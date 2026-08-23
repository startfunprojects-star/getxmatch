'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const config = require('../config');
const { sendSignupOtp } = require('../mail');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../auth');
const wasted = require('../wasted');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user) {
  return { id: user.id, username: user.username, email: user.email };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// POST /api/auth/signup/start — validate details, email a 6-digit OTP, and
// stash the pending signup. No user row is created until the code is verified.
router.post('/signup/start', authLimiter, async (req, res) => {
  const { username, email, password, ageConfirmed } = req.body || {};

  if (!ageConfirmed) {
    return res.status(400).json({ error: 'You must confirm you are 18 or older.' });
  }
  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-20 letters, numbers, or underscores.' });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const emailLc = email.toLowerCase();
  const existing = db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .get(username, emailLc);
  if (existing) {
    return res.status(409).json({ error: 'That username or email is already taken.' });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  const passwordHash = bcrypt.hashSync(password, 12);

  // Upsert the pending signup for this email (replaces any prior attempt).
  db.prepare(
    `INSERT INTO email_otps (email, username, password_hash, code_hash, attempts, expires_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       username = excluded.username,
       password_hash = excluded.password_hash,
       code_hash = excluded.code_hash,
       attempts = 0,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`
  ).run(emailLc, username, passwordHash, sha256(code), now + config.otpTtlMs, now);

  try {
    await sendSignupOtp(emailLc, code);
  } catch (e) {
    return res.status(502).json({ error: 'Could not send the verification email. Please try again.' });
  }

  res.json({ ok: true, email: emailLc });
});

// POST /api/auth/signup/verify — check the OTP, then create the account.
router.post('/signup/verify', authLimiter, (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code are required.' });
  }
  const emailLc = String(email).toLowerCase();

  const pending = db.prepare('SELECT * FROM email_otps WHERE email = ?').get(emailLc);
  if (!pending) {
    return res.status(400).json({ error: 'No pending verification. Please start again.' });
  }
  if (Date.now() > pending.expires_at) {
    db.prepare('DELETE FROM email_otps WHERE email = ?').run(emailLc);
    return res.status(400).json({ error: 'The code has expired. Please start again.' });
  }
  if (pending.attempts >= config.otpMaxAttempts) {
    db.prepare('DELETE FROM email_otps WHERE email = ?').run(emailLc);
    return res.status(429).json({ error: 'Too many incorrect attempts. Please start again.' });
  }
  if (sha256(String(code)) !== pending.code_hash) {
    db.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE email = ?').run(emailLc);
    const left = config.otpMaxAttempts - (pending.attempts + 1);
    return res.status(400).json({ error: `Incorrect code.${left > 0 ? ` ${left} attempt(s) left.` : ''}` });
  }

  // Guard against a race where the username/email was taken meanwhile.
  const taken = db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .get(pending.username, emailLc);
  if (taken) {
    db.prepare('DELETE FROM email_otps WHERE email = ?').run(emailLc);
    return res.status(409).json({ error: 'That username or email is already taken.' });
  }

  const now = Date.now();
  const info = db
    .prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(pending.username, emailLc, pending.password_hash, now);
  db.prepare('DELETE FROM email_otps WHERE email = ?').run(emailLc);

  const user = { id: info.lastInsertRowid, username: pending.username, email: emailLc };
  setAuthCookie(res, signToken(user));

  res.status(201).json({ user: publicUser(user), hasProfile: false });
});

// POST /api/auth/login
router.post('/login', authLimiter, (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Username/email and password are required.' });
  }

  const user = db
    .prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .get(identifier, identifier.toLowerCase());

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const token = signToken(user);
  setAuthCookie(res, token);

  // A fresh login sobers the user up in every conversation.
  wasted.resetForUser(user.id);

  const profile = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(user.id);
  res.json({ user: publicUser(user), hasProfile: !!profile });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const profile = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(req.user.id);
  res.json({ user: publicUser(req.user), hasProfile: !!profile });
});

module.exports = router;
