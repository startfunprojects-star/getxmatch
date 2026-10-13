'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

const referrals = require('../referrals');
const db = require('../db');
const config = require('../config');
const { sendSignupOtp, sendPasswordResetCode, sendPasswordChangedNotice } = require('../mail');
const { disconnectUser } = require('../socket');
const F = require('../profileFields');
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
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    education: user.education || null,
    educationStream: user.education_stream || null,
    workStatus: user.work_status || null,
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// POST /api/auth/signup/start — validate details, email a 6-digit OTP, and
// stash the pending signup. No user row is created until the code is verified.
router.post('/signup/start', authLimiter, async (req, res) => {
  const { username, email, password } = req.body || {};
  // Older clients still send the terms box as `ageConfirmed`.
  const termsAccepted = !!(req.body && (req.body.termsAccepted || req.body.ageConfirmed));
  // Referral codes are ignored while the admin has referrals switched off.
  const referralCode = referrals.enabled() ? referrals.normalize(req.body && req.body.referralCode) : '';

  if (!termsAccepted) {
    return res.status(400).json({ error: 'You must agree to the terms.' });
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
  const { education, educationStream, workStatus } = req.body;
  if (!F.EDUCATION.includes(education)) {
    return res.status(400).json({ error: 'Please select your minimum education.' });
  }
  if (!F.EDUCATION_STREAM.includes(educationStream)) {
    return res.status(400).json({ error: 'Please select your education stream.' });
  }
  if (!F.WORK_STATUS.includes(workStatus)) {
    return res.status(400).json({ error: 'Please select your working status.' });
  }

  const emailLc = email.toLowerCase();
  const existing = db
    .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .get(username, emailLc);
  if (existing) {
    return res.status(409).json({ error: 'That username or email is already taken.' });
  }

  if (referralCode && !referrals.referrerId(referralCode)) {
    return res.status(400).json({ error: 'That referral code is not valid. Check it or leave it blank.' });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  const passwordHash = bcrypt.hashSync(password, 12);

  // Upsert the pending signup for this email (replaces any prior attempt).
  db.prepare(
    `INSERT INTO email_otps (email, username, password_hash, code_hash, attempts, expires_at, created_at, referral_code,
                             education, education_stream, work_status)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       username = excluded.username,
       referral_code = excluded.referral_code,
       education = excluded.education,
       education_stream = excluded.education_stream,
       work_status = excluded.work_status,
       password_hash = excluded.password_hash,
       code_hash = excluded.code_hash,
       attempts = 0,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`
  ).run(emailLc, username, passwordHash, sha256(code), now + config.otpTtlMs, now, referralCode || null,
    education, educationStream, workStatus);

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
    .prepare(`INSERT INTO users (username, email, password_hash, created_at, education, education_stream, work_status)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(pending.username, emailLc, pending.password_hash, now,
      pending.education, pending.education_stream, pending.work_status);
  db.prepare('DELETE FROM email_otps WHERE email = ?').run(emailLc);

  const user = {
    id: info.lastInsertRowid, username: pending.username, email: emailLc,
    education: pending.education, education_stream: pending.education_stream, work_status: pending.work_status,
  };
  referrals.ensureCode(user.id);
  if (pending.referral_code) referrals.applyReferral(user.id, pending.referral_code);
  recordLogin(user.id);
  setAuthCookie(res, signToken(user));

  res.status(201).json({ user: publicUser(user), hasProfile: false });
});

// Remember this and the previous login ("new since your last login" in
// Notifications).
function recordLogin(userId) {
  db.prepare('UPDATE users SET prev_login_at = last_login_at, last_login_at = ? WHERE id = ?').run(Date.now(), userId);
}

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

  // Suspended accounts can authenticate but not enter.
  if (user.suspended_until && user.suspended_until > Date.now()) {
    const until = new Date(user.suspended_until).toLocaleString();
    return res.status(403).json({
      error: `Your account is suspended until ${until}.${user.suspended_reason ? ` Reason: ${user.suspended_reason}` : ''}`,
      suspended: true,
      suspendedUntil: user.suspended_until,
    });
  }

  const token = signToken(user);
  recordLogin(user.id);
  setAuthCookie(res, token);

  const profile = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(user.id);
  res.json({ user: publicUser(user), hasProfile: !!profile });
});

/* ---------------------------------------------------------------------------
   Forgot password: a 6-digit code goes to the account's email; entering it with
   a new password sets the password and signs out every other device.
--------------------------------------------------------------------------- */

function findByIdentifier(identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  return db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(id, id.toLowerCase()) || null;
}

// POST /api/auth/password/forgot { identifier } — always answers the same way,
// so it can't be used to find out which usernames or emails exist.
router.post('/password/forgot', authLimiter, async (req, res) => {
  const user = findByIdentifier(req.body && req.body.identifier);
  if (user && user.email) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const now = Date.now();
    db.prepare(
      `INSERT INTO password_resets (user_id, code_hash, attempts, expires_at, created_at) VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, attempts = 0,
         expires_at = excluded.expires_at, created_at = excluded.created_at`
    ).run(user.id, sha256(code), now + config.otpTtlMs, now);
    try {
      await sendPasswordResetCode(user.email, code);
    } catch (e) {
      console.error('password reset email failed:', e.message);
      return res.status(502).json({ error: 'Could not send the email. Please try again.' });
    }
  }
  res.json({ ok: true });
});

// POST /api/auth/password/reset { identifier, code, password }
router.post('/password/reset', authLimiter, (req, res) => {
  const { code, password } = req.body || {};
  const user = findByIdentifier(req.body && req.body.identifier);
  const pending = user && db.prepare('SELECT * FROM password_resets WHERE user_id = ?').get(user.id);
  if (!pending) return res.status(400).json({ error: 'No reset in progress. Ask for a new code.' });
  if (Date.now() > pending.expires_at) {
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    return res.status(400).json({ error: 'The code has expired. Ask for a new one.' });
  }
  if (pending.attempts >= config.otpMaxAttempts) {
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
    return res.status(429).json({ error: 'Too many incorrect attempts. Ask for a new code.' });
  }
  if (sha256(String(code || '').trim()) !== pending.code_hash) {
    db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?').run(user.id);
    const left = config.otpMaxAttempts - (pending.attempts + 1);
    return res.status(400).json({ error: `Incorrect code.${left > 0 ? ` ${left} attempt(s) left.` : ''}` });
  }
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
    .run(bcrypt.hashSync(String(password), 12), user.id);
  db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
  disconnectUser(user.id); // open tabs elsewhere were signed out by the new token version
  sendPasswordChangedNotice(user.email, user.username).catch(() => {});
  res.json({ ok: true });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
// GET /api/auth/referrals — public: whether referrals are switched on (the
// sign-up form shows the referral field and honours ?ref= links only then).
router.get('/referrals', (req, res) => {
  res.json({ enabled: referrals.enabled() });
});

router.get('/me', requireAuth, (req, res) => {
  const profile = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(req.user.id);
  res.json({ user: publicUser(req.user), hasProfile: !!profile });
});

module.exports = router;
