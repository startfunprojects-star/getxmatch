'use strict';

// Alerts on Recent Activity: the latest news about admin-chosen keywords,
// optionally limited to admin-chosen websites (Admin → Activity → Alerts).
//
// Sources, merged and newest first:
//   1. Google News search results for each keyword (restricted to the chosen
//      websites with site: filters), fetched every FETCH_EVERY_MS and stored
//      here as headline + link + source + date only;
//   2. headlines from the admin's own News feeds (src/news.js) whose title or
//      snippet mentions a keyword.
// The website list is applied again when alerts are read, so editing it takes
// effect straight away. Every member sees the same alerts.

const db = require('./db');
const { getSetting, setSetting } = require('./settings');
const news = require('./news');

const FETCH_EVERY_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_KEYWORDS = 25;
const MAX_SITES = 30;
const KEEP_ITEMS = 300; // stored Google News alerts, newest first
const KEEP_DAYS = 14;
const SHOW_LIMIT = 30; // alerts shown to members

db.exec(`
  CREATE TABLE IF NOT EXISTS alert_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword      TEXT NOT NULL,
    guid         TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    link         TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT '',
    source_url   TEXT,
    published_at INTEGER NOT NULL,
    fetched_at   INTEGER NOT NULL,
    hidden       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_alert_items_pub ON alert_items (published_at);
`);

/* ---------------------------------------------------------------------------
   Settings: comma-separated keywords and websites
--------------------------------------------------------------------------- */
function splitList(raw) {
  return String(raw || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

// Normalise a keyword: collapse spaces, strip quotes, cap the length.
function cleanKeywords(raw) {
  const seen = new Set();
  const out = [];
  for (const k of splitList(raw)) {
    const kw = k.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (kw && !seen.has(kw.toLowerCase())) { seen.add(kw.toLowerCase()); out.push(kw); }
  }
  return out.slice(0, MAX_KEYWORDS);
}

// "https://www.bbc.com/news", "bbc.com", "www.bbc.com" → "bbc.com".
function cleanSites(raw) {
  const seen = new Set();
  const out = [];
  for (const s of splitList(raw)) {
    let host = s.toLowerCase();
    try { host = new URL(/^https?:\/\//.test(host) ? host : 'https://' + host).hostname; } catch (_e) { continue; }
    host = host.replace(/^www\./, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out.slice(0, MAX_SITES);
}

function getConfig() {
  return {
    keywords: cleanKeywords(getSetting('alerts_keywords', '')),
    sites: cleanSites(getSetting('alerts_sites', '')),
  };
}

// Save the lists (as typed, cleaned) and drop stored alerts for keywords that
// were removed. Returns the cleaned config.
function setConfig({ keywords, sites }) {
  const kw = cleanKeywords(keywords);
  const st = cleanSites(sites);
  setSetting('alerts_keywords', kw.join(', '));
  setSetting('alerts_sites', st.join(', '));
  if (kw.length) {
    const marks = kw.map(() => '?').join(',');
    db.prepare(`DELETE FROM alert_items WHERE lower(keyword) NOT IN (${marks})`).run(...kw.map((k) => k.toLowerCase()));
  } else {
    db.prepare('DELETE FROM alert_items').run();
  }
  return { keywords: kw, sites: st };
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (_e) { return ''; }
}

function siteAllowed(host, sites) {
  if (!sites.length) return true;
  return !!host && sites.some((s) => host === s || host.endsWith('.' + s));
}

/* ---------------------------------------------------------------------------
   Fetching (Google News search RSS)
--------------------------------------------------------------------------- */
function searchUrl(keyword, sites) {
  let q = `"${keyword}"`;
  if (sites.length) q += ' (' + sites.map((s) => 'site:' + s).join(' OR ') + ')';
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-IN&gl=IN&ceid=IN:en';
}

// Google News titles end in " - Source name"; drop that (the source is shown
// separately).
function stripSourceSuffix(title, source) {
  let t = title;
  if (source && t.endsWith(' - ' + source)) t = t.slice(0, -(source.length + 3));
  if (source && t.endsWith(' | ' + source)) t = t.slice(0, -(source.length + 3));
  // Section tails some sites add ("… | India News", "… | Latest News") and
  // dangling separators.
  t = t.replace(/\s*\|\s*[^|]{0,40}\bnews\b[^|]*$/i, '');
  return t.replace(/(\s*[|\-–—]\s*)+$/, '').trim();
}

// True if the headline itself mentions the keyword (Google also matches text
// deep inside an article, which makes for off-topic alerts).
function mentions(text, keyword) {
  const esc = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

async function fetchKeyword(keyword, sites) {
  const res = await fetch(searchUrl(keyword, sites), {
    headers: { 'user-agent': 'getxmatch-news/1.0 (+https://getxmatch.com)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { items } = news.parseFeed(await res.text());
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO alert_items (keyword, guid, title, link, source, source_url, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guid) DO NOTHING`
  );
  let added = 0;
  for (const it of items) {
    const pub = it.publishedAt && it.publishedAt <= now ? it.publishedAt : now;
    if (now - pub > KEEP_DAYS * 86400000) continue;
    const source = it.sourceName || hostOf(it.sourceUrl || it.link);
    const title = stripSourceSuffix(it.title, it.sourceName);
    if (!title || !mentions(title, keyword)) continue;
    added += ins.run(keyword, it.guid, title, it.link, source, it.sourceUrl, pub, now).changes;
  }
  return added;
}

let running = false;
async function fetchAll() {
  if (running) return { ok: false, error: 'Already fetching.' };
  running = true;
  const { keywords, sites } = getConfig();
  const errors = [];
  let added = 0;
  try {
    for (const kw of keywords) {
      try { added += await fetchKeyword(kw, sites); } catch (e) { errors.push(`${kw}: ${e.message}`); }
    }
    db.prepare('DELETE FROM alert_items WHERE published_at < ?').run(Date.now() - KEEP_DAYS * 86400000);
    db.prepare(
      `DELETE FROM alert_items WHERE id NOT IN (SELECT id FROM alert_items ORDER BY published_at DESC LIMIT ?)`
    ).run(KEEP_ITEMS);
    setSetting('alerts_last_fetch', JSON.stringify({ at: Date.now(), added, errors }));
  } finally {
    running = false;
  }
  return { ok: !errors.length, added, errors };
}

function lastFetch() {
  try { return JSON.parse(getSetting('alerts_last_fetch', 'null')); } catch (_e) { return null; }
}

function start() {
  setTimeout(() => fetchAll().catch(() => {}), 20000).unref();
  setInterval(() => fetchAll().catch(() => {}), FETCH_EVERY_MS).unref();
}

/* ---------------------------------------------------------------------------
   Reading
--------------------------------------------------------------------------- */
// The current alerts, newest first. `includeHidden` is for the admin view.
function listAlerts({ limit = SHOW_LIMIT, includeHidden = false } = {}) {
  const { keywords, sites } = getConfig();
  if (!keywords.length) return [];
  const out = [];

  // 1) Google News results.
  db.prepare(
    `SELECT id, keyword, title, link, source, source_url, published_at, hidden FROM alert_items
      ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY published_at DESC LIMIT ?`
  ).all(limit * 4).forEach((r) => {
    if (!siteAllowed(hostOf(r.source_url || r.link), sites)) return;
    out.push({ id: 'a' + r.id, keyword: r.keyword, title: r.title, link: r.link, source: r.source, at: r.published_at, hidden: !!r.hidden });
  });

  // 2) Headlines from the admin's News feeds that mention a keyword.
  const likes = keywords.map(() => '(i.title LIKE ? OR i.snippet LIKE ?)').join(' OR ');
  const args = keywords.flatMap((k) => [`%${k}%`, `%${k}%`]);
  db.prepare(
    `SELECT i.id, i.title, i.snippet, i.link, i.published_at, i.hidden, f.title AS feed_title
       FROM news_items i JOIN news_feeds f ON f.id = i.feed_id
      WHERE f.enabled = 1 ${includeHidden ? '' : 'AND i.hidden = 0'} AND (${likes})
      ORDER BY i.published_at DESC LIMIT ?`
  ).all(...args, limit * 2).forEach((r) => {
    if (!siteAllowed(hostOf(r.link), sites)) return;
    const keyword = keywords.find((k) => mentions(r.title + ' ' + r.snippet, k));
    if (!keyword) return; // LIKE also hits inside longer words
    out.push({ id: 'n' + r.id, keyword, title: r.title, link: r.link, source: r.feed_title || hostOf(r.link), at: r.published_at, hidden: !!r.hidden });
  });

  // Newest first, one per headline.
  out.sort((a, b) => b.at - a.at);
  const seen = new Set();
  return out.filter((a) => {
    const key = a.title.toLowerCase().replace(/\W+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

// Hide / show one alert ('a<id>' = Google News result, 'n<id>' = News feed
// headline, which is then hidden from News too).
function setHidden(id, hidden) {
  const m = /^([an])(\d+)$/.exec(String(id));
  if (!m) return false;
  const table = m[1] === 'a' ? 'alert_items' : 'news_items';
  return db.prepare(`UPDATE ${table} SET hidden = ? WHERE id = ?`).run(hidden ? 1 : 0, m[2]).changes > 0;
}

module.exports = { start, fetchAll, getConfig, setConfig, listAlerts, setHidden, lastFetch, MAX_KEYWORDS, MAX_SITES };
