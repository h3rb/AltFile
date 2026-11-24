# Alt File Explorer

A fast, dark, keyboard-first file explorer built with **Rust + Tauri 2**. It adds smart media
thumbnails, quick previews, fuzzy/recursive search, file operations, and a FolderExplorer-style
treemap visualization of any folder — and it builds as a portable executable for Windows and Linux.

## Features

- **Dark UI** with grid and list views, tabs, breadcrumbs, sidebar places, bookmarks, and a details pane.
  The accent hue is adjustable in **Settings → Appearance → Theme**; every accent-tinted surface follows the
  slider, while the default position keeps the original teal exactly.
- **Network shares** appear in a `Network` group under *This PC* on Windows: the sidebar asks both the
  network browse list and the shell Network folder, so it finds machines the other source misses (and
  shares the browse list shows but the shell hides). Entries open the UNC path like any other folder, and
  the refresh icon rescans. The group is hidden on Linux, where there is nothing to enumerate.
- **Cross Device** appears as a `Cross Device` section under Network on Windows when the Cross Device
  service is present: linked phones, cameras and other small devices are listed from
  `%USERPROFILE%\CrossDevice` and open like ordinary folders. When no devices are linked, the section
  is not shown at all. Device folders linger after unplugging, so the sidebar checks the attached
  portable devices on a once-a-minute timer (and when the window regains focus) and dims any gadget
  that is no longer connected, labeling it *Disconnected*. Right-click a disconnected device and choose
  **Remove from view** to hide it until it reconnects; the entry reappears by itself the next time the
  device is attached.
- **Smart thumbnails** generated on demand and cached by a key over the file path, size and modification time
  (512 MB LRU-style cache):
  - Windows: images (with EXIF orientation), video/audio posters, PDF first pages through the Windows PDF
    renderer, and Office documents and executable icons via the shell.
  - Linux: images, video posters through `ffmpeg`, and PDF first pages through `pdftoppm` when available.
  - Password-protected PDFs show a lock instead of a preview, since they cannot be rendered without the password.
  - Both: **3D model renders** for `.stl`, `.obj`, `.ply` and `.3mf` — the mesh is parsed and shaded by a small
    built-in software renderer (no shell handler, no GPU), so a model card shows the object itself from a
    three-quarter view instead of a generic icon.
  - **3MF projects** render in color: core-spec base materials, color groups, composite and multi-property
    materials, Bambu Studio / Orca Slicer part filaments, PrusaSlicer volume extruders, and painted
    multi-material regions (`paint_color` / `mmu_segmentation`) all tint the shaded model. Build items,
    nested components, sub-model files and transforms are honored, modifier volumes are skipped, and
    multi-plate projects show the first plate. Very large scenes are simplified by vertex clustering to a
    facet budget, which keeps surfaces closed instead of thinning them into speckles.
- **Drag files out**: drag any card or list row into another application. Selection is honored (drag a
  selected item to move the whole selection) and the drop carries real files through the native OS drag, so
  apps and file managers receive the files themselves.
- **Rubber-band selection**: drag in empty grid or list space to select every item the band touches; a drag
  started in the list's left margin selects whole rows. Hold `Ctrl`, `⌘`, or `Shift` to add the band to the
  current selection instead of replacing it.
- **Selection colors**: selected items take a teal-to-blue gradient — the same transition as the drive
  capacity meters — while the focused cursor item keeps the accent ring, so selection and position read
  differently.
- **Keyboard selection**: `Ctrl+Space` adds or removes the focused item from the selection. In the grid,
  `Ctrl+Arrow` moves the focus and adds both the item it leaves and the item it lands on; in list view only
  `Ctrl+Up` and `Ctrl+Down` do this. `Ctrl+Shift+A` inverts the selection, and the right-click menu offers
  *Invert selection* when multiple items are selected and *Select all* when only the active item is selected.
- **Shortcuts**: `.lnk` files are labeled *Shortcut* everywhere (cards, list, Details) and show a link badge over
  their grid thumbnail, while the thumbnail itself comes from the shell so it reflects the shortcut's target.
- **Animated GIFs**: GIF cards and the preview pane show a still first-frame thumbnail, then play the original
  animation while the pointer is over the image and return to the still on mouse-out. The animation streams
  through the media protocol and is cached per modification time.
- **Hover video previews**: video cards start a muted, looping inline playback of the file while the pointer is
  over the card, and return to the poster frame on mouse-out.
- **Grid folder cards** fill the preview box with an oversized folder and show live subfolder/file counts, each
  marked with a folder or document icon; counts load lazily and honor the hidden-file toggle. A row of small
  icons under the counts hints at the kinds of files inside — audio, video and 3D models — with one icon per
  kind present.
- **Media folder mosaics**: when more than half of a folder's files are images or videos, its grid card and
  the preview pane show a packed mosaic of those thumbnails instead of the folder icon. A bin-packing layout
  justifies rows to the container and keeps adding tiles while they stay readable; the order they are picked in
  follows **Settings → Appearance → Folder photo mosaics** (latest modified, alphabetical, or largest first).
  Folders at exactly half or below keep the count view.
- **Folder content size**: the same tile shows the recursive size of the folder, and list view replaces the `—`
  in the size column with it. Sizes walk the tree lazily for visible rows with a time/entry budget, so a partial
  total is suffixed with `+` instead of blocking the view.
- **Font specimens**: `.ttf`, `.otf`, `.woff` and `.woff2` cards and the preview pane render the full ASCII
  sweep — `A–Z`, `a–z`, `0–9` and punctuation — in the actual typeface, loaded lazily for visible tiles through
  the `font://` protocol.
- **Archive contents**: ZIP, TAR, TAR.GZ/TGZ, TAR.BZ2/TBZ2, GZ, BZ2, RAR (4 and 5), 7Z and the legacy ARC and
  LZH archives list their first entries, the archive format, file/folder counts, and a best-guess content type
  (Application, Source Code, Media Files, Documents, Fonts, 3D Models, Archives, or Mixed Files). Any archive that contains an `.exe`
  file is marked Application regardless of the other entries. ZIP indexes are read from the central
  directory without decompressing entry data; compressed tar streams are scanned with a 256 MB budget, and a
  partial result is marked with `+`. 7Z headers are decoded through their compressed (encoded) form without
  extracting file data. Password-protected ZIP, RAR and 7Z archives (including archives with encrypted headers)
  show a padlock over the card, an "Encrypted" content type, and a password-required message in the preview
  pane instead of a contents list. The preview pane shows the same contents list with total uncompressed size.
- **Disc image contents**: ISO (ISO 9660/Joliet/UDF) and legacy Atari disk images (ATR, DI, XFD, PRO) cards list
  the files and folders stored inside the image, the filesystem label or volume name when present, file/folder
  counts and a best-guess content type, using the same card layout as archives; an ISO's autorun icon, when the
  disc carries one, replaces the generic disc glyph. The preview pane shows the top entries plus the filesystem
  and volume metadata. Atari images are parsed through their boot-sector layout and DOS 2.x/MyDOS directory
  entries; DCM images (including their DC3 and DSK aliases) and copy-protected ATX images keep the disc-style
  card and report that their contents cannot be listed.
- **Extract archives**: right-click an archive (or use the preview pane's **Extract To…** button) to unpack it
  into a folder that defaults to the archive's own folder plus its name without the extension. ZIP, TAR,
  TAR.GZ/TGZ, TAR.BZ2/TBZ2, GZ, BZ2 and 7Z extract natively; RAR uses an installed bsdtar, 7-Zip or unrar.
  Entry paths are validated so nothing is written outside the chosen folder.
- **HTML thumbnails**: `.html` and `.htm` cards render the page itself in a live, sandboxed frame (scripts,
  forms and navigation disabled) served through the `page://` protocol, so relative stylesheets, images and
  fonts load from the file's own folder. Only visible cards mount a frame, and a bounded pool is recycled as
  you scroll.
- **Markdown thumbnails**: `.md` and `.markdown` cards show a typeset document preview instead of a generic
  file icon. Markdown is rendered to HTML on the fly (headings, lists, task lists, tables, code fences,
  quotes, links and images) and served through the same sandboxed `page://` frame, with raw HTML escaped
  and script URLs stripped.
- **Treemap visualization** for the active folder: squarified tiles, drill-down, hover tooltip, large-file and
  extension/contents insights, hidden-file support, and cancellable scans. Right-clicking the Visualize button
  opens the current folder's map in a new tab, gives every first-level subfolder its own visualization tab, or
  exports the visible map as a PNG through a save dialog.
  Folder sizes are summed recursively
  over the whole subtree and scans have no entry cap; each scan returns the folder's tiles with nested subtrees
  for the folders that clear the depth threshold, and drilling into a folder re-scans it. The treemap fills in progressively while the scan runs, with nested contents shown
  for any folder taking more than its depth threshold of the section (1% by default, adjustable from 1% to 50% in
  Settings) — one level deeper at a time, each level faded 5% more
  (from 75% opacity) until it would drop below 25% — and tiles, breadcrumbs and drill-down stay clickable even
  while a scan or refresh is still running (a navigation supersedes the in-flight scan); the scan strip above the
  canvas offers Stop. While open it watches the visualized folder recursively and
  re-scans automatically when files change anywhere below it; the refreshed scan is merged into the displayed
  tree in place, so the current view stays interactive (and navigable) while it is being updated. Completed
  scans are also cached on disk, so returning to a folder — even after a restart — reopens its map instantly;
  a cached map that has not been opened for 15 minutes is shown immediately and re-scanned in the background.
- **Preview pane** with media thumbnails, file metadata, image dimensions, and text previews (UTF-8/UTF-16).
  Model files that the software renderer understands (`.stl`, `.obj`, `.ply`, `.3mf`) open in a slowly rotating
  WebGL view instead of a static poster, so the shape can be inspected without leaving the app. Rotation can
  be turned off in **Settings → Appearance → Rotate 3D models**, which freezes the current three-quarter view.
  3MF files keep their material colors in the live view, and the metadata list adds the model title,
  designer and slicer, object/part/plate counts, triangle count (with painted triangles and simplification noted),
  world extent in millimeters, and a swatch list of the materials or filaments with their share of the surface.
- **Media previews and playlist**: audio waveforms with duration, bitrate, sample rate, and channels
  (click the waveform to start playback at that point), while list view draws a faint waveform behind the
  name of each audio file; video frame previews with hover scrubbing over
  the timeline; and a persistent player with a queue you can fill from the preview pane, context menu,
  or command palette (`Space` toggles playback). When the file open in the preview is playing, the
  preview's own video follows the player — starting, pausing, and staying in sync — and scrubbing the
  preview timeline seeks the player. While audio plays, the shading on grid thumbnails pulses subtly to
  the beat (Web Audio analyser; disabled when the system asks for reduced motion), and the playing file's
  card shows a live spectrum/oscilloscope overlay fed by the same analyser. Loop playback is on by default:
  when a file ends it repeats, and turning Loop off lets playback advance to the next item as before. Toggle
  it from the repeat button in the player bar, the **Loop** button next to **Play** in audio and video
  previews, or **Settings → Playback → Loop playback**. The playlist panel header
  shows the selected saved playlist: **Add to playlist** sends new files there, and when no playlist is
  selected the next add creates and selects a new one. Picking an existing playlist loads it into the
  player, removing a track from the queue updates the selected playlist, and the picker can start a new
  playlist or delete the current one. Turn on **Settings → Appearance → Playlists in sidebar** to list
  saved playlists under Bookmarks in the left panel; clicking one opens it in the player, and the **+**
  beside the section heading starts a new playlist. Right-click a playlist to expand its tracks in the
  sidebar — clicking a track plays that file and highlights it while it is playing; right-click again to
  collapse. Drag audio or video files from the grid or list onto a listed playlist to add them, or drop
  files from another application onto it.
- **MIDI playback and SoundFonts**: `.mid`, `.midi`, `.rmi` and `.kar` files play out of the box through a
  built-in generative General MIDI synth — no SoundFont needed. The preview renders the score to a waveform
  with duration, sample rate and channels, and the player bar treats it like any other audio track. `.sf2`
  SoundFonts get a piano-keyboard card and a preview listing the font name, preset/instrument/sample counts,
  engine and version. Right-click a SoundFont and choose **Use for MIDI playback** (or **Use for MIDI** in its
  preview) to make it the active font, so MIDI files render with its samples; the card gains a `MIDI` badge.
  **Reset MIDI SoundFont** in the same menu, **Use built-in** in the preview, or the reset button under
  **Settings → Playback → MIDI SoundFont** returns to the generative synth. The choice is remembered across
  sessions.
- **Tracker modules**: `.mod`, `.stm`, `.s3m`, `.s3i`/`.s3t`, `.xm`, `.it`, `.mptm` and the compressed
  `.s3z`/`.xmz`/`.itz`/`.mptmz`/`.mdz` variants play through a built-in mixer with per-channel panning and
  looping samples. The preview shows the live pattern grid — notes, instrument and volume columns, with the
  playing row highlighted and a click on any row starting playback there — plus title, tracker, order,
  pattern and sample counts. When playback is stopped, the pattern grid takes focus and the arrow keys move the
  cursor down and up by rows and left and right by patterns. A **Sound bank** under the preview actions lets
  you audition any sample (and the single instrument of an `.s3t`/`.s3i` file) on its own, once, at its native
  pitch; right-click a sample to **Export as…** (OGG Vorbis/FLAC/WAV through a save dialog) or use **Quick Export**
  to write the chosen format next to the module as `<name>-01.ext` (numbering from the bank index). The player bar treats modules like
  any other audio track.
- **Search** the current folder instantly, or recurse into subfolders with gitignore-aware walking. Which of
  the two the search box does is a setting (**Settings → Browsing → Search subfolders**); the scope button next
  to the box flips the same switch, and the choice is remembered across sessions.
- **Details column** in list view, filled per kind: play length for audio and video, pixel size for images,
  subfolder/file counts for folders and archives, and bounding-box dimensions for 3D models (`.obj`, `.stl`,
  `.ply`, `.3mf`, `.gltf`, `.glb`, `.off`). Values load lazily for visible rows only and are cached per file.
  The Kind column names the extension for files that match no known kind (`File: XYZ`).
- **List scrolling gestures**: `Ctrl+Wheel` starts a slow line-by-line drift up or down that continues until the
  wheel turns the other way or Ctrl is released. `Ctrl+Middle click` toggles the autoscroll anchor: a circle-with-
  arrows marker appears where you clicked, moving the pointer away from it glides the list at a speed matching the
  distance, and clicking it again or left-clicking exits.
- **File operations**: create folder, rename, copy/cut/paste with collision-safe names, reveal, properties,
  and delete to the system Trash. Right-clicking a folder segment in the breadcrumb path opens the same
  folder menu as right-clicking that folder in the grid or list, without disturbing the current selection.
- **File operation queue**: copies, moves, deletes and archive extractions run through a dedicated
  **File operations** tab. The tab opens on its own (without stealing focus from the current folder) when
  something is queued, and can also be reached from **More actions → File operations**. Operations run one at
  a time with a live progress bar and per-item result; finished entries can be cleared, and the tab survives
  restarts like any other tab.
- **Legacy formats**: **Settings → Browsing → Support Legacy File Formats** (on by default) natively identifies
  classic Atari 8-bit formats, plus Commodore SID, NES NSF and ARC/LZH/LZW archives, by reading their contents,
  so only files that pass a format check are grouped. Identified files join a **Legacy** filter and show their
  real kind (Atari ATR/XEX/CAS, DI/XFD/APE/ATX/DCM/DSK disk images, CART cartridge images, ARC/LZH/LZW archives,
  tokenized Atari BASIC, BASIC XL/XE and Turbo BASIC programs, MAC/65 and C source listings, fonts
  including Daisy-Dot NLQ, GR8/GR9/G15/HIP/RGB/INT95a/Fun with Art/ILC pictures,
  SAP/SID/NSF/RMT/CMC/DMC/ProTracker/TMC/TM2/AMP/AMS/Future Composer music) in cards, list, search, the
  palette and the preview; turning the setting off removes the group and falls back to the
  extension-based kind.
- **System Menu** (Windows): right-click any drive, file or folder — including treemap tiles — and open
  the real shell context menu, with shell extensions and submenus, as a submenu of the app menu.
- **File Explorer integration** (Windows): **Settings → Windows integration → Add AltFile Context Menu Items**
  adds **Explore in AltFile** to the right-click menu for folders and for empty folder backgrounds. It is a
  per-user registration and needs no administrator rights. Once installed, the same button reads **Remove AltFile
  Context Menu Items** and undoes the registration. Windows 11 shows these entries in the classic menu,
  so reach them with **Show more options** (or Shift+F10 / the Menu key). Choosing the entry launches the app
  at that folder; if AltFile is already running, the window comes to the front and its active tab navigates
  there, while the second launch hands its request to the first instance and exits.
- **Keyboard-first**: command palette, quick paths, vim-free arrow navigation, and standard shortcuts.
- **Update check and in-place updates**: on launch (at most once every six hours) the app asks the GitHub
  releases API for the latest release. When a newer version exists, a version pill appears on the Settings
  button and **Settings → About → Get update** downloads the build for this platform and installs it:
  an NSIS-installed copy runs the release's setup silently in update mode and relaunches, while a portable
  copy replaces its executable in place and restarts. Download progress is shown in the About row; failed
  checks and downloads stay quiet and can be retried there.
- **Portable mode**: place `portable.txt` next to the executable and settings, session, and thumbnails are kept
  in a `data` folder beside it. On Windows the WebView2 profile moves there too.
- **Session restore**: tabs, bookmarks, recent folders, thumbnail size, panel state, the playlist, and saved playlists persist across runs.

## Supported file types

The Kind a file gets is decided by its extension through one table shared by the cards, list, filters, search
and Details column. Contents, previews and details are only added when the file really matches: archives and
disc images are parsed, PDF encryption is checked, and text is probed for its encoding. Legacy formats are the
one family whose Kind also depends on content (see below). Grid cards, the preview pane and the Details column
follow the same table.

| Type | Extensions | How it is detected | Grid thumbnail | Preview pane | Operations |
| --- | --- | --- | --- | --- | --- |
| Images | `jpg` `jpeg` `jfif` `png` `gif` `webp` `bmp` `tif` `tiff` `ico` `svg` `avif` `heic` `heif` `raw` `cr2` `nef` | Extension; decoded in-app (EXIF orientation applied); formats the decoder cannot read fall back to the Windows shell thumbnail, or to an icon on Linux | Real thumbnail, generated on demand and cached | Scaled image with dimensions; GIFs play while hovered and return to the still on mouse-out | Open with the default app, reveal, copy path, drag out |
| Video | `mp4` `mkv` `avi` `mov` `wmv` `flv` `webm` `m4v` `mpg` `mpeg` `3gp` `m2ts` `ogv` | Extension; playability follows the WebView codecs | Poster frame (Windows shell; `ffmpeg` frame on Linux); the card plays a muted loop while hovered | Inline player with poster, scrubbable timeline, duration and resolution; follows the player bar when the same file plays | Play, loop, add to playlist, reveal, drag out |
| Audio | `mp3` `wav` `flac` `ogg` `oga` `m4a` `aac` `wma` `opus` `aiff` | Extension; decoded by the WebView | Shell-provided artwork/icon on Windows; generic icon elsewhere | Waveform (click to start playback at that point), duration, estimated bitrate, sample rate, channels | Play, loop, add to playlist, drag out |
| MIDI | `mid` `midi` `rmi` `kar` | Extension; rendered by the built-in General MIDI synth or the chosen `.sf2` SoundFont | Shell icon | Rendered waveform with duration, sample rate and channels | Play, loop, playlist; choose the SoundFont from its card/preview |
| Tracker modules | `mod` `stm` `s3m` `s3z` `s3t` `s3i` `xm` `xmz` `it` `itz` `mptm` `mptmz` `mdz` | Extension; the module is decoded by the built-in mixer | Shell icon | Live pattern grid with the playing row highlighted (click a row to start there), title/tracker/order/pattern/sample counts, position | Play; arrow keys move the pattern cursor while stopped; Sound bank audition and OGG/FLAC/WAV sample export |
| 3D models (rendered) | `stl` `obj` `ply` `3mf` | Extension; the mesh is parsed locally (3MF through its own ZIP/XML reader) | Shaded three-quarter render from the built-in software rasterizer, in material colors for 3MF | Slowly rotating WebGL view; 3MF adds title, designer, slicer, object/triangle counts, extent and material swatches; rotation can be disabled in Settings | Open, reveal, copy path |
| 3D models (measured only) | `gltf` `glb` `off` | Extension; parsed only for bounds | Icon | Icon; the Details column shows the bounding-box dimensions from the mesh | Open, reveal |
| Other 3D formats | `dae` `fbx` `blend` `3ds` `usd` `usda` `usdz` `abc` `step` `stp` `iges` `igs` `wrl` `vrml` `lwo` | Extension only — no parser, no renderer | Kind icon | Icon with metadata | Open, reveal |
| PDF | `pdf` | Extension; first page rendered by the Windows PDF engine or `pdftoppm` on Linux; encrypted files are confirmed by scanning the trailer for `/Encrypt` | First-page thumbnail; a lock overlay for password-protected files | First-page image with metadata, or a password-required message | Open, reveal |
| Office documents | `doc` `docx` `xls` `xlsx` `ppt` `pptx` `odt` `ods` `odp` | Extension; thumbnails come from the Windows shell, so they exist only where an Office handler is installed (none on Linux) | Shell thumbnail on Windows, icon otherwise | Icon with metadata | Open, reveal |
| Documents (plain) | `txt` `md` `markdown` `log` `csv` `tsv` `rtf` `epub` `mobi` | Extension; `txt`/`md`/`log`/`csv`/`tsv`/`rtf` never request a shell thumbnail, `epub`/`mobi` do on Windows when a handler exists | Icon, except Markdown (rendered card below) and `epub`/`mobi` on Windows | UTF-8 or UTF-16 (LE/BE by BOM) text, up to 96 KB read and 14,000 characters shown, with a truncation/encoding note; binary files report that instead of text | Open, reveal, copy path |
| Code and config | `rs` `js` `mjs` `cjs` `ts` `tsx` `jsx` `py` `rb` `go` `java` `c` `h` `cpp` `hpp` `cc` `cs` `php` `swift` `kt` `kts` `scala` `sh` `bash` `zsh` `ps1` `bat` `cmd` `lua` `r` `sql` `html` `htm` `css` `scss` `sass` `less` `vue` `svelte` `astro` `json` `jsonc` `yaml` `yml` `toml` `xml` `ini` `cfg` `conf` `env` `gradle` `cmake` `ipynb` | Extension; same text probe as documents | Icon, except HTML/Markdown | Plain monospace text preview (no syntax highlighting) with the same length and encoding limits | Open, reveal, copy path |
| HTML and Markdown pages | `html` `htm` `md` `markdown` | Extension; HTML is served through a sandboxed `page://` frame with its sibling assets, Markdown is converted by the built-in renderer | Live page thumbnail in a sandboxed iframe (scripts and navigation disabled), mounted only for visible cards | Source text preview | Open in the default app, reveal |
| Archives (listed) | `zip` `rar` `7z` `tar` `gz` `tgz` `bz2` `tbz2` `tbz` | Extension plus header parsing: ZIP central directory (Zip64), TAR blocks, tar-inside-gzip/bzip2 sniffing, RAR 4/5 and 7Z headers; encryption flags mark the archive locked | Contents tile: format, first entries, file/folder counts, content type, total size, padlock when encrypted | The same list (up to six entries), counts, total uncompressed size, protection state | **Extract To…** (ZIP, TAR family, GZ, BZ2 and 7Z natively; RAR through bsdtar/7-Zip/unrar), open, reveal |
| Other archive-type extensions | `xz` `zst` `dmg` `cab` `rpm` `deb` | Extension only — no contents reader, no extractor | Icon | Icon with metadata | Open, reveal |
| ISO disc images | `iso` | ISO 9660/Joliet/UDF structures are parsed; volume label, filesystem and an autorun icon come from the image | Contents tile with the disc label and an autorun icon when present | Contents list plus filesystem, volume label and counts | Open, reveal |
| Atari disk images | `atr` `di` `xfd` `pro`; recognized as discs without contents: `dcm` `dc3` `dsk` `atx` | Requires the Legacy format setting; contents parsed from the boot layout and DOS 2.x/MyDOS directories and VTOC; DCM/DC3/DSK and ATX have no readable directory | Disc contents tile, or a disc-style card reporting that contents are unavailable for DCM/DC3/DSK/ATX | The same contents/metadata or the unavailable message | Open, reveal |
| Fonts | `ttf` `otf` `woff` `woff2` | Extension; the face is loaded through the `font://` protocol | ASCII specimen (`A–Z`, `a–z`, `0–9`, punctuation) set in the actual typeface | Large specimen of the same sweep | Open, reveal |
| SoundFonts | `sf2` | Extension; the SoundFont is parsed for its metadata | Piano-keyboard card with a `MIDI` badge when the font is active | Font name, preset/instrument/sample counts, engine and version | **Use for MIDI** / **Use built-in**, open, reveal |
| Executables and shortcuts | `exe` `dll` `so` `dylib` `msi` `msix` `appx` `app` `appimage` `url`; `lnk` | Extension; `.lnk` files are labeled *Shortcut* and get a link badge | Shell icon (the shortcut's target on Windows) | Icon with metadata | Open, reveal |
| Unknown files | anything else | Extension only, shown as `File: EXT` | Kind icon | Icon with metadata | Open, reveal |

Common operations are available on every card and row regardless of type: rename, copy/cut/paste, move to
Trash, properties, drag out to other applications, and — on Windows — the real shell **System Menu**.
Archive and disc files additionally show their contents in the card, list Details column and preview pane.

### Legacy formats

**Settings → Browsing → Support Legacy File Formats** (on by default) adds content sniffers for classic
formats. A file is only relabeled when its header, structure or documented size passes the per-format test
(the first 13 KB are read); files that fail keep their extension-based kind. Identified files join the
**Legacy** filter, appear with their real format name in cards, list, search, palette and preview, and revert
to the plain extension kind when the setting is turned off. Content listing and extraction are only available
for the legacy disc images and archives marked below.

| Family | Extensions | Content test | Shown as |
| --- | --- | --- | --- |
| Atari disk images | `atr` `di` `xfd` `pro` `atx` `dcm` `dc3` `dsk` | ATR header and geometry, DI header and sector table, XFD by sector-size multiple (headerless), APE ProSystem sector count, `AT8X` magic for ATX, DCM header flags | Disk images (ATR/DI/XFD/PRO contents are listed; DCM/DC3/DSK/ATX contents unavailable) |
| Cartridges | `car` | `CART` + type code header | Cartridge image |
| Executables and system files | `xex` `bin` `com` `sys` `ars` `aut` | Atari binary `$FF $FF` (or `$00 $00`) segment structure | Executable / system / autorun file |
| Cassettes | `cas` | `FUJI` magic | Cassette image |
| Archives | `arc` `lzh` `lzw` | ARC `$1A $08`, LZH header levels, Unix-compress `$1F $9D` header | ARC/LZH list their contents; LZW is identified only |
| BASIC programs | `bas` `sav` `abs` `tb` `tba` `tbs` `tur` `bxl` `bxe` | Seven-pointer Atari BASIC save header (LOMEM through STARP), variable-table alignment and line chain (BASIC XL/XE saves share it) | BASIC, BASIC XL/XE or Turbo BASIC program (by extension) |
| Sources and listings | `asm` `lst` `src` `act` `pas` `hlp` `4th` `for` `fth` `pil` `plo` `qik` `qui` `lgo` `c65` `ccc` `mac` `m65` | MAC/65 files need the `$FE $FE` size and ascending line chain; the rest must be at least 95% printable Atari text | Assembler/Action!/Pascal/Forth/Pilot/Quick/Logo/C source, Atari listing or text file, MAC/65 source |
| Fonts | `chr` `fnt` `fon` `nlq` | 512/768/1024/2048-byte font shapes; Daisy-Dot NLQ by its 91-glyph walk | Atari font, Daisy-Dot NLQ font |
| Pictures | `gr8` `gr9` `g15` `mic` `p15` `pi8` `pi9` `256` `ap2` `apc` `pic` `int` `fwa` `ilc` `hip` `rgb` `b` `g` `r` | Documented frame sizes for headerless bitmaps; `INT95a` and Fun with Art headers checked byte by byte | Graphics 8/9/15, Atari picture (`mic`/`pic`), Paint 256, HIP, RGB, INT95a, Fun with Art, Interlaced picture |
| Music | `sap` `sid` `nsf` `rmt` `cmc` `dmc` `mpt` `d8` `d15` `md8` `ft` `tmc` `tm2` `amp` `am2` `ams` | Per-format signatures (`SAP`, `PSID`/`RSID`, `NESM`, RMT/CMC/ProTracker/AMP/AMS headers, Future Composer magic) | SAP/SID/NSF/RMT/CMC/DMC/ProTracker music and modules, converted MOD module, TMC/TM2/AMP/AMS/Future Composer music |

Legacy files have no built-in renderer, player or converter; the only extras are the contents listings for the
ATR/DI/XFD/PRO disk images and the ARC/LZH archives noted above.

## Portable builds

The packaging scripts also produce the assets the in-app updater expects, so every release should publish
them next to the archives: `<name>-setup.exe` (NSIS) and the bare executable for each platform.

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-windows.ps1
```

Outputs in `dist/`:

- `AltFileExplorer-<version>-win-x64.zip` — portable folder containing `altfileexplorer.exe`, `portable.txt`,
  `README.md`, and `LICENSE`. Unzip anywhere and run the executable.
- `AltFileExplorer-<version>-win-x64-setup.exe` — NSIS installer for the current user, built with
  `cargo tauri bundle --bundles nsis`.
- `AltFileExplorer-<version>-win-x64.exe` — bare executable that portable copies download when they update.

WebView2 Runtime is required (preinstalled on Windows 10/11; the evergreen runtime can be installed from
Microsoft).

### Linux

```bash
bash scripts/package-linux.sh
```

Outputs in `dist/`: `AltFileExplorer-<version>-linux-<arch>.tar.gz` (extract and run `./altfileexplorer`) and
the bare `AltFileExplorer-<version>-linux-<arch>.bin` binary used by the in-place updater. The binary is
dynamically linked against WebKitGTK, so the target system needs the Tauri runtime libraries (see below).
The `portable.txt` marker keeps user data beside the binary.

### Linux from Windows (WSL)

Build the Linux target locally from Windows through WSL:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-linux.ps1 -InstallDeps
```

The first run installs the WebKitGTK/GTK build dependencies in the WSL distro and Rust via rustup;
later builds can omit `-InstallDeps`. The Linux build uses `~/.cache/altfe-linux-target` inside WSL,
so its artifacts never mix with the Windows `target` folder, and the tarball is written to `dist/`.
Use `-Distro Ubuntu-24.04` to pick a specific distro or `-SkipBuild` to repackage an existing binary.

### Linux system dependencies

Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
                 build-essential curl wget file libssl-dev libxdo-dev
```

Optional thumbnail helpers:

```bash
sudo apt install ffmpeg poppler-utils
```

## Development

Prerequisites: Rust (stable), the Tauri 2 CLI (`cargo install tauri-cli --version "^2" --locked`),
and the Linux packages above if applicable.

```bash
cargo tauri dev          # run with hot frontend reload from ui/
cargo tauri build        # produce installers/bundles
cargo build --release    # plain release binary (used by the packaging scripts)
```

The frontend is plain ES modules + CSS in `ui/` — no Node.js or bundler required. Tauri embeds it into
the executable at compile time. The process model, command surface, protocols and every subsystem are
documented in [docs/Internals.md](docs/Internals.md).

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Command palette |
| `Ctrl+L` | Edit the current path |
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+P` | Toggle preview pane |
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | Grid / list / visualization |
| `Ctrl+Wheel` | Zoom grid cards / drift-scroll the list |
| `Ctrl+Middle click` | Toggle list autoscroll (panning) |
| Drag in empty space | Rubber-band select (hold `Ctrl`, `⌘`, or `Shift` to add to the selection) |
| `Ctrl+Shift+N` | New folder |
| `Ctrl+F` or `/` | Focus search |
| `Tab` | Complete a typed path in the path bar or search |
| `Enter` | Open a typed path from search |
| `.`, `:`, `\|`, `` ` ``, or `F4` | Open terminal in the active folder |
| `Ctrl+A` | Select all |
| `Ctrl+Space` | Add or remove the focused item from the selection |
| `Ctrl+Arrow` (grid), `Ctrl+Up` / `Ctrl+Down` (list) | Move focus and add both items to the selection |
| `Ctrl+Shift+A` | Invert selection |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste |
| `Alt+Left` / `Alt+Right` | Back / forward |
| `Alt+Up`, `Backspace` | Parent folder |
| `F5`, `Ctrl+R` | Refresh |
| `F2` | Rename focused item |
| `Delete` | Move selection to Trash |
| `Enter` | Open focused item |
| Arrows, `Home`, `End`, `PageUp`, `PageDown` | Move focus (hold `Shift` to extend selection); in grid view `←` / `→` move the cursor, in list view they go up / enter |
| Arrows in the tracker pattern grid | While stopped, move the tracker cursor by row (`↑`/`↓`) or pattern (`←`/`→`) |
| `Menu` (application key) | Open the context menu at the current focus; the command palette opens when nothing is selected |
| `Ctrl+Menu`, Ctrl+right-click | Command palette, bypassing the context menu |
| `Alt+Menu` | Open the window (title bar) menu on Windows |
| `Escape` | Clear search / selection, or close overlays |

Every command in the table (plus the terminal commands) can be rebound in **Settings → Keyboard shortcuts**:
click a binding, press the new chord, or unbind/reset it. Text editing, dialog navigation, and mouse
gestures keep their standard keys. Paths typed into the path bar or search complete on `Tab` relative
to the current folder (or from an absolute/`~` prefix, case-insensitively), and `Enter` in search
opens a typed path instead of filtering.

## Transparent Footprint

Everything the app writes lives in one of two places, chosen at startup:

- **Portable** (`portable.txt` beside the executable): settings, session and playlists in `<exe dir>/data`;
  thumbnails in `<exe dir>/data/thumbnails`; the treemap cache in `<exe dir>/data/viz-cache`. On Windows the
  WebView2 profile also moves to `<exe dir>/data/webview`, so the portable copy keeps its WebView data there too.
- **Installed**: settings/session in the platform app-data directory and thumbnails in the platform app-cache
  directory, both under the `dev.h3rb.altfileexplorer` identifier; the WebView2 profile stays in its default
  location.

Within that footprint every file has a clear purpose: `settings.json` is the saved session (tabs, bookmarks,
recent folders, keybindings, playback queue and playlists, appearance and browsing preferences), `thumbnails/` is
a regenerable cache capped at 512 MB, and `viz-cache/` is a regenerable treemap cache. Deleting any of it only
loses state or caches that the app rebuilds.

Nothing else on the system is modified. The only registry writes are the optional per-user **Explore in AltFile**
context-menu entries, installed and removed by the Settings button. There is no telemetry and no background
service; the app reaches the network only to check GitHub for updates and to enumerate LAN shares, and every
preview is computed locally.

## License

MIT — see [LICENSE](LICENSE).

Ogg Vorbis sample export bundles a WebAssembly build of libvorbis (BSD-3-Clause, Xiph.Org Foundation)
through wasm-media-encoders (MIT); the license texts are in `ui/vendor/`.
