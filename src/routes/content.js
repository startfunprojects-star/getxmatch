'use strict';

// Public (authenticated-user) read + interaction endpoints for the content
// features managed by the admin: quizzes, polls, and blogs.

const crypto = require('crypto');
const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { broadcastLeaderboardChange } = require('../socket');

const router = express.Router();

const MATCH_TTL_MS = 60 * 60 * 1000; // shared links live for one hour

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
    .prepare('SELECT id, title, description, questions, created_at FROM quizzes ORDER BY created_at DESC')
    .all();

  const quizzes = rows.map((r) => {
    const questions = parseJson(r.questions, []);
    const matches = db
      .prepare('SELECT COUNT(*) AS n FROM quiz_matches WHERE quiz_id = ?')
      .get(r.id).n;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      questionCount: questions.length,
      matches,
      createdAt: r.created_at,
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
// One user action (e.g. Alt+Tab) fires blur + visibility + fullscreen events
// together; strikes closer than this are treated as the same incident.
const PROCTOR_GRACE_MS = 1500;

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

// Where a session is in the quiz: the current question and how long is left
// on it (by the server's clock), plus points earned so far.
function sessionState(sess, questions) {
  const index = sess.q_index || 0;
  const done = index >= questions.length;
  let remainingMs = null;
  if (!done) {
    const { seconds } = questionMeta(questions[index]);
    if (seconds) remainingMs = Math.max(0, seconds * 1000 - (Date.now() - (sess.q_started_at || Date.now())));
  }
  return {
    index,
    done,
    remainingMs,
    points: sess.points || 0,
    maxPoints: questions.reduce((a, q) => a + questionMeta(q).points, 0),
  };
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
  res.json({
    lockedUntil: activeLockout(req.user.id, quizId),
    maxStrikes: PROCTOR_MAX_STRIKES,
    penalty: PROCTOR_PENALTY,
    lockHours: PROCTOR_LOCK_MS / 3600000,
  });
});

// POST /api/content/quizzes/:id/proctor/start — open (or resume) a session.
// An unfinished session is resumed rather than replaced, so reloading the page
// doesn't wipe an earlier strike.
router.post('/quizzes/:id/proctor/start', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, questions FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Quiz not found.' });
  const until = activeLockout(req.user.id, row.id);
  if (until) return lockedResponse(res, until);
  const questions = parseJson(row.questions, []);

  const now = Date.now();
  let sess = db
    .prepare(
      `SELECT * FROM quiz_proctor_sessions
        WHERE user_id = ? AND quiz_id = ? AND status = 'active' AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(req.user.id, row.id, now);
  if (!sess) {
    // The first question's clock starts now.
    sess = { token: crypto.randomBytes(18).toString('base64url'), strikes: 0, q_index: 0, q_started_at: now, points: 0 };
    db.prepare(
      `INSERT INTO quiz_proctor_sessions (token, quiz_id, user_id, created_at, expires_at, q_started_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sess.token, row.id, req.user.id, now, now + PROCTOR_SESSION_MS, now);
  }
  res.json({
    session: sess.token,
    strikes: sess.strikes,
    maxStrikes: PROCTOR_MAX_STRIKES,
    penalty: PROCTOR_PENALTY,
    state: sessionState(sess, questions),
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
  broadcastLeaderboardChange();
  res.json({ strikes, terminated: true, lockedUntil: until, penalty: PROCTOR_PENALTY });
});

// POST /api/content/quizzes/:id/proctor/answer  { session, index, option }
// Records the answer to the current question and moves on to the next. An
// answer that arrives after the question's time limit (or option -1, sent when
// the client's timer runs out) is recorded as unanswered and earns no points.
router.post('/quizzes/:id/proctor/answer', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, questions FROM quizzes WHERE id = ?').get(req.params.id);
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
    return res.json({ accepted: false, state: sessionState(sess, questions) });
  }

  const q = questions[index];
  const { points, seconds } = questionMeta(q);
  const opts = Array.isArray(q.options) ? q.options : [];
  const option = Number(req.body && req.body.option);
  const late = seconds > 0 && now - (sess.q_started_at || now) > seconds * 1000 + ANSWER_GRACE_MS;
  const answer = !late && Number.isInteger(option) && option >= 0 && option < opts.length ? option : -1;
  const earned = answer >= 0 ? points : 0;

  const answers = parseJson(sess.answers, []);
  answers[index] = answer;
  const next = { ...sess, q_index: index + 1, q_started_at: now, points: (sess.points || 0) + earned, answers: JSON.stringify(answers) };
  db.prepare('UPDATE quiz_proctor_sessions SET q_index = ?, q_started_at = ?, points = ?, answers = ? WHERE token = ?')
    .run(next.q_index, next.q_started_at, next.points, next.answers, token);
  res.json({ accepted: true, answered: answer >= 0, late, earned, state: sessionState(next, questions) });
});

// POST /api/content/quizzes/:id/match  { session }
// The logged-in initiator records their answers and gets a shareable token.
// Answers are only accepted from a live proctored session.
router.post('/quizzes/:id/match', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, questions FROM quizzes WHERE id = ?').get(req.params.id);
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
  const token = crypto.randomBytes(9).toString('base64url'); // ~12 url-safe chars
  db.prepare(
    `INSERT INTO quiz_matches
       (token, quiz_id, a_user_id, a_name, a_answers, total, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token,
    row.id,
    req.user.id,
    userDisplayName(req.user.id),
    JSON.stringify(answers),
    questions.length,
    now,
    now + MATCH_TTL_MS
  );
  db.prepare("UPDATE quiz_proctor_sessions SET status = 'completed' WHERE token = ?").run(sessToken);
  // The attempt's points feed the leaderboard (best attempt per quiz counts).
  db.prepare('INSERT INTO quiz_attempts (quiz_id, user_id, score, total, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.id, req.user.id, state.points, state.maxPoints, now);
  broadcastLeaderboardChange();

  res.status(201).json({
    token,
    expiresAt: now + MATCH_TTL_MS,
    points: state.points,
    maxPoints: state.maxPoints,
    answered: answers.filter((a) => a >= 0).length,
    total: questions.length,
  });
});

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

  res.json({ poll: pollPayload(row, req.user.id) });
});

/* ===========================================================================
   Blogs
=========================================================================== */

// GET /api/content/blogs — list (excerpt only).
router.get('/blogs', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, title, author, excerpt, cover, seo, created_at FROM blogs ORDER BY created_at DESC')
    .all();
  res.json({
    blogs: rows.map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      excerpt: r.excerpt,
      cover: r.cover ? `/uploads/${r.cover}` : null,
      seo: parseJson(r.seo, {}),
      createdAt: r.created_at,
    })),
  });
});

// GET /api/content/blogs/:id — full post.
router.get('/blogs/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT id, title, author, excerpt, body, cover, seo, created_at, updated_at FROM blogs WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Blog post not found.' });
  res.json({
    blog: {
      id: r.id,
      title: r.title,
      author: r.author,
      excerpt: r.excerpt,
      body: r.body,
      cover: r.cover ? `/uploads/${r.cover}` : null,
      seo: parseJson(r.seo, {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
  });
});

module.exports = router;
