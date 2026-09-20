'use strict';

const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./db');

function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username },
    config.jwtSecret,
    { expiresIn: config.tokenTtl }
  );
}

function setAuthCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  res.clearCookie(config.cookieName);
}

// Verify a raw token string. Returns the user row (incl. suspension fields) or
// null. Suspension is enforced by the callers, not here, so socket/optional
// paths can decide how to treat a suspended session.
function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = db
      .prepare('SELECT id, username, email, created_at, suspended_until, suspended_reason FROM users WHERE id = ?')
      .get(payload.uid);
    return user || null;
  } catch (_e) {
    return null;
  }
}

// Remaining suspension in ms for a user row (0 = active). Kept here to avoid a
// circular require between auth and moderation.
function suspensionRemaining(user) {
  if (!user || !user.suspended_until) return 0;
  const remaining = user.suspended_until - Date.now();
  return remaining > 0 ? remaining : 0;
}

// Express middleware: attaches req.user or returns 401. A suspended account is
// rejected with 403 and the time its suspension ends.
function requireAuth(req, res, next) {
  const token = req.cookies ? req.cookies[config.cookieName] : null;
  const user = userFromToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const remaining = suspensionRemaining(user);
  if (remaining > 0) {
    return res.status(403).json({
      error: 'Your account is suspended.',
      suspended: true,
      suspendedUntil: user.suspended_until,
      reason: user.suspended_reason || null,
    });
  }
  req.user = user;
  next();
}

// Express middleware: attaches req.user if present, never blocks. A suspended
// account is treated as logged-out for public/optional routes.
function optionalAuth(req, res, next) {
  const user = userFromToken(req.cookies ? req.cookies[config.cookieName] : null);
  req.user = user && suspensionRemaining(user) === 0 ? user : null;
  next();
}

/* ---------------------------------------------------------------------------
   Admin session — a separate cookie/token from regular users.
--------------------------------------------------------------------------- */
const ADMIN_COOKIE = 'gxm_admin';

function signAdminToken() {
  return jwt.sign({ role: 'admin' }, config.jwtSecret, { expiresIn: '12h' });
}

function setAdminCookie(res, token) {
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 12 * 60 * 60 * 1000,
  });
}

function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE);
}

// Express middleware: requires a valid admin session, else 401.
function requireAdmin(req, res, next) {
  const token = req.cookies ? req.cookies[ADMIN_COOKIE] : null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.role !== 'admin') throw new Error('not admin');
    req.admin = true;
    next();
  } catch (_e) {
    res.status(401).json({ error: 'Admin authentication required.' });
  }
}

module.exports = {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  userFromToken,
  suspensionRemaining,
  requireAuth,
  optionalAuth,
  ADMIN_COOKIE,
  signAdminToken,
  setAdminCookie,
  clearAdminCookie,
  requireAdmin,
};
