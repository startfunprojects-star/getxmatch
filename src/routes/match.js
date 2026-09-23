'use strict';

// Public endpoints for the shareable compatibility link. The initiator (A)
// creates a match via /api/content/quizzes/:id/match; this router lets the
// responder (B) — who may not have an account — open the link, answer, and
// see how compatible the two of them are. Both parties revisit the same link
// to read the result.

const express = require('express');

const db = require('../db');
const { optionalAuth } = require('../auth');
const { WEIGHTS } = require('../points');
const { MATCH_TTL_MS } = require('../quizTypes');
const { notifyUser, broadcastLeaderboardChange } = require('../socket');

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

// Points the viewer earned (or why not) from a completed link.
//   awarded: both sides got their points for this link
//   reason:  why not — 'guest' (answered without an account) or 'repeat'
//            (this pair already earned points on this quiz)
function pointsInfo(m, viewer) {
  const mine = viewer === 'a' ? WEIGHTS.shareCompleted : viewer === 'b' ? WEIGHTS.answerShared : 0;
  if (m.points_awarded) return { awarded: true, you: mine, sharer: WEIGHTS.shareCompleted, responder: WEIGHTS.answerShared };
  return {
    awarded: false,
    you: 0,
    sharer: WEIGHTS.shareCompleted,
    responder: WEIGHTS.answerShared,
    reason: m.b_user_id ? 'repeat' : 'guest',
  };
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
    const ctx = chatContext(m, req.user);
    return res.json({
      state: 'done',
      quizTitle: quiz.title,
      isInitiator,
      result: resultPayload(m, questions),
      points: pointsInfo(m, ctx.viewer),
      ...ctx,
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
      ttlHours: MATCH_TTL_MS / 3600000,
      isInitiator: true,
      points: { sharer: WEIGHTS.shareCompleted, responder: WEIGHTS.answerShared },
    });
  }

  return res.json({
    state: 'open',
    quizTitle: quiz.title,
    quizDescription: quiz.description,
    aName: m.a_name,
    expiresAt: m.expires_at,
    ttlHours: MATCH_TTL_MS / 3600000,
    loggedIn: !!req.user,
    points: { sharer: WEIGHTS.shareCompleted, responder: WEIGHTS.answerShared },
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
  const bUserId = req.user ? req.user.id : null;
  // Both sides are now done. Points go to the sharer (A) and the responder (B)
  // only when B is a signed-in member, and only once per quiz for each pair —
  // otherwise one person could farm points by answering their own links.
  const alreadyPaired = bUserId && db
    .prepare(
      `SELECT 1 FROM quiz_matches
        WHERE quiz_id = ? AND points_awarded = 1
          AND ((a_user_id = ? AND b_user_id = ?) OR (a_user_id = ? AND b_user_id = ?))
        LIMIT 1`
    )
    .get(m.quiz_id, m.a_user_id, bUserId, bUserId, m.a_user_id);
  const award = bUserId && m.a_user_id && !alreadyPaired ? 1 : 0;
  const info = db.prepare(
    `UPDATE quiz_matches
       SET b_user_id = ?, b_name = ?, b_answers = ?, score = ?, completed_at = ?, points_awarded = ?
     WHERE id = ? AND completed_at IS NULL`
  ).run(bUserId, finalName, JSON.stringify(bAns), score, now, award, m.id);
  // Someone else finished this link a moment earlier.
  if (!info.changes) return res.status(409).json({ error: 'This quiz has already been answered.' });

  const updated = loadMatch(req.params.token);
  const result = resultPayload(updated, questions);
  if (award) broadcastLeaderboardChange();
  // Tell the sharer their result is ready (and whether they earned points).
  notifyUser(m.a_user_id, 'quiz:matched', {
    token: m.token,
    quizTitle: quiz.title,
    bName: finalName,
    percent: result.percent,
    points: award ? WEIGHTS.shareCompleted : 0,
  });
  const ctx = chatContext(updated, req.user);
  res.json({
    state: 'done',
    quizTitle: quiz.title,
    result,
    points: pointsInfo(updated, ctx.viewer),
    ...ctx,
  });
});

module.exports = router;
