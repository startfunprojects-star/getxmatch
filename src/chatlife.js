'use strict';

// Chat lifecycle. Tracks whether each side of a 1-on-1 conversation currently
// has the chat open. When BOTH sides have closed it, a 12-hour timer starts; if
// neither reopens it in that window, every message between the pair is deleted.
// Images already shared to the Highway live in their own table (with copied
// files) and are never affected.

const db = require('./db');

const GRACE_MS = 12 * 60 * 60 * 1000; // 12 hours

function pair(a, b) {
  return a < b ? { lo: a, hi: b } : { lo: b, hi: a };
}

// Set one side's "open" flag for a pair, then (re)stamp both_closed_since: it
// holds the moment both sides were last closed, or NULL while either is open.
function setOpen(a, b, isOpen) {
  const p = pair(a, b);
  const col = a === p.lo ? 'open_lo' : 'open_hi';
  const now = Date.now();
  db.prepare(
    `INSERT INTO chat_close_state (user_lo, user_hi, ${col}) VALUES (?, ?, ?)
     ON CONFLICT(user_lo, user_hi) DO UPDATE SET ${col} = excluded.${col}`
  ).run(p.lo, p.hi, isOpen ? 1 : 0);
  db.prepare(
    `UPDATE chat_close_state
        SET both_closed_since = CASE WHEN open_lo = 0 AND open_hi = 0
              THEN COALESCE(both_closed_since, ?) ELSE NULL END
      WHERE user_lo = ? AND user_hi = ?`
  ).run(now, p.lo, p.hi);
}

function markOpen(a, b) { setOpen(a, b, true); }
function markClosed(a, b) { setOpen(a, b, false); }

// A user went fully offline (last socket closed): treat every conversation they
// still had open as closed, and stamp any pair that is now closed on both sides.
function closeAllFor(userId) {
  const now = Date.now();
  db.prepare('UPDATE chat_close_state SET open_lo = 0 WHERE user_lo = ? AND open_lo = 1').run(userId);
  db.prepare('UPDATE chat_close_state SET open_hi = 0 WHERE user_hi = ? AND open_hi = 1').run(userId);
  db.prepare(
    'UPDATE chat_close_state SET both_closed_since = ? WHERE open_lo = 0 AND open_hi = 0 AND both_closed_since IS NULL'
  ).run(now);
}

// Delete messages for every pair that has been closed on both sides for at least
// GRACE_MS. Returns [{ lo, hi, ids }] so the caller can tell any online clients
// to drop those bubbles. Highway posts are untouched.
function sweep() {
  const cutoff = Date.now() - GRACE_MS;
  const due = db
    .prepare('SELECT user_lo, user_hi FROM chat_close_state WHERE both_closed_since IS NOT NULL AND both_closed_since <= ?')
    .all(cutoff);
  const out = [];
  const selIds = db.prepare(
    `SELECT id FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)`
  );
  const delMsgs = db.prepare(
    `DELETE FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)`
  );
  const delState = db.prepare('DELETE FROM chat_close_state WHERE user_lo = ? AND user_hi = ?');
  for (const r of due) {
    const lo = r.user_lo;
    const hi = r.user_hi;
    const ids = selIds.all(lo, hi, hi, lo).map((row) => row.id);
    delMsgs.run(lo, hi, hi, lo);
    delState.run(lo, hi);
    out.push({ lo, hi, ids });
  }
  return out;
}

module.exports = { GRACE_MS, markOpen, markClosed, closeAllFor, sweep };
