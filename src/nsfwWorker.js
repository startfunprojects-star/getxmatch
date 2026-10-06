'use strict';

// Worker thread for src/nsfw.js: loads the NSFWJS model once, then classifies
// image files on request. Runs off the main thread so inference (pure-JS
// TensorFlow, a few hundred ms per image) never stalls HTTP or Socket.IO.
//
// in:  { id, file }
// out: { id, frames: [{ Drawing, Hentai, Neutral, Porn, Sexy }, …] } or { id, error }

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

const modelReady = quiet(() => nsfwjs.load('MobileNetV2'))();

async function classifyFrame(model, file, page) {
  const { data, info } = await sharp(file, { page, animated: false })
    .flatten({ background: '#ffffff' })
    .resize(SIZE, SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const input = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
  try {
    const preds = await model.classify(input, 5);
    return Object.fromEntries(preds.map((p) => [p.className, p.probability]));
  } finally {
    input.dispose();
  }
}

async function classify(file) {
  const model = await modelReady;
  const { pages = 1 } = await sharp(file).metadata();
  const n = Math.min(pages, MAX_FRAMES);
  const frames = [];
  for (let i = 0; i < n; i++) {
    frames.push(await classifyFrame(model, file, Math.floor((i * pages) / n)));
  }
  return frames;
}

// One image at a time (the model isn't re-entrant-friendly and this keeps the
// worker's memory flat); requests queue up behind each other.
let chain = Promise.resolve();
parentPort.on('message', ({ id, file }) => {
  chain = chain.then(() => classify(file)).then(
    (frames) => parentPort.postMessage({ id, frames }),
    (err) => parentPort.postMessage({ id, error: String((err && err.message) || err) })
  );
});

modelReady.then(
  () => parentPort.postMessage({ ready: true }),
  (err) => parentPort.postMessage({ fatal: String((err && err.message) || err) })
);
