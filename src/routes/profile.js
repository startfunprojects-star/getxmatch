'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth');
const { imageUpload } = require('../upload');

const router = express.Router();

function removeUpload(filename) {
  if (!filename) return;
  const p = path.join(config.uploadsDir, path.basename(filename));
  fs.promises.unlink(p).catch(() => {});
}

function buildProfile(userId) {
  const row = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.bio, p.avatar, p.updated_at
       FROM users u JOIN profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .get(userId);
  if (!row) return null;
  const photos = db
    .prepare('SELECT id, filename FROM gallery_photos WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatar: row.avatar ? `/uploads/${row.avatar}` : null,
    gallery: photos.map((ph) => ({ id: ph.id, url: `/uploads/${ph.filename}` })),
    updatedAt: row.updated_at,
  };
}

// GET /api/profile/me  — current user's profile (or 404 if not created yet)
router.get('/me', requireAuth, (req, res) => {
  const profile = buildProfile(req.user.id);
  if (!profile) return res.status(404).json({ error: 'No profile yet.' });
  res.json({ profile });
});

// GET /api/profile/:username — view any user's profile
router.get('/:username', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const profile = buildProfile(user.id);
  if (!profile) return res.status(404).json({ error: 'This user has no profile yet.' });
  res.json({ profile });
});

// PUT /api/profile — create or update display name + bio (+ optional avatar)
router.put('/', requireAuth, imageUpload.single('avatar'), (req, res) => {
  const displayName = (req.body.displayName || '').trim();
  const bio = (req.body.bio || '').trim();

  if (!displayName || displayName.length > 50) {
    removeUpload(req.file && req.file.filename);
    return res.status(400).json({ error: 'Display name is required (max 50 chars).' });
  }
  if (bio.length > 500) {
    removeUpload(req.file && req.file.filename);
    return res.status(400).json({ error: 'Bio must be 500 characters or fewer.' });
  }

  const now = Date.now();
  const existing = db.prepare('SELECT avatar FROM profiles WHERE user_id = ?').get(req.user.id);

  let avatar = existing ? existing.avatar : null;
  if (req.file) {
    if (avatar) removeUpload(avatar); // replace old avatar
    avatar = req.file.filename;
  }

  if (existing) {
    db.prepare(
      'UPDATE profiles SET display_name = ?, bio = ?, avatar = ?, updated_at = ? WHERE user_id = ?'
    ).run(displayName, bio, avatar, now, req.user.id);
  } else {
    db.prepare(
      'INSERT INTO profiles (user_id, display_name, bio, avatar, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, displayName, bio, avatar, now);
  }

  res.json({ profile: buildProfile(req.user.id) });
});

// POST /api/profile/gallery — add a gallery photo
router.post('/gallery', requireAuth, imageUpload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  const hasProfile = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(req.user.id);
  if (!hasProfile) {
    removeUpload(req.file.filename);
    return res.status(400).json({ error: 'Create your profile before adding gallery photos.' });
  }

  const info = db
    .prepare('INSERT INTO gallery_photos (user_id, filename, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, req.file.filename, Date.now());

  res.status(201).json({ photo: { id: info.lastInsertRowid, url: `/uploads/${req.file.filename}` } });
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
