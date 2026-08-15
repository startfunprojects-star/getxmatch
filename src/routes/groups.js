'use strict';

// Group chats: 2–4 members, joined by invitation + acceptance. Text messages
// (sent over the socket as `group:message`) are stored in group_messages. Only
// people you're already connected with (accepted friendship of any kind) can be
// invited, and a group can never exceed MAX_MEMBERS people (joined + invited).

const express = require('express');

const db = require('../db');
const { requireAuth } = require('../auth');
const { notifyGroup } = require('../socket');

const router = express.Router();

const MAX_MEMBERS = 4;

function areConnected(a, b) {
  return !!db
    .prepare(
      `SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
    )
    .get(a, b, b, a);
}

// A group's members with profile bits and status, ordered joined-first.
function membersOf(groupId) {
  return db
    .prepare(
      `SELECT m.user_id AS id, m.status, u.username, p.display_name, p.avatar
       FROM chat_group_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN profiles p ON p.user_id = m.user_id
       WHERE m.group_id = ?
       ORDER BY (m.status = 'joined') DESC, m.created_at ASC`
    )
    .all(groupId)
    .map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
      status: r.status,
    }));
}

// Total people occupying a group (joined + still-pending invites).
function occupancy(groupId) {
  return db
    .prepare("SELECT COUNT(*) AS n FROM chat_group_members WHERE group_id = ?")
    .get(groupId).n;
}

function myStatus(groupId, userId) {
  const r = db
    .prepare('SELECT status FROM chat_group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
  return r ? r.status : null;
}

// Build a group summary for `viewerId`. Name defaults to the members' names.
function serializeGroup(groupId, viewerId) {
  const g = db.prepare('SELECT id, name, created_by, created_at FROM chat_groups WHERE id = ?').get(groupId);
  if (!g) return null;
  const members = membersOf(groupId);
  const joined = members.filter((m) => m.status === 'joined');
  const autoName = joined.map((m) => m.displayName).join(', ') || 'Group chat';
  return {
    id: g.id,
    name: g.name || autoName,
    createdBy: g.created_by,
    createdAt: g.created_at,
    members,
    memberCount: joined.length,
    max: MAX_MEMBERS,
    myStatus: myStatus(groupId, viewerId),
  };
}

// The user_ids of everyone currently in the group (joined + invited), so the
// socket layer can notify all of them.
function memberIds(groupId) {
  return db.prepare('SELECT user_id FROM chat_group_members WHERE group_id = ?').all(groupId).map((r) => r.user_id);
}

// POST /api/groups  { name?, invite: [usernames] } — create a group. Creator is
// joined immediately; each listed connection is invited (must accept).
router.post('/', requireAuth, (req, res) => {
  const me = req.user.id;
  const name = ((req.body && req.body.name) || '').trim().slice(0, 60) || null;
  const inviteNames = Array.isArray(req.body && req.body.invite) ? req.body.invite : [];

  // Resolve invitees to connected users, de-duped and excluding self.
  const invitees = [];
  const seen = new Set([me]);
  for (const uname of inviteNames) {
    const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(String(uname || '').trim());
    if (!u || seen.has(u.id)) continue;
    if (!areConnected(me, u.id)) {
      return res.status(400).json({ error: `You can only add people you're connected with (${uname}).` });
    }
    seen.add(u.id);
    invitees.push(u);
  }
  if (!invitees.length) return res.status(400).json({ error: 'Add at least one person to start a group chat.' });
  if (invitees.length + 1 > MAX_MEMBERS) {
    return res.status(400).json({ error: `A group chat can have at most ${MAX_MEMBERS} people.` });
  }

  const now = Date.now();
  const info = db.prepare('INSERT INTO chat_groups (name, created_by, created_at) VALUES (?, ?, ?)').run(name, me, now);
  const gid = info.lastInsertRowid;
  db.prepare("INSERT INTO chat_group_members (group_id, user_id, status, invited_by, created_at) VALUES (?, ?, 'joined', ?, ?)")
    .run(gid, me, me, now);
  const insInvite = db.prepare("INSERT INTO chat_group_members (group_id, user_id, status, invited_by, created_at) VALUES (?, ?, 'invited', ?, ?)");
  invitees.forEach((u) => insInvite.run(gid, u.id, me, now));

  notifyGroup(memberIds(gid), gid);
  res.status(201).json({ group: serializeGroup(gid, me) });
});

// GET /api/groups — my joined groups and my pending invites.
router.get('/', requireAuth, (req, res) => {
  const me = req.user.id;
  const rows = db
    .prepare("SELECT group_id, status FROM chat_group_members WHERE user_id = ? ORDER BY created_at DESC")
    .all(me);
  const groups = [];
  const invites = [];
  rows.forEach((r) => {
    const g = serializeGroup(r.group_id, me);
    if (!g) return;
    if (r.status === 'joined') groups.push(g);
    else if (r.status === 'invited') invites.push(g);
  });
  res.json({ groups, invites });
});

// GET /api/groups/:id — group detail (joined members only).
router.get('/:id', requireAuth, (req, res) => {
  const gid = parseInt(req.params.id, 10);
  if (myStatus(gid, req.user.id) !== 'joined') return res.status(403).json({ error: 'You are not in this group.' });
  res.json({ group: serializeGroup(gid, req.user.id) });
});

// GET /api/groups/:id/messages — recent group history (joined members only).
router.get('/:id/messages', requireAuth, (req, res) => {
  const gid = parseInt(req.params.id, 10);
  if (myStatus(gid, req.user.id) !== 'joined') return res.status(403).json({ error: 'You are not in this group.' });
  const rows = db
    .prepare(
      `SELECT gm.id, gm.sender_id, gm.body, gm.created_at, u.username, p.display_name, p.avatar
       FROM group_messages gm
       JOIN users u ON u.id = gm.sender_id
       LEFT JOIN profiles p ON p.user_id = gm.sender_id
       WHERE gm.group_id = ?
       ORDER BY gm.created_at ASC
       LIMIT 200`
    )
    .all(gid);
  res.json({
    messages: rows.map((r) => ({
      id: r.id,
      groupId: gid,
      from: r.sender_id,
      fromName: r.display_name || r.username,
      fromAvatar: r.avatar ? `/uploads/${r.avatar}` : null,
      body: r.body,
      at: r.created_at,
      mine: r.sender_id === req.user.id,
    })),
  });
});

// POST /api/groups/:id/invite  { username } — invite one more connection.
router.post('/:id/invite', requireAuth, (req, res) => {
  const me = req.user.id;
  const gid = parseInt(req.params.id, 10);
  if (myStatus(gid, me) !== 'joined') return res.status(403).json({ error: 'You are not in this group.' });
  if (occupancy(gid) >= MAX_MEMBERS) return res.status(400).json({ error: `A group chat can have at most ${MAX_MEMBERS} people.` });

  const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(String((req.body && req.body.username) || '').trim());
  if (!u) return res.status(404).json({ error: 'User not found.' });
  if (u.id === me) return res.status(400).json({ error: 'You are already in this group.' });
  if (!areConnected(me, u.id)) return res.status(400).json({ error: "You can only add people you're connected with." });
  if (myStatus(gid, u.id)) return res.status(409).json({ error: 'That person is already in the group or invited.' });

  db.prepare("INSERT INTO chat_group_members (group_id, user_id, status, invited_by, created_at) VALUES (?, ?, 'invited', ?, ?)")
    .run(gid, u.id, me, Date.now());
  notifyGroup(memberIds(gid), gid);
  res.status(201).json({ group: serializeGroup(gid, me) });
});

// POST /api/groups/:id/accept — accept an invite and join.
router.post('/:id/accept', requireAuth, (req, res) => {
  const me = req.user.id;
  const gid = parseInt(req.params.id, 10);
  if (myStatus(gid, me) !== 'invited') return res.status(404).json({ error: 'No pending invite for this group.' });
  if (occupancy(gid) > MAX_MEMBERS) return res.status(400).json({ error: 'This group is full.' });
  db.prepare("UPDATE chat_group_members SET status = 'joined' WHERE group_id = ? AND user_id = ?").run(gid, me);
  notifyGroup(memberIds(gid), gid);
  res.json({ group: serializeGroup(gid, me) });
});

// POST /api/groups/:id/leave — decline an invite, or leave a group. If no joined
// members remain, the group (and its messages) are removed.
router.post('/:id/leave', requireAuth, (req, res) => {
  const me = req.user.id;
  const gid = parseInt(req.params.id, 10);
  if (!myStatus(gid, me)) return res.status(404).json({ error: 'You are not in this group.' });
  const others = memberIds(gid).filter((id) => id !== me);
  db.prepare('DELETE FROM chat_group_members WHERE group_id = ? AND user_id = ?').run(gid, me);
  const remainingJoined = db.prepare("SELECT COUNT(*) AS n FROM chat_group_members WHERE group_id = ? AND status = 'joined'").get(gid).n;
  if (remainingJoined === 0) {
    db.prepare('DELETE FROM chat_groups WHERE id = ?').run(gid); // cascades members + messages
  }
  notifyGroup(others, gid);
  res.json({ ok: true });
});

module.exports = router;
