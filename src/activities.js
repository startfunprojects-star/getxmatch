'use strict';

// The set of activity verbs users can pick as their "what are you doing"
// status in a chat.

const ACTIVITIES = [
  'chatting with',
  'flirting with',
  'video calling',
  'getting to know',
  'vibing with',
  'texting',
];

function listActivities() {
  return ACTIVITIES.slice();
}

function isValidActivity(activity) {
  const a = String(activity || '').trim();
  return a.length > 0 && ACTIVITIES.includes(a);
}

module.exports = { listActivities, isValidActivity };
