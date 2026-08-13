'use strict';

const express = require('express');
const multer = require('multer');
const config = require('../config');
const { requireAuth } = require('../auth');
const { FEMALE_VOICES, MALE_VOICES } = require('../voices');
const voice = require('../voice');

const router = express.Router();

// Audio is held in memory only long enough to forward to the provider.
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxVoiceBytes } });

// GET /api/voice/voices — the voice-changer catalog. `realistic` tells the
// client whether the server can do realistic conversion or it should apply the
// browser fallback effect using the pitch/bright params below.
router.get('/voices', requireAuth, (_req, res) => {
  res.json({
    realistic: voice.realisticConfigured(),
    female: FEMALE_VOICES,
    male: MALE_VOICES,
  });
});

// POST /api/voice/convert — realistic conversion (multipart: audio + voice id).
// When no provider is configured we respond { fallback: true } so the client
// knows to run its own browser effect instead.
router.post('/convert', requireAuth, memUpload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio.' });
    const voiceId = (req.body && req.body.voice) || '';
    const out = await voice.convert(req.file.buffer, req.file.mimetype, voiceId);
    if (!out) return res.json({ fallback: true });
    res.set('Content-Type', out.mime);
    res.send(out.buffer);
  } catch (e) {
    res.status(400).json({ error: e.message || 'Conversion failed.' });
  }
});

module.exports = router;
