'use strict';
// Tests for the v2.1 features: LZMA / GMA / workshop index, BSP reader + native pakfile writer, skin pruning,
// BSP-driven scraping, incremental mode, workshop exclusion / extraction, .gma writer, --keep-normals, CLI settings.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decompressAlone } = require('../src/lzma');
const { parseHeader, readGMA, WorkshopIndex } = require('../src/gma');
const { BSP, packFiles } = require('../src/bsp');
const { parseMDL, texturesForSkins } = require('../src/mdl');
const { isGmaAllowed, buildGMAs, writeAddonJson } = require('../src/publish');
const { optimizeTextures } = require('../src/optimize');
const { Scraper } = require('../src/scraper');
const vtf = require('../src/vtf');
const { crc32 } = require('../src/crc32');
const { makeT } = require('../src/i18n');
const F = require('./fixtures');
const vector = require('./lzma-vector');

let passed = 0;
/** Counts event-loop turns until the returned stop() is called: a step that blocks the loop leaves it near 0. */
function loopTurns() {
  let turns = 0, on = true;
  const spin = () => { turns++; if (on) setImmediate(spin); };
  setImmediate(spin);
  return () => { on = false; return turns; };
}
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscraper-v21-'));
const game = path.join(root, 'steamapps', 'common', 'GarrysMod', 'garrysmod');
const content = path.join(root, 'steamapps', 'workshop', 'content', '4000');
const cacheDir = path.join(root, 'cache');
const put = (base, rel, data) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const W = (rel, data) => put(game, rel, data);
const vmt = (tex, extra = '') => `"VertexLitGeneric"\n{\n\t"$basetexture" "${tex}"\n${extra}}\n`;

(async () => {
  console.log('lzma / gma');
  await test('lzma: decodes an xz-made .lzma stream (unknown size + end marker)', () => {
    assert.ok(decompressAlone(vector).equals(F.vectorGMA()));
  });

  const rawGma = F.makeGMA({ name: 'Raw Addon', files: { 'materials/ws/raw.vmt': vmt('ws/raw'), 'materials/ws/raw.vtf': 'RAW-VTF-DATA' } });
  const ownGma = F.makeGMA({ name: 'My Content Pack', files: { 'materials/brick/wall.vtf': 'same path, other bytes' } });
  put(content, '111/raw.gma', rawGma);
  put(content, '222/123_legacy.bin', vector);
  put(content, '333/pack.gma', ownGma);
  W('materials/.keep', '');

  await test('gma: header + file table of raw and LZMA-compressed addons', () => {
    const h = parseHeader(rawGma);
    assert.strictEqual(h.name, 'Raw Addon');
    assert.deepStrictEqual(h.files.map((f) => f.path), ['materials/ws/raw.vmt', 'materials/ws/raw.vtf']);
    assert.strictEqual(rawGma.subarray(h.dataOffset + h.files[1].offset, h.dataOffset + h.files[1].offset + h.files[1].size).toString(), 'RAW-VTF-DATA');
    const c = readGMA(path.join(content, '222', '123_legacy.bin'));
    assert.strictEqual(c.compressed, true);
    assert.strictEqual(c.name, 'Compressed Addon');
    assert.strictEqual(c.files.length, 3);
  });

  await test('workshop index: providers, cache reuse, extraction from raw and compressed addons', () => {
    const ix = new WorkshopIndex(game, { cacheDir }).build();
    assert.strictEqual(ix.addons.length, 3);
    assert.deepStrictEqual(ix.providers('materials/ws/raw.vtf').map((a) => a.id), ['111']);
    assert.deepStrictEqual(ix.providers('materials/ws/packed_n.vtf').map((a) => a.id), ['222']);
    assert.strictEqual(ix.providers('materials/nope.vtf').length, 0);
    const a = ix.extract('materials/ws/raw.vtf');
    assert.strictEqual(fs.readFileSync(a.path, 'utf-8'), 'RAW-VTF-DATA');
    // out-of-order extraction from the LZMA stream (the second request forces a decoder restart)
    const n = ix.extract('materials/ws/packed_n.vtf'), v = ix.extract('materials/ws/packed.vmt');
    const expected = parseHeader(F.vectorGMA());
    const body = (i) => F.vectorGMA().subarray(expected.dataOffset + expected.files[i].offset, expected.dataOffset + expected.files[i].offset + expected.files[i].size);
    assert.ok(fs.readFileSync(n.path).equals(body(2)));
    assert.ok(fs.readFileSync(v.path).equals(body(0)));
    assert.strictEqual(crc32(fs.readFileSync(v.path)), expected.files[0].crc);
    ix.close();
    const again = new WorkshopIndex(game, { cacheDir }).build(); // served from the json cache
    assert.strictEqual(again.byPath.size, ix.byPath.size);
  });

  console.log('bsp');
  const bspBuf = F.makeBSP({
    entities: [
      { classname: 'worldspawn', skyname: 'sky_x' },
      { classname: 'prop_dynamic', targetname: 'door1', model: 'models/props/dyn.mdl', skin: '0' },
      { classname: 'logic_relay', OnTrigger: 'door1,Skin,1,0,-1' },
      { classname: 'infodecal', texture: 'ws/raw' },
      { classname: 'infodecal', texture: 'ws/packed' },
      { classname: 'env_soundscape', soundscape: 't2.room' },
    ],
    texdata: ['BRICK/WALL', 'maps/test2/brick/wall_10_20_30'],
    staticProps: [{ model: 'models/props/multi.mdl', skin: 1 }, { model: 'models/props/multi.mdl', skin: 1 }],
    pak: {
      'materials/maps/test2/brick/wall_10_20_30.vmt': '"patch"\n{\n\t"include" "materials/BRICK/WALL.vmt"\n\t"replace"\n\t{\n\t\t"$envmap" "maps/test2/c10_20_30"\n\t}\n}\n',
      'materials/maps/test2/c10_20_30.vtf': 'CUBEMAP',
    },
  });
  const bspFile = W('maps/test2.bsp', bspBuf);

  await test('bsp: entities, texdata, static prop skins and pakfile', () => {
    const b = new BSP(bspFile);
    try {
      assert.strictEqual(b.entities().length, 6);
      assert.deepStrictEqual(b.texdataStrings(), ['BRICK/WALL', 'maps/test2/brick/wall_10_20_30']);
      assert.deepStrictEqual([...b.staticProps()], [['models/props/multi.mdl', new Set([1])]]);
      assert.strictEqual(b.pak().size, 2);
      assert.strictEqual(b.pak().read('materials/maps/test2/c10_20_30.vtf').toString(), 'CUBEMAP');
      assert.strictEqual(b.isCompressed(), false);
    } finally { b.close(); }
  });

  await test('bsp: native pakfile writer adds and replaces entries (pak last or not)', () => {
    for (const pakLast of [true, false]) {
      const src = put(root, `pack/src_${pakLast}.bsp`, F.makeBSP({ entities: [{ classname: 'worldspawn' }], texdata: ['A/B'], staticProps: [{ model: 'models/a.mdl', skin: 2 }], pak: { 'materials/keep.vmt': 'KEEP', 'scripts/old.txt': 'OLD' }, pakLast }));
      const add = put(root, 'pack/new.txt', 'NEW CONTENT'), repl = put(root, 'pack/old.txt', 'REPLACED');
      const dest = path.join(root, `pack/out_${pakLast}.bsp`);
      assert.deepStrictEqual(packFiles(src, dest, [{ rel: 'maps/x_particles.txt', abs: add }, { rel: 'scripts/old.txt', abs: repl }]), { added: 1, replaced: 1 });
      const b = new BSP(dest);
      try {
        assert.strictEqual(b.pak().size, 3);
        assert.strictEqual(b.pak().read('materials/keep.vmt').toString(), 'KEEP');
        assert.strictEqual(b.pak().read('scripts/old.txt').toString(), 'REPLACED');
        assert.strictEqual(b.pak().read('maps/x_particles.txt').toString(), 'NEW CONTENT');
        assert.deepStrictEqual(b.texdataStrings(), ['A/B']); // other lumps untouched
        assert.deepStrictEqual([...b.staticProps().get('models/a.mdl')], [2]);
      } finally { b.close(); }
    }
  });

  console.log('skins');
  await test('mdl: skin families -> textures actually used', () => {
    const info = parseMDL(F.makeMDL({ textures: ['a', 'b', 'shared'], cdtextures: ['models/props/'], skins: [[0, 2], [1, 2]] }));
    assert.deepStrictEqual(info.skins, [[0, 2], [1, 2]]);
    assert.deepStrictEqual([...texturesForSkins(info, [1])].sort(), [1, 2]);
    assert.deepStrictEqual([...texturesForSkins(info, [0, 7])].sort(), [0, 2]); // out of range falls back to skin 0
    assert.strictEqual(texturesForSkins(info, [-1]), null);
  });

  await test('mdl: only the slots used by meshes count (alternative skin textures are not part of skin 0)', () => {
    const book = parseMDL(F.makeMDL({ textures: ['pages', 'cover', 'cover_red', 'cover_blue'], cdtextures: ['models/b/'], skins: [[0, 1, 2, 3], [0, 2, 2, 3], [0, 3, 2, 3]], meshes: [0, 1] }));
    assert.deepStrictEqual([...book.meshSlots], [0, 1]);
    assert.deepStrictEqual([...texturesForSkins(book, [0])].sort(), [0, 1]);
    assert.deepStrictEqual([...texturesForSkins(book, [2])].sort(), [0, 3]);
    assert.deepStrictEqual([...texturesForSkins(book, [0, 1, 2])].sort(), [0, 1, 2, 3]);
    const bogus = parseMDL(F.makeMDL({ textures: ['a', 'b'], skins: [[0, 1]], meshes: [7] }));
    assert.strictEqual(bogus.meshSlots.size, 0, 'a slot outside the skin table disables slot pruning');
    assert.deepStrictEqual([...texturesForSkins(bogus, [0])].sort(), [0, 1]);
    const { vtxReplacementMaterials } = require('../src/mdl');
    const vtx = Buffer.alloc(200); vtx.writeInt32LE(1, 20); vtx.writeInt32LE(40, 24); vtx.writeInt32LE(1, 40); vtx.writeInt32LE(8, 44); vtx.writeInt16LE(0, 48); vtx.writeInt32LE(20, 50); vtx.write('lod_cover', 68, 'latin1');
    assert.deepStrictEqual(vtxReplacementMaterials(vtx), ['lod_cover']);
    assert.deepStrictEqual(vtxReplacementMaterials(Buffer.alloc(10)), []);
  });

  // game content for the BSP-driven scrapes
  W('models/props/multi.mdl', F.makeMDL({ textures: ['skin_a', 'skin_b', 'shared'], cdtextures: ['models/props/'], skins: [[0, 2], [1, 2]] }));
  W('models/props/multi.vvd', 'vvd'); W('models/props/multi.dx90.vtx', 'vtx');
  W('models/props/dyn.mdl', F.makeMDL({ textures: ['dyn_a', 'dyn_b'], cdtextures: ['models/props/'], skins: [[0], [1]] }));
  W('models/props/dyn.vvd', 'vvd'); W('models/props/dyn.dx80.vtx', 'old vtx only');
  for (const t of ['skin_a', 'skin_b', 'shared', 'dyn_a', 'dyn_b']) { W(`materials/models/props/${t}.vmt`, vmt(`models/props/${t}`)); W(`materials/models/props/${t}.vtf`, t); }
  W('materials/brick/wall.vmt', vmt('brick/wall', '\t"$bumpmap" "brick/wall_n"\n')); W('materials/brick/wall.vtf', 'wall'); W('materials/brick/wall_n.vtf', 'wall normal');
  W('scripts/soundscapes_other.txt', '"t2.room" { "playlooping" { "wave" "amb/room.wav" } }'); W('sound/amb/room.wav', 'wav');
  const scrape = async (name, extra) => {
    const s = new Scraper({ gamepath: game, bsp: bspFile, outputDir: path.join(root, name), cacheDir, ...extra });
    const r = await s.run();
    return { r, has: (rel) => fs.existsSync(path.join(root, name, rel)) };
  };

  console.log('scraper (from a BSP)');
  await test('bsp mode: used skins only, Skin inputs keep every skin, pak content is not duplicated', async () => {
    const { r, has } = await scrape('out_bsp');
    assert.ok(has('models/props/multi.mdl') && has('materials/models/props/skin_b.vmt') && has('materials/models/props/shared.vtf'));
    assert.ok(!has('materials/models/props/skin_a.vmt'), 'material of the unused skin is skipped');
    assert.strictEqual(r.stats.skinPruned, 1);
    assert.ok(has('materials/models/props/dyn_a.vmt') && has('materials/models/props/dyn_b.vmt'), 'entity targeted by a Skin input keeps all skins');
    assert.ok(has('models/props/dyn.dx80.vtx'), 'falls back to the only .vtx available');
    assert.ok(has('materials/brick/wall.vmt') && has('materials/brick/wall.vtf') && has('materials/brick/wall_n.vtf'), 'texdata + include of the patched material');
    assert.ok(!has('materials/maps/test2/c10_20_30.vtf') && !has('materials/maps/test2/brick/wall_10_20_30.vmt'), 'pak files are not copied');
    assert.strictEqual(r.stats.inBsp, 2);
    assert.ok(r.normalMaps.includes('materials/brick/wall_n.vtf'));
    assert.ok(has('sound/amb/room.wav'));
    const b = new BSP(path.join(root, 'out_bsp', 'maps/test2.bsp'));
    try { assert.strictEqual(b.pak().read('scripts/soundscapes_other.txt').toString().includes('t2.room'), true); assert.strictEqual(b.pak().size, 3); } finally { b.close(); }
    assert.deepStrictEqual(r.packed, ['scripts/soundscapes_other.txt']);
  });

  await test('the BSP step lets the console redraw (status shown while packing)', async () => {
    const t = makeT('en');
    let current = '', seen = null;
    await scrape('out_bsp_ui', { onStatus: (m) => { current = m; if (m === t('phase.pack')) setImmediate(() => { seen = current; }); } });
    assert.strictEqual(seen, t('phase.pack'));
  });

  await test('Valve tools (bspzip, compression) run without blocking the event loop', async () => {
    const s = new Scraper({ gamepath: game, bsp: bspFile, outputDir: path.join(root, 'out_tool'), cacheDir });
    const stop = loopTurns();
    const r = await s.runTool(process.execPath, ['-e', 'setTimeout(() => { console.error("boom"); process.exit(3); }, 150)']);
    const turns = stop();
    assert.deepStrictEqual([r.ok, r.status, r.output], [false, 3, 'boom']);
    assert.ok(turns > 10, `turns=${turns}`);
    assert.strictEqual((await s.runTool(path.join(root, 'no-such-tool.exe'), [])).ok, false, 'a missing tool fails cleanly');
  });

  await test('--all-skins copies every skin', async () => {
    const { r, has } = await scrape('out_allskins', { allSkins: true });
    assert.ok(has('materials/models/props/skin_a.vmt'));
    assert.strictEqual(r.stats.skinPruned, 0);
  });

  console.log('scraper (workshop)');
  await test('files only present in installed workshop addons are attributed to them', async () => {
    const { r, has } = await scrape('out_ws');
    assert.deepStrictEqual(r.workshopMissing, ['materials/ws/packed.vmt', 'materials/ws/raw.vmt']);
    assert.deepStrictEqual(r.workshop.required.map((a) => a.id).sort(), ['111', '222']);
    assert.ok(r.workshopProviders['materials/ws/raw.vmt'].startsWith('111 '));
    assert.ok(!has('materials/ws/raw.vmt'));
    assert.deepStrictEqual(r.missing.filter((m) => !m.startsWith('materials/skybox/sky_x')), [], 'only the (absent) skybox is really missing');
    assert.strictEqual(r.missing.length, 6);
  });

  await test('--from-workshop extracts them (and follows their dependencies)', async () => {
    const { r, has } = await scrape('out_fromws', { fromWorkshop: true });
    for (const f of ['materials/ws/raw.vmt', 'materials/ws/raw.vtf', 'materials/ws/packed.vmt', 'materials/ws/packed.vtf', 'materials/ws/packed_n.vtf']) assert.ok(has(f), f);
    assert.strictEqual(fs.readFileSync(path.join(root, 'out_fromws', 'materials/ws/raw.vtf'), 'utf-8'), 'RAW-VTF-DATA');
    assert.deepStrictEqual(r.workshop.extracted.map((a) => a.id).sort(), ['111', '222']);
    assert.deepStrictEqual(r.workshopMissing, []);
  });

  await test('--exclude-workshop leaves out what the given item already provides', async () => {
    const { r, has } = await scrape('out_exclude', { excludeWorkshop: ['333'] });
    assert.ok(!has('materials/brick/wall.vtf') && has('materials/brick/wall.vmt') && has('materials/brick/wall_n.vtf'));
    assert.deepStrictEqual(r.workshop.excluded.map((a) => [a.id, a.name, a.files]), [['333', 'My Content Pack', 1]]);
  });

  console.log('incremental / safety');
  const ent = (cls, kvs) => `entity\n{\n\t"classname" "${cls}"\n${Object.entries(kvs).map(([k, v]) => `\t"${k}" "${v}"`).join('\n')}\n}\n`;
  const vmfFile = path.join(root, 'src', 'inc.vmf');
  fs.mkdirSync(path.dirname(vmfFile), { recursive: true });
  await test('--incremental: nothing rewritten on the second run, stale files removed afterwards', async () => {
    const outDir = path.join(root, 'out_inc');
    const run = async () => new Scraper({ gamepath: game, vmf: vmfFile, outputDir: outDir, cacheDir, incremental: true }).run();
    fs.writeFileSync(vmfFile, ent('prop_static', { model: 'models/props/multi.mdl', skin: '0' }) + ent('prop_dynamic', { model: 'models/props/dyn.mdl' }));
    const r1 = await run();
    assert.ok(r1.stats.written > 5 && r1.stats.kept === 0 && !r1.incremental);
    assert.ok(fs.existsSync(path.join(outDir, 'materials/models/props/skin_a.vtf')) && !fs.existsSync(path.join(outDir, 'materials/models/props/skin_b.vtf')));
    const stamp = fs.statSync(path.join(outDir, 'models/props/multi.mdl')).mtimeMs;
    const r2 = await run();
    assert.strictEqual(r2.stats.written, 0);
    assert.strictEqual(r2.stats.kept, r1.stats.written);
    assert.strictEqual(fs.statSync(path.join(outDir, 'models/props/multi.mdl')).mtimeMs, stamp);
    fs.writeFileSync(vmfFile, ent('prop_static', { model: 'models/props/multi.mdl', skin: '1' }));
    const r3 = await run();
    assert.ok(r3.stats.stale >= 4, `stale=${r3.stats.stale}`);
    assert.ok(!fs.existsSync(path.join(outDir, 'models/props/dyn.mdl')) && !fs.existsSync(path.join(outDir, 'materials/models/props/skin_a.vtf')));
    assert.ok(fs.existsSync(path.join(outDir, 'materials/models/props/skin_b.vtf')));
    assert.ok(!fs.existsSync(path.join(outDir, 'models/props/dyn.vvd')) && !fs.existsSync(path.join(outDir, 'materials/models/props')) === false);
  });

  await test('an interrupted copy never leaves a truncated file that a later --incremental run would keep', async () => {
    const outDir = path.join(root, 'out_cut');
    fs.writeFileSync(vmfFile, ent('prop_static', { model: 'models/props/multi.mdl', skin: '0' }) + ent('prop_dynamic', { model: 'models/props/dyn.mdl' }));
    const make = (incremental) => new Scraper({ gamepath: game, vmf: vmfFile, outputDir: outDir, cacheDir, incremental, copyThreads: 2 });
    await make(false).run(); // a complete extraction: its state file stays behind
    const real = fs.promises.copyFile;
    let calls = 0;
    fs.promises.copyFile = async (src, dest) => { // the 3rd copy dies half-way (Ctrl+C, full disk...)
      if (++calls === 3) { fs.writeFileSync(dest, 'TRUNC'); const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; }
      return real(src, dest);
    };
    try { await assert.rejects(() => make(false).run(), /disk full/); } finally { fs.promises.copyFile = real; }
    put(outDir, 'materials/leftover.vmt.mstmp', 'left by a killed run');
    const r = await make(true).run();
    const bad = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name), rel = path.relative(outDir, p), src = path.join(game, rel);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.mstmp') || (fs.existsSync(src) && !fs.readFileSync(src).equals(fs.readFileSync(p)))) bad.push(rel);
      }
    })(outDir);
    assert.deepStrictEqual(bad, [], 'every output file is complete');
    assert.ok(r.stats.written >= 1, 'what the failed run did not copy is copied now');
  });

  await test('refuses to wipe a folder that holds foreign files', async () => {
    const outDir = path.join(root, 'documents');
    put(outDir, 'thesis.docx', 'precious');
    await assert.rejects(() => new Scraper({ gamepath: game, vmf: vmfFile, outputDir: outDir, cacheDir }).run(), /Refusing to clear/);
    assert.strictEqual(fs.readFileSync(path.join(outDir, 'thesis.docx'), 'utf-8'), 'precious');
  });

  console.log('publish');
  await test('gma whitelist', () => {
    for (const ok of ['maps/x.bsp', 'maps/graphs/x.ain', 'maps/thumb/x.png', 'materials/a/b.vmt', 'models/a.dx90.vtx', 'sound/a b/c.wav', 'particles/x.pcf', 'scenes/a/b.vcd', 'scripts/vehicles/jeep.txt']) assert.ok(isGmaAllowed(ok), ok);
    for (const no of ['scripts/soundscapes_x.txt', 'maps/x_particles.txt', 'maps/x_level_sounds.txt', 'detail.vbsp', 'materials/correction/x.raw', 'addon.json', 'models/a.dx90.vtx.bak']) assert.ok(!isGmaAllowed(no), no);
  });

  await test('native .gma writer: whitelist filter, map first, split into parts, contents intact, console kept alive', async () => {
    const dir = path.join(root, 'addon');
    const files = { 'maps/x.bsp': Buffer.alloc(3000, 1), 'materials/a.vmt': 'AAA', 'materials/b.vtf': Buffer.alloc(5000, 2), 'sound/c.wav': Buffer.alloc(4000, 3), 'scripts/soundscapes_x.txt': 'nope' };
    for (const [rel, data] of Object.entries(files)) put(dir, rel, data);
    const json = writeAddonJson(dir, { title: 'x', tags: ['Build', 'bogus'], ignore: ['scripts/soundscapes_x.txt'] });
    assert.deepStrictEqual([json.type, json.tags, json.ignore], ['map', ['build'], ['scripts/soundscapes_x.txt']]);
    const stop = loopTurns();
    const res = await buildGMAs({ dir, outBase: path.join(root, 'addon_out'), title: 'My Map', tags: ['roleplay'], splitBytes: 9000 });
    const turns = stop();
    assert.ok(turns >= 4, `the event loop turned while the archives were written (${turns} turns)`);
    assert.deepStrictEqual(res.rejected, ['scripts/soundscapes_x.txt']);
    assert.strictEqual(res.archives.length, 2);
    const seen = [];
    res.archives.forEach((a, i) => {
      const g = readGMA(a.file), raw = fs.readFileSync(a.file);
      assert.strictEqual(g.name, `My Map (part ${i + 1}/2)`);
      assert.strictEqual(raw.readUInt32LE(raw.length - 4), crc32(raw.subarray(0, raw.length - 4)), 'trailing archive crc');
      for (const f of g.files) {
        const body = raw.subarray(g.dataOffset + f.offset, g.dataOffset + f.offset + f.size);
        assert.ok(body.equals(Buffer.from(files[f.path])), f.path);
        assert.strictEqual(crc32(body), f.crc);
        seen.push(f.path);
      }
    });
    assert.deepStrictEqual(seen, ['maps/x.bsp', 'materials/a.vmt', 'materials/b.vtf', 'sound/c.wav']);
    const single = await buildGMAs({ dir, outBase: path.join(root, 'addon_single'), title: 'My Map', tags: [] });
    assert.deepStrictEqual(single.archives.map((a) => path.basename(a.file)), ['addon_single.gma']);
  });

  console.log('optimiser');
  await test('--keep-normals: normal maps are resized but never DXT-compressed', async () => {
    const dir = path.join(root, 'opt');
    put(dir, 'materials/n/wall.vmt', vmt('n/wall', '\t"$bumpmap" "n/wall_bumpy"\n'));
    put(dir, 'materials/n/wall.vtf', F.makeVTF(1024, 1024, 0, F.makeRGBA(1024, 1024, false)));
    put(dir, 'materials/n/wall_bumpy.vtf', F.makeVTF(1024, 1024, 0, F.makeRGBA(1024, 1024, false)));
    put(dir, 'materials/n/flagged.vtf', F.makeVTF(1024, 512, 3, F.makeRGBA(1024, 512, false), vtf.FLAGS.NORMAL));
    put(dir, 'materials/n/small_n.vtf', F.makeVTF(512, 512, 0, F.makeRGBA(512, 512, true)));
    const res = await optimizeTextures(dir, { maxSize: 512, keepNormals: true, threads: 2 });
    const fmtOf = (rel) => { const h = vtf.parse(fs.readFileSync(path.join(dir, rel))); return [h.formatName, h.width, h.height]; };
    assert.deepStrictEqual(fmtOf('materials/n/wall.vtf'), ['DXT1', 512, 512]);
    assert.deepStrictEqual(fmtOf('materials/n/wall_bumpy.vtf'), ['BGR888', 512, 512]);
    assert.deepStrictEqual(fmtOf('materials/n/flagged.vtf'), ['BGR888', 512, 256]);
    assert.deepStrictEqual(fmtOf('materials/n/small_n.vtf'), ['RGBA8888', 512, 512]); // within the cap: untouched
    assert.deepStrictEqual([res.converted.length, res.cappedNormals, res.keptNormals], [3, 2, 1]);
    const h = vtf.parse(fs.readFileSync(path.join(dir, 'materials/n/flagged.vtf')));
    assert.ok(h.flags & vtf.FLAGS.NORMAL, 'flags preserved');
    assert.ok(vtf.decode(fs.readFileSync(path.join(dir, 'materials/n/flagged.vtf')), h).length === 512 * 256 * 4);
  });

  await test('lossless pass: DXT5 with an unused alpha becomes DXT1 with identical pixels', async () => {
    const opaque = vtf.write({ mips: [{ rgba: F.makeRGBA(64, 64, false), w: 64, h: 64 }, { rgba: F.makeRGBA(32, 32, false), w: 32, h: 32 }], fmt: 15, flags: 0x2000 });
    // force the "endpoints in the wrong order" and "equal endpoints" paths on the first two blocks of the top mip
    const top = opaque.length - 16 * 16 * 16;
    const c0 = opaque.readUInt16LE(top + 8), c1 = opaque.readUInt16LE(top + 10);
    opaque.writeUInt16LE(Math.min(c0, c1), top + 8); opaque.writeUInt16LE(Math.max(c0, c1), top + 10);
    opaque.writeUInt16LE(0x1234, top + 16 + 8); opaque.writeUInt16LE(0x1234, top + 16 + 10); opaque.writeUInt32LE(0xe4e4e4e4, top + 16 + 12);
    const h = vtf.parse(opaque), slim = vtf.stripOpaqueAlpha(opaque, h), h2 = vtf.parse(slim);
    assert.deepStrictEqual([h2.formatName, h2.width, h2.mipCount, h2.flags & 0x3000], ['DXT1', 64, 2, 0]);
    assert.ok(slim.length < opaque.length * 0.6);
    assert.deepStrictEqual(vtf.decode(slim, h2), vtf.decode(opaque, h));
    const withAlpha = vtf.write({ mips: [{ rgba: F.makeRGBA(64, 64, true), w: 64, h: 64 }], fmt: 15, flags: 0x2000 });
    assert.strictEqual(vtf.stripOpaqueAlpha(withAlpha, vtf.parse(withAlpha)), null, 'a used alpha channel is never dropped');
    const dir = path.join(root, 'opt_lossless');
    const big = (alpha) => vtf.write({ mips: [{ rgba: F.makeRGBA(256, 256, alpha), w: 256, h: 256 }], fmt: 15, flags: 0x2000 }); // above the 16 KB floor
    put(dir, 'materials/a/opaque.vtf', big(false)); put(dir, 'materials/a/alpha.vtf', big(true));
    const res = await optimizeTextures(dir, { threads: 1 });
    assert.deepStrictEqual([res.lossless, res.converted.length, res.untouched], [1, 1, 1]);
    assert.strictEqual(vtf.parse(fs.readFileSync(path.join(dir, 'materials/a/alpha.vtf'))).formatName, 'DXT5');
  });

  console.log('analysis coverage');
  await test('conditional VMT keys, $fallbackmaterial, startexture and gib models from MDL $keyvalues', async () => {
    W('materials/cov/wall.vmt', '"LightmappedGeneric"\n{\n\t"srgb?$basetexture" "cov/wall_srgb"\n\t"$fallbackmaterial" "cov/wall_dx8"\n}\n');
    W('materials/cov/wall_srgb.vtf', 'x'); W('materials/cov/wall_dx8.vmt', vmt('cov/wall_dx8')); W('materials/cov/wall_dx8.vtf', 'x');
    W('materials/skybox/stars.vtf', 'stars');
    const crate = F.makeMDL({ textures: ['skin_a'], cdtextures: ['models/props/'] });
    const text = Buffer.from('mdlkeyvalue { prop_data { base Wooden.Large } break { "model" "models/gibs/crate_gib1.mdl" } }\0', 'latin1');
    text.copy(crate, 6000); crate.writeInt32LE(6000, 312); crate.writeInt32LE(text.length, 316);
    W('models/props/breakable.mdl', crate); W('models/props/breakable.vvd', 'v'); W('models/props/breakable.dx90.vtx', 'v');
    W('models/gibs/crate_gib1.mdl', F.makeMDL({})); W('models/gibs/crate_gib1.vvd', 'v'); W('models/gibs/crate_gib1.dx90.vtx', 'v');
    const file = put(root, 'src/cov.vmf', `world\n{\n\t"id" "1"\n\t"classname" "worldspawn"\n\tsolid\n\t{\n\t\t"id" "2"\n\t\tside\n\t\t{\n\t\t\t"material" "COV/WALL"\n\t\t}\n\t}\n}\n${ent('env_sun', { startexture: 'skybox/stars' })}${ent('prop_physics', { model: 'models/props/breakable.mdl' })}`);
    const r = await new Scraper({ gamepath: game, vmf: file, outputDir: path.join(root, 'out_cov'), cacheDir }).run();
    for (const f of ['materials/cov/wall_srgb.vtf', 'materials/cov/wall_dx8.vmt', 'materials/cov/wall_dx8.vtf', 'materials/skybox/stars.vtf', 'models/gibs/crate_gib1.mdl', 'models/gibs/crate_gib1.vvd']) assert.ok(fs.existsSync(path.join(root, 'out_cov', f)), f);
    assert.ok(!r.missing.some((m) => m.includes('stars')), 'optional material of startexture is not reported');
  });

  await test('names with spaces, accents or "#" are extracted; invalid ones are reported, never silently dropped', async () => {
    W('materials/mur béton/brique rouge.vmt', vmt('mur béton/brique rouge')); W('materials/mur béton/brique rouge.vtf', 'x');
    W('models/props/max.mdl', F.makeMDL({ textures: ['material #25'], cdtextures: ['models/props/'] })); W('models/props/max.vvd', 'v'); W('models/props/max.dx90.vtx', 'v');
    W('materials/models/props/material #25.vmt', vmt('models/props/material #25')); W('materials/models/props/material #25.vtf', 'x');
    const world = 'world\n{\n\t"id" "1"\n\t"classname" "worldspawn"\n\tsolid\n\t{\n\t\t"id" "2"\n\t\tside\n\t\t{\n\t\t\t"material" "MUR BÉTON/BRIQUE ROUGE"\n\t\t}\n\t}\n}\n';
    const file = put(root, 'src/names.vmf', world + ent('prop_static', { model: 'models/props/max.mdl' }) + ent('infodecal', { texture: 'decals/bad*name' }));
    const out = path.join(root, 'out_names');
    const r = await new Scraper({ gamepath: game, vmf: file, outputDir: out, cacheDir }).run();
    for (const f of ['materials/mur béton/brique rouge.vmt', 'materials/mur béton/brique rouge.vtf', 'materials/models/props/material #25.vmt', 'materials/models/props/material #25.vtf']) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.ok(r.unsafePaths.includes('materials/decals/bad*name'), JSON.stringify(r.unsafePaths));
  });

  await test('particles: only the systems the map uses (and their children) are followed; stock names are recognised', async () => {
    const pcf = F.makePCF([
      { name: 'portal_main', material: 'particle/used_a.vmt', children: ['portal_child'] },
      { name: 'portal_child', material: 'particle\\used_b.vmt' },
      { name: 'unrelated_fx', material: 'particle/never_used.vmt' },
    ]);
    W('particles/custom_fx.pcf', pcf);
    for (const m of ['used_a', 'used_b', 'never_used']) { W(`materials/particle/${m}.vmt`, vmt(`particle/${m}`)); W(`materials/particle/${m}.vtf`, m); }
    W('materials/tex/ext.vmt', '"LightmappedGeneric"\n{\n\t"$basetexture" "tex/ext_color.vmt"\n}\n'); W('materials/tex/ext_color.vtf', 'x');
    W('hl2_stock_dir.vpk', F.makeVPKWithFiles({
      'scripts/sounds/hl2_game_sounds_world.txt': '"Doors.Move17"\n{\n\t"wave" "doors/door17.wav"\n}\n',
      'scripts/soundscapes/soundscapes_stock.txt': '"Nothing"\n{\n}\n',
      'particles/stock_fx.pcf': F.makePCF([{ name: 'striderbuster_break', material: 'particle/x.vmt' }]),
    }));
    const file = put(root, 'src/pfx.vmf', `world\n{\n\t"id" "1"\n\t"classname" "worldspawn"\n\tsolid\n\t{\n\t\t"id" "2"\n\t\tside\n\t\t{\n\t\t\t"material" "TEX/EXT"\n\t\t}\n\t}\n}\n`
      + ent('info_particle_system', { effect_name: 'portal_main' }) + ent('info_particle_system', { effect_name: 'striderbuster_break' }) + ent('info_particle_system', { effect_name: 'ghost_fx' })
      + ent('func_door', { noise1: 'Doors.Move17' }) + ent('func_door', { noise1: 'Custom.Unknown' }) + ent('env_soundscape', { soundscape: 'Nothing' }));
    const out = path.join(root, 'out_pfx');
    const r = await new Scraper({ gamepath: game, vmf: file, outputDir: out, cacheDir }).run();
    const has = (f) => fs.existsSync(path.join(out, f));
    assert.ok(has('particles/custom_fx.pcf') && has('materials/particle/used_a.vmt') && has('materials/particle/used_b.vtf'));
    assert.ok(!has('materials/particle/never_used.vmt'), 'a system the map does not use brings nothing');
    assert.ok(has('materials/tex/ext_color.vtf'), 'an extension written in $basetexture is ignored, like the engine does');
    assert.deepStrictEqual(r.unresolved, { soundscripts: ['custom.unknown'], soundscapes: [], effects: ['ghost_fx'] });
    for (const n of ['soundscript:doors.move17', 'soundscape:nothing', 'effect:striderbuster_break']) assert.ok(r.stock.includes(n), n);
  });

  console.log('cli');
  await test('arguments: drag & drop, --no-<flag>, config defaults', () => {
    const { parseArgs, resolveSettings } = require('../main');
    const a = parseArgs(['C:\\maps\\my map.VMF', '--gma', '--no-workshop', '--max-texture', '1024', '--exclude-workshop', '1,2', '--tags', 'build,water,fun']);
    assert.strictEqual(a.opts.vmf, 'C:\\maps\\my map.VMF');
    assert.deepStrictEqual(a.errors, []);
    const s = resolveSettings(a, { defaults: { optimizeTextures: true, keepNormals: true, maxTexture: 4096, tags: ['nope'] } });
    assert.deepStrictEqual([s.gma, s.workshop, s.optimizeTextures, s.keepNormals, s.maxTexture], [true, false, true, true, 1024]);
    assert.deepStrictEqual([s.excludeWorkshop, s.tags], [['1', '2'], ['build', 'water']]);
    assert.strictEqual(parseArgs(['x.bsp']).opts.bsp, 'x.bsp');
    assert.deepStrictEqual(parseArgs(['whatever.txt']).errors, ['whatever.txt']);
    assert.strictEqual(resolveSettings(parseArgs(['--no-optimize-textures']), { defaults: { optimizeTextures: true } }).optimizeTextures, false);
    assert.deepStrictEqual(parseArgs(['x.vmf', '--dryrun', '--optimise-textures', '--gma=1']).errors, ['--dryrun', '--optimise-textures', '--gma=1'], 'typos are refused');
    const eq = parseArgs(['--game=C:\\Steam\\garrysmod', '--out', 'D:\\out', '--tags=build']);
    assert.deepStrictEqual([eq.opts.game, eq.opts.out, eq.opts.tags, eq.errors], ['C:\\Steam\\garrysmod', 'D:\\out', 'build', []]);
    const gap = parseArgs(['--out', '--gma']);
    assert.deepStrictEqual([gap.noValue, gap.flags.has('gma')], [['--out'], true], 'the next flag is not swallowed as a value');
    assert.deepStrictEqual(parseArgs(['x.vmf', '--title']).noValue, ['--title']);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
