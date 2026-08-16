'use strict';

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { friendState, ratingSummary } = require('../profileData');
const { areBlocked } = require('../relations');
const { GIFTS } = require('../gifts');
const { listActivities } = require('../activities');
const { isValidRelType, sentText, acceptedText, relEmoji } = require('../relationships');
const { broadcastActivity, notifyUser, broadcastLeaderboardChange } = require('../socket');

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

// POST /api/social/rate/:username  { stars: 1-5 }  — rate another user
router.post('/rate/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot rate yourself.' });
  }
  const stars = parseInt(req.body && req.body.stars, 10);
  if (!(stars >= 1 && stars <= 5)) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5 stars.' });
  }

  db.prepare(
    `INSERT INTO ratings (rater_id, ratee_id, stars, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(rater_id, ratee_id) DO UPDATE SET stars = excluded.stars, created_at = excluded.created_at`
  ).run(req.user.id, target.id, stars, Date.now());

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
   Gifts
--------------------------------------------------------------------------- */

// GET /api/social/gifts — catalog of naughty gifts sendable in chat.
router.get('/gifts', requireAuth, (_req, res) => {
  res.json({ gifts: GIFTS });
});

/* ---------------------------------------------------------------------------
   Chat activity ("what are you doing" status)
--------------------------------------------------------------------------- */

// GET /api/social/activities — the activity verbs users can pick (column 2 of
// the admin's fake-activity table).
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
