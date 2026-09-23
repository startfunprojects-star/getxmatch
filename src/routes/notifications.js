'use strict';

// The member's Notifications section:
//   - compatibility results: someone completed a quiz link the member shared,
//     or the member completed someone else's link (stored rows, see
//     addMatchNotifications), each with the compatibility score;
//   - new quizzes and polls published since the member's previous login
//     (computed live from created_at).
// "Unread" = anything newer than when the member last opened the section.

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');

const router = express.Router();

const NEW_CONTENT_LIMIT = 20;
const MATCH_LIMIT = 50;
// Members who haven't logged in since login times were recorded: treat the
// last two weeks as "new".
const FALLBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}

// Record a completed compatibility link for both sides. Called by the match
// router once the responder finishes. `b` is null for a guest responder.
function addMatchNotifications({ m, quizTitle, bUserId, bName, result, sharerPoints, responderPoints }) {
  const now = Date.now();
  const base = { token: m.token, quizTitle, percent: result.percent, score: result.score, total: result.total };
  const insert = db.prepare('INSERT INTO notifications (user_id, kind, data, created_at) VALUES (?, ?, ?, ?)');
  if (m.a_user_id) {
    insert.run(m.a_user_id, 'match_shared', JSON.stringify({ ...base, otherName: bName, otherUserId: bUserId, points: sharerPoints }), now);
  }
  if (bUserId) {
    insert.run(bUserId, 'match_answered', JSON.stringify({ ...base, otherName: m.a_name, otherUserId: m.a_user_id, points: responderPoints }), now);
  }
}

// When "new since your last login" starts for this member.
function newSince(u) {
  if (u.prev_login_at) return u.prev_login_at;
  return Math.max(u.created_at || 0, Date.now() - FALLBACK_WINDOW_MS);
}

function usernameOf(id) {
  if (!id) return null;
  const r = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
  return r ? r.username : null;
}

function buildItems(userId) {
  const u = db.prepare('SELECT id, created_at, prev_login_at, notif_read_at FROM users WHERE id = ?').get(userId);
  const since = newSince(u);
  const items = [];

  db.prepare('SELECT id, kind, data, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, MATCH_LIMIT)
    .forEach((n) => {
      const d = parseJson(n.data, {});
      items.push({
        id: 'n' + n.id,
        kind: n.kind, // match_shared | match_answered
        at: n.created_at,
        quizTitle: d.quizTitle,
        otherName: d.otherName || 'Someone',
        otherUsername: usernameOf(d.otherUserId),
        percent: d.percent,
        score: d.score,
        total: d.total,
        points: d.points || 0,
        link: `/m/${d.token}`,
      });
    });

  db.prepare('SELECT id, title, created_at FROM quizzes WHERE created_at > ? ORDER BY created_at DESC LIMIT ?')
    .all(since, NEW_CONTENT_LIMIT)
    .forEach((q) => items.push({ id: 'q' + q.id, kind: 'new_quiz', at: q.created_at, title: q.title, link: `/quizzes/${q.id}` }));
  db.prepare('SELECT id, question, created_at FROM polls WHERE created_at > ? ORDER BY created_at DESC LIMIT ?')
    .all(since, NEW_CONTENT_LIMIT)
    .forEach((p) => items.push({ id: 'p' + p.id, kind: 'new_poll', at: p.created_at, title: p.question, link: `/polls/${p.id}` }));

  items.sort((a, b) => b.at - a.at);
  const readAt = u.notif_read_at || 0;
  items.forEach((it) => { it.unread = it.at > readAt; });
  return { items, unread: items.filter((it) => it.unread).length, since };
}

// GET /api/notifications — the list, newest first, with unread flags.
router.get('/', requireAuth, (req, res) => {
  res.json(buildItems(req.user.id));
});

// GET /api/notifications/count — just the unread count (for the nav badge).
router.get('/count', requireAuth, (req, res) => {
  res.json({ unread: buildItems(req.user.id).unread });
});

// POST /api/notifications/read — mark everything up to now as read.
router.post('/read', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET notif_read_at = ? WHERE id = ?').run(Date.now(), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
module.exports.addMatchNotifications = addMatchNotifications;
