'use strict';

// Job openings in the Alerts panel on Recent Activity.
//
// Jobs come from job-board RSS feeds the admin manages (Admin → Activity →
// Job alerts), each tagged with the country its jobs are in (none = anywhere,
// e.g. remote jobs). A starter set is added once on first run. Only sites that
// publish a jobs feed can be used: Indeed closed its RSS feeds and Naukri has
// none for listings, and both forbid scraping, so they aren't included.
//
// Like News, only the job title, link, source and date are stored; members tap
// through to read and apply on the job board itself. Optional admin keywords
// narrow the jobs shown (e.g. "fresher, intern, developer").

const db = require('./db');
const { getSetting, setSetting } = require('./settings');
const news = require('./news');
const countries = require('./newsCountries');

const FETCH_EVERY_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_FEED_BYTES = 3 * 1024 * 1024;
const KEEP_PER_FEED = 60;
const KEEP_DAYS = 21;
const SHOW_LIMIT = 30;
const MAX_KEYWORDS = 25;

db.exec(`
  CREATE TABLE IF NOT EXISTS job_feeds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL DEFAULT '',
    country         TEXT,                        -- NULL = jobs anywhere (shown to every country)
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_fetched_at INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS job_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id      INTEGER NOT NULL REFERENCES job_feeds(id) ON DELETE CASCADE,
    guid         TEXT NOT NULL,
    title        TEXT NOT NULL,
    link         TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    fetched_at   INTEGER NOT NULL,
    hidden       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (feed_id, guid)
  );
  CREATE INDEX IF NOT EXISTS idx_job_items_pub ON job_items (published_at);
`);

// [url, name, country] — all checked to be live job feeds when added.
const STARTER_FEEDS = [
  ['https://www.freshersworld.com/feed', 'Freshersworld', 'India'],
  ['https://www.freejobalert.com/feed/', 'FreeJobAlert (government jobs)', 'India'],
  ['https://www.sarkariresult.com/feed/', 'Sarkari Result (government jobs & exams)', 'India'],
  ['https://weworkremotely.com/remote-jobs.rss', 'We Work Remotely (remote jobs)', null],
];

function seedStarterFeeds() {
  if (getSetting('jobs_seeded', null)) return;
  const ins = db.prepare(
    'INSERT INTO job_feeds (url, title, country, enabled, created_at) VALUES (?, ?, ?, 1, ?) ON CONFLICT(url) DO NOTHING'
  );
  const now = Date.now();
  for (const [url, title, country] of STARTER_FEEDS) ins.run(url, title, country, now);
  setSetting('jobs_seeded', '1');
}

/* ---------------------------------------------------------------------------
   Keywords (optional filter)
--------------------------------------------------------------------------- */
function cleanKeywords(raw) {
  const seen = new Set();
  const out = [];
  for (const k of String(raw || '').split(/[,\n]/)) {
    const kw = k.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (kw && !seen.has(kw.toLowerCase())) { seen.add(kw.toLowerCase()); out.push(kw); }
  }
  return out.slice(0, MAX_KEYWORDS);
}

function getKeywords() { return cleanKeywords(getSetting('jobs_keywords', '')); }
function setKeywords(raw) {
  const kw = cleanKeywords(raw);
  setSetting('jobs_keywords', kw.join(', '));
  return kw;
}

function mentionsAny(text, keywords) {
  if (!keywords.length) return true;
  return keywords.some((k) => {
    const esc = k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
  });
}

/* ---------------------------------------------------------------------------
   Fetching
--------------------------------------------------------------------------- */
// Tidy a job title: drop unfilled template tokens some boards leak
// ("#!job_role!# Job Opening in …") and stray separators.
function cleanTitle(t) {
  return String(t || '').replace(/#![^#]*!#/g, ' ')
    .replace(/(\p{Ll})(Jobs? (?:Opening|Vacanc))/gu, '$1 $2') // "AssistantJobs Opening"
    .replace(/\s+/g, ' ').replace(/^[\s\-–—|:,]+/, '').trim();
}

// Drop tracking parameters (utm_*, src) from a job link.
function cleanLink(u) {
  try {
    const url = new URL(u);
    [...url.searchParams.keys()].forEach((k) => { if (/^utm_|^src$/i.test(k)) url.searchParams.delete(k); });
    return url.href;
  } catch (_e) {
    return u;
  }
}

async function fetchFeed(feed) {
  const now = Date.now();
  try {
    const res = await fetch(feed.url, {
      headers: { 'user-agent': 'getxmatch-news/1.0 (+https://getxmatch.com)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FEED_BYTES) throw new Error('Feed is too large.');
    const { title, items } = news.parseFeed(buf.toString('utf8'));
    if (!items.length) throw new Error('No items found — is this an RSS or Atom feed?');

    const ins = db.prepare(
      `INSERT INTO job_items (feed_id, guid, title, link, published_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(feed_id, guid) DO NOTHING`
    );
    let added = 0;
    for (const it of items) {
      const jobTitle = cleanTitle(it.title);
      if (jobTitle.length < 4) continue;
      const pub = it.publishedAt && it.publishedAt <= now ? it.publishedAt : now;
      if (now - pub > KEEP_DAYS * 86400000) continue;
      added += ins.run(feed.id, it.guid, jobTitle, cleanLink(it.link), pub, now).changes;
    }
    db.prepare(
      `DELETE FROM job_items WHERE feed_id = ? AND (published_at < ? OR id NOT IN
         (SELECT id FROM job_items WHERE feed_id = ? ORDER BY published_at DESC LIMIT ?))`
    ).run(feed.id, now - KEEP_DAYS * 86400000, feed.id, KEEP_PER_FEED);
    db.prepare("UPDATE job_feeds SET last_fetched_at = ?, last_error = NULL, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?")
      .run(now, title || new URL(feed.url).hostname, feed.id);
    return { ok: true, added, found: items.length };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    db.prepare('UPDATE job_feeds SET last_fetched_at = ?, last_error = ? WHERE id = ?').run(now, msg, feed.id);
    return { ok: false, error: msg };
  }
}

let running = false;
async function fetchAll() {
  if (running) return;
  running = true;
  try {
    const feeds = db.prepare('SELECT id, url FROM job_feeds WHERE enabled = 1').all();
    for (const f of feeds) await fetchFeed(f);
  } finally {
    running = false;
  }
}

function start() {
  seedStarterFeeds();
  setTimeout(() => fetchAll().catch(() => {}), 25000).unref();
  setInterval(() => fetchAll().catch(() => {}), FETCH_EVERY_MS).unref();
}

/* ---------------------------------------------------------------------------
   Reading
--------------------------------------------------------------------------- */
function sourceOf(r) {
  if (r.feed_title) return r.feed_title;
  try { return new URL(r.link).hostname.replace(/^www\./, ''); } catch (_e) { return 'Jobs'; }
}

// Latest jobs, newest first and taking turns between job boards (so one busy
// board can't crowd out the rest). `country` = that country's jobs plus jobs
// anywhere; null (Worldwide) = every feed. `includeHidden` is for the admin.
function listJobs({ country = null, limit = SHOW_LIMIT, includeHidden = false } = {}) {
  const keywords = includeHidden ? [] : getKeywords();
  const conds = ['f.enabled = 1'];
  const args = [];
  if (!includeHidden) conds.push('i.hidden = 0');
  if (country) { conds.push('(f.country IS NULL OR f.country = ?)'); args.push(country); }
  const rows = db.prepare(
    `SELECT i.id, i.feed_id, i.title, i.link, i.published_at, i.hidden, f.title AS feed_title, f.country
       FROM job_items i JOIN job_feeds f ON f.id = i.feed_id
      WHERE ${conds.join(' AND ')}
      ORDER BY i.published_at DESC LIMIT 2000`
  ).all(...args);
  // Round-robin across feeds, each in newest-first order.
  const byFeed = new Map();
  rows.forEach((r) => {
    if (!byFeed.has(r.feed_id)) byFeed.set(r.feed_id, []);
    byFeed.get(r.feed_id).push(r);
  });
  const queues = [...byFeed.values()];
  const mixed = [];
  for (let i = 0; mixed.length < rows.length; i++) queues.forEach((q) => { if (q[i]) mixed.push(q[i]); });
  const seen = new Set();
  const out = [];
  for (const r of mixed) {
    const key = r.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (seen.has(key) || !mentionsAny(r.title, keywords)) continue;
    seen.add(key);
    out.push({ id: r.id, title: r.title, link: r.link, source: sourceOf(r), country: r.country || null, at: r.published_at, hidden: !!r.hidden });
    if (out.length >= limit) break;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   The country a member sees jobs for (profiles.jobs_country): one they pick,
   'Worldwide' for every country, or — until they pick — the same country as
   their alerts and news.
--------------------------------------------------------------------------- */
function jobsCountryFor(userId) {
  const r = db.prepare('SELECT jobs_country FROM profiles WHERE user_id = ?').get(userId);
  const v = r && r.jobs_country;
  if (v === countries.WORLDWIDE || countries.isCountry(v)) return { country: v, chosen: true };
  return { country: countries.forUser(userId).country, chosen: false };
}

// Save a member's pick ('' = follow the alerts country again).
function setJobsCountry(userId, country) {
  const v = country === countries.WORLDWIDE || countries.isCountry(country) ? country : null;
  db.prepare('UPDATE profiles SET jobs_country = ? WHERE user_id = ?').run(v, userId);
  return jobsCountryFor(userId);
}

// Countries that have an enabled job feed of their own (the picker lists
// these; other countries only get the "Anywhere" feeds).
function countriesWithJobs() {
  return db.prepare('SELECT DISTINCT country FROM job_feeds WHERE enabled = 1 AND country IS NOT NULL ORDER BY country')
    .all().map((r) => r.country);
}

/* ---------------------------------------------------------------------------
   Admin
--------------------------------------------------------------------------- */
function feedRows() {
  return db.prepare(
    `SELECT f.*, (SELECT COUNT(*) FROM job_items i WHERE i.feed_id = f.id) AS items
       FROM job_feeds f ORDER BY f.created_at, f.id`
  ).all().map((f) => ({
    id: f.id,
    url: f.url,
    title: f.title || '',
    country: f.country || null,
    enabled: !!f.enabled,
    lastFetchedAt: f.last_fetched_at || null,
    lastError: f.last_error || null,
    items: f.items,
  }));
}

function cleanCountry(c) {
  return c && countries.isCountry(c) ? c : null;
}

// Add a feed and fetch it straight away.
async function addFeed({ url, title, country }) {
  const safe = news.safeUrl(url);
  if (!safe) return { error: 'Enter the feed’s full http(s) address.' };
  if (db.prepare('SELECT 1 FROM job_feeds WHERE url = ?').get(safe)) return { error: 'That feed is already on the list.' };
  const info = db.prepare('INSERT INTO job_feeds (url, title, country, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(safe, String(title || '').trim().slice(0, 120), cleanCountry(country), Date.now());
  return { result: await fetchFeed({ id: Number(info.lastInsertRowid), url: safe }) };
}

function updateFeed(id, b) {
  const f = db.prepare('SELECT * FROM job_feeds WHERE id = ?').get(id);
  if (!f) return false;
  db.prepare('UPDATE job_feeds SET title = ?, country = ?, enabled = ? WHERE id = ?').run(
    b.title !== undefined ? String(b.title).trim().slice(0, 120) : f.title,
    b.country !== undefined ? cleanCountry(b.country) : f.country,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : f.enabled,
    f.id
  );
  return true;
}

function deleteFeed(id) {
  db.prepare('DELETE FROM job_items WHERE feed_id = ?').run(id);
  return db.prepare('DELETE FROM job_feeds WHERE id = ?').run(id).changes > 0;
}

function fetchOne(id) {
  const f = db.prepare('SELECT id, url FROM job_feeds WHERE id = ?').get(id);
  return f ? fetchFeed(f) : null;
}

function setHidden(id, hidden) {
  return db.prepare('UPDATE job_items SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, id).changes > 0;
}

module.exports = {
  start, fetchAll, fetchOne, listJobs, jobsCountryFor, setJobsCountry, countriesWithJobs, feedRows, addFeed, updateFeed, deleteFeed, setHidden,
  getKeywords, setKeywords, MAX_KEYWORDS,
};
