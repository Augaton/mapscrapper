'use strict';
// Pure-JS LZMA decoder (sequential, resumable, sliding window). Follows the LZMA SDK reference decoder.
// Used for compressed workshop addons (*_legacy.bin = ".lzma alone" streams), compressed BSP lumps and
// LZMA-compressed pakfile entries.
const fs = require('fs');

const PROB_INIT = 1024;
const TOP = 16777216; // 1 << 24

class LzmaError extends Error {}
class LzmaNeedInput extends LzmaError {
  constructor() { super('LZMA: unexpected end of input'); }
}

/** Byte source: an in-memory buffer, or a file descriptor read chunk by chunk. */
class Input {
  constructor({ buf = null, fd = null, start = 0, end = Infinity, chunk = 1 << 22 }) {
    this.fd = fd;
    if (buf) { this.buf = buf; this.pos = start; this.end = Math.min(buf.length, end); } else {
      this.buf = Buffer.allocUnsafe(chunk); this.pos = 0; this.end = 0; this.filePos = start; this.fileEnd = end;
    }
  }
  fill() {
    if (this.fd === null) throw new LzmaNeedInput();
    const want = Math.min(this.buf.length, this.fileEnd - this.filePos);
    const n = want > 0 ? fs.readSync(this.fd, this.buf, 0, want, this.filePos) : 0;
    if (n <= 0) throw new LzmaNeedInput();
    this.filePos += n; this.pos = 0; this.end = n;
  }
  byte() {
    if (this.pos >= this.end) this.fill();
    return this.buf[this.pos++];
  }
}

const probs = (n) => new Uint16Array(n).fill(PROB_INIT);
const lenCoder = () => ({ choice: probs(2), low: probs(16 << 3), mid: probs(16 << 3), high: probs(256) });

class LzmaDecoder {
  /**
   * @param {Buffer} props      5 property bytes (lc/lp/pb + dictionary size)
   * @param {number} unpackSize uncompressed size, or -1 when unknown (end marker expected)
   * @param {Input}  input      positioned on the first byte of the range-coder stream
   */
  constructor(props, unpackSize, input) {
    let d = props[0];
    if (d >= 225) throw new LzmaError('LZMA: bad properties');
    this.lc = d % 9; d = (d / 9) | 0; this.lp = d % 5; this.pb = (d / 5) | 0;
    this.dictSize = Math.max(props.readUInt32LE(1), 4096);
    if (this.dictSize > (1 << 30)) throw new LzmaError('LZMA: dictionary too large'); // hostile header: do not allocate gigabytes
    this.unpackSize = unpackSize;
    this.in = input;

    let win = this.dictSize;
    if (unpackSize >= 0 && unpackSize < win) win = Math.max(unpackSize, 4096);
    this.winSize = win;
    this.win = new Uint8Array(win);
    this.wpos = 0;
    this.total = 0;
    this.finished = false;

    this.isMatch = probs(12 << 4); this.isRep = probs(12); this.isRepG0 = probs(12); this.isRepG1 = probs(12);
    this.isRepG2 = probs(12); this.isRep0Long = probs(12 << 4);
    this.posSlot = probs(4 << 6); this.posDecoders = probs(115); this.align = probs(16);
    this.lenDec = lenCoder(); this.repLenDec = lenCoder();
    this.lit = probs(0x300 << (this.lc + this.lp));
    this.state = 0; this.rep0 = 0; this.rep1 = 0; this.rep2 = 0; this.rep3 = 0;

    // range coder init: first byte is always 0, then 4 bytes of code
    this.range = 0xffffffff; this.code = 0;
    if (input.byte() !== 0) throw new LzmaError('LZMA: corrupted stream start');
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | input.byte()) >>> 0;
  }

  /** ".lzma alone" stream: 5 props bytes + 8 bytes uncompressed size + data. */
  static alone(source) {
    const input = source instanceof Input ? source : new Input(Buffer.isBuffer(source) ? { buf: source } : source);
    const hdr = Buffer.alloc(13);
    for (let i = 0; i < 13; i++) hdr[i] = input.byte();
    const lo = hdr.readUInt32LE(5), hi = hdr.readUInt32LE(9);
    const size = lo === 0xffffffff && hi === 0xffffffff ? -1 : hi * 4294967296 + lo;
    return new LzmaDecoder(hdr.subarray(0, 5), size, input);
  }

  _bit(p, i) {
    const v = p[i];
    const bound = (this.range >>> 11) * v;
    let bit;
    if (this.code < bound) { p[i] = v + ((2048 - v) >>> 5); this.range = bound; bit = 0; } else {
      p[i] = v - (v >>> 5); this.code -= bound; this.range -= bound; bit = 1;
    }
    if (this.range < TOP) { this.range = (this.range << 8) >>> 0; this.code = ((this.code << 8) | this.in.byte()) >>> 0; }
    return bit;
  }

  _direct(n) {
    let res = 0;
    do {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) { this.code -= this.range; b = 1; }
      if (this.range < TOP) { this.range = (this.range << 8) >>> 0; this.code = ((this.code << 8) | this.in.byte()) >>> 0; }
      res = res * 2 + b;
    } while (--n);
    return res;
  }

  _tree(p, off, bits) {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) + this._bit(p, off + m);
    return m - (1 << bits);
  }

  _rtree(p, off, bits) {
    let m = 1, sym = 0;
    for (let i = 0; i < bits; i++) { const b = this._bit(p, off + m); m = (m << 1) + b; sym |= b << i; }
    return sym;
  }

  _len(ld, posState) {
    if (this._bit(ld.choice, 0) === 0) return this._tree(ld.low, posState << 3, 3);
    if (this._bit(ld.choice, 1) === 0) return 8 + this._tree(ld.mid, posState << 3, 3);
    return 16 + this._tree(ld.high, 0, 8);
  }

  _distance(len) {
    const lenState = len > 3 ? 3 : len;
    const slot = this._tree(this.posSlot, lenState << 6, 6);
    if (slot < 4) return slot;
    const nbits = (slot >> 1) - 1;
    let dist = ((2 | (slot & 1)) << nbits) >>> 0;
    if (slot < 14) dist += this._rtree(this.posDecoders, dist - slot, nbits);
    else { dist += this._direct(nbits - 4) * 16; dist += this._rtree(this.align, 0, 4); }
    return dist;
  }

  /** Decode until at least `target` bytes have been produced (or the stream ends). Returns true when finished. */
  decodeTo(target) {
    const win = this.win, winSize = this.winSize, lc = this.lc;
    const pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1;
    let { state, rep0, rep1, rep2, rep3, wpos, total } = this;
    const save = () => { Object.assign(this, { state, rep0, rep1, rep2, rep3, wpos, total }); };
    try {
      while (total < target && !this.finished) {
        if (this.unpackSize >= 0 && total >= this.unpackSize) { this.finished = true; break; }
        const posState = total & pbMask;
        if (this._bit(this.isMatch, (state << 4) + posState) === 0) {
          const prev = total > 0 ? win[wpos === 0 ? winSize - 1 : wpos - 1] : 0;
          const base = 0x300 * (((total & lpMask) << lc) + (prev >>> (8 - lc)));
          let sym = 1;
          if (state >= 7) {
            let idx = wpos - rep0 - 1; if (idx < 0) idx += winSize;
            let mb = win[idx];
            do {
              const mbit = (mb >>> 7) & 1; mb <<= 1;
              const b = this._bit(this.lit, base + ((1 + mbit) << 8) + sym);
              sym = (sym << 1) | b;
              if (mbit !== b) break;
            } while (sym < 0x100);
          }
          while (sym < 0x100) sym = (sym << 1) | this._bit(this.lit, base + sym);
          win[wpos] = sym & 0xff; if (++wpos === winSize) wpos = 0; total++;
          state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
          continue;
        }
        let len;
        if (this._bit(this.isRep, state) !== 0) {
          if (total === 0) throw new LzmaError('LZMA: corrupted (rep at start)');
          if (this._bit(this.isRepG0, state) === 0) {
            if (this._bit(this.isRep0Long, (state << 4) + posState) === 0) { // short rep
              state = state < 7 ? 9 : 11;
              let idx = wpos - rep0 - 1; if (idx < 0) idx += winSize;
              win[wpos] = win[idx]; if (++wpos === winSize) wpos = 0; total++;
              continue;
            }
          } else {
            let dist;
            if (this._bit(this.isRepG1, state) === 0) dist = rep1;
            else {
              if (this._bit(this.isRepG2, state) === 0) dist = rep2;
              else { dist = rep3; rep3 = rep2; }
              rep2 = rep1;
            }
            rep1 = rep0; rep0 = dist;
          }
          len = this._len(this.repLenDec, posState);
          state = state < 7 ? 8 : 11;
        } else {
          rep3 = rep2; rep2 = rep1; rep1 = rep0;
          len = this._len(this.lenDec, posState);
          state = state < 7 ? 7 : 10;
          rep0 = this._distance(len);
          if (rep0 === 0xffffffff) { this.finished = true; break; } // end marker
        }
        if (rep0 >= this.dictSize || rep0 >= total) throw new LzmaError('LZMA: corrupted (bad distance)');
        len += 2;
        if (this.unpackSize >= 0 && total + len > this.unpackSize) len = this.unpackSize - total;
        let src = wpos - rep0 - 1; if (src < 0) src += winSize;
        for (let i = 0; i < len; i++) {
          win[wpos] = win[src];
          if (++wpos === winSize) wpos = 0;
          if (++src === winSize) src = 0;
        }
        total += len;
      }
    } finally { save(); }
    return this.finished;
  }

  /** Copy `length` decoded bytes starting at absolute output offset `start` (must still be inside the window). */
  getRange(start, length) {
    if (start < 0 || start + length > this.total) throw new RangeError('LZMA: range not decoded yet');
    if (start < this.total - Math.min(this.total, this.winSize)) throw new RangeError('LZMA: range left the window');
    const out = Buffer.allocUnsafe(length);
    let idx = start % this.winSize, done = 0;
    while (done < length) {
      const n = Math.min(length - done, this.winSize - idx);
      out.set(this.win.subarray(idx, idx + n), done);
      done += n; idx = 0;
    }
    return out;
  }

  /** Read output bytes [start, start+length) sequentially, decoding as needed; `sink(chunk)` receives the data. */
  readRange(start, length, sink) {
    if (start < this.total - Math.min(this.total, this.winSize)) throw new RangeError('LZMA: cannot seek backwards');
    const step = Math.max(4096, this.winSize >> 1);
    let pos = start;
    const end = start + length;
    if (this.total < start) { // skip forward in window-sized hops so nothing is lost
      while (this.total < start && !this.finished) this.decodeTo(Math.min(start, this.total + step));
    }
    while (pos < end) {
      const upto = Math.min(end, pos + step);
      if (this.total < upto) this.decodeTo(upto);
      const avail = Math.min(upto, this.total);
      if (avail <= pos) throw new LzmaError('LZMA: stream ended early');
      sink(this.getRange(pos, avail - pos));
      pos = avail;
    }
  }
}

/** Decompress a whole ".lzma alone" buffer. */
function decompressAlone(buf) {
  const dec = LzmaDecoder.alone(buf);
  return drain(dec);
}

/** Decompress raw LZMA data given its 5 property bytes and the uncompressed size. */
function decompressRaw(props, unpackSize, buf, start = 0) {
  return drain(new LzmaDecoder(props, unpackSize, new Input({ buf, start })));
}

function drain(dec) {
  const parts = [];
  const step = Math.max(4096, dec.winSize >> 1);
  let pos = 0;
  while (!dec.finished) {
    dec.decodeTo(pos + step);
    if (dec.total > pos) { parts.push(dec.getRange(pos, dec.total - pos)); pos = dec.total; } else if (!dec.finished) break;
  }
  return Buffer.concat(parts);
}

module.exports = { LzmaDecoder, Input, LzmaError, LzmaNeedInput, decompressAlone, decompressRaw };
