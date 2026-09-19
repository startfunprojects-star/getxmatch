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
const { areBlocked } = require('../relations');
const { broadcastHighway } = require('../socket');
const hw = require('../highway');

const router = express.Router();

const BODY_MAX = 2000;
const COMMENT_MAX = 500;

// Aggregated like state for a post, plus whether the viewer has liked it.
function likeState(postId, viewerId) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM highway_likes WHERE post_id = ?').get(postId).n;
  const mine = viewerId
    ? !!db.prepare('SELECT 1 FROM highway_likes WHERE post_id = ? AND user_id = ?').get(postId, viewerId)
    : false;
  return { count, mine };
}

// Shape one comment row for the client. The comment's author or the post's
// author may delete it.
function shapeComment(r, viewerId, postAuthorId) {
  return {
    id: r.id,
    body: r.body,
    at: r.created_at,
    author: {
      id: r.author_id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
    },
    canDelete: !!viewerId && (viewerId === r.author_id || viewerId === postAuthorId),
  };
}

// All comments on a post, oldest first (natural reading order).
function postComments(postId, viewerId, postAuthorId) {
  const rows = db
    .prepare(
      `SELECT c.id, c.author_id, c.body, c.created_at, u.username, p.display_name, p.avatar
         FROM highway_comments c
         JOIN users u ON u.id = c.author_id
         LEFT JOIN profiles p ON p.user_id = c.author_id
        WHERE c.post_id = ?
        ORDER BY c.created_at ASC
        LIMIT 500`
    )
    .all(postId);
  return rows.map((r) => shapeComment(r, viewerId, postAuthorId));
}

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
    pinned: !!r.pinned,
    pinRank: r.pinned ? (r.pin_rank || null) : null,
    likes: likeState(r.id, viewerId),
    commentCount: db.prepare('SELECT COUNT(*) AS n FROM highway_comments WHERE post_id = ?').get(r.id).n,
  };
}

// GET /api/highway — the pool in display order (pinned first, then newest).
router.get('/', requireAuth, (req, res) => {
  res.json({ posts: hw.allOrdered().map((r) => shapePost(r, req.user.id)), max: hw.MAX_POSTS });
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

  // Prune unpinned posts beyond the cap, deleting their images too.
  hw.prune().forEach(removeUpload);

  const row = hw.byId(info.lastInsertRowid);
  const post = shapePost(row, req.user.id);

  // Live-push to everyone. Viewer-specific fields (mine/friendState) are filled
  // in per-client, so send the neutral author-centric shape.
  try {
    broadcastHighway({
      id: post.id, body: post.body, image: post.image, createdAt: post.createdAt,
      author: post.author,
    });
  } catch (_e) { /* never block the response */ }

  res.status(201).json({ post });
});

// Resolve a :id param to its post row (id + author). Sends the error itself and
// returns null when invalid/not found.
function resolvePost(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id) { res.status(400).json({ error: 'Invalid post.' }); return null; }
  const post = db.prepare('SELECT id, user_id FROM highway_posts WHERE id = ?').get(id);
  if (!post) { res.status(404).json({ error: 'Post not found.' }); return null; }
  return post;
}

// GET /api/highway/:id/comments — the comment thread for one post.
router.get('/:id/comments', requireAuth, (req, res) => {
  const post = resolvePost(req, res);
  if (!post) return;
  res.json({ comments: postComments(post.id, req.user.id, post.user_id) });
});

// POST /api/highway/:id/like — toggle the viewer's like on a post.
router.post('/:id/like', requireAuth, (req, res) => {
  const post = resolvePost(req, res);
  if (!post) return;
  if (areBlocked(req.user.id, post.user_id)) {
    return res.status(403).json({ error: 'You cannot like this while a block is in place.' });
  }
  const existing = db.prepare('SELECT id FROM highway_likes WHERE post_id = ? AND user_id = ?').get(post.id, req.user.id);
  if (existing) {
    db.prepare('DELETE FROM highway_likes WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO highway_likes (post_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(post.id, req.user.id, Date.now());
  }
  res.json({ likes: likeState(post.id, req.user.id) });
});

// POST /api/highway/:id/comment  { body } — add a comment to a post.
router.post('/:id/comment', requireAuth, (req, res) => {
  const post = resolvePost(req, res);
  if (!post) return;
  if (areBlocked(req.user.id, post.user_id)) {
    return res.status(403).json({ error: 'You cannot comment while a block is in place.' });
  }
  const body = String((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (body.length > COMMENT_MAX) return res.status(400).json({ error: `Comment must be ${COMMENT_MAX} characters or fewer.` });

  const now = Date.now();
  const info = db.prepare('INSERT INTO highway_comments (post_id, author_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(post.id, req.user.id, body, now);
  const me = db.prepare('SELECT display_name, avatar FROM profiles WHERE user_id = ?').get(req.user.id);
  res.status(201).json({
    comment: {
      id: info.lastInsertRowid,
      body,
      at: now,
      author: {
        id: req.user.id,
        username: req.user.username,
        displayName: (me && me.display_name) || req.user.username,
        avatar: me && me.avatar ? `/uploads/${me.avatar}` : null,
      },
      canDelete: true,
    },
    commentCount: db.prepare('SELECT COUNT(*) AS n FROM highway_comments WHERE post_id = ?').get(post.id).n,
  });
});

// DELETE /api/highway/comment/:id — the comment's author or the post's author.
router.delete('/comment/:id', requireAuth, (req, res) => {
  const row = db
    .prepare(
      `SELECT c.id, c.author_id, c.post_id, h.user_id AS post_author_id
         FROM highway_comments c
         JOIN highway_posts h ON h.id = c.post_id
        WHERE c.id = ?`
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Comment not found.' });
  if (row.author_id !== req.user.id && row.post_author_id !== req.user.id) {
    return res.status(403).json({ error: 'You cannot delete this comment.' });
  }
  db.prepare('DELETE FROM highway_comments WHERE id = ?').run(row.id);
  res.json({ ok: true, commentCount: db.prepare('SELECT COUNT(*) AS n FROM highway_comments WHERE post_id = ?').get(row.post_id).n });
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
