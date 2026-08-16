'use strict';

// Daily "offline activity" email digest.
//
// Once a day at config.digestHour (local server time), every user who is
// currently OFFLINE and has received direct messages, relationship requests or
// group invites since they were last online gets a single summary email. This
// batches notifications to one mail a day rather than one per event, and skips
// anyone who is online (they'll see it live in the app).

const db = require('./db');
const config = require('./config');
const { isOnline } = require('./socket');
const { sendOfflineDigest } = require('./mail');

// Human-friendly "Alice, Bob and 2 others" from a list of names.
function nameList(names) {
  const uniq = [...new Set(names.filter(Boolean))];
  if (uniq.length === 0) return '';
  if (uniq.length === 1) return uniq[0];
  if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]}`;
  const shown = uniq.slice(0, 2);
  return `${shown.join(', ')} and ${uniq.length - 2} other${uniq.length - 2 === 1 ? '' : 's'}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Build the digest "parts" (summary lines) for one user given a cutoff time.
// Only counts activity strictly newer than `cutoff`. Returns [] when nothing.
function buildParts(userId, cutoff) {
  const parts = [];

  const msg = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND created_at > ?').get(userId, cutoff);
  if (msg && msg.n > 0) {
    const senders = db.prepare(
      `SELECT DISTINCT COALESCE(NULLIF(p.display_name, ''), u.username) AS name
       FROM messages m JOIN users u ON u.id = m.sender_id
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE m.recipient_id = ? AND m.created_at > ? LIMIT 5`
    ).all(userId, cutoff).map((r) => r.name);
    const from = nameList(senders);
    parts.push(`${plural(msg.n, 'new message')}${from ? ` from ${from}` : ''}`);
  }

  const req = db.prepare(
    "SELECT COUNT(*) AS n FROM friendships WHERE addressee_id = ? AND status = 'pending' AND created_at > ?"
  ).get(userId, cutoff);
  if (req && req.n > 0) {
    const from = nameList(db.prepare(
      `SELECT COALESCE(NULLIF(p.display_name, ''), u.username) AS name
       FROM friendships f JOIN users u ON u.id = f.requester_id
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE f.addressee_id = ? AND f.status = 'pending' AND f.created_at > ? LIMIT 5`
    ).all(userId, cutoff).map((r) => r.name));
    parts.push(`${plural(req.n, 'new connection request')}${from ? ` from ${from}` : ''}`);
  }

  const inv = db.prepare(
    "SELECT COUNT(*) AS n FROM chat_group_members WHERE user_id = ? AND status = 'invited' AND created_at > ?"
  ).get(userId, cutoff);
  if (inv && inv.n > 0) {
    parts.push(plural(inv.n, 'new group invite'));
  }

  return parts;
}

// Run one digest pass. Emails every eligible offline user and advances their
// last_digest_at. `nowMs` is the reference "now" (injectable for tests).
// Returns a small summary of what happened.
async function runDigest(nowMs = Date.now()) {
  const users = db
    .prepare("SELECT id, username, email, last_seen_at, last_digest_at FROM users WHERE email IS NOT NULL AND email != ''")
    .all();

  let sent = 0;
  let skippedOnline = 0;
  let skippedEmpty = 0;

  for (const u of users) {
    if (isOnline(u.id)) { skippedOnline++; continue; }

    // Only count activity that is both unseen (after they went offline) and not
    // already covered by a previous digest.
    const cutoff = Math.max(u.last_seen_at || 0, u.last_digest_at || 0);
    const parts = buildParts(u.id, cutoff);
    if (!parts.length) { skippedEmpty++; continue; }

    const name = displayName(u.id) || u.username;
    try {
      await sendOfflineDigest(u.email, { name, parts, appUrl: config.publicUrl });
      sent++;
    } catch (e) {
      // Log and continue — one bad address shouldn't stop the batch.
      console.error(`digest: failed to email user ${u.id}:`, e.message);
    }
    // Advance the cut-off so the same items aren't re-sent tomorrow, whether or
    // not the SMTP call succeeded (a persistent failure shouldn't loop daily).
    db.prepare('UPDATE users SET last_digest_at = ? WHERE id = ?').run(nowMs, u.id);
  }

  const summary = { sent, skippedOnline, skippedEmpty, total: users.length };
  console.log(`digest: ${JSON.stringify(summary)}`);
  return summary;
}

function displayName(userId) {
  const r = db.prepare('SELECT display_name FROM profiles WHERE user_id = ?').get(userId);
  return r && r.display_name ? r.display_name : null;
}

// Milliseconds from `from` until the next occurrence of digestHour:00 local.
function msUntilNextRun(from = new Date()) {
  const next = new Date(from);
  next.setHours(config.digestHour, 0, 0, 0);
  if (next <= from) next.setDate(next.getDate() + 1);
  return next - from;
}

let timer = null;

// Start the daily scheduler (idempotent). No-op when disabled.
function startDigestScheduler() {
  if (timer || !config.digestEnabled) return;
  const schedule = () => {
    const wait = msUntilNextRun();
    timer = setTimeout(async () => {
      try { await runDigest(); } catch (e) { console.error('digest run failed:', e.message); }
      schedule(); // re-arm for the next day
    }, wait);
    // Don't keep the process alive solely for this timer.
    if (timer && typeof timer.unref === 'function') timer.unref();
    const hrs = Math.round((wait / 3600000) * 10) / 10;
    console.log(`digest: next run in ~${hrs}h (daily at ${config.digestHour}:00 local)`);
  };
  schedule();
}

module.exports = { startDigestScheduler, runDigest, buildParts, msUntilNextRun };
