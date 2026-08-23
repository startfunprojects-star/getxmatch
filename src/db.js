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
    ['weight', 'REAL'], // body weight in kg — drives the "Wasted" score increment

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

// --- Migration: disappearing messages. When a conversation has disappearing
// mode on, each new message is stamped with expires_at (epoch ms). A background
// sweeper in src/socket.js deletes expired rows and tells both clients to drop
// the bubbles. NULL means the message never auto-expires.
(function migrateMessageExpiresAt() {
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('expires_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN expires_at INTEGER;');
  }
})();
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages (expires_at);');

// --- Per-conversation "disappearing messages" setting. One row per user pair
// (stored normalized as user_lo < user_hi). ttl_seconds is how long a message
// lives before it self-destructs; 0 / no row means disappearing is off. Either
// participant can turn it on or off for the pair. set_by records who last
// changed it so the other side can be told who armed/disarmed it.
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_settings (
    user_lo     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_hi     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ttl_seconds INTEGER NOT NULL DEFAULT 0,
    set_by      INTEGER,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_lo, user_hi)
  );
`);

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

// --- Profile picture buffer: a pool of up to 10 images per user, separate from
// the single display picture (profiles.avatar) and the photo gallery. In chat,
// the picture shown for a user is drawn at random from this buffer and rotates
// every 20s (see public/js/app.js). Max is enforced at write time.
db.exec(`
  CREATE TABLE IF NOT EXISTS profile_buffer_photos (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename   TEXT NOT NULL,           -- filename in uploads/
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_buffer_user ON profile_buffer_photos (user_id, created_at);
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

  -- Compatibility matches: one row per shared quiz link. The initiator (A)
  -- answers first, gets a token/link valid for one hour, and shares it. The
  -- responder (B) opens the link and answers; the score is how many answers
  -- the two picked in common. B may be anonymous (no account), so b_user_id
  -- is nullable.
  CREATE TABLE IF NOT EXISTS quiz_matches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    token        TEXT NOT NULL UNIQUE,
    quiz_id      INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    a_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    a_name       TEXT NOT NULL,
    a_answers    TEXT NOT NULL,            -- JSON: [optionIndex, ...]
    b_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    b_name       TEXT,
    b_answers    TEXT,                     -- JSON, null until B answers
    score        INTEGER,                  -- matching answers, null until done
    total        INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_matches_token ON quiz_matches (token);

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

// Admin-authored "fake" activity used to make the recent-activity feed feel
// busy. Each row is a triple: person A, an activity, person B. The feed
// recombines these names/activities at random and mixes them with real
// activity. Names here are plain strings — never linked to real accounts.
db.exec(`
  CREATE TABLE IF NOT EXISTS fake_activities (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    person_a   TEXT NOT NULL,   -- female name (column 1)
    activity   TEXT NOT NULL,
    person_b   TEXT NOT NULL,   -- male name (column 3)
    created_at INTEGER NOT NULL
  );

  -- Simple key/value store for global app settings (e.g. fake-activity on/off).
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- What a user says they're doing with a chat partner (an activity verb drawn
  -- from the admin's fake-activity list, e.g. "flirting with"). Shown at the top
  -- of that chat and, using the two real names, on the Recent Activity feed.
  CREATE TABLE IF NOT EXISTS chat_activities (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity   TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, peer_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_activities_recent ON chat_activities (updated_at);

  -- Image/GIF a user shares onto the Recent Activity feed (shown as a thumbnail).
  CREATE TABLE IF NOT EXISTS activity_posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    image      TEXT NOT NULL,          -- filename in uploads/
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_posts_recent ON activity_posts (created_at);

  -- Continuous server-generated activity stream (the "recent activity" ticker).
  -- Generated on the server on a timer so it runs even with nobody online and
  -- every user sees the SAME rows. Kept as a rolling window (old rows pruned).
  CREATE TABLE IF NOT EXISTS activity_stream (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    icon       TEXT NOT NULL DEFAULT '✨',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_activity_stream_recent ON activity_stream (created_at);

  -- Group chats: up to 4 members, joined by invitation/acceptance.
  CREATE TABLE IF NOT EXISTS chat_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  -- One row per (group, user). status: 'invited' (pending) | 'joined'.
  CREATE TABLE IF NOT EXISTS chat_group_members (
    group_id   INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'invited',
    invited_by INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_group_members_user ON chat_group_members (user_id, status);

  -- Group chat messages (text only). Delivered live and kept as history.
  CREATE TABLE IF NOT EXISTS group_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id   INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
    sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages (group_id, created_at);
`);

// On-page SEO metadata for content tables. Stored as a single JSON blob so the
// field set can grow without further migrations. Added idempotently for
// databases created before the SEO feature.
for (const t of ['quizzes', 'polls', 'blogs']) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols.includes('seo')) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN seo TEXT NOT NULL DEFAULT '{}'`);
  }
}

// Advertisements + click tracking. Ads are placed by the admin into named
// slots (header/footer/sidebars/inline on content pages, and inline in chat &
// the live-activity feed). An ad is either an uploaded image (with a click-
// through link) or a raw HTML/script snippet from an ad network. Every click on
// an image ad is logged so the admin can see clicks per placement over time.
db.exec(`
  CREATE TABLE IF NOT EXISTS ads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'image',   -- 'image' | 'script'
    placement  TEXT NOT NULL,                    -- slot key (see src/ads.js)
    image      TEXT,                             -- filename in uploads/ (image ads)
    link       TEXT,                             -- click-through URL (image ads)
    script     TEXT,                             -- raw HTML/JS snippet (script ads)
    width      INTEGER,                          -- optional px hint (script ads)
    height     INTEGER,                          -- optional px hint (script ads)
    active     INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ads_placement ON ads (placement, active);

  CREATE TABLE IF NOT EXISTS ad_clicks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ad_id      INTEGER NOT NULL REFERENCES ads(id) ON DELETE CASCADE,
    placement  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ad_clicks_recent ON ad_clicks (created_at);
  CREATE INDEX IF NOT EXISTS idx_ad_clicks_ad ON ad_clicks (ad_id);
  CREATE INDEX IF NOT EXISTS idx_ad_clicks_placement ON ad_clicks (placement, created_at);
`);

// "Highway" — a shared public pool where any registered user can post text,
// an image, and/or links (YouTube/Instagram/Facebook/etc). The pool is capped
// at the newest 100 posts: older posts (and their images) are pruned when new
// ones arrive (see src/routes/highway.js).
db.exec(`
  CREATE TABLE IF NOT EXISTS highway_posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body       TEXT NOT NULL DEFAULT '',
    image      TEXT,                     -- optional filename in uploads/
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_highway_recent ON highway_posts (created_at);
`);

// Admin pinning for Highway: a pinned post is exempt from the 100-post prune and
// is shown ahead of the rest, ordered by pin_rank (1..10). Added idempotently.
{
  const cols = db.prepare('PRAGMA table_info(highway_posts)').all().map((c) => c.name);
  if (!cols.includes('pinned')) db.exec('ALTER TABLE highway_posts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('pin_rank')) db.exec('ALTER TABLE highway_posts ADD COLUMN pin_rank INTEGER');
}

// Relationship kind on a friendship request (friend / girlfriend / crush / …).
// Added idempotently for databases created before the relationship-request feature.
{
  const cols = db.prepare('PRAGMA table_info(friendships)').all().map((c) => c.name);
  if (!cols.includes('rel_type')) {
    db.exec("ALTER TABLE friendships ADD COLUMN rel_type TEXT NOT NULL DEFAULT 'friend'");
  }
}

// Heal any user that has no profile row — e.g. accounts admin-created before a
// profile was made mandatory. Without a profile they vanish from the people
// list and leaderboard (both inner-join profiles) and render as a "user<id>"
// fallback in chats. Give them a minimal profile named after their username.
(function backfillMissingProfiles() {
  const orphans = db
    .prepare('SELECT u.id, u.username FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE p.user_id IS NULL')
    .all();
  if (!orphans.length) return;
  const now = Date.now();
  const insert = db.prepare(
    "INSERT INTO profiles (user_id, display_name, bio, avatar, updated_at) VALUES (?, ?, '', NULL, ?)"
  );
  for (const r of orphans) insert.run(r.id, String(r.username).slice(0, 50), now);
})();

// Presence + digest bookkeeping on users, for the daily "offline activity"
// email. last_seen_at = when the user last went fully offline (messages after
// it are unseen); last_digest_at = the cut-off up to which they've been emailed.
// Existing users are backfilled to "now" so the first run never dumps a backlog.
{
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('last_seen_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_seen_at INTEGER');
  }
  if (!cols.includes('last_digest_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_digest_at INTEGER NOT NULL DEFAULT 0');
    db.prepare('UPDATE users SET last_digest_at = ?').run(Date.now());
  }
  // "Wasted" score bookkeeping. wasted_score is the current intoxication level
  // (0..15); it climbs when a user consumes a drink/substance and decays over
  // time (they sober up). wasted_updated_at is when it was last changed, so the
  // decay can be computed lazily on read (see src/wasted.js).
  if (!cols.includes('wasted_score')) {
    db.exec('ALTER TABLE users ADD COLUMN wasted_score REAL NOT NULL DEFAULT 0');
  }
  if (!cols.includes('wasted_updated_at')) {
    db.exec('ALTER TABLE users ADD COLUMN wasted_updated_at INTEGER NOT NULL DEFAULT 0');
  }
}

// --- "Wasted" feature admin content.
// wasted_words: a pool of words the system randomly splices into the messages of
// tipsy users (the drunker they are, the more often). wasted_sentences: whole
// lines that randomly appear as permanent system messages inside a chat.
db.exec(`
  CREATE TABLE IF NOT EXISTS wasted_words (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    word       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS wasted_sentences (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sentence   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Per-conversation intoxication score. Directional: user_id's "wasted" level
  -- in their chat with peer_id (so the same person can be sober in one chat and
  -- hammered in another). Resets to 0 after 15 minutes (see src/wasted.js) and
  -- is wiped for a user when they log in again.
  CREATE TABLE IF NOT EXISTS wasted_scores (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score      REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, peer_id)
  );
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
