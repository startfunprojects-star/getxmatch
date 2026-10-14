'use strict';

// Kinds of quiz an admin can create. The admin picks the type for each quiz;
// members see a badge (the type's label) only on compatibility quizzes.
//   standard           — a timed quiz with right answers: the admin marks the
//                        correct option of each question, and only a correct
//                        answer given in time earns its points. Afterwards the
//                        member shares a link; ONE person answers it and both
//                        see who got more right (head to head).
//   compatibility      — the same, then the member shares a link; ONE person
//                        answers it and both see how many answers the two
//                        picked in common, and both earn points. Only these
//                        can be played together in chat.
//   open_compatibility — like compatibility, but ANY registered member can
//                        answer the shared link. The sharer sees their
//                        compatibility with every responder; each responder
//                        sees only their own compatibility with the sharer.

const QUIZ_TYPES = {
  standard: { label: 'Quiz', shareable: true, open: false, badge: false, graded: true },
  compatibility: { label: 'Compatibility Quiz', shareable: true, open: false, badge: true, graded: false },
  open_compatibility: { label: 'Open Compatibility Quiz', shareable: true, open: true, badge: true, graded: false },
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

// Members see the type's label as a badge on the quiz.
function hasBadge(type) {
  return typeOf(type).badge;
}

// Questions can have a correct option (scored right / wrong).
function isGraded(type) {
  return typeOf(type).graded;
}

// The correct option index of a question, or null when none is set.
function correctOption(q) {
  const opts = Array.isArray(q && q.options) ? q.options : [];
  return Number.isInteger(q && q.answer) && q.answer >= 0 && q.answer < opts.length ? q.answer : null;
}

module.exports = { QUIZ_TYPES, MATCH_TTL_MS, typeLabel, isCompatibility, isShareable, isOpen, hasBadge, isGraded, correctOption };
