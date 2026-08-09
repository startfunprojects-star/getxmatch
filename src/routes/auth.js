'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../auth');

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

// POST /api/auth/signup
router.post('/signup', authLimiter, (req, res) => {
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

  const existing = db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .get(username, email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'That username or email is already taken.' });
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(username, email.toLowerCase(), passwordHash, now);

  const user = { id: info.lastInsertRowid, username, email: email.toLowerCase() };
  const token = signToken(user);
  setAuthCookie(res, token);

  // hasProfile=false → client will send them to create their profile.
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
