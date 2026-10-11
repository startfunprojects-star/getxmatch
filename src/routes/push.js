'use strict';

// Web Push subscriptions for the installed app's icon badge (see src/push.js).

const express = require('express');
const rateLimit = require('express-rate-limit');

const { requireAuth } = require('../auth');
const push = require('../push');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

// GET /api/push/key — the server's public VAPID key, for PushManager.subscribe.
router.get('/key', (req, res) => {
  res.json({ key: push.publicKey() });
});

// POST /api/push/subscribe — { subscription } from PushManager.subscribe().
router.post('/subscribe', requireAuth, limiter, (req, res) => {
  if (!push.subscribe(req.user.id, req.body && req.body.subscription)) {
    return res.status(400).json({ error: 'Invalid subscription.' });
  }
  res.json({ ok: true });
});

// POST /api/push/unsubscribe — { endpoint }.
router.post('/unsubscribe', requireAuth, limiter, (req, res) => {
  push.unsubscribe(req.user.id, req.body && req.body.endpoint);
  res.json({ ok: true });
});

// GET /api/push/badge — what the app icon badge should show right now.
router.get('/badge', requireAuth, (req, res) => {
  res.json({ count: push.badgeCount(req.user.id) });
});

module.exports = router;
