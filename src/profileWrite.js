'use strict';

const fs = require('fs');
const path = require('path');

const db = require('./db');
const config = require('./config');
const { buildProfile } = require('./profileData');
const F = require('./profileFields');

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

// Validate `body` and create/update the profile for `userId`. `file` is the
// optional uploaded avatar (a multer file). On failure the upload is cleaned
// up and { error } is returned; on success { profile } is returned. Shared by
// the member-facing PUT /api/profile and the admin profile editor so both
// enforce identical rules — the only difference is which user is written.
function saveProfile(userId, body, file) {
  const fail = (msg) => {
    removeUpload(file && file.filename);
    return { error: msg };
  };

  const b = body || {};
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
  if (age < F.MIN_AGE) return fail(`User must be at least ${F.MIN_AGE} years old.`);
  if (age > 120) return fail('Please enter a valid date of birth.');

  const country = (b.country || '').trim();
  if (!country || country.length > 60) return fail('Please select a country.');

  // Weight, smoking, alcohol, diet, sexuality, "what kind of person", the
  // intimacy fields and the partner link are no longer part of the profile:
  // they aren't collected, shown or returned by the API. Values saved before
  // are left untouched in the database.

  // --- Optional enum fields.
  const relStatus = optionalEnum(b.relationshipStatus, F.RELATIONSHIP_STATUS, 'relationship status');
  if (relStatus.error) return fail(relStatus.error);

  let friendsVisibility = (b.friendsVisibility || 'public').trim();
  if (!F.FRIENDS_VISIBILITY.includes(friendsVisibility)) friendsVisibility = 'public';

  // --- Hide from search: when set, the profile is excluded from browse/search
  // results. The member editor always sends '1' or '0'; when the field is
  // absent (e.g. the admin editor doesn't render it) keep the current value so
  // an unrelated edit never silently unhides someone.
  let hidden;
  if (b.hidden == null || String(b.hidden).trim() === '') {
    const cur = db.prepare('SELECT hidden FROM profiles WHERE user_id = ?').get(userId);
    hidden = cur ? cur.hidden : 0;
  } else {
    hidden = ['1', 'true', 'on', 'yes'].includes(String(b.hidden).trim().toLowerCase()) ? 1 : 0;
  }

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

  const now = Date.now();
  const existing = db.prepare('SELECT avatar FROM profiles WHERE user_id = ?').get(userId);

  let avatar = existing ? existing.avatar : null;
  if (file) {
    if (avatar) removeUpload(avatar); // replace old avatar
    avatar = file.filename;
  }

  const interestsJson = JSON.stringify(interests);

  if (existing) {
    db.prepare(
      `UPDATE profiles SET
         display_name = ?, bio = ?, avatar = ?,
         gender = ?, date_of_birth = ?, country = ?, interests = ?,
         relationship_status = ?, friends_visibility = ?, hidden = ?, updated_at = ?
       WHERE user_id = ?`
    ).run(
      displayName, about, avatar,
      gender, dob, country, interestsJson,
      relStatus.value, friendsVisibility, hidden, now, userId
    );
  } else {
    db.prepare(
      `INSERT INTO profiles
         (user_id, display_name, bio, avatar, gender, date_of_birth, country, interests,
          relationship_status, friends_visibility, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId, displayName, about, avatar, gender, dob, country, interestsJson,
      relStatus.value, friendsVisibility, hidden, now
    );
  }

  return { profile: buildProfile(userId, userId) };
}

module.exports = { saveProfile };
