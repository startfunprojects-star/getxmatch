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

// True if `viewerId` is ignoring `otherId` (one-way mute).
function isIgnoring(viewerId, otherId) {
  if (!viewerId || viewerId === otherId) return false;
  return !!db.prepare('SELECT 1 FROM ignores WHERE ignorer_id = ? AND ignored_id = ?').get(viewerId, otherId);
}

// The ids a user is ignoring (for filtering their feeds).
function ignoredIds(viewerId) {
  if (!viewerId) return [];
  return db.prepare('SELECT ignored_id FROM ignores WHERE ignorer_id = ?').all(viewerId).map((r) => r.ignored_id);
}

// Ignore state between a profile owner and a viewer (only the viewer's own mute
// is meaningful/visible).
function ignoreState(ownerId, viewerId) {
  return { iIgnore: isIgnoring(viewerId, ownerId) };
}

module.exports = { areBlocked, blockState, isIgnoring, ignoredIds, ignoreState };
