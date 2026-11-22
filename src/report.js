'use strict';
// Text and HTML reports written next to the output folder.
const fs = require('fs');
const { pathToFileURL } = require('url');
const { describeRef, describeChain } = require('./scraper');

const WORKSHOP_URL = 'https://steamcommunity.com/sharedfiles/filedetails/?id=';

// ---------- text ----------

function textReport(r, { optRes, gmaRes, t, fmt, version }) {
  const L = [];
  const section = (title, items) => { L.push('', `== ${title} (${items.length}) ==`); for (const i of items) L.push(i); };
  const addon = (a) => `${String(a.files).padStart(6)} ${t('sum.filesWord')} ${a.bytes ? fmt.bytes(a.bytes).padStart(10) : ''.padStart(10)}  ${a.id ? WORKSHOP_URL + a.id : '(local .gma)'}  ${a.name}`;
  L.push(t('rep.title', { map: r.mapname }), t('rep.generated', { date: new Date().toLocaleString(t.lang), version }), `${t('rep.output')}: ${r.outputDir}`, `${t('rep.duration')}: ${fmt.duration(r.ms)}`, '');
  L.push(`Stats: ${JSON.stringify(r.stats)}`, `Referenced: ${JSON.stringify(r.referenced)}`);
  if (r.dryRun) L.push(t('rep.dry'));
  if (r.bsp) L.push(`BSP: ${r.bsp.file} (${t('sum.bspDetail', { version: r.bsp.version, compressed: r.bsp.compressed ? t('sum.bspCompressedTag') : '', pak: r.bsp.pakFiles })})`);
  if (r.bspCompression) L.push(`${t('sum.bspCompressed')} ${fmt.bytes(r.bspCompression.before)} -> ${fmt.bytes(r.bspCompression.after)} (${r.bspCompression.tool})`);
  if (gmaRes) section(t('rep.archives'), gmaRes.archives.map((a) => `${fmt.bytes(a.size).padStart(10)}  ${a.count} ${t('sum.filesWord')}  ${a.file}`));
  if (optRes) {
    section(`${t('rep.optimisation')}: ${fmt.bytes(optRes.before)} -> ${fmt.bytes(optRes.after)}`, optRes.converted.map((c) => `${fmt.bytes(c.before).padStart(10)} -> ${fmt.bytes(c.after).padStart(10)}  ${c.rel}  (${c.from} -> ${c.to})`));
    section(t('rep.optSkipped'), optRes.skipped.map((x) => `${fmt.bytes(x.size).padStart(10)}  ${x.rel}  (${x.reason})`));
  }
  if (r.diff) {
    L.push('', `== ${t('rep.diff')} ==`, t('sum.diff', { added: r.diff.added.length, addedSize: fmt.bytes(r.diff.addedBytes), removed: r.diff.removed.length, removedSize: fmt.bytes(r.diff.removedBytes), changed: r.diff.changed.length }));
    for (const [label, list, sign] of [[t('rep.added'), r.diff.added, '+'], [t('rep.removed'), r.diff.removed, '-'], [t('rep.changed'), r.diff.changed, '~']]) {
      if (list.length) { L.push(`-- ${label} (${list.length})`); for (const f of list) L.push(`${sign} ${f}`); }
    }
  }
  section(t('rep.sizeByCategory'), Object.entries(r.bytes).map(([c, n]) => `${c.padEnd(10)} ${fmt.bytes(n)}`));
  section(t('rep.largest'), r.largest.map((f) => `${fmt.bytes(f.size).padStart(10)}  ${f.rel}`));
  section(t('rep.bigTextures'), r.bigTextures.map((f) => `${fmt.bytes(f.size).padStart(10)}  ${f.rel}`));
  section(t('rep.missing'), r.missing.flatMap((f) => { const c = describeChain(r.missingRefs[f] || [], t); return c ? [f, `      <- ${c.replace(/←/g, '<-')}`] : [f]; }));
  section(t('rep.wsExcluded'), r.workshop.excluded.map(addon));
  section(t('rep.wsExtracted'), r.workshop.extracted.map(addon));
  section(t('rep.wsRequired'), r.workshop.required.map(addon));
  section(t('rep.wsDuplicates'), r.workshop.duplicates.map((a) => `${addon(a)}${a.id ? `   -> --exclude-workshop ${a.id}` : ''}`));
  section(t('rep.wsFiles'), r.workshopMissing.map((f) => `${f}   <- ${r.workshopProviders[f] || ''}`));
  section(t('rep.incomplete'), r.incompleteModels);
  section(t('rep.packed'), r.packed);
  section(t('rep.notGma'), r.notGmaAllowed);
  section(t('rep.warnings'), [...r.warnings, ...r.workshop.errors.map((e) => `workshop: ${e}`)]);
  section(t('rep.notes'), r.notes);
  const unresolved = (kind, names) => names.map((n) => { const c = describeChain(r.unresolvedRefs[`${kind}:${n}`] || [], t); return c ? `${n}   <- ${c.replace(/←/g, '<-')}` : n; });
  section(t('rep.unresolvedEffects'), unresolved('effect', r.unresolved.effects));
  section(t('rep.unresolvedSoundscapes'), unresolved('soundscape', r.unresolved.soundscapes));
  section(t('rep.unresolvedSoundscripts'), unresolved('soundscript', r.unresolved.soundscripts));
  section(t('rep.stock'), r.stock);
  section(t('rep.timings'), r.timings.map(([name, ms]) => `${String(ms).padStart(7)} ms  ${name}`));
  section(t('rep.searchPaths'), r.searchPaths);
  section(t('rep.vpks'), r.vpkFiles);
  return `${L.join('\n')}\n`;
}

// ---------- html ----------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#1d2330;--muted:#667085;--line:#e4e7ec;--accent:#2f9e63;--warn:#c4620c;--bad:#c2342d;--code:#eef1f5}
@media(prefers-color-scheme:dark){:root{--bg:#12151b;--card:#1b2029;--text:#e6e9ef;--muted:#98a2b3;--line:#2a313d;--accent:#48c78e;--warn:#f0a35e;--bad:#f0706a;--code:#232a35}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI",system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:24px 16px 64px}h1{margin:0 0 4px;font-size:24px}h2{margin:32px 0 10px;font-size:17px}
.sub{color:var(--muted);margin:0 0 4px;word-break:break-all}.sub a{color:var(--accent)}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 0}nav a{padding:4px 10px;border:1px solid var(--line);border-radius:999px;color:var(--text);text-decoration:none;background:var(--card);font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card b{display:block;font-size:20px}.card span{color:var(--muted);font-size:12px}
.card.bad b{color:var(--bad)}.card.warn b{color:var(--warn)}.card.ok b{color:var(--accent)}
.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow-x:auto}
.bar{display:grid;grid-template-columns:110px 1fr 90px;gap:10px;align-items:center;margin:5px 0}.bar i{display:block;height:10px;border-radius:5px;background:var(--accent);min-width:2px}.bar em{font-style:normal;color:var(--muted);text-align:right}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600;white-space:nowrap}th[data-sort]{cursor:pointer}
td.num{white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}code,td.path{font-family:Consolas,ui-monospace,monospace;font-size:12.5px;word-break:break-all}
.chain{color:var(--muted)}.chain .ent{color:var(--text);font-weight:600}.chain .arrow{opacity:.6;padding:0 3px}
button.copy{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--code);color:var(--text);border-radius:6px;padding:0 6px;cursor:pointer}
input.filter{width:100%;max-width:340px;margin:0 0 8px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)}
details{margin:8px 0}summary{cursor:pointer;font-weight:600}ul{margin:6px 0;padding-left:20px}li{margin:3px 0}
.note{border-left:3px solid var(--warn);padding:4px 10px;margin:6px 0;background:var(--card)}.err{border-left-color:var(--bad)}.hint{color:var(--muted);margin:0 0 8px}.tag{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--code);font-size:12px;margin-left:8px}
`;

const JS = `
document.querySelectorAll('input[data-filter]').forEach(function(inp){inp.addEventListener('input',function(){var q=inp.value.toLowerCase();document.querySelectorAll(inp.dataset.filter+' tbody tr').forEach(function(tr){tr.hidden=tr.textContent.toLowerCase().indexOf(q)<0;});});});
document.querySelectorAll('th[data-sort]').forEach(function(th){th.addEventListener('click',function(){var tb=th.closest('table').tBodies[0],i=th.cellIndex,dir=th.dataset.dir==='asc'?-1:1;th.dataset.dir=dir===1?'asc':'desc';Array.prototype.slice.call(tb.rows).sort(function(a,b){var x=a.cells[i].dataset.v||a.cells[i].textContent,y=b.cells[i].dataset.v||b.cells[i].textContent,nx=parseFloat(x),ny=parseFloat(y);return(!isNaN(nx)&&!isNaN(ny)&&a.cells[i].dataset.v!==undefined?nx-ny:x.localeCompare(y))*dir;}).forEach(function(r){tb.appendChild(r);});});});
document.querySelectorAll('button[data-copy]').forEach(function(b){b.addEventListener('click',function(){if(navigator.clipboard)navigator.clipboard.writeText(b.dataset.copy);b.textContent='✓ '+b.dataset.copy;});});
`;

function htmlChain(chain, t) {
  if (!chain || !chain.length) return '';
  return `<span class="chain">${chain.map((ref) => {
    if (ref && typeof ref === 'object' && ref.kind === 'entity') {
      const head = [ref.cls || 'entity', ref.id ? `#${ref.id}` : '', ref.name ? `"${ref.name}"` : '', ref.file ? `[${ref.file}]` : ''].filter(Boolean).join(' ');
      return `<span class="ent">${esc(head)}</span>${ref.origin ? ` <button class="copy" data-copy="${esc(ref.origin)}" title="Hammer: View &gt; Go to Coordinates">${esc(ref.origin)}</button>` : ''}`;
    }
    const text = describeRef(ref, t);
    return typeof ref === 'string' ? `<code>${esc(text)}</code>` : `<span class="ent">${esc(text)}</span>`;
  }).join('<span class="arrow">←</span>')}</span>`;
}

function htmlReport(r, { optRes, gmaRes, t, fmt, version }) {
  const parts = [], nav = [];
  const section = (id, title, body, count) => {
    if (!body) return;
    nav.push(`<a href="#${id}">${esc(title)}${count !== undefined ? ` <b>${count}</b>` : ''}</a>`);
    parts.push(`<h2 id="${id}">${esc(title)}${count !== undefined ? `<span class="tag">${count}</span>` : ''}</h2>${body}`);
  };
  const table = (id, heads, rows, filter) => (rows.length
    ? `${filter ? `<input class="filter" data-filter="#${id}" placeholder="${esc(t('rep.filter'))}">` : ''}<div class="box"><table id="${id}"><thead><tr>${heads.map((h) => `<th data-sort>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '');
  const listBox = (items) => (items.length ? `<div class="box"><ul>${items.map((i) => `<li><code>${esc(i)}</code></li>`).join('')}</ul></div>` : '');
  const sizeCell = (n) => `<td class="num" data-v="${n}">${esc(fmt.bytes(n))}</td>`;
  const addonRows = (list) => list.map((a) => `<tr><td>${a.id ? `<a href="${WORKSHOP_URL}${esc(a.id)}" target="_blank" rel="noopener">${esc(a.name || a.id)}</a>` : esc(a.name || '(local .gma)')}</td><td class="num" data-v="${a.files}">${a.files}</td>${a.bytes ? sizeCell(a.bytes) : '<td></td>'}<td><code>${esc(a.id || '')}</code></td></tr>`);
  const details = (title, count, body) => (body ? `<details><summary>${esc(title)} <span class="tag">${count}</span></summary>${body}</details>` : '');

  // overview
  const s = r.stats;
  const card = (value, label, cls = '') => `<div class="card ${cls}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const cards = [
    card(s.files, t('sum.files')), card(fmt.bytes(r.bytes.total), t('sum.total').replace(/\s*:\s*$/, '')),
    card(s.materials, t('sum.materials')), card(s.textures, t('sum.textures')), card(s.models, t('sum.models')), card(s.sounds, t('sum.sounds')), card(s.particles, t('sum.particles')),
    card(r.missing.length, t('rep.missing'), r.missing.length ? 'bad' : 'ok'),
  ];
  if (r.workshopMissing.length) cards.push(card(r.workshopMissing.length, t('rep.wsFiles'), 'warn'));
  if (s.inBsp) cards.push(card(s.inBsp, t('sum.inBsp', { n: '' }).trim()));
  if (s.skinPruned) cards.push(card(s.skinPruned, t('sum.skinPruned', { n: '' }).trim()));
  if (r.bspCompression) cards.push(card(`${fmt.bytes(r.bspCompression.before)} → ${fmt.bytes(r.bspCompression.after)}`, t('sum.bspCompressed').replace(/\s*:\s*$/, ''), 'ok'));
  if (optRes) cards.push(card(`-${fmt.bytes(optRes.saved)}`, t('rep.optimisation'), 'ok'));
  const max = Math.max(1, ...Object.entries(r.bytes).filter(([c]) => c !== 'total').map(([, n]) => n));
  const bars = Object.entries(r.bytes).filter(([c, n]) => c !== 'total' && n > 0).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<div class="bar"><span>${esc(c)}</span><i style="width:${Math.max(0.5, (n / max) * 100).toFixed(1)}%"></i><em>${esc(fmt.bytes(n))}</em></div>`).join('');
  section('overview', t('rep.overview'), `<div class="cards">${cards.join('')}</div><h2>${esc(t('rep.sizeByCategory'))}</h2><div class="box">${bars}</div>`);

  if (r.diff && (r.diff.added.length || r.diff.removed.length || r.diff.changed.length)) {
    const cap = (list) => listBox(list.slice(0, 400)) + (list.length > 400 ? `<p class="hint">+${list.length - 400}…</p>` : '');
    section('diff', t('rep.diff'), `<p class="hint">${esc(t('sum.diff', { added: r.diff.added.length, addedSize: fmt.bytes(r.diff.addedBytes), removed: r.diff.removed.length, removedSize: fmt.bytes(r.diff.removedBytes), changed: r.diff.changed.length }))}</p>`
      + details(t('rep.added'), r.diff.added.length, cap(r.diff.added)) + details(t('rep.removed'), r.diff.removed.length, cap(r.diff.removed)) + details(t('rep.changed'), r.diff.changed.length, cap(r.diff.changed)));
  }

  section('missing', t('rep.missing'), r.missing.length
    ? `<p class="hint">${esc(t('rep.missingHint'))}</p>${table('t-missing', [t('rep.file'), t('rep.usedBy')], r.missing.map((f) => `<tr><td class="path">${esc(f)}</td><td>${htmlChain(r.missingRefs[f], t)}</td></tr>`), true)}`
    : `<p class="hint">${esc(t('rep.nothing'))}</p>`, r.missing.length);

  const ws = [
    [t('rep.wsExcluded'), r.workshop.excluded], [t('rep.wsExtracted'), r.workshop.extracted], [t('rep.wsRequired'), r.workshop.required], [t('rep.wsDuplicates'), r.workshop.duplicates],
  ].filter(([, l]) => l.length).map(([title, l], i) => `<h3>${esc(title)}</h3>${table(`t-ws${i}`, [t('rep.item'), t('sum.filesWord'), t('rep.size'), 'id'], addonRows(l))}`).join('');
  const wsFiles = r.workshopMissing.length ? details(t('rep.wsFiles'), r.workshopMissing.length, table('t-wsfiles', [t('rep.file'), t('rep.item')], r.workshopMissing.map((f) => `<tr><td class="path">${esc(f)}</td><td>${esc(r.workshopProviders[f] || '')}</td></tr>`), true)) : '';
  section('workshop', t('rep.workshop'), ws + wsFiles || '');

  if (gmaRes) section('archives', t('rep.archives'), table('t-gma', [t('rep.file'), t('sum.filesWord'), t('rep.size')], gmaRes.archives.map((a) => `<tr><td class="path">${esc(a.file)}</td><td class="num" data-v="${a.count}">${a.count}</td>${sizeCell(a.size)}</tr>`)));
  if (optRes) {
    section('optimisation', t('rep.optimisation'), `<p class="hint">${esc(`${fmt.bytes(optRes.before)} → ${fmt.bytes(optRes.after)} (-${fmt.bytes(optRes.saved)})`)}</p>`
      + table('t-opt', [t('rep.file'), t('rep.size'), '→', ''], optRes.converted.map((c) => `<tr><td class="path">${esc(c.rel)}</td>${sizeCell(c.before)}${sizeCell(c.after)}<td>${esc(`${c.from} → ${c.to}`)}</td></tr>`), true)
      + details(t('rep.optSkipped'), optRes.skipped.length, listBox(optRes.skipped.map((x) => `${x.rel}  (${x.reason})`))), optRes.converted.length);
  }
  section('largest', t('rep.largest'), table('t-largest', [t('rep.file'), t('rep.size')], r.largest.map((f) => `<tr><td class="path">${esc(f.rel)}</td>${sizeCell(f.size)}</tr>`)));

  const messages = [...r.warnings.map((w) => `<div class="note err">${esc(w)}</div>`), ...r.workshop.errors.map((w) => `<div class="note err">workshop: ${esc(w)}</div>`), ...r.notes.map((n) => `<div class="note">${esc(n)}</div>`)].join('');
  section('notes', `${t('rep.warnings')} / ${t('rep.notes')}`, messages, r.warnings.length + r.notes.length);

  const unresolvedRows = [['effect', r.unresolved.effects, t('sum.unresolved.effects')], ['soundscape', r.unresolved.soundscapes, t('sum.unresolved.soundscapes')], ['soundscript', r.unresolved.soundscripts, t('sum.unresolved.soundscripts')]]
    .flatMap(([kind, names, label]) => names.map((n) => `<tr><td>${esc(label)}</td><td class="path">${esc(n)}</td><td>${htmlChain(r.unresolvedRefs[`${kind}:${n}`], t)}</td></tr>`));
  const more = [
    details(t('sum.unresolved', { n: unresolvedRows.length }).replace(/^\S+\s+/, ''), unresolvedRows.length, table('t-unres', ['', t('rep.file'), t('rep.usedBy')], unresolvedRows, true)),
    details(t('rep.incomplete'), r.incompleteModels.length, listBox(r.incompleteModels)),
    details(t('rep.bigTextures'), r.bigTextures.length, listBox(r.bigTextures.map((f) => `${fmt.bytes(f.size)}  ${f.rel}`))),
    details(t('rep.packed'), r.packed.length, listBox(r.packed)),
    details(t('rep.notGma'), r.notGmaAllowed.length, listBox(r.notGmaAllowed)),
    details(t('rep.stock'), r.stock.length, listBox(r.stock)),
    details(t('rep.timings'), r.timings.length, listBox(r.timings.map(([n, ms]) => `${ms} ms  ${n}`))),
    details(t('rep.searchPaths'), r.searchPaths.length, listBox(r.searchPaths)),
    details(t('rep.vpks'), r.vpkFiles.length, listBox(r.vpkFiles)),
  ].join('');
  section('more', '…', more);

  let folderUrl = '';
  try { folderUrl = pathToFileURL(r.outputDir).href; } catch { /* odd path */ }
  const bspLine = r.bsp ? `<p class="sub">BSP: ${esc(r.bsp.file)} (${esc(t('sum.bspDetail', { version: r.bsp.version, compressed: r.bsp.compressed ? t('sum.bspCompressedTag') : '', pak: r.bsp.pakFiles }))})</p>` : '';
  return `<!doctype html>
<html lang="${esc(t.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t('rep.title', { map: r.mapname }))}</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(r.mapname)}${r.dryRun ? `<span class="tag">${esc(t('rep.dry'))}</span>` : ''}</h1>
<p class="sub">${esc(t('rep.generated', { date: new Date().toLocaleString(t.lang), version }))} · ${esc(t('rep.duration'))}: ${esc(fmt.duration(r.ms))}</p>
<p class="sub">${esc(t('rep.output'))}: ${folderUrl && !r.dryRun ? `<a href="${esc(folderUrl)}">${esc(r.outputDir)}</a>` : esc(r.outputDir)}</p>${bspLine}
<nav>${nav.join('')}</nav>
${parts.join('\n')}
</main><script>${JS}</script></body></html>
`;
}

/** Writes <output>_report.txt and <output>_report.html; returns their paths. */
function writeReports(r, extras) {
  const txt = `${r.outputDir}_report.txt`, html = `${r.outputDir}_report.html`;
  fs.writeFileSync(txt, textReport(r, extras));
  fs.writeFileSync(html, htmlReport(r, extras));
  return { txt, html };
}

module.exports = { textReport, htmlReport, writeReports, esc };
