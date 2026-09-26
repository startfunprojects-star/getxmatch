'use strict';

// Read a video file's duration (in seconds) straight from its container
// headers — no ffmpeg needed. Supports MP4 / MOV / M4V (the `mvhd` box inside
// `moov`) and WebM / Matroska (Segment Info → Duration × TimecodeScale).
// Returns null when the duration can't be determined.

const fs = require('fs');

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

// Walk ISO-BMFF boxes from `start` to `end`, returning { start, size, header }
// for the first box of `type`.
function findBox(fd, start, end, type) {
  let pos = start;
  while (pos + 8 <= end) {
    const h = readAt(fd, pos, 16);
    if (h.length < 8) return null;
    let size = h.readUInt32BE(0);
    const t = h.toString('latin1', 4, 8);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) return null;
      size = Number(h.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = end - pos; // box runs to end of file
    }
    if (size < header) return null;
    if (t === type) return { start: pos, size, header };
    pos += size;
  }
  return null;
}

function mp4Duration(fd, fileSize) {
  const moov = findBox(fd, 0, fileSize, 'moov');
  if (!moov) return null;
  const mvhd = findBox(fd, moov.start + moov.header, moov.start + moov.size, 'mvhd');
  if (!mvhd) return null;
  const b = readAt(fd, mvhd.start + mvhd.header, 32);
  const version = b[0];
  let timescale;
  let duration;
  if (version === 1) {
    if (b.length < 32) return null;
    timescale = b.readUInt32BE(20);
    duration = Number(b.readBigUInt64BE(24));
  } else {
    if (b.length < 20) return null;
    timescale = b.readUInt32BE(12);
    duration = b.readUInt32BE(16);
  }
  if (!timescale || duration === 0xffffffff) return null;
  return duration / timescale;
}

// WebM: find the Duration element (ID 0x4489, a 4- or 8-byte float in
// TimecodeScale units) and TimecodeScale (ID 0x2AD7B1, default 1ms) in the
// file's first megabyte, where the Segment Info block lives.
function webmDuration(fd) {
  const b = readAt(fd, 0, 1024 * 1024);
  if (b.length < 4 || b.readUInt32BE(0) !== 0x1a45dfa3) return null;

  let scale = 1000000;
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] === 0x2a && b[i + 1] === 0xd7 && b[i + 2] === 0xb1) {
      const len = b[i + 3] & 0x7f; // 1-byte size vint (0x8N)
      if ((b[i + 3] & 0x80) && len >= 1 && len <= 8 && i + 4 + len <= b.length) {
        scale = b.readUIntBE(i + 4, Math.min(len, 6));
      }
      break;
    }
  }
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] === 0x44 && b[i + 1] === 0x89) {
      const sz = b[i + 2];
      if (sz === 0x84 && i + 7 <= b.length) return (b.readFloatBE(i + 3) * scale) / 1e9;
      if (sz === 0x88 && i + 11 <= b.length) return (b.readDoubleBE(i + 3) * scale) / 1e9;
    }
  }
  return null;
}

function videoDuration(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const { size } = fs.fstatSync(fd);
    const d = webmDuration(fd) ?? mp4Duration(fd, size);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch (_e) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { videoDuration };
