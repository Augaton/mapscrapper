'use strict';
// Where the program keeps its settings and its cache. The environment and the platform are arguments, so that the Linux
// layout can be tested from Windows.
const os = require('os');
const path = require('path');

/** config.json: %APPDATA%\MapScraper on Windows, $XDG_CONFIG_HOME (default ~/.config)/MapScraper elsewhere. */
function configFile(env = process.env, platform = process.platform, home = os.homedir()) {
  const base = platform === 'win32' ? env.APPDATA || home : env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'MapScraper', 'config.json');
}

/** Workshop index and extracted workshop files: %LOCALAPPDATA%\MapScraper on Windows, $XDG_CACHE_HOME (default ~/.cache)/MapScraper elsewhere. */
function cacheDir(env = process.env, platform = process.platform, home = os.homedir(), tmp = os.tmpdir()) {
  const base = platform === 'win32' ? env.LOCALAPPDATA || env.APPDATA || tmp : env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(base, 'MapScraper');
}

module.exports = { configFile, cacheDir };
