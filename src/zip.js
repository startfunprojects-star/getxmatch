'use strict';

// Minimal streaming ZIP writer for "Download my data" (src/account.js). Text
// entries are deflated; files that are already compressed (photos, videos,
// audio) are stored as they are. Entries are written one at a time, so only one
// file is held in memory however large the archive gets.

const fs = require('fs');
const zlib = require('zlib');

// DOS date/time fields for the entry headers.
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ZipWriter {
  constructor(out) {
    this.out = out;          // a writable stream (e.g. the HTTP response)
    this.offset = 0;
    this.entries = [];
    this.names = new Set();
  }

  async write(buf) {
    this.offset += buf.length;
    if (!this.out.write(buf)) await new Promise((r) => this.out.once('drain', r));
  }

  // Add an entry. `data` is a Buffer or string; `deflate` compresses it.
  async add(name, data, { deflate = true, mtime = new Date() } = {}) {
    let n = name.replace(/\\/g, '/').replace(/^\/+/, '');
    // Keep names unique (two photos can share a caption-based name).
    if (this.names.has(n)) {
      const dot = n.lastIndexOf('.');
      let i = 2;
      while (this.names.has(dot > 0 ? `${n.slice(0, dot)} (${i})${n.slice(dot)}` : `${n} (${i})`)) i++;
      n = dot > 0 ? `${n.slice(0, dot)} (${i})${n.slice(dot)}` : `${n} (${i})`;
    }
    this.names.add(n);

    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const crc = zlib.crc32(raw) >>> 0;
    const nameBuf = Buffer.from(n, 'utf8');
    const { time, date } = dosDateTime(mtime);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);            // version needed
    header.writeUInt16LE(0x0800, 6);        // flags: UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);

    this.entries.push({ nameBuf, crc, method, time, date, csize: body.length, size: raw.length, offset: this.offset });
    await this.write(header);
    await this.write(nameBuf);
    await this.write(body);
  }

  // Add a file from disk (silently skipped if it no longer exists).
  async addFile(name, filePath, opts = {}) {
    let data;
    let stat;
    try {
      data = await fs.promises.readFile(filePath);
      stat = await fs.promises.stat(filePath);
    } catch (_e) {
      return false;
    }
    await this.add(name, data, { deflate: false, mtime: stat.mtime, ...opts });
    return true;
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);               // version made by
      h.writeUInt16LE(20, 6);               // version needed
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(e.offset, 42);
      await this.write(h);
      await this.write(e.nameBuf);
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    this.out.end();
  }
}

module.exports = { ZipWriter };
