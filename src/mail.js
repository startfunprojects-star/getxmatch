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

module.exports = { sendMail, sendSignupOtp, sendAdminResetLink, smtpReady };
