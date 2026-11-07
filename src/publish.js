'use strict';
// Workshop packaging: GMA whitelist, addon.json and a native .gma writer (with optional splitting into parts).
const fs = require('fs');
const path = require('path');
const { crc32 } = require('./crc32');

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
  const t = (tags || []).map((x) => String(x).trim().toLowerCase()).filter((x) => VALID_TAGS.includes(x));
  return (t.length ? t : ['roleplay']).slice(0, 2);
}

function writeAddonJson(dir, { title, tags, ignore = [] }) {
  const json = { title, type: 'map', tags: cleanTags(tags), ignore: [...new Set(ignore)].sort() };
  fs.writeFileSync(path.join(dir, 'addon.json'), JSON.stringify(json, null, '\t') + '\n');
  return json;
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

/** Write one .gma. files: [{ rel, abs, size }]. Returns the byte size of the archive. */
function writeGMA({ out, title, tags, files, onProgress = () => {} }) {
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
  str(JSON.stringify({ description: 'Description', type: 'map', tags: cleanTags(tags) }));
  str('Author Name');
  u32(1);                                  // addon version
  files.forEach((f, i) => { u32(i + 1); str(f.rel); u64(f.size); u32(f.crc); });
  u32(0);
  const header = Buffer.concat(parts);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fd = fs.openSync(out, 'w');
  let written = 0, all = 0;
  const put = (b) => { fs.writeSync(fd, b); all = crc32(b, all); written += b.length; };
  try {
    put(header);
    for (const f of files) { // pass 2: contents
      eachChunk(f, (b) => { put(b); progress += b.length; });
      onProgress(progress, total, f.rel);
    }
    const tail = Buffer.alloc(4); tail.writeUInt32LE(all);
    fs.writeSync(fd, tail); written += 4;
  } finally { fs.closeSync(fd); }
  return written;
}

/**
 * Package a folder into one or several .gma files.
 * @returns {{ archives: {file,size,count}[], rejected: string[] }}
 */
function buildGMAs({ dir, outBase, title, tags, splitBytes = 0, onProgress }) {
  const all = listFiles(dir).filter((f) => f.rel !== 'addon.json');
  const rejected = all.filter((f) => !isGmaAllowed(f.rel)).map((f) => f.rel);
  const files = all.filter((f) => isGmaAllowed(f.rel));
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
  groups.forEach((g, i) => {
    if (!g.length) return;
    const multi = groups.length > 1;
    const file = multi ? `${outBase}_part${i + 1}.gma` : `${outBase}.gma`;
    const t = multi ? `${title} (part ${i + 1}/${groups.length})` : title;
    const bytes = writeGMA({ out: file, title: t, tags, files: g, onProgress: onProgress && ((d, n, rel) => onProgress(i + 1, groups.length, d, n, rel)) });
    archives.push({ file, size: bytes, count: g.length });
  });
  return { archives, rejected };
}

module.exports = { isGmaAllowed, writeAddonJson, writeGMA, buildGMAs, cleanTags, crc32, VALID_TAGS };
