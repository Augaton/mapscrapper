'use strict';
// Texture optimizer: walks a folder, re-encodes big uncompressed / oversized VTFs to DXT1/DXT5 with a size cap.
// Heavy work (decode + DXT encode) runs in worker threads; this file is also the worker entry point.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const vtf = require('./vtf');
const kv = require('./kv');

const COMPRESSED = new Set([13, 14, 15, 20]);
const LOSSLESS_MIN = 16 * 1024; // the lossless DXT5 -> DXT1 pass pays off even on small textures
const BUMP_KEYS = new Set(['$bumpmap', '$bumpmap2', '$normalmap', '$normalmap2', '$ssbump', '$bumpmask']);
const NORMAL_NAME = /(_n|_nm|_nrm|_norm|_normal|_normals|_bump|_ssbump)\.vtf$/i;

function walk(dir, re = /\.vtf$/i, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, re, out);
    else if (e.isFile() && re.test(e.name)) out.push(p);
  }
  return out;
}

/** Write next to the file, then rename over it: an interrupted run never leaves a truncated texture. */
function replaceFile(file, data) {
  const tmp = `${file}.mstmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}

/** Re-encode one file in place. Returns { before, after, from, to } or { skip: reason }. */
function convertFile(file, maxSize, compress = true, lossless = false) {
  try {
    const buf = fs.readFileSync(file);
    const h = vtf.parse(buf);
    if (!h) return { skip: 'not a VTF' };
    if (lossless) { // DXT5 whose alpha is opaque everywhere -> DXT1, colours untouched
      const slim = vtf.stripOpaqueAlpha(buf, h);
      if (!slim) return { alphaUsed: true };
      replaceFile(file, slim);
      return { before: buf.length, after: slim.length, from: `DXT5 ${h.width}x${h.height}`, to: `DXT1 ${h.width}x${h.height} (lossless)`, lossless: true };
    }
    const out = vtf.reencode(buf, h, { maxSize, compress });
    if (out.buf.length >= buf.length) return { skip: 'no gain' };
    replaceFile(file, out.buf);
    return { before: buf.length, after: out.buf.length, from: `${h.formatName} ${h.width}x${h.height}`, to: `${vtf.NAMES[out.fmt]} ${out.w}x${out.h}` };
  } catch (e) { return { skip: e.message }; }
}

if (!isMainThread && parentPort) {
  parentPort.on('message', (job) => parentPort.postMessage(convertFile(job.file, job.maxSize, job.compress, job.lossless)));
}

/** Normal maps referenced by the VMTs of a folder (materials/...vtf, lowercase). */
function collectNormalMaps(dir) {
  const set = new Set();
  for (const file of walk(dir, /\.vmt$/i)) {
    let flat;
    try { flat = kv.flatten(kv.parse(fs.readFileSync(file, 'utf-8'))); } catch { continue; }
    for (const [key, values] of flat) {
      if (!BUMP_KEYS.has(key)) continue;
      for (const v of values) set.add(`materials/${v.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.vtf$/i, '').toLowerCase()}.vtf`);
    }
  }
  return set;
}

/** Run jobs on a worker pool; falls back to the current thread when workers are unavailable (or die). */
function runJobs(jobs, threads, each) {
  const pending = jobs.slice();
  const local = async () => {
    while (pending.length) { const j = pending.shift(); each(j, convertFile(j.file, j.maxSize, j.compress, j.lossless)); await new Promise((r) => setImmediate(r)); }
  };
  if (threads <= 1 || pending.length < 2) return local();
  return new Promise((resolve) => {
    let active = 0;
    const settle = () => { if (active === 0) local().then(resolve); }; // drains whatever is left (normally nothing)
    const spawn = () => {
      let w;
      try { w = new Worker(__filename); } catch { return false; }
      active++;
      let current = null, dead = false;
      const stop = () => { if (dead) return; dead = true; active--; w.terminate(); settle(); };
      const feed = () => { current = pending.shift() || null; if (current) w.postMessage(current); else stop(); };
      w.on('message', (res) => { each(current, res); feed(); });
      w.on('error', () => { if (current) pending.unshift(current); current = null; stop(); });
      w.on('exit', () => { if (!dead && current) pending.unshift(current); stop(); });
      feed();
      return true;
    };
    for (let i = 0, n = Math.min(threads, pending.length); i < n; i++) if (!spawn()) break;
    if (active === 0) local().then(resolve);
  });
}

/**
 * @param {string} dir       folder to process in place (only *.vtf files are touched)
 * @param {object} [o]
 * @param {number} [o.maxSize=2048]     cap for width/height (0 = no downscale)
 * @param {number} [o.minBytes=1MB]     files smaller than this are left alone
 * @param {boolean} [o.keepNormals]     never DXT-compress normal / bump maps (artefacts are most visible there): only cap their size
 * @param {Iterable<string>} [o.normalMaps] known normal maps (materials/...vtf); scanned from the folder's VMTs when omitted
 * @param {number} [o.threads]          worker threads (default: CPU count - 1, max 8)
 * @param {(done:number,total:number,file:string)=>void} [o.onProgress]
 */
async function optimizeTextures(dir, o = {}) {
  const maxSize = o.maxSize === undefined ? 2048 : o.maxSize;
  const minBytes = o.minBytes === undefined ? 1 << 20 : o.minBytes;
  const onProgress = o.onProgress || (() => {});
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  const threads = o.threads > 0 ? o.threads : Math.min(8, Math.max(1, cpus - 1));
  const res = { converted: [], skipped: [], untouched: 0, keptNormals: 0, cappedNormals: 0, lossless: 0, losslessSaved: 0, before: 0, after: 0, saved: 0, ms: 0, threads };
  const t0 = Date.now();
  const normals = o.keepNormals ? new Set(o.normalMaps || collectNormalMaps(dir)) : null;

  const jobs = [];
  const head = Buffer.alloc(512);
  for (const file of walk(dir)) {
    const size = fs.statSync(file).size;
    if (size < LOSSLESS_MIN) continue;
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const fd = fs.openSync(file, 'r');
    const n = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const h = vtf.parse(head.subarray(0, n));
    const skip = (reason) => res.skipped.push({ rel, reason, size });
    if (!h) { skip('not a VTF'); continue; }
    if (h.frames !== 1) { skip(`animated (${h.frames} frames)`); continue; }
    if (h.faces !== 1) { skip('cubemap'); continue; }
    if (h.depth !== 1) { skip('volume texture'); continue; }
    if (vtf.imageSize(h.format, h.width, h.height) < 0) { skip(`unsupported format ${h.formatName}`); continue; }
    const tooBig = maxSize > 0 && Math.max(h.width, h.height) > maxSize;
    if (h.format === 15 && !tooBig) { jobs.push({ file, rel, size, maxSize, lossless: true }); continue; } // its alpha may be unused
    if (size < minBytes) continue;
    if (COMPRESSED.has(h.format) && !tooBig) { res.untouched++; continue; }
    // --keep-normals: never DXT-compress a normal map (block artefacts show up in the lighting); only cap its size
    const isNormal = !!normals && (!!(h.flags & vtf.FLAGS.NORMAL) || normals.has(rel.toLowerCase()) || NORMAL_NAME.test(rel));
    if (isNormal && !tooBig) { res.keptNormals++; continue; }
    const compress = !(isNormal && !COMPRESSED.has(h.format));
    if (!compress) res.cappedNormals++;
    jobs.push({ file, rel, size, maxSize, compress });
  }
  jobs.sort((a, b) => b.size - a.size); // biggest first: better balance across workers

  let done = 0;
  onProgress(0, jobs.length, '');
  await runJobs(jobs, threads, (job, r) => {
    onProgress(++done, jobs.length, job.rel);
    if (r && r.alphaUsed) { res.untouched++; return; }
    if (r && r.lossless) { res.lossless++; res.losslessSaved += r.before - r.after; }
    if (!r || r.skip) { res.skipped.push({ rel: job.rel, reason: r ? r.skip : 'worker failed', size: job.size }); return; }
    res.converted.push({ rel: job.rel, before: r.before, after: r.after, from: r.from, to: r.to });
    res.before += r.before; res.after += r.after;
  });

  res.saved = res.before - res.after;
  res.ms = Date.now() - t0;
  res.converted.sort((a, b) => (b.before - b.after) - (a.before - a.after));
  return res;
}

module.exports = { optimizeTextures, collectNormalMaps, walk };
