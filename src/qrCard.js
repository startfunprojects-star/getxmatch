'use strict';

// A member's profile QR card: a branded PNG ("GETXMATCH" header, the QR code,
// "@username") whose code opens their public profile link /u/<username>.
// The link never changes for a member, so the QR is fixed and safe to print or
// share. Rendered with the same zero-dependency canvas/PNG code as the social
// preview images (src/ogImage.js); `qrcode` only computes the module matrix.

const QRCode = require('qrcode');
const { canvas, fillRect, fillRoundRect, drawText, textWidth, fitText, encodePng } = require('./ogImage');

const W = 640;
const H = 820;
const WHITE = [255, 255, 255];
const PAPER = [255, 253, 248]; // #fffdf8
const INK = [29, 36, 51]; // #1d2433 — dark on light scans most reliably
const ACCENT = [31, 78, 140]; // #1f4e8c Oxford blue
const MUTED = [90, 98, 115];

const cache = new Map();
const CACHE_MAX = 500;

function centered(c, text, y, scale, rgb) {
  drawText(c, text, Math.round((W - textWidth(text, scale)) / 2), y, scale, rgb);
}

// url: absolute profile URL encoded in the QR. Returns a PNG Buffer.
function renderProfileQr(username, url) {
  const key = `${username}|${url}`;
  if (cache.has(key)) return cache.get(key);

  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const QUIET = 4; // modules of white margin required around a QR code
  const box = 480;
  const mod = Math.floor(box / (n + QUIET * 2));
  const qrPx = mod * (n + QUIET * 2);

  const c = canvas(W, H, PAPER);
  // Brand header.
  fillRect(c, 0, 0, W, 118, ACCENT);
  centered(c, 'GETXMATCH', 36, 7, WHITE);

  // QR code, centred, with its quiet zone.
  const qx = Math.round((W - qrPx) / 2);
  const qy = 150;
  fillRoundRect(c, qx - 6, qy - 6, qrPx + 12, qrPx + 12, 14, [226, 217, 198]); // paper-toned frame
  fillRect(c, qx, qy, qrPx, qrPx, WHITE);
  for (let r = 0; r < n; r++) {
    for (let col = 0; col < n; col++) {
      if (qr.modules.get(r, col)) fillRect(c, qx + (col + QUIET) * mod, qy + (r + QUIET) * mod, mod, mod, INK);
    }
  }

  // Who it belongs to + what it does.
  let y = qy + qrPx + 34;
  const handle = fitText('@' + String(username).toUpperCase(), 5, W - 60);
  centered(c, handle, y, 5, INK);
  y += 56;
  centered(c, 'SCAN TO VIEW MY PROFILE', y, 3, MUTED);
  y += 34;
  centered(c, 'ON GETXMATCH', y, 3, ACCENT);

  const png = encodePng(c);
  cache.set(key, png);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return png;
}

module.exports = { renderProfileQr };
