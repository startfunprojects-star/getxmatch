'use strict';

// Zero-dependency social "feature image" generator.
//
// Renders a poll question / quiz title onto a branded 1200×630 PNG so that when
// someone shares a poll or quiz link, the unfurled preview card shows the
// heading itself. No native modules and no fonts on disk — the glyphs are a
// small built-in 5×7 bitmap font and the PNG is encoded by hand with Node's
// built-in zlib, so this works identically on the alpine production image.

const zlib = require('zlib');

/* ---------------------------------------------------------------------------
   5×7 bitmap font. Each glyph is 7 rows of a 5-bit mask (bit 4 = leftmost).
   Uppercase only — headings are upper-cased before rendering. Unknown
   characters render as a blank space.
--------------------------------------------------------------------------- */
const GLYPHS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
  "'": ['01100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '"': ['01010', '01010', '01010', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  ';': ['00000', '01100', '01100', '00000', '01100', '00100', '01000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '&': ['01100', '10010', '10010', '01100', '10101', '10010', '01101'],
  '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};

const GLYPH_W = 5;
const GLYPH_H = 7;
const SPACE_UNITS = 4; // advance for a space, in font units

/* ---------------------------------------------------------------------------
   Simple RGBA canvas.
--------------------------------------------------------------------------- */
function canvas(w, h, bg) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = bg[0];
    buf[i * 4 + 1] = bg[1];
    buf[i * 4 + 2] = bg[2];
    buf[i * 4 + 3] = 255;
  }
  return { w, h, buf };
}

function setPx(c, x, y, rgb) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.buf[i] = rgb[0];
  c.buf[i + 1] = rgb[1];
  c.buf[i + 2] = rgb[2];
  c.buf[i + 3] = 255;
}

function fillRect(c, x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) setPx(c, xx, yy, rgb);
  }
}

// Draw one glyph at (x, y) with each font-pixel scaled to `scale`×`scale`.
function drawGlyph(c, ch, x, y, scale, rgb) {
  const g = GLYPHS[ch];
  if (!g) return;
  for (let row = 0; row < GLYPH_H; row++) {
    const bits = g[row];
    for (let col = 0; col < GLYPH_W; col++) {
      if (bits[col] === '1') fillRect(c, x + col * scale, y + row * scale, scale, scale, rgb);
    }
  }
}

// Advance width (in px) of a rendered string at a given scale.
function textWidth(text, scale) {
  let units = 0;
  for (const ch of text) {
    if (ch === ' ') units += SPACE_UNITS + 1;
    else units += GLYPH_W + 1; // glyph + 1 unit letter spacing
  }
  units = Math.max(0, units - 1); // no trailing spacing
  return units * scale;
}

function drawText(c, text, x, y, scale, rgb) {
  let cx = x;
  for (const ch of text) {
    if (ch === ' ') { cx += (SPACE_UNITS + 1) * scale; continue; }
    drawGlyph(c, ch, cx, y, scale, rgb);
    cx += (GLYPH_W + 1) * scale;
  }
}

// Greedy word-wrap into as many lines as the text needs; each line fits `maxW`
// (a single word longer than maxW is left on its own overflowing line).
function wrapAll(text, scale, maxW) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const trial = line ? line + ' ' + w : w;
    if (!line || textWidth(trial, scale) <= maxW) {
      line = trial;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Wrap into at most `maxLines`, ellipsising ("...") the last line on overflow.
function wrapClamped(text, scale, maxW, maxLines) {
  const all = wrapAll(text, scale, maxW);
  if (all.length <= maxLines) return all;
  const lines = all.slice(0, maxLines);
  let last = lines[maxLines - 1];
  while (last && textWidth(last + '...', scale) > maxW) last = last.replace(/\s*\S+$/, '');
  lines[maxLines - 1] = (last || lines[maxLines - 1]) + '...';
  return lines;
}

/* ---------------------------------------------------------------------------
   PNG encoding (RGBA, 8-bit, no interlace).
--------------------------------------------------------------------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(c) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Prepend a filter byte (0 = None) to every scanline.
  const stride = c.w * 4;
  const raw = Buffer.alloc((stride + 1) * c.h);
  for (let y = 0; y < c.h; y++) {
    raw[y * (stride + 1)] = 0;
    c.buf.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------------------------------------------------------------------
   Public API.
--------------------------------------------------------------------------- */
const W = 1200;
const H = 630;
const BG = [15, 17, 23]; // #0f1117
const PANEL = [22, 26, 36]; // slightly lifted panel
const ACCENT = [255, 77, 125]; // brand pink
const WHITE = [245, 247, 250];
const MUTED = [154, 162, 177];

const cache = new Map(); // key -> Buffer, so a heading is rendered once

// Render a feature image. `kind` is 'Poll' or 'Quiz', `heading` the question/
// title. Returns a PNG Buffer.
function renderCard(kind, heading, cacheKey) {
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);

  const c = canvas(W, H, BG);
  // Inner panel + left accent rail.
  fillRect(c, 40, 40, W - 80, H - 80, PANEL);
  fillRect(c, 40, 40, 14, H - 80, ACCENT);

  const marginX = 100;
  const maxW = W - marginX - 80;

  // Kind label (top).
  const label = String(kind || '').toUpperCase();
  drawText(c, label, marginX, 96, 6, ACCENT);
  fillRect(c, marginX, 150, textWidth(label, 6), 4, ACCENT);

  // Heading — pick the largest scale at which the whole heading wraps into at
  // most 4 lines within the central band; ellipsise only if even the smallest
  // scale can't hold it.
  const clean = String(heading || '').toUpperCase().replace(/\s+/g, ' ').trim() || 'UNTITLED';
  const bandTop = 200;
  const bandH = 300;
  const MAX_LINES = 4;
  const lineHAt = (s) => GLYPH_H * s + 4 * s; // glyph height + line gap
  let scale = 6;
  let lines = wrapClamped(clean, 6, maxW, MAX_LINES);
  for (let s = 18; s >= 6; s -= 1) {
    const wrapped = wrapAll(clean, s, maxW);
    const totalH = wrapped.length * lineHAt(s) - 4 * s;
    if (wrapped.length <= MAX_LINES && totalH <= bandH) { scale = s; lines = wrapped; break; }
  }
  const lineH = lineHAt(scale);
  const totalH = lines.length * lineH - 4 * scale;
  let y = bandTop + Math.max(0, (bandH - totalH) / 2);
  for (const line of lines) {
    drawText(c, line, marginX, Math.round(y), scale, WHITE);
    y += lineH;
  }

  // Brand footer.
  drawText(c, 'GETXMATCH.COM', marginX, H - 128, 5, MUTED);

  const png = encodePng(c);
  if (cacheKey) cache.set(cacheKey, png);
  return png;
}

module.exports = { renderCard, W, H };
