'use strict';

// Kinds of quiz an admin can create. Each type decides how a quiz is played
// after its questions are answered:
//   compatibility — the member shares a link; whoever answers it sees how many
//                   answers the two picked in common, and both earn points.

const QUIZ_TYPES = {
  compatibility: { label: 'Compatibility Quiz' },
};

// How long a compatibility share link stays open for someone to answer.
const MATCH_TTL_MS = 24 * 60 * 60 * 1000;

function typeLabel(type) {
  return (QUIZ_TYPES[type] || QUIZ_TYPES.compatibility).label;
}

module.exports = { QUIZ_TYPES, MATCH_TTL_MS, typeLabel };
