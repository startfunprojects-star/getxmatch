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

// Highway posts: several photos and/or videos at once. Each file is capped at
// the reel size here; photos are held to the (smaller) image cap by the route.
const MEDIA_ALLOWED = { ...ALLOWED, ...VIDEO_ALLOWED };
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.uploadsDir),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + MEDIA_ALLOWED[file.mimetype]),
  }),
  fileFilter: (req, file, cb) => {
    if (MEDIA_ALLOWED[file.mimetype]) return cb(null, true);
    cb(new Error('Only photos (JPG, PNG, WEBP, GIF) and videos (MP4, MOV, WEBM) are allowed'));
  },
  limits: { fileSize: Math.max(config.maxReelBytes, config.maxUploadBytes) },
});

module.exports = { imageUpload, videoUpload, mediaUpload };
