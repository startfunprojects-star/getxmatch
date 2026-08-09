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
  maxChatFileBytes: (parseInt(process.env.MAX_CHAT_FILE_MB, 10) || 15) * 1024 * 1024,
  dataDir: path.join(ROOT, 'data'),
  uploadsDir: path.join(ROOT, 'uploads'),
  dbPath: path.join(ROOT, 'data', 'getxmatch.db'),
};

if (config.isProd && config.jwtSecret === 'dev-insecure-secret-change-me') {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start in production with an insecure secret.');
  process.exit(1);
}

module.exports = config;
