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

module.exports = { REL_TYPES, REL_ORDER, isValidRelType };
