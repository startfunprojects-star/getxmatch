'use strict';

// Referrals. Every member has a fixed, unchangeable referral code (generated
// once, stored on users.referral_code). A new member who signs up with a code
// is linked to the referrer via users.referred_by, which earns points on the
// leaderboard: the referrer gets WEIGHTS.referrer per member referred and the
// new member gets WEIGHTS.referred once (see src/points.js).

const crypto = require('crypto');
const db = require('./db');
const { getSetting, setSetting } = require('./settings');

// Admin master switch. When off, no Refer button/code is shown, referral links
// don't prefill sign-up and codes are ignored. Points already earned remain.
const ENABLED_KEY = 'referrals_enabled';
function enabled() { return getSetting(ENABLED_KEY, '1') !== '0'; }
function setEnabled(on) { setSetting(ENABLED_KEY, on ? '1' : '0'); }

// No 0/O/1/I so codes are easy to read aloud and type.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const CODE_RE = /^[A-Z0-9]{4,16}$/;

function randomCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

// Return the user's referral code, creating it on first use. Codes never change.
function ensureCode(userId) {
  const row = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId);
  if (!row) return null;
  if (row.referral_code) return row.referral_code;
  for (;;) {
    const code = randomCode();
    const taken = db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(code);
    if (taken) continue;
    db.prepare('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL').run(code, userId);
    return db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId).referral_code;
  }
}

// Normalise a code typed by a person (trim, upper-case). '' when blank.
function normalize(raw) {
  return String(raw == null ? '' : raw).trim().toUpperCase();
}

// The user id owning `code`, or null.
function referrerId(code) {
  const c = normalize(code);
  if (!CODE_RE.test(c)) return null;
  const row = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(c);
  return row ? row.id : null;
}

// Link a freshly created user to the owner of `code` (if valid).
function applyReferral(newUserId, code) {
  if (!enabled()) return false;
  const refId = referrerId(code);
  if (!refId || refId === newUserId) return false;
  db.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL').run(refId, newUserId);
  return true;
}

// Give every existing member a code (run once at startup; cheap afterwards).
function backfill() {
  db.prepare('SELECT id FROM users WHERE referral_code IS NULL').all().forEach((r) => ensureCode(r.id));
}

// Admin overview: totals and the top referrers.
function stats() {
  return {
    enabled: enabled(),
    totalReferred: db.prepare('SELECT COUNT(*) AS n FROM users WHERE referred_by IS NOT NULL').get().n,
    top: db.prepare(
      `SELECT u.id, u.username, p.display_name, u.referral_code, COUNT(r.id) AS referrals
         FROM users u
         JOIN users r ON r.referred_by = u.id
         LEFT JOIN profiles p ON p.user_id = u.id
        GROUP BY u.id ORDER BY referrals DESC, u.username LIMIT 50`
    ).all(),
  };
}

module.exports = { enabled, setEnabled, stats, ensureCode, normalize, referrerId, applyReferral, backfill };
