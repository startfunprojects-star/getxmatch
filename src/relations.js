'use strict';

const db = require('./db');

// True if either user has blocked the other. Communication (requests, chat,
// files, gifts) is cut both ways once a block exists in either direction.
function areBlocked(a, b) {
  const row = db
    .prepare(
      `SELECT 1 FROM blocks
       WHERE (blocker_id = ? AND blocked_id = ?)
          OR (blocker_id = ? AND blocked_id = ?)
       LIMIT 1`
    )
    .get(a, b, b, a);
  return !!row;
}

// Block state between a profile owner and a viewer.
//   iBlocked  = the viewer has blocked the owner
//   blockedMe = the owner has blocked the viewer
function blockState(ownerId, viewerId) {
  if (!viewerId || viewerId === ownerId) return { iBlocked: false, blockedMe: false };
  const iBlocked = !!db
    .prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
    .get(viewerId, ownerId);
  const blockedMe = !!db
    .prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
    .get(ownerId, viewerId);
  return { iBlocked, blockedMe };
}

module.exports = { areBlocked, blockState };
