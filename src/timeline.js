'use strict';

// Profile timeline: who may see it, life/career milestones, and quiz/poll
// activity. The timeline on a profile is the member's gallery photos/reels,
// their Highway posts (statements, photos, listed blogs), the milestones they
// add here (new job, education, relationship, achievement, …) and — unless they
// turn it off — their quiz and poll activity, all newest first.
//
// Visibility (profiles.timeline_visibility), checked on the server for every
// timeline read (src/routes/profile.js, src/routes/highway.js, the gallery
// endpoints via profileData.canSeePhoto):
//   everyone  — any signed-in member;
//   followers — members who follow the owner, and the owner's friends;
//   friends   — the owner's friends only;
//   custom    — only the members on the owner's "include" list;
//   only_me   — nobody but the owner.
// The "exclude" list (profiles.timeline_deny) hides the timeline from those
// members whatever the level. A block either way always hides it.

const db = require('./db');
const { isFollowing } = require('./follows');
const { areBlocked } = require('./relations');

const VISIBILITY = ['everyone', 'followers', 'friends', 'custom', 'only_me'];
const MILESTONE_KINDS = {
  job: '💼',
  education: '🎓',
  relationship: '❤️',
  achievement: '🏆',
  move: '🏠',
  travel: '✈️',
  family: '👪',
  health: '💪',
  other: '⭐',
};
const MAX_LIST = 200;
const MAX_TITLE = 120;
const MAX_DETAIL = 1000;
const ACTIVITY_LIMIT = 50;

(function migrate() {
  const cols = db.prepare('PRAGMA table_info(profiles)').all().map((c) => c.name);
  if (!cols.includes('timeline_visibility')) db.exec("ALTER TABLE profiles ADD COLUMN timeline_visibility TEXT NOT NULL DEFAULT 'everyone';");
  if (!cols.includes('timeline_allow')) db.exec("ALTER TABLE profiles ADD COLUMN timeline_allow TEXT NOT NULL DEFAULT '[]';");
  if (!cols.includes('timeline_deny')) db.exec("ALTER TABLE profiles ADD COLUMN timeline_deny TEXT NOT NULL DEFAULT '[]';");
  if (!cols.includes('timeline_activity')) db.exec('ALTER TABLE profiles ADD COLUMN timeline_activity INTEGER NOT NULL DEFAULT 1;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_milestones (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL DEFAULT 'other',
      title      TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '',
      happened_on TEXT,                 -- YYYY-MM-DD the member picked (optional)
      at         INTEGER NOT NULL,      -- sort key: happened_on as ms, else created_at
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_timeline_milestones_user ON timeline_milestones (user_id, at);
  `);
})();

function parseIds(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch (_e) { return []; }
}

function isFriend(a, b) {
  return !!db.prepare(
    `SELECT 1 FROM friendships WHERE status = 'accepted'
       AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
  ).get(a, b, b, a);
}

function rawSettings(ownerId) {
  return db.prepare('SELECT timeline_visibility, timeline_allow, timeline_deny, timeline_activity FROM profiles WHERE user_id = ?').get(ownerId);
}

// Members shown by id → { id, username, displayName, avatar } (for the
// owner's include/exclude lists).
function people(ids) {
  if (!ids.length) return [];
  const rows = db.prepare(
    `SELECT u.id, u.username, p.display_name, p.avatar FROM users u LEFT JOIN profiles p ON p.user_id = u.id
      WHERE u.id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  return rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name || r.username, avatar: r.avatar ? `/uploads/${r.avatar}` : null }));
}

// The owner's own settings (for the settings window).
function settingsFor(ownerId) {
  const r = rawSettings(ownerId);
  if (!r) return null;
  return {
    visibility: VISIBILITY.includes(r.timeline_visibility) ? r.timeline_visibility : 'everyone',
    allow: people(parseIds(r.timeline_allow)),
    deny: people(parseIds(r.timeline_deny)),
    showActivity: !!r.timeline_activity,
  };
}

// True if `viewerId` may see `ownerId`'s timeline.
function canView(ownerId, viewerId) {
  if (!viewerId) return false;
  if (viewerId === ownerId) return true;
  if (areBlocked(viewerId, ownerId)) return false;
  const r = rawSettings(ownerId);
  if (!r) return false;
  if (parseIds(r.timeline_deny).includes(viewerId)) return false;
  switch (r.timeline_visibility) {
    case 'only_me': return false;
    case 'custom': return parseIds(r.timeline_allow).includes(viewerId);
    case 'friends': return isFriend(ownerId, viewerId);
    case 'followers': return isFriend(ownerId, viewerId) || isFollowing(viewerId, ownerId);
    default: return true;
  }
}

// Resolve usernames/ids from the client to existing member ids (not the owner).
function resolveIds(list, ownerId) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const v of list.slice(0, MAX_LIST)) {
    let row = null;
    if (typeof v === 'number' || /^\d+$/.test(String(v))) row = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(v));
    else row = db.prepare('SELECT id FROM users WHERE username = ?').get(String(v).trim().replace(/^@/, ''));
    if (row && row.id !== ownerId) out.add(row.id);
  }
  return [...out];
}

function saveSettings(ownerId, body) {
  body = body || {};
  if (!rawSettings(ownerId)) return { error: 'Create your profile first.' };
  const visibility = String(body.visibility || '');
  if (!VISIBILITY.includes(visibility)) return { error: 'Pick who can see your timeline.' };
  const allow = resolveIds(body.allow, ownerId);
  const deny = resolveIds(body.deny, ownerId).filter((id) => !allow.includes(id));
  if (visibility === 'custom' && !allow.length) return { error: 'Add at least one person who may see your timeline, or pick another option.' };
  db.prepare('UPDATE profiles SET timeline_visibility = ?, timeline_allow = ?, timeline_deny = ?, timeline_activity = ? WHERE user_id = ?')
    .run(visibility, JSON.stringify(allow), JSON.stringify(deny), body.showActivity === false ? 0 : 1, ownerId);
  return { settings: settingsFor(ownerId) };
}

/* ---------------- milestones ---------------- */

function shapeMilestone(r) {
  return {
    id: r.id,
    kind: r.kind,
    emoji: MILESTONE_KINDS[r.kind] || MILESTONE_KINDS.other,
    title: r.title,
    detail: r.detail,
    happenedOn: r.happened_on || null,
    at: r.at,
    createdAt: r.created_at,
  };
}

function cleanMilestone(body) {
  body = body || {};
  const kind = Object.prototype.hasOwnProperty.call(MILESTONE_KINDS, body.kind) ? body.kind : 'other';
  const title = String(body.title || '').trim().slice(0, MAX_TITLE);
  if (!title) return { error: 'Give the milestone a title.' };
  const detail = String(body.detail || '').trim().slice(0, MAX_DETAIL);
  let happenedOn = String(body.happenedOn || '').trim();
  if (happenedOn && !/^\d{4}-\d{2}-\d{2}$/.test(happenedOn)) return { error: 'Use a valid date.' };
  const t = happenedOn ? Date.parse(happenedOn + 'T12:00:00Z') : NaN;
  if (happenedOn && (!Number.isFinite(t) || t > Date.now() + 366 * 86400000)) return { error: 'Use a valid date.' };
  if (!happenedOn) happenedOn = null;
  return { kind, title, detail, happenedOn, at: happenedOn ? t : null };
}

function milestonesOf(ownerId) {
  return db.prepare('SELECT * FROM timeline_milestones WHERE user_id = ? ORDER BY at DESC, id DESC').all(ownerId).map(shapeMilestone);
}

function addMilestone(ownerId, body) {
  if (!rawSettings(ownerId)) return { error: 'Create your profile first.' };
  const m = cleanMilestone(body);
  if (m.error) return m;
  const now = Date.now();
  const info = db.prepare('INSERT INTO timeline_milestones (user_id, kind, title, detail, happened_on, at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ownerId, m.kind, m.title, m.detail, m.happenedOn, m.at || now, now);
  return { milestone: shapeMilestone(db.prepare('SELECT * FROM timeline_milestones WHERE id = ?').get(info.lastInsertRowid)) };
}

function updateMilestone(ownerId, id, body) {
  const row = db.prepare('SELECT * FROM timeline_milestones WHERE id = ? AND user_id = ?').get(Number(id), ownerId);
  if (!row) return { error: 'Milestone not found.', status: 404 };
  const m = cleanMilestone(body);
  if (m.error) return m;
  db.prepare('UPDATE timeline_milestones SET kind = ?, title = ?, detail = ?, happened_on = ?, at = ? WHERE id = ?')
    .run(m.kind, m.title, m.detail, m.happenedOn, m.at || row.created_at, row.id);
  return { milestone: shapeMilestone(db.prepare('SELECT * FROM timeline_milestones WHERE id = ?').get(row.id)) };
}

function deleteMilestone(ownerId, id) {
  return db.prepare('DELETE FROM timeline_milestones WHERE id = ? AND user_id = ?').run(Number(id), ownerId).changes > 0;
}

/* ---------------- quiz / poll activity ---------------- */

function activityOf(ownerId) {
  const quizzes = db.prepare(
    `SELECT a.id, a.score, a.total, a.created_at, q.title FROM quiz_attempts a JOIN quizzes q ON q.id = a.quiz_id
      WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT ?`
  ).all(ownerId, ACTIVITY_LIMIT).map((r) => ({
    id: 'quiz-' + r.id, type: 'quiz', emoji: '🧠', title: `Took the quiz “${r.title}”`, detail: `Scored ${r.score} / ${r.total}`, at: r.created_at,
  }));
  // Which option they picked stays private; only that they voted is shown.
  const polls = db.prepare(
    `SELECT v.poll_id, v.created_at, p.question FROM poll_votes v JOIN polls p ON p.id = v.poll_id
      WHERE v.user_id = ? ORDER BY v.created_at DESC LIMIT ?`
  ).all(ownerId, ACTIVITY_LIMIT).map((r) => ({
    id: 'poll-' + r.poll_id, type: 'poll', emoji: '📊', title: 'Voted in a poll', detail: r.question, at: r.created_at,
  }));
  return quizzes.concat(polls).sort((a, b) => b.at - a.at).slice(0, ACTIVITY_LIMIT);
}

// Milestones + activity for one viewer (the caller has checked canView).
function entriesFor(ownerId) {
  const r = rawSettings(ownerId);
  return {
    milestones: milestonesOf(ownerId),
    activity: r && r.timeline_activity ? activityOf(ownerId) : [],
  };
}

module.exports = {
  VISIBILITY,
  MILESTONE_KINDS,
  canView,
  settingsFor,
  saveSettings,
  entriesFor,
  addMilestone,
  updateMilestone,
  deleteMilestone,
};
