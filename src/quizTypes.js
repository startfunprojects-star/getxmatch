'use strict';

// Kinds of quiz an admin can create. The admin picks the type for each quiz;
// members see a "Compatibility Quiz" badge only on compatibility quizzes.
//   standard      — a timed quiz: answer each question in time to earn its
//                   points. Nothing to share afterwards.
//   compatibility — the same, then the member shares a link; whoever answers it
//                   sees how many answers the two picked in common, and both
//                   earn points. Only these can be played together in chat.

const QUIZ_TYPES = {
  standard: { label: 'Quiz' },
  compatibility: { label: 'Compatibility Quiz' },
};

// How long a compatibility share link stays open for someone to answer.
const MATCH_TTL_MS = 24 * 60 * 60 * 1000;

function typeLabel(type) {
  return (QUIZ_TYPES[type] || QUIZ_TYPES.compatibility).label;
}

function isCompatibility(type) {
  return (type || 'compatibility') === 'compatibility';
}

module.exports = { QUIZ_TYPES, MATCH_TTL_MS, typeLabel, isCompatibility };
