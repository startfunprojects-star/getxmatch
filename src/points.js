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
  poll: 5, // per community poll voted in (changing a vote doesn't count again)
  // Compatibility quizzes: once a shared link is completed by a signed-in
  // member, the sharer and the responder both earn points (once per quiz for
  // each pair of members, so re-sharing to the same person earns nothing).
  shareCompleted: 10, // to the member who shared the link
  answerShared: 5, // to the member who answered it
  // Open compatibility quizzes: anyone registered can answer a shared link.
  // Per response (once per quiz for each pair of members).
  openShareAnswered: 3, // to the member who shared the link
  openAnswer: 1, // to the member who answered it
  // Follows: each follower pays the fee they followed at; the member followed
  // earns double (src/follows.js). Default fee 1 → -1 / +2.
  followGainMultiplier: 2,
  // Referrals (src/referrals.js): per new member who joined with your code,
  // and once to a member who joined with someone's code.
  referrer: 4,
  referred: 2,
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
              (SELECT COUNT(*) FROM poll_votes pv WHERE pv.user_id = u.id)     AS polls,
              (SELECT COUNT(*) FROM follows fo WHERE fo.followee_id = u.id)    AS followers,
              (SELECT COALESCE(SUM(fee), 0) FROM follows fo
                WHERE fo.followee_id = u.id)                                   AS follow_fees_in,
              (SELECT COALESCE(SUM(fee), 0) FROM follows fo
                WHERE fo.follower_id = u.id)                                   AS follow_fees_out,
              (SELECT COUNT(*) FROM quiz_matches qm
                WHERE qm.a_user_id = u.id AND qm.points_awarded = 1)           AS shares_completed,
              (SELECT COUNT(*) FROM quiz_matches qm
                WHERE qm.b_user_id = u.id AND qm.points_awarded = 1)           AS shared_answered,
              (SELECT COUNT(*) FROM open_match_responses om
                WHERE om.a_user_id = u.id AND om.points_awarded = 1)           AS open_shares_answered,
              (SELECT COUNT(*) FROM open_match_responses om
                WHERE om.user_id = u.id AND om.points_awarded = 1)             AS open_answered,
              (SELECT COUNT(*) FROM users ru WHERE ru.referred_by = u.id)      AS referrals,
              (CASE WHEN u.referred_by IS NULL THEN 0 ELSE 1 END)              AS was_referred,
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
          r.likes * WEIGHTS.like +
          r.polls * WEIGHTS.poll +
          r.shares_completed * WEIGHTS.shareCompleted +
          r.shared_answered * WEIGHTS.answerShared +
          r.open_shares_answered * WEIGHTS.openShareAnswered +
          r.open_answered * WEIGHTS.openAnswer +
          r.referrals * WEIGHTS.referrer +
          r.was_referred * WEIGHTS.referred +
          r.follow_fees_in * WEIGHTS.followGainMultiplier -
          r.follow_fees_out
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
      polls: r.polls,
      followers: r.followers,
      matches: r.shares_completed + r.shared_answered + r.open_shares_answered + r.open_answered,
      referrals: r.referrals,
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
