'use strict';

// Public (authenticated-user) roleplay endpoints: browse the catalog, read the
// current session state for a conversation, load/observe caption state, and
// share a captioned stage image to the Highway. Starting/advancing a roleplay
// and live caption edits happen over the socket (see src/socket.js).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth');
const { areBlocked } = require('../relations');
const { friendState } = require('../profileData');
const { broadcastHighway } = require('../socket');
const hw = require('../highway');
const {
  roleplaySummary,
  getActiveSession,
  progressState,
  sessionForParticipant,
  getCaptionState,
  captionsForShare,
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

// GET /api/roleplay/captions/:sessionId?stage=N — the shared caption state
// (text + any player-set position/rotation) on a stage's speech/thought bubbles.
// Restricted to the two players so a card can paint what's there on load/reload.
router.get('/captions/:sessionId', requireAuth, (req, res) => {
  const sessionId = parseInt(req.params.sessionId, 10);
  const stage = parseInt(req.query.stage, 10);
  if (!sessionId || !(stage >= 0)) return res.status(400).json({ error: 'Invalid request.' });
  const session = sessionForParticipant(sessionId, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });
  res.json({ captions: getCaptionState(sessionId, stage) });
});

// POST /api/roleplay/share  { sessionId, stage } — bake the current captions onto
// a copy of the stage image and post it to the Highway, linked back to this
// conversation so later likes/comments surface in the chat.
router.post('/share', requireAuth, (req, res) => {
  const sessionId = parseInt(req.body && req.body.sessionId, 10);
  const stage = parseInt(req.body && req.body.stage, 10);
  if (!sessionId || !(stage >= 0)) return res.status(400).json({ error: 'Invalid request.' });

  const session = sessionForParticipant(sessionId, req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const baked = captionsForShare(session, stage);
  if (!baked) return res.status(400).json({ error: 'This stage has no image to share.' });

  // Copy the stage image to a fresh file so Highway pruning never deletes the
  // roleplay's own artwork.
  const srcName = path.basename(baked.image);
  const ext = path.extname(srcName) || '.jpg';
  const destName = crypto.randomBytes(16).toString('hex') + ext;
  try {
    fs.copyFileSync(path.join(config.uploadsDir, srcName), path.join(config.uploadsDir, destName));
  } catch (_e) {
    return res.status(500).json({ error: 'Could not share this image right now.' });
  }

  const origin = { kind: 'roleplay', a: session.user_lo, b: session.user_hi };
  const { id, prunedImages } = hw.createPost({
    userId: req.user.id,
    body: '',
    image: destName,
    captions: JSON.stringify(baked.captions),
    origin,
  });
  prunedImages.forEach((f) => {
    if (f) fs.promises.unlink(path.join(config.uploadsDir, path.basename(f))).catch(() => {});
  });

  const row = hw.byId(id);
  const author = {
    id: row.user_id,
    username: row.username,
    displayName: row.display_name || row.username,
    avatar: row.avatar ? `/uploads/${row.avatar}` : null,
  };
  try {
    broadcastHighway({
      id: row.id, body: '', image: `/uploads/${row.image}`,
      captions: baked.captions, createdAt: row.created_at, author,
    });
  } catch (_e) { /* never block the response */ }

  res.status(201).json({ ok: true, postId: id, friendState: friendState(row.user_id, req.user.id) });
});

module.exports = router;
