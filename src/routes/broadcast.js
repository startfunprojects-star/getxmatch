'use strict';

// Public listing of active broadcast ("live") chats. Deliberately open to
// everyone via optionalAuth: logged-out visitors browse the same list on the
// standalone /live page. All the live streaming itself happens over the socket
// (see src/socket.js) — this route only exposes the current directory.

const express = require('express');

const { optionalAuth } = require('../auth');
const broadcast = require('../broadcast');

const router = express.Router();

router.get('/', optionalAuth, (req, res) => {
  res.json({
    broadcasts: broadcast.list(),
    me: req.user ? { id: req.user.id, username: req.user.username } : null,
  });
});

router.get('/:token', optionalAuth, (req, res) => {
  const b = broadcast.get(req.params.token);
  if (!b) return res.status(404).json({ error: 'This broadcast has ended.' });
  res.json({
    broadcast: broadcast.publicView(b),
    me: req.user ? { id: req.user.id, username: req.user.username } : null,
  });
});

module.exports = router;
