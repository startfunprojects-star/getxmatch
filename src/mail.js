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

/* ---------- Account and parent emails ---------- */

// A short branded email: a title, paragraphs of plain text, an optional big
// code and an optional button. Everything is escaped here.
function simpleMail(to, subject, { title, lines = [], code, cta, footnote }) {
  const appUrl = config.publicUrl;
  const text =
    (title ? `${title}\n\n` : '') +
    lines.join('\n\n') +
    (code ? `\n\n${code}` : '') +
    (cta ? `\n\n${cta.label}: ${cta.url}` : '') +
    `\n\n— getxmatch`;
  const body =
    (title ? `<p style="margin:0 0 14px;font-size:18px;font-weight:700;color:${INK}">${escapeHtml(title)}</p>` : '') +
    lines.map((l) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:${INK}">${escapeHtml(l)}</p>`).join('') +
    (code ? `<p style="margin:18px 0;font-size:30px;font-weight:700;letter-spacing:6px;color:${ACCENT}">${escapeHtml(code)}</p>` : '') +
    (cta ? `<p style="margin:24px 0 0;text-align:center">${button(cta.url, cta.label)}</p>` : '');
  return sendMail({ to, subject, text, html: layout(body, appUrl, footnote || '') });
}

const minutes = () => Math.round(config.otpTtlMs / 60000);

function sendPasswordResetCode(email, code) {
  return simpleMail(email, 'Reset your getxmatch password', {
    title: 'Reset your password',
    lines: [`Enter this code on getxmatch to choose a new password. It expires in ${minutes()} minutes.`],
    code,
    footnote: "If you didn't ask to reset your password, ignore this email. Your password stays the same.",
  });
}

function sendEmailChangeCode(email, code) {
  return simpleMail(email, 'Confirm your new getxmatch email', {
    title: 'Confirm your new email address',
    lines: [`Enter this code in getxmatch Account settings to use this address for your account. It expires in ${minutes()} minutes.`],
    code,
    footnote: "If you didn't ask for this, ignore this email.",
  });
}

// Sent to the OLD address once an email change is done.
function sendEmailChangedNotice(oldEmail, newEmail, username) {
  return simpleMail(oldEmail, 'Your getxmatch email was changed', {
    title: 'Your email address was changed',
    lines: [
      `The email for the getxmatch account @${username} was changed to ${newEmail}.`,
      "If you didn't do this, reply to this email or contact contact@getxmatch.com straight away.",
    ],
  });
}

function sendPasswordChangedNotice(email, username) {
  return simpleMail(email, 'Your getxmatch password was changed', {
    title: 'Your password was changed',
    lines: [
      `The password for the getxmatch account @${username} was just changed, and every other device was signed out.`,
      "If you didn't do this, use “Forgot password?” on the login page to choose a new one, then contact contact@getxmatch.com.",
    ],
  });
}

function sendAccountDeletedNotice(email, username) {
  return simpleMail(email, 'Your getxmatch account was deleted', {
    title: 'Your account was deleted',
    lines: [
      `The getxmatch account @${username} and everything in it (profile, photos, reels, posts, messages and points) has been permanently deleted.`,
      "You're welcome back any time with a new account.",
    ],
  });
}

// Parent emails. `child` is { name, username }.
function sendGuardianConfirm(email, child, confirmUrl) {
  return simpleMail(email, `${child.name} added you as their parent on getxmatch`, {
    title: 'Please confirm you are the parent or guardian',
    lines: [
      `${child.name} (@${child.username}), who is under 18, added this email address as their parent or guardian on getxmatch, a social network for learning.`,
      'Once you confirm, you will get a short weekly summary of their activity and you can approve or decline new friends before they connect. You will never see their private messages.',
    ],
    cta: { url: confirmUrl, label: 'Confirm and open parent controls' },
    footnote: "If you don't know this person, ignore this email and nothing will be linked.",
  });
}

function sendGuardianApprovalRequest(email, child, friendName, manageUrl) {
  return simpleMail(email, `${child.name} wants to be friends with ${friendName} on getxmatch`, {
    title: 'A friend request needs your approval',
    lines: [
      `${child.name} (@${child.username}) and ${friendName} both want to be friends on getxmatch.`,
      'They will only be connected (and able to chat) after you approve.',
    ],
    cta: { url: manageUrl, label: 'Review the request' },
  });
}

function sendGuardianRemovalRequest(email, child, manageUrl) {
  return simpleMail(email, `${child.name} asked to remove parent controls on getxmatch`, {
    title: 'Request to remove parent controls',
    lines: [
      `${child.name} (@${child.username}) asked to unlink you as their parent or guardian on getxmatch.`,
      'Nothing changes unless you choose “Remove parent controls” on the parent page.',
    ],
    cta: { url: manageUrl, label: 'Open parent controls' },
  });
}

// `s` = { newFriends: [names], pendingApprovals, quizzes, posts, blogs,
// messages, points, lastActive }
function sendGuardianWeekly(email, child, s, manageUrl) {
  const friends = s.newFriends.length ? `${s.newFriends.length} new friend${s.newFriends.length === 1 ? '' : 's'}: ${s.newFriends.join(', ')}` : 'No new friends';
  return simpleMail(email, `${child.name}'s week on getxmatch`, {
    title: `${child.name}'s week on getxmatch`,
    lines: [
      friends + '.',
      `Quizzes taken: ${s.quizzes} · Highway posts: ${s.posts} · Blogs published: ${s.blogs} · Chat messages sent: ${s.messages}.`,
      `Total points: ${s.points}. Last active: ${s.lastActive}.`,
      s.pendingApprovals ? `${s.pendingApprovals} friend request${s.pendingApprovals === 1 ? ' is' : 's are'} waiting for your approval.` : '',
      'Message contents are private and never included.',
    ].filter(Boolean),
    cta: { url: manageUrl, label: 'Open parent controls' },
    footnote: 'You can turn this weekly summary off on the parent page.',
  });
}

module.exports = {
  sendMail, sendSignupOtp, sendAdminResetLink, sendOfflineDigest, smtpReady,
  sendPasswordResetCode, sendEmailChangeCode, sendEmailChangedNotice, sendPasswordChangedNotice,
  sendAccountDeletedNotice, sendGuardianConfirm, sendGuardianApprovalRequest, sendGuardianRemovalRequest,
  sendGuardianWeekly,
};
