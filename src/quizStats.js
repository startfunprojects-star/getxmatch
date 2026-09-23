'use strict';

// Summary shown on each quiz card: question count, total time, negative
// marking, how many people attempted it and its top scorers. Top scorers rank
// each member's best attempt by points (highest first); equal points are
// broken by time taken (fastest first).

const db = require('./db');

const TOP_N = 3;

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}

const topStmt = () =>
  db.prepare(
    `SELECT b.user_id, b.score, b.duration_ms, u.username, p.display_name, p.avatar
       FROM (SELECT user_id, score, duration_ms,
                    ROW_NUMBER() OVER (PARTITION BY user_id
                                       ORDER BY score DESC, duration_ms IS NULL, duration_ms ASC, id ASC) AS rn
               FROM quiz_attempts WHERE quiz_id = ?) b
       JOIN users u ON u.id = b.user_id
       JOIN profiles p ON p.user_id = u.id
      WHERE b.rn = 1
      ORDER BY b.score DESC, b.duration_ms IS NULL, b.duration_ms ASC, u.username ASC
      LIMIT ?`
  );

// row: a quizzes row with at least id, questions, negative_marks.
function quizStats(row) {
  const questions = parseJson(row.questions, []);
  let totalSeconds = 0;
  let untimed = 0;
  let totalPoints = 0;
  for (const q of questions) {
    if (Number.isInteger(q.seconds) && q.seconds > 0) totalSeconds += q.seconds;
    else untimed += 1;
    if (Number.isInteger(q.points) && q.points > 0) totalPoints += q.points;
  }
  const attemptedBy = db
    .prepare('SELECT COUNT(DISTINCT user_id) AS n FROM quiz_attempts WHERE quiz_id = ?')
    .get(row.id).n;
  const topScorers = topStmt()
    .all(row.id, TOP_N)
    .map((r) => ({
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
      points: r.score,
      durationMs: r.duration_ms,
    }));
  return {
    questionCount: questions.length,
    totalSeconds,
    untimedQuestions: untimed,
    totalPoints,
    negativeMarks: row.negative_marks || 0,
    attemptedBy,
    topScorers,
  };
}

// "2 min 30 s", "45 s"; untimed questions noted separately by callers.
function fmtDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (!m) return `${s} s`;
  return s ? `${m} min ${s} s` : `${m} min`;
}

// Human label for the card's total time.
function timeLabel(st) {
  if (!st.questionCount) return '—';
  if (!st.totalSeconds) return 'No time limit';
  return fmtDuration(st.totalSeconds) + (st.untimedQuestions ? ` + ${st.untimedQuestions} untimed` : '');
}

module.exports = { quizStats, fmtDuration, timeLabel };
