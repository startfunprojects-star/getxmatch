'use strict';

// Public (authenticated-user) roleplay endpoints: browse the catalog and read
// the current session state for a conversation. Starting/advancing a roleplay
// happens over the socket (see src/socket.js).

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { areBlocked } = require('../relations');
const {
  roleplaySummary,
  getActiveSession,
  progressState,
  sessionForParticipant,
  getCaptionTexts,
} = require('../roleplay');

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

// GET /api/roleplay/captions/:sessionId?stage=N — the shared caption-studio text
// already written on a stage's speech/thought bubbles. Restricted to the two
// players of that session so a card can paint what's there on load/reload.
router.get('/captions/:sessionId', requireAuth, (req, res) => {
  const sessionId = parseInt(req.params.sessionId, 10);
  const stage = parseInt(req.query.stage, 10);
  if (!sessionId || !(stage >= 0)) return res.status(400).json({ error: 'Invalid request.' });
  const session = sessionForParticipant(sessionId, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  res.json({ texts: getCaptionTexts(sessionId, stage) });
});

module.exports = router;
