'use strict';

// One inbox, one account. Many providers deliver "name+anything@" to "name@",
// and Gmail also ignores dots in the name, so "j.o.e+2@gmail.com" reaches
// "joe@gmail.com". canonicalEmail() folds those aliases together; signup
// refuses an email whose canonical form already has an account.

const GMAIL = new Set(['gmail.com', 'googlemail.com']);

// Throwaway-inbox services: an account needs an email its owner keeps.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', 'grr.la',
  '10minutemail.com', '10minutemail.net', 'temp-mail.org', 'tempmail.com', 'tempmail.net', 'tempmailo.com',
  'temp-mail.io', 'yopmail.com', 'yopmail.net', 'trashmail.com', 'trashmail.de', 'getnada.com', 'nada.email',
  'dispostable.com', 'maildrop.cc', 'mailnesia.com', 'mintemail.com', 'throwawaymail.com', 'fakeinbox.com',
  'emailondeck.com', 'mohmal.com', 'tempinbox.com', 'mailcatch.com', 'spamgourmet.com', 'moakt.com',
  'tmail.ws', 'tmpmail.org', 'tmpmail.net', 'burnermail.io', 'inboxkitten.com', 'mail.tm', 'mail.gw',
  'dropmail.me', 'emailfake.com', 'fakemail.net', 'luxusmail.org', 'mytemp.email', 'tempr.email',
]);

function splitEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return null;
  return { local: e.slice(0, at), domain: e.slice(at + 1) };
}

function canonicalEmail(email) {
  if (!email) return null;
  const parts = splitEmail(email);
  if (!parts) return String(email || '').trim().toLowerCase();
  let { local, domain } = parts;
  local = local.split('+')[0];
  if (GMAIL.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local + '@' + domain;
}

function isDisposableEmail(email) {
  const parts = splitEmail(email);
  if (!parts) return false;
  // Subdomains of a throwaway service count too (e.g. "x.mailinator.com").
  const labels = parts.domain.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (DISPOSABLE.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

module.exports = { canonicalEmail, isDisposableEmail };
