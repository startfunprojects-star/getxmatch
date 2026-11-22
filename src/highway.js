'use strict';

// Shared Highway data helpers used by the member API, the public page and the
// admin dashboard. Posts are kept permanently (they make up each member's
// timeline); the Highway itself shows a ranked selection of recent ones — see
// recommend() below. Display order for the public page and admin list:
// admin-pinned posts first (by pin_rank 1..10, then recency), then the newest
// MAX_POSTS others.

const db = require('./db');

const MAX_POSTS = 100;

const SELECT =
  `SELECT h.id, h.user_id, h.body, h.image, h.origin_kind, h.origin_a, h.origin_b,
          h.pinned, h.pin_rank, h.created_at,
          u.username, p.display_name, p.avatar
     FROM highway_posts h
     JOIN users u ON u.id = h.user_id
     LEFT JOIN profiles p ON p.user_id = h.user_id`;

// A post's photos/videos in order: [{ filename, kind }]. Older posts have only
// the single `image` column.
function postMedia(postId, legacyImage) {
  const rows = db.prepare('SELECT filename, kind FROM highway_media WHERE post_id = ? ORDER BY position, id').all(postId);
  if (rows.length) return rows;
  return legacyImage ? [{ filename: legacyImage, kind: 'image' }] : [];
}

// Every uploaded file belonging to a post (to unlink when it's deleted).
function postFiles(postId) {
  const row = db.prepare('SELECT image FROM highway_posts WHERE id = ?').get(postId);
  const files = new Set(postMedia(postId, row && row.image).map((m) => m.filename));
  if (row && row.image) files.add(row.image);
  return [...files];
}

// Create a Highway post. `opts.origin` is { kind, a, b } linking the post to a
// conversation, or null. `opts.media` is [{ filename, kind }] (photos and
// videos, in order); `opts.image` a single photo (older callers). Returns { id }.
function createPost(opts) {
  const now = Date.now();
  const media = opts.media || (opts.image ? [{ filename: opts.image, kind: 'image' }] : []);
  const firstImage = (media.find((m) => m.kind === 'image') || {}).filename || null;
  const info = db
    .prepare(
      `INSERT INTO highway_posts (user_id, body, image, origin_kind, origin_a, origin_b, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.userId,
      opts.body || '',
      firstImage,
      opts.origin ? opts.origin.kind : null,
      opts.origin ? opts.origin.a : null,
      opts.origin ? opts.origin.b : null,
      now
    );
  const ins = db.prepare('INSERT INTO highway_media (post_id, filename, kind, position) VALUES (?, ?, ?, ?)');
  media.forEach((m, i) => ins.run(info.lastInsertRowid, m.filename, m.kind, i));
  return { id: info.lastInsertRowid };
}

// Sort a set of rows into display order.
function orderRows(rows) {
  const pinned = rows.filter((r) => r.pinned)
    .sort((a, b) => (a.pin_rank || 99) - (b.pin_rank || 99) || b.created_at - a.created_at);
  const rest = rows.filter((r) => !r.pinned).sort((a, b) => b.created_at - a.created_at);
  return pinned.concat(rest);
}

// Pinned posts plus the newest MAX_POSTS others, in display order (the public
// Highway page and the admin list).
function allOrdered() {
  return orderRows(db.prepare(
    `${SELECT} WHERE h.pinned = 1
        OR h.id IN (SELECT id FROM highway_posts WHERE pinned = 0 ORDER BY created_at DESC, id DESC LIMIT ?)`
  ).all(MAX_POSTS));
}

// Every post by one member, newest first (their timeline).
function byAuthor(userId) {
  return db.prepare(`${SELECT} WHERE h.user_id = ? ORDER BY h.created_at DESC, h.id DESC`).all(userId);
}

function byId(id) {
  return db.prepare(`${SELECT} WHERE h.id = ?`).get(id);
}

// --- Recommendations. The Highway is each member's own ranked feed, built from
// recent posts (the newest CANDIDATES) using what we know they like:
//   • their areas of interest, plus topics of the posts they have liked —
//     a post whose text (or listed blog's title/category/tags) mentions one
//     scores higher;
//   • authors they follow, are connected with, or have liked before;
//   • authors "near" them (shared interests, same country, same decade);
//   • how much the post is being liked and commented on;
//   • freshness (a post loses a point every 12 hours).
// A post is shown only when at least one personal signal links it to the
// viewer (see eligible()); the viewer's own posts and admin-pinned posts
// always are. Pinned posts stay on top; the rest are ordered by score.
const CANDIDATES = 500;
const MIN_SHARED_INTERESTS = 5;

const STOPWORDS = new Set(['and', 'the', 'for', 'with', 'general', 'other']);

// Interest label → the word stems that count as a mention ("Food & dining" →
// food, dining). Matched at a word start, so "travel" also finds "travelling".
const stemCache = new Map();
function interestStems(label) {
  if (!stemCache.has(label)) {
    const words = String(label).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    stemCache.set(label, words.map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)));
  }
  return stemCache.get(label);
}
function mentions(text, label) {
  const stems = interestStems(label);
  return stems.length > 0 && stems.some((re) => re.test(text));
}

function parseInterests(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && s.trim()) : [];
  } catch (_e) { return []; }
}

function affinityRow(userId) {
  const r = db.prepare('SELECT country, date_of_birth, interests FROM profiles WHERE user_id = ?').get(userId);
  const labels = parseInterests(r && r.interests);
  const country = r && r.country ? String(r.country).trim().toLowerCase() : '';
  const year = r && r.date_of_birth ? parseInt(String(r.date_of_birth).slice(0, 4), 10) : NaN;
  return {
    country,
    decade: Number.isFinite(year) ? Math.floor(year / 10) : null,
    labels,
    interests: new Set(labels.map((s) => s.trim().toLowerCase())),
  };
}

function sharedInterests(a, b) {
  let n = 0;
  for (const i of a.interests) if (b.interests.has(i)) n++;
  return n;
}

function isNear(a, b) {
  if (a.country && a.country === b.country) return true;
  if (a.decade !== null && a.decade === b.decade) return true;
  return sharedInterests(a, b) >= MIN_SHARED_INTERESTS;
}

// The searchable text of a post: its body, plus a listed blog's title,
// category, excerpt and tags.
function postText(row) {
  let text = row.body || '';
  if (row.origin_kind === 'blog' && row.origin_a) {
    const b = db.prepare('SELECT title, excerpt, category, tags FROM blogs WHERE id = ?').get(row.origin_a);
    if (b) text += ` ${b.title || ''} ${b.excerpt || ''} ${b.category || ''} ${parseInterests(b.tags).join(' ')}`;
  }
  return text.toLowerCase();
}

// Everything about the viewer the ranking needs, gathered once per request.
function viewerContext(viewerId) {
  const me = affinityRow(viewerId);
  const { INTERESTS } = require('./profileFields');

  // Authors the viewer has liked, and how often (Highway posts, older pruned
  // likes, blog posts and gallery photos/reels).
  const likedAuthors = new Map();
  const addLikes = (rows) => rows.forEach((r) => likedAuthors.set(r.author, (likedAuthors.get(r.author) || 0) + r.n));
  addLikes(db.prepare(`SELECT hp.user_id AS author, COUNT(*) AS n FROM highway_likes hl
    JOIN highway_posts hp ON hp.id = hl.post_id WHERE hl.user_id = ? GROUP BY hp.user_id`).all(viewerId));
  addLikes(db.prepare('SELECT author_id AS author, COUNT(*) AS n FROM highway_like_archive WHERE liker_id = ? GROUP BY author_id').all(viewerId));
  addLikes(db.prepare(`SELECT b.user_id AS author, COUNT(*) AS n FROM blog_likes bl
    JOIN blogs b ON b.id = bl.blog_id WHERE bl.user_id = ? AND b.user_id IS NOT NULL GROUP BY b.user_id`).all(viewerId));
  addLikes(db.prepare(`SELECT g.user_id AS author, COUNT(*) AS n FROM gallery_reactions gr
    JOIN gallery_photos g ON g.id = gr.photo_id WHERE gr.user_id = ? GROUP BY g.user_id`).all(viewerId));
  likedAuthors.delete(viewerId);

  // Topic weights: declared interests count 1; every recent liked post that
  // mentions an interest adds 0.5 to it (capped at 3), so the feed learns
  // from likes even for topics the viewer never ticked.
  const topics = new Map(me.labels.map((l) => [l, 1]));
  const liked = db.prepare(`SELECT hp.body, hp.origin_kind, hp.origin_a FROM highway_likes hl
    JOIN highway_posts hp ON hp.id = hl.post_id WHERE hl.user_id = ? ORDER BY hl.created_at DESC LIMIT 200`).all(viewerId);
  const likedBlogs = db.prepare(`SELECT '' AS body, 'blog' AS origin_kind, bl.blog_id AS origin_a FROM blog_likes bl
    WHERE bl.user_id = ? ORDER BY bl.created_at DESC LIMIT 100`).all(viewerId);
  for (const row of liked.concat(likedBlogs)) {
    const text = postText(row);
    for (const label of INTERESTS) {
      if (mentions(text, label)) topics.set(label, Math.min(3, (topics.get(label) || 0) + 0.5));
    }
  }

  const follows = new Set(db.prepare('SELECT followee_id AS id FROM follows WHERE follower_id = ?').all(viewerId).map((r) => r.id));
  db.prepare(`SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id
      FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`)
    .all(viewerId, viewerId, viewerId).forEach((r) => follows.add(r.id));

  const blocked = new Set(db.prepare(`SELECT CASE WHEN blocker_id = ? THEN blocked_id ELSE blocker_id END AS id
      FROM blocks WHERE blocker_id = ? OR blocked_id = ?`).all(viewerId, viewerId, viewerId).map((r) => r.id));

  const authorCache = new Map();
  const author = (id) => {
    if (!authorCache.has(id)) authorCache.set(id, affinityRow(id));
    return authorCache.get(id);
  };
  return { viewerId, me, topics, likedAuthors, follows, blocked, author };
}

// The personal signals linking a post to the viewer, with a score and the
// strongest reason (shown on the card as "Because …").
function signals(ctx, authorId, text) {
  const out = { score: 0, linked: false, why: null, whyWeight: 0 };
  const reason = (w, why) => { if (w > out.whyWeight) { out.whyWeight = w; out.why = why; } };
  if (authorId === ctx.viewerId) { out.linked = true; out.score += 6; return out; }

  if (ctx.follows.has(authorId)) { out.linked = true; out.score += 10; reason(10, 'You follow them'); }

  const likes = ctx.likedAuthors.get(authorId) || 0;
  if (likes) { out.linked = true; const w = Math.min(likes, 5) * 3; out.score += w; reason(w, 'You liked their posts'); }

  let topicW = 0, bestTopic = null, bestW = 0;
  for (const [label, w] of ctx.topics) {
    if (mentions(text, label)) {
      topicW += w;
      if (w > bestW) { bestW = w; bestTopic = label; }
    }
  }
  if (topicW) {
    out.linked = true;
    const w = Math.min(topicW * 4, 16);
    out.score += w;
    reason(w + 0.5, `Because you like ${bestTopic}`);
  }

  const a = ctx.author(authorId);
  const shared = sharedInterests(ctx.me, a);
  if (shared) { const w = Math.min(shared * 1.5, 9); out.score += w; reason(w, `${shared} interest${shared === 1 ? '' : 's'} in common`); }
  if (ctx.me.country && ctx.me.country === a.country) { out.score += 3; reason(3, 'Near you'); }
  if (ctx.me.decade !== null && ctx.me.decade === a.decade) out.score += 1;
  if (isNear(ctx.me, a)) out.linked = true;
  return out;
}

// The viewer's Highway: pinned posts first, then up to MAX_POSTS recommended
// posts by score. `hidden` is a Set of author ids to leave out (ignored).
// Returns rows with `_why` set to the reason a post was picked (or null).
function recommend(viewerId, hidden) {
  const ctx = viewerContext(viewerId);
  const rows = db.prepare(
    `${SELECT} WHERE h.pinned = 1
        OR h.id IN (SELECT id FROM highway_posts WHERE pinned = 0 ORDER BY created_at DESC, id DESC LIMIT ?)`
  ).all(CANDIDATES);
  const engagement = db.prepare(
    `SELECT (SELECT COUNT(*) FROM highway_likes WHERE post_id = ?) + (SELECT COUNT(*) FROM highway_comments WHERE post_id = ?) AS n`
  );
  const now = Date.now();
  const pinned = [];
  const scored = [];
  for (const r of rows) {
    if (hidden && hidden.has(r.user_id)) continue;
    if (ctx.blocked.has(r.user_id)) continue;
    if (r.pinned) { r._why = null; pinned.push(r); continue; }
    const s = signals(ctx, r.user_id, postText(r));
    if (!s.linked) continue;
    const ageHours = Math.max(0, now - r.created_at) / 3600000;
    const buzz = 3 * Math.log2(1 + engagement.get(r.id, r.id).n);
    r._score = s.score + buzz - ageHours / 12;
    r._why = s.why;
    scored.push(r);
  }
  pinned.sort((a, b) => (a.pin_rank || 99) - (b.pin_rank || 99) || b.created_at - a.created_at);
  scored.sort((a, b) => b._score - a._score || b.created_at - a.created_at);
  return pinned.concat(scored.slice(0, MAX_POSTS));
}

// Whether a new post by `authorId` belongs on `viewerId`'s Highway (used for
// live pushes). `text` is the post's text, for topic matching.
function canSeeAuthor(viewerId, authorId, text) {
  if (viewerId === authorId) return true;
  const ctx = viewerContext(viewerId);
  if (ctx.blocked.has(authorId)) return false;
  return signals(ctx, authorId, String(text || '').toLowerCase()).linked;
}

module.exports = {
  MAX_POSTS, MIN_SHARED_INTERESTS, SELECT, orderRows, allOrdered, byId, byAuthor, createPost,
  postMedia, postFiles,
  recommend, canSeeAuthor,
};
