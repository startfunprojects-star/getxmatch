'use strict';

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// Ensure runtime directories exist.
fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

// Uses Node's built-in SQLite (Node 22.5+) — no native build step required.
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  -- One profile per user. Created after signup.
  CREATE TABLE IF NOT EXISTS profiles (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name  TEXT NOT NULL,
    bio           TEXT NOT NULL DEFAULT '',
    avatar        TEXT,                 -- filename of display picture in uploads/
    updated_at    INTEGER NOT NULL
  );

  -- Gallery photos belonging to a profile.
  CREATE TABLE IF NOT EXISTS gallery_photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,           -- filename in uploads/
    created_at INTEGER NOT NULL
  );

  -- Text chat history. NOTE: shared FILES are never stored here — they are
  -- relayed live over the socket and discarded. Only text messages persist.
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair
    ON messages (sender_id, recipient_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_gallery_user
    ON gallery_photos (user_id, created_at);

  -- Pending signups awaiting email OTP verification. A user row is only
  -- created once the correct code is entered. One pending row per email.
  CREATE TABLE IF NOT EXISTS email_otps (
    email         TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    code_hash     TEXT NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    expires_at    INTEGER NOT NULL,
    created_at    INTEGER NOT NULL
  );

  -- Single admin account (id is always 1). password_hash is null until the
  -- admin sets it via an emailed link.
  CREATE TABLE IF NOT EXISTS admin_account (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    email         TEXT NOT NULL,
    password_hash TEXT,
    updated_at    INTEGER
  );

  -- Admin password set/reset links. Only one is valid at a time: every new
  -- request clears the table first, so the previous link stops working.
  CREATE TABLE IF NOT EXISTS admin_reset_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

// --- Migration: make users.email nullable (admin can create users with no
// email). Older databases created the column as NOT NULL; rebuild the table
// if so. NULL emails are allowed to repeat under a UNIQUE index in SQLite.
(function migrateEmailNullable() {
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const emailCol = cols.find((c) => c.name === 'email');
  if (!emailCol || emailCol.notnull === 0) return; // already nullable

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        email         TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );
      INSERT INTO users_new (id, username, email, password_hash, created_at)
        SELECT id, username, email, password_hash, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.exec('PRAGMA foreign_keys = ON;');
})();

// Seed the single admin row (email from config). Never overwrites an existing
// password; updates the target email if it changed in config.
(function seedAdmin() {
  const row = db.prepare('SELECT id, email FROM admin_account WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO admin_account (id, email, password_hash, updated_at) VALUES (1, ?, NULL, ?)')
      .run(config.adminEmail, Date.now());
  } else if (row.email !== config.adminEmail) {
    db.prepare('UPDATE admin_account SET email = ? WHERE id = 1').run(config.adminEmail);
  }
})();

module.exports = db;
