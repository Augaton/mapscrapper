'use strict';
// Finds the Garry's Mod "garrysmod" folder through Steam (registry + libraryfolders.vdf), so the user is not asked for it.
const fs = require('fs');
const path = require('path');
const kv = require('./kv');
const { reg } = require('./winshell');

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function regValue(key, name) {
  if (process.platform !== 'win32') return null;
  try {
    const r = reg(['query', key, '/v', name]);
    if (!r.ok) return null;
    const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'im').exec(r.out);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Steam installation folders worth looking at. */
function steamRoots() {
  const roots = [
    regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
    regValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Steam'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Steam'),
    process.env.HOME && path.join(process.env.HOME, '.steam', 'steam'),
    process.env.HOME && path.join(process.env.HOME, '.local', 'share', 'Steam'),
  ].filter(Boolean).map((p) => path.resolve(p));
  return [...new Set(roots)].filter(isDir);
}

/** Library folders listed in steamapps/libraryfolders.vdf (old and new layouts). */
function parseLibraryFolders(text) {
  const out = [];
  let nodes;
  try { nodes = kv.parse(text); } catch { return out; }
  for (const n of kv.walk(nodes)) {
    if (n.children || !n.value) continue;
    if (n.key === 'path' || /^\d+$/.test(n.key)) out.push(n.value.replace(/\\\\/g, '\\'));
  }
  return out;
}

/** @returns {string|null} absolute path of .../GarrysMod/garrysmod */
function detectGamePath(roots = steamRoots()) {
  const libs = [];
  for (const root of roots) {
    libs.push(root);
    try { libs.push(...parseLibraryFolders(fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf-8'))); } catch { /* no library file */ }
  }
  for (const lib of [...new Set(libs.map((l) => path.resolve(l)))]) {
    const game = path.join(lib, 'steamapps', 'common', 'GarrysMod', 'garrysmod');
    if (isDir(path.join(game, 'materials'))) return game;
  }
  return null;
}

module.exports = { detectGamePath, parseLibraryFolders, steamRoots };
