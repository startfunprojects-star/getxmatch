'use strict';

// Web Push: lets the installed app (home-screen PWA) show a badge / dot on its
// icon, and a notification, while it is closed.
//
// Each device that allows notifications gives us a push subscription, stored
// in push_subscriptions. When something new arrives for a member (a direct
// message, a new quiz or poll) we push a small JSON payload to every one of
// their devices; the service worker (public/sw.js) sets the icon badge to
// `badge` and shows the notification.
//
// The VAPID key pair identifies this server to the browsers' push services.
// It comes from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY when set, otherwise one is
// generated once and kept in app_settings (changing it would orphan every
// existing subscription).

const webpush = require('web-push');
const db = require('./db');
const { getSetting, setSetting } = require('./settings');
const { unreadCount } = require('./routes/notifications');

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint   TEXT NOT NULL UNIQUE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id);
`);

const MAX_PER_USER = 10; // devices per member; the oldest is dropped beyond this

let keys = null;
function vapidKeys() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const pub = getSetting('vapid_public_key', '');
    const priv = getSetting('vapid_private_key', '');
    if (pub && priv) keys = { publicKey: pub, privateKey: priv };
    else {
      keys = webpush.generateVAPIDKeys();
      setSetting('vapid_public_key', keys.publicKey);
      setSetting('vapid_private_key', keys.privateKey);
    }
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@getxmatch.com', keys.publicKey, keys.privateKey);
  return keys;
}

function publicKey() {
  return vapidKeys().publicKey;
}

function subscribe(userId, sub) {
  const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
  const k = (sub && sub.keys) || {};
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || typeof k.p256dh !== 'string' || typeof k.auth !== 'string'
    || k.p256dh.length > 200 || k.auth.length > 100) return false;
  // One row per device: re-subscribing (or another member signing in on the
  // same phone) moves the endpoint to this member.
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(userId, endpoint, k.p256dh, k.auth, Date.now());
  db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN
    (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`)
    .run(userId, userId, MAX_PER_USER);
  return true;
}

function unsubscribe(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, String(endpoint || ''));
}

// What the icon badge should show: unread direct and group messages + unread
// Notifications (new quizzes, polls, compatibility results, followers).
function badgeCount(userId) {
  const msgs = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL AND kind <> 'hwevent'"
  ).get(userId).n;
  const groupMsgs = db.prepare(
    `SELECT COUNT(*) AS n FROM group_messages gm JOIN chat_group_members m ON m.group_id = gm.group_id
      WHERE m.user_id = ? AND m.status = 'joined' AND gm.sender_id <> ? AND gm.created_at > COALESCE(m.read_at, m.created_at)`
  ).get(userId, userId).n;
  return msgs + groupMsgs + unreadCount(userId);
}

async function sendTo(row, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      { TTL: 24 * 60 * 60, urgency: 'normal' }
    );
  } catch (e) {
    // Gone / not found: the device unsubscribed or the app was removed.
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
    }
  }
}

// Push { title, body, url, tag } to every device of one member, with their
// current badge count. Never throws; returns once all sends have settled.
async function pushToUser(userId, note) {
  try {
    const rows = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
    if (!rows.length) return;
    vapidKeys();
    const payload = { ...note, badge: badgeCount(userId) };
    await Promise.all(rows.map((r) => sendTo(r, payload)));
  } catch (_e) { /* push is best-effort */ }
}

// Push to every member with a device (new quiz / poll), a few at a time.
async function pushToAll(note) {
  try {
    const users = db.prepare('SELECT DISTINCT s.user_id FROM push_subscriptions s JOIN users u ON u.id = s.user_id').all();
    for (let i = 0; i < users.length; i += 20) {
      await Promise.all(users.slice(i, i + 20).map((u) => pushToUser(u.user_id, note)));
    }
  } catch (_e) { /* push is best-effort */ }
}

module.exports = { publicKey, subscribe, unsubscribe, badgeCount, pushToUser, pushToAll };
