'use strict';

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');

const ALLOWED = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadsDir),
  filename: (req, file, cb) => {
    const ext = ALLOWED[file.mimetype] || '.bin';
    const name = crypto.randomBytes(16).toString('hex') + ext;
    cb(null, name);
  },
});

function fileFilter(req, file, cb) {
  if (ALLOWED[file.mimetype]) return cb(null, true);
  cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed'));
}

// Persisted image uploads (avatars + gallery). These are profile content and
// are intentionally saved to disk — unlike ephemeral chat files.
const imageUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxUploadBytes },
});

module.exports = { imageUpload };
