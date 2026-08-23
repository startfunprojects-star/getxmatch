'use strict';

const cookie = require('cookie');
const db = require('./db');
const config = require('./config');
const { userFromToken } = require('./auth');
const { areBlocked } = require('./relations');
const { getGift } = require('./gifts');
const wasted = require('./wasted');
const roleplay = require('./roleplay');
const broadcast = require('./broadcast');

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
   Disappearing-messages helpers
-------------------------------------------------------------------------- */

// Normalize a pair of user ids so a conversation has one canonical key
// regardless of who is the sender.
function pairKey(a, b) {
  return a < b ? { lo: a, hi: b } : { lo: b, hi: a };
}

// The disappearing-messages TTL (in seconds) armed for a conversation, or 0
// when it's off. Either participant's setting applies to the whole pair.
function convoTtl(a, b) {
  const { lo, hi } = pairKey(a, b);
  const row = db.prepare('SELECT ttl_seconds FROM chat_settings WHERE user_lo = ? AND user_hi = ?').get(lo, hi);
  return row && row.ttl_seconds > 0 ? row.ttl_seconds : 0;
}

// Given a conversation's two ids, the epoch-ms a message sent now should
// expire at, or null when disappearing is off.
function expiryFor(a, b) {
  const ttl = convoTtl(a, b);
  return ttl > 0 ? Date.now() + ttl * 1000 : null;
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
  // Mirror roleplay narration to broadcast watchers, if any.
  mirrorLiveMessage(io, a, b, 'narration', body, now);
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
   "Wasted" helpers
-------------------------------------------------------------------------- */

// Tell a user (all their tabs) their current wasted score, so the UI can show
// the meter and gate sending once they hit the cap.
function emitWastedScore(io, userId, score) {
  io.to(`user:${userId}`).emit('wasted:score', {
    userId,
    score: Math.round(score * 100) / 100,
    max: wasted.MAX_SCORE,
    maxed: wasted.isMaxed(score),
  });
}

// Persist and deliver an offer/self-take as a kind='offer' message. The body is
// a JSON payload { item, status, by }: status is 'pending' (awaiting the
// recipient), 'accepted', 'rejected', or 'self' (the sender took it alone).
function deliverOffer(io, from, to, payload) {
  const now = Date.now();
  const body = JSON.stringify(payload);
  const info = db
    .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at, expires_at) VALUES (?, ?, ?, 'offer', ?, NULL)")
    .run(from, to, body, now);
  const msg = { id: info.lastInsertRowid, from, to, body, kind: 'offer', at: now };
  io.to(`user:${to}`).emit('chat:message', { ...msg, mine: false });
  io.to(`user:${from}`).emit('chat:message', { ...msg, mine: true });
  mirrorLiveMessage(io, from, to, 'offer', body, now);
  return info.lastInsertRowid;
}

// Persist and deliver an admin "wasted" sentence as a permanent system message
// visible to both users. expires_at is left NULL so it never disappears.
function deliverWastedSentence(io, a, b, sentence) {
  const now = Date.now();
  const info = db
    .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at, expires_at) VALUES (?, ?, ?, 'wasted', ?, NULL)")
    .run(a, b, sentence, now);
  const msg = { id: info.lastInsertRowid, from: a, to: b, body: sentence, kind: 'wasted', at: now };
  io.to(`user:${a}`).emit('chat:message', { ...msg, mine: false });
  io.to(`user:${b}`).emit('chat:message', { ...msg, mine: false });
  mirrorLiveMessage(io, a, b, 'wasted', sentence, now);
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
  } else if (row.kind === 'offer') {
    text = '🥂 Wasted';
  }
  return { id: row.id, from: row.sender_id, kind: row.kind || 'text', text: String(text).slice(0, 140) };
}

// Reference to the live Server, set on init, so HTTP routes can broadcast onto
// the Recent Activity feed (e.g. a shared image) without importing server.js.
let ioRef = null;

// Broadcast a ready-to-render feed item to every connected client. The client's
// `activity:new` handler inserts it at the top of any open activity feed.
function broadcastActivity(payload) {
  if (ioRef) ioRef.emit('activity:new', payload);
}

// Broadcast a new Highway post to every connected client. The client's
// `highway:new` handler prepends it to an open Highway feed.
function broadcastHighway(payload) {
  if (ioRef) ioRef.emit('highway:new', payload);
}

// Tell the given users that a group they're in changed (created, invited,
// joined, left) so their UI can refetch. Used by the groups HTTP routes.
function notifyGroup(userIds, groupId) {
  if (!ioRef || !Array.isArray(userIds)) return;
  userIds.forEach((uid) => ioRef.to(`user:${uid}`).emit('group:changed', { groupId }));
}

// Emit an event to every socket of a single user (all their open tabs). Used by
// HTTP routes to push a live notification — e.g. a new friend request landing.
function notifyUser(userId, event, payload) {
  if (!ioRef || !userId) return;
  ioRef.to(`user:${userId}`).emit(event, payload || {});
}

// Tell every connected client that the leaderboard ranking may have shifted
// (a new rating, a new accepted friendship, …) so the UI can flag it as fresh.
function broadcastLeaderboardChange() {
  if (ioRef) ioRef.emit('leaderboard:changed', { at: Date.now() });
}

/* --------------------------------------------------------------------------
   Broadcast ("live chat") helpers
-------------------------------------------------------------------------- */

let commentSeq = 0;

function broadcastRoom(token) {
  return `bcast:${token}`;
}

// Display name (or @username) for a user id — used to label broadcast messages
// and comments without leaking anything private.
function nameOf(uid) {
  const r = db
    .prepare('SELECT p.display_name, u.username FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?')
    .get(uid);
  return r ? (r.display_name || r.username) : 'Someone';
}

// Render a stored message row into the viewer-safe shape sent to watchers.
function broadcastMessageView(row) {
  const kind = row.kind || 'text';
  let text = row.body;
  if (kind === 'gift') {
    const g = getGift(row.body);
    text = g ? `${g.emoji} ${g.name}` : '🎁 a gift';
  } else if (kind === 'narration') {
    try {
      const p = JSON.parse(row.body);
      text = p.final ? '🎬 The End' : `🎭 ${p.title || 'Roleplay'}`;
    } catch (_e) { text = '🎭 Roleplay'; }
  } else if (kind === 'offer') {
    try {
      const o = JSON.parse(row.body);
      const it = wasted.getItem(o.item);
      text = it ? `🥂 ${it.emoji} ${it.label}` : '🥂 Wasted';
    } catch (_e) { text = '🥂 Wasted'; }
  }
  return { from: row.sender_id, fromName: nameOf(row.sender_id), kind, text, at: row.created_at };
}

// The conversation, from the broadcast's start onward (older, pre-broadcast
// history is deliberately withheld from viewers).
function recentBroadcastMessages(b) {
  const rows = db
    .prepare(
      `SELECT id, sender_id, body, kind, created_at FROM messages
        WHERE created_at >= ?
          AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
        ORDER BY created_at ASC LIMIT 60`
    )
    .all(b.startedAt, b.ownerId, b.peerId, b.peerId, b.ownerId);
  return rows.map(broadcastMessageView);
}

// Push the current viewer count to the watch room AND to both participants
// (who watch the count from inside their private chat).
function emitViewerCount(io, b) {
  const evt = { token: b.token, count: b.viewers.size };
  io.to(broadcastRoom(b.token)).emit('broadcast:viewers', evt);
  io.to(`user:${b.ownerId}`).emit('broadcast:viewers', evt);
  io.to(`user:${b.peerId}`).emit('broadcast:viewers', evt);
}

// If the pair (from -> to) is being broadcast, mirror a just-sent message to
// everyone watching. kind is 'text' | 'gift' | 'narration'; body is the raw
// stored value (gift id / narration JSON / text).
function mirrorLiveMessage(io, from, to, kind, body, at) {
  const b = broadcast.forPair(from, to);
  if (!b) return;
  let text = body;
  if (kind === 'gift') {
    const g = getGift(body);
    text = g ? `${g.emoji} ${g.name}` : '🎁 a gift';
  } else if (kind === 'narration') {
    try {
      const p = JSON.parse(body);
      text = p.final ? '🎬 The End' : `🎭 ${p.title || 'Roleplay'}`;
    } catch (_e) { text = '🎭 Roleplay'; }
  } else if (kind === 'offer') {
    try {
      const o = JSON.parse(body);
      const it = wasted.getItem(o.item);
      text = it ? `🥂 ${it.emoji} ${it.label}` : '🥂 Wasted';
    } catch (_e) { text = '🥂 Wasted'; }
  }
  io.to(broadcastRoom(b.token)).emit('broadcast:message', {
    from, fromName: nameOf(from), kind, text, at,
  });
}

// Tear down a broadcast and tell watchers + participants it's over.
function endBroadcast(io, b) {
  if (!b) return;
  broadcast.stop(b.token);
  const room = broadcastRoom(b.token);
  io.to(room).emit('broadcast:ended', { token: b.token });
  io.to(`user:${b.ownerId}`).emit('broadcast:ended', { token: b.token });
  io.to(`user:${b.peerId}`).emit('broadcast:ended', { token: b.token });
  io.emit('broadcast:listChanged', { at: Date.now() });
}

// Remove a watching socket from a broadcast and refresh the viewer count.
function leaveWatch(io, socket, token) {
  if (!token) return;
  socket.leave(broadcastRoom(token));
  if (socket.data) socket.data.watching = null;
  const b = broadcast.get(token);
  if (b) {
    b.viewers.delete(socket.id);
    b.lastComment.delete(socket.id);
    emitViewerCount(io, b);
  }
}

// Viewer-side handlers — available to EVERY socket, including anonymous
// (logged-out) visitors watching the public /live pages.
function registerBroadcastViewer(io, socket) {
  const me = socket.user; // may be null (anonymous)
  if (!socket.data) socket.data = {};

  socket.on('broadcast:watch', (payload, ack) => {
    try {
      const token = String((payload && payload.token) || '');
      const b = broadcast.get(token);
      if (!b) return ack && ack({ error: 'This broadcast has ended.' });
      // Leave any previous broadcast this socket was watching.
      if (socket.data.watching && socket.data.watching !== token) {
        leaveWatch(io, socket, socket.data.watching);
      }
      socket.join(broadcastRoom(token));
      b.viewers.add(socket.id);
      socket.data.watching = token;
      emitViewerCount(io, b);
      ack && ack({ ok: true, info: broadcast.publicView(b), messages: recentBroadcastMessages(b) });
    } catch (_e) {
      ack && ack({ error: 'Server error.' });
    }
  });

  socket.on('broadcast:unwatch', (payload, ack) => {
    const token = String((payload && payload.token) || socket.data.watching || '');
    leaveWatch(io, socket, token);
    ack && ack && ack({ ok: true });
  });

  // A flying comment from a watcher (or a participant). Ephemeral — never
  // stored; relayed to the room and to both participants for 10s of on-screen
  // life (the client removes it).
  socket.on('broadcast:comment', (payload, ack) => {
    try {
      const token = String((payload && payload.token) || '');
      const b = broadcast.get(token);
      if (!b) return ack && ack({ error: 'This broadcast has ended.' });
      const text = String((payload && payload.text) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) return ack && ack({ error: 'Say something first.' });

      // Lightweight per-socket rate limit.
      const now = Date.now();
      const last = b.lastComment.get(socket.id) || 0;
      if (now - last < 700) return ack && ack({ error: 'Slow down a moment.' });
      b.lastComment.set(socket.id, now);

      let name;
      if (me) {
        name = nameOf(me.id);
      } else {
        name = String((payload && payload.guestName) || '')
          .replace(/\s+/g, ' ').trim().slice(0, 24) || 'Guest';
      }
      const comment = { id: `c${++commentSeq}`, token, name, text, at: now, guest: !me };
      io.to(broadcastRoom(token)).emit('broadcast:comment', comment);
      // Participants aren't in the watch room; deliver to their private tabs.
      io.to(`user:${b.ownerId}`).emit('broadcast:comment', comment);
      io.to(`user:${b.peerId}`).emit('broadcast:comment', comment);
      ack && ack({ ok: true });
    } catch (_e) {
      ack && ack({ error: 'Server error.' });
    }
  });

  socket.on('disconnect', () => {
    if (socket.data && socket.data.watching) leaveWatch(io, socket, socket.data.watching);
  });
}

// Owner-side controls — only wired for authenticated sockets.
function registerBroadcastOwner(io, socket) {
  const me = socket.user;

  socket.on('broadcast:start', (payload, ack) => {
    try {
      const to = parseInt(payload && payload.peerId, 10);
      if (!to || to === me.id) return ack && ack({ error: 'Invalid chat to broadcast.' });
      const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
      if (!recipient) return ack && ack({ error: 'Recipient not found.' });
      if (areBlocked(me.id, to)) return ack && ack({ error: 'You cannot broadcast this chat.' });

      const title = String((payload && payload.title) || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const b = broadcast.start({
        ownerId: me.id, ownerName: nameOf(me.id), peerId: to, peerName: nameOf(to), title,
      });
      const view = broadcast.publicView(b);
      io.to(`user:${me.id}`).emit('broadcast:live', view);
      io.to(`user:${to}`).emit('broadcast:live', view);
      io.emit('broadcast:listChanged', { at: Date.now() });
      ack && ack({ ok: true, broadcast: view });
    } catch (_e) {
      ack && ack({ error: 'Server error.' });
    }
  });

  socket.on('broadcast:stop', (payload, ack) => {
    try {
      const token = String((payload && payload.token) || '');
      const b = broadcast.get(token);
      if (!b) return ack && ack({ ok: true });
      if (!broadcast.isParticipant(b, me.id)) return ack && ack({ error: 'Not your broadcast.' });
      endBroadcast(io, b);
      ack && ack({ ok: true });
    } catch (_e) {
      ack && ack({ error: 'Server error.' });
    }
  });
}

// Periodically delete messages whose disappearing-messages TTL has elapsed and
// tell both participants which bubble ids vanished so their UIs can drop them.
function startExpirySweeper(io) {
  setInterval(() => {
    try {
      const now = Date.now();
      const rows = db
        .prepare('SELECT id, sender_id, recipient_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?')
        .all(now);
      if (!rows.length) return;
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
      // Fan the vanished ids out to each affected user (sender + recipient).
      const byUser = new Map();
      for (const r of rows) {
        for (const uid of [r.sender_id, r.recipient_id]) {
          if (!byUser.has(uid)) byUser.set(uid, []);
          byUser.get(uid).push(r.id);
        }
      }
      byUser.forEach((idList, uid) => io.to(`user:${uid}`).emit('chat:expire', { ids: idList }));
    } catch (_e) { /* non-fatal */ }
  }, 2000);
}

function initSocket(io) {
  ioRef = io;
  startExpirySweeper(io);
  // Attach the user from the httpOnly auth cookie when present, but DO NOT
  // reject anonymous sockets: logged-out visitors need a live socket to watch
  // and comment on public broadcasts. socket.user is null for them, and every
  // private-chat handler below is gated behind an authenticated user.
  io.use((socket, next) => {
    try {
      const raw = socket.handshake.headers.cookie || '';
      const parsed = cookie.parse(raw);
      socket.user = userFromToken(parsed[config.cookieName]) || null;
    } catch (_e) {
      socket.user = null;
    }
    next();
  });

  io.on('connection', (socket) => {
    const me = socket.user;

    // Watching/commenting on broadcasts is open to everyone (incl. anonymous).
    registerBroadcastViewer(io, socket);

    // Anonymous sockets get nothing more than the viewer handlers above.
    if (!me) return;

    addSocket(me.id, socket.id);
    // Personal room makes it easy to target all of a user's sockets.
    socket.join(`user:${me.id}`);

    // Owner controls for starting/stopping a broadcast of a private chat.
    registerBroadcastOwner(io, socket);

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
        const expiresAt = expiryFor(me.id, to);

        // "Wasted": at the cap the message becomes "Completely Wasted"; below it
        // random words may be spliced in. The stored/delivered body is the
        // transformed one, so both users (and the sender's echo) see the same.
        const senderScore = wasted.getScore(me.id, now);
        const outBody = wasted.transformOutgoing(body, senderScore);

        const info = db
          .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, reply_to, created_at, expires_at) VALUES (?, ?, ?, 'text', ?, ?, ?)")
          .run(me.id, to, outBody, replyTo, now, expiresAt);

        const reply = replyPreview(replyTo);
        const msg = { id: info.lastInsertRowid, from: me.id, to, body: outBody, kind: 'text', at: now, replyTo, reply, expiresAt };

        // Deliver to recipient's sockets and echo to sender's other tabs.
        io.to(`user:${to}`).emit('chat:message', { ...msg, mine: false });
        socket.to(`user:${me.id}`).emit('chat:message', { ...msg, mine: true });

        // If this conversation is being broadcast, mirror it to watchers.
        mirrorLiveMessage(io, me.id, to, 'text', outBody, now);

        // Count the message toward any active roleplay; reveal the next stage
        // when both players have hit the threshold.
        applyRoleplayOutcome(io, me.id, to, roleplay.recordMessage(me.id, to));

        // Keep the sender's wasted meter fresh, and occasionally interrupt the
        // chat with a random admin "wasted" sentence (a permanent message).
        emitWastedScore(io, me.id, senderScore);
        const sentence = wasted.maybeSentence();
        if (sentence) deliverWastedSentence(io, me.id, to, sentence);

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

    // Arm / disarm disappearing messages for a conversation. seconds > 0 turns
    // it on (every subsequent message self-destructs after that many seconds);
    // 0 turns it off. Applies to the pair — either participant can change it —
    // and both are notified so their UI stays in sync.
    socket.on('chat:disappearing', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        if (!to) return ack && ack({ error: 'Invalid request.' });
        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });
        if (areBlocked(me.id, to)) {
          return ack && ack({ error: 'You cannot change this chat — a block is in place.' });
        }

        // Clamp to 5 seconds .. 24 hours; 0 disables.
        let seconds = Math.floor(Number(payload && payload.seconds) || 0);
        if (seconds < 0) seconds = 0;
        if (seconds > 0 && seconds < 5) seconds = 5;
        if (seconds > 86400) seconds = 86400;

        const { lo, hi } = pairKey(me.id, to);
        const now = Date.now();
        if (seconds === 0) {
          db.prepare('DELETE FROM chat_settings WHERE user_lo = ? AND user_hi = ?').run(lo, hi);
        } else {
          db.prepare(
            `INSERT INTO chat_settings (user_lo, user_hi, ttl_seconds, set_by, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_lo, user_hi) DO UPDATE SET ttl_seconds = excluded.ttl_seconds, set_by = excluded.set_by, updated_at = excluded.updated_at`
          ).run(lo, hi, seconds, me.id, now);
        }

        const evt = { from: me.id, to, seconds };
        io.to(`user:${to}`).emit('chat:disappearing', evt);
        io.to(`user:${me.id}`).emit('chat:disappearing', evt);
        ack && ack({ ok: true, seconds });
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
        const expiresAt = expiryFor(me.id, to);
        const info = db
          .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at, expires_at) VALUES (?, ?, ?, 'gift', ?, ?)")
          .run(me.id, to, gift.id, now, expiresAt);

        const msg = { id: info.lastInsertRowid, from: me.id, to, body: gift.id, kind: 'gift', at: now, expiresAt };

        io.to(`user:${to}`).emit('chat:message', { ...msg, mine: false });
        socket.to(`user:${me.id}`).emit('chat:message', { ...msg, mine: true });

        // Mirror the gift to any watchers of this broadcast.
        mirrorLiveMessage(io, me.id, to, 'gift', gift.id, now);

        ack && ack({ ok: true, message: { ...msg, mine: true } });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    /* -------------------- "Wasted" offers -------------------- */

    // Offer a drink/substance to the other user. They can accept or reject.
    socket.on('wasted:offer', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const item = wasted.getItem(payload && payload.item);
        if (!to || !item) return ack && ack({ error: 'Invalid offer.' });
        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });
        if (areBlocked(me.id, to)) {
          return ack && ack({ error: 'You cannot offer this user anything — a block is in place.' });
        }
        const id = deliverOffer(io, me.id, to, { item: item.id, status: 'pending', by: me.id });
        ack && ack({ ok: true, id });
      } catch (_e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // Take a drink/substance yourself. Consumes immediately (no acceptance) and
    // raises your own wasted score.
    socket.on('wasted:self', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const item = wasted.getItem(payload && payload.item);
        if (!to || !item) return ack && ack({ error: 'Invalid request.' });
        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });

        deliverOffer(io, me.id, to, { item: item.id, status: 'self', by: me.id });
        const score = wasted.consume(me.id);
        emitWastedScore(io, me.id, score);
        ack && ack({ ok: true, score });
      } catch (_e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // Respond to a pending offer aimed at me: accept (consume + raise my score)
    // or reject. Only the recipient of the offer may respond.
    socket.on('wasted:respond', (payload, ack) => {
      try {
        const messageId = parseInt(payload && payload.messageId, 10);
        const accept = !!(payload && payload.accept);
        if (!messageId) return ack && ack({ error: 'Invalid response.' });

        const row = db
          .prepare("SELECT id, sender_id, recipient_id, body FROM messages WHERE id = ? AND kind = 'offer'")
          .get(messageId);
        if (!row) return ack && ack({ error: 'Offer not found.' });
        if (row.recipient_id !== me.id) return ack && ack({ error: 'This offer is not for you.' });

        let data;
        try { data = JSON.parse(row.body); } catch (_e) { data = {}; }
        if (data.status !== 'pending') return ack && ack({ error: 'This offer was already answered.' });

        data.status = accept ? 'accepted' : 'rejected';
        db.prepare('UPDATE messages SET body = ? WHERE id = ?').run(JSON.stringify(data), row.id);

        const evt = { id: row.id, status: data.status };
        io.to(`user:${row.sender_id}`).emit('wasted:update', evt);
        io.to(`user:${row.recipient_id}`).emit('wasted:update', evt);

        if (accept) {
          const score = wasted.consume(me.id);
          emitWastedScore(io, me.id, score);
          return ack && ack({ ok: true, score });
        }
        ack && ack({ ok: true });
      } catch (_e) {
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

    // Group chat message → stored, then delivered live to every joined member.
    socket.on('group:message', (payload, ack) => {
      try {
        const groupId = parseInt(payload && payload.groupId, 10);
        const body = (payload && typeof payload.body === 'string' ? payload.body : '').trim();
        if (!groupId || !body) return ack && ack({ error: 'Invalid message.' });
        if (body.length > 4000) return ack && ack({ error: 'Message too long.' });

        const mine = db
          .prepare("SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ? AND status = 'joined'")
          .get(groupId, me.id);
        if (!mine) return ack && ack({ error: 'You are not a member of this group.' });

        const now = Date.now();
        const info = db
          .prepare('INSERT INTO group_messages (group_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)')
          .run(groupId, me.id, body, now);

        const prof = db.prepare('SELECT display_name, avatar FROM profiles WHERE user_id = ?').get(me.id);
        const base = {
          id: info.lastInsertRowid,
          groupId,
          from: me.id,
          fromName: (prof && prof.display_name) || me.username,
          fromAvatar: prof && prof.avatar ? `/uploads/${prof.avatar}` : null,
          body,
          at: now,
        };

        const members = db
          .prepare("SELECT user_id FROM chat_group_members WHERE group_id = ? AND status = 'joined'")
          .all(groupId);
        members.forEach((m) => {
          io.to(`user:${m.user_id}`).emit('group:message', { ...base, mine: m.user_id === me.id });
        });

        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
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
      // When the user's last tab disconnects they're fully offline: stamp the
      // time so the daily digest knows which later messages went unseen, and
      // end any broadcast they were a participant of (no ghost live chats).
      if (!isOnline(me.id)) {
        try {
          db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), me.id);
        } catch (_e) { /* non-fatal */ }
        try {
          broadcast.stopForUser(me.id).forEach((b) => {
            const room = broadcastRoom(b.token);
            io.to(room).emit('broadcast:ended', { token: b.token });
            io.to(`user:${b.ownerId}`).emit('broadcast:ended', { token: b.token });
            io.to(`user:${b.peerId}`).emit('broadcast:ended', { token: b.token });
          });
          io.emit('broadcast:listChanged', { at: Date.now() });
        } catch (_e) { /* non-fatal */ }
      }
    });
  });
}

module.exports = { initSocket, isOnline, broadcastActivity, broadcastHighway, notifyGroup, notifyUser, broadcastLeaderboardChange };
