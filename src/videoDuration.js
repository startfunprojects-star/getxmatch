'use strict';

// Read a video file's duration (in seconds) straight from its container
// headers — no ffmpeg needed. Supports:
//   - MP4 / MOV / M4V: the `mvhd` box inside `moov`, or — for fragmented MP4
//     such as browser recordings, where mvhd says 0 — `mehd`, or the end time
//     of the last `moof` fragment.
//   - WebM / Matroska: Segment Info → Duration, or — for browser recordings,
//     which leave Duration out — the timestamp of the last block in the file.
// Returns null when the duration can't be determined.

const fs = require('fs');

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

/* ------------------------------ MP4 ------------------------------ */

// Top-level boxes of the file, read from disk: [{ type, start, size, header }].
function fileBoxes(fd, fileSize) {
  const out = [];
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const h = readAt(fd, pos, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0);
    let header = 8;
    if (size === 1) {
      if (h.length < 16) break;
      size = Number(h.readBigUInt64BE(8));
      header = 16;
    } else if (size === 0) {
      size = fileSize - pos; // box runs to end of file
    }
    if (size < header) break;
    out.push({ type: h.toString('latin1', 4, 8), start: pos, size, header });
    pos += size;
  }
  return out;
}

// Child boxes inside an in-memory buffer range.
function childBoxes(buf, start, end) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    out.push({ type: buf.toString('latin1', pos + 4, pos + 8), body: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

const child = (buf, box, type) => childBoxes(buf, box.body, box.end).find((b) => b.type === type);
const readU64 = (buf, off) => Number(buf.readBigUInt64BE(off));

function mp4Duration(fd, fileSize) {
  const top = fileBoxes(fd, fileSize);
  const moovBox = top.find((b) => b.type === 'moov');
  if (!moovBox || moovBox.size > 64 * 1024 * 1024) return null;
  const buf = readAt(fd, moovBox.start, moovBox.size);
  const moov = { body: moovBox.header, end: buf.length };

  const mvhd = child(buf, moov, 'mvhd');
  if (!mvhd) return null;
  const v = buf[mvhd.body];
  const movieScale = buf.readUInt32BE(mvhd.body + (v === 1 ? 20 : 12));
  const movieDur = v === 1 ? readU64(buf, mvhd.body + 24) : buf.readUInt32BE(mvhd.body + 16);
  if (movieScale && movieDur && movieDur !== 0xffffffff) return movieDur / movieScale;

  // Fragmented MP4. Try mvex/mehd (total fragment duration) first.
  const mvex = child(buf, moov, 'mvex');
  if (mvex && movieScale) {
    const mehd = child(buf, mvex, 'mehd');
    if (mehd) {
      const d = buf[mehd.body] === 1 ? readU64(buf, mehd.body + 4) : buf.readUInt32BE(mehd.body + 4);
      if (d) return d / movieScale;
    }
  }

  // Otherwise add up the fragments: per track, the end time of its last run.
  const tracks = new Map(); // track_ID -> { scale, defDur, end }
  for (const trak of childBoxes(buf, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const tkhd = child(buf, trak, 'tkhd');
    const mdia = child(buf, trak, 'mdia');
    const mdhd = mdia && child(buf, mdia, 'mdhd');
    if (!tkhd || !mdhd) continue;
    const id = buf.readUInt32BE(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12));
    const scale = buf.readUInt32BE(mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12));
    tracks.set(id, { scale, defDur: 0, end: 0 });
  }
  if (mvex) {
    for (const trex of childBoxes(buf, mvex.body, mvex.end).filter((b) => b.type === 'trex')) {
      const t = tracks.get(buf.readUInt32BE(trex.body + 4));
      if (t) t.defDur = buf.readUInt32BE(trex.body + 12);
    }
  }

  for (const box of top.filter((b) => b.type === 'moof')) {
    if (box.size > 16 * 1024 * 1024) continue;
    const mb = readAt(fd, box.start, box.size);
    for (const traf of childBoxes(mb, box.header, mb.length).filter((b) => b.type === 'traf')) {
      const tfhd = child(mb, traf, 'tfhd');
      if (!tfhd) continue;
      const tflags = mb.readUIntBE(tfhd.body + 1, 3);
      const t = tracks.get(mb.readUInt32BE(tfhd.body + 4));
      if (!t) continue;
      let off = tfhd.body + 8;
      if (tflags & 0x1) off += 8;
      if (tflags & 0x2) off += 4;
      const defDur = tflags & 0x8 ? mb.readUInt32BE(off) : t.defDur;

      const tfdt = child(mb, traf, 'tfdt');
      let time = tfdt
        ? (mb[tfdt.body] === 1 ? readU64(mb, tfdt.body + 4) : mb.readUInt32BE(tfdt.body + 4))
        : t.end;
      for (const trun of childBoxes(mb, traf.body, traf.end).filter((b) => b.type === 'trun')) {
        const flags = mb.readUIntBE(trun.body + 1, 3);
        const count = mb.readUInt32BE(trun.body + 4);
        let p = trun.body + 8;
        if (flags & 0x1) p += 4;
        if (flags & 0x4) p += 4;
        const per = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0) + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
        if (flags & 0x100) {
          for (let i = 0; i < count && p + 4 <= trun.end; i++, p += per) time += mb.readUInt32BE(p);
        } else {
          time += count * defDur;
        }
      }
      if (time > t.end) t.end = time;
    }
  }

  let best = 0;
  for (const t of tracks.values()) if (t.scale && t.end) best = Math.max(best, t.end / t.scale);
  return best || null;
}

/* ------------------------------ WebM ------------------------------ */

// EBML variable-length integer at `pos`: { len, value, unknown }.
function vint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { len, value, unknown: !keepMarker && allOnes };
}

function webmDuration(fd, fileSize) {
  const head = readAt(fd, 0, 1024 * 1024);
  if (head.length < 4 || head.readUInt32BE(0) !== 0x1a45dfa3) return undefined; // not WebM

  let scale = 1000000; // TimecodeScale, ns per tick (default 1ms)
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x2a && head[i + 1] === 0xd7 && head[i + 2] === 0xb1) {
      const len = head[i + 3] & 0x7f; // 1-byte size vint (0x8N)
      if ((head[i + 3] & 0x80) && len >= 1 && len <= 6 && i + 4 + len <= head.length) {
        scale = head.readUIntBE(i + 4, len);
      }
      break;
    }
  }
  for (let i = 0; i + 3 < head.length; i++) {
    if (head[i] === 0x44 && head[i + 1] === 0x89) {
      const sz = head[i + 2];
      if (sz === 0x84 && i + 7 <= head.length) return (head.readFloatBE(i + 3) * scale) / 1e9;
      if (sz === 0x88 && i + 11 <= head.length) return (head.readDoubleBE(i + 3) * scale) / 1e9;
    }
  }

  // No Duration (MediaRecorder output): find the last Cluster in the file's
  // tail and add its Timecode to the latest block timestamp inside it.
  const tailLen = Math.min(fileSize, 16 * 1024 * 1024);
  const tail = readAt(fd, fileSize - tailLen, tailLen);
  for (let i = tail.length - 4; i >= 0; i--) {
    if (tail[i] !== 0x1f || tail[i + 1] !== 0x43 || tail[i + 2] !== 0xb6 || tail[i + 3] !== 0x75) continue;
    const size = vint(tail, i + 4);
    if (!size) continue;
    let p = i + 4 + size.len;
    // The Cluster must open with its Timecode element (0xE7).
    if (tail[p] !== 0xe7) continue;
    const tcSize = vint(tail, p + 1);
    if (!tcSize || tcSize.value < 1 || tcSize.value > 8) continue;
    const clusterTime = tail.readUIntBE(p + 1 + tcSize.len, Math.min(tcSize.value, 6));
    p += 1 + tcSize.len + tcSize.value;

    let maxRel = 0;
    while (p < tail.length) {
      const id = vint(tail, p, true);
      if (!id) break;
      const sz = vint(tail, p + id.len);
      if (!sz || sz.unknown) break;
      const body = p + id.len + sz.len;
      if (body + sz.value > tail.length) break;
      if (id.value === 0x1f43b675) break; // next cluster
      let block = null;
      if (id.value === 0xa3) block = body; // SimpleBlock
      else if (id.value === 0xa0 && tail[body] === 0xa1) { // BlockGroup → Block
        const bsz = vint(tail, body + 1);
        if (bsz) block = body + 1 + bsz.len;
      }
      if (block !== null) {
        const track = vint(tail, block);
        if (track) maxRel = Math.max(maxRel, tail.readInt16BE(block + track.len));
      }
      p = body + sz.value;
    }
    return ((clusterTime + maxRel) * scale) / 1e9;
  }
  return null;
}

function videoDuration(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const { size } = fs.fstatSync(fd);
    const w = webmDuration(fd, size);
    const d = w === undefined ? mp4Duration(fd, size) : w;
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch (_e) {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { videoDuration };
