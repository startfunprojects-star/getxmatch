'use strict';

// Recent Events feed — a time-ordered activity stream. The only member
// activity on it is new gallery content; everything else members do (friend
// requests and friendships, quizzes, shared images, profile pictures, GIFs,
// profile edits) stays off the feed:
//   • gallery uploads       (new gallery photos/reels by the members the viewer
//                            follows or is friends with, and the viewer's own)
//   • admin events          (curated announcements)
//   • news                  (headlines from the admin's RSS feeds matching the
//                            viewer's areas of interest and chosen country —
//                            src/news.js, src/newsCountries.js)
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
const alerts = require('../alerts');
const newsCountries = require('../newsCountries');
const jobs = require('../jobs');
const { isMinor } = require('../relations');
const { imageUpload } = require('../upload');
const { nsfwGuard } = require('../nsfw');
const { shareUploadToHighway } = require('../highwayShare');

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
// Built with a null viewer, so it carries no member activity (gallery uploads
// are only for followers and friends): just the announcements.
router.get('/public', (req, res) => {
  res.json({ events: buildFeed(null) });
});

// POST /api/events/activity-image — share an image/GIF from the chat status bar.
// It goes to the Highway only (Recent Activity shows gallery uploads, not shared
// images); the Highway post keeps its own copy of the file.
router.post('/activity-image', requireAuth, imageUpload.single('image'), nsfwGuard, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });
  // Hard 5 MB cap for activity images, regardless of the global upload limit.
  if (req.file.size > ACTIVITY_IMG_MAX_BYTES) {
    fs.promises.unlink(path.join(config.uploadsDir, req.file.filename)).catch(() => {});
    return res.status(413).json({ error: 'Image must be 5 MB or smaller.' });
  }
  shareUploadToHighway(req.user.id, req.file.filename, '');
  fs.promises.unlink(path.join(config.uploadsDir, req.file.filename)).catch(() => {});
  res.status(201).json({ ok: true });
});

// Build the merged Recent Activity feed for `viewerId` (null = public / logged
// out). Actor metadata is attached but the feed renders plain text, so a null
// viewer is fine.
function buildFeed(viewerId) {
  const me = viewerId;
  const events = [];

  // 1) New gallery photos / reels from the members the viewer follows (or is
  //    friends with), and the viewer's own. Only in the viewer's own feed,
  //    never the public one. A photo carries a thumbnail only when the viewer
  //    is allowed to see it on the profile.
  if (me) {
    const watchedOrMe = `(SELECT @me
                          UNION
                          SELECT followee_id FROM follows WHERE follower_id = @me
                          UNION
                          SELECT CASE WHEN requester_id = @me THEN addressee_id ELSE requester_id END
                            FROM friendships
                           WHERE (requester_id = @me OR addressee_id = @me) AND status = 'accepted')`;
    db.prepare(
      `SELECT id, user_id, filename, kind, created_at FROM gallery_photos
        WHERE user_id IN ${watchedOrMe} ORDER BY created_at DESC LIMIT @n`
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
  }

  // 2) News for the viewer's areas of interest (signed-in feed only; members
  //     under 18 see family-safe sources only). Each row links out to the
  //     article on the source's own site.
  if (me) {
    const prof = db.prepare('SELECT interests FROM profiles WHERE user_id = ?').get(me);
    const interests = prof ? parseInterests(prof.interests) : [];
    const { country } = newsCountries.forUser(me);
    news.itemsForInterests(interests, {
      familySafeOnly: isMinor(me),
      limit: 25,
      country: country === newsCountries.WORLDWIDE ? null : country,
    }).forEach((n) => {
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

  // 3) Admin-curated announcements.
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
// Images shared onto the feed in the past (activity_posts) no longer show on it
// — each has its own copy on the Highway — so those rows and files go too.
function pruneActivity() {
  try {
    const shared = db.prepare('SELECT image FROM activity_posts').all();
    db.prepare('DELETE FROM activity_posts').run();
    shared.forEach((r) => {
      if (r.image) fs.promises.unlink(path.join(config.uploadsDir, path.basename(r.image))).catch(() => {});
    });
    const feed = buildFeed(null);
    if (feed.length < FEED_SIZE) return;
    const cutoff = feed[FEED_SIZE - 1].at;
    db.prepare('DELETE FROM admin_events WHERE created_at < ?').run(cutoff);
    db.prepare('DELETE FROM hidden_activities WHERE hidden_up_to < ?').run(cutoff);
  } catch (_e) { /* pruning must never break the feed */ }
}
setTimeout(pruneActivity, 15000).unref();
setInterval(pruneActivity, 60 * 60 * 1000).unref();

const NEWS_EVERY = 3;

// GET /api/events/alerts — the latest alerts for the admin's keywords (and
// websites), shown above the feed on Recent Activity (src/alerts.js).
// Alerts are for the member's chosen country (all countries for 'Worldwide').
function alertsFor(userId) {
  const { keywords } = alerts.getConfig();
  const { country, chosen } = newsCountries.forUser(userId);
  const only = country === newsCountries.WORLDWIDE ? null : country;
  const jc = jobs.jobsCountryFor(userId);
  return {
    alerts: alerts.listAlerts({ country: only }).map(({ hidden: _h, ...a }) => a),
    jobs: jobs.listJobs({ country: jc.country === newsCountries.WORLDWIDE ? null : jc.country })
      .map(({ hidden: _h, ...j }) => j),
    jobsCountry: jc.country,
    jobsChosen: jc.chosen,
    jobCountries: jobs.countriesWithJobs(),
    keywords,
    country,
    chosen,
    countries: newsCountries.COUNTRIES,
  };
}

// PUT /api/events/jobs-country  { country } — the country this member wants
// job openings from: a listed country, 'Worldwide', or '' to follow their
// alerts country.
router.put('/jobs-country', requireAuth, (req, res) => {
  const want = String((req.body && req.body.country) || '');
  if (want && want !== newsCountries.WORLDWIDE && !newsCountries.isCountry(want)) {
    return res.status(400).json({ error: 'Choose a country from the list.' });
  }
  jobs.setJobsCountry(req.user.id, want);
  res.json(alertsFor(req.user.id));
});

router.get('/alerts', requireAuth, (req, res) => {
  res.json(alertsFor(req.user.id));
});

// PUT /api/events/news-country  { country } — the country this member wants
// alerts and news for: one of the listed countries, 'Worldwide', or '' to
// follow their profile country. A country not fetched recently is fetched
// before replying, so the new alerts and news show straight away.
router.put('/news-country', requireAuth, async (req, res) => {
  const want = String((req.body && req.body.country) || '');
  if (want && want !== newsCountries.WORLDWIDE && !newsCountries.isCountry(want)) {
    return res.status(400).json({ error: 'Choose a country from the list.' });
  }
  const { country } = newsCountries.setForUser(req.user.id, want);
  if (country !== newsCountries.WORLDWIDE) {
    await Promise.all([alerts.prepareCountry(country), news.prepareCountry(country)]).catch(() => {});
  }
  res.json(alertsFor(req.user.id));
});

// GET /api/events — merged recent activity for the signed-in user.
router.get('/', requireAuth, (req, res) => {
  res.json({ events: buildFeed(req.user.id) });
});

module.exports = router;
module.exports.buildFeed = buildFeed;
module.exports.pruneActivity = pruneActivity;
module.exports.FEED_SIZE = FEED_SIZE;
