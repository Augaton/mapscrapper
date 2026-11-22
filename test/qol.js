'use strict';
// Tests for the quality-of-life pass: output folder shown, publication questions (title / description / tags / icon,
// remembered per map), "extract now" after an analysis, the complete Settings menu, --strict / --json, --icon /
// --description, and the watch mode that only reports what changed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { readJpegSize, writeAddonJson } = require('../src/publish');
const { catalogs } = require('../src/i18n');
const cli = require('../main');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscraper-qol-'));
const game = path.join(root, 'steamapps', 'common', 'GarrysMod', 'garrysmod');
const put = (base, rel, data) => { const p = path.join(base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const block = (name, kvs, inner = '') => `${name}\n{\n${Object.entries(kvs).map(([k, v]) => `\t"${k}" "${v}"`).join('\n')}\n${inner}}\n`;
const solid = (id, materials) => `\tsolid\n\t{\n\t\t"id" "${id}"\n${materials.map((m, i) => `\t\tside\n\t\t{\n\t\t\t"id" "${i + 1}"\n\t\t\t"material" "${m}"\n\t\t}\n`).join('')}\t}\n`;
const mapText = (materials) => block('world', { id: '1', classname: 'worldspawn' }, solid(2, materials));
/** A JPEG made of the markers that matter: SOI, one APP0 segment, a baseline frame header, EOI. */
const jpeg = (w, h) => Buffer.concat([
  Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), Buffer.alloc(14, 0x4A),
  Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]), Buffer.alloc(9, 1), Buffer.from([0xFF, 0xD9]),
]);

put(game, 'materials/ok/floor.vmt', '"LightmappedGeneric"\n{\n\t"$basetexture" "ok/floor"\n}\n');
put(game, 'materials/ok/floor.vtf', Buffer.alloc(300000, 7));
const vmfOk = put(root, 'src/qolmap.vmf', mapText(['OK/FLOOR']));
const vmfBad = put(root, 'src/qolbad.vmf', mapText(['OK/FLOOR', 'MISSING/ONE']));
const icon512 = put(root, 'icons/icon.jpg', jpeg(512, 512));
const icon100 = put(root, 'icons/small.jpg', jpeg(100, 50));
const notJpeg = put(root, 'icons/fake.jpg', 'this is not an image');

let n = 0;
/** Runs the CLI in a fresh folder with its own config; `defaults` are written into that config first. */
function session(defaults = { workshop: false, checkUpdates: false }, extraCfg = {}) {
  const cwd = path.join(root, `run${++n}`), config = path.join(root, `cfg${n}`, 'config.json');
  fs.mkdirSync(cwd, { recursive: true });
  put(path.dirname(config), 'config.json', JSON.stringify({ gamepath: game, lang: 'en', defaults, ...extraCfg }));
  const env = { ...process.env, MAPSCRAPER_CONFIG: config, MAPSCRAPER_OFFLINE: '1', FORCE_COLOR: '0' };
  return {
    cwd, config,
    run: (args, input = '') => spawnSync(process.execPath, [path.join(__dirname, '..', 'main.js'), ...args], { cwd, input, encoding: 'utf-8', env }),
    spawn: (args) => spawn(process.execPath, [path.join(__dirname, '..', 'main.js'), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }),
    cfg: () => JSON.parse(fs.readFileSync(config, 'utf-8')),
  };
}

(async () => {
  console.log('publication details');
  await test('a JPEG size is read from its frame header; anything else is refused', () => {
    assert.deepStrictEqual(readJpegSize(icon512), { width: 512, height: 512 });
    assert.deepStrictEqual(readJpegSize(icon100), { width: 100, height: 50 });
    assert.strictEqual(readJpegSize(notJpeg), null);
    assert.strictEqual(readJpegSize(path.join(root, 'nowhere.jpg')), null);
    assert.strictEqual(readJpegSize(put(root, 'icons/cut.jpg', jpeg(512, 512).subarray(0, 12))), null, 'truncated before the frame header');
    assert.strictEqual(readJpegSize(put(root, 'icons/soi.jpg', Buffer.from([0xFF, 0xD8]))), null);
  });
  await test('checkIcon: missing and non-JPEG files are fatal, a wrong size only warns', () => {
    const t = (k, v) => `${k} ${JSON.stringify(v)}`;
    assert.strictEqual(cli.checkIcon(icon512, t), null);
    assert.ok(cli.checkIcon(path.join(root, 'nowhere.jpg'), t).fatal);
    assert.ok(cli.checkIcon(notJpeg, t).fatal);
    const small = cli.checkIcon(icon100, t);
    assert.ok(!small.fatal && small.msg.includes('"w":100') && small.msg.includes('"h":50'));
  });
  await test('addon.json carries the description only when there is one', () => {
    const dir = path.join(root, 'addonjson');
    fs.mkdirSync(dir, { recursive: true });
    assert.ok(!('description' in writeAddonJson(dir, { title: 'a', tags: ['fun'] })));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'addon.json'), 'utf-8')).description, undefined);
    writeAddonJson(dir, { title: 'a', description: 'about it', tags: ['fun'] });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'addon.json'), 'utf-8')).description, 'about it');
  });
  await test('--icon / --description: checked at start, written to addon.json and the .gma, icon path in the gmpublish command', () => {
    const s = session();
    const bad = s.run([vmfOk, '--gma', '--icon', notJpeg, '--no-wait']);
    assert.ok(bad.status === 1 && bad.stderr.includes('JPEG'), bad.stdout + bad.stderr);
    assert.ok(!fs.existsSync(path.join(s.cwd, 'qolmap')), 'refused before anything was written');
    const r = s.run([vmfOk, '--gma', '--icon', icon100, '--description', 'Hello desc', '--title', 'My Title', '--no-wait', '--no-open']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('100x50'), 'a wrong size warns');
    assert.ok(r.stdout.includes(`-icon "${icon100}"`), r.stdout);
    const addon = JSON.parse(fs.readFileSync(path.join(s.cwd, 'qolmap', 'addon.json'), 'utf-8'));
    assert.deepStrictEqual([addon.title, addon.description], ['My Title', 'Hello desc']);
    assert.ok(fs.readFileSync(path.join(s.cwd, 'qolmap.gma')).includes('Hello desc'), 'description in the .gma header');
  });
  await test('"Prepare the publication" asks title, description, tags and icon, remembers them per map, and Enter keeps them', () => {
    const s = session();
    const first = s.run(['--no-wait', '--no-open'], `3\n${vmfOk}\nMy Title\nA desc\nfun,build\n${icon512}\n`);
    assert.strictEqual(first.status, 0, first.stdout + first.stderr);
    const read = () => JSON.parse(fs.readFileSync(path.join(s.cwd, 'qolmap', 'addon.json'), 'utf-8'));
    assert.deepStrictEqual([read().title, read().description, read().tags], ['My Title', 'A desc', ['fun', 'build']]);
    assert.ok(first.stdout.includes(`-icon "${icon512}"`), first.stdout);
    const saved = s.cfg();
    assert.deepStrictEqual(saved.publish.qolmap, { title: 'My Title', description: 'A desc', icon: icon512 });
    assert.deepStrictEqual(saved.defaults.tags, ['fun', 'build']);
    const again = s.run(['--no-wait', '--no-open'], '3\n\n\n\n\n\n'); // recent map, then Enter on each question
    assert.strictEqual(again.status, 0, again.stdout + again.stderr);
    assert.ok(again.stdout.includes('[My Title]'), 'the proposal is shown');
    assert.deepStrictEqual([read().title, read().description, read().tags], ['My Title', 'A desc', ['fun', 'build']]);
    const cleared = s.run(['--no-wait', '--no-open'], '3\n\n\n-\n\n-\n'); // "-" empties description and icon
    assert.strictEqual(cleared.status, 0, cleared.stdout + cleared.stderr);
    assert.strictEqual(read().description, undefined);
    assert.ok(cleared.stdout.includes('-icon "icon.jpg"'));
  });
  await test('an icon typed in the questions is checked: a bad one is asked again', () => {
    const s = session();
    const r = s.run(['--no-wait', '--no-open'], `3\n${vmfOk}\n\n\n\n${notJpeg}\n${icon512}\n`);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('must be a JPEG') && r.stdout.includes(`-icon "${icon512}"`), r.stdout);
  });

  console.log('menu');
  await test('the plan names the output folder before anything is written', () => {
    const s = session();
    const r = s.run([vmfOk, '--no-wait', '--no-open']);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const at = r.stdout.indexOf(`Output folder: ${path.join(s.cwd, 'qolmap')}`);
    assert.ok(at > 0 && at < r.stdout.indexOf('Extraction completed'), r.stdout);
  });
  await test('after an analysis the menu offers to extract the map, and nothing is written when declined', () => {
    const yes = session();
    const a = yes.run(['--no-wait', '--no-open'], `1\n${vmfOk}\ny\n`);
    assert.strictEqual(a.status, 0, a.stdout + a.stderr);
    assert.ok(a.stdout.includes('Extract this map now') && fs.existsSync(path.join(yes.cwd, 'qolmap', 'materials/ok/floor.vtf')), a.stdout);
    const no = session();
    const b = no.run(['--no-wait', '--no-open'], `1\n${vmfOk}\nn\n`);
    assert.strictEqual(b.status, 0, b.stdout + b.stderr);
    assert.ok(!fs.existsSync(path.join(no.cwd, 'qolmap')));
    const eof = session().run(['--no-wait', '--no-open'], `1\n${vmfOk}\n`); // piped answers used up: no extraction, no error
    assert.strictEqual(eof.status, 0, eof.stdout + eof.stderr);
  });
  await test('the Settings menu edits every default (incremental, .gma, split, tags, skins, workshop, threads, updates)', () => {
    const s = session({});
    const input = ['8', '6', '7', '8', '700', '9', 'fun, build', '10', '11', '12', '14', '3', '16', '', '0'].join('\n') + '\n';
    const r = s.run(['--game', game, '--no-wait'], input);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(!/settings\.\w+/.test(r.stdout), 'every row has a label');
    const d = s.cfg().defaults;
    assert.deepStrictEqual(
      [d.incremental, d.gma, d.splitMb, d.tags, d.allSkins, d.workshop, d.fromWorkshop, d.threads, d.checkUpdates],
      [true, true, 700, ['fun', 'build'], true, false, true, 3, false],
    );
  });
  await test('both languages have the new messages', () => {
    for (const key of ['plan.dir', 'ask.extractNow', 'pub.title', 'pub.icon', 'icon.badSize', 'settings.splitMb', 'settings.checkUpdates', 'watch.newMissing', 'watch.fixed', 'cli.strict']) {
      assert.ok(catalogs.en[key] && catalogs.fr[key], key);
    }
    for (const lang of ['en', 'fr']) for (const opt of ['--strict', '--json', '--icon', '--description', '--no-check-updates']) assert.ok(catalogs[lang].usage.includes(opt), `${lang} usage lists ${opt}`);
  });

  console.log('scripts');
  await test('--strict: exit code 2 with missing files, 0 without; the JSON holds the result', () => {
    const s = session();
    const json = path.join(s.cwd, 'out', 'result.json');
    fs.mkdirSync(path.dirname(json), { recursive: true });
    const bad = s.run([vmfBad, '--dry-run', '--strict', '--json', json, '--no-wait']);
    assert.strictEqual(bad.status, 2, bad.stdout + bad.stderr);
    assert.ok(bad.stderr.includes('--strict') && bad.stderr.includes('1 missing'), bad.stderr);
    const result = JSON.parse(fs.readFileSync(json, 'utf-8'));
    assert.deepStrictEqual(result.missing, ['materials/missing/one.vmt']);
    assert.ok(result.missingRefs['materials/missing/one.vmt'].length && result.stats.materials >= 1 && result.mapname === 'qolbad');
    const good = s.run([vmfOk, '--dry-run', '--strict', '--no-wait']);
    assert.strictEqual(good.status, 0, good.stdout + good.stderr);
    const plain = s.run([vmfBad, '--dry-run', '--no-wait']);
    assert.strictEqual(plain.status, 0, 'without --strict a missing file is not a failure');
  });
  await test('--json without a value is refused like any value option', () => {
    const r = session().run([vmfOk, '--json']);
    assert.ok(r.status === 1 && r.stderr.includes('--json'), r.stdout + r.stderr);
  });
  await test('the update check is off with --no-check-updates and with checkUpdates: false', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf-8');
    assert.ok(/if \(s\.checkUpdates\) checkVersion\(\)/.test(src));
    assert.strictEqual(cli.resolveSettings(cli.parseArgs([]), {}).checkUpdates, true);
    assert.strictEqual(cli.resolveSettings(cli.parseArgs(['--no-check-updates']), {}).checkUpdates, false);
    assert.strictEqual(cli.resolveSettings(cli.parseArgs([]), { defaults: { checkUpdates: false } }).checkUpdates, false);
  });

  console.log('watch');
  await test('diffMissing lists what became missing and what was found again', () => {
    assert.deepStrictEqual(cli.diffMissing(['a', 'b'], ['b', 'c', 'd']), { added: ['c', 'd'], fixed: ['a'] });
    assert.deepStrictEqual(cli.diffMissing([], []), { added: [], fixed: [] });
    assert.deepStrictEqual(cli.diffMissing(['a'], ['a']), { added: [], fixed: [] });
  });
  await test('a watched map prints only the files that just became missing, then the ones found again', async () => {
    const s = session();
    const vmf = put(s.cwd, 'watched.vmf', mapText(['OK/FLOOR', 'MISSING/ONE']));
    const child = s.spawn([vmf, '--watch', '--no-wait', '--no-open']);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const until = async (pred, what, ms = 40000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (pred()) return;
      throw new Error(`timeout waiting for ${what}. Output so far:\n${out}`);
    };
    try {
      await until(() => out.includes('Watching'), 'the watch to start');
      fs.writeFileSync(vmf, mapText(['OK/FLOOR', 'MISSING/ONE', 'MISSING/TWO']));
      await until(() => out.includes('new missing file'), 'the new missing file');
      const mark = out.indexOf('new missing file');
      await until(() => out.indexOf('two.vmt', mark) > 0, 'the name of the new file');
      assert.ok(!out.slice(mark).includes('one.vmt'), 'the file that was already missing is not repeated');
      fs.writeFileSync(vmf, mapText(['OK/FLOOR', 'MISSING/ONE']));
      await until(() => out.includes('no longer missing'), 'the file found again');
      assert.ok(out.slice(out.indexOf('no longer missing')).includes('two.vmt'));
    } finally { child.kill(); }
  });

  await sleep(500); // the killed watcher may still hold its folder for a moment (Windows)
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
})().catch((e) => { console.error(e); process.exit(1); });
