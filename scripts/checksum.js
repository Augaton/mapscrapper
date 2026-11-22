'use strict';
// Writes <file>.sha256 next to each file given (default: dist/MapScraper.exe) so that a download can be verified:
//   Windows: certutil -hashfile MapScraper.exe SHA256        Linux: sha256sum -c mapscraper-linux-x64.tar.gz.sha256
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const files = process.argv.length > 2 ? process.argv.slice(2) : [path.join(__dirname, '..', 'dist', 'MapScraper.exe')];
for (const file of files) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`); // the "hash  name" layout of sha256sum
  console.log(`sha256  ${hash}  ${path.basename(file)} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`);
}
