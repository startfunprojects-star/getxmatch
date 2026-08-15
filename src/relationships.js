'use strict';

// Relationship-request kinds a user can send in place of a plain friend request.
// Stored on the friendship row as `rel_type` (the requester's chosen kind). The
// key is what the API/DB store; `requestLabel` is the option text in the picker;
// `label`/`emoji` are how the accepted bond is shown.
const REL_TYPES = {
  friend:     { label: 'Friends',    emoji: '🤝', requestLabel: 'Send Friend Request' },
  girlfriend: { label: 'Girlfriend', emoji: '💖', requestLabel: 'Be My Girlfriend' },
  boyfriend:  { label: 'Boyfriend',  emoji: '💙', requestLabel: 'Be My Boyfriend' },
  wife:       { label: 'Wife',       emoji: '💍', requestLabel: 'Be My Wife' },
  husband:    { label: 'Husband',    emoji: '💍', requestLabel: 'Be My Husband' },
  crush:      { label: 'Crush',      emoji: '💘', requestLabel: 'Crush' },
  colleague:  { label: 'Colleagues', emoji: '💼', requestLabel: 'Colleagues' },
};

// Order the picker presents the options in (matches the product spec).
const REL_ORDER = ['friend', 'girlfriend', 'boyfriend', 'wife', 'husband', 'crush', 'colleague'];

function isValidRelType(t) {
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(REL_TYPES, t);
}

// Feed line when `a` sends `b` a request of the given kind.
function sentText(type, a, b) {
  switch (type) {
    case 'girlfriend': return `${a} asked ${b} to be their girlfriend`;
    case 'boyfriend':  return `${a} asked ${b} to be their boyfriend`;
    case 'wife':       return `${a} asked ${b} to be their wife`;
    case 'husband':    return `${a} asked ${b} to be their husband`;
    case 'crush':      return `${a} has a crush on ${b}`;
    case 'colleague':  return `${a} sent ${b} a colleague request`;
    default:           return `${a} sent ${b} a friend request`;
  }
}

// Feed line when a request of the given kind between `a` and `b` is accepted.
function acceptedText(type, a, b) {
  switch (type) {
    case 'girlfriend':
    case 'boyfriend':  return `${a} and ${b} are now a couple`;
    case 'wife':
    case 'husband':    return `${a} and ${b} are now married`;
    case 'crush':      return `${a} and ${b} are crushing on each other`;
    case 'colleague':  return `${a} and ${b} are now colleagues`;
    default:           return `${a} and ${b} are now friends`;
  }
}

function relEmoji(type) {
  return (REL_TYPES[type] || REL_TYPES.friend).emoji;
}

module.exports = { REL_TYPES, REL_ORDER, isValidRelType, sentText, acceptedText, relEmoji };
