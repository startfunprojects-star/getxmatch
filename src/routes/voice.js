'use strict';

// Voice notes: POST /api/voice uploads a recording for a 1:1 chat (`to`) or a
// group chat (`groupId`); it's converted to AAC (see src/voiceNotes.js) and
// delivered as a kind='voice' message. GET /api/voice/:id streams a note to the
// people in that conversation only (with range requests, so seeking works).

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const { requireAuth } = require('../auth');
const voiceNotes = require('../voiceNotes');
const { postDenied, deliverMessage } = require('../socket');

const router = express.Router();

// The raw browser recording lands in the OS temp folder until it's converted.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) => cb(null, 'gxm-voice-' + crypto.randomBytes(12).toString('hex')),
  }),
  fileFilter: (req, file, cb) => {
    if (/^(audio|video)\/(webm|ogg|mp4|mpeg|aac|x-m4a|wav|x-wav|3gpp|quicktime)/i.test(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported recording format.'));
  },
  limits: { fileSize: 12 * 1024 * 1024 },
});

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are sending voice notes too fast. Please wait a moment.' },
});

router.post('/', requireAuth, sendLimiter, (req, res, next) => {
  upload.single('audio')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That voice note is too long.' : err.message });
  });
}, async (req, res) => {
  const tmp = req.file && req.file.path;
  const cleanup = () => { if (tmp) fs.unlink(tmp, () => {}); };
  try {
    if (!tmp) return res.status(400).json({ error: 'No recording received.' });
    const to = parseInt(req.body.to, 10) || null;
    const groupId = parseInt(req.body.groupId, 10) || null;
    if ((!to && !groupId) || to === req.user.id) { cleanup(); return res.status(400).json({ error: 'Invalid recipient.' }); }
    const denied = postDenied(req.user.id, { to, groupId });
    if (denied) { cleanup(); return res.status(403).json({ error: denied }); }
    if (!voiceNotes.available()) { cleanup(); return res.status(503).json({ error: 'Voice notes are not available right now.' }); }

    let out;
    try { out = await voiceNotes.transcode(tmp); }
    catch (e) { return res.status(400).json({ error: 'That recording could not be processed. Please try again.' }); }
    finally { cleanup(); }
    if (out.duration < voiceNotes.MIN_SECONDS) {
      fs.unlink(voiceNotes.filePath(out), () => {});
      return res.status(400).json({ error: 'That voice note was too short. Hold the mic a little longer.' });
    }

    const voiceId = voiceNotes.saveNote({ file: out.file, duration: out.duration, ownerId: req.user.id, to, groupId });
    const id = deliverMessage(req.user.id, {
      to, groupId, kind: 'voice', body: voiceNotes.bodyFor(voiceId, out.duration), replyTo: req.body.replyTo,
    });
    res.status(201).json({ ok: true, id, voiceId, duration: out.duration });
  } catch (e) {
    cleanup();
    res.status(500).json({ error: e.message || 'Could not send the voice note.' });
  }
});

router.get('/:id', requireAuth, (req, res) => {
  const row = voiceNotes.noteFor(parseInt(req.params.id, 10), req.user.id);
  if (!row) return res.status(404).json({ error: 'Voice note not found.' });
  const file = voiceNotes.filePath(row);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Voice note not found.' });
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('audio/mp4');
  res.sendFile(path.resolve(file)); // handles Range requests for seeking
});

module.exports = router;
