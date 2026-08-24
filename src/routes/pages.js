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
const settings = require('../settings');
const ads = require('../ads');
const hw = require('../highway');

const router = express.Router();

// Wrap a page's body with header + footer ad slots and supply the left/right
// sidebar rails, for a given placement group ('content' for quizzes/polls/blogs,
// 'highway' for the Highway pool).
function withAds(bodyHtml, prefix) {
  prefix = prefix || 'content';
  return {
    bodyHtml: ads.slotHtml(`${prefix}_header`) + bodyHtml + ads.slotHtml(`${prefix}_footer`),
    railLeft: ads.slotHtml(`${prefix}_sidebar_left`),
    railRight: ads.slotHtml(`${prefix}_sidebar_right`),
  };
}

// Join a list of item-HTML strings, dropping an inline ad after every 4 items.
function joinWithInlineAds(items, prefix) {
  prefix = prefix || 'content';
  const out = [];
  items.forEach((html, i) => {
    out.push(html);
    if ((i + 1) % 4 === 0 && i < items.length - 1) out.push(ads.slotHtml(`${prefix}_inline`, Math.floor(i / 4)));
  });
  return out.join('');
}

// Join Highway post cards, inserting an inline ad between them at random, and
// mandatorily after every 15 posts. Avoids two ads back-to-back.
function joinHighwayPosts(cards) {
  const out = [];
  let adIdx = 0, lastWasAd = false;
  cards.forEach((html, i) => {
    out.push(html);
    const isLast = i === cards.length - 1;
    const mandatory = (i + 1) % 15 === 0;
    const random = !lastWasAd && Math.random() < 0.15;
    if (!isLast && (mandatory || random)) {
      const ad = ads.slotHtml('highway_inline', adIdx++);
      if (ad) { out.push(ad); lastWasAd = true; } else lastWasAd = false;
    } else { lastWasAd = false; }
  });
  return out.join('');
}

// Send a content page with ad slots injected (header/footer/rails).
function sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml, status, adPrefix }) {
  const a = withAds(bodyHtml, adPrefix);
  const html = renderDocument({ seoDescriptor, jsonLd, bodyHtml: a.bodyHtml, railLeft: a.railLeft, railRight: a.railRight });
  if (status) res.status(status);
  res.send(html);
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (_e) {
    return fallback;
  }
}

const { esc, escAttr, itemPath, slugify, summarize, resolveSeo, headTags, jsonLdTag, breadcrumbLd, breadcrumbHtml, organizationLd, websiteLd, renderUserText, renderDocument, absUrl, SITE_NAME, SITE_TAGLINE, SITE_OG_IMAGE, DEFAULT_HOME_TITLE, siteConfig } = seo;

// The static SEO tags baked into public/index.html — the ones the admin's
// site-wide settings replace on the landing page. Stripped before the injected,
// admin-controlled set is added, so nothing is duplicated.
function stripStaticSeoTags(html) {
  return html
    .replace(/\s*<title>[\s\S]*?<\/title>/i, '')
    .replace(/\s*<meta\s+name="description"[^>]*>/i, '')
    .replace(/\s*<meta\s+name="keywords"[^>]*>/i, '')
    .replace(/\s*<meta\s+name="theme-color"[^>]*>/i, '')
    .replace(/\s*<meta\s+property="og:[^"]*"[^>]*>/gi, '')
    .replace(/\s*<meta\s+name="twitter:[^"]*"[^>]*>/gi, '');
}

// The raw SPA shell is read once; the SEO injection is rebuilt per request so
// the admin's changes take effect immediately (no restart, no cache to bust).
let rawIndexCache = null;
function rawIndexHtml() {
  if (rawIndexCache == null) {
    rawIndexCache = fs.readFileSync(path.join(config.root, 'public', 'index.html'), 'utf8');
  }
  return rawIndexCache;
}

// Landing page: serve the SPA shell with the site-wide, admin-controlled on-page
// SEO injected — the crawlable <title>/description, canonical, and the Open
// Graph + Twitter/X card tags that Google, Facebook, Instagram, Reddit, WhatsApp
// and Twitter read when a getxmatch.com link is shared — plus WebSite +
// Organization structured data. Admin settings fall back to the brand defaults.
function homeHtml() {
  const s = settings.getSiteSeo();
  const homeTitle = (s.metaTitle || '').trim() || DEFAULT_HOME_TITLE;
  const d = resolveSeo(s, { canonicalPath: '/', title: homeTitle, description: SITE_TAGLINE, type: 'website' });
  // The root page uses its title verbatim — no " · getxmatch" suffix.
  d.title = homeTitle;
  d.ogTitle = (s.ogTitle || '').trim() || homeTitle;
  // Match content-page + admin-preview fallback order: Twitter → OG → home title.
  d.twitterTitle = (s.twitterTitle || '').trim() || d.ogTitle;

  const cfg = siteConfig();
  const inject = [
    headTags(d),
    `<meta name="theme-color" content="${escAttr(cfg.themeColor)}" />`,
    jsonLdTag([organizationLd(), websiteLd()]),
  ].join('\n  ');

  const html = stripStaticSeoTags(rawIndexHtml());
  return html.replace('</head>', `  ${inject}\n</head>`);
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
    ? joinWithInlineAds(items.map((it) => `
      <a class="card" href="${escAttr(it.path)}">
        <h3>${esc(it.title)}</h3>
        <p class="meta">${it.qCount} question${it.qCount === 1 ? '' : 's'}</p>
        ${it.description ? `<p class="excerpt">${esc(summarize(it.description, 160))}</p>` : ''}
      </a>`))
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
  sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml });
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
${ads.slotHtml('content_inline')}
<a class="cta" href="/">Find your match — open getxmatch →</a>`;
  sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml });
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
    ? joinWithInlineAds(items.map((it) => `
      <a class="card" href="${escAttr(it.path)}">
        <h3>${esc(it.question)}</h3>
        <p class="meta">${it.closed ? 'Closed' : 'Open for voting'}</p>
      </a>`))
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
  sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml });
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
${ads.slotHtml('content_inline')}
<a class="cta" href="/">${row.closed ? 'See more polls in the app →' : 'Cast your vote in the app →'}</a>`;
  sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml });
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
    ? joinWithInlineAds(items.map((it) => `
      <a class="card" href="${escAttr(it.path)}">
        <h3>${esc(it.title)}</h3>
        <p class="meta">By ${esc(it.author)} · ${esc(humanDate(it.createdAt))}</p>
        ${it.excerpt ? `<p class="excerpt">${esc(summarize(it.excerpt, 180))}</p>` : ''}
      </a>`))
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
  sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml });
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
${ads.slotHtml('content_inline')}
<a class="cta" href="/">Join getxmatch →</a>`;
  sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml });
});

/* ===========================================================================
   Highway — public, read-only view of the community post pool. Logged-out
   visitors can browse posts; posting and connecting happen in the app.
=========================================================================== */

function highwayCard(p) {
  const avatar = p.avatar ? `/uploads/${p.avatar}` : null;
  const who = esc(p.display_name || p.username);
  return `<article class="hw-card${p.pinned ? ' pinned' : ''}">
      <header class="hw-card-head">
        ${avatar ? `<img class="hw-av" src="${escAttr(avatar)}" alt="" loading="lazy" />` : '<span class="hw-av hw-av-ph">👤</span>'}
        <div class="hw-meta"><span class="hw-who">${who}</span> <span class="hw-handle">@${esc(p.username)}</span> <span class="hw-date">${esc(humanDate(p.created_at))}</span></div>
        ${p.pinned ? '<span class="hw-pin">📌 Pinned</span>' : ''}
      </header>
      ${p.body ? renderUserText(p.body) : ''}
      ${p.image ? `<a href="/uploads/${escAttr(p.image)}" target="_blank" rel="noopener"><img class="hw-card-img" src="/uploads/${escAttr(p.image)}" alt="" loading="lazy" /></a>` : ''}
    </article>`;
}

router.get('/highway', (req, res) => {
  const posts = hw.allOrdered();
  const cards = posts.length
    ? joinHighwayPosts(posts.map(highwayCard))
    : '<p class="empty">No posts on the Highway yet — be the first once you join.</p>';

  // Volatile, user-generated content: viewable by everyone but kept out of the
  // search index.
  const seoDescriptor = resolveSeo({ noindex: true }, {
    canonicalPath: '/highway',
    title: 'Highway',
    description: 'The getxmatch community pool — see what members are sharing right now: posts, images, links and videos.',
  });
  const jsonLd = breadcrumbLd([{ name: 'Home', path: '/' }, { name: 'Highway', path: '/highway' }]);
  const bodyHtml = `
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Highway', path: '/highway' }])}
<h1>🌊 Highway</h1>
<p class="lede">The community pool — members share text, images, links and videos.</p>
<a class="cta" href="/">Join getxmatch to post &amp; connect →</a>
${cards}`;
  sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml, adPrefix: 'highway' });
});

/* ===========================================================================
   Static informational & legal pages

   Server-rendered, crawlable pages that give search engines real, trustworthy
   content (E-E-A-T) and give the app the About / Safety / FAQ / Privacy / Terms
   pages users and app stores expect. Content is intentionally plain and honest;
   the legal pages are reasonable starting boilerplate to review with counsel.
=========================================================================== */

const LAST_REVIEWED = 'August 20, 2026';

// Render one informational page with breadcrumbs + WebPage/Article JSON-LD.
function renderInfo(res, { pathname, title, description, lede, bodyHtml, extraLd }) {
  const seoDescriptor = resolveSeo({}, { canonicalPath: pathname, title, description, type: 'website' });
  const crumbs = [{ name: 'Home', path: '/' }, { name: title, path: pathname }];
  const jsonLd = [
    breadcrumbLd(crumbs),
    { '@context': 'https://schema.org', '@type': 'WebPage', name: title, description, url: absUrl(pathname) },
    ...(extraLd || []),
  ];
  const body = `
${breadcrumbHtml(crumbs)}
<div class="hero">
  <h1>${esc(title)}</h1>
  ${lede ? `<p class="lede">${esc(lede)}</p>` : ''}
</div>
<div class="prose">
${bodyHtml}
</div>
<a class="cta" href="/">Join getxmatch — it's free →</a>`;
  res.send(renderDocument({ seoDescriptor, jsonLd, bodyHtml: body }));
}

// ---- About -----------------------------------------------------------------
router.get('/about', (req, res) => {
  renderInfo(res, {
    pathname: '/about',
    title: `About ${SITE_NAME}`,
    description: `${SITE_NAME} is a lightweight social space for adults (18+) — real profiles, compatibility quizzes, community polls and real-time chat, built to be private and self-hosted.`,
    lede: `${SITE_NAME} is a lightweight social space for adults (18+) — a friendly place to build a profile, discover people, play compatibility quizzes and chat in real time.`,
    bodyHtml: `
<h2>What ${SITE_NAME} is</h2>
<p>${SITE_NAME} brings together the parts of an online community that actually help people connect: a rich personal profile with a photo gallery, playful compatibility quizzes you can share, community polls, a blog, and fast one-to-one and group chat. It's designed to be simple, private and calm — no endless feeds, no ads chasing you around the web.</p>
<h2>What makes it different</h2>
<ul>
  <li><strong>Built for adults, honestly.</strong> Every account confirms it is 18+ and verifies an email before it's created.</li>
  <li><strong>Real conversations.</strong> Chat is instant over WebSockets, and files you share are relayed live and never stored on our servers.</li>
  <li><strong>Play, don't just scroll.</strong> Compatibility quizzes, community polls and shareable match links make meeting people fun.</li>
  <li><strong>Privacy by design.</strong> Your email address is never shown to other members, and the app is lightweight enough to self-host on a single server.</li>
</ul>
<h2>Who's behind it</h2>
<p>${SITE_NAME} is an independent project. Have feedback or a question? Read our <a href="/faq">FAQ</a>, review our <a href="/safety">Safety guidelines</a>, or see <a href="/how-it-works">how it works</a>.</p>`,
    extraLd: [organizationLd()],
  });
});

// ---- How it works ----------------------------------------------------------
router.get('/how-it-works', (req, res) => {
  const steps = [
    ['Create your account', 'Confirm you are 18+ and verify your email with a one-time code. Your email is never shown to anyone else.'],
    ['Build your profile', 'Add a display picture, a gallery of up to 25 photos, your interests, and a few words about yourself. You control what you share.'],
    ['Discover people', 'Browse and search members, climb the engagement leaderboard, and see a live feed of community activity.'],
    ['Play compatibility quizzes', 'Answer a few playful questions, share a private match link with someone, and see how well you match.'],
    ['Chat in real time', 'Message one-to-one or in small groups. Shared files are relayed live and never stored on our servers.'],
  ];
  const stepHtml = steps.map((s, i) => `
    <div class="card">
      <h3>${i + 1}. ${esc(s[0])}</h3>
      <p class="excerpt">${esc(s[1])}</p>
    </div>`).join('');
  renderInfo(res, {
    pathname: '/how-it-works',
    title: 'How it works',
    description: `How ${SITE_NAME} works — create a profile, discover people, play compatibility quizzes, vote in polls and chat in real time. Free to join, 18+.`,
    lede: `Getting started on ${SITE_NAME} takes a minute. Here's the whole journey, step by step.`,
    bodyHtml: stepHtml + `
<h2>Explore before you sign up</h2>
<p>You can browse our <a href="/quizzes">compatibility quizzes</a>, <a href="/polls">community polls</a> and <a href="/blog">blog</a> without an account. When you're ready to chat and match, joining is free.</p>`,
    extraLd: [{
      '@context': 'https://schema.org', '@type': 'HowTo',
      name: `How to get started on ${SITE_NAME}`,
      step: steps.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s[0], text: s[1] })),
    }],
  });
});

// ---- Safety & community guidelines ----------------------------------------
router.get('/safety', (req, res) => {
  renderInfo(res, {
    pathname: '/safety',
    title: 'Safety & Community Guidelines',
    description: `Stay safe on ${SITE_NAME}. Our community guidelines, safety tips for meeting people online, and how to block or report someone.`,
    lede: `${SITE_NAME} is for adults 18 and over. These guidelines keep the community respectful and safe.`,
    bodyHtml: `
<h2>The essentials</h2>
<ul>
  <li><strong>18+ only.</strong> You must be at least 18 to create an account. Accounts found to belong to minors are removed.</li>
  <li><strong>Be respectful.</strong> No harassment, hate speech, threats or unsolicited explicit content.</li>
  <li><strong>Be real.</strong> Impersonation, spam, scams and solicitation are not allowed.</li>
  <li><strong>Consent matters.</strong> Only share images you have the right to share, and never share someone else's private information.</li>
</ul>
<h2>Staying safe online</h2>
<ul>
  <li>Keep conversations on the platform until you trust someone.</li>
  <li>Never send money, gift cards or financial details to someone you've met online.</li>
  <li>Protect personal information — your home address, workplace and financial details.</li>
  <li>If you choose to meet in person, meet in a public place and tell a friend.</li>
</ul>
<h2>Blocking &amp; reporting</h2>
<p>You can block any member from their profile or a chat — blocking cuts off messages, requests, files and gifts both ways. If you see content or behaviour that breaks these guidelines, report it so we can review it. We remove content and accounts that violate these rules.</p>
<h2>Your data &amp; privacy</h2>
<p>Your email address is never shown to other members, and files you share in chat are relayed live and never stored on our servers. See our <a href="/privacy">Privacy Policy</a> for the full picture.</p>`,
  });
});

// ---- FAQ (with FAQPage rich-result structured data) ------------------------
const FAQS = [
  ['Is getxmatch free?', 'Yes. Creating a profile, browsing people, taking quizzes, voting in polls and chatting are all free.'],
  ['Do I need to be 18?', 'Yes. getxmatch is strictly for adults aged 18 and over, and every account confirms this at sign-up.'],
  ['Is my email address visible to other people?', 'No. Your email is used only to verify your account and for notifications. It is never shown to other members and is never returned by our public APIs.'],
  ['What happens to files I share in chat?', 'Files shared in chat are relayed live between you and the recipient and are never stored on our servers — not on disk and not in the database. Only text messages are kept as history.'],
  ['How do compatibility quizzes work?', 'You answer a short set of questions, then share a private link. When the other person answers, you both see how many answers you picked in common and a compatibility score.'],
  ['How do I stay safe?', 'Read our Safety & Community Guidelines. In short: keep chats on-platform, never send money, protect personal details, and block or report anyone who breaks the rules.'],
  ['How do I delete my account?', 'You can remove your profile from the app. If you need help, use the contact details in our Privacy Policy and we will assist you.'],
];
router.get('/faq', (req, res) => {
  const faqHtml = FAQS.map(([q, a]) => `
    <details class="faq">
      <summary>${esc(q)}</summary>
      <div class="a">${esc(a)}</div>
    </details>`).join('');
  renderInfo(res, {
    pathname: '/faq',
    title: 'Frequently Asked Questions',
    description: `Answers to common questions about ${SITE_NAME} — cost, age requirements, privacy, safety, compatibility quizzes and chat.`,
    lede: `Everything you might want to know before you join ${SITE_NAME}.`,
    bodyHtml: faqHtml,
    extraLd: [{
      '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: FAQS.map(([q, a]) => ({
        '@type': 'Question', name: q,
        acceptedAnswer: { '@type': 'Answer', text: a },
      })),
    }],
  });
});

// ---- Privacy Policy --------------------------------------------------------
router.get('/privacy', (req, res) => {
  renderInfo(res, {
    pathname: '/privacy',
    title: 'Privacy Policy',
    description: `How ${SITE_NAME} collects, uses and protects your information. Your email is never shown to other members and chat files are never stored.`,
    lede: `Last reviewed: ${LAST_REVIEWED}. This policy explains what we collect and why.`,
    bodyHtml: `
<p class="updated">This is a plain-language summary intended as a starting point. Review it with a legal professional before relying on it for your jurisdiction.</p>
<h2>Information we collect</h2>
<ul>
  <li><strong>Account details</strong> — your username and email address (email is used to verify your account and for notifications).</li>
  <li><strong>Profile content</strong> — the display name, photos, interests and other details you choose to add.</li>
  <li><strong>Activity</strong> — text messages (kept as history), quiz attempts, poll votes, ratings and friendships.</li>
</ul>
<h2>What we do not store</h2>
<p>Files shared in chat are relayed live and are <strong>never written to our servers</strong>. Your email address is <strong>never shown to other members</strong> and is not returned by our public APIs.</p>
<h2>How we use information</h2>
<p>To create and secure your account, to operate the service (chat, quizzes, polls, leaderboard), to send you account and activity notifications, and to keep the community safe.</p>
<h2>Cookies</h2>
<p>We use a single, essential, signed httpOnly cookie to keep you logged in. We do not use advertising or third-party tracking cookies.</p>
<h2>Your choices</h2>
<p>You can edit or remove your profile content at any time and request account deletion. Passwords are stored only as salted hashes and are never readable by us.</p>
<h2>Contact</h2>
<p>Questions about your privacy? Contact us at <a href="mailto:privacy@getxmatch.com">privacy@getxmatch.com</a>.</p>`,
  });
});

// ---- Terms of Service ------------------------------------------------------
router.get('/terms', (req, res) => {
  renderInfo(res, {
    pathname: '/terms',
    title: 'Terms of Service',
    description: `The terms that govern your use of ${SITE_NAME}. You must be 18+ to use the service.`,
    lede: `Last reviewed: ${LAST_REVIEWED}. By using ${SITE_NAME} you agree to these terms.`,
    bodyHtml: `
<p class="updated">This is reasonable boilerplate intended as a starting point. Review it with a legal professional before relying on it.</p>
<h2>1. Eligibility</h2>
<p>You must be at least 18 years old to create an account or use ${SITE_NAME}. By using the service you confirm that you meet this requirement.</p>
<h2>2. Your account</h2>
<p>You are responsible for keeping your credentials secure and for activity under your account. Provide accurate information and do not impersonate others.</p>
<h2>3. Acceptable use</h2>
<p>Do not use ${SITE_NAME} to harass, threaten or defraud others, to post illegal content, to spam or solicit, or to share content you do not have the right to share. See our <a href="/safety">Community Guidelines</a>.</p>
<h2>4. Content</h2>
<p>You retain ownership of the content you post and grant us a limited licence to display it as part of operating the service. You are responsible for the content you share.</p>
<h2>5. Termination</h2>
<p>We may suspend or remove accounts that violate these terms or our guidelines. You may stop using the service and request deletion at any time.</p>
<h2>6. Disclaimer</h2>
<p>The service is provided "as is" without warranties. To the extent permitted by law, we are not liable for interactions between members or for indirect damages.</p>
<h2>7. Changes</h2>
<p>We may update these terms; material changes will be reflected by the "last reviewed" date above.</p>
<h2>Contact</h2>
<p><a href="mailto:hello@getxmatch.com">hello@getxmatch.com</a></p>`,
  });
});

// ---- Site search (crawlable results for public content) --------------------
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const results = [];
  if (q) {
    const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
    db.prepare("SELECT id, title, description, seo FROM quizzes WHERE title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 20")
      .all(like, like)
      .forEach((r) => { const s = parseJson(r.seo, {}); results.push({ kind: 'Quiz', title: r.title, excerpt: r.description, path: itemPath('quizzes', r.id, s.slug || r.title) }); });
    db.prepare("SELECT id, question, seo FROM polls WHERE question LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 20")
      .all(like)
      .forEach((r) => { const s = parseJson(r.seo, {}); results.push({ kind: 'Poll', title: r.question, excerpt: '', path: itemPath('polls', r.id, s.slug || r.question) }); });
    db.prepare("SELECT id, title, excerpt, seo FROM blogs WHERE title LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 20")
      .all(like, like, like)
      .forEach((r) => { const s = parseJson(r.seo, {}); results.push({ kind: 'Blog', title: r.title, excerpt: r.excerpt, path: itemPath('blog', r.id, s.slug || r.title) }); });
  }

  const cards = q
    ? (results.length
        ? results.map((it) => `
          <a class="card" href="${escAttr(it.path)}">
            <h3>${esc(it.title)}</h3>
            <p class="meta">${esc(it.kind)}</p>
            ${it.excerpt ? `<p class="excerpt">${esc(summarize(it.excerpt, 160))}</p>` : ''}
          </a>`).join('')
        : `<p class="empty">No results for “${esc(q)}”. Try the <a href="/quizzes">quizzes</a>, <a href="/polls">polls</a> or <a href="/blog">blog</a>.</p>`)
    : '<p class="empty">Type a search term to find quizzes, polls and blog posts.</p>';

  // A search results page should not itself compete in the index.
  const seoDescriptor = resolveSeo({ noindex: true }, {
    canonicalPath: '/search',
    title: q ? `Search: ${q}` : 'Search',
    description: `Search ${SITE_NAME} quizzes, polls and blog posts.`,
  });
  const bodyHtml = `
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Search', path: '/search' }])}
<h1>Search</h1>
<form action="/search" method="get" role="search" style="margin:0 0 20px">
  <input type="search" name="q" value="${escAttr(q)}" placeholder="Search quizzes, polls, blog…" aria-label="Search"
    style="width:100%;max-width:520px;padding:12px 16px;border-radius:999px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:16px" />
</form>
${cards}`;
  res.send(renderDocument({ seoDescriptor, jsonLd: null, bodyHtml }));
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
Disallow: /search
Disallow: /live/

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
  add('/about', null, 'monthly', '0.6');
  add('/how-it-works', null, 'monthly', '0.6');
  add('/safety', null, 'monthly', '0.5');
  add('/faq', null, 'monthly', '0.6');
  add('/privacy', null, 'yearly', '0.3');
  add('/terms', null, 'yearly', '0.3');

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
