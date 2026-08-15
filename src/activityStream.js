'use strict';

// Continuous, server-side "recent activity" generator.
//
// Runs on a timer in the server process — independent of whether any users are
// online — so the Recent Activity feed is always moving. Each tick generates one
// row (recombined from the admin's fake-activity pool), stores it in a shared
// rolling table, and broadcasts it to every connected client. Because the rows
// are stored and broadcast (not generated per-client), every user sees the SAME
// feed, both on load and live.

const db = require('./db');
const { isFakeActivityEnabled } = require('./settings');
const { broadcastActivity } = require('./socket');

const MAX_ROWS = 300;          // rolling window kept in the DB
const MIN_INTERVAL_MS = 5000;  // 5s
const MAX_INTERVAL_MS = 12000; // 12s

const uniq = (arr) => [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];

function pools() {
  const rows = db.prepare('SELECT person_a, activity, person_b FROM fake_activities').all();
  return {
    females: uniq(rows.map((r) => r.person_a)),
    males: uniq(rows.map((r) => r.person_b)),
    activities: uniq(rows.map((r) => r.activity)),
  };
}

// Pick an emoji that suits the activity verb (mirrors the feed's icon logic).
function iconFor(activity) {
  const a = String(activity).toLowerCase();
  if (/(chat|messag|talk)/.test(a)) return '💬';
  if (/(flirt|crush|love|kiss)/.test(a)) return '😍';
  if (/(match|paired|connect)/.test(a)) return '💘';
  if (/(rat|star|review)/.test(a)) return '⭐';
  if (/(gift|sent)/.test(a)) return '🎁';
  if (/(view|check|look|profile)/.test(a)) return '👀';
  if (/(friend|follow)/.test(a)) return '🤝';
  return '✨';
}

// Build one recombined activity line, or null if the pool is empty/disabled.
function generateOne() {
  if (!isFakeActivityEnabled()) return null;
  const { females, males, activities } = pools();
  if (!females.length || !males.length || !activities.length) return null;
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const f = pick(females);
  const m = pick(males);
  const act = pick(activities);
  const text = Math.random() < 0.5 ? `${f} ${act} ${m}` : `${m} ${act} ${f}`;
  return { text, icon: iconFor(act), at: Date.now() };
}

// The most recent stream rows, as feed-ready event objects (newest first).
function recentStream(limit = 40) {
  return db
    .prepare('SELECT id, text, icon, created_at FROM activity_stream ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ id: 'stream-' + r.id, type: 'fake', at: r.created_at, icon: r.icon, text: r.text }));
}

let timer = null;

function tick() {
  try {
    const ev = generateOne();
    if (ev) {
      db.prepare('INSERT INTO activity_stream (text, icon, created_at) VALUES (?, ?, ?)')
        .run(ev.text, ev.icon, ev.at);
      // Keep only the newest MAX_ROWS rows.
      db.prepare(
        'DELETE FROM activity_stream WHERE id NOT IN (SELECT id FROM activity_stream ORDER BY created_at DESC LIMIT ?)'
      ).run(MAX_ROWS);
      broadcastActivity({ at: ev.at, icon: ev.icon, text: ev.text });
    }
  } catch (_e) { /* keep the timer alive regardless of a transient error */ }
  timer = setTimeout(tick, MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
}

// Start the background generator (idempotent). Called once from server startup.
function startActivityStream() {
  if (timer) return;
  timer = setTimeout(tick, 2000); // small delay so the socket server is ready
}

module.exports = { startActivityStream, recentStream };
