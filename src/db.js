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
`);

module.exports = db;
