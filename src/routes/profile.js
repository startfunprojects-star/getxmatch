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

module.exports = router;
