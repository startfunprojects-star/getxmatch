'use strict';

// Quizzes attempted together inside a 1:1 chat. One of the two chatters starts
// an admin-authored quiz in the conversation; both answer it privately, and once
// BOTH have submitted a compatibility result is revealed (how many answers
// matched, as a percentage). See the socket handlers in src/socket.js and the
// client renderer in public/js/app.js.

const db = require('./db');

function parseJson(raw, fallback) {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v == null ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}

// The quiz's questions as [{ prompt, options:[string] }]. Answers/keys don't
// exist — a quiz is about comparing two people's picks, not right/wrong.
function quizQuestions(quizId) {
  const row = db.prepare('SELECT questions FROM quizzes WHERE id = ?').get(quizId);
  if (!row) return null;
  return parseJson(row.questions, []).map((q) => ({
    prompt: q.prompt,
    options: Array.isArray(q.options) ? q.options : [],
  }));
}

function quizMeta(quizId) {
  return db.prepare('SELECT id, title, description FROM quizzes WHERE id = ?').get(quizId) || null;
}

// Create a session between two DM participants. Returns the new session id.
function startSession({ quizId, creatorId, dmA, dmB }) {
  const lo = Math.min(dmA, dmB);
  const hi = Math.max(dmA, dmB);
  const info = db
    .prepare(
      `INSERT INTO chat_quizzes (quiz_id, dm_a, dm_b, creator_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(quizId, lo, hi, creatorId, Date.now());
  return info.lastInsertRowid;
}

function attachMessage(chatQuizId, messageId) {
  db.prepare('UPDATE chat_quizzes SET message_id = ? WHERE id = ?').run(messageId, chatQuizId);
}

function getSession(chatQuizId) {
  return db.prepare('SELECT * FROM chat_quizzes WHERE id = ?').get(chatQuizId);
}

// One of the two DM participants?
function canParticipate(session, userId) {
  return !!session && (userId === session.dm_a || userId === session.dm_b);
}

// Record (or replace) a participant's answers, validated against the quiz.
// Returns { error } on a bad payload, or {} on success.
function submitAnswers(session, userId, rawAnswers) {
  const questions = quizQuestions(session.quiz_id);
  if (!questions || !questions.length) return { error: 'This quiz is unavailable.' };

  const arr = Array.isArray(rawAnswers) ? rawAnswers : [];
  const answers = questions.map((q, i) => {
    const idx = Number(arr[i]);
    return Number.isInteger(idx) && idx >= 0 && idx < q.options.length ? idx : -1;
  });
  if (answers.some((a) => a < 0)) return { error: 'Please answer every question.' };

  db.prepare(
    `INSERT INTO chat_quiz_answers (chat_quiz_id, user_id, answers, submitted_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_quiz_id, user_id) DO UPDATE SET answers = excluded.answers, submitted_at = excluded.submitted_at`
  ).run(session.id, userId, JSON.stringify(answers), Date.now());
  return {};
}

function answersOf(chatQuizId, userId) {
  const row = db
    .prepare('SELECT answers FROM chat_quiz_answers WHERE chat_quiz_id = ? AND user_id = ?')
    .get(chatQuizId, userId);
  return row ? parseJson(row.answers, null) : null;
}

// The full, viewer-tailored payload sent to a participant's client.
// Before both have submitted, neither person's answers are revealed to the
// other — only WHO has finished. Once both are in, the comparison is shown.
function sessionPayload(chatQuizId, viewerId) {
  const session = typeof chatQuizId === 'object' ? chatQuizId : getSession(chatQuizId);
  if (!session) return null;
  const meta = quizMeta(session.quiz_id);
  const questions = quizQuestions(session.quiz_id) || [];

  const aAns = answersOf(session.id, session.dm_a);
  const bAns = answersOf(session.id, session.dm_b);
  const bothDone = !!aAns && !!bAns;

  const myAnswers = answersOf(session.id, viewerId);
  const iSubmitted = !!myAnswers;
  const otherId = viewerId === session.dm_a ? session.dm_b : session.dm_a;
  const otherSubmitted = !!answersOf(session.id, otherId);

  const payload = {
    id: session.id,
    quizId: session.quiz_id,
    title: meta ? meta.title : 'Quiz',
    description: meta ? meta.description : '',
    creatorId: session.creator_id,
    questions, // prompts + options so the client can render the quiz to answer
    iSubmitted,
    otherSubmitted,
    bothDone,
    myAnswers: myAnswers || null,
  };

  if (bothDone) {
    let matches = 0;
    const perQuestion = questions.map((q, i) => {
      const same = aAns[i] === bAns[i];
      if (same) matches++;
      return { a: aAns[i], b: bAns[i], same };
    });
    const total = questions.length || 1;
    payload.result = {
      matches,
      total: questions.length,
      percent: Math.round((matches / total) * 100),
      // Map the two stored answers onto "you" vs "them" for this viewer.
      perQuestion: perQuestion.map((pq) => ({
        mine: viewerId === session.dm_a ? pq.a : pq.b,
        theirs: viewerId === session.dm_a ? pq.b : pq.a,
        same: pq.same,
      })),
    };
  }
  return payload;
}

// Short label for a quiz session (reply previews, broadcast mirror).
function quizLabel(chatQuizId) {
  const s = getSession(chatQuizId);
  const meta = s && quizMeta(s.quiz_id);
  return meta ? `🧩 ${meta.title}` : '🧩 Quiz';
}

// Pull the chatQuizId out of a kind='quiz' message body ({"chatQuizId":N}).
function chatQuizIdFromBody(body) {
  try {
    const p = typeof body === 'string' ? JSON.parse(body) : body;
    return p && p.chatQuizId ? p.chatQuizId : null;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  startSession,
  attachMessage,
  getSession,
  canParticipate,
  submitAnswers,
  sessionPayload,
  quizLabel,
  chatQuizIdFromBody,
};
