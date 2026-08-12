'use strict';

// Public (authenticated-user) roleplay endpoints: browse the catalog and read
// the current session state for a conversation. Starting/advancing a roleplay
// happens over the socket (see src/socket.js).

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { areBlocked } = require('../relations');
const { roleplaySummary, getActiveSession, progressState } = require('../roleplay');

const router = express.Router();

// GET /api/roleplay — catalog of playable roleplays (those with >=1 stage).
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM roleplays ORDER BY created_at DESC').all();
  const roleplays = rows.map(roleplaySummary).filter((r) => r.stageCount > 0);
  res.json({ roleplays });
});

// GET /api/roleplay/session/:peerId — the active roleplay session (if any)
// between the viewer and the given peer, from the viewer's perspective.
router.get('/session/:peerId', requireAuth, (req, res) => {
  const peerId = parseInt(req.params.peerId, 10);
  if (!peerId) return res.status(400).json({ error: 'Invalid user id.' });
  if (areBlocked(req.user.id, peerId)) return res.json({ session: null });
  const session = getActiveSession(req.user.id, peerId);
  res.json({ session: session ? progressState(session, req.user.id) : null });
});

module.exports = router;
