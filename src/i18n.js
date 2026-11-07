'use strict';
// User-facing messages in English and French. `makeT(lang)` returns t(key, vars) with {placeholder} substitution.

const en = {
  // ----- engine: phases
  'phase.indexing': 'Indexing search paths, stock VPKs and workshop addons',
  'phase.vmf': 'Reading VMF',
  'phase.bsp': 'Reading BSP',
  'phase.particles': 'Resolving particles',
  'phase.sounds': 'Resolving soundscripts & soundscapes',
  'phase.assets': 'Resolving models & materials',
  'phase.soundFiles': 'Resolving sounds',
  'phase.others': 'Resolving other files',
  'phase.prepare': 'Preparing the output folder',
  'phase.copy': 'Copying files',
  'phase.pack': 'Packing the BSP',
  'phase.compress': 'Compressing the BSP',
  'phase.cleanup': 'Cleaning up',
  // ----- engine: errors, warnings, notes
  'error.needMap': 'A .vmf or a .bsp is required',
  'error.vmfNotFound': 'VMF not found: {file}',
  'error.bspNotFound': 'BSP not found: {file}',
  'error.invalidGame': 'Invalid game path (no materials/ folder): {dir}',
  'error.refuseClear': 'Refusing to clear "{dir}": it contains files MapScraper did not create ({files}). Choose an empty or dedicated output folder.',
  'error.diskSpace': 'Not enough free disk space for "{dir}": {need} needed, {free} available.',
  'warn.workshopIndex': 'Workshop index failed: {error}',
  'warn.noWorkshop': 'No installed workshop addon was found: workshop options are ignored.',
  'warn.instanceNotFound': 'Instance VMF not found: {file}',
  'warn.cannotRead': 'Cannot read {file}: {error}',
  'warn.vmtParse': 'Could not parse {file}',
  'warn.mdlOld': 'Unsupported/old MDL format, materials not resolved: {file}',
  'warn.noBsp': 'Compiled map not found ({file}); nothing to pack.',
  'warn.packNoTool': 'Could not embed files in the BSP ({error}) and no bspzip was found: BSP copied as is.',
  'warn.packFailed': 'Could not embed files in the BSP ({error}; {tool} exit {status}: {output}): BSP copied as is.',
  'warn.notEmbedded': '{count} files cannot be shipped in a workshop .gma and could not be embedded in the BSP: {files}',
  'warn.compressNoTool': 'BSP compression skipped: no bspzip found.',
  'warn.compressNothing': "BSP compression did nothing ({detail}). Garry's Mod's own bspzip ignores -repack: install bspzipplusplus.exe (ficool2) in GarrysMod/bin/win64.",
  'warn.copyFailed': 'Could not copy {file}: {error}',
  'warn.unsafePaths': '{count} referenced paths are invalid file names or try to leave the game folder, and were ignored: {files}',
  'note.bspOnly': 'The compiled BSP references content that is not in the VMF ({materials} materials, {models} models, {sounds} sounds): it was added to the output because the BSP is what gets published.',
  'note.bspOlder': 'The compiled BSP is older than the VMF: recompile before publishing if the map changed.',
  'note.soundscriptFile': 'Soundscript "{name}" comes from {file}: that file must be loaded by the game (game_sounds_manifest.txt or maps/{map}_level_sounds.txt).',
  'note.soundscapeFile': 'Soundscape "{name}" is defined in {file} (not {mapFile}): make sure the game loads it (soundscapes_manifest.txt).',
  'note.particleNotListed': 'Particle "{effect}" is defined in {pcf}, which is not listed in {manifest}: add it there (or precache it with game.AddParticles in Lua).',
  'note.manifestGenerated': '{manifest} did not exist: generated one listing {pcfs} so these particles get precached.',
  'note.bspCompressed': "The BSP was LZMA-compressed: load the map once in game before publishing to make sure your Garry's Mod branch accepts it.",
  // ----- references
  'ref.brush': 'brush #{id}',
  'ref.bspTexdata': 'BSP material table (brush faces)',
  'ref.bspStaticProps': 'BSP static props',
  'ref.bspPak': 'file embedded in the BSP',
  'ref.mapFiles': 'map companion file',
  'ref.at': 'at',
  // ----- cli: general
  'cli.madeBy': 'Made by',
  'cli.version': 'Version:',
  'cli.outdated': 'A new version of MapScraper is available',
  'cli.latest': 'latest: {version}',
  'cli.thanks': 'Thanks for using MapScraper 👍',
  'cli.pressEnter': 'Press enter to close the program',
  'cli.error': 'An error occurred:',
  'cli.unknownArg': 'Unknown argument: {args} (expected a .vmf / .bsp file or --options, see --help)',
  'cli.missingValue': 'Missing value after {opts} (e.g. --out "C:\\addons\\mymap" or --out="C:\\addons\\mymap")',
  'cli.watchGma': '--watch re-extracts after every compile and does not build a .gma: run once with --gma when you are done',
  'cli.inputClosed': 'Input closed (stdin ended before all questions were answered)',
  'cli.invalidYN': 'Invalid input (y/n)',
  'cli.invalidChoice': 'Invalid choice',
  'cli.yes': 'yes',
  'cli.no': 'no',
  'cli.none': '(none)',
  'cli.folderNotFound': 'Folder not found: {dir}',
  'cli.invalidMap': 'Invalid map file: {file}',
  'cli.missingGame': 'Missing or invalid --game path',
  // ----- cli: game path / map
  'game.detected': 'Garry\'s Mod found:',
  'game.using': 'Game folder:',
  'game.ask': '📂 Game Path (C:\\Steam\\steamapps\\common\\GarrysMod\\garrysmod)',
  'game.invalid': 'Invalid path (no materials/ folder inside)',
  'map.ask': '📄 VMF or BSP file (you can drag & drop it here)',
  'map.invalid': 'Invalid file (must be an existing .vmf or .bsp)',
  'map.choose': '🗺️  Which map?',
  'map.other': 'Another file…',
  'map.ago.minutes': '{n} min ago',
  'map.ago.hours': '{n} h ago',
  'map.ago.days': '{n} d ago',
  // ----- cli: menus
  'menu.title': '📜 What do you want to do?',
  'menu.titleFor': '📜 What do you want to do with {map}?',
  'menu.analyse': 'Analyse a map',
  'menu.analyse.hint': 'report only, nothing is copied',
  'menu.extract': 'Extract a map',
  'menu.extract.hint': 'with your default options',
  'menu.publish': 'Prepare the publication',
  'menu.publish.hint': 'extraction + optimised textures + compressed BSP + .gma',
  'menu.update': 'Update an existing extraction',
  'menu.update.hint': 'only copies what changed',
  'menu.watch': 'Watch a map',
  'menu.watch.hint': 're-extracts automatically after each compile',
  'menu.optimize': 'Optimise the textures of a folder',
  'menu.settings': 'Settings',
  'menu.quit': 'Quit',
  'menu.custom': 'Choose everything myself',
  'menu.custom.hint': 'one question per option',
  'ask.everything': '🚀 Extract everything (materials, models, sounds, particles, misc.)',
  'ask.materials': '🧱 Extract Materials',
  'ask.models': '📐 Extract Models',
  'ask.sounds': '🔊 Extract Sounds',
  'ask.others': '📤 Ready to Publish (particles, soundscapes, nav, bsp packing…)',
  'ask.optimize': '🗜️  Optimize textures? (DXT compression + max {px} px, lossy but usually invisible, big size savings)',
  'ask.compressBsp': '🗜️  Compress the BSP? (needs bspzipplusplus, test the map in game once)',
  'ask.gma': '📦 Build the workshop .gma? (ready for gmpublish)',
  'ask.incremental': '♻️  Keep the existing output and only copy what changed?',
  'ask.optimizeFolder': '📁 Folder to optimise',
  'ask.continue': 'Continue?',
  // ----- cli: settings
  'settings.title': '⚙️  Settings (Enter to go back)',
  'settings.lang': 'Language',
  'settings.optimize': 'Optimise textures by default',
  'settings.keepNormals': 'Keep normal maps uncompressed',
  'settings.maxTexture': 'Maximum texture size (px)',
  'settings.compressBsp': 'Compress the BSP by default',
  'settings.exclude': 'Workshop items to exclude (ids)',
  'settings.openReport': 'Open the report at the end',
  'settings.contextMenu': 'Explorer right-click "Extract with MapScraper"',
  'settings.game': 'Game folder',
  'settings.installed': 'installed',
  'settings.notInstalled': 'not installed',
  'settings.askMaxTexture': 'Maximum texture size in pixels (0 = no limit)',
  'settings.askExclude': 'Workshop ids separated by commas (empty = none, "all" = every installed item)',
  'settings.saved': 'Saved.',
  'shell.label': 'Extract with MapScraper',
  'shell.installed': '✅ Right-click entry installed for .vmf and .bsp files.',
  'shell.removed': '✅ Right-click entry removed.',
  'shell.failed': 'Could not change the Explorer menu: {error}',
  'shell.windowsOnly': 'The Explorer right-click menu only exists on Windows.',
  // ----- cli: plan / progress
  'plan.summary': '📦 {files} files to write, {size} ({kept} already up to date) · free space: {free}',
  'plan.summaryDry': '📦 The extraction would hold {files} files, {size}',
  'plan.cancelled': 'Cancelled, nothing was copied.',
  'progress.eta': 'ETA',
  // ----- cli: summary
  'sum.dryDone': '🔎 Analysis completed (nothing copied)',
  'sum.done': '✅ Extraction completed',
  'sum.in': 'in {time}',
  'sum.materials': 'materials',
  'sum.textures': 'textures',
  'sum.models': 'models',
  'sum.sounds': 'sounds',
  'sum.particles': 'particle files',
  'sum.referenced': '{n} referenced',
  'sum.skinPruned': '{n} materials of unused skins skipped',
  'sum.soundDetail': '{sounds} referenced, {soundscapes} soundscapes, {soundscripts} soundscripts',
  'sum.effects': '{n} effects referenced',
  'sum.instances': 'instances merged',
  'sum.bspRead': 'BSP read:',
  'sum.bspDetail': 'v{version}{compressed}, {pak} embedded files',
  'sum.bspCompressedTag': ' (compressed)',
  'sum.inBsp': '{n} referenced files are already inside it and were not copied',
  'sum.files': 'files in the output',
  'sum.incremental': '{written} written, {kept} unchanged, {stale} stale removed',
  'sum.packed': 'files embedded in the BSP:',
  'sum.bspCompressed': 'BSP compressed:',
  'sum.stock': '{n} references are stock content (in the game VPKs) and were skipped',
  'sum.total': 'Total size:',
  'sum.largest': 'Largest files:',
  'sum.bigTextures': '💡 {n} textures are ≥ 16 MB each ({size} total): texture optimisation would shrink them a lot.',
  'sum.excluded': '🔗 Not copied because these workshop items already provide them (add them as required items):',
  'sum.extracted': '📥 Extracted from installed workshop addons:',
  'sum.required': '🔗 {n} files are not loose on disk but installed workshop items provide them (required items, or use --from-workshop):',
  'sum.missing': '⚠️  {n} referenced files were not found anywhere (broken references or content you do not have):',
  'sum.missingMore': '… {n} more, with who references them, in the report',
  'sum.usedBy': 'used by',
  'sum.incomplete': '⚠️  {n} models have no .vvd / .vtx next to them (they will show as ERROR in game):',
  'sum.unresolved': '⚠️  {n} names are defined neither on disk nor by the game (the script that defines them is missing):',
  'sum.unresolved.effects': 'particles',
  'sum.unresolved.soundscapes': 'soundscapes',
  'sum.unresolved.soundscripts': 'soundscripts',
  'sum.diff': '🔁 Since the previous run: {added} files added ({addedSize}), {removed} removed ({removedSize}), {changed} changed',
  'sum.report': 'Full report:',
  'sum.reportHtml': 'Visual report:',
  'sum.filesWord': 'files',
  // ----- cli: optimiser / gma / watch
  'opt.header': 'Optimising textures in {dir} (max {px} px, DXT1/DXT5{normals})',
  'opt.normalsKept': ', normal maps kept uncompressed',
  'opt.progress': 'Optimising textures {done}/{total} {file}',
  'opt.done': '🗜️  Texture optimisation completed',
  'opt.threads': 'in {time} ({threads} threads)',
  'opt.reencoded': 'textures re-encoded:',
  'opt.untouched': '{n} textures were already DXT-compressed and within the size cap',
  'opt.normals': '--keep-normals: {kept} normal maps left untouched, {capped} only resized (kept uncompressed)',
  'opt.lossless': '{n} of them were DXT5 textures with an unused alpha channel: converted to DXT1 without any loss (-{size})',
  'opt.skipped': 'skipped:',
  'gma.progress': 'Building .gma {part}{percent}%',
  'gma.done': '📦 Workshop archive ready',
  'gma.publish': 'Publish with (icon = 512x512 .jpg):',
  'watch.start': '👀 Watching {files} (Ctrl+C to stop)',
  'watch.changed': 'change detected, extracting…',
  'watch.line': '✅ {written} written, {stale} removed, {size} in total · {time}',
  // ----- reports
  'rep.title': 'MapScraper report: {map}',
  'rep.generated': 'Generated on {date} by MapScraper {version}',
  'rep.output': 'Output folder',
  'rep.duration': 'Duration',
  'rep.dry': 'Analysis only: nothing was copied.',
  'rep.overview': 'Overview',
  'rep.sizeByCategory': 'Size by category',
  'rep.largest': 'Largest files',
  'rep.bigTextures': 'Textures ≥ 16 MB (candidates for texture optimisation)',
  'rep.missing': 'Files not found anywhere',
  'rep.missingHint': 'Broken references, or content you do not have. "Used by" walks up to the entity: in Hammer use View > Go to Coordinates with the position shown.',
  'rep.file': 'File',
  'rep.size': 'Size',
  'rep.usedBy': 'Used by',
  'rep.filter': 'Filter…',
  'rep.workshop': 'Workshop',
  'rep.wsExcluded': 'Items that already provide files (not copied: add them as required items)',
  'rep.wsExtracted': 'Items files were extracted from',
  'rep.wsRequired': 'Items providing files that are not loose on disk (required items)',
  'rep.wsFiles': 'Files provided only by installed workshop items',
  'rep.item': 'Item',
  'rep.incomplete': 'Models without .vvd / .vtx',
  'rep.packed': 'Files embedded in the BSP',
  'rep.notGma': 'Files a workshop .gma cannot contain (embedded in the BSP instead)',
  'rep.warnings': 'Warnings',
  'rep.notes': 'Notes',
  'rep.unresolvedEffects': 'Unresolved particle effects',
  'rep.unresolvedSoundscapes': 'Unresolved soundscapes',
  'rep.unresolvedSoundscripts': 'Unresolved soundscripts',
  'rep.stock': 'Stock content (found in the game VPKs, not copied)',
  'rep.searchPaths': 'Search paths',
  'rep.vpks': 'Stock VPK indexes',
  'rep.timings': 'Timings',
  'rep.archives': 'Workshop archives',
  'rep.optimisation': 'Texture optimisation',
  'rep.optSkipped': 'Textures skipped by the optimiser',
  'rep.diff': 'Changes since the previous run',
  'rep.added': 'Added',
  'rep.removed': 'Removed',
  'rep.changed': 'Changed',
  'rep.nothing': 'Nothing to report.',
  usage: `
Usage: mapscraper                      start menu (choose an action, then a recent map)
       mapscraper <map.vmf | map.bsp>  same menu for that map: this is what a drag & drop on the exe does
       mapscraper <map> [options]      no question asked, the options decide
       mapscraper --optimize <folder> [--max-texture <px>] [--keep-normals]

Input
  --game <dir>            garrysmod folder (found through Steam and remembered)
  --vmf <file> / --bsp <file>   map source / compiled map        --out <dir>   output folder (default ./<mapname>, dedicated to MapScraper)
  --all | --materials --models --sounds --publish                 what to extract (default: everything)
  --dry-run               analyse and write the reports only, copy nothing
  --incremental           keep the output folder: copy only new/changed files, delete the ones no longer needed
  --watch                 stay open and re-extract (incrementally) every time the map is compiled (no .gma)
  --all-skins             copy the materials of every model skin (default: only the skins used by the map)

Workshop
  --no-workshop           do not index the installed workshop addons
  --from-workshop         extract files that only exist inside installed workshop addons (.gma)
  --exclude-workshop <ids|all>   do not copy files these workshop items already provide (they become required items)

Size
  --optimize-textures     re-encode big textures: uncompressed -> DXT1/DXT5, capped at --max-texture px (default 2048, 0 = no cap)
  --keep-normals          ...but never DXT-compress normal / bump maps (only cap their size)      --threads <n>   worker threads
  --compress-bsp          LZMA-compress the BSP (needs bspzipplusplus.exe; test the map in game once)

Publishing
  --gma                   build <output>.gma (native writer, no gmad needed)     --split-mb <n>   split into parts of at most n MB
  --title <text>          addon title (default: map name)                          --tags a,b       {tags}

Comfort
  --lang en|fr            language (default: the one of Windows)                  --no-open        do not open the visual report at the end
  --install-context-menu / --uninstall-context-menu    "Extract with MapScraper" on right-click in the Explorer
  --save-defaults         remember the current options as defaults               --yes            do not ask before big copies
  --no-wait               do not wait for Enter at the end
Every on/off option has a --no-<option> form. Defaults live in {config}
`,
};

const fr = {
  'phase.indexing': 'Indexation des dossiers, des VPK du jeu et des addons workshop',
  'phase.vmf': 'Lecture du VMF',
  'phase.bsp': 'Lecture du BSP',
  'phase.particles': 'Résolution des particules',
  'phase.sounds': 'Résolution des soundscripts et soundscapes',
  'phase.assets': 'Résolution des modèles et matériaux',
  'phase.soundFiles': 'Résolution des sons',
  'phase.others': 'Résolution des autres fichiers',
  'phase.prepare': 'Préparation du dossier de sortie',
  'phase.copy': 'Copie des fichiers',
  'phase.pack': 'Intégration des fichiers dans le BSP',
  'phase.compress': 'Compression du BSP',
  'phase.cleanup': 'Nettoyage',
  'error.needMap': 'Il faut un fichier .vmf ou .bsp',
  'error.vmfNotFound': 'VMF introuvable : {file}',
  'error.bspNotFound': 'BSP introuvable : {file}',
  'error.invalidGame': 'Dossier du jeu invalide (pas de dossier materials/) : {dir}',
  'error.refuseClear': 'Refus de vider « {dir} » : il contient des fichiers que MapScraper n\'a pas créés ({files}). Choisis un dossier de sortie vide ou dédié.',
  'error.diskSpace': 'Espace disque insuffisant pour « {dir} » : {need} nécessaires, {free} disponibles.',
  'warn.workshopIndex': 'Échec de l\'indexation du workshop : {error}',
  'warn.noWorkshop': 'Aucun addon workshop installé : les options workshop sont ignorées.',
  'warn.instanceNotFound': 'VMF d\'instance introuvable : {file}',
  'warn.cannotRead': 'Lecture impossible de {file} : {error}',
  'warn.vmtParse': 'Impossible d\'analyser {file}',
  'warn.mdlOld': 'Format MDL ancien ou non géré, matériaux non résolus : {file}',
  'warn.noBsp': 'Map compilée introuvable ({file}) ; rien à intégrer.',
  'warn.packNoTool': 'Impossible d\'intégrer des fichiers au BSP ({error}) et aucun bspzip trouvé : BSP copié tel quel.',
  'warn.packFailed': 'Impossible d\'intégrer des fichiers au BSP ({error} ; {tool} code {status} : {output}) : BSP copié tel quel.',
  'warn.notEmbedded': '{count} fichiers interdits dans un .gma workshop n\'ont pas pu être intégrés au BSP : {files}',
  'warn.compressNoTool': 'Compression du BSP ignorée : aucun bspzip trouvé.',
  'warn.compressNothing': 'La compression du BSP n\'a rien changé ({detail}). Le bspzip de Garry\'s Mod ignore -repack : installe bspzipplusplus.exe (ficool2) dans GarrysMod/bin/win64.',
  'warn.copyFailed': 'Copie impossible de {file} : {error}',
  'warn.unsafePaths': '{count} chemins référencés sont des noms de fichier invalides ou tentent de sortir du dossier du jeu, et ont été ignorés : {files}',
  'note.bspOnly': 'Le BSP compilé référence du contenu absent du VMF ({materials} matériaux, {models} modèles, {sounds} sons) : il a été ajouté à la sortie, car c\'est le BSP qui est publié.',
  'note.bspOlder': 'Le BSP compilé est plus ancien que le VMF : recompile avant de publier si la map a changé.',
  'note.soundscriptFile': 'Le soundscript « {name} » vient de {file} : ce fichier doit être chargé par le jeu (game_sounds_manifest.txt ou maps/{map}_level_sounds.txt).',
  'note.soundscapeFile': 'Le soundscape « {name} » est défini dans {file} (et non {mapFile}) : vérifie que le jeu le charge (soundscapes_manifest.txt).',
  'note.particleNotListed': 'La particule « {effect} » est définie dans {pcf}, absent de {manifest} : ajoute-le (ou précache-le en Lua avec game.AddParticles).',
  'note.manifestGenerated': '{manifest} n\'existait pas : il a été généré avec {pcfs} pour que ces particules soient précachées.',
  'note.bspCompressed': 'Le BSP a été compressé en LZMA : charge la map une fois en jeu avant de publier pour vérifier que ta branche de Garry\'s Mod l\'accepte.',
  'ref.brush': 'brush n°{id}',
  'ref.bspTexdata': 'table des matériaux du BSP (faces de brushes)',
  'ref.bspStaticProps': 'props statiques du BSP',
  'ref.bspPak': 'fichier embarqué dans le BSP',
  'ref.mapFiles': 'fichier compagnon de la map',
  'ref.at': 'en',
  'cli.madeBy': 'Créé par',
  'cli.version': 'Version :',
  'cli.outdated': 'Une nouvelle version de MapScraper est disponible',
  'cli.latest': 'dernière : {version}',
  'cli.thanks': 'Merci d\'utiliser MapScraper 👍',
  'cli.pressEnter': 'Appuie sur Entrée pour fermer le programme',
  'cli.error': 'Une erreur est survenue :',
  'cli.unknownArg': 'Argument inconnu : {args} (attendu : un fichier .vmf / .bsp ou des --options, voir --help)',
  'cli.missingValue': 'Valeur manquante après {opts} (ex. --out "C:\\addons\\mamap" ou --out="C:\\addons\\mamap")',
  'cli.watchGma': '--watch ré-extrait après chaque compilation et ne construit pas de .gma : relance une fois avec --gma quand tu as fini',
  'cli.inputClosed': 'Entrée fermée avant la fin des questions',
  'cli.invalidYN': 'Réponse invalide (o/n)',
  'cli.invalidChoice': 'Choix invalide',
  'cli.yes': 'oui',
  'cli.no': 'non',
  'cli.none': '(aucun)',
  'cli.folderNotFound': 'Dossier introuvable : {dir}',
  'cli.invalidMap': 'Fichier de map invalide : {file}',
  'cli.missingGame': 'Chemin --game absent ou invalide',
  'game.detected': 'Garry\'s Mod trouvé :',
  'game.using': 'Dossier du jeu :',
  'game.ask': '📂 Dossier du jeu (C:\\Steam\\steamapps\\common\\GarrysMod\\garrysmod)',
  'game.invalid': 'Chemin invalide (pas de dossier materials/ dedans)',
  'map.ask': '📄 Fichier VMF ou BSP (tu peux le glisser-déposer ici)',
  'map.invalid': 'Fichier invalide (il faut un .vmf ou un .bsp existant)',
  'map.choose': '🗺️  Quelle map ?',
  'map.other': 'Un autre fichier…',
  'map.ago.minutes': 'il y a {n} min',
  'map.ago.hours': 'il y a {n} h',
  'map.ago.days': 'il y a {n} j',
  'menu.title': '📜 Que veux-tu faire ?',
  'menu.titleFor': '📜 Que veux-tu faire avec {map} ?',
  'menu.analyse': 'Analyser une map',
  'menu.analyse.hint': 'rapport seulement, rien n\'est copié',
  'menu.extract': 'Extraire une map',
  'menu.extract.hint': 'avec tes options par défaut',
  'menu.publish': 'Préparer la publication',
  'menu.publish.hint': 'extraction + textures optimisées + BSP compressé + .gma',
  'menu.update': 'Mettre à jour une extraction existante',
  'menu.update.hint': 'ne recopie que ce qui a changé',
  'menu.watch': 'Surveiller une map',
  'menu.watch.hint': 'ré-extrait automatiquement après chaque compilation',
  'menu.optimize': 'Optimiser les textures d\'un dossier',
  'menu.settings': 'Réglages',
  'menu.quit': 'Quitter',
  'menu.custom': 'Tout choisir moi-même',
  'menu.custom.hint': 'une question par option',
  'ask.everything': '🚀 Tout extraire (matériaux, modèles, sons, particules, divers)',
  'ask.materials': '🧱 Extraire les matériaux',
  'ask.models': '📐 Extraire les modèles',
  'ask.sounds': '🔊 Extraire les sons',
  'ask.others': '📤 Prêt à publier (particules, soundscapes, nav, intégration au BSP…)',
  'ask.optimize': '🗜️  Optimiser les textures ? (compression DXT + max {px} px, avec perte mais quasi invisible, gros gain de taille)',
  'ask.compressBsp': '🗜️  Compresser le BSP ? (nécessite bspzipplusplus, teste la map une fois en jeu)',
  'ask.gma': '📦 Construire le .gma workshop ? (prêt pour gmpublish)',
  'ask.incremental': '♻️  Garder la sortie existante et ne copier que ce qui a changé ?',
  'ask.optimizeFolder': '📁 Dossier à optimiser',
  'ask.continue': 'Continuer ?',
  'settings.title': '⚙️  Réglages (Entrée pour revenir)',
  'settings.lang': 'Langue',
  'settings.optimize': 'Optimiser les textures par défaut',
  'settings.keepNormals': 'Garder les normal maps non compressées',
  'settings.maxTexture': 'Taille maximale des textures (px)',
  'settings.compressBsp': 'Compresser le BSP par défaut',
  'settings.exclude': 'Addons workshop à exclure (ids)',
  'settings.openReport': 'Ouvrir le rapport à la fin',
  'settings.contextMenu': 'Clic droit « Extraire avec MapScraper » dans l\'Explorateur',
  'settings.game': 'Dossier du jeu',
  'settings.installed': 'installé',
  'settings.notInstalled': 'non installé',
  'settings.askMaxTexture': 'Taille maximale des textures en pixels (0 = sans limite)',
  'settings.askExclude': 'Ids workshop séparés par des virgules (vide = aucun, « all » = tous les addons installés)',
  'settings.saved': 'Enregistré.',
  'shell.label': 'Extraire avec MapScraper',
  'shell.installed': '✅ Entrée de clic droit installée pour les fichiers .vmf et .bsp.',
  'shell.removed': '✅ Entrée de clic droit supprimée.',
  'shell.failed': 'Impossible de modifier le menu de l\'Explorateur : {error}',
  'shell.windowsOnly': 'Le menu clic droit de l\'Explorateur n\'existe que sous Windows.',
  'plan.summary': '📦 {files} fichiers à écrire, {size} ({kept} déjà à jour) · espace libre : {free}',
  'plan.summaryDry': '📦 L\'extraction contiendrait {files} fichiers, {size}',
  'plan.cancelled': 'Annulé, rien n\'a été copié.',
  'progress.eta': 'reste',
  'sum.dryDone': '🔎 Analyse terminée (rien n\'a été copié)',
  'sum.done': '✅ Extraction terminée',
  'sum.in': 'en {time}',
  'sum.materials': 'matériaux',
  'sum.textures': 'textures',
  'sum.models': 'modèles',
  'sum.sounds': 'sons',
  'sum.particles': 'fichiers de particules',
  'sum.referenced': '{n} référencés',
  'sum.skinPruned': '{n} matériaux de skins inutilisés ignorés',
  'sum.soundDetail': '{sounds} référencés, {soundscapes} soundscapes, {soundscripts} soundscripts',
  'sum.effects': '{n} effets référencés',
  'sum.instances': 'instances fusionnées',
  'sum.bspRead': 'BSP lu :',
  'sum.bspDetail': 'v{version}{compressed}, {pak} fichiers embarqués',
  'sum.bspCompressedTag': ' (compressé)',
  'sum.inBsp': '{n} fichiers référencés sont déjà dedans et n\'ont pas été copiés',
  'sum.files': 'fichiers dans la sortie',
  'sum.incremental': '{written} écrits, {kept} inchangés, {stale} obsolètes supprimés',
  'sum.packed': 'fichiers intégrés au BSP :',
  'sum.bspCompressed': 'BSP compressé :',
  'sum.stock': '{n} références sont du contenu du jeu (dans les VPK) et ont été ignorées',
  'sum.total': 'Taille totale :',
  'sum.largest': 'Plus gros fichiers :',
  'sum.bigTextures': '💡 {n} textures font 16 Mo ou plus chacune ({size} au total) : l\'optimisation des textures les réduirait fortement.',
  'sum.excluded': '🔗 Non copiés car ces addons workshop les fournissent déjà (ajoute-les en « required items ») :',
  'sum.extracted': '📥 Extraits des addons workshop installés :',
  'sum.required': '🔗 {n} fichiers ne sont pas sur le disque mais des addons workshop installés les fournissent (required items, ou utilise --from-workshop) :',
  'sum.missing': '⚠️  {n} fichiers référencés sont introuvables (références cassées ou contenu que tu n\'as pas) :',
  'sum.missingMore': '… {n} autres, avec ce qui les référence, dans le rapport',
  'sum.usedBy': 'utilisé par',
  'sum.incomplete': '⚠️  {n} modèles n\'ont pas de .vvd / .vtx à côté (ils apparaîtront en ERROR en jeu) :',
  'sum.unresolved': '⚠️  {n} noms ne sont définis ni sur le disque ni par le jeu (le script qui les définit est absent) :',
  'sum.unresolved.effects': 'particules',
  'sum.unresolved.soundscapes': 'soundscapes',
  'sum.unresolved.soundscripts': 'soundscripts',
  'sum.diff': '🔁 Depuis la dernière exécution : {added} fichiers ajoutés ({addedSize}), {removed} retirés ({removedSize}), {changed} modifiés',
  'sum.report': 'Rapport complet :',
  'sum.reportHtml': 'Rapport visuel :',
  'sum.filesWord': 'fichiers',
  'opt.header': 'Optimisation des textures de {dir} (max {px} px, DXT1/DXT5{normals})',
  'opt.normalsKept': ', normal maps gardées non compressées',
  'opt.progress': 'Optimisation des textures {done}/{total} {file}',
  'opt.done': '🗜️  Optimisation des textures terminée',
  'opt.threads': 'en {time} ({threads} threads)',
  'opt.reencoded': 'textures ré-encodées :',
  'opt.untouched': '{n} textures étaient déjà compressées en DXT et sous la taille maximale',
  'opt.normals': '--keep-normals : {kept} normal maps intactes, {capped} seulement redimensionnées (non compressées)',
  'opt.lossless': 'dont {n} textures DXT5 au canal alpha inutilisé : converties en DXT1 sans aucune perte (-{size})',
  'opt.skipped': 'ignorées :',
  'gma.progress': 'Construction du .gma {part}{percent}%',
  'gma.done': '📦 Archive workshop prête',
  'gma.publish': 'Publie avec (icône = .jpg de 512x512) :',
  'watch.start': '👀 Surveillance de {files} (Ctrl+C pour arrêter)',
  'watch.changed': 'changement détecté, extraction…',
  'watch.line': '✅ {written} écrits, {stale} supprimés, {size} au total · {time}',
  'rep.title': 'Rapport MapScraper : {map}',
  'rep.generated': 'Généré le {date} par MapScraper {version}',
  'rep.output': 'Dossier de sortie',
  'rep.duration': 'Durée',
  'rep.dry': 'Analyse seule : rien n\'a été copié.',
  'rep.overview': 'Vue d\'ensemble',
  'rep.sizeByCategory': 'Taille par catégorie',
  'rep.largest': 'Plus gros fichiers',
  'rep.bigTextures': 'Textures de 16 Mo ou plus (candidates à l\'optimisation)',
  'rep.missing': 'Fichiers introuvables',
  'rep.missingHint': 'Références cassées, ou contenu que tu n\'as pas. « Utilisé par » remonte jusqu\'à l\'entité : dans Hammer, View > Go to Coordinates avec la position indiquée.',
  'rep.file': 'Fichier',
  'rep.size': 'Taille',
  'rep.usedBy': 'Utilisé par',
  'rep.filter': 'Filtrer…',
  'rep.workshop': 'Workshop',
  'rep.wsExcluded': 'Addons qui fournissent déjà des fichiers (non copiés : à ajouter en required items)',
  'rep.wsExtracted': 'Addons dont des fichiers ont été extraits',
  'rep.wsRequired': 'Addons fournissant des fichiers absents du disque (required items)',
  'rep.wsFiles': 'Fichiers fournis uniquement par des addons workshop installés',
  'rep.item': 'Addon',
  'rep.incomplete': 'Modèles sans .vvd / .vtx',
  'rep.packed': 'Fichiers intégrés au BSP',
  'rep.notGma': 'Fichiers interdits dans un .gma workshop (intégrés au BSP à la place)',
  'rep.warnings': 'Avertissements',
  'rep.notes': 'Notes',
  'rep.unresolvedEffects': 'Effets de particules non résolus',
  'rep.unresolvedSoundscapes': 'Soundscapes non résolus',
  'rep.unresolvedSoundscripts': 'Soundscripts non résolus',
  'rep.stock': 'Contenu du jeu (trouvé dans les VPK, non copié)',
  'rep.searchPaths': 'Dossiers de recherche',
  'rep.vpks': 'Index VPK du jeu',
  'rep.timings': 'Durées',
  'rep.archives': 'Archives workshop',
  'rep.optimisation': 'Optimisation des textures',
  'rep.optSkipped': 'Textures ignorées par l\'optimiseur',
  'rep.diff': 'Changements depuis la dernière exécution',
  'rep.added': 'Ajoutés',
  'rep.removed': 'Retirés',
  'rep.changed': 'Modifiés',
  'rep.nothing': 'Rien à signaler.',
  usage: `
Usage : mapscraper                      menu de démarrage (choisir une action, puis une map récente)
        mapscraper <map.vmf | map.bsp>  même menu pour cette map : c'est ce que fait un glisser-déposer sur l'exe
        mapscraper <map> [options]      aucune question, les options décident
        mapscraper --optimize <dossier> [--max-texture <px>] [--keep-normals]

Entrée
  --game <dossier>        dossier garrysmod (trouvé via Steam puis mémorisé)
  --vmf <fichier> / --bsp <fichier>   source / map compilée      --out <dossier>   dossier de sortie (défaut ./<map>, dédié à MapScraper)
  --all | --materials --models --sounds --publish                 quoi extraire (défaut : tout)
  --dry-run               analyse et écrit les rapports seulement, ne copie rien
  --incremental           garde le dossier de sortie : ne copie que le nouveau/modifié, supprime ce qui ne sert plus
  --watch                 reste ouvert et ré-extrait (en incrémental) à chaque compilation de la map (sans .gma)
  --all-skins             copie les matériaux de tous les skins des modèles (défaut : seulement ceux utilisés par la map)

Workshop
  --no-workshop           n'indexe pas les addons workshop installés
  --from-workshop         extrait les fichiers qui n'existent que dans des addons workshop installés (.gma)
  --exclude-workshop <ids|all>   ne copie pas ce que ces addons fournissent déjà (ils deviennent des « required items »)

Taille
  --optimize-textures     ré-encode les grosses textures : non compressées -> DXT1/DXT5, plafonnées à --max-texture px (défaut 2048, 0 = sans plafond)
  --keep-normals          ...mais ne compresse jamais les normal maps en DXT (plafond de taille seulement)   --threads <n>   threads de travail
  --compress-bsp          compresse le BSP en LZMA (nécessite bspzipplusplus.exe ; teste la map une fois en jeu)

Publication
  --gma                   construit <sortie>.gma (writer intégré, sans gmad)      --split-mb <n>   découpe en parts d'au plus n Mo
  --title <texte>         titre de l'addon (défaut : nom de la map)               --tags a,b       {tags}

Confort
  --lang en|fr            langue (défaut : celle de Windows)                      --no-open        n'ouvre pas le rapport visuel à la fin
  --install-context-menu / --uninstall-context-menu    « Extraire avec MapScraper » au clic droit dans l'Explorateur
  --save-defaults         mémorise les options courantes comme valeurs par défaut --yes            ne demande pas de confirmation avant les grosses copies
  --no-wait               n'attend pas Entrée à la fin
Chaque option oui/non a une forme --no-<option>. Les valeurs par défaut sont dans {config}
`,
};

const catalogs = { en, fr };

function format(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

/** @returns {(key:string, vars?:object)=>string} */
function makeT(lang) {
  const cat = catalogs[lang] || en;
  const t = (key, vars) => format(cat[key] !== undefined ? cat[key] : (en[key] !== undefined ? en[key] : key), vars);
  t.lang = catalogs[lang] ? lang : 'en';
  return t;
}

/** 'fr' when the system speaks French, 'en' otherwise. */
function detectLang() {
  const env = process.env.MAPSCRAPER_LANG || process.env.LC_ALL || process.env.LANG || '';
  let locale = env;
  if (!/^[a-z]{2}/i.test(locale)) { try { locale = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { locale = ''; } }
  return /^fr/i.test(locale) ? 'fr' : 'en';
}

module.exports = { makeT, detectLang, catalogs, LANGS: Object.keys(catalogs) };
