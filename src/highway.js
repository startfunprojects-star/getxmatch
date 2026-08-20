'use strict';

// Shared Highway data helpers used by the member API, the public page and the
// admin dashboard. Ordering: admin-pinned posts first (by pin_rank 1..10, then
// recency), then everything else newest-first. Pinned posts are exempt from the
// 100-post prune.

const db = require('./db');

const MAX_POSTS = 100;

const SELECT =
  `SELECT h.id, h.user_id, h.body, h.image, h.pinned, h.pin_rank, h.created_at,
          u.username, p.display_name, p.avatar
     FROM highway_posts h
     JOIN users u ON u.id = h.user_id
     LEFT JOIN profiles p ON p.user_id = h.user_id`;

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

module.exports = { MAX_POSTS, SELECT, orderRows, allOrdered, byId, prune };
