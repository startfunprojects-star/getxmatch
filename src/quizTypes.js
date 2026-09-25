'use strict';

// Kinds of quiz an admin can create. The admin picks the type for each quiz;
// members see a badge (the type's label) only on shareable quizzes.
//   standard           — a timed quiz: answer each question in time to earn
//                        its points. Nothing to share afterwards.
//   compatibility      — the same, then the member shares a link; ONE person
//                        answers it and both see how many answers the two
//                        picked in common, and both earn points. Only these
//                        can be played together in chat.
//   open_compatibility — like compatibility, but ANY registered member can
//                        answer the shared link. The sharer sees their
//                        compatibility with every responder; each responder
//                        sees only their own compatibility with the sharer.

const QUIZ_TYPES = {
  standard: { label: 'Quiz', shareable: false, open: false },
  compatibility: { label: 'Compatibility Quiz', shareable: true, open: false },
  open_compatibility: { label: 'Open Compatibility Quiz', shareable: true, open: true },
};

// How long a compatibility share link stays open for someone to answer.
const MATCH_TTL_MS = 24 * 60 * 60 * 1000;

function typeOf(type) {
  return QUIZ_TYPES[type] || QUIZ_TYPES.compatibility;
}

function typeLabel(type) {
  return typeOf(type).label;
}

// One-to-one compatibility quiz (the classic share link / chat quiz).
function isCompatibility(type) {
  return (type || 'compatibility') === 'compatibility';
}

// Finishing the quiz gives the member a link to share.
function isShareable(type) {
  return typeOf(type).shareable;
}

// The shared link can be answered by any number of registered members.
function isOpen(type) {
  return typeOf(type).open;
}

module.exports = { QUIZ_TYPES, MATCH_TTL_MS, typeLabel, isCompatibility, isShareable, isOpen };
