# Changelog

Each release is a `## <version>` section below: the release workflow publishes that section as the release notes
(see *Releasing* in the README).

## 2.7.0 - 2026-11-22

### Added
- **Publication details.** The "Prepare the publication" menu entry (and any interactive run that builds a `.gma`) asks for
  title, description, tags and icon, and remembers them per map in `config.json`. New `--description` and `--icon`
  (a 512x512 JPEG, checked at start; its path is used in the printed `gmpublish` command).
- **Workshop duplicates.** The summary and both reports list the installed workshop items that already hold files the addon
  ships (same path, same size) and suggest `--exclude-workshop <id>` with the size it would save. Required items now show
  the size they stand for instead of nothing.
- **Size limit.** A `.gma` above the workshop limit (around 4 GB, Garry's Mod wiki) is flagged, with advice to make it smaller
  (`--optimize-textures`, `--compress-bsp`, `--exclude-workshop`): the wiki asks not to upload multi-part addons.
- **For scripts.** `--strict` (exit code 2 when files are missing or a warning was raised) and `--json <file>` (the full result).
- **Menus.** The Settings menu edits every default. After an analysis the tool offers to extract right away. The map list also
  proposes the newest compiled maps of the game folder, so a map that only exists as a `.bsp` is one choice away.
- The output folder is printed before anything is written. `--no-check-updates` / `checkUpdates` switch the version check off.
- `--watch` prints only what changed between two compiles: files that just became missing and files found again.
- A rewritten README with a logo and screenshots (`assets/`), grouped options and a security and privacy section.
- **A Linux version.** Releases now carry `mapscraper-linux-x64.tar.gz` next to `MapScraper.exe`, each with its SHA-256. On Linux the
  settings live in `~/.config/MapScraper` and the workshop cache in `~/.cache/MapScraper` (`XDG_CONFIG_HOME` / `XDG_CACHE_HOME`
  honoured); the Explorer menu and `--compress-bsp` (a Windows tool) stay Windows-only. An analysis made by the Linux binary gives the
  same result as the Windows one.
- **Automatic releases and versions.** CI: the tests run on Windows and Linux for every push to `main` and every pull request. A push
  that changes the program is released by itself: the version follows the commit messages (`feat:` minor, `type!:` or `BREAKING CHANGE:`
  major, otherwise patch), the changelog section and the release commit are made by the workflow, both binaries are started once as a
  smoke test, and the release is published with the notes. No tag to push. "Run workflow" releases by hand with a chosen bump.
  Rules: *Releasing* in the README.

### Changed
- A second `.vmf` (or `.bsp`) given on the command line, or dropped on the exe, is an error instead of silently replacing the first.

### Fixed
- An unreadable `config.json` is no longer overwritten without a word: it is kept as `config.json.broken-<time>` and the
  tool says so. A config that is valid JSON but not an object (`null`, `[]`) no longer crashes the start.
- Output files and the BSP are written under a temporary name and renamed once complete: an interrupted run can no longer
  leave a truncated file that a later `--incremental` run keeps. A full disk stops every copy worker. The `.gma` is written
  the same way.
- BSP packing and compression and `.gma` writing no longer block the event loop: the status line keeps moving.
- Unknown `--flags` and value options without a value are errors; `--opt=value` is accepted. `--watch` is refused together with `--gma`.
- Material and model names with spaces, accents or `#` are extracted; names Windows forbids are reported instead of dropped.
- The update check runs in the background and its notice comes at the end.
- Answers piped in advance are still served after the input has ended: after a long analysis the next question used to die
  with `ERR_USE_AFTER_CLOSE` (for instance the "extract this map now?" offer in a scripted run).
- `"tags": "fun"` (a string) in a hand-edited `config.json` no longer crashes the start; a JPEG icon made of endless tiny segments
  is refused instead of being read to its end; `--json` creates the folder of its file instead of failing after the run.

### Performance
- File lookup walks one cached listing per folder level instead of listing the target folder in each of 100+ search paths
  (about 99,000 failing `readdir` calls less): 5 to 9 times faster on real maps.
- The texture optimiser and the `.gma` writer open files through a small parallel prefetch: a full extraction went from 20.5 s to 9.1 s.

### Security
- `reg.exe` and `explorer.exe` are started by absolute path (Windows looks in the current folder first, which is the map's
  folder when started from the Explorer).
- Soundscape, effect and instance names no longer reach the console and the reports with terminal escape sequences.
- The asset-path patterns are bounded (80 KB of path characters took 6.6 s). Decompression is capped at 512 MiB. A damaged BSP
  pakfile entry is skipped and reported instead of aborting the analysis.
- The release workflow no longer leaves its token in `.git/config` while `npm ci` runs, and builds the shipped exe without a cache.

## 2.6.0

First version of this changelog: see the git history before 2.7.0.
