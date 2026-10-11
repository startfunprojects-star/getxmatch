'use strict';

// GET /api/link-preview?url=…  → { preview: { url, title, description, site, image } | null }
// GET /api/link-preview/img/:file → the cached, shrunk featured image.
// See src/linkPreview.js for how pages are fetched safely.

const express = require('express');
const rateLimit = require('express-rate-limit');

const { requireAuth } = require('../auth');
const linkPreview = require('../linkPreview');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many link previews. Please wait a moment.' },
});

router.get('/', requireAuth, limiter, async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).json({ error: 'Missing url.' });
  try {
    const preview = await linkPreview.preview(url);
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ preview });
  } catch (_e) {
    res.json({ preview: null });
  }
});

router.get('/img/:file', requireAuth, (req, res) => {
  const file = linkPreview.imagePath(req.params.file);
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.type('image/webp');
  res.sendFile(file);
});

module.exports = router;
