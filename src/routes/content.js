'use strict';

// Public (authenticated-user) read + interaction endpoints for the content
// features managed by the admin: quizzes, polls, and blogs.

const crypto = require('crypto');
const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { broadcastLeaderboardChange } = require('../socket');
const { quizStats } = require('../quizStats');

const router = express.Router();

const { MATCH_TTL_MS, typeLabel, isShareable, isOpen, hasBadge, isGraded, correctOption } = require('../quizTypes');
const { WEIGHTS } = require('../points'); // shared links live for 24 hours
const { categoryLabel } = require('../quizCategories');
const challenges = require('../quizChallenge');

// Best display name for a logged-in user: their profile name, else @username.
function userDisplayName(userId) {
  const row = db
    .prepare(
      `SELECT COALESCE(NULLIF(p.display_name, ''), u.username) AS name
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .get(userId);
  return (row && row.name) || 'Someone';
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}

/* ===========================================================================
   Quizzes
=========================================================================== */

// GET /api/content/quizzes — list quizzes.
router.get('/quizzes', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, title, description, questions, negative_marks, type, category, created_at FROM quizzes ORDER BY created_at DESC')
    .all();

  const quizzes = rows.map((r) => {
    const matches = db
      .prepare('SELECT COUNT(*) AS n FROM quiz_matches WHERE quiz_id = ?')
      .get(r.id).n;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      matches,
      type: r.type,
      typeLabel: typeLabel(r.type),
      category: r.category || null,
      categoryLabel: categoryLabel(r.category),
      // shareable = finishing gives a link; badge = show the type's label;
      // open = anyone registered can answer that link.
      shareable: isShareable(r.type),
      badge: hasBadge(r.type),
      open: isOpen(r.type),
      createdAt: r.created_at,
      // questionCount, totalSeconds, untimedQuestions, totalPoints,
      // negativeMarks, attemptedBy, topScorers
      ...quizStats(r),
    };
  });

  res.json({ quizzes });
});

// GET /api/content/quizzes/:id — full quiz (prompts + options; no answers exist).
router.get('/quizzes/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, title, description, questions, seo FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Quiz not found.' });
  const questions = parseJson(row.questions, []).map((q) => ({
    prompt: q.prompt,
    options: Array.isArray(q.options) ? q.options : [],
  }));
  res.json({ quiz: { id: row.id, title: row.title, description: row.description, questions, seo: parseJson(row.seo, {}) } });
});

/* ---------------------------------------------------------------------------
   Proctoring. A quiz is attempted in full screen inside a server-side session.
   The client reports every time the user leaves full screen / the window; the
   server counts strikes so the rules can't be bypassed by editing the page:
   strike 1 = warning, strike 2 = attempt stopped, quiz locked for 24h and
   PROCTOR_PENALTY points deducted from the user's leaderboard score.
--------------------------------------------------------------------------- */
const PROCTOR_MAX_STRIKES = 2;
const PROCTOR_LOCK_MS = 24 * 60 * 60 * 1000;
const PROCTOR_PENALTY = 10;
const PROCTOR_SESSION_MS = 2 * 60 * 60 * 1000;
// Starting a quiz again after any earlier attempt (finished, stopped or
// abandoned) costs this many points, straight away. Resuming an unfinished
// session is free. A standard quiz costs more: its reattempts can't be used
// to challenge anyone either (see /match below).
const REATTEMPT_PENALTY = 10;
const STANDARD_REATTEMPT_PENALTY = 30;
const reattemptPenalty = (type) => (isGraded(type) ? STANDARD_REATTEMPT_PENALTY : REATTEMPT_PENALTY);
// One user action (e.g. Alt+Tab) fires blur + visibility + fullscreen events
// together; strikes closer than this are treated as the same incident.
const PROCTOR_GRACE_MS = 1500;

// The member's live (resumable) session for a quiz, if any.
function activeSession(userId, quizId) {
  return db
    .prepare(
      `SELECT * FROM quiz_proctor_sessions
        WHERE user_id = ? AND quiz_id = ? AND status = 'active' AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId, quizId, Date.now());
}

// True if the member has attempted this quiz before (so starting a new
// session is a reattempt).
function attemptedBefore(userId, quizId) {
  return !!(
    db.prepare('SELECT 1 FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? LIMIT 1').get(userId, quizId) ||
    db.prepare('SELECT 1 FROM quiz_proctor_sessions WHERE user_id = ? AND quiz_id = ? LIMIT 1').get(userId, quizId)
  );
}

function activeLockout(userId, quizId) {
  const row = db.prepare('SELECT until FROM quiz_lockouts WHERE user_id = ? AND quiz_id = ?').get(userId, quizId);
  return row && row.until > Date.now() ? row.until : null;
}

// Allowance for network latency on top of a question's time limit.
const ANSWER_GRACE_MS = 2000;

function questionMeta(q) {
  return {
    points: Number.isInteger(q && q.points) && q.points > 0 ? q.points : 0,
    seconds: Number.isInteger(q && q.seconds) && q.seconds > 0 ? q.seconds : 0,
  };
}

// A random permutation of 0..n-1 (Fisher–Yates).
function shuffled(n) {
  const a = Array.from({ length: n }, (_v, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The session's question order and per-question option order. Sessions from
// before shuffling (or a quiz edited mid-attempt) fall back to the original
// order wherever the stored order doesn't fit.
function sessionOrder(sess, questions) {
  const n = questions.length;
  const optCount = (q) => (Array.isArray(q && q.options) ? q.options.length : 0);
  const isPerm = (p, len) => Array.isArray(p) && p.length === len && p.every((x, i) => p.indexOf(i) >= 0);
  let order = parseJson(sess.q_order, null);
  if (!isPerm(order, n)) order = identity(n);
  const stored = parseJson(sess.opt_order, []);
  const opts = questions.map((q, i) => (isPerm(stored[i], optCount(q)) ? stored[i] : identity(optCount(q))));
  return { order, opts };
}
function identity(n) {
  return Array.from({ length: n }, (_v, i) => i);
}

// Where a session is in the quiz: the current question and how long is left
// on it (by the server's clock), plus points earned so far. In a standard
// quiz (`graded`) the points stay hidden until the end — a running score
// would give away which answers were right.
// `index` is the position in this attempt's shuffled order; `q` is the
// question shown there (its original index) and `opts` its options' original
// indexes in the order to show them.
function sessionState(sess, questions, graded) {
  const index = sess.q_index || 0;
  const done = index >= questions.length;
  let remainingMs = null;
  let q = null;
  let opts = null;
  if (!done) {
    const ord = sessionOrder(sess, questions);
    q = ord.order[index];
    opts = ord.opts[q];
    const { seconds } = questionMeta(questions[q]);
    if (seconds) remainingMs = Math.max(0, seconds * 1000 - (Date.now() - (sess.q_started_at || Date.now())));
  }
  return {
    index,
    q,
    opts,
    done,
    remainingMs,
    points: graded && !done ? null : sess.points || 0,
    maxPoints: questions.reduce((a, q) => a + questionMeta(q).points, 0),
  };
}

// For a standard quiz: how many answers were right, out of the questions that
// have a correct option set ({} for other quiz types).
function gradedCounts(type, questions, answers) {
  if (!isGraded(type)) return {};
  let graded = 0;
  let correct = 0;
  questions.forEach((q, i) => {
    const key = correctOption(q);
    if (key == null) return;
    graded += 1;
    if (answers[i] === key) correct += 1;
  });
  return graded ? { graded, correct } : {};
}

function lockedResponse(res, until) {
  return res.status(423).json({
    error: 'You were stopped from this quiz for leaving full screen. You can attempt it again after the lock expires.',
    lockedUntil: until,
  });
}

// GET /api/content/quizzes/:id/proctor — rules + whether the viewer is locked out.
router.get('/quizzes/:id/proctor', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = db.prepare('SELECT type FROM quizzes WHERE id = ?').get(quizId);
  const type = quiz ? quiz.type : null;
  // ?challenge=<token>: the member opened a challenge link (standard quiz).
  let challenge;
  if (req.query.challenge) {
    const m = challenges.loadByToken(req.query.challenge);
    if (!m || m.quiz_id !== quizId) challenge = { error: 'This challenge link is not valid.' };
    else {
      const no = challenges.whyNot(m, req.user.id);
      // The sharer's score stays hidden until the challenge is over.
      challenge = { aName: m.a_name, error: no ? no.error : null };
    }
  }
  res.json({
    challenge,
    lockedUntil: activeLockout(req.user.id, quizId),
    // Starting now would cost reattemptPenalty points (and, for a standard
    // quiz, give no challenge link).
    reattempt: !activeSession(req.user.id, quizId) && attemptedBefore(req.user.id, quizId),
    reattemptPenalty: reattemptPenalty(type),
    reattemptNoChallenge: isGraded(type),
    maxStrikes: PROCTOR_MAX_STRIKES,
    penalty: PROCTOR_PENALTY,
    lockHours: PROCTOR_LOCK_MS / 3600000,
  });
});

// POST /api/content/quizzes/:id/proctor/start — open (or resume) a session.
// An unfinished session is resumed rather than replaced, so reloading the page
// doesn't wipe an earlier strike.
router.post('/quizzes/:id/proctor/start', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, questions, type FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Quiz not found.' });
  const until = activeLockout(req.user.id, row.id);
  if (until) return lockedResponse(res, until);
  const questions = parseJson(row.questions, []);

  const now = Date.now();
  let sess = activeSession(req.user.id, row.id);
  let charged = 0;
  // Accepting a challenge: only a member who has never attempted this quiz,
  // and only one member per link. Their session is tied to the link.
  let matchId = null;
  if (req.body && req.body.challenge && !(sess && sess.match_id)) {
    const m = challenges.settleStale(challenges.loadByToken(req.body.challenge));
    if (!m || m.quiz_id !== row.id) return res.status(404).json({ error: 'This challenge link is not valid.' });
    const no = challenges.whyNot(m, req.user.id);
    if (no) return res.status(409).json({ error: no.error });
    if (!challenges.reserve(m, req.user.id)) return res.status(409).json({ error: 'Someone else already accepted this challenge.' });
    matchId = m.id;
  }
  if (!sess) {
    if (!matchId && attemptedBefore(req.user.id, row.id)) {
      charged = reattemptPenalty(row.type);
      db.prepare('INSERT INTO quiz_penalties (user_id, quiz_id, points, reason, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, row.id, charged, 'Quiz reattempt', now);
    }
    // The first question's clock starts now.
    // A fresh random order of questions and options for every attempt.
    const qOrder = JSON.stringify(shuffled(questions.length));
    const optOrder = JSON.stringify(questions.map((q) => shuffled(Array.isArray(q.options) ? q.options.length : 0)));
    sess = {
      token: crypto.randomBytes(18).toString('base64url'),
      strikes: 0, q_index: 0, q_started_at: now, points: 0, match_id: matchId, q_order: qOrder, opt_order: optOrder,
    };
    db.prepare(
      `INSERT INTO quiz_proctor_sessions (token, quiz_id, user_id, created_at, expires_at, q_started_at, match_id, q_order, opt_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sess.token, row.id, req.user.id, now, now + PROCTOR_SESSION_MS, now, matchId, qOrder, optOrder);
  }
  if (charged) broadcastLeaderboardChange();
  res.json({
    reattemptCharged: charged,
    challenge: !!sess.match_id,
    session: sess.token,
    strikes: sess.strikes,
    maxStrikes: PROCTOR_MAX_STRIKES,
    penalty: PROCTOR_PENALTY,
    state: sessionState(sess, questions, isGraded(row.type)),
  });
});

// POST /api/content/quizzes/:id/proctor/violation  { session, reason }
// Also sent with navigator.sendBeacon when the page is hidden or closed.
router.post('/quizzes/:id/proctor/violation', requireAuth, (req, res) => {
  const quizId = Number(req.params.id);
  const token = String((req.body && req.body.session) || '');
  const reason = String((req.body && req.body.reason) || 'left').slice(0, 40);
  const sess = db
    .prepare('SELECT * FROM quiz_proctor_sessions WHERE token = ? AND user_id = ? AND quiz_id = ?')
    .get(token, req.user.id, quizId);
  if (!sess) return res.status(404).json({ error: 'Quiz session not found.' });
  if (sess.status === 'terminated') {
    return res.json({ strikes: sess.strikes, terminated: true, lockedUntil: activeLockout(req.user.id, quizId), penalty: PROCTOR_PENALTY });
  }
  if (sess.status !== 'active') return res.json({ strikes: sess.strikes, terminated: false, ignored: true });

  const now = Date.now();
  if (sess.last_strike_at && now - sess.last_strike_at < PROCTOR_GRACE_MS) {
    return res.json({ strikes: sess.strikes, terminated: false, duplicate: true });
  }

  const strikes = sess.strikes + 1;
  if (strikes < PROCTOR_MAX_STRIKES) {
    db.prepare('UPDATE quiz_proctor_sessions SET strikes = ?, last_strike_at = ? WHERE token = ?').run(strikes, now, token);
    return res.json({ strikes, terminated: false, maxStrikes: PROCTOR_MAX_STRIKES, reason });
  }

  const until = now + PROCTOR_LOCK_MS;
  db.exec('BEGIN');
  try {
    db.prepare("UPDATE quiz_proctor_sessions SET strikes = ?, last_strike_at = ?, status = 'terminated' WHERE token = ?")
      .run(strikes, now, token);
    db.prepare(
      `INSERT INTO quiz_lockouts (user_id, quiz_id, until) VALUES (?, ?, ?)
       ON CONFLICT(user_id, quiz_id) DO UPDATE SET until = excluded.until`
    ).run(req.user.id, quizId, until);
    db.prepare('INSERT INTO quiz_penalties (user_id, quiz_id, points, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, quizId, PROCTOR_PENALTY, `Quiz stopped: ${reason}`, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // A challenger stopped mid-quiz forfeits the challenge.
  if (sess.match_id) forfeitChallenge(sess);
  broadcastLeaderboardChange();
  res.json({ strikes, terminated: true, lockedUntil: until, penalty: PROCTOR_PENALTY });
});

// POST /api/content/quizzes/:id/proctor/answer  { session, index, option }
// Records the answer to the current question and moves on to the next. An
// answer that arrives after the question's time limit (or option -1, sent when
// the client's timer runs out) is recorded as unanswered: it earns no points,
// and costs the quiz's negative marks if it has any. In a standard quiz only
// the correct option earns the question's points; a wrong one earns none.
router.post('/quizzes/:id/proctor/answer', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, questions, negative_marks, type FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Quiz not found.' });
  const until = activeLockout(req.user.id, row.id);
  if (until) return lockedResponse(res, until);
  const questions = parseJson(row.questions, []);

  const token = String((req.body && req.body.session) || '');
  const sess = db
    .prepare('SELECT * FROM quiz_proctor_sessions WHERE token = ? AND user_id = ? AND quiz_id = ?')
    .get(token, req.user.id, row.id);
  const now = Date.now();
  if (!sess || sess.status !== 'active' || sess.expires_at <= now) {
    return res.status(409).json({ error: 'This quiz must be taken in full screen. Please start it again.' });
  }
  const index = Number(req.body && req.body.index);
  // Out of step (e.g. a retry after the answer already landed): resync.
  if (index !== sess.q_index || sess.q_index >= questions.length) {
    return res.json({ accepted: false, state: sessionState(sess, questions, isGraded(row.type)) });
  }

  // `index` is the position in this attempt's shuffled order; the answer is
  // recorded against the question's original index. `option` is already an
  // original option index (the page only reorders how they're shown).
  const qi = sessionOrder(sess, questions).order[index];
  const q = questions[qi];
  const { points, seconds } = questionMeta(q);
  const opts = Array.isArray(q.options) ? q.options : [];
  const option = Number(req.body && req.body.option);
  const late = seconds > 0 && now - (sess.q_started_at || now) > seconds * 1000 + ANSWER_GRACE_MS;
  const answer = !late && Number.isInteger(option) && option >= 0 && option < opts.length ? option : -1;
  const key = isGraded(row.type) ? correctOption(q) : null;
  const wrong = answer >= 0 && key != null && answer !== key;
  // Negative marking: an unanswered (timed-out) question costs points.
  const earned = answer < 0 ? -(row.negative_marks || 0) : wrong ? 0 : points;

  const answers = parseJson(sess.answers, []);
  answers[qi] = answer;
  const next = { ...sess, q_index: index + 1, q_started_at: now, points: (sess.points || 0) + earned, answers: JSON.stringify(answers) };
  db.prepare('UPDATE quiz_proctor_sessions SET q_index = ?, q_started_at = ?, points = ?, answers = ? WHERE token = ?')
    .run(next.q_index, next.q_started_at, next.points, next.answers, token);
  // A standard quiz never says whether an answer was right: `earned` is only
  // sent for a skipped question (its negative marks), and the score at the end.
  const graded = isGraded(row.type);
  res.json({
    accepted: true,
    answered: answer >= 0,
    late,
    earned: graded && answer >= 0 ? null : earned,
    state: sessionState(next, questions, graded),
  });
});

// POST /api/content/quizzes/:id/match  { session }
// The logged-in initiator records their answers and gets a shareable token.
// Answers are only accepted from a live proctored session.
router.post('/quizzes/:id/match', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, title, questions, type FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Quiz not found.' });

  const until = activeLockout(req.user.id, row.id);
  if (until) return lockedResponse(res, until);
  const sessToken = String((req.body && req.body.session) || '');
  const sess = db
    .prepare('SELECT * FROM quiz_proctor_sessions WHERE token = ? AND user_id = ? AND quiz_id = ?')
    .get(sessToken, req.user.id, row.id);
  if (!sess || sess.status !== 'active' || sess.expires_at <= Date.now()) {
    return res.status(409).json({ error: 'This quiz must be taken in full screen. Please start it again.' });
  }

  const questions = parseJson(row.questions, []);
  if (!questions.length) return res.status(400).json({ error: 'This quiz has no questions.' });

  // Answers come from the session (recorded one by one against each
  // question's timer), never from this request. -1 = ran out of time.
  if (sess.q_index < questions.length) {
    return res.status(409).json({ error: 'Please answer every question first.' });
  }
  const recorded = parseJson(sess.answers, []);
  const answers = questions.map((q, i) => (Number.isInteger(recorded[i]) ? recorded[i] : -1));
  const state = sessionState(sess, questions);

  const now = Date.now();
  // The challenger finishing a standard-quiz challenge: their attempt counts
  // as usual, and the challenge is settled instead of a new link being made.
  if (sess.match_id) return finishChallenge(req, res, row, sess, questions, answers, state);

  // Every quiz type gives a share link. A standard quiz's link is a
  // challenge (one member takes it on; the winner takes the loser's points),
  // and only a member's first attempt at the quiz can challenge anyone — not
  // a reattempt, nor anything after an earlier stopped or abandoned try.
  // An open link can be answered by any registered member.
  const graded = isGraded(row.type);
  const firstTry = !(
    db.prepare('SELECT 1 FROM quiz_attempts WHERE user_id = ? AND quiz_id = ? LIMIT 1').get(req.user.id, row.id) ||
    db.prepare('SELECT 1 FROM quiz_proctor_sessions WHERE user_id = ? AND quiz_id = ? AND token != ? LIMIT 1').get(req.user.id, row.id, sessToken)
  );
  const challengeBlocked = graded && !firstTry;
  const shareable = isShareable(row.type) && !challengeBlocked;
  const open = isOpen(row.type);
  const challenge = graded && shareable;
  const token = shareable ? crypto.randomBytes(9).toString('base64url') : null; // ~12 url-safe chars
  if (shareable) db.prepare(
    `INSERT INTO quiz_matches
       (token, quiz_id, a_user_id, a_name, a_answers, total, created_at, expires_at, is_open, challenge, a_points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token,
    row.id,
    req.user.id,
    userDisplayName(req.user.id),
    JSON.stringify(answers),
    questions.length,
    now,
    now + MATCH_TTL_MS,
    open ? 1 : 0,
    challenge ? 1 : 0,
    challenge ? state.points : null
  );
  db.prepare("UPDATE quiz_proctor_sessions SET status = 'completed' WHERE token = ?").run(sessToken);
  // The attempt's points feed the leaderboard (the latest attempt per quiz
  // counts, replacing any earlier one).
  // duration_ms breaks ties between equal top scores on the quiz card.
  db.prepare('INSERT INTO quiz_attempts (quiz_id, user_id, score, total, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, req.user.id, state.points, state.maxPoints, now - sess.created_at, now);
  broadcastLeaderboardChange();

  res.status(201).json({
    token,
    expiresAt: shareable ? now + MATCH_TTL_MS : null,
    open,
    challenge,
    challengeBlocked,
    sharePoints: open
      ? { sharer: WEIGHTS.openShareAnswered, responder: WEIGHTS.openAnswer }
      : { sharer: WEIGHTS.shareCompleted, responder: WEIGHTS.answerShared },
    points: state.points,
    maxPoints: state.maxPoints,
    durationMs: now - sess.created_at,
    answered: answers.filter((a) => a >= 0).length,
    total: questions.length,
    ...gradedCounts(row.type, questions, answers),
  });
});

// Settle a challenge once the challenger has answered every question.
function finishChallenge(req, res, row, sess, questions, answers, state) {
  const now = Date.now();
  const m = db.prepare('SELECT * FROM quiz_matches WHERE id = ?').get(sess.match_id);
  db.prepare("UPDATE quiz_proctor_sessions SET status = 'completed' WHERE token = ?").run(sess.token);
  db.prepare('INSERT INTO quiz_attempts (quiz_id, user_id, score, total, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.id, req.user.id, state.points, state.maxPoints, now - sess.created_at, now);
  const done = m ? challenges.complete(m, { answers, points: state.points, forfeit: false }) : null;
  if (done) challenges.announce(done, row.title, questions);
  broadcastLeaderboardChange();
  res.status(201).json({
    challengeDone: true,
    token: m ? m.token : null,
    points: state.points,
    maxPoints: state.maxPoints,
    durationMs: now - sess.created_at,
    answered: answers.filter((a) => a >= 0).length,
    total: questions.length,
    ...gradedCounts(row.type, questions, answers),
  });
}

// The challenger was stopped for leaving full screen: they forfeit.
function forfeitChallenge(sess) {
  const m = db.prepare('SELECT * FROM quiz_matches WHERE id = ?').get(sess.match_id);
  const quiz = db.prepare('SELECT title, questions FROM quizzes WHERE id = ?').get(sess.quiz_id);
  if (!m || !quiz) return;
  const questions = parseJson(quiz.questions, []);
  const done = challenges.complete(m, { answers: questions.map(() => -1), points: 0, forfeit: true });
  if (done) challenges.announce(done, quiz.title, questions);
}

/* ===========================================================================
   Polls
=========================================================================== */

function pollPayload(row, viewerId) {
  const options = parseJson(row.options, []);
  const counts = new Array(options.length).fill(0);
  // Per-option gender split so the client can colour votes Male / Female.
  const genders = options.map(() => ({ male: 0, female: 0, other: 0 }));
  db.prepare(
    `SELECT v.option_index AS oi, p.gender AS gender
       FROM poll_votes v LEFT JOIN profiles p ON p.user_id = v.user_id
      WHERE v.poll_id = ?`
  )
    .all(row.id)
    .forEach((r) => {
      const i = r.oi;
      if (!(i >= 0 && i < counts.length)) return;
      counts[i] += 1;
      if (r.gender === 'Male') genders[i].male += 1;
      else if (r.gender === 'Female') genders[i].female += 1;
      else genders[i].other += 1;
    });
  const mine = db
    .prepare('SELECT option_index FROM poll_votes WHERE poll_id = ? AND user_id = ?')
    .get(row.id, viewerId);
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    id: row.id,
    question: row.question,
    options,
    counts,
    genders,
    total,
    closed: !!row.closed,
    seo: parseJson(row.seo, {}),
    myVote: mine ? mine.option_index : null,
    createdAt: row.created_at,
  };
}

// GET /api/content/polls — all polls with tallies + this user's votes.
router.get('/polls', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, question, options, closed, seo, created_at FROM polls ORDER BY created_at DESC').all();
  res.json({ polls: rows.map((r) => pollPayload(r, req.user.id)) });
});

// POST /api/content/polls/:id/vote  { option } — cast or change a vote.
router.post('/polls/:id/vote', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, question, options, closed, seo, created_at FROM polls WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Poll not found.' });
  if (row.closed) return res.status(403).json({ error: 'This poll is closed.' });

  const options = parseJson(row.options, []);
  const idx = parseInt(req.body && req.body.option, 10);
  if (!(idx >= 0 && idx < options.length)) {
    return res.status(400).json({ error: 'Invalid option.' });
  }

  db.prepare(
    `INSERT INTO poll_votes (poll_id, user_id, option_index, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(poll_id, user_id) DO UPDATE SET option_index = excluded.option_index, created_at = excluded.created_at`
  ).run(row.id, req.user.id, idx, Date.now());
  broadcastLeaderboardChange(); // a first vote earns poll points

  res.json({ poll: pollPayload(row, req.user.id) });
});

// Blogs moved to src/routes/blogs.js (/api/blogs).

module.exports = router;
