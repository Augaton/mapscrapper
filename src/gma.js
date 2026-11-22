'use strict';
// Garry's Mod addon (.gma) reader + workshop index: which installed workshop item provides which file.
// Handles raw GMAs ("GMAD") and LZMA-compressed ones (workshop *_legacy.bin).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LzmaDecoder, Input, LzmaNeedInput } = require('./lzma');

const INDEX_VERSION = 2;

class NeedMore extends Error {}

/** Parse the GMA header + file table from a buffer that holds the beginning of the (decompressed) file. */
function parseHeader(buf) {
  if (buf.length < 22) throw new NeedMore();
  if (buf.toString('latin1', 0, 4) !== 'GMAD') throw new Error('not a GMA');
  const version = buf[4];
  let p = 5 + 8 + 8; // steamid + timestamp
  const str = () => {
    const end = buf.indexOf(0, p);
    if (end === -1) throw new NeedMore();
    const s = buf.toString('utf-8', p, end);
    p = end + 1;
    return s;
  };
  if (version > 1) { while (str() !== '') { /* required content, unused */ } }
  const name = str();
  const desc = str();
  const author = str();
  p += 4; // addon version
  const files = [];
  let offset = 0;
  for (;;) {
    if (p + 4 > buf.length) throw new NeedMore();
    const num = buf.readUInt32LE(p); p += 4;
    if (num === 0) break;
    const fpath = str();
    if (p + 12 > buf.length) throw new NeedMore();
    const size = buf.readUInt32LE(p) + buf.readUInt32LE(p + 4) * 4294967296;
    const crc = buf.readUInt32LE(p + 8);
    p += 12;
    files.push({ path: fpath.replace(/\\/g, '/').toLowerCase(), size, crc, offset });
    offset += size;
  }
  let type = '', tags = [];
  try { const j = JSON.parse(desc); type = j.type || ''; tags = j.tags || []; } catch { /* plain text description */ }
  const tidy = (s) => String(s).replace(/[\x00-\x1f\x7f\x9b]/g, '').slice(0, 120); // shown in the console and the reports
  return { name: tidy(name), author: tidy(author), type: tidy(type), tags, files, dataOffset: p };
}

/** Read header + table of a .gma / _legacy.bin file, decoding as little as possible. */
function readGMA(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    const compressed = magic.toString('latin1') !== 'GMAD';
    for (let want = 1 << 16; ; want *= 4) {
      let head, exhausted;
      if (!compressed) {
        head = Buffer.alloc(Math.min(want, size));
        fs.readSync(fd, head, 0, head.length, 0);
        exhausted = head.length >= size;
      } else { // the table sits at the start of the stream: decode only a prefix (restart with a bigger one if needed)
        const dec = LzmaDecoder.alone(new Input({ fd }));
        const cap = Math.min(want, dec.winSize - 512);
        try { dec.decodeTo(cap); } catch (e) { if (!(e instanceof LzmaNeedInput)) throw e; }
        head = dec.getRange(0, Math.min(dec.total, cap));
        exhausted = dec.finished || cap < want;
      }
      try { return Object.assign(parseHeader(head), { compressed }); } catch (e) {
        if (!(e instanceof NeedMore)) throw e;
        if (want >= (1 << 26)) throw new Error('GMA file table too large'); // 64 MB: far beyond any real addon
        if (exhausted) throw new Error('truncated GMA (or file table larger than the LZMA window)');
      }
    }
  } finally { fs.closeSync(fd); }
}

class WorkshopIndex {
  /**
   * @param {string} gamepath .../GarrysMod/garrysmod
   * @param {object} [o] { cacheDir }
   */
  constructor(gamepath, o = {}) {
    this.gamepath = gamepath;
    this.cacheDir = o.cacheDir || path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir(), 'MapScraper');
    // one index per game install, so scanning another game folder never clobbers this one
    const tag = crypto.createHash('md5').update(path.resolve(gamepath).toLowerCase()).digest('hex').slice(0, 8);
    this.indexFile = path.join(this.cacheDir, `workshop-index-${tag}.json`);
    this.addons = [];           // [{ file, id, name, size, mtime, compressed, dataOffset, files }]
    this.byPath = new Map();    // rel -> [addonIndex, fileIndex][]
    this.errors = [];
    this.decoders = new Map();  // addon file -> { fd, dec }
  }

  /** Candidate GMA files: workshop downloads + addons/*.gma. */
  locate() {
    const out = [];
    const content = path.resolve(this.gamepath, '..', '..', '..', 'workshop', 'content', '4000');
    let ids = [];
    try { ids = fs.readdirSync(content); } catch { /* no workshop folder */ }
    for (const id of ids) {
      let names = [];
      try { names = fs.readdirSync(path.join(content, id)); } catch { continue; }
      for (const n of names) if (/\.(gma|bin)$/i.test(n)) out.push({ file: path.join(content, id, n), id });
    }
    const addons = path.join(this.gamepath, 'addons');
    try {
      for (const n of fs.readdirSync(addons)) {
        if (!/\.gma$/i.test(n)) continue;
        const m = /_(\d{6,})\.gma$/i.exec(n);
        out.push({ file: path.join(addons, n), id: m ? m[1] : '' });
      }
    } catch { /* no addons folder */ }
    return out;
  }

  build(onProgress = () => {}) {
    let cache = {};
    try {
      const j = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
      if (j.version === INDEX_VERSION) cache = j.addons || {};
    } catch { /* no cache yet */ }
    const found = this.locate();
    const next = {};
    let dirty = false, i = 0;
    for (const { file, id } of found) {
      onProgress(++i, found.length);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      let entry = cache[file];
      if (!entry || entry.size !== st.size || entry.mtime !== st.mtimeMs) {
        dirty = true;
        try {
          const g = readGMA(file);
          entry = { size: st.size, mtime: st.mtimeMs, id, name: g.name, compressed: g.compressed, dataOffset: g.dataOffset, files: g.files.map((f) => [f.path, f.size, f.crc]) };
        } catch (e) {
          this.errors.push(`${file}: ${e.message}`);
          entry = { size: st.size, mtime: st.mtimeMs, id, name: '', compressed: false, dataOffset: 0, files: [], error: e.message };
        }
      }
      next[file] = entry;
    }
    if (dirty || Object.keys(cache).length !== Object.keys(next).length) {
      try { fs.mkdirSync(this.cacheDir, { recursive: true }); fs.writeFileSync(this.indexFile, JSON.stringify({ version: INDEX_VERSION, addons: next })); } catch { /* cache is optional */ }
    }
    for (const [file, e] of Object.entries(next)) {
      const ai = this.addons.length;
      let offset = 0;
      const files = e.files.map(([p, size, crc]) => { const f = { path: p, size, crc, offset }; offset += size; return f; });
      this.addons.push({ file, id: e.id, name: e.name, compressed: e.compressed, dataOffset: e.dataOffset, mtime: e.mtime, files });
      files.forEach((f, fi) => {
        const arr = this.byPath.get(f.path);
        if (arr) arr.push([ai, fi]); else this.byPath.set(f.path, [[ai, fi]]);
      });
    }
    return this;
  }

  /** Addons providing a game-relative (lowercase) path. */
  providers(rel) {
    return (this.byPath.get(rel) || []).map(([ai]) => this.addons[ai]);
  }

  /** Like providers(), with the size each addon stores the file at: [{ addon, size }]. */
  copies(rel) {
    return (this.byPath.get(rel) || []).map(([ai, fi]) => ({ addon: this.addons[ai], size: this.addons[ai].files[fi].size }));
  }

  /** Extract a file from the first addon that provides it; returns { path, addon } (cached copy) or null. */
  extract(rel) {
    const hits = this.byPath.get(rel);
    if (!hits) return null;
    if (/[:\\]/.test(rel) || rel.split('/').some((seg) => seg === '..' || seg === '')) return null; // never extract outside the cache
    for (const [ai, fi] of hits) {
      const addon = this.addons[ai], f = addon.files[fi];
      const dest = path.join(this.cacheDir, 'gma-cache', `${addon.id || path.basename(addon.file)}_${Math.round(addon.mtime)}`, rel);
      try {
        const st = fs.statSync(dest, { throwIfNoEntry: false });
        if (st && st.size === f.size) return { path: dest, addon };
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        this._extractTo(addon, f, dest);
        return { path: dest, addon };
      } catch (e) {
        this.errors.push(`${addon.file} → ${rel}: ${e.message}`);
      }
    }
    return null;
  }

  _extractTo(addon, f, dest) {
    const start = addon.dataOffset + f.offset;
    const tmp = `${dest}.part`;
    const out = fs.openSync(tmp, 'w');
    try {
      if (!addon.compressed) {
        const fd = fs.openSync(addon.file, 'r');
        try {
          const buf = Buffer.allocUnsafe(Math.min(f.size, 1 << 24) || 1);
          for (let done = 0; done < f.size;) {
            const n = fs.readSync(fd, buf, 0, Math.min(buf.length, f.size - done), start + done);
            if (n <= 0) throw new Error('unexpected end of GMA');
            fs.writeSync(out, buf, 0, n);
            done += n;
          }
        } finally { fs.closeSync(fd); }
      } else {
        let d = this.decoders.get(addon.file);
        const tooLate = (x) => start < x.dec.total - Math.min(x.dec.total, x.dec.winSize);
        if (!d || tooLate(d)) { // (re)start decoding from the beginning of the stream
          if (d) fs.closeSync(d.fd);
          const fd = fs.openSync(addon.file, 'r');
          d = { fd, dec: LzmaDecoder.alone(new Input({ fd })) };
          this.decoders.set(addon.file, d);
        }
        d.dec.readRange(start, f.size, (chunk) => fs.writeSync(out, chunk));
      }
    } catch (e) {
      fs.closeSync(out); fs.rmSync(tmp, { force: true });
      throw e;
    }
    fs.closeSync(out);
    fs.renameSync(tmp, dest);
  }

  close() {
    for (const d of this.decoders.values()) { try { fs.closeSync(d.fd); } catch { /* already closed */ } }
    this.decoders.clear();
  }
}

module.exports = { parseHeader, readGMA, WorkshopIndex, NeedMore };
