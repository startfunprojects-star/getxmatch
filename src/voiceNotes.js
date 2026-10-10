'use strict';

// Voice notes for 1:1 and group chats.
//
// An earlier version stored browser recordings as base64 inside the message and
// played them back as-is; playback broke across browsers (Chrome records
// WebM/Opus, which Safari/iOS won't reliably play, and vice versa). So now
// every recording — whatever the browser produced — is converted on the server
// with ffmpeg into one format every browser and phone plays: AAC in an .m4a,
// mono, 64 kbps, with low rumble cut and the loudness evened out so quiet and
// loud mics sound alike. The file is kept on disk (not in the message) and only
// streamed to the people in that conversation (GET /api/voice/:id).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const db = require('./db');
const config = require('./config');

const FFMPEG = process.env.FFMPEG_PATH || (() => {
  try { return require('ffmpeg-static'); } catch (_e) { return null; }
})();

const MAX_SECONDS = 300;   // 5 minutes per note
const MIN_SECONDS = 0.5;
// Kept in the private data folder (not the public uploads/), so the only way to
// hear a note is the permission-checked GET /api/voice/:id.
const VOICE_DIR = path.join(config.dataDir, 'voice');
fs.mkdirSync(VOICE_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS voice_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    file       TEXT NOT NULL,             -- in data/voice/
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dm_a       INTEGER,                   -- 1:1: lower user id
    dm_b       INTEGER,                   -- 1:1: higher user id
    group_id   INTEGER,                   -- group chat
    duration   REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_voice_notes_group ON voice_notes (group_id);
`);

function available() { return !!FFMPEG; }

// Convert any browser recording to a clean, loudness-levelled AAC .m4a.
// Resolves { file, duration } (file = name inside VOICE_DIR).
function transcode(inPath) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('Voice notes are not available on this server.'));
    const file = crypto.randomBytes(16).toString('hex') + '.m4a';
    const out = path.join(VOICE_DIR, file);
    const ff = spawn(FFMPEG, [
      '-hide_banner', '-nostdin', '-y',
      '-i', inPath,
      '-t', String(MAX_SECONDS),
      '-vn', '-ac', '1',
      '-af', 'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11',
      '-ar', '48000',
      '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart',
      out,
    ]);
    let err = '';
    ff.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    const timer = setTimeout(() => ff.kill('SIGKILL'), 60000);
    ff.on('error', (e) => { clearTimeout(timer); reject(e); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        fs.unlink(out, () => {});
        return reject(new Error('That recording could not be processed.'));
      }
      // Duration = the last "time=hh:mm:ss.xx" progress stamp ffmpeg printed.
      const stamps = [...err.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const last = stamps[stamps.length - 1];
      const duration = last ? (+last[1]) * 3600 + (+last[2]) * 60 + (+last[3]) : 0;
      resolve({ file, duration });
    });
  });
}

// Record a converted note. `where` is { to } (1:1, with `from`) or { groupId }.
function saveNote({ file, duration, ownerId, to, groupId }) {
  const lo = to ? Math.min(ownerId, to) : null;
  const hi = to ? Math.max(ownerId, to) : null;
  const info = db
    .prepare('INSERT INTO voice_notes (file, owner_id, dm_a, dm_b, group_id, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(file, ownerId, lo, hi, groupId || null, duration, Date.now());
  return info.lastInsertRowid;
}

// May `userId` listen to note `id`? Returns the row, or null.
function noteFor(id, userId) {
  const row = db.prepare('SELECT * FROM voice_notes WHERE id = ?').get(id);
  if (!row) return null;
  if (row.group_id) {
    const member = db
      .prepare("SELECT 1 FROM chat_group_members WHERE group_id = ? AND user_id = ? AND status = 'joined'")
      .get(row.group_id, userId);
    return member ? row : null;
  }
  return userId === row.dm_a || userId === row.dm_b ? row : null;
}

function filePath(row) {
  return path.join(VOICE_DIR, path.basename(row.file));
}

// A group was deleted: remove its notes and their files.
function removeForGroup(groupId) {
  const rows = db.prepare('SELECT id, file FROM voice_notes WHERE group_id = ?').all(groupId);
  rows.forEach((r) => fs.unlink(path.join(VOICE_DIR, path.basename(r.file)), () => {}));
  db.prepare('DELETE FROM voice_notes WHERE group_id = ?').run(groupId);
}

// The message body that carries a note: {"voiceId":N,"dur":12.3}.
function bodyFor(id, duration) {
  return JSON.stringify({ voiceId: id, dur: Math.round(duration * 10) / 10 });
}

// Label used in reply quotes, e.g. "🎤 Voice note (0:12)".
function label(body) {
  try {
    const b = JSON.parse(body);
    if (b && b.dur) {
      const s = Math.round(b.dur);
      return `🎤 Voice note (${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')})`;
    }
  } catch (_e) { /* legacy note */ }
  return '🎤 Voice note';
}

module.exports = {
  MAX_SECONDS, MIN_SECONDS, available, transcode, saveNote, noteFor, filePath, removeForGroup, bodyFor, label,
};
