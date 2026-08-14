'use strict';

// Public endpoints for the shareable compatibility link. The initiator (A)
// creates a match via /api/content/quizzes/:id/match; this router lets the
// responder (B) — who may not have an account — open the link, answer, and
// see how compatible the two of them are. Both parties revisit the same link
// to read the result.

const express = require('express');

const db = require('../db');
const { optionalAuth } = require('../auth');

const router = express.Router();

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}

function loadMatch(token) {
  return db.prepare('SELECT * FROM quiz_matches WHERE token = ?').get(token);
}

function usernameOf(userId) {
  if (!userId) return null;
  const r = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  return r ? r.username : null;
}

// Work out who the viewer is relative to a completed match, and how (or whether)
// they can chat with the other party. A is always a registered user; B may be a
// guest who answered anonymously.
function chatContext(m, reqUser) {
  let viewer = 'guest';
  if (reqUser && m.a_user_id && reqUser.id === m.a_user_id) viewer = 'a';
  else if (reqUser && m.b_user_id && reqUser.id === m.b_user_id) viewer = 'b';

  if (viewer === 'a') {
    const bRegistered = !!m.b_user_id;
    return {
      viewer,
      chat: {
        canChat: bRegistered,
        otherName: m.b_name,
        otherUsername: bRegistered ? usernameOf(m.b_user_id) : null,
        needSignup: false,
      },
    };
  }
  // viewer is B (registered) or a guest — either way the person they'd chat
  // with is the initiator A, who is always registered.
  return {
    viewer,
    chat: {
      canChat: viewer === 'b',
      otherName: m.a_name,
      otherUsername: usernameOf(m.a_user_id),
      needSignup: viewer === 'guest',
    },
  };
}

// Shape the completed-result payload (safe to show to either party).
function resultPayload(m, questions) {
  const aAns = parseJson(m.a_answers, []);
  const bAns = parseJson(m.b_answers, []);
  const breakdown = questions.map((q, i) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    return {
      prompt: q.prompt,
      a: opts[aAns[i]] != null ? opts[aAns[i]] : null,
      b: opts[bAns[i]] != null ? opts[bAns[i]] : null,
      match: aAns[i] === bAns[i],
    };
  });
  return {
    score: m.score,
    total: m.total,
    percent: m.total ? Math.round((m.score / m.total) * 100) : 0,
    aName: m.a_name,
    bName: m.b_name,
    breakdown,
    completedAt: m.completed_at,
  };
}

// GET /api/match/:token — current state of a shared link.
router.get('/:token', optionalAuth, (req, res) => {
  const m = loadMatch(req.params.token);
  if (!m) return res.status(404).json({ error: 'This link is not valid.' });

  const quiz = db.prepare('SELECT title, description, questions FROM quizzes WHERE id = ?').get(m.quiz_id);
  if (!quiz) return res.status(404).json({ error: 'This quiz no longer exists.' });
  const questions = parseJson(quiz.questions, []);
  const isInitiator = !!(req.user && m.a_user_id && req.user.id === m.a_user_id);

  // Already completed → show the result to anyone with the link.
  if (m.completed_at) {
    return res.json({
      state: 'done',
      quizTitle: quiz.title,
      isInitiator,
      result: resultPayload(m, questions),
      ...chatContext(m, req.user),
    });
  }

  // Expired before anyone answered.
  if (Date.now() > m.expires_at) {
    return res.json({ state: 'expired', quizTitle: quiz.title, isInitiator });
  }

  // Still open. The initiator sees a "waiting" screen; everyone else answers.
  if (isInitiator) {
    return res.json({
      state: 'waiting',
      quizTitle: quiz.title,
      aName: m.a_name,
      expiresAt: m.expires_at,
      isInitiator: true,
    });
  }

  return res.json({
    state: 'open',
    quizTitle: quiz.title,
    quizDescription: quiz.description,
    aName: m.a_name,
    expiresAt: m.expires_at,
    questions: questions.map((q) => ({
      prompt: q.prompt,
      options: Array.isArray(q.options) ? q.options : [],
    })),
  });
});

// POST /api/match/:token/answer  { name, answers } — responder submits.
router.post('/:token/answer', optionalAuth, (req, res) => {
  const m = loadMatch(req.params.token);
  if (!m) return res.status(404).json({ error: 'This link is not valid.' });
  if (m.completed_at) return res.status(409).json({ error: 'This quiz has already been answered.' });
  if (Date.now() > m.expires_at) return res.status(410).json({ error: 'This link has expired.' });
  if (req.user && m.a_user_id && req.user.id === m.a_user_id) {
    return res.status(403).json({ error: 'You started this quiz — share the link with someone else.' });
  }

  const quiz = db.prepare('SELECT title, questions FROM quizzes WHERE id = ?').get(m.quiz_id);
  if (!quiz) return res.status(404).json({ error: 'This quiz no longer exists.' });
  const questions = parseJson(quiz.questions, []);

  const finalName = String((req.body && req.body.name) || '').trim().slice(0, 50) || 'Your match';

  const raw = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];
  const bAns = questions.map((q, i) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    const idx = Number(raw[i]);
    return Number.isInteger(idx) && idx >= 0 && idx < opts.length ? idx : -1;
  });
  if (bAns.some((a) => a < 0)) {
    return res.status(400).json({ error: 'Please answer every question.' });
  }

  const aAns = parseJson(m.a_answers, []);
  let score = 0;
  bAns.forEach((b, i) => { if (b === aAns[i]) score += 1; });

  const now = Date.now();
  db.prepare(
    `UPDATE quiz_matches
       SET b_user_id = ?, b_name = ?, b_answers = ?, score = ?, completed_at = ?
     WHERE id = ?`
  ).run(req.user ? req.user.id : null, finalName, JSON.stringify(bAns), score, now, m.id);

  const updated = loadMatch(req.params.token);
  res.json({
    state: 'done',
    quizTitle: quiz.title,
    result: resultPayload(updated, questions),
    ...chatContext(updated, req.user),
  });
});

module.exports = router;
