'use strict';

// Activity email ("digest").
//
// A member gets an email when someone sends them a friend request, or a new quiz
// or poll is published. They also get any direct messages or group invites
// received while offline. At most ONE email per member in any 24 hours,
// and each one goes out at a random moment (a random delay of up to
// MAX_DELAY_MS after it becomes due) rather than at a fixed hour. Everything
// that happened in between is batched into that one email.
//
// users.last_digest_at = when they were last emailed (the cut-off for "new");
// users.digest_due_at  = the random moment their next email is scheduled for.

const db = require('./db');
const config = require('./config');
const { isOnline } = require('./socket');
const { sendOfflineDigest } = require('./mail');

const MIN_GAP_MS = 24 * 60 * 60 * 1000;  // one email per 24 hours, at most
const MIN_DELAY_MS = 10 * 60 * 1000;     // a random delay once something is due…
const MAX_DELAY_MS = 6 * 60 * 60 * 1000; // …of between 10 minutes and 6 hours
const TICK_MS = 5 * 60 * 1000;           // how often the scheduler looks

(function migrate() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('digest_due_at')) db.exec('ALTER TABLE users ADD COLUMN digest_due_at INTEGER');
})();

// Human-friendly "Alice, Bob and 2 others" from a list of names.
function nameList(names) {
  const uniq = [...new Set(names.filter(Boolean))];
  if (uniq.length === 0) return '';
  if (uniq.length === 1) return uniq[0];
  if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`;
  const shown = uniq.slice(0, 2);
  return `${shown.join(', ')} and ${uniq.length - 2} other${uniq.length - 2 === 1 ? '' : 's'}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

// "“A”, “B”, “C” and 2 more"
function titleList(titles) {
  const shown = titles.slice(0, 3).map((t) => `“${String(t).slice(0, 80)}”`).join(', ');
  return titles.length > 3 ? `${shown} and ${titles.length - 3} more` : shown;
}

// The email's summary lines for one member: everything newer than their last
// email. Messages and group invites only count when the member hasn't been
// online since (and isn't online now); friend requests, quizzes and polls
// always count. Returns [] when there is nothing to tell.
function buildParts(user) {
  const parts = [];
  const sinceMail = user.last_digest_at || 0;

  const req = db.prepare(
    "SELECT COUNT(*) AS n FROM friendships WHERE addressee_id = ? AND status = 'pending' AND created_at > ?"
  ).get(user.id, sinceMail);
  if (req && req.n > 0) {
    const from = nameList(db.prepare(
      `SELECT COALESCE(NULLIF(p.display_name, ''), u.username) AS name
       FROM friendships f JOIN users u ON u.id = f.requester_id
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE f.addressee_id = ? AND f.status = 'pending' AND f.created_at > ?
       ORDER BY f.created_at DESC LIMIT 5`
    ).all(user.id, sinceMail).map((r) => r.name));
    parts.push(`${plural(req.n, 'new friend request')}${from ? ` from ${from}` : ''}`);
  }

  if (!isOnline(user.id)) {
    const unseen = Math.max(user.last_seen_at || 0, sinceMail);
    const msg = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND created_at > ?').get(user.id, unseen);
    if (msg && msg.n > 0) {
      const from = nameList(db.prepare(
        `SELECT DISTINCT COALESCE(NULLIF(p.display_name, ''), u.username) AS name
         FROM messages m JOIN users u ON u.id = m.sender_id
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE m.recipient_id = ? AND m.created_at > ? LIMIT 5`
      ).all(user.id, unseen).map((r) => r.name));
      parts.push(`${plural(msg.n, 'new message')}${from ? ` from ${from}` : ''}`);
    }
    const inv = db.prepare(
      "SELECT COUNT(*) AS n FROM chat_group_members WHERE user_id = ? AND status = 'invited' AND created_at > ?"
    ).get(user.id, unseen);
    if (inv && inv.n > 0) parts.push(plural(inv.n, 'new group invite'));
  }

  // Quizzes and polls published since the last email (or since they joined).
  const since = Math.max(sinceMail, user.created_at || 0);
  const quizzes = db.prepare('SELECT title FROM quizzes WHERE created_at > ? ORDER BY created_at DESC').all(since);
  if (quizzes.length) parts.push(`${quizzes.length === 1 ? 'A new quiz' : plural(quizzes.length, 'new quiz', 'new quizzes')}: ${titleList(quizzes.map((q) => q.title))}`);
  const polls = db.prepare('SELECT question FROM polls WHERE created_at > ? ORDER BY created_at DESC').all(since);
  if (polls.length) parts.push(`${polls.length === 1 ? 'A new poll' : plural(polls.length, 'new poll')}: ${titleList(polls.map((p) => p.question))}`);

  return parts;
}

const randomDelay = () => MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));

// One scheduler pass. For each member with an email address: once 24 hours
// have passed since their last email and there is something new, pick a random
// send time; when that time arrives, send one email covering everything new.
// `nowMs` is injectable for tests. Returns a small summary.
async function runDigest(nowMs = Date.now()) {
  const users = db.prepare(
    `SELECT id, username, email, created_at, last_seen_at, last_digest_at, digest_due_at
       FROM users WHERE email IS NOT NULL AND email != ''`
  ).all();

  let sent = 0;
  let scheduled = 0;

  for (const u of users) {
    if (nowMs - (u.last_digest_at || 0) < MIN_GAP_MS) continue; // emailed in the last 24h

    const parts = buildParts(u);
    if (!parts.length) {
      if (u.digest_due_at) db.prepare('UPDATE users SET digest_due_at = NULL WHERE id = ?').run(u.id);
      continue;
    }
    if (!u.digest_due_at) {
      db.prepare('UPDATE users SET digest_due_at = ? WHERE id = ?').run(nowMs + randomDelay(), u.id);
      scheduled++;
      continue;
    }
    if (nowMs < u.digest_due_at) continue;

    const name = displayName(u.id) || u.username;
    try {
      await sendOfflineDigest(u.email, { name, parts, appUrl: config.publicUrl });
      sent++;
    } catch (e) {
      // Log and continue — one bad address shouldn't stop the batch.
      console.error(`digest: failed to email user ${u.id}:`, e.message);
    }
    // Start the next 24 hours whether or not SMTP succeeded (a persistent
    // failure shouldn't retry every few minutes).
    db.prepare('UPDATE users SET last_digest_at = ?, digest_due_at = NULL WHERE id = ?').run(nowMs, u.id);
  }

  if (sent || scheduled) console.log(`digest: ${JSON.stringify({ sent, scheduled })}`);
  return { sent, scheduled, total: users.length };
}

function displayName(userId) {
  const r = db.prepare('SELECT display_name FROM profiles WHERE user_id = ?').get(userId);
  return r && r.display_name ? r.display_name : null;
}

let timer = null;

// Start the scheduler (idempotent). No-op when disabled.
function startDigestScheduler() {
  if (timer || !config.digestEnabled) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runDigest(); } catch (e) { console.error('digest run failed:', e.message); }
    running = false;
  }, TICK_MS);
  // Don't keep the process alive solely for this timer.
  if (typeof timer.unref === 'function') timer.unref();
  console.log('digest: activity emails on (one per member per 24h, random send time)');
}

module.exports = { startDigestScheduler, runDigest, buildParts };
