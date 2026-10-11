'use strict';

// Suggestions: any registered member can send the admin an idea, improvement
// or problem report. The admin sees each one with who sent it (Admin →
// Suggestions), can set its status and reply; the member sees their own
// suggestions with that status and reply.
//
//   GET  /api/suggestions        my suggestions, newest first
//   POST /api/suggestions        { category, body }
//
// Admin endpoints live in src/routes/admin.js (/api/admin/suggestions).

const express = require('express');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const { requireAuth } = require('../auth');

const CATEGORIES = ['Feature idea', 'Improvement', 'Problem / bug', 'Content', 'Other'];
const STATUSES = ['new', 'reviewing', 'planned', 'done', 'declined'];
const BODY_MAX = 2000;
const REPLY_MAX = 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS suggestions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category    TEXT NOT NULL DEFAULT 'Other',
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'new',
    reply       TEXT,
    replied_at  INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_suggestions_recent ON suggestions (created_at);
  CREATE INDEX IF NOT EXISTS idx_suggestions_user ON suggestions (user_id, created_at);
`);

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You have sent a lot of suggestions this hour. Please try again later.' },
});

function shapeMine(r) {
  return {
    id: r.id,
    category: r.category,
    body: r.body,
    status: r.status,
    reply: r.reply || null,
    repliedAt: r.replied_at || null,
    createdAt: r.created_at,
  };
}

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM suggestions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ suggestions: rows.map(shapeMine), categories: CATEGORIES, max: BODY_MAX });
});

router.post('/', requireAuth, limiter, (req, res) => {
  const body = String((req.body && req.body.body) || '').trim().slice(0, BODY_MAX);
  if (body.length < 5) return res.status(400).json({ error: 'Please write your suggestion (a few words at least).' });
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO suggestions (user_id, category, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, category, body, now, now);
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ suggestion: shapeMine(row) });
});

module.exports = router;
module.exports.CATEGORIES = CATEGORIES;
module.exports.STATUSES = STATUSES;
module.exports.REPLY_MAX = REPLY_MAX;
