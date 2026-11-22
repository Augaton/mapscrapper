'use strict';
// Opens and closes every file once, several at a time. With a real-time antivirus (Windows Defender) the first open of a
// file that was just written blocks for ~3 ms while it is scanned: 3000 files cost 10 s one after the other, ~2.5 s in
// parallel (measured). Later opens are free (~40 us), so the sequential passes that follow (texture optimiser, .gma
// writer) run at full speed. Without an antivirus this costs a fraction of a second.
const fs = require('fs');

async function prefetch(files, concurrency = 8) {
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      try { await (await fs.promises.open(files[next++], 'r')).close(); } catch { /* the real pass reports an unreadable file */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
}

module.exports = { prefetch };
