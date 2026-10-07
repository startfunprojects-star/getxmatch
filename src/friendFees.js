'use strict';

// Friend request fees. Sending a friend request is priced at the addressee's
// friend fee (default 1), fixed on the request when it's sent. Once the request
// is accepted the requester pays that fee and the addressee earns double. Each
// member sets their own fee; changing it never alters earlier requests.
// Unfriending (or a block) deletes the friendship, which reverses its
// transaction, so friend/unfriend cycles can't be used to farm points. Pending
// or declined requests move no points.

const db = require('./db');

const DEFAULT_FEE = 1;
const MAX_FEE = 100; // caps what two colluding members could gain by friending each other
const GAIN_MULTIPLIER = 2;

function friendFeeOf(userId) {
  const r = db.prepare('SELECT friend_fee FROM users WHERE id = ?').get(userId);
  return r && Number.isInteger(r.friend_fee) ? r.friend_fee : DEFAULT_FEE;
}

// Points a member has earned from (and spent on) accepted friend requests.
function friendFeeTotals(userId) {
  const earned = db.prepare(
    "SELECT COALESCE(SUM(fee), 0) AS n FROM friendships WHERE addressee_id = ? AND status = 'accepted'"
  ).get(userId).n * GAIN_MULTIPLIER;
  const spent = db.prepare(
    "SELECT COALESCE(SUM(fee), 0) AS n FROM friendships WHERE requester_id = ? AND status = 'accepted'"
  ).get(userId).n;
  return { earned, spent };
}

module.exports = { DEFAULT_FEE, MAX_FEE, GAIN_MULTIPLIER, friendFeeOf, friendFeeTotals };
