'use strict';

// The set of activity verbs users can pick in a chat. These are exactly the
// values from column 2 ("Activity") of the admin's fake-activity table, so the
// real "what are you doing" statuses use the same vocabulary as the fillers.

const db = require('./db');

function listActivities() {
  const rows = db.prepare('SELECT DISTINCT activity FROM fake_activities').all();
  return [...new Set(rows.map((r) => String(r.activity).trim()).filter(Boolean))];
}

function isValidActivity(activity) {
  const a = String(activity || '').trim();
  return a.length > 0 && listActivities().includes(a);
}

module.exports = { listActivities, isValidActivity };
