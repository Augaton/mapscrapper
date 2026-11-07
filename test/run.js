'use strict';
// Self-contained test-suite: builds a fake game folder (VPK, MDL, PCF, VMT, soundscapes...) and scrapes a VMF.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const kv = require('../src/kv');
const { parseMDL } = require('../src/mdl');
const { readVpkDir } = require('../src/vpk');
const { Scraper } = require('../src/scraper');
const { BSP } = require('../src/bsp');
const { makeBSP } = require('./fixtures');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

// ---------- builders ----------

function makeMDL({ textures = [], cdtextures = [], includes = [] }) {
  const buf = Buffer.alloc(4096);
  buf.write('IDST', 0, 'latin1');
  buf.writeInt32LE(48, 4);
  buf.write('test.mdl', 12, 'latin1');
  buf.writeInt32LE(4096, 76);
  let cursor = 408, strPos = 2048;
  const putStr = (s) => { const o = strPos; buf.write(`${s}\0`, o, 'latin1'); strPos += s.length + 1; return o; };
  buf.writeInt32LE(textures.length, 204); buf.writeInt32LE(cursor, 208);
  textures.forEach((t, i) => { const base = cursor + i * 64; buf.writeInt32LE(putStr(t) - base, base); });
  cursor += textures.length * 64;
  buf.writeInt32LE(cdtextures.length, 212); buf.writeInt32LE(cursor, 216);
  cdtextures.forEach((d, i) => buf.writeInt32LE(putStr(d), cursor + i * 4));
  cursor += cdtextures.length * 4;
  buf.writeInt32LE(includes.length, 336); buf.writeInt32LE(cursor, 340);
  includes.forEach((n, i) => { const base = cursor + i * 8; buf.writeInt32LE(0, base); buf.writeInt32LE(putStr(n) - base, base + 4); });
  return buf;
}

function makeVPK(entries) { // entries: ['materials/tools/toolsnodraw.vmt', ...]
  const byExt = new Map();
  for (const e of entries) {
    const ext = path.extname(e).slice(1), dir = path.dirname(e).replace(/\\/g, '/'), name = path.basename(e, path.extname(e));
    if (!byExt.has(ext)) byExt.set(ext, new Map());
    const d = byExt.get(ext);
    if (!d.has(dir)) d.set(dir, []);
    d.get(dir).push(name);
  }
  const parts = [];
  const str = (s) => parts.push(Buffer.from(`${s}\0`, 'latin1'));
  for (const [ext, dirs] of byExt) {
    str(ext);
    for (const [dir, names] of dirs) {
      str(dir);
      for (const n of names) {
        str(n);
        const e = Buffer.alloc(18);
        e.writeUInt32LE(0, 0); e.writeUInt16LE(0, 4); e.writeUInt16LE(0x7fff, 6); e.writeUInt32LE(0, 8); e.writeUInt32LE(1, 12); e.writeUInt16LE(0xffff, 16);
        parts.push(e);
      }
      str('');
    }
    str('');
  }
  str('');
  const tree = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x55aa1234, 0); header.writeUInt32LE(1, 4); header.writeUInt32LE(tree.length, 8);
  return Buffer.concat([header, tree]);
}

const ent = (classname, kvs) => `entity\n{\n\t"classname" "${classname}"\n${Object.entries(kvs).map(([k, v]) => `\t"${k}" "${v}"`).join('\n')}\n}\n`;

// ---------- unit tests ----------

console.log('kv');
test('parses quoted/unquoted keys, comments, conditionals, nested blocks', () => {
  const nodes = kv.parse(`// comment\n"LightmappedGeneric"\n{\n\t"$basetexture" "a/b" // c\n\t$bumpmap a/b_n [$hdr]\n\t>=DX90 { $detail "d" }\n\tProxies { Sine { } }\n}`);
  const flat = kv.flatten(nodes);
  assert.deepStrictEqual(flat.get('$basetexture'), ['a/b']);
  assert.deepStrictEqual(flat.get('$bumpmap'), ['a/b_n']);
  assert.deepStrictEqual(flat.get('$detail'), ['d']);
  assert.strictEqual(nodes[0].key, 'lightmappedgeneric');
});
test('handles BOM and unterminated quotes without throwing', () => {
  const nodes = kv.parse('﻿"name" { "wave" "x.wav" "broken');
  assert.strictEqual(nodes[0].key, 'name');
  assert.strictEqual([...kv.walk(nodes)].some((n) => n.key === 'wave' && n.value === 'x.wav'), true);
});

console.log('mdl');
test('reads textures, cdtextures and includemodels', () => {
  const info = parseMDL(makeMDL({ textures: ['crate', 'crate_lid'], cdtextures: ['models/props/', 'models/alt/'], includes: ['props/anim.mdl'] }));
  assert.deepStrictEqual(info.textures, ['crate', 'crate_lid']);
  assert.deepStrictEqual(info.textureDirs, ['models/props/', 'models/alt/']);
  assert.deepStrictEqual(info.includeModels, ['props/anim.mdl']);
});
test('rejects garbage', () => {
  assert.strictEqual(parseMDL(Buffer.alloc(10)), null);
  assert.strictEqual(parseMDL(Buffer.alloc(500)), null);
});

console.log('vpk');
test('reads a v1 directory tree', () => {
  const file = path.join(os.tmpdir(), `mapscraper_test_${process.pid}.vpk`);
  fs.writeFileSync(file, makeVPK(['materials/tools/toolsnodraw.vmt', 'models/props_c17/oildrum001.mdl', 'sound/x/y.wav']));
  const s = readVpkDir(file);
  fs.rmSync(file);
  assert.strictEqual(s.has('materials/tools/toolsnodraw.vmt'), true);
  assert.strictEqual(s.has('models/props_c17/oildrum001.mdl'), true);
  assert.strictEqual(s.size, 3);
});

console.log('vtf');
const vtf = require('../src/vtf');
const { optimizeTextures } = require('../src/optimize');
function makeRGBA(w, h, alpha) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    d[i] = (x * 255 / (w - 1)) | 0; d[i + 1] = (y * 255 / (h - 1)) | 0; d[i + 2] = ((x ^ y) & 8) ? 200 : 40; d[i + 3] = alpha ? (x * 255 / (w - 1)) | 0 : 255;
  }
  return d;
}
function makeVTF(w, h, fmt, rgba, minor = 2) { // uncompressed 8-bit writer for test fixtures (single mip, plus thumbnail)
  const bpp = { 0: 4, 12: 4, 2: 3, 5: 1 }[fmt];
  const data = Buffer.alloc(w * h * bpp);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (fmt === 0) data.set([r, g, b, a], i * 4);
    else if (fmt === 12) data.set([b, g, r, a], i * 4);
    else if (fmt === 2) data.set([r, g, b], i * 3);
    else data[i] = r;
  }
  const hdr = Buffer.alloc(minor >= 3 ? 96 : 80);
  hdr.write('VTF\0', 0, 'latin1'); hdr.writeUInt32LE(7, 4); hdr.writeUInt32LE(minor, 8); hdr.writeUInt32LE(hdr.length, 12);
  hdr.writeUInt16LE(w, 16); hdr.writeUInt16LE(h, 18); hdr.writeUInt32LE(fmt === 0 || fmt === 12 ? 0x2000 : 0, 20); hdr.writeUInt16LE(1, 24);
  hdr.writeInt32LE(fmt, 52); hdr[56] = 1; hdr.writeInt32LE(-1, 57); hdr.writeUInt16LE(1, 63);
  if (minor >= 3) { hdr.writeUInt32LE(2, 68); hdr.set([0x01, 0, 0, 2, 0, 0, 0, 0], 80); hdr.set([0x30, 0, 0, 0], 88); hdr.writeUInt32LE(96, 92); }
  return Buffer.concat([hdr, data]);
}
function psnr(a, b, skipAlpha) {
  let se = 0, n = 0;
  for (let i = 0; i < a.length; i++) { if (skipAlpha && (i & 3) === 3) continue; const d = a[i] - b[i]; se += d * d; n++; }
  return se ? 10 * Math.log10(255 * 255 / (se / n)) : 99;
}
test('parses 7.2 and 7.3 headers and decodes 8-bit formats', () => {
  const rgba = makeRGBA(64, 32, true);
  for (const [fmt, minor] of [[0, 2], [12, 3], [2, 2], [5, 5]]) {
    const buf = makeVTF(64, 32, fmt, rgba, minor);
    const h = vtf.parse(buf);
    assert.strictEqual(h.width, 64); assert.strictEqual(h.format, fmt); assert.strictEqual(h.minor, minor);
    const out = vtf.decode(buf, h);
    if (fmt === 0 || fmt === 12) assert.deepStrictEqual(out, rgba);
    else if (fmt === 2) for (let i = 0; i < out.length; i++) assert.strictEqual(out[i], (i & 3) === 3 ? 255 : rgba[i]);
    else for (let i = 0; i < out.length; i += 4) assert.strictEqual(out[i], rgba[i]);
  }
});
test('DXT1/DXT5 encode -> decode round trip is close to the source', () => {
  const rgba = makeRGBA(64, 64, true);
  const dxt5 = vtf.encodeDXT(rgba, 64, 64, 15);
  assert.strictEqual(dxt5.length, 16 * 16 * 16);
  const full = vtf.write({ mips: [{ rgba, w: 64, h: 64 }], fmt: 15, flags: 0 });
  const h = vtf.parse(full);
  assert.strictEqual(h.version, '7.2'); assert.strictEqual(h.format, 15); assert.strictEqual(h.lowWidth, 16);
  assert.ok(psnr(rgba, vtf.decode(full, h), false) > 30, 'DXT5 quality');
  const opaque = makeRGBA(64, 64, false);
  const full1 = vtf.write({ mips: [{ rgba: opaque, w: 64, h: 64 }], fmt: 13, flags: 0 });
  assert.ok(psnr(opaque, vtf.decode(full1, vtf.parse(full1)), true) > 30, 'DXT1 quality');
});
test('reencode: downscale, mip chain, alpha detection, flags', () => {
  const rgba = makeRGBA(256, 128, false);
  const src = makeVTF(256, 128, 0, rgba, 3);
  const h = vtf.parse(src);
  const r = vtf.reencode(src, h, { maxSize: 64 });
  assert.strictEqual(r.w, 64); assert.strictEqual(r.h, 32); assert.strictEqual(r.fmt, 13, 'opaque -> DXT1');
  const h2 = vtf.parse(r.buf);
  assert.strictEqual(h2.mipCount, 7); assert.strictEqual(h2.flags & 0x3000, 0, 'alpha flags cleared');
  assert.ok(r.buf.length < src.length / 10);
  const withA = vtf.reencode(makeVTF(64, 64, 12, makeRGBA(64, 64, true)), vtf.parse(makeVTF(64, 64, 12, makeRGBA(64, 64, true))), {});
  assert.strictEqual(withA.fmt, 15, 'alpha -> DXT5');
  assert.ok(vtf.parse(withA.buf).flags & 0x2000);
});
const optimizeTest = test('optimizeTextures: converts big/uncompressed, skips small, DXT and animated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscraper-opt-'));
  const big = makeVTF(1024, 1024, 0, makeRGBA(1024, 1024, false));
  fs.mkdirSync(path.join(dir, 'a'));
  fs.writeFileSync(path.join(dir, 'a', 'big.vtf'), big);
  fs.writeFileSync(path.join(dir, 'small.vtf'), makeVTF(64, 64, 0, makeRGBA(64, 64, false)));
  const anim = makeVTF(1024, 512, 0, makeRGBA(1024, 512, false)); anim.writeUInt16LE(2, 24);
  fs.writeFileSync(path.join(dir, 'anim.vtf'), anim);
  const res = await optimizeTextures(dir, { maxSize: 512 });
  assert.strictEqual(res.converted.length, 1);
  assert.strictEqual(res.converted[0].rel, 'a/big.vtf');
  assert.ok(res.converted[0].after < big.length / 20, 'size shrank a lot');
  assert.strictEqual(vtf.parse(fs.readFileSync(path.join(dir, 'a', 'big.vtf'))).width, 512);
  assert.ok(res.skipped.some((s) => s.rel === 'anim.vtf' && /animated/.test(s.reason)));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'small.vtf')).length, makeVTF(64, 64, 0, makeRGBA(64, 64, false)).length, 'small untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- integration: fake game ----------

console.log('scraper');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscraper-'));
const game = path.join(root, 'GarrysMod', 'garrysmod');
const out = path.join(root, 'out');
const W = (rel, content) => { const p = path.join(game, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

// materials
W('materials/wall/brick.vmt', '"LightmappedGeneric" { "$basetexture" "wall/brick" $bumpmap wall/brick_n "$envmap" "env_cubemap" include "materials/wall/base.vmt" }');
W('materials/wall/base.vmt', '"Patch" { "$detail" "wall/detail" }');
W('materials/wall/brick.vtf', 'vtf'); W('materials/wall/brick.hdr.vtf', 'vtf'); W('materials/wall/brick_n.vtf', 'vtf'); W('materials/wall/detail.vtf', 'vtf');
W('materials/sprites/glow.vmt', '"UnlitGeneric" { "$basetexture" "sprites/glow" }'); W('materials/sprites/glow.vtf', 'vtf');
for (const s of ['up', 'dn', 'lf', 'rt', 'ft', 'bk']) { W(`materials/skybox/sky_test${s}.vmt`, `"UnlitGeneric" { "$basetexture" "skybox/sky_test${s}" }`); W(`materials/skybox/sky_test${s}.vtf`, 'vtf'); }
W('materials/models/props/crate.vmt', '"VertexLitGeneric" { "$basetexture" "models/props/crate" }'); W('materials/models/props/crate.vtf', 'vtf');
W('materials/particle/custom_fx.vmt', '"SpriteCard" { "$basetexture" "particle/custom_fx" }'); W('materials/particle/custom_fx.vtf', 'vtf');
W('materials/water/pool.vmt', '"Water" { "$bottommaterial" "water/pool_bottom" "$refracttexture" "_rt_WaterRefraction" }');
W('materials/water/pool_bottom.vmt', '"Water" { }');
W('materials/dev/cc.vmt', '"UnlitGeneric" {}'); // referenced with $ and rt junk to be ignored
// models
W('models/props/crate.mdl', makeMDL({ textures: ['crate'], cdtextures: ['models/props/'], includes: ['props/anim.mdl'] }));
W('models/props/crate.vvd', 'vvd'); W('models/props/crate.dx90.vtx', 'vtx'); W('models/props/crate.phy', 'phy');
W('models/props/anim.mdl', makeMDL({}));
W('models/props/inst.mdl', makeMDL({}));
W('models/props/fxmodel.mdl', makeMDL({}));
// sounds
W('sound/amb/loop.wav', 'wav'); W('sound/door/open.wav', 'wav'); W('sound/ss/wind.wav', 'wav'); W('sound/ss/sub.wav', 'wav'); W('sound/misc/ext.wav', 'wav');
W('maps/test_level_sounds.txt', '"Test.Door" { "channel" "CHAN_STATIC" "wave" "^door/open.wav" }');
W('scripts/game_sounds_custom.txt', '"Ext.Sound" { "rndwave" { wave "misc/ext.wav" } }');
W('scripts/soundscapes_test.txt', '"test.room" { "playlooping" { "wave" "ss\\wind.wav" } "playsoundscape" { "name" "test.sub" } }\n"test.sub" { "playrandom" { "rndwave" { wave "ss/sub.wav" } } }');
// particles
W('particles/particles_manifest.txt', 'particles_manifest { "file" "particles/stock.pcf" }');
W('particles/stock.pcf', Buffer.from('\0stock_effect\0particle/stock.vmt\0', 'latin1'));
W('particles/custom.pcf', Buffer.from('pcf\0my_effect\0particle/custom_fx.vmt\0models/props/fxmodel.mdl\0', 'latin1'));
W('particles/other.pcf', Buffer.from('\0other_effect\0', 'latin1'));
// misc
W('maps/test.nav', 'nav'); W('maps/test.bsp', makeBSP({})); W('scenes/test/intro.vcd', 'vcd'); W('materials/correction/test.raw', 'raw');
W('detail.vbsp', 'vbsp');
// addon content + stock vpk
fs.mkdirSync(path.join(game, 'addons', 'myaddon', 'materials', 'addon'), { recursive: true });
fs.writeFileSync(path.join(game, 'addons', 'myaddon', 'materials', 'addon', 'thing.vmt'), '"LightmappedGeneric" { "$basetexture" "addon/thing" }');
fs.writeFileSync(path.join(game, 'addons', 'myaddon', 'materials', 'addon', 'thing.vtf'), 'vtf');
W('garrysmod_dir.vpk', makeVPK(['materials/tools/toolsnodraw.vmt', 'models/props_c17/oildrum001.mdl', 'materials/models/props_c17/oildrum001.vmt']));
// vmf + instance
const vmfDir = path.join(root, 'mapsrc');
fs.mkdirSync(path.join(vmfDir, 'instances'), { recursive: true });
fs.writeFileSync(path.join(vmfDir, 'instances', 'inst.vmf'), ent('prop_static', { model: 'models/props/inst.mdl' }));
const vmf = [
  'world\n{\n\t"classname" "worldspawn"\n\t"skyname" "sky_test"\n\t"detailvbsp" "detail.vbsp"\n\t"detailmaterial" "detail/detailsprites"\n',
  '\tsolid\n\t{\n\t\tside\n\t\t{\n\t\t\t"material" "WALL/BRICK"\n\t\t}\n\t\tside\n\t\t{\n\t\t\t"material" "TOOLS/TOOLSNODRAW"\n\t\t}\n\t\tside\n\t\t{\n\t\t\t"material" "WATER/POOL"\n\t\t}\n\t}\n}\n',
  ent('prop_static', { model: 'models/props/crate.mdl' }),
  ent('prop_physics', { model: 'models/props_c17/oildrum001.mdl' }),
  ent('prop_dynamic', { model: 'models/props/missing.mdl' }),
  ent('env_sprite', { model: 'sprites/glow.spr' }),
  ent('ambient_generic', { message: 'amb/loop.wav' }),
  ent('ambient_generic', { message: 'Test.Door' }),
  ent('ambient_generic', { message: 'Ext.Sound' }),
  ent('ambient_generic', { message: 'Doors.Stock' }),
  ent('func_door', { noise1: '0', locked_sound: '2', message: 'Some free text here' }),
  ent('env_soundscape', { soundscape: 'test.room' }),
  ent('info_particle_system', { effect_name: 'my_effect' }),
  ent('info_particle_system', { effect_name: 'stock_effect' }),
  ent('info_particle_system', { effect_name: 'other_effect' }),
  ent('info_particle_system', { effect_name: 'ghost_effect' }),
  ent('func_instance', { file: 'instances/inst.vmf' }),
  ent('infodecal', { texture: 'addon/thing' }),
  ent('logic_choreographed_scene', { SceneFile: 'scenes/test/intro.vcd' }),
  ent('color_correction', { filename: 'materials/correction/test.raw' }),
  ent('env_projectedtexture', { texturename: 'effects/flashlight001' }),
].join('');
const vmfPath = path.join(vmfDir, 'test.vmf');
fs.writeFileSync(vmfPath, vmf);

(async () => {
  await optimizeTest;
  const scraper = new Scraper({ gamepath: game, vmf: vmfPath, outputDir: out, cacheDir: path.join(root, 'cache') });
  const r = await scraper.run();
  const has = (rel) => fs.existsSync(path.join(out, rel));

  await test('materials, textures, hdr, include, $bottommaterial', () => {
    for (const f of ['materials/wall/brick.vmt', 'materials/wall/brick.vtf', 'materials/wall/brick.hdr.vtf', 'materials/wall/brick_n.vtf', 'materials/wall/base.vmt', 'materials/wall/detail.vtf', 'materials/water/pool.vmt', 'materials/water/pool_bottom.vmt']) assert.ok(has(f), f);
    assert.ok(!r.missing.some((m) => m.includes('_rt_') || m.includes('env_cubemap')), 'rt/env_cubemap ignored');
  });
  await test('skybox + sprites + addon search path + lowercase output', () => {
    for (const s of ['up', 'dn', 'lf', 'rt', 'ft', 'bk']) assert.ok(has(`materials/skybox/sky_test${s}.vmt`) && has(`materials/skybox/sky_test${s}.vtf`));
    assert.ok(has('materials/sprites/glow.vmt') && has('materials/sprites/glow.vtf'));
    assert.ok(has('materials/addon/thing.vmt') && has('materials/addon/thing.vtf'));
    assert.ok(r.searchPaths.some((p) => p.includes('myaddon')));
  });
  await test('models: variants, mdl materials, $includemodel, instance', () => {
    for (const f of ['models/props/crate.mdl', 'models/props/crate.vvd', 'models/props/crate.dx90.vtx', 'models/props/crate.phy', 'materials/models/props/crate.vmt', 'materials/models/props/crate.vtf', 'models/props/anim.mdl', 'models/props/inst.mdl']) assert.ok(has(f), f);
    assert.strictEqual(r.stats.instances, 1);
  });
  await test('sounds: files, prefixes, soundscripts (level_sounds + game_sounds), soundscapes + sub-soundscapes', () => {
    for (const f of ['sound/amb/loop.wav', 'sound/door/open.wav', 'sound/misc/ext.wav', 'sound/ss/wind.wav', 'sound/ss/sub.wav', 'maps/test_level_sounds.txt', 'scripts/soundscapes_test.txt', 'scripts/game_sounds_custom.txt']) assert.ok(has(f), f);
    assert.deepStrictEqual(r.unresolved.soundscripts, ['doors.stock']);
    assert.ok(r.notes.some((n) => n.includes('Ext.Sound') || n.includes('ext.sound')));
    assert.ok(r.packed.includes('maps/test_level_sounds.txt') || r.warnings.some((w) => w.includes('bspzip')));
  });
  await test('particles: effect lookup, stock skipped, manifest generated, pcf deps', () => {
    assert.ok(has('particles/custom.pcf') && has('particles/other.pcf'), 'custom pcfs copied');
    assert.ok(!has('particles/stock.pcf'), 'stock pcf not copied');
    assert.ok(has('materials/particle/custom_fx.vmt') && has('models/props/fxmodel.mdl'), 'pcf dependencies');
    assert.deepStrictEqual(r.unresolved.effects, ['ghost_effect']);
    const manifest = fs.readFileSync(path.join(out, 'maps/test_particles.txt'), 'utf-8');
    assert.ok(manifest.includes('particles/custom.pcf') && manifest.includes('particles/other.pcf') && !manifest.includes('stock.pcf'));
  });
  await test('misc files, stock vs missing classification, bsp', () => {
    for (const f of ['maps/test.nav', 'maps/test.bsp', 'scenes/test/intro.vcd', 'materials/correction/test.raw']) assert.ok(has(f), f);
    assert.ok(!has('detail.vbsp'), 'stock detail.vbsp skipped');
    assert.ok(r.stock.includes('models/props_c17/oildrum001.mdl') && r.stock.includes('materials/tools/toolsnodraw.vmt'), 'stock detected via vpk');
    assert.ok(r.missing.includes('models/props/missing.mdl'), 'missing model reported');
    assert.ok(r.missing.includes('materials/effects/flashlight001.vtf'), 'texturename reported');
    assert.ok(!r.missing.includes('materials/effects/flashlight001.vmt'), 'optional vmt not reported');
    assert.ok(!r.missing.some((m) => m.includes('some free text')), 'free text ignored');
    // files a workshop .gma cannot hold are embedded in the output BSP by the native pakfile writer
    const bsp = new BSP(path.join(out, 'maps/test.bsp'));
    try {
      for (const f of ['maps/test_level_sounds.txt', 'scripts/soundscapes_test.txt', 'maps/test_particles.txt', 'materials/correction/test.raw', 'scripts/game_sounds_custom.txt']) assert.ok(bsp.pak().has(f), `${f} embedded in the BSP`);
      assert.ok(bsp.pak().read('maps/test_particles.txt').toString().includes('particles/custom.pcf'));
    } finally { bsp.close(); }
    assert.deepStrictEqual([...r.packed].sort(), [...r.notGmaAllowed].sort());
  });
  await test('extract toggles are respected', async () => {
    const s2 = new Scraper({ gamepath: game, vmf: vmfPath, outputDir: `${out}2`, cacheDir: path.join(root, 'cache'), extract: { materials: false, models: true, sounds: false, others: false } });
    const r2 = await s2.run();
    assert.strictEqual(r2.stats.materials, 0);
    assert.ok(r2.stats.models > 0);
    assert.strictEqual(r2.stats.sounds, 0);
    assert.strictEqual(r2.stats.particles, 0);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
