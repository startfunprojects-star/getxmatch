'use strict';

// Follows: a one-way "I follow you" (no approval). Following is free; the
// member followed earns FOLLOWER_POINTS for every follower they have (counted
// live, so an unfollow takes that point back). A follower sees a preview of
// the member's profile (their newest few gallery photos) and their profile
// updates on Recent Activity; the complete profile and chat are for friends
// (see src/friendFees.js for the points friend requests move).

const db = require('./db');

const FOLLOWER_POINTS = 1;

// Follower / following counts and, for a viewer, whether they follow `ownerId`.
function followSummary(ownerId, viewerId) {
  const followers = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?').get(ownerId).n;
  const following = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?').get(ownerId).n;
  const isFollowing = !!(viewerId && viewerId !== ownerId &&
    db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, ownerId));
  return { followers, following, isFollowing, gain: FOLLOWER_POINTS };
}

// True if `viewerId` follows `ownerId`.
function isFollowing(viewerId, ownerId) {
  if (!viewerId || viewerId === ownerId) return false;
  return !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, ownerId);
}

module.exports = { FOLLOWER_POINTS, followSummary, isFollowing };
