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
    .prepare('SELECT id, stage_index, narration, image, captions FROM roleplay_stages WHERE roleplay_id = ? AND stage_index = ?')
    .get(roleplayId, index);
}

// Parse a stage's stored caption definitions (positioned speech/thought
// bubbles). Returns a sanitized array of { type, x, y } with x/y as percentages
// of the image box. Malformed input yields an empty list.
function parseCaptions(raw) {
  let arr;
  try { arr = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .slice(0, 12)
    .map((c) => ({
      type: c && c.type === 'thinking' ? 'thinking' : 'saying',
      x: clampPct(c && c.x),
      y: clampPct(c && c.y),
    }));
}

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v * 100) / 100));
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
// `sessionId` binds the card to a live playthrough so the caption bubbles can be
// synced/saved; it may be null for a final "The End" card.
function stagePayload(roleplay, stageRow, index, total, final, sessionId) {
  return {
    rp: roleplay.id,
    title: roleplay.title,
    stage: index,
    total,
    narration: stageRow ? stageRow.narration : '',
    image: stageRow && stageRow.image ? `/uploads/${stageRow.image}` : null,
    captions: stageRow && stageRow.image ? parseCaptions(stageRow.captions) : [],
    sid: sessionId || null,
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

// Return the session row if `userId` is one of its two players, else null.
// Used to authorize caption edits over the socket / REST.
function sessionForParticipant(sessionId, userId) {
  const s = sessionById(sessionId);
  if (!s) return null;
  return s.user_lo === userId || s.user_hi === userId ? s : null;
}

// All caption texts written so far for a stage of a session, as
// { [captionIndex]: text }. Powers the initial paint when a card loads.
function getCaptionTexts(sessionId, stageIndex) {
  const rows = db
    .prepare('SELECT caption_index, text FROM roleplay_caption_texts WHERE session_id = ? AND stage_index = ?')
    .all(sessionId, stageIndex);
  const out = {};
  rows.forEach((r) => { out[r.caption_index] = r.text; });
  return out;
}

// Upsert one shared caption value (last writer wins). Text is trimmed to a
// sane length by the caller.
function setCaptionText(sessionId, stageIndex, captionIndex, text, userId) {
  db.prepare(
    `INSERT INTO roleplay_caption_texts (session_id, stage_index, caption_index, text, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, stage_index, caption_index)
       DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(sessionId, stageIndex, captionIndex, text, userId, Date.now());
}

module.exports = {
  pair,
  totalStages,
  getStage,
  parseCaptions,
  roleplaySummary,
  stagePayload,
  getActiveSession,
  progressState,
  startSession,
  stopSession,
  recordMessage,
  sessionForParticipant,
  getCaptionTexts,
  setCaptionText,
};
