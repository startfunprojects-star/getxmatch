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

module.exports = { getSetting, setSetting, isFakeActivityEnabled, setFakeActivityEnabled };
