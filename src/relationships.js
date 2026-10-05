'use strict';

// Connection requests are plain friend requests. Every friendship row's
// `rel_type` is 'friend' (older kinds are converted at startup in src/db.js).
const REL_TYPES = {
  friend: { label: 'Friends', emoji: '🤝', requestLabel: 'Send Friend Request' },
};

const REL_ORDER = ['friend'];

function isValidRelType(t) {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(REL_TYPES, t);
}

// Possessive pronoun from a user's self-declared gender. Male → his, Female →
// her, everything else (non-binary / other / prefer-not-to-say / unset) → their.
function possessivePronoun(gender) {
  if (gender === 'Male') return 'his';
  if (gender === 'Female') return 'her';
  return 'their';
}

// Feed line when `a` sends `b` a friend request. (The type and gender
// arguments are accepted for older callers; every request reads as a friend
// request.)
function sentText(_type, a, b) {
  return `${a} sent ${b} a friend request`;
}

// Feed line when a friend request between `a` and `b` is accepted.
function acceptedText(_type, a, b) {
  return `${a} and ${b} are now friends`;
}

function relEmoji() {
  return REL_TYPES.friend.emoji;
}

module.exports = { REL_TYPES, REL_ORDER, isValidRelType, sentText, acceptedText, relEmoji, possessivePronoun };
