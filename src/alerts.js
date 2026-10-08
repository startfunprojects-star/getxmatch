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
// effect straight away.
//
// Alerts are per country: Google News is searched in the edition of each
// country members use (src/newsCountries.js), and each member sees the alerts
// for the country they picked ('Worldwide' = every country's).

const db = require('./db');
const { getSetting, setSetting } = require('./settings');
const news = require('./news');
const countries = require('./newsCountries');

const FETCH_EVERY_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_KEYWORDS = 25;
const MAX_SITES = 30;
const KEYWORDS_PER_SEARCH = 5; // keywords OR'd into one Google News search
const KEEP_PER_COUNTRY = 300; // stored Google News alerts per country, newest first
const KEEP_DAYS = 14;
const SHOW_LIMIT = 30; // alerts shown to members

const ALERT_ITEMS_SQL = `(
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    country      TEXT NOT NULL,
    keyword      TEXT NOT NULL,
    guid         TEXT NOT NULL,
    title        TEXT NOT NULL,
    link         TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT '',
    source_url   TEXT,
    published_at INTEGER NOT NULL,
    fetched_at   INTEGER NOT NULL,
    hidden       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (country, guid)
  )`;
db.exec(`CREATE TABLE IF NOT EXISTS alert_items ${ALERT_ITEMS_SQL};`);
// Older databases: alerts were India-edition only and the guid alone was unique.
if (!db.prepare('PRAGMA table_info(alert_items)').all().some((c) => c.name === 'country')) {
  db.exec(`
    BEGIN;
    CREATE TABLE alert_items_new ${ALERT_ITEMS_SQL};
    INSERT INTO alert_items_new (id, country, keyword, guid, title, link, source, source_url, published_at, fetched_at, hidden)
      SELECT id, 'India', keyword, guid, title, link, source, source_url, published_at, fetched_at, hidden FROM alert_items;
    DROP TABLE alert_items;
    ALTER TABLE alert_items_new RENAME TO alert_items;
    COMMIT;
  `);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_alert_items_pub ON alert_items (country, published_at);');

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
function searchUrl(keywords, sites, country) {
  let q = '(' + keywords.map((k) => `"${k}"`).join(' OR ') + ')';
  if (sites.length) q += ' (' + sites.map((s) => 'site:' + s).join(' OR ') + ')';
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&' + countries.editionQuery(country);
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

// One search for a few keywords in one country's edition; each result is filed
// under the keyword its headline mentions (none → skipped).
async function fetchKeywords(keywords, sites, country) {
  const res = await fetch(searchUrl(keywords, sites, country), {
    headers: { 'user-agent': 'getxmatch-news/1.0 (+https://getxmatch.com)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { items } = news.parseFeed(await res.text());
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO alert_items (country, keyword, guid, title, link, source, source_url, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(country, guid) DO NOTHING`
  );
  let added = 0;
  for (const it of items) {
    const pub = it.publishedAt && it.publishedAt <= now ? it.publishedAt : now;
    if (now - pub > KEEP_DAYS * 86400000) continue;
    const source = it.sourceName || hostOf(it.sourceUrl || it.link);
    const title = stripSourceSuffix(it.title, it.sourceName);
    const keyword = title && keywords.find((k) => mentions(title, k));
    if (!keyword) continue;
    added += ins.run(country, keyword, it.guid, title, it.link, source, it.sourceUrl, pub, now).changes;
  }
  return added;
}

const fetchedAt = new Map(); // country → last fetch (this process)

// Fetch one country's alerts (searches run in parallel). Returns { added, errors }.
async function fetchCountry(country, cfg = getConfig()) {
  const { keywords, sites } = cfg;
  const chunks = [];
  for (let i = 0; i < keywords.length; i += KEYWORDS_PER_SEARCH) chunks.push(keywords.slice(i, i + KEYWORDS_PER_SEARCH));
  const errors = [];
  let added = 0;
  await Promise.all(chunks.map(async (chunk) => {
    try { added += await fetchKeywords(chunk, sites, country); } catch (e) { errors.push(`${country} (${chunk.join(', ')}): ${e.message}`); }
  }));
  db.prepare(
    `DELETE FROM alert_items WHERE country = ? AND id NOT IN
       (SELECT id FROM alert_items WHERE country = ? ORDER BY published_at DESC LIMIT ?)`
  ).run(country, country, KEEP_PER_COUNTRY);
  fetchedAt.set(country, Date.now());
  return { added, errors };
}

// A member just picked `country`: fetch it now unless it's fresh.
async function prepareCountry(country) {
  if (!countries.isCountry(country) || Date.now() - (fetchedAt.get(country) || 0) < FETCH_EVERY_MS) return;
  if (!getConfig().keywords.length) return;
  await fetchCountry(country);
}

let running = false;
async function fetchAll() {
  if (running) return { ok: false, error: 'Already fetching.' };
  running = true;
  const cfg = getConfig();
  const list = countries.inUse();
  if (!list.length) list.push('India');
  const errors = [];
  let added = 0;
  try {
    if (cfg.keywords.length) {
      for (const c of list) { // one country at a time: gentle on Google News
        const r = await fetchCountry(c, cfg);
        added += r.added;
        errors.push(...r.errors);
      }
    }
    db.prepare('DELETE FROM alert_items WHERE published_at < ?').run(Date.now() - KEEP_DAYS * 86400000);
    setSetting('alerts_last_fetch', JSON.stringify({ at: Date.now(), added, errors, countries: list }));
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
// The current alerts, newest first. `country` = one country's alerts (plus
// matching headlines from the international and that country's News feeds);
// null = every country's. `includeHidden` is for the admin view.
function listAlerts({ limit = SHOW_LIMIT, includeHidden = false, country = null } = {}) {
  const { keywords, sites } = getConfig();
  if (!keywords.length) return [];
  const out = [];
  const where = (conds) => (conds.length ? 'WHERE ' + conds.join(' AND ') : '');

  // 1) Google News results.
  const aConds = [];
  const aArgs = [];
  if (!includeHidden) aConds.push('hidden = 0');
  if (country) { aConds.push('country = ?'); aArgs.push(country); }
  db.prepare(
    `SELECT id, country, keyword, title, link, source, source_url, published_at, hidden FROM alert_items
      ${where(aConds)} ORDER BY published_at DESC LIMIT ?`
  ).all(...aArgs, limit * 4).forEach((r) => {
    if (!siteAllowed(hostOf(r.source_url || r.link), sites)) return;
    out.push({ id: 'a' + r.id, country: r.country, keyword: r.keyword, title: r.title, link: r.link, source: r.source, at: r.published_at, hidden: !!r.hidden });
  });

  // 2) Headlines from the admin's News feeds that mention a keyword.
  const likes = keywords.map(() => '(i.title LIKE ? OR i.snippet LIKE ?)').join(' OR ');
  const args = keywords.flatMap((k) => [`%${k}%`, `%${k}%`]);
  db.prepare(
    `SELECT i.id, i.title, i.snippet, i.link, i.source, i.published_at, i.hidden, f.title AS feed_title, f.country
       FROM news_items i JOIN news_feeds f ON f.id = i.feed_id
      WHERE f.enabled = 1 ${includeHidden ? '' : 'AND i.hidden = 0'} ${country ? 'AND (f.country IS NULL OR f.country = ?)' : ''}
        AND (${likes})
      ORDER BY i.published_at DESC LIMIT ?`
  ).all(...(country ? [country] : []), ...args, limit * 2).forEach((r) => {
    if (!siteAllowed(hostOf(r.link), sites)) return;
    const keyword = keywords.find((k) => mentions(r.title + ' ' + r.snippet, k));
    if (!keyword) return; // LIKE also hits inside longer words
    out.push({ id: 'n' + r.id, country: r.country || null, keyword, title: r.title, link: r.link, source: r.source || r.feed_title || hostOf(r.link), at: r.published_at, hidden: !!r.hidden });
  });

  // Newest first, one per headline.
  out.sort((a, b) => b.at - a.at);
  const seen = new Set();
  return out.filter((a) => {
    const key = a.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

// Hide / show one alert ('a<id>' = Google News result, 'n<id>' = News feed
// headline, which is then hidden from News too). A Google News result is
// hidden in every country it was found in.
function setHidden(id, hidden) {
  const m = /^([an])(\d+)$/.exec(String(id));
  if (!m) return false;
  if (m[1] === 'n') return db.prepare('UPDATE news_items SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, m[2]).changes > 0;
  return db.prepare('UPDATE alert_items SET hidden = ? WHERE guid = (SELECT guid FROM alert_items WHERE id = ?)')
    .run(hidden ? 1 : 0, m[2]).changes > 0;
}

module.exports = { start, fetchAll, prepareCountry, getConfig, setConfig, listAlerts, setHidden, lastFetch, MAX_KEYWORDS, MAX_SITES };
