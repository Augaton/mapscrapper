'use strict';
// Tests of the release logic (scripts/release.js): which version comes next, when nothing is released, how the changelog and the
// version files are rewritten. Real git repositories in a temporary folder, no network.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const R = require('../scripts/release');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); } catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscraper-release-'));
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
let counter = 0;
const write = (dir, rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const commit = (dir, subject, files = {}, body) => {
  for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', subject, ...(body ? ['-m', body] : []));
};
const CHANGELOG = '# Changelog\n\nIntro.\n\n## 2.7.0 - 2026-11-22\n\n### Added\n- first\n\n## 2.6.0\n\nOld.\n';
/** A repository with a version in package.json, and a first commit. */
function repo(version = '2.7.0') {
  const dir = path.join(root, `r${++counter}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  commit(dir, 'Initial', { 'package.json': `{\n  "name": "x",\n  "version": "${version}"\n}\n`, 'main.js': '1', 'src/a.js': '1', 'README.md': 'r', 'CHANGELOG.md': CHANGELOG });
  return dir;
}
const released = (dir, tag = 'v2.7.0') => git(dir, 'tag', tag);

console.log('versions');
test('versions compare numerically and bump by level', () => {
  assert.deepStrictEqual(R.parse('v2.10.3'), [2, 10, 3]);
  assert.strictEqual(R.parse('2.7'), null);
  assert.ok(R.compare('v2.10.0', 'v2.9.9') > 0 && R.compare('2.7.0', 'v2.7.0') === 0);
  assert.deepStrictEqual(['patch', 'minor', 'major'].map((l) => R.bump('2.7.3', l)), ['2.7.4', '2.8.0', '3.0.0']);
});
test('the level comes from the commit messages: feat is minor, ! or BREAKING CHANGE is major, the rest patch', () => {
  const c = (subject, body = '') => ({ subject, body });
  assert.strictEqual(R.levelOf([c('Fix the thing'), c('Update README')]), 'patch');
  assert.strictEqual(R.levelOf([c('fix: x'), c('feat: y')]), 'minor');
  assert.strictEqual(R.levelOf([c('feat(ui): y')]), 'minor');
  assert.strictEqual(R.levelOf([c('feat: y'), c('refactor!: z')]), 'major');
  assert.strictEqual(R.levelOf([c('fix: x', 'Details.\n\nBREAKING CHANGE: the option is gone')]), 'major');
  assert.strictEqual(R.levelOf([c('Feature flags are documented')]), 'patch', 'only the "feat:" prefix counts');
});

console.log('plan');
test('without any release yet, the version of package.json is the first one', () => {
  const p = R.plan({ cwd: repo('2.7.0') });
  assert.deepStrictEqual([p.release, p.version, p.tag, p.previous], [true, '2.7.0', 'v2.7.0', '']);
});
test('nothing is released twice, nor for a release commit nor for [skip release]', () => {
  const d = repo();
  released(d);
  assert.match(R.plan({ cwd: d }).reason, /already v2\.7\.0/);
  commit(d, 'Fix a bug [skip release]', { 'src/a.js': '2' });
  assert.match(R.plan({ cwd: d }).reason, /skip release/);
  assert.strictEqual(R.plan({ cwd: d, event: 'dispatch' }).version, '2.7.1', 'the button ignores the marker');
  commit(d, 'Release v2.7.1 [skip ci]', { 'src/a.js': '3' });
  assert.match(R.plan({ cwd: d }).reason, /release commit/);
});
test('documentation, tests and CI alone do not release; code does; a pending code change survives a later docs push', () => {
  const d = repo();
  released(d);
  commit(d, 'Update the README', { 'README.md': 'r2', 'test/t.js': 't', '.github/workflows/ci.yml': 'x', 'scripts/other.js': 'y', 'assets/a.png': 'p' });
  assert.match(R.plan({ cwd: d }).reason, /documentation, tests or CI/);
  assert.deepStrictEqual([R.plan({ cwd: d, event: 'dispatch' }).release, R.plan({ cwd: d, event: 'dispatch' }).version], [true, '2.7.1']);
  commit(d, 'Speed up the lookup', { 'src/a.js': '2' });
  commit(d, 'Polish the README', { 'README.md': 'r3' });
  const p = R.plan({ cwd: d });
  assert.deepStrictEqual([p.release, p.version], [true, '2.7.1'], 'the code change of two commits ago is released');
});
test('the next version follows the commits: patch by default, feat: minor, breaking: major, or what was asked', () => {
  const d = repo();
  released(d);
  commit(d, 'Fix a bug', { 'src/a.js': '2' });
  assert.strictEqual(R.plan({ cwd: d }).version, '2.7.1');
  commit(d, 'feat: a new option', { 'src/a.js': '3' });
  assert.strictEqual(R.plan({ cwd: d }).version, '2.8.0');
  commit(d, 'feat(cli)!: drop an option', { 'main.js': '2' });
  assert.strictEqual(R.plan({ cwd: d }).version, '3.0.0');
  assert.strictEqual(R.plan({ cwd: d, bump: 'patch', event: 'dispatch' }).version, '2.7.1');
  assert.strictEqual(R.plan({ cwd: d, bump: 'minor', event: 'dispatch' }).version, '2.8.0');
  assert.throws(() => R.plan({ cwd: d, bump: 'huge' }), /unknown bump/);
});
test('the highest tag wins, not the latest one; a version bumped by hand is used as it is', () => {
  const d = repo();
  released(d, 'v2.9.0');
  released(d, 'v2.10.0');
  released(d, 'v2.8.5');
  commit(d, 'Fix', { 'src/a.js': '2' });
  assert.deepStrictEqual([R.plan({ cwd: d }).previous, R.plan({ cwd: d }).version], ['v2.10.0', '2.10.1']);
  commit(d, 'Big change', { 'package.json': '{\n  "name": "x",\n  "version": "3.1.0"\n}\n' });
  const p = R.plan({ cwd: d });
  assert.deepStrictEqual([p.version, /by hand/.test(p.how)], ['3.1.0', true]);
  git(d, 'tag', 'v3.1.0');
  commit(d, 'Fix again', { 'src/a.js': '3' });
  assert.strictEqual(R.plan({ cwd: d }).version, '3.1.1', 'package.json equal to a released version: bump');
});
test('the command prints key=value lines for $GITHUB_OUTPUT', () => {
  const d = repo();
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release.js'), 'plan', '--bump', 'auto', '--event', 'push'], { cwd: d, encoding: 'utf-8' });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(run.stdout.trim(), 'release=true\nversion=2.7.0\ntag=v2.7.0\nprevious=');
  assert.match(run.stderr, /Release v2\.7\.0: first release/);
  released(d);
  assert.strictEqual(spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'release.js'), 'plan'], { cwd: d, encoding: 'utf-8' }).stdout.trim(), 'release=false');
});

console.log('files');
test('the changelog gets a section for the version: kept, renamed from Unreleased, or generated from the commits', () => {
  const commits = [{ subject: 'Fix a' }, { subject: 'feat: b' }];
  assert.strictEqual(R.stampChangelog(CHANGELOG, '2.7.0', '2030-01-01', commits), CHANGELOG, 'an existing section is left alone');
  const open = '# Changelog\n\n## Unreleased\n\n### Fixed\n- written by hand\n\n## 2.7.0 - 2026-11-22\n\nOld.\n';
  assert.strictEqual(R.stampChangelog(open, '2.7.1', '2030-01-01', commits), '# Changelog\n\n## 2.7.1 - 2030-01-01\n\n### Fixed\n- written by hand\n\n## 2.7.0 - 2026-11-22\n\nOld.\n');
  const empty = '# Changelog\n\n## Unreleased\n\n## 2.7.0 - 2026-11-22\n\nOld.\n';
  assert.strictEqual(R.stampChangelog(empty, '2.7.1', '2030-01-01', commits), '# Changelog\n\n## 2.7.1 - 2030-01-01\n\n- Fix a\n- feat: b\n\n## 2.7.0 - 2026-11-22\n\nOld.\n');
  assert.strictEqual(R.stampChangelog(CHANGELOG, '2.7.1', '2030-01-01', commits), '# Changelog\n\nIntro.\n\n## 2.7.1 - 2030-01-01\n\n- Fix a\n- feat: b\n\n## 2.7.0 - 2026-11-22\n\n### Added\n- first\n\n## 2.6.0\n\nOld.\n');
  assert.ok(R.stampChangelog('# Changelog\r\n\r\n## 2.7.0\r\n\r\nx\r\n', '2.7.1', 'd', commits).split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r')), 'CRLF kept');
  assert.ok(R.stampChangelog('# Changelog\n', '1.0.0', 'd', []).includes('- Maintenance release.'));
});
test('the notes are the section of the version, "###" parts included; 2.7.0 is not 2.7.01', () => {
  assert.strictEqual(R.notesOf(CHANGELOG, '2.7.0'), '### Added\n- first');
  assert.strictEqual(R.notesOf(CHANGELOG, '2.6.0'), 'Old.');
  assert.strictEqual(R.notesOf(CHANGELOG, '2.7.01'), '');
  assert.strictEqual(R.notesOf(CHANGELOG, '9.9.9'), '');
});
test('releaseNotes: the section, or the commits when there is none, and a link to the comparison', () => {
  const d = repo();
  assert.strictEqual(R.releaseNotes({ cwd: d, version: '2.7.0', repository: 'o/r' }), '### Added\n- first\n');
  released(d);
  commit(d, 'Fix a bug', { 'src/a.js': '2' });
  assert.strictEqual(R.releaseNotes({ cwd: d, version: '2.7.1', repository: 'o/r' }), '- Fix a bug\n\n**Full changelog**: https://github.com/o/r/compare/v2.7.0...v2.7.1\n');
  assert.strictEqual(R.releaseNotes({ cwd: d, version: '2.7.1', repository: '' }), '- Fix a bug\n');
});
test('apply sets the version in package.json and in the lockfile (the package and its "" entry) and nothing else', () => {
  const d = path.join(root, 'apply');
  fs.mkdirSync(d);
  const here = path.join(__dirname, '..');
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(here, f), path.join(d, f));
  const before = { pkg: fs.readFileSync(path.join(d, 'package.json'), 'utf-8'), lock: JSON.parse(fs.readFileSync(path.join(d, 'package-lock.json'), 'utf-8')) };
  R.applyVersion({ cwd: d, version: '9.8.7' });
  const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf-8')), lock = JSON.parse(fs.readFileSync(path.join(d, 'package-lock.json'), 'utf-8'));
  assert.deepStrictEqual([pkg.version, lock.version, lock.packages[''].version], ['9.8.7', '9.8.7', '9.8.7']);
  assert.strictEqual(lock.packages['node_modules/figlet'].version, before.lock.packages['node_modules/figlet'].version, 'dependencies untouched');
  const changed = fs.readFileSync(path.join(d, 'package.json'), 'utf-8').split('\n').filter((l, i) => l !== before.pkg.split('\n')[i]);
  assert.strictEqual(changed.length, 1, 'package.json keeps its layout');
  assert.throws(() => R.applyVersion({ cwd: d, version: 'latest' }), /not a version/);
});
test('apply --changelog stamps the changelog from the commits since the last release', () => {
  const d = repo();
  write(d, 'package-lock.json', '{\n  "name": "x",\n  "version": "2.7.0",\n  "packages": {\n    "": {\n      "name": "x",\n      "version": "2.7.0"\n    }\n  }\n}\n');
  released(d);
  commit(d, 'Fix a bug', { 'src/a.js': '2' });
  R.applyVersion({ cwd: d, version: '2.7.1', changelog: true, date: '2030-02-03' });
  assert.ok(fs.readFileSync(path.join(d, 'CHANGELOG.md'), 'utf-8').includes('## 2.7.1 - 2030-02-03\n\n- Fix a bug\n\n## 2.7.0'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf-8')).version, '2.7.1');
});
test('this repository: package.json is a version, and the changelog has a section for it', () => {
  const here = path.join(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf-8')).version;
  assert.ok(R.parse(version), version);
  assert.ok(R.notesOf(fs.readFileSync(path.join(here, 'CHANGELOG.md'), 'utf-8'), version), `CHANGELOG.md has no "## ${version}" section`);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} tests passed${process.exitCode ? ', some FAILED' : ''}`);
