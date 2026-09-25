'use strict';

// Public, server-rendered, crawlable pages for content the admin publishes:
// quizzes, polls and blog posts. No authentication — these exist so search
// engines and social unfurlers can read real content + metadata. Interaction
// (playing a quiz, voting) still happens in the logged-in SPA, linked via CTAs.
//
// Also serves /sitemap.xml and /robots.txt.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');

const db = require('../db');
const config = require('../config');
const seo = require('../seo');
const settings = require('../settings');
const ads = require('../ads');
const hw = require('../highway');
const ogImage = require('../ogImage');
const { quizStats, timeLabel, fmtDuration } = require('../quizStats');
const { typeLabel } = require('../quizTypes');
const { ageFromDob } = require('../profileFields');
const { buildProfile } = require('../profileData');
const { renderProfileQr } = require('../qrCard');
const { optionalAuth } = require('../auth');

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

// Interactive attempt UI shared by the public poll + quiz pages. The behaviour
// lives in /js/attempt.js (an external file, because the pages' CSP forbids
// inline scripts); the styles are inline (inline styles are allowed).
const ATTEMPT_SCRIPT = '<script src="/js/attempt.js" defer></script>';
const ATTEMPT_STYLE = `<style>
.gx-attempt { margin: 18px 0 8px; }
.gx-opts { display: flex; flex-direction: column; gap: 10px; }
.gx-opt { position: relative; overflow: hidden; display: block; width: 100%; text-align: left;
  border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; cursor: pointer;
  background: var(--bg2); color: var(--text); font: inherit; transition: border-color .15s ease, transform .05s ease; }
.gx-opt:hover:not(:disabled) { border-color: var(--accent); }
.gx-opt:active:not(:disabled) { transform: scale(.995); }
.gx-opt.mine { border-color: var(--accent); }
.gx-opt:disabled { cursor: default; opacity: .9; }
.gx-opt-bar { position: absolute; inset: 0 auto 0 0; width: 0; display: flex; background: color-mix(in srgb, var(--accent) 12%, transparent); transition: width .3s ease; }
.gx-seg { height: 100%; min-width: 0; }
.gx-seg-male { background: color-mix(in srgb, var(--vote-male) 42%, transparent); }
.gx-seg-female { background: color-mix(in srgb, var(--vote-female) 42%, transparent); }
.gx-seg-other { background: color-mix(in srgb, var(--vote-other) 42%, transparent); }
.gx-legend { display: flex; gap: 14px; flex-wrap: wrap; margin: 12px 0 0; color: var(--muted); font-size: 13px; }
.gx-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.gx-dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
.gx-dot.gx-seg-male { background: var(--vote-male); }
.gx-dot.gx-seg-female { background: var(--vote-female); }
.gx-dot.gx-seg-other { background: var(--vote-other); }
.gx-opt-main { position: relative; z-index: 1; display: flex; justify-content: space-between; gap: 12px; align-items: center; }
.gx-opt-label { font-weight: 600; overflow-wrap: anywhere; }
.gx-opt-meta { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
.gx-opt.mine .gx-opt-label::after { content: ' ✓'; color: var(--accent); }
.gx-hint { color: var(--muted); font-size: 14px; margin: 12px 0 0; }
.gx-note { margin: 16px 0 0; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text); }
.gx-note .cta { margin: 10px 0 0; }
.gx-q { border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; margin: 0 0 14px; background: var(--bg2); }
.gx-q legend { font-weight: 700; padding: 0 6px; }
.gx-qopt { display: flex; align-items: center; gap: 10px; padding: 9px 8px; border-radius: 8px; cursor: pointer; color: var(--text); }
.gx-qopt:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
.gx-qopt input { accent-color: var(--accent); width: auto; }
.gx-submit { margin-top: 6px; }
.gx-result { margin-top: 16px; }
.gx-share { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.gx-share input { flex: 1; min-width: 220px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); }
.gx-attempt:fullscreen { background: var(--bg); color: var(--text); overflow-y: auto; padding: 28px max(16px, calc(50vw - 380px)); }
.gx-attempt::backdrop { background: var(--bg); }
.gx-proctor-intro { border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; background: var(--bg2); margin: 0 0 14px; }
.gx-proctor-intro h2 { margin: 0 0 8px; font-size: 1.15rem; }
.gx-proctor-intro ul { margin: 0 0 14px; padding-left: 20px; color: var(--muted); }
.gx-proctor-intro li { margin: 4px 0; }
.gx-proctor-intro strong { color: var(--text); }
.gx-proctor-bar { display: flex; justify-content: space-between; gap: 12px; font-size: .85rem; color: var(--muted); border-bottom: 1px solid var(--border); padding: 0 0 10px; margin: 0 0 16px; }
.gx-proctor-bar[hidden], .gx-proctor-warn[hidden] { display: none; }
.gx-proctor-strikes.warned { color: var(--accent); font-weight: 700; }
.gx-proctor-warn { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; padding: 16px; background: color-mix(in srgb, var(--bg) 92%, transparent); }
.gx-proctor-box { max-width: 460px; width: 100%; border: 1px solid var(--accent); border-radius: 14px; padding: 22px 24px; background: var(--bg2); text-align: center; }
.gx-proctor-box h2 { margin: 0 0 8px; color: var(--accent); font-size: 1.2rem; }
.gx-proctor-box p { margin: 0 0 16px; }
.gx-proctor-sum { margin: 0 0 8px; font-weight: 700; }
.gx-qmeta { margin: 0 0 6px; font-size: .85rem; color: var(--muted); }
.gx-step[hidden] { display: none; }
.gx-step { margin: 0 0 14px; }
.gx-step-row { display: flex; justify-content: space-between; gap: 12px; font-size: .9rem; color: var(--muted); margin: 0 0 6px; }
.gx-timer { font-weight: 800; color: var(--text); font-variant-numeric: tabular-nums; }
.gx-timer.low { color: var(--accent); }
.gx-timebar { height: 6px; border-radius: 999px; background: var(--bg3); overflow: hidden; }
.gx-timebar span { display: block; height: 100%; width: 100%; background: var(--grad); transition: width .25s linear; }
.gx-timebar.untimed { display: none; }
</style>`;

/* ===========================================================================
   Dynamic social "feature" images (Open Graph). /og/poll/:id.png and
   /og/quiz/:id.png render the poll question / quiz title onto a branded card so
   a shared link unfurls with the heading as its preview image.
=========================================================================== */

function sendOg(res, png) {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400'); // 1 day
  res.send(png);
}

// The poll image shows the live results, so it is versioned by a hash of the
// question, options and tallies: the page links /og/poll/:id.png?v=<hash>, and a
// new vote yields a new URL that WhatsApp / Facebook / Telegram etc. fetch
// afresh instead of reusing a stale cached preview.
function pollOgState(row) {
  const options = parseJson(row.options, []);
  const tally = pollTally(row.id, options);
  const version = crypto
    .createHash('sha1')
    .update(JSON.stringify([row.question, options, row.closed, tally.counts, tally.genders]))
    .digest('hex')
    .slice(0, 12);
  return { options, tally, version };
}

router.get('/og/poll/:id.png', (req, res, next) => {
  const row = db.prepare('SELECT id, question, options, closed FROM polls WHERE id = ?').get(req.params.id);
  if (!row) return next();
  const { options, tally, version } = pollOgState(row);
  const png = ogImage.renderPollCard(
    { question: row.question, options, counts: tally.counts, genders: tally.genders, total: tally.total, closed: !!row.closed },
    `poll:${row.id}:${version}`
  );
  res.set('Content-Type', 'image/png');
  // A versioned URL never changes content; the bare URL tracks live votes.
  res.set('Cache-Control', req.query.v === version ? 'public, max-age=604800, immutable' : 'public, max-age=300');
  res.send(png);
});

router.get('/og/quiz/:id.png', (req, res, next) => {
  const row = db.prepare('SELECT id, title, updated_at, created_at FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return next();
  const key = `quiz:${row.id}:${row.updated_at || row.created_at || ''}`;
  sendOg(res, ogImage.renderCard('Quiz', row.title, key));
});

/* ===========================================================================
   Quizzes
=========================================================================== */

// The stats block on a quiz card: questions, total time, negative marking,
// how many people attempted it and the top scorers (points, then time).
function quizStatsHtml(st) {
  const top = st.topScorers.length
    ? `<ol class="gx-top">${st.topScorers.map((t, i) => `
        <li><span class="gx-medal">${['🥇', '🥈', '🥉'][i] || `#${i + 1}`}</span>
          <span class="gx-top-name">${esc(t.displayName)}</span>
          <span class="gx-top-pts">${t.points} pts${t.durationMs != null ? ` · ${fmtDuration(Math.max(1, Math.round(t.durationMs / 1000)))}` : ''}</span></li>`).join('')}</ol>`
    : '<p class="gx-top-empty">No attempts yet — be the first!</p>';
  return `
        <ul class="gx-stats">
          <li><span>Questions</span><strong>${st.questionCount}</strong></li>
          <li><span>Total time</span><strong>${esc(timeLabel(st))}</strong></li>
          <li><span>Negative marking</span><strong>${st.negativeMarks ? `Yes · −${st.negativeMarks} per unanswered` : 'No'}</strong></li>
          <li><span>Attempted by</span><strong>${st.attemptedBy} ${st.attemptedBy === 1 ? 'person' : 'people'}</strong></li>
        </ul>
        <p class="gx-top-h">Top scorers</p>
        ${top}`;
}

const QUIZ_CARD_STYLE = `<style>
.gx-type { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 999px; padding: 2px 9px; margin: 0 0 8px; }
.gx-stats { list-style: none; margin: 10px 0 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.gx-stats li { background: var(--bg3); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.gx-stats span { color: var(--muted); font-size: 12px; }
.gx-stats strong { color: var(--text); font-size: 14px; overflow-wrap: anywhere; }
.gx-top-h { margin: 12px 0 4px; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.gx-top { list-style: none; margin: 0; padding: 0; }
.gx-top li { display: flex; align-items: center; gap: 8px; padding: 3px 0; color: var(--text); font-size: 14px; }
.gx-top-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gx-top-pts { color: var(--muted); font-size: 12px; white-space: nowrap; }
.gx-top-empty { margin: 0; color: var(--muted); font-size: 13px; }
</style>`;

router.get('/quizzes', (req, res) => {
  const rows = db.prepare('SELECT id, title, description, questions, negative_marks, type, seo, updated_at FROM quizzes ORDER BY created_at DESC').all();
  const items = rows.map((r) => {
    const s = parseJson(r.seo, {});
    return { id: r.id, title: r.title, description: r.description, type: typeLabel(r.type), stats: quizStats(r), path: itemPath('quizzes', r.id, s.slug || r.title) };
  });

  const cards = items.length
    ? joinWithInlineAds(items.map((it) => `
      <a class="card" href="${escAttr(it.path)}">
        <span class="gx-type">${esc(it.type)}</span>
        <h3>${esc(it.title)}</h3>
        ${it.description ? `<p class="excerpt">${esc(summarize(it.description, 160))}</p>` : ''}
        ${quizStatsHtml(it.stats)}
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
${QUIZ_CARD_STYLE}
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Quizzes', path: '/quizzes' }])}
<h1>Compatibility Quizzes</h1>
<p class="lede">Answer a few playful questions and discover how well you match. Share a link and compare answers with anyone.</p>
${cards}`;
  sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml });
});

router.get('/quizzes/:id/:slug?', optionalAuth, (req, res, next) => {
  const row = db.prepare('SELECT id, title, description, questions, negative_marks, seo, created_at, updated_at FROM quizzes WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, req.path.split('/')[1].replace(/s$/,''));
  const s = parseJson(row.seo, {});
  const chk = canonicalCheck('quizzes', req, row.id, s.slug || row.title);
  if (chk.redirect) return res.redirect(301, chk.redirect);

  const loggedIn = !!req.user;
  const questions = parseJson(row.questions, []);
  // Per-question points and time limit, as set by the admin (0 = none).
  const qPoints = (q) => (Number.isInteger(q.points) && q.points > 0 ? q.points : 0);
  const qSeconds = (q) => (Number.isInteger(q.seconds) && q.seconds > 0 ? q.seconds : 0);
  const totalPoints = questions.reduce((a, q) => a + qPoints(q), 0);
  const negMarks = row.negative_marks || 0;
  const qHtml = questions.map((q, i) => {
    const opts = Array.isArray(q.options) ? q.options : [];
    const optHtml = opts.map((o, oi) =>
      `<label class="gx-qopt"><input type="radio" name="q${i}" value="${oi}" /><span>${esc(o)}</span></label>`
    ).join('');
    const meta = [
      qPoints(q) ? `${qPoints(q)} point${qPoints(q) === 1 ? '' : 's'}` : '',
      qSeconds(q) ? `${qSeconds(q)} seconds` : 'No time limit',
    ].filter(Boolean).join(' · ');
    return `
    <fieldset class="gx-q" data-q="${i}" data-points="${qPoints(q)}" data-seconds="${qSeconds(q)}">
      <legend>${i + 1}. ${esc(q.prompt)}</legend>
      <p class="gx-qmeta">${meta}</p>
      ${optHtml}
    </fieldset>`;
  }).join('');

  const seoDescriptor = resolveSeo(s, {
    canonicalPath: chk.canonical,
    title: row.title,
    description: row.description || `Take the "${row.title}" compatibility quiz on ${SITE_NAME}.`,
    image: `/og/quiz/${row.id}.png`,
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
  const hasQuestions = questions.length > 0;
  const hint = !hasQuestions ? ''
    : (loggedIn
        ? 'Answer every question, then submit to get a private link to compare with someone.'
        : 'Register or sign in to attempt this quiz.');
  const bodyHtml = `
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name: 'Quizzes', path: '/quizzes' }, { name: row.title, path: chk.canonical }])}
<h1>${esc(row.title)}</h1>
${row.description ? `<p class="lede">${esc(row.description)}</p>` : ''}
${ATTEMPT_STYLE}
${hasQuestions ? `
<div id="gxAttempt" class="gx-attempt" data-kind="quiz" data-id="${row.id}" data-logged="${loggedIn ? 1 : 0}">
  <div class="gx-proctor-intro">
    <h2>This quiz runs in full screen</h2>
    <p class="gx-proctor-sum">${questions.length} question${questions.length === 1 ? '' : 's'}${totalPoints ? ` · up to ${totalPoints} points` : ''}</p>
    <ul>
      <li>The quiz opens in full screen and must stay there until you submit.</li>
      <li>Questions come one at a time. Each shows its points and time limit — answer before the timer runs out to earn its points. When time is up, the question is skipped${negMarks ? ` and <strong>${negMarks} point${negMarks === 1 ? ' is' : 's are'} deducted (negative marking)</strong>` : ' and earns nothing (no negative marking)'}.</li>
      <li>Pressing Esc, switching tabs or apps, minimising the window, connecting another display or using remote-control/automation tools counts as leaving the quiz.</li>
      <li>The first time, you get a warning and return to full screen.</li>
      <li><strong>The second time, the quiz stops, you can't attempt it again for 24 hours and 10 points are deducted from your score.</strong></li>
      <li>This is a compatibility quiz: when you finish, you get a link to share that stays active for 24 hours. When a signed-in member answers it, you both see your compatibility results — you earn 10 points and they earn 5.</li>
    </ul>
    <button type="button" class="cta gx-start">Start quiz in full screen</button>
  </div>
  <div class="gx-proctor-bar" hidden><span>Full-screen quiz</span><span class="gx-proctor-strikes"></span></div>
  <div class="gx-step" hidden>
    <div class="gx-step-row"><span class="gx-progress"></span><span class="gx-earned"></span><span class="gx-timer" aria-live="polite"></span></div>
    <div class="gx-timebar"><span></span></div>
  </div>
  <div class="gx-proctor-warn" role="alertdialog" aria-modal="true" aria-labelledby="gxWarnTitle" hidden>
    <div class="gx-proctor-box">
      <h2 id="gxWarnTitle"></h2>
      <p class="gx-proctor-msg"></p>
      <button type="button" class="cta gx-return" hidden>Return to full screen</button>
    </div>
  </div>
  <form id="gxQuizForm" hidden>
    ${qHtml}
    <button type="submit" class="cta gx-submit">Next</button>
  </form>
  <p class="gx-hint">${hint}</p>
  <div class="gx-result" hidden></div>
  <div class="gx-note" hidden></div>
</div>` : '<p class="empty">This quiz has no questions yet.</p>'}
${ads.slotHtml('content_inline')}
${ATTEMPT_SCRIPT}`;
  sendWithAds(res, { seoDescriptor, jsonLd, bodyHtml });
});

/* ===========================================================================
   Polls
=========================================================================== */

function pollTally(id, options) {
  const counts = new Array(options.length).fill(0);
  // Split each option's votes by voter gender (Male / Female / other) so the
  // result bars can be coloured accordingly.
  const genders = options.map(() => ({ male: 0, female: 0, other: 0 }));
  db.prepare(
    `SELECT v.option_index AS oi, p.gender AS gender
       FROM poll_votes v LEFT JOIN profiles p ON p.user_id = v.user_id
      WHERE v.poll_id = ?`
  )
    .all(id)
    .forEach((r) => {
      const i = r.oi;
      if (!(i >= 0 && i < counts.length)) return;
      counts[i] += 1;
      if (r.gender === 'Male') genders[i].male += 1;
      else if (r.gender === 'Female') genders[i].female += 1;
      else genders[i].other += 1;
    });
  const total = counts.reduce((a, b) => a + b, 0);
  return { counts, total, genders };
}

// Coloured, hover-labelled segments for one option's result bar. Each gender
// gets a slice sized by its share of that option's votes; the title attribute
// reveals the exact Male / Female / other breakdown on hover.
function voteBarSegs(g) {
  g = g || { male: 0, female: 0, other: 0 };
  return [
    ['male', g.male, 'Male'],
    ['female', g.female, 'Female'],
    ['other', g.other, 'Other / unspecified'],
  ]
    .filter(([, n]) => n > 0)
    .map(
      ([cls, n, label]) =>
        `<span class="gx-seg gx-seg-${cls}" style="flex-grow:${n}" title="${label}: ${n} vote${n === 1 ? '' : 's'}"></span>`
    )
    .join('');
}

// Small legend explaining the vote colours.
const VOTE_LEGEND = `<p class="gx-legend"><span class="gx-legend-item"><span class="gx-dot gx-seg-male"></span>Male</span><span class="gx-legend-item"><span class="gx-dot gx-seg-female"></span>Female</span><span class="gx-legend-item"><span class="gx-dot gx-seg-other"></span>Other</span></p>`;

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

router.get('/polls/:id/:slug?', optionalAuth, (req, res, next) => {
  const row = db.prepare('SELECT id, question, options, closed, seo, created_at FROM polls WHERE id = ?').get(req.params.id);
  if (!row) return notFound(res, req.path.split('/')[1].replace(/s$/,''));
  const s = parseJson(row.seo, {});
  const chk = canonicalCheck('polls', req, row.id, s.slug || row.question);
  if (chk.redirect) return res.redirect(301, chk.redirect);

  const og = pollOgState(row);
  const { options } = og;
  const { counts, total, genders } = og.tally;

  const loggedIn = !!req.user;
  let myVote = null;
  if (loggedIn) {
    const v = db.prepare('SELECT option_index FROM poll_votes WHERE poll_id = ? AND user_id = ?').get(row.id, req.user.id);
    if (v) myVote = v.option_index;
  }

  const optHtml = options.map((o, i) => {
    const n = counts[i] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    return `
      <button type="button" class="gx-opt${myVote === i ? ' mine' : ''}" data-i="${i}"${row.closed ? ' disabled' : ''}>
        <span class="gx-opt-bar" style="width:${pct}%">${voteBarSegs(genders[i])}</span>
        <span class="gx-opt-main"><span class="gx-opt-label">${esc(o)}</span><span class="gx-opt-meta">${pct}% · ${n}</span></span>
      </button>`;
  }).join('');

  const hint = row.closed
    ? 'This poll is closed.'
    : (loggedIn ? 'Tap an option to cast or change your vote.' : 'Tap an option — you’ll be asked to register to vote.');

  // The share image is always the live poll results card (never an admin
  // override), so a shared link previews the poll exactly as people voted.
  const pollImage = `/og/poll/${row.id}.png?v=${og.version}`;
  const seoDescriptor = resolveSeo({ ...s, ogImage: '', twitterImage: '' }, {
    canonicalPath: chk.canonical,
    title: row.question,
    description: row.question ? `Vote: ${summarize(row.question, 150)} — ${total} vote${total === 1 ? '' : 's'} so far. Join the poll on ${SITE_NAME}.` : undefined,
    image: pollImage,
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
<p class="lede gx-total">${total} vote${total === 1 ? '' : 's'} so far${row.closed ? ' · this poll is closed' : ''}.</p>
${ATTEMPT_STYLE}
<div id="gxAttempt" class="gx-attempt" data-kind="poll" data-id="${row.id}" data-logged="${loggedIn ? 1 : 0}"${row.closed ? ' data-closed="1"' : ''}>
  <div class="gx-opts">${optHtml}</div>
  ${VOTE_LEGEND}
  <p class="gx-hint">${hint}</p>
  <div class="gx-note" hidden></div>
</div>
${ads.slotHtml('content_inline')}
${ATTEMPT_SCRIPT}`;
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
   Public profile share pages — /u/<username>

   Every profile gets a shareable link. The link unfurls (Open Graph / Twitter
   card) with the member's profile picture and their age · gender · country,
   so recipients preview who it is. A logged-in visitor is sent straight to the
   profile inside the app; a logged-out visitor sees a preview card and must
   sign up to open the full profile or do anything (message, rate, connect).
   These pages are noindex — members share them deliberately, not for search.
=========================================================================== */

function genderGlyph(g) {
  return g === 'Female' ? '♀' : g === 'Male' ? '♂' : '⚧';
}

// The member's fixed profile QR code (PNG). It encodes their public link
// /u/<username>, so scanning it opens their profile. ?download=1 saves it.
router.get('/qr/u/:file', (req, res, next) => {
  const m = /^(.+)\.png$/i.exec(req.params.file);
  if (!m) return next();
  const row = db
    .prepare('SELECT u.username FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.username = ? COLLATE NOCASE')
    .get(m[1]);
  if (!row) return res.status(404).type('text/plain').send('No such profile.');
  const png = renderProfileQr(row.username, absUrl('/u/' + row.username));
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="getxmatch-${row.username}-qr.png"`);
  res.send(png);
});

// Public profile link (/u/<username>) — what the share button and the profile
// QR code point to. A logged-in member is taken to the profile inside the app;
// anyone else sees a read-only profile and must join to message, follow, rate
// or connect. Intimate fields, photos, GIFs and comments stay members-only.
router.get('/u/:username', optionalAuth, (req, res) => {
  const row = db
    .prepare(
      `SELECT u.id, u.username FROM users u JOIN profiles p ON p.user_id = u.id
       WHERE u.username = ? COLLATE NOCASE`
    )
    .get(req.params.username);
  if (!row) return notFound(res, 'profile');

  // A logged-in member lands straight on the profile inside the app.
  if (req.user) return res.redirect(302, '/?view=' + encodeURIComponent(row.username));

  const pr = buildProfile(row.id, null);
  const name = pr.displayName || pr.username;
  const age = pr.age;
  const avatar = pr.avatar;

  // The facts a shared link surfaces: age · gender · country.
  const factLine = [age != null ? `${age}` : null, pr.gender || null, pr.country || null]
    .filter(Boolean)
    .join(' · ');
  const description =
    `${name}${factLine ? ` — ${factLine}` : ''} on ${SITE_NAME}. ` +
    `View ${name}'s profile — join to message, follow, rate or connect.`;

  const seoDescriptor = resolveSeo({ noindex: true }, {
    canonicalPath: '/u/' + pr.username,
    title: `${name}${age != null ? `, ${age}` : ''}`,
    description,
    image: avatar || undefined, // the profile picture is the share image
    type: 'profile',
  });

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    mainEntity: {
      '@type': 'Person',
      name,
      url: absUrl('/u/' + pr.username),
      image: avatar ? absUrl(avatar) : undefined,
      gender: pr.gender || undefined,
    },
  };

  const signupHref = '/?view=' + encodeURIComponent(pr.username) + '&signup=1';
  const loginHref = '/?view=' + encodeURIComponent(pr.username);
  const qrSrc = `/qr/u/${encodeURIComponent(pr.username)}.png`;

  const badges = [
    age != null ? `<span class="pf-badge">🎂 ${age}</span>` : '',
    pr.gender ? `<span class="pf-badge">${genderGlyph(pr.gender)} ${esc(pr.gender)}</span>` : '',
    pr.country ? `<span class="pf-badge">📍 ${esc([pr.city, pr.state, pr.country].filter(Boolean).join(', '))}</span>` : '',
  ].filter(Boolean).join('');

  const details = [
    ['Relationship', pr.relationshipStatus],
  ].filter(([, v]) => v).map(([k, v]) => `<div class="pf-detail"><span>${k}</span><strong>${esc(v)}</strong></div>`).join('');

  const interests = (pr.interests || []).map((t) => `<span class="pf-chip">${esc(t)}</span>`).join('');
  const rating = pr.rating && pr.rating.count
    ? `⭐ ${Math.round(pr.rating.average * 10) / 10} (${pr.rating.count} rating${pr.rating.count === 1 ? '' : 's'})`
    : '⭐ No ratings yet';
  const f = pr.follow || { followers: 0, following: 0 };

  const avatarHtml = avatar
    ? `<img class="pf-avatar" src="${escAttr(avatar)}" alt="${escAttr(name)}" />`
    : '<div class="pf-avatar pf-avatar-ph">👤</div>';

  // Every action is shown but locked for visitors — it leads to sign-up.
  const lockedAction = (icon, label) =>
    `<a class="pf-action" href="${escAttr(signupHref)}" title="Join ${escAttr(SITE_NAME)} to ${escAttr(label.toLowerCase())}">${icon} ${esc(label)} <span aria-hidden="true">🔒</span></a>`;

  const bodyHtml = `
<style>
.pf-card { max-width: 560px; margin: 24px auto; background: var(--bg2);
  border: 1px solid var(--border); border-radius: 18px; padding: 28px 24px; }
.pf-head { text-align: center; }
.pf-avatar { width: 150px; height: 150px; border-radius: 50%; object-fit: cover;
  border: 3px solid var(--accent); display: block; margin: 0 auto 14px; background: var(--bg); }
.pf-avatar-ph { display: flex; align-items: center; justify-content: center; font-size: 64px; }
.pf-name { font-size: 26px; font-weight: 800; margin: 0 0 4px; }
.pf-handle { color: var(--muted); margin: 0 0 10px; }
.pf-stats { color: var(--muted); font-size: 14px; margin: 0 0 14px; }
.pf-stats strong { color: var(--text); }
.pf-badges { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin: 0 0 16px; }
.pf-badge { border: 1px solid var(--border); border-radius: 999px; padding: 6px 12px; font-weight: 600; background: var(--bg); }
.pf-sec { border-top: 1px solid var(--border); padding: 16px 0 0; margin: 16px 0 0; }
.pf-sec h2 { font-size: 15px; margin: 0 0 8px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.pf-sec p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.pf-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.pf-detail { background: var(--bg3); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; }
.pf-detail span { color: var(--muted); font-size: 12px; }
.pf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.pf-chip { background: var(--bg3); border-radius: 999px; padding: 4px 10px; font-size: 13px; }
.pf-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.pf-action { display: block; text-align: center; padding: 10px; border: 1px dashed var(--border); border-radius: 10px; color: var(--muted); font-weight: 600; }
.pf-action:hover { text-decoration: none; border-color: var(--accent); color: var(--text); }
.pf-gate { color: var(--muted); font-size: 14px; margin: 12px 0; text-align: center; }
.pf-card .cta { display: block; text-align: center; margin: 0 0 10px; }
.pf-login { color: var(--accent); }
.pf-qr { text-align: center; }
.pf-qr img { width: 220px; max-width: 70%; height: auto; border-radius: 12px; border: 1px solid var(--border); }
</style>
${breadcrumbHtml([{ name: 'Home', path: '/' }, { name, path: '/u/' + pr.username }])}
<div class="pf-card">
  <div class="pf-head">
    ${avatarHtml}
    <h1 class="pf-name">${esc(name)}</h1>
    <p class="pf-handle">@${esc(pr.username)}</p>
    <p class="pf-stats"><strong>${f.followers}</strong> follower${f.followers === 1 ? '' : 's'} · <strong>${f.following}</strong> following · ${rating}</p>
    ${badges ? `<div class="pf-badges">${badges}</div>` : ''}
  </div>
  ${pr.about ? `<div class="pf-sec"><h2>About me</h2><p>${esc(pr.about)}</p></div>` : ''}
  ${details ? `<div class="pf-sec"><h2>Details</h2><div class="pf-details">${details}</div></div>` : ''}
  ${interests ? `<div class="pf-sec"><h2>Interests</h2><div class="pf-chips">${interests}</div></div>` : ''}
  <div class="pf-sec">
    <div class="pf-actions">
      ${lockedAction('💬', 'Message')}
      ${lockedAction('➕', 'Follow')}
      ${lockedAction('⭐', 'Rate')}
      ${lockedAction('🤝', 'Connect')}
    </div>
    <p class="pf-gate">You’re viewing ${esc(name)}’s profile as a visitor. Join ${esc(SITE_NAME)} to message, follow, rate or connect — and to see photos and more.</p>
    <a class="cta" href="${escAttr(signupHref)}">Join ${esc(SITE_NAME)} — it’s free →</a>
    <p class="pf-gate">Already a member? <a class="pf-login" href="${escAttr(loginHref)}">Log in</a></p>
  </div>
  <div class="pf-sec pf-qr">
    <h2>Profile QR code</h2>
    <a href="/u/${escAttr(pr.username)}" title="Open ${escAttr(name)}’s profile"><img src="${escAttr(qrSrc)}" alt="QR code for ${escAttr(name)}’s getxmatch profile" width="220" height="282" loading="lazy" /></a>
  </div>
</div>`;

  res.send(renderDocument({ seoDescriptor, jsonLd, bodyHtml }));
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
    ['Create your account', 'Confirm you are 18+ and verify your email with a one-time code. Your email is never shown to anyone else. Joining with a friend’s referral link gets you 2 points to start.'],
    ['Build your profile', 'Add your gender, date of birth and country, then pick your state and city, write a few words about yourself and choose up to 10 areas of interest. Add a display picture and a gallery of up to 25 photos.'],
    ['Find your people on the Highway', 'The Highway is the community feed. You see posts from members who share at least 5 of your interests, live in your country or were born in your decade. Post text, pictures and links — every picture you upload is shared there too.'],
    ['Connect', 'Send friend requests, follow members, rate profiles and leave comments. Browse and search members, or send a request straight from a Highway post or the leaderboard.'],
    ['Take quizzes and vote in polls', 'Quizzes are played in full screen with a timer on each question. Compatibility quizzes give you a share link that stays open for 24 hours — when someone answers it, you both see how well you match and both earn points.'],
    ['Chat in real time', 'Message one-to-one or in groups and send everyday gifts like a thank-you or a warm hug. Shared files are relayed live and never stored on our servers.'],
    ['Earn points and climb the leaderboard', 'Almost everything you do earns points, and the leaderboard ranks every member strictly by points.'],
  ];
  const stepHtml = steps.map((s, i) => `
    <div class="card">
      <h3>${i + 1}. ${esc(s[0])}</h3>
      <p class="excerpt">${esc(s[1])}</p>
    </div>`).join('');
  renderInfo(res, {
    pathname: '/how-it-works',
    title: 'How it works',
    description: `How ${SITE_NAME} works — build a profile around your interests, meet like-minded people on the Highway, take compatibility quizzes, vote in polls, chat in real time and earn points on the leaderboard. Free to join, 18+.`,
    lede: `Getting started on ${SITE_NAME} takes a minute. Here's the whole journey, step by step.`,
    bodyHtml: stepHtml + `
<h2>How points work</h2>
<ul>
  <li><strong>Quizzes:</strong> the points set on each question you answer in time (your best attempt per quiz counts). Some quizzes take points off for questions left unanswered when time runs out.</li>
  <li><strong>Compatibility links:</strong> 10 points when someone answers the link you shared, and 5 points for answering someone else's — once per quiz for each pair of members.</li>
  <li><strong>Polls:</strong> 5 points for each poll you vote in (changing your vote doesn't earn more).</li>
  <li><strong>Highway:</strong> 4 points for every like your posts receive.</li>
  <li><strong>Friends &amp; ratings:</strong> 8 points per friend, 5 per rating you receive, plus 20 × your average star rating.</li>
  <li><strong>Follows:</strong> following someone costs their follow fee (1 point by default) and earns them double. Each member sets their own fee, and unfollowing reverses it.</li>
  <li><strong>Referrals:</strong> share your personal code with the Refer button on your profile — you earn 4 points for each person who joins with it, and they get 2.</li>
</ul>

<h2>Fair-play rules for quizzes</h2>
<p>Quizzes are proctored. Leaving full screen, switching tabs or apps, reloading the page or connecting a second screen counts as a strike. The first strike is a warning; the second stops the quiz, locks that quiz for you for 24 hours and deducts 10 points.</p>

<h2>Privacy and safety</h2>
<ul>
  <li>Your email address is never shown to other members.</li>
  <li>Chat files are relayed live and never stored. When both people close a chat and neither reopens it within 12 hours, the conversation is deleted.</li>
  <li>You can ignore or report any member. Profiles that collect many reports are suspended for 7 days. Read our <a href="/safety">Safety guidelines</a> for more.</li>
</ul>

<h2>Explore before you sign up</h2>
<p>You can browse the <a href="/highway">Highway</a>, <a href="/quizzes">quizzes</a>, <a href="/polls">community polls</a> and <a href="/blog">blog</a> without an account. When you're ready to connect, chat and earn points, joining is free.</p>`,
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
Disallow: /u/
Disallow: /qr/

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
