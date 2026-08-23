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

  // --- Mandatory: body weight (kg). Drives the "Wasted" score in chat.
  const weight = Math.round(Number(b.weight));
  if (!Number.isFinite(weight) || weight < F.MIN_WEIGHT || weight > F.MAX_WEIGHT) {
    return fail(`Please enter a valid weight between ${F.MIN_WEIGHT} and ${F.MAX_WEIGHT} kg.`);
  }

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
    if (!partner) return fail('The partner username entered does not exist.');
    if (partner.id === userId) return fail('A user cannot be listed as their own partner.');
    partnerId = partner.id;
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
         gender = ?, date_of_birth = ?, country = ?, weight = ?, smokes = ?, drinks = ?,
         diet = ?, sexuality = ?, interests = ?, persona = ?, likes_in_bed = ?,
         bed_role = ?, relationship_status = ?, partner_user_id = ?,
         friends_visibility = ?, updated_at = ?
       WHERE user_id = ?`
    ).run(
      displayName, about, avatar,
      gender, dob, country, weight, smokes.value, drinks.value,
      diet.value, sexuality.value, interestsJson, persona, likesInBed,
      bedRole.value, relStatus.value, partnerId,
      friendsVisibility, now, userId
    );
  } else {
    db.prepare(
      `INSERT INTO profiles
         (user_id, display_name, bio, avatar, gender, date_of_birth, country, weight,
          smokes, drinks, diet, sexuality, interests, persona, likes_in_bed,
          bed_role, relationship_status, partner_user_id, friends_visibility, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId, displayName, about, avatar, gender, dob, country, weight,
      smokes.value, drinks.value, diet.value, sexuality.value, interestsJson,
      persona, likesInBed, bedRole.value, relStatus.value, partnerId,
      friendsVisibility, now
    );
  }

  return { profile: buildProfile(userId, userId) };
}

module.exports = { saveProfile };
