'use strict';

// Leaderboard points. Every member earns points from their engagement; the
// leaderboard ranks strictly by points (highest first). Members with the same
// points share a rank ("1, 2, 2, 4"). Used by both the member and the admin
// leaderboard so the two always agree.

const db = require('./db');

// Points per unit of each activity. Quizzes add the points the admin set on
// each question the member answered in time (best attempt per quiz).
const WEIGHTS = {
  ratingAvg: 20, // × average star rating received (0–5)
  rating: 5, // per rating received
  friend: 8, // per accepted friend
  like: 4, // per like received on the Highway
};

function rankedUsers() {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar, p.country,
              (SELECT COUNT(*) FROM ratings r WHERE r.ratee_id = u.id)         AS rating_count,
              (SELECT AVG(stars) FROM ratings r WHERE r.ratee_id = u.id)       AS rating_avg,
              (SELECT COUNT(*) FROM friendships f
                 WHERE (f.requester_id = u.id OR f.addressee_id = u.id)
                   AND f.status = 'accepted')                                  AS friends,
              (SELECT COUNT(DISTINCT quiz_id) FROM quiz_attempts q
                WHERE q.user_id = u.id)                                        AS quizzes,
              COALESCE(qb.quiz_points, 0)                                      AS quiz_points,
              (SELECT COUNT(*) FROM highway_likes hl
                 JOIN highway_posts hp ON hp.id = hl.post_id
                WHERE hp.user_id = u.id)                                       AS likes,
              (SELECT COALESCE(SUM(points), 0) FROM quiz_penalties qp
                WHERE qp.user_id = u.id)                                       AS penalty
       FROM users u
       JOIN profiles p ON p.user_id = u.id
       LEFT JOIN (SELECT user_id, SUM(best) AS quiz_points
                    FROM (SELECT user_id, quiz_id, MAX(score) AS best
                            FROM quiz_attempts GROUP BY user_id, quiz_id)
                   GROUP BY user_id) qb ON qb.user_id = u.id`
    )
    .all();

  const scored = rows.map((r) => {
    const avg = r.rating_avg || 0;
    // Minus points deducted for stopped (proctoring-violating) quiz attempts.
    const points =
      Math.round(
        avg * WEIGHTS.ratingAvg +
          r.rating_count * WEIGHTS.rating +
          r.friends * WEIGHTS.friend +
          r.quiz_points +
          r.likes * WEIGHTS.like
      ) - r.penalty;
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
      quizPoints: r.quiz_points,
      likes: r.likes,
      penalty: r.penalty,
      points,
      score: points, // legacy name
    };
  });

  // Highest points first; ties listed alphabetically but share one rank.
  scored.sort((a, b) => b.points - a.points || a.displayName.localeCompare(b.displayName));
  scored.forEach((row, i) => {
    row.rank = i > 0 && row.points === scored[i - 1].points ? scored[i - 1].rank : i + 1;
  });
  return scored;
}

module.exports = { rankedUsers, WEIGHTS };
