'use strict';

// "Wasted" feature: users offer each other drinks & substances in chat. Every
// consumption raises the consumer's intoxication ("wasted") score, capped at 15.
// The lighter the person, the faster it climbs. As the score rises the system
// splices random words into their messages; at the cap their messages are
// replaced entirely with "Completely Wasted". The score decays over time so a
// user eventually sobers up (see DECAY_PER_MS).

const db = require('./db');

const MAX_SCORE = 15;

// At/above this the user is "completely wasted" (messages become the fixed
// phrase). It sits just under the cap so that reaching 15 counts as wasted for
// a meaningful window even as the score immediately begins to decay — otherwise
// the state would be unreachable (a freshly-capped score reads a hair under 15).
const WASTED_THRESHOLD = MAX_SCORE - 0.5;

// How fast a maxed-out user sobers up: 1 point every 30 minutes.
const DECAY_PER_MS = 1 / (30 * 60 * 1000);

// The text a fully-wasted user's messages are replaced with.
const WASTED_MESSAGE = 'Completely Wasted';

// Things one user can offer another (or take themselves). `drink` is alcohol;
// the rest are the substance options (smoke / powder / pills). All consumptions
// raise the score identically — only the label/emoji differ.
const ITEMS = {
  drink: { id: 'drink', label: 'Drink', emoji: '🍺', kind: 'drink' },
  smoke: { id: 'smoke', label: 'Smoke', emoji: '🚬', kind: 'substance' },
  powder: { id: 'powder', label: 'Powder', emoji: '❄️', kind: 'substance' },
  pills: { id: 'pills', label: 'Pills', emoji: '💊', kind: 'substance' },
};

function getItem(id) {
  return ITEMS[id] || null;
}

const clamp = (n) => Math.max(0, Math.min(MAX_SCORE, n));

// How many points a single consumption adds, by body weight (kg). Lighter
// people get drunk faster. Missing weight falls back to the 60–80 kg bracket.
function incrementForWeight(weight) {
  const w = Number(weight);
  if (!Number.isFinite(w) || w <= 0) return 2; // no weight on file yet
  if (w < 60) return 3;
  if (w < 80) return 2;
  if (w < 100) return 1;
  if (w < 120) return 0.5;
  return 0.25;
}

// Apply time-decay to a stored score. Read-only: the decayed value is what the
// rest of the app should treat as "current"; it's persisted on the next write.
function decayed(score, updatedAt, now) {
  if (!score || score <= 0) return 0;
  if (!updatedAt) return clamp(score);
  const elapsed = Math.max(0, now - updatedAt);
  return clamp(score - elapsed * DECAY_PER_MS);
}

// The user's current (decayed) wasted score.
function getScore(userId, now = Date.now()) {
  const row = db.prepare('SELECT wasted_score, wasted_updated_at FROM users WHERE id = ?').get(userId);
  if (!row) return 0;
  return decayed(row.wasted_score, row.wasted_updated_at, now);
}

function weightOf(userId) {
  const p = db.prepare('SELECT weight FROM profiles WHERE user_id = ?').get(userId);
  return p ? p.weight : null;
}

// Register one consumption for a user and persist the new score. Returns the
// new (clamped) score.
function consume(userId, now = Date.now()) {
  const current = getScore(userId, now);
  const next = clamp(current + incrementForWeight(weightOf(userId)));
  db.prepare('UPDATE users SET wasted_score = ?, wasted_updated_at = ? WHERE id = ?').run(next, now, userId);
  return next;
}

function isMaxed(score) {
  return score >= WASTED_THRESHOLD;
}

/* -------------------------------------------------------------------------
   Admin-managed content: injection words + random chat sentences.
------------------------------------------------------------------------- */

function words() {
  return db.prepare('SELECT word FROM wasted_words').all().map((r) => r.word).filter(Boolean);
}

function sentences() {
  return db.prepare('SELECT sentence FROM wasted_sentences').all().map((r) => r.sentence).filter(Boolean);
}

function pick(arr) {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

// Splice random words from the admin pool into `body`. The drunker the sender
// (higher score), the more likely — and the more words get spliced in. Returns
// the (possibly unchanged) text. No-op when the word pool is empty.
function injectWords(body, score) {
  const pool = words();
  if (!pool.length || !body) return body;
  // Injection probability scales from ~0 up to ~0.8 at the cap.
  const p = Math.min(0.8, (score / MAX_SCORE) * 0.8);
  const attempts = 1 + Math.floor(score / 6); // 1 attempt low, up to 3 near max
  let tokens = body.split(' ');
  for (let i = 0; i < attempts; i++) {
    if (Math.random() > p) continue;
    const word = pick(pool);
    if (!word) break;
    const at = Math.floor(Math.random() * (tokens.length + 1));
    tokens.splice(at, 0, word);
  }
  return tokens.join(' ');
}

// Transform an outgoing message body for a sender at the given score: a maxed
// user's message becomes "Completely Wasted"; otherwise words may be spliced in.
function transformOutgoing(body, score) {
  if (isMaxed(score)) return WASTED_MESSAGE;
  return injectWords(body, score);
}

// Occasionally return a random admin "wasted" sentence to drop into a chat.
// Chance is low so it feels like an ambient interruption, not spam.
function maybeSentence(chance = 0.12) {
  const pool = sentences();
  if (!pool.length) return null;
  if (Math.random() > chance) return null;
  return pick(pool);
}

module.exports = {
  MAX_SCORE,
  WASTED_MESSAGE,
  ITEMS,
  getItem,
  incrementForWeight,
  getScore,
  consume,
  isMaxed,
  injectWords,
  transformOutgoing,
  maybeSentence,
  words,
  sentences,
};
