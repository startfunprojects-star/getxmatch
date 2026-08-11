'use strict';

// Profile discussions. Any visitor may open a discussion ABOUT a profile. The
// profile owner sees every discussion on their profile, can like/dislike them,
// and can delete any of them at any time. Authors may delete their own. These
// discussions also surface on the Recent Events feed.

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { friendState } = require('../profileData');

const router = express.Router();

function resolveTarget(req, res) {
  const target = db
    .prepare(
      `SELECT u.id, u.username FROM users u
       JOIN profiles p ON p.user_id = u.id WHERE u.username = ?`
    )
    .get(req.params.username);
  if (!target) {
    res.status(404).json({ error: 'User not found.' });
    return null;
  }
  return target;
}

// Shape a single discussion row for the client, tailored to the viewer.
function discussionPayload(id, viewerId) {
  const d = db
    .prepare(
      `SELECT d.id, d.subject_id, d.author_id, d.title, d.body, d.created_at,
              au.username AS a_username, ap.display_name AS a_display, ap.avatar AS a_avatar,
              su.username AS s_username, sp.display_name AS s_display
       FROM discussions d
       JOIN users au ON au.id = d.author_id
       LEFT JOIN profiles ap ON ap.user_id = d.author_id
       JOIN users su ON su.id = d.subject_id
       LEFT JOIN profiles sp ON sp.user_id = d.subject_id
       WHERE d.id = ?`
    )
    .get(id);
  if (!d) return null;

  const likes = db.prepare('SELECT COUNT(*) AS n FROM discussion_reactions WHERE discussion_id = ? AND value = 1').get(id).n;
  const dislikes = db.prepare('SELECT COUNT(*) AS n FROM discussion_reactions WHERE discussion_id = ? AND value = -1').get(id).n;
  const mineRow = viewerId
    ? db.prepare('SELECT value FROM discussion_reactions WHERE discussion_id = ? AND user_id = ?').get(id, viewerId)
    : null;

  return {
    id: d.id,
    title: d.title,
    body: d.body,
    at: d.created_at,
    subject: { id: d.subject_id, username: d.s_username, displayName: d.s_display || d.s_username },
    author: {
      id: d.author_id,
      username: d.a_username,
      displayName: d.a_display || d.a_username,
      avatar: d.a_avatar ? `/uploads/${d.a_avatar}` : null,
    },
    likes,
    dislikes,
    myReaction: mineRow ? mineRow.value : 0,
    // The profile owner may delete any discussion; authors may delete their own.
    canDelete: viewerId === d.subject_id || viewerId === d.author_id,
    isOwner: viewerId === d.subject_id,
    friendState: friendState(d.author_id, viewerId),
  };
}

// GET /api/discuss/:username — all discussions on this profile.
router.get('/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  const ids = db
    .prepare('SELECT id FROM discussions WHERE subject_id = ? ORDER BY created_at DESC LIMIT 200')
    .all(target.id);
  res.json({ discussions: ids.map((r) => discussionPayload(r.id, req.user.id)) });
});

// POST /api/discuss/:username  { title, body } — open a discussion.
router.post('/:username', requireAuth, (req, res) => {
  const target = resolveTarget(req, res);
  if (!target) return;
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot open a discussion on your own profile.' });
  }
  const title = ((req.body && req.body.title) || '').trim().slice(0, 120);
  const body = ((req.body && req.body.body) || '').trim();
  if (!body) return res.status(400).json({ error: 'Discussion text cannot be empty.' });
  if (body.length > 2000) return res.status(400).json({ error: 'Discussion must be 2000 characters or fewer.' });

  const info = db
    .prepare('INSERT INTO discussions (subject_id, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(target.id, req.user.id, title, body, Date.now());

  res.status(201).json({ discussion: discussionPayload(info.lastInsertRowid, req.user.id) });
});

// POST /api/discuss/:id/react  { value: 1 | -1 } — like/dislike (toggle off if
// the same value is sent again).
router.post('/:id/react', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const discussion = db.prepare('SELECT id FROM discussions WHERE id = ?').get(id);
  if (!discussion) return res.status(404).json({ error: 'Discussion not found.' });

  const value = parseInt(req.body && req.body.value, 10);
  if (value !== 1 && value !== -1) return res.status(400).json({ error: 'Invalid reaction.' });

  const existing = db.prepare('SELECT value FROM discussion_reactions WHERE discussion_id = ? AND user_id = ?').get(id, req.user.id);
  if (existing && existing.value === value) {
    db.prepare('DELETE FROM discussion_reactions WHERE discussion_id = ? AND user_id = ?').run(id, req.user.id);
  } else {
    db.prepare(
      `INSERT INTO discussion_reactions (discussion_id, user_id, value, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(discussion_id, user_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at`
    ).run(id, req.user.id, value, Date.now());
  }

  res.json({ discussion: discussionPayload(id, req.user.id) });
});

// DELETE /api/discuss/:id — profile owner (any time) or the author.
router.delete('/:id', requireAuth, (req, res) => {
  const d = db.prepare('SELECT id, subject_id, author_id FROM discussions WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Discussion not found.' });
  if (d.subject_id !== req.user.id && d.author_id !== req.user.id) {
    return res.status(403).json({ error: 'You cannot delete this discussion.' });
  }
  db.prepare('DELETE FROM discussions WHERE id = ?').run(d.id);
  res.json({ ok: true });
});

module.exports = router;
