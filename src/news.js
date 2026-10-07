'use strict';

// News on Recent Activity: headlines from RSS / Atom feeds, matched to each
// member's areas of interest (profile interests, src/profileFields.js).
//
// The admin keeps a list of feeds (Admin → News), each tagged with the
// interests it serves and whether it's family-safe (members under 18 only see
// family-safe feeds). A background job fetches every enabled feed every
// FETCH_EVERY_MS and stores just the headline, a one-line snippet, the link and
// the publish time — never the article itself; members tap through to read it
// on the source's site. A starter set of feeds is added once on first run.

const db = require('./db');
const { getSetting, setSetting } = require('./settings');
const { INTERESTS } = require('./profileFields');

const FETCH_EVERY_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_FEED_BYTES = 3 * 1024 * 1024;
const KEEP_PER_FEED = 40; // newest items kept per feed
const KEEP_DAYS = 21; // items older than this are dropped
const MAX_TITLE = 300;
const MAX_SNIPPET = 220;

db.exec(`
  CREATE TABLE IF NOT EXISTS news_feeds (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT NOT NULL DEFAULT '',   -- the feed's own name (from the feed) or the admin's label
    interests       TEXT NOT NULL DEFAULT '[]', -- JSON array of INTERESTS it serves
    family_safe     INTEGER NOT NULL DEFAULT 1, -- shown to members under 18?
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_fetched_at INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS news_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id      INTEGER NOT NULL REFERENCES news_feeds(id) ON DELETE CASCADE,
    guid         TEXT NOT NULL,
    title        TEXT NOT NULL,
    link         TEXT NOT NULL,
    snippet      TEXT NOT NULL DEFAULT '',
    published_at INTEGER NOT NULL,
    fetched_at   INTEGER NOT NULL,
    hidden       INTEGER NOT NULL DEFAULT 0,  -- taken down by the admin
    UNIQUE (feed_id, guid)
  );
  CREATE INDEX IF NOT EXISTS idx_news_items_pub ON news_items (published_at);
`);

/* ---------------------------------------------------------------------------
   Starter feeds (all checked to be live when added). [url, interests, familySafe]
--------------------------------------------------------------------------- */
const G = (p) => `https://www.theguardian.com/${p}/rss`;
const STARTER_FEEDS = [
  [G('artanddesign'), ['Art'], 1],
  [G('music'), ['Music'], 1],
  ['https://www.billboard.com/feed/', ['Music'], 0],
  [G('film'), ['Movies'], 0],
  ['https://variety.com/feed/', ['Movies', 'TV series'], 0],
  ['https://petapixel.com/feed/', ['Photography'], 1],
  [G('artanddesign/photography'), ['Photography'], 1],
  [G('stage/dance'), ['Dancing'], 1],
  [G('stage'), ['Theatre'], 1],
  [G('books/poetry'), ['Poetry'], 1],
  [G('artanddesign/painting'), ['Painting'], 1],
  [G('artanddesign/design'), ['Design'], 1],
  [G('artanddesign/architecture'), ['Architecture'], 1],
  [G('artanddesign/museums'), ['Museums'], 1],
  [G('books'), ['Reading', 'Writing', 'Literature'], 1],
  [G('books/philosophy'), ['Philosophy'], 1],
  [G('books/history'), ['History'], 1],
  [G('education/languages'), ['Languages'], 1],
  [G('media'), ['Journalism', 'Blogging'], 1],
  [G('world/religion'), ['Mythology', 'Spirituality'], 1],
  ['https://www.theverge.com/rss/index.xml', ['Technology'], 1],
  ['https://feeds.bbci.co.uk/news/technology/rss.xml', ['Technology'], 1],
  ['https://feeds.arstechnica.com/arstechnica/index', ['Technology', 'Electronics'], 1],
  ['https://www.sciencedaily.com/rss/top/science.xml', ['Science'], 1],
  [G('science'), ['Science'], 1],
  [G('education/mathematics'), ['Mathematics'], 1],
  [G('science/physics'), ['Physics'], 1],
  [G('science/space'), ['Astronomy'], 1],
  [G('science/biology'), ['Biology'], 1],
  [G('science/chemistry'), ['Chemistry'], 1],
  ['https://github.blog/feed/', ['Programming'], 1],
  [G('technology/programming'), ['Programming'], 1],
  ['https://www.technologyreview.com/topic/artificial-intelligence/feed', ['Artificial intelligence'], 1],
  [G('technology/artificialintelligenceai'), ['Artificial intelligence'], 1],
  [G('technology/robots'), ['Robotics'], 1],
  ['https://feeds.bbci.co.uk/news/health/rss.xml', ['Medicine'], 1],
  [G('science/medical-research'), ['Medicine'], 1],
  ['https://feeds.bbci.co.uk/news/politics/rss.xml', ['Politics', 'Debating'], 1],
  [G('politics'), ['Politics', 'Debating'], 1],
  [G('business/economics'), ['Economics'], 1],
  [G('science/psychology'), ['Psychology'], 1],
  [G('society'), ['Sociology', 'Social causes'], 1],
  [G('law'), ['Law'], 1],
  [G('education'), ['Education'], 1],
  [G('environment'), ['Environment', 'Nature'], 1],
  [G('society/volunteering'), ['Volunteering'], 1],
  [G('business/entrepreneurs'), ['Entrepreneurship'], 1],
  ['https://feeds.bbci.co.uk/news/business/rss.xml', ['Finance', 'Economics'], 1],
  [G('money'), ['Finance'], 1],
  [G('travel'), ['Travel', 'Hiking', 'Camping'], 1],
  [G('food'), ['Cooking', 'Food & dining'], 1],
  [G('fashion'), ['Fashion'], 1],
  [G('lifeandstyle/fitness'), ['Fitness', 'Running'], 1],
  [G('lifeandstyle/yoga'), ['Yoga', 'Meditation'], 1],
  [G('lifeandstyle/gardens'), ['Gardening'], 1],
  [G('lifeandstyle/pets'), ['Pets'], 1],
  [G('food/coffee'), ['Coffee & tea'], 1],
  [G('lifeandstyle/craft'), ['DIY & crafts'], 1],
  ['https://feeds.bbci.co.uk/sport/rss.xml', ['Sports'], 1],
  [G('environment/wildlife'), ['Wildlife', 'Nature'], 1],
  [G('sport/cycling'), ['Cycling'], 1],
  [G('sport/swimming'), ['Swimming'], 1],
  ['https://www.espncricinfo.com/rss/content/story/feeds/0.xml', ['Cricket'], 1],
  [G('sport/cricket'), ['Cricket'], 1],
  ['https://feeds.bbci.co.uk/sport/football/rss.xml', ['Football'], 1],
  [G('sport/badminton'), ['Badminton'], 1],
  ['https://www.chess.com/rss/news', ['Chess'], 1],
  [G('sport/chess'), ['Chess'], 1],
  ['https://www.polygon.com/rss/index.xml', ['Gaming', 'Board games'], 0],
  [G('games'), ['Gaming'], 1],
  [G('tv-and-radio/podcasts'), ['Podcasts'], 1],
  [G('stage/comedy'), ['Stand-up comedy'], 0],
  ['https://www.animenewsnetwork.com/news/rss.xml', ['Anime'], 0],
  [G('culture/anime'), ['Anime'], 1],
  [G('tv-and-radio'), ['TV series'], 0],
];

function seedStarterFeeds() {
  if (getSetting('news_seeded', null)) return;
  const ins = db.prepare(
    `INSERT INTO news_feeds (url, interests, family_safe, enabled, created_at) VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(url) DO NOTHING`
  );
  const now = Date.now();
  for (const [url, interests, safe] of STARTER_FEEDS) ins.run(url, JSON.stringify(interests), safe, now);
  setSetting('news_seeded', '1');
}

/* ---------------------------------------------------------------------------
   Parsing (RSS 2.0 / RSS 1.0 / Atom) — small and dependency-free.
--------------------------------------------------------------------------- */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : m; } catch (_e) { return m; }
    }
    return ENTITIES[e.toLowerCase()] != null ? ENTITIES[e.toLowerCase()] : m;
  });
}

// Inner text of an element: CDATA unwrapped, entities decoded, tags stripped
// (descriptions often carry HTML), whitespace collapsed.
function textOf(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeEntities(s); // entity-encoded HTML becomes real tags first…
  s = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim(); // …then strip and decode again
}

function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : null;
}

function attr(tagSrc, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tagSrc);
  return m ? decodeEntities(m[2] != null ? m[2] : m[3]) : null;
}

function safeUrl(u) {
  try {
    const url = new URL(String(u || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch (_e) {
    return null;
  }
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
}

function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const channel = isAtom ? xml.replace(/<entry[\s>][\s\S]*$/i, '') : (tag(xml, 'channel') || xml).replace(/<item[\s>][\s\S]*$/i, '');
  const feedTitle = clip(textOf(tag(channel, 'title')), 120);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) || [];
  const items = [];
  for (const b of blocks) {
    const title = clip(textOf(tag(b, 'title')), MAX_TITLE);
    let link = null;
    if (isAtom) {
      const links = b.match(/<link\b[^>]*>/gi) || [];
      const alt = links.find((l) => !/\srel\s*=/.test(l) || /\srel\s*=\s*["']alternate["']/i.test(l)) || links[0];
      link = alt ? attr(alt, 'href') : null;
    } else {
      link = textOf(tag(b, 'link'));
      if (!link) {
        const g = /<guid[^>]*isPermaLink\s*=\s*["']?true[^>]*>([\s\S]*?)<\/guid>/i.exec(b) || /<guid[^>]*>(https?:[\s\S]*?)<\/guid>/i.exec(b);
        link = g ? textOf(g[1]) : null;
      }
    }
    link = safeUrl(link);
    if (!title || !link) continue;
    const guid = clip(textOf(tag(b, isAtom ? 'id' : 'guid')) || link, 500);
    const dateRaw = textOf(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const when = Date.parse(dateRaw);
    const snippet = clip(textOf(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || ''), MAX_SNIPPET);
    // <source url="https://site">Site name</source> (aggregators like Google News).
    const src = /<source\b([^>]*)>([\s\S]*?)<\/source>/i.exec(b);
    const sourceName = src ? clip(textOf(src[2]), 120) : '';
    const sourceUrl = src ? safeUrl(attr(src[1], 'url')) : null;
    items.push({ guid, title, link, snippet: snippet === title ? '' : snippet, publishedAt: Number.isFinite(when) ? when : null, sourceName, sourceUrl });
  }
  return { title: feedTitle, items };
}

/* ---------------------------------------------------------------------------
   Fetching
--------------------------------------------------------------------------- */
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
    const { title, items } = parseFeed(buf.toString('utf8'));
    if (!items.length) throw new Error('No items found — is this an RSS or Atom feed?');

    const ins = db.prepare(
      `INSERT INTO news_items (feed_id, guid, title, link, snippet, published_at, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(feed_id, guid) DO NOTHING`
    );
    let added = 0;
    for (const it of items) {
      // Missing or future dates count as "now" so they can't pin themselves on top.
      const pub = it.publishedAt && it.publishedAt <= now ? it.publishedAt : now;
      added += ins.run(feed.id, it.guid, it.title, it.link, it.snippet, pub, now).changes;
    }
    // Keep the newest KEEP_PER_FEED, nothing older than KEEP_DAYS.
    db.prepare(
      `DELETE FROM news_items WHERE feed_id = ? AND (published_at < ? OR id NOT IN
         (SELECT id FROM news_items WHERE feed_id = ? ORDER BY published_at DESC LIMIT ?))`
    ).run(feed.id, now - KEEP_DAYS * 86400000, feed.id, KEEP_PER_FEED);
    db.prepare('UPDATE news_feeds SET last_fetched_at = ?, last_error = NULL, title = CASE WHEN title = \'\' THEN ? ELSE title END WHERE id = ?')
      .run(now, title || new URL(feed.url).hostname, feed.id);
    return { ok: true, added, found: items.length };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    db.prepare('UPDATE news_feeds SET last_fetched_at = ?, last_error = ? WHERE id = ?').run(now, msg, feed.id);
    return { ok: false, error: msg };
  }
}

let running = false;
async function fetchAll() {
  if (running) return;
  running = true;
  try {
    const feeds = db.prepare('SELECT id, url FROM news_feeds WHERE enabled = 1').all();
    for (const f of feeds) await fetchFeed(f); // one at a time: gentle on sources and on us
  } finally {
    running = false;
  }
}

function start() {
  seedStarterFeeds();
  setTimeout(() => fetchAll().catch(() => {}), 10000).unref();
  setInterval(() => fetchAll().catch(() => {}), FETCH_EVERY_MS).unref();
}

/* ---------------------------------------------------------------------------
   Reading
--------------------------------------------------------------------------- */
function parseInterestList(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch (_e) {
    return [];
  }
}

function sourceName(feed, link) {
  if (feed.title) return feed.title;
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch (_e) { return 'News'; }
}

// Headlines for a member with these interests (newest first, one per link).
function itemsForInterests(interests, { familySafeOnly = false, limit = 25 } = {}) {
  const wanted = new Set(interests || []);
  if (!wanted.size) return [];
  const feeds = db.prepare('SELECT id, title, interests, family_safe FROM news_feeds WHERE enabled = 1').all()
    .map((f) => ({ ...f, interestList: parseInterestList(f.interests).filter((i) => wanted.has(i)) }))
    .filter((f) => f.interestList.length && (!familySafeOnly || f.family_safe));
  if (!feeds.length) return [];
  const byId = new Map(feeds.map((f) => [f.id, f]));
  const marks = feeds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, feed_id, title, link, snippet, published_at FROM news_items
      WHERE hidden = 0 AND feed_id IN (${marks}) ORDER BY published_at DESC LIMIT ?`
  ).all(...feeds.map((f) => f.id), limit * 4);
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = r.link.replace(/[?#].*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const f = byId.get(r.feed_id);
    out.push({
      id: r.id,
      title: r.title,
      link: r.link,
      snippet: r.snippet,
      source: sourceName(f, r.link),
      interest: f.interestList[0],
      at: r.published_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  INTERESTS,
  clip,
  start,
  fetchAll,
  fetchFeed,
  parseFeed,
  safeUrl,
  parseInterestList,
  itemsForInterests,
};
