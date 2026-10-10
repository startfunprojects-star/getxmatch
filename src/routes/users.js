'use strict';

const express = require('express');
const db = require('../db');
const { requireAuth } = require('../auth');
const { getGift } = require('../gifts');
const polls = require('../polls');
const chatQuiz = require('../chatQuiz');
const { areFriends } = require('../profileData');
const { areBlocked } = require('../relations');

// Build the compact quoted-message preview attached to a reply. Mirrors
// replyPreview() in src/socket.js so live and historical replies render alike.
function buildReplyPreview(row) {
  if (!row || !row.reply_to || row.reply_id == null) return null;
  if (row.reply_deleted) return { id: row.reply_id, from: row.reply_sender, kind: 'deleted', text: '🚫 This message was deleted' };
  let text = row.reply_body;
  if (row.reply_kind === 'gift') {
    const g = getGift(row.reply_body);
    text = g ? `${g.emoji} ${g.name}` : 'a gift';
  } else if (row.reply_kind === 'poll') {
    text = polls.pollLabel(polls.pollIdFromBody(row.reply_body));
  } else if (row.reply_kind === 'quiz') {
    text = chatQuiz.quizLabel(chatQuiz.chatQuizIdFromBody(row.reply_body));
  } else if (row.reply_kind === 'voice') {
    text = require('../voiceNotes').label(row.reply_body);
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
         AND p.hidden = 0
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
      // Only friends can chat; the sidebar opens a profile for anyone else.
      isFriend: areFriends(req.user.id, r.id),
    })),
  });
});

// GET /api/users/:id/summary — name and picture for one member, by id. Used when
// a chat message arrives from someone not in the client's people list (that
// list is capped and leaves out hidden profiles), so they never show up as a
// made-up "User 45" with a profile link that goes nowhere.
router.get('/:id/summary', requireAuth, (req, res) => {
  const uid = parseInt(req.params.id, 10);
  if (!uid) return res.status(400).json({ error: 'Invalid user id.' });
  const r = db.prepare(
    `SELECT u.id, u.username, p.display_name, p.avatar
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`
  ).get(uid);
  if (!r) return res.status(404).json({ error: 'User not found.' });
  res.json({
    user: {
      id: r.id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
      isFriend: areFriends(req.user.id, r.id),
    },
  });
});

// GET /api/users/:id/avatars — the pictures to cycle through for this user in
// chat: their profile picture buffer, or just their single display picture if
// the buffer is empty. Returns absolute /uploads URLs.
router.get('/:id/avatars', requireAuth, (req, res) => {
  const uid = parseInt(req.params.id, 10);
  if (!uid) return res.status(400).json({ error: 'Invalid user id.' });

  // The picture buffer has been retired: chat shows the display picture.
  const prof = db.prepare('SELECT avatar FROM profiles WHERE user_id = ?').get(uid);
  const avatar = prof && prof.avatar ? [`/uploads/${prof.avatar}`] : [];
  res.json({ avatars: avatar });
});

// DELETE /api/users/:id/messages — delete this whole chat for me (the other
// person keeps their copy). Files kept in the browser are cleared client-side.
router.delete('/:id/messages', requireAuth, (req, res) => {
  const otherId = parseInt(req.params.id, 10);
  if (!otherId || otherId === req.user.id) return res.status(400).json({ error: 'Invalid user id.' });
  db.prepare(
    `INSERT INTO chat_clears (user_id, peer_id, cleared_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, peer_id) DO UPDATE SET cleared_at = excluded.cleared_at`
  ).run(req.user.id, otherId, Date.now());
  res.json({ ok: true });
});

// POST /api/users/messages/:mid/hide — delete one message for me.
router.post('/messages/:mid/hide', requireAuth, (req, res) => {
  const mid = parseInt(req.params.mid, 10);
  const m = db.prepare('SELECT id FROM messages WHERE id = ? AND (sender_id = ? OR recipient_id = ?)').get(mid, req.user.id, req.user.id);
  if (!m) return res.status(404).json({ error: 'Message not found.' });
  db.prepare('INSERT OR IGNORE INTO message_hides (user_id, message_id) VALUES (?, ?)').run(req.user.id, m.id);
  res.json({ ok: true });
});

// POST /api/users/messages/:mid/unsend — the sender deletes a message for
// everyone: its content is wiped and both sides see "This message was deleted".
router.post('/messages/:mid/unsend', requireAuth, (req, res) => {
  const mid = parseInt(req.params.mid, 10);
  const m = db.prepare('SELECT id, sender_id, recipient_id, kind, body, deleted_at FROM messages WHERE id = ?').get(mid);
  if (!m) return res.status(404).json({ error: 'Message not found.' });
  if (m.sender_id !== req.user.id) return res.status(403).json({ error: 'You can only unsend your own messages.' });
  if (!m.deleted_at) {
    if (m.kind === 'voice') require('../voiceNotes').removeByBody(m.body);
    db.prepare("UPDATE messages SET body = '', deleted_at = ? WHERE id = ?").run(Date.now(), m.id);
    db.prepare('DELETE FROM message_reactions WHERE message_id = ?').run(m.id);
  }
  const { notifyUser } = require('../socket');
  [m.sender_id, m.recipient_id].forEach((uid) => notifyUser(uid, 'chat:unsent', { id: m.id, from: m.sender_id, to: m.recipient_id }));
  res.json({ ok: true });
});

// GET /api/users/:id/messages — text chat history with a given user
router.get('/:id/messages', requireAuth, (req, res) => {
  const otherId = parseInt(req.params.id, 10);
  if (!otherId) return res.status(400).json({ error: 'Invalid user id.' });

  const rows = db
    .prepare(
      `SELECT m.id, m.sender_id, m.recipient_id, m.body, m.kind, m.created_at, m.reply_to, m.delivered_at, m.read_at,
              m.deleted_at, r.id AS reply_id, r.sender_id AS reply_sender, r.body AS reply_body, r.kind AS reply_kind,
              r.deleted_at AS reply_deleted
       FROM messages m
       LEFT JOIN messages r ON r.id = m.reply_to
       WHERE ((m.sender_id = ? AND m.recipient_id = ?)
          OR (m.sender_id = ? AND m.recipient_id = ?))
         AND m.created_at > COALESCE((SELECT cleared_at FROM chat_clears WHERE user_id = ? AND peer_id = ?), 0)
         AND m.id NOT IN (SELECT message_id FROM message_hides WHERE user_id = ?)
       ORDER BY m.created_at DESC
       LIMIT 500`
    )
    .all(req.user.id, otherId, otherId, req.user.id, req.user.id, otherId, req.user.id)
    .reverse(); // the newest 500, oldest first

  // Reactions across this whole conversation, grouped by message.
  const reactionRows = db
    .prepare(
      `SELECT mr.message_id, mr.user_id, mr.emoji
       FROM message_reactions mr
       JOIN messages m ON m.id = mr.message_id
       WHERE (m.sender_id = ? AND m.recipient_id = ?)
          OR (m.sender_id = ? AND m.recipient_id = ?)`
    )
    .all(req.user.id, otherId, otherId, req.user.id);
  const reactionsByMsg = new Map();
  for (const r of reactionRows) {
    if (!reactionsByMsg.has(r.message_id)) reactionsByMsg.set(r.message_id, []);
    reactionsByMsg.get(r.message_id).push({ userId: r.user_id, emoji: r.emoji });
  }

  res.json({
    // One-to-one chat is for friends only (enforced on send in src/socket.js).
    canChat: areFriends(req.user.id, otherId) && !areBlocked(req.user.id, otherId),
    messages: rows.map((m) => ({
      id: m.id,
      from: m.sender_id,
      to: m.recipient_id,
      body: m.deleted_at ? '' : m.body,
      kind: m.deleted_at ? 'deleted' : (m.kind || 'text'),
      at: m.created_at,
      mine: m.sender_id === req.user.id,
      // Tick state of my own messages: sent → delivered → read.
      status: m.read_at ? 'read' : m.delivered_at ? 'delivered' : 'sent',
      replyTo: m.reply_to || null,
      reply: buildReplyPreview(m),
      reactions: reactionsByMsg.get(m.id) || [],
      poll: m.kind === 'poll' ? polls.pollPayload(polls.pollIdFromBody(m.body), req.user.id) : undefined,
      quiz: m.kind === 'quiz' ? chatQuiz.sessionPayload(chatQuiz.chatQuizIdFromBody(m.body), req.user.id) : undefined,
    })),
  });
});

module.exports = router;
