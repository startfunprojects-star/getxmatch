'use strict';

// Public advertisement endpoints:
//   GET /api/ads/slots?placements=a,b   active ads for the SPA to render
//   GET /api/ads/c/:id                  log a click, then redirect to the link
//   GET /api/ads/frame/:id              sandboxed document for a script ad
//
// No auth: ads are shown to everyone, including logged-out visitors.

const express = require('express');
const db = require('../db');
const ads = require('../ads');

const router = express.Router();

// Active ads for one or more placements, grouped by placement. The client
// rotates through the list for repeated inline slots (chat, live, between items).
router.get('/slots', (req, res) => {
  const requested = String(req.query.placements || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ads.isPlacement(s));
  const out = {};
  for (const p of requested) {
    out[p] = ads.activeByPlacement(p).slice(0, 10).map(ads.publicAd);
  }
  res.json({ slots: out });
});

// Record a click on an image ad and redirect to its destination.
router.get('/c/:id', (req, res) => {
  const ad = db.prepare('SELECT id, placement, link, active FROM ads WHERE id = ?').get(req.params.id);
  if (!ad || !ad.link) return res.status(404).type('text/plain').send('Ad not found');
  try { ads.recordClick(ad.id, ad.placement); } catch (_e) { /* never block the redirect */ }
  // Only allow http(s) destinations.
  const url = /^https?:\/\//i.test(ad.link) ? ad.link : 'https://' + ad.link;
  res.redirect(302, url);
});

// Sandboxed document for a script ad. Served with its own permissive CSP so the
// ad network's code can run, isolated from the main app (the embedding <iframe>
// uses sandbox without allow-same-origin, so it can't reach the parent).
router.get('/frame/:id', (req, res) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ? AND type = ? AND active = 1').get(req.params.id, 'script');
  if (!ad) return res.status(404).type('text/plain').send('Ad not found');
  // Override the app-wide strict CSP for this isolated frame only.
  res.setHeader('Content-Security-Policy',
    "default-src 'self' https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self';");
  res.removeHeader('Cross-Origin-Resource-Policy');
  res.type('html').send(ads.frameDocument(ad));
});

module.exports = router;
