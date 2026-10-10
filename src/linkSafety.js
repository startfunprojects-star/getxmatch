'use strict';

// Link safety: before a member's text is posted anywhere (chat, group chat,
// Highway, comments, captions, bio…), every link in it is checked, and text
// carrying a dangerous link is refused.
//
// Two layers:
//  1. Google Safe Browsing (when GOOGLE_SAFE_BROWSING_KEY is set) — Google's
//     live list of phishing, malware and unwanted-software sites.
//  2. Built-in heuristics that catch the common phishing tricks even without
//     an API key: script/data links, "user@host" disguises, raw IP hosts,
//     look-alike (punycode) domains, brand names on someone else's domain,
//     and throwaway domains dressed up with "login / verify / KYC" bait.
// Shortened links (bit.ly, tinyurl…) are expanded first — only by asking the
// shortener where it points, never by opening the destination — so the real
// target is what gets checked.
//
// Usage: const verdict = await checkText(text);
//        if (!verdict.safe) reject with verdict.message.

const config = require('./config');

// Bare domains are only recognised with these endings, so ordinary words with
// dots ("e.g.", "file.txt") aren't mistaken for links.
const TLDS = [
  'com', 'net', 'org', 'in', 'co', 'io', 'info', 'biz', 'me', 'app', 'dev', 'ai', 'xyz', 'top', 'site',
  'online', 'live', 'shop', 'store', 'club', 'link', 'click', 'icu', 'buzz', 'tk', 'ml', 'ga', 'cf', 'gq',
  'cn', 'ru', 'uk', 'us', 'ly', 'cc', 'ws', 'pw', 'su', 'zip', 'mov', 'work', 'rest', 'fit', 'loan', 'win',
  'bid', 'stream', 'download', 'review', 'country', 'kim', 'party', 'gdn', 'men', 'date', 'racing', 'cam',
  'support', 'help', 'services', 'today', 'website', 'space', 'tech', 'fun', 'host', 'press', 'vip', 'lol',
];
const URL_RE = new RegExp(
  String.raw`\b(?:(?:https?|ftp|javascript|data|vbscript|file):[^\s<>"']+|www\.[^\s<>"']+|` +
  String.raw`(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${TLDS.join('|')})(?::\d+)?(?:/[^\s<>"']*)?(?=$|[\s<>"'.,!?)\]]))`,
  'gi'
);

// TLDs that cost little or nothing and are heavily used for throwaway scam
// sites. Not blocked on their own — they add to the risk score.
const RISKY_TLDS = new Set([
  'tk', 'ml', 'ga', 'cf', 'gq', 'xyz', 'top', 'icu', 'buzz', 'click', 'link', 'zip', 'mov', 'work', 'rest',
  'fit', 'loan', 'win', 'bid', 'stream', 'download', 'review', 'country', 'kim', 'party', 'gdn', 'men',
  'date', 'racing', 'cam', 'su', 'pw', 'ws', 'support', 'help', 'live', 'online', 'site', 'website', 'vip',
]);

// Words phishing pages use to look official / urgent.
const BAIT_WORDS = [
  'login', 'log-in', 'signin', 'sign-in', 'verify', 'verification', 'validate', 'account', 'secure', 'security',
  'update', 'confirm', 'password', 'passwd', 'wallet', 'unlock', 'suspend', 'suspended', 'blocked', 'kyc',
  'otp', 'refund', 'reward', 'prize', 'winner', 'lottery', 'giveaway', 'free-gift', 'claim', 'bonus',
  'billing', 'invoice', 'payment', 'banking', 'netbanking', 'recover', 'restore', 'support-team', 'helpdesk',
];

// Brands phishers imitate → their real registrable domains. A brand name on any
// other domain (e.g. "paypal-secure-login.xyz", "sbi.kyc-update.in") is a fake.
const BRANDS = {
  paypal: ['paypal.com', 'paypal.me'],
  google: ['google.com', 'google.co.in', 'youtube.com', 'goo.gl', 'g.co', 'googleusercontent.com', 'gstatic.com', 'blogspot.com'],
  gmail: ['google.com', 'gmail.com'],
  apple: ['apple.com', 'icloud.com', 'apple.co'],
  icloud: ['icloud.com', 'apple.com'],
  microsoft: ['microsoft.com', 'live.com', 'outlook.com', 'office.com', 'microsoftonline.com', 'bing.com', 'msn.com'],
  outlook: ['outlook.com', 'live.com', 'microsoft.com', 'office.com'],
  office365: ['office.com', 'microsoft.com'],
  facebook: ['facebook.com', 'fb.com', 'fb.me', 'fbcdn.net', 'facebook.net'],
  instagram: ['instagram.com', 'instagr.am', 'cdninstagram.com'],
  whatsapp: ['whatsapp.com', 'whatsapp.net', 'wa.me'],
  netflix: ['netflix.com'],
  amazon: ['amazon.com', 'amazon.in', 'amazon.co.uk', 'amzn.to', 'amzn.in', 'amazonaws.com', 'media-amazon.com'],
  flipkart: ['flipkart.com', 'fkrt.it'],
  linkedin: ['linkedin.com', 'lnkd.in'],
  twitter: ['twitter.com', 't.co', 'x.com'],
  telegram: ['telegram.org', 't.me', 'telegram.me'],
  binance: ['binance.com'],
  coinbase: ['coinbase.com'],
  metamask: ['metamask.io'],
  paytm: ['paytm.com', 'paytm.in'],
  phonepe: ['phonepe.com'],
  sbi: ['sbi.co.in', 'onlinesbi.sbi', 'sbi', 'onlinesbi.com', 'sbicard.com'],
  hdfc: ['hdfcbank.com', 'hdfc.com', 'hdfclife.com'],
  icici: ['icicibank.com', 'icicidirect.com', 'icicilombard.com'],
  axisbank: ['axisbank.com'],
  kotak: ['kotak.com'],
  irctc: ['irctc.co.in'],
  incometax: ['incometax.gov.in'],
  uidai: ['uidai.gov.in'],
  aadhaar: ['uidai.gov.in'],
  dhl: ['dhl.com', 'dhl.de'],
  fedex: ['fedex.com'],
  steam: ['steampowered.com', 'steamcommunity.com'],
  getxmatch: ['getxmatch.com'],
};

// How each brand is written in the explanation shown to the member.
const BRAND_NAMES = {
  paypal: 'PayPal', icloud: 'iCloud', office365: 'Office 365', whatsapp: 'WhatsApp', linkedin: 'LinkedIn',
  phonepe: 'PhonePe', metamask: 'MetaMask', sbi: 'SBI', hdfc: 'HDFC Bank', icici: 'ICICI Bank',
  axisbank: 'Axis Bank', irctc: 'IRCTC', incometax: 'the Income Tax Department', uidai: 'UIDAI (Aadhaar)',
  aadhaar: 'Aadhaar', dhl: 'DHL', fedex: 'FedEx', gmail: 'Gmail', getxmatch: 'getxmatch',
};

// Two-level public suffixes, so "evil.co.in" resolves to "evil.co.in" not "co.in".
const SECOND_LEVEL = new Set(['co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'edu.in', 'nic.in', 'res.in',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'com.br', 'com.cn', 'com.sg',
  'co.za', 'com.mx', 'co.nz', 'com.tr', 'com.pk', 'com.bd', 'com.np', 'com.ng']);

// Link shorteners whose target we look up before judging.
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'shorturl.at',
  'ow.ly', 'buff.ly', 't.ly', 'tiny.cc', 'rebrand.ly', 'bl.ink', 'shorte.st', 'adf.ly', 'v.gd', 'qr.ae',
  's.id', 'tny.im', 'clck.ru', 'urlz.fr', 'lnkd.in', 'amzn.to', 'fkrt.it', 't.co']);

const BLOCK_SCORE = 3;
const EXTRA_BLOCKED = new Set(String(process.env.BLOCKED_LINK_DOMAINS || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

function registrableDomain(host) {
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return SECOND_LEVEL.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

function isOfficial(host, domains) {
  return domains.some((d) => host === d || host.endsWith('.' + d));
}

// All link-like strings in a piece of text.
function extractUrls(text) {
  const out = [];
  const str = String(text || '');
  let m;
  const re = new RegExp(URL_RE.source, 'gi');
  while ((m = re.exec(str)) !== null) out.push(m[0].replace(/[.,!?)\]]+$/, ''));
  return [...new Set(out)];
}

// Parse a found link into a URL object (bare "evil.com/x" gets http://).
function parse(raw) {
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  try { return new URL(hasScheme ? raw : 'http://' + raw); } catch (_e) { return null; }
}

// Heuristic verdict for one link: { score, reasons[] }.
function heuristics(raw) {
  const u = parse(raw);
  if (!u) return { score: 0, reasons: [] };
  const reasons = [];
  let score = 0;
  const add = (n, why) => { score += n; reasons.push(why); };

  const scheme = u.protocol.replace(':', '').toLowerCase();
  if (['javascript', 'data', 'vbscript', 'file'].includes(scheme)) add(10, 'it runs code or opens local files');
  if (!['http', 'https', 'ftp', 'javascript', 'data', 'vbscript', 'file'].includes(scheme)) return { score, reasons };

  const host = (u.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return { score, reasons };
  if (u.username || u.password || /^[^/]*@/.test(raw.replace(/^[a-z]+:\/\//i, ''))) add(10, 'it hides the real address behind an "@"');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) add(4, 'it points to a bare IP address instead of a website name');
  if (host.split('.').some((l) => l.startsWith('xn--'))) add(4, 'it uses look-alike characters to imitate another website');

  const reg = registrableDomain(host);
  if (EXTRA_BLOCKED.has(reg) || EXTRA_BLOCKED.has(host)) add(10, 'this website is blocked');

  const hostAndPath = (host + u.pathname + u.search).toLowerCase();
  // Words of the website name (sub-domains + the name part of the domain).
  const words = host.slice(0, host.length - reg.length).split(/[.\-]/)
    .concat(reg.split('.')[0].split('-')).filter(Boolean);
  for (const [brand, domains] of Object.entries(BRANDS)) {
    if (isOfficial(host, domains)) continue;
    const pretends = `it pretends to be ${BRAND_NAMES[brand] || brand[0].toUpperCase() + brand.slice(1)} but isn't their website`;
    // "paypal-login.xyz", "sbi.kyc-update.in": the brand as a word of the name.
    if (words.includes(brand)) { add(4, pretends); break; }
    // "mypaypalaccount.com": buried in a word — suspicious, not proof
    // (needs another signal; short names like "apple" are skipped here).
    if (brand.length >= 6 && words.some((w) => w.includes(brand))) { add(2, pretends); break; }
  }

  const tld = host.split('.').pop();
  const bait = BAIT_WORDS.filter((w) => hostAndPath.includes(w));
  if (RISKY_TLDS.has(tld)) {
    score += 1;
    if (bait.length) add(2, `it asks you to "${bait[0]}" on a throwaway domain`);
  }
  if (bait.length >= 2 && host.split('-').length >= 3) add(2, 'its address is stuffed with login/verification words');
  if (host.split('.').length >= 5) score += 1; // deeply nested sub-domains
  if (/\.(exe|scr|bat|cmd|msi|apk|jar|vbs|ps1)(\?|$)/i.test(u.pathname)) add(3, 'it downloads a program that could harm your device');
  return { score, reasons };
}

// Ask a shortener where a short link goes (no redirect is followed — we only
// read its Location header, so no other site is ever contacted).
async function expandShortLink(u) {
  try {
    const res = await fetch(u.href.replace(/^http:/, 'https:'), {
      method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(3000),
      headers: { 'user-agent': 'getxmatch-link-check' },
    });
    return res.headers.get('location') || null;
  } catch (_e) { return null; }
}

// Google Safe Browsing v4 lookup for several URLs at once → Set of flagged URLs.
const sbCache = new Map(); // url -> { bad, at }
const SB_TTL = 30 * 60 * 1000;
async function safeBrowsing(urls) {
  const key = config.safeBrowsingKey;
  const flagged = new Set();
  if (!key || !urls.length) return flagged;
  const now = Date.now();
  const todo = urls.filter((x) => {
    const c = sbCache.get(x);
    if (c && now - c.at < SB_TTL) { if (c.bad) flagged.add(x); return false; }
    return true;
  });
  if (!todo.length) return flagged;
  try {
    const res = await fetch(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(3500),
      body: JSON.stringify({
        client: { clientId: 'getxmatch', clientVersion: '1.0' },
        threatInfo: {
          threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
          platformTypes: ['ANY_PLATFORM'],
          threatEntryTypes: ['URL'],
          threatEntries: todo.map((url) => ({ url })),
        },
      }),
    });
    if (!res.ok) return flagged; // API trouble: fall back to the heuristics alone
    const data = await res.json();
    const bad = new Set(((data && data.matches) || []).map((m) => m.threat && m.threat.url));
    todo.forEach((x) => {
      sbCache.set(x, { bad: bad.has(x), at: now });
      if (bad.has(x)) flagged.add(x);
    });
    if (sbCache.size > 5000) sbCache.clear();
  } catch (_e) { /* network/timeout: heuristics still apply */ }
  return flagged;
}

const SAFE = { safe: true };

// Check every link in `text`. Resolves to { safe: true } or
// { safe: false, url, reason, message }.
async function checkText(text) {
  const found = extractUrls(text);
  if (!found.length) return SAFE;

  // Expand short links so their destinations are judged too.
  const targets = []; // [{ shown, url }]
  for (const raw of found.slice(0, 20)) {
    targets.push({ shown: raw, url: raw });
    const u = parse(raw);
    if (u && SHORTENERS.has(u.hostname.toLowerCase().replace(/^www\./, ''))) {
      const dest = await expandShortLink(u);
      if (dest) targets.push({ shown: raw, url: dest });
    }
  }

  for (const t of targets) {
    const h = heuristics(t.url);
    if (h.score >= BLOCK_SCORE) return unsafe(t.shown, h.reasons[0] || 'it looks like a phishing link');
  }

  const absolute = targets.map((t) => { const u = parse(t.url); return u && /^https?:$/.test(u.protocol) ? u.href : null; });
  const flagged = await safeBrowsing(absolute.filter(Boolean));
  const hit = targets.find((_t, i) => absolute[i] && flagged.has(absolute[i]));
  if (hit) return unsafe(hit.shown, 'Google Safe Browsing reports it as a phishing or malware site');
  return SAFE;
}

function unsafe(url, reason) {
  const shown = url.length > 60 ? url.slice(0, 57) + '…' : url;
  return {
    safe: false,
    url,
    reason,
    message: `This can't be posted: the link "${shown}" looks unsafe — ${reason}. Remove the link and try again.`,
  };
}

// Express middleware: refuse the request when any of the named body fields
// carries an unsafe link (removing files this request already uploaded).
function requireSafeLinks(...fields) {
  return async (req, res, next) => {
    const text = fields.map((f) => req.body && req.body[f]).filter((v) => typeof v === 'string' && v).join(' ');
    if (!text) return next();
    let verdict;
    try { verdict = await checkText(text); } catch (_e) { return next(); }
    if (verdict.safe) return next();
    dropUploads(req);
    res.status(400).json({ error: verdict.message, unsafeLink: verdict.url });
  };
}

function dropUploads(req) {
  const fs = require('fs');
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  else if (req.files) Object.values(req.files).forEach((arr) => files.push(...arr));
  files.forEach((f) => f && f.path && fs.unlink(f.path, () => {}));
}

// Socket.IO per-socket middleware: for the listed events, check the text the
// event carries and answer its ack with an error instead of handling it.
const SOCKET_TEXT = {
  'chat:message': (p) => p && p.body,
  'group:message': (p) => p && p.body,
  'call:chat': (p) => p && p.body,
  'poll:create': (p) => p && [p.question].concat(Array.isArray(p.options) ? p.options : []).join(' '),
};
function socketGuard(packet, next) {
  const pick = SOCKET_TEXT[packet[0]];
  const text = pick ? pick(packet[1]) : null;
  if (!text || typeof text !== 'string') return next();
  checkText(text).then((verdict) => {
    if (verdict.safe) return next();
    const ack = packet[packet.length - 1];
    if (typeof ack === 'function') ack({ error: verdict.message, unsafeLink: verdict.url });
  }, () => next());
}

module.exports = { checkText, extractUrls, heuristics, requireSafeLinks, socketGuard };
