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
const CACHE_MAX = 300;

function cachePut(key, png) {
  if (!key) return;
  cache.set(key, png);
  // Poll-result keys change with every vote, so cap the cache (oldest first).
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

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
  cachePut(cacheKey, png);
  return png;
}

/* ---------------------------------------------------------------------------
   Poll results card: the question plus every option drawn as a result bar,
   split by voter gender in the same colours the poll page uses.
--------------------------------------------------------------------------- */
const TRACK = [34, 39, 52];
const VOTE_MALE = [79, 155, 255]; // #4f9bff
const VOTE_FEMALE = [255, 105, 180]; // #ff69b4
const VOTE_OTHER = [154, 163, 181]; // #9aa3b5

// Blend `rgb` over `base` at `a` (0..1) — mirrors the page's color-mix() bars.
function mix(rgb, base, a) {
  return rgb.map((v, i) => Math.round(v * a + base[i] * (1 - a)));
}

// Rectangle with corners clipped to radius `r`.
function fillRoundRect(c, x, y, w, h, r, rgb) {
  r = Math.max(0, Math.min(r, Math.floor(w / 2), Math.floor(h / 2)));
  for (let yy = 0; yy < h; yy++) {
    let inset = 0;
    const dy = yy < r ? r - yy - 0.5 : yy >= h - r ? yy - (h - r) + 0.5 : -1;
    if (dy >= 0) inset = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    fillRect(c, x + inset, y + yy, w - inset * 2, 1, rgb);
  }
}

// Trim `text` with "..." until it fits `maxW` at `scale`.
function fitText(text, scale, maxW) {
  if (textWidth(text, scale) <= maxW) return text;
  let t = text;
  while (t.length && textWidth(t + '...', scale) > maxW) t = t.slice(0, -1).trimEnd();
  return t + '...';
}

const clean = (t) => String(t || '').toUpperCase().replace(/\s+/g, ' ').trim();

// poll = { question, options: [str], counts: [n], genders: [{male,female,other}],
//          total, closed }. Returns a PNG Buffer.
function renderPollCard(poll, cacheKey) {
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);

  const c = canvas(W, H, BG);
  fillRect(c, 40, 40, W - 80, H - 80, PANEL);
  fillRect(c, 40, 40, 14, H - 80, ACCENT);

  const left = 96;
  const right = W - 84;
  const maxW = right - left;

  // Header: "POLL" on the left, vote count / status on the right.
  drawText(c, 'POLL', left, 72, 5, ACCENT);
  const total = poll.total || 0;
  const status = (total ? `${total} VOTE${total === 1 ? '' : 'S'}` : 'NO VOTES YET') + (poll.closed ? ' - CLOSED' : '');
  drawText(c, status, right - textWidth(status, 4), 76, 4, MUTED);

  // Options: show up to 6 (5 + a "+N more" line when there are more).
  const allOpts = poll.options || [];
  const MAX_ROWS = 6;
  const shown = allOpts.length > MAX_ROWS ? MAX_ROWS - 1 : allOpts.length;
  const more = allOpts.length - shown;
  const rows = shown + (more ? 1 : 0);

  // Vertical budget between the header and the footer.
  const top = 140;
  const bottom = H - 118;
  const gap = 22;
  const minRow = 44;

  // Question: largest scale (≤ 3 lines) that still leaves room for the bars.
  const q = clean(poll.question) || 'UNTITLED POLL';
  const lineHAt = (s) => GLYPH_H * s + 3 * s;
  let qScale = 3;
  let qLines = wrapClamped(q, 3, maxW, 3);
  for (let s = 8; s >= 3; s -= 1) {
    const wrapped = wrapAll(q, s, maxW);
    const qH = wrapped.length * lineHAt(s) - 3 * s;
    if (wrapped.length <= 3 && qH + gap + rows * minRow <= bottom - top) { qScale = s; qLines = wrapped; break; }
  }
  const qH = qLines.length * lineHAt(qScale) - 3 * qScale;
  const rowH = rows ? Math.min(70, Math.floor((bottom - top - qH - gap) / rows)) : 0;
  // Centre the question + bars block when a short poll leaves spare room.
  let y = top + Math.max(0, Math.floor((bottom - top - (qH + gap + rows * rowH)) / 2));
  for (const line of qLines) {
    drawText(c, line, left, y, qScale, WHITE);
    y += lineHAt(qScale);
  }
  y += gap - 3 * qScale;

  const barH = Math.max(32, rowH - 10);
  const tScale = Math.max(3, Math.min(4, Math.floor((barH - 12) / GLYPH_H)));
  const textY = (by) => by + Math.round((barH - GLYPH_H * tScale) / 2);
  const counts = poll.counts || [];
  const lead = Math.max(0, ...counts.slice(0, allOpts.length));

  for (let i = 0; i < shown; i++) {
    const n = counts[i] || 0;
    const pct = total ? Math.round((n / total) * 100) : 0;
    const by = y + i * rowH;
    fillRoundRect(c, left, by, maxW, barH, 10, TRACK);

    // Filled portion, split by gender.
    const fillW = Math.round((maxW * n) / Math.max(1, total));
    if (fillW > 0) {
      const g = (poll.genders && poll.genders[i]) || { male: 0, female: 0, other: n };
      const parts = [[g.male, VOTE_MALE], [g.female, VOTE_FEMALE], [g.other, VOTE_OTHER]].filter(([k]) => k > 0);
      const sum = parts.reduce((a, [k]) => a + k, 0) || 1;
      let x = left;
      parts.forEach(([k, col], pi) => {
        const w = pi === parts.length - 1 ? left + fillW - x : Math.round((fillW * k) / sum);
        fillRect(c, x, by, w, barH, mix(col, TRACK, 0.55));
        x += w;
      });
      // Re-clip the bar's corners back to the panel colour.
      clipCorners(c, left, by, maxW, barH, 10, PANEL);
    }

    const isLead = total > 0 && n === lead;
    const meta = `${pct}%  ${n}`;
    const metaW = textWidth(meta, tScale);
    drawText(c, meta, left + maxW - 18 - metaW, textY(by), tScale, isLead ? WHITE : MUTED);
    const label = fitText(clean(allOpts[i]) || '-', tScale, maxW - 54 - metaW);
    drawText(c, label, left + 18, textY(by), tScale, WHITE);
  }
  if (more) {
    const by = y + shown * rowH;
    drawText(c, `+ ${more} MORE OPTION${more === 1 ? '' : 'S'}`, left + 18, textY(by), tScale, MUTED);
  }

  // Footer: brand on the left, colour legend on the right.
  const fy = H - 96;
  drawText(c, 'GETXMATCH.COM', left, fy, 4, MUTED);
  let lx = right;
  for (const [name, col] of [['OTHER', VOTE_OTHER], ['FEMALE', VOTE_FEMALE], ['MALE', VOTE_MALE]]) {
    const tw = textWidth(name, 3);
    lx -= tw;
    drawText(c, name, lx, fy + 3, 3, MUTED);
    lx -= 30;
    fillRoundRect(c, lx, fy + 1, 22, 22, 5, col);
    lx -= 32;
  }

  const png = encodePng(c);
  cachePut(cacheKey, png);
  return png;
}

// Paint the pixels outside a rounded rect's corners with `rgb` (used to round
// off a bar after its square segments were drawn).
function clipCorners(c, x, y, w, h, r, rgb) {
  for (let yy = 0; yy < r; yy++) {
    const dy = r - yy - 0.5;
    const inset = Math.ceil(r - Math.sqrt(Math.max(0, r * r - dy * dy)));
    fillRect(c, x, y + yy, inset, 1, rgb);
    fillRect(c, x + w - inset, y + yy, inset, 1, rgb);
    fillRect(c, x, y + h - 1 - yy, inset, 1, rgb);
    fillRect(c, x + w - inset, y + h - 1 - yy, inset, 1, rgb);
  }
}

module.exports = { renderCard, renderPollCard, W, H };
