'use strict';

const cookie = require('cookie');
const db = require('./db');
const config = require('./config');
const { userFromToken } = require('./auth');
const { areBlocked } = require('./relations');
const { getGift } = require('./gifts');
const roleplay = require('./roleplay');

// Emoji reactions a user may place on a message/gift. Server-side allow-list so
// clients can't store arbitrary strings.
const REACTION_EMOJIS = new Set(['❤️', '😂', '😮', '😢', '🔥', '👍', '😍', '🙏']);

// Map of userId -> Set of socket ids (a user may have multiple tabs open).
const online = new Map();

function addSocket(userId, socketId) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(socketId);
}

function removeSocket(userId, socketId) {
  const set = online.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) online.delete(userId);
}

function isOnline(userId) {
  return online.has(userId);
}

/* --------------------------------------------------------------------------
   Roleplay delivery helpers
-------------------------------------------------------------------------- */

// Persist a narration card as a kind='narration' message and deliver it to
// both users in the pair (body is the JSON stage payload).
function deliverNarration(io, a, b, payload) {
  const now = Date.now();
  const body = JSON.stringify(payload);
  const info = db
    .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at) VALUES (?, ?, ?, 'narration', ?)")
    .run(a, b, body, now);
  const msg = { id: info.lastInsertRowid, from: a, to: b, body, kind: 'narration', at: now };
  io.to(`user:${a}`).emit('chat:message', { ...msg, mine: true });
  io.to(`user:${b}`).emit('chat:message', { ...msg, mine: false });
}

function emitRoleplayProgress(io, a, b, session) {
  io.to(`user:${a}`).emit('roleplay:progress', roleplay.progressState(session, a));
  io.to(`user:${b}`).emit('roleplay:progress', roleplay.progressState(session, b));
}

// Act on a recordMessage()/start outcome: reveal narration + push progress.
function applyRoleplayOutcome(io, senderId, otherId, outcome) {
  if (!outcome) return;
  if (outcome.type === 'advance') {
    deliverNarration(io, senderId, otherId,
      roleplay.stagePayload(outcome.roleplay, outcome.stageRow, outcome.stageIndex, outcome.total, false));
    emitRoleplayProgress(io, senderId, otherId, outcome.session);
  } else if (outcome.type === 'complete') {
    deliverNarration(io, senderId, otherId,
      roleplay.stagePayload(outcome.roleplay, null, outcome.total, outcome.total, true));
    emitRoleplayProgress(io, senderId, otherId, outcome.session);
  } else if (outcome.type === 'progress') {
    emitRoleplayProgress(io, senderId, otherId, outcome.session);
  }
}

/* --------------------------------------------------------------------------
   Reply helpers
-------------------------------------------------------------------------- */

// Validate a replyTo id: it must be a real message exchanged between these two
// users (either direction). Returns the numeric id or null.
function resolveReplyTo(raw, a, b) {
  const id = parseInt(raw, 10);
  if (!id) return null;
  const row = db
    .prepare('SELECT id FROM messages WHERE id = ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))')
    .get(id, a, b, b, a);
  return row ? id : null;
}

// A compact snapshot of the quoted message so the client can render it without
// a second lookup. gift bodies hold a gift id (resolved to a label here).
function replyPreview(replyToId) {
  if (!replyToId) return null;
  const row = db.prepare('SELECT id, sender_id, body, kind FROM messages WHERE id = ?').get(replyToId);
  if (!row) return null;
  let text = row.body;
  if (row.kind === 'gift') {
    const g = getGift(row.body);
    text = g ? `${g.emoji} ${g.name}` : 'a gift';
  } else if (row.kind === 'narration') {
    text = '🎭 Roleplay';
  }
  return { id: row.id, from: row.sender_id, kind: row.kind || 'text', text: String(text).slice(0, 140) };
}

function initSocket(io) {
  // Authenticate every socket from the httpOnly auth cookie.
  io.use((socket, next) => {
    try {
      const raw = socket.handshake.headers.cookie || '';
      const parsed = cookie.parse(raw);
      const user = userFromToken(parsed[config.cookieName]);
      if (!user) return next(new Error('unauthorized'));
      socket.user = user;
      next();
    } catch (e) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const me = socket.user;
    addSocket(me.id, socket.id);
    // Personal room makes it easy to target all of a user's sockets.
    socket.join(`user:${me.id}`);

    // Text message → persisted to history, then delivered live if online.
    socket.on('chat:message', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const body = (payload && typeof payload.body === 'string' ? payload.body : '').trim();
        if (!to || !body) return ack && ack({ error: 'Invalid message.' });
        if (body.length > 4000) return ack && ack({ error: 'Message too long.' });

        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });
        if (areBlocked(me.id, to)) {
          return ack && ack({ error: 'You cannot message this user — a block is in place.' });
        }

        // Optional reply: only accept an id that belongs to THIS conversation.
        const replyTo = resolveReplyTo(payload && payload.replyTo, me.id, to);

        const now = Date.now();
        const info = db
          .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, reply_to, created_at) VALUES (?, ?, ?, 'text', ?, ?)")
          .run(me.id, to, body, replyTo, now);

        const reply = replyPreview(replyTo);
        const msg = { id: info.lastInsertRowid, from: me.id, to, body, kind: 'text', at: now, replyTo, reply };

        // Deliver to recipient's sockets and echo to sender's other tabs.
        io.to(`user:${to}`).emit('chat:message', { ...msg, mine: false });
        socket.to(`user:${me.id}`).emit('chat:message', { ...msg, mine: true });

        // Count the message toward any active roleplay; reveal the next stage
        // when both players have hit the threshold.
        applyRoleplayOutcome(io, me.id, to, roleplay.recordMessage(me.id, to));

        ack && ack({ ok: true, message: { ...msg, mine: true } });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // File share → RELAYED LIVE ONLY. The binary payload is never written to
    // disk or the database. If the recipient is offline it simply is not
    // delivered (nothing is stored for later).
    socket.on('chat:file', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const { name, mime, data } = payload || {};
        if (!to || !name || !data) return ack && ack({ error: 'Invalid file.' });

        // data is expected as an ArrayBuffer/Buffer from the client.
        const size = data.byteLength != null ? data.byteLength : (data.length || 0);
        if (size > config.maxChatFileBytes) {
          return ack && ack({ error: 'File exceeds the size limit.' });
        }
        if (areBlocked(me.id, to)) {
          return ack && ack({ error: 'You cannot share files with this user — a block is in place.' });
        }
        if (!isOnline(to)) {
          return ack && ack({ error: 'Recipient is offline. Files are only delivered live and are never stored.' });
        }

        const meta = {
          from: me.id,
          fromUsername: me.username,
          name: String(name).slice(0, 200),
          mime: String(mime || 'application/octet-stream').slice(0, 100),
          size,
          data, // relayed in-memory, then discarded
          at: Date.now(),
        };

        io.to(`user:${to}`).emit('chat:file', meta);
        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // Naughty gift → persisted like a message (kind='gift', body holds the
    // gift id) so it shows in history, then delivered live if online.
    socket.on('chat:gift', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const gift = getGift(payload && payload.gift);
        if (!to || !gift) return ack && ack({ error: 'Invalid gift.' });

        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });
        if (areBlocked(me.id, to)) {
          return ack && ack({ error: 'You cannot send a gift to this user — a block is in place.' });
        }

        const now = Date.now();
        const info = db
          .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at) VALUES (?, ?, ?, 'gift', ?)")
          .run(me.id, to, gift.id, now);

        const msg = { id: info.lastInsertRowid, from: me.id, to, body: gift.id, kind: 'gift', at: now };

        io.to(`user:${to}`).emit('chat:message', { ...msg, mine: false });
        socket.to(`user:${me.id}`).emit('chat:message', { ...msg, mine: true });

        ack && ack({ ok: true, message: { ...msg, mine: true } });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // Emoji reaction on a message (text/gift). Toggling: same emoji again
    // clears it, a different emoji replaces it. Broadcast to both users so all
    // tabs stay in sync.
    socket.on('chat:react', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const messageId = parseInt(payload && payload.messageId, 10);
        const emoji = String((payload && payload.emoji) || '');
        if (!to || !messageId || !REACTION_EMOJIS.has(emoji)) {
          return ack && ack({ error: 'Invalid reaction.' });
        }

        // The message must belong to this conversation.
        const msg = db
          .prepare('SELECT id FROM messages WHERE id = ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))')
          .get(messageId, me.id, to, to, me.id);
        if (!msg) return ack && ack({ error: 'Message not found.' });

        const existing = db.prepare('SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?').get(messageId, me.id);
        let resultEmoji;
        if (existing && existing.emoji === emoji) {
          db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, me.id);
          resultEmoji = null;
        } else if (existing) {
          db.prepare('UPDATE message_reactions SET emoji = ?, created_at = ? WHERE message_id = ? AND user_id = ?').run(emoji, Date.now(), messageId, me.id);
          resultEmoji = emoji;
        } else {
          db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').run(messageId, me.id, emoji, Date.now());
          resultEmoji = emoji;
        }

        const evt = { messageId, userId: me.id, emoji: resultEmoji };
        io.to(`user:${to}`).emit('chat:reaction', evt);
        io.to(`user:${me.id}`).emit('chat:reaction', evt);
        ack && ack({ ok: true, emoji: resultEmoji });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // Start (or restart) a roleplay with another user. Reveals the first
    // stage's narration to both.
    socket.on('roleplay:start', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const roleplayId = parseInt(payload && payload.roleplayId, 10);
        if (!to || !roleplayId) return ack && ack({ error: 'Invalid roleplay.' });

        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });
        if (areBlocked(me.id, to)) {
          return ack && ack({ error: 'You cannot start a roleplay — a block is in place.' });
        }

        const started = roleplay.startSession(roleplayId, me.id, to);
        if (started.error) return ack && ack({ error: started.error });

        deliverNarration(io, me.id, to,
          roleplay.stagePayload(started.roleplay, started.stageRow, 0, started.total, false));
        emitRoleplayProgress(io, me.id, to, started.session);

        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // Cancel the active roleplay with another user.
    socket.on('roleplay:stop', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        if (!to) return ack && ack({ error: 'Invalid request.' });
        const session = roleplay.stopSession(me.id, to);
        if (session) emitRoleplayProgress(io, me.id, to, session);
        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // Typing indicator (transient).
    socket.on('chat:typing', (payload) => {
      const to = parseInt(payload && payload.to, 10);
      if (to) io.to(`user:${to}`).emit('chat:typing', { from: me.id });
    });

    // "What are you doing" status for this conversation. An empty/blank activity
    // clears it. Persisted so it surfaces on the Recent Activity feed, and
    // pushed live to both users so the chat header stays in sync.
    socket.on('chat:activity', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        if (!to) return ack && ack({ error: 'Invalid request.' });
        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });

        // Accept either a predefined verb or a user's own custom activity.
        // Free text is trimmed, whitespace-collapsed and length-capped; the
        // feed renders it as plain text (textContent), so no markup can leak.
        const raw = String((payload && payload.activity) || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        const now = Date.now();
        if (!raw) {
          db.prepare('DELETE FROM chat_activities WHERE user_id = ? AND peer_id = ?').run(me.id, to);
        } else {
          db.prepare(
            `INSERT INTO chat_activities (user_id, peer_id, activity, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, peer_id) DO UPDATE SET activity = excluded.activity, updated_at = excluded.updated_at`
          ).run(me.id, to, raw, now);
        }

        const evt = { from: me.id, to, activity: raw };
        io.to(`user:${to}`).emit('chat:activity', evt);
        io.to(`user:${me.id}`).emit('chat:activity', evt);

        // Stream it live onto everyone's Recent Activity feed (same non-clickable
        // "<A> <activity> <B>" line the /api/events feed builds on reload).
        if (raw) {
          const nameOf = (uid) => {
            const r = db.prepare(
              'SELECT p.display_name, u.username FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?'
            ).get(uid);
            return r ? (r.display_name || r.username) : 'Someone';
          };
          io.emit('activity:new', {
            activity: raw,
            at: now,
            text: `${nameOf(me.id)} ${raw} ${nameOf(to)}`,
          });
        }

        ack && ack({ ok: true, activity: raw });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    socket.on('disconnect', () => {
      removeSocket(me.id, socket.id);
    });
  });
}

module.exports = { initSocket, isOnline };
