'use strict';

// Connection requests are plain friend requests. The friendship row still has
// a `rel_type` column: older rows may hold kinds that used to exist
// (girlfriend, crush, colleague, …); they're kept in the database but shown as
// friends everywhere, and new requests are always 'friend'.
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
