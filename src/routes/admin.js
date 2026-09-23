'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const config = require('../config');
const { sendAdminResetLink } = require('../mail');
const { isOnline } = require('../socket');
const { rankedUsers } = require('../points');
const { QUIZ_TYPES } = require('../quizTypes');
const { imageUpload } = require('../upload');
const { buildProfile } = require('../profileData');
const { saveProfile } = require('../profileWrite');
const { getSiteSeo, setSiteSeo } = require('../settings');
const seo = require('../seo');
const ads = require('../ads');
const hw = require('../highway');
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
  // Don't reveal the admin address anywhere client-facing; just confirm.
  res.json({ ok: true });
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

  // Always seed a minimal profile so the account is browsable and its name
  // resolves everywhere. Without a profile row the user is excluded from the
  // people list and leaderboard (both inner-join profiles) and shows up as a
  // "user<id>" fallback in chats. Default the display name to the username when
  // the admin didn't provide one.
  const dn = (displayName || '').trim();
  const profileName = (dn || username).slice(0, 50);
  db.prepare(
    'INSERT INTO profiles (user_id, display_name, bio, avatar, updated_at) VALUES (?, ?, \'\', NULL, ?)'
  ).run(info.lastInsertRowid, profileName, now);

  res.status(201).json({
    user: { id: info.lastInsertRowid, username, email: null, displayName: profileName },
  });
});

// GET /api/admin/users/:id/profile — a user's profile for the admin editor
// (or profile: null if they haven't got one yet).
router.get('/users/:id/profile', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  // Build it as if the owner is viewing, so every field is populated.
  const profile = buildProfile(id, id);
  res.json({ username: user.username, profile: profile || null });
});

// PUT /api/admin/users/:id/profile — create or update a user's profile on
// their behalf (same rules as the member-facing editor, minus the email).
router.put('/users/:id/profile', requireAdmin, imageUpload.single('avatar'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) { removeUpload(req.file && req.file.filename); return res.status(404).json({ error: 'User not found.' }); }
  const out = saveProfile(id, req.body, req.file);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json({ profile: out.profile });
});

// DELETE /api/admin/users/:id — remove a user (cascades to their data).
router.delete('/users/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid user id.' });
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'User not found.' });
  res.json({ ok: true });
});

/* ===========================================================================
   Content management (admin only): quizzes, polls, blogs, events.
=========================================================================== */

function parseJson(raw, fallback) {
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return raw;
  try { const v = JSON.parse(raw); return v == null ? fallback : v; } catch (_e) { return fallback; }
}

function removeUpload(filename) {
  if (!filename) return;
  fs.promises.unlink(path.join(config.uploadsDir, path.basename(filename))).catch(() => {});
}

// A URL-friendly slug from arbitrary text.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// On-page SEO fields shared by quizzes, polls and blogs, with per-field length
// caps. Text fields plus two boolean robots flags.
const SEO_FIELDS = {
  metaTitle: 70,
  metaDescription: 320,
  slug: 80,
  focusKeyword: 80,
  metaKeywords: 300,
  canonicalUrl: 500,
  ogTitle: 100,
  ogDescription: 320,
  ogImage: 500,
  ogType: 40,
  twitterCard: 40,
  twitterTitle: 100,
  twitterDescription: 320,
  twitterImage: 500,
};

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';

// Validate + normalise the posted SEO object (may be a JSON string from a
// multipart form). Falls back to a slug derived from `fallbackTitle`.
function normalizeSeo(raw, fallbackTitle) {
  const o = parseJson(raw, {}) || {};
  const out = {};
  for (const [key, max] of Object.entries(SEO_FIELDS)) {
    out[key] = (o[key] == null ? '' : String(o[key])).trim().slice(0, max);
  }
  out.slug = slugify(out.slug || fallbackTitle);
  out.noindex = truthy(o.noindex);
  out.nofollow = truthy(o.nofollow);
  return JSON.stringify(out);
}

// Validate + normalise a quiz's questions array. Returns { value } or { error }.
// Compatibility quizzes have no "correct" option — every question is a prompt,
// the choices two people can match on, the points it's worth and its time limit.
function normalizeQuestions(raw) {
  const arr = parseJson(raw, null);
  if (!Array.isArray(arr) || arr.length === 0) return { error: 'A quiz needs at least one question.' };
  const out = [];
  for (const q of arr) {
    const prompt = (q && typeof q.prompt === 'string' ? q.prompt : '').trim();
    const options = Array.isArray(q && q.options)
      ? q.options.map((o) => String(o).trim()).filter(Boolean)
      : [];
    if (!prompt) return { error: 'Every question needs a prompt.' };
    if (options.length < 2) return { error: 'Every question needs at least two options.' };
    // Points a member earns for answering within the time limit, and the time
    // limit in seconds (0 = untimed).
    const points = Number(q.points == null || q.points === '' ? 0 : q.points);
    if (!Number.isInteger(points) || points < 0 || points > 1000) {
      return { error: 'Points for each question must be a whole number from 0 to 1000.' };
    }
    const seconds = Number(q.seconds == null || q.seconds === '' ? 0 : q.seconds);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600 || (seconds > 0 && seconds < 5)) {
      return { error: 'Time for each question must be 0 (no limit) or 5 to 3600 seconds.' };
    }
    out.push({ prompt: prompt.slice(0, 300), options: options.slice(0, 8), points, seconds });
  }
  return { value: out };
}

/* ---------------- Quizzes ---------------- */

function normalizeType(raw) {
  const t = String(raw || 'compatibility');
  return QUIZ_TYPES[t] ? { value: t } : { error: 'Unknown quiz type.' };
}

// Negative marking: points deducted for each question left unanswered when its
// time runs out (0 = none). Returns { value } or { error }.
function normalizeNegative(raw) {
  const n = Number(raw == null || raw === '' ? 0 : raw);
  if (!Number.isInteger(n) || n < 0 || n > 1000) {
    return { error: 'Negative marking must be a whole number from 0 to 1000.' };
  }
  return { value: n };
}

// GET /api/admin/quizzes — full quizzes including correct answers.
router.get('/quizzes', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, title, description, questions, negative_marks, type, seo, created_at, updated_at FROM quizzes ORDER BY created_at DESC').all();
  res.json({
    quizzes: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      questions: parseJson(r.questions, []),
      negativeMarks: r.negative_marks || 0,
      type: r.type,
      seo: parseJson(r.seo, {}),
      attempts: db.prepare('SELECT COUNT(*) AS n FROM quiz_attempts WHERE quiz_id = ?').get(r.id).n,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

// POST /api/admin/quizzes
router.post('/quizzes', requireAdmin, (req, res) => {
  const title = ((req.body && req.body.title) || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const description = ((req.body && req.body.description) || '').trim().slice(0, 500);
  const q = normalizeQuestions(req.body && req.body.questions);
  if (q.error) return res.status(400).json({ error: q.error });
  const neg = normalizeNegative(req.body && req.body.negativeMarks);
  if (neg.error) return res.status(400).json({ error: neg.error });
  const type = normalizeType(req.body && req.body.type);
  if (type.error) return res.status(400).json({ error: type.error });

  const seo = normalizeSeo(req.body && req.body.seo, title);
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO quizzes (title, description, questions, negative_marks, type, seo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(title.slice(0, 150), description, JSON.stringify(q.value), neg.value, type.value, seo, now, now);
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/admin/quizzes/:id
router.put('/quizzes/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Quiz not found.' });
  const title = ((req.body && req.body.title) || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const description = ((req.body && req.body.description) || '').trim().slice(0, 500);
  const q = normalizeQuestions(req.body && req.body.questions);
  if (q.error) return res.status(400).json({ error: q.error });
  const neg = normalizeNegative(req.body && req.body.negativeMarks);
  if (neg.error) return res.status(400).json({ error: neg.error });
  const type = normalizeType(req.body && req.body.type);
  if (type.error) return res.status(400).json({ error: type.error });

  const seo = normalizeSeo(req.body && req.body.seo, title);
  db.prepare('UPDATE quizzes SET title = ?, description = ?, questions = ?, negative_marks = ?, type = ?, seo = ?, updated_at = ? WHERE id = ?')
    .run(title.slice(0, 150), description, JSON.stringify(q.value), neg.value, type.value, seo, Date.now(), row.id);
  res.json({ ok: true });
});

// DELETE /api/admin/quizzes/:id
router.delete('/quizzes/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM quizzes WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Quiz not found.' });
  res.json({ ok: true });
});

/* ---------------- Polls ---------------- */

function normalizeOptions(raw) {
  const arr = parseJson(raw, null);
  if (!Array.isArray(arr)) return { error: 'Options must be a list.' };
  const opts = arr.map((o) => String(o).trim()).filter(Boolean).slice(0, 10);
  if (opts.length < 2) return { error: 'A poll needs at least two options.' };
  return { value: opts };
}

// GET /api/admin/polls
router.get('/polls', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, question, options, closed, seo, created_at FROM polls ORDER BY created_at DESC').all();
  res.json({
    polls: rows.map((r) => ({
      id: r.id,
      question: r.question,
      options: parseJson(r.options, []),
      closed: !!r.closed,
      seo: parseJson(r.seo, {}),
      votes: db.prepare('SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?').get(r.id).n,
      createdAt: r.created_at,
    })),
  });
});

// POST /api/admin/polls
router.post('/polls', requireAdmin, (req, res) => {
  const question = ((req.body && req.body.question) || '').trim();
  if (!question) return res.status(400).json({ error: 'Question is required.' });
  const o = normalizeOptions(req.body && req.body.options);
  if (o.error) return res.status(400).json({ error: o.error });

  const seo = normalizeSeo(req.body && req.body.seo, question);
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO polls (question, options, closed, seo, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)'
  ).run(question.slice(0, 300), JSON.stringify(o.value), seo, now, now);
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/admin/polls/:id
router.put('/polls/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM polls WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Poll not found.' });
  const question = ((req.body && req.body.question) || '').trim();
  if (!question) return res.status(400).json({ error: 'Question is required.' });
  const o = normalizeOptions(req.body && req.body.options);
  if (o.error) return res.status(400).json({ error: o.error });
  const closed = req.body && (req.body.closed === true || req.body.closed === 'true' || req.body.closed === 1) ? 1 : 0;

  const seo = normalizeSeo(req.body && req.body.seo, question);
  db.prepare('UPDATE polls SET question = ?, options = ?, closed = ?, seo = ?, updated_at = ? WHERE id = ?')
    .run(question.slice(0, 300), JSON.stringify(o.value), closed, seo, Date.now(), row.id);
  res.json({ ok: true });
});

// DELETE /api/admin/polls/:id
router.delete('/polls/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM polls WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Poll not found.' });
  res.json({ ok: true });
});

/* ---------------- Blogs ---------------- */

// GET /api/admin/blogs
router.get('/blogs', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, title, author, excerpt, body, cover, seo, created_at, updated_at FROM blogs ORDER BY created_at DESC').all();
  res.json({
    blogs: rows.map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      excerpt: r.excerpt,
      body: r.body,
      cover: r.cover ? `/uploads/${r.cover}` : null,
      seo: parseJson(r.seo, {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

// POST /api/admin/blogs  (multipart, optional cover)
router.post('/blogs', requireAdmin, imageUpload.single('cover'), (req, res) => {
  const title = ((req.body && req.body.title) || '').trim();
  if (!title) { removeUpload(req.file && req.file.filename); return res.status(400).json({ error: 'Title is required.' }); }
  const body = ((req.body && req.body.body) || '').trim();
  if (!body) { removeUpload(req.file && req.file.filename); return res.status(400).json({ error: 'Body is required.' }); }
  const author = ((req.body && req.body.author) || 'getxmatch').trim().slice(0, 80) || 'getxmatch';
  const excerpt = ((req.body && req.body.excerpt) || body.slice(0, 160)).trim().slice(0, 300);

  const seo = normalizeSeo(req.body && req.body.seo, title);
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO blogs (title, author, excerpt, body, cover, seo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(title.slice(0, 200), author, excerpt, body, req.file ? req.file.filename : null, seo, now, now);
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/admin/blogs/:id  (multipart, optional new cover)
router.put('/blogs/:id', requireAdmin, imageUpload.single('cover'), (req, res) => {
  const row = db.prepare('SELECT id, cover FROM blogs WHERE id = ?').get(req.params.id);
  if (!row) { removeUpload(req.file && req.file.filename); return res.status(404).json({ error: 'Blog post not found.' }); }
  const title = ((req.body && req.body.title) || '').trim();
  if (!title) { removeUpload(req.file && req.file.filename); return res.status(400).json({ error: 'Title is required.' }); }
  const body = ((req.body && req.body.body) || '').trim();
  if (!body) { removeUpload(req.file && req.file.filename); return res.status(400).json({ error: 'Body is required.' }); }
  const author = ((req.body && req.body.author) || 'getxmatch').trim().slice(0, 80) || 'getxmatch';
  const excerpt = ((req.body && req.body.excerpt) || body.slice(0, 160)).trim().slice(0, 300);

  let cover = row.cover;
  if (req.file) {
    if (cover) removeUpload(cover);
    cover = req.file.filename;
  }
  const seo = normalizeSeo(req.body && req.body.seo, title);
  db.prepare('UPDATE blogs SET title = ?, author = ?, excerpt = ?, body = ?, cover = ?, seo = ?, updated_at = ? WHERE id = ?')
    .run(title.slice(0, 200), author, excerpt, body, cover, seo, Date.now(), row.id);
  res.json({ ok: true });
});

// DELETE /api/admin/blogs/:id
router.delete('/blogs/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id, cover FROM blogs WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Blog post not found.' });
  db.prepare('DELETE FROM blogs WHERE id = ?').run(row.id);
  removeUpload(row.cover);
  res.json({ ok: true });
});

/* ---------------- Recent Events (admin-curated announcements) ---------------- */

// GET /api/admin/events
router.get('/events', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, title, body, created_at, updated_at FROM admin_events ORDER BY created_at DESC').all();
  res.json({ events: rows.map((r) => ({ id: r.id, title: r.title, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at })) });
});

// POST /api/admin/events
router.post('/events', requireAdmin, (req, res) => {
  const title = ((req.body && req.body.title) || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const body = ((req.body && req.body.body) || '').trim().slice(0, 2000);
  const now = Date.now();
  const info = db.prepare('INSERT INTO admin_events (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(title.slice(0, 200), body, now, now);
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/admin/events/:id
router.put('/events/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM admin_events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Event not found.' });
  const title = ((req.body && req.body.title) || '').trim();
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const body = ((req.body && req.body.body) || '').trim().slice(0, 2000);
  db.prepare('UPDATE admin_events SET title = ?, body = ?, updated_at = ? WHERE id = ?')
    .run(title.slice(0, 200), body, Date.now(), row.id);
  res.json({ ok: true });
});

// DELETE /api/admin/events/:id
router.delete('/events/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM admin_events WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Event not found.' });
  res.json({ ok: true });
});

/* ---------------- Leaderboard (read-only view for admins) ---------------- */

// GET /api/admin/leaderboard — same ranking users see, for oversight.
router.get('/leaderboard', requireAdmin, (req, res) => {
  res.json({ leaderboard: rankedUsers() });
});

/* ===========================================================================
   Site-wide on-page SEO (admin only).

   Controls the title, description and social-share cards for the WHOLE app —
   i.e. what Google, Facebook, Instagram, Reddit, WhatsApp and Twitter/X show
   when a getxmatch.com link is shared. These platforms read three standard tag
   families: the page title + meta description (Google), Open Graph (Facebook,
   Instagram, Reddit, WhatsApp, LinkedIn, Slack) and Twitter Cards (Twitter/X) —
   so this one settings blob drives all of them. Applied on the landing page and
   as the site-wide default for every crawlable page (see src/seo.js).
=========================================================================== */

// Field set + per-field length caps for the site-wide SEO blob.
const SITE_SEO_FIELDS = {
  siteName: 60,
  metaTitle: 70,
  metaDescription: 320,
  metaKeywords: 300,
  canonicalUrl: 500,
  themeColor: 24,
  ogTitle: 100,
  ogDescription: 320,
  ogImage: 500,
  ogType: 40,
  twitterCard: 40,
  twitterSite: 40,
  twitterCreator: 40,
  twitterTitle: 100,
  twitterDescription: 320,
  twitterImage: 500,
  facebookAppId: 40,
};

// Clean the Organization/social-profile links (Facebook, Instagram, Twitter,
// Reddit, …) into an array of absolute http(s) URLs. Accepts a JSON array or a
// comma/newline-separated string.
function normalizeSocialLinks(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    arr = parseJson(raw, null);
    if (!Array.isArray(arr)) arr = raw.split(/[\n,]+/);
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const u = String(item == null ? '' : item).trim().slice(0, 300);
    if (/^https?:\/\/\S+$/i.test(u)) out.push(u);
    if (out.length >= 12) break;
  }
  return out;
}

// Validate + normalise the posted site-wide SEO object. The payload arrives as a
// JSON string in the `seo` field (multipart, so an OG image can ride along).
function normalizeSiteSeo(body) {
  const o = parseJson(body && body.seo, null) || {};
  const out = {};
  for (const [key, max] of Object.entries(SITE_SEO_FIELDS)) {
    out[key] = (o[key] == null ? '' : String(o[key])).trim().slice(0, max);
  }
  out.noindex = truthy(o.noindex);
  out.nofollow = truthy(o.nofollow);
  out.socialLinks = normalizeSocialLinks(o.socialLinks);
  return out;
}

// GET /api/admin/site-seo — current settings, the brand defaults each field
// falls back to, and the public base URL (for building the live share preview).
router.get('/site-seo', requireAdmin, (req, res) => {
  res.json({
    seo: getSiteSeo(),
    defaults: {
      siteName: seo.SITE_NAME,
      metaTitle: seo.DEFAULT_HOME_TITLE,
      metaDescription: seo.SITE_TAGLINE,
      ogImage: seo.SITE_OG_IMAGE,
      ogType: 'website',
      twitterCard: 'summary_large_image',
      themeColor: '#0f1117',
    },
    publicUrl: config.publicUrl,
  });
});

// PUT /api/admin/site-seo — save settings. An optional OG/share image can be
// uploaded (field `ogImageFile`); it replaces the ogImage URL and any previously
// uploaded share image is cleaned up.
router.put('/site-seo', requireAdmin, imageUpload.single('ogImageFile'), (req, res) => {
  const prev = getSiteSeo();
  const out = normalizeSiteSeo(req.body);
  if (req.file) out.ogImage = '/uploads/' + req.file.filename;

  // If the share image changed and the old one was an uploaded file, remove it.
  const oldImg = String(prev.ogImage || '');
  if (oldImg !== out.ogImage && /^\/uploads\//.test(oldImg)) {
    removeUpload(oldImg.slice('/uploads/'.length));
  }

  setSiteSeo(out);
  res.json({ ok: true, seo: out });
});

/* ===========================================================================
   Advertisements (admin only): CRUD + click analytics.
=========================================================================== */

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 4096) : null;
}

// Shape an ad row for the admin UI (includes the raw script so it can be edited).
function adForAdmin(r) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    placement: r.placement,
    image: r.image ? `/uploads/${r.image}` : null,
    link: r.link || '',
    script: r.script || '',
    width: r.width || null,
    height: r.height || null,
    active: !!r.active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/admin/ads — every ad + the placement catalog + click analytics.
router.get('/ads', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM ads ORDER BY created_at DESC').all();
  res.json({
    ads: rows.map(adForAdmin),
    placements: ads.PLACEMENTS,
    stats: ads.stats(),
  });
});

// Validate a posted ad. Returns { value } or { error }.
function normalizeAd(body, file, existing) {
  const name = String((body && body.name) || '').trim().slice(0, 120);
  if (!name) return { error: 'A name is required.' };
  const type = (body && body.type) === 'script' ? 'script' : 'image';
  const placement = String((body && body.placement) || '').trim();
  if (!ads.isPlacement(placement)) return { error: 'Choose a valid placement.' };
  const active = (body && (body.active === undefined ? true : truthy(body.active))) ? 1 : 0;

  if (type === 'script') {
    const script = String((body && body.script) || '').trim();
    if (!script) return { error: 'Paste the ad HTML/script code.' };
    return { value: { name, type, placement, image: null, link: null, script: script.slice(0, 20000), width: intOrNull(body.width), height: intOrNull(body.height), active } };
  }
  // image ad
  const image = file ? file.filename : (existing ? existing.image : null);
  if (!image) return { error: 'Upload an image for this ad.' };
  const link = String((body && body.link) || '').trim().slice(0, 500);
  return { value: { name, type, placement, image, link: link || null, script: null, width: intOrNull(body.width), height: intOrNull(body.height), active } };
}

// POST /api/admin/ads  (multipart: optional image)
router.post('/ads', requireAdmin, imageUpload.single('image'), (req, res) => {
  const norm = normalizeAd(req.body, req.file, null);
  if (norm.error) { removeUpload(req.file && req.file.filename); return res.status(400).json({ error: norm.error }); }
  const a = norm.value;
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO ads (name, type, placement, image, link, script, width, height, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(a.name, a.type, a.placement, a.image, a.link, a.script, a.width, a.height, a.active, now, now);
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/admin/ads/:id  (multipart: optional replacement image)
router.put('/ads/:id', requireAdmin, imageUpload.single('image'), (req, res) => {
  const existing = db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.id);
  if (!existing) { removeUpload(req.file && req.file.filename); return res.status(404).json({ error: 'Ad not found.' }); }
  const norm = normalizeAd(req.body, req.file, existing);
  if (norm.error) { removeUpload(req.file && req.file.filename); return res.status(400).json({ error: norm.error }); }
  const a = norm.value;
  // When a new image was uploaded (or the type switched away from image), drop
  // the old file.
  if (existing.image && existing.image !== a.image) removeUpload(existing.image);
  db.prepare(
    'UPDATE ads SET name = ?, type = ?, placement = ?, image = ?, link = ?, script = ?, width = ?, height = ?, active = ?, updated_at = ? WHERE id = ?'
  ).run(a.name, a.type, a.placement, a.image, a.link, a.script, a.width, a.height, a.active, Date.now(), existing.id);
  res.json({ ok: true });
});

// DELETE /api/admin/ads/:id
router.delete('/ads/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id, image FROM ads WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ad not found.' });
  db.prepare('DELETE FROM ads WHERE id = ?').run(row.id); // cascades ad_clicks
  removeUpload(row.image);
  res.json({ ok: true });
});

/* ===========================================================================
   Highway moderation (admin only): delete any post, pin to positions 1–10.
=========================================================================== */

// GET /api/admin/highway — every post in display order, for moderation.
router.get('/highway', requireAdmin, (req, res) => {
  res.json({
    posts: hw.allOrdered().map((r) => ({
      id: r.id,
      body: r.body || '',
      image: r.image ? `/uploads/${r.image}` : null,
      author: { username: r.username, displayName: r.display_name || r.username },
      pinned: !!r.pinned,
      pinRank: r.pinned ? (r.pin_rank || null) : null,
      createdAt: r.created_at,
    })),
    maxPin: 10,
  });
});

// DELETE /api/admin/highway/:id — remove any post.
router.delete('/highway/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id, image FROM highway_posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Post not found.' });
  db.prepare('DELETE FROM highway_posts WHERE id = ?').run(row.id);
  removeUpload(row.image);
  res.json({ ok: true });
});

// POST /api/admin/highway/:id/pin  { rank } — pin to position 1–10, or rank 0
// (or empty) to unpin.
router.post('/highway/:id/pin', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM highway_posts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Post not found.' });
  const rank = parseInt(req.body && req.body.rank, 10);
  if (!rank || rank < 1) {
    db.prepare('UPDATE highway_posts SET pinned = 0, pin_rank = NULL WHERE id = ?').run(row.id);
    return res.json({ ok: true, pinned: false });
  }
  const r = Math.min(10, rank);
  db.prepare('UPDATE highway_posts SET pinned = 1, pin_rank = ? WHERE id = ?').run(r, row.id);
  res.json({ ok: true, pinned: true, pinRank: r });
});

module.exports = router;
