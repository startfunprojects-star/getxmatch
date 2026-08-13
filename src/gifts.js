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
  // Sweet & romantic — nothing naughty, for a softer flirt.
  { id: 'heart', emoji: '❤️', name: 'Heart' },
  { id: 'bouquet', emoji: '💐', name: 'Bouquet' },
  { id: 'chocolate', emoji: '🍫', name: 'Chocolate' },
  { id: 'teddy', emoji: '🧸', name: 'Teddy bear' },
  { id: 'loveletter', emoji: '💌', name: 'Love letter' },
  { id: 'ring', emoji: '💍', name: 'Ring' },
  { id: 'star', emoji: '⭐', name: 'You’re a star' },
  { id: 'coffee', emoji: '☕', name: 'Coffee date' },
  // More adult — turning up the heat.
  { id: 'champagne', emoji: '🍾', name: 'Pop the bubbly' },
  { id: 'cocktail', emoji: '🍸', name: 'One more drink?' },
  { id: 'bed', emoji: '🛏️', name: 'Come over' },
  { id: 'key', emoji: '🔑', name: 'My place' },
  { id: 'devil', emoji: '😈', name: 'Feeling naughty' },
  { id: 'honey', emoji: '🍯', name: 'Sweet & sticky' },
  { id: 'banana', emoji: '🍌', name: 'Banana' },
  { id: 'donut', emoji: '🍩', name: 'Glazed' },
];

const byId = new Map(GIFTS.map((g) => [g.id, g]));

function getGift(id) {
  return byId.get(id) || null;
}

module.exports = { GIFTS, getGift };
