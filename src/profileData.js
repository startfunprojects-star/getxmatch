'use strict';

const db = require('./db');
const { followSummary, isFollowing } = require('./follows');
const { friendFeeOf, GAIN_MULTIPLIER: FRIEND_FEE_GAIN } = require('./friendFees');
const { blockState, ignoreState } = require('./relations');
const { isOnline } = require('./socket');
const referrals = require('./referrals');

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
      `SELECT u.id, u.username, p.display_name, p.avatar, f.rel_type
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
    relType: r.rel_type || 'friend',
    online: isOnline(r.id),
  }));
}

// How many of a member's newest gallery photos a follower (who isn't a friend)
// may see.
const FOLLOWER_PREVIEW_PHOTOS = 3;

// What `viewerId` may see of `ownerId`'s profile:
//   'full'     — the owner themself, or a friend: the complete profile;
//   'follower' — follows the owner: the basics plus the newest few photos;
//   'basic'    — anyone else: name, picture, about, gender, country.
// A member's age is never shown; only the owner gets their date of birth (to edit it).
function profileAccess(ownerId, viewerId) {
  if (!viewerId || viewerId === ownerId) return viewerId ? 'full' : 'basic';
  if (friendState(ownerId, viewerId) === 'friends') return 'full';
  return isFollowing(viewerId, ownerId) ? 'follower' : 'basic';
}

// The gallery photo ids `viewerId` may open on `ownerId`'s profile (null =
// all of them).
function visiblePhotoIds(ownerId, viewerId) {
  const access = profileAccess(ownerId, viewerId);
  if (access === 'full') return null;
  if (access === 'basic') return new Set();
  return new Set(db
    .prepare('SELECT id FROM gallery_photos WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(ownerId, FOLLOWER_PREVIEW_PHOTOS)
    .map((r) => r.id));
}

// True if `viewerId` may open (react to, comment on) this gallery photo.
function canSeePhoto(photo, viewerId) {
  const ids = visiblePhotoIds(photo.user_id, viewerId);
  return ids === null || ids.has(photo.id);
}

// True if two members are friends (accepted request either way). Chat is for
// friends only.
function areFriends(a, b) {
  return !!a && !!b && a !== b && friendState(a, b) === 'friends';
}

// The four independent rating dimensions, each scored 1-5 stars. Mirrored on
// the client (RATING_DIMS in public/js/app.js).
const RATING_DIMS = ['knowledgeable', 'helpful', 'creative', 'thoughtful'];

function ratingSummary(rateeId, viewerId) {
  const agg = db
    .prepare(
      `SELECT COUNT(*) AS count,
              AVG(knowledgeable) AS knowledgeable, COUNT(knowledgeable) AS knowledgeable_n,
              AVG(helpful) AS helpful,       COUNT(helpful) AS helpful_n,
              AVG(creative) AS creative,     COUNT(creative) AS creative_n,
              AVG(thoughtful) AS thoughtful, COUNT(thoughtful) AS thoughtful_n
       FROM ratings WHERE ratee_id = ?`
    )
    .get(rateeId);

  const dimensions = {};
  const dimAverages = [];
  for (const d of RATING_DIMS) {
    const n = agg[`${d}_n`] || 0;
    const avg = n ? Math.round(agg[d] * 10) / 10 : 0;
    dimensions[d] = { average: avg, count: n };
    if (n) dimAverages.push(agg[d]);
  }
  const overall = dimAverages.length
    ? Math.round((dimAverages.reduce((s, x) => s + x, 0) / dimAverages.length) * 10) / 10
    : 0;

  let mine = null;
  if (viewerId && viewerId !== rateeId) {
    const r = db
      .prepare('SELECT knowledgeable, helpful, creative, thoughtful FROM ratings WHERE rater_id = ? AND ratee_id = ?')
      .get(viewerId, rateeId);
    if (r) mine = { knowledgeable: r.knowledgeable || null, helpful: r.helpful || null, creative: r.creative || null, thoughtful: r.thoughtful || null };
  }

  return {
    count: agg.count,     // number of people who rated (any dimension)
    average: overall,     // overall = mean of the dimension averages (hero score)
    dimensions,           // { knowledgeable: {average,count}, helpful: {...}, ... }
    mine,                 // the viewer's own per-dimension scores, or null
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

// Build the gallery for a profile: each photo carries its aggregated emoji
// reactions, a total, the viewer's own reaction (if any), and a comment count.
// Detail (the full comment list) is fetched lazily when a photo is opened.
function buildGallery(userId, viewerId) {
  const photos = db
    .prepare(
      `SELECT id, filename, kind, duration, caption, location, music, music_mixed
       FROM gallery_photos WHERE user_id = ? ORDER BY created_at DESC`
    )
    .all(userId);
  if (!photos.length) return [];

  const ids = photos.map((p) => p.id);
  const marks = ids.map(() => '?').join(',');

  const reactRows = db
    .prepare(
      `SELECT photo_id, emoji, COUNT(*) AS n FROM gallery_reactions
       WHERE photo_id IN (${marks}) GROUP BY photo_id, emoji`
    )
    .all(...ids);
  const reactionsBy = new Map();
  for (const r of reactRows) {
    if (!reactionsBy.has(r.photo_id)) reactionsBy.set(r.photo_id, []);
    reactionsBy.get(r.photo_id).push({ emoji: r.emoji, count: r.n });
  }

  const commentRows = db
    .prepare(
      `SELECT photo_id, COUNT(*) AS n FROM gallery_comments
       WHERE photo_id IN (${marks}) GROUP BY photo_id`
    )
    .all(...ids);
  const commentCount = new Map(commentRows.map((r) => [r.photo_id, r.n]));

  let mineBy = new Map();
  if (viewerId) {
    const mineRows = db
      .prepare(`SELECT photo_id, emoji FROM gallery_reactions WHERE user_id = ? AND photo_id IN (${marks})`)
      .all(viewerId, ...ids);
    mineBy = new Map(mineRows.map((r) => [r.photo_id, r.emoji]));
  }

  return photos.map((ph) => {
    const reactions = reactionsBy.get(ph.id) || [];
    return {
      id: ph.id,
      url: `/uploads/${ph.filename}`,
      kind: ph.kind || 'photo',
      duration: ph.duration || null,
      caption: ph.caption || '',
      location: ph.location || '',
      music: ph.music || null,
      musicMixed: !!ph.music_mixed,
      reactions,
      reactionCount: reactions.reduce((sum, r) => sum + r.count, 0),
      commentCount: commentCount.get(ph.id) || 0,
      myReaction: mineBy.get(ph.id) || null,
    };
  });
}

// The user's GIF "feelings" collection, newest first. Visibility gating (who
// is allowed to see it) is applied by the caller in buildProfile().
function buildGifs(userId) {
  return db
    .prepare('SELECT id, filename, caption FROM user_gifs WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map((g) => ({ id: g.id, url: `/uploads/${g.filename}`, caption: g.caption || '' }));
}

// Aggregated reaction state for one photo: per-emoji counts, the total, and the
// viewer's own reaction (if any). Returned by the react endpoint and the photo
// detail endpoint so the client can repaint without a full profile reload.
function photoReactionState(photoId, viewerId) {
  const rows = db
    .prepare('SELECT emoji, COUNT(*) AS n FROM gallery_reactions WHERE photo_id = ? GROUP BY emoji')
    .all(photoId);
  let mine = null;
  if (viewerId) {
    const r = db
      .prepare('SELECT emoji FROM gallery_reactions WHERE photo_id = ? AND user_id = ?')
      .get(photoId, viewerId);
    mine = r ? r.emoji : null;
  }
  return {
    reactions: rows.map((r) => ({ emoji: r.emoji, count: r.n })),
    total: rows.reduce((sum, r) => sum + r.n, 0),
    mine,
  };
}

// Aggregated emoji reactions on a single gallery COMMENT, plus the viewer's own
// pick. Same shape as photoReactionState so the client can reuse its renderer.
function commentReactionState(commentId, viewerId) {
  const rows = db
    .prepare('SELECT emoji, COUNT(*) AS n FROM gallery_comment_reactions WHERE comment_id = ? GROUP BY emoji')
    .all(commentId);
  let mine = null;
  if (viewerId) {
    const r = db
      .prepare('SELECT emoji FROM gallery_comment_reactions WHERE comment_id = ? AND user_id = ?')
      .get(commentId, viewerId);
    mine = r ? r.emoji : null;
  }
  return {
    reactions: rows.map((r) => ({ emoji: r.emoji, count: r.n })),
    total: rows.reduce((sum, r) => sum + r.n, 0),
    mine,
  };
}

// Full comment thread for a single gallery photo. Top-level comments come newest
// first; each carries its `replies` (oldest first) and its emoji `reactions`.
// The photo owner or a comment's own author may delete it.
function photoComments(photoId, viewerId) {
  const owner = db.prepare('SELECT user_id FROM gallery_photos WHERE id = ?').get(photoId);
  const ownerId = owner ? owner.user_id : null;
  const rows = db
    .prepare(
      `SELECT c.id, c.author_id, c.body, c.created_at, c.parent_id, u.username, p.display_name, p.avatar
       FROM gallery_comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN profiles p ON p.user_id = c.author_id
       WHERE c.photo_id = ?
       ORDER BY c.created_at ASC
       LIMIT 500`
    )
    .all(photoId);

  const shape = (r) => ({
    id: r.id,
    parentId: r.parent_id || null,
    body: r.body,
    at: r.created_at,
    author: {
      id: r.author_id,
      username: r.username,
      displayName: r.display_name || r.username,
      avatar: r.avatar ? `/uploads/${r.avatar}` : null,
    },
    canDelete: !!viewerId && (viewerId === r.author_id || viewerId === ownerId),
    reactions: commentReactionState(r.id, viewerId),
    replies: [],
  });

  const byId = new Map();
  rows.forEach((r) => byId.set(r.id, shape(r)));
  const top = [];
  rows.forEach((r) => {
    const node = byId.get(r.id);
    if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).replies.push(node);
    else top.push(node);
  });
  top.sort((a, b) => b.at - a.at); // newest thread first; replies stay oldest-first
  return top;
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
// A member's overall points and leaderboard rank (see src/points.js).
function myPoints(userId) {
  const { rankedUsers } = require('./points'); // lazy: points pulls in the leaderboard queries
  const rows = rankedUsers();
  const me = rows.find((r) => r.id === userId);
  return me ? { total: me.totalPoints, rank: me.rank, of: rows.length } : { total: 0, rank: null, of: rows.length };
}

function buildProfile(userId, viewerId) {
  const row = db
    .prepare(
      `SELECT u.id, u.username,
              p.display_name, p.bio, p.avatar, p.updated_at,
              p.gender, p.date_of_birth, p.country, p.state, p.city, p.interests,
              u.education, u.education_stream, u.work_status, p.friends_visibility,
              p.gif_visibility, p.hidden, p.cover
       FROM users u JOIN profiles p ON p.user_id = u.id
       WHERE u.id = ?`
    )
    .get(userId);
  if (!row) return null;

  const isMe = viewerId === row.id;
  // Friends (and the owner) see everything; a follower sees a preview; anyone
  // else sees the basics only.
  const access = profileAccess(row.id, viewerId);
  const full = access === 'full';

  const allPhotos = buildGallery(userId, viewerId);
  const gallery = full ? allPhotos : access === 'follower' ? allPhotos.slice(0, FOLLOWER_PREVIEW_PHOTOS) : [];

  // GIF "feelings" collection, gated by the owner's chosen visibility.
  const fStateForGifs = friendState(row.id, viewerId);
  const gifVisibility = row.gif_visibility || 'public';
  const gifsAllowed = full && (
    isMe ||
    gifVisibility === 'public' ||
    (gifVisibility === 'friends' && fStateForGifs === 'friends'));
  const gifs = gifsAllowed ? buildGifs(userId) : [];
  // Only flag the collection as "locked" for a viewer when it's both hidden
  // from them AND actually has something in it.
  const gifsHidden = !gifsAllowed &&
    !!db.prepare('SELECT 1 FROM user_gifs WHERE user_id = ? LIMIT 1').get(userId);

  // Profile picture buffer (up to 10). Separate from the gallery and the single
  // display picture; the chat rotates through these.
  const bufferPhotos = db
    .prepare('SELECT id, filename FROM profile_buffer_photos WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);

  // The complete profile (details, friends list, comments, GIFs, the whole
  // gallery) is for friends only. Email is never included in this payload.
  const fState = friendState(row.id, viewerId);
  const friendList = friendsOf(row.id);
  const blocked = blockState(row.id, viewerId);

  // The relationship kind (always 'friend') between the owner
  // and the viewer, if any request exists in either direction.
  let relType = null;
  if (viewerId && viewerId !== row.id) {
    const rel = db
      .prepare(
        `SELECT rel_type FROM friendships
         WHERE (requester_id = ? AND addressee_id = ?)
            OR (requester_id = ? AND addressee_id = ?)`
      )
      .get(row.id, viewerId, viewerId, row.id);
    relType = rel ? rel.rel_type || 'friend' : null;
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    about: row.bio,
    avatar: row.avatar ? `/uploads/${row.avatar}` : null,
    gender: row.gender || null,
    dateOfBirth: isMe ? row.date_of_birth || null : null,
    country: row.country || null,
    state: full ? row.state || null : null,
    city: full ? row.city || null : null,
    interests: full ? parseInterests(row.interests) : [],
    education: full ? row.education || null : null,
    educationStream: full ? row.education_stream || null : null,
    workStatus: full ? row.work_status || null : null,
    // 'full' | 'follower' | 'basic' — see profileAccess().
    access,
    gallery,
    // How many photos/reels the gallery really has (a follower sees only the
    // newest FOLLOWER_PREVIEW_PHOTOS of them, others none).
    galleryTotal: allPhotos.length,
    gifs,
    // The chosen audience level for the GIF collection. `gifsLocked` tells a
    // viewer the owner has GIFs they're not allowed to see, so the UI can show
    // a small lock hint instead of an empty section.
    gifVisibility,
    gifsLocked: gifsHidden,
    buffer: isMe ? bufferPhotos.map((ph) => ({ id: ph.id, url: `/uploads/${ph.filename}` })) : [],
    rating: ratingSummary(row.id, viewerId),
    // Total likes this user has received on their Highway posts (shared images
    // included). Shown on the profile and factored into leaderboard ranking.
    likes: db
      .prepare('SELECT COUNT(*) AS n FROM highway_likes hl JOIN highway_posts hp ON hp.id = hl.post_id WHERE hp.user_id = ?')
      .get(row.id).n,
    comments: full ? commentsFor(row.id, viewerId) : [],
    // Followers / following, the fee a new follower pays, and whether the
    // viewer already follows (src/follows.js).
    follow: followSummary(row.id, viewerId),
    friends: {
      count: friendList.length,
      list: full ? friendList : [],
      state: fState,
      relType,
      // What a friend request to this member costs once accepted (they earn
      // `gain`) — see src/friendFees.js.
      fee: friendFeeOf(row.id),
      gain: friendFeeOf(row.id) * FRIEND_FEE_GAIN,
    },
    blocked,
    ignore: ignoreState(row.id, viewerId),
    isMe,
    // "Hidden from search" is a private setting — only the owner sees its state.
    hidden: isMe ? !!row.hidden : undefined,
    // The owner's fixed referral code (only they see it).
    referralCode: isMe && referrals.enabled() ? referrals.ensureCode(row.id) : undefined,
    // Background picture behind the name (anyone who can see the profile).
    cover: row.cover ? `/uploads/${row.cover}` : null,
    // Your own total leaderboard points and rank (shown only to you).
    points: isMe ? myPoints(row.id) : undefined,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  buildProfile,
  profileAccess,
  canSeePhoto,
  areFriends,
  FOLLOWER_PREVIEW_PHOTOS,
  friendState,
  friendsOf,
  ratingSummary,
  RATING_DIMS,
  commentsFor,
  buildGallery,
  buildGifs,
  photoReactionState,
  photoComments,
  commentReactionState,
  parseInterests,
};
