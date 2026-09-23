'use strict';

// Leaderboard: ranks every user by points (see src/points.js) — the more
// points, the higher the rank. Each row carries the viewer's friendship state
// so the UI can offer "Add friend".

const express = require('express');

const { rankedUsers } = require('../points');
const { requireAuth } = require('../auth');
const { friendState } = require('../profileData');

const router = express.Router();

// GET /api/leaderboard — ranked users (excludes the viewer's own row from
// friend actions but still shows them, flagged isMe).
router.get('/', requireAuth, (req, res) => {
  const me = req.user.id;
  const leaderboard = rankedUsers().map((row) => ({
    ...row,
    isMe: row.id === me,
    friendState: friendState(row.id, me),
  }));
  res.json({ leaderboard });
});

module.exports = router;
