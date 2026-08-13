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

  -- One profile per user. Created after signup. The extended fields below are
  -- added by migration for older databases; see migrateProfileColumns().
  CREATE TABLE IF NOT EXISTS profiles (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name  TEXT NOT NULL,
    bio           TEXT NOT NULL DEFAULT '',   -- "About me"
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

  -- Star ratings other users leave on a profile (1-5). One row per rater/ratee
  -- pair; a re-rate updates the existing row.
  CREATE TABLE IF NOT EXISTS ratings (
    rater_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ratee_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (rater_id, ratee_id)
  );

  -- Public comments left by other users on a profile.
  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comments_subject
    ON comments (subject_id, created_at);

  -- Friend relationships. A row is created (status 'pending') when one user
  -- sends a request and flips to 'accepted' when the other accepts. The pair
  -- is stored in request direction: requester_id asked addressee_id.
  CREATE TABLE IF NOT EXISTS friendships (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted'
    created_at   INTEGER NOT NULL,
    UNIQUE (requester_id, addressee_id)
  );
  CREATE INDEX IF NOT EXISTS idx_friendships_addressee
    ON friendships (addressee_id, status);

  -- Blocks. blocker_id has blocked blocked_id. A block is directional in
  -- storage but communication is cut both ways: either party blocking the
  -- other prevents friend requests, chat messages, files and gifts between
  -- them (see areBlocked() in src/relations.js).
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks (blocked_id);

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

// --- Migration: add the extended profile fields as nullable columns. Older
// databases (and the original schema above) only had display_name/bio/avatar.
// New columns are added idempotently so existing profile rows are preserved;
// gender/date_of_birth/country are enforced as required at write time by the
// profile route, not by the DB.
(function migrateProfileColumns() {
  const cols = db.prepare('PRAGMA table_info(profiles)').all().map((c) => c.name);
  const additions = [
    ['gender', 'TEXT'],
    ['date_of_birth', 'TEXT'],
    ['country', 'TEXT'],
    ['smokes', 'TEXT'],
    ['drinks', 'TEXT'],
    ['diet', 'TEXT'],
    ['sexuality', 'TEXT'],
    ['interests', "TEXT NOT NULL DEFAULT '[]'"],
    ['persona', "TEXT NOT NULL DEFAULT ''"],
    ['likes_in_bed', "TEXT NOT NULL DEFAULT ''"],
    ['bed_role', 'TEXT'],
    ['relationship_status', 'TEXT'],
    ['partner_user_id', 'INTEGER'],
    ['friends_visibility', "TEXT NOT NULL DEFAULT 'public'"],
  ];
  for (const [name, type] of additions) {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE profiles ADD COLUMN ${name} ${type};`);
    }
  }
})();

// --- Migration: tag each chat message with a `kind` so gift messages can be
// distinguished from plain text. Older rows default to 'text'. For gifts the
// body holds the gift id (see src/gifts.js).
(function migrateMessageKind() {
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('kind')) {
    db.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';");
  }
})();

// --- Migration: allow a message to quote/reply to an earlier one. reply_to
// holds the id of the message being replied to (NULL for normal messages).
(function migrateMessageReplyTo() {
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('reply_to')) {
    db.exec('ALTER TABLE messages ADD COLUMN reply_to INTEGER;');
  }
})();

// --- Emoji reactions on chat messages (text / gift / voice note). One row per
// (message, user): a user has at most one reaction per message; picking a new
// emoji replaces it, picking the same one again clears it.
db.exec(`
  CREATE TABLE IF NOT EXISTS message_reactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    UNIQUE (message_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions (message_id);
`);

// --- Content & engagement features: quizzes, polls, blogs, profile
// and admin-authored events. Created idempotently so existing
// databases pick them up on next boot.
db.exec(`
  /* ---------------- Quizzes ---------------- */
  CREATE TABLE IF NOT EXISTS quizzes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    questions   TEXT NOT NULL DEFAULT '[]', -- JSON: [{prompt, options:[..], answer:index}]
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- One row per user per quiz attempt (history is kept for the events feed).
  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id    INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score      INTEGER NOT NULL,
    total      INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_attempts_recent
    ON quiz_attempts (created_at);

  /* ---------------- Polls ---------------- */
  CREATE TABLE IF NOT EXISTS polls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    question   TEXT NOT NULL,
    options    TEXT NOT NULL DEFAULT '[]', -- JSON: ["Option A", "Option B", ...]
    closed     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- One vote per user per poll; re-voting updates the choice.
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id      INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    option_index INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (poll_id, user_id)
  );

  /* ---------------- Blogs ---------------- */
  CREATE TABLE IF NOT EXISTS blogs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT 'getxmatch',
    excerpt    TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    cover      TEXT,                        -- optional filename in uploads/
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_blogs_recent ON blogs (created_at);

  /* ---------------- Admin-authored events ----------------
     Curated announcements the admin pins to the Recent Events feed alongside
     the automatically-aggregated activity. */
  CREATE TABLE IF NOT EXISTS admin_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  /* ---------------- Roleplay stories ----------------
     Admin-authored interactive stories two users play out in chat. A roleplay
     has an ordered list of stages, each with a narration and an optional
     image/gif. required_messages is how many messages EACH user must send in a
     stage before the next stage's narration is revealed. */
  CREATE TABLE IF NOT EXISTS roleplays (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    title             TEXT NOT NULL,
    description       TEXT NOT NULL DEFAULT '',
    cover             TEXT,                      -- optional filename in uploads/
    required_messages INTEGER NOT NULL DEFAULT 10,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS roleplay_stages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    roleplay_id INTEGER NOT NULL REFERENCES roleplays(id) ON DELETE CASCADE,
    stage_index INTEGER NOT NULL,                -- 0-based order
    narration   TEXT NOT NULL DEFAULT '',
    image       TEXT,                            -- optional filename in uploads/
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_roleplay_stages
    ON roleplay_stages (roleplay_id, stage_index);

  -- One active playthrough per pair of users. The pair is stored normalized
  -- (user_lo < user_hi); count_lo/count_hi track messages each has sent in the
  -- current stage and reset to 0 when the stage advances.
  CREATE TABLE IF NOT EXISTS roleplay_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    roleplay_id   INTEGER NOT NULL REFERENCES roleplays(id) ON DELETE CASCADE,
    user_lo       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_hi       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_stage INTEGER NOT NULL DEFAULT 0,
    count_lo      INTEGER NOT NULL DEFAULT 0,
    count_hi      INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active', -- 'active' | 'completed'
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_roleplay_sessions_pair
    ON roleplay_sessions (user_lo, user_hi, status);
`);

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
