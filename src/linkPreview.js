'use strict';

// Link previews: for a link posted in chat or on the Highway, read the page's
// featured image, title, description and site name (Open Graph / Twitter card
// tags, falling back to <title> and the description meta).
//
// Fetching URLs that members typed is risky for a server, so every request:
//   - is http/https on the standard ports only;
//   - resolves the host name and refuses private, loopback, link-local and
//     other internal addresses — checked at connect time, so a DNS trick that
//     points a name at an internal address afterwards doesn't get through;
//   - follows at most 4 redirects, each checked the same way;
//   - times out quickly and stops reading after a size cap.
// Links that the link-safety check (src/linkSafety.js) flags are never fetched.
//
// The featured image is downloaded once, shrunk with sharp to a small WebP and
// served from our own server — members' browsers never contact the other site
// (no IP leak, no hot-link blocking), and odd image files can't reach them.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const db = require('./db');
const config = require('./config');
const linkSafety = require('./linkSafety');

let sharp = null;
try { sharp = require('sharp'); } catch (_e) { /* previews without images */ }

const CACHE_DIR = path.join(config.dataDir, 'linkcache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const HTML_MAX = 600 * 1024;          // only the start of a page is needed
const IMAGE_MAX = 6 * 1024 * 1024;
const TIMEOUT_MS = 6000;
const OK_TTL = 24 * 60 * 60 * 1000;   // refresh previews daily
const FAIL_TTL = 60 * 60 * 1000;      // retry failed pages after an hour

db.exec(`
  CREATE TABLE IF NOT EXISTS link_previews (
    url         TEXT PRIMARY KEY,
    ok          INTEGER NOT NULL,
    title       TEXT,
    description TEXT,
    site        TEXT,
    image_file  TEXT,
    fetched_at  INTEGER NOT NULL
  );
`);

/* ------------------------- address safety ------------------------- */

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||   // carrier-grade NAT
      (a === 169 && b === 254) ||             // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') ||
    v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

// dns.lookup replacement used by the request itself: only public addresses.
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = (addrs || []).find((a) => !isPrivateIp(a.address));
    if (!ok) return cb(new Error('Blocked address'));
    if (opts && opts.all) return cb(null, [ok]);
    cb(null, ok.address, ok.family);
  });
}

// GET a URL safely. Resolves { url (final), type, body (Buffer) }.
function safeGet(url, maxBytes, accept, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_e) { return reject(new Error('Bad URL')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('Unsupported scheme'));
    if (u.port && !['80', '443'].includes(u.port)) return reject(new Error('Unsupported port'));
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ''))) {
      return reject(new Error('Blocked address'));
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, {
      lookup: safeLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; getxmatchLinkPreview/1.0; +https://getxmatch.com)',
        accept,
        'accept-language': 'en',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= 4) return reject(new Error('Too many redirects'));
        let next;
        try { next = new URL(res.headers.location, u).href; } catch (_e) { return reject(new Error('Bad redirect')); }
        return resolve(safeGet(next, maxBytes, accept, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        chunks.push(c);
        if (size >= maxBytes) res.destroy(); // enough — stop reading
      });
      const done = () => resolve({ url: u.href, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).subarray(0, maxBytes) });
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
  });
}

/* --------------------------- page parsing --------------------------- */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Math.min(0x10ffff, +n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(Math.min(0x10ffff, parseInt(h, 16))))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// All <meta> tags in the page head as { key -> content } (property / name).
function readMeta(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const attr = (name) => {
      const r = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
      return r ? (r[2] ?? r[3] ?? r[4] ?? '') : null;
    };
    const key = (attr('property') || attr('name') || attr('itemprop') || '').toLowerCase();
    const content = attr('content');
    if (key && content != null && !(key in out)) out[key] = decodeEntities(content);
  }
  return out;
}

function parsePage(html, pageUrl) {
  const head = html.slice(0, HTML_MAX);
  const meta = readMeta(head);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  const title = meta['og:title'] || meta['twitter:title'] || (titleTag ? decodeEntities(titleTag[1]) : '');
  let description = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  if (!description) {
    // No description tag — use the first real paragraph of the page.
    const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let p;
    while ((p = re.exec(html)) !== null) {
      const text = decodeEntities(p[1].replace(/<[^>]+>/g, '')).replace(/\[\d+\]/g, '');
      if (text.length >= 60) { description = text; break; }
    }
  }
  let site = meta['og:site_name'] || '';
  let image = meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || meta.image || '';
  if (!image) {
    // Fall back to the page's large touch icon.
    const icon = /<link\b[^>]*rel=["']?(?:apple-touch-icon|icon)[^>]*>/i.exec(head);
    const href = icon && /href\s*=\s*["']?([^"'\s>]+)/i.exec(icon[0]);
    if (href) image = href[1];
  }
  try { if (image) image = new URL(image, pageUrl).href; } catch (_e) { image = ''; }
  if (!site) { try { site = new URL(pageUrl).hostname.replace(/^www\./, ''); } catch (_e) { site = ''; } }
  return {
    title: title.slice(0, 200),
    description: description.slice(0, 300),
    site: site.slice(0, 80),
    image,
  };
}

// Download the featured image and keep a small WebP copy. Returns the file name.
async function cacheImage(imageUrl) {
  if (!sharp || !imageUrl) return null;
  const name = crypto.createHash('sha1').update(imageUrl).digest('hex') + '.webp';
  const file = path.join(CACHE_DIR, name);
  if (fs.existsSync(file)) return name;
  const res = await safeGet(imageUrl, IMAGE_MAX, 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8');
  if (!/^image\//i.test(res.type) || /svg/i.test(res.type)) return null;
  const out = await sharp(res.body, { limitInputPixels: 40e6, animated: false })
    .rotate()
    .resize({ width: 720, height: 720, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 76 })
    .toBuffer();
  await fs.promises.writeFile(file, out);
  return name;
}

/* ------------------------------ public ------------------------------ */

const inflight = new Map();

// Preview for a URL: { url, title, description, site, image } or null.
async function preview(rawUrl) {
  let url;
  try { url = new URL(rawUrl).href; } catch (_e) { return null; }
  if (!/^https?:/i.test(url) || url.length > 2000) return null;

  const row = db.prepare('SELECT * FROM link_previews WHERE url = ?').get(url);
  if (row && Date.now() - row.fetched_at < (row.ok ? OK_TTL : FAIL_TTL)) return shape(row);
  if (inflight.has(url)) return inflight.get(url);

  const job = (async () => {
    let data = null;
    try {
      const verdict = await linkSafety.checkText(url);
      if (!verdict.safe) throw new Error('unsafe');
      const page = await safeGet(url, HTML_MAX, 'text/html,application/xhtml+xml');
      if (!/html/i.test(page.type)) throw new Error('not html');
      const meta = parsePage(page.body.toString('utf8'), page.url);
      let imageFile = null;
      try { imageFile = await cacheImage(meta.image); } catch (_e) { imageFile = null; }
      if (meta.title || imageFile) data = { ...meta, imageFile };
    } catch (_e) { data = null; }
    db.prepare(
      `INSERT INTO link_previews (url, ok, title, description, site, image_file, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET ok = excluded.ok, title = excluded.title, description = excluded.description,
         site = excluded.site, image_file = excluded.image_file, fetched_at = excluded.fetched_at`
    ).run(url, data ? 1 : 0, data && data.title, data && data.description, data && data.site, data && data.imageFile, Date.now());
    return shape(db.prepare('SELECT * FROM link_previews WHERE url = ?').get(url));
  })();
  inflight.set(url, job);
  try { return await job; } finally { inflight.delete(url); }
}

function shape(row) {
  if (!row || !row.ok) return null;
  return {
    url: row.url,
    title: row.title || '',
    description: row.description || '',
    site: row.site || '',
    image: row.image_file ? `/api/link-preview/img/${row.image_file}` : null,
  };
}

function imagePath(name) {
  if (!/^[0-9a-f]{40}\.webp$/.test(name)) return null;
  const file = path.join(CACHE_DIR, name);
  return fs.existsSync(file) ? file : null;
}

module.exports = { preview, imagePath, isPrivateIp, parsePage };
