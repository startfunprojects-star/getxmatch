'use strict';

// Worker thread for src/nsfw.js: loads the NSFWJS model once, then classifies
// images and video frames on request. Runs off the main thread so inference
// (~50 ms per image) never stalls HTTP or Socket.IO.
//
// in:  { id, input }   an image file path, or the image bytes (Uint8Array)
//      { id, frames }  raw RGB video frames, each SIZE × SIZE × 3 bytes
// out: { id, frames: [{ Drawing, Hentai, Neutral, Porn, Sexy }, …] } or
//      { id, error, decode }  (decode: the image couldn't be decoded)

const { parentPort } = require('worker_threads');
const tf = require('@tensorflow/tfjs');
const nsfwjs = require('nsfwjs');
const sharp = require('sharp');

const SIZE = 224;       // MobileNetV2 input size
const MAX_FRAMES = 4;   // frames sampled from an animated GIF / WEBP

// The model's informational console messages are noise in the server log.
const quiet = (fn) => async (...a) => {
  const { log, warn, info } = console;
  console.log = console.warn = console.info = () => {};
  try { return await fn(...a); } finally { Object.assign(console, { log, warn, info }); }
};

// The WebAssembly backend is ~15× faster than plain JS (about 50 ms per image)
// and needs no native build; fall back to plain JS if it can't start.
async function useFastestBackend() {
  try {
    require('@tensorflow/tfjs-backend-wasm');
    if (await tf.setBackend('wasm')) return;
  } catch (_e) { /* fall through */ }
  await tf.setBackend('cpu');
}

const modelReady = quiet(async () => {
  await useFastestBackend();
  return nsfwjs.load('MobileNetV2');
})();

async function classifyRgb(model, rgb) {
  const input = tf.tensor3d(rgb, [SIZE, SIZE, 3], 'int32');
  try {
    const preds = await model.classify(input, 5);
    return Object.fromEntries(preds.map((p) => [p.className, p.probability]));
  } finally {
    input.dispose();
  }
}

async function imageFrame(src, page) {
  const data = await sharp(src, { page, animated: false })
    .flatten({ background: '#ffffff' })
    .resize(SIZE, SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  return new Uint8Array(data);
}

// A sharp failure means the input isn't a decodable image.
const decoding = (p) => p.catch((err) => { throw Object.assign(err, { decode: true }); });

async function classifyImage(src) {
  const model = await modelReady;
  const { pages = 1 } = await decoding(sharp(src).metadata());
  const n = Math.min(pages, MAX_FRAMES);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await classifyRgb(model, await decoding(imageFrame(src, Math.floor((i * pages) / n)))));
  }
  return out;
}

async function classifyFrames(frames) {
  const model = await modelReady;
  const out = [];
  for (const f of frames) out.push(await classifyRgb(model, new Uint8Array(f)));
  return out;
}

// One request at a time (keeps the worker's memory flat); requests queue up
// behind each other.
let chain = Promise.resolve();
parentPort.on('message', ({ id, input, frames }) => {
  const job = frames
    ? () => classifyFrames(frames)
    : () => classifyImage(typeof input === 'string' ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  chain = chain.then(job).then(
    (result) => parentPort.postMessage({ id, frames: result }),
    (err) => parentPort.postMessage({ id, error: String((err && err.message) || err), decode: !!(err && err.decode) })
  );
});

modelReady.then(
  () => parentPort.postMessage({ ready: true, backend: tf.getBackend() }),
  (err) => parentPort.postMessage({ fatal: String((err && err.message) || err) })
);
