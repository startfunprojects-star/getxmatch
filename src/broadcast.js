'use strict';

// In-memory registry of live "broadcast chats". A broadcast turns a private
// 1:1 conversation into a public live stream: anyone (registered OR anonymous)
// can WATCH the messages the two participants exchange from the moment the
// broadcast starts, see a live viewer count, and post ephemeral flying
// comments. Viewers can never join the actual conversation.
//
// Nothing here is persisted — broadcasts live only while at least one
// participant is online and the owner keeps it running. On server restart the
// registry is empty, which is the desired behaviour for "active chats only".

const crypto = require('crypto');

// token -> broadcast object.
const broadcasts = new Map();
// normalized pair key ("lo:hi") -> token, so a pair maps to at most one live
// broadcast regardless of who started it.
const byPair = new Map();

function pairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

// A viewer-safe snapshot (no internal Sets, no viewer socket ids).
function publicView(b) {
  return {
    token: b.token,
    ownerId: b.ownerId,
    ownerName: b.ownerName,
    peerId: b.peerId,
    peerName: b.peerName,
    title: b.title,
    startedAt: b.startedAt,
    viewers: b.viewers.size,
  };
}

// Start (or return the existing) broadcast for a pair. The starter is recorded
// as the owner. Returns the broadcast object.
function start({ ownerId, ownerName, peerId, peerName, title }) {
  const key = pairKey(ownerId, peerId);
  const existingToken = byPair.get(key);
  if (existingToken && broadcasts.has(existingToken)) {
    return broadcasts.get(existingToken);
  }
  const token = crypto.randomBytes(9).toString('base64url'); // ~12 url-safe chars
  const b = {
    token,
    ownerId: Number(ownerId),
    ownerName: ownerName || 'Someone',
    peerId: Number(peerId),
    peerName: peerName || 'Someone',
    title: (title || '').toString().slice(0, 80),
    startedAt: Date.now(),
    viewers: new Set(), // socket ids currently watching (authed + anonymous)
    lastComment: new Map(), // socketId -> ts, for lightweight rate limiting
  };
  broadcasts.set(token, b);
  byPair.set(key, token);
  return b;
}

function get(token) {
  return broadcasts.get(token) || null;
}

function forPair(a, b) {
  const token = byPair.get(pairKey(a, b));
  return token ? broadcasts.get(token) || null : null;
}

// Stop a broadcast by token. Returns the removed object (or null).
function stop(token) {
  const b = broadcasts.get(token);
  if (!b) return null;
  broadcasts.delete(token);
  byPair.delete(pairKey(b.ownerId, b.peerId));
  return b;
}

// Stop every broadcast a given user participates in (owner or peer). Used when
// a participant goes fully offline. Returns the removed broadcast objects.
function stopForUser(userId) {
  const uid = Number(userId);
  const removed = [];
  for (const b of [...broadcasts.values()]) {
    if (b.ownerId === uid || b.peerId === uid) {
      stop(b.token);
      removed.push(b);
    }
  }
  return removed;
}

// Whether a user is a participant (owner or peer) of a broadcast.
function isParticipant(b, userId) {
  const uid = Number(userId);
  return b.ownerId === uid || b.peerId === uid;
}

function list() {
  return [...broadcasts.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(publicView);
}

module.exports = {
  start,
  stop,
  stopForUser,
  get,
  forPair,
  isParticipant,
  list,
  publicView,
};
