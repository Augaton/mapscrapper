'use strict';
// Writes dist/MapScraper.exe.sha256 so a downloaded exe can be verified:  certutil -hashfile MapScraper.exe SHA256
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const exe = path.join(__dirname, '..', 'dist', 'MapScraper.exe');
const hash = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
fs.writeFileSync(`${exe}.sha256`, `${hash}  MapScraper.exe\n`);
console.log(`sha256  ${hash}  (${(fs.statSync(exe).size / 1048576).toFixed(1)} MB)`);
