'use strict';

// Advertisement engine. Ads live in named "placement" slots and are either an
// uploaded image (with a click-through link we track) or a raw HTML/JS snippet
// from an ad network. Script ads are rendered inside a sandboxed same-origin
// iframe (served by /api/ads/frame/:id with its own permissive CSP) so arbitrary
// ad code can run without weakening the main app's strict Content-Security-Policy
// or being able to read the page, its cookies or user data.

const db = require('./db');

// The full set of placement slots, with human labels for the admin UI. Keep in
// sync with the client (public/js/app.js) and the admin dashboard.
const PLACEMENTS = [
  { key: 'content_header', label: 'Content — header (top of quizzes/polls/blogs)' },
  { key: 'content_footer', label: 'Content — footer (bottom of quizzes/polls/blogs)' },
  { key: 'content_sidebar_left', label: 'Content — left sidebar' },
  { key: 'content_sidebar_right', label: 'Content — right sidebar' },
  { key: 'content_inline', label: 'Content — between items' },
  { key: 'chat_inline', label: 'Chat — after every 20 messages' },
  { key: 'live_inline', label: 'Live activity — after every 15 items' },
];
const PLACEMENT_KEYS = PLACEMENTS.map((p) => p.key);
const isPlacement = (k) => PLACEMENT_KEYS.includes(k);

// Default iframe dimensions per placement (script ads). Admin values override.
function defaultDims(placement) {
  switch (placement) {
    case 'content_sidebar_left':
    case 'content_sidebar_right':
      return { w: 300, h: 250 };
    case 'chat_inline':
    case 'live_inline':
      return { w: 0, h: 120 }; // 0 width → full-width
    default:
      return { w: 0, h: 120 };
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// All active ads in a placement, newest first.
function activeByPlacement(placement) {
  if (!isPlacement(placement)) return [];
  return db.prepare('SELECT * FROM ads WHERE placement = ? AND active = 1 ORDER BY created_at DESC').all(placement);
}

// Pick one ad for a placement. When `index` is given (repeated inline slots)
// rotate deterministically through the active ads; otherwise pick at random.
function pickForPlacement(placement, index) {
  const rows = activeByPlacement(placement);
  if (!rows.length) return null;
  if (Number.isInteger(index)) return rows[index % rows.length];
  return rows[Math.floor(Math.random() * rows.length)];
}

// A safe, JSON-friendly view of an ad for the SPA. Never leaks the raw script;
// the client embeds script ads via the sandboxed /api/ads/frame/:id route.
function publicAd(ad) {
  if (!ad) return null;
  const dims = defaultDims(ad.placement);
  return {
    id: ad.id,
    type: ad.type,
    placement: ad.placement,
    image: ad.type === 'image' && ad.image ? `/uploads/${ad.image}` : null,
    clickUrl: ad.type === 'image' ? `/api/ads/c/${ad.id}?p=${encodeURIComponent(ad.placement)}` : null,
    frameUrl: ad.type === 'script' ? `/api/ads/frame/${ad.id}` : null,
    width: ad.width || dims.w || 0,
    height: ad.height || dims.h || 250,
  };
}

// Server-rendered HTML for a single ad (used by the crawlable content pages).
function adHtml(ad) {
  if (!ad) return '';
  if (ad.type === 'image') {
    if (!ad.image) return '';
    const href = `/api/ads/c/${ad.id}?p=${encodeURIComponent(ad.placement)}`;
    return `<a class="ad-image" href="${esc(href)}" target="_blank" rel="nofollow sponsored noopener"><img src="/uploads/${esc(ad.image)}" alt="Advertisement" loading="lazy" /></a>`;
  }
  // script ad → sandboxed same-origin iframe
  const dims = defaultDims(ad.placement);
  const w = ad.width || dims.w;
  const h = ad.height || dims.h || 250;
  const style = `${w ? `width:${w}px;` : 'width:100%;'}height:${h}px;border:0;display:block;margin:0 auto;`;
  return `<iframe class="ad-frame" src="/api/ads/frame/${ad.id}" title="Advertisement" loading="lazy" scrolling="no" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms" style="${esc(style)}"></iframe>`;
}

// A full ad "slot" (label + ad) for server-rendered pages, or '' when empty.
function slotHtml(placement, index) {
  const ad = pickForPlacement(placement, index);
  if (!ad) return '';
  return `<aside class="ad-slot ad-${esc(placement)}" aria-label="Advertisement"><span class="ad-label">Advertisement</span>${adHtml(ad)}</aside>`;
}

// The document body for a script ad's sandboxed iframe. Emits the admin's raw
// snippet as-is inside its own permissive context.
function frameDocument(ad) {
  const body = ad && ad.type === 'script' ? String(ad.script || '') : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}img{max-width:100%}</style></head><body>${body}</body></html>`;
}

function recordClick(adId, placement) {
  db.prepare('INSERT INTO ad_clicks (ad_id, placement, created_at) VALUES (?, ?, ?)')
    .run(adId, placement, Date.now());
}

// Click totals for a set of time windows (all-time, 30d, 7d, today), grouped by
// placement and by ad, for the admin analytics view.
function stats() {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const windows = {
    today: now - dayMs,
    week: now - 7 * dayMs,
    month: now - 30 * dayMs,
    all: 0,
  };
  const countSince = (sql, since) => db.prepare(sql).all(since);

  // Per-placement and per-ad, for each window.
  const byPlacement = {};
  const byAd = {};
  for (const [name, since] of Object.entries(windows)) {
    countSince('SELECT placement, COUNT(*) AS n FROM ad_clicks WHERE created_at >= ? GROUP BY placement', since)
      .forEach((r) => { (byPlacement[r.placement] = byPlacement[r.placement] || {})[name] = r.n; });
    countSince('SELECT ad_id, COUNT(*) AS n FROM ad_clicks WHERE created_at >= ? GROUP BY ad_id', since)
      .forEach((r) => { (byAd[r.ad_id] = byAd[r.ad_id] || {})[name] = r.n; });
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM ad_clicks').get().n;
  return { windows: ['today', 'week', 'month', 'all'], byPlacement, byAd, total };
}

module.exports = {
  PLACEMENTS,
  PLACEMENT_KEYS,
  isPlacement,
  activeByPlacement,
  pickForPlacement,
  publicAd,
  adHtml,
  slotHtml,
  frameDocument,
  recordClick,
  stats,
};
