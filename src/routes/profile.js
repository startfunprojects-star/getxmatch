'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth');
const { imageUpload } = require('../upload');
const { buildProfile } = require('../profileData');
const { saveProfile } = require('../profileWrite');
const F = require('../profileFields');

const router = express.Router();

function removeUpload(filename) {
  if (!filename) return;
  const p = path.join(config.uploadsDir, path.basename(filename));
  fs.promises.unlink(p).catch(() => {});
}

// GET /api/profile/me  — current user's profile (or 404 if not created yet)
router.get('/me', requireAuth, (req, res) => {
  const profile = buildProfile(req.user.id, req.user.id);
  if (!profile) return res.status(404).json({ error: 'No profile yet.' });
  res.json({ profile });
});

// GET /api/profile/:username — view any user's profile
router.get('/:username', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const profile = buildProfile(user.id, req.user.id);
  if (!profile) return res.status(404).json({ error: 'This user has no profile yet.' });
  res.json({ profile });
});

// PUT /api/profile — create or update the profile (+ optional avatar)
router.put('/', requireAuth, imageUpload.single('avatar'), (req, res) => {
  const out = saveProfile(req.user.id, req.body, req.file);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ profile: out.profile });
});

// POST /api/profile/gallery — add a gallery photo (max 25 per user)
router.post('/gallery', requireAuth, imageUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  const hasProfile = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(req.user.id);
  if (!hasProfile) {
    removeUpload(req.file.filename);
    return res.status(400).json({ error: 'Create your profile before adding gallery photos.' });
  }

  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM gallery_photos WHERE user_id = ?')
    .get(req.user.id);
  if (n >= F.MAX_GALLERY_PHOTOS) {
    removeUpload(req.file.filename);
    return res
      .status(400)
      .json({ error: `Your gallery is full (max ${F.MAX_GALLERY_PHOTOS} photos).` });
  }

  const info = db
    .prepare('INSERT INTO gallery_photos (user_id, filename, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, req.file.filename, Date.now());

  res.status(201).json({
    photo: { id: info.lastInsertRowid, url: `/uploads/${req.file.filename}` },
    count: n + 1,
    max: F.MAX_GALLERY_PHOTOS,
  });
});

// DELETE /api/profile/gallery/:id — remove a gallery photo
router.delete('/gallery/:id', requireAuth, (req, res) => {
  const photo = db
    .prepare('SELECT id, filename FROM gallery_photos WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!photo) return res.status(404).json({ error: 'Photo not found.' });

  db.prepare('DELETE FROM gallery_photos WHERE id = ?').run(photo.id);
  removeUpload(photo.filename);
  res.json({ ok: true });
});

/* -------------------------------------------------------------------------
   GIF "feelings" collection — up to 100 animated GIFs per user, with an
   owner-chosen visibility (public | friends | private).
------------------------------------------------------------------------- */

// POST /api/profile/gifs — add a GIF (max 100 per user). GIF files only, so the
// collection stays true to its name (and animation is preserved). An optional
// short caption describes the feeling.
router.post('/gifs', requireAuth, imageUpload.single('gif'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No GIF uploaded.' });

  if (req.file.mimetype !== 'image/gif') {
    removeUpload(req.file.filename);
    return res.status(400).json({ error: 'Only GIF files are allowed here.' });
  }

  const hasProfile = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(req.user.id);
  if (!hasProfile) {
    removeUpload(req.file.filename);
    return res.status(400).json({ error: 'Create your profile before adding GIFs.' });
  }

  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM user_gifs WHERE user_id = ?')
    .get(req.user.id);
  if (n >= F.MAX_GIFS) {
    removeUpload(req.file.filename);
    return res
      .status(400)
      .json({ error: `Your GIF collection is full (max ${F.MAX_GIFS} GIFs).` });
  }

  const caption = String(req.body.caption || '').trim().slice(0, 80);
  const info = db
    .prepare('INSERT INTO user_gifs (user_id, filename, caption, created_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, req.file.filename, caption, Date.now());

  res.status(201).json({
    gif: { id: info.lastInsertRowid, url: `/uploads/${req.file.filename}`, caption },
    count: n + 1,
    max: F.MAX_GIFS,
  });
});

// DELETE /api/profile/gifs/:id — remove a GIF from the collection
router.delete('/gifs/:id', requireAuth, (req, res) => {
  const gif = db
    .prepare('SELECT id, filename FROM user_gifs WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!gif) return res.status(404).json({ error: 'GIF not found.' });

  db.prepare('DELETE FROM user_gifs WHERE id = ?').run(gif.id);
  removeUpload(gif.filename);
  res.json({ ok: true });
});

// PUT /api/profile/gifs/visibility — set who may see the GIF collection
router.put('/gifs/visibility', requireAuth, (req, res) => {
  const visibility = String((req.body && req.body.visibility) || '').trim();
  if (!F.GIF_VISIBILITY.includes(visibility)) {
    return res.status(400).json({ error: 'Invalid visibility.' });
  }
  const hasProfile = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(req.user.id);
  if (!hasProfile) return res.status(400).json({ error: 'Create your profile first.' });

  db.prepare('UPDATE profiles SET gif_visibility = ? WHERE user_id = ?').run(visibility, req.user.id);
  res.json({ ok: true, visibility });
});

// POST /api/profile/buffer — add an image to the profile picture buffer (max 10)
router.post('/buffer', requireAuth, imageUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  const hasProfile = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(req.user.id);
  if (!hasProfile) {
    removeUpload(req.file.filename);
    return res.status(400).json({ error: 'Create your profile before adding buffer pictures.' });
  }

  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM profile_buffer_photos WHERE user_id = ?')
    .get(req.user.id);
  if (n >= F.MAX_BUFFER_PHOTOS) {
    removeUpload(req.file.filename);
    return res
      .status(400)
      .json({ error: `Your profile picture buffer is full (max ${F.MAX_BUFFER_PHOTOS} pictures).` });
  }

  const info = db
    .prepare('INSERT INTO profile_buffer_photos (user_id, filename, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, req.file.filename, Date.now());

  res.status(201).json({
    photo: { id: info.lastInsertRowid, url: `/uploads/${req.file.filename}` },
    count: n + 1,
    max: F.MAX_BUFFER_PHOTOS,
  });
});

// DELETE /api/profile/buffer/:id — remove a buffer picture
router.delete('/buffer/:id', requireAuth, (req, res) => {
  const photo = db
    .prepare('SELECT id, filename FROM profile_buffer_photos WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!photo) return res.status(404).json({ error: 'Picture not found.' });

  db.prepare('DELETE FROM profile_buffer_photos WHERE id = ?').run(photo.id);
  removeUpload(photo.filename);
  res.json({ ok: true });
});

module.exports = router;
