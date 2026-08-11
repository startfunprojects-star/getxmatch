'use strict';

// Leaderboard: ranks every user by a simple engagement score built from their
// average rating, number of ratings received, friends, and quiz activity. Each
// row carries the viewer's friendship state so the UI can offer "Add friend".

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { friendState } = require('../profileData');

const router = express.Router();

// GET /api/leaderboard — ranked users (excludes the viewer's own row from
// friend actions but still shows them, flagged isMe).
router.get('/', requireAuth, (req, res) => {
  const me = req.user.id;

  const rows = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar, p.country,
              (SELECT COUNT(*) FROM ratings r WHERE r.ratee_id = u.id)         AS rating_count,
              (SELECT AVG(stars) FROM ratings r WHERE r.ratee_id = u.id)       AS rating_avg,
              (SELECT COUNT(*) FROM friendships f
                 WHERE (f.requester_id = u.id OR f.addressee_id = u.id)
                   AND f.status = 'accepted')                                  AS friends,
              (SELECT COUNT(*) FROM quiz_attempts q WHERE q.user_id = u.id)    AS quizzes
       FROM users u
       JOIN profiles p ON p.user_id = u.id`
    )
    .all();

  const scored = rows.map((r) => {
    const avg = r.rating_avg || 0;
    // Weighted score: rating quality × volume, plus social + quiz activity.
    const score = Math.round(avg * 20 + r.rating_count * 5 + r.friends * 8 + r.quizzes * 3);
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
      country: r.country || null,
      ratingAvg: avg ? Math.round(avg * 10) / 10 : 0,
      ratingCount: r.rating_count,
      friends: r.friends,
      quizzes: r.quizzes,
      score,
      isMe: r.id === me,
      friendState: friendState(r.id, me),
    };
  });

  scored.sort((a, b) => b.score - a.score || b.ratingAvg - a.ratingAvg);
  scored.forEach((row, i) => { row.rank = i + 1; });

  res.json({ leaderboard: scored });
});

module.exports = router;
