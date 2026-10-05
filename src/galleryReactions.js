'use strict';

// Emoji "likes" a user can leave on a gallery photo. One reaction per user per
// photo; picking a new one replaces it, picking the same one again clears it.
//
// Server-side allow-list so clients can't store arbitrary strings. The client
// mirrors this list to render the reaction picker (see GALLERY_REACTIONS in
// public/js/app.js) — keep the two in sync.
const GALLERY_REACTIONS = [
  { emoji: '❤️', label: 'Love' },
  { emoji: '😄', label: 'Smile' },
  { emoji: '😮', label: 'Wow' },
  { emoji: '👏', label: 'Applause' },
  { emoji: '🔥', label: 'Awesome' },
];

const GALLERY_REACTION_SET = new Set(GALLERY_REACTIONS.map((r) => r.emoji));

module.exports = { GALLERY_REACTIONS, GALLERY_REACTION_SET };
