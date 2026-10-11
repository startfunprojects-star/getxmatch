'use strict';

// Member blogs API (see src/blogs.js).
//
//   GET    /api/blogs                 search / filter / sort published posts (?mine=1 for my posts incl. drafts)
//   GET    /api/blogs/meta            categories and popular tags
//   GET    /api/blogs/:id             one post (drafts only to their writer)
//   POST   /api/blogs                 write a post (multipart: cover + fields)
//   PUT    /api/blogs/:id             edit my post
//   DELETE /api/blogs/:id             delete my post
//   POST   /api/blogs/images          upload a picture to place inside a post
//   POST   /api/blogs/:id/like        like / unlike (the writer earns 1 point per like)
//   GET    /api/blogs/:id/comments    threaded comments
//   POST   /api/blogs/:id/comments    { body, parentId? }
//   DELETE /api/blogs/comments/:cid   the commenter or the writer

const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

const db = require('../db');
const config = require('../config');
const { requireAuth } = require('../auth');
const { imageUpload } = require('../upload');
const nsfw = require('../nsfw');
const { requireSafeLinks, checkText } = require('../linkSafety');
const { areBlocked, ignoredIds } = require('../relations');
const { broadcastHighway, broadcastLeaderboardChange, notifyUser } = require('../socket');
const hw = require('../highway');
const blogs = require('../blogs');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'You are saving blog posts very quickly. Please wait a little.' },
});
const imageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many pictures uploaded. Please wait a little.' },
});
const commentLimiter = rateLimit({
  windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'You are commenting very quickly. Please wait a moment.' },
});

function removeUpload(filename) {
  if (!filename) return;
  fs.promises.unlink(path.join(config.uploadsDir, path.basename(filename))).catch(() => {});
}

// Every uploaded picture a post's body uses (to tidy up when it's deleted).
function bodyImages(html) {
  return [...String(html || '').matchAll(/src="\/uploads\/([0-9a-f]{32}\.(?:jpg|png|webp|gif))"/g)].map((m) => m[1]);
}

// Reject an uploaded picture that fails the size or nudity check.
async function vetImage(req, res, next) {
  const f = req.file;
  if (!f) return next();
  try {
    const result = await nsfw.checkImage(f.path);
    if (result.blocked) {
      removeUpload(f.filename);
      return res.status(400).json({ error: nsfw.rejectionMessage(result, 'an image') });
    }
    next();
  } catch (e) { removeUpload(f.filename); next(e); }
}

const coverUpload = (req, res, next) => imageUpload.single('cover')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.message || 'Could not upload that picture.' });
  next();
});

function blogOr404(req, res) {
  const id = parseInt(req.params.id, 10);
  const row = id && blogs.byId(id);
  if (!row || (row.status !== 'published' && row.user_id !== req.user.id)) {
    res.status(404).json({ error: 'Blog post not found.' });
    return null;
  }
  return row;
}

// Fields from a create/edit form, cleaned. Returns { error } or { fields }.
async function readFields(body) {
  const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, blogs.TITLE_MAX);
  const html = blogs.cleanHtml(body.body);
  const text = blogs.textOf(html, 'html');
  const status = body.status === 'draft' ? 'draft' : 'published';
  if (!title) return { error: 'Give your post a title.' };
  if (status === 'published' && text.replace(/\s/g, '').length < 20 && !/<(img|iframe)\b/.test(html)) {
    return { error: 'Write a little more before publishing (at least a couple of sentences).' };
  }
  if (html.length > blogs.BODY_MAX) return { error: 'This post is too long. Please split it into parts.' };
  const verdict = await checkText(`${title}\n${body.excerpt || ''}\n${(html.match(/href="[^"]+"/g) || []).map((h) => h.slice(6, -1)).join(' ')}`);
  if (!verdict.safe) return { error: verdict.message || 'This post contains a link that looks unsafe.' };
  const category = blogs.CATEGORIES.includes(body.category) ? body.category : 'Other';
  return {
    fields: {
      title,
      excerpt: String(body.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, blogs.EXCERPT_MAX),
      body: html,
      status,
      category,
      tags: JSON.stringify(blogs.cleanTags(body.tags)),
    },
  };
}

// First publish: list the post on the Highway (a card linking to the blog).
// The Highway post carries no files of its own, so pruning it never removes
// the blog's cover.
function listOnHighway(blogId, userId) {
  try {
    const { id, prunedImages } = hw.createPost({ userId, body: '', origin: { kind: 'blog', a: blogId, b: null } });
    prunedImages.forEach(removeUpload);
    const r = hw.byId(id);
    const blog = blogCard(blogId);
    broadcastHighway({
      id, body: '', image: null, media: [], createdAt: r.created_at, blog,
      author: { id: userId, username: r.username, displayName: r.display_name || r.username, avatar: r.avatar ? `/uploads/${r.avatar}` : null },
    }, (viewerId) => hw.canSeeAuthor(viewerId, userId));
  } catch (e) { console.error('blogs: highway listing failed:', e.message); }
}

// The small blog summary a Highway card shows.
function blogCard(blogId) {
  const r = blogs.byId(blogId);
  if (!r || r.status !== 'published') return null;
  const s = blogs.shape(r, null, false);
  return { id: s.id, title: s.title, excerpt: s.excerpt, cover: s.cover, category: s.category, readMinutes: s.readMinutes };
}

/* ------------------------------- reading ------------------------------- */

router.get('/', requireAuth, (req, res) => {
  const q = req.query;
  res.json(blogs.list(req.user.id, {
    q: String(q.q || '').slice(0, 100),
    category: blogs.CATEGORIES.includes(q.category) ? q.category : null,
    tag: q.tag ? String(q.tag).slice(0, 40) : null,
    author: q.author ? String(q.author).slice(0, 40) : null,
    mine: q.mine === '1',
    sort: String(q.sort || 'new'),
    since: { week: Date.now() - 7 * 864e5, month: Date.now() - 30 * 864e5, year: Date.now() - 365 * 864e5 }[q.period] || null,
    offset: q.offset,
    hideAuthors: ignoredIds(req.user.id),
  }));
});

router.get('/meta', requireAuth, (req, res) => {
  res.json({ categories: blogs.CATEGORIES, tags: blogs.popularTags() });
});

router.get('/:id', requireAuth, (req, res) => {
  const row = blogOr404(req, res);
  if (!row) return;
  if (row.status === 'published' && row.user_id !== req.user.id) {
    db.prepare('UPDATE blogs SET views = views + 1 WHERE id = ?').run(row.id);
  }
  res.json({ blog: blogs.shape(blogs.byId(row.id), req.user.id, true) });
});

/* ------------------------------- writing ------------------------------- */

router.post('/images', requireAuth, imageLimiter, (req, res, next) => imageUpload.single('image')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.message || 'Could not upload that picture.' });
  next();
}), vetImage, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a picture.' });
  res.status(201).json({ url: `/uploads/${req.file.filename}` });
});

router.post('/', requireAuth, writeLimiter, coverUpload, vetImage, async (req, res) => {
  const { error, fields } = await readFields(req.body || {});
  if (error) { removeUpload(req.file && req.file.filename); return res.status(400).json({ error }); }
  const now = Date.now();
  const info = db.prepare(
    `INSERT INTO blogs (user_id, title, author, excerpt, body, cover, format, status, category, tags, created_at, updated_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, 'html', ?, ?, ?, ?, ?, ?)`
  ).run(req.user.id, fields.title, req.user.username, fields.excerpt, fields.body, req.file ? req.file.filename : null,
    fields.status, fields.category, fields.tags, now, now, fields.status === 'published' ? now : null);
  const id = Number(info.lastInsertRowid);
  if (fields.status === 'published') listOnHighway(id, req.user.id);
  res.status(201).json({ blog: blogs.shape(blogs.byId(id), req.user.id, true) });
});

router.put('/:id', requireAuth, writeLimiter, coverUpload, vetImage, async (req, res) => {
  const row = db.prepare('SELECT * FROM blogs WHERE id = ?').get(parseInt(req.params.id, 10) || 0);
  if (!row || row.user_id !== req.user.id) {
    removeUpload(req.file && req.file.filename);
    return res.status(404).json({ error: 'Blog post not found.' });
  }
  const { error, fields } = await readFields(req.body || {});
  if (error) { removeUpload(req.file && req.file.filename); return res.status(400).json({ error }); }

  let cover = row.cover;
  if (req.file) cover = req.file.filename;
  else if (req.body.removeCover === '1') cover = null;
  if (cover !== row.cover) removeUpload(row.cover);
  // Pictures that were in the old body but not the new one.
  const kept = new Set(bodyImages(fields.body));
  bodyImages(row.body).filter((f) => !kept.has(f)).forEach(removeUpload);

  const firstPublish = fields.status === 'published' && !row.published_at;
  db.prepare(
    `UPDATE blogs SET title = ?, excerpt = ?, body = ?, cover = ?, status = ?, category = ?, tags = ?, updated_at = ?,
            published_at = COALESCE(published_at, ?) WHERE id = ?`
  ).run(fields.title, fields.excerpt, fields.body, cover, fields.status, fields.category, fields.tags, Date.now(),
    fields.status === 'published' ? Date.now() : null, row.id);
  if (firstPublish) listOnHighway(row.id, req.user.id);
  res.json({ blog: blogs.shape(blogs.byId(row.id), req.user.id, true) });
});

router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM blogs WHERE id = ?').get(parseInt(req.params.id, 10) || 0);
  if (!row || row.user_id !== req.user.id) return res.status(404).json({ error: 'Blog post not found.' });
  db.prepare("DELETE FROM highway_posts WHERE origin_kind = 'blog' AND origin_a = ?").run(row.id);
  db.prepare('DELETE FROM blogs WHERE id = ?').run(row.id);
  removeUpload(row.cover);
  bodyImages(row.body).forEach(removeUpload);
  broadcastLeaderboardChange(); // its likes no longer count
  res.json({ ok: true });
});

/* -------------------------- likes and comments -------------------------- */

router.post('/:id/like', requireAuth, (req, res) => {
  const row = blogOr404(req, res);
  if (!row) return;
  if (row.user_id === req.user.id) return res.status(400).json({ error: 'You can’t like your own post.' });
  if (row.status !== 'published') return res.status(400).json({ error: 'This post isn’t published.' });
  if (row.user_id && areBlocked(req.user.id, row.user_id)) return res.status(403).json({ error: 'You can’t like this post.' });
  const had = db.prepare('SELECT 1 FROM blog_likes WHERE blog_id = ? AND user_id = ?').get(row.id, req.user.id);
  if (had) db.prepare('DELETE FROM blog_likes WHERE blog_id = ? AND user_id = ?').run(row.id, req.user.id);
  else {
    db.prepare('INSERT INTO blog_likes (blog_id, user_id, created_at) VALUES (?, ?, ?)').run(row.id, req.user.id, Date.now());
    if (row.user_id) notifyUser(row.user_id, 'blog:liked', { blogId: row.id, by: req.user.username });
  }
  broadcastLeaderboardChange(); // each like is a point for the writer
  const likes = db.prepare('SELECT COUNT(*) AS n FROM blog_likes WHERE blog_id = ?').get(row.id).n;
  res.json({ liked: !had, likes });
});

router.get('/:id/comments', requireAuth, (req, res) => {
  const row = blogOr404(req, res);
  if (!row) return;
  res.json({ comments: blogs.comments(row.id, req.user.id, row.user_id) });
});

router.post('/:id/comments', requireAuth, commentLimiter, requireSafeLinks('body'), (req, res) => {
  const row = blogOr404(req, res);
  if (!row) return;
  if (row.status !== 'published') return res.status(400).json({ error: 'This post isn’t published.' });
  if (row.user_id && areBlocked(req.user.id, row.user_id)) return res.status(403).json({ error: 'You can’t comment on this post.' });
  const body = String((req.body && req.body.body) || '').trim().slice(0, blogs.COMMENT_MAX);
  if (!body) return res.status(400).json({ error: 'Write a comment first.' });
  let parentId = parseInt(req.body.parentId, 10) || null;
  if (parentId) {
    const parent = db.prepare('SELECT id, parent_id FROM blog_comments WHERE id = ? AND blog_id = ?').get(parentId, row.id);
    if (!parent) return res.status(400).json({ error: 'That comment is gone.' });
    parentId = parent.parent_id || parent.id; // replies stay one level deep
  }
  db.prepare('INSERT INTO blog_comments (blog_id, author_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.id, req.user.id, parentId, body, Date.now());
  if (row.user_id && row.user_id !== req.user.id) notifyUser(row.user_id, 'blog:comment', { blogId: row.id, by: req.user.username });
  res.status(201).json({ comments: blogs.comments(row.id, req.user.id, row.user_id) });
});

router.delete('/comments/:cid', requireAuth, (req, res) => {
  const c = db.prepare(
    'SELECT c.id, c.author_id, c.blog_id, b.user_id AS blog_author FROM blog_comments c JOIN blogs b ON b.id = c.blog_id WHERE c.id = ?'
  ).get(parseInt(req.params.cid, 10) || 0);
  if (!c || (c.author_id !== req.user.id && c.blog_author !== req.user.id)) return res.status(404).json({ error: 'Comment not found.' });
  db.prepare('DELETE FROM blog_comments WHERE id = ? OR parent_id = ?').run(c.id, c.id);
  res.json({ comments: blogs.comments(c.blog_id, req.user.id, c.blog_author) });
});

module.exports = router;
module.exports.blogCard = blogCard;
