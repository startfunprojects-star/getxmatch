'use strict';

// Link previews for shared quiz links (/m/<token>). When someone pastes the
// link into WhatsApp, Telegram, X, etc., the unfurled card says who invited
// them, to which quiz and what kind it is (challenge / compatibility / open
// compatibility), and that the link is active for 24 hours. The page gets
// Open Graph / Twitter meta tags and a generated 1200×630 image,
// /og/m/<token>.png. Nothing secret goes in: never the sharer's score or any
// answers.

const fs = require('fs');
const path = require('path');

const config = require('./config');
const db = require('./db');
const ogImage = require('./ogImage');
const { esc, absUrl, SITE_NAME } = require('./seo');
const { MATCH_TTL_MS, isGraded } = require('./quizTypes');
const { categoryLabel } = require('./quizCategories');

const TTL_HOURS = MATCH_TTL_MS / 3600000;
const pageFile = path.join(config.root, 'public', 'match.html');

function load(token) {
  const m = db.prepare('SELECT * FROM quiz_matches WHERE token = ?').get(String(token || ''));
  if (!m) return null;
  const quiz = db.prepare('SELECT title, questions, type, category FROM quizzes WHERE id = ?').get(m.quiz_id);
  if (!quiz) return null;
  let n = 0;
  try { n = (JSON.parse(quiz.questions) || []).length; } catch (_e) {}
  return { m, quiz, questionCount: n };
}

// 'done' | 'accepted' (a challenger is playing) | 'expired' | 'active'
function linkState(m) {
  if (m.completed_at) return 'done';
  if (m.challenge && m.b_user_id) return 'accepted';
  if (Date.now() > m.expires_at) return 'expired';
  return 'active';
}

function untilUtc(ms) {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

// Everything the card and the meta tags say about a link.
function describe({ m, quiz, questionCount }) {
  const state = linkState(m);
  const a = m.a_name || 'A friend';
  const b = m.b_name || 'their opponent';
  const cat = categoryLabel(quiz.category);
  const qs = `${questionCount} question${questionCount === 1 ? '' : 's'}`;
  const about = [cat, qs].filter(Boolean).join(' - ');
  const lifetime = `Link active for ${TTL_HOURS} hours`;
  const status = { active: `Active ${TTL_HOURS} hrs`, accepted: 'Accepted', done: 'Finished', expired: 'Expired' }[state];
  const base = { state, status, statusOn: state === 'active', title: quiz.title };

  if (m.challenge || isGraded(quiz.type)) {
    if (state === 'done') {
      return {
        ...base,
        label: 'Quiz challenge',
        heading: `${a} vs ${b}`,
        info: [about, 'Challenge over - open to see who won'],
        footer: 'Result ready',
        pageTitle: `${a} vs ${b} on “${quiz.title}”`,
        description: `${a} challenged ${b} to the “${quiz.title}” quiz on ${SITE_NAME}. The challenge is over — open the link to see who won.`,
      };
    }
    return {
      ...base,
      label: 'Quiz challenge',
      heading: `${a} challenged you`,
      info: [about, 'Same timed quiz - winner takes all points'],
      footer: state === 'expired' ? 'This link has expired' : state === 'accepted' ? 'Challenge accepted - in progress' : lifetime,
      pageTitle: `${a} challenged you to “${quiz.title}”`,
      description: `⚔️ ${a} challenged you to the “${quiz.title}” quiz${cat ? ` (${cat})` : ''} on ${SITE_NAME}. ` +
        `Take the same ${qs} with the same timers — whoever scores more wins the other’s points. Only one person can accept. ` +
        (state === 'expired' ? 'This link has expired.' : `Active for ${TTL_HOURS} hours, until ${untilUtc(m.expires_at)}.`),
    };
  }

  const open = !!m.is_open;
  const label = open ? 'Open compatibility quiz' : 'Compatibility quiz';
  if (state === 'done') {
    return {
      ...base,
      label,
      heading: `${a} & ${b}`,
      info: [about, 'Compatibility result ready'],
      footer: 'Open to see how compatible they are',
      pageTitle: `${a} & ${b} on “${quiz.title}”`,
      description: `${a} and ${b} took the “${quiz.title}” compatibility quiz on ${SITE_NAME}. Open the link to see how compatible they are.`,
    };
  }
  return {
    ...base,
    label,
    heading: `${a} invited you`,
    info: [about, open ? 'Members answer - see your compatibility' : 'Answer it - see how compatible you are'],
    footer: state === 'expired' ? 'This link has expired' : lifetime,
    pageTitle: `${a} invited you to “${quiz.title}”`,
    description: `🧩 ${a} invited you to the “${quiz.title}” ${open ? 'open compatibility' : 'compatibility'} quiz on ${SITE_NAME}. ` +
      `Answer the same ${qs} and see how compatible you are. ` +
      (state === 'expired' ? 'This link has expired.' : `Active for ${TTL_HOURS} hours, until ${untilUtc(m.expires_at)}.`),
  };
}

// The image URL changes with the link's state (and who accepted it), so chat
// apps fetch a fresh card instead of reusing a stale cached one.
function version(m) {
  return `${linkState(m)}${m.b_user_id || ''}`;
}

// GET /og/m/:token.png
function imageRoute(req, res, next) {
  const data = load(req.params.token);
  if (!data) return next();
  const d = describe(data);
  const png = ogImage.renderInviteCard(d, `m:${data.m.token}:${version(data.m)}:${data.m.a_name}:${data.quiz.title}`);
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', req.query.v === version(data.m) ? 'public, max-age=86400' : 'public, max-age=300');
  res.send(png);
}

// GET /m/:token — the standalone match page with preview meta tags.
function pageRoute(req, res) {
  const token = String(req.path.replace(/^\/m\/?/, '').split('/')[0] || '');
  let html;
  try { html = fs.readFileSync(pageFile, 'utf8'); } catch (_e) { return res.sendFile(pageFile); }
  const data = token ? load(token) : null;
  if (data) {
    const d = describe(data);
    const url = absUrl(`/m/${encodeURIComponent(token)}`);
    const img = absUrl(`/og/m/${encodeURIComponent(token)}.png?v=${version(data.m)}`);
    const title = `${d.pageTitle} · ${SITE_NAME}`;
    const tags = [
      `<meta name="description" content="${esc(d.description)}" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
      `<meta property="og:title" content="${esc(d.pageTitle)}" />`,
      `<meta property="og:description" content="${esc(d.description)}" />`,
      `<meta property="og:url" content="${esc(url)}" />`,
      `<meta property="og:image" content="${esc(img)}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="${esc(`${d.heading} — “${d.title}”`)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${esc(d.pageTitle)}" />`,
      `<meta name="twitter:description" content="${esc(d.description)}" />`,
      `<meta name="twitter:image" content="${esc(img)}" />`,
    ].join('\n  ');
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
      .replace('</head>', `  ${tags}\n</head>`);
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(html);
}

module.exports = { imageRoute, pageRoute };
