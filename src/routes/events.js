'use strict';

// Recent Events feed — a unified, time-ordered activity stream aggregated from
// real activity across the app plus admin-curated announcements:
//   • user relationships   (new accepted friendships)
//   • recent chats          (conversations that recently happened)
//   • quiz attempts         (quizzes users attempted)
//   • admin events          (curated announcements)
// Each activity row carries the viewer's friendship state with the actor so the
// UI can offer an "Add friend" action inline.

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { friendState } = require('../profileData');

const router = express.Router();

const PER_SOURCE = 40;

function userMini(id, viewerId) {
  const r = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`
    )
    .get(id);
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name || r.username,
    avatar: r.avatar ? `/uploads/${r.avatar}` : null,
    isMe: r.id === viewerId,
    friendState: friendState(r.id, viewerId),
  };
}

// GET /api/events — merged recent activity.
router.get('/', requireAuth, (req, res) => {
  const me = req.user.id;
  const events = [];

  // 1) Accepted friendships (relationships).
  db.prepare(
    `SELECT id, requester_id, addressee_id, created_at
     FROM friendships WHERE status = 'accepted' ORDER BY created_at DESC LIMIT ?`
  ).all(PER_SOURCE).forEach((f) => {
    const a = userMini(f.requester_id, me);
    const b = userMini(f.addressee_id, me);
    if (!a || !b) return;
    events.push({
      id: 'friend-' + f.id,
      type: 'friendship',
      at: f.created_at,
      icon: '🤝',
      actor: a,
      target: b,
      text: `${a.displayName} and ${b.displayName} are now friends`,
    });
  });

  // 2) Recent chats — one event per conversing pair (privacy: no message text).
  db.prepare(
    `SELECT MIN(sender_id, recipient_id) AS u1, MAX(sender_id, recipient_id) AS u2,
            MAX(created_at) AS at, COUNT(*) AS n
     FROM messages
     GROUP BY MIN(sender_id, recipient_id), MAX(sender_id, recipient_id)
     ORDER BY at DESC LIMIT ?`
  ).all(PER_SOURCE).forEach((m) => {
    const a = userMini(m.u1, me);
    const b = userMini(m.u2, me);
    if (!a || !b) return;
    events.push({
      id: `chat-${m.u1}-${m.u2}`,
      type: 'chat',
      at: m.at,
      icon: '💬',
      actor: a,
      target: b,
      text: `${a.displayName} and ${b.displayName} have been chatting (${m.n} message${m.n === 1 ? '' : 's'})`,
    });
  });

  // 3) Quiz attempts.
  db.prepare(
    `SELECT qa.id, qa.user_id, qa.score, qa.total, qa.created_at, q.title
     FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
     ORDER BY qa.created_at DESC LIMIT ?`
  ).all(PER_SOURCE).forEach((qa) => {
    const a = userMini(qa.user_id, me);
    if (!a) return;
    events.push({
      id: 'quiz-' + qa.id,
      type: 'quiz',
      at: qa.created_at,
      icon: '🧠',
      actor: a,
      target: null,
      text: `${a.displayName} attempted the quiz “${qa.title}” and scored ${qa.score}/${qa.total}`,
    });
  });

  // 4) Admin-curated announcements.
  db.prepare('SELECT id, title, body, created_at FROM admin_events ORDER BY created_at DESC LIMIT ?')
    .all(PER_SOURCE)
    .forEach((e) => {
      events.push({
        id: 'admin-' + e.id,
        type: 'admin',
        at: e.created_at,
        icon: '📣',
        actor: null,
        target: null,
        title: e.title,
        text: e.body || e.title,
      });
    });

  events.sort((a, b) => b.at - a.at);
  res.json({ events: events.slice(0, 100) });
});

module.exports = router;
