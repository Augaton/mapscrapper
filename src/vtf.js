'use strict';
// VTF (Valve Texture Format) reader/writer with a DXT1/DXT5 codec, used to shrink textures.
// Reads 2D single-frame textures in the common 8-bit and DXT formats; always writes VTF 7.2 (DXT1 / DXT5),
// which every Source engine game understands.

const FMT = {
  RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, RGB565: 4, I8: 5, IA88: 6, A8: 8, ARGB8888: 11, BGRA8888: 12,
  DXT1: 13, DXT3: 14, DXT5: 15, BGRX8888: 16, BGR565: 17, DXT1_ONEBITALPHA: 20,
};
const NAMES = {
  0: 'RGBA8888', 1: 'ABGR8888', 2: 'RGB888', 3: 'BGR888', 4: 'RGB565', 5: 'I8', 6: 'IA88', 7: 'P8', 8: 'A8',
  9: 'RGB888_BLUESCREEN', 10: 'BGR888_BLUESCREEN', 11: 'ARGB8888', 12: 'BGRA8888', 13: 'DXT1', 14: 'DXT3', 15: 'DXT5',
  16: 'BGRX8888', 17: 'BGR565', 18: 'BGRX5551', 19: 'BGRA4444', 20: 'DXT1_ONEBITALPHA', 21: 'BGRA5551', 22: 'UV88',
  23: 'UVWQ8888', 24: 'RGBA16161616F', 25: 'RGBA16161616', 26: 'UVLX8888',
};
const FLAGS = { NORMAL: 0x80, NOMIP: 0x100, NOLOD: 0x200, ONEBITALPHA: 0x1000, EIGHTBITALPHA: 0x2000, ENVMAP: 0x4000 };
const BPP = { 0: 4, 1: 4, 2: 3, 3: 3, 4: 2, 5: 1, 6: 2, 8: 1, 11: 4, 12: 4, 16: 4, 17: 2 };

function imageSize(fmt, w, h) {
  if (fmt === 13 || fmt === 20) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * 8;
  if (fmt === 14 || fmt === 15) return Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * 16;
  const bpp = BPP[fmt];
  return bpp === undefined ? -1 : w * h * bpp;
}

// ---------- header ----------

function parse(buf) {
  if (buf.length < 64 || buf.toString('latin1', 0, 4) !== 'VTF\0') return null;
  const major = buf.readUInt32LE(4), minor = buf.readUInt32LE(8);
  if (major !== 7) return null;
  const h = {
    version: `${major}.${minor}`, minor, headerSize: buf.readUInt32LE(12),
    width: buf.readUInt16LE(16), height: buf.readUInt16LE(18), flags: buf.readUInt32LE(20),
    frames: buf.readUInt16LE(24), firstFrame: buf.readUInt16LE(26),
    reflectivity: [buf.readFloatLE(32), buf.readFloatLE(36), buf.readFloatLE(40)],
    bumpScale: buf.readFloatLE(48), format: buf.readInt32LE(52), mipCount: buf[56],
    lowFormat: buf.readInt32LE(57), lowWidth: buf[61], lowHeight: buf[62],
    depth: minor >= 2 ? buf.readUInt16LE(63) : 1, resources: [],
  };
  if (minor >= 3) {
    const n = buf.readUInt32LE(68);
    for (let i = 0; i < n && 80 + i * 8 + 8 <= buf.length; i++) {
      const o = 80 + i * 8;
      h.resources.push({ tag: buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16), flags: buf[o + 3], data: buf.readUInt32LE(o + 4) });
    }
  }
  h.faces = (h.flags & FLAGS.ENVMAP) ? (minor >= 1 && minor < 5 ? 7 : 6) : 1;
  h.formatName = NAMES[h.format] || `unknown(${h.format})`;
  return h;
}

function highResOffset(h) {
  if (h.minor >= 3) {
    const r = h.resources.find((x) => x.tag === 0x30);
    return r ? r.data : -1;
  }
  let off = h.headerSize;
  if (h.lowWidth && h.lowHeight && h.lowFormat >= 0 && imageSize(h.lowFormat, h.lowWidth, h.lowHeight) > 0) {
    off += imageSize(h.lowFormat, h.lowWidth, h.lowHeight);
  }
  return off;
}

/** Decode the largest mip of a 2D single-frame texture to RGBA8 (Uint8Array w*h*4). */
function decode(buf, h) {
  if (h.frames !== 1) throw new Error('animated texture');
  if (h.faces !== 1) throw new Error('cubemap');
  if (h.depth !== 1) throw new Error('volume texture');
  if (!h.width || !h.height || h.width > 8192 || h.height > 8192) throw new Error('unreasonable texture size');
  const size0 = imageSize(h.format, h.width, h.height);
  if (size0 < 0) throw new Error(`unsupported format ${h.formatName}`);
  let off = highResOffset(h);
  if (off < 0) throw new Error('no image data');
  for (let i = h.mipCount - 1; i >= 1; i--) off += imageSize(h.format, Math.max(1, h.width >> i), Math.max(1, h.height >> i));
  if (off + size0 > buf.length) throw new Error('truncated file');
  return toRGBA(buf.subarray(off, off + size0), h.format, h.width, h.height);
}

// ---------- pixel format conversion ----------

const e5 = (v) => (v << 3) | (v >> 2);
const e6 = (v) => (v << 2) | (v >> 4);

function toRGBA(d, fmt, w, h) {
  const n = w * h, out = new Uint8Array(n * 4);
  switch (fmt) {
    case 0: out.set(d.subarray(0, n * 4)); break;
    case 1: for (let i = 0; i < n; i++) { out[i * 4] = d[i * 4 + 3]; out[i * 4 + 1] = d[i * 4 + 2]; out[i * 4 + 2] = d[i * 4 + 1]; out[i * 4 + 3] = d[i * 4]; } break;
    case 2: for (let i = 0; i < n; i++) { out[i * 4] = d[i * 3]; out[i * 4 + 1] = d[i * 3 + 1]; out[i * 4 + 2] = d[i * 3 + 2]; out[i * 4 + 3] = 255; } break;
    case 3: for (let i = 0; i < n; i++) { out[i * 4] = d[i * 3 + 2]; out[i * 4 + 1] = d[i * 3 + 1]; out[i * 4 + 2] = d[i * 3]; out[i * 4 + 3] = 255; } break;
    case 4: for (let i = 0; i < n; i++) { const v = d[i * 2] | (d[i * 2 + 1] << 8); out[i * 4] = e5(v & 31); out[i * 4 + 1] = e6((v >> 5) & 63); out[i * 4 + 2] = e5(v >> 11); out[i * 4 + 3] = 255; } break;
    case 17: for (let i = 0; i < n; i++) { const v = d[i * 2] | (d[i * 2 + 1] << 8); out[i * 4] = e5(v >> 11); out[i * 4 + 1] = e6((v >> 5) & 63); out[i * 4 + 2] = e5(v & 31); out[i * 4 + 3] = 255; } break;
    case 5: for (let i = 0; i < n; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = d[i]; out[i * 4 + 3] = 255; } break;
    case 6: for (let i = 0; i < n; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = d[i * 2]; out[i * 4 + 3] = d[i * 2 + 1]; } break;
    case 8: for (let i = 0; i < n; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 255; out[i * 4 + 3] = d[i]; } break;
    case 11: for (let i = 0; i < n; i++) { out[i * 4] = d[i * 4 + 1]; out[i * 4 + 1] = d[i * 4 + 2]; out[i * 4 + 2] = d[i * 4 + 3]; out[i * 4 + 3] = d[i * 4]; } break;
    case 12: for (let i = 0; i < n; i++) { out[i * 4] = d[i * 4 + 2]; out[i * 4 + 1] = d[i * 4 + 1]; out[i * 4 + 2] = d[i * 4]; out[i * 4 + 3] = d[i * 4 + 3]; } break;
    case 16: for (let i = 0; i < n; i++) { out[i * 4] = d[i * 4 + 2]; out[i * 4 + 1] = d[i * 4 + 1]; out[i * 4 + 2] = d[i * 4]; out[i * 4 + 3] = 255; } break;
    case 13: case 20: decodeDXT(d, w, h, out, 0); break;
    case 14: decodeDXT(d, w, h, out, 3); break;
    case 15: decodeDXT(d, w, h, out, 5); break;
    default: throw new Error(`unsupported format ${NAMES[fmt] || fmt}`);
  }
  return out;
}

// ---------- DXT decode ----------

function decodeDXT(d, w, h, out, mode) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const blockSize = mode ? 16 : 8;
  const pal = new Uint8Array(16), alpha = new Uint8Array(16), apal = new Uint8Array(8);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let o = (by * bw + bx) * blockSize;
      alpha.fill(255);
      if (mode === 3) {
        for (let i = 0; i < 16; i++) { const v = (d[o + (i >> 1)] >> ((i & 1) * 4)) & 15; alpha[i] = v * 17; }
        o += 8;
      } else if (mode === 5) {
        const a0 = d[o], a1 = d[o + 1];
        apal[0] = a0; apal[1] = a1;
        if (a0 > a1) for (let i = 1; i <= 6; i++) apal[i + 1] = ((7 - i) * a0 + i * a1 + 3) / 7 | 0;
        else { for (let i = 1; i <= 4; i++) apal[i + 1] = ((5 - i) * a0 + i * a1 + 2) / 5 | 0; apal[6] = 0; apal[7] = 255; }
        const lo = d[o + 2] | (d[o + 3] << 8) | (d[o + 4] << 16) | (d[o + 5] << 24);
        const hi = d[o + 6] | (d[o + 7] << 8);
        for (let i = 0; i < 16; i++) {
          const b = i * 3;
          const idx = b < 30 ? (lo >>> b) & 7 : b === 30 ? ((lo >>> 30) | (hi << 2)) & 7 : (hi >>> (b - 32)) & 7;
          alpha[i] = apal[idx];
        }
        o += 8;
      }
      const c0 = d[o] | (d[o + 1] << 8), c1 = d[o + 2] | (d[o + 3] << 8);
      const r0 = e5(c0 >> 11), g0 = e6((c0 >> 5) & 63), b0 = e5(c0 & 31);
      const r1 = e5(c1 >> 11), g1 = e6((c1 >> 5) & 63), b1 = e5(c1 & 31);
      pal[0] = r0; pal[1] = g0; pal[2] = b0; pal[3] = 255;
      pal[4] = r1; pal[5] = g1; pal[6] = b1; pal[7] = 255;
      if (mode || c0 > c1) {
        pal[8] = (2 * r0 + r1 + 1) / 3 | 0; pal[9] = (2 * g0 + g1 + 1) / 3 | 0; pal[10] = (2 * b0 + b1 + 1) / 3 | 0; pal[11] = 255;
        pal[12] = (r0 + 2 * r1 + 1) / 3 | 0; pal[13] = (g0 + 2 * g1 + 1) / 3 | 0; pal[14] = (b0 + 2 * b1 + 1) / 3 | 0; pal[15] = 255;
      } else {
        pal[8] = (r0 + r1) >> 1; pal[9] = (g0 + g1) >> 1; pal[10] = (b0 + b1) >> 1; pal[11] = 255;
        pal[12] = 0; pal[13] = 0; pal[14] = 0; pal[15] = 0;
      }
      const bits = d[o + 4] | (d[o + 5] << 8) | (d[o + 6] << 16) | (d[o + 7] << 24);
      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py;
        if (y >= h) break;
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          if (x >= w) break;
          const i = py * 4 + px, k = ((bits >>> (i * 2)) & 3) * 4, p = (y * w + x) * 4;
          out[p] = pal[k]; out[p + 1] = pal[k + 1]; out[p + 2] = pal[k + 2];
          out[p + 3] = mode ? alpha[i] : pal[k + 3];
        }
      }
    }
  }
}

// ---------- DXT encode ----------

const q565 = (r, g, b) => ((r * 31 + 127) / 255 << 11 | (g * 63 + 127) / 255 << 5 | (b * 31 + 127) / 255) >>> 0;

const blk = new Uint8Array(64);       // current block, RGBA
const palr = new Int32Array(4), palg = new Int32Array(4), palb = new Int32Array(4);
const W0 = [3, 0, 2, 1];              // weight of c0 (out of 3) for each index

function fetchBlock(rgba, w, h, bx, by) {
  for (let py = 0; py < 4; py++) {
    const y = Math.min(h - 1, by * 4 + py);
    for (let px = 0; px < 4; px++) {
      const x = Math.min(w - 1, bx * 4 + px);
      const s = (y * w + x) * 4, t = (py * 4 + px) * 4;
      blk[t] = rgba[s]; blk[t + 1] = rgba[s + 1]; blk[t + 2] = rgba[s + 2]; blk[t + 3] = rgba[s + 3];
    }
  }
}

function setPalette(c0, c1) {
  palr[0] = e5(c0 >> 11); palg[0] = e6((c0 >> 5) & 63); palb[0] = e5(c0 & 31);
  palr[1] = e5(c1 >> 11); palg[1] = e6((c1 >> 5) & 63); palb[1] = e5(c1 & 31);
  palr[2] = (2 * palr[0] + palr[1] + 1) / 3 | 0; palg[2] = (2 * palg[0] + palg[1] + 1) / 3 | 0; palb[2] = (2 * palb[0] + palb[1] + 1) / 3 | 0;
  palr[3] = (palr[0] + 2 * palr[1] + 1) / 3 | 0; palg[3] = (palg[0] + 2 * palg[1] + 1) / 3 | 0; palb[3] = (palb[0] + 2 * palb[1] + 1) / 3 | 0;
}

/** Assign each pixel to the nearest palette entry. Returns packed indices; err in errOut[0]. */
const errOut = new Float64Array(1);
function matchColors(c0, c1) {
  setPalette(c0, c1);
  let idx = 0, err = 0;
  for (let i = 0; i < 16; i++) {
    const r = blk[i * 4], g = blk[i * 4 + 1], b = blk[i * 4 + 2];
    let best = 0, bd = 1e9;
    for (let k = 0; k < 4; k++) {
      const dr = r - palr[k], dg = g - palg[k], db = b - palb[k];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = k; }
    }
    idx |= best << (i * 2);
    err += bd;
  }
  errOut[0] = err;
  return idx >>> 0;
}

/** Least-squares refit of the endpoints for the given indices. Returns [c0, c1] or null. */
function refine(idx) {
  let A = 0, B = 0, C = 0, r0 = 0, g0 = 0, b0 = 0, r1 = 0, g1 = 0, b1 = 0;
  for (let i = 0; i < 16; i++) {
    const w0 = W0[(idx >>> (i * 2)) & 3], w1 = 3 - w0;
    const r = blk[i * 4], g = blk[i * 4 + 1], b = blk[i * 4 + 2];
    A += w0 * w0; B += w0 * w1; C += w1 * w1;
    r0 += w0 * r; g0 += w0 * g; b0 += w0 * b;
    r1 += w1 * r; g1 += w1 * g; b1 += w1 * b;
  }
  const det = A * C - B * B;
  if (det === 0) return null;
  const s = 3 / det;
  const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  const R0 = cl((C * r0 - B * r1) * s), G0 = cl((C * g0 - B * g1) * s), B0 = cl((C * b0 - B * b1) * s);
  const R1 = cl((A * r1 - B * r0) * s), G1 = cl((A * g1 - B * g0) * s), B1 = cl((A * b1 - B * b0) * s);
  return [q565(R0, G0, B0), q565(R1, G1, B1)];
}

function encodeColorBlock(out, o) {
  let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
  for (let i = 0; i < 16; i++) {
    const r = blk[i * 4], g = blk[i * 4 + 1], b = blk[i * 4 + 2];
    if (r < minR) minR = r; if (r > maxR) maxR = r;
    if (g < minG) minG = g; if (g > maxG) maxG = g;
    if (b < minB) minB = b; if (b > maxB) maxB = b;
  }
  if (minR === maxR && minG === maxG && minB === maxB) { // flat block
    const c = q565(minR, minG, minB);
    out[o] = c & 255; out[o + 1] = c >> 8; out[o + 2] = c & 255; out[o + 3] = c >> 8;
    out[o + 4] = out[o + 5] = out[o + 6] = out[o + 7] = 0;
    return;
  }
  // principal axis (power iteration on the covariance matrix, seeded with the extents)
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 16; i++) { mr += blk[i * 4]; mg += blk[i * 4 + 1]; mb += blk[i * 4 + 2]; }
  mr /= 16; mg /= 16; mb /= 16;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < 16; i++) {
    const r = blk[i * 4] - mr, g = blk[i * 4 + 1] - mg, b = blk[i * 4 + 2] - mb;
    xx += r * r; xy += r * g; xz += r * b; yy += g * g; yz += g * b; zz += b * b;
  }
  let vx = maxR - minR, vy = maxG - minG, vz = maxB - minB;
  for (let it = 0; it < 4; it++) {
    const nx = xx * vx + xy * vy + xz * vz, ny = xy * vx + yy * vy + yz * vz, nz = xz * vx + yz * vy + zz * vz;
    const m = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
    if (m === 0) break;
    vx = nx / m; vy = ny / m; vz = nz / m;
  }
  let minD = Infinity, maxD = -Infinity, minI = 0, maxI = 0;
  for (let i = 0; i < 16; i++) {
    const d = blk[i * 4] * vx + blk[i * 4 + 1] * vy + blk[i * 4 + 2] * vz;
    if (d < minD) { minD = d; minI = i; }
    if (d > maxD) { maxD = d; maxI = i; }
  }
  let c0 = q565(blk[maxI * 4], blk[maxI * 4 + 1], blk[maxI * 4 + 2]);
  let c1 = q565(blk[minI * 4], blk[minI * 4 + 1], blk[minI * 4 + 2]);
  let bestC0 = c0, bestC1 = c1, bestIdx = matchColors(c0, c1), bestErr = errOut[0];
  for (let it = 0; it < 2 && bestErr > 0; it++) {
    const r = refine(bestIdx);
    if (!r || (r[0] === c0 && r[1] === c1)) break;
    c0 = r[0]; c1 = r[1];
    const idx = matchColors(c0, c1);
    if (errOut[0] < bestErr) { bestErr = errOut[0]; bestC0 = c0; bestC1 = c1; bestIdx = idx; } else break;
  }
  if (bestC0 < bestC1) { const t = bestC0; bestC0 = bestC1; bestC1 = t; bestIdx = (bestIdx ^ 0x55555555) >>> 0; }
  else if (bestC0 === bestC1) bestIdx = 0;
  out[o] = bestC0 & 255; out[o + 1] = bestC0 >> 8; out[o + 2] = bestC1 & 255; out[o + 3] = bestC1 >> 8;
  out[o + 4] = bestIdx & 255; out[o + 5] = (bestIdx >>> 8) & 255; out[o + 6] = (bestIdx >>> 16) & 255; out[o + 7] = (bestIdx >>> 24) & 255;
}

const apal = new Int32Array(8);
function encodeAlphaBlock(out, o) {
  let min = 255, max = 0;
  for (let i = 0; i < 16; i++) { const a = blk[i * 4 + 3]; if (a < min) min = a; if (a > max) max = a; }
  out[o] = max; out[o + 1] = min;
  for (let i = 2; i < 8; i++) out[o + i] = 0;
  if (min === max) return;
  apal[0] = max; apal[1] = min;
  for (let i = 1; i <= 6; i++) apal[i + 1] = ((7 - i) * max + i * min + 3) / 7 | 0;
  let acc = 0, nb = 0, p = o + 2;
  for (let i = 0; i < 16; i++) {
    const a = blk[i * 4 + 3];
    let best = 0, bd = 1e9;
    for (let k = 0; k < 8; k++) { const d = Math.abs(a - apal[k]); if (d < bd) { bd = d; best = k; } }
    acc |= best << nb; nb += 3;
    while (nb >= 8) { out[p++] = acc & 255; acc >>>= 8; nb -= 8; }
  }
}

/** Encode RGBA8 to DXT1 (fmt 13) or DXT5 (fmt 15). */
function encodeDXT(rgba, w, h, fmt) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const alpha = fmt === 15, bs = alpha ? 16 : 8;
  const out = Buffer.alloc(bw * bh * bs);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      fetchBlock(rgba, w, h, bx, by);
      const o = (by * bw + bx) * bs;
      if (alpha) { encodeAlphaBlock(out, o); encodeColorBlock(out, o + 8); }
      else encodeColorBlock(out, o);
    }
  }
  return out;
}

// ---------- resampling ----------

/** 2x2 box downsample (exact for power-of-two sizes). */
function halve(rgba, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const out = new Uint8Array(nw * nh * 4);
  const sx = w > 1 ? 2 : 1, sy = h > 1 ? 2 : 1, cnt = sx * sy;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < sy; dy++) {
        for (let dx = 0; dx < sx; dx++) {
          const s = ((y * sy + dy) * w + (x * sx + dx)) * 4;
          r += rgba[s]; g += rgba[s + 1]; b += rgba[s + 2]; a += rgba[s + 3];
        }
      }
      const t = (y * nw + x) * 4;
      out[t] = (r + (cnt >> 1)) / cnt | 0; out[t + 1] = (g + (cnt >> 1)) / cnt | 0; out[t + 2] = (b + (cnt >> 1)) / cnt | 0; out[t + 3] = (a + (cnt >> 1)) / cnt | 0;
    }
  }
  return { rgba: out, w: nw, h: nh };
}

function hasAlpha(rgba) {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true;
  return false;
}

// ---------- writer ----------

/**
 * Build a VTF 7.2 file. mips: [{ rgba, w, h }] largest first.
 * @returns Buffer
 */
function write({ mips, fmt, flags, reflectivity = [0.2, 0.2, 0.2], bumpScale = 1 }) {
  const { w, h } = mips[0];
  let thumbSrc = mips.find((m) => Math.max(m.w, m.h) <= 16) || mips[mips.length - 1];
  while (Math.max(thumbSrc.w, thumbSrc.h) > 16) thumbSrc = halve(thumbSrc.rgba, thumbSrc.w, thumbSrc.h);
  const thumb = encodeDXT(thumbSrc.rgba, thumbSrc.w, thumbSrc.h, 13);
  const parts = [thumb];
  for (let i = mips.length - 1; i >= 0; i--) parts.push(encodeImage(mips[i].rgba, mips[i].w, mips[i].h, fmt));
  const hdr = Buffer.alloc(80);
  hdr.write('VTF\0', 0, 'latin1');
  hdr.writeUInt32LE(7, 4); hdr.writeUInt32LE(2, 8); hdr.writeUInt32LE(80, 12);
  hdr.writeUInt16LE(w, 16); hdr.writeUInt16LE(h, 18);
  let f = flags & ~(FLAGS.ONEBITALPHA | FLAGS.EIGHTBITALPHA);
  if (fmt === 15 || fmt === 12) f |= FLAGS.EIGHTBITALPHA;
  if (mips.length === 1) f |= FLAGS.NOMIP;
  hdr.writeUInt32LE(f >>> 0, 20);
  hdr.writeUInt16LE(1, 24); hdr.writeUInt16LE(0, 26);
  hdr.writeFloatLE(reflectivity[0], 32); hdr.writeFloatLE(reflectivity[1], 36); hdr.writeFloatLE(reflectivity[2], 40);
  hdr.writeFloatLE(bumpScale, 48);
  hdr.writeInt32LE(fmt, 52);
  hdr[56] = mips.length;
  hdr.writeInt32LE(13, 57); hdr[61] = thumbSrc.w; hdr[62] = thumbSrc.h;
  hdr.writeUInt16LE(1, 63);
  return Buffer.concat([hdr, ...parts]);
}

/** Encode RGBA8 into one of the formats the writer supports: DXT1 (13), DXT5 (15), BGR888 (3), BGRA8888 (12). */
function encodeImage(rgba, w, h, fmt) {
  if (fmt === 13 || fmt === 15) return encodeDXT(rgba, w, h, fmt);
  const n = w * h, bpp = fmt === 12 ? 4 : 3;
  const out = Buffer.allocUnsafe(n * bpp);
  for (let i = 0, s = 0, t = 0; i < n; i++, s += 4, t += bpp) {
    out[t] = rgba[s + 2]; out[t + 1] = rgba[s + 1]; out[t + 2] = rgba[s];
    if (bpp === 4) out[t + 3] = rgba[s + 3];
  }
  return out;
}

/**
 * Re-encode a texture: optional downscale to maxSize, then DXT1 (opaque) / DXT5 (alpha),
 * or - with compress:false - lossless BGR888 / BGRA8888 (used for normal maps).
 * @returns {{ buf: Buffer, fmt: number, w: number, h: number }}
 */
function reencode(buf, h, { maxSize = 0, compress = true } = {}) {
  let rgba = decode(buf, h), w = h.width, ht = h.height;
  while (maxSize > 0 && Math.max(w, ht) > maxSize) ({ rgba, w, h: ht } = halve(rgba, w, ht));
  const alpha = hasAlpha(rgba);
  const fmt = compress ? (alpha ? 15 : 13) : (alpha ? 12 : 3);
  const mips = [{ rgba, w, h: ht }];
  if (!(h.flags & FLAGS.NOMIP)) {
    let cur = mips[0];
    while (cur.w > 1 || cur.h > 1) { cur = halve(cur.rgba, cur.w, cur.h); mips.push(cur); }
  }
  return { buf: write({ mips, fmt, flags: h.flags, reflectivity: h.reflectivity, bumpScale: h.bumpScale }), fmt, w, h: ht };
}

/**
 * DXT5 texture whose alpha is 255 everywhere -> DXT1, without touching a single colour (lossless, half the size).
 * The header, thumbnail and other resources are kept byte for byte. Returns null when the texture does not qualify.
 */
function stripOpaqueAlpha(buf, h) {
  if (h.format !== 15 || h.frames !== 1 || h.faces !== 1 || h.depth !== 1) return null;
  const start = highResOffset(h);
  if (start < 0) return null;
  const mips = [];
  let total = 0;
  for (let i = h.mipCount - 1; i >= 0; i--) { const blocks = Math.max(1, ((h.width >> i) + 3) >> 2) * Math.max(1, ((h.height >> i) + 3) >> 2); mips.push(blocks); total += blocks; }
  if (start + total * 16 !== buf.length) return null; // image data must be the last thing in the file
  if (h.minor >= 3 && h.resources.some((r) => r.tag !== 0x30 && r.tag !== 0x01 && !(r.flags & 2) && r.data > start)) return null;
  const out = Buffer.allocUnsafe(start + total * 8);
  buf.copy(out, 0, 0, start);
  let src = start, dst = start;
  for (let b = 0; b < total; b++, src += 16, dst += 8) {
    const a0 = buf[src], a1 = buf[src + 1];
    // opaque block: both endpoints 255, or a0 = 255 with every index pointing at it
    if (a0 !== 255 || (a1 !== 255 && (buf[src + 2] | buf[src + 3] | buf[src + 4] | buf[src + 5] | buf[src + 6] | buf[src + 7]) !== 0)) return null;
    const c0 = buf[src + 8] | (buf[src + 9] << 8), c1 = buf[src + 10] | (buf[src + 11] << 8);
    if (c0 > c1) buf.copy(out, dst, src + 8, src + 16);
    else if (c0 === c1) { out[dst] = buf[src + 8]; out[dst + 1] = buf[src + 9]; out[dst + 2] = buf[src + 8]; out[dst + 3] = buf[src + 9]; out[dst + 4] = out[dst + 5] = out[dst + 6] = out[dst + 7] = 0; } else {
      // DXT1 needs c0 > c1 for its 4-colour mode: swap the endpoints and flip the indices (0<->1, 2<->3)
      out[dst] = buf[src + 10]; out[dst + 1] = buf[src + 11]; out[dst + 2] = buf[src + 8]; out[dst + 3] = buf[src + 9];
      for (let k = 4; k < 8; k++) out[dst + k] = buf[src + 8 + k] ^ 0x55;
    }
  }
  out.writeInt32LE(13, 52);
  out.writeUInt32LE((h.flags & ~(FLAGS.ONEBITALPHA | FLAGS.EIGHTBITALPHA)) >>> 0, 20);
  return out;
}

module.exports = { stripOpaqueAlpha, FMT, NAMES, FLAGS, parse, decode, encodeDXT, encodeImage, halve, write, reencode, imageSize, hasAlpha };
