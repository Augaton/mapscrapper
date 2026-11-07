'use strict';
// Particle file reader (.pcf = DMX "binary 2..5, format pcf"). Used to follow only the particle systems a map
// really uses (and their children) instead of every material named anywhere in the file.
// parsePCF returns null whenever the file is not read cleanly to its last byte: callers then fall back to a text scan.

const SIZES = { 2: 4, 3: 4, 4: 1, 8: 4, 9: 8, 10: 12, 11: 16, 12: 12, 13: 16, 14: 64 };

function parsePCF(buf) {
  try {
    const nl = buf.indexOf(0x0a);
    if (nl < 0 || nl > 200) return null;
    const m = /dmx encoding binary (\d+) format pcf/.exec(buf.toString('latin1', 0, nl));
    if (!m) return null;
    const ver = +m[1];
    if (ver < 2 || ver > 5) return null;
    let p = nl + 2; // "\n" + NUL
    const need = (n) => { if (p + n > buf.length) throw new Error('eof'); };
    const cstr = () => { const e = buf.indexOf(0, p); if (e < 0) throw new Error('eof'); const s = buf.toString('latin1', p, e); p = e + 1; return s; };
    const i32 = () => { need(4); const v = buf.readInt32LE(p); p += 4; return v; };
    const u16 = () => { need(2); const v = buf.readUInt16LE(p); p += 2; return v; };
    const dictIndex = () => (ver >= 5 ? i32() : u16());

    const dictCount = ver >= 4 ? i32() : u16();
    if (dictCount < 0 || dictCount > 100000) return null;
    const dict = [];
    for (let i = 0; i < dictCount; i++) dict.push(cstr());
    const word = () => { const s = dict[dictIndex()]; if (s === undefined) throw new Error('bad string index'); return s; };

    const count = i32();
    if (count < 0 || count > 200000) return null;
    const elements = [];
    for (let i = 0; i < count; i++) {
      const type = word();
      const name = ver >= 4 ? word() : cstr();
      need(16); p += 16; // GUID
      elements.push({ type, name, refs: [], strings: [] });
    }
    const value = (t, el) => {
      if (t === 1) { const r = i32(); if (r >= 0 && r < count) el.refs.push(r); return; }
      if (t === 5) { el.strings.push(ver >= 4 ? word() : cstr()); return; }
      if (t === 6) { const n = i32(); if (n < 0) throw new Error('bad blob'); need(n); p += n; return; }
      if (t === 7) { const n = ver >= 3 ? 4 : 16; need(n); p += n; return; } // time (v3+) / object id (v1-2)
      const size = SIZES[t];
      if (!size) throw new Error(`unknown attribute type ${t}`);
      need(size); p += size;
    };
    for (const el of elements) {
      const n = i32();
      if (n < 0 || n > 10000) return null;
      for (let a = 0; a < n; a++) {
        word(); // attribute name
        need(1); const t = buf[p++];
        if (t >= 15 && t <= 28) { const len = i32(); if (len < 0 || len > 1000000) return null; for (let k = 0; k < len; k++) value(t - 14, el); } else value(t, el);
      }
    }
    if (p !== buf.length) return null;
    const systems = new Map();
    elements.forEach((el, i) => { if (el.type === 'DmeParticleSystemDefinition') systems.set(el.name.toLowerCase(), i); });
    return { version: ver, elements, systems };
  } catch { return null; }
}

/** Every string reachable from the given particle systems (operators, renderers, children systems...). */
function stringsOf(pcf, systemNames) {
  const out = [], seen = new Set(), stack = [];
  for (const n of systemNames) { const i = pcf.systems.get(String(n).toLowerCase()); if (i !== undefined) stack.push(i); }
  while (stack.length) {
    const i = stack.pop();
    if (seen.has(i)) continue;
    seen.add(i);
    const el = pcf.elements[i];
    out.push(...el.strings);
    for (const r of el.refs) stack.push(r);
  }
  return out;
}

module.exports = { parsePCF, stringsOf };
