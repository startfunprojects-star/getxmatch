'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const config = require('../config');
const { sendAdminResetLink } = require('../mail');
const { isOnline } = require('../socket');
const {
  ADMIN_COOKIE,
  signAdminToken,
  setAdminCookie,
  clearAdminCookie,
  requireAdmin,
} = require('../auth');

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function getAdmin() {
  return db.prepare('SELECT id, email, password_hash FROM admin_account WHERE id = 1').get();
}

/* ---------------------------------------------------------------------------
   Password set/reset via a rotating, single-use emailed link.
--------------------------------------------------------------------------- */

// POST /api/admin/request-reset — email a fresh link to the admin address.
// Every call clears prior tokens, so the previous link stops working.
router.post('/request-reset', adminLimiter, async (req, res) => {
  const admin = getAdmin();
  const rawToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  db.prepare('DELETE FROM admin_reset_tokens').run();
  db.prepare(
    'INSERT INTO admin_reset_tokens (token_hash, expires_at, used, created_at) VALUES (?, ?, 0, ?)'
  ).run(sha256(rawToken), now + config.adminResetTtlMs, now);

  const url = `${config.publicUrl}/admin/reset?token=${rawToken}`;
  try {
    await sendAdminResetLink(url);
  } catch (e) {
    return res.status(502).json({ error: 'Could not send the email. Please try again.' });
  }
  // Don't reveal the admin address; just confirm it was sent.
  res.json({ ok: true, sentTo: admin.email });
});

// GET /api/admin/reset/valid?token=... — is this link still usable?
router.get('/reset/valid', (req, res) => {
  const token = req.query.token || '';
  const row = db.prepare('SELECT expires_at, used FROM admin_reset_tokens WHERE token_hash = ?')
    .get(sha256(String(token)));
  const valid = !!row && row.used === 0 && Date.now() <= row.expires_at;
  res.json({ valid });
});

// POST /api/admin/reset — consume the link and set the admin password.
router.post('/reset', adminLimiter, (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 8) {
    return res.status(400).json({ error: 'A valid link and a password of at least 8 characters are required.' });
  }
  const row = db.prepare('SELECT token_hash, expires_at, used FROM admin_reset_tokens WHERE token_hash = ?')
    .get(sha256(String(token)));
  if (!row || row.used === 1 || Date.now() > row.expires_at) {
    return res.status(400).json({ error: 'This link is invalid or has expired. Request a new one.' });
  }

  db.prepare('UPDATE admin_account SET password_hash = ?, updated_at = ? WHERE id = 1')
    .run(bcrypt.hashSync(password, 12), Date.now());
  // Single-use: clear all tokens so this and any other link stop working.
  db.prepare('DELETE FROM admin_reset_tokens').run();

  res.json({ ok: true });
});

/* ---------------------------------------------------------------------------
   Admin session
--------------------------------------------------------------------------- */

// POST /api/admin/login
router.post('/login', adminLimiter, (req, res) => {
  const { password } = req.body || {};
  const admin = getAdmin();
  if (!admin.password_hash) {
    return res.status(403).json({ error: 'No admin password set yet. Use the emailed link to set one.' });
  }
  if (!password || !bcrypt.compareSync(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  setAdminCookie(res, signAdminToken());
  res.json({ ok: true });
});

// POST /api/admin/logout
router.post('/logout', (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

// GET /api/admin/me — session check + whether a password has been set.
router.get('/me', (req, res) => {
  const admin = getAdmin();
  const token = req.cookies ? req.cookies[ADMIN_COOKIE] : null;
  let authenticated = false;
  try {
    authenticated = jwt.verify(token, config.jwtSecret).role === 'admin';
  } catch (_e) { authenticated = false; }
  res.json({ authenticated, hasPassword: !!admin.password_hash });
});

/* ---------------------------------------------------------------------------
   User management (admin only)
--------------------------------------------------------------------------- */

// GET /api/admin/users — every user, with online status and profile info.
router.get('/users', requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.username, u.email, u.created_at,
            p.display_name, p.avatar
     FROM users u
     LEFT JOIN profiles p ON p.user_id = u.id
     ORDER BY u.created_at DESC`
  ).all();

  res.json({
    users: rows.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email || null,
      displayName: r.display_name || null,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
      hasProfile: !!r.display_name,
      online: isOnline(r.id),
      createdAt: r.created_at,
    })),
  });
});

// POST /api/admin/users — create a user with no email (admin sets password).
router.post('/users', requireAdmin, (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers, or underscores.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const clash = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (clash) return res.status(409).json({ error: 'That username is already taken.' });

  const now = Date.now();
  const info = db
    .prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?, NULL, ?, ?)')
    .run(username, bcrypt.hashSync(password, 12), now);

  // Optionally seed a minimal profile so the account is browsable right away.
  const dn = (displayName || '').trim();
  if (dn) {
    db.prepare(
      'INSERT INTO profiles (user_id, display_name, bio, avatar, updated_at) VALUES (?, ?, \'\', NULL, ?)'
    ).run(info.lastInsertRowid, dn.slice(0, 50), now);
  }

  res.status(201).json({
    user: { id: info.lastInsertRowid, username, email: null, displayName: dn || null },
  });
});

// DELETE /api/admin/users/:id — remove a user (cascades to their data).
router.delete('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid user id.' });
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

module.exports = router;
