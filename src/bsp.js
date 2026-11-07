'use strict';
// Source engine BSP reader: lump directory, entity lump, texdata strings, static props, embedded pakfile (zip).
const fs = require('fs');
const zlib = require('zlib');
const { decompressRaw } = require('./lzma');
const { crc32 } = require('./crc32');

const LUMP_ENTITIES = 0, LUMP_GAME = 35, LUMP_PAKFILE = 40, LUMP_TEXDATA_STRINGS = 43;

class BSP {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    try {
      this.size = fs.fstatSync(this.fd).size;
      const hdr = this._read(0, 1036);
      if (hdr.length < 1036 || hdr.toString('latin1', 0, 4) !== 'VBSP') throw new Error(`Not a Source BSP: ${file}`);
      this.version = hdr.readInt32LE(4);
      this.lumps = [];
      for (let i = 0; i < 64; i++) {
        const o = 8 + i * 16;
        this.lumps.push({ ofs: hdr.readInt32LE(o), len: hdr.readInt32LE(o + 4), version: hdr.readInt32LE(o + 8), uncompressed: hdr.readUInt32LE(o + 12) });
      }
    } catch (e) { this.close(); throw e; }
  }

  close() { if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; } }

  _read(ofs, len) {
    if (ofs < 0 || len <= 0 || ofs >= this.size) return Buffer.alloc(0);
    const buf = Buffer.alloc(Math.min(len, this.size - ofs));
    fs.readSync(this.fd, buf, 0, buf.length, ofs);
    return buf;
  }

  /** Valve LZMA wrapper: 'LZMA' + actualSize + lzmaSize + 5 props bytes. */
  static unwrap(buf) {
    if (buf.length > 17 && buf.toString('latin1', 0, 4) === 'LZMA') {
      return decompressRaw(buf.subarray(12, 17), buf.readUInt32LE(4), buf, 17);
    }
    return buf;
  }

  readLump(i) {
    const l = this.lumps[i];
    if (!l || l.len <= 0) return Buffer.alloc(0);
    return BSP.unwrap(this._read(l.ofs, l.len));
  }

  /** True when the lumps are LZMA-compressed (bspzip -repack -compress). */
  isCompressed() {
    const l = this.lumps[LUMP_ENTITIES];
    return this._read(l.ofs, 4).toString('latin1') === 'LZMA';
  }

  /** Raw entity lump text. */
  entityText() {
    if (this._entText === undefined) this._entText = this.readLump(LUMP_ENTITIES).toString('latin1');
    return this._entText;
  }

  /** Entity lump as an array of [key, value][] (keys lowercased), one per entity. */
  entities() {
    const text = this.entityText();
    const out = [];
    const blockRe = /\{([^{}]*)\}/g;
    const pairRe = /"([^"\r\n]*)"\s+"([^"\r\n]*)"/g;
    let b;
    while ((b = blockRe.exec(text))) {
      const pairs = [];
      let m;
      pairRe.lastIndex = 0;
      while ((m = pairRe.exec(b[1]))) pairs.push([m[1].toLowerCase(), m[2]]);
      if (pairs.length) out.push(pairs);
    }
    return out;
  }

  /** Material names used by brushes, displacements, overlays... */
  texdataStrings() {
    return this.readLump(LUMP_TEXDATA_STRINGS).toString('latin1').split('\0').filter(Boolean);
  }

  /** Static props: [{ model, skins:Set<number> }] (skin is at offset 32 of the prop struct in every lump version). */
  staticProps() {
    const dir = this.readLump(LUMP_GAME);
    const result = new Map();
    if (dir.length < 4) return result;
    const n = dir.readInt32LE(0);
    for (let i = 0; i < n && 4 + i * 16 + 16 <= dir.length; i++) {
      const o = 4 + i * 16;
      if (dir.toString('latin1', o, o + 4) !== 'prps') continue; // 'sprp' little-endian
      const flags = dir.readUInt16LE(o + 4);
      const ofs = dir.readInt32LE(o + 8);
      let len = dir.readInt32LE(o + 12);
      // compressed game lump: filelen is the uncompressed size, the real length runs up to the next lump
      if ((flags & 1) && i + 1 < n && 4 + (i + 1) * 16 + 16 <= dir.length) len = dir.readInt32LE(4 + (i + 1) * 16 + 8) - ofs;
      const data = BSP.unwrap(this._read(ofs, len));
      if (data.length < 4) break;
      let p = 0;
      const dictCount = data.readInt32LE(p); p += 4;
      const names = [];
      for (let k = 0; k < dictCount && p + 128 <= data.length; k++, p += 128) {
        let end = data.indexOf(0, p); if (end === -1 || end > p + 128) end = p + 128;
        const name = data.toString('latin1', p, end);
        names.push(name);
        result.set(name.toLowerCase().replace(/\\/g, '/'), new Set());
      }
      if (p + 4 > data.length) break;
      const leafCount = data.readInt32LE(p); p += 4 + leafCount * 2;
      if (p + 4 > data.length) break;
      const propCount = data.readInt32LE(p); p += 4;
      const stride = propCount > 0 ? Math.floor((data.length - p) / propCount) : 0;
      const skinsKnown = stride >= 36 && stride <= 128 && (data.length - p) === stride * propCount;
      for (let k = 0; k < propCount && skinsKnown; k++) {
        const s = p + k * stride;
        const model = names[data.readUInt16LE(s + 24)];
        if (model === undefined) continue;
        result.get(model.toLowerCase().replace(/\\/g, '/')).add(data.readInt32LE(s + 32));
      }
      if (!skinsKnown) for (const set of result.values()) set.add(-1); // -1 = unknown, keep every skin
      break;
    }
    return result;
  }

  /** Embedded pakfile. */
  pak() {
    if (!this._pak) this._pak = new Pak(this._read(this.lumps[LUMP_PAKFILE].ofs, this.lumps[LUMP_PAKFILE].len));
    return this._pak;
  }
}

/** Tiny zip reader (stored / deflate / lzma entries), enough for BSP pakfiles. */
class Pak {
  constructor(buf) {
    this.buf = buf;
    this.entries = new Map(); // lowercased path -> { name, method, csize, usize, offset }
    let e = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    }
    if (e < 0) return;
    const count = buf.readUInt16LE(e + 10);
    let p = buf.readUInt32LE(e + 16);
    for (let i = 0; i < count && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
      const name = buf.toString('latin1', p + 46, p + 46 + nl).replace(/\\/g, '/');
      this.entries.set(name.toLowerCase(), {
        name, method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42),
      });
      p += 46 + nl + xl + cl;
    }
  }

  has(rel) { return this.entries.has(rel); }
  get size() { return this.entries.size; }
  names() { return this.entries.keys(); }

  read(rel) {
    const en = this.entries.get(rel);
    if (!en) return null;
    const b = this.buf, o = en.offset;
    if (o + 30 > b.length || b.readUInt32LE(o) !== 0x04034b50) return null;
    const start = o + 30 + b.readUInt16LE(o + 26) + b.readUInt16LE(o + 28);
    const data = b.subarray(start, start + en.csize);
    if (en.method === 0) return Buffer.from(data);
    if (en.method === 8) return zlib.inflateRawSync(data);
    if (en.method === 14) { // zip-lzma: version(2) propsSize(2) props(5) stream
      const ps = data.readUInt16LE(2);
      return decompressRaw(data.subarray(4, 4 + ps), en.usize, data, 4 + ps);
    }
    return null;
  }
}

/**
 * Add / replace files in the pakfile of a BSP without any external tool.
 * Existing entries are carried over byte for byte; new ones are stored uncompressed.
 * @param {string} src   source .bsp
 * @param {string} dest  output .bsp (may not be the same file)
 * @param {{rel:string, abs:string}[]} files
 * @returns {{added:number, replaced:number}}
 */
function packFiles(src, dest, files) {
  const bsp = new BSP(src);
  let head, zip, lump;
  try {
    lump = bsp.lumps[LUMP_PAKFILE];
    head = bsp._read(0, 1036);
    zip = lump.len > 0 ? bsp._read(lump.ofs, lump.len) : Buffer.alloc(0);
  } finally { bsp.close(); }

  // central directory of the existing pak
  const old = [];
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd >= 0) {
    let p = zip.readUInt32LE(eocd + 16);
    for (let i = 0, n = zip.readUInt16LE(eocd + 10); i < n; i++) {
      if (p + 46 > zip.length || zip.readUInt32LE(p) !== 0x02014b50) throw new Error('pakfile: corrupted central directory');
      const nl = zip.readUInt16LE(p + 28), xl = zip.readUInt16LE(p + 30), cl = zip.readUInt16LE(p + 32);
      if (zip.readUInt16LE(p + 8) & 8) throw new Error('pakfile: data descriptors are not supported');
      old.push({ central: zip.subarray(p, p + 46 + nl + xl + cl), name: zip.toString('latin1', p + 46, p + 46 + nl).replace(/\\/g, '/').toLowerCase(), csize: zip.readUInt32LE(p + 20), offset: zip.readUInt32LE(p + 42) });
      p += 46 + nl + xl + cl;
    }
  } else if (zip.length > 22) throw new Error('pakfile: end of central directory not found');

  const incoming = new Map(files.map((f) => [f.rel.replace(/\\/g, '/').toLowerCase(), f]));
  const parts = [], central = [];
  let pos = 0, replaced = 0;
  for (const e of old) {
    if (incoming.has(e.name)) { replaced++; continue; }
    const o = e.offset;
    if (o + 30 > zip.length || zip.readUInt32LE(o) !== 0x04034b50) throw new Error(`pakfile: bad local header for ${e.name}`);
    const local = zip.subarray(o, o + 30 + zip.readUInt16LE(o + 26) + zip.readUInt16LE(o + 28) + e.csize);
    const c = Buffer.from(e.central);
    c.writeUInt32LE(pos, 42);
    parts.push(local); central.push(c);
    pos += local.length;
  }
  for (const [name, f] of incoming) {
    const data = fs.readFileSync(f.abs);
    const nameBuf = Buffer.from(name, 'latin1');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(10, 4); // version needed; flags, method (stored), time, date = 0
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(10, 6);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(pos, 42);
    parts.push(local, nameBuf, data); central.push(Buffer.concat([c, nameBuf]));
    pos += 30 + nameBuf.length + data.length;
  }
  if (central.length > 65535) throw new Error('pakfile: too many entries');
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(pos, 16);

  // The pakfile is normally the last lump: replace it in place. Otherwise append the new one (old bytes become dead space).
  const size = fs.statSync(src).size;
  const others = [];
  { const b = new BSP(src); try { b.lumps.forEach((l, i) => { if (i !== LUMP_PAKFILE && l.len > 0) others.push(l.ofs + l.len); }); } finally { b.close(); } }
  const pakIsLast = lump.len > 0 && others.every((e) => e <= lump.ofs) && lump.ofs + lump.len + 4 >= size;
  const keep = pakIsLast ? lump.ofs : size;
  const pad = (4 - (keep % 4)) % 4;

  const out = fs.openSync(dest, 'w');
  const inp = fs.openSync(src, 'r');
  try {
    const hdr = Buffer.from(head);
    hdr.writeInt32LE(keep + pad, 8 + LUMP_PAKFILE * 16);
    hdr.writeInt32LE(pos + cd.length + 22, 12 + LUMP_PAKFILE * 16);
    fs.writeSync(out, hdr);
    const chunk = Buffer.allocUnsafe(1 << 22);
    for (let done = 1036; done < keep;) {
      const n = fs.readSync(inp, chunk, 0, Math.min(chunk.length, keep - done), done);
      if (n <= 0) throw new Error('unexpected end of BSP');
      fs.writeSync(out, chunk, 0, n);
      done += n;
    }
    if (pad) fs.writeSync(out, Buffer.alloc(pad));
    for (const b of parts) fs.writeSync(out, b);
    fs.writeSync(out, cd);
    fs.writeSync(out, end);
  } finally { fs.closeSync(inp); fs.closeSync(out); }
  return { added: incoming.size - replaced, replaced };
}

module.exports = { BSP, Pak, packFiles };
