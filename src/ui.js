'use strict';
// Console helpers: colours, number formatting, prompts (work on a TTY and with piped input), menus, spinner / progress bar.
const readline = require('readline');
const { spawn } = require('child_process');
const colors = require('@colors/colors/safe');

const { gray, green, red, white, yellow, cyan, bold } = colors;

/** Locale-aware formatters. */
function makeFmt(lang) {
  const frn = lang === 'fr';
  const num = (v, digits) => { const s = v.toFixed(digits); return frn ? s.replace('.', ',') : s; };
  const units = frn ? ['Ko', 'Mo', 'Go'] : ['KB', 'MB', 'GB'];
  const bytes = (n) => {
    if (!Number.isFinite(n)) return '∞';
    if (n >= 1073741824) return `${num(n / 1073741824, 2)} ${units[2]}`;
    if (n >= 1048576) return `${num(n / 1048576, n >= 104857600 ? 0 : 1)} ${units[1]}`;
    return `${num(n / 1024, n >= 10240 ? 0 : 1)} ${units[0]}`;
  };
  const duration = (ms) => {
    if (ms < 60000) return `${num(ms / 1000, 1)} s`;
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  };
  const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  return { bytes, duration, clock, num };
}

// ---------- prompts ----------

const unquote = (v) => v.trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
const io = { rl: null, closed: false, waiter: null, lines: [] };

/** Line-buffered question: answers piped in advance are queued, not lost. */
function ask(question, t) {
  if (!io.rl) {
    io.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    io.rl.on('line', (l) => { if (io.waiter) { const w = io.waiter; io.waiter = null; w(l); } else io.lines.push(l); });
    io.rl.on('close', () => { io.closed = true; if (io.waiter) { const w = io.waiter; io.waiter = null; w(null); } });
  }
  io.rl.setPrompt(`${gray('-')} ${question} ${gray('>')} `);
  io.rl.prompt();
  const eof = () => new Error(t ? t('cli.inputClosed') : 'Input closed');
  if (io.lines.length) { const l = io.lines.shift(); if (!process.stdin.isTTY) console.log(l); return Promise.resolve(l); }
  if (io.closed) return Promise.reject(eof());
  return new Promise((res, rej) => { io.waiter = (l) => (l === null ? rej(eof()) : res(l)); });
}

async function askUntil(question, validate, t) {
  for (;;) {
    const raw = unquote(await ask(question, t));
    const err = validate(raw);
    if (!err) return raw;
    console.log(red(`  ${err}`));
  }
}

async function askYN(question, def, t) {
  const y = t.lang === 'fr' ? 'o' : 'y';
  const hint = def === undefined ? `${white('[')}${green(y)}${white('/')}${red('n')}${white(']')}`
    : def ? `${white('[')}${green(y.toUpperCase())}${white('/')}${red('n')}${white(']')}` : `${white('[')}${green(y)}${white('/')}${red('N')}${white(']')}`;
  for (;;) {
    const a = (await ask(`${question} ${hint}`, t)).trim().toLowerCase();
    if (a === '' && def !== undefined) return def;
    if (['y', 'yes', 'o', 'oui'].includes(a)) return true;
    if (['n', 'no', 'non'].includes(a)) return false;
    console.log(red(`  ${t('cli.invalidYN')}`));
  }
}

/**
 * Numbered menu. options: [{ label, hint?, value }]. Enter picks `def` (a value) when given.
 * `zero` adds a "0) …" entry (quit / back) that resolves to null.
 */
async function choose(title, options, { def, zero, t }) {
  console.log(`\n${white(title)}`);
  options.forEach((o, i) => console.log(`  ${cyan(String(i + 1).padStart(2))}) ${white(o.label)}${o.hint ? gray(`  (${o.hint})`) : ''}`));
  if (zero) console.log(`  ${cyan(' 0')}) ${gray(zero)}`);
  const defIndex = def === undefined ? -1 : options.findIndex((o) => o.value === def);
  for (;;) {
    const a = (await ask(defIndex >= 0 ? `[${defIndex + 1}]` : '#', t)).trim();
    if (a === '' && defIndex >= 0) return options[defIndex].value;
    if (a === '' && zero && defIndex < 0) return null;
    if (a === '0' && zero) return null;
    const n = parseInt(a, 10);
    if (String(n) === a && n >= 1 && n <= options.length) return options[n - 1].value;
    console.log(red(`  ${t('cli.invalidChoice')}`));
  }
}

function closePrompts() { if (io.rl && !io.closed) io.rl.close(); }

function waitForExit(t) {
  console.log(gray(`\n${t('cli.pressEnter')}`));
  closePrompts();
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(process.exitCode || 0));
}

// ---------- status line: spinner + progress bar ----------

function createStatus(t, fmt) {
  const tty = !!process.stdout.isTTY;
  const frames = ['|', '/', '-', '\\'];
  let msg = '', bar = null, frame = 0, started = 0, lastPrinted = '', lastDecile = -1;
  const width = () => Math.max(40, (process.stdout.columns || 100) - 2);
  const draw = () => {
    let line;
    if (bar && bar.totalBytes > 0) {
      const ratio = Math.min(1, bar.doneBytes / bar.totalBytes);
      const cells = 22, full = Math.round(ratio * cells);
      const elapsed = (Date.now() - started) / 1000;
      const speed = elapsed > 0.5 ? bar.doneBytes / elapsed : 0;
      const eta = speed > 0 ? ((bar.totalBytes - bar.doneBytes) / speed) * 1000 : 0;
      const short = `${'█'.repeat(full)}${'░'.repeat(cells - full)} ${String(Math.round(ratio * 100)).padStart(3)}%`;
      const long = `${short}  ${fmt.bytes(bar.doneBytes)} / ${fmt.bytes(bar.totalBytes)}${speed > 0 ? `  ${fmt.bytes(speed)}/s  ${t('progress.eta')} ${fmt.clock(eta)}` : ''}`;
      const head = long.length + 2 <= (process.stdout.columns || 100) - 1 ? long : short; // narrow console: bar and percentage only
      const room = width() - head.length - 4;
      const file = room > 12 && bar.current ? `  ${bar.current.length > room ? `…${bar.current.slice(-(room - 1))}` : bar.current}` : '';
      line = `${green(head.slice(0, cells))}${white(head.slice(cells))}${gray(file)}`;
      process.stdout.write(`\r${gray('-')} ${line}${' '.repeat(Math.max(0, width() - head.length - file.length - 2))}`);
      return;
    }
    line = `${msg.slice(0, width() - 6)}`;
    process.stdout.write(`\r${gray(`- ${line.padEnd(width() - 6)}`)} ${white(frames[frame++ % frames.length])}`);
  };
  const timer = tty ? setInterval(draw, 100) : null;
  if (timer && timer.unref) timer.unref();
  return {
    phase(m, quiet) {
      const changed = m !== msg || bar !== null;
      msg = m; bar = null;
      if (tty) { if (changed) draw(); } // right away: the next step may keep the event loop busy for a while
      else if (!quiet && m !== lastPrinted) { lastPrinted = m; console.log(gray(`- ${m}`)); }
    },
    progress(p) {
      if (!bar) started = Date.now();
      bar = p;
      if (!tty && p.totalBytes > 0) {
        const decile = Math.floor((p.doneBytes / p.totalBytes) * 10);
        if (decile !== lastDecile) { lastDecile = decile; console.log(gray(`  ${decile * 10}%  ${fmt.bytes(p.doneBytes)} / ${fmt.bytes(p.totalBytes)}`)); }
      }
    },
    stop() { if (timer) { clearInterval(timer); process.stdout.write(`\r${' '.repeat(width() + 1)}\r`); } },
  };
}

// ---------- misc ----------

/** Open a file or a folder with the default application. */
function openPath(target) {
  try {
    // explorer.exe, not "cmd /c start": a file name containing & or ^ must never reach a shell
    const cmd = process.platform === 'win32' ? ['explorer.exe', [target]] : process.platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  } catch { return false; }
}

const bell = () => { if (process.stdout.isTTY) process.stdout.write('\x07'); };

module.exports = { colors: { gray, green, red, white, yellow, cyan, bold }, makeFmt, unquote, ask, askUntil, askYN, choose, closePrompts, waitForExit, createStatus, openPath, bell, io };
