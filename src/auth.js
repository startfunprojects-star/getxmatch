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

// Verify a raw token string. Returns the user row or null.
function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = db
      .prepare('SELECT id, username, email, created_at FROM users WHERE id = ?')
      .get(payload.uid);
    return user || null;
  } catch (_e) {
    return null;
  }
}

// Express middleware: attaches req.user or returns 401.
function requireAuth(req, res, next) {
  const token = req.cookies ? req.cookies[config.cookieName] : null;
  const user = userFromToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.user = user;
  next();
}

// Express middleware: attaches req.user if present, never blocks.
function optionalAuth(req, res, next) {
  const token = req.cookies ? req.cookies[config.cookieName] : null;
  req.user = userFromToken(token);
  next();
}

module.exports = {
  signToken,
  setAuthCookie,
  clearAuthCookie,
  userFromToken,
  requireAuth,
  optionalAuth,
};
