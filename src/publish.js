'use strict';
// Workshop packaging: GMA whitelist, addon.json and a native .gma writer (with optional splitting into parts).
const fs = require('fs');
const path = require('path');
const { crc32 } = require('./crc32');
const { prefetch } = require('./prefetch');

// Mirrors the whitelist enforced by gmad / gmpublish ('*' matches anything, including '/').
const WHITELIST = [
  'lua/*.lua', 'scenes/*.vcd', 'particles/*.pcf', 'resource/fonts/*.ttf', 'scripts/vehicles/*.txt',
  'resource/localization/*/*.properties',
  'maps/*.bsp', 'maps/*.lmp', 'maps/*.nav', 'maps/*.ain', 'maps/thumb/*.png',
  'sound/*.wav', 'sound/*.mp3', 'sound/*.ogg',
  'materials/*.vmt', 'materials/*.vtf', 'materials/*.png', 'materials/*.jpg', 'materials/*.jpeg', 'materials/colorcorrection/*.raw',
  'models/*.mdl', 'models/*.phy', 'models/*.ani', 'models/*.vvd', 'models/*.vtx',
  'data_static/*.txt', 'data_static/*.dat', 'data_static/*.json', 'data_static/*.xml', 'data_static/*.csv',
].map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));

const VALID_TAGS = ['fun', 'roleplay', 'scenic', 'movie', 'realism', 'cartoon', 'water', 'comic', 'build'];

/** Can this (lowercase, forward-slash) path be shipped inside a workshop .gma? */
function isGmaAllowed(rel) {
  return WHITELIST.some((re) => re.test(rel));
}

function cleanTags(tags) {
  const t = (Array.isArray(tags) ? tags : []).map((x) => String(x).trim().toLowerCase()).filter((x) => VALID_TAGS.includes(x)); // config.json is hand-editable: "tags": "fun" must not crash the start
  return (t.length ? t : ['roleplay']).slice(0, 2);
}

function writeAddonJson(dir, { title, description, tags, ignore = [] }) {
  const json = { title, ...(description ? { description } : {}), type: 'map', tags: cleanTags(tags), ignore: [...new Set(ignore)].sort() };
  fs.writeFileSync(path.join(dir, 'addon.json'), JSON.stringify(json, null, '\t') + '\n');
  return json;
}

/**
 * Size of a JPEG file, read from its frame header (the workshop icon must be 512x512).
 * @returns {{width:number,height:number}|null} null when the file is not a readable JPEG
 */
function readJpegSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(9);
    if (fs.readSync(fd, head, 0, 2, 0) < 2 || head[0] !== 0xFF || head[1] !== 0xD8) return null;
    for (let pos = 2, segments = 0; segments++ < 4096;) { // a real header has a dozen segments: a file of endless tiny ones is refused, not read to its end
      if (fs.readSync(fd, head, 0, 4, pos) < 4 || head[0] !== 0xFF) return null;
      const marker = head[1];
      if (marker === 0xFF) { pos++; continue; }                                  // fill byte
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { pos += 2; continue; } // markers without a length
      if (marker === 0xD9 || marker === 0xDA) return null;                       // end of image / scan data: no frame header seen
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) { // SOFn: precision, height, width
        if (fs.readSync(fd, head, 0, 5, pos + 4) < 5) return null;
        return { height: head.readUInt16BE(1), width: head.readUInt16BE(3) };
      }
      pos += 2 + head.readUInt16BE(2);
    }
    return null;
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// ---------- .gma writer ----------

function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push({ rel: path.relative(dir, p).split(path.sep).join('/').toLowerCase(), abs: p, size: fs.statSync(p).size });
    }
  })(dir);
  return out;
}

/** One event-loop turn between files: the console status line keeps redrawing while gigabytes are packed. */
const breathe = () => new Promise((r) => setImmediate(r));

/** Write one .gma. files: [{ rel, abs, size }]. Resolves to the byte size of the archive. */
async function writeGMA({ out, title, description, tags, files, onProgress = () => {} }) {
  const chunk = Buffer.allocUnsafe(1 << 22);
  const eachChunk = (file, fn) => {
    const fd = fs.openSync(file.abs, 'r');
    try {
      for (let done = 0; done < file.size;) {
        const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, file.size - done), done);
        if (n <= 0) throw new Error(`File changed while packing: ${file.rel}`);
        fn(chunk.subarray(0, n));
        done += n;
      }
    } finally { fs.closeSync(fd); }
  };
  const total = files.reduce((a, f) => a + f.size, 0) * 2;
  let progress = 0;

  for (const f of files) { // pass 1: per-file CRC
    let c = 0;
    eachChunk(f, (b) => { c = crc32(b, c); progress += b.length; });
    f.crc = c;
    onProgress(progress, total, f.rel);
    await breathe();
  }

  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeUInt32LE(v % 4294967296, 0); b.writeUInt32LE(Math.floor(v / 4294967296), 4); parts.push(b); };
  const str = (s) => parts.push(Buffer.from(`${s}\0`, 'utf-8'));
  parts.push(Buffer.from('GMAD', 'latin1'), Buffer.from([3]));
  u64(0);                                  // steamid (unused)
  u64(Math.floor(Date.now() / 1000));      // timestamp
  parts.push(Buffer.from([0]));            // required content (empty list)
  str(title);
  str(JSON.stringify({ description: description || 'Description', type: 'map', tags: cleanTags(tags) }));
  str('Author Name');
  u32(1);                                  // addon version
  files.forEach((f, i) => { u32(i + 1); str(f.rel); u64(f.size); u32(f.crc); });
  u32(0);
  const header = Buffer.concat(parts);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.mstmp`; // renamed once complete: an interrupted run never leaves a truncated .gma that could be published
  const fd = fs.openSync(tmp, 'w');
  let written = 0, all = 0;
  const put = (b) => { fs.writeSync(fd, b); all = crc32(b, all); written += b.length; };
  try {
    put(header);
    for (const f of files) { // pass 2: contents
      eachChunk(f, (b) => { put(b); progress += b.length; });
      onProgress(progress, total, f.rel);
      await breathe();
    }
    const tail = Buffer.alloc(4); tail.writeUInt32LE(all);
    fs.writeSync(fd, tail); written += 4;
  } catch (e) { fs.closeSync(fd); fs.rmSync(tmp, { force: true }); throw e; }
  fs.closeSync(fd);
  fs.renameSync(tmp, out);
  return written;
}

/**
 * Package a folder into one or several .gma files.
 * @returns {Promise<{ archives: {file,size,count}[], rejected: string[] }>}
 */
async function buildGMAs({ dir, outBase, title, description, tags, splitBytes = 0, onProgress }) {
  const all = listFiles(dir).filter((f) => f.rel !== 'addon.json');
  const rejected = all.filter((f) => !isGmaAllowed(f.rel)).map((f) => f.rel);
  const files = all.filter((f) => isGmaAllowed(f.rel));
  await prefetch(files.map((f) => f.abs)); // the files were just written: see prefetch.js
  // the map itself first, then everything else in path order (keeps folders together when splitting)
  files.sort((a, b) => (b.rel.startsWith('maps/') - a.rel.startsWith('maps/')) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const groups = [[]];
  let size = 0;
  for (const f of files) {
    if (splitBytes > 0 && size + f.size > splitBytes && groups[groups.length - 1].length) { groups.push([]); size = 0; }
    groups[groups.length - 1].push(f);
    size += f.size;
  }
  const archives = [];
  for (const [i, g] of groups.entries()) {
    if (!g.length) continue;
    const multi = groups.length > 1;
    const file = multi ? `${outBase}_part${i + 1}.gma` : `${outBase}.gma`;
    const t = multi ? `${title} (part ${i + 1}/${groups.length})` : title;
    const bytes = await writeGMA({ out: file, title: t, description, tags, files: g, onProgress: onProgress && ((d, n, rel) => onProgress(i + 1, groups.length, d, n, rel)) });
    archives.push({ file, size: bytes, count: g.length });
  }
  return { archives, rejected };
}

module.exports = { isGmaAllowed, writeAddonJson, writeGMA, buildGMAs, cleanTags, readJpegSize, crc32, VALID_TAGS };
