'use strict';

// Leaderboard: ranks every user by points (see src/points.js) — the more
// points, the higher the rank. Each row carries the viewer's friendship state
// so the UI can offer "Add friend".

const express = require('express');

const { leaderboards } = require('../points');
const { requireAuth } = require('../auth');
const { friendState } = require('../profileData');

const router = express.Router();

// GET /api/leaderboard — every board (see leaderboards() in src/points.js).
// The viewer's own rows are flagged isMe. `leaderboard` is the overall board,
// kept for older clients.
router.get('/', requireAuth, (req, res) => {
  const me = req.user.id;
  const boards = leaderboards((row) => ({
    ...row,
    isMe: row.id === me,
    friendState: friendState(row.id, me),
  }));
  res.json({ boards, leaderboard: boards[0].rows });
});

module.exports = router;
