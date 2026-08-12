'use strict';

const db = require('./db');
const { ageFromDob } = require('./profileFields');
const { blockState } = require('./relations');

// Compute the friendship state between the viewer and a profile owner.
// Returns one of: 'self' | 'friends' | 'incoming' | 'outgoing' | 'none'.
// 'incoming'  = the owner sent the viewer a request awaiting the viewer.
// 'outgoing'  = the viewer sent the owner a request awaiting the owner.
function friendState(ownerId, viewerId) {
  if (!viewerId || viewerId === ownerId) return 'self';
  const row = db
    .prepare(
      `SELECT requester_id, addressee_id, status FROM friendships
       WHERE (requester_id = ? AND addressee_id = ?)
          OR (requester_id = ? AND addressee_id = ?)`
    )
    .get(ownerId, viewerId, viewerId, ownerId);
  if (!row) return 'none';
  if (row.status === 'accepted') return 'friends';
  return row.requester_id === viewerId ? 'outgoing' : 'incoming';
}

// All accepted friends of a user, as lightweight summaries.
function friendsOf(userId) {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       JOIN profiles p ON p.user_id = u.id
       WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
       ORDER BY p.display_name COLLATE NOCASE`
    )
    .all(userId, userId, userId);
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    avatar: r.avatar ? `/uploads/${r.avatar}` : null,
  }));
}

function ratingSummary(rateeId, viewerId) {
  const agg = db
    .prepare('SELECT COUNT(*) AS count, AVG(stars) AS avg FROM ratings WHERE ratee_id = ?')
    .get(rateeId);
  let mine = null;
  if (viewerId && viewerId !== rateeId) {
    const r = db
      .prepare('SELECT stars FROM ratings WHERE rater_id = ? AND ratee_id = ?')
      .get(viewerId, rateeId);
    mine = r ? r.stars : null;
  }
  return {
    count: agg.count,
    average: agg.count ? Math.round(agg.avg * 10) / 10 : 0,
    mine,
  };
}

function commentsFor(subjectId, viewerId) {
  const rows = db
    .prepare(
      `SELECT c.id, c.author_id, c.body, c.created_at, u.username, p.display_name, p.avatar
       FROM comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN profiles p ON p.user_id = c.author_id
       WHERE c.subject_id = ?
       ORDER BY c.created_at DESC
       LIMIT 200`
    )
    .all(subjectId);
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    at: r.created_at,
    author: {
      id: r.author_id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
    },
    // The comment author, the profile owner, or nobody-of-note can delete.
    canDelete: !!viewerId && (viewerId === r.author_id || viewerId === subjectId),
  }));
}

function parseInterests(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch (_e) {
    return [];
  }
}

// Build the full profile object for `userId`, tailored to `viewerId` (the
// authenticated requester). Returns null if the user has no profile.
function buildProfile(userId, viewerId) {
  const row = db
    .prepare(
      `SELECT u.id, u.username,
              p.display_name, p.bio, p.avatar, p.updated_at,
              p.gender, p.date_of_birth, p.country, p.smokes, p.drinks, p.diet,
              p.sexuality, p.interests, p.persona, p.likes_in_bed, p.bed_role,
              p.relationship_status, p.partner_user_id, p.friends_visibility
       FROM users u JOIN profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .get(userId);
  if (!row) return null;

  const isMe = viewerId === row.id;

  const photos = db
    .prepare('SELECT id, filename FROM gallery_photos WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);

  // Relationship partner (if linked and still exists).
  let partner = null;
  if (row.partner_user_id) {
    const p = db
      .prepare(
        `SELECT u.id, u.username, pr.display_name
         FROM users u JOIN profiles pr ON pr.user_id = u.id WHERE u.id = ?`
      )
      .get(row.partner_user_id);
    if (p) partner = { id: p.id, username: p.username, displayName: p.display_name };
  }

  // All profile information is public; the friends list is always visible.
  // Email is the only private field and is never included in this payload.
  const fState = friendState(row.id, viewerId);
  const friendList = friendsOf(row.id);
  const blocked = blockState(row.id, viewerId);

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    about: row.bio,
    avatar: row.avatar ? `/uploads/${row.avatar}` : null,
    gender: row.gender || null,
    dateOfBirth: row.date_of_birth || null,
    age: ageFromDob(row.date_of_birth),
    country: row.country || null,
    smokes: row.smokes || null,
    drinks: row.drinks || null,
    diet: row.diet || null,
    sexuality: row.sexuality || null,
    interests: parseInterests(row.interests),
    persona: row.persona || '',
    likesInBed: row.likes_in_bed || '',
    bedRole: row.bed_role || null,
    relationshipStatus: row.relationship_status || null,
    partner,
    gallery: photos.map((ph) => ({ id: ph.id, url: `/uploads/${ph.filename}` })),
    rating: ratingSummary(row.id, viewerId),
    comments: commentsFor(row.id, viewerId),
    friends: {
      count: friendList.length,
      list: friendList,
      state: fState,
    },
    blocked,
    isMe,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  buildProfile,
  friendState,
  friendsOf,
  ratingSummary,
  commentsFor,
  parseInterests,
};
