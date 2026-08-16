'use strict';

// Public, server-rendered, crawlable pages for content the admin publishes:
// quizzes, polls and blog posts. No authentication — these exist so search
// engines and social unfurlers can read real content + metadata. Interaction
// (playing a quiz, voting) still happens in the logged-in SPA, linked via CTAs.
//
// Also serves /sitemap.xml and /robots.txt.

const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('../db');
const config = require('../config');
const seo = require('../seo');

const router = express.Router();

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}

const { esc, escAttr, itemPath, slugify, summarize, resolveSeo, jsonLdTag, breadcrumbLd, breadcrumbHtml, renderDocument, absUrl, SITE_NAME, SITE_TAGLINE } = seo;

// Landing page: serve the SPA shell, but inject the absolute canonical / OG URLs
// (domain-dependent, so done here rather than in the static file) plus WebSite +
// Organization structured data. The app markup and scripts are untouched.
let homeHtmlCache = null;
function homeHtml() {
  if (homeHtmlCache) return homeHtmlCache;
  let html = fs.readFileSync(path.join(config.root, 'public', 'index.html'), 'utf8');
  const canonical = absUrl('/');
  const inject = [
    `<link rel="canonical" href="${escAttr(canonical)}" />`,
    `<meta property="og:url" content="${escAttr(canonical)}" />`,
    jsonLdTag([
      { '@context': 'https://schema.org', '@type': 'WebSite', name: SITE_NAME, url: canonical },
      { '@context': 'https://schema.org', '@type': 'Organization', name: SITE_NAME, url: canonical, description: SITE_TAGLINE },
    ]),
  ].join('\n  ');
  html = html.replace('</head>', `  ${inject}\n</head>`);
  homeHtmlCache = html;
  return homeHtmlCache;
}

router.get('/', (req, res) => res.type('html').send(homeHtml()));

function isoDate(ms) {
  return new Date(ms || Date.now()).toISOString();
}

// A proper 404 page (noindex) for a missing content item — avoids the soft-404
// that falling through to the SPA would produce for crawlers.
function notFound(res, kind) {
  const seoDescriptor = resolveSeo({ noindex: true }, {
    canonicalPath: res.req.path,
    title: 'Not found',
    description: 'The page you are looking for could not be found.',
  });
  const bodyHtml = `
<h1>Page not found</h1>
<p class="lede">Sorry, that ${esc(kind || 'page')} doesn’t exist or may have been removed.</p>
<a class="cta" href="/">Go to getxmatch →</a>`;
  res.status(404).send(renderDocument({ seoDescriptor, jsonLd: null, bodyHtml }));
}
function humanDate(ms) {
  return new Date(ms || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Resolve /:base/:id/:slug? to the canonical path; if the request path differs
// from canonical (missing/stale slug), returns { redirect } for a 301.
function canonicalCheck(base, req, id, slugSource) {
  const canonical = itemPath(base, id, slugSource);
  if (req.path !== canonical) return { redirect: canonical };
  return { canonical };
}

/* ===========================================================================
   Quizzes
=========================================================================== */

router.get('/quizzes', (req, res) => {
  const rows = db.prepare('SELECT id, title, description, questions, seo, updated_at FROM quizzes ORDER BY created_at DESC').all();
  const items = rows.map((r) => {
    const s = parseJson(r.seo, {});
    const qCount = parseJson(r.questions, []).length;
    return { id: r.id, title: r.title, description: r.description, qCount, path: itemPath('quizzes', r.id, s.slug || r.title) };
  });

  const cards = items.length
    ? items.map((it) => `
      <a class="card" href="${escAttr(it.path)}">
        <h3>${esc(it.title)}</h3>
        <p class="meta">${it.qCount} question${it.qCount === 1 ? '' : 's'}</p>
        ${it.description ? `<p class="excerpt">${esc(summarize(it.description, 160))}</p>` : ''}
      </a>`).join('')
    : '<p class="empty">No quizzes published yet. Check back soon!</p>';

  const seoDescriptor = resolveSeo({}, {
    canonicalPath: '/quizzes',
    title: 'Compatibility Quizzes',
    description: 'Fun compatibility quizzes on getxmatch — answer a few questions and find out how well you match with someone.',
  });
  const jsonLd = [
    breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Quizzes', path: '/quizzes' }]),
    {
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: 'Compatibility Quizzes', url: absUrl('/quizzes'),
      hasPart: items.map((it) => ({ '@type': 'Quiz', name: it.title, url: absUrl(it.path) })),
    },
  ];
  const bodyHtml = `
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Quizzes', path: '/quizzes' }])}
<h1>Compatibility Quizzes</h1>
<p class="lede">Answer a few playful questions and discover how well you match. Share a link and compare answers with anyone.</p>
${cards}`;
  res.send(renderDocument({ seoDescriptor, jsonLd, bodyHtml }));
});

router.get('/quizzes/:id/:slug?', (req, res, next) => {
  const row = db.prepare('SELECT id, title, description, questions, seo, created_at, updated_at FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, req.path.split('/')[1].replace(/s$/,''));
  const s = parseJson(row.seo, {});
  const chk = canonicalCheck('quizzes', req, row.id, s.slug || row.title);
  if (chk.redirect) return res.redirect(301, chk.redirect);

  const questions = parseJson(row.questions, []);
  const qHtml = questions.map((q, i) => `
    <div class="q">
      <p class="prompt">${i + 1}. ${esc(q.prompt)}</p>
      <ul>${(Array.isArray(q.options) ? q.options : []).map((o) => `<li>${esc(o)}</li>`).join('')}</ul>
    </div>`).join('');

  const seoDescriptor = resolveSeo(s, {
    canonicalPath: chk.canonical,
    title: row.title,
    description: row.description || `Take the "${row.title}" compatibility quiz on ${SITE_NAME}.`,
    type: 'article',
  });
  const jsonLd = [
    breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Quizzes', path: '/quizzes' }, { name: row.title, path: chk.canonical }]),
    {
      '@context': 'https://schema.org', '@type': 'Quiz',
      name: row.title, description: row.description || undefined, url: absUrl(chk.canonical),
      numberOfQuestions: questions.length,
      hasPart: questions.map((q) => ({
        '@type': 'Question',
        name: q.prompt,
        suggestedAnswer: (Array.isArray(q.options) ? q.options : []).map((o) => ({ '@type': 'Answer', text: o })),
      })),
    },
  ];
  const bodyHtml = `
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Quizzes', path: '/quizzes' }, { name: row.title, path: chk.canonical }])}
<h1>${esc(row.title)}</h1>
${row.description ? `<p class="lede">${esc(row.description)}</p>` : ''}
<a class="cta" href="/">Take this quiz in the app →</a>
<h2>Questions</h2>
${qHtml || '<p class="empty">This quiz has no questions yet.</p>'}
<a class="cta" href="/">Find your match — open getxmatch →</a>`;
  res.send(renderDocument({ seoDescriptor, jsonLd, bodyHtml }));
});

/* ===========================================================================
   Polls
=========================================================================== */

function pollTally(id, options) {
  const counts = new Array(options.length).fill(0);
  db.prepare('SELECT option_index, COUNT(*) AS n FROM poll_votes WHERE poll_id = ? GROUP BY option_index')
    .all(id)
    .forEach((r) => { if (r.option_index >= 0 && r.option_index < counts.length) counts[r.option_index] = r.n; });
  const total = counts.reduce((a, b) => a + b, 0);
  return { counts, total };
}

router.get('/polls', (req, res) => {
  const rows = db.prepare('SELECT id, question, options, closed, seo FROM polls ORDER BY created_at DESC').all();
  const items = rows.map((r) => {
    const s = parseJson(r.seo, {});
    return { id: r.id, question: r.question, closed: !!r.closed, path: itemPath('polls', r.id, s.slug || r.question) };
  });
  const cards = items.length
    ? items.map((it) => `
      <a class="card" href="${escAttr(it.path)}">
        <h3>${esc(it.question)}</h3>
        <p class="meta">${it.closed ? 'Closed' : 'Open for voting'}</p>
      </a>`).join('')
    : '<p class="empty">No polls published yet. Check back soon!</p>';

  const seoDescriptor = resolveSeo({}, {
    canonicalPath: '/polls',
    title: 'Community Polls',
    description: 'Vote in getxmatch community polls and see what everyone thinks.',
  });
  const jsonLd = [
    breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Polls', path: '/polls' }]),
    {
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: 'Community Polls', url: absUrl('/polls'),
      hasPart: items.map((it) => ({ '@type': 'WebPage', name: it.question, url: absUrl(it.path) })),
    },
  ];
  const bodyHtml = `
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Polls', path: '/polls' }])}
<h1>Community Polls</h1>
<p class="lede">See what the getxmatch community thinks — then cast your own vote.</p>
${cards}`;
  res.send(renderDocument({ seoDescriptor, jsonLd, bodyHtml }));
});

router.get('/polls/:id/:slug?', (req, res, next) => {
  const row = db.prepare('SELECT id, question, options, closed, seo, created_at FROM polls WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, req.path.split('/')[1].replace(/s$/,''));
  const s = parseJson(row.seo, {});
  const chk = canonicalCheck('polls', req, row.id, s.slug || row.question);
  if (chk.redirect) return res.redirect(301, chk.redirect);

  const options = parseJson(row.options, []);
  const { counts, total } = pollTally(row.id, options);
  const optHtml = options.map((o, i) => {
    const n = counts[i] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    return `
      <div class="opt-wrap">
        <div class="opt"><span>${esc(o)}</span><span class="meta">${pct}% · ${n} vote${n === 1 ? '' : 's'}</span></div>
        <div class="bar" style="width:${pct}%"></div>
      </div>`;
  }).join('');

  const seoDescriptor = resolveSeo(s, {
    canonicalPath: chk.canonical,
    title: row.question,
    description: row.question ? `Vote: ${summarize(row.question, 150)} — join the poll on ${SITE_NAME}.` : undefined,
    type: 'article',
  });
  const jsonLd = [
    breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Polls', path: '/polls' }, { name: row.question, path: chk.canonical }]),
    {
      '@context': 'https://schema.org', '@type': 'Question',
      name: row.question, answerCount: options.length, url: absUrl(chk.canonical),
      suggestedAnswer: options.map((o, i) => ({ '@type': 'Answer', text: o, upvoteCount: counts[i] || 0 })),
    },
  ];
  const bodyHtml = `
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Polls', path: '/polls' }, { name: row.question, path: chk.canonical }])}
<h1>${esc(row.question)}</h1>
<p class="lede">${total} vote${total === 1 ? '' : 's'} so far${row.closed ? ' · this poll is closed' : ''}.</p>
${optHtml}
<a class="cta" href="/">${row.closed ? 'See more polls in the app →' : 'Cast your vote in the app →'}</a>`;
  res.send(renderDocument({ seoDescriptor, jsonLd, bodyHtml }));
});

/* ===========================================================================
   Blog
=========================================================================== */

router.get('/blog', (req, res) => {
  const rows = db.prepare('SELECT id, title, author, excerpt, cover, seo, created_at FROM blogs ORDER BY created_at DESC').all();
  const items = rows.map((r) => {
    const s = parseJson(r.seo, {});
    return {
      id: r.id, title: r.title, author: r.author, excerpt: r.excerpt,
      cover: r.cover ? `/uploads/${r.cover}` : null, createdAt: r.created_at,
      path: itemPath('blog', r.id, s.slug || r.title),
    };
  });
  const cards = items.length
    ? items.map((it) => `
      <a class="card" href="${escAttr(it.path)}">
        <h3>${esc(it.title)}</h3>
        <p class="meta">By ${esc(it.author)} · ${esc(humanDate(it.createdAt))}</p>
        ${it.excerpt ? `<p class="excerpt">${esc(summarize(it.excerpt, 180))}</p>` : ''}
      </a>`).join('')
    : '<p class="empty">No blog posts yet. Check back soon!</p>';

  const seoDescriptor = resolveSeo({}, {
    canonicalPath: '/blog',
    title: 'Blog',
    description: 'Stories, dating tips and news from the getxmatch team.',
  });
  const jsonLd = [
    breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Blog', path: '/blog' }]),
    {
      '@context': 'https://schema.org', '@type': 'Blog',
      name: `${SITE_NAME} Blog`, url: absUrl('/blog'),
      blogPost: items.map((it) => ({ '@type': 'BlogPosting', headline: it.title, url: absUrl(it.path), datePublished: isoDate(it.createdAt), author: { '@type': 'Person', name: it.author } })),
    },
  ];
  const bodyHtml = `
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Blog', path: '/blog' }])}
<h1>Blog</h1>
<p class="lede">Stories, dating tips and news from the getxmatch team.</p>
${cards}`;
  res.send(renderDocument({ seoDescriptor, jsonLd, bodyHtml }));
});

router.get('/blog/:id/:slug?', (req, res, next) => {
  const r = db.prepare('SELECT id, title, author, excerpt, body, cover, seo, created_at, updated_at FROM blogs WHERE id = ?').get(req.params.id);
  if (!r) return notFound(res, 'post');
  const s = parseJson(r.seo, {});
  const chk = canonicalCheck('blog', req, r.id, s.slug || r.title);
  if (chk.redirect) return res.redirect(301, chk.redirect);

  const cover = r.cover ? `/uploads/${r.cover}` : null;
  const paras = String(r.body || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br />')}</p>`)
    .join('');

  const seoDescriptor = resolveSeo(s, {
    canonicalPath: chk.canonical,
    title: r.title,
    description: r.excerpt || summarize(r.body, 160),
    image: cover,
    type: 'article',
  });
  const jsonLd = [
    breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Blog', path: '/blog' }, { name: r.title, path: chk.canonical }]),
    {
      '@context': 'https://schema.org', '@type': 'BlogPosting',
      headline: r.title,
      description: r.excerpt || summarize(r.body, 160),
      image: cover ? absUrl(cover) : undefined,
      datePublished: isoDate(r.created_at),
      dateModified: isoDate(r.updated_at || r.created_at),
      author: { '@type': 'Person', name: r.author },
      publisher: { '@type': 'Organization', name: SITE_NAME },
      mainEntityOfPage: { '@type': 'WebPage', '@id': absUrl(chk.canonical) },
    },
  ];
  const bodyHtml = `
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Blog', path: '/blog' }, { name: r.title, path: chk.canonical }])}
<h1>${esc(r.title)}</h1>
<p class="meta">By ${esc(r.author)} · ${esc(humanDate(r.created_at))}</p>
${cover ? `<img class="cover" src="${escAttr(cover)}" alt="${escAttr(r.title)}" />` : ''}
<article class="post">${paras || `<p>${esc(r.excerpt || '')}</p>`}</article>
<a class="cta" href="/">Join getxmatch →</a>`;
  res.send(renderDocument({ seoDescriptor, jsonLd, bodyHtml }));
});

/* ===========================================================================
   robots.txt + sitemap.xml
=========================================================================== */

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin
Disallow: /m/

Sitemap: ${absUrl('/sitemap.xml')}
`
  );
});

router.get('/sitemap.xml', (req, res) => {
  const urls = [];
  const add = (path, lastmod, changefreq, priority) => {
    urls.push({ loc: absUrl(path), lastmod: lastmod ? isoDate(lastmod) : null, changefreq, priority });
  };

  add('/', null, 'daily', '1.0');
  add('/quizzes', null, 'weekly', '0.8');
  add('/polls', null, 'weekly', '0.8');
  add('/blog', null, 'weekly', '0.8');

  const notNoindex = (raw) => !parseJson(raw, {}).noindex;

  db.prepare('SELECT id, title, seo, updated_at FROM quizzes ORDER BY created_at DESC').all().forEach((r) => {
    if (notNoindex(r.seo)) add(itemPath('quizzes', r.id, parseJson(r.seo, {}).slug || r.title), r.updated_at, 'monthly', '0.7');
  });
  db.prepare('SELECT id, question, seo, created_at FROM polls ORDER BY created_at DESC').all().forEach((r) => {
    if (notNoindex(r.seo)) add(itemPath('polls', r.id, parseJson(r.seo, {}).slug || r.question), r.created_at, 'weekly', '0.6');
  });
  db.prepare('SELECT id, title, seo, updated_at FROM blogs ORDER BY created_at DESC').all().forEach((r) => {
    if (notNoindex(r.seo)) add(itemPath('blog', r.id, parseJson(r.seo, {}).slug || r.title), r.updated_at, 'monthly', '0.7');
  });

  const body = urls.map((u) => `  <url>
    <loc>${esc(u.loc)}</loc>${u.lastmod ? `
    <lastmod>${u.lastmod}</lastmod>` : ''}${u.changefreq ? `
    <changefreq>${u.changefreq}</changefreq>` : ''}${u.priority ? `
    <priority>${u.priority}</priority>` : ''}
  </url>`).join('\n');

  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`);
});

module.exports = router;
