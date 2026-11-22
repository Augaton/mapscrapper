#!/usr/bin/env node
'use strict';
// Release planning for the CI (.github/workflows/ci.yml). No dependency: it runs before "npm ci". Rules: "Releasing" in the README.
//   node scripts/release.js plan  [--bump auto|patch|minor|major] [--event push|dispatch]   key=value lines for $GITHUB_OUTPUT
//   node scripts/release.js apply --version X.Y.Z [--changelog]   version in package.json / package-lock.json; with --changelog also stamps CHANGELOG.md
//   node scripts/release.js notes --version X.Y.Z                 release notes (Markdown) on stdout
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;
// A change in one of these is worth a release. Documentation, screenshots, tests, CI files and the scripts of this folder alone are not:
// none of them ends up in the program.
const CODE_PATHS = ['main.js', 'src', 'package.json', 'package-lock.json'];
const BUMPS = ['auto', 'patch', 'minor', 'major'];

// ---------- versions ----------

const parse = (v) => { const m = SEMVER.exec(String(v)); return m ? m.slice(1).map(Number) : null; };
const compare = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
function bump(version, level) {
  const [major, minor, patch] = parse(version);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The part of Conventional Commits that matters: "feat:" is minor, "type!:" or a "BREAKING CHANGE:" line is major, the rest patch. */
function levelOf(commits) {
  let level = 'patch';
  for (const { subject, body = '' } of commits) {
    if (/^\w+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE:/m.test(body)) return 'major';
    if (/^feat(\([^)]*\))?:/i.test(subject)) level = 'minor';
  }
  return level;
}

// ---------- git ----------

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 1 << 26 }).trim();
const listTags = (cwd) => git(cwd, 'tag', '--list', 'v*').split(/\r?\n/).filter((t) => /^v\d+\.\d+\.\d+$/.test(t));

/** Commits after `since` (a tag, or the whole history), merges and release commits left out. */
function commitsSince(cwd, since) {
  const raw = git(cwd, 'log', '--no-merges', '--format=%s%x1f%b%x1e', since ? `${since}..HEAD` : 'HEAD');
  return raw.split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => { const [subject, body = ''] = c.split('\x1f'); return { subject: subject.trim(), body }; })
    .filter((c) => !/^Release v\d/.test(c.subject));
}

/**
 * Decide whether HEAD is to be released and under which version.
 * Version: the one of package.json when there is no release yet, or when it was bumped by hand; otherwise the last release
 * bumped by `bump` (auto: from the commit messages). event "dispatch" (the "Run workflow" button) skips the filters.
 */
function plan({ cwd = process.cwd(), bump: want = 'auto', event = 'push' } = {}) {
  if (!BUMPS.includes(want)) throw new Error(`unknown bump "${want}" (${BUMPS.join(', ')})`);
  const tags = listTags(cwd);
  const last = tags.slice().sort((a, b) => compare(b, a))[0];
  const no = (reason) => ({ release: false, reason });
  const message = git(cwd, 'log', '-1', '--format=%B');
  if (last && git(cwd, 'rev-list', '-n', '1', last) === git(cwd, 'rev-parse', 'HEAD')) return no(`HEAD is already ${last}`);
  if (/^Release v\d/.test(message)) return no('this is a release commit');
  if (event !== 'dispatch') {
    if (/\[skip release\]/i.test(message)) return no('[skip release] in the last commit');
    if (last && !git(cwd, 'diff', '--name-only', last, 'HEAD', '--', ...CODE_PATHS)) return no(`only documentation, tests or CI changed since ${last}`);
  }
  const commits = commitsSince(cwd, last);
  const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')).version;
  let version, how;
  if (!last) { version = pkg; how = `first release, the version of package.json`; }
  else if (compare(pkg, last) > 0 && !tags.includes(`v${pkg}`)) { version = pkg; how = `package.json was bumped by hand (${last} -> v${pkg})`; }
  else {
    const level = want === 'auto' ? levelOf(commits) : want;
    version = bump(last, level);
    how = `${level} bump of ${last}${want === 'auto' ? ', from the commit messages' : ', as requested'}`;
  }
  if (tags.includes(`v${version}`)) throw new Error(`the tag v${version} already exists`);
  return { release: true, version, tag: `v${version}`, previous: last || '', how, commits };
}

// ---------- files ----------

/** Sets the first `count` "version" fields of a JSON file, without reformatting it. */
function setVersion(file, version, count) {
  let n = 0;
  const text = fs.readFileSync(file, 'utf-8').replace(/("version"\s*:\s*")[^"]*(")/g, (m, a, b) => (n++ < count ? `${a}${version}${b}` : m));
  fs.writeFileSync(file, text);
}

/** [{ title, start, end }] for every "## " heading (a "### " is not one). */
function sections(lines) {
  const out = [];
  lines.forEach((l, i) => { const m = /^##\s+(.*?)\s*$/.exec(l); if (m) out.push({ title: m[1], start: i }); });
  out.forEach((s, k) => { s.end = k + 1 < out.length ? out[k + 1].start : lines.length; });
  return out;
}
const isVersion = (title, version) => new RegExp(`^v?${version.replace(/\./g, '\\.')}(?![\\d.])`).test(title);

/** Body of the "## X.Y.Z" section of a changelog, '' when there is none. */
function notesOf(text, version) {
  const lines = text.split(/\r?\n/);
  const s = sections(lines).find((x) => isVersion(x.title, version));
  return s ? lines.slice(s.start + 1, s.end).join('\n').trim() : '';
}

/**
 * Makes sure the changelog has a "## X.Y.Z - date" section: a section for that version stays as it is, "## Unreleased" is renamed
 * (and filled with the commit subjects when empty), otherwise a section made of the commit subjects is added on top.
 */
function stampChangelog(text, version, date, commits) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const found = sections(lines);
  if (found.some((s) => isVersion(s.title, version))) return text;
  const bullets = commits.length ? commits.slice(0, 40).map((c) => `- ${c.subject}`) : ['- Maintenance release.'];
  const heading = `## ${version} - ${date}`;
  const unreleased = found.find((s) => /^unreleased$/i.test(s.title));
  if (unreleased) {
    const body = lines.slice(unreleased.start + 1, unreleased.end);
    lines.splice(unreleased.start, unreleased.end - unreleased.start, ...(body.every((l) => !l.trim()) ? [heading, '', ...bullets, ''] : [heading, ...body]));
  } else lines.splice(found.length ? found[0].start : lines.length, 0, heading, '', ...bullets, '');
  return lines.join(eol);
}

function applyVersion({ cwd = process.cwd(), version, changelog = false, date = new Date().toISOString().slice(0, 10) }) {
  if (!parse(version)) throw new Error(`not a version: ${version}`);
  setVersion(path.join(cwd, 'package.json'), version, 1);
  setVersion(path.join(cwd, 'package-lock.json'), version, 2); // the package itself, and its entry "" in "packages"
  if (changelog) {
    const file = path.join(cwd, 'CHANGELOG.md');
    const last = listTags(cwd).sort((a, b) => compare(b, a))[0];
    fs.writeFileSync(file, stampChangelog(fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '# Changelog\n\n', version, date, commitsSince(cwd, last)));
  }
}

/** Release notes of a version: its changelog section (or the commit subjects), and a link to the comparison with the previous release. */
function releaseNotes({ cwd = process.cwd(), version, repository = process.env.GITHUB_REPOSITORY }) {
  const file = path.join(cwd, 'CHANGELOG.md');
  const last = listTags(cwd).filter((t) => compare(t, version) < 0).sort((a, b) => compare(b, a))[0];
  let notes = fs.existsSync(file) ? notesOf(fs.readFileSync(file, 'utf-8'), version) : '';
  if (!notes) notes = commitsSince(cwd, last).slice(0, 40).map((c) => `- ${c.subject}`).join('\n') || '- Maintenance release.';
  return `${notes}${repository && last ? `\n\n**Full changelog**: https://github.com/${repository}/compare/${last}...v${version}` : ''}\n`;
}

// ---------- command line ----------

function main(argv) {
  const [command, ...rest] = argv;
  const opt = (name, def) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : def; };
  const cwd = process.cwd();
  if (command === 'plan') {
    const p = plan({ cwd, bump: opt('bump', 'auto'), event: opt('event', 'push') });
    console.log(p.release ? [`release=true`, `version=${p.version}`, `tag=${p.tag}`, `previous=${p.previous}`].join('\n') : 'release=false');
    console.error(p.release ? `Release ${p.tag}: ${p.how}.` : `No release: ${p.reason}.`);
  } else if (command === 'apply') {
    applyVersion({ cwd, version: opt('version'), changelog: rest.includes('--changelog') });
  } else if (command === 'notes') {
    process.stdout.write(releaseNotes({ cwd, version: opt('version') }));
  } else {
    console.error('usage: node scripts/release.js plan [--bump auto|patch|minor|major] [--event push|dispatch] | apply --version X.Y.Z [--changelog] | notes --version X.Y.Z');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}

module.exports = { parse, compare, bump, levelOf, plan, sections, notesOf, stampChangelog, setVersion, applyVersion, releaseNotes, commitsSince, CODE_PATHS };
