'use strict';
// MapScraper core: resolves every asset a map (VMF and/or compiled BSP) depends on, then copies it to an output folder.
// Two steps: plan() works out what is needed (fast, nothing is written), execute() writes the output with progress.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const kv = require('./kv');
const { parseMDL, texturesForSkins, vtxReplacementMaterials } = require('./mdl');
const { loadStockIndex, readVpkFile } = require('./vpk');
const { BSP, packFiles } = require('./bsp');
const { crc32 } = require('./crc32');
const { WorkshopIndex } = require('./gma');
const { isGmaAllowed } = require('./publish');
const { makeT } = require('./i18n');
const { parsePCF, stringsOf } = require('./pcf');
const K = require('./keys');

// .dx80.vtx / .sw.vtx are never loaded by Garry's Mod (DX9 only): skipping them saves space.
const MODEL_VARIANTS = ['.vvd', '.phy', '.ani', '.dx90.vtx'];
const BIG_TEXTURE = 16 * 1024 * 1024;
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg']);
const CONTENT_DIRS = ['materials', 'models', 'sound', 'particles', 'scripts', 'maps', 'scenes', 'resource'];
const OUTPUT_ENTRIES = new Set([...CONTENT_DIRS, 'addon.json', 'detail.vbsp', 'zipfiles.txt', 'cfg', 'data', 'lua']);
const SKY_SIDES = ['up', 'dn', 'lf', 'rt', 'ft', 'bk'];
const BUMP_KEYS = new Set(['bumpmap', 'bumpmap2', 'normalmap', 'normalmap2', 'ssbump', 'bumpmask']);
const ASSET_EXT = /\.(mdl|vmt|vtf|wav|mp3|ogg|pcf)$/i;
// The run is bounded ({1,260}, Windows MAX_PATH): with a bare "+", a megabyte of path characters without an extension
// costs a quadratic time (80 KB already took 6 s), which a hostile "code" value or script could use to freeze the tool.
const ASSET_IN_TEXT = /[\w\/\\.\-]{1,260}\.(?:mdl|vmt|vtf|wav|mp3|ogg|pcf)\b/gi;
const STATE_VERSION = 1;
// The engine strips whatever extension a VMT gives to a texture name, then looks for the .vtf
const TEXTURE_EXTS = ['.vtf', '.vmt', '.tga', '.psd', '.png', '.jpg', '.jpeg', '.bmp'];
// Output files are written under this suffix, then renamed (same suffix as optimize.js): an interrupted run never
// leaves a truncated file under its real name, which a later --incremental run would otherwise keep.
const TMP_SUFFIX = '.mstmp';

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { const st = fs.statSync(p, { throwIfNoEntry: false }); return !!st && st.isFile(); };

/** Text taken from map / addon files ends up in the console and the reports: drop control characters (terminal escape sequences). */
const clean = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, '');

/** Normalise a game-relative path: forward slashes, no leading ./ or /, lowercase. */
function norm(p) {
  return clean(p).trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase();
}
function stripExt(p, exts) {
  for (const e of exts) if (p.endsWith(e)) return p.slice(0, -e.length);
  return p;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Give the event loop one turn, so that the console status line can redraw before / during a long step. */
const breathe = () => new Promise((r) => setImmediate(r));

/** A game-relative path taken from untrusted data (map, material, model, addon) must stay inside the folder it is joined to. */
function isSafeRel(key) {
  if (!key || key.length > 400 || key.startsWith('/') || /[\x00-\x1f:*?"<>|]/.test(key)) return false;
  return !key.split('/').some((seg) => seg === '..' || seg === '.' || seg === '');
}
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function categoryOf(rel) {
  if (rel.startsWith('materials/')) return rel.endsWith('.vtf') ? 'textures' : 'materials';
  if (rel.startsWith('models/')) return 'models';
  if (rel.startsWith('sound/')) return 'sounds';
  if (rel.startsWith('particles/')) return 'particles';
  if (rel.endsWith('.bsp')) return 'bsp';
  return 'other';
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSize(p); else { try { total += fs.statSync(p).size; } catch { /* vanished */ } }
    }
  } catch { /* unreadable */ }
  return total;
}

function freeSpace(dir) {
  let p = path.resolve(dir);
  while (!isDir(p)) { const up = path.dirname(p); if (up === p) return Infinity; p = up; }
  try { const s = fs.statfsSync(p); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; }
}

/** Human readable form of one link of a "used by" chain. */
function describeRef(ref, t) {
  if (typeof ref === 'string') {
    const m = /^(soundscape|soundscript|effect):(.*)$/.exec(ref);
    return m ? `${m[1]} "${m[2]}"` : ref;
  }
  if (!ref) return '';
  if (ref.kind === 'entity') {
    const parts = [ref.cls || 'entity'];
    if (ref.id) parts.push(`#${ref.id}`);
    if (ref.name) parts.push(`"${ref.name}"`);
    if (ref.origin) parts.push(`${t('ref.at')} (${ref.origin})`);
    if (ref.file) parts.push(`[${ref.file}]`);
    return parts.join(' ');
  }
  if (ref.kind === 'brush') return ref.ent && ref.ent.cls && ref.ent.cls !== 'worldspawn' ? `${t('ref.brush', { id: ref.id })} (${describeRef(ref.ent, t)})` : t('ref.brush', { id: ref.id });
  if (ref.kind === 'bsp') return t(ref.what === 'staticprops' ? 'ref.bspStaticProps' : ref.what === 'pak' ? 'ref.bspPak' : 'ref.bspTexdata');
  if (ref.kind === 'map') return t('ref.mapFiles');
  return '';
}
const describeChain = (chain, t) => chain.map((r) => describeRef(r, t)).filter(Boolean).join('  ←  ');

class Scraper {
  /**
   * @param {object} o
   * @param {string} o.gamepath     e.g. .../GarrysMod/garrysmod
   * @param {string} [o.vmf]        map source (.vmf)
   * @param {string} [o.bsp]        compiled map (.bsp); found automatically in maps/ when only a VMF is given
   * @param {string} [o.outputDir]  defaults to ./<mapname>
   * @param {{materials?:boolean,models?:boolean,sounds?:boolean,others?:boolean}} [o.extract]
   * @param {boolean} [o.dryRun]          analyse only
   * @param {boolean} [o.incremental]     keep the output folder and only copy what changed
   * @param {boolean} [o.allSkins]        copy the materials of every model skin (default: only the skins the map uses)
   * @param {boolean} [o.workshop]        index installed workshop addons (default true)
   * @param {boolean} [o.fromWorkshop]    extract files that only exist inside installed workshop addons
   * @param {string[]} [o.excludeWorkshop] workshop ids (or 'all') whose files must NOT be copied (required items instead)
   * @param {boolean} [o.compressBsp]     LZMA-compress the output BSP (needs bspzipplusplus)
   * @param {string}  [o.optimizeSig]     texture optimisation settings applied after the run (for incremental mode)
   * @param {string}  [o.cacheDir]        where the workshop index / extraction cache live
   * @param {number}  [o.copyThreads]     parallel file copies (default 4)
   * @param {Function} [o.t]              translator from i18n.makeT (default: English)
   * @param {(msg:string)=>void} [o.onStatus]
   * @param {(p:{doneBytes:number,totalBytes:number,doneFiles:number,totalFiles:number,current:string})=>void} [o.onProgress]
   */
  constructor(o) {
    this.t = o.t || makeT('en');
    if (!o.vmf && !o.bsp) throw new Error(this.t('error.needMap'));
    this.gamepath = path.resolve(o.gamepath);
    this.vmfPath = o.vmf ? path.resolve(o.vmf) : null;
    this.bspPath = o.bsp ? path.resolve(o.bsp) : null;
    const main = this.vmfPath || this.bspPath;
    this.mapname = path.basename(main, path.extname(main)).toLowerCase();
    this.outputDir = path.resolve(o.outputDir || this.mapname);
    this.stateFile = `${this.outputDir}_state.json`;
    this.extract = Object.assign({ materials: true, models: true, sounds: true, others: true }, o.extract);
    this.dryRun = !!o.dryRun;
    this.incremental = !!o.incremental;
    this.allSkins = !!o.allSkins;
    this.useWorkshop = o.workshop !== false;
    this.fromWorkshop = !!o.fromWorkshop;
    const ex = (o.excludeWorkshop || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    this.excludeAll = ex.includes('all');
    this.excludeIds = new Set(ex);
    this.compressBsp = !!o.compressBsp;
    this.optimizeSig = o.optimizeSig || 'off';
    this.cacheDir = o.cacheDir;
    this.copyThreads = o.copyThreads > 0 ? o.copyThreads : 4;
    this.status = o.onStatus || (() => {});
    this.onProgress = o.onProgress || (() => {});

    this.searchPaths = [];
    this.mountPaths = [];
    this.stock = null;
    this.vpkFiles = [];
    this.bsp = null;
    this.pak = null;
    this.workshop = null;
    this.workshopAddons = 0;
    this.workshopErrors = [];
    this.resolveCache = new Map();
    this.statCache = new Map();
    this.dirCache = new Map();
    this.planList = []; // [{ key, src, size, mtime, kept?, destSize? }]
    this.copied = new Set();
    this.inBsp = new Set();
    this.excluded = new Set();
    this.missing = new Map(); // rel -> 'stock' | 'workshop' | 'missing'
    this.workshopProviders = {};
    this.warnings = [];
    this.notes = [];
    this.unresolved = { soundscripts: [], soundscapes: [], effects: [] };
    this.ws = { required: new Map(), extracted: new Map(), excluded: new Map() }; // id -> { id, name, files, bytes }
    this.unsafe = new Set(); // referenced paths that tried to leave the game folder (ignored)
    this.refs = new Map(); // what first referenced each file: rel -> parent rel | descriptor object
    this.curRef = null;

    this.materials = new Set(); this.materialQueue = [];
    this.textures = new Set();
    this.normalMaps = new Set();
    this.models = new Set(); this.modelQueue = []; this.modelDone = new Set();
    this.modelSkins = new Map(); // model -> Set<number> | 'all'
    this.pendingModels = [];
    this.skinTargets = new Set(); this.skinWildcard = false;
    this.incompleteModels = [];
    this.waves = new Set();
    this.soundScripts = new Set();
    this.soundscapes = new Set();
    this.effects = new Set();
    this.pcfs = new Set();
    this.pcfEffects = new Map(); // pcf -> particle systems the map uses in it
    this.pcfWhole = new Set();   // pcfs wanted as a whole (manifest, explicit key)
    this.files = new Map(); // rel -> optional
    this.packList = new Set();
    this.generated = new Map(); // rel -> { abs, content } files we create in the output dir
    this.packed = [];
    this.notGmaAllowed = [];
    this.bspInfo = null;
    this.bspPlan = null;
    this.bspCompression = null;
    this.prevState = null; // previous run, when continuing it (incremental)
    this.lastState = null; // previous run, whatever the mode (for the "what changed" section)
    this.diff = null;
    this.planInfo = null;
    this.planned = false;
    this.state = { version: STATE_VERSION, optimizeSig: this.optimizeSig, files: {}, bsp: null };
    this.stats = { materials: 0, textures: 0, models: 0, sounds: 0, particles: 0, files: 0, instances: 0, inBsp: 0, skinPruned: 0, pcfSystems: 0, kept: 0, written: 0, stale: 0 };
    this.bytes = { materials: 0, textures: 0, models: 0, sounds: 0, particles: 0, bsp: 0, other: 0, total: 0 };
    this.largest = []; // [{ rel, size }] top 25
    this.timings = []; // [phase, ms]
    this.ms = 0;
    this._ops = 0;
  }

  // ---------- helpers ----------

  /** Start a named phase (shown to the user, and timed for the report). */
  phase(key) {
    const now = Date.now();
    if (this._phase) this.timings.push([this._phase, now - this._phaseStart]);
    this._phase = key ? this.t(key) : null; this._phaseStart = now;
    if (key) this.status(this._phase);
  }

  // Every message goes through clean(): some variables are raw text from the map (an instance file name, ...).
  warn(key, vars) { this.warnings.push(clean(this.t(key, vars))); }
  note(key, vars) { const msg = clean(this.t(key, vars)); if (!this.notes.includes(msg)) this.notes.push(msg); }
  async tick() { if ((++this._ops & 63) === 0) await new Promise((r) => setImmediate(r)); }

  /** Remember what first referenced a file (or a soundscape / soundscript / particle name). */
  ref(key) { if (this.curRef !== null && this.curRef !== undefined && !this.refs.has(key)) this.refs.set(key, this.curRef); }

  /** Chain of referrers, from the direct one up to the entity / brush / lump it all started from. */
  chainOf(key) {
    const chain = [], seen = new Set([key]);
    let cur = this.refs.get(key);
    while (cur !== undefined && cur !== null && chain.length < 8) {
      chain.push(cur);
      if (typeof cur !== 'string' || seen.has(cur)) break;
      seen.add(cur);
      cur = this.refs.get(cur);
    }
    return chain;
  }

  initSearchPaths() {
    const add = (p) => {
      if (p && isDir(p) && !this.searchPaths.some((s) => s.toLowerCase() === p.toLowerCase())) this.searchPaths.push(p);
    };
    add(this.gamepath);
    const addons = path.join(this.gamepath, 'addons');
    if (isDir(addons)) {
      for (const d of fs.readdirSync(addons)) {
        const p = path.join(addons, d);
        if (isDir(p) && CONTENT_DIRS.some((c) => isDir(path.join(p, c)))) add(p);
      }
    }
    try {
      const nodes = kv.parse(fs.readFileSync(path.join(this.gamepath, 'cfg', 'mount.cfg'), 'utf-8'));
      for (const n of kv.walk(nodes)) if (n.value && isDir(n.value)) { this.mountPaths.push(n.value); add(n.value); }
    } catch { /* no mount.cfg */ }
    add(path.join(this.gamepath, 'download'));
  }

  loadStock() {
    const base = path.dirname(this.gamepath);
    const dirs = [this.gamepath, path.join(base, 'sourceengine'), path.join(base, 'platform'), path.join(base, 'hl2'), ...this.mountPaths];
    const { set, files, readable } = loadStockIndex(dirs);
    this.stock = set;
    this.stockFiles = readable;
    this.vpkFiles = files;
  }

  loadWorkshop() {
    if (!this.useWorkshop) return;
    try {
      this.workshop = new WorkshopIndex(this.gamepath, this.cacheDir ? { cacheDir: this.cacheDir } : {}).build();
      this.workshopAddons = this.workshop.addons.length;
      if (!this.workshop.addons.length) this.workshop = null;
    } catch (e) { this.warn('warn.workshopIndex', { error: e.message }); this.workshop = null; }
    if ((this.excludeIds.size || this.fromWorkshop) && !this.workshop) this.warn('warn.noWorkshop');
  }

  isStock(rel) { return !!this.stock && this.stock.has(norm(rel)); }

  /** Is this soundscript / soundscape / particle system defined by the game itself (inside its VPKs)? Built on first use. */
  isStockName(kind, name) {
    if (!this.stockNames) {
      const names = { soundscript: new Set(), soundscape: new Set(), effect: new Set() };
      for (const [rel, entry] of this.stockFiles || []) {
        const scapes = /^scripts\/soundscapes.*[.]txt$/.test(rel) && !rel.endsWith('manifest.txt');
        // Garry's Mod keeps its soundscripts in scripts/sounds/, other Source games in scripts/game_sounds_*.txt
        const sounds = !scapes && /^scripts\/(sounds\/.+|[^\/]*(game_sounds|npc_sounds|level_sounds)[^\/]*)[.]txt$/.test(rel);
        if (!sounds && !scapes && !rel.endsWith('.pcf')) continue;
        const buf = readVpkFile(entry);
        if (!buf) continue;
        if (rel.endsWith('.pcf')) { const pcf = parsePCF(buf); if (pcf) for (const n of pcf.systems.keys()) names.effect.add(n); continue; }
        try { for (const n of kv.parse(buf.toString('latin1'))) if (n.children) names[sounds ? 'soundscript' : 'soundscape'].add(n.key); } catch { /* unreadable stock script */ }
      }
      this.stockNames = names;
    }
    return this.stockNames[kind].has(String(name).toLowerCase());
  }

  /** Absolute path of a loose file (search paths, then - if enabled - extracted from an installed workshop addon). */
  resolve(rel) {
    const key = norm(rel);
    const cached = this.resolveCache.get(key);
    if (cached !== undefined) return cached;
    let found = null;
    if (!isSafeRel(key)) { this.unsafe.add(key); this.resolveCache.set(key, null); return null; } // "../" tricks: never leave the search paths
    const segs = key.split('/'), last = segs.pop();
    for (const sp of this.searchPaths) {
      // Walk down one cached listing per level: a search path (100+ addons) that lacks a folder costs nothing, instead of one
      // failing readdir (an exception each) per lookup. Names are matched case-insensitively and keep their real spelling.
      let dir = sp, list = this.listDir(sp);
      for (const seg of segs) {
        const hit = list.get(seg);
        if (!hit || !hit.dir) { list = null; break; }
        if (!hit.list) { hit.full = path.join(dir, hit.name); hit.list = this.listDir(hit.full); } // memoised on the entry: no join / lowercase per lookup
        dir = hit.full; list = hit.list;
      }
      const hit = list && list.get(last);
      if (!hit || hit.dir) continue;
      const full = path.join(dir, hit.name);
      const st = fs.statSync(full, { throwIfNoEntry: false });
      if (st && st.isFile()) { found = full; this.statCache.set(full, st); break; } // keep the stat: copy() needs size + mtime
    }
    if (!found && this.fromWorkshop && this.workshop && !this.isStock(key)) {
      const hit = this.workshop.extract(key);
      if (hit) { found = hit.path; this.tally(this.ws.extracted, hit.addon, fs.statSync(hit.path).size); }
    }
    this.resolveCache.set(key, found);
    return found;
  }

  /** Lower-cased entry name -> { name: real name, dir } for one folder (empty when it is missing). Cached for the whole run. */
  listDir(dir) {
    const k = dir.toLowerCase();
    let names = this.dirCache.get(k);
    if (names === undefined) {
      names = new Map();
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          // a link (junction / symlink) to a folder counts as a folder, like when the OS follows it
          const isLink = e.isSymbolicLink();
          names.set(e.name.toLowerCase(), { name: e.name, dir: e.isDirectory() || (isLink && isDir(path.join(dir, e.name))) });
        }
      } catch { /* the folder does not exist or cannot be read */ }
      this.dirCache.set(k, names);
    }
    return names;
  }

  tally(map, addon, bytes) {
    const k = addon.id || addon.file;
    const e = map.get(k) || { id: addon.id, name: addon.name, files: 0, bytes: 0 };
    e.files++; e.bytes += bytes;
    map.set(k, e);
  }

  exists(rel) {
    const key = norm(rel);
    return (!!this.pak && this.pak.has(key)) || !!this.resolve(key);
  }

  /** File content: the BSP pakfile wins over loose files, exactly like in game. */
  readBuffer(rel) {
    const key = norm(rel);
    if (this.pak && this.pak.has(key)) { const b = this.pak.read(key); if (b) return b; }
    const src = this.resolve(key);
    return src ? fs.readFileSync(src) : null;
  }

  read(rel, enc = 'utf-8') {
    const b = this.readBuffer(rel);
    return b ? b.toString(enc) : null;
  }

  /**
   * Make a game-relative file part of the output (planned now, written by execute()).
   * Returns true when the file is available: planned, already in the BSP, or provided by an excluded workshop item.
   */
  copy(rel, { optional = false } = {}) {
    const key = norm(rel);
    if (this.copied.has(key) || this.inBsp.has(key) || this.excluded.has(key)) return true;
    if (this.missing.has(key)) return false;
    if (this.pak && this.pak.has(key)) { this.inBsp.add(key); this.stats.inBsp++; return true; }
    const src = this.resolve(key);
    if (!src) {
      if (!optional) this.missing.set(key, this.classifyMissing(key));
      return false;
    }
    const st = this.statCache.get(src) || fs.statSync(src);
    if (this.workshop && (this.excludeAll || this.excludeIds.size)) {
      const by = this.workshop.providers(key).find((a) => this.excludeAll || this.excludeIds.has(a.id));
      if (by) { this.excluded.add(key); this.tally(this.ws.excluded, by, st.size); return true; }
    }
    this.planList.push({ key, src, size: st.size, mtime: st.mtimeMs });
    this.copied.add(key);
    this.stats.files++;
    return true;
  }

  classifyMissing(key) {
    if (this.isStock(key)) return 'stock';
    if (this.workshop) {
      const by = this.workshop.providers(key);
      if (by.length) {
        this.tally(this.ws.required, by[0], 0);
        this.workshopProviders[key] = `${by[0].id} ${by[0].name}`;
        return 'workshop';
      }
    }
    return 'missing';
  }

  /** Size bookkeeping per category + top-N largest files. */
  account(rel, size) {
    this.bytes[categoryOf(rel)] += size;
    this.bytes.total += size;
    const L = this.largest;
    if (L.length < 25 || size > L[L.length - 1].size) {
      L.push({ rel, size });
      L.sort((a, b) => b.size - a.size);
      if (L.length > 25) L.pop();
    }
  }

  /** List files (game-relative, lowercased) matching `re` inside `relDir` across all search paths. */
  listFiles(relDir, re) {
    const out = new Map();
    for (const sp of this.searchPaths) {
      const d = path.join(sp, relDir);
      if (!isDir(d)) continue;
      for (const f of fs.readdirSync(d)) {
        const k = f.toLowerCase();
        if (re.test(k) && !out.has(k)) out.set(k, `${relDir}/${k}`);
      }
    }
    return [...out.values()];
  }

  // ---------- VMF ----------

  /** Entities whose skin can be changed by map logic ("target,Skin,n" outputs) must keep every skin. */
  scanSkinInputs(text) {
    const re = /"[^"\r\n]*"\s+"([^"\r\n,\x1b]*)[,\x1b]skin[,\x1b]/gi;
    let m;
    while ((m = re.exec(text))) {
      const t = m[1].trim().toLowerCase();
      if (!t || t.includes('*') || t.startsWith('!')) this.skinWildcard = true;
      else this.skinTargets.add(t);
    }
  }

  /** Register the model of one entity together with the skin it uses. */
  addEntityModel(classname, model, skin, targetname) {
    if (!model || !/\.mdl$/i.test(model.trim())) return;
    const dynamic = classname !== 'prop_static' && (this.skinWildcard || (!!targetname && this.skinTargets.has(targetname.trim().toLowerCase())));
    const n = parseInt(skin, 10);
    this.addModel(model, dynamic ? undefined : (Number.isFinite(n) && n >= 0 ? n : 0));
  }

  /** Classify the key-values of one entity; its model waits until every Skin input of the map is known. */
  finishEntity(ref, pairs, onInstance) {
    for (const [key, value] of pairs) {
      if (key === 'classname') ref.cls = clean(value).toLowerCase().slice(0, 80);
      else if (key === 'id' || key === 'hammerid') ref.id = ref.id || clean(value).slice(0, 20);
      else if (key === 'origin') ref.origin = clean(value).slice(0, 60);
      else if (key === 'targetname') ref.name = clean(value).slice(0, 80);
    }
    let model = '', skin = '';
    for (const [key, value] of pairs) {
      this.curRef = ref;
      if (key === 'file' && /\.vmf$/i.test(value) && onInstance) { onInstance(value); continue; }
      if (key === 'model' && /\.mdl$/i.test(value.trim())) { model = value; continue; } // needs the skin: see flushEntityModels
      if (key === 'skin') skin = value;
      this.classify(key, value);
    }
    this.curRef = null;
    if (model) this.pendingModels.push({ ref, model, skin });
  }

  flushEntityModels() {
    for (const p of this.pendingModels) { this.curRef = p.ref; this.addEntityModel(p.ref.cls, p.model, p.skin, p.ref.name); }
    this.pendingModels = [];
    this.curRef = null;
  }

  loadVMF(file, depth = 0, seen = new Set()) {
    const abs = path.resolve(file);
    const k = abs.toLowerCase();
    if (seen.has(k) || depth > 16) return;
    seen.add(k);
    const content = fs.readFileSync(abs, 'utf-8');
    this.scanSkinInputs(content);
    const vmfDir = path.dirname(abs);
    const onInstance = (value) => {
      const inst = this.findInstance(value, vmfDir);
      if (inst) { this.stats.instances++; this.loadVMF(inst, depth + 1, seen); } else this.warn('warn.instanceNotFound', { file: value });
    };
    // One pass over the lines: "key" "value" | blockname [{] | { | }
    const re = /^[ \t]*(?:"([^"\r\n]*)"[ \t]+"([^"\r\n]*)"|([A-Za-z_]\w*)[ \t]*(\{)?|(\{)|(\}))[ \t]*\r?$/gm;
    const stack = [];
    let pendingName = '', ent = null, solidId = '', m;
    while ((m = re.exec(content))) {
      if (m[1] !== undefined) {
        const key = m[1].toLowerCase(), value = m[2];
        if (ent && stack.length === ent.depth) { ent.pairs.push([key, value]); continue; } // own key of an entity / the world
        const block = stack[stack.length - 1];
        if (block === 'solid' && key === 'id') { solidId = value; continue; }
        this.curRef = block === 'side' && key === 'material' ? { kind: 'brush', id: solidId, ent: ent ? ent.ref : null } : (ent ? ent.ref : null);
        this.classify(key, value);
        this.curRef = null;
        continue;
      }
      if (m[3] !== undefined) pendingName = m[3].toLowerCase();
      if (m[4] !== undefined || m[5] !== undefined) {
        stack.push(pendingName);
        if (!ent && (pendingName === 'entity' || pendingName === 'world')) {
          ent = { depth: stack.length, pairs: [], ref: { kind: 'entity', cls: pendingName === 'world' ? 'worldspawn' : '', id: '', origin: '', name: '' } };
          if (depth > 0) ent.ref.file = path.basename(abs);
        }
        pendingName = '';
      } else if (m[6] !== undefined) {
        const closed = stack.pop();
        if (closed === 'solid') solidId = '';
        if (ent && stack.length < ent.depth) { this.finishEntity(ent.ref, ent.pairs, onInstance); ent = null; }
      }
    }
    if (depth === 0) this.flushEntityModels();
  }

  findInstance(value, vmfDir) {
    const rel = value.replace(/\\/g, '/');
    const candidates = [
      path.join(vmfDir, rel),
      path.join(this.gamepath, 'maps', rel),
      path.join(this.gamepath, 'mapsrc', rel),
      path.join(this.gamepath, rel),
      path.join(path.dirname(this.gamepath), 'sdk_content', 'maps', rel),
    ];
    return candidates.find(isFile) || null;
  }

  // ---------- BSP ----------

  openBSP() {
    if (!this.bspPath) this.bspPath = this.resolveLoose(`maps/${this.mapname}.bsp`);
    if (!this.bspPath) return;
    try {
      this.bsp = new BSP(this.bspPath);
      this.pak = this.bsp.pak();
    } catch (e) { this.warn('warn.cannotRead', { file: this.bspPath, error: e.message }); this.bsp = null; this.pak = null; }
  }

  /** Like resolve() but never goes through the workshop (used before the index is needed). */
  resolveLoose(rel) {
    if (!isSafeRel(norm(rel))) return null;
    for (const sp of this.searchPaths) { const p = path.join(sp, norm(rel)); if (isFile(p)) return p; }
    return null;
  }

  loadBSP() {
    if (!this.bsp) return;
    const before = { materials: this.materials.size, models: this.models.size, sounds: this.waves.size + this.soundScripts.size };
    this.scanSkinInputs(this.bsp.entityText());
    for (const pairs of this.bsp.entities()) this.finishEntity({ kind: 'entity', cls: '', id: '', origin: '', name: '' }, pairs, null);
    this.flushEntityModels();
    this.curRef = { kind: 'bsp', what: 'texdata' };
    for (const name of this.bsp.texdataStrings()) this.addMaterial(name);
    this.curRef = { kind: 'bsp', what: 'staticprops' };
    for (const [model, skins] of this.bsp.staticProps()) {
      if (!skins.size) this.addModel(model, 0);
      for (const s of skins) this.addModel(model, s);
    }
    this.curRef = { kind: 'bsp', what: 'pak' };
    for (const name of this.pak.names()) if (name.startsWith('materials/') && name.endsWith('.vmt')) this.addMaterial(name);
    this.curRef = null;
    const onlyMaterials = [...this.materials].slice(before.materials).filter((m) => !m.startsWith('maps/')).length;
    this.bspInfo = {
      file: this.bspPath, version: this.bsp.version, compressed: this.bsp.isCompressed(), pakFiles: this.pak.size,
      onlyInBsp: this.vmfPath ? { materials: onlyMaterials, models: this.models.size - before.models, sounds: this.waves.size + this.soundScripts.size - before.sounds } : null,
      olderThanVmf: !!this.vmfPath && fs.statSync(this.bspPath).mtimeMs < fs.statSync(this.vmfPath).mtimeMs,
    };
    const d = this.bspInfo.onlyInBsp;
    if (d && (d.materials || d.models || d.sounds)) this.note('note.bspOnly', d);
    if (this.bspInfo.olderThanVmf) this.note('note.bspOlder');
  }

  // ---------- classification ----------

  classify(key, value) {
    const v = value.trim();
    if (!v) return;
    if (key === 'skyname') return this.addSkybox(v);
    if (key === 'effect_name') return this.addEffect(v);
    if (key === 'soundscape') return this.addSoundscape(v);
    if (key === 'code') return this.scanText(v); // lua_run
    const ext = path.extname(v).toLowerCase();
    if (ext === '.mdl') return this.addModel(v);
    if (ext === '.vmt' || ext === '.spr') return this.addMaterial(v);
    if (ext === '.vtf') return this.addTexture(v);
    if (AUDIO_EXT.has(ext)) return this.addWave(v);
    if (ext === '.pcf') return this.addPcf(v);
    if (ext === '.vcd') return this.addFile(/^scenes[\\/]/i.test(v) ? v : `scenes/${v}`, false);
    if (key === 'detailvbsp' && norm(v) === 'detail.vbsp') return; // stock default
    if (ext === '.raw' || ext === '.txt' || ext === '.vbsp' || ext === '.nut') return this.addFile(v, !K.VMF_FILE_KEYS.has(key));
    if (K.VMF_MATERIAL_KEYS.has(key)) return this.addMaterial(v);
    if (K.VMF_TEXTURE_KEYS.has(key)) { this.addTexture(v); return this.addMaterial(v, true); }
    if (K.VMF_SOUND_KEYS.has(key)) return this.addSoundScript(v);
    // I/O connections: "target,Input,parameter,delay,refire" (',' or ESC separated) may carry an asset path
    if (v.includes(',') || v.includes('\x1b')) {
      for (const part of v.split(/[,\x1b]/)) if (ASSET_EXT.test(part.trim())) this.classify('', part.trim());
    }
  }

  scanText(text) {
    const found = text.match(ASSET_IN_TEXT);
    if (found) for (const f of found) this.classify('', f);
  }

  // ---------- materials / textures ----------

  cleanMaterialName(v, exts) {
    let m = norm(v).replace(/^materials\//, '');
    m = stripExt(m, exts);
    if (!m || !/\p{L}/u.test(m) || m.startsWith('_rt_') || m === 'env_cubemap') return null;
    if (!K.SAFE.test(m)) { this.unsafe.add(`materials/${m}`); return null; } // reported, never silently dropped
    return m;
  }

  addMaterial(v, optional = false) {
    if (!this.extract.materials) return;
    const m = this.cleanMaterialName(v, ['.vmt', '.spr', '.vtf']);
    if (!m) return;
    this.ref(`materials/${m}.vmt`);
    if (this.materials.has(m)) return;
    this.materials.add(m);
    this.materialQueue.push([m, optional]);
  }

  processMaterial(m, optional) {
    const rel = `materials/${m}.vmt`;
    if (!this.copy(rel, { optional })) return;
    if (this.copied.has(rel)) this.stats.materials++;
    let nodes;
    try { nodes = kv.parse(this.read(rel, 'utf-8')); } catch { this.warn('warn.vmtParse', { file: rel }); return; }
    this.curRef = rel;
    for (const [key, values] of kv.flatten(nodes)) {
      const k = key.slice(key.lastIndexOf('?') + 1).replace(/^[$%]/, ''); // "srgb?$basetexture", "hdr?$envmap": conditional keys
      if (K.VMT_TEXTURE_KEYS.has(k)) {
        for (const val of values) {
          this.addTexture(val);
          if (BUMP_KEYS.has(k)) { const t = this.cleanMaterialName(val, TEXTURE_EXTS); if (t) this.normalMaps.add(`materials/${t}.vtf`); }
        }
      } else if (K.VMT_MATERIAL_KEYS.has(k)) for (const val of values) this.addMaterial(val);
    }
    this.curRef = null;
  }

  addTexture(v) {
    if (!this.extract.materials) return;
    const t = this.cleanMaterialName(v, TEXTURE_EXTS);
    if (!t) return;
    this.ref(`materials/${t}.vtf`);
    if (this.textures.has(t)) return;
    this.textures.add(t);
    if (this.copy(`materials/${t}.vtf`) && this.copied.has(`materials/${t}.vtf`)) this.stats.textures++;
    this.copy(`materials/${t}.hdr.vtf`, { optional: true });
  }

  addSkybox(name) {
    const n = norm(name);
    if (!n) return;
    if (!K.SAFE.test(n)) { this.unsafe.add(`materials/skybox/${n}`); return; }
    for (const side of SKY_SIDES) {
      this.addMaterial(`skybox/${n}${side}`);
      this.addMaterial(`skybox/${n}_hdr${side}`, true);
    }
  }

  // ---------- models ----------

  /** @param {number} [skin] skin index used by this reference; undefined = unknown (keep every skin) */
  addModel(v, skin) {
    if (!this.extract.models) return;
    const m = norm(v);
    if (!m.endsWith('.mdl')) return;
    if (!K.SAFE.test(m)) { this.unsafe.add(m); return; }
    this.ref(m);
    let set = this.modelSkins.get(m);
    const before = set === 'all' ? -1 : set ? set.size : 0;
    if (skin === undefined || skin < 0 || this.allSkins) set = 'all';
    else if (set !== 'all') { set = set || new Set(); set.add(skin); }
    this.modelSkins.set(m, set);
    const grew = set === 'all' ? before !== -1 : set.size !== before;
    if (!this.models.has(m)) { this.models.add(m); this.modelQueue.push(m); } else if (grew && this.modelDone.has(m)) this.modelQueue.push(m); // wider skin set: look at the materials again
  }

  processModel(m) {
    const first = !this.modelDone.has(m);
    this.modelDone.add(m);
    if (!this.copy(m)) return;
    const base = m.slice(0, -4);
    if (first) {
      if (this.copied.has(m)) this.stats.models++;
      for (const ext of MODEL_VARIANTS) this.copy(base + ext, { optional: true });
      const have = (ext) => this.copied.has(base + ext) || this.inBsp.has(base + ext) || this.excluded.has(base + ext);
      if (!have('.dx90.vtx')) for (const alt of ['.vtx', '.dx80.vtx', '.sw.vtx']) if (this.copy(base + alt, { optional: true })) break;
      const anyVtx = ['.dx90.vtx', '.vtx', '.dx80.vtx', '.sw.vtx'].some(have);
      if (!have('.vvd') || !anyVtx) this.incompleteModels.push(m);
    }

    let info = null;
    try { info = parseMDL(this.readBuffer(m)); } catch (e) { this.warn('warn.cannotRead', { file: m, error: e.message }); return; }
    if (!info) { if (first) this.warn('warn.mdlOld', { file: m }); return; }

    this.curRef = m;
    for (const inc of info.includeModels) this.addModel(/^models\//i.test(inc) ? inc : `models/${inc}`);
    if (first && info.keyvalues) this.scanText(info.keyvalues); // gib / break models and sounds declared in $keyvalues
    if (this.extract.materials) {
      const used = this.modelSkins.get(m);
      // unknown skin (it can change in game): every skin family, but still only the slots the meshes use
      const keep = this.allSkins ? null : texturesForSkins(info, used === 'all' || !used ? info.skins.map((_, i) => i) : used);
      const dirs = info.textureDirs.length ? info.textureDirs : [''];
      if (first && keep) { // materials the lower LODs swap in are not in any skin row
        const vtx = this.readBuffer(`${base}.dx90.vtx`);
        for (const name of vtx ? vtxReplacementMaterials(vtx) : []) {
          const idx = info.textures.findIndex((x) => x.toLowerCase() === path.basename(norm(name)));
          if (idx >= 0) keep.add(idx);
        }
      }
      info.textures.forEach((tex, i) => {
        if (!tex) return;
        if (keep && !keep.has(i)) { if (first) this.stats.skinPruned++; return; }
        const candidates = [...new Set([...dirs.map((d) => norm(`${d}/${tex}`)), norm(tex)])];
        const found = candidates.find((c) => this.exists(`materials/${c}.vmt`))
          || candidates.find((c) => this.isStock(`materials/${c}.vmt`))
          || candidates[0];
        this.addMaterial(found);
      });
    }
    this.curRef = null;
  }

  // ---------- sounds ----------

  addWave(v) {
    if (!this.extract.sounds) return;
    const s = norm(v).replace(/^[^a-z0-9_\/.]+/, '').replace(/^sound\//, ''); // strip ^*#@)( ... prefixes
    if (!s || !AUDIO_EXT.has(path.extname(s))) return;
    this.ref(`sound/${s}`);
    this.waves.add(s);
  }

  addSoundScript(v) {
    if (!this.extract.sounds) return;
    const s = v.trim();
    if (!s || /^[\d.\-]+$/.test(s)) return;
    if (AUDIO_EXT.has(path.extname(s).toLowerCase())) return this.addWave(s);
    if (!/^[\w.\-]+$/.test(s)) return; // free text (game_text "message", etc.)
    this.ref(`soundscript:${s.toLowerCase()}`);
    this.soundScripts.add(s.toLowerCase());
  }

  addSoundscape(v) {
    if (!this.extract.sounds) return;
    const s = clean(v).trim().toLowerCase(); // printed in the console and the reports: no terminal escape sequences
    if (!s) return;
    this.ref(`soundscape:${s}`);
    this.soundscapes.add(s);
  }

  buildSoundScriptIndex() {
    const index = new Map();
    const files = new Set([`maps/${this.mapname}_level_sounds.txt`, ...this.listFiles('scripts', /^game_sounds.*\.txt$/)]);
    const manifest = this.read('scripts/game_sounds_manifest.txt');
    if (manifest) {
      try { for (const n of kv.walk(kv.parse(manifest))) if (n.key === 'precache_file' && n.value) files.add(norm(n.value)); } catch { /* ignore */ }
    }
    for (const f of files) {
      const text = this.read(f);
      if (!text) continue;
      let nodes;
      try { nodes = kv.parse(text); } catch { continue; }
      for (const n of nodes) {
        if (!n.children || index.has(n.key)) continue;
        const waves = [];
        for (const w of kv.walk(n.children)) if (w.key === 'wave' && w.value) waves.push(w.value);
        index.set(n.key, { file: f, waves });
      }
    }
    return index;
  }

  resolveSoundScripts() {
    if (!this.soundScripts.size) return;
    const index = this.buildSoundScriptIndex();
    const levelSounds = `maps/${this.mapname}_level_sounds.txt`;
    for (const name of this.soundScripts) {
      const e = index.get(name);
      if (!e) { if (this.isStockName('soundscript', name)) this.missing.set(`soundscript:${name}`, 'stock'); else this.unresolved.soundscripts.push(name); continue; }
      this.curRef = `soundscript:${name}`;
      for (const w of e.waves) this.addWave(w);
      if (e.file !== levelSounds) {
        this.addFile(e.file, true);
        this.note('note.soundscriptFile', { name, file: e.file, map: this.mapname });
      }
    }
    this.curRef = null;
  }

  buildSoundscapeIndex() {
    const index = new Map();
    const files = this.listFiles('scripts', /^soundscapes.*\.txt$/);
    const own = `scripts/soundscapes_${this.mapname}.txt`;
    if (this.pak && this.pak.has(own) && !files.includes(own)) files.unshift(own);
    for (const f of files) {
      if (f.endsWith('soundscapes_manifest.txt')) continue;
      const text = this.read(f);
      if (!text) continue;
      let nodes;
      try { nodes = kv.parse(text); } catch { continue; }
      for (const n of nodes) {
        if (!n.children || index.has(n.key)) continue;
        const waves = [], subs = [];
        for (const w of kv.walk(n.children)) {
          if (w.key === 'wave' && w.value) waves.push(w.value);
          if (w.key === 'playsoundscape' && w.children) {
            for (const c of w.children) if (c.key === 'name' && c.value) subs.push(c.value.toLowerCase());
          }
        }
        index.set(n.key, { file: f, waves, subs });
      }
    }
    return index;
  }

  resolveSoundscapes() {
    if (!this.soundscapes.size) return;
    const index = this.buildSoundscapeIndex();
    const mapFile = `scripts/soundscapes_${this.mapname}.txt`;
    const visited = new Set();
    const visit = (name) => {
      if (visited.has(name)) return;
      visited.add(name);
      const e = index.get(name);
      if (!e) { if (this.isStockName('soundscape', name)) this.missing.set(`soundscape:${name}`, 'stock'); else this.unresolved.soundscapes.push(name); return; }
      this.curRef = `soundscape:${name}`;
      for (const w of e.waves) this.addWave(w);
      if (e.file !== mapFile) {
        this.addFile(e.file, true);
        this.note('note.soundscapeFile', { name, file: e.file, mapFile });
      }
      for (const s of e.subs) { this.curRef = `soundscape:${name}`; this.ref(`soundscape:${s}`); visit(s); }
    };
    for (const name of this.soundscapes) visit(name);
    this.curRef = null;
  }

  // ---------- particles ----------

  addEffect(v) {
    if (!this.extract.others) return;
    const n = clean(v).trim().toLowerCase();
    if (!n) return;
    this.ref(`effect:${n}`);
    this.effects.add(n);
  }

  addPcf(v) {
    if (!this.extract.others) return;
    const p = norm(v);
    if (!p.endsWith('.pcf')) return;
    const key = p.startsWith('particles/') ? p : `particles/${p}`;
    this.ref(key);
    this.pcfs.add(key);
    // reached through one particle effect -> only that system matters; listed by a manifest / a key -> the whole file
    if (typeof this.curRef === 'string' && this.curRef.startsWith('effect:')) {
      if (!this.pcfEffects.has(key)) this.pcfEffects.set(key, new Set());
      this.pcfEffects.get(key).add(this.curRef.slice(7));
    } else this.pcfWhole.add(key);
  }

  readManifestPcfs(rel) {
    const text = this.read(rel);
    if (!text) return null;
    const set = new Set();
    try { for (const n of kv.walk(kv.parse(text))) if (n.key === 'file' && n.value) set.add(norm(n.value).replace(/^!/, '')); } catch { /* ignore */ }
    return set;
  }

  processParticles() {
    const mapManifest = `maps/${this.mapname}_particles.txt`;
    const mapPcfs = this.readManifestPcfs(mapManifest);
    const globalPcfs = this.readManifestPcfs('particles/particles_manifest.txt') || new Set();
    if (mapPcfs) {
      this.curRef = { kind: 'map' };
      this.addFile(mapManifest, false);
      this.packList.add(mapManifest);
      this.curRef = mapManifest;
      for (const p of mapPcfs) this.addPcf(p);
      this.curRef = null;
    }

    if (this.effects.size) {
      const pool = [...new Set([...(mapPcfs || []), ...this.listFiles('particles', /\.pcf$/)])];
      const cache = new Map();
      const textOf = (p) => {
        if (!cache.has(p)) { const t = this.read(p, 'latin1'); cache.set(p, t ? t.toLowerCase() : null); }
        return cache.get(p);
      };
      for (const eff of this.effects) {
        const needle = `\0${eff}\0`;
        const pcf = pool.find((p) => { const t = textOf(p); return !!t && t.includes(needle); });
        if (!pcf) { if (this.isStockName('effect', eff)) this.missing.set(`effect:${eff}`, 'stock'); else this.unresolved.effects.push(eff); continue; }
        if (globalPcfs.has(pcf) && !(mapPcfs && mapPcfs.has(pcf))) continue; // stock effect, precached by default
        this.curRef = `effect:${eff}`;
        this.addPcf(pcf);
        this.curRef = null;
        if (mapPcfs && !mapPcfs.has(pcf)) this.note('note.particleNotListed', { effect: eff, pcf, manifest: mapManifest });
      }
    }

    const copiedPcfs = [];
    for (const pcf of this.pcfs) {
      if (globalPcfs.has(pcf) && this.isStockLoose(pcf)) continue; // shipped with the game
      if (!this.copy(pcf)) continue;
      this.stats.particles++;
      copiedPcfs.push(pcf);
      // A .pcf holds dozens of particle systems: follow only the ones the map uses (and their children) when we know them.
      const raw = this.readBuffer(pcf);
      const wanted = this.pcfWhole.has(pcf) ? null : this.pcfEffects.get(pcf);
      const parsed = wanted ? parsePCF(raw) : null;
      const text = parsed ? stringsOf(parsed, wanted).join('\n') : raw.toString('latin1');
      if (parsed) this.stats.pcfSystems += wanted.size;
      const re = /[\w\/\\.\-]{1,260}\.(vmt|mdl)/gi; // bounded, see ASSET_IN_TEXT
      let m;
      this.curRef = pcf;
      while ((m = re.exec(text))) {
        if (m[1].toLowerCase() === 'vmt') this.addMaterial(m[0]); else this.addModel(m[0]);
      }
      this.curRef = null;
    }

    // No per-map manifest: generate one so the custom particle files get precached.
    if (!mapPcfs && copiedPcfs.length) {
      const content = `particles_manifest\n{\n${copiedPcfs.map((p) => `\t"file"\t"${p}"\n`).join('')}}\n`;
      this.generated.set(mapManifest, { abs: path.join(this.outputDir, mapManifest), content });
      this.copied.add(mapManifest);
      this.stats.files++;
      this.packList.add(mapManifest);
      this.note('note.manifestGenerated', { manifest: mapManifest, pcfs: copiedPcfs.join(', ') });
    }
  }

  /** Heuristic: a file listed in the global particles manifest that lives in the game dir itself is stock. */
  isStockLoose(rel) {
    const src = this.resolve(rel);
    if (!src) return false;
    const low = src.toLowerCase();
    return low.startsWith(this.gamepath.toLowerCase() + path.sep)
      && !low.includes(`${path.sep}addons${path.sep}`)
      && !low.includes(`${path.sep}download${path.sep}`);
  }

  // ---------- other files / bsp ----------

  addFile(v, optional = true) {
    const f = norm(v);
    if (!f || f.includes('..')) return;
    this.ref(f);
    const prev = this.files.get(f);
    this.files.set(f, prev === undefined ? optional : prev && optional);
  }

  processMapFiles() {
    const m = this.mapname;
    const optionalFiles = [
      `maps/${m}.nav`, `maps/${m}.ain`, `maps/graphs/${m}.ain`, `maps/thumb/${m}.png`,
      `maps/${m}.txt`, `maps/${m}_commentary.txt`, `resource/overviews/${m}.txt`,
      `materials/vgui/maps/menu_thumb_${m}.vmt`, `materials/vgui/maps/menu_thumb_${m}.vtf`,
      ...this.listFiles('maps', new RegExp(`^${escapeRe(m)}_l_\\d+\\.lmp$`)),
    ];
    for (const f of optionalFiles) this.copy(f, { optional: true });
    for (const f of [`maps/${m}_level_sounds.txt`, `scripts/soundscapes_${m}.txt`]) {
      if (this.copy(f, { optional: true }) && this.copied.has(f)) this.packList.add(f);
    }
  }

  findTool(names) {
    const base = path.dirname(this.gamepath);
    for (const dir of ['bin', 'bin/win64', 'bin/x64']) {
      for (const n of names) { const p = path.join(base, dir, n); if (isFile(p)) return p; }
    }
    return null;
  }

  /** Run a Valve tool without blocking the event loop (a BSP compression takes minutes: the status line keeps moving). */
  runTool(exe, args, timeout = 600000) {
    return new Promise((resolve) => {
      let out = '', err = '', child;
      const finish = (status) => resolve({ ok: status === 0, status, output: String(err || out).trim().slice(-300) });
      try {
        child = spawn(exe, args, { env: { ...process.env, VPROJECT: this.gamepath }, windowsHide: true, cwd: path.dirname(exe) });
      } catch (e) { err = e.message; finish(null); return; }
      const timer = setTimeout(() => child.kill(), timeout);
      child.stdout.on('data', (d) => { out = (out + d).slice(-4000); });
      child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
      child.on('error', (e) => { err = err || e.message; });
      child.on('close', (code) => { clearTimeout(timer); finish(code); }); // also emitted after a failed spawn
    });
  }

  /** Path + fingerprint of a file that goes inside the BSP (generated files only exist once execute() ran). */
  packSource(p) {
    const g = this.generated.get(p);
    if (g) { const b = Buffer.from(g.content); return { abs: g.abs, size: b.length, tag: crc32(b) }; }
    const abs = this.resolve(p);
    if (!abs) return null;
    const st = fs.statSync(abs);
    // content hash (not mtime) for small files, so that touching them does not force a BSP rebuild
    return { abs, size: st.size, tag: st.size < (1 << 22) ? crc32(fs.readFileSync(abs)) : st.mtimeMs };
  }

  planBSP() {
    const rel = `maps/${this.mapname}.bsp`;
    const src = this.bspPath;
    if (!src) { this.note('warn.noBsp', { file: rel }); return; }
    // Files that a workshop .gma cannot contain must travel inside the BSP.
    for (const f of this.copied) if (f !== rel && !isGmaAllowed(f)) { this.packList.add(f); this.notGmaAllowed.push(f); }
    const pack = [...this.packList].map((p) => ({ rel: p, info: this.packSource(p) })).filter((x) => x.info).sort((a, b) => (a.rel < b.rel ? -1 : 1));
    const st = fs.statSync(src);
    const dest = path.join(this.outputDir, rel);
    const sig = JSON.stringify([st.size, st.mtimeMs, this.compressBsp, pack.map((x) => [x.rel, x.info.size, x.info.tag])]);
    const kept = !!(this.prevState && this.prevState.bsp && this.prevState.bsp.sig === sig && isFile(dest));
    this.bspPlan = { rel, src, size: st.size, dest, sig, kept, pack: pack.map((x) => ({ rel: x.rel, abs: x.info.abs })) };
    this.copied.add(rel);
    this.stats.files++;
  }

  async executeBSP() {
    const b = this.bspPlan;
    if (!b) return;
    const names = b.pack.map((x) => x.rel);
    if (this.dryRun) { this.packed = names; this.account(b.rel, b.size); return; }
    if (b.kept) {
      this.packed = this.prevState.bsp.packed || [];
      this.bspCompression = this.prevState.bsp.compression || null;
      this.stats.kept++;
    } else {
      this.phase('phase.pack');
      await breathe();
      fs.mkdirSync(path.dirname(b.dest), { recursive: true });
      // built under a temporary name (still ending in .bsp for Valve's tools), renamed once complete
      const work = path.join(path.dirname(b.dest), `${this.mapname}${TMP_SUFFIX}.bsp`);
      fs.rmSync(work, { force: true });
      try {
        if (b.pack.length) {
          try { // native pakfile writer: no external tool needed
            packFiles(b.src, work, b.pack);
            this.packed = names;
          } catch (e) { // unusual pakfile: fall back to Valve's tool (bspzipplusplus first: GMod's own bspzip bloats the BSP)
            fs.rmSync(work, { force: true });
            const tool = this.findTool(['bspzipplusplus.exe']) || this.findTool(['bspzip.exe']);
            if (!tool) this.warn('warn.packNoTool', { error: e.message });
            else {
              const listFile = path.join(this.outputDir, 'zipfiles.txt');
              fs.writeFileSync(listFile, b.pack.flatMap((x) => [x.rel, x.abs]).join('\r\n') + '\r\n');
              const r = await this.runTool(tool, ['-addorupdatelist', b.src, listFile, work]);
              fs.rmSync(listFile, { force: true });
              if (r.ok && isFile(work)) this.packed = names;
              else { fs.rmSync(work, { force: true }); this.warn('warn.packFailed', { error: e.message, tool: path.basename(tool), status: r.status, output: r.output }); }
            }
          }
        }
        if (!isFile(work)) await fs.promises.copyFile(b.src, work);
        if (this.compressBsp) { this.phase('phase.compress'); await this.compressOutputBsp(work); }
        fs.renameSync(work, b.dest);
      } catch (e) { fs.rmSync(work, { force: true }); throw e; }
      this.stats.written++;
    }
    const lost = this.notGmaAllowed.filter((f) => !this.packed.includes(f));
    if (lost.length) this.warn('warn.notEmbedded', { count: lost.length, files: `${lost.slice(0, 6).join(', ')}${lost.length > 6 ? '…' : ''}` });
    this.state.bsp = { sig: b.sig, packed: this.packed, compression: this.bspCompression || null };
    this.account(b.rel, fs.statSync(b.dest).size);
  }

  async compressOutputBsp(dest) {
    const before = fs.statSync(dest).size;
    const tool = this.findTool(['bspzipplusplus.exe']) || this.findTool(['bspzip.exe']);
    if (!tool) { this.warn('warn.compressNoTool'); return; }
    const r = await this.runTool(tool, ['-repack', '-compress', dest]);
    const after = fs.statSync(dest).size;
    if (!r.ok || after >= before) {
      this.warn('warn.compressNothing', { detail: `${path.basename(tool)}${r.ok ? '' : `, exit ${r.status}: ${r.output}`}` });
      return;
    }
    this.bspCompression = { before, after, tool: path.basename(tool) };
    this.note('note.bspCompressed');
  }

  // ---------- output folder ----------

  readState() {
    try {
      const j = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      return j && j.version === STATE_VERSION && j.files ? j : null;
    } catch { return null; }
  }

  /** Fails early (before any work) when the output folder is not ours to clear. */
  checkOutput() {
    if (this.dryRun) return;
    this.lastState = this.readState();
    if (this.incremental && this.lastState && isDir(this.outputDir)) this.prevState = this.lastState;
    if (!this.prevState && isDir(this.outputDir)) {
      const foreign = fs.readdirSync(this.outputDir).filter((n) => !OUTPUT_ENTRIES.has(n.toLowerCase()));
      if (foreign.length) throw new Error(this.t('error.refuseClear', { dir: this.outputDir, files: foreign.slice(0, 4).join(', ') }));
    }
  }

  /** Decide what really has to be written, compare with the previous run, check the free space. */
  finalizePlan(fmt) {
    let writeBytes = 0, writeFiles = 0, keptFiles = 0, totalBytes = 0;
    for (const e of this.planList) {
      totalBytes += e.size;
      const prev = this.prevState && this.prevState.files[e.key];
      const vtfReset = e.key.endsWith('.vtf') && this.prevState && this.prevState.optimizeSig !== this.optimizeSig;
      if (prev && !vtfReset && prev[0] === e.size && prev[1] === e.mtime) {
        const ds = fs.statSync(path.join(this.outputDir, e.key), { throwIfNoEntry: false });
        if (ds) { e.kept = true; e.destSize = ds.size; keptFiles++; continue; }
      }
      writeBytes += e.size; writeFiles++;
    }
    if (this.bspPlan) { totalBytes += this.bspPlan.size; if (this.bspPlan.kept) keptFiles++; else { writeBytes += this.bspPlan.size; writeFiles++; } }

    const last = this.dryRun ? this.readState() : this.lastState;
    if (last) {
      const now = new Map(this.planList.map((e) => [e.key, e]));
      const d = { added: [], removed: [], changed: [], addedBytes: 0, removedBytes: 0 };
      for (const [key, e] of now) {
        const p = last.files[key];
        if (!p) { d.added.push(key); d.addedBytes += e.size; } else if (p[0] !== e.size || p[1] !== e.mtime) d.changed.push(key);
      }
      for (const key of Object.keys(last.files)) if (!now.has(key)) { d.removed.push(key); d.removedBytes += last.files[key][0]; }
      d.added.sort(); d.removed.sort(); d.changed.sort();
      this.diff = d;
    }

    let free = Infinity;
    if (!this.dryRun) {
      free = freeSpace(this.outputDir);
      const margin = 64 * 1024 * 1024;
      if (writeBytes + margin > free) {
        const reclaimed = !this.prevState && isDir(this.outputDir) ? dirSize(this.outputDir) : 0; // cleared before copying
        if (writeBytes + margin > free + reclaimed) throw new Error(this.t('error.diskSpace', { dir: this.outputDir, need: fmt(writeBytes), free: fmt(free + reclaimed) }));
      }
    }
    this.planInfo = { files: this.planList.length + (this.bspPlan ? 1 : 0) + this.generated.size, bytes: totalBytes, writeFiles, writeBytes, keptFiles, free };
  }

  prepareOutput() {
    if (!this.prevState && isDir(this.outputDir)) fs.rmSync(this.outputDir, { recursive: true, force: true });
    fs.mkdirSync(this.outputDir, { recursive: true });
    for (const [, g] of this.generated) {
      fs.mkdirSync(path.dirname(g.abs), { recursive: true });
      fs.writeFileSync(g.abs, g.content);
    }
  }

  async copyAll() {
    const todo = this.planList.filter((e) => !e.kept);
    const totalBytes = todo.reduce((a, e) => a + e.size, 0), totalFiles = todo.length;
    const dirs = new Set(todo.map((e) => path.dirname(path.join(this.outputDir, e.key))));
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    let next = 0, doneBytes = 0, doneFiles = 0, last = 0, fatal = null;
    const emit = (current, force) => {
      const now = Date.now();
      if (!force && now - last < 80) return;
      last = now;
      this.onProgress({ doneBytes, totalBytes, doneFiles, totalFiles, current });
    };
    const worker = async () => {
      while (!fatal) { // a full disk stops every worker, not just the one that hit it
        const e = todo[next++];
        if (!e) return;
        const dest = path.join(this.outputDir, e.key), tmp = `${dest}${TMP_SUFFIX}`;
        try {
          if (!inside(this.outputDir, dest)) throw new Error('path escapes the output folder'); // defence in depth
          await fs.promises.copyFile(e.src, tmp);
          await fs.promises.rename(tmp, dest);
        } catch (err) {
          await fs.promises.rm(tmp, { force: true }).catch(() => {});
          if (err.code === 'ENOSPC') { fatal = err; return; }
          e.failed = true;
          this.warn('warn.copyFailed', { file: e.key, error: err.message });
        }
        doneBytes += e.size; doneFiles++;
        emit(e.key, false);
      }
    };
    emit('', true);
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.copyThreads, todo.length)) }, worker));
    if (fatal) throw fatal;
    emit('', true);
    for (const e of this.planList) {
      if (e.failed) continue;
      if (e.kept) this.stats.kept++; else this.stats.written++;
      this.state.files[e.key] = [e.size, e.mtime];
      this.account(e.key, e.kept ? e.destSize : e.size);
    }
  }

  /** Incremental mode: delete what a previous run copied and the map no longer needs. */
  removeStale() {
    if (!this.prevState) return;
    const walk = (dir, relDir) => {
      let left = 0;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name), rel = relDir ? `${relDir}/${e.name.toLowerCase()}` : e.name.toLowerCase();
        if (e.isDirectory()) { if (walk(abs, rel)) left++; else fs.rmdirSync(abs); } else if (this.copied.has(rel) || rel === 'addon.json') left++;
        else { fs.rmSync(abs, { force: true }); this.stats.stale++; }
      }
      return left;
    };
    walk(this.outputDir, '');
  }

  // ---------- main ----------

  async drain() {
    let mi = 0, ti = 0;
    while (mi < this.modelQueue.length || ti < this.materialQueue.length) {
      while (mi < this.modelQueue.length) { this.processModel(this.modelQueue[mi++]); await this.tick(); }
      while (ti < this.materialQueue.length) { const [m, o] = this.materialQueue[ti++]; this.processMaterial(m, o); await this.tick(); }
    }
  }

  /**
   * Step 1: work out everything the map needs. Nothing is written.
   * @param {(bytes:number)=>string} [fmt] byte formatter for error messages
   * @returns {{files:number, bytes:number, writeFiles:number, writeBytes:number, keptFiles:number, free:number}}
   */
  async plan(fmt = (n) => `${(n / 1048576).toFixed(0)} MB`) {
    const t0 = Date.now();
    if (this.vmfPath && !isFile(this.vmfPath)) throw new Error(this.t('error.vmfNotFound', { file: this.vmfPath }));
    if (this.bspPath && !isFile(this.bspPath)) throw new Error(this.t('error.bspNotFound', { file: this.bspPath }));
    if (!isDir(path.join(this.gamepath, 'materials'))) throw new Error(this.t('error.invalidGame', { dir: this.gamepath }));
    this.checkOutput();
    try {
      this.phase('phase.indexing');
      this.initSearchPaths();
      this.loadStock();
      this.loadWorkshop();
      await this.tick();

      this.openBSP();
      if (this.vmfPath) { this.phase('phase.vmf'); this.loadVMF(this.vmfPath); await this.tick(); }
      if (this.bsp) { this.phase('phase.bsp'); this.loadBSP(); await this.tick(); }

      if (this.extract.others) { this.phase('phase.particles'); this.processParticles(); await this.tick(); }
      if (this.extract.sounds) { this.phase('phase.sounds'); this.resolveSoundScripts(); this.resolveSoundscapes(); await this.tick(); }

      // scripts the map points to may name more assets (models of a custom detail .vbsp, sounds of a vehicle script...)
      for (const [f] of this.files) {
        if (!/[.](vbsp|txt)$/.test(f) || this.isStock(f)) continue;
        const text = this.read(f, 'latin1');
        if (text && text.length < (1 << 20)) { this.curRef = f; this.scanText(text); this.curRef = null; }
      }

      this.phase('phase.assets');
      await this.drain();

      if (this.extract.sounds) {
        this.phase('phase.soundFiles');
        for (const w of this.waves) { if (this.copy(`sound/${w}`) && this.copied.has(`sound/${w}`)) this.stats.sounds++; await this.tick(); }
      }

      this.phase('phase.others');
      for (const [f, optional] of this.files) this.copy(f, { optional });
      if (this.extract.others) { this.curRef = { kind: 'map' }; this.processMapFiles(); this.curRef = null; this.planBSP(); }
      if (this.unsafe.size) this.warn('warn.unsafePaths', { count: this.unsafe.size, files: [...this.unsafe].slice(0, 5).join(', ') });
      if (this.pak && this.pak.damaged.size) this.warn('warn.pakDamaged', { count: this.pak.damaged.size, files: [...this.pak.damaged].slice(0, 5).join(', ') });
      this.finalizePlan(fmt);
      if (this.workshop) this.workshopErrors = this.workshop.errors.slice();
    } finally {
      this.phase(null);
      if (this.bsp) { this.bsp.close(); this.bsp = null; }
      if (this.workshop) this.workshop.close();
      this.ms += Date.now() - t0;
    }
    this.planned = true;
    return this.planInfo;
  }

  /** Step 2: write the output folder (or, for a dry run, just finish the bookkeeping). Returns the summary. */
  async execute() {
    if (!this.planned) await this.plan();
    const t0 = Date.now();
    try {
      if (this.dryRun) {
        for (const e of this.planList) this.account(e.key, e.size);
        await this.executeBSP();
      } else {
        this.phase('phase.prepare');
        this.prepareOutput();
        this.phase('phase.copy');
        await this.copyAll();
        await this.executeBSP();
        this.phase('phase.cleanup');
        this.removeStale();
        try { // atomic: a crash never leaves a half-written state behind
          fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state));
          fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
        } catch { /* state is optional */ }
      }
    } finally {
      this.phase(null);
      this.ms += Date.now() - t0;
    }
    return this.summary();
  }

  async run() {
    await this.plan();
    return this.execute();
  }

  summary() {
    const missing = [], stock = [], workshop = [];
    for (const [k, r] of this.missing) (r === 'stock' ? stock : r === 'workshop' ? workshop : missing).push(k);
    const list = (m) => [...m.values()].sort((a, b) => b.bytes - a.bytes || b.files - a.files);
    const missingRefs = {};
    for (const k of missing) missingRefs[k] = this.chainOf(k);
    const unresolvedRefs = {};
    for (const [kind, names] of [['effect', this.unresolved.effects], ['soundscape', this.unresolved.soundscapes], ['soundscript', this.unresolved.soundscripts]]) {
      for (const n of names) unresolvedRefs[`${kind}:${n}`] = this.chainOf(`${kind}:${n}`);
    }
    return {
      mapname: this.mapname, outputDir: this.outputDir, searchPaths: this.searchPaths, vpkFiles: this.vpkFiles,
      stats: this.stats, bytes: this.bytes, largest: this.largest, dryRun: this.dryRun, incremental: !!this.prevState,
      plan: this.planInfo, diff: this.diff,
      bigTextures: this.largest.filter((f) => f.rel.endsWith('.vtf') && f.size >= BIG_TEXTURE),
      normalMaps: [...this.normalMaps],
      packed: this.packed, notGmaAllowed: this.notGmaAllowed, bsp: this.bspInfo, bspCompression: this.bspCompression || null,
      missing: missing.sort(), missingRefs, unresolvedRefs, stock: stock.sort(), workshopMissing: workshop.sort(), workshopProviders: this.workshopProviders,
      workshop: {
        addons: this.workshopAddons,
        required: list(this.ws.required), extracted: list(this.ws.extracted), excluded: list(this.ws.excluded),
        errors: this.workshopErrors,
      },
      incompleteModels: this.incompleteModels.sort(), unsafePaths: [...this.unsafe].sort(),
      unresolved: this.unresolved, warnings: this.warnings, notes: this.notes, ms: this.ms, timings: this.timings,
      referenced: {
        materials: this.materials.size, textures: this.textures.size, models: this.models.size, sounds: this.waves.size,
        effects: this.effects.size, pcfs: this.pcfs.size, soundscapes: this.soundscapes.size, soundscripts: this.soundScripts.size,
      },
    };
  }
}

module.exports = { Scraper, norm, describeRef, describeChain, isSafeRel };
