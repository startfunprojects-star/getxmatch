'use strict';

const db = require('./db');
const { ageFromDob, ADULT_AGE } = require('./profileFields');

// True if the member's date of birth puts them under ADULT_AGE. A member with
// no profile / date of birth yet counts as an adult.
function isMinor(userId) {
  const row = db.prepare('SELECT date_of_birth FROM profiles WHERE user_id = ?').get(userId);
  const age = row ? ageFromDob(row.date_of_birth) : null;
  return age != null && age < ADULT_AGE;
}

// Age wall: members under 18 and adults can't contact each other at all (no
// requests, chat, follows, ratings, comments, reactions or gifts).
function ageSeparated(a, b) {
  if (!a || !b || a === b) return false;
  return isMinor(a) !== isMinor(b);
}

// True if either user has blocked the other, or the age wall separates them.
// Communication (requests, chat, files, gifts) is cut both ways either way.
function areBlocked(a, b) {
  if (ageSeparated(a, b)) return true;
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
//   ageWall   = one of them is under 18 and the other isn't
function blockState(ownerId, viewerId) {
  if (!viewerId || viewerId === ownerId) return { iBlocked: false, blockedMe: false, ageWall: false };
  const iBlocked = !!db
    .prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
    .get(viewerId, ownerId);
  const blockedMe = !!db
    .prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?')
    .get(ownerId, viewerId);
  return { iBlocked, blockedMe, ageWall: ageSeparated(ownerId, viewerId) };
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

module.exports = { isMinor, ageSeparated, areBlocked, blockState, isIgnoring, ignoredIds, ignoreState };
