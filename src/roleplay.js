'use strict';

// Roleplay engine. A roleplay is an admin-authored story with ordered stages.
// Two users play it out inside their chat: each stage's narration (title + text
// + an optional image carrying caption-studio speech/thought bubbles) is shown,
// and either player advances to the next stage with the "Next stage" button.
// Session state (just the current stage) lives in the roleplay_sessions table,
// keyed on the normalized user pair. The count_lo/count_hi columns are legacy
// and no longer used now that advancing is manual.

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
    .prepare('SELECT id, stage_index, title, narration, image, captions FROM roleplay_stages WHERE roleplay_id = ? AND stage_index = ?')
    .get(roleplayId, index);
}

// Parse a stage's stored caption definitions (positioned speech/thought
// bubbles). Returns a sanitized array of { type, x, y, rot, flip }: x/y are
// percentages of the image box (the tail's anchor point), rot is a rotation in
// degrees and flip mirrors the bubble. Malformed input yields an empty list.
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
      rot: clampRot(c && c.rot),
      flip: !!(c && c.flip),
    }));
}

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v * 100) / 100));
}

function clampRot(n) {
  let v = Number(n);
  if (!Number.isFinite(v)) return 0;
  v = Math.round(v);
  // Normalize into (-180, 180].
  v = ((v % 360) + 360) % 360;
  if (v > 180) v -= 360;
  return v;
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
  const next = final ? null : getStage(roleplay.id, index + 1);
  return {
    rp: roleplay.id,
    title: roleplay.title,
    stage: index,
    total,
    stageTitle: stageRow && stageRow.title ? stageRow.title : '',
    nextTitle: next && next.title ? next.title : '',
    hasNext: !final && index + 1 < total,
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
// Carries the current + next stage titles so players know what they're playing.
function progressState(session, viewerId) {
  if (!session) return null;
  const rp = db.prepare('SELECT id, title FROM roleplays WHERE id = ?').get(session.roleplay_id);
  const isLo = viewerId === session.user_lo;
  const total = totalStages(session.roleplay_id);
  const cur = getStage(session.roleplay_id, session.current_stage);
  const next = getStage(session.roleplay_id, session.current_stage + 1);
  return {
    sessionId: session.id,
    roleplayId: session.roleplay_id,
    title: rp ? rp.title : 'Roleplay',
    peerId: isLo ? session.user_hi : session.user_lo,
    stage: session.current_stage,
    total,
    stageTitle: cur && cur.title ? cur.title : '',
    nextStageTitle: next && next.title ? next.title : '',
    hasNext: session.current_stage + 1 < total,
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

// Manually advance the active session for a pair to the next stage (triggered by
// either player's "Next stage" button). Returns null if there's no active
// session, else { type: 'advance' | 'complete', ... } to reveal to both users.
function advanceSession(a, b) {
  const session = getActiveSession(a, b);
  if (!session) return null;
  const rp = db.prepare('SELECT * FROM roleplays WHERE id = ?').get(session.roleplay_id);
  if (!rp) return null;

  const total = totalStages(rp.id);
  const now = Date.now();
  const nextIndex = session.current_stage + 1;

  if (nextIndex < total) {
    db.prepare('UPDATE roleplay_sessions SET current_stage = ?, updated_at = ? WHERE id = ?')
      .run(nextIndex, now, session.id);
    return {
      type: 'advance',
      roleplay: rp,
      stageRow: getStage(rp.id, nextIndex),
      stageIndex: nextIndex,
      total,
      session: sessionById(session.id),
    };
  }

  db.prepare("UPDATE roleplay_sessions SET status = 'completed', updated_at = ? WHERE id = ?").run(now, session.id);
  return { type: 'complete', roleplay: rp, total, session: sessionById(session.id) };
}

// Return the session row if `userId` is one of its two players, else null.
// Used to authorize caption edits over the socket / REST.
function sessionForParticipant(sessionId, userId) {
  const s = sessionById(sessionId);
  if (!s) return null;
  return s.user_lo === userId || s.user_hi === userId ? s : null;
}

// Per-caption shared state for a stage of a session, as
// { [captionIndex]: { text, x, y, rot } } where x/y/rot are null unless a player
// has dragged/rotated that caption. Powers the initial paint when a card loads.
function getCaptionState(sessionId, stageIndex) {
  const rows = db
    .prepare('SELECT caption_index, text, x, y, rot FROM roleplay_caption_texts WHERE session_id = ? AND stage_index = ?')
    .all(sessionId, stageIndex);
  const out = {};
  rows.forEach((r) => { out[r.caption_index] = { text: r.text, x: r.x, y: r.y, rot: r.rot }; });
  return out;
}

// Upsert one shared caption's state (last writer wins). Only the provided fields
// of `fields` ({ text?, x?, y?, rot? }) are changed; the rest are preserved by
// reading the existing row first, then writing the merged values.
function setCaptionState(sessionId, stageIndex, captionIndex, fields, userId) {
  const cur = db
    .prepare('SELECT text, x, y, rot FROM roleplay_caption_texts WHERE session_id = ? AND stage_index = ? AND caption_index = ?')
    .get(sessionId, stageIndex, captionIndex) || { text: '', x: null, y: null, rot: null };

  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const text = typeof fields.text === 'string' ? fields.text : cur.text;
  const x = fields.x !== undefined ? num(fields.x, cur.x) : cur.x;
  const y = fields.y !== undefined ? num(fields.y, cur.y) : cur.y;
  const rot = fields.rot !== undefined ? num(fields.rot, cur.rot) : cur.rot;

  db.prepare(
    `INSERT INTO roleplay_caption_texts (session_id, stage_index, caption_index, text, x, y, rot, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, stage_index, caption_index)
       DO UPDATE SET text = excluded.text, x = excluded.x, y = excluded.y, rot = excluded.rot,
                     updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(sessionId, stageIndex, captionIndex, text, x, y, rot, userId, Date.now());
}

// Merge a stage's admin-authored caption definitions with a session's overrides
// (position/rotation/text) into the final overlay to bake onto a shared Highway
// post. Returns { image, captions:[{type,x,y,rot,flip,text}] } or null if the
// stage has no image.
function captionsForShare(session, stageIndex) {
  const stage = getStage(session.roleplay_id, stageIndex);
  if (!stage || !stage.image) return null;
  const defs = parseCaptions(stage.captions);
  const state = getCaptionState(session.id, stageIndex);
  const captions = defs.map((d, i) => {
    const s = state[i] || {};
    return {
      type: d.type,
      x: s.x != null ? clampPct(s.x) : d.x,
      y: s.y != null ? clampPct(s.y) : d.y,
      rot: s.rot != null ? clampRot(s.rot) : d.rot,
      flip: d.flip,
      text: s.text || '',
    };
  });
  return { image: stage.image, captions };
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
  advanceSession,
  sessionForParticipant,
  getCaptionState,
  setCaptionState,
  captionsForShare,
};
