'use strict';
// Regenerates test/lzma-vector.js from fixtures.vectorGMA(). Needs the `xz` command line tool (npm run vector).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { vectorGMA } = require('./fixtures');

const lzma = execFileSync('xz', ['--format=lzma', '-6', '--stdout'], { input: vectorGMA(), maxBuffer: 1 << 24 });
const lines = lzma.toString('base64').match(/.{1,120}/g);
fs.writeFileSync(path.join(__dirname, 'lzma-vector.js'), [
  "'use strict';",
  '// test/fixtures.js vectorGMA() compressed with `xz --format=lzma -6` (unknown size + end marker). Regenerate with: npm run vector',
  'module.exports = Buffer.from([',
  ...lines.map((l) => `  '${l}',`),
  "].join(''), 'base64');",
  '',
].join('\n'));
console.log(`test/lzma-vector.js written (${lzma.length} bytes of LZMA)`);
