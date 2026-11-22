#!/usr/bin/env node
'use strict';
// MapScraper CLI: start menu, drag & drop, or flags around src/scraper.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const figlet = require('figlet');
const { Scraper, describeChain } = require('./src/scraper');
const { optimizeTextures } = require('./src/optimize');
const { buildGMAs, writeAddonJson, cleanTags, readJpegSize, VALID_TAGS } = require('./src/publish');
const { writeReports } = require('./src/report');
const { makeT, detectLang, LANGS } = require('./src/i18n');
const { detectGamePath } = require('./src/steam');
const { watchFiles } = require('./src/watch');
const shell = require('./src/winshell');
const ui = require('./src/ui');
const { version } = require('./package.json');

const { gray, green, red, white, yellow, bold } = ui.colors;
const LATEST_URL = 'https://raw.githubusercontent.com/SpySpaille/MapScraper/main/package.json';
const CONFIG_FILE = process.env.MAPSCRAPER_CONFIG || path.join(process.env.APPDATA || os.homedir(), 'MapScraper', 'config.json');
const GIB = 1073741824;
const WORKSHOP_LIMIT = 4 * GIB; // "Current limit is around 4GB": Garry's Mod wiki, Steam Workshop Rules (it was 2 GB in 2020)
const DUPLICATE_MIN = 20 * 1048576; // a workshop item that already provides less than this is not worth a suggestion

// Settings that can be preset in config.json ("defaults") and overridden on the command line.
const DEFAULTS = {
  optimizeTextures: false, maxTexture: 2048, keepNormals: false, threads: 0,
  incremental: false, allSkins: false, compressBsp: false,
  workshop: true, fromWorkshop: false, excludeWorkshop: [],
  gma: false, splitMb: 0, tags: ['roleplay'], openReport: true, checkUpdates: true,
};
const FLAG_OF = {
  optimizeTextures: 'optimize-textures', keepNormals: 'keep-normals', incremental: 'incremental', allSkins: 'all-skins', compressBsp: 'compress-bsp',
  workshop: 'workshop', fromWorkshop: 'from-workshop', gma: 'gma', openReport: 'open', checkUpdates: 'check-updates',
};
const VALUE_OPTS = ['game', 'vmf', 'bsp', 'out', 'max-texture', 'optimize', 'threads', 'exclude-workshop', 'split-mb', 'title', 'description', 'icon', 'json', 'tags', 'lang'];
// Every other --flag is refused: a typo (--dryrun, --optimise-textures) must never run a different job than asked.
const BOOL_FLAGS = new Set([
  'help', 'h', 'all', 'materials', 'models', 'sounds', 'publish', 'dry-run', 'watch', 'strict', 'yes', 'no-wait', 'save-defaults',
  'install-context-menu', 'uninstall-context-menu',
  ...Object.values(FLAG_OF).flatMap((f) => [f, `no-${f}`]),
]);
const PRESETS = ['analyse', 'extract', 'publish', 'update', 'watch', 'custom'];

// ---------- args / settings ----------

/**
 * errors: unknown tokens / flags; noValue: value options given without a value; twoMaps: a second .vmf (or .bsp) after one
 * was already given, by --vmf / --bsp or dropped on the exe. Accepts "--opt value" and "--opt=value".
 */
function parseArgs(argv) {
  const a = { flags: new Set(), opts: {}, errors: [], noValue: [], twoMaps: [] };
  const setOpt = (name, value) => {
    if ((name === 'vmf' || name === 'bsp') && a.opts[name] !== undefined) a.twoMaps.push(`${a.opts[name]}  /  ${value}`); // never keep one silently
    else a.opts[name] = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq > 0 ? tok.slice(2, eq) : tok.slice(2);
      if (VALUE_OPTS.includes(name)) {
        const value = eq > 0 ? tok.slice(eq + 1) : argv[i + 1];
        if (value === undefined || (eq < 0 && value.startsWith('--'))) a.noValue.push(`--${name}`);
        else { setOpt(name, value); if (eq < 0) i++; }
      } else if (eq < 0 && BOOL_FLAGS.has(name)) a.flags.add(name);
      else a.errors.push(tok);
    } else if (/\.vmf$/i.test(tok)) setOpt('vmf', tok); // drag & drop
    else if (/\.bsp$/i.test(tok)) setOpt('bsp', tok);
    else a.errors.push(tok);
  }
  return a;
}

/** Effective settings: defaults < config.json < command line. */
function resolveSettings(args, cfg) {
  const s = { ...DEFAULTS, ...(cfg.defaults || {}) };
  for (const [key, flag] of Object.entries(FLAG_OF)) {
    if (args.flags.has(flag)) s[key] = true;
    if (args.flags.has(`no-${flag}`)) s[key] = false;
  }
  const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  if (args.opts['max-texture'] !== undefined) s.maxTexture = int(args.opts['max-texture'], s.maxTexture);
  if (args.opts.threads !== undefined) s.threads = int(args.opts.threads, s.threads);
  if (args.opts['split-mb'] !== undefined) s.splitMb = int(args.opts['split-mb'], s.splitMb);
  if (args.opts['exclude-workshop'] !== undefined) s.excludeWorkshop = String(args.opts['exclude-workshop']).split(/[,; ]+/).filter(Boolean);
  if (args.opts.tags !== undefined) s.tags = String(args.opts.tags).split(/[,; ]+/).filter(Boolean);
  if (!Array.isArray(s.excludeWorkshop)) s.excludeWorkshop = [];
  s.tags = cleanTags(s.tags);
  return s;
}

/** Options a start-menu entry switches on, on top of the saved defaults. */
function applyPreset(s, preset) {
  const out = { ...s, dryRun: false, watch: false };
  if (preset === 'analyse') out.dryRun = true;
  if (preset === 'publish') { out.optimizeTextures = true; out.compressBsp = true; out.gma = true; }
  if (preset === 'update' || preset === 'watch') out.incremental = true;
  if (preset === 'watch') { out.watch = true; out.gma = false; }
  return out;
}

function pickLang(args, cfg) {
  const wanted = String(args.opts.lang || cfg.lang || '').toLowerCase();
  return LANGS.includes(wanted) ? wanted : detectLang();
}

/** Should we show the start menu? Only for a human: a terminal, and nothing but (at most) a dropped file. */
function wantsMenu(args, isTTY) {
  return !!isTTY && args.flags.size === 0 && Object.keys(args.opts).every((k) => ['vmf', 'bsp', 'lang', 'game'].includes(k));
}

// ---------- config ----------

/**
 * @returns {{cfg:object, broken:boolean}} broken: the file exists but is not a JSON object. It is hand-editable, and the
 * program rewrites it at every start, so a typo must not silently wipe the language, the recent maps and the publication details.
 */
function readConfig(file = CONFIG_FILE) {
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return { cfg: {}, broken: false }; } // no file yet
  if (!text.trim()) return { cfg: {}, broken: false };
  try {
    const cfg = JSON.parse(text);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return { cfg, broken: false };
  } catch { /* fall through */ }
  return { cfg: {}, broken: true };
}
const loadConfig = (file) => readConfig(file).cfg;

/** Keeps the unreadable config next to itself before the defaults overwrite it. @returns the copy's path, or '' when it could not be made */
function keepBrokenConfig(file = CONFIG_FILE) {
  const copy = `${file}.broken-${Date.now()}`;
  try { fs.copyFileSync(file, copy); return copy; } catch { return ''; }
}
function saveConfig(cfg, file = CONFIG_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2)); // atomic: never a half-written config
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* ignore */ }
}

/**
 * Most recently used maps first, then the newest VMFs of the folders they live in, then (what room is left, 5 at most) the newest
 * compiled maps of the game folder: a map that only exists as a .bsp has no VMF to be listed.
 */
function recentMaps(cfg, limit = 9) {
  const seen = new Set(), out = [];
  const push = (file) => {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) return;
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st || !st.isFile()) return;
    seen.add(key);
    out.push({ file: path.resolve(file), mtime: st.mtimeMs });
  };
  const recent = Array.isArray(cfg.recent) ? cfg.recent : [];
  for (const f of recent) push(f);
  const siblings = [];
  for (const dir of [...new Set(recent.map((f) => path.dirname(path.resolve(f))))]) {
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!/\.vmf$/i.test(n)) continue;
        const p = path.join(dir, n), st = fs.statSync(p, { throwIfNoEntry: false });
        if (st && st.isFile()) siblings.push({ file: p, mtime: st.mtimeMs });
      }
    } catch { /* folder gone */ }
  }
  siblings.sort((a, b) => b.mtime - a.mtime);
  for (const s of siblings) { if (out.length >= limit) break; push(s.file); }
  if (cfg.gamepath && out.length < limit) {
    const listed = new Set(out.map((m) => mapKey(m.file))); // a .bsp whose .vmf is listed is picked up through the VMF
    const dir = path.join(cfg.gamepath, 'maps'), bsps = [];
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!/\.bsp$/i.test(n)) continue;
        const p = path.join(dir, n), st = fs.statSync(p, { throwIfNoEntry: false });
        if (st && st.isFile() && !listed.has(mapKey(p))) bsps.push({ file: p, mtime: st.mtimeMs });
      }
    } catch { /* no maps folder */ }
    bsps.sort((a, b) => b.mtime - a.mtime);
    for (const b of bsps.slice(0, 5)) { if (out.length >= limit) break; push(b.file); }
  }
  return out.slice(0, limit);
}

function rememberMap(cfg, file) {
  const abs = path.resolve(file);
  cfg.recent = [abs, ...(Array.isArray(cfg.recent) ? cfg.recent : []).filter((f) => path.resolve(f).toLowerCase() !== abs.toLowerCase())].slice(0, 10);
}

const mapKey = (file) => path.basename(file, path.extname(file)).toLowerCase();

/** What changed in the list of missing files between two runs of a watched map. */
function diffMissing(before, after) {
  const was = new Set(before), is = new Set(after);
  return { added: [...is].filter((f) => !was.has(f)), fixed: [...was].filter((f) => !is.has(f)) };
}

/** Problem with a workshop icon file: { fatal, msg } or null. A wrong size only warns (the workshop may still take it). */
function checkIcon(file, t) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return { fatal: true, msg: t('icon.missing', { file }) };
  const size = readJpegSize(file);
  if (!size) return { fatal: true, msg: t('icon.notJpeg', { file }) };
  if (size.width !== 512 || size.height !== 512) return { fatal: false, msg: t('icon.badSize', { file, w: size.width, h: size.height }) };
  return null;
}

// ---------- output ----------

function usage(t) {
  console.log(t('usage', { config: CONFIG_FILE, tags: VALID_TAGS.join(', ') }));
}

function printSizes(r, willOptimize, ctx) {
  const { t, fmt } = ctx;
  const b = r.bytes;
  const cats = [['textures', '🖼️ '], ['models', '📐'], ['materials', '🧱'], ['sounds', '🔊'], ['bsp', '🗺️ '], ['particles', '✨'], ['other', '📄']]
    .filter(([c]) => b[c] > 0)
    .map(([c, icon]) => `${icon} ${c} ${white(fmt.bytes(b[c]))}`);
  console.log(`\n  💾 ${white(t('sum.total'))} ${green(fmt.bytes(b.total))}  ${gray(cats.join('  ·  '))}`);
  if (r.largest.length) {
    console.log(`  ${gray(t('sum.largest'))}`);
    for (const f of r.largest.slice(0, 5)) console.log(gray(`   ${fmt.bytes(f.size).padStart(10)}  ${f.rel}`));
  }
  if (r.bigTextures.length && !willOptimize) {
    const sum = r.bigTextures.reduce((a, f) => a + f.size, 0);
    console.log(`\n${yellow(t('sum.bigTextures', { n: r.bigTextures.length, size: fmt.bytes(sum) }))}`);
  }
}

function printSummary(r, willOptimize, ctx) {
  const { t, fmt } = ctx;
  const s = r.stats;
  const addonLine = (a) => `${String(a.files).padStart(6)} ${t('sum.filesWord')} ${a.bytes ? fmt.bytes(a.bytes).padStart(10) : ''.padStart(10)}  ${a.id ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${a.id}` : '(local .gma)'}  ${a.name}`;
  console.log(`\n${green(t(r.dryRun ? 'sum.dryDone' : 'sum.done'))} ${gray(`${t('sum.in', { time: fmt.duration(r.ms) })} → ${r.outputDir}`)}\n`);
  console.log(`  🧱 ${green(s.materials)} ${white(t('sum.materials'))} ${gray(`(${t('sum.referenced', { n: r.referenced.materials })})`)}`);
  console.log(`  🖼️  ${green(s.textures)} ${white(t('sum.textures'))} ${gray(`(${t('sum.referenced', { n: r.referenced.textures })})`)}`);
  console.log(`  📐 ${green(s.models)} ${white(t('sum.models'))} ${gray(`(${t('sum.referenced', { n: r.referenced.models })}${s.skinPruned ? `, ${t('sum.skinPruned', { n: s.skinPruned })}` : ''})`)}`);
  console.log(`  🔊 ${green(s.sounds)} ${white(t('sum.sounds'))} ${gray(`(${t('sum.soundDetail', r.referenced)})`)}`);
  console.log(`  ✨ ${green(s.particles)} ${white(t('sum.particles'))} ${gray(`(${t('sum.effects', { n: r.referenced.effects })})`)}`);
  if (s.instances) console.log(`  🧩 ${green(s.instances)} ${white(t('sum.instances'))}`);
  if (r.bsp) console.log(`  🗺️  ${white(t('sum.bspRead'))} ${gray(`${t('sum.bspDetail', { version: r.bsp.version, compressed: r.bsp.compressed ? t('sum.bspCompressedTag') : '', pak: r.bsp.pakFiles })}${s.inBsp ? `, ${t('sum.inBsp', { n: s.inBsp })}` : ''}`)}`);
  console.log(`  📦 ${green(s.files)} ${white(t('sum.files'))}${r.incremental ? gray(` (${t('sum.incremental', s)})`) : ''}`);
  if (r.packed.length) console.log(`  🗜️  ${green(r.packed.length)} ${white(t('sum.packed'))} ${gray(r.packed.slice(0, 5).join(', '))}${r.packed.length > 5 ? gray(' …') : ''}`);
  if (r.bspCompression) console.log(`  🗜️  ${white(t('sum.bspCompressed'))} ${fmt.bytes(r.bspCompression.before)} → ${green(fmt.bytes(r.bspCompression.after))} ${gray(`(${r.bspCompression.tool})`)}`);
  if (r.stock.length) console.log(`  💿 ${gray(t('sum.stock', { n: r.stock.length }))}`);
  printSizes(r, willOptimize, ctx);

  if (r.diff && (r.diff.added.length || r.diff.removed.length || r.diff.changed.length)) {
    console.log(`\n${white(t('sum.diff', { added: r.diff.added.length, addedSize: fmt.bytes(r.diff.addedBytes), removed: r.diff.removed.length, removedSize: fmt.bytes(r.diff.removedBytes), changed: r.diff.changed.length }))}`);
  }
  const w = r.workshop;
  if (w.excluded.length) { console.log(`\n${green(t('sum.excluded'))}`); for (const a of w.excluded) console.log(gray(`  ${addonLine(a)}`)); }
  if (w.extracted.length) { console.log(`\n${green(t('sum.extracted'))}`); for (const a of w.extracted) console.log(gray(`  ${addonLine(a)}`)); }
  if (w.required.length) { console.log(`\n${yellow(t('sum.required', { n: r.workshopMissing.length }))}`); for (const a of w.required) console.log(gray(`  ${addonLine(a)}`)); }
  const twins = w.duplicates.filter((a) => a.id && a.bytes >= DUPLICATE_MIN).slice(0, 3); // biggest first; local .gma have no id to exclude
  if (twins.length) {
    console.log(`\n${yellow(t('sum.duplicates', { size: fmt.bytes(twins.reduce((n, a) => n + a.bytes, 0)) }))}`);
    for (const a of twins) console.log(gray(`  ${addonLine(a)}   → --exclude-workshop ${a.id}`));
  }
  if (r.missing.length) {
    console.log(`\n${yellow(t('sum.missing', { n: r.missing.length }))}`);
    for (const m of r.missing.slice(0, 8)) {
      console.log(`   ${gray('-')} ${white(m)}`);
      const chain = describeChain(r.missingRefs[m] || [], t);
      if (chain) console.log(gray(`       ${t('sum.usedBy')} ${chain}`));
    }
    if (r.missing.length > 8) console.log(gray(`   ${t('sum.missingMore', { n: r.missing.length - 8 })}`));
  }
  if (r.incompleteModels.length) console.log(`\n${yellow(t('sum.incomplete', { n: r.incompleteModels.length }))} ${gray(r.incompleteModels.slice(0, 4).join(', '))}${r.incompleteModels.length > 4 ? gray(' …') : ''}`);
  const un = r.unresolved;
  const unCount = un.soundscripts.length + un.soundscapes.length + un.effects.length;
  if (unCount) {
    console.log(`\n${yellow(t('sum.unresolved', { n: unCount }))}`);
    const cut = (list) => `${list.slice(0, 12).join(', ')}${list.length > 12 ? ' …' : ''}`;
    if (un.effects.length) console.log(gray(`   ${t('sum.unresolved.effects')} : ${cut(un.effects)}`));
    if (un.soundscapes.length) console.log(gray(`   ${t('sum.unresolved.soundscapes')} : ${cut(un.soundscapes)}`));
    if (un.soundscripts.length) console.log(gray(`   ${t('sum.unresolved.soundscripts')} : ${cut(un.soundscripts)}`));
  }
  for (const n of r.notes) console.log(`\n${yellow(`ℹ️  ${n}`)}`);
  for (const x of r.warnings) console.log(`\n${red(`❌ ${x}`)}`);
}

// ---------- steps ----------

async function runOptimize(dir, s, normalMaps, ctx) {
  const { t, fmt } = ctx;
  const status = ui.createStatus(t, fmt);
  let res;
  try {
    res = await optimizeTextures(dir, {
      maxSize: s.maxTexture, keepNormals: s.keepNormals, normalMaps, threads: s.threads,
      onProgress: (i, n, f) => status.phase(t('opt.progress', { done: i, total: n, file: f }), true),
    });
  } finally { status.stop(); }
  const pct = res.before ? Math.round((res.saved / res.before) * 100) : 0;
  console.log(`\n${green(t('opt.done'))} ${gray(t('opt.threads', { time: fmt.duration(res.ms), threads: res.threads }))}`);
  console.log(`  ${green(res.converted.length)} ${white(t('opt.reencoded'))} ${fmt.bytes(res.before)} → ${fmt.bytes(res.after)}  ${green(`(-${fmt.bytes(res.saved)}, -${pct}%)`)}`);
  if (res.lossless) console.log(gray(`  ${t('opt.lossless', { n: res.lossless, size: fmt.bytes(res.losslessSaved) })}`));
  if (res.untouched) console.log(gray(`  ${t('opt.untouched', { n: res.untouched })}`));
  if (res.keptNormals || res.cappedNormals) console.log(gray(`  ${t('opt.normals', { kept: res.keptNormals, capped: res.cappedNormals })}`));
  for (const c of res.converted.slice(0, 5)) console.log(gray(`   ${fmt.bytes(c.before).padStart(10)} → ${fmt.bytes(c.after).padStart(10)}  ${c.rel}  (${c.from} → ${c.to})`));
  if (res.skipped.length) {
    const reasons = {};
    for (const x of res.skipped) reasons[x.reason] = (reasons[x.reason] || 0) + 1;
    console.log(gray(`  ${t('opt.skipped')} ${Object.entries(reasons).map(([k, n]) => `${n}× ${k}`).join(', ')}`));
  }
  return res;
}

/** The archives the workshop would refuse for their size (strictly above the limit). */
const tooBig = (archives, limit = WORKSHOP_LIMIT) => archives.filter((a) => a.size > limit);

async function runGma(result, s, { title, description, icon }, gamepath, ctx) {
  const { t, fmt } = ctx;
  const status = ui.createStatus(t, fmt);
  let res;
  try {
    res = await buildGMAs({
      dir: result.outputDir, outBase: result.outputDir, title, description, tags: s.tags, splitBytes: s.splitMb * 1048576,
      onProgress: (part, parts, done, total) => status.phase(t('gma.progress', { part: parts > 1 ? `${part}/${parts} ` : '', percent: total ? Math.round((done / total) * 100) : 100 }), true),
    });
  } finally { status.stop(); }
  console.log(`\n${green(t('gma.done'))}`);
  for (const a of res.archives) console.log(`  ${white(a.file)} ${gray(`(${fmt.bytes(a.size)}, ${a.count} ${t('sum.filesWord')})`)}`);
  for (const a of tooBig(res.archives)) console.log(yellow(`  ${t('gma.tooBig', { file: path.basename(a.file), size: fmt.bytes(a.size), limit: fmt.bytes(WORKSHOP_LIMIT) })}`));
  const gmpublish = path.join(path.dirname(gamepath), 'bin', 'gmpublish.exe');
  console.log(gray(`  ${t('gma.publish')}`));
  for (const a of res.archives) console.log(gray(`   "${gmpublish}" create -icon "${icon || 'icon.jpg'}" -addon "${a.file}"`));
  return res;
}

/**
 * One full pass on a map: plan, (confirm), copy, optimise, package, report.
 * @returns the scraper summary (+ reports), or null when the user cancelled.
 */
async function runMap(job, ctx) {
  const { t, fmt } = ctx;
  const { s, extract, gamepath, quiet } = job;
  const optimizeSig = s.optimizeTextures ? `${s.maxTexture}${s.keepNormals ? '|keep-normals' : ''}` : 'off';
  let status = ui.createStatus(t, fmt);
  let scraper, plan, result;
  try {
    scraper = new Scraper({
      gamepath, vmf: job.vmf, bsp: job.bsp, outputDir: job.out, extract, dryRun: s.dryRun, incremental: s.incremental, allSkins: s.allSkins,
      workshop: s.workshop, fromWorkshop: s.fromWorkshop, excludeWorkshop: s.excludeWorkshop, compressBsp: s.compressBsp, optimizeSig, t,
      cacheDir: job.cacheDir, onStatus: (m) => status.phase(m, quiet), onProgress: (p) => { if (!quiet) status.progress(p); },
    });
    plan = await scraper.plan(fmt.bytes);
  } finally { status.stop(); }
  if (!s.dryRun && !quiet) {
    console.log(`\n${white(t('plan.summary', { files: plan.writeFiles, size: fmt.bytes(plan.writeBytes), kept: plan.keptFiles, free: fmt.bytes(plan.free) }))}`);
    console.log(gray(`   ${t('plan.dir', { dir: scraper.outputDir })}`));
    if (job.confirm && plan.writeBytes >= GIB && !(await ui.askYN(t('ask.continue'), true, t))) { console.log(gray(t('plan.cancelled'))); return null; }
  }
  status = ui.createStatus(t, fmt);
  try { result = await scraper.execute(); } finally { status.stop(); }
  if (!quiet) printSummary(result, s.optimizeTextures && !s.dryRun, ctx);

  let optRes = null, gmaRes = null;
  if (!s.dryRun) {
    if (s.optimizeTextures && extract.materials) {
      const o = { maxSize: s.maxTexture, keepNormals: s.keepNormals, normalMaps: result.normalMaps, threads: s.threads };
      optRes = quiet ? await optimizeTextures(result.outputDir, o) : await runOptimize(result.outputDir, s, result.normalMaps, ctx);
    }
    const title = job.title || result.mapname;
    if (extract.others) writeAddonJson(result.outputDir, { title, description: job.description, tags: s.tags, ignore: result.notGmaAllowed });
    if (s.gma) gmaRes = await runGma(result, s, { title, description: job.description, icon: job.icon }, gamepath, ctx);
  }
  result.reports = writeReports(result, { optRes, gmaRes, t, fmt, version });
  return result;
}

/** Re-runs the (incremental) extraction every time the VMF / BSP changes. Never resolves: Ctrl+C ends it. */
function watchMap(job, first, ctx) {
  const { t, fmt } = ctx;
  const main = job.vmf || job.bsp;
  const bspFile = (first && first.bsp && first.bsp.file) || job.bsp || path.join(job.gamepath, 'maps', `${path.basename(main, path.extname(main))}.bsp`);
  const files = [...new Set([job.vmf, bspFile].filter(Boolean))];
  console.log(`\n${white(t('watch.start', { files: files.map((f) => path.basename(f)).join(' + ') }))}`);
  const now = () => new Date().toLocaleTimeString(t.lang);
  ui.closePrompts();
  let known = first ? first.missing : []; // what the previous cycle could not find: only the difference is worth a line
  const list = (r, names) => { for (const m of names.slice(0, 5)) { const chain = describeChain(r.missingRefs[m] || [], t); console.log(`   ${gray('-')} ${white(m)}${chain ? gray(`   ${t('sum.usedBy')} ${chain}`) : ''}`); } if (names.length > 5) console.log(gray(`   … +${names.length - 5}`)); };
  return new Promise(() => {
    watchFiles(files, async () => {
      const r = await runMap({ ...job, quiet: true, confirm: false }, ctx);
      if (!r) return;
      console.log(`${gray(`[${now()}]`)} ${t('watch.line', { written: r.stats.written, stale: r.stats.stale, size: fmt.bytes(r.bytes.total), time: fmt.duration(r.ms) })}${r.missing.length ? yellow(`  ⚠️ ${r.missing.length}`) : ''}`);
      const { added, fixed } = diffMissing(known, r.missing);
      known = r.missing;
      if (added.length) { console.log(yellow(`   ${t('watch.newMissing', { n: added.length })}`)); list(r, added); }
      if (fixed.length) { console.log(green(`   ${t('watch.fixed', { n: fixed.length })}`)); for (const m of fixed.slice(0, 5)) console.log(gray(`   - ${m}`)); if (fixed.length > 5) console.log(gray(`   … +${fixed.length - 5}`)); }
    }, {
      settle: job.settle,
      onDetect: () => console.log(`${gray(`[${now()}]`)} ${gray(t('watch.changed'))}`),
      onError: (e) => console.error(`${gray(`[${now()}]`)} ${red(`❌ ${e.message}`)}`),
    });
  });
}

// ---------- interactive ----------

function ago(ms, t) {
  const min = Math.max(1, Math.round((Date.now() - ms) / 60000));
  if (min < 60) return t('map.ago.minutes', { n: min });
  if (min < 48 * 60) return t('map.ago.hours', { n: Math.round(min / 60) });
  return t('map.ago.days', { n: Math.round(min / 1440) });
}

const validMap = (t) => (p) => (/\.(vmf|bsp)$/i.test(p) && fs.existsSync(p) ? null : t('map.invalid'));
const validGame = (t) => (p) => (p && fs.existsSync(path.join(p, 'materials')) ? null : t('game.invalid'));

async function chooseMap(ctx) {
  const { t, cfg } = ctx;
  const maps = recentMaps(cfg);
  if (maps.length) {
    const options = maps.map((m) => ({ label: path.basename(m.file), hint: `${path.basename(path.dirname(m.file))}, ${ago(m.mtime, t)}`, value: m.file }));
    options.push({ label: t('map.other'), value: '' });
    const picked = await ui.choose(t('map.choose'), options, { def: maps[0].file, t });
    if (picked) return picked;
  }
  return ui.askUntil(t('map.ask'), validMap(t), t);
}

async function chooseAction(ctx, mapName) {
  const { t } = ctx;
  const options = PRESETS.map((key) => ({ label: t(`menu.${key}`), hint: t(`menu.${key}.hint`), value: key }));
  if (!mapName) options.push({ label: t('menu.optimize'), value: 'optimize' }, { label: t('menu.settings'), value: 'settings' });
  return ui.choose(mapName ? t('menu.titleFor', { map: mapName }) : t('menu.title'), options, { def: 'extract', zero: t('menu.quit'), t });
}

async function customOptions(s, ctx) {
  const { t } = ctx;
  const out = { ...s, dryRun: false, watch: false };
  const all = await ui.askYN(t('ask.everything'), true, t);
  const extract = all ? { materials: true, models: true, sounds: true, others: true } : {
    materials: await ui.askYN(t('ask.materials'), undefined, t), models: await ui.askYN(t('ask.models'), undefined, t),
    sounds: await ui.askYN(t('ask.sounds'), undefined, t), others: await ui.askYN(t('ask.others'), undefined, t),
  };
  out.incremental = await ui.askYN(t('ask.incremental'), s.incremental, t);
  out.optimizeTextures = await ui.askYN(t('ask.optimize', { px: s.maxTexture }), s.optimizeTextures, t);
  out.compressBsp = await ui.askYN(t('ask.compressBsp'), s.compressBsp, t);
  out.gma = await ui.askYN(t('ask.gma'), s.gma, t);
  return { s: out, extract };
}

/**
 * Workshop details of a map that is about to become a .gma: title, description, tags, icon.
 * Remembered per map in config.json ("publish"), so the next publication is Enter four times.
 * @returns {{title:string, description:string, icon:string, tags:string[]}}
 */
async function askPublishInfo(job, ctx) {
  const { t, cfg } = ctx;
  const key = mapKey(job.vmf || job.bsp);
  const known = (cfg.publish && cfg.publish[key]) || {};
  const none = (v) => (v === '-' ? '' : v);
  const title = await ui.askDefault(t('pub.title'), known.title || key, t);
  const description = none(await ui.askDefault(t('pub.description'), known.description || '', t));
  const tags = cleanTags((await ui.askDefault(t('pub.tags', { valid: VALID_TAGS.join(', ') }), job.s.tags.join(','), t)).split(/[,; ]+/));
  console.log(gray(`   ${tags.join(', ')}`));
  const offered = known.icon && !(checkIcon(known.icon, t) || {}).fatal ? known.icon : ''; // a vanished icon is not proposed again
  let icon = '';
  for (;;) {
    icon = none(ui.unquote(await ui.askDefault(t('pub.icon'), offered, t)));
    const problem = icon ? checkIcon(path.resolve(icon), t) : null;
    if (problem) console.log(problem.fatal ? red(`  ${problem.msg}`) : yellow(`  ${problem.msg}`));
    if (!problem || !problem.fatal) break;
  }
  if (icon) icon = path.resolve(icon);
  cfg.publish = { ...cfg.publish, [key]: { title, description, icon } };
  cfg.defaults = { ...DEFAULTS, ...(cfg.defaults || {}), tags };
  saveConfig(cfg);
  return { title, description, icon, tags };
}

function toggleContextMenu(install, ctx) {
  const { t } = ctx;
  if (!shell.supported()) { console.log(yellow(t('shell.windowsOnly'))); return false; }
  try {
    if (install) shell.install({ label: t('shell.label') }); else shell.uninstall();
    console.log(green(t(install ? 'shell.installed' : 'shell.removed')));
    return true;
  } catch (e) { console.log(red(t('shell.failed', { error: e.message }))); return false; }
}

async function settingsMenu(ctx) {
  for (;;) {
    const { t, cfg } = ctx;
    const d = { ...DEFAULTS, ...(cfg.defaults || {}) };
    const yn = (v) => (v ? t('cli.yes') : t('cli.no'));
    const installed = shell.supported() ? !!shell.installedCommand() : false;
    const rows = [ // [value, message key, what is shown]
      ['lang', 'settings.lang', t.lang === 'fr' ? 'Français' : 'English'],
      ['optimizeTextures', 'settings.optimize', yn(d.optimizeTextures)],
      ['keepNormals', 'settings.keepNormals', yn(d.keepNormals)],
      ['maxTexture', 'settings.maxTexture', d.maxTexture || '∞'],
      ['compressBsp', 'settings.compressBsp', yn(d.compressBsp)],
      ['incremental', 'settings.incremental', yn(d.incremental)],
      ['gma', 'settings.gma', yn(d.gma)],
      ['splitMb', 'settings.splitMb', d.splitMb || t('cli.none')],
      ['tags', 'settings.tags', cleanTags(d.tags).join(', ')],
      ['allSkins', 'settings.allSkins', yn(d.allSkins)],
      ['workshop', 'settings.workshop', yn(d.workshop)],
      ['fromWorkshop', 'settings.fromWorkshop', yn(d.fromWorkshop)],
      ['excludeWorkshop', 'settings.exclude', d.excludeWorkshop.length ? d.excludeWorkshop.join(', ') : t('cli.none')],
      ['threads', 'settings.threads', d.threads || t('settings.auto')],
      ['openReport', 'settings.openReport', yn(d.openReport)],
      ['checkUpdates', 'settings.checkUpdates', yn(d.checkUpdates)],
      ['contextMenu', 'settings.contextMenu', installed ? t('settings.installed') : t('settings.notInstalled')],
      ['game', 'settings.game', cfg.gamepath || t('cli.none')],
    ];
    const pick = await ui.choose(t('settings.title'), rows.map(([value, key, shown]) => ({ label: `${t(key)} : ${shown}`, value })), { zero: '←', t });
    if (!pick) return;
    if (pick === 'lang') { cfg.lang = t.lang === 'fr' ? 'en' : 'fr'; ctx.t = makeT(cfg.lang); ctx.fmt = ui.makeFmt(cfg.lang); }
    else if (['maxTexture', 'splitMb', 'threads'].includes(pick)) { // whole numbers, 0 allowed
      const n = parseInt(await ui.ask(t(`settings.ask${pick[0].toUpperCase()}${pick.slice(1)}`), t), 10);
      if (Number.isFinite(n) && n >= 0) d[pick] = n;
    }
    else if (pick === 'tags') d.tags = cleanTags((await ui.ask(t('settings.askTags', { valid: VALID_TAGS.join(', ') }), t)).split(/[,; ]+/));
    else if (pick === 'excludeWorkshop') d.excludeWorkshop = (await ui.ask(t('settings.askExclude'), t)).split(/[,; ]+/).map((x) => x.trim()).filter(Boolean);
    else if (pick === 'contextMenu') toggleContextMenu(!installed, ctx);
    else if (pick === 'game') cfg.gamepath = path.resolve(await ui.askUntil(t('game.ask'), validGame(t), t));
    else d[pick] = !d[pick];
    cfg.defaults = d;
    saveConfig(cfg);
    console.log(gray(`  ${ctx.t('settings.saved')}`));
  }
}

// ---------- main ----------

function isNewer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkVersion() {
  if (typeof fetch !== 'function' || process.env.MAPSCRAPER_OFFLINE) return null;
  try {
    const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(3000) });
    const v = String((await res.json()).version || '');
    return /^\d+(\.\d+){0,3}$/.test(v) ? v : null; // only ever print something that looks like a version
  } catch { return null; }
}

async function resolveGamePath(args, ctx) {
  const { t, cfg } = ctx;
  const check = validGame(t);
  if (args.opts.game) { if (check(args.opts.game)) throw new Error(t('cli.missingGame')); return path.resolve(args.opts.game); }
  if (cfg.gamepath && !check(cfg.gamepath)) return path.resolve(cfg.gamepath);
  const found = detectGamePath();
  if (found) { console.log(`${gray('-')} ${green(t('game.detected'))} ${white(found)}`); return found; }
  return path.resolve(await ui.askUntil(t('game.ask'), check, t));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { cfg, broken } = readConfig();
  const lang = pickLang(args, cfg);
  const ctx = { t: makeT(lang), fmt: ui.makeFmt(lang), cfg, args };
  const tty = !!process.stdin.isTTY;
  // The update check runs in the background (it used to delay the start menu by up to 3 s); its notice comes at the end.
  let latest = null, updateShown = false;
  const showUpdate = () => {
    if (updateShown || !latest || !isNewer(latest, version)) return;
    updateShown = true;
    console.log(`\n${gray('-')} ${red(ctx.t('cli.outdated'))} ${gray(`${ctx.t('cli.latest', { version: latest })} · https://github.com/SpySpaille/MapScraper`)}`);
  };
  const end = () => { showUpdate(); if (!args.flags.has('no-wait') && tty) ui.waitForExit(ctx.t); else ui.closePrompts(); };

  if (args.flags.has('help') || args.flags.has('h')) { usage(ctx.t); return; }
  if (args.errors.length) throw new Error(ctx.t('cli.unknownArg', { args: args.errors.join(' ') }));
  if (args.noValue.length) throw new Error(ctx.t('cli.missingValue', { opts: args.noValue.join(' ') }));
  if (args.twoMaps.length) throw new Error(ctx.t('cli.twoMaps', { maps: args.twoMaps.join(' ; ') }));
  if (args.flags.has('watch') && args.flags.has('gma')) throw new Error(ctx.t('cli.watchGma'));
  if (args.flags.has('install-context-menu') || args.flags.has('uninstall-context-menu')) {
    if (!toggleContextMenu(args.flags.has('install-context-menu'), ctx)) process.exitCode = 1;
    return;
  }
  if (broken) { // the defaults are about to be saved over it: keep what the user wrote
    const copy = keepBrokenConfig();
    console.log(yellow(`ℹ️  ${ctx.t('cli.configBroken', { file: CONFIG_FILE })}${copy ? ` ${ctx.t('cli.configKept', { copy })}` : ''}`));
  }
  let s = resolveSettings(args, cfg);

  const optimizeFolder = async (dir) => {
    const { t, fmt } = ctx;
    if (!fs.existsSync(dir)) throw new Error(t('cli.folderNotFound', { dir }));
    console.log(`${gray('-')} ${white(t('opt.header', { dir, px: s.maxTexture || '∞', normals: s.keepNormals ? t('opt.normalsKept') : '' }))}`);
    const res = await runOptimize(dir, s, undefined, ctx);
    const report = `${dir}_optimize_report.txt`;
    const lines = [
      `${t('rep.optimisation')}: ${fmt.bytes(res.before)} -> ${fmt.bytes(res.after)}`,
      ...res.converted.map((c) => `${fmt.bytes(c.before).padStart(10)} -> ${fmt.bytes(c.after).padStart(10)}  ${c.rel}  (${c.from} -> ${c.to})`),
      '', t('rep.optSkipped'), ...res.skipped.map((x) => `${fmt.bytes(x.size).padStart(10)}  ${x.rel}  (${x.reason})`),
    ];
    fs.writeFileSync(report, `${lines.join('\n')}\n`);
    console.log(`\n${gray(t('sum.report'))} ${white(report)}`);
  };
  if (args.opts.optimize) { await optimizeFolder(path.resolve(ui.unquote(args.opts.optimize))); end(); return; }

  console.log(green(figlet.textSync('MapScraper')));
  console.log(`${gray(ctx.t('cli.madeBy'))} ${white('SpySpaille')} ${gray('❤️')}`);
  if (s.checkUpdates) checkVersion().then((v) => { latest = v; });
  console.log(`${gray('-')} ${green(ctx.t('cli.version'))} ${white(version)}\n`);

  let vmf = args.opts.vmf, bsp = args.opts.bsp;
  for (const f of [vmf, bsp]) if (f && validMap(ctx.t)(f)) throw new Error(ctx.t('cli.invalidMap', { file: f }));
  const iconFile = args.opts.icon ? path.resolve(ui.unquote(args.opts.icon)) : '';
  const iconProblem = iconFile ? checkIcon(iconFile, ctx.t) : null;
  if (iconProblem && iconProblem.fatal) throw new Error(iconProblem.msg);
  if (iconProblem) console.log(yellow(`ℹ️  ${iconProblem.msg}`));
  const gamepath = await resolveGamePath(args, ctx);
  cfg.gamepath = gamepath;
  cfg.defaults = { ...DEFAULTS, ...(cfg.defaults || {}) };
  if (args.flags.has('save-defaults')) cfg.defaults = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, s[k]]));
  if (args.opts.lang && LANGS.includes(String(args.opts.lang).toLowerCase())) cfg.lang = String(args.opts.lang).toLowerCase();
  saveConfig(cfg);

  let extract = null, interactive = false, action = null;
  const direct = !!(vmf || bsp);
  if (direct && !wantsMenu(args, tty)) { // scripted: the flags decide everything
    const all = args.flags.has('all') || !['materials', 'models', 'sounds', 'publish'].some((f) => args.flags.has(f));
    extract = { materials: all || args.flags.has('materials'), models: all || args.flags.has('models'), sounds: all || args.flags.has('sounds'), others: all || args.flags.has('publish') };
    s = { ...s, dryRun: args.flags.has('dry-run'), watch: args.flags.has('watch') };
    if (s.watch) { s.incremental = true; s.gma = false; } // same as the "watch" menu entry: no .gma rebuilt after every compile
  } else { // a human: start menu (also after a drag & drop, where no option can be typed)
    interactive = true;
    for (;;) {
      action = await chooseAction(ctx, direct ? path.basename(vmf || bsp) : '');
      if (!action) { showUpdate(); ui.closePrompts(); return; }
      if (action === 'settings') { await settingsMenu(ctx); s = resolveSettings(args, ctx.cfg); continue; }
      if (action === 'optimize') {
        await optimizeFolder(path.resolve(await ui.askUntil(ctx.t('ask.optimizeFolder'), (p) => (p && fs.existsSync(p) ? null : ctx.t('cli.folderNotFound', { dir: p })), ctx.t)));
        end();
        return;
      }
      if (!direct) { const file = await chooseMap(ctx); if (/\.bsp$/i.test(file)) bsp = file; else vmf = file; }
      if (action === 'custom') ({ s, extract } = await customOptions(s, ctx));
      else { s = applyPreset(s, action); extract = { materials: true, models: true, sounds: true, others: true }; }
      break;
    }
  }
  rememberMap(cfg, vmf || bsp);
  saveConfig(cfg);

  const job = { vmf, bsp, out: args.opts.out, title: args.opts.title, description: args.opts.description, icon: iconFile, gamepath, s, extract, confirm: interactive && !args.flags.has('yes') };
  if (interactive && s.gma && !s.dryRun) { // a .gma is about to be built: ask what the workshop page needs
    const info = await askPublishInfo(job, ctx);
    Object.assign(job, { title: info.title, description: info.description, icon: info.icon, s: { ...s, tags: info.tags } });
  }
  const started = Date.now();
  let result = await runMap(job, ctx);
  if (result && action === 'analyse' && await ui.askYN(ctx.t('ask.extractNow'), true, ctx.t).catch(() => false)) {
    job.s = applyPreset(job.s, 'extract'); // the plan is recomputed: an analysis writes nothing, so there is nothing to reuse
    result = await runMap(job, ctx);
  }
  if (result) {
    console.log(`\n${gray(ctx.t('sum.report'))} ${white(result.reports.txt)}`);
    console.log(`${gray(ctx.t('sum.reportHtml'))} ${white(result.reports.html)}`);
    if (args.flags.has('strict') && (result.missing.length || result.warnings.length)) {
      console.error(red(ctx.t('cli.strict', { missing: result.missing.length, warnings: result.warnings.length })));
      process.exitCode = 2;
    }
    if (args.opts.json) { // after a run of minutes: a missing folder must not lose the result
      const file = path.resolve(ui.unquote(args.opts.json));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    }
    if (job.s.watch && !job.s.dryRun) { showUpdate(); await watchMap(job, result, ctx); return; }
    console.log(`\n${bold(green(ctx.t('cli.thanks')))}`);
    if (Date.now() - started > 30000) ui.bell();
    if (tty && job.s.openReport && !args.flags.has('no-wait')) ui.openPath(result.reports.html);
  }
  end();
}

if (require.main === module) {
  main().catch((err) => {
    const t = makeT(pickLang(parseArgs(process.argv.slice(2)), loadConfig()));
    console.error(`\n${red(`❌ ${t('cli.error')}`)} ${err.message}`);
    if (process.env.DEBUG) console.error(err);
    process.exitCode = 1;
    if (process.stdin.isTTY && !ui.io.closed) ui.waitForExit(t); else ui.closePrompts();
  });
}

module.exports = { parseArgs, resolveSettings, applyPreset, wantsMenu, recentMaps, rememberMap, pickLang, runMap, watchMap, diffMissing, checkIcon, tooBig, readConfig, WORKSHOP_LIMIT, DEFAULTS, PRESETS };
