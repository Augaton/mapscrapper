'use strict';
// Tolerant Valve KeyValues tokenizer/parser (VMT, soundscapes, soundscripts, manifests, mount.cfg...).
// Keys are lowercased, values keep their case. `[...]` conditionals and `//` comments are ignored.

function tokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 13 || c === 10) { i++; continue; }
    if (c === 47 && text.charCodeAt(i + 1) === 47) { // // comment
      while (i < n && text.charCodeAt(i) !== 10) i++;
      continue;
    }
    if (c === 123) { tokens.push('{'); i++; continue; }
    if (c === 125) { tokens.push('}'); i++; continue; }
    if (c === 34) { // quoted string
      let j = text.indexOf('"', i + 1);
      if (j === -1) j = n;
      tokens.push(text.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === 32 || d === 9 || d === 13 || d === 10 || d === 123 || d === 125 || d === 34) break;
      j++;
    }
    const word = text.slice(i, j);
    i = j;
    if (word[0] === '[' && word[word.length - 1] === ']') continue; // conditional e.g. [$X360]
    tokens.push(word);
  }
  return tokens;
}

/**
 * Parse KeyValues text into a tree: [{ key, value } | { key, children }]
 */
function parse(text) {
  const tokens = tokenize(text);
  let pos = 0;
  let depth = 0;
  function block() {
    if (++depth > 64) throw new Error('KeyValues nested too deeply'); // hostile file: no stack overflow
    try { return blockBody(); } finally { depth--; }
  }
  function blockBody() {
    const out = [];
    while (pos < tokens.length) {
      const t = tokens[pos++];
      if (t === '}') return out;
      if (t === '{') { out.push({ key: '', children: block() }); continue; }
      const next = tokens[pos];
      if (next === '{') { pos++; out.push({ key: t.toLowerCase(), children: block() }); }
      else if (next === undefined || next === '}') out.push({ key: t.toLowerCase(), value: '' });
      else { pos++; out.push({ key: t.toLowerCase(), value: next }); }
    }
    return out;
  }
  return block();
}

/** Depth-first iterator over every node. */
function* walk(nodes) {
  for (const n of nodes) {
    yield n;
    if (n.children) yield* walk(n.children);
  }
}

/** Map<key, string[]> of every leaf pair at any depth. */
function flatten(nodes, map = new Map()) {
  for (const n of walk(nodes)) {
    if (n.children) continue;
    const arr = map.get(n.key);
    if (arr) arr.push(n.value); else map.set(n.key, [n.value]);
  }
  return map;
}

module.exports = { tokenize, parse, walk, flatten };
