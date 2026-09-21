'use strict';

// WhatsApp-style chat polls. A poll is created inside a 1:1 or group chat and
// referenced by a chat message (kind='poll'). Voting is live: each vote updates
// the shared tallies pushed to every participant. See the socket handlers in
// src/socket.js and the client renderer in public/js/app.js.

const db = require('./db');

const MAX_OPTIONS = 12;
const MAX_QUESTION = 300;
const MAX_OPTION = 120;

// Normalise + validate the raw {question, options, multi} from a client. Returns
// { question, options: [string], multi: bool } or { error }.
function sanitize(input) {
  const question = String((input && input.question) || '').trim();
  if (!question) return { error: 'Ask a question for your poll.' };
  if (question.length > MAX_QUESTION) return { error: 'That question is too long.' };

  let options = Array.isArray(input && input.options) ? input.options : [];
  options = options
    .map((o) => String(o == null ? '' : o).trim())
    .filter((o) => o.length)
    .slice(0, MAX_OPTIONS);
  if (options.length < 2) return { error: 'Add at least two options.' };
  if (options.some((o) => o.length > MAX_OPTION)) return { error: 'One of the options is too long.' };

  return { question, options, multi: !!(input && input.multi) };
}

// Create a poll row. `target` is either { dmA, dmB } or { groupId }.
function createPoll({ creatorId, question, options, multi, dmA, dmB, groupId }) {
  const scope = groupId ? 'group' : 'dm';
  const lo = dmA != null && dmB != null ? Math.min(dmA, dmB) : null;
  const hi = dmA != null && dmB != null ? Math.max(dmA, dmB) : null;
  const info = db
    .prepare(
      `INSERT INTO chat_polls (scope, dm_a, dm_b, group_id, creator_id, question, options, multi, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(scope, lo, hi, groupId || null, creatorId, question, JSON.stringify(options), multi ? 1 : 0, Date.now());
  return info.lastInsertRowid;
}

// Link the poll to the chat message that carries it (best-effort convenience).
function attachMessage(pollId, messageId) {
  db.prepare('UPDATE chat_polls SET message_id = ? WHERE id = ?').run(messageId, pollId);
}

function getPoll(pollId) {
  return db.prepare('SELECT * FROM chat_polls WHERE id = ?').get(pollId);
}

function parseOptions(row) {
  try {
    const arr = JSON.parse(row.options);
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

// May this user see / vote on this poll? DM: one of the two participants.
// Group: a currently-joined member.
function canParticipate(poll, userId) {
  if (!poll) return false;
  if (poll.scope === 'dm') return userId === poll.dm_a || userId === poll.dm_b;
  const row = db
    .prepare("SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ? AND status = 'joined'")
    .get(poll.group_id, userId);
  return !!row;
}

// Cast / toggle a vote. Single-choice: the same option again clears it, a
// different option replaces the previous one. Multi-choice: each option toggles
// independently. Returns { error } on a bad option index.
function vote(poll, userId, optionIndex) {
  const options = parseOptions(poll);
  if (!(optionIndex >= 0 && optionIndex < options.length)) return { error: 'Invalid option.' };

  const now = Date.now();
  const existing = db
    .prepare('SELECT option_index FROM chat_poll_votes WHERE poll_id = ? AND user_id = ?')
    .all(poll.id, userId)
    .map((r) => r.option_index);

  if (poll.multi) {
    if (existing.includes(optionIndex)) {
      db.prepare('DELETE FROM chat_poll_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?')
        .run(poll.id, userId, optionIndex);
    } else {
      db.prepare('INSERT INTO chat_poll_votes (poll_id, option_index, user_id, created_at) VALUES (?, ?, ?, ?)')
        .run(poll.id, optionIndex, userId, now);
    }
  } else {
    // Single choice: clear any prior selection first.
    db.prepare('DELETE FROM chat_poll_votes WHERE poll_id = ? AND user_id = ?').run(poll.id, userId);
    if (!existing.includes(optionIndex)) {
      db.prepare('INSERT INTO chat_poll_votes (poll_id, option_index, user_id, created_at) VALUES (?, ?, ?, ?)')
        .run(poll.id, optionIndex, userId, now);
    }
  }
  return {};
}

// The full, viewer-tailored poll payload sent to clients.
function pollPayload(pollId, viewerId) {
  const poll = typeof pollId === 'object' ? pollId : getPoll(pollId);
  if (!poll) return null;
  const options = parseOptions(poll);

  const counts = new Array(options.length).fill(0);
  // Per-option gender split (Male / Female / other) so the client can colour votes.
  const genders = options.map(() => ({ male: 0, female: 0, other: 0 }));
  const rows = db
    .prepare(
      `SELECT v.option_index AS option_index, v.user_id AS user_id, p.gender AS gender
         FROM chat_poll_votes v LEFT JOIN profiles p ON p.user_id = v.user_id
        WHERE v.poll_id = ?`
    )
    .all(poll.id);
  const voters = new Set();
  const mine = [];
  for (const r of rows) {
    if (r.option_index >= 0 && r.option_index < counts.length) {
      counts[r.option_index]++;
      if (r.gender === 'Male') genders[r.option_index].male++;
      else if (r.gender === 'Female') genders[r.option_index].female++;
      else genders[r.option_index].other++;
    }
    voters.add(r.user_id);
    if (viewerId && r.user_id === viewerId) mine.push(r.option_index);
  }

  return {
    id: poll.id,
    scope: poll.scope,
    creatorId: poll.creator_id,
    question: poll.question,
    multi: !!poll.multi,
    options: options.map((text, i) => ({ text, count: counts[i], genders: genders[i] })),
    total: voters.size,
    myVotes: mine,
  };
}

// Short label for a poll (broadcast mirror, reply previews).
function pollLabel(pollId) {
  const poll = getPoll(pollId);
  return poll ? `📊 ${poll.question}` : '📊 Poll';
}

// Pull the pollId out of a kind='poll' message body ({"pollId":N}).
function pollIdFromBody(body) {
  try {
    const p = typeof body === 'string' ? JSON.parse(body) : body;
    return p && p.pollId ? p.pollId : null;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  MAX_OPTIONS,
  sanitize,
  createPoll,
  attachMessage,
  getPoll,
  canParticipate,
  vote,
  pollPayload,
  pollLabel,
  pollIdFromBody,
};
