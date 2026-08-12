'use strict';

const cookie = require('cookie');
const db = require('./db');
const config = require('./config');
const { userFromToken } = require('./auth');
const { areBlocked } = require('./relations');
const { getGift } = require('./gifts');

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

        const now = Date.now();
        const info = db
          .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at) VALUES (?, ?, ?, 'text', ?)")
          .run(me.id, to, body, now);

        const msg = { id: info.lastInsertRowid, from: me.id, to, body, kind: 'text', at: now };

        // Deliver to recipient's sockets and echo to sender's other tabs.
        io.to(`user:${to}`).emit('chat:message', { ...msg, mine: false });
        socket.to(`user:${me.id}`).emit('chat:message', { ...msg, mine: true });

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

    // Typing indicator (transient).
    socket.on('chat:typing', (payload) => {
      const to = parseInt(payload && payload.to, 10);
      if (to) io.to(`user:${to}`).emit('chat:typing', { from: me.id });
    });

    socket.on('disconnect', () => {
      removeSocket(me.id, socket.id);
    });
  });
}

module.exports = { initSocket, isOnline };
