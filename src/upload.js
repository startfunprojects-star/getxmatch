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

// Gallery reels: short videos (max 1 minute — checked after upload by the
// route, from the file's own headers).
const VIDEO_ALLOWED = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-m4v': '.m4v',
};

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.uploadsDir),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + VIDEO_ALLOWED[file.mimetype]),
  }),
  fileFilter: (req, file, cb) => {
    if (VIDEO_ALLOWED[file.mimetype]) return cb(null, true);
    cb(new Error('Only MP4, MOV or WEBM videos are allowed'));
  },
  limits: { fileSize: config.maxReelBytes },
});

module.exports = { imageUpload, videoUpload };
