'use strict';
// Windows Explorer integration: a right-click "Extract with MapScraper" entry on .vmf / .bsp files.
// Per-user keys only (HKCU), nothing needs administrator rights and uninstall removes everything.
const path = require('path');
const { spawnSync } = require('child_process');

const BASE = 'HKCU\\Software\\Classes\\SystemFileAssociations';
const EXTENSIONS = ['.vmf', '.bsp'];
const ENTRY = 'MapScraper';

function reg(args) {
  const r = spawnSync('reg', args, { encoding: 'utf-8', windowsHide: true, timeout: 10000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** Command line Explorer runs: the packaged exe, or node + main.js when running from source. */
function launchCommand() {
  if (process.pkg) return { exe: process.execPath, command: `"${process.execPath}" "%1"` };
  const main = path.join(__dirname, '..', 'main.js');
  return { exe: process.execPath, command: `"${process.execPath}" "${main}" "%1"` };
}

function supported() { return process.platform === 'win32'; }

function install({ label, base = BASE, launch = launchCommand() } = {}) {
  if (!supported()) throw new Error('windows only');
  for (const ext of EXTENSIONS) {
    const key = `${base}\\${ext}\\shell\\${ENTRY}`;
    const steps = [
      ['add', key, '/ve', '/d', label, '/f'],
      ['add', key, '/v', 'Icon', '/d', launch.exe, '/f'],
      ['add', `${key}\\command`, '/ve', '/d', launch.command, '/f'],
    ];
    for (const s of steps) { const r = reg(s); if (!r.ok) throw new Error(r.out || 'reg add failed'); }
  }
}

function uninstall({ base = BASE } = {}) {
  if (!supported()) throw new Error('windows only');
  for (const ext of EXTENSIONS) reg(['delete', `${base}\\${ext}\\shell\\${ENTRY}`, '/f']); // missing key = already removed
}

/** The command currently registered for .vmf files, or null. */
function installedCommand({ base = BASE } = {}) {
  if (!supported()) return null;
  const r = reg(['query', `${base}\\.vmf\\shell\\${ENTRY}\\command`, '/ve']);
  if (!r.ok) return null;
  const m = /REG_SZ\s+(.+?)\s*$/m.exec(r.out);
  return m ? m[1] : null;
}

module.exports = { install, uninstall, installedCommand, launchCommand, supported, BASE };
