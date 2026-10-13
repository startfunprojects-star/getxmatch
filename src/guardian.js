'use strict';

// Parent / guardian controls for members under 18.
//
// A member under 18 can link a parent's email in Account settings. The parent
// confirms from an emailed link (nothing applies until then) and from then on
// manages everything from a private page, /guardian/<token>, linked from every
// email: approve or decline new friends, turn the weekly summary on or off, or
// remove the link. A member can't remove an active link themselves; they can
// only ask, which emails the parent.
//
// Friend approval: when two members agree to be friends and either is a minor
// whose parent requires approval, the friendship waits with status 'guardian'
// (one friend_approvals row per parent still to decide) instead of becoming
// 'accepted'. The parent's approval completes it; a decline removes it. Once a
// member turns 18 none of this applies any more.

const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const mail = require('./mail');
const { isMinor } = require('./relations');
const { pointsOf } = require('./points');
const { acceptedText, relEmoji } = require('./relationships');
const { broadcastActivity, notifyUser, broadcastLeaderboardChange } = require('./socket');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');

const manageUrl = (token) => `${config.publicUrl}/guardian/${token}`;
const confirmUrl = (token) => `${config.publicUrl}/guardian/confirm/${token}`;

function child(userId) {
  const r = db.prepare(
    'SELECT u.username, p.display_name FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?'
  ).get(userId);
  return r ? { username: r.username, name: r.display_name || r.username } : null;
}

function get(userId) {
  return db.prepare('SELECT * FROM guardians WHERE user_id = ?').get(userId) || null;
}

function byManageToken(token) {
  if (!token || typeof token !== 'string') return null;
  return db.prepare('SELECT * FROM guardians WHERE manage_token = ?').get(token) || null;
}

// What the member sees in Account settings.
function summaryFor(userId) {
  const g = get(userId);
  if (!g) return null;
  return {
    email: g.email,
    status: g.status,
    approveFriends: !!g.approve_friends,
    weeklySummary: !!g.weekly_summary,
    removalRequested: !!g.removal_requested_at,
    pendingApprovals: pendingFor(userId).length,
  };
}

// Link (or re-link) a parent email and send the confirmation link. Replaces a
// pending link; an active link can't be replaced by the member.
async function link(userId, email) {
  const addr = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(addr)) throw Object.assign(new Error("Enter your parent's email address."), { status: 400 });
  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  if (me && me.email && me.email === addr) {
    throw Object.assign(new Error("That's your own email. Enter your parent's or guardian's email."), { status: 400 });
  }
  const existing = get(userId);
  if (existing && existing.status === 'active') {
    throw Object.assign(new Error('A parent is already linked. Only they can change it.'), { status: 409 });
  }
  const confirm = newToken();
  const now = Date.now();
  db.prepare(
    `INSERT INTO guardians (user_id, email, status, confirm_token_hash, manage_token, created_at)
     VALUES (?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, status = 'pending',
       confirm_token_hash = excluded.confirm_token_hash, manage_token = excluded.manage_token,
       created_at = excluded.created_at, confirmed_at = NULL, removal_requested_at = NULL`
  ).run(userId, addr, sha256(confirm), newToken(), now);
  await mail.sendGuardianConfirm(addr, child(userId), confirmUrl(confirm));
}

async function resend(userId) {
  const g = get(userId);
  if (!g || g.status !== 'pending') throw Object.assign(new Error('There is no pending parent link.'), { status: 400 });
  const confirm = newToken();
  db.prepare('UPDATE guardians SET confirm_token_hash = ? WHERE user_id = ?').run(sha256(confirm), userId);
  await mail.sendGuardianConfirm(g.email, child(userId), confirmUrl(confirm));
}

// The member removes a pending link outright, or asks the parent to remove an
// active one. Returns 'removed' | 'requested'.
async function removeOrRequest(userId) {
  const g = get(userId);
  if (!g) return 'removed';
  if (g.status !== 'active') {
    db.prepare('DELETE FROM guardians WHERE user_id = ?').run(userId);
    return 'removed';
  }
  db.prepare('UPDATE guardians SET removal_requested_at = ? WHERE user_id = ?').run(Date.now(), userId);
  await mail.sendGuardianRemovalRequest(g.email, child(userId), manageUrl(g.manage_token));
  return 'requested';
}

// From the confirmation link. Returns the activated row or null.
function confirm(token) {
  if (!token) return null;
  const g = db.prepare("SELECT * FROM guardians WHERE confirm_token_hash = ? AND status = 'pending'").get(sha256(token));
  if (!g) return null;
  const now = Date.now();
  db.prepare(
    "UPDATE guardians SET status = 'active', confirm_token_hash = NULL, confirmed_at = ?, last_summary_at = ? WHERE user_id = ?"
  ).run(now, now, g.user_id);
  return get(g.user_id);
}

function updateSettings(userId, { approveFriends, weeklySummary }) {
  db.prepare('UPDATE guardians SET approve_friends = ?, weekly_summary = ? WHERE user_id = ?')
    .run(approveFriends ? 1 : 0, weeklySummary ? 1 : 0, userId);
  // Turning approval off releases anything that was waiting on this parent.
  if (!approveFriends) pendingFor(userId).forEach((p) => approve(userId, p.friendshipId));
}

// The parent removes the link. Anything waiting on them is released.
function unlink(userId) {
  pendingFor(userId).forEach((p) => approve(userId, p.friendshipId));
  db.prepare('DELETE FROM guardians WHERE user_id = ?').run(userId);
}

/* ----------------------------- friend approval ----------------------------- */

// The members in a friendship whose parent must approve it first.
function approversNeeded(aId, bId) {
  return [aId, bId].filter((id) => {
    const g = get(id);
    return g && g.status === 'active' && g.approve_friends && isMinor(id);
  });
}

// Finish a friendship: accepted now, announced, both sides refreshed.
function complete(row) {
  db.prepare("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE id = ?").run(Date.now(), row.id);
  const type = row.rel_type || 'friend';
  const a = child(row.requester_id);
  const b = child(row.addressee_id);
  if (a && b) broadcastActivity({ at: Date.now(), icon: relEmoji(type), text: acceptedText(type, a.name, b.name) });
  broadcastLeaderboardChange(); // a new accepted friendship can reshuffle ranks
  [row.requester_id, row.addressee_id].forEach((id) => notifyUser(id, 'notify:request', { type }));
}

// Called where a friendship would become accepted. Accepts it, or holds it for
// the parents who must approve. Returns 'friends' | 'guardian'.
function acceptOrHold(row) {
  const needed = approversNeeded(row.requester_id, row.addressee_id);
  if (!needed.length) {
    complete(row);
    return 'friends';
  }
  db.prepare("UPDATE friendships SET status = 'guardian' WHERE id = ?").run(row.id);
  const now = Date.now();
  for (const childId of needed) {
    db.prepare('INSERT OR IGNORE INTO friend_approvals (friendship_id, child_id, created_at) VALUES (?, ?, ?)')
      .run(row.id, childId, now);
    const g = get(childId);
    const otherId = childId === row.requester_id ? row.addressee_id : row.requester_id;
    const other = child(otherId);
    mail.sendGuardianApprovalRequest(g.email, child(childId), other ? other.name : 'another member', manageUrl(g.manage_token))
      .catch((e) => console.error('guardian approval email failed:', e.message));
  }
  [row.requester_id, row.addressee_id].forEach((id) => notifyUser(id, 'notify:request', { type: 'guardian' }));
  return 'guardian';
}

// Friendships waiting on this child's parent.
function pendingFor(childId) {
  return db.prepare(
    `SELECT f.id AS friendship_id, f.requester_id, f.addressee_id, fa.created_at
       FROM friend_approvals fa JOIN friendships f ON f.id = fa.friendship_id
      WHERE fa.child_id = ? ORDER BY fa.created_at`
  ).all(childId).map((r) => {
    const otherId = r.requester_id === childId ? r.addressee_id : r.requester_id;
    const other = child(otherId) || { name: 'A member', username: '' };
    const p = db.prepare('SELECT country FROM profiles WHERE user_id = ?').get(otherId) || {};
    return { friendshipId: r.friendship_id, otherId, name: other.name, username: other.username, country: p.country || '', at: r.created_at };
  });
}

function approve(childId, friendshipId) {
  const info = db.prepare('DELETE FROM friend_approvals WHERE friendship_id = ? AND child_id = ?').run(friendshipId, childId);
  if (!info.changes) return false;
  const left = db.prepare('SELECT COUNT(*) AS n FROM friend_approvals WHERE friendship_id = ?').get(friendshipId).n;
  const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(friendshipId);
  if (row && !left) complete(row);
  return true;
}

function decline(childId, friendshipId) {
  const ok = db.prepare('SELECT 1 FROM friend_approvals WHERE friendship_id = ? AND child_id = ?').get(friendshipId, childId);
  if (!ok) return false;
  const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(friendshipId);
  db.prepare('DELETE FROM friendships WHERE id = ?').run(friendshipId); // cascades the approvals
  if (row) [row.requester_id, row.addressee_id].forEach((id) => notifyUser(id, 'notify:request', { type: 'guardian' }));
  return true;
}

/* ------------------------------ weekly summary ------------------------------ */

function weeklyStats(userId, since) {
  const count = (sql, ...args) => {
    try { return db.prepare(sql).get(...args).n || 0; } catch (_e) { return 0; }
  };
  const newFriends = db.prepare(
    `SELECT COALESCE(p.display_name, u.username) AS name FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       LEFT JOIN profiles p ON p.user_id = u.id
      WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted' AND f.accepted_at > ?`
  ).all(userId, userId, userId, since).map((r) => r.name);
  const u = db.prepare('SELECT last_seen_at, last_login_at FROM users WHERE id = ?').get(userId) || {};
  const seen = Math.max(u.last_seen_at || 0, u.last_login_at || 0);
  return {
    newFriends,
    pendingApprovals: pendingFor(userId).length,
    quizzes: count('SELECT COUNT(*) AS n FROM quiz_attempts WHERE user_id = ? AND created_at > ?', userId, since),
    posts: count('SELECT COUNT(*) AS n FROM highway_posts WHERE user_id = ? AND created_at > ?', userId, since),
    blogs: count("SELECT COUNT(*) AS n FROM blogs WHERE user_id = ? AND status = 'published' AND published_at > ?", userId, since),
    messages: count('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND created_at > ?', userId, since)
      + count('SELECT COUNT(*) AS n FROM group_messages WHERE sender_id = ? AND created_at > ?', userId, since),
    points: pointsOf(userId),
    lastActive: seen ? new Date(seen).toUTCString().replace(/:\d\d GMT$/, ' GMT') : 'not this week',
  };
}

async function runWeekly(nowMs = Date.now()) {
  const due = db.prepare(
    "SELECT * FROM guardians WHERE status = 'active' AND weekly_summary = 1 AND COALESCE(last_summary_at, 0) <= ?"
  ).all(nowMs - WEEK_MS);
  let sent = 0;
  for (const g of due) {
    db.prepare('UPDATE guardians SET last_summary_at = ? WHERE user_id = ?').run(nowMs, g.user_id);
    if (!isMinor(g.user_id)) continue; // turned 18: no more summaries
    try {
      await mail.sendGuardianWeekly(g.email, child(g.user_id), weeklyStats(g.user_id, g.last_summary_at || g.confirmed_at || 0), manageUrl(g.manage_token));
      sent++;
    } catch (e) {
      console.error(`guardian: weekly summary for user ${g.user_id} failed:`, e.message);
    }
  }
  return { sent, due: due.length };
}

let timer = null;
function startWeeklyScheduler() {
  if (timer) return;
  let running = false;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await runWeekly(); } catch (e) { console.error('guardian weekly run failed:', e.message); }
    running = false;
  }, 60 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = {
  get, byManageToken, summaryFor, link, resend, removeOrRequest, confirm, updateSettings, unlink,
  acceptOrHold, pendingFor, approve, decline, weeklyStats, runWeekly, startWeeklyScheduler, manageUrl, child,
};
