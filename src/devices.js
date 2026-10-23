'use strict';

// Multi-account checks. Every browser gets a long-lived random device cookie.
// Each signed-in request records (member, device); two members seen on the
// same device become linked accounts. Points that linked accounts give each
// other (ratings, friends, follows, likes, quiz links, referrals, challenges)
// don't count (src/points.js), and they can't take each other's challenges.
// Signup is capped per device and per network (IP) too, see signupBlock().

const crypto = require('crypto');
const config = require('./config');
const db = require('./db');
const { canonicalEmail, isDisposableEmail } = require('./emailCanon');

const DEVICE_COOKIE = 'gxm_dev';
const DEVICE_RE = /^[a-f0-9]{32}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Express middleware: make sure the browser has a device id (req.deviceId).
function deviceCookie(req, res, next) {
  let id = req.cookies ? req.cookies[DEVICE_COOKIE] : null;
  if (!id || !DEVICE_RE.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    res.cookie(DEVICE_COOKIE, id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProd,
      maxAge: 2 * 365 * DAY_MS,
    });
  }
  req.deviceId = id;
  next();
}

// Recording is throttled: once per member + device every 10 minutes.
const RECORD_EVERY_MS = 10 * 60 * 1000;
const recent = new Map();

function recordDevice(userId, deviceId, ip) {
  if (!userId || !deviceId || !DEVICE_RE.test(deviceId)) return;
  const key = userId + ':' + deviceId;
  const now = Date.now();
  if (now - (recent.get(key) || 0) < RECORD_EVERY_MS) return;
  if (recent.size > 50000) recent.clear();
  recent.set(key, now);
  db.prepare(
    `INSERT INTO user_devices (user_id, device_id, ip, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET ip = excluded.ip, last_seen = excluded.last_seen`
  ).run(userId, deviceId, ip || null, now, now);
  // Link this member with everyone else seen on the device.
  const others = db
    .prepare('SELECT user_id FROM user_devices WHERE device_id = ? AND user_id != ?')
    .all(deviceId, userId);
  const link = db.prepare('INSERT OR IGNORE INTO linked_accounts (a_id, b_id, created_at) VALUES (?, ?, ?)');
  for (const o of others) {
    link.run(userId, o.user_id, now);
    link.run(o.user_id, userId, now);
  }
}

function areLinked(a, b) {
  if (!a || !b || a === b) return false;
  return !!db.prepare('SELECT 1 FROM linked_accounts WHERE a_id = ? AND b_id = ?').get(a, b);
}

// Why a new account can't be opened with this email from this device and IP,
// or null if it can.
function signupBlock(email, deviceId, ip) {
  if (isDisposableEmail(email)) {
    return 'Please sign up with your own email address — temporary inboxes aren’t accepted.';
  }
  const canon = canonicalEmail(email);
  if (db.prepare('SELECT 1 FROM users WHERE email_canon = ? LIMIT 1').get(canon)) {
    return 'An account already uses this email address (or another form of it).';
  }
  const now = Date.now();
  if (deviceId) {
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM users WHERE signup_device = ? AND created_at > ?')
      .get(deviceId, now - 30 * DAY_MS).n;
    if (n >= config.signupMaxPerDevice) {
      return 'Too many accounts have been created on this device recently. Please sign in to your existing account.';
    }
  }
  if (ip) {
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM users WHERE signup_ip = ? AND created_at > ?')
      .get(ip, now - DAY_MS).n;
    if (n >= config.signupMaxPerIpDay) {
      return 'Too many accounts have been created from this network today. Please try again tomorrow.';
    }
  }
  return null;
}

module.exports = { DEVICE_COOKIE, deviceCookie, recordDevice, areLinked, signupBlock, canonicalEmail };
