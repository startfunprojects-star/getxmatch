'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

// GET /api/users?q=search — browse/search other users who have a profile
router.get('/', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;

  const rows = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar
       FROM users u JOIN profiles p ON p.user_id = u.id
       WHERE u.id != ?
         AND (? = '' OR u.username LIKE ? OR p.display_name LIKE ?)
       ORDER BY p.updated_at DESC
       LIMIT 100`
    )
    .all(req.user.id, q, like, like);

  res.json({
    users: rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
    })),
  });
});

// GET /api/users/:id/messages — text chat history with a given user
router.get('/:id/messages', requireAuth, (req, res) => {
  const otherId = parseInt(req.params.id, 10);
  if (!otherId) return res.status(400).json({ error: 'Invalid user id.' });

  const rows = db
    .prepare(
      `SELECT id, sender_id, recipient_id, body, kind, created_at
       FROM messages
       WHERE (sender_id = ? AND recipient_id = ?)
          OR (sender_id = ? AND recipient_id = ?)
       ORDER BY created_at ASC
       LIMIT 500`
    )
    .all(req.user.id, otherId, otherId, req.user.id);

  res.json({
    messages: rows.map((m) => ({
      id: m.id,
      from: m.sender_id,
      to: m.recipient_id,
      body: m.body,
      kind: m.kind || 'text',
      at: m.created_at,
      mine: m.sender_id === req.user.id,
    })),
  });
});

module.exports = router;
