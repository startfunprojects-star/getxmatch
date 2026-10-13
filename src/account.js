'use strict';

// Account self-service helpers: delete a member together with their uploaded
// files, and build their "Download my data" archive.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const config = require('./config');
const { ZipWriter } = require('./zip');
const { rankedUsers } = require('./points');
const voiceNotes = require('./voiceNotes');

const UPLOAD_NAME = /^[\w.-]+$/;
const BLOG_IMAGE = /\/uploads\/([0-9a-f]{32}\.(?:jpg|png|webp|gif))/g;

// Columns that hold a filename in uploads/. Used to find a member's files and
// to check a file is no longer used by anyone before it's deleted.
const FILE_COLUMNS = [
  ['profiles', 'avatar'],
  ['profiles', 'cover'],
  ['gallery_photos', 'filename'],
  ['user_gifs', 'filename'],
  ['profile_buffer_photos', 'filename'],
  ['avatar_changes', 'filename'],
  ['highway_posts', 'image'],
  ['highway_media', 'filename'],
  ['activity_posts', 'image'],
  ['blogs', 'cover'],
];

function safeAll(sql, ...args) {
  try { return db.prepare(sql).all(...args); } catch (_e) { return []; }
}

// Every uploads/ file that belongs to this member.
function uploadsOf(userId) {
  const files = new Set();
  const add = (f) => { if (f && UPLOAD_NAME.test(path.basename(f))) files.add(path.basename(f)); };
  safeAll('SELECT avatar, cover FROM profiles WHERE user_id = ?', userId).forEach((r) => { add(r.avatar); add(r.cover); });
  ['gallery_photos', 'user_gifs', 'profile_buffer_photos', 'avatar_changes'].forEach((t) =>
    safeAll(`SELECT filename FROM ${t} WHERE user_id = ?`, userId).forEach((r) => add(r.filename)));
  safeAll('SELECT image FROM highway_posts WHERE user_id = ?', userId).forEach((r) => add(r.image));
  safeAll('SELECT m.filename FROM highway_media m JOIN highway_posts p ON p.id = m.post_id WHERE p.user_id = ?', userId)
    .forEach((r) => add(r.filename));
  safeAll('SELECT image FROM activity_posts WHERE user_id = ?', userId).forEach((r) => add(r.image));
  safeAll('SELECT cover, body FROM blogs WHERE user_id = ?', userId).forEach((r) => {
    add(r.cover);
    for (const m of String(r.body || '').matchAll(BLOG_IMAGE)) add(m[1]);
  });
  return [...files];
}

function stillUsed(filename) {
  for (const [table, col] of FILE_COLUMNS) {
    if (safeAll(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1`, filename).length) return true;
  }
  return safeAll("SELECT 1 FROM blogs WHERE body LIKE ? LIMIT 1", `%/uploads/${filename}%`).length > 0;
}

// Delete a member and everything that belongs to them. Rows go through the
// foreign-key cascades; uploaded pictures, reels and voice notes are deleted
// from disk afterwards (unless something else still uses the same file).
function deleteUser(userId) {
  const files = uploadsOf(userId);
  const voice = safeAll('SELECT file FROM voice_notes WHERE owner_id = ?', userId).map((r) => r.file);
  const info = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  if (!info.changes) return false;
  // Members they referred keep their account; the link just goes.
  db.prepare('UPDATE users SET referred_by = NULL WHERE referred_by = ?').run(userId);
  for (const f of files) {
    if (!stillUsed(f)) fs.promises.unlink(path.join(config.uploadsDir, f)).catch(() => {});
  }
  for (const f of voice) fs.promises.unlink(voiceNotes.filePath({ file: f })).catch(() => {});
  return true;
}

/* ------------------------------- data export ------------------------------- */

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const json = (v) => JSON.stringify(v, null, 2);
function parse(s, fallback) {
  try { return JSON.parse(s); } catch (_e) { return fallback; }
}
function nameOf(id) {
  const r = safeAll('SELECT u.username, p.display_name FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?', id)[0];
  return r ? { username: r.username, name: r.display_name || r.username } : { username: null, name: '(deleted member)' };
}
const who = (id) => nameOf(id).username || '(deleted member)';

// Write the member's archive to `out` (an HTTP response).
async function writeExport(userId, out) {
  const zip = new ZipWriter(out);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const p = safeAll('SELECT * FROM profiles WHERE user_id = ?', userId)[0] || null;

  await zip.add('README.txt',
    `Your getxmatch data\n===================\n\nExported ${new Date().toUTCString()} for @${u.username}.\n\n` +
    'account.json      your account details\n' +
    'profile.json      your profile\n' +
    'points.json       your points and how they add up\n' +
    'connections.json  friends, followers, people you follow, blocks\n' +
    'messages.json     your 1:1 and group chat messages (text)\n' +
    'posts.json        your Highway posts, comments, blogs and gallery captions\n' +
    'activity.json     quiz attempts, poll votes, ratings and suggestions\n' +
    'photos/           your profile pictures, gallery photos and reels\n' +
    'highway/          pictures and videos you posted on the Highway\n' +
    'voice-notes/      voice notes you recorded\n\n' +
    'Files shared in chats are never stored on getxmatch, so they are not included.\n');

  await zip.add('account.json', json({
    username: u.username,
    email: u.email,
    createdAt: iso(u.created_at),
    lastLoginAt: iso(u.last_login_at),
    education: u.education,
    educationStream: u.education_stream,
    workStatus: u.work_status,
    referralCode: u.referral_code,
    referredBy: u.referred_by ? who(u.referred_by) : null,
    friendFee: u.friend_fee,
  }));

  await zip.add('profile.json', json(p && {
    displayName: p.display_name,
    about: p.bio,
    gender: p.gender,
    dateOfBirth: p.date_of_birth,
    country: p.country,
    state: p.state,
    city: p.city,
    interests: parse(p.interests, p.interests),
    hiddenFromSearch: !!p.hidden,
    updatedAt: iso(p.updated_at),
  }));

  const me = rankedUsers().find((r) => r.id === userId) || null;
  await zip.add('points.json', json(me));

  const friendRows = safeAll('SELECT * FROM friendships WHERE requester_id = ? OR addressee_id = ?', userId, userId);
  await zip.add('connections.json', json({
    friends: friendRows.filter((f) => f.status === 'accepted').map((f) => ({
      member: who(f.requester_id === userId ? f.addressee_id : f.requester_id),
      since: iso(f.accepted_at || f.created_at),
    })),
    requestsSent: friendRows.filter((f) => f.status !== 'accepted' && f.requester_id === userId)
      .map((f) => ({ to: who(f.addressee_id), status: f.status, at: iso(f.created_at) })),
    requestsReceived: friendRows.filter((f) => f.status !== 'accepted' && f.addressee_id === userId)
      .map((f) => ({ from: who(f.requester_id), status: f.status, at: iso(f.created_at) })),
    followers: safeAll('SELECT follower_id, created_at FROM follows WHERE followee_id = ?', userId)
      .map((r) => ({ member: who(r.follower_id), since: iso(r.created_at) })),
    following: safeAll('SELECT followee_id, created_at FROM follows WHERE follower_id = ?', userId)
      .map((r) => ({ member: who(r.followee_id), since: iso(r.created_at) })),
    blocked: safeAll('SELECT blocked_id, created_at FROM blocks WHERE blocker_id = ?', userId)
      .map((r) => ({ member: who(r.blocked_id), at: iso(r.created_at) })),
    groups: safeAll(
      `SELECT g.name, m.status, m.created_at FROM chat_group_members m JOIN chat_groups g ON g.id = m.group_id WHERE m.user_id = ?`, userId)
      .map((r) => ({ name: r.name, status: r.status, joined: iso(r.created_at) })),
  }));

  await zip.add('messages.json', json({
    direct: safeAll(
      `SELECT sender_id, recipient_id, body, kind, created_at FROM messages
        WHERE (sender_id = ? OR recipient_id = ?) AND deleted_at IS NULL ORDER BY created_at`, userId, userId)
      .map((m) => ({ from: who(m.sender_id), to: who(m.recipient_id), kind: m.kind, text: m.body, at: iso(m.created_at) })),
    groupMessagesYouSent: safeAll(
      `SELECT g.name, gm.body, gm.kind, gm.created_at FROM group_messages gm JOIN chat_groups g ON g.id = gm.group_id
        WHERE gm.sender_id = ? AND gm.deleted_at IS NULL ORDER BY gm.created_at`, userId)
      .map((m) => ({ group: m.name, kind: m.kind, text: m.body, at: iso(m.created_at) })),
  }));

  const blogs = safeAll('SELECT * FROM blogs WHERE user_id = ? ORDER BY created_at', userId);
  const gallery = safeAll('SELECT * FROM gallery_photos WHERE user_id = ? ORDER BY created_at', userId);
  const posts = safeAll('SELECT * FROM highway_posts WHERE user_id = ? ORDER BY created_at', userId);
  await zip.add('posts.json', json({
    highwayPosts: posts.map((h) => ({ text: h.body, at: iso(h.created_at) })),
    highwayComments: safeAll('SELECT body, created_at FROM highway_comments WHERE author_id = ? ORDER BY created_at', userId)
      .map((c) => ({ text: c.body, at: iso(c.created_at) })),
    blogs: blogs.map((b) => ({
      title: b.title, status: b.status, category: b.category, tags: parse(b.tags, []), excerpt: b.excerpt,
      bodyHtml: b.body, views: b.views, createdAt: iso(b.created_at), publishedAt: iso(b.published_at),
    })),
    blogComments: safeAll('SELECT body, created_at FROM blog_comments WHERE author_id = ? ORDER BY created_at', userId)
      .map((c) => ({ text: c.body, at: iso(c.created_at) })),
    profileComments: safeAll('SELECT subject_id, body, created_at FROM comments WHERE author_id = ? ORDER BY created_at', userId)
      .map((c) => ({ on: who(c.subject_id), text: c.body, at: iso(c.created_at) })),
    gallery: gallery.map((g) => ({ file: `photos/${g.filename}`, kind: g.kind, caption: g.caption, location: g.location, at: iso(g.created_at) })),
  }));

  await zip.add('activity.json', json({
    quizAttempts: safeAll(
      `SELECT q.title, a.score, a.total, a.created_at FROM quiz_attempts a LEFT JOIN quizzes q ON q.id = a.quiz_id
        WHERE a.user_id = ? ORDER BY a.created_at`, userId)
      .map((a) => ({ quiz: a.title, score: a.score, total: a.total, at: iso(a.created_at) })),
    pollVotes: safeAll(
      `SELECT p.question, v.option_index, v.created_at FROM poll_votes v LEFT JOIN polls p ON p.id = v.poll_id
        WHERE v.user_id = ? ORDER BY v.created_at`, userId)
      .map((v) => ({ poll: v.question, option: v.option_index, at: iso(v.created_at) })),
    ratingsGiven: safeAll('SELECT * FROM ratings WHERE rater_id = ?', userId)
      .map((r) => ({ member: who(r.ratee_id), knowledgeable: r.knowledgeable, helpful: r.helpful, creative: r.creative, thoughtful: r.thoughtful })),
    ratingsReceived: safeAll('SELECT * FROM ratings WHERE ratee_id = ?', userId)
      .map((r) => ({ knowledgeable: r.knowledgeable, helpful: r.helpful, creative: r.creative, thoughtful: r.thoughtful, at: iso(r.created_at) })),
    suggestions: safeAll('SELECT category, body, status, reply, created_at FROM suggestions WHERE user_id = ? ORDER BY created_at', userId)
      .map((s) => ({ category: s.category, text: s.body, status: s.status, adminReply: s.reply, at: iso(s.created_at) })),
  }));

  // Files: profile pictures and gallery, Highway media, voice notes.
  const up = (f) => path.join(config.uploadsDir, path.basename(f));
  if (p && p.avatar) await zip.addFile(`photos/profile-picture${path.extname(p.avatar)}`, up(p.avatar));
  if (p && p.cover) await zip.addFile(`photos/cover-photo${path.extname(p.cover)}`, up(p.cover));
  for (const g of gallery) await zip.addFile(`photos/${g.filename}`, up(g.filename));
  for (const h of posts) {
    if (h.image) await zip.addFile(`highway/${h.image}`, up(h.image));
    for (const m of safeAll('SELECT filename FROM highway_media WHERE post_id = ? ORDER BY position', h.id)) {
      await zip.addFile(`highway/${m.filename}`, up(m.filename));
    }
  }
  for (const v of safeAll('SELECT file FROM voice_notes WHERE owner_id = ?', userId)) {
    await zip.addFile(`voice-notes/${path.basename(v.file)}`, voiceNotes.filePath(v));
  }

  await zip.finish();
}

module.exports = { deleteUser, writeExport, uploadsOf };
