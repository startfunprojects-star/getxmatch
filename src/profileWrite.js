'use strict';

const fs = require('fs');
const path = require('path');

const db = require('./db');
const config = require('./config');
const { buildProfile } = require('./profileData');
const F = require('./profileFields');
const geo = require('./geo');

function removeUpload(filename) {
  if (!filename) return;
  const p = path.join(config.uploadsDir, path.basename(filename));
  fs.promises.unlink(p).catch(() => {});
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
  if (age > 120) return fail('Please enter a valid date of birth.');

  const country = (b.country || '').trim();
  if (!country || country.length > 60) return fail('Please select a country.');

  // --- Optional state + city. The state must be one listed for the country;
  // the city may be a listed one or a name the member typed. When the fields
  // are absent (the admin editor doesn't render them) keep the saved values,
  // unless the country changed, which makes them stale.
  const cur = db.prepare('SELECT country, state, city FROM profiles WHERE user_id = ?').get(userId);
  let state = null;
  let city = null;
  if (b.state == null && b.city == null) {
    if (cur && cur.country === country) { state = cur.state; city = cur.city; }
  } else {
    state = String(b.state || '').trim() || null;
    if (state && !geo.states(country).includes(state)) return fail('Please select a valid state.');
    city = String(b.city || '').trim().replace(/\s+/g, ' ') || null;
    if (city && !state) return fail('Please select a state before the city.');
    if (city && city.length > 80) return fail('City name must be 80 characters or fewer.');
  }

  // Weight, smoking, alcohol, sexuality, "what kind of person", the intimacy
  // fields and the partner link are no longer part of the profile; their
  // columns are dropped at startup (migrateRemoveAdultFeatures in src/db.js).

  // --- Academic background (required; chosen at signup, kept on the users
  // row). A field the form leaves out keeps its saved value.
  const curUser = db.prepare('SELECT education, education_stream, work_status FROM users WHERE id = ?').get(userId) || {};
  const pick = (raw, allowed, saved, msg) => {
    const v = raw == null ? saved : String(raw).trim();
    return allowed.includes(v) ? { value: v } : { error: msg };
  };
  const education = pick(b.education, F.EDUCATION, curUser.education, 'Please select your minimum education.');
  if (education.error) return fail(education.error);
  const educationStream = pick(b.educationStream, F.EDUCATION_STREAM, curUser.education_stream, 'Please select your education stream.');
  if (educationStream.error) return fail(educationStream.error);
  const workStatus = pick(b.workStatus, F.WORK_STATUS, curUser.work_status, 'Please select your working status.');
  if (workStatus.error) return fail(workStatus.error);

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
    interests = [...new Set(interests)]; // de-dupe, keep order (no cap on how many)
  }

  const now = Date.now();
  const existing = db.prepare('SELECT avatar FROM profiles WHERE user_id = ?').get(userId);

  let avatar = existing ? existing.avatar : null;
  // "Remove picture" in the editor (only when no new picture was chosen).
  if (!file && String(b.removeAvatar || '') === '1' && avatar) {
    removeUpload(avatar);
    avatar = null;
  }
  if (file) {
    if (avatar) removeUpload(avatar); // replace old avatar
    avatar = file.filename;
  }

  const interestsJson = JSON.stringify(interests);

  db.prepare('UPDATE users SET education = ?, education_stream = ?, work_status = ? WHERE id = ?')
    .run(education.value, educationStream.value, workStatus.value, userId);

  if (existing) {
    db.prepare(
      `UPDATE profiles SET
         display_name = ?, bio = ?, avatar = ?,
         gender = ?, date_of_birth = ?, country = ?, state = ?, city = ?, interests = ?,
         friends_visibility = ?, hidden = ?, updated_at = ?
       WHERE user_id = ?`
    ).run(
      displayName, about, avatar,
      gender, dob, country, state, city, interestsJson,
      friendsVisibility, hidden, now, userId
    );
  } else {
    db.prepare(
      `INSERT INTO profiles
         (user_id, display_name, bio, avatar, gender, date_of_birth, country, state, city, interests,
          friends_visibility, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId, displayName, about, avatar, gender, dob, country, state, city, interestsJson,
      friendsVisibility, hidden, now
    );
  }

  return { profile: buildProfile(userId, userId) };
}

module.exports = { saveProfile };
