'use strict';

// Public (authenticated-user) read + interaction endpoints for the content
// features managed by the admin: quizzes, polls, and blogs.

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');

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

/* ===========================================================================
   Quizzes
=========================================================================== */

// GET /api/content/quizzes — list quizzes (no answers leaked).
router.get('/quizzes', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, title, description, questions, created_at FROM quizzes ORDER BY created_at DESC')
    .all();

  const quizzes = rows.map((r) => {
    const questions = parseJson(r.questions, []);
    const attempt = db
      .prepare(
        'SELECT score, total, created_at FROM quiz_attempts WHERE quiz_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1'
      )
      .get(r.id, req.user.id);
    const attempts = db
      .prepare('SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ?')
      .get(r.id).n;
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      questionCount: questions.length,
      attempts,
      myBest: attempt ? { score: attempt.score, total: attempt.total } : null,
      createdAt: r.created_at,
    };
  });

  res.json({ quizzes });
});

// GET /api/content/quizzes/:id — full quiz WITHOUT the correct answers.
router.get('/quizzes/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, title, description, questions FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Quiz not found.' });
  const questions = parseJson(row.questions, []).map((q) => ({
    prompt: q.prompt,
    options: Array.isArray(q.options) ? q.options : [],
  }));
  res.json({ quiz: { id: row.id, title: row.title, description: row.description, questions } });
});

// POST /api/content/quizzes/:id/attempt  { answers: [index, ...] } — grade it.
router.post('/quizzes/:id/attempt', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, title, questions FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Quiz not found.' });

  const questions = parseJson(row.questions, []);
  const answers = Array.isArray(req.body && req.body.answers) ? req.body.answers : [];

  let score = 0;
  const review = questions.map((q, i) => {
    const correct = Number(q.answer);
    const picked = Number(answers[i]);
    const right = picked === correct;
    if (right) score += 1;
    return { correct, picked: Number.isInteger(picked) ? picked : null, right };
  });

  db.prepare(
    'INSERT INTO quiz_attempts (quiz_id, user_id, score, total, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(row.id, req.user.id, score, questions.length, Date.now());

  res.json({ score, total: questions.length, review });
});

/* ===========================================================================
   Polls
=========================================================================== */

function pollPayload(row, viewerId) {
  const options = parseJson(row.options, []);
  const counts = new Array(options.length).fill(0);
  db.prepare('SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_index')
    .all(row.id)
    .forEach((r) => {
      if (r.option_index >= 0 && r.option_index < counts.length) counts[r.option_index] = r.n;
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
    total,
    closed: !!row.closed,
    myVote: mine ? mine.option_index : null,
    createdAt: row.created_at,
  };
}

// GET /api/content/polls — all polls with tallies + this user's votes.
router.get('/polls', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, question, options, closed, created_at FROM polls ORDER BY created_at DESC').all();
  res.json({ polls: rows.map((r) => pollPayload(r, req.user.id)) });
});

// POST /api/content/polls/:id/vote  { option } — cast or change a vote.
router.post('/polls/:id/vote', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, question, options, closed, created_at FROM polls WHERE id = ?').get(req.params.id);
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
    .prepare('SELECT id, title, author, excerpt, cover, created_at FROM blogs ORDER BY created_at DESC')
    .all();
  res.json({
    blogs: rows.map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      excerpt: r.excerpt,
      cover: r.cover ? `/uploads/${r.cover}` : null,
      createdAt: r.created_at,
    })),
  });
});

// GET /api/content/blogs/:id — full post.
router.get('/blogs/:id', requireAuth, (req, res) => {
  const r = db.prepare('SELECT id, title, author, excerpt, body, cover, created_at, updated_at FROM blogs WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Blog post not found.' });
  res.json({
    blog: {
      id: r.id,
      title: r.title,
      author: r.author,
      excerpt: r.excerpt,
      body: r.body,
      cover: r.cover ? `/uploads/${r.cover}` : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    },
  });
});

module.exports = router;
