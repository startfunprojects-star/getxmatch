'use strict';

// Standard-quiz challenges. After attempting a standard quiz, a member gets a
// share link (a quiz_matches row with challenge = 1). Exactly one other
// registered member can accept it — and only if they have never attempted
// that quiz — by taking the same quiz in full screen with the same timers.
// Whoever scores more points wins and takes the loser's points for that
// attempt (the loser drops by the same amount). A tie moves no points. A
// challenger stopped for leaving full screen forfeits.

const db = require('./db');
const { correctOption } = require('./quizTypes');

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}

function displayName(userId) {
  const r = db
    .prepare("SELECT COALESCE(NULLIF(p.display_name, ''), u.username) AS name FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?")
    .get(userId);
  return r ? r.name : 'Member';
}

function loadByToken(token) {
  return db.prepare('SELECT * FROM quiz_matches WHERE token = ? AND challenge = 1').get(String(token || ''));
}

// Has the member attempted this quiz outside this challenge?
function attemptedOutside(userId, quizId, matchId) {
  return !!(
    db.prepare('SELECT 1 FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? LIMIT 1').get(userId, quizId) ||
    db.prepare('SELECT 1 FROM quiz_proctor_sessions WHERE user_id = ? AND quiz_id = ? AND (match_id IS NULL OR match_id != ?) LIMIT 1')
      .get(userId, quizId, matchId)
  );
}

// Why `userId` can't take this challenge, or null if they can.
//   own | done | expired | taken (someone else accepted it) | attempted
function whyNot(m, userId) {
  if (m.a_user_id === userId) return { code: 'own', error: 'This is your own challenge — share the link with someone else.' };
  if (m.completed_at) return { code: 'done', error: 'This challenge is already over.' };
  if (m.b_user_id && m.b_user_id !== userId) return { code: 'taken', error: 'Someone else already accepted this challenge.' };
  if (Date.now() > m.expires_at) return { code: 'expired', error: 'This challenge link has expired.' };
  if (attemptedOutside(userId, m.quiz_id, m.id)) {
    return { code: 'attempted', error: 'You’ve already taken this quiz, so you can’t accept a challenge on it.' };
  }
  return null;
}

// Claim the link for `userId` (only one member can ever take it).
function reserve(m, userId) {
  const info = db
    .prepare(
      `UPDATE quiz_matches SET b_user_id = ?, b_name = ?
        WHERE id = ? AND completed_at IS NULL AND (b_user_id IS NULL OR b_user_id = ?)`
    )
    .run(userId, displayName(userId), m.id, userId);
  return info.changes > 0;
}

// Who won and how many points moved. winner: 'a' | 'b' | 'tie'.
function outcome(m) {
  const a = m.a_points || 0;
  const b = m.b_points || 0;
  if (m.b_forfeit) return { winner: 'a', transfer: 0 };
  if (a === b) return { winner: 'tie', transfer: 0 };
  const winner = a > b ? 'a' : 'b';
  return { winner, transfer: Math.max(0, winner === 'a' ? b : a) };
}

// The challenge summary shown on the result page and in notifications.
function summary(m) {
  const { winner, transfer } = outcome(m);
  return { aPoints: m.a_points || 0, bPoints: m.b_points || 0, winner, transfer, forfeit: !!m.b_forfeit };
}

// Right answers per side ({ aCorrect, bCorrect, graded }).
function correctCounts(m, questions) {
  const aAns = parseJson(m.a_answers, []);
  const bAns = parseJson(m.b_answers, []);
  let graded = 0;
  let aCorrect = 0;
  let bCorrect = 0;
  questions.forEach((q, i) => {
    const key = correctOption(q);
    if (key == null) return;
    graded += 1;
    if (aAns[i] === key) aCorrect += 1;
    if (bAns[i] === key) bCorrect += 1;
  });
  return { aCorrect, bCorrect, graded };
}

// Finish the challenge with the challenger's answers and points, and move the
// loser's points to the winner. Returns the updated row, or null if it was
// already finished.
function complete(m, { answers, points, forfeit }) {
  const now = Date.now();
  const aAns = parseJson(m.a_answers, []);
  let common = 0;
  answers.forEach((b, i) => { if (b >= 0 && b === aAns[i]) common += 1; });
  db.exec('BEGIN');
  try {
    const info = db
      .prepare(
        `UPDATE quiz_matches
            SET b_answers = ?, b_points = ?, b_forfeit = ?, score = ?, completed_at = ?, points_awarded = 0
          WHERE id = ? AND completed_at IS NULL`
      )
      .run(JSON.stringify(answers), forfeit ? 0 : points, forfeit ? 1 : 0, common, now, m.id);
    if (!info.changes) {
      db.exec('ROLLBACK');
      return null;
    }
    const done = db.prepare('SELECT * FROM quiz_matches WHERE id = ?').get(m.id);
    const { winner, transfer } = outcome(done);
    if (transfer && done.a_user_id && done.b_user_id) {
      const winnerId = winner === 'a' ? done.a_user_id : done.b_user_id;
      const loserId = winner === 'a' ? done.b_user_id : done.a_user_id;
      const ins = db.prepare('INSERT INTO quiz_challenge_points (user_id, quiz_id, match_id, points, created_at) VALUES (?, ?, ?, ?, ?)');
      ins.run(winnerId, done.quiz_id, done.id, transfer, now);
      ins.run(loserId, done.quiz_id, done.id, -transfer, now);
    }
    db.exec('COMMIT');
    return done;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Tell both sides how it went (Notifications + a live toast for the sharer).
// Required lazily: socket.js and the notifications router load after this.
function announce(m, quizTitle, questions) {
  const { notifyUser } = require('./socket');
  const { addMatchNotifications } = require('./routes/notifications');
  const counts = correctCounts(m, questions);
  const challenge = summary(m);
  const result = {
    scored: true,
    ...counts,
    challenge,
    score: m.score,
    total: m.total,
    percent: m.total ? Math.round((m.score / m.total) * 100) : 0,
  };
  addMatchNotifications({ m, quizTitle, bUserId: m.b_user_id, bName: m.b_name, result, sharerPoints: 0, responderPoints: 0 });
  if (m.b_user_id) notifyUser(m.b_user_id, 'notify:new', {});
  const aDelta = challenge.winner === 'a' ? challenge.transfer : challenge.winner === 'b' ? -challenge.transfer : 0;
  notifyUser(m.a_user_id, 'quiz:matched', {
    token: m.token,
    quizTitle,
    bName: m.b_name,
    percent: result.percent,
    scored: true,
    challenge: true,
    aPoints: challenge.aPoints,
    bPoints: challenge.bPoints,
    winner: challenge.winner,
    forfeit: challenge.forfeit,
    points: aDelta,
  });
}

// The challenger accepted but their attempt ended without finishing (their
// session expired): settle it as a forfeit so the link doesn't hang open and
// they can't restart the quiz with fresh timers. Returns the current row.
function settleStale(m) {
  if (!m || m.completed_at || !m.b_user_id) return m;
  const live = db
    .prepare("SELECT 1 FROM quiz_proctor_sessions WHERE match_id = ? AND status = 'active' AND expires_at > ? LIMIT 1")
    .get(m.id, Date.now());
  if (live) return m;
  const quiz = db.prepare('SELECT title, questions FROM quizzes WHERE id = ?').get(m.quiz_id);
  if (!quiz) return m;
  const questions = parseJson(quiz.questions, []);
  const done = complete(m, { answers: questions.map(() => -1), points: 0, forfeit: true });
  if (!done) return db.prepare('SELECT * FROM quiz_matches WHERE id = ?').get(m.id);
  announce(done, quiz.title, questions);
  return done;
}

module.exports = { loadByToken, whyNot, reserve, complete, summary, correctCounts, announce, settleStale };
