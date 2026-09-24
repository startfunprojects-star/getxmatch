'use strict';

// Shared Highway data helpers used by the member API, the public page and the
// admin dashboard. Ordering: admin-pinned posts first (by pin_rank 1..10, then
// recency), then everything else newest-first. Pinned posts are exempt from the
// 100-post prune.

const db = require('./db');

const MAX_POSTS = 100;

const SELECT =
  `SELECT h.id, h.user_id, h.body, h.image, h.origin_kind, h.origin_a, h.origin_b,
          h.pinned, h.pin_rank, h.created_at,
          u.username, p.display_name, p.avatar
     FROM highway_posts h
     JOIN users u ON u.id = h.user_id
     LEFT JOIN profiles p ON p.user_id = h.user_id`;

// Create a Highway post and prune the pool back to the cap. `opts.origin` is
// { kind, a, b } linking the post to a conversation, or null. Returns
// { id, prunedImages } — the caller broadcasts and unlinks the pruned images.
function createPost(opts) {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO highway_posts (user_id, body, image, origin_kind, origin_a, origin_b, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.userId,
      opts.body || '',
      opts.image || null,
      opts.origin ? opts.origin.kind : null,
      opts.origin ? opts.origin.a : null,
      opts.origin ? opts.origin.b : null,
      now
    );
  const prunedImages = prune().filter(Boolean);
  return { id: info.lastInsertRowid, prunedImages };
}

// Sort a set of rows into display order.
function orderRows(rows) {
  const pinned = rows.filter((r) => r.pinned)
    .sort((a, b) => (a.pin_rank || 99) - (b.pin_rank || 99) || b.created_at - a.created_at);
  const rest = rows.filter((r) => !r.pinned).sort((a, b) => b.created_at - a.created_at);
  return pinned.concat(rest);
}

// Every post, in display order (the pool is capped near 100 so this is small).
function allOrdered() {
  return orderRows(db.prepare(SELECT).all());
}

function byId(id) {
  return db.prepare(`${SELECT} WHERE h.id = ?`).get(id);
}

// Prune unpinned posts beyond the newest (MAX_POSTS − pinnedCount). Pinned posts
// are always kept. Returns the image filenames of deleted rows (to unlink).
function prune() {
  const pinnedCount = db.prepare('SELECT COUNT(*) AS n FROM highway_posts WHERE pinned = 1').get().n;
  const keepUnpinned = Math.max(0, MAX_POSTS - pinnedCount);
  const stale = db.prepare(
    `SELECT id, image FROM highway_posts
      WHERE pinned = 0
        AND id NOT IN (SELECT id FROM highway_posts WHERE pinned = 0 ORDER BY created_at DESC, id DESC LIMIT ?)`
  ).all(keepUnpinned);
  const del = db.prepare('DELETE FROM highway_posts WHERE id = ?');
  stale.forEach((s) => del.run(s.id));
  return stale.map((s) => s.image).filter(Boolean);
}

// --- Audience rule: a member sees a post on the Highway only when its author is
// "near" them — at least MIN_SHARED_INTERESTS areas of interest in common, the
// same country, or born in the same decade. Your own posts and admin-pinned
// posts are always visible.
const MIN_SHARED_INTERESTS = 5;

function affinityRow(userId) {
  const r = db.prepare('SELECT country, date_of_birth, interests FROM profiles WHERE user_id = ?').get(userId);
  let interests = [];
  try {
    const arr = JSON.parse((r && r.interests) || '[]');
    if (Array.isArray(arr)) interests = arr.filter((s) => typeof s === 'string');
  } catch (_e) { /* treat as none */ }
  const country = r && r.country ? String(r.country).trim().toLowerCase() : '';
  const year = r && r.date_of_birth ? parseInt(String(r.date_of_birth).slice(0, 4), 10) : NaN;
  return {
    country,
    decade: Number.isFinite(year) ? Math.floor(year / 10) : null,
    interests: new Set(interests.map((s) => s.trim().toLowerCase()).filter(Boolean)),
  };
}

function isNear(a, b) {
  if (a.country && a.country === b.country) return true;
  if (a.decade !== null && a.decade === b.decade) return true;
  let shared = 0;
  for (const i of a.interests) {
    if (b.interests.has(i) && ++shared >= MIN_SHARED_INTERESTS) return true;
  }
  return false;
}

// Returns canSee(authorId) for `viewerId`, caching each author's profile.
function audienceFilter(viewerId) {
  const me = affinityRow(viewerId);
  const cache = new Map();
  return (authorId) => {
    if (authorId === viewerId) return true;
    if (!cache.has(authorId)) cache.set(authorId, isNear(me, affinityRow(authorId)));
    return cache.get(authorId);
  };
}

// Whether `viewerId` may see a new post by `authorId` (used for live pushes).
function canSeeAuthor(viewerId, authorId) {
  return viewerId === authorId || isNear(affinityRow(viewerId), affinityRow(authorId));
}

module.exports = {
  MAX_POSTS, MIN_SHARED_INTERESTS, SELECT, orderRows, allOrdered, byId, prune, createPost,
  audienceFilter, canSeeAuthor,
};
