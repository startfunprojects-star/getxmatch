'use strict';

// Catalog of "naughty gifts" users can send each other in chat. 18+ app, so
// the set is flirty/adult-themed but emoji-only — nothing is uploaded or
// stored beyond the gift id in the message row. Single source of truth: the
// socket validates against this list and the client fetches it via
// GET /api/social/gifts.
const GIFTS = [
  { id: 'kiss', emoji: '💋', name: 'Kiss' },
  { id: 'rose', emoji: '🌹', name: 'Rose' },
  { id: 'peach', emoji: '🍑', name: 'Peach' },
  { id: 'eggplant', emoji: '🍆', name: 'Eggplant' },
  { id: 'fire', emoji: '🔥', name: 'Hottie' },
  { id: 'spicy', emoji: '🌶️', name: 'Spicy' },
  { id: 'cherries', emoji: '🍒', name: 'Cherries' },
  { id: 'tongue', emoji: '👅', name: 'Tongue' },
  { id: 'splash', emoji: '💦', name: 'Splash' },
  { id: 'lingerie', emoji: '🩲', name: 'Lingerie' },
  { id: 'cuffs', emoji: '⛓️', name: 'Cuffs' },
  { id: 'lollipop', emoji: '🍭', name: 'Lollipop' },
  { id: 'hotface', emoji: '🥵', name: 'Hot & bothered' },
  { id: 'wine', emoji: '🍷', name: 'Nightcap' },
];

const byId = new Map(GIFTS.map((g) => [g.id, g]));

function getGift(id) {
  return byId.get(id) || null;
}

module.exports = { GIFTS, getGift };
