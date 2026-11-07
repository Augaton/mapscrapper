'use strict';
// CRC-32 (zlib's when available, table fallback otherwise).
const zlib = require('zlib');

let TABLE = null;
function crc32js(buf, crc = 0) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; TABLE[n] = c >>> 0; }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (b, c = 0) => zlib.crc32(b, c) >>> 0 : crc32js;

module.exports = { crc32, crc32js };
