'use strict';

// Account settings for a signed-in member: change password, change email,
// download my data, delete my account, and (under 18) parent controls.

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const config = require('../config');
const mail = require('../mail');
const account = require('../account');
const guardian = require('../guardian');
const { isMinor } = require('../relations');
const { requireAuth, signToken, setAuthCookie, clearAuthCookie } = require('../auth');
const { disconnectUser } = require('../socket');

const router = express.Router();

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You can download your data 5 times an hour. Please try again later.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function fullUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function passwordOk(user, password) {
  return !!password && bcrypt.compareSync(String(password), user.password_hash);
}
// Errors with a status are the member's to fix; anything else is most likely
// the mail server, and is logged.
function sendError(res, e) {
  if (!e.status) console.error('account:', e.message);
  res.status(e.status || 502).json({ error: e.status ? e.message : 'Could not send the email. Please try again.' });
}

// GET /api/account
router.get('/', requireAuth, (req, res) => {
  const u = fullUser(req.user.id);
  const pending = db.prepare('SELECT new_email, expires_at FROM email_changes WHERE user_id = ?').get(u.id);
  const minor = isMinor(u.id);
  res.json({
    username: u.username,
    email: u.email || null,
    createdAt: u.created_at,
    pendingEmail: pending && pending.expires_at > Date.now() ? pending.new_email : null,
    isMinor: minor,
    // Shown to members under 18, and to anyone who still has a link.
    guardian: guardian.summaryFor(u.id),
  });
});

// PUT /api/account/password { currentPassword, newPassword } — signs out every
// other device; this one gets a fresh login token.
router.put('/password', requireAuth, sensitiveLimiter, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = fullUser(req.user.id);
  if (!passwordOk(u, currentPassword)) return res.status(400).json({ error: 'Your current password is not correct.' });
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'The new password must be at least 8 characters.' });
  if (String(newPassword) === String(currentPassword)) return res.status(400).json({ error: 'Choose a password different from your current one.' });

  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(String(newPassword), 12), u.id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
  setAuthCookie(res, signToken(fullUser(u.id)));
  if (u.email) mail.sendPasswordChangedNotice(u.email, u.username).catch(() => {});
  res.json({ ok: true });
});

// POST /api/account/email/start { email, password } — emails a code to the new
// address. Also how a member created by the admin (no email) adds one.
router.post('/email/start', requireAuth, sensitiveLimiter, async (req, res) => {
  const u = fullUser(req.user.id);
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!passwordOk(u, req.body && req.body.password)) return res.status(400).json({ error: 'Your password is not correct.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (email === u.email) return res.status(400).json({ error: 'That is already your email address.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, u.id)) {
    return res.status(409).json({ error: 'That email is already used by another account.' });
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  db.prepare(
    `INSERT INTO email_changes (user_id, new_email, code_hash, attempts, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET new_email = excluded.new_email, code_hash = excluded.code_hash, attempts = 0,
       expires_at = excluded.expires_at, created_at = excluded.created_at`
  ).run(u.id, email, sha256(code), now + config.otpTtlMs, now);
  try {
    await mail.sendEmailChangeCode(email, code);
  } catch (e) {
    return sendError(res, e);
  }
  res.json({ ok: true, pendingEmail: email });
});

// POST /api/account/email/verify { code }
router.post('/email/verify', requireAuth, sensitiveLimiter, (req, res) => {
  const u = fullUser(req.user.id);
  const pending = db.prepare('SELECT * FROM email_changes WHERE user_id = ?').get(u.id);
  if (!pending) return res.status(400).json({ error: 'No email change in progress.' });
  const drop = () => db.prepare('DELETE FROM email_changes WHERE user_id = ?').run(u.id);
  if (Date.now() > pending.expires_at) { drop(); return res.status(400).json({ error: 'The code has expired. Start again.' }); }
  if (pending.attempts >= config.otpMaxAttempts) { drop(); return res.status(429).json({ error: 'Too many incorrect attempts. Start again.' }); }
  if (sha256(String((req.body && req.body.code) || '').trim()) !== pending.code_hash) {
    db.prepare('UPDATE email_changes SET attempts = attempts + 1 WHERE user_id = ?').run(u.id);
    const left = config.otpMaxAttempts - (pending.attempts + 1);
    return res.status(400).json({ error: `Incorrect code.${left > 0 ? ` ${left} attempt(s) left.` : ''}` });
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(pending.new_email, u.id)) {
    drop();
    return res.status(409).json({ error: 'That email is already used by another account.' });
  }
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(pending.new_email, u.id);
  drop();
  if (u.email) mail.sendEmailChangedNotice(u.email, pending.new_email, u.username).catch(() => {});
  res.json({ ok: true, email: pending.new_email });
});

// DELETE /api/account/email/pending — cancel an email change.
router.delete('/email/pending', requireAuth, (req, res) => {
  db.prepare('DELETE FROM email_changes WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// GET /api/account/export — "Download my data" as a zip.
router.get('/export', requireAuth, exportLimiter, async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="getxmatch-${req.user.username}-${stamp}.zip"`);
  res.setHeader('Cache-Control', 'no-store');
  try {
    await account.writeExport(req.user.id, res);
  } catch (e) {
    console.error(`export for user ${req.user.id} failed:`, e.message);
    res.destroy(e); // headers are gone already; abort so the download shows as failed
  }
});

// POST /api/account/delete { password, confirm: 'DELETE' } — permanent.
router.post('/delete', requireAuth, sensitiveLimiter, (req, res) => {
  const u = fullUser(req.user.id);
  const { password, confirm } = req.body || {};
  if (String(confirm || '').trim().toUpperCase() !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm.' });
  if (!passwordOk(u, password)) return res.status(400).json({ error: 'Your password is not correct.' });
  account.deleteUser(u.id);
  disconnectUser(u.id);
  clearAuthCookie(res);
  if (u.email) mail.sendAccountDeletedNotice(u.email, u.username).catch(() => {});
  res.json({ ok: true });
});

/* ------------------------------ parent controls ------------------------------ */

// PUT /api/account/guardian { email } — link a parent (members under 18).
router.put('/guardian', requireAuth, sensitiveLimiter, async (req, res) => {
  if (!isMinor(req.user.id)) return res.status(400).json({ error: 'Parent controls are for members under 18.' });
  try {
    await guardian.link(req.user.id, req.body && req.body.email);
  } catch (e) {
    return sendError(res, e);
  }
  res.json({ ok: true, guardian: guardian.summaryFor(req.user.id) });
});

// POST /api/account/guardian/resend — send the confirmation link again.
router.post('/guardian/resend', requireAuth, sensitiveLimiter, async (req, res) => {
  try {
    await guardian.resend(req.user.id);
  } catch (e) {
    return sendError(res, e);
  }
  res.json({ ok: true });
});

// DELETE /api/account/guardian — remove a pending link, or ask the parent to
// remove an active one.
router.delete('/guardian', requireAuth, sensitiveLimiter, async (req, res) => {
  let result;
  try {
    result = await guardian.removeOrRequest(req.user.id);
  } catch (e) {
    return sendError(res, e);
  }
  res.json({ ok: true, result, guardian: guardian.summaryFor(req.user.id) });
});

module.exports = router;
