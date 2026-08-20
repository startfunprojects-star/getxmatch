'use strict';

// Server-side rendering helpers for the public, crawlable pages (quizzes,
// polls, blogs). These pages exist purely so search engines and social-media
// unfurlers can read real content and metadata — the logged-in experience is
// still the SPA. Every field the admin fills under "On-page SEO" is honoured
// here, with sensible fallbacks derived from the content itself.

const config = require('./config');

const SITE_NAME = 'getxmatch';
const SITE_TAGLINE = 'A lightweight social space for adults — profiles, galleries, quizzes, polls and real-time chat.';
const DEFAULT_OG_TYPE = 'website';

// Brand assets (served from /public). The OG cover is the fallback social-share
// image used whenever a page has no image of its own; the logo feeds the
// Organization structured data. Both are site-relative and made absolute below.
const SITE_LOGO = '/assets/logo.svg';
const SITE_OG_IMAGE = '/assets/og-cover.svg';

// Optional social presence for the Organization `sameAs` and the Twitter card
// `site` handle. Configured via env so they can be set per-deployment without a
// code change; empty by default so nothing bogus is emitted.
const TWITTER_HANDLE = (process.env.TWITTER_HANDLE || '').trim();
const SOCIAL_LINKS = (process.env.SOCIAL_LINKS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// HTML-escape text for safe interpolation into markup.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape a value for use inside an HTML attribute (quotes matter most).
function escAttr(s) {
  return esc(s);
}

// Turn a site-relative path into an absolute URL using the configured base.
function absUrl(pathname) {
  if (!pathname) return config.publicUrl;
  if (/^https?:\/\//i.test(pathname)) return pathname;
  return config.publicUrl + (pathname.startsWith('/') ? '' : '/') + pathname;
}

// A URL-friendly slug (mirrors the admin slugify so canonical links match).
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// Canonical path for a content item: /<base>/<id>/<slug>. The id guarantees a
// unique, always-resolvable URL; the slug carries the keywords for SEO.
function itemPath(base, id, slugSource) {
  const slug = slugify(slugSource);
  return `/${base}/${id}${slug ? '/' + slug : ''}`;
}

// Truncate a plain-text string to `n` chars on a word boundary, adding an
// ellipsis. Used to build meta descriptions from body text.
function summarize(text, n = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

// Merge an admin-provided SEO object with fallbacks derived from the content.
// Returns a flat, ready-to-render descriptor.
//   seo            the parsed `seo` JSON blob (may be {})
//   canonicalPath  site-relative canonical path for this page
//   title/desc     content-derived fallbacks
//   image          site-relative or absolute fallback image (optional)
//   type           OG type (website / article)
function resolveSeo(seo, { canonicalPath, title, description, image, type }) {
  seo = seo || {};
  const metaTitle = (seo.metaTitle || title || SITE_NAME).slice(0, 70);
  const fullTitle = metaTitle === SITE_NAME ? SITE_NAME : `${metaTitle} · ${SITE_NAME}`;
  const metaDescription = (seo.metaDescription || description || SITE_TAGLINE).slice(0, 320);
  const canonical = absUrl(seo.canonicalUrl || canonicalPath);
  // Fall back to the site-wide social cover so every page shares a rich preview.
  const rawImage = seo.ogImage || seo.twitterImage || image || SITE_OG_IMAGE;
  const ogImage = rawImage;
  return {
    title: fullTitle,
    metaTitle,
    description: metaDescription,
    keywords: seo.metaKeywords || '',
    canonical,
    noindex: !!seo.noindex,
    nofollow: !!seo.nofollow,
    ogTitle: seo.ogTitle || metaTitle,
    ogDescription: seo.ogDescription || metaDescription,
    ogType: seo.ogType || type || DEFAULT_OG_TYPE,
    ogImage: ogImage ? absUrl(ogImage) : '',
    twitterCard: seo.twitterCard || (ogImage ? 'summary_large_image' : 'summary'),
    twitterTitle: seo.twitterTitle || seo.ogTitle || metaTitle,
    twitterDescription: seo.twitterDescription || seo.ogDescription || metaDescription,
    twitterImage: (seo.twitterImage || ogImage) ? absUrl(seo.twitterImage || ogImage) : '',
  };
}

// Build the <head> meta block from a resolved SEO descriptor.
function headTags(s) {
  const robots = [s.noindex ? 'noindex' : 'index', s.nofollow ? 'nofollow' : 'follow'].join(', ');
  const tags = [
    `<title>${esc(s.title)}</title>`,
    `<meta name="description" content="${escAttr(s.description)}" />`,
    s.keywords ? `<meta name="keywords" content="${escAttr(s.keywords)}" />` : '',
    `<meta name="robots" content="${robots}" />`,
    `<link rel="canonical" href="${escAttr(s.canonical)}" />`,
    // Open Graph
    `<meta property="og:site_name" content="${escAttr(SITE_NAME)}" />`,
    `<meta property="og:title" content="${escAttr(s.ogTitle)}" />`,
    `<meta property="og:description" content="${escAttr(s.ogDescription)}" />`,
    `<meta property="og:type" content="${escAttr(s.ogType)}" />`,
    `<meta property="og:url" content="${escAttr(s.canonical)}" />`,
    s.ogImage ? `<meta property="og:image" content="${escAttr(s.ogImage)}" />` : '',
    s.ogImage ? `<meta property="og:image:alt" content="${escAttr(s.ogTitle)}" />` : '',
    s.ogImage ? `<meta property="og:image:width" content="1200" />` : '',
    s.ogImage ? `<meta property="og:image:height" content="630" />` : '',
    `<meta property="og:locale" content="en_US" />`,
    // Twitter
    `<meta name="twitter:card" content="${escAttr(s.twitterCard)}" />`,
    TWITTER_HANDLE ? `<meta name="twitter:site" content="${escAttr(TWITTER_HANDLE)}" />` : '',
    `<meta name="twitter:title" content="${escAttr(s.twitterTitle)}" />`,
    `<meta name="twitter:description" content="${escAttr(s.twitterDescription)}" />`,
    s.twitterImage ? `<meta name="twitter:image" content="${escAttr(s.twitterImage)}" />` : '',
  ];
  return tags.filter(Boolean).join('\n  ');
}

// One or more JSON-LD blocks.
function jsonLdTag(obj) {
  if (!obj) return '';
  const arr = Array.isArray(obj) ? obj : [obj];
  return arr
    .filter(Boolean)
    .map((o) => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`)
    .join('\n  ');
}

// A BreadcrumbList JSON-LD from [{name, path}] crumbs.
function breadcrumbLd(crumbs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: absUrl(c.path),
    })),
  };
}

// Organization structured data — logo + optional social profiles. Emitted on
// the home page so Google can build a Knowledge-Graph entry for the brand.
function organizationLd() {
  const org = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: absUrl('/'),
    logo: absUrl(SITE_LOGO),
    description: SITE_TAGLINE,
  };
  if (SOCIAL_LINKS.length) org.sameAs = SOCIAL_LINKS;
  return org;
}

// WebSite structured data with a Sitelinks Search Box action, so Google can
// surface an in-site search field under the brand result.
function websiteLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: absUrl('/'),
    description: SITE_TAGLINE,
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: absUrl('/search?q={search_term_string}') },
      'query-input': 'required name=search_term_string',
    },
  };
}

// Extract a YouTube video id from a watch/share/embed URL, or null.
function youtubeId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const mm = u.pathname.match(/^\/(embed|shorts|v)\/([^/?#]+)/);
      if (mm) return mm[2];
    }
  } catch (_e) { /* not a url */ }
  return null;
}

// Safely render a user-authored post body to HTML: everything is escaped, URLs
// become links, and YouTube / image / video links are embedded below the text.
function renderUserText(text) {
  const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
  const str = String(text == null ? '' : text);
  let html = '';
  let last = 0;
  let m;
  const embeds = [];
  while ((m = URL_RE.exec(str)) !== null) {
    const url = m[0];
    html += esc(str.slice(last, m.index));
    html += `<a href="${escAttr(url)}" target="_blank" rel="nofollow noopener">${esc(url)}</a>`;
    last = m.index + url.length;
    const yt = youtubeId(url);
    if (yt) {
      embeds.push(`<iframe class="hw-embed" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}" title="YouTube video" allow="accelerometer; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe>`);
    } else if (/\.(jpe?g|png|gif|webp|bmp|svg)(\?|#|$)/i.test(url)) {
      embeds.push(`<a href="${escAttr(url)}" target="_blank" rel="noopener"><img class="hw-media-img" src="${escAttr(url)}" alt="" loading="lazy" /></a>`);
    } else if (/\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(url)) {
      embeds.push(`<video class="hw-media-video" src="${escAttr(url)}" controls preload="metadata"></video>`);
    }
  }
  html += esc(str.slice(last));
  html = html.replace(/\n/g, '<br />');
  return `<div class="hw-text">${html}</div>` + (embeds.length ? `<div class="hw-embeds">${embeds.join('')}</div>` : '');
}

// Visible breadcrumb trail markup.
function breadcrumbHtml(crumbs) {
  const parts = crumbs.map((c, i) =>
    i === crumbs.length - 1
      ? `<span aria-current="page">${esc(c.name)}</span>`
      : `<a href="${escAttr(c.path)}">${esc(c.name)}</a>`
  );
  return `<nav class="crumbs" aria-label="Breadcrumb">${parts.join('<span class="sep">›</span>')}</nav>`;
}

// The shared inline stylesheet for public pages — small, fast, theme-aware, and
// independent of the app's large SPA stylesheet.
const PAGE_CSS = `
:root{--bg:#0b0d13;--bg2:#14171f;--bg3:#1c202b;--text:#eef0f6;--muted:#98a0b2;--border:#262c39;--accent:#ff4d7d;--accent2:#7c5cff;--grad:linear-gradient(135deg,var(--accent),var(--accent2))}
@media (prefers-color-scheme:light){:root{--bg:#f6f7fb;--bg2:#fff;--bg3:#eef0f5;--text:#141824;--muted:#5b6270;--border:#e4e7ee;--accent:#e5356a;--accent2:#6a4bff}}
*{box-sizing:border-box}
::selection{background:rgba(255,77,125,.34);color:#fff}
*{scrollbar-width:thin;scrollbar-color:var(--border) transparent}
:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(124,92,255,.38);border-radius:8px}
body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,'Apple Color Emoji','Segoe UI Emoji',sans-serif;color:var(--text);line-height:1.65;-webkit-font-smoothing:antialiased;
  background:radial-gradient(1100px 620px at 100% -8%,rgba(124,92,255,.13),transparent 60%),radial-gradient(900px 520px at -8% 112%,rgba(255,77,125,.10),transparent 60%),var(--bg);background-attachment:fixed}
a{color:var(--accent);text-decoration:none;transition:color .15s}a:hover{text-decoration:underline}
.wrap{max-width:840px;margin:0 auto;padding:0 20px}
header.site{border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg2) 78%,transparent);position:sticky;top:0;z-index:20;backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px)}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;height:62px;gap:16px}
.brand{font-weight:800;font-size:21px;letter-spacing:.2px;background:linear-gradient(115deg,var(--text) 0%,var(--text) 38%,var(--accent) 74%,var(--accent2) 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}.brand .x{-webkit-text-fill-color:var(--accent)}
nav.top a{color:var(--muted);font-weight:600;margin-left:18px;font-size:15px}
nav.top a:hover{color:var(--text);text-decoration:none}
main{padding:28px 0 56px}
h1{font-size:32px;line-height:1.2;letter-spacing:-.02em;margin:.2em 0 .4em}
h2{font-size:22px;margin:1.4em 0 .5em}
.lede{color:var(--muted);font-size:18px;margin:0 0 20px}
.crumbs{font-size:13px;color:var(--muted);margin-bottom:14px}
.crumbs a{color:var(--muted)}.crumbs .sep{margin:0 7px;opacity:.6}
.card{display:block;background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:18px 20px;margin:0 0 14px;box-shadow:0 1px 2px rgba(0,0,0,.2),0 10px 30px rgba(0,0,0,.14);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}
a.card:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--accent) 50%,var(--border));box-shadow:0 14px 40px rgba(0,0,0,.28);text-decoration:none}
.card h3{margin:0 0 6px;font-size:19px}.card h3 a{color:var(--text)}
.meta{color:var(--muted);font-size:13px;margin:0 0 8px}
.excerpt{margin:0;color:var(--text)}
.q{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin:0 0 12px}
.q .prompt{font-weight:700;margin:0 0 8px}
.q ul{margin:0;padding-left:20px}.q li{margin:3px 0}
.opt{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--border)}
.opt:last-child{border-bottom:none}
.bar{height:8px;border-radius:6px;background:linear-gradient(90deg,var(--accent),var(--accent2));margin-top:4px}
.cta{display:inline-block;background:var(--grad);color:#fff;font-weight:700;padding:13px 24px;border-radius:999px;margin:18px 0;box-shadow:0 6px 22px rgba(255,77,125,.32);transition:transform .16s ease,box-shadow .16s ease,filter .16s ease}
.cta:hover{text-decoration:none;transform:translateY(-2px);box-shadow:0 10px 32px rgba(255,77,125,.45);filter:brightness(1.05)}
.cover{width:100%;max-height:380px;object-fit:cover;border-radius:14px;margin:0 0 20px}
article.post{font-size:17px}article.post p{margin:0 0 1em}
footer.site{border-top:1px solid var(--border);color:var(--muted);font-size:13px;padding:24px 0;background:var(--bg2)}
footer.site .wrap{display:flex;flex-wrap:wrap;gap:14px;justify-content:space-between}
footer.site a{color:var(--muted)}
footer.site .fnav{line-height:2}
.empty{color:var(--muted);padding:30px 0}
.prose h2{font-size:22px}.prose h3{font-size:18px;margin:1.2em 0 .4em}
.prose ul{padding-left:22px}.prose li{margin:6px 0}
.faq{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:4px 18px;margin:0 0 12px}
.faq summary{cursor:pointer;font-weight:700;padding:12px 0;list-style:none}
.faq summary::-webkit-details-marker{display:none}
.faq summary::before{content:'＋';color:var(--accent);margin-right:10px;font-weight:800}
.faq[open] summary::before{content:'－'}
.faq .a{padding:0 0 14px;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin:18px 0}
.hero{padding:14px 0 6px}
.hero .lede{font-size:20px;max-width:640px}
.updated{color:var(--muted);font-size:13px;margin:0 0 18px}
/* Advertisements */
.ad-slot{display:block;text-align:center;margin:22px auto;max-width:100%}
.ad-slot .ad-label{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);opacity:.7;margin:0 0 6px}
.ad-slot .ad-image{display:inline-block;line-height:0}
.ad-slot .ad-image img{max-width:100%;height:auto;border-radius:12px;border:1px solid var(--border)}
.ad-slot .ad-frame{max-width:100%;border-radius:12px;overflow:hidden;background:transparent}
.ad-header,.ad-footer{border:1px dashed var(--border);border-radius:14px;padding:12px}
.ad-content_inline{margin:18px auto}
/* Highway (public post pool) */
.hw-card{background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:16px 18px;margin:0 0 14px;box-shadow:0 1px 2px rgba(0,0,0,.2),0 10px 30px rgba(0,0,0,.12)}
.hw-card.pinned{border-color:color-mix(in srgb,var(--accent) 55%,var(--border))}
.hw-card-head{display:flex;align-items:center;gap:10px;margin:0 0 8px}
.hw-av{width:38px;height:38px;border-radius:50%;object-fit:cover;flex:none;background:var(--bg3)}
.hw-av-ph{display:grid;place-items:center;font-size:18px}
.hw-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0}
.hw-who{font-weight:700}.hw-handle{color:var(--muted);font-size:13px}
.hw-date{color:var(--muted);font-size:12px}
.hw-pin{margin-left:auto;font-size:12px;font-weight:700;color:var(--accent);white-space:nowrap}
.hw-text{white-space:normal;line-height:1.55;overflow-wrap:anywhere}
.hw-embeds{margin-top:10px;display:flex;flex-direction:column;gap:10px}
.hw-embed{width:100%;max-width:520px;aspect-ratio:16/9;height:auto;border:0;border-radius:12px}
.hw-media-img{max-width:100%;max-height:420px;border-radius:12px;border:1px solid var(--border)}
.hw-media-video{max-width:100%;border-radius:12px}
.hw-card-img{display:block;margin-top:12px;max-width:100%;max-height:460px;border-radius:12px;border:1px solid var(--border)}
/* Side-rail layout used when rail ads are present. */
.page-shell{display:block}
@media (min-width:1180px){
  .page-shell.has-rails{display:grid;grid-template-columns:1fr minmax(0,840px) 1fr;align-items:start;gap:20px;max-width:1320px;margin:0 auto}
  .page-shell.has-rails .wrap{max-width:840px;padding:0 12px}
  .page-shell .rail{position:sticky;top:80px;padding:0 8px}
  .page-shell .rail .ad-slot{margin:0 auto 20px}
}
@media (max-width:1179px){.page-shell .rail{display:none}}
`;

// Full HTML document for a public page.
//   seoDescriptor   from resolveSeo()
//   jsonLd          object/array for structured data
//   bodyHtml        the <main> inner markup (already escaped)
//   railLeft/railRight  optional ad markup for the side rails (wide screens)
function renderDocument({ seoDescriptor, jsonLd, bodyHtml, railLeft, railRight }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#0f1117" />
  ${headTags(seoDescriptor)}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/assets/logo.svg" />
  <link rel="mask-icon" href="/favicon.svg" color="#ff4d7d" />
  <link rel="manifest" href="/site.webmanifest" />
  ${jsonLdTag(jsonLd)}
  <style>${PAGE_CSS}</style>
</head>
<body>
  <header class="site">
    <div class="wrap">
      <a class="brand" href="/">getx<span class="x">match</span></a>
      <nav class="top">
        <a href="/highway">Highway</a>
        <a href="/quizzes">Quizzes</a>
        <a href="/polls">Polls</a>
        <a href="/blog">Blog</a>
        <a href="/how-it-works">How it works</a>
        <a href="/">Open app</a>
      </nav>
    </div>
  </header>
  <main>
    <div class="page-shell${railLeft || railRight ? ' has-rails' : ''}">
      ${railLeft ? `<div class="rail rail-left">${railLeft}</div>` : ''}
      <div class="wrap">
${bodyHtml}
      </div>
      ${railRight ? `<div class="rail rail-right">${railRight}</div>` : ''}
    </div>
  </main>
  <footer class="site">
    <div class="wrap">
      <span>© ${new Date().getFullYear()} ${esc(SITE_NAME)} — a social space for adults 18+.</span>
      <nav class="fnav" aria-label="Footer">
        <a href="/highway">Highway</a> · <a href="/about">About</a> · <a href="/how-it-works">How it works</a> · <a href="/quizzes">Quizzes</a> · <a href="/polls">Polls</a> · <a href="/blog">Blog</a> · <a href="/faq">FAQ</a> · <a href="/safety">Safety</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/sitemap.xml">Sitemap</a>
      </nav>
    </div>
  </footer>
</body>
</html>`;
}

module.exports = {
  SITE_NAME,
  SITE_TAGLINE,
  SITE_LOGO,
  SITE_OG_IMAGE,
  esc,
  escAttr,
  absUrl,
  slugify,
  itemPath,
  summarize,
  resolveSeo,
  jsonLdTag,
  breadcrumbLd,
  breadcrumbHtml,
  organizationLd,
  websiteLd,
  renderUserText,
  renderDocument,
};
