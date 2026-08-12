'use strict';

// Roleplay engine. A roleplay is an admin-authored story with ordered stages.
// Two users play it out inside their chat: each stage's narration is shown,
// then both users must each send `required_messages` messages before the next
// stage's narration is revealed. Session state (current stage + per-user
// message counts) lives in the roleplay_sessions table, keyed on the
// normalized user pair.

const db = require('./db');

// Order a user pair so it maps to a single session row regardless of who
// started it.
function pair(a, b) {
  return a < b ? { lo: a, hi: b } : { lo: b, hi: a };
}

function totalStages(roleplayId) {
  return db.prepare('SELECT COUNT(*) AS n FROM roleplay_stages WHERE roleplay_id = ?').get(roleplayId).n;
}

function getStage(roleplayId, index) {
  return db
    .prepare('SELECT id, stage_index, narration, image FROM roleplay_stages WHERE roleplay_id = ? AND stage_index = ?')
    .get(roleplayId, index);
}

// Lightweight catalog summary for the roleplay list.
function roleplaySummary(r) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    cover: r.cover ? `/uploads/${r.cover}` : null,
    requiredMessages: r.required_messages,
    stageCount: totalStages(r.id),
    createdAt: r.created_at,
  };
}

// The narration payload embedded (as JSON) in a kind='narration' chat message.
function stagePayload(roleplay, stageRow, index, total, final) {
  return {
    rp: roleplay.id,
    title: roleplay.title,
    stage: index,
    total,
    narration: stageRow ? stageRow.narration : '',
    image: stageRow && stageRow.image ? `/uploads/${stageRow.image}` : null,
    final: !!final,
  };
}

function getActiveSession(a, b) {
  const p = pair(a, b);
  return db
    .prepare("SELECT * FROM roleplay_sessions WHERE user_lo = ? AND user_hi = ? AND status = 'active'")
    .get(p.lo, p.hi);
}

function sessionById(id) {
  return db.prepare('SELECT * FROM roleplay_sessions WHERE id = ?').get(id);
}

// Progress snapshot tailored to a viewer (so "you" vs "partner" is correct).
function progressState(session, viewerId) {
  if (!session) return null;
  const rp = db.prepare('SELECT id, title, required_messages FROM roleplays WHERE id = ?').get(session.roleplay_id);
  const isLo = viewerId === session.user_lo;
  return {
    sessionId: session.id,
    roleplayId: session.roleplay_id,
    title: rp ? rp.title : 'Roleplay',
    peerId: isLo ? session.user_hi : session.user_lo,
    stage: session.current_stage,
    total: totalStages(session.roleplay_id),
    required: rp ? rp.required_messages : 0,
    myCount: isLo ? session.count_lo : session.count_hi,
    peerCount: isLo ? session.count_hi : session.count_lo,
    status: session.status,
  };
}

// Start (or restart) a roleplay for the pair. Any existing active session for
// the pair is completed first. Returns { error } or the started session data.
function startSession(roleplayId, a, b) {
  const rp = db.prepare('SELECT * FROM roleplays WHERE id = ?').get(roleplayId);
  if (!rp) return { error: 'Roleplay not found.' };
  const total = totalStages(roleplayId);
  if (!total) return { error: 'This roleplay has no stages yet.' };

  const p = pair(a, b);
  const now = Date.now();
  db.prepare("UPDATE roleplay_sessions SET status = 'completed', updated_at = ? WHERE user_lo = ? AND user_hi = ? AND status = 'active'")
    .run(now, p.lo, p.hi);
  const info = db
    .prepare(
      `INSERT INTO roleplay_sessions
         (roleplay_id, user_lo, user_hi, current_stage, count_lo, count_hi, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, 0, 'active', ?, ?)`
    )
    .run(roleplayId, p.lo, p.hi, now, now);

  return {
    session: sessionById(info.lastInsertRowid),
    roleplay: rp,
    stageRow: getStage(roleplayId, 0),
    stageIndex: 0,
    total,
  };
}

function stopSession(a, b) {
  const s = getActiveSession(a, b);
  if (!s) return null;
  db.prepare("UPDATE roleplay_sessions SET status = 'completed', updated_at = ? WHERE id = ?").run(Date.now(), s.id);
  return sessionById(s.id);
}

// Record a TEXT message from sender→other in the active session (if any) and
// decide what happens next. Returns null if there's no active session, else a
// descriptor: { type: 'progress' | 'advance' | 'complete', ... }.
function recordMessage(senderId, otherId) {
  const session = getActiveSession(senderId, otherId);
  if (!session) return null;
  const rp = db.prepare('SELECT * FROM roleplays WHERE id = ?').get(session.roleplay_id);
  if (!rp) return null;

  const required = rp.required_messages;
  const isLo = senderId === session.user_lo;
  const now = Date.now();
  db.prepare(
    `UPDATE roleplay_sessions
       SET count_lo = count_lo + ?, count_hi = count_hi + ?, updated_at = ?
     WHERE id = ?`
  ).run(isLo ? 1 : 0, isLo ? 0 : 1, now, session.id);

  const s = sessionById(session.id);
  const total = totalStages(rp.id);

  if (s.count_lo >= required && s.count_hi >= required) {
    const nextIndex = s.current_stage + 1;
    if (nextIndex < total) {
      db.prepare('UPDATE roleplay_sessions SET current_stage = ?, count_lo = 0, count_hi = 0, updated_at = ? WHERE id = ?')
        .run(nextIndex, now, s.id);
      return {
        type: 'advance',
        roleplay: rp,
        stageRow: getStage(rp.id, nextIndex),
        stageIndex: nextIndex,
        total,
        session: sessionById(s.id),
      };
    }
    db.prepare("UPDATE roleplay_sessions SET status = 'completed', updated_at = ? WHERE id = ?").run(now, s.id);
    return { type: 'complete', roleplay: rp, total, session: sessionById(s.id) };
  }

  return { type: 'progress', roleplay: rp, total, session: s };
}

module.exports = {
  pair,
  totalStages,
  getStage,
  roleplaySummary,
  stagePayload,
  getActiveSession,
  progressState,
  startSession,
  stopSession,
  recordMessage,
};
