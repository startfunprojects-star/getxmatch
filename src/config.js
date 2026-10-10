'use strict';

require('dotenv').config();

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const config = {
  root: ROOT,
  port: parseInt(process.env.PORT, 10) || 3000,
  env: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  jwtSecret: process.env.JWT_SECRET || 'dev-insecure-secret-change-me',
  cookieName: 'gxm_token',
  tokenTtl: '7d',
  maxUploadBytes: (parseInt(process.env.MAX_UPLOAD_MB, 10) || 5) * 1024 * 1024,
  maxReelBytes: (parseInt(process.env.MAX_REEL_MB, 10) || 50) * 1024 * 1024,
  maxChatFileBytes: (parseInt(process.env.MAX_CHAT_FILE_MB, 10) || 15) * 1024 * 1024,
  dataDir: path.join(ROOT, 'data'),
  uploadsDir: path.join(ROOT, 'uploads'),
  dbPath: path.join(ROOT, 'data', 'getxmatch.db'),

  // Public base URL, used to build absolute links inside emails.
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),

  // Where the admin password set/reset link is sent.
  adminEmail: process.env.ADMIN_EMAIL || 'contact@getxmatch.com',

  // Signup email OTP.
  otpTtlMs: (parseInt(process.env.OTP_TTL_MIN, 10) || 10) * 60 * 1000,
  otpMaxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS, 10) || 5,

  // Admin password reset link lifetime.
  adminResetTtlMs: (parseInt(process.env.ADMIN_RESET_TTL_MIN, 10) || 60) * 60 * 1000,

  // Daily "offline activity" digest email. Sent once a day at digestHour (local
  // server time, 0-23) to offline users who got messages/requests since they
  // were last online. Set DIGEST_ENABLED=false to turn it off.
  digestEnabled: process.env.DIGEST_ENABLED !== 'false',
  digestHour: Math.min(23, Math.max(0, parseInt(process.env.DIGEST_HOUR, 10) || 12)),

  // WebRTC ICE servers for video calls. Public STUN works for most networks;
  // set TURN_URLS (comma-separated, e.g. "turn:turn.example.com:3478,turns:turn.example.com:5349")
  // plus TURN_USERNAME / TURN_CREDENTIAL so calls also connect from strict
  // corporate/mobile NATs, where a direct peer-to-peer path is impossible.
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ...(process.env.TURN_URLS
      ? [{
          urls: process.env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
          username: process.env.TURN_USERNAME || '',
          credential: process.env.TURN_CREDENTIAL || '',
        }]
      : []),
  ],

  // Optional Google Safe Browsing API key: links in posts and messages are then
  // also checked against Google's live phishing/malware lists (see linkSafety.js).
  safeBrowsingKey: process.env.GOOGLE_SAFE_BROWSING_KEY || '',

  // Outgoing mail (Hostinger SMTP by default). If user/pass are blank the
  // mailer falls back to logging messages to the server console.
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.hostinger.com',
    port: parseInt(process.env.SMTP_PORT, 10) || 465,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || 'getxmatch <contact@getxmatch.com>',
  },
};

if (config.isProd && config.jwtSecret === 'dev-insecure-secret-change-me') {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start in production with an insecure secret.');
  process.exit(1);
}

module.exports = config;
