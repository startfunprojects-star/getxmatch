'use strict';

// Follows: a one-way "I follow you" (no approval). Following someone costs the
// follower that person's follow fee in points, and the person followed earns
// double that. Each member sets their own fee (default 1: -1 for the follower,
// +2 for them). The fee is stored on each follow when it's made, so changing
// it later never alters earlier follows. Unfollowing reverses that follow's
// transaction (the follower gets the fee back and the other side loses what
// they earned), so follow/unfollow cycles can't be used to farm points.

const db = require('./db');

const DEFAULT_FEE = 1;
const MAX_FEE = 100; // caps what two colluding members could gain by following each other
const GAIN_MULTIPLIER = 2;

function followFeeOf(userId) {
  const r = db.prepare('SELECT follow_fee FROM users WHERE id = ?').get(userId);
  return r && Number.isInteger(r.follow_fee) ? r.follow_fee : DEFAULT_FEE;
}

// Follower / following counts and, for a viewer, whether they follow `ownerId`
// and at what fee.
function followSummary(ownerId, viewerId) {
  const followers = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?').get(ownerId).n;
  const following = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?').get(ownerId).n;
  const mine = viewerId && viewerId !== ownerId
    ? db.prepare('SELECT fee FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewerId, ownerId)
    : null;
  return {
    followers,
    following,
    fee: followFeeOf(ownerId), // what a new follower pays now
    gain: followFeeOf(ownerId) * GAIN_MULTIPLIER,
    isFollowing: !!mine,
    paidFee: mine ? mine.fee : null,
  };
}

module.exports = { DEFAULT_FEE, MAX_FEE, GAIN_MULTIPLIER, followFeeOf, followSummary };
