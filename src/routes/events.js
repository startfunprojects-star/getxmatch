'use strict';

// Recent Events feed — a unified, time-ordered activity stream aggregated from
// real activity across the app plus admin-curated announcements:
//   • user relationships   (new accepted friendships)
//   • recent chats          (conversations that recently happened)
//   • quiz attempts         (quizzes users attempted)
//   • admin events          (curated announcements)
// Each activity row carries the viewer's friendship state with the actor so the
// UI can offer an "Add friend" action inline.

const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth');
const { friendState } = require('../profileData');
const { imageUpload } = require('../upload');
const { broadcastActivity } = require('../socket');
const { recentStream } = require('../activityStream');
const { acceptedText, sentText, relEmoji } = require('../relationships');

const router = express.Router();

const PER_SOURCE = 40;
const ACTIVITY_IMG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap for shared activity images

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

// Pick an emoji that suits the activity verb, so fake rows blend in visually.
function activityIcon(activity) {
  const a = String(activity).toLowerCase();
  if (/(chat|messag|talk)/.test(a)) return '💬';
  if (/(flirt|crush|love|kiss)/.test(a)) return '😍';
  if (/(match|paired|connect)/.test(a)) return '💘';
  if (/(rat|star|review)/.test(a)) return '⭐';
  if (/(gift|sent)/.test(a)) return '🎁';
  if (/(view|check|look|profile)/.test(a)) return '👀';
  if (/(friend|follow)/.test(a)) return '🤝';
  return '✨';
}

// GET /api/events/public — a PUBLIC, no-auth activity feed for the sign-in page.
// Same feed the signed-in Recent Activity shows, but with the user-shared image
// posts omitted (no thumbnails on the sign-in page). Built with a null viewer.
router.get('/public', (req, res) => {
  res.json({ events: buildFeed(null, { includeImages: false }) });
});

// POST /api/events/activity-image — share an image/GIF onto the Recent Activity
// feed. Saved to disk and shown to everyone as a thumbnail (live + on reload).
router.post('/activity-image', requireAuth, imageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
  // Hard 5 MB cap for activity images, regardless of the global upload limit.
  if (req.file.size > ACTIVITY_IMG_MAX_BYTES) {
    fs.promises.unlink(path.join(config.uploadsDir, req.file.filename)).catch(() => {});
    return res.status(413).json({ error: 'Image must be 5 MB or smaller.' });
  }
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO activity_posts (user_id, image, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, req.file.filename, now);

  const actor = userMini(req.user.id, req.user.id);
  const url = `/uploads/${req.file.filename}`;
  const event = {
    id: 'post-' + info.lastInsertRowid,
    type: 'activity-image',
    at: now,
    icon: '🖼️',
    actor,
    target: null,
    text: `${actor ? actor.displayName : 'Someone'} shared an image`,
    image: url,
  };
  // Stream it live onto everyone's open feeds as a thumbnail.
  broadcastActivity({ at: now, icon: '🖼️', text: event.text, image: url });
  res.status(201).json({ event });
});

// Build the merged Recent Activity feed for `viewerId` (null = public / logged
// out). `includeImages` gates the user-shared image posts — excluded from the
// public sign-in feed so it never shows thumbnails. Actor/target metadata is
// attached but the feed renders plain text, so a null viewer is fine.
function buildFeed(viewerId, opts) {
  const me = viewerId;
  const includeImages = !opts || opts.includeImages !== false;
  const events = [];

  // 1) Accepted relationships (friend, crush, couple, …).
  db.prepare(
    `SELECT id, requester_id, addressee_id, rel_type, created_at
     FROM friendships WHERE status = 'accepted' ORDER BY created_at DESC LIMIT ?`
  ).all(PER_SOURCE).forEach((f) => {
    const a = userMini(f.requester_id, me);
    const b = userMini(f.addressee_id, me);
    if (!a || !b) return;
    const type = f.rel_type || 'friend';
    events.push({
      id: 'friend-' + f.id,
      type: 'friendship',
      at: f.created_at,
      icon: relEmoji(type),
      actor: a,
      target: b,
      text: acceptedText(type, a.displayName, b.displayName),
    });
  });

  // 1b) Pending relationship requests that were sent (so a sent request shows on
  //     Recent Activity until it's accepted, declined or cancelled).
  db.prepare(
    `SELECT id, requester_id, addressee_id, rel_type, created_at
     FROM friendships WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`
  ).all(PER_SOURCE).forEach((f) => {
    const a = userMini(f.requester_id, me);
    const b = userMini(f.addressee_id, me);
    if (!a || !b) return;
    const type = f.rel_type || 'friend';
    events.push({
      id: 'req-' + f.id,
      type: 'request',
      at: f.created_at,
      icon: relEmoji(type),
      actor: a,
      target: b,
      text: sentText(type, a.displayName, b.displayName),
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

  // 3b) User-declared chat activity ("A flirting with B") — real users.
  db.prepare(
    'SELECT user_id, peer_id, activity, updated_at FROM chat_activities ORDER BY updated_at DESC LIMIT ?'
  ).all(PER_SOURCE).forEach((row) => {
    const a = userMini(row.user_id, me);
    const b = userMini(row.peer_id, me);
    if (!a || !b) return;
    events.push({
      id: `activity-${row.user_id}-${row.peer_id}`,
      type: 'chat-activity',
      at: row.updated_at,
      icon: activityIcon(row.activity),
      actor: a,
      target: b,
      text: `${a.displayName} ${row.activity} ${b.displayName}`,
    });
  });

  // 3c) User-shared images/GIFs — displayed as a thumbnail in the feed. Omitted
  //     from the public sign-in feed (no thumbnails there).
  if (includeImages) {
    db.prepare(
      'SELECT id, user_id, image, created_at FROM activity_posts ORDER BY created_at DESC LIMIT ?'
    ).all(PER_SOURCE).forEach((row) => {
      const a = userMini(row.user_id, me);
      if (!a) return;
      events.push({
        id: 'post-' + row.id,
        type: 'activity-image',
        at: row.created_at,
        icon: '🖼️',
        actor: a,
        target: null,
        text: `${a.displayName} shared an image`,
        image: `/uploads/${row.image}`,
      });
    });
  }

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

  // 5) The shared, server-generated activity stream (same rows for every user,
  //    generated continuously in the background). No actor/target, so their
  //    names are never clickable.
  recentStream(PER_SOURCE).forEach((f) => events.push(f));

  events.sort((a, b) => b.at - a.at);
  return events.slice(0, 100);
}

// GET /api/events — merged recent activity for the signed-in user.
router.get('/', requireAuth, (req, res) => {
  res.json({ events: buildFeed(req.user.id) });
});

module.exports = router;
