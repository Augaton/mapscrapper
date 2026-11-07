'use strict';
// Reads the directory tree of *_dir.vpk files (v1/v2) to know which files ship with the game,
// and can read the small text / particle files stored inside them (stock soundscripts, soundscapes, .pcf).
const fs = require('fs');
const path = require('path');

const READABLE = /^(scripts\/.+\.txt|particles\/.+\.(pcf|txt))$/;

/**
 * @param {string} file  a *_dir.vpk
 * @param {Set<string>} into  receives every path of the archive (lowercase)
 * @param {Map<string,object>} [readable]  receives what is needed to read scripts / particle files later
 */
function readVpkDir(file, into = new Set(), readable = null) {
  const buf = fs.readFileSync(file);
  if (buf.length < 12 || buf.readUInt32LE(0) !== 0x55aa1234) return into;
  const version = buf.readUInt32LE(4);
  const treeSize = buf.readUInt32LE(8);
  const headerSize = version === 2 ? 28 : 12;
  let pos = headerSize;
  const end = Math.min(buf.length, pos + treeSize);
  const readStr = () => {
    let z = buf.indexOf(0, pos);
    if (z === -1 || z > end) z = end;
    const s = buf.toString('latin1', pos, z);
    pos = z + 1;
    return s;
  };
  while (pos < end) {
    const ext = readStr();
    if (!ext) break;
    for (;;) {
      const dir = readStr();
      if (!dir) break;
      const prefix = dir === ' ' || dir === '' ? '' : dir.toLowerCase() + '/';
      for (;;) {
        const name = readStr();
        if (!name) break;
        if (pos + 18 > end) return into;
        const preload = buf.readUInt16LE(pos + 4), archive = buf.readUInt16LE(pos + 6), offset = buf.readUInt32LE(pos + 8), length = buf.readUInt32LE(pos + 12);
        const preloadAt = pos + 18;
        pos += 18 + preload; // crc(4) preload(2) archive(2) offset(4) length(4) terminator(2) + preload bytes
        const rel = prefix + name.toLowerCase() + '.' + ext.toLowerCase();
        into.add(rel);
        if (readable && !readable.has(rel) && READABLE.test(rel) && length < (1 << 24)) {
          readable.set(rel, { dirFile: file, archive, offset, length, preload: preload ? Buffer.from(buf.subarray(preloadAt, preloadAt + preload)) : null, dataStart: headerSize + treeSize });
        }
      }
    }
  }
  return into;
}

/** Content of a file recorded by readVpkDir (null when it cannot be read). */
function readVpkFile(entry) {
  try {
    const parts = [];
    if (entry.preload) parts.push(entry.preload);
    if (entry.length > 0) {
      const embedded = entry.archive === 0x7fff;
      const file = embedded ? entry.dirFile : entry.dirFile.replace(/_dir\.vpk$/i, `_${String(entry.archive).padStart(3, '0')}.vpk`);
      const fd = fs.openSync(file, 'r');
      try {
        const data = Buffer.alloc(entry.length);
        const n = fs.readSync(fd, data, 0, entry.length, (embedded ? entry.dataStart : 0) + entry.offset);
        if (n !== entry.length) return null;
        parts.push(data);
      } finally { fs.closeSync(fd); }
    }
    return Buffer.concat(parts);
  } catch { return null; }
}

/** Index every *_dir.vpk found directly inside the given directories. */
function loadStockIndex(dirs) {
  const set = new Set(), readable = new Map();
  const files = [];
  for (const d of dirs) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) if (/_dir\.vpk$/i.test(n)) files.push(path.join(d, n));
  }
  for (const f of files) {
    try { readVpkDir(f, set, readable); } catch { /* corrupt vpk: ignore */ }
  }
  return { set, files, readable };
}

module.exports = { readVpkDir, readVpkFile, loadStockIndex };
