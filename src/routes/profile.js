'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth');
const { imageUpload } = require('../upload');
const { buildProfile } = require('../profileData');
const F = require('../profileFields');

const router = express.Router();

function removeUpload(filename) {
  if (!filename) return;
  const p = path.join(config.uploadsDir, path.basename(filename));
  fs.promises.unlink(p).catch(() => {});
}

// Validate an optional enum field: empty string clears it, a listed value is
// accepted, anything else is rejected. Returns { value } or { error }.
function optionalEnum(raw, allowed, label) {
  const v = (raw == null ? '' : String(raw)).trim();
  if (!v) return { value: null };
  if (!allowed.includes(v)) return { error: `Invalid value for ${label}.` };
  return { value: v };
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
  const fail = (msg) => {
    removeUpload(req.file && req.file.filename);
    return res.status(400).json({ error: msg });
  };

  const b = req.body || {};
  const displayName = (b.displayName || '').trim();
  const about = (b.about || '').trim();

  if (!displayName || displayName.length > 50) {
    return fail('Display name is required (max 50 chars).');
  }
  if (about.length > 500) {
    return fail('About me must be 500 characters or fewer.');
  }

  // --- Mandatory fields: gender, date of birth, country.
  const gender = (b.gender || '').trim();
  if (!F.GENDER.includes(gender)) return fail('Please select your gender.');

  const dob = (b.dateOfBirth || '').trim();
  const age = F.ageFromDob(dob);
  if (age == null) return fail('Please enter a valid date of birth.');
  if (age < F.MIN_AGE) return fail(`You must be at least ${F.MIN_AGE} years old.`);
  if (age > 120) return fail('Please enter a valid date of birth.');

  const country = (b.country || '').trim();
  if (!country || country.length > 60) return fail('Please select your country.');

  // --- Optional enum fields.
  const smokes = optionalEnum(b.smokes, F.YES_NO, 'smoking');
  if (smokes.error) return fail(smokes.error);
  const drinks = optionalEnum(b.drinks, F.YES_NO, 'alcohol');
  if (drinks.error) return fail(drinks.error);
  const diet = optionalEnum(b.diet, F.DIET, 'diet');
  if (diet.error) return fail(diet.error);
  const sexuality = optionalEnum(b.sexuality, F.SEXUALITY, 'sexuality');
  if (sexuality.error) return fail(sexuality.error);
  const bedRole = optionalEnum(b.bedRole, F.BED_ROLE, 'role');
  if (bedRole.error) return fail(bedRole.error);
  const relStatus = optionalEnum(b.relationshipStatus, F.RELATIONSHIP_STATUS, 'relationship status');
  if (relStatus.error) return fail(relStatus.error);

  let friendsVisibility = (b.friendsVisibility || 'public').trim();
  if (!F.FRIENDS_VISIBILITY.includes(friendsVisibility)) friendsVisibility = 'public';

  // --- Interests: JSON array or comma list of allowed values.
  let interests = [];
  const rawInterests = b.interests;
  if (rawInterests) {
    let arr = [];
    if (Array.isArray(rawInterests)) arr = rawInterests;
    else {
      try {
        const parsed = JSON.parse(rawInterests);
        arr = Array.isArray(parsed) ? parsed : String(rawInterests).split(',');
      } catch (_e) {
        arr = String(rawInterests).split(',');
      }
    }
    interests = arr.map((s) => String(s).trim()).filter((s) => F.INTERESTS.includes(s));
    interests = [...new Set(interests)]; // de-dupe, keep order
  }

  // --- Free-text extras.
  const persona = (b.persona || '').trim();
  if (persona.length > 500) return fail('That field must be 500 characters or fewer.');
  const likesInBed = (b.likesInBed || '').trim();
  if (likesInBed.length > 500) return fail('That field must be 500 characters or fewer.');

  // --- Relationship partner (optional): a username to link to. Cannot be self.
  let partnerId = null;
  const partnerUsername = (b.partner || '').trim();
  if (partnerUsername) {
    const partner = db.prepare('SELECT id FROM users WHERE username = ?').get(partnerUsername);
    if (!partner) return fail('The partner username you entered does not exist.');
    if (partner.id === req.user.id) return fail('You cannot list yourself as your partner.');
    partnerId = partner.id;
  }

  const now = Date.now();
  const existing = db.prepare('SELECT avatar FROM profiles WHERE user_id = ?').get(req.user.id);

  let avatar = existing ? existing.avatar : null;
  if (req.file) {
    if (avatar) removeUpload(avatar); // replace old avatar
    avatar = req.file.filename;
  }

  const interestsJson = JSON.stringify(interests);

  if (existing) {
    db.prepare(
      `UPDATE profiles SET
         display_name = ?, bio = ?, avatar = ?,
         gender = ?, date_of_birth = ?, country = ?, smokes = ?, drinks = ?,
         diet = ?, sexuality = ?, interests = ?, persona = ?, likes_in_bed = ?,
         bed_role = ?, relationship_status = ?, partner_user_id = ?,
         friends_visibility = ?, updated_at = ?
       WHERE user_id = ?`
    ).run(
      displayName, about, avatar,
      gender, dob, country, smokes.value, drinks.value,
      diet.value, sexuality.value, interestsJson, persona, likesInBed,
      bedRole.value, relStatus.value, partnerId,
      friendsVisibility, now, req.user.id
    );
  } else {
    db.prepare(
      `INSERT INTO profiles
         (user_id, display_name, bio, avatar, gender, date_of_birth, country,
          smokes, drinks, diet, sexuality, interests, persona, likes_in_bed,
          bed_role, relationship_status, partner_user_id, friends_visibility, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req.user.id, displayName, about, avatar, gender, dob, country,
      smokes.value, drinks.value, diet.value, sexuality.value, interestsJson,
      persona, likesInBed, bedRole.value, relStatus.value, partnerId,
      friendsVisibility, now
    );
  }

  res.json({ profile: buildProfile(req.user.id, req.user.id) });
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
