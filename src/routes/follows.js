'use strict';

// Follow / unfollow members and set your own follow fee. See src/follows.js
// for how points move.

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { areBlocked } = require('../relations');
const { MAX_FEE, GAIN_MULTIPLIER, followFeeOf, followSummary } = require('../follows');
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

// GET /api/follow/me — my fee, counts, and points earned/spent on follows.
router.get('/me', requireAuth, (req, res) => {
  const me = req.user.id;
  const earned = db.prepare('SELECT COALESCE(SUM(fee), 0) AS n FROM follows WHERE followee_id = ?').get(me).n * GAIN_MULTIPLIER;
  const spent = db.prepare('SELECT COALESCE(SUM(fee), 0) AS n FROM follows WHERE follower_id = ?').get(me).n;
  res.json({ ...followSummary(me, null), earned, spent, maxFee: MAX_FEE, multiplier: GAIN_MULTIPLIER });
});

// PUT /api/follow/fee  { fee } — what future followers pay (you get double).
// Existing follows keep the fee they were made at.
router.put('/fee', requireAuth, (req, res) => {
  const fee = Number(req.body && req.body.fee);
  if (!Number.isInteger(fee) || fee < 0 || fee > MAX_FEE) {
    return res.status(400).json({ error: `Follow fee must be a whole number from 0 to ${MAX_FEE}.` });
  }
  db.prepare('UPDATE users SET follow_fee = ? WHERE id = ?').run(fee, req.user.id);
  res.json({ fee, gain: fee * GAIN_MULTIPLIER });
});

// POST /api/follow/:username — follow at the member's current fee.
router.post('/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot follow yourself.' });
  if (areBlocked(req.user.id, target.id)) {
    return res.status(403).json({ error: 'You cannot follow someone while a block is in place.' });
  }
  const fee = followFeeOf(target.id);
  const info = db
    .prepare(
      `INSERT INTO follows (follower_id, followee_id, fee, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(follower_id, followee_id) DO NOTHING`
    )
    .run(req.user.id, target.id, fee, Date.now());
  if (!info.changes) return res.status(409).json({ error: 'You already follow them.' });

  // Tell them (Notifications) and let the leaderboard refresh.
  db.prepare('INSERT INTO notifications (user_id, kind, data, created_at) VALUES (?, ?, ?, ?)')
    .run(target.id, 'follow', JSON.stringify({ followerId: req.user.id, points: fee * GAIN_MULTIPLIER }), Date.now());
  notifyUser(target.id, 'notify:new', {});
  broadcastLeaderboardChange();
  res.status(201).json({ spent: fee, theyEarned: fee * GAIN_MULTIPLIER, follow: followSummary(target.id, req.user.id) });
});

// DELETE /api/follow/:username — unfollow; reverses that follow's points.
router.delete('/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  const row = db.prepare('SELECT fee FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, target.id);
  if (!row) return res.status(404).json({ error: 'You don’t follow them.' });
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, target.id);
  broadcastLeaderboardChange();
  res.json({ refunded: row.fee, follow: followSummary(target.id, req.user.id) });
});

module.exports = router;
