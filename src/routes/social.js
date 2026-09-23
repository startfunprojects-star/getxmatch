'use strict';

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { friendState, ratingSummary, RATING_DIMS, photoReactionState, photoComments, commentReactionState } = require('../profileData');
const { areBlocked } = require('../relations');
const moderation = require('../moderation');
const { GIFTS } = require('../gifts');
const { GALLERY_REACTIONS, GALLERY_REACTION_SET } = require('../galleryReactions');
const { listActivities } = require('../activities');
const { isValidRelType, sentText, acceptedText, relEmoji } = require('../relationships');
const { broadcastActivity, notifyUser, broadcastLeaderboardChange, isOnline } = require('../socket');

const router = express.Router();

// Display name + declared gender for a user (name falls back to username).
function profileBits(userId, fallback) {
  const r = db.prepare('SELECT display_name, gender FROM profiles WHERE user_id = ?').get(userId);
  return { name: (r && r.display_name) || fallback, gender: r ? r.gender : null };
}

// Announce a relationship request being sent / accepted onto Recent Activity.
// Broadcast only (no socket on the public sign-in page, so real names stay in
// the logged-in feed); accepts also persist via the accepted-friendships source.
// For a "sent" line the his/her/their possessive follows the sender's gender.
function announceRelation(kind, type, aId, aFallback, bId, bFallback) {
  const a = profileBits(aId, aFallback);
  const b = profileBits(bId, bFallback);
  const text = kind === 'accepted'
    ? acceptedText(type, a.name, b.name)
    : sentText(type, a.name, b.name, a.gender);
  broadcastActivity({ at: Date.now(), icon: relEmoji(type), text });
}

// Resolve a :username param to a user row that has a profile. Sends the 404
// response itself and returns null when not found.
function resolveTarget(req, res) {
  const target = db
    .prepare(
      `SELECT u.id, u.username FROM users u
       JOIN profiles p ON p.user_id = u.id WHERE u.username = ?`
    )
    .get(req.params.username);
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return null;
  }
  return target;
}

/* ---------------------------------------------------------------------------
   Ratings
--------------------------------------------------------------------------- */

// POST /api/social/rate/:username  { dimension, stars: 1-5 }  — rate another
// user on ONE dimension (slow / fast / creative / thoughtful). The row's other
// dimensions are preserved; the legacy `stars` column is recomputed as the
// rounded mean of the given dimensions (the overall score the leaderboard uses).
router.post('/rate/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot rate yourself.' });
  }
  const dimension = req.body && req.body.dimension;
  if (!RATING_DIMS.includes(dimension)) {
    return res.status(400).json({ error: 'Invalid rating category.' });
  }
  const stars = parseInt(req.body && req.body.stars, 10);
  if (!(stars >= 1 && stars <= 5)) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5 stars.' });
  }

  // Merge the new value into any existing row, then recompute the overall.
  const existing = db
    .prepare('SELECT slow, fast, creative, thoughtful FROM ratings WHERE rater_id = ? AND ratee_id = ?')
    .get(req.user.id, target.id) || {};
  const vals = {};
  for (const d of RATING_DIMS) vals[d] = existing[d] != null ? existing[d] : null;
  vals[dimension] = stars;

  const given = RATING_DIMS.map((d) => vals[d]).filter((v) => v != null);
  const overall = Math.round(given.reduce((s, x) => s + x, 0) / given.length); // 1-5 int

  db.prepare(
    `INSERT INTO ratings (rater_id, ratee_id, slow, fast, creative, thoughtful, stars, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(rater_id, ratee_id) DO UPDATE SET
       slow = excluded.slow, fast = excluded.fast,
       creative = excluded.creative, thoughtful = excluded.thoughtful,
       stars = excluded.stars, created_at = excluded.created_at`
  ).run(req.user.id, target.id, vals.slow, vals.fast, vals.creative, vals.thoughtful, overall, Date.now());

  broadcastLeaderboardChange(); // a new/changed rating can reshuffle ranks
  res.json({ rating: ratingSummary(target.id, req.user.id) });
});

// DELETE /api/social/rate/:username — remove your rating of a user
router.delete('/rate/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  db.prepare('DELETE FROM ratings WHERE rater_id = ? AND ratee_id = ?').run(req.user.id, target.id);
  res.json({ rating: ratingSummary(target.id, req.user.id) });
});

/* ---------------------------------------------------------------------------
   Comments
--------------------------------------------------------------------------- */

// POST /api/social/comment/:username  { body }  — leave a comment on a profile
router.post('/comment/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  const body = ((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (body.length > 500) return res.status(400).json({ error: 'Comment must be 500 characters or fewer.' });

  const now = Date.now();
  const info = db
    .prepare('INSERT INTO comments (author_id, subject_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, target.id, body, now);

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
  });
});

// DELETE /api/social/comment/:id — the author or the profile owner may delete
router.delete('/comment/:id', requireAuth, (req, res) => {
  const comment = db
    .prepare('SELECT id, author_id, subject_id FROM comments WHERE id = ?')
    .get(req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.author_id !== req.user.id && comment.subject_id !== req.user.id) {
    return res.status(403).json({ error: 'You cannot delete this comment.' });
  }
  db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------------
   Gallery photos — emoji reactions ("likes") and per-photo comments
--------------------------------------------------------------------------- */

// Resolve a :photoId param to its gallery photo row (id + owner user_id). Sends
// the error response itself and returns null when invalid/not found.
function resolvePhoto(req, res) {
  const id = parseInt(req.params.photoId, 10);
  if (!id) {
    res.status(400).json({ error: 'Invalid photo.' });
    return null;
  }
  const photo = db.prepare('SELECT id, user_id FROM gallery_photos WHERE id = ?').get(id);
  if (!photo) {
    res.status(404).json({ error: 'Photo not found.' });
    return null;
  }
  return photo;
}

// GET /api/social/photo-reactions — the emoji "likes" a user may leave (catalog)
router.get('/photo-reactions', requireAuth, (_req, res) => {
  res.json({ reactions: GALLERY_REACTIONS });
});

// GET /api/social/photo/:photoId — full detail for one gallery photo: its
// comments plus aggregated reactions and the viewer's own reaction.
router.get('/photo/:photoId', requireAuth, (req, res) => {
  const photo = resolvePhoto(req, res);
  if (!photo) return;
  res.json({
    reactions: photoReactionState(photo.id, req.user.id),
    comments: photoComments(photo.id, req.user.id),
  });
});

// POST /api/social/photo/:photoId/react  { emoji }  — set / toggle a reaction.
// Same emoji again clears it; a different emoji replaces it.
router.post('/photo/:photoId/react', requireAuth, (req, res) => {
  const photo = resolvePhoto(req, res);
  if (!photo) return;
  if (areBlocked(req.user.id, photo.user_id)) {
    return res.status(403).json({ error: 'You cannot react while a block is in place.' });
  }
  const emoji = ((req.body && req.body.emoji) || '').trim();
  if (!GALLERY_REACTION_SET.has(emoji)) {
    return res.status(400).json({ error: 'Invalid reaction.' });
  }

  const existing = db
    .prepare('SELECT emoji FROM gallery_reactions WHERE photo_id = ? AND user_id = ?')
    .get(photo.id, req.user.id);
  const now = Date.now();
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM gallery_reactions WHERE photo_id = ? AND user_id = ?').run(photo.id, req.user.id);
  } else if (existing) {
    db.prepare('UPDATE gallery_reactions SET emoji = ?, created_at = ? WHERE photo_id = ? AND user_id = ?')
      .run(emoji, now, photo.id, req.user.id);
  } else {
    db.prepare('INSERT INTO gallery_reactions (photo_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
      .run(photo.id, req.user.id, emoji, now);
  }

  res.json({ reactions: photoReactionState(photo.id, req.user.id) });
});

// POST /api/social/photo/:photoId/comment  { body }  — comment on a photo
router.post('/photo/:photoId/comment', requireAuth, (req, res) => {
  const photo = resolvePhoto(req, res);
  if (!photo) return;
  if (areBlocked(req.user.id, photo.user_id)) {
    return res.status(403).json({ error: 'You cannot comment while a block is in place.' });
  }
  const body = ((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (body.length > 500) return res.status(400).json({ error: 'Comment must be 500 characters or fewer.' });

  // Optional reply: parentId must be a comment on THIS photo. Threads are kept
  // one level deep — replying to a reply attaches to its top-level parent.
  let parentId = null;
  const rawParent = req.body && req.body.parentId ? parseInt(req.body.parentId, 10) : null;
  if (rawParent) {
    const parent = db
      .prepare('SELECT id, photo_id, parent_id FROM gallery_comments WHERE id = ?')
      .get(rawParent);
    if (!parent || parent.photo_id !== photo.id) {
      return res.status(400).json({ error: 'Invalid comment to reply to.' });
    }
    parentId = parent.parent_id || parent.id;
  }

  const now = Date.now();
  const info = db
    .prepare('INSERT INTO gallery_comments (photo_id, author_id, body, created_at, parent_id) VALUES (?, ?, ?, ?, ?)')
    .run(photo.id, req.user.id, body, now, parentId);

  const me = db.prepare('SELECT display_name, avatar FROM profiles WHERE user_id = ?').get(req.user.id);
  res.status(201).json({
    comment: {
      id: info.lastInsertRowid,
      parentId,
      body,
      at: now,
      author: {
        id: req.user.id,
        username: req.user.username,
        displayName: (me && me.display_name) || req.user.username,
        avatar: me && me.avatar ? `/uploads/${me.avatar}` : null,
      },
      canDelete: true,
      reactions: { reactions: [], total: 0, mine: null },
      replies: [],
    },
  });
});

// POST /api/social/photo-comment/:id/react  { emoji } — set / toggle an emoji
// reaction on a single gallery comment. Same emoji again clears it; a different
// emoji replaces it (one reaction per user per comment).
router.post('/photo-comment/:id/react', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid comment.' });
  const row = db
    .prepare(
      `SELECT gc.id, gp.user_id AS owner_id
       FROM gallery_comments gc
       JOIN gallery_photos gp ON gp.id = gc.photo_id
       WHERE gc.id = ?`
    )
    .get(id);
  if (!row) return res.status(404).json({ error: 'Comment not found.' });
  if (areBlocked(req.user.id, row.owner_id)) {
    return res.status(403).json({ error: 'You cannot react while a block is in place.' });
  }
  const emoji = ((req.body && req.body.emoji) || '').trim();
  if (!GALLERY_REACTION_SET.has(emoji)) {
    return res.status(400).json({ error: 'Invalid reaction.' });
  }

  const existing = db
    .prepare('SELECT emoji FROM gallery_comment_reactions WHERE comment_id = ? AND user_id = ?')
    .get(id, req.user.id);
  const now = Date.now();
  if (existing && existing.emoji === emoji) {
    db.prepare('DELETE FROM gallery_comment_reactions WHERE comment_id = ? AND user_id = ?').run(id, req.user.id);
  } else if (existing) {
    db.prepare('UPDATE gallery_comment_reactions SET emoji = ?, created_at = ? WHERE comment_id = ? AND user_id = ?')
      .run(emoji, now, id, req.user.id);
  } else {
    db.prepare('INSERT INTO gallery_comment_reactions (comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
      .run(id, req.user.id, emoji, now);
  }

  res.json({ reactions: commentReactionState(id, req.user.id) });
});

// DELETE /api/social/photo-comment/:id — the comment's author or the photo
// owner may delete it.
router.delete('/photo-comment/:id', requireAuth, (req, res) => {
  const row = db
    .prepare(
      `SELECT gc.id, gc.author_id, gp.user_id AS owner_id
       FROM gallery_comments gc
       JOIN gallery_photos gp ON gp.id = gc.photo_id
       WHERE gc.id = ?`
    )
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Comment not found.' });
  if (row.author_id !== req.user.id && row.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'You cannot delete this comment.' });
  }
  db.prepare('DELETE FROM gallery_comments WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------------------
   Friends
--------------------------------------------------------------------------- */

function existingFriendship(a, b) {
  return db
    .prepare(
      `SELECT * FROM friendships
       WHERE (requester_id = ? AND addressee_id = ?)
          OR (requester_id = ? AND addressee_id = ?)`
    )
    .get(a, b, b, a);
}

// POST /api/social/friend/:username — send a relationship request (friend,
// crush, girlfriend, …), or accept a pending request already received from the
// target. Body: { type } (defaults to 'friend'; invalid values fall back too).
router.post('/friend/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot send a request to yourself.' });
  }
  if (areBlocked(req.user.id, target.id)) {
    return res.status(403).json({ error: 'You cannot send a request while a block is in place.' });
  }

  let type = (req.body && req.body.type) || 'friend';
  if (!isValidRelType(type)) type = 'friend';

  const row = existingFriendship(req.user.id, target.id);
  if (row) {
    if (row.status === 'accepted') {
      return res.status(409).json({ error: 'You are already connected.' });
    }
    // Pending. If the target requested us, accept it (keep their chosen type).
    if (row.addressee_id === req.user.id) {
      db.prepare('UPDATE friendships SET status = ? WHERE id = ?').run('accepted', row.id);
      announceRelation('accepted', row.rel_type || 'friend', req.user.id, req.user.username, target.id, target.username);
      broadcastLeaderboardChange(); // a new accepted friendship can reshuffle ranks
      return res.json({ state: 'friends' });
    }
    return res.status(409).json({ error: 'You already sent a request.' });
  }

  db.prepare(
    'INSERT INTO friendships (requester_id, addressee_id, status, rel_type, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, target.id, 'pending', type, Date.now());
  announceRelation('sent', type, req.user.id, req.user.username, target.id, target.username);
  // Live-notify the addressee so their "Requests" button lights up immediately.
  notifyUser(target.id, 'notify:request', { from: req.user.username, type });
  res.status(201).json({ state: 'outgoing', type });
});

// POST /api/social/friend/:username/accept — accept an incoming request
router.post('/friend/:username/accept', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  const row = db
    .prepare(
      `SELECT * FROM friendships
       WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`
    )
    .get(target.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'No pending request from this user.' });

  db.prepare('UPDATE friendships SET status = ? WHERE id = ?').run('accepted', row.id);
  announceRelation('accepted', row.rel_type || 'friend', req.user.id, req.user.username, target.id, target.username);
  broadcastLeaderboardChange(); // a new accepted friendship can reshuffle ranks
  res.json({ state: 'friends' });
});

// DELETE /api/social/friend/:username — unfriend, cancel a sent request, or
// decline a received one (any friendship row between the two is removed).
router.delete('/friend/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  db.prepare(
    `DELETE FROM friendships
     WHERE (requester_id = ? AND addressee_id = ?)
        OR (requester_id = ? AND addressee_id = ?)`
  ).run(req.user.id, target.id, target.id, req.user.id);
  res.json({ state: 'none' });
});

// GET /api/social/friends — my accepted friends plus pending requests
router.get('/friends', requireAuth, (req, res) => {
  const me = req.user.id;

  const map = (r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name || r.username,
    avatar: r.avatar ? `/uploads/${r.avatar}` : null,
    relType: r.rel_type || 'friend',
    online: isOnline(r.id),
  });

  const accepted = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar, f.rel_type
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       JOIN profiles p ON p.user_id = u.id
       WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
       ORDER BY p.display_name COLLATE NOCASE`
    )
    .all(me, me, me);

  const incoming = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar, f.rel_type
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
       JOIN profiles p ON p.user_id = u.id
       WHERE f.addressee_id = ? AND f.status = 'pending'
       ORDER BY f.created_at DESC`
    )
    .all(me);

  const outgoing = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar, f.rel_type
       FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       JOIN profiles p ON p.user_id = u.id
       WHERE f.requester_id = ? AND f.status = 'pending'
       ORDER BY f.created_at DESC`
    )
    .all(me);

  res.json({
    friends: accepted.map(map),
    incoming: incoming.map(map),
    outgoing: outgoing.map(map),
  });
});

/* ---------------------------------------------------------------------------
   Blocks
--------------------------------------------------------------------------- */

// POST /api/social/block/:username — block a user. Also tears down any
// friendship or pending request between the two.
router.post('/block/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot block yourself.' });
  }

  const now = Date.now();
  db.prepare(
    `INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(blocker_id, blocked_id) DO NOTHING`
  ).run(req.user.id, target.id, now);

  // A block ends follows both ways (each follow's points are reversed).
  db.prepare(
    `DELETE FROM follows
     WHERE (follower_id = ? AND followee_id = ?)
        OR (follower_id = ? AND followee_id = ?)`
  ).run(req.user.id, target.id, target.id, req.user.id);

  // Remove any friendship/request in either direction.
  db.prepare(
    `DELETE FROM friendships
     WHERE (requester_id = ? AND addressee_id = ?)
        OR (requester_id = ? AND addressee_id = ?)`
  ).run(req.user.id, target.id, target.id, req.user.id);

  res.json({ state: 'blocked' });
});

// DELETE /api/social/block/:username — unblock a user.
router.delete('/block/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(
    req.user.id,
    target.id
  );
  res.json({ state: 'none' });
});

// GET /api/social/blocked — the users I have blocked
router.get('/blocked', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar
       FROM blocks b
       JOIN users u ON u.id = b.blocked_id
       JOIN profiles p ON p.user_id = u.id
       WHERE b.blocker_id = ?
       ORDER BY b.created_at DESC`
    )
    .all(req.user.id);
  res.json({
    blocked: rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
    })),
  });
});

/* ---------------------------------------------------------------------------
   Ignore (one-way mute) + Report
--------------------------------------------------------------------------- */

// POST /api/social/ignore/:username — hide this user's Highway posts from my
// feed. Softer than a block: it doesn't tear down friendships.
router.post('/ignore/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot ignore yourself.' });
  db.prepare(
    `INSERT INTO ignores (ignorer_id, ignored_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT(ignorer_id, ignored_id) DO NOTHING`
  ).run(req.user.id, target.id, Date.now());
  res.json({ state: 'ignored' });
});

// DELETE /api/social/ignore/:username — stop ignoring a user.
router.delete('/ignore/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  db.prepare('DELETE FROM ignores WHERE ignorer_id = ? AND ignored_id = ?').run(req.user.id, target.id);
  res.json({ state: 'none' });
});

// GET /api/social/ignored — the ids I'm ignoring (to filter live feeds).
router.get('/ignored', requireAuth, (req, res) => {
  const ids = db.prepare('SELECT ignored_id FROM ignores WHERE ignorer_id = ?').all(req.user.id).map((r) => r.ignored_id);
  res.json({ ids });
});

// POST /api/social/report/:username  { reason? } — report a profile. Reports are
// deduped per reporter; crossing the thresholds suspends the reported profile
// (mass reports) or a report-spamming reporter.
router.post('/report/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot report yourself.' });

  const reason = String((req.body && req.body.reason) || '').trim();
  const out = moderation.recordReport(req.user.id, target.id, reason);

  if (out.reportedSuspended && target.id) {
    // Boot the now-suspended user out of every live session.
    try { notifyUser(target.id, 'account:suspended', { until: Date.now() + moderation.SUSPEND_MS }); } catch (_e) {}
  }
  if (out.reporterSuspended) {
    return res.status(403).json({
      error: 'You have reported too many profiles in a short time and your account is now suspended for 7 days.',
      suspended: true,
    });
  }

  res.json({
    state: 'reported',
    already: !out.created,
    message: out.created ? 'Thanks — this profile has been reported.' : 'You have already reported this profile.',
  });
});

/* ---------------------------------------------------------------------------
   Gifts
--------------------------------------------------------------------------- */

// GET /api/social/gifts — catalog of naughty gifts sendable in chat.
router.get('/gifts', requireAuth, (_req, res) => {
  res.json({ gifts: GIFTS });
});

/* ---------------------------------------------------------------------------
   Chat activity ("what are you doing" status)
--------------------------------------------------------------------------- */

// GET /api/social/activities — the activity verbs users can pick.
router.get('/activities', requireAuth, (_req, res) => {
  res.json({ activities: listActivities() });
});

// GET /api/social/chat-activity/:peerId — my activity toward this peer and
// theirs toward me, for the top-of-chat status bar.
router.get('/chat-activity/:peerId', requireAuth, (req, res) => {
  const peerId = parseInt(req.params.peerId, 10);
  if (!peerId) return res.status(400).json({ error: 'Invalid peer.' });
  const mine = db.prepare('SELECT activity FROM chat_activities WHERE user_id = ? AND peer_id = ?').get(req.user.id, peerId);
  const theirs = db.prepare('SELECT activity FROM chat_activities WHERE user_id = ? AND peer_id = ?').get(peerId, req.user.id);
  res.json({ mine: mine ? mine.activity : null, theirs: theirs ? theirs.activity : null });
});

module.exports = router;
