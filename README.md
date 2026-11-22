# Map Scraper

MapScraper extracts **every asset a Source Engine / Garry's Mod map depends on** — from its `.vmf`, its compiled
`.bsp`, or both — into a folder (and optionally a `.gma`) that is ready to be published on the workshop.

## Installation

[![Latest Release](https://img.shields.io/github/downloads/SpySpaille/MapScraper/total)](https://github.com/SpySpaille/MapScraper/releases/latest)

- Download the latest release **[here](https://github.com/SpySpaille/MapScraper/releases/latest)**
- Place the executable in a **dedicated** folder and run it (or **drag & drop a `.vmf` / `.bsp` onto it**)

From source (Node 18+): `npm install`, then `npm start`.

## Usage

**Double-click** the exe (or drop a `.vmf` / `.bsp` on it) and pick what you want from the menu. The interface is in
English or French depending on Windows (`--lang en|fr`), and the game folder is found through Steam.

```console
📜 What do you want to do?
   1) Analyse a map  (report only, nothing is copied)
   2) Extract a map  (with your default options)
   3) Prepare the publication  (extraction + optimised textures + compressed BSP + .gma)
   4) Update an existing extraction  (only copies what changed)
   5) Watch a map  (re-extracts automatically after each compile)
   6) Choose everything myself  (one question per option)
   7) Optimise the textures of a folder
   8) Settings
🗺️  Which map?
   1) rp_mymap_v3.vmf  (mapping, 2 h ago)
   2) rp_mymap_v2.vmf  (mapping, 5 d ago)
   …
📦 7300 files to write, 2.29 GB (0 already up to date) · free space: 34.42 GB
- ██████████░░░░░░░░░░░░  45%  1.03 GB / 2.29 GB  310 MB/s  ETA 00:04  materials/…
```

The map list holds the maps you used last, then the most recent VMFs of the same folders. Before anything is
written the tool tells you how much it is going to copy and **where** (and asks above 1 GB), and checks the free disk
space. After an analysis it offers to extract the map right away.

The publication questions (title, description, tags, a 512x512 `.jpg` icon) are remembered per map in `config.json`:
the next publication of the same map is Enter four times. `-` empties the description or the icon.

Scripts and power users: give any option and no question is asked. Values can be written `--out dir` or `--out=dir`; an
unknown option is an error, so a typo never runs a different job than the one asked for.

```console
mapscraper "C:\maps\gm_mymap.vmf" --optimize-textures --compress-bsp --gma
mapscraper --bsp "C:\...\garrysmod\maps\gm_mymap.bsp" --dry-run
mapscraper "C:\maps\gm_mymap.vmf" --watch          (re-extracts after every compile, Ctrl+C to stop)
```

Output goes to `./<mapname>/`, relative to the **current folder** of the program (the exact path is printed before
anything is written; `--out` chooses another one). The output folder must be dedicated to MapScraper: it is
cleared on every run (the tool refuses to clear a folder that contains anything it did not create), so keep the
workshop icon and other files of yours outside of it.

### Reports

Every run writes `<mapname>_report.txt` and `<mapname>_report.html` (opened automatically at the end of an
interactive run; `--no-open` / Settings to turn that off). The visual report has the sizes per category, the largest
files, the workshop items involved with links, what changed since the previous run, and above all the
**missing files with who uses them**:

```console
materials/models/ares/book_a_07.vmt
    used by models/ares/book_a_open.mdl  ←  prop_static #27125 at (5614 -2674 -5017.32)
materials/hina/climbing_wall_base_ao_2k.vtf
    used by materials/hina/bs_hp_concretewall00_tb2.vmt  ←  brush #2095091 (func_detail #2113427)
```

The chain goes up to the Hammer entity (id, targetname, position: click the position in the HTML report to copy it,
then *View > Go to Coordinates* in Hammer) or to the brush id, so a broken reference can be fixed instead of guessed.

| Option | |
|---|---|
| `--game <dir>` | `garrysmod` folder (auto-detected through Steam, then remembered) |
| `--vmf <file>` / `--bsp <file>` | map source / compiled map. With a VMF, `maps/<name>.bsp` is picked up automatically |
| `--out <dir>` | output folder (default `./<mapname>`) |
| `--all` \| `--materials --models --sounds --publish` | what to extract (default: everything) |
| `--dry-run` | analyse and write the reports only (2 s), copy nothing |
| `--incremental` | keep the output folder: copy only new / changed files, delete the ones the map no longer needs |
| `--watch` | stay open and re-extract incrementally every time the VMF / BSP changes (never builds a `.gma`: refused together with `--gma`) |
| `--all-skins` | copy the materials of every model skin (default: only the skins the map uses) |
| `--no-workshop` | do not index the installed workshop addons |
| `--from-workshop` | extract files that only exist inside installed workshop addons (`.gma`, including LZMA-compressed ones) |
| `--exclude-workshop <ids\|all>` | do not copy files these workshop items already provide — they become *required items* |
| `--optimize-textures`, `--max-texture <px>` | re-encode big textures (see below) |
| `--keep-normals` | never DXT-compress normal / bump maps, only cap their size |
| `--threads <n>` | worker threads of the texture optimiser (default: CPU count − 1, max 8) |
| `--compress-bsp` | LZMA-compress the BSP (typically −75 %). Needs `bspzipplusplus.exe` in `GarrysMod/bin[/win64]`; load the map once in game before publishing |
| `--gma`, `--split-mb <n>`, `--title`, `--tags a,b` | build `<output>.gma` (or `_part1.gma`, `_part2.gma`… of at most *n* MB) |
| `--description <text>`, `--icon <file>` | description written in `addon.json` and the `.gma`; icon (a 512x512 JPEG, checked at start) used in the `gmpublish` command printed at the end |
| `--strict` | exit code **2** when files are missing or a warning was raised (0 = fine, 1 = the run failed) |
| `--json <file>` | write the full result of the run (stats, missing files and who uses them, workshop items, warnings…) as JSON |
| `--lang en\|fr`, `--no-open`, `--yes` | language · do not open the visual report · do not ask before big copies |
| `--no-check-updates` | do not look for a new version at start (see below) |
| `--install-context-menu` / `--uninstall-context-menu` | "Extract with MapScraper" on right-click on `.vmf` / `.bsp` files (per-user registry keys, also in Settings) |
| `--save-defaults` | remember the current options as defaults |
| `--optimize <folder>` | only run the texture optimiser on an existing folder |
| `--no-wait` | do not wait for Enter at the end |

Every on/off option has a `--no-<option>` form. Defaults live in `%APPDATA%\MapScraper\config.json` (the Settings
menu edits every one of them):

```json
{
  "gamepath": "D:\\Steam\\steamapps\\common\\GarrysMod\\garrysmod",
  "lang": "fr",
  "defaults": { "optimizeTextures": true, "maxTexture": 2048, "keepNormals": true, "compressBsp": true,
                "incremental": true, "excludeWorkshop": ["3556917354"], "gma": false, "tags": ["roleplay"], "openReport": true,
                "checkUpdates": true }
}
```

### Environment, network, exit codes

| | |
|---|---|
| `MAPSCRAPER_CONFIG` | path of the config file (default `%APPDATA%\MapScraper\config.json`) |
| `MAPSCRAPER_LANG` | language when neither `--lang` nor the config sets one (`en` / `fr`) |
| `MAPSCRAPER_OFFLINE=1` | never touch the network |
| `DEBUG=1` | print the full stack trace of an error |

The only network access is the update check: at start, one `GET` of `package.json` on `raw.githubusercontent.com`
(3 s timeout, in the background); only the version number in the answer is read and compared, and the request
carries no map name nor identifier (GitHub sees your IP address, as for any download). Turn it off with `--no-check-updates`, the Settings menu (`checkUpdates`) or `MAPSCRAPER_OFFLINE=1`.

Exit codes: **0** done, **1** error (bad argument, unreadable map, full disk…), **2** `--strict` and files were missing or a warning was raised.
In `--watch`, each cycle prints only what *changed*: the files that just became missing (with who uses them) and the ones found again.

## What is detected

| Source | Extracted |
|---|---|
| Brushes, displacements, overlays, decals | materials (`.vmt`) and every texture they reference (`$basetexture`, `$bumpmap`, `$envmapmask`, `$detail`, HDR variants, `include`d patches, `$bottommaterial`…) |
| `skyname` | the 6 skybox faces (+ `_hdr` variants) |
| `prop_*`, `npc_*`, any key ending in `.mdl` | `.mdl .vvd .phy .ani .dx90.vtx`, the materials of the **skins actually used**, `$includemodel` animation models. Models without `.vvd` / `.vtx` are reported |
| `env_sprite`, `env_beam`, ropes, `env_smokestack`, `env_screenoverlay`, `env_projectedtexture`… | sprites (`.spr` / `.vmt`) and textures |
| `ambient_generic`, doors, buttons, trains… | sound files, plus **soundscripts** resolved through `maps/<map>_level_sounds.txt` and `scripts/game_sounds*.txt` |
| `env_soundscape*` | soundscapes (including nested `playsoundscape`) from `scripts/soundscapes_*.txt`, and their waves |
| `info_particle_system` | the `.pcf` defining each effect, then — the file is really parsed — only the materials and models of the particle systems the map uses and of their children; `maps/<map>_particles.txt` is generated when missing |
| `func_instance` | instance VMFs are merged recursively |
| I/O outputs, `lua_run` | asset paths passed as parameters (`SetModel`, `PlaySound`…) or written in Lua code |
| misc | `.nav`, `.ain`, `.lmp`, thumbnails, `.vcd` scenes, colour-correction `.raw`, vehicle scripts, `detail.vbsp`, `<map>_level_sounds.txt`, `soundscapes_<map>.txt` |
| **Compiled BSP** | entity lump, material table (texdata), static prop lump (with skins) and the embedded pakfile are read too — LZMA-compressed BSPs included. What the BSP already embeds (cubemaps, patched materials, packed content) is **not copied again**; the materials those embedded VMTs point to are |

Content is searched in the game folder, every legacy `addons/<name>/` folder, the paths from `cfg/mount.cfg` and
`download/`. References that cannot be found are sorted into:

- **stock** — present in the game's `*_dir.vpk` (skipped);
- **workshop** — provided by an installed workshop item: listed with its id / title / link as a *required item*
  (or extracted with `--from-workshop`);
- **not found** — broken references, or content you do not have.

### Skins

A model with 10 skins drags 10 sets of materials along. MapScraper reads the skin families of each `.mdl` and the
`skin` of every `prop_static` / entity (VMF and BSP static prop lump) and only copies the materials of the skins in
use. Entities targeted by a `Skin` input keep all their skins; use `--all-skins` if Lua changes skins at run time.

### Workshop-aware

Installed workshop addons (`steamapps/workshop/content/4000`, raw `.gma` and LZMA `_legacy.bin`, plus
`addons/*.gma`) are indexed once and cached (~2 s, then ~80 ms). That is what powers the *required items* list,
`--from-workshop`, and `--exclude-workshop`: if your map already depends on a content pack you published,
`--exclude-workshop <its id>` leaves out everything that pack provides and only ships the delta.

## Publishing

- Files a workshop `.gma` is not allowed to contain (soundscapes, particle manifests, `_level_sounds.txt`, `.raw`…)
  are **embedded in the BSP** by a built-in pakfile writer — no `bspzip` needed (Garry's Mod's own `bspzip` currently
  bloats BSPs by tens of MB).
- `addon.json` is written in the output folder; `--gma` builds the archive(s) natively (whitelist enforced, map
  first, optional splitting). Publish with `gmpublish.exe create -icon icon.jpg -addon <file.gma>`: the command is
  printed at the end, with the path of your `--icon` when you gave one.
- All output paths are lowercased so the addon works on Linux servers.

## Shrinking the addon

Textures are almost always what makes a map addon huge. `--optimize-textures` re-encodes, in the output folder
only, every texture ≥ 1 MB that is stored **uncompressed** or is **larger than `--max-texture`** (default 2048 px):

- **lossless first**: a DXT5 texture whose alpha channel is 255 everywhere becomes DXT1 with exactly the same pixels (half the
  size, typically 10 % of a map's textures);
- opaque → **DXT1** (8× smaller than RGBA8888), with alpha → **DXT5** (4×); oversized ones are downscaled and get a
  fresh mip chain; work is spread over worker threads;
- `--keep-normals`: normal maps (VTF flag, `$bumpmap` references, `_n` / `_normal` names) stay uncompressed — only
  the size cap applies to them;
- animated textures, cubemaps, float / HDR and exotic formats are left untouched and listed in the report.

The codec is built in (no VTFEdit needed) and writes VTF 7.2. It is lossy (typically 40 dB PSNR — invisible in
game), so it is **off by default**. Together with `--compress-bsp` and `--exclude-workshop`, a 3.3 GB extraction of a
large RP map shrinks to ~1.6 GB.

## Development

```console
npm test         # three self-contained suites (synthetic game folder, BSP / GMA / LZMA / VTF / MDL fixtures, CLI end to end)
npm run build    # pinned @yao-pkg/pkg → dist/MapScraper.exe + MapScraper.exe.sha256 (verify: certutil -hashfile MapScraper.exe SHA256)
npm run vector   # regenerate the LZMA test vector (needs the xz command)
```

Source layout: `main.js` (CLI) · `src/scraper.js` (engine: `plan()` then `execute()`) · `src/ui.js` (menus, progress bar) ·
`src/report.js` (text + HTML reports) · `src/i18n.js` (English / French) · `src/steam.js` · `src/watch.js` · `src/winshell.js` · `src/bsp.js` (BSP reader + pakfile writer) ·
`src/gma.js` (GMA reader + workshop index) · `src/lzma.js` (LZMA decoder) · `src/publish.js` (whitelist, `.gma`
writer) · `src/vtf.js` + `src/optimize.js` (texture codec / optimiser) · `src/mdl.js` · `src/vpk.js` · `src/kv.js`.

## Author

- [@SpySpaille](https://github.com/SpySpaille)
