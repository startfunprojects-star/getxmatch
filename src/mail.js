'use strict';

const nodemailer = require('nodemailer');
const config = require('./config');

// If SMTP credentials are configured, send for real. Otherwise fall back to a
// "console" transport that just logs the message — handy for local testing and
// so the app never crashes when email isn't set up yet.
const smtpReady = Boolean(config.smtp.user && config.smtp.pass);

let transporter = null;
if (smtpReady) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  // Check the SMTP login once at startup so a wrong password / blocked port
  // shows up in the server log instead of silently failing on first send.
  transporter
    .verify()
    .then(() => console.log(`mail: SMTP ready (${config.smtp.user} via ${config.smtp.host}:${config.smtp.port})`))
    .catch((e) => console.error(`mail: SMTP login FAILED for ${config.smtp.user} via ${config.smtp.host}:${config.smtp.port} — ${e.code || ''} ${e.message}`));
} else {
  console.warn('mail: SMTP_USER / SMTP_PASS not set — emails are printed to this console instead of being sent.');
}

async function sendMail({ to, subject, text, html }) {
  if (!smtpReady) {
    // Dev fallback — no SMTP configured. Log so the developer/admin can see it.
    console.log('\n──────── EMAIL (not sent — SMTP not configured) ────────');
    console.log(`To:      ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(text || html);
    console.log('────────────────────────────────────────────────────────\n');
    return { logged: true };
  }
  return transporter.sendMail({ from: config.smtp.from, to, subject, text, html });
}

function sendSignupOtp(email, code) {
  const subject = 'Your getxmatch verification code';
  const text =
    `Your getxmatch verification code is: ${code}\n\n` +
    `It expires in ${Math.round(config.otpTtlMs / 60000)} minutes. ` +
    `If you didn't request this, you can ignore this email.`;
  const html =
    `<p>Your getxmatch verification code is:</p>` +
    `<p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
    `<p>It expires in ${Math.round(config.otpTtlMs / 60000)} minutes. ` +
    `If you didn't request this, you can ignore this email.</p>`;
  return sendMail({ to: email, subject, text, html });
}

function sendAdminResetLink(url) {
  const subject = 'getxmatch admin — set your password';
  const text =
    `Use this one-time link to set the getxmatch admin password:\n\n${url}\n\n` +
    `This link expires in ${Math.round(config.adminResetTtlMs / 60000)} minutes and ` +
    `can be used once. Requesting another link invalidates this one.`;
  const html =
    `<p>Use this one-time link to set the getxmatch admin password:</p>` +
    `<p><a href="${url}">${url}</a></p>` +
    `<p>This link expires in ${Math.round(config.adminResetTtlMs / 60000)} minutes and ` +
    `can be used once. Requesting another link invalidates this one.</p>`;
  return sendMail({ to: config.adminEmail, subject, text, html });
}

// Activity email (src/digest.js), at most one per member per 24 hours. `parts`
// is an array of human-readable lines (e.g. "2 new friend requests from Alice
// and Bob", "A new quiz: “…”"). `features` (optional) are the new polls and
// quizzes as picture cards: { kind, title, description, meta, url, image, cta }
// — the image is the live-rendered preview, so a poll shows its current votes.
function sendOfflineDigest(email, { name, parts, features = [], appUrl }) {
  const greeting = name ? `Hi ${name},` : 'Hi,';
  const request = parts.find((p) => /friend request/.test(p));
  const poll = features.find((f) => f.kind === 'Poll');
  const quiz = features.find((f) => f.kind === 'Quiz');
  const subject = request ? `You have ${request} on getxmatch`
    : poll ? `New poll: ${clip(poll.title, 70)}`
      : quiz ? `New quiz: ${clip(quiz.title, 70)}`
        : "What's new for you on getxmatch";

  // Poll / quiz summary lines are replaced by their cards when there are any.
  const kinds = new Set(features.map((f) => f.kind.toLowerCase()));
  const others = parts.filter((p) => {
    const m = /^(?:A|\d+) new (poll|quiz)/.exec(p);
    return !(m && kinds.has(m[1]));
  });

  const bullets = others.map((p) => `• ${p}`).join('\n');
  const featureText = features.map((f) => `${f.kind}: ${f.title}\n${f.meta}\n${f.cta}: ${f.url}`).join('\n\n');
  const text =
    `${greeting}\n\n` +
    `Here's what's new for you:\n\n` +
    (bullets ? `${bullets}\n\n` : '') +
    (featureText ? `${featureText}\n\n` : '') +
    `Open getxmatch: ${appUrl}\n\n` +
    `— getxmatch\n\n` +
    `You're receiving this because you have an account on getxmatch.`;

  const body =
    `<p style="margin:0 0 6px;font-size:18px;font-weight:700;color:${INK}">${escapeHtml(greeting)}</p>` +
    `<p style="margin:0 0 20px;font-size:15px;color:${MUTED}">Here's what's new for you on getxmatch.</p>` +
    (others.length
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border:1px solid ${LINE};border-radius:12px">` +
        others.map((p, i) => `<tr><td style="padding:12px 16px;font-size:15px;color:${INK};${i ? `border-top:1px solid ${LINE};` : ''}">` +
          `<span style="color:${ACCENT};font-weight:700">●</span>&nbsp; ${escapeHtml(p)}</td></tr>`).join('') +
        `</table>`
      : '') +
    features.map(featureCard).join('') +
    `<p style="margin:28px 0 0;text-align:center">${button(appUrl, 'Open getxmatch')}</p>`;

  return sendMail({ to: email, subject, text, html: layout(body, appUrl, "You're receiving this because you have an account on getxmatch.") });
}

/* ---------- HTML email building blocks ----------
   Table layout with inline styles: what Gmail, Outlook and Apple Mail all
   render the same way. */
const ACCENT = '#1f4e8c';
const ACCENT_2 = '#8c2f39';
const INK = '#1a2233';
const MUTED = '#5b6578';
const LINE = '#e3e7ef';

function clip(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function button(href, label) {
  return `<a href="${escapeHtml(href)}" style="display:inline-block;background:${ACCENT};color:#ffffff;` +
    `font-weight:700;font-size:15px;padding:12px 26px;border-radius:999px;text-decoration:none">${escapeHtml(label)} →</a>`;
}

function featureCard(f) {
  const badge = f.kind === 'Poll' ? '📊 New poll' : '🧠 New quiz';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="margin:0 0 20px;border:1px solid ${LINE};border-radius:14px;overflow:hidden;background:#ffffff">` +
    `<tr><td style="padding:0;line-height:0"><a href="${escapeHtml(f.url)}">` +
      `<img src="${escapeHtml(f.image)}" width="536" alt="${escapeHtml(f.title)}" ` +
      `style="display:block;width:100%;max-width:536px;height:auto;border:0" /></a></td></tr>` +
    `<tr><td style="padding:18px 20px 20px">` +
      `<div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${ACCENT_2}">${badge}</div>` +
      `<div style="margin:6px 0 4px;font-size:18px;font-weight:700;line-height:1.35;color:${INK}">${escapeHtml(f.title)}</div>` +
      (f.description ? `<div style="margin:0 0 6px;font-size:14px;line-height:1.5;color:${MUTED}">${escapeHtml(clip(f.description, 200))}</div>` : '') +
      `<div style="margin:0 0 16px;font-size:13px;color:${MUTED}">${escapeHtml(f.meta)}</div>` +
      button(f.url, f.cta) +
    `</td></tr></table>`;
}

// The shared frame: brand header, white content card, small footer.
function layout(body, appUrl, footnote) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#f3f5f9;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px">` +
      `<tr><td style="background:${ACCENT};background-image:linear-gradient(135deg,${ACCENT},${ACCENT_2});border-radius:16px 16px 0 0;padding:20px 32px">` +
        `<a href="${escapeHtml(appUrl)}" style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-.01em;text-decoration:none">getxmatch</a>` +
        `<div style="color:#dfe7f5;font-size:13px;margin-top:2px">Profiles, quizzes, polls &amp; real-time chat</div></td></tr>` +
      `<tr><td style="background:#ffffff;border-radius:0 0 16px 16px;padding:28px 32px 32px">${body}</td></tr>` +
      `<tr><td style="padding:18px 12px;text-align:center;font-size:12px;line-height:1.5;color:#8a93a5">` +
        (footnote ? `${escapeHtml(footnote)}<br>` : '') +
        `© ${new Date().getFullYear()} getxmatch · <a href="${escapeHtml(appUrl)}" style="color:#8a93a5">${escapeHtml(appUrl.replace(/^https?:\/\//, ''))}</a></td></tr>` +
    `</table></td></tr></table></body></html>`;
}

// Minimal HTML escaping for values interpolated into the digest markup.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { sendMail, sendSignupOtp, sendAdminResetLink, sendOfflineDigest, smtpReady };
