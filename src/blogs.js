'use strict';

// Member blogs. Any member can write a blog post (drafts stay private until
// published); published posts are shown to everyone in the Blogs section, can
// be searched and filtered, liked (each like earns the writer 1 point — see
// src/points.js) and commented on, and are listed on the Highway when first
// published. Older posts written by the admin have no user_id and a plain-text
// body (format 'text'); member posts are rich HTML (format 'html'), cleaned
// here with an allowlist before they are stored.

const sanitizeHtml = require('sanitize-html');
const db = require('./db');

const CATEGORIES = [
  'Lifestyle', 'Relationships', 'Travel', 'Food', 'Technology', 'Career', 'Education',
  'Health & Fitness', 'Entertainment', 'Sports', 'Personal story', 'News', 'Other',
];
const TITLE_MAX = 150;
const EXCERPT_MAX = 300;
const BODY_MAX = 200000;   // characters of cleaned HTML
const TAGS_MAX = 8;
const TAG_LEN = 30;
const COMMENT_MAX = 1000;
const PAGE = 20;

(function migrate() {
  const cols = db.prepare('PRAGMA table_info(blogs)').all().map((c) => c.name);
  const add = (name, def) => { if (!cols.includes(name)) db.exec(`ALTER TABLE blogs ADD COLUMN ${name} ${def}`); };
  add('user_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
  add('status', "TEXT NOT NULL DEFAULT 'published'");   // 'draft' | 'published'
  add('format', "TEXT NOT NULL DEFAULT 'text'");        // 'text' (admin, older) | 'html'
  add('category', 'TEXT');
  add('tags', "TEXT NOT NULL DEFAULT '[]'");
  add('published_at', 'INTEGER');
  add('views', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    UPDATE blogs SET published_at = created_at WHERE published_at IS NULL AND status = 'published';
    CREATE INDEX IF NOT EXISTS idx_blogs_user ON blogs (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_blogs_published ON blogs (status, published_at);

    CREATE TABLE IF NOT EXISTS blog_likes (
      blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (blog_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS blog_comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      blog_id    INTEGER NOT NULL REFERENCES blogs(id) ON DELETE CASCADE,
      author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_id  INTEGER REFERENCES blog_comments(id) ON DELETE CASCADE,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_blog_comments ON blog_comments (blog_id, created_at);
  `);
})();

/* ----------------------------- cleaning ----------------------------- */

// Only our own uploads may be shown as pictures inside a post (no tracking
// pixels or hot-linked images), and only YouTube as embedded video.
const OWN_IMAGE = /^\/uploads\/[0-9a-f]{32}\.(?:jpg|png|webp|gif)$/;
const YOUTUBE = /^https:\/\/www\.youtube(?:-nocookie)?\.com\/embed\/[\w-]{6,20}(?:\?[\w=&;-]*)?$/;

const SANITIZE = {
  allowedTags: [
    'p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup', 'mark',
    'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'img', 'figure', 'figcaption',
    'iframe', 'div', 'span', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    iframe: ['src', 'title', 'allowfullscreen'],
    '*': ['style'],
  },
  allowedStyles: {
    '*': {
      'text-align': [/^(?:left|right|center|justify)$/],
      'font-weight': [/^(?:bold|normal|[1-9]00)$/],
      'font-style': [/^(?:italic|normal)$/],
      'text-decoration': [/^(?:underline|line-through|none)$/],
      color: [/^#[0-9a-f]{3,6}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/],
      'background-color': [/^#[0-9a-f]{3,6}$/i, /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  transformTags: {
    a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow ugc' } }),
    b: 'strong',
    i: 'em',
    strike: 's',
  },
  exclusiveFilter: (frame) =>
    (frame.tag === 'img' && !OWN_IMAGE.test(frame.attribs.src || '')) ||
    (frame.tag === 'iframe' && !YOUTUBE.test(frame.attribs.src || '')),
};
// The attributes added by transformTags must survive the allowlist.
SANITIZE.allowedAttributes.a.push('target', 'rel');

function cleanHtml(html) {
  return sanitizeHtml(String(html || ''), SANITIZE).trim();
}

// Plain text of a post body (for excerpts, search and reading time).
function textOf(body, format) {
  if (format !== 'html') return String(body || '');
  return sanitizeHtml(String(body || '').replace(/<\/(p|h\d|li|blockquote|pre|div|tr)>|<br\s*\/?>/gi, '$& \n'), { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

function readingMinutes(text) {
  const words = (String(text).match(/\S+/g) || []).length;
  return Math.max(1, Math.round(words / 200));
}

function cleanTags(raw) {
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch (_e) { list = raw.split(','); }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    const tag = String(t || '').replace(/^#/, '').replace(/[^\p{L}\p{N} &+.-]/gu, '').trim().slice(0, TAG_LEN);
    if (tag && !out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

function parseJson(s, dflt) { try { return JSON.parse(s); } catch (_e) { return dflt; } }

/* ------------------------------ shaping ------------------------------ */

const SELECT = `
  SELECT b.*, u.username, p.display_name, p.avatar,
         (SELECT COUNT(*) FROM blog_likes l WHERE l.blog_id = b.id)    AS like_count,
         (SELECT COUNT(*) FROM blog_comments c WHERE c.blog_id = b.id) AS comment_count
    FROM blogs b
    LEFT JOIN users u ON u.id = b.user_id
    LEFT JOIN profiles p ON p.user_id = b.user_id`;

function shape(r, viewerId, full) {
  const text = textOf(r.body, r.format);
  const out = {
    id: r.id,
    title: r.title,
    excerpt: r.excerpt || text.slice(0, 220),
    cover: r.cover ? `/uploads/${r.cover}` : null,
    category: r.category || null,
    tags: parseJson(r.tags, []),
    status: r.status,
    format: r.format,
    createdAt: r.created_at,
    publishedAt: r.published_at || null,
    updatedAt: r.updated_at,
    readMinutes: readingMinutes(text),
    views: r.views || 0,
    author: r.user_id
      ? { id: r.user_id, username: r.username, displayName: r.display_name || r.username, avatar: r.avatar ? `/uploads/${r.avatar}` : null }
      : { id: null, username: null, displayName: r.author || 'getxmatch', avatar: null },
    likes: r.like_count || 0,
    comments: r.comment_count || 0,
    mine: !!viewerId && r.user_id === viewerId,
    liked: !!viewerId && !!db.prepare('SELECT 1 FROM blog_likes WHERE blog_id = ? AND user_id = ?').get(r.id, viewerId),
  };
  if (full) out.body = r.body;
  return out;
}

function byId(id) {
  return db.prepare(`${SELECT} WHERE b.id = ?`).get(id);
}

const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

// Search and filter. opts: { q, category, tag, author (username), mine,
// sort: 'new'|'old'|'liked'|'commented'|'read', offset, hideAuthors: [ids] }.
function list(viewerId, opts = {}) {
  const where = [];
  const args = [];
  if (opts.mine) { where.push('b.user_id = ?'); args.push(viewerId); }
  else where.push("b.status = 'published'");
  if (opts.q) {
    const words = String(opts.q).trim().split(/\s+/).slice(0, 6);
    for (const w of words) {
      const like = `%${likeEsc(w)}%`;
      where.push(`(b.title LIKE ? ESCAPE '\\' OR b.excerpt LIKE ? ESCAPE '\\' OR b.body LIKE ? ESCAPE '\\' OR b.tags LIKE ? ESCAPE '\\'
                   OR b.category LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\' OR p.display_name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')`);
      args.push(like, like, like, like, like, like, like, like);
    }
  }
  if (opts.category) { where.push('b.category = ?'); args.push(opts.category); }
  if (opts.tag) { where.push("EXISTS (SELECT 1 FROM json_each(b.tags) t WHERE lower(t.value) = lower(?))"); args.push(opts.tag); }
  if (opts.author) { where.push('lower(u.username) = lower(?)'); args.push(opts.author); }
  if (opts.since) { where.push('COALESCE(b.published_at, b.created_at) >= ?'); args.push(opts.since); }
  if (opts.hideAuthors && opts.hideAuthors.length) {
    where.push(`(b.user_id IS NULL OR b.user_id NOT IN (${opts.hideAuthors.map(() => '?').join(',')}))`);
    args.push(...opts.hideAuthors);
  }
  const order = {
    old: 'COALESCE(b.published_at, b.created_at) ASC',
    liked: 'like_count DESC, COALESCE(b.published_at, b.created_at) DESC',
    commented: 'comment_count DESC, COALESCE(b.published_at, b.created_at) DESC',
    read: 'b.views DESC, COALESCE(b.published_at, b.created_at) DESC',
  }[opts.sort] || 'COALESCE(b.published_at, b.created_at) DESC';
  const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...args, PAGE + 1, offset);
  return {
    blogs: rows.slice(0, PAGE).map((r) => shape(r, viewerId, false)),
    more: rows.length > PAGE,
    nextOffset: offset + PAGE,
  };
}

// Tags used most across published posts.
function popularTags(limit = 20) {
  return db.prepare(
    `SELECT t.value AS tag, COUNT(*) AS n FROM blogs b, json_each(b.tags) t
      WHERE b.status = 'published' GROUP BY lower(t.value) ORDER BY n DESC, tag LIMIT ?`
  ).all(limit).map((r) => r.tag);
}

/* ------------------------------ comments ----------------------------- */

function comments(blogId, viewerId, blogAuthorId) {
  const rows = db.prepare(
    `SELECT c.id, c.author_id, c.parent_id, c.body, c.created_at, u.username, p.display_name, p.avatar
       FROM blog_comments c JOIN users u ON u.id = c.author_id LEFT JOIN profiles p ON p.user_id = c.author_id
      WHERE c.blog_id = ? ORDER BY c.created_at ASC LIMIT 1000`
  ).all(blogId);
  const all = rows.map((r) => ({
    id: r.id,
    parentId: r.parent_id || null,
    body: r.body,
    at: r.created_at,
    author: { id: r.author_id, username: r.username, displayName: r.display_name || r.username, avatar: r.avatar ? `/uploads/${r.avatar}` : null },
    canDelete: !!viewerId && (viewerId === r.author_id || viewerId === blogAuthorId),
    replies: [],
  }));
  const top = all.filter((c) => !c.parentId);
  const byIdMap = new Map(top.map((c) => [c.id, c]));
  all.filter((c) => c.parentId).forEach((c) => { const parent = byIdMap.get(c.parentId); if (parent) parent.replies.push(c); });
  return top;
}

module.exports = {
  CATEGORIES, TITLE_MAX, EXCERPT_MAX, BODY_MAX, COMMENT_MAX,
  cleanHtml, cleanTags, textOf, readingMinutes, shape, byId, list, popularTags, comments,
};
