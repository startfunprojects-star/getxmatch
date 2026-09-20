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
const { areBlocked, ignoredIds } = require('../relations');
const { broadcastHighway, notifyHighwayEvent, broadcastLeaderboardChange } = require('../socket');
const hw = require('../highway');

const router = express.Router();

const BODY_MAX = 2000;
const COMMENT_MAX = 500;

function parseJson(raw, fallback) {
  try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch (_e) { return fallback; }
}

function nameOf(userId) {
  const r = db.prepare('SELECT p.display_name, u.username FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?').get(userId);
  return (r && (r.display_name || r.username)) || 'Someone';
}

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
    captions: parseJson(r.captions, []),
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

// GET /api/highway — the pool in display order (pinned first, then newest),
// with posts from users the viewer ignores filtered out.
router.get('/', requireAuth, (req, res) => {
  const muted = new Set(ignoredIds(req.user.id));
  const posts = hw.allOrdered()
    .filter((r) => !muted.has(r.user_id))
    .map((r) => shapePost(r, req.user.id));
  res.json({ posts, max: hw.MAX_POSTS });
});

// POST /api/highway — create a post (text and/or image), then prune to 100. An
// optional `originPeer` links a picture shared straight from a chat back to that
// conversation, so later likes/comments surface there.
router.post('/', requireAuth, postLimiter, imageUpload.single('image'), (req, res) => {
  const body = String((req.body && req.body.body) || '').trim().slice(0, BODY_MAX);
  const image = req.file ? req.file.filename : null;
  if (!body && !image) {
    return res.status(400).json({ error: 'Write something or add an image to post.' });
  }

  let origin = null;
  const peerId = parseInt(req.body && req.body.originPeer, 10);
  if (image && peerId && peerId !== req.user.id) {
    const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(peerId);
    if (peer && !areBlocked(req.user.id, peerId)) {
      origin = { kind: 'chat', a: req.user.id, b: peerId };
    }
  }

  const { id, prunedImages } = hw.createPost({ userId: req.user.id, body, image, origin });
  prunedImages.forEach(removeUpload);

  const post = shapePost(hw.byId(id), req.user.id);

  // Live-push to everyone. Viewer-specific fields (mine/friendState) are filled
  // in per-client, so send the neutral author-centric shape.
  try {
    broadcastHighway({
      id: post.id, body: post.body, image: post.image, captions: post.captions,
      createdAt: post.createdAt, author: post.author,
    });
  } catch (_e) { /* never block the response */ }

  res.status(201).json({ post });
});

// Resolve a :id param to its post row (id + author). Sends the error itself and
// returns null when invalid/not found.
function resolvePost(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id) { res.status(400).json({ error: 'Invalid post.' }); return null; }
  const post = db
    .prepare('SELECT id, user_id, image, origin_kind, origin_a, origin_b FROM highway_posts WHERE id = ?')
    .get(id);
  if (!post) { res.status(404).json({ error: 'Post not found.' }); return null; }
  return post;
}

// Build the { postId, image, origin } context for a like/comment notification,
// or null when the post isn't linked to a conversation.
function originContext(post) {
  if (!post.origin_a || !post.origin_b) return null;
  return {
    postId: post.id,
    image: post.image ? `/uploads/${post.image}` : null,
    origin: { a: post.origin_a, b: post.origin_b },
  };
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
  const liking = !existing;
  if (existing) {
    db.prepare('DELETE FROM highway_likes WHERE id = ?').run(existing.id);
  } else {
    db.prepare('INSERT INTO highway_likes (post_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(post.id, req.user.id, Date.now());
  }

  // A like changes the author's profile-likes tally, which feeds leaderboard
  // ranking; and a new like on a shared picture is surfaced in its chat.
  try {
    broadcastLeaderboardChange();
    const ctx = originContext(post);
    if (liking && ctx) {
      notifyHighwayEvent({ ...ctx, action: 'like', byId: req.user.id, byName: nameOf(req.user.id) });
    }
  } catch (_e) { /* notification failures never block the like */ }

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

  // Surface the comment inside the conversation the picture was shared from.
  try {
    const ctx = originContext(post);
    if (ctx) notifyHighwayEvent({ ...ctx, action: 'comment', byId: req.user.id, byName: nameOf(req.user.id), text: body });
  } catch (_e) { /* never block the response */ }

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
