'use strict';

// Follow / unfollow members. Following is free; the member followed earns a
// point per follower (src/follows.js).

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { areBlocked } = require('../relations');
const { FOLLOWER_POINTS, followSummary } = require('../follows');
const { notifyUser, broadcastLeaderboardChange } = require('../socket');

const router = express.Router();

function resolveTarget(req, res) {
  const target = db
    .prepare('SELECT u.id, u.username FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.username = ?')
    .get(req.params.username);
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return null;
  }
  return target;
}

// GET /api/follow/me — my follower / following counts.
router.get('/me', requireAuth, (req, res) => {
  const summary = followSummary(req.user.id, null);
  res.json({ ...summary, earned: summary.followers * FOLLOWER_POINTS });
});

// POST /api/follow/:username — follow (free; they earn a point).
router.post('/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot follow yourself.' });
  if (areBlocked(req.user.id, target.id)) {
    return res.status(403).json({ error: 'You cannot follow this member.' });
  }
  const info = db
    .prepare(
      `INSERT INTO follows (follower_id, followee_id, fee, created_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(follower_id, followee_id) DO NOTHING`
    )
    .run(req.user.id, target.id, Date.now());
  if (!info.changes) return res.status(409).json({ error: 'You already follow them.' });

  // Tell them (Notifications) and let the leaderboard refresh.
  db.prepare('INSERT INTO notifications (user_id, kind, data, created_at) VALUES (?, ?, ?, ?)')
    .run(target.id, 'follow', JSON.stringify({ followerId: req.user.id, points: FOLLOWER_POINTS }), Date.now());
  notifyUser(target.id, 'notify:new', {});
  broadcastLeaderboardChange();
  res.status(201).json({ theyEarned: FOLLOWER_POINTS, follow: followSummary(target.id, req.user.id) });
});

// DELETE /api/follow/:username — unfollow (they lose that follower's point).
router.delete('/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  const info = db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, target.id);
  if (!info.changes) return res.status(404).json({ error: 'You don’t follow them.' });
  broadcastLeaderboardChange();
  res.json({ follow: followSummary(target.id, req.user.id) });
});

module.exports = router;
