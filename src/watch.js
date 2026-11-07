'use strict';
// Polling file watcher: calls onChange once the watched files stopped changing (a compile writes the BSP several times).
const fs = require('fs');

function stamp(file) {
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st ? `${st.size}:${st.mtimeMs}` : 'missing';
}

/**
 * @param {string[]} files
 * @param {() => Promise<void>|void} onChange
 * @param {{interval?:number, settle?:number, onDetect?:()=>void}} [o]
 * @returns {{stop:()=>void}}
 */
function watchFiles(files, onChange, o = {}) {
  const interval = o.interval || 1000, settle = o.settle === undefined ? 3000 : o.settle;
  let last = files.map(stamp), dirtySince = 0, running = false, stopped = false, announced = false;
  const seen = last.map((s) => s !== 'missing');
  const timer = setInterval(async () => {
    if (stopped) return;
    const now = files.map(stamp);
    now.forEach((s, i) => { if (s !== 'missing') seen[i] = true; });
    if (now.some((s, i) => s !== last[i])) {
      last = now; dirtySince = Date.now();
      if (!announced && o.onDetect) { announced = true; o.onDetect(); }
    }
    if (!dirtySince || running || Date.now() - dirtySince < settle) return;
    if (now.some((s, i) => s === 'missing' && seen[i])) return; // being rewritten by the compiler: wait until it is back
    dirtySince = 0; announced = false; running = true;
    try { await onChange(); } catch (e) { if (o.onError) o.onError(e); } finally { running = false; }
  }, interval);
  return { stop() { stopped = true; clearInterval(timer); } };
}

module.exports = { watchFiles };
