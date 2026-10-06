'use strict';

const cookie = require('cookie');
const db = require('./db');
const config = require('./config');
const { userFromToken, suspensionRemaining } = require('./auth');
const { areBlocked } = require('./relations');
const { getGift } = require('./gifts');
const polls = require('./polls');
const chatQuiz = require('./chatQuiz');
const { isCompatibility } = require('./quizTypes');
const { isValidActivity } = require('./activities');
const nsfw = require('./nsfw');

// Emoji reactions a user may place on a message/gift. Server-side allow-list so
// clients can't store arbitrary strings.
const REACTION_EMOJIS = new Set(['❤️', '😂', '😮', '😢', '🔥', '👍', '💡', '🙏']);

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

// The user ids of everyone `userId` has an accepted relationship with — the
// audience for their online/offline presence.
function friendIdsOf(userId) {
  return db
    .prepare(
      `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS fid
       FROM friendships
       WHERE (requester_id = ? OR addressee_id = ?) AND status = 'accepted'`
    )
    .all(userId, userId, userId)
    .map((r) => r.fid);
}

// Tell a user's friends/relations that they just came online or went offline,
// so open clients can flip the little presence dot live.
function broadcastPresence(io, userId, isOnlineNow) {
  friendIdsOf(userId).forEach((fid) => {
    io.to(`user:${fid}`).emit('presence:update', { userId, online: isOnlineNow });
  });
}

/* --------------------------------------------------------------------------
   Group-chat helpers
-------------------------------------------------------------------------- */

// The joined members of a group (the audience for any group message).
function groupJoinedIds(groupId) {
  return db
    .prepare("SELECT user_id FROM chat_group_members WHERE group_id = ? AND status = 'joined'")
    .all(groupId)
    .map((r) => r.user_id);
}

// True if any other joined member is blocked from / age-walled from `userId`.
function groupWalled(groupId, userId) {
  return groupJoinedIds(groupId).some((uid) => uid !== userId && areBlocked(userId, uid));
}

// Persist a group message of any kind (text | poll) and deliver it to
// every joined member (mine flag per recipient). Returns the new row id.
function deliverGroupMessage(io, groupId, senderId, kind, body) {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO group_messages (group_id, sender_id, body, kind, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(groupId, senderId, body, kind, now);
  const prof = db.prepare('SELECT display_name, avatar FROM profiles WHERE user_id = ?').get(senderId);
  const base = {
    id: info.lastInsertRowid,
    groupId,
    from: senderId,
    fromName: (prof && prof.display_name) || nameOf(senderId),
    fromAvatar: prof && prof.avatar ? `/uploads/${prof.avatar}` : null,
    body,
    kind,
    at: now,
  };
  groupJoinedIds(groupId).forEach((uid) =>
    io.to(`user:${uid}`).emit('group:message', { ...base, mine: uid === senderId }));
  return info.lastInsertRowid;
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
  } else if (row.kind === 'poll') {
    text = polls.pollLabel(polls.pollIdFromBody(row.body));
  } else if (row.kind === 'quiz') {
    text = chatQuiz.quizLabel(chatQuiz.chatQuizIdFromBody(row.body));
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

// Push a new Highway post to every online member for whom `canSee(userId)` is
// true. The client's `highway:new` handler prepends it to an open Highway feed.
function broadcastHighway(payload, canSee) {
  if (!ioRef) return;
  for (const userId of online.keys()) {
    if (!canSee || canSee(userId)) ioRef.to(`user:${userId}`).emit('highway:new', payload);
  }
}

// Someone liked/commented on a Highway post that was shared from a conversation.
// Surface it inside THAT chat for both participants as a persistent system card
// (kind='hwevent'), and push it live. `event` = { postId, image, origin:{a,b},
// action:'like'|'comment', byId, byName, text? }. No-op if the post isn't linked
// to a conversation.
function notifyHighwayEvent(event) {
  const o = event && event.origin;
  if (!o || !o.a || !o.b) return;
  const now = Date.now();
  const body = JSON.stringify({
    action: event.action,
    postId: event.postId,
    image: event.image || null,
    byId: event.byId,
    byName: event.byName || 'Someone',
    text: event.text || '',
  });
  const info = db
    .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at, expires_at) VALUES (?, ?, ?, 'hwevent', ?, NULL)")
    .run(o.a, o.b, body, now);
  const msg = { id: info.lastInsertRowid, from: o.a, to: o.b, body, kind: 'hwevent', at: now };
  if (ioRef) {
    ioRef.to(`user:${o.a}`).emit('chat:message', { ...msg, mine: true });
    ioRef.to(`user:${o.b}`).emit('chat:message', { ...msg, mine: false });
  }
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

// Tell every connected member to refresh their Notifications badge (e.g. a new
// quiz or poll was published).
function broadcastNotify() {
  if (ioRef) ioRef.emit('notify:new', { at: Date.now() });
}

// Tell every connected client that the leaderboard ranking may have shifted
// (a new rating, a new accepted friendship, …) so the UI can flag it as fresh.
function broadcastLeaderboardChange() {
  if (ioRef) ioRef.emit('leaderboard:changed', { at: Date.now() });
}

// Display name (or @username) for a user id.
function nameOf(uid) {
  const r = db
    .prepare('SELECT p.display_name, u.username FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?')
    .get(uid);
  return r ? (r.display_name || r.username) : 'Someone';
}

function initSocket(io) {
  ioRef = io;
  // Attach the user from the httpOnly auth cookie when present, but DO NOT
  // reject anonymous sockets: logged-out visitors get the live Recent Activity
  // feed on the sign-in page. socket.user is null for them, and every
  // private-chat handler below is gated behind an authenticated user.
  io.use((socket, next) => {
    try {
      const raw = socket.handshake.headers.cookie || '';
      const parsed = cookie.parse(raw);
      const user = userFromToken(parsed[config.cookieName]) || null;
      // A suspended account gets an anonymous socket (no private-chat handlers).
      socket.user = user && suspensionRemaining(user) === 0 ? user : null;
    } catch (_e) {
      socket.user = null;
    }
    next();
  });

  io.on('connection', (socket) => {
    const me = socket.user;

    // Anonymous sockets only receive public broadcasts (activity feed).
    if (!me) return;

    // Detect the offline→online transition (their first live tab) so we only
    // announce presence once, not on every extra tab they open.
    const wasOffline = !isOnline(me.id);
    addSocket(me.id, socket.id);
    // Personal room makes it easy to target all of a user's sockets.
    socket.join(`user:${me.id}`);
    if (wasOffline) broadcastPresence(io, me.id, true);

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
          return ack && ack({ error: 'You cannot message this user.' });
        }

        // Optional reply: only accept an id that belongs to THIS conversation.
        const replyTo = resolveReplyTo(payload && payload.replyTo, me.id, to);

        const now = Date.now();

        const info = db
          .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, reply_to, created_at, expires_at) VALUES (?, ?, ?, 'text', ?, ?, NULL)")
          .run(me.id, to, body, replyTo, now);

        // Reply target: normally another persisted message. A reply to a shared
        // FILE (which isn't in the DB) carries a client snapshot instead — the
        // quote is rendered live from it; reply_to stays NULL in the DB.
        let reply = replyPreview(replyTo);
        if (!reply && payload && payload.replyFile && typeof payload.replyFile.id === 'string') {
          const rf = payload.replyFile;
          const from = parseInt(rf.from, 10) === to ? to : me.id;
          reply = { id: rf.id.slice(0, 64), from, kind: 'file', text: String(rf.text || '📎 File').slice(0, 140) };
        }
        const msg = { id: info.lastInsertRowid, from: me.id, to, body, kind: 'text', at: now, replyTo, reply };

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
          return ack && ack({ error: 'You cannot share files with this user.' });
        }
        if (!isOnline(to)) {
          return ack && ack({ error: 'Recipient is offline. Files are only delivered live and are never stored.' });
        }

        // A short client-supplied id so both sides can reference the same file
        // (for replying to it and for the sender deleting it). Still nothing is
        // written to disk or the DB — only the live payload is relayed.
        const fid = typeof (payload && payload.id) === 'string'
          ? payload.id.slice(0, 64)
          : 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

        const meta = {
          id: fid,
          from: me.id,
          fromUsername: me.username,
          name: String(name).slice(0, 200),
          mime: String(mime || 'application/octet-stream').slice(0, 100),
          size,
          data, // relayed in-memory, then discarded
          at: Date.now(),
        };

        // Images and videos are checked for nudity before they're passed on.
        nsfw.checkBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data)).then((result) => {
          if (result.blocked) {
            const what = String(meta.mime).startsWith('video/') ? 'a video' : 'an image';
            return ack && ack({ error: nsfw.rejectionMessage(result, what) });
          }
          io.to(`user:${to}`).emit('chat:file', meta);
          ack && ack({ ok: true, id: fid });
        }, () => ack && ack({ error: 'Server error.' }));
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // The sender removes a file they shared. Files aren't stored, so this simply
    // relays a "remove that bubble" signal to the recipient's live sockets (and
    // the sender's other tabs). `from` is set by the server so a recipient can't
    // spoof it to wipe the sender's own copy.
    socket.on('chat:file:delete', (payload) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const id = payload && typeof payload.id === 'string' ? payload.id.slice(0, 64) : null;
        if (!to || !id) return;
        io.to(`user:${to}`).emit('chat:file:delete', { id, from: me.id });
        socket.to(`user:${me.id}`).emit('chat:file:delete', { id, from: me.id });
      } catch (_e) { /* best-effort */ }
    });

    // Gift → persisted like a message (kind='gift', body holds the
    // gift id) so it shows in history, then delivered live if online.
    socket.on('chat:gift', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const gift = getGift(payload && payload.gift);
        if (!to || !gift) return ack && ack({ error: 'Invalid gift.' });

        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });
        if (areBlocked(me.id, to)) {
          return ack && ack({ error: 'You cannot send a gift to this user.' });
        }

        const now = Date.now();
        const info = db
          .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at, expires_at) VALUES (?, ?, ?, 'gift', ?, NULL)")
          .run(me.id, to, gift.id, now);

        const msg = { id: info.lastInsertRowid, from: me.id, to, body: gift.id, kind: 'gift', at: now };

        io.to(`user:${to}`).emit('chat:message', { ...msg, mine: false });
        socket.to(`user:${me.id}`).emit('chat:message', { ...msg, mine: true });

        ack && ack({ ok: true, message: { ...msg, mine: true } });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    /* -------------------- Polls -------------------- */

    // Create a poll in a 1:1 chat ({ to, question, options, multi }) or a group
    // chat ({ groupId, ... }). The poll is delivered as a kind='poll' chat
    // message carrying its full payload.
    socket.on('poll:create', (payload, ack) => {
      try {
        const clean = polls.sanitize(payload);
        if (clean.error) return ack && ack({ error: clean.error });

        const groupId = parseInt(payload && payload.groupId, 10) || null;
        if (groupId) {
          const member = db
            .prepare("SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ? AND status = 'joined'")
            .get(groupId, me.id);
          if (!member) return ack && ack({ error: 'You are not a member of this group.' });
          if (groupWalled(groupId, me.id)) return ack && ack({ error: 'You cannot post in this group.' });

          const pollId = polls.createPoll({ creatorId: me.id, ...clean, groupId });
          const now = Date.now();
          const info = db
            .prepare("INSERT INTO group_messages (group_id, sender_id, body, kind, created_at) VALUES (?, ?, ?, 'poll', ?)")
            .run(groupId, me.id, JSON.stringify({ pollId }), now);
          polls.attachMessage(pollId, info.lastInsertRowid);

          const prof = db.prepare('SELECT display_name, avatar FROM profiles WHERE user_id = ?').get(me.id);
          const base = {
            id: info.lastInsertRowid,
            groupId,
            from: me.id,
            fromName: (prof && prof.display_name) || nameOf(me.id),
            fromAvatar: prof && prof.avatar ? `/uploads/${prof.avatar}` : null,
            kind: 'poll',
            at: now,
          };
          groupJoinedIds(groupId).forEach((uid) =>
            io.to(`user:${uid}`).emit('group:message', { ...base, mine: uid === me.id, poll: polls.pollPayload(pollId, uid) }));
          return ack && ack({ ok: true });
        }

        const to = parseInt(payload && payload.to, 10);
        if (!to) return ack && ack({ error: 'Invalid recipient.' });
        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });
        if (areBlocked(me.id, to)) {
          return ack && ack({ error: 'You cannot send a poll to this user.' });
        }

        const pollId = polls.createPoll({ creatorId: me.id, ...clean, dmA: me.id, dmB: to });
        const now = Date.now();
        const info = db
          .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at, expires_at) VALUES (?, ?, ?, 'poll', ?, NULL)")
          .run(me.id, to, JSON.stringify({ pollId }), now);
        polls.attachMessage(pollId, info.lastInsertRowid);

        const base = { id: info.lastInsertRowid, from: me.id, to, kind: 'poll', at: now };
        io.to(`user:${to}`).emit('chat:message', { ...base, mine: false, poll: polls.pollPayload(pollId, to) });
        io.to(`user:${me.id}`).emit('chat:message', { ...base, mine: true, poll: polls.pollPayload(pollId, me.id) });

        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // Cast / toggle a vote. Broadcasts the updated tallies to every participant;
    // the voter's ack carries their own (viewer-tailored) payload.
    socket.on('poll:vote', (payload, ack) => {
      try {
        const pollId = parseInt(payload && payload.pollId, 10);
        const option = parseInt(payload && payload.option, 10);
        const poll = polls.getPoll(pollId);
        if (!poll) return ack && ack({ error: 'Poll not found.' });
        if (!polls.canParticipate(poll, me.id)) return ack && ack({ error: 'You cannot vote on this poll.' });

        const out = polls.vote(poll, me.id, option);
        if (out.error) return ack && ack({ error: out.error });

        // Recipients get the shared tallies; each client keeps its own myVotes.
        const recipients = poll.scope === 'group'
          ? groupJoinedIds(poll.group_id)
          : [poll.dm_a, poll.dm_b];
        recipients.forEach((uid) =>
          io.to(`user:${uid}`).emit('poll:update', { pollId, poll: polls.pollPayload(pollId, uid) }));

        ack && ack({ ok: true, poll: polls.pollPayload(pollId, me.id) });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    /* -------------------- Quizzes (attempt together) -------------------- */

    // Start a quiz in a 1:1 chat ({ to, quizId }). Delivered as a kind='quiz'
    // chat message; both participants then answer it and, once both are done,
    // see a compatibility result.
    socket.on('quiz:start', (payload, ack) => {
      try {
        const to = parseInt(payload && payload.to, 10);
        const quizId = parseInt(payload && payload.quizId, 10);
        if (!to || !quizId) return ack && ack({ error: 'Invalid quiz.' });
        const recipient = db.prepare('SELECT id FROM users WHERE id = ?').get(to);
        if (!recipient) return ack && ack({ error: 'Recipient not found.' });
        if (areBlocked(me.id, to)) {
          return ack && ack({ error: 'You cannot start a quiz with this user.' });
        }
        const quiz = db.prepare('SELECT id, questions, type FROM quizzes WHERE id = ?').get(quizId);
        if (!quiz) return ack && ack({ error: 'Quiz not found.' });
        if (!isCompatibility(quiz.type)) return ack && ack({ error: 'Only compatibility quizzes can be played together in chat.' });
        let qcount = 0;
        try { qcount = (JSON.parse(quiz.questions) || []).length; } catch (_e) {}
        if (!qcount) return ack && ack({ error: 'This quiz has no questions.' });

        const chatQuizId = chatQuiz.startSession({ quizId, creatorId: me.id, dmA: me.id, dmB: to });
        const now = Date.now();
        const info = db
          .prepare("INSERT INTO messages (sender_id, recipient_id, body, kind, created_at, expires_at) VALUES (?, ?, ?, 'quiz', ?, NULL)")
          .run(me.id, to, JSON.stringify({ chatQuizId }), now);
        chatQuiz.attachMessage(chatQuizId, info.lastInsertRowid);

        const base = { id: info.lastInsertRowid, from: me.id, to, kind: 'quiz', at: now };
        io.to(`user:${to}`).emit('chat:message', { ...base, mine: false, quiz: chatQuiz.sessionPayload(chatQuizId, to) });
        io.to(`user:${me.id}`).emit('chat:message', { ...base, mine: true, quiz: chatQuiz.sessionPayload(chatQuizId, me.id) });

        ack && ack({ ok: true });
      } catch (e) {
        ack && ack({ error: 'Server error.' });
      }
    });

    // Submit my answers for a chat quiz. Pushes an updated (viewer-tailored)
    // payload to both participants — revealing the comparison once both are in.
    socket.on('quiz:answer', (payload, ack) => {
      try {
        const chatQuizId = parseInt(payload && payload.chatQuizId, 10);
        const session = chatQuiz.getSession(chatQuizId);
        if (!session) return ack && ack({ error: 'Quiz not found.' });
        if (!chatQuiz.canParticipate(session, me.id)) return ack && ack({ error: 'You cannot answer this quiz.' });

        const out = chatQuiz.submitAnswers(session, me.id, payload && payload.answers);
        if (out.error) return ack && ack({ error: out.error });

        [session.dm_a, session.dm_b].forEach((uid) =>
          io.to(`user:${uid}`).emit('quiz:update', { chatQuizId, quiz: chatQuiz.sessionPayload(chatQuizId, uid) }));

        ack && ack({ ok: true, quiz: chatQuiz.sessionPayload(chatQuizId, me.id) });
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

    // Typing indicator (transient).
    socket.on('chat:typing', (payload) => {
      const to = parseInt(payload && payload.to, 10);
      if (to && !areBlocked(me.id, to)) io.to(`user:${to}`).emit('chat:typing', { from: me.id });
    });

    /* ----------------------------------------------------------------
       Screen sharing (browser-tab only) — WebRTC signaling relay.

       The media itself is peer-to-peer (RTCPeerConnection); the server
       only shuttles the offer/answer/ICE between the two chat partners
       and never sees the stream. The sharer's client enforces that only
       a browser TAB can be captured (it rejects any window/monitor
       surface), so nothing else is shareable. Each relay is a thin
       forward to the recipient's room, gated by the same block check as
       chat so a blocked user can't push a connection request.
    ---------------------------------------------------------------- */
    const relayScreen = (payload, event) => {
      const to = parseInt(payload && payload.to, 10);
      if (!to) return;
      if (areBlocked(me.id, to)) return;
      const out = { from: me.id };
      if (payload.sdp) out.sdp = payload.sdp;
      if (payload.candidate) out.candidate = payload.candidate;
      io.to(`user:${to}`).emit(event, out);
    };
    socket.on('screen:offer', (payload) => relayScreen(payload, 'screen:offer'));
    socket.on('screen:answer', (payload) => relayScreen(payload, 'screen:answer'));
    socket.on('screen:ice', (payload) => relayScreen(payload, 'screen:ice'));
    socket.on('screen:stop', (payload) => relayScreen(payload, 'screen:stop'));

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
        if (groupWalled(groupId, me.id)) return ack && ack({ error: 'You cannot post in this group.' });

        deliverGroupMessage(io, groupId, me.id, 'text', body);

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
        if (areBlocked(me.id, to)) return ack && ack({ error: 'You cannot set an activity with this member.' });

        // Only the predefined verbs (src/activities.js) are accepted — no free
        // text, since the activity is shown on the public feed.
        const raw = String((payload && payload.activity) || '').trim();
        if (raw && !isValidActivity(raw)) return ack && ack({ error: 'Pick an activity from the list.' });
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
      // time so the daily digest knows which later messages went unseen.
      if (!isOnline(me.id)) {
        try {
          db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), me.id);
        } catch (_e) { /* non-fatal */ }
        broadcastPresence(io, me.id, false); // tell friends they went offline
      }
    });
  });
}

module.exports = { initSocket, isOnline, broadcastActivity, broadcastHighway, notifyHighwayEvent, notifyGroup, notifyUser, broadcastLeaderboardChange, broadcastNotify };
