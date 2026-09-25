'use strict';

// Public endpoints for the shareable compatibility link. The initiator (A)
// creates a match via /api/content/quizzes/:id/match; this router lets the
// responder (B) — who may not have an account — open the link, answer, and
// see how compatible the two of them are. Both parties revisit the same link
// to read the result.
//
// Open links (quiz_matches.is_open, from an open_compatibility quiz) are never
// "completed": any number of registered members can answer them, each getting
// a row in open_match_responses. The sharer sees every responder's result;
// a responder sees only their own compatibility with the sharer.

const express = require('express');

const db = require('../db');
const { optionalAuth } = require('../auth');
const { WEIGHTS } = require('../points');
const { MATCH_TTL_MS } = require('../quizTypes');
const { notifyUser, broadcastLeaderboardChange } = require('../socket');
const { addMatchNotifications } = require('./notifications');

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

// Validated option indexes for every question, or null if any is missing.
function parseAnswers(body, questions) {
  const raw = Array.isArray(body && body.answers) ? body.answers : [];
  const ans = questions.map((q, i) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    const idx = Number(raw[i]);
    return Number.isInteger(idx) && idx >= 0 && idx < opts.length ? idx : -1;
  });
  return ans.some((a) => a < 0) ? null : ans;
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

/* ---------------------------------------------------------------------------
   Open links
--------------------------------------------------------------------------- */

const OPEN_POINTS = { sharer: WEIGHTS.openShareAnswered, responder: WEIGHTS.openAnswer };

function openResponse(m, userId) {
  return db.prepare('SELECT * FROM open_match_responses WHERE match_id = ? AND user_id = ?').get(m.id, userId);
}

function userDisplayName(userId) {
  const r = db
    .prepare("SELECT COALESCE(NULLIF(p.display_name, ''), u.username) AS name FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?")
    .get(userId);
  return r ? r.name : 'Member';
}

// One responder's result against the sharer, shaped like a 1:1 result.
function openResultPayload(m, r, questions) {
  return resultPayload(
    { ...m, b_name: r.name, b_answers: r.answers, score: r.score, completed_at: r.created_at },
    questions
  );
}

function openPointsInfo(r, viewer) {
  if (r.points_awarded) {
    return { awarded: true, you: viewer === 'a' ? OPEN_POINTS.sharer : OPEN_POINTS.responder, ...OPEN_POINTS };
  }
  return { awarded: false, you: 0, ...OPEN_POINTS, reason: 'repeat' };
}

// A responder's own view: their compatibility with the sharer only.
function openResponderDone(m, r, quiz, questions) {
  return {
    state: 'done',
    open: true,
    quizTitle: quiz.title,
    isInitiator: false,
    viewer: 'b',
    result: openResultPayload(m, r, questions),
    points: openPointsInfo(r, 'b'),
    chat: { canChat: true, otherName: m.a_name, otherUsername: usernameOf(m.a_user_id), needSignup: false },
  };
}

function openGet(req, res, m, quiz, questions) {
  const expired = Date.now() > m.expires_at;
  const isInitiator = !!(req.user && m.a_user_id && req.user.id === m.a_user_id);

  // The sharer sees everyone who answered, newest first.
  if (isInitiator) {
    const rows = db.prepare('SELECT * FROM open_match_responses WHERE match_id = ? ORDER BY created_at DESC').all(m.id);
    return res.json({
      state: 'open_owner',
      open: true,
      quizTitle: quiz.title,
      isInitiator: true,
      aName: m.a_name,
      expired,
      expiresAt: m.expires_at,
      ttlHours: MATCH_TTL_MS / 3600000,
      points: OPEN_POINTS,
      responses: rows.map((r) => ({
        username: usernameOf(r.user_id),
        pointsAwarded: !!r.points_awarded,
        ...openResultPayload(m, r, questions),
      })),
    });
  }

  if (req.user) {
    const mine = openResponse(m, req.user.id);
    if (mine) return res.json(openResponderDone(m, mine, quiz, questions));
  }
  if (expired) return res.json({ state: 'expired', quizTitle: quiz.title, isInitiator: false });
  // Only registered members can answer an open link.
  if (!req.user) {
    return res.json({ state: 'login_required', open: true, quizTitle: quiz.title, aName: m.a_name, points: OPEN_POINTS });
  }
  return res.json({
    state: 'open',
    open: true,
    quizTitle: quiz.title,
    quizDescription: quiz.description,
    aName: m.a_name,
    expiresAt: m.expires_at,
    ttlHours: MATCH_TTL_MS / 3600000,
    loggedIn: true,
    points: OPEN_POINTS,
    questions: questions.map((q) => ({ prompt: q.prompt, options: Array.isArray(q.options) ? q.options : [] })),
  });
}

function openAnswer(req, res, m, quiz, questions, bAns) {
  if (!req.user) return res.status(401).json({ error: 'Please log in to getxmatch to answer this quiz.' });
  if (m.a_user_id && req.user.id === m.a_user_id) {
    return res.status(403).json({ error: 'You started this quiz — share the link with others.' });
  }
  if (openResponse(m, req.user.id)) return res.status(409).json({ error: 'You have already answered this quiz.' });
  if (Date.now() > m.expires_at) return res.status(410).json({ error: 'This link has expired.' });

  const aAns = parseJson(m.a_answers, []);
  let score = 0;
  bAns.forEach((b, i) => { if (b === aAns[i]) score += 1; });

  const bUserId = req.user.id;
  const name = userDisplayName(bUserId);
  // Points once per quiz for each pair of members (either direction, via any
  // open link), so re-sharing to the same person earns nothing.
  const alreadyPaired = db
    .prepare(
      `SELECT 1 FROM open_match_responses
        WHERE quiz_id = ? AND points_awarded = 1
          AND ((a_user_id = ? AND user_id = ?) OR (a_user_id = ? AND user_id = ?))
        LIMIT 1`
    )
    .get(m.quiz_id, m.a_user_id, bUserId, bUserId, m.a_user_id);
  const award = m.a_user_id && !alreadyPaired ? 1 : 0;
  try {
    db.prepare(
      `INSERT INTO open_match_responses
         (match_id, quiz_id, a_user_id, user_id, name, answers, score, total, points_awarded, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(m.id, m.quiz_id, m.a_user_id, bUserId, name, JSON.stringify(bAns), score, m.total, award, Date.now());
  } catch (_e) {
    // UNIQUE (match_id, user_id): a double submit landed first.
    return res.status(409).json({ error: 'You have already answered this quiz.' });
  }

  const r = openResponse(m, bUserId);
  const result = openResultPayload(m, r, questions);
  if (award) broadcastLeaderboardChange();
  addMatchNotifications({
    m,
    quizTitle: quiz.title,
    bUserId,
    bName: name,
    result,
    sharerPoints: award ? OPEN_POINTS.sharer : 0,
    responderPoints: award ? OPEN_POINTS.responder : 0,
  });
  notifyUser(bUserId, 'notify:new', {});
  notifyUser(m.a_user_id, 'quiz:matched', {
    token: m.token,
    quizTitle: quiz.title,
    bName: name,
    percent: result.percent,
    points: award ? OPEN_POINTS.sharer : 0,
  });
  res.json(openResponderDone(m, r, quiz, questions));
}

// GET /api/match/:token — current state of a shared link.
router.get('/:token', optionalAuth, (req, res) => {
  const m = loadMatch(req.params.token);
  if (!m) return res.status(404).json({ error: 'This link is not valid.' });

  const quiz = db.prepare('SELECT title, description, questions FROM quizzes WHERE id = ?').get(m.quiz_id);
  if (!quiz) return res.status(404).json({ error: 'This quiz no longer exists.' });
  const questions = parseJson(quiz.questions, []);
  if (m.is_open) return openGet(req, res, m, quiz, questions);
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
  if (m.is_open) {
    const quiz = db.prepare('SELECT title, questions FROM quizzes WHERE id = ?').get(m.quiz_id);
    if (!quiz) return res.status(404).json({ error: 'This quiz no longer exists.' });
    const questions = parseJson(quiz.questions, []);
    const bAns = parseAnswers(req.body, questions);
    if (!bAns) return res.status(400).json({ error: 'Please answer every question.' });
    return openAnswer(req, res, m, quiz, questions, bAns);
  }
  if (m.completed_at) return res.status(409).json({ error: 'This quiz has already been answered.' });
  if (Date.now() > m.expires_at) return res.status(410).json({ error: 'This link has expired.' });
  if (req.user && m.a_user_id && req.user.id === m.a_user_id) {
    return res.status(403).json({ error: 'You started this quiz — share the link with someone else.' });
  }

  const quiz = db.prepare('SELECT title, questions FROM quizzes WHERE id = ?').get(m.quiz_id);
  if (!quiz) return res.status(404).json({ error: 'This quiz no longer exists.' });
  const questions = parseJson(quiz.questions, []);

  const finalName = String((req.body && req.body.name) || '').trim().slice(0, 50) || 'Your match';

  const bAns = parseAnswers(req.body, questions);
  if (!bAns) return res.status(400).json({ error: 'Please answer every question.' });

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
  // Both people get a notification with the compatibility result.
  addMatchNotifications({
    m,
    quizTitle: quiz.title,
    bUserId,
    bName: finalName,
    result,
    sharerPoints: award ? WEIGHTS.shareCompleted : 0,
    responderPoints: award ? WEIGHTS.answerShared : 0,
  });
  if (bUserId) notifyUser(bUserId, 'notify:new', {});
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
