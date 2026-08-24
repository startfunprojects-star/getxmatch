'use strict';

// Tiny wrapper over the app_settings key/value table.

const db = require('./db');

function getSetting(key, fallback) {
  const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

const FAKE_KEY = 'fake_activity_enabled';

// Fake activity is on by default (only '0' turns it off).
const isFakeActivityEnabled = () => getSetting(FAKE_KEY, '1') !== '0';
const setFakeActivityEnabled = (on) => setSetting(FAKE_KEY, on ? '1' : '0');

/* ---------------------------------------------------------------------------
   Site-wide on-page SEO.

   A single JSON blob controlling the title, description and social-share cards
   for the whole application — i.e. what Google, Facebook, Instagram, Reddit,
   WhatsApp and Twitter/X show when a getxmatch.com link is shared. Stored under
   one key so the field set can grow without a migration. Reads return a plain
   object ({} when nothing is set yet); every field is optional and falls back
   to a brand default in src/seo.js.
--------------------------------------------------------------------------- */
const SITE_SEO_KEY = 'site_seo';

function getSiteSeo() {
  const raw = getSetting(SITE_SEO_KEY, null);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_e) {
    return {};
  }
}

function setSiteSeo(obj) {
  setSetting(SITE_SEO_KEY, JSON.stringify(obj && typeof obj === 'object' ? obj : {}));
}

module.exports = {
  getSetting,
  setSetting,
  isFakeActivityEnabled,
  setFakeActivityEnabled,
  getSiteSeo,
  setSiteSeo,
};
