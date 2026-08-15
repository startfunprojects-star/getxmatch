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
const { imageUpload } = require('../upload');
const { buildProfile } = require('../profileData');
const { saveProfile } = require('../profileWrite');
const { isFakeActivityEnabled, setFakeActivityEnabled } = require('../settings');
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
// Compatibility quizzes have no "correct" option — every question is just a
// prompt plus the choices two people can match on.
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
    out.push({ prompt: prompt.slice(0, 300), options: options.slice(0, 8) });
  }
  return { value: out };
}

/* ---------------- Quizzes ---------------- */

// GET /api/admin/quizzes — full quizzes including correct answers.
router.get('/quizzes', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, title, description, questions, seo, created_at, updated_at FROM quizzes ORDER BY created_at DESC').all();
  res.json({
    quizzes: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      questions: parseJson(r.questions, []),
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

  const seo = normalizeSeo(req.body && req.body.seo, title);
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO quizzes (title, description, questions, seo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title.slice(0, 150), description, JSON.stringify(q.value), seo, now, now);
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

  const seo = normalizeSeo(req.body && req.body.seo, title);
  db.prepare('UPDATE quizzes SET title = ?, description = ?, questions = ?, seo = ?, updated_at = ? WHERE id = ?')
    .run(title.slice(0, 150), description, JSON.stringify(q.value), seo, Date.now(), row.id);
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

/* ---------------- Fake activity (recent-activity filler) ---------------- */

// GET /api/admin/fake-activities
router.get('/fake-activities', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, person_a, activity, person_b, created_at FROM fake_activities ORDER BY created_at DESC').all();
  res.json({
    enabled: isFakeActivityEnabled(),
    activities: rows.map((r) => ({
      id: r.id,
      personA: r.person_a,
      activity: r.activity,
      personB: r.person_b,
      createdAt: r.created_at,
    })),
  });
});

// POST /api/admin/fake-activities/settings  { enabled } — global on/off toggle.
// (Distinct path from the :id routes below, so no route conflict.)
router.post('/fake-activities/settings', requireAdmin, (req, res) => {
  const enabled = !!(req.body && (req.body.enabled === true || req.body.enabled === 'true' || req.body.enabled === 1 || req.body.enabled === '1'));
  setFakeActivityEnabled(enabled);
  res.json({ enabled });
});

// POST /api/admin/fake-activities  { personA, activity, personB }
router.post('/fake-activities', requireAdmin, (req, res) => {
  const personA = ((req.body && req.body.personA) || '').trim().slice(0, 60);
  const activity = ((req.body && req.body.activity) || '').trim().slice(0, 60); // optional
  const personB = ((req.body && req.body.personB) || '').trim().slice(0, 60);
  if (!personA || !personB) {
    return res.status(400).json({ error: 'Female and Male names are required.' });
  }
  const info = db.prepare(
    'INSERT INTO fake_activities (person_a, activity, person_b, created_at) VALUES (?, ?, ?, ?)'
  ).run(personA, activity, personB, Date.now());
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/admin/fake-activities/:id
router.put('/fake-activities/:id', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id FROM fake_activities WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Activity not found.' });
  const personA = ((req.body && req.body.personA) || '').trim().slice(0, 60);
  const activity = ((req.body && req.body.activity) || '').trim().slice(0, 60); // optional
  const personB = ((req.body && req.body.personB) || '').trim().slice(0, 60);
  if (!personA || !personB) {
    return res.status(400).json({ error: 'Female and Male names are required.' });
  }
  db.prepare('UPDATE fake_activities SET person_a = ?, activity = ?, person_b = ? WHERE id = ?')
    .run(personA, activity, personB, row.id);
  res.json({ ok: true });
});

// DELETE /api/admin/fake-activities/:id
router.delete('/fake-activities/:id', requireAdmin, (req, res) => {
  const info = db.prepare('DELETE FROM fake_activities WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Activity not found.' });
  res.json({ ok: true });
});

/* ---------------- Roleplay stories ----------------
   Interactive stories users play out in chat. Each roleplay has ordered stages
   (narration + optional image/gif). Stage images arrive as multipart fields
   named `stage_image_<index>`; the cover as `cover`. */

// Parse the posted stages, resolving each stage's image to either a freshly
// uploaded file, a retained existing filename, or none. Returns
// { value: [{narration, image}], retained: Set } or { error }.
function normalizeStages(rawStages, fileByField) {
  const arr = parseJson(rawStages, null);
  if (!Array.isArray(arr) || arr.length === 0) return { error: 'Add at least one stage.' };
  const out = [];
  const retained = new Set();
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i] || {};
    const narration = (typeof s.narration === 'string' ? s.narration : '').trim();
    const uploaded = fileByField['stage_image_' + i];
    let image = null;
    if (uploaded) {
      image = uploaded.filename;
    } else if (s.existingImage && typeof s.existingImage === 'string') {
      image = path.basename(s.existingImage);
      retained.add(image);
    }
    if (!narration && !image) {
      return { error: `Stage ${i + 1} needs a narration or an image.` };
    }
    out.push({ narration: narration.slice(0, 4000), image });
  }
  return { value: out, retained };
}

function indexFiles(req) {
  const map = {};
  (req.files || []).forEach((f) => { map[f.fieldname] = f; });
  return map;
}
function cleanupFiles(req) {
  (req.files || []).forEach((f) => removeUpload(f.filename));
}
function parseRequired(raw) {
  const n = parseInt(raw, 10);
  return n >= 1 && n <= 100 ? n : 10;
}

// GET /api/admin/roleplays — full roleplays including stages.
router.get('/roleplays', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM roleplays ORDER BY created_at DESC').all();
  res.json({
    roleplays: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      cover: r.cover ? `/uploads/${r.cover}` : null,
      requiredMessages: r.required_messages,
      stages: db
        .prepare('SELECT id, stage_index, narration, image FROM roleplay_stages WHERE roleplay_id = ? ORDER BY stage_index')
        .all(r.id)
        .map((s) => ({
          index: s.stage_index,
          narration: s.narration,
          image: s.image ? `/uploads/${s.image}` : null,
          imageRaw: s.image || null,
        })),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

// POST /api/admin/roleplays  (multipart: cover + stage_image_<i>)
router.post('/roleplays', requireAdmin, imageUpload.any(), (req, res) => {
  const fileByField = indexFiles(req);
  const title = ((req.body && req.body.title) || '').trim();
  if (!title) { cleanupFiles(req); return res.status(400).json({ error: 'Title is required.' }); }
  const stages = normalizeStages(req.body && req.body.stages, fileByField);
  if (stages.error) { cleanupFiles(req); return res.status(400).json({ error: stages.error }); }

  const description = ((req.body && req.body.description) || '').trim().slice(0, 1000);
  const required = parseRequired(req.body && req.body.requiredMessages);
  const cover = fileByField.cover ? fileByField.cover.filename : null;
  const now = Date.now();

  const info = db
    .prepare('INSERT INTO roleplays (title, description, cover, required_messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title.slice(0, 200), description, cover, required, now, now);
  const rpId = info.lastInsertRowid;
  const insStage = db.prepare('INSERT INTO roleplay_stages (roleplay_id, stage_index, narration, image, created_at) VALUES (?, ?, ?, ?, ?)');
  stages.value.forEach((s, i) => insStage.run(rpId, i, s.narration, s.image, now));

  res.status(201).json({ id: rpId });
});

// PUT /api/admin/roleplays/:id  (multipart: cover + stage_image_<i>)
router.put('/roleplays/:id', requireAdmin, imageUpload.any(), (req, res) => {
  const rp = db.prepare('SELECT * FROM roleplays WHERE id = ?').get(req.params.id);
  if (!rp) { cleanupFiles(req); return res.status(404).json({ error: 'Roleplay not found.' }); }
  const fileByField = indexFiles(req);

  const title = ((req.body && req.body.title) || '').trim();
  if (!title) { cleanupFiles(req); return res.status(400).json({ error: 'Title is required.' }); }
  const stages = normalizeStages(req.body && req.body.stages, fileByField);
  if (stages.error) { cleanupFiles(req); return res.status(400).json({ error: stages.error }); }

  const description = ((req.body && req.body.description) || '').trim().slice(0, 1000);
  const required = parseRequired(req.body && req.body.requiredMessages);
  const now = Date.now();

  // Cover: new upload replaces; else keep when keepCover is set, otherwise drop.
  let cover = rp.cover;
  if (fileByField.cover) {
    if (cover) removeUpload(cover);
    cover = fileByField.cover.filename;
  } else if (!(req.body && (req.body.keepCover === 'true' || req.body.keepCover === '1'))) {
    if (cover) removeUpload(cover);
    cover = null;
  }

  // Remove any old stage images that are not being retained.
  const oldImages = db
    .prepare('SELECT image FROM roleplay_stages WHERE roleplay_id = ? AND image IS NOT NULL')
    .all(rp.id)
    .map((r) => r.image);
  oldImages.forEach((img) => { if (!stages.retained.has(img)) removeUpload(img); });

  db.prepare('DELETE FROM roleplay_stages WHERE roleplay_id = ?').run(rp.id);
  const insStage = db.prepare('INSERT INTO roleplay_stages (roleplay_id, stage_index, narration, image, created_at) VALUES (?, ?, ?, ?, ?)');
  stages.value.forEach((s, i) => insStage.run(rp.id, i, s.narration, s.image, now));

  db.prepare('UPDATE roleplays SET title = ?, description = ?, cover = ?, required_messages = ?, updated_at = ? WHERE id = ?')
    .run(title.slice(0, 200), description, cover, required, now, rp.id);

  res.json({ ok: true });
});

// DELETE /api/admin/roleplays/:id
router.delete('/roleplays/:id', requireAdmin, (req, res) => {
  const rp = db.prepare('SELECT id, cover FROM roleplays WHERE id = ?').get(req.params.id);
  if (!rp) return res.status(404).json({ error: 'Roleplay not found.' });
  const images = db
    .prepare('SELECT image FROM roleplay_stages WHERE roleplay_id = ? AND image IS NOT NULL')
    .all(rp.id)
    .map((r) => r.image);
  db.prepare('DELETE FROM roleplays WHERE id = ?').run(rp.id); // cascades stages + sessions
  removeUpload(rp.cover);
  images.forEach(removeUpload);
  res.json({ ok: true });
});

/* ---------------- Leaderboard (read-only view for admins) ---------------- */

// GET /api/admin/leaderboard — same ranking users see, for oversight.
router.get('/leaderboard', requireAdmin, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.username, p.display_name, p.avatar,
            (SELECT COUNT(*) FROM ratings r WHERE r.ratee_id = u.id)   AS rating_count,
            (SELECT AVG(stars) FROM ratings r WHERE r.ratee_id = u.id) AS rating_avg,
            (SELECT COUNT(*) FROM friendships f
               WHERE (f.requester_id = u.id OR f.addressee_id = u.id) AND f.status = 'accepted') AS friends,
            (SELECT COUNT(*) FROM quiz_attempts q WHERE q.user_id = u.id) AS quizzes
     FROM users u JOIN profiles p ON p.user_id = u.id`
  ).all();

  const scored = rows.map((r) => {
    const avg = r.rating_avg || 0;
    return {
      id: r.id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
      ratingAvg: avg ? Math.round(avg * 10) / 10 : 0,
      ratingCount: r.rating_count,
      friends: r.friends,
      quizzes: r.quizzes,
      score: Math.round(avg * 20 + r.rating_count * 5 + r.friends * 8 + r.quizzes * 3),
    };
  });
  scored.sort((a, b) => b.score - a.score || b.ratingAvg - a.ratingAvg);
  scored.forEach((row, i) => { row.rank = i + 1; });
  res.json({ leaderboard: scored });
});

module.exports = router;
