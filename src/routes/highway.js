'use strict';

// "Highway" — a shared public pool of posts. Any registered user can post text,
// an image and/or links (YouTube/Instagram/Facebook/…). The pool keeps only the
// newest 100 posts; older ones (and their uploaded images) are pruned when new
// posts arrive. Each post shows who posted it, and viewers can send that person
// a relationship request straight from the post.

const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth');
const { imageUpload } = require('../upload');
const { friendState } = require('../profileData');
const { broadcastHighway } = require('../socket');

const router = express.Router();

const MAX_POSTS = 100;
const BODY_MAX = 2000;

const postLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are posting too fast. Please wait a moment.' },
});

function removeUpload(filename) {
  if (!filename) return;
  fs.promises.unlink(path.join(config.uploadsDir, path.basename(filename))).catch(() => {});
}

// Shape a post row (already joined with its author) for the client. `viewerId`
// determines the relationship state shown on the post.
function shapePost(r, viewerId) {
  return {
    id: r.id,
    body: r.body || '',
    image: r.image ? `/uploads/${r.image}` : null,
    createdAt: r.created_at,
    author: {
      id: r.user_id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
    },
    mine: r.user_id === viewerId,
    friendState: friendState(r.user_id, viewerId),
  };
}

const POST_SELECT =
  `SELECT h.id, h.user_id, h.body, h.image, h.created_at,
          u.username, p.display_name, p.avatar
     FROM highway_posts h
     JOIN users u ON u.id = h.user_id
     LEFT JOIN profiles p ON p.user_id = h.user_id`;

// GET /api/highway — newest 100 posts.
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(`${POST_SELECT} ORDER BY h.created_at DESC, h.id DESC LIMIT ?`).all(MAX_POSTS);
  res.json({ posts: rows.map((r) => shapePost(r, req.user.id)), max: MAX_POSTS });
});

// POST /api/highway — create a post (text and/or image), then prune to 100.
router.post('/', requireAuth, postLimiter, imageUpload.single('image'), (req, res) => {
  const body = String((req.body && req.body.body) || '').trim().slice(0, BODY_MAX);
  const image = req.file ? req.file.filename : null;
  if (!body && !image) {
    return res.status(400).json({ error: 'Write something or add an image to post.' });
  }

  const now = Date.now();
  const info = db.prepare('INSERT INTO highway_posts (user_id, body, image, created_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, body, image, now);

  // Prune anything beyond the newest MAX_POSTS, deleting their images too.
  const stale = db.prepare(
    'SELECT id, image FROM highway_posts WHERE id NOT IN (SELECT id FROM highway_posts ORDER BY created_at DESC, id DESC LIMIT ?)'
  ).all(MAX_POSTS);
  if (stale.length) {
    const del = db.prepare('DELETE FROM highway_posts WHERE id = ?');
    stale.forEach((s) => { del.run(s.id); removeUpload(s.image); });
  }

  const row = db.prepare(`${POST_SELECT} WHERE h.id = ?`).get(info.lastInsertRowid);
  const post = shapePost(row, req.user.id);

  // Live-push to everyone. Viewer-specific fields (mine/friendState) are filled
  // in per-client, so send the neutral author-centric shape.
  try {
    broadcastHighway({
      id: post.id, body: post.body, image: post.image, createdAt: post.createdAt,
      author: post.author, prunedIds: stale.map((s) => s.id),
    });
  } catch (_e) { /* never block the response */ }

  res.status(201).json({ post });
});

// DELETE /api/highway/:id — remove your own post.
router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, user_id, image FROM highway_posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Post not found.' });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own posts.' });
  db.prepare('DELETE FROM highway_posts WHERE id = ?').run(row.id);
  removeUpload(row.image);
  res.json({ ok: true });
});

module.exports = router;
