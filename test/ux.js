'use strict';
// Tests for the comfort features: translations, "used by" chains, plan/execute + progress, run-to-run diff,
// reports (text + HTML), Steam detection, watch mode, Explorer context menu, start-menu helpers and the CLI itself.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { catalogs, makeT } = require('../src/i18n');
const { Scraper, describeChain } = require('../src/scraper');
const { textReport, htmlReport } = require('../src/report');
const { parseLibraryFolders, detectGamePath } = require('../src/steam');
const { watchFiles } = require('../src/watch');
const shell = require('../src/winshell');
const ui = require('../src/ui');
const cli = require('../main');
const F = require('./fixtures');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscraper-ux-'));
const game = path.join(root, 'steamapps', 'common', 'GarrysMod', 'garrysmod');
const cacheDir = path.join(root, 'cache');
const put = (base, rel, data) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const W = (rel, data) => put(game, rel, data);
const block = (name, kvs, inner = '') => `${name}\n{\n${Object.entries(kvs).map(([k, v]) => `\t"${k}" "${v}"`).join('\n')}\n${inner}}\n`;
const solid = (id, materials) => `\tsolid\n\t{\n\t\t"id" "${id}"\n${materials.map((m, i) => `\t\tside\n\t\t{\n\t\t\t"id" "${i + 1}"\n\t\t\t"material" "${m}"\n\t\t}\n`).join('')}\t}\n`;

(async () => {
  console.log('i18n');
  await test('both languages define the same keys with the same placeholders', () => {
    const holes = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
    for (const key of Object.keys(catalogs.en)) {
      assert.ok(catalogs.fr[key] !== undefined, `fr is missing ${key}`);
      assert.strictEqual(holes(catalogs.fr[key]), holes(catalogs.en[key]), `placeholders of ${key}`);
    }
    for (const key of Object.keys(catalogs.fr)) assert.ok(catalogs.en[key] !== undefined, `en is missing ${key}`);
  });
  await test('every message used in the code exists', () => {
    const dir = path.join(__dirname, '..');
    const files = ['main.js', ...fs.readdirSync(path.join(dir, 'src')).map((f) => `src/${f}`)];
    const used = new Set();
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf-8');
      for (const m of text.matchAll(/\b(?:t|note|warn|phase)\(\s*'([a-zA-Z]+(?:\.[\w.]+)?)'/g)) used.add(m[1]);
    }
    for (const p of cli.PRESETS) { used.add(`menu.${p}`); used.add(`menu.${p}.hint`); }
    assert.ok(used.size > 120, `only ${used.size} keys found`);
    for (const key of used) assert.ok(catalogs.en[key] !== undefined, `unknown message key: ${key}`);
  });
  await test('formatters follow the language', () => {
    const fr = ui.makeFmt('fr'), en = ui.makeFmt('en');
    assert.strictEqual(fr.bytes(1610612736), '1,50 Go');
    assert.strictEqual(en.bytes(1610612736), '1.50 GB');
    assert.strictEqual(en.bytes(5 * 1048576), '5.0 MB');
    assert.strictEqual(en.bytes(2048), '2.0 KB');
    assert.strictEqual(en.duration(2500), '2.5 s');
    assert.strictEqual(fr.duration(125000), '2 min 05 s');
    assert.strictEqual(en.clock(65000), '01:05');
    assert.strictEqual(makeT('fr')('sum.referenced', { n: 3 }), '3 référencés');
    assert.strictEqual(makeT('xx').lang, 'en');
  });

  console.log('steam');
  await test('finds garrysmod through libraryfolders.vdf (new and old layouts)', () => {
    const lib = path.join(root, 'lib2');
    const steam = path.join(root, 'Steam');
    put(lib, 'steamapps/common/GarrysMod/garrysmod/materials/.keep', '');
    put(steam, 'steamapps/libraryfolders.vdf', `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam.replace(/\\/g, '\\\\')}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib.replace(/\\/g, '\\\\')}"\n\t\t"apps" { "4000" "123" }\n\t}\n}\n`);
    assert.deepStrictEqual(parseLibraryFolders('"LibraryFolders" { "TimeNextStatsReport" "1" "1" "D:\\\\Games" }').includes('D:\\Games'), true);
    assert.strictEqual(detectGamePath([steam]), path.join(lib, 'steamapps', 'common', 'GarrysMod', 'garrysmod'));
    assert.strictEqual(detectGamePath([path.join(root, 'nowhere')]), null);
  });

  // ----- a small game + map with broken references -----
  W('materials/wall/real.vmt', '"LightmappedGeneric"\n{\n\t"$basetexture" "wall/ghosttex"\n}\n');
  W('materials/ok/floor.vmt', '"LightmappedGeneric"\n{\n\t"$basetexture" "ok/floor"\n}\n'); W('materials/ok/floor.vtf', Buffer.alloc(300000, 7));
  W('materials/ok/extra.vmt', '"LightmappedGeneric"\n{\n\t"$basetexture" "ok/extra"\n}\n'); W('materials/ok/extra.vtf', Buffer.alloc(200000, 9));
  W('models/props/broken.mdl', F.makeMDL({ textures: ['ghost'], cdtextures: ['models/props/'] }));
  W('models/props/broken.vvd', 'vvd'); W('models/props/broken.dx90.vtx', 'vtx');
  const vmfA = [
    block('world', { id: '1', classname: 'worldspawn' }, solid(5, ['MISSING/BRUSHMAT', 'WALL/REAL', 'OK/FLOOR'])),
    block('entity', { id: '77', classname: 'prop_static', model: 'models/props/broken.mdl', origin: '1 2 3' }),
    block('entity', { id: '9', classname: 'func_detail' }, solid(12, ['MISSING/DETAIL'])),
    block('entity', { id: '30', classname: 'env_soundscape', targetname: 'amb', soundscape: 'nowhere.place', origin: '8 8 8' }),
    'entity {\n\t"id" "31"\n\t"classname" "prop_dynamic"\n\t"model" "models/props/ghostmodel.mdl"\n\t"origin" "4 5 6"\n}\n', // name and brace on one line
  ].join('');
  const vmfFile = put(root, 'src/uxmap.vmf', vmfA);
  const outDir = path.join(root, 'out');
  const newScraper = (extra) => new Scraper({ gamepath: game, vmf: vmfFile, outputDir: outDir, cacheDir, ...extra });

  console.log('engine');
  let firstRun;
  await test('plan() writes nothing, execute() reports byte-accurate progress', async () => {
    const events = [];
    const s = newScraper({ onProgress: (p) => events.push({ ...p }) });
    const plan = await s.plan();
    assert.ok(!fs.existsSync(outDir), 'nothing written by plan()');
    assert.strictEqual(plan.writeFiles, plan.files);
    assert.ok(plan.writeBytes >= 300000 && Number.isFinite(plan.free));
    firstRun = await s.execute();
    assert.ok(fs.existsSync(path.join(outDir, 'materials/ok/floor.vtf')));
    assert.ok(events.length >= 2);
    const last = events[events.length - 1];
    assert.strictEqual(last.doneBytes, last.totalBytes);
    assert.strictEqual(last.totalBytes, plan.writeBytes);
    assert.strictEqual(last.doneFiles, plan.writeFiles);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].doneBytes >= events[i - 1].doneBytes, 'monotonic');
    assert.strictEqual(firstRun.stats.written, plan.writeFiles);
    assert.strictEqual(firstRun.diff, null, 'no previous run to compare with');
  });

  await test('"used by" chains lead from a missing file to the Hammer entity / brush', () => {
    const t = makeT('en');
    const r = firstRun;
    assert.deepStrictEqual(r.missing, ['materials/missing/brushmat.vmt', 'materials/missing/detail.vmt', 'materials/models/props/ghost.vmt', 'materials/wall/ghosttex.vtf', 'models/props/ghostmodel.mdl']);
    assert.strictEqual(describeChain(r.missingRefs['materials/models/props/ghost.vmt'], t), 'models/props/broken.mdl  ←  prop_static #77 at (1 2 3)');
    assert.strictEqual(describeChain(r.missingRefs['materials/wall/ghosttex.vtf'], t), 'materials/wall/real.vmt  ←  brush #5');
    assert.strictEqual(describeChain(r.missingRefs['materials/missing/brushmat.vmt'], t), 'brush #5');
    assert.strictEqual(describeChain(r.missingRefs['materials/missing/detail.vmt'], t), 'brush #12 (func_detail #9)');
    assert.strictEqual(describeChain(r.missingRefs['models/props/ghostmodel.mdl'], t), 'prop_dynamic #31 at (4 5 6)');
    assert.strictEqual(describeChain(r.unresolvedRefs['soundscape:nowhere.place'], makeT('fr')), 'env_soundscape #30 "amb" en (8 8 8)');
  });

  await test('the next run lists what changed since the previous one', async () => {
    fs.writeFileSync(vmfFile, vmfA.replace('"OK/FLOOR"', '"OK/EXTRA"'));
    const r = await newScraper().run();
    assert.deepStrictEqual(r.diff.added, ['materials/ok/extra.vmt', 'materials/ok/extra.vtf']);
    assert.deepStrictEqual(r.diff.removed, ['materials/ok/floor.vmt', 'materials/ok/floor.vtf']);
    assert.ok(r.diff.addedBytes > 200000 && r.diff.removedBytes > 300000);
    const dry = await newScraper({ dryRun: true }).run();
    assert.deepStrictEqual([dry.diff.added.length, dry.diff.removed.length, dry.diff.changed.length], [0, 0, 0]);
  });

  await test('refuses to start when the disk is too small, before touching the output', async () => {
    const real = fs.statfsSync;
    fs.statfsSync = () => ({ bavail: 10, bsize: 4096 });
    try {
      const marker = put(outDir, 'materials/marker.vmt', 'still here');
      await assert.rejects(() => newScraper({ incremental: true, t: makeT('fr') }).run(), /Espace disque insuffisant/);
      assert.ok(fs.existsSync(marker));
    } finally { fs.statfsSync = real; }
  });

  console.log('security');
  await test('a crafted map cannot read outside the game folder nor write outside the output', async () => {
    const { isSafeRel } = require('../src/scraper');
    for (const bad of ['../x.wav', 'sound/../../x.wav', 'sound/a/../../../x.wav', 'c:/windows/x.wav', '/etc/x.wav', 'sound//x.wav', 'sound/./x.wav', `sound/x${String.fromCharCode(0)}.wav`, 'sound/a|b.wav', '']) assert.strictEqual(isSafeRel(bad), false, JSON.stringify(bad));
    for (const ok of ['sound/a b/c.wav', 'materials/models/x-1/y_2.vmt', 'maps/graphs/m.ain']) assert.strictEqual(isSafeRel(ok), true, ok);
    const secret = put(root, 'secret/passwords.wav', 'TOP SECRET');
    put(root, 'secret/skin.vmt', '"x" {}');
    const evil = put(root, 'src/evil.vmf', [
      block('entity', { id: '1', classname: 'ambient_generic', message: '../../../../../secret/passwords.wav' }),
      block('entity', { id: '2', classname: 'infodecal', texture: '../../../../../secret/skin' }),
      block('entity', { id: '3', classname: 'prop_static', model: 'models/../../../../../secret/x.mdl' }),
    ].join(''));
    const out = path.join(root, 'evil_out', 'deep', 'er');
    const r = await new Scraper({ gamepath: game, vmf: evil, outputDir: out, cacheDir }).run();
    assert.strictEqual(r.stats.files, 0);
    assert.ok(r.unsafePaths.includes('sound/../../../../../secret/passwords.wav') && r.unsafePaths.length >= 3, JSON.stringify(r.unsafePaths));
    assert.ok(r.warnings.some((w) => /leave the game folder/.test(w)));
    const leaked = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/passwords|skin[.]vmt/.test(e.name) && p !== secret && !p.includes(path.join(root, 'secret'))) leaked.push(p); } })(root);
    assert.deepStrictEqual(leaked, []);
  });
  await test('terminal escape sequences and absurd nesting from map files are neutralised', async () => {
    const ESC = String.fromCharCode(27);
    const file = put(root, 'src/esc.vmf', block('entity', { id: '5', classname: 'prop_static', targetname: `evil${ESC}[2J${ESC}]0;pwned`, model: `models/props/no${ESC}[31mpe.mdl`, origin: '0 0 0' }));
    const r = await new Scraper({ gamepath: game, vmf: file, outputDir: path.join(root, 'esc_out'), cacheDir }).run();
    const dump = JSON.stringify(r) + textReport(r, { t: makeT('en'), fmt: ui.makeFmt('en'), version: '0' });
    assert.ok(!dump.includes(ESC) && !dump.includes('\\u001b'), 'no escape character reaches the output');
    assert.strictEqual(r.stats.models, 0, 'a model name with illegal characters is ignored');
    const kv = require('../src/kv');
    assert.throws(() => kv.parse('a {'.repeat(5000)), /nested too deeply/);
    assert.strictEqual(kv.parse('a { b { c { "k" "v" } } }')[0].children[0].children[0].children[0].value, 'v');
  });
  await test('file lookups are case-insensitive and keep the real name on disk', async () => {
    W('materials/CaseTest/Wall_A.VMT', '"LightmappedGeneric"\n{\n\t"$basetexture" "casetest/WALL_a"\n}\n'); W('materials/CaseTest/wall_a.vtf', 'x');
    const file = put(root, 'src/case.vmf', block('world', { id: '1', classname: 'worldspawn' }, solid(2, ['CASETEST/WALL_A'])));
    await new Scraper({ gamepath: game, vmf: file, outputDir: path.join(root, 'case_out'), cacheDir }).run();
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'case_out', 'materials', 'casetest')).sort(), ['wall_a.vmt', 'wall_a.vtf'], 'found, and written in lower case');
  });
  await test('opening the report never goes through a shell', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf-8');
    assert.ok(!src.includes('shell: true') && !src.includes("'cmd'"), 'no cmd.exe / shell:true in ui.js');
    for (const f of ['scraper.js', 'winshell.js', 'steam.js']) {
      const code = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf-8');
      assert.ok(!code.includes('shell: true') && !code.includes('execSync(') && !code.includes(' exec('), f);
    }
  });
  await test('hostile binary headers are refused instead of exhausting memory', () => {
    const { LzmaDecoder } = require('../src/lzma');
    const vtf = require('../src/vtf');
    const hdr = Buffer.alloc(32); hdr[0] = 0x5d; hdr.writeUInt32LE(0xfffffff0, 1);
    assert.throws(() => LzmaDecoder.alone(hdr), /dictionary too large/);
    const v = F.makeVTF(4, 4, 0, F.makeRGBA(4, 4, false)); v.writeUInt16LE(65535, 16); v.writeUInt16LE(65535, 18);
    assert.throws(() => vtf.decode(v, vtf.parse(v)), /unreasonable texture size/);
  });

  await test('a damaged or lying pakfile entry is reported and skipped, never fatal nor memory-hungry', async () => {
    const zlib = require('zlib');
    const { Pak } = require('../src/bsp');
    const { decompressRaw } = require('../src/lzma');
    const entry = (data, method, usize) => { // a one-entry pakfile whose directory announces this method and size
      const z = F.makeZip({ 'a/b.txt': data });
      z.writeUInt16LE(method, 8);
      const c = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      z.writeUInt16LE(method, c + 10); z.writeUInt32LE(usize, c + 24);
      return new Pak(z);
    };
    const text = Buffer.from('hello pakfile '.repeat(50));
    assert.deepStrictEqual(entry(zlib.deflateRawSync(text), 8, text.length).read('a/b.txt'), text, 'an honest deflate entry still reads');
    for (const [label, pak] of [
      ['stream longer than declared', entry(zlib.deflateRawSync(Buffer.alloc(4 << 20)), 8, 1000)],
      ['4 GiB declared', entry(zlib.deflateRawSync(text), 8, 0xffffffff)],
      ['not a deflate stream', entry(Buffer.from('not deflate at all'), 8, 18)],
      ['unknown method', entry(text, 99, text.length)],
    ]) { assert.strictEqual(pak.read('a/b.txt'), null, label); assert.ok(pak.damaged.has('a/b.txt'), label); }
    assert.throws(() => decompressRaw(Buffer.from([0x5d, 0, 0, 0, 1]), 0xffffffff, Buffer.alloc(32)), /too large/, 'LZMA size is never trusted');

    // end to end: one damaged entry used to abort the whole analysis ("invalid stored block lengths")
    const bsp = F.makeBSP({ entities: [{ classname: 'worldspawn' }], pak: { 'particles/particles_manifest.txt': 'particles_manifest\n{\n}\n' } });
    bsp.writeUInt16LE(8, bsp.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) + 8);
    bsp.writeUInt16LE(8, bsp.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    const file = put(root, 'src/damaged.bsp', bsp);
    const r = await new Scraper({ gamepath: game, bsp: file, outputDir: path.join(root, 'damaged_out'), cacheDir, dryRun: true, workshop: false }).run();
    assert.ok(r.warnings.some((w) => /damaged/.test(w) && w.includes('particles/particles_manifest.txt')), JSON.stringify(r.warnings));
  });
  await test('names printed from the map carry no terminal escape sequences (soundscapes, effects, instance files)', async () => {
    const ESC = String.fromCharCode(27);
    const file = put(root, 'src/esc2.vmf', [
      block('entity', { id: '1', classname: 'env_soundscape', soundscape: `evil${ESC}[2Jscape` }),
      block('entity', { id: '2', classname: 'info_particle_system', effect_name: `fx${ESC}]0;pwn` }),
      block('entity', { id: '3', classname: 'func_instance', file: `inst${ESC}[31m.vmf` }),
    ].join(''));
    const r = await new Scraper({ gamepath: game, vmf: file, outputDir: path.join(root, 'esc2_out'), cacheDir, dryRun: true, workshop: false }).run();
    const dump = JSON.stringify(r) + textReport(r, { t: makeT('en'), fmt: ui.makeFmt('en'), version: '0' });
    assert.ok(!dump.includes(ESC) && !dump.includes('\\u001b'), 'no escape character reaches the output');
    assert.deepStrictEqual([r.unresolved.soundscapes.length, r.unresolved.effects.length, r.warnings.length > 0], [1, 1, true], 'the names themselves are still reported');
  });
  await test('a megabyte of path characters cannot freeze the asset scan (it used to be quadratic)', () => {
    const s = new Scraper({ gamepath: game, vmf: vmfFile, outputDir: path.join(root, 'redos_out'), cacheDir });
    const t0 = Date.now();
    s.scanText('a'.repeat(100000));              // ~10 s with an unbounded "+"
    s.scanText(`${'a/'.repeat(50000)}b`);
    assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    s.scanText('see models/props/x.mdl and sound/a.wav');
    assert.ok(s.models.has('models/props/x.mdl') && s.waves.has('a.wav'), 'real paths are still found');
  });
  await test('Windows programs are started by absolute path (a planted reg.exe / explorer.exe in the map folder is never run)', () => {
    const win = shell.systemPath('System32', 'reg.exe');
    assert.ok(path.isAbsolute(win) && /[\\/]System32[\\/]reg\.exe$/i.test(win));
    for (const f of ['winshell.js', 'steam.js', 'ui.js', 'scraper.js']) {
      const code = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf-8');
      assert.ok(!/spawn(?:Sync)?\(\s*['"](?:reg|explorer)(?:\.exe)?['"]/.test(code), `${f} starts a bare command name`);
    }
    if (!shell.supported()) return;
    const plant = path.join(root, 'planted');
    fs.mkdirSync(plant, { recursive: true });
    fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'hostname.exe'), path.join(plant, 'reg.exe'));
    const here = process.cwd();
    try {
      process.chdir(plant);                      // the folder Explorer starts us in when a .vmf is right-clicked
      const r = shell.reg(['/?']);
      assert.ok(r.ok && /QUERY/.test(r.out), 'the real reg.exe answered, not the planted one');
    } finally { process.chdir(here); }
  });
  await test('a negative offset in a model header reads as empty instead of throwing', () => {
    const { parseMDL } = require('../src/mdl');
    for (const [countAt, indexAt] of [[204, 208], [212, 216], [232, 236]]) {
      const b = Buffer.from(F.makeMDL({ textures: ['a'], cdtextures: ['x/'] }));
      b.writeInt32LE(1, countAt); b.writeInt32LE(-1000, indexAt);
      assert.doesNotThrow(() => parseMDL(b), `offset at ${indexAt}`);
    }
  });
  await test('a .gma is written under a temporary name: an interrupted run never leaves a truncated archive', async () => {
    const { writeGMA } = require('../src/publish');
    const dir = path.join(root, 'gma_atomic');
    const src = put(dir, 'in/materials/a.vtf', Buffer.alloc(100, 1));
    const out = path.join(dir, 'ok.gma');
    await writeGMA({ out, title: 't', tags: ['fun'], files: [{ rel: 'materials/a.vtf', abs: src, size: 100 }] });
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.gma') || n.endsWith('.mstmp')), ['ok.gma']);
    assert.strictEqual(fs.readFileSync(out).toString('latin1', 0, 4), 'GMAD');
    const bad = path.join(dir, 'bad.gma');
    await assert.rejects(() => writeGMA({
      out: bad, title: 't', tags: ['fun'], files: [{ rel: 'materials/a.vtf', abs: src, size: 100 }],
      onProgress: () => fs.truncateSync(src, 10), // the file shrinks after its checksum was taken
    }), /changed while packing/);
    assert.ok(!fs.existsSync(bad) && !fs.existsSync(`${bad}.mstmp`), 'neither a .gma nor a leftover');
  });
  await test('looking a file up never lists a folder that does not exist (100+ addons made it ~100k failing readdir calls)', async () => {
    const pg = path.join(root, 'perf', 'garrysmod');
    for (let i = 0; i < 25; i++) put(pg, `addons/a${i}/materials/only${i}/x.txt`, '');
    const names = [];
    for (let i = 0; i < 30; i++) { put(pg, `materials/deep${i % 3}/m${i}.vmt`, '"LightmappedGeneric"\n{\n}\n'); names.push(`deep${i % 3}/m${i}`); }
    const vmf = put(root, 'src/perf.vmf', block('world', { id: '1', classname: 'worldspawn' }, solid(2, names)));
    const real = fs.readdirSync;
    let failing = 0;
    fs.readdirSync = function (p, ...rest) { try { return real.call(this, p, ...rest); } catch (e) { if (/[\\/]materials[\\/]/.test(String(p))) failing++; throw e; } };
    let r;
    try { r = await new Scraper({ gamepath: pg, vmf, outputDir: path.join(root, 'perf_out'), cacheDir, dryRun: true, workshop: false }).run(); } finally { fs.readdirSync = real; }
    assert.strictEqual(r.stats.materials, 30, 'every material is still found');
    assert.strictEqual(failing, 0, `${failing} failing listings of folders under materials/`);
  });
  await test('folders reached through a junction / symlink are still searched, whatever the case of their names', () => {
    const pg = path.join(root, 'perf', 'garrysmod'), target = path.join(root, 'linked_target');
    put(target, 'Tex/x.vmt', '"x"\n{\n}\n');
    const link = path.join(pg, 'addons', 'a3', 'materials', 'wall');
    try { fs.symlinkSync(target, link, 'junction'); } catch { return; } // no permission to link on this machine
    const s = new Scraper({ gamepath: pg, vmf: vmfFile, outputDir: path.join(root, 'link_out'), cacheDir });
    s.initSearchPaths();
    const found = s.resolve('materials/wall/tex/x.vmt');
    assert.ok(found && path.basename(found) === 'x.vmt', String(found));
    assert.strictEqual(s.resolve('materials/wall/tex/nope.vmt'), null);
    assert.strictEqual(s.resolve('materials/wall/x.vmt/y'), null, 'a file is not a folder');
  });

  await test('prefetch opens every file a few at a time and ignores the ones it cannot open', async () => {
    const { prefetch } = require('../src/prefetch');
    const dir = path.join(root, 'prefetch');
    const files = [1, 2, 3, 4, 5].map((i) => put(dir, `f${i}.bin`, 'x'));
    files.push(path.join(dir, 'missing.bin'));
    const real = fs.promises.open;
    let calls = 0, running = 0, peak = 0;
    fs.promises.open = async function (f, ...rest) {
      calls++; running++; peak = Math.max(peak, running);
      try { await new Promise((r) => setImmediate(r)); return await real.call(fs.promises, f, ...rest); } finally { running--; }
    };
    try { await prefetch(files, 2); } finally { fs.promises.open = real; }
    assert.deepStrictEqual([calls, peak], [6, 2]);
    await prefetch([]); // nothing to do is fine
  });
  await test('hand-edited config values and hostile icons cannot crash or stall the start', () => {
    const { cleanTags, readJpegSize } = require('../src/publish');
    assert.deepStrictEqual(cleanTags('fun'), ['roleplay'], 'a string instead of a list');
    assert.doesNotThrow(() => cli.resolveSettings(cli.parseArgs([]), { defaults: { tags: 'fun', excludeWorkshop: 'all' } }));
    const tiny = Buffer.concat([Buffer.from([0xFF, 0xD8]), ...Array.from({ length: 20000 }, () => Buffer.from([0xFF, 0xE0, 0x00, 0x02]))]);
    const file = put(root, 'icons/endless.jpg', tiny);
    const real = fs.readSync;
    let reads = 0;
    fs.readSync = (...a) => { reads++; return real(...a); };
    try { assert.strictEqual(readJpegSize(file), null); } finally { fs.readSync = real; }
    assert.ok(reads <= 4200, `${reads} reads`);
  });
  await test('answers piped in advance are still served after the input has ended (a long analysis in between)', () => {
    const script = "const ui = require(process.argv[1]); (async () => { const a = await ui.ask('q1'); await new Promise((r) => setTimeout(r, 300)); const b = await ui.ask('q2'); console.log('GOT', a, b); ui.closePrompts(); })();";
    const r = spawnSync(process.execPath, ['-e', script, path.join(__dirname, '..', 'src', 'ui.js')], { input: 'x\ny\n', encoding: 'utf-8' });
    assert.strictEqual(r.status, 0, r.stderr); // used to die with ERR_USE_AFTER_CLOSE on the second question
    assert.ok(r.stdout.includes('GOT x y') && r.stdout.includes('q2'), r.stdout);
  });
  await test('--json creates the folder of its file: a long run never loses its result', () => {
    const target = path.join(root, 'json_out', 'deep', 'result.json');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'main.js'), vmfFile, '--dry-run', '--json', target, '--game', game, '--no-wait', '--no-open'], {
      cwd: root, input: '', encoding: 'utf-8', env: { ...process.env, MAPSCRAPER_CONFIG: path.join(root, 'cfg_json', 'config.json'), MAPSCRAPER_OFFLINE: '1', LOCALAPPDATA: cacheDir, FORCE_COLOR: '0' },
    });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.strictEqual(JSON.parse(fs.readFileSync(target, 'utf-8')).mapname, 'uxmap');
  });

  console.log('reports');
  await test('text and HTML reports (both languages, escaping, working script)', () => {
    for (const lang of ['en', 'fr']) {
      const t = makeT(lang), fmt = ui.makeFmt(lang);
      const r = { ...firstRun, warnings: ['<script>alert(1)</script>'], diff: { added: ['a'], removed: [], changed: [], addedBytes: 5, removedBytes: 0 } };
      const extras = { t, fmt, version: '0.0.0', optRes: null, gmaRes: null };
      const txt = textReport(r, extras), html = htmlReport(r, extras);
      assert.ok(txt.includes('materials/models/props/ghost.vmt') && txt.includes('<- models/props/broken.mdl  <-  prop_static #77'));
      assert.ok(txt.includes(t('rep.diff')) && txt.includes('+ a'));
      assert.ok(html.startsWith('<!doctype html>') && html.includes(`lang="${lang}"`));
      assert.ok(html.includes('id="missing"') && html.includes('data-copy="1 2 3"') && html.includes('prop_static #77'));
      assert.ok(!html.includes('<script>alert(1)') && html.includes('&lt;script&gt;alert(1)'), 'escaped');
      assert.ok(!/\{[a-z]+\}/i.test(html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, '')), 'no unfilled placeholder');
      new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(html)[1]); // throws on a syntax error
    }
  });

  console.log('watch');
  await test('fires once the file stopped changing, then again on the next change', async () => {
    const file = put(root, 'watch/map.bsp', 'v1');
    let hits = 0, detected = 0;
    const w = watchFiles([file, path.join(root, 'watch/never-there.vmf')], () => { hits++; }, { interval: 40, settle: 200, onDetect: () => { detected++; } });
    try {
      await sleep(150); assert.strictEqual(hits, 0);
      fs.writeFileSync(file, 'v2-partial'); await sleep(90); fs.writeFileSync(file, 'v2-complete'); // a compile writes several times
      await sleep(120); assert.strictEqual(hits, 0, 'still settling');
      await sleep(400); assert.strictEqual(hits, 1); assert.strictEqual(detected, 1);
      fs.writeFileSync(file, 'v3-longer-content'); await sleep(500); assert.strictEqual(hits, 2);
    } finally { w.stop(); }
    fs.writeFileSync(file, 'v4'); await sleep(350); assert.strictEqual(hits, 2, 'stopped');
  });

  console.log('explorer menu');
  await test('installs and removes the right-click entry (throwaway registry key)', () => {
    if (!shell.supported()) return;
    const base = `HKCU\\Software\\MapScraperSelfTest_${process.pid}`;
    const launch = { exe: 'C:\\Program Files\\Map Scraper\\MapScraper.exe', command: '"C:\\Program Files\\Map Scraper\\MapScraper.exe" "%1"' };
    try {
      assert.strictEqual(shell.installedCommand({ base }), null);
      shell.install({ label: 'Extraire avec MapScraper', base, launch });
      assert.strictEqual(shell.installedCommand({ base }), launch.command);
      const q = spawnSync('reg', ['query', `${base}\\.bsp\\shell\\MapScraper`, '/ve'], { encoding: 'utf-8' });
      assert.ok(q.stdout.includes('Extraire avec MapScraper'));
      shell.uninstall({ base });
      assert.strictEqual(shell.installedCommand({ base }), null);
    } finally { spawnSync('reg', ['delete', base, '/f'], { encoding: 'utf-8' }); }
  });

  console.log('cli');
  await test('start-menu helpers: presets, menu eligibility, recent maps', () => {
    const base = cli.resolveSettings(cli.parseArgs([]), {});
    assert.deepStrictEqual([cli.applyPreset(base, 'analyse').dryRun, cli.applyPreset(base, 'extract').dryRun], [true, false]);
    const pub = cli.applyPreset(base, 'publish');
    assert.deepStrictEqual([pub.optimizeTextures, pub.compressBsp, pub.gma], [true, true, true]);
    const watch = cli.applyPreset({ ...base, gma: true }, 'watch');
    assert.deepStrictEqual([watch.incremental, watch.watch, watch.gma], [true, true, false]);
    assert.strictEqual(cli.wantsMenu(cli.parseArgs(['a.vmf']), true), true, 'drag & drop');
    assert.strictEqual(cli.wantsMenu(cli.parseArgs(['a.vmf', '--gma']), true), false, 'scripted');
    assert.strictEqual(cli.wantsMenu(cli.parseArgs(['a.vmf']), false), false, 'no terminal');
    const dir = path.join(root, 'maps');
    const a = put(dir, 'a.vmf', ''), b = put(dir, 'b.vmf', ''), c = put(dir, 'c.vmf', '');
    fs.utimesSync(b, new Date(), new Date(Date.now() - 86400000)); fs.utimesSync(c, new Date(), new Date(Date.now() - 3600000));
    const cfg = {};
    cli.rememberMap(cfg, b); cli.rememberMap(cfg, path.join(dir, 'gone.vmf')); cli.rememberMap(cfg, b);
    assert.deepStrictEqual(cfg.recent.map((f) => path.basename(f)), ['b.vmf', 'gone.vmf']);
    assert.deepStrictEqual(cli.recentMaps(cfg).map((m) => path.basename(m.file)), ['b.vmf', 'a.vmf', 'c.vmf'], 'used first, then newest siblings');
    assert.strictEqual(cli.pickLang(cli.parseArgs(['--lang', 'FR']), { lang: 'en' }), 'fr');
    assert.strictEqual(cli.pickLang(cli.parseArgs([]), { lang: 'en' }), 'en');
    void a;
  });

  await test('end to end: menu with piped answers, French output, both reports, remembered map', () => {
    const config = path.join(root, 'cfg', 'config.json');
    const cwd = path.join(root, 'cli');
    fs.mkdirSync(cwd, { recursive: true });
    const run = (args, input) => spawnSync(process.execPath, [path.join(__dirname, '..', 'main.js'), ...args], {
      cwd, input, encoding: 'utf-8', env: { ...process.env, MAPSCRAPER_CONFIG: config, MAPSCRAPER_OFFLINE: '1', LOCALAPPDATA: cacheDir, FORCE_COLOR: '0' },
    });
    const first = run(['--game', game, '--lang', 'fr', '--no-wait'], `2\n${vmfFile}\n`); // Extract, then type the path (no recent map yet)
    assert.strictEqual(first.status, 0, first.stderr + first.stdout);
    assert.ok(first.stdout.includes('Que veux-tu faire ?') && first.stdout.includes('Extraction terminée'), first.stdout);
    assert.ok(first.stdout.includes('utilisé par') && first.stdout.includes('prop_static #77'));
    assert.ok(fs.existsSync(path.join(cwd, 'uxmap', 'materials/ok/extra.vtf')));
    for (const f of ['uxmap_report.txt', 'uxmap_report.html', 'uxmap_state.json']) assert.ok(fs.existsSync(path.join(cwd, f)), f);
    const saved = JSON.parse(fs.readFileSync(config, 'utf-8'));
    assert.deepStrictEqual([saved.lang, saved.recent.length, saved.gamepath], ['fr', 1, path.resolve(game)]);

    const second = run(['--no-wait'], '1\n\n'); // Analyse, Enter = most recent map; language and game come from the config
    assert.strictEqual(second.status, 0, second.stderr + second.stdout);
    assert.ok(second.stdout.includes('Quelle map ?') && second.stdout.includes('uxmap.vmf') && second.stdout.includes('Analyse terminée'), second.stdout);

    const scripted = run([vmfFile, '--dry-run', '--lang', 'en', '--no-wait'], '');
    assert.ok(scripted.status === 0 && scripted.stdout.includes('Analysis completed') && !scripted.stdout.includes('What do you want to do'), scripted.stdout);
    const bad = run(['nonsense.txt'], '');
    assert.strictEqual(bad.status, 1);
    assert.ok(bad.stderr.includes('nonsense.txt'));
    const typo = run([vmfFile, '--dryrun', '--no-wait'], ''); // used to run a full extraction instead of a dry run
    assert.ok(typo.status === 1 && typo.stderr.includes('--dryrun'), typo.stdout + typo.stderr);
    const watchGma = run([vmfFile, '--watch', '--gma', '--no-wait'], '');
    assert.ok(watchGma.status === 1 && watchGma.stderr.includes('--watch'), watchGma.stdout + watchGma.stderr);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
