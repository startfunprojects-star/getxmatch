'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { getGift } = require('../gifts');

// Build the compact quoted-message preview attached to a reply. Mirrors
// replyPreview() in src/socket.js so live and historical replies render alike.
function buildReplyPreview(row) {
  if (!row || !row.reply_to || row.reply_id == null) return null;
  let text = row.reply_body;
  if (row.reply_kind === 'gift') {
    const g = getGift(row.reply_body);
    text = g ? `${g.emoji} ${g.name}` : 'a gift';
  } else if (row.reply_kind === 'narration') {
    text = '🎭 Roleplay';
  }
  return { id: row.reply_id, from: row.reply_sender, kind: row.reply_kind || 'text', text: String(text).slice(0, 140) };
}

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
      `SELECT m.id, m.sender_id, m.recipient_id, m.body, m.kind, m.created_at, m.reply_to,
              r.id AS reply_id, r.sender_id AS reply_sender, r.body AS reply_body, r.kind AS reply_kind
       FROM messages m
       LEFT JOIN messages r ON r.id = m.reply_to
       WHERE (m.sender_id = ? AND m.recipient_id = ?)
          OR (m.sender_id = ? AND m.recipient_id = ?)
       ORDER BY m.created_at ASC
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
      replyTo: m.reply_to || null,
      reply: buildReplyPreview(m),
    })),
  });
});

module.exports = router;
