'use strict';
// Builders for synthetic Source / Garry's Mod files used by the test-suites.
const { crc32 } = require('../src/crc32');

/** studiomdl header with textures, $cdmaterials, $includemodel and skin families (rows of texture indices). */
function makeMDL({ textures = [], cdtextures = [], includes = [], skins = null, meshes = null }) {
  const buf = Buffer.alloc(8192);
  buf.write('IDST', 0, 'latin1');
  buf.writeInt32LE(48, 4);
  buf.write('test.mdl', 12, 'latin1');
  buf.writeInt32LE(buf.length, 76);
  let cursor = 408, strPos = 4096;
  const putStr = (s) => { const o = strPos; buf.write(`${s}\0`, o, 'latin1'); strPos += s.length + 1; return o; };
  buf.writeInt32LE(textures.length, 204); buf.writeInt32LE(cursor, 208);
  textures.forEach((t, i) => { const base = cursor + i * 64; buf.writeInt32LE(putStr(t) - base, base); });
  cursor += textures.length * 64;
  buf.writeInt32LE(cdtextures.length, 212); buf.writeInt32LE(cursor, 216);
  cdtextures.forEach((d, i) => buf.writeInt32LE(putStr(d), cursor + i * 4));
  cursor += cdtextures.length * 4;
  const rows = skins || [textures.map((_, i) => i)];
  buf.writeInt32LE(rows[0].length, 220); buf.writeInt32LE(rows.length, 224); buf.writeInt32LE(cursor, 228);
  rows.forEach((row, f) => row.forEach((t, r) => buf.writeInt16LE(t, cursor + (f * rows[0].length + r) * 2)));
  cursor += rows.length * rows[0].length * 2;
  buf.writeInt32LE(includes.length, 336); buf.writeInt32LE(cursor, 340);
  includes.forEach((n, i) => { const base = cursor + i * 8; buf.writeInt32LE(0, base); buf.writeInt32LE(putStr(n) - base, base + 4); });
  if (meshes) { // one bodypart -> one model -> one mesh per material slot
    const bp = 3000, mo = bp + 16, me = mo + 148;
    buf.writeInt32LE(1, 232); buf.writeInt32LE(bp, 236);
    buf.writeInt32LE(1, bp + 4); buf.writeInt32LE(16, bp + 12);
    buf.writeInt32LE(meshes.length, mo + 72); buf.writeInt32LE(148, mo + 76);
    meshes.forEach((slot, i) => buf.writeInt32LE(slot, me + i * 116));
  }
  return buf;
}

/** Stored (uncompressed) zip archive. files: { 'path/in/zip': Buffer|string } */
function makeZip(files) {
  const locals = [], central = [];
  let pos = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nb = Buffer.from(name, 'latin1'), crc = crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(10, 4); l.writeUInt32LE(crc, 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(10, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(pos, 42);
    locals.push(l, nb, data); central.push(c, nb);
    pos += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  const n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(pos, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * Minimal VBSP v20: entity lump, texdata strings, static prop game lump (v10 layout, 76-byte props) and pakfile.
 * @param {{entities?:object[], texdata?:string[], staticProps?:{model:string,skin?:number}[], pak?:object, pakLast?:boolean}} o
 */
function makeBSP({ entities = [], texdata = [], staticProps = [], pak = {}, pakLast = true } = {}) {
  const entText = entities.map((e) => `{\n${Object.entries(e).map(([k, v]) => `"${k}" "${v}"`).join('\n')}\n}\n`).join('') + '\0';
  const lumps = new Map();
  lumps.set(0, Buffer.from(entText, 'latin1'));
  lumps.set(43, Buffer.from(texdata.map((t) => `${t}\0`).join(''), 'latin1'));

  const models = [...new Set(staticProps.map((p) => p.model))];
  const sprp = Buffer.alloc(4 + models.length * 128 + 4 + 4 + staticProps.length * 76);
  let p = 0;
  sprp.writeInt32LE(models.length, p); p += 4;
  for (const m of models) { sprp.write(m, p, 'latin1'); p += 128; }
  sprp.writeInt32LE(0, p); p += 4; // leaves
  sprp.writeInt32LE(staticProps.length, p); p += 4;
  for (const sp of staticProps) { sprp.writeUInt16LE(models.indexOf(sp.model), p + 24); sprp.writeInt32LE(sp.skin || 0, p + 32); p += 76; }

  const zip = makeZip(pak);
  const header = Buffer.alloc(1036);
  header.write('VBSP', 0, 'latin1'); header.writeInt32LE(20, 4);
  const parts = [header];
  let pos = 1036;
  const place = (index, data) => {
    header.writeInt32LE(pos, 8 + index * 16); header.writeInt32LE(data.length, 12 + index * 16);
    parts.push(data); pos += data.length;
    const pad = (4 - (pos % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); pos += pad; }
  };
  place(0, lumps.get(0));
  if (!pakLast) place(40, zip);
  place(43, lumps.get(43));
  // game lump: directory (1 entry) immediately followed by the sprp data; offsets are absolute
  const dir = Buffer.alloc(4 + 16);
  dir.writeInt32LE(1, 0); dir.write('prps', 4, 'latin1'); dir.writeUInt16LE(0, 8); dir.writeUInt16LE(10, 10);
  dir.writeInt32LE(pos + dir.length, 12); dir.writeInt32LE(sprp.length, 16);
  place(35, Buffer.concat([dir, sprp]));
  if (pakLast) place(40, zip);
  return Buffer.concat(parts);
}

/** Garry's Mod addon archive. files: { 'path': Buffer|string } */
function makeGMA({ name = 'Test Addon', files = {}, timestamp = 1700000000 } = {}) {
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeUInt32LE(v % 4294967296, 0); b.writeUInt32LE(Math.floor(v / 4294967296), 4); parts.push(b); };
  const str = (s) => parts.push(Buffer.from(`${s}\0`, 'utf-8'));
  parts.push(Buffer.from('GMAD', 'latin1'), Buffer.from([3]));
  u64(0); u64(timestamp); parts.push(Buffer.from([0]));
  str(name); str(JSON.stringify({ description: 'd', type: 'model', tags: ['fun'] })); str('Author Name'); u32(1);
  const datas = Object.entries(files).map(([p, c]) => [p, Buffer.isBuffer(c) ? c : Buffer.from(c)]);
  datas.forEach(([fp, data], i) => { u32(i + 1); str(fp); u64(data.length); u32(crc32(data)); });
  u32(0);
  for (const [, data] of datas) parts.push(data);
  const body = Buffer.concat(parts);
  const tail = Buffer.alloc(4); tail.writeUInt32LE(crc32(body));
  return Buffer.concat([body, tail]);
}

/** The addon whose LZMA-compressed form is stored in lzma-vector.js (keep both in sync: npm run vector). */
function vectorGMA() {
  const filler = Buffer.alloc(3000);
  for (let i = 0; i < filler.length; i++) filler[i] = (i * 7 + (i >> 3)) & 0xff;
  return makeGMA({
    name: 'Compressed Addon',
    files: {
      'materials/ws/packed.vmt': '"VertexLitGeneric"\n{\n\t"$basetexture" "ws/packed"\n\t"$bumpmap" "ws/packed_n"\n}\n',
      'materials/ws/packed.vtf': Buffer.concat([Buffer.from('VTF-packed-'), filler]),
      'materials/ws/packed_n.vtf': Buffer.from('normal normal normal normal normal normal normal normal normal normal'.repeat(20)),
    },
  });
}

/** Gradient test image (RGBA8). */
function makeRGBA(w, h, alpha) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = (x * 255 / (w - 1)) | 0; d[i + 1] = (y * 255 / (h - 1)) | 0; d[i + 2] = ((x ^ y) & 8) ? 200 : 40; d[i + 3] = alpha ? (x * 255 / (w - 1)) | 0 : 255;
    }
  }
  return d;
}

/** Uncompressed single-mip VTF 7.2 (fmt 0 = RGBA8888, 3 = BGR888). */
function makeVTF(w, h, fmt, rgba, flags = 0) {
  const bpp = fmt === 0 ? 4 : 3;
  const data = Buffer.alloc(w * h * bpp);
  for (let i = 0; i < w * h; i++) {
    if (fmt === 0) data.set([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]], i * 4);
    else data.set([rgba[i * 4 + 2], rgba[i * 4 + 1], rgba[i * 4]], i * 3);
  }
  const hdr = Buffer.alloc(80);
  hdr.write('VTF\0', 0, 'latin1'); hdr.writeUInt32LE(7, 4); hdr.writeUInt32LE(2, 8); hdr.writeUInt32LE(80, 12);
  hdr.writeUInt16LE(w, 16); hdr.writeUInt16LE(h, 18); hdr.writeUInt32LE(flags, 20); hdr.writeUInt16LE(1, 24);
  hdr.writeInt32LE(fmt, 52); hdr[56] = 1; hdr.writeInt32LE(-1, 57); hdr.writeUInt16LE(1, 63);
  return Buffer.concat([hdr, data]);
}

module.exports = { makeMDL, makeZip, makeBSP, makeGMA, vectorGMA, makeRGBA, makeVTF };

/** Particle file, DMX "binary 2 format pcf 1". systems: [{ name, material, children?: string[] }] */
function makePCF(systems) {
  const dict = ['DmeElement', 'DmeParticleSystemDefinition', 'DmeParticleChild', 'particleSystemDefinitions', 'material', 'children', 'child'];
  const elements = [{ type: 0, name: 'root', attrs: [] }];
  const indexOf = new Map();
  systems.forEach((s) => { indexOf.set(s.name, elements.length); elements.push({ type: 1, name: s.name, attrs: [], sys: s }); });
  elements[0].attrs.push({ name: 3, type: 15, value: systems.map((s) => indexOf.get(s.name)) });
  for (const el of elements.slice()) {
    if (!el.sys) continue;
    el.attrs.push({ name: 4, type: 5, value: el.sys.material });
    const kids = (el.sys.children || []).map((c) => { elements.push({ type: 2, name: 'child', attrs: [{ name: 6, type: 1, value: indexOf.get(c) }] }); return elements.length - 1; });
    el.attrs.push({ name: 5, type: 15, value: kids });
  }
  const parts = [Buffer.from('<!-- dmx encoding binary 2 format pcf 1 -->\n\0', 'latin1')];
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); parts.push(b); };
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); };
  const str = (s) => parts.push(Buffer.from(`${s}\0`, 'latin1'));
  u16(dict.length); dict.forEach(str);
  i32(elements.length);
  for (const el of elements) { u16(el.type); str(el.name); parts.push(Buffer.alloc(16)); }
  for (const el of elements) {
    i32(el.attrs.length);
    for (const a of el.attrs) {
      u16(a.name); parts.push(Buffer.from([a.type]));
      if (a.type === 1) i32(a.value); else if (a.type === 5) str(a.value); else { i32(a.value.length); a.value.forEach(i32); }
    }
  }
  return Buffer.concat(parts);
}

/** VPK v1 whose files are stored inside the _dir file itself. files: { 'scripts/x.txt': Buffer|string } */
function makeVPKWithFiles(files) {
  const tree = [], data = [];
  let offset = 0;
  const str = (s) => tree.push(Buffer.from(`${s}\0`, 'latin1'));
  for (const [rel, content] of Object.entries(files)) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const ext = rel.slice(rel.lastIndexOf('.') + 1), dir = rel.slice(0, rel.lastIndexOf('/')), name = rel.slice(rel.lastIndexOf('/') + 1, rel.lastIndexOf('.'));
    str(ext); str(dir); str(name);
    const e = Buffer.alloc(18);
    e.writeUInt16LE(0, 4); e.writeUInt16LE(0x7fff, 6); e.writeUInt32LE(offset, 8); e.writeUInt32LE(body.length, 12); e.writeUInt16LE(0xffff, 16);
    tree.push(e); str(''); str('');
    data.push(body); offset += body.length;
  }
  str('');
  const t = Buffer.concat(tree), header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0); header.writeUInt32LE(1, 4); header.writeUInt32LE(t.length, 8);
  return Buffer.concat([header, t, ...data]);
}

module.exports.makePCF = makePCF;
module.exports.makeVPKWithFiles = makeVPKWithFiles;
