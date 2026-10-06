'use strict';

// NSFW filter for images and videos. Everything a member uploads or sends in
// chat is classified by NSFWJS (MobileNetV2, run locally — nothing is sent to
// an outside service) and rejected if it looks pornographic or sexually
// explicit:
//   - images: animated GIF / WEBP are checked on several frames;
//   - videos: VIDEO_FRAMES frames spread across the clip are pulled out with
//     ffmpeg (the ffmpeg-static binary, or FFMPEG_PATH) and checked.
// The worst frame decides.
//
// The model runs in a worker thread (src/nsfwWorker.js), started with the
// server. If the model or ffmpeg is unavailable the filter fails OPEN (the
// upload is allowed and the error is logged) so a broken install doesn't take
// uploads down; set NSFW_FILTER=false to turn the filter off entirely.
//
// Thresholds (0-1, env-tunable):
//   NSFW_THRESHOLD       Porn or Hentai probability at/above which to block (0.5)
//   NSFW_SEXY_THRESHOLD  "Sexy" (suggestive) probability to block (0.8)

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const { videoDuration } = require('./videoDuration');

const ENABLED = process.env.NSFW_FILTER !== 'false';
const num = (v, d) => { const n = parseFloat(v); return n > 0 && n <= 1 ? n : d; };
const EXPLICIT = num(process.env.NSFW_THRESHOLD, 0.5);
const SUGGESTIVE = num(process.env.NSFW_SEXY_THRESHOLD, 0.8);
const TIMEOUT_MS = 60 * 1000;
const SIZE = 224;          // model input (must match src/nsfwWorker.js)
const VIDEO_FRAMES = 8;

const FFMPEG = process.env.FFMPEG_PATH || (() => {
  try { return require('ffmpeg-static'); } catch (_e) { return null; }
})();

let worker = null;
let available = false;
let nextId = 1;
const pending = new Map();

function start() {
  if (!ENABLED || worker) return;
  worker = new Worker(path.join(__dirname, 'nsfwWorker.js'));
  worker.unref();
  worker.on('message', (m) => {
    if (m.ready) { available = true; console.log(`[nsfw] filter ready (${m.backend} backend)`); return; }
    if (m.fatal) { console.error('[nsfw] model failed to load — uploads are NOT being filtered:', m.fatal); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(new Error(m.error), { decode: m.decode })); else p.resolve(m.frames);
  });
  worker.on('error', (err) => {
    console.error('[nsfw] worker crashed — uploads are NOT being filtered:', err);
    available = false;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
    pending.clear();
  });
  if (!FFMPEG) console.error('[nsfw] ffmpeg not found — videos are NOT being filtered');
}

// Resolves once the model has loaded (or failed to), for one-off scripts.
function ready() {
  start();
  return new Promise((resolve) => {
    const tick = () => (available || !worker ? resolve(available) : setTimeout(tick, 200));
    worker.once('error', () => resolve(false));
    tick();
  });
}

function ask(msg) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timed out')); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, ...msg });
  });
}

function isNsfw(scores) {
  return (scores.Porn || 0) >= EXPLICIT
    || (scores.Hentai || 0) >= EXPLICIT
    || (scores.Sexy || 0) >= SUGGESTIVE;
}

// Image file path or Buffer → { blocked, unreadable }.
async function checkImage(input) {
  if (!ENABLED || !available) return { blocked: false };
  try {
    return { blocked: (await ask({ input })).some(isNsfw) };
  } catch (err) {
    // Not a real image, so don't keep it either.
    if (err.decode) return { blocked: true, unreadable: true };
    console.error('[nsfw] could not check image — allowed:', err.message);
    return { blocked: false };
  }
}

// Pull VIDEO_FRAMES evenly spaced frames out of a video file, scaled to the
// model's input size, as raw RGB buffers.
function videoFrames(file) {
  return new Promise((resolve, reject) => {
    const duration = videoDuration(file);
    const rate = duration ? Math.max(VIDEO_FRAMES / duration, 0.01) : 1;
    const ff = spawn(FFMPEG, [
      '-v', 'error', '-i', file, '-an',
      '-vf', `fps=${rate.toFixed(4)},scale=${SIZE}:${SIZE}`,
      '-frames:v', String(VIDEO_FRAMES),
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out = [];
    let err = '';
    const timer = setTimeout(() => ff.kill('SIGKILL'), TIMEOUT_MS);
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', (e) => { clearTimeout(timer); reject(e); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      const all = Buffer.concat(out);
      const frameBytes = SIZE * SIZE * 3;
      const frames = [];
      for (let o = 0; o + frameBytes <= all.length; o += frameBytes) frames.push(all.subarray(o, o + frameBytes));
      if (frames.length) return resolve(frames);
      reject(Object.assign(new Error(err.trim() || `ffmpeg exited with ${code}`), { noFrames: true }));
    });
  });
}

// Video file path → { blocked, unreadable }.
async function checkVideo(file) {
  if (!ENABLED || !available || !FFMPEG) return { blocked: false };
  let frames;
  try {
    frames = await videoFrames(file);
  } catch (err) {
    if (err.noFrames) return { blocked: true, unreadable: true };
    console.error('[nsfw] could not check video — allowed:', err.message);
    return { blocked: false };
  }
  try {
    return { blocked: (await ask({ frames })).some(isNsfw) };
  } catch (err) {
    console.error('[nsfw] could not check video — allowed:', err.message);
    return { blocked: false };
  }
}

// Video bytes (a chat file) → { blocked, unreadable }. ffmpeg has to seek in
// MP4/MOV, so the bytes go to a private temp file for the check and are
// deleted straight after. On Linux that file is in /dev/shm (RAM), so chat
// files still never touch the disk.
const SCRATCH = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir();

async function checkVideoBuffer(buf) {
  if (!ENABLED || !available || !FFMPEG) return { blocked: false };
  const tmp = path.join(SCRATCH, 'gxm-' + crypto.randomBytes(12).toString('hex'));
  try {
    await fs.promises.writeFile(tmp, buf, { mode: 0o600 });
    return await checkVideo(tmp);
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// What a buffer really is, from its first bytes (the client's mime type isn't
// trusted): 'image', 'video' or null.
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  const hex = buf.subarray(0, 4).toString('hex');
  const head = buf.subarray(0, 12).toString('latin1');
  if (hex.startsWith('ffd8ff') || hex === '89504e47' || head.startsWith('GIF8')
    || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')
    || /^\s*<(\?xml|svg)/i.test(buf.subarray(0, 64).toString('latin1'))) return 'image';
  if (head.slice(4, 8) === 'ftyp') {
    // HEIC / AVIF photos are ISO-BMFF too; sharp reads those as images.
    return /^(heic|heix|hevc|mif1|msf1|avif)$/.test(head.slice(8, 12)) ? 'image' : 'video';
  }
  if (hex === '1a45dfa3' || (head.startsWith('RIFF') && head.slice(8, 11) === 'AVI')) return 'video';
  return null;
}

// Any chat file (Buffer): images and videos are checked, other files pass.
function checkBuffer(buf) {
  const kind = sniff(buf);
  if (kind === 'image') return checkImage(buf);
  if (kind === 'video') return checkVideoBuffer(buf);
  return Promise.resolve({ blocked: false });
}

function rejectionMessage({ unreadable }, what) {
  return unreadable
    ? `That file could not be read as ${what}.`
    : 'This looks like it contains nudity or sexual content, which isn’t allowed on getxmatch.';
}

// Express middleware: put it right after multer's .single(...). Deletes and
// rejects a flagged upload; requests without a file pass through.
function guard(check, what) {
  return (req, res, next) => {
    if (!req.file) return next();
    check(req.file.path).then((result) => {
      if (!result.blocked) return next();
      fs.unlink(req.file.path, () => {});
      res.status(400).json({ error: rejectionMessage(result, what) });
    }, next);
  };
}

const nsfwGuard = guard(checkImage, 'an image');
const nsfwVideoGuard = guard(checkVideo, 'a video');

module.exports = {
  start, ready, checkImage, checkVideo, checkBuffer, rejectionMessage,
  nsfwGuard, nsfwVideoGuard,
};
