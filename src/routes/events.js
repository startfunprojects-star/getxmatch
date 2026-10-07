'use strict';

// Recent Events feed — a unified, time-ordered activity stream aggregated from
// real activity across the app plus admin-curated announcements:
//   • user relationships   (new accepted friendships)
//   • quiz attempts         (quizzes users attempted)
//   • admin events          (curated announcements)
//   • user-shared images    (photos/GIFs posted to the feed)
//   • profile updates       (new gallery photos/reels, GIFs and profile edits
//                            by members the viewer follows or is friends with)
//   • news                  (headlines from the admin's RSS feeds matching the
//                            viewer's areas of interest — src/news.js)
// Each activity row carries the viewer's friendship state with the actor so the
// UI can offer an "Add friend" action inline.

const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth');
const { friendState, canSeePhoto, parseInterests } = require('../profileData');
const news = require('../news');
const { isMinor } = require('../relations');
const { imageUpload } = require('../upload');
const { nsfwGuard } = require('../nsfw');
const { broadcastActivity } = require('../socket');
const { shareUploadToHighway } = require('../highwayShare');
const { acceptedText, sentText, relEmoji } = require('../relationships');

const router = express.Router();

// Recent Activity shows the latest FEED_SIZE activities. Anything older is
// dropped: rows that exist only for the feed (shared images and their files,
// announcements, hidden markers) are deleted by pruneActivity(); rows built
// from real data (friendships, quiz attempts, gallery photos…) just stop
// appearing — that data belongs to profiles, points and friendships.
const FEED_SIZE = 200;
const PER_SOURCE = FEED_SIZE;
const ACTIVITY_IMG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap for shared activity images

function userMini(id, viewerId) {
  const r = db
    .prepare(
      `SELECT u.id, u.username, p.display_name, p.avatar
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`
    )
    .get(id);
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name || r.username,
    avatar: r.avatar ? `/uploads/${r.avatar}` : null,
    isMe: r.id === viewerId,
    friendState: friendState(r.id, viewerId),
  };
}

// GET /api/events/public — a PUBLIC, no-auth activity feed for the sign-in page.
// Same feed the signed-in Recent Activity shows, but with the user-shared image
// posts omitted (no thumbnails on the sign-in page). Built with a null viewer.
router.get('/public', (req, res) => {
  res.json({ events: buildFeed(null, { includeImages: false }) });
});

// POST /api/events/activity-image — share an image/GIF onto the Recent Activity
// feed. Saved to disk and shown to everyone as a thumbnail (live + on reload).
router.post('/activity-image', requireAuth, imageUpload.single('image'), nsfwGuard, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
  // Hard 5 MB cap for activity images, regardless of the global upload limit.
  if (req.file.size > ACTIVITY_IMG_MAX_BYTES) {
    fs.promises.unlink(path.join(config.uploadsDir, req.file.filename)).catch(() => {});
    return res.status(413).json({ error: 'Image must be 5 MB or smaller.' });
  }
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO activity_posts (user_id, image, created_at) VALUES (?, ?, ?)')
    .run(req.user.id, req.file.filename, now);

  const actor = userMini(req.user.id, req.user.id);
  const url = `/uploads/${req.file.filename}`;
  const event = {
    id: 'post-' + info.lastInsertRowid,
    type: 'activity-image',
    at: now,
    icon: '🖼️',
    actor,
    target: null,
    text: `${actor ? actor.displayName : 'Someone'} shared an image`,
    image: url,
  };
  shareUploadToHighway(req.user.id, req.file.filename, '');
  setImmediate(pruneActivity); // the oldest activity may now fall out of the feed
  // Stream it live onto everyone's open feeds as a thumbnail.
  broadcastActivity({ at: now, icon: '🖼️', text: event.text, image: url });
  res.status(201).json({ event });
});

// Build the merged Recent Activity feed for `viewerId` (null = public / logged
// out). `includeImages` gates the user-shared image posts — excluded from the
// public sign-in feed so it never shows thumbnails. Actor/target metadata is
// attached but the feed renders plain text, so a null viewer is fine.
function buildFeed(viewerId, opts) {
  const me = viewerId;
  const includeImages = !opts || opts.includeImages !== false;
  const events = [];

  // 1) Accepted friendships.
  db.prepare(
    `SELECT id, requester_id, addressee_id, rel_type, created_at
     FROM friendships WHERE status = 'accepted' ORDER BY created_at DESC LIMIT ?`
  ).all(PER_SOURCE).forEach((f) => {
    const a = userMini(f.requester_id, me);
    const b = userMini(f.addressee_id, me);
    if (!a || !b) return;
    const type = f.rel_type || 'friend';
    events.push({
      id: 'friend-' + f.id,
      type: 'friendship',
      at: f.created_at,
      icon: relEmoji(type),
      actor: a,
      target: b,
      text: acceptedText(type, a.displayName, b.displayName),
    });
  });

  // 1b) Pending relationship requests that were sent (so a sent request shows on
  //     Recent Activity until it's accepted, declined or cancelled). The his/her/
  //     their possessive follows the sender's declared gender.
  db.prepare(
    `SELECT f.id, f.requester_id, f.addressee_id, f.rel_type, f.created_at,
            rp.gender AS requester_gender
     FROM friendships f
     LEFT JOIN profiles rp ON rp.user_id = f.requester_id
     WHERE f.status = 'pending' ORDER BY f.created_at DESC LIMIT ?`
  ).all(PER_SOURCE).forEach((f) => {
    const a = userMini(f.requester_id, me);
    const b = userMini(f.addressee_id, me);
    if (!a || !b) return;
    const type = f.rel_type || 'friend';
    events.push({
      id: 'req-' + f.id,
      type: 'request',
      at: f.created_at,
      icon: relEmoji(type),
      actor: a,
      target: b,
      text: sentText(type, a.displayName, b.displayName, f.requester_gender),
    });
  });

  // (Chats are private: who talks to whom never appears on the feed.)

  // 3) Quiz attempts.
  db.prepare(
    `SELECT qa.id, qa.user_id, qa.score, qa.total, qa.created_at, q.title
     FROM quiz_attempts qa JOIN quizzes q ON q.id = qa.quiz_id
     ORDER BY qa.created_at DESC LIMIT ?`
  ).all(PER_SOURCE).forEach((qa) => {
    const a = userMini(qa.user_id, me);
    if (!a) return;
    events.push({
      id: 'quiz-' + qa.id,
      type: 'quiz',
      at: qa.created_at,
      icon: '🧠',
      actor: a,
      target: null,
      text: `${a.displayName} attempted the quiz “${qa.title}” and earned ${qa.score}/${qa.total} points`,
    });
  });

  // 3c) User-shared images/GIFs — displayed as a thumbnail in the feed. Omitted
  //     from the public sign-in feed (no thumbnails there).
  if (includeImages) {
    db.prepare(
      'SELECT id, user_id, image, created_at FROM activity_posts ORDER BY created_at DESC LIMIT ?'
    ).all(PER_SOURCE).forEach((row) => {
      const a = userMini(row.user_id, me);
      if (!a) return;
      events.push({
        id: 'post-' + row.id,
        type: 'activity-image',
        at: row.created_at,
        icon: '🖼️',
        actor: a,
        target: null,
        text: `${a.displayName} shared an image`,
        image: `/uploads/${row.image}`,
      });
    });
  }

  // 3d) Profile updates from the members the viewer follows (or is friends
  //     with): new gallery photos / reels, new GIFs, and profile edits. Only in
  //     the viewer's own feed, never the public one. A photo carries a
  //     thumbnail only when the viewer is allowed to see it on the profile.
  if (me) {
    const watched = `(SELECT followee_id FROM follows WHERE follower_id = @me
                      UNION
                      SELECT CASE WHEN requester_id = @me THEN addressee_id ELSE requester_id END
                        FROM friendships
                       WHERE (requester_id = @me OR addressee_id = @me) AND status = 'accepted')`;
    db.prepare(
      `SELECT id, user_id, filename, kind, created_at FROM gallery_photos
        WHERE user_id IN ${watched} ORDER BY created_at DESC LIMIT @n`
    ).all({ me, n: PER_SOURCE }).forEach((row) => {
      const a = userMini(row.user_id, me);
      if (!a) return;
      const isReel = row.kind === 'reel';
      events.push({
        id: 'gallery-' + row.id,
        type: 'profile-update',
        at: row.created_at,
        icon: isReel ? '🎬' : '📷',
        actor: a,
        target: null,
        text: `${a.displayName} added a new ${isReel ? 'reel' : 'photo'} to their gallery`,
        image: !isReel && canSeePhoto({ id: row.id, user_id: row.user_id }, me) ? `/uploads/${row.filename}` : undefined,
      });
    });
    db.prepare(
      `SELECT id, user_id, created_at FROM user_gifs
        WHERE user_id IN ${watched} ORDER BY created_at DESC LIMIT @n`
    ).all({ me, n: PER_SOURCE }).forEach((row) => {
      const a = userMini(row.user_id, me);
      if (!a) return;
      events.push({
        id: 'gif-' + row.id,
        type: 'profile-update',
        at: row.created_at,
        icon: '🎞️',
        actor: a,
        target: null,
        text: `${a.displayName} added a new GIF feeling`,
      });
    });
    db.prepare(
      `SELECT user_id, updated_at FROM profiles
        WHERE user_id IN ${watched} AND updated_at IS NOT NULL ORDER BY updated_at DESC LIMIT @n`
    ).all({ me, n: PER_SOURCE }).forEach((row) => {
      const a = userMini(row.user_id, me);
      if (!a) return;
      events.push({
        id: `profile-${row.user_id}-${row.updated_at}`,
        type: 'profile-update',
        at: row.updated_at,
        icon: '✏️',
        actor: a,
        target: null,
        text: `${a.displayName} updated their profile`,
      });
    });
  }

  // 3e) News for the viewer's areas of interest (signed-in feed only; members
  //     under 18 see family-safe sources only). Each row links out to the
  //     article on the source's own site.
  if (me) {
    const prof = db.prepare('SELECT interests FROM profiles WHERE user_id = ?').get(me);
    const interests = prof ? parseInterests(prof.interests) : [];
    news.itemsForInterests(interests, { familySafeOnly: isMinor(me), limit: 25 }).forEach((n) => {
      events.push({
        id: 'news-' + n.id,
        type: 'news',
        at: n.at,
        icon: '📰',
        actor: null,
        target: null,
        text: n.title,
        news: { source: n.source, link: n.link, snippet: n.snippet, interest: n.interest },
      });
    });
  }

  // 4) Admin-curated announcements.
  db.prepare('SELECT id, title, body, created_at FROM admin_events ORDER BY created_at DESC LIMIT ?')
    .all(PER_SOURCE)
    .forEach((e) => {
      events.push({
        id: 'admin-' + e.id,
        type: 'admin',
        at: e.created_at,
        icon: '📣',
        actor: null,
        target: null,
        title: e.title,
        text: e.body || e.title,
      });
    });

  // Drop what the admin removed from the feed.
  const hidden = new Map(db.prepare('SELECT event_id, hidden_up_to FROM hidden_activities').all()
    .map((h) => [h.event_id, h.hidden_up_to]));
  const visible = events.filter((ev) => !(hidden.has(ev.id) && ev.at <= hidden.get(ev.id)));

  visible.sort((a, b) => b.at - a.at);
  // News is woven in (one headline after every NEWS_EVERY other items) rather
  // than sorted by time, so fresh headlines never bury members' own activity.
  const others = visible.filter((ev) => ev.type !== 'news');
  const headlines = visible.filter((ev) => ev.type === 'news');
  const merged = [];
  others.forEach((ev, i) => {
    merged.push(ev);
    if ((i + 1) % NEWS_EVERY === 0 && headlines.length) merged.push(headlines.shift());
  });
  return merged.concat(headlines).slice(0, FEED_SIZE);
}

// Delete feed-only rows that have fallen out of the latest FEED_SIZE. The
// cut-off comes from the shared feed (no viewer): a member's own feed only
// adds rows, so nothing older than it can be in anyone's latest FEED_SIZE.
function pruneActivity() {
  try {
    const feed = buildFeed(null);
    if (feed.length < FEED_SIZE) return;
    const cutoff = feed[FEED_SIZE - 1].at;
    const old = db.prepare('SELECT id, image FROM activity_posts WHERE created_at < ?').all(cutoff);
    db.prepare('DELETE FROM activity_posts WHERE created_at < ?').run(cutoff);
    old.forEach((r) => {
      if (r.image) fs.promises.unlink(path.join(config.uploadsDir, path.basename(r.image))).catch(() => {});
    });
    db.prepare('DELETE FROM admin_events WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM hidden_activities WHERE hidden_up_to < ?').run(cutoff);
  } catch (_e) { /* pruning must never break the feed */ }
}
setTimeout(pruneActivity, 15000).unref();
setInterval(pruneActivity, 60 * 60 * 1000).unref();

const NEWS_EVERY = 3;

// GET /api/events — merged recent activity for the signed-in user.
router.get('/', requireAuth, (req, res) => {
  res.json({ events: buildFeed(req.user.id) });
});

module.exports = router;
module.exports.buildFeed = buildFeed;
module.exports.pruneActivity = pruneActivity;
module.exports.FEED_SIZE = FEED_SIZE;
