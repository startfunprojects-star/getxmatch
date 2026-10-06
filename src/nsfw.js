'use strict';

// NSFW image filter. Every image a member uploads is classified by NSFWJS
// (MobileNetV2, run locally — no image ever leaves the server) and rejected if
// it looks pornographic or sexually explicit. For animated GIF / WEBP several
// frames are checked and the worst one counts.
//
// The model runs in a worker thread (src/nsfwWorker.js), started with the
// server. If the model can't be loaded the filter fails OPEN (uploads are
// allowed and the error is logged) so a broken install doesn't take uploads
// down; set NSFW_FILTER=false to turn the filter off entirely.
//
// Thresholds (0-1, env-tunable):
//   NSFW_THRESHOLD       Porn or Hentai probability at/above which to block (0.5)
//   NSFW_SEXY_THRESHOLD  "Sexy" (suggestive) probability to block (0.8)

const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const ENABLED = process.env.NSFW_FILTER !== 'false';
const num = (v, d) => { const n = parseFloat(v); return n > 0 && n <= 1 ? n : d; };
const EXPLICIT = num(process.env.NSFW_THRESHOLD, 0.5);
const SUGGESTIVE = num(process.env.NSFW_SEXY_THRESHOLD, 0.8);
const TIMEOUT_MS = 60 * 1000;

let worker = null;
let available = false;
let nextId = 1;
const pending = new Map();

function start() {
  if (!ENABLED || worker) return;
  worker = new Worker(path.join(__dirname, 'nsfwWorker.js'));
  worker.unref();
  worker.on('message', (m) => {
    if (m.ready) { available = true; console.log('[nsfw] image filter ready'); return; }
    if (m.fatal) { console.error('[nsfw] model failed to load — uploads are NOT being filtered:', m.fatal); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error)); else p.resolve(m.frames);
  });
  worker.on('error', (err) => {
    console.error('[nsfw] worker crashed — uploads are NOT being filtered:', err);
    available = false;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  });
}

function classify(file) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timed out')); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, file });
  });
}

function isNsfw(scores) {
  return (scores.Porn || 0) >= EXPLICIT
    || (scores.Hentai || 0) >= EXPLICIT
    || (scores.Sexy || 0) >= SUGGESTIVE;
}

// Resolves { blocked, unreadable } for an image file on disk.
async function checkImage(file) {
  if (!ENABLED || !available) return { blocked: false };
  let frames;
  try {
    frames = await classify(file);
  } catch (err) {
    // sharp couldn't decode it: not a real image, so don't keep it either.
    if (/unsupported image format|Input file|corrupt|premature end/i.test(err.message)) return { blocked: true, unreadable: true };
    console.error('[nsfw] could not check', path.basename(file), '— allowed:', err.message);
    return { blocked: false };
  }
  return { blocked: frames.some(isNsfw) };
}

// Express middleware: put it right after multer's imageUpload.single(...).
// Deletes and rejects a flagged upload; requests without a file pass through.
function nsfwGuard(req, res, next) {
  if (!req.file) return next();
  checkImage(req.file.path).then(({ blocked, unreadable }) => {
    if (!blocked) return next();
    fs.unlink(req.file.path, () => {});
    res.status(400).json({
      error: unreadable
        ? 'That file could not be read as an image.'
        : 'This image looks like it contains nudity or sexual content, which isn’t allowed on getxmatch.',
    });
  }, next);
}

module.exports = { start, checkImage, nsfwGuard };
