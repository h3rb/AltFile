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
- **Smart thumbnails** generated on demand and cached by content hash (512 MB LRU-style cache):
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
- **Folder content size**: the same tile shows the recursive size of the folder, and list view replaces the `—`
  in the size column with it. Sizes walk the tree lazily for visible rows with a time/entry budget, so a partial
  total is suffixed with `+` instead of blocking the view.
- **Font specimens**: `.ttf`, `.otf`, `.woff` and `.woff2` cards and the preview pane render the full ASCII
  sweep — `A–Z`, `a–z`, `0–9` and punctuation — in the actual typeface, loaded lazily for visible tiles through
  the `font://` protocol.
- **Archive contents**: ZIP, TAR, TAR.GZ/TGZ, TAR.BZ2/TBZ2, GZ, BZ2, RAR (4 and 5) and 7Z cards list the first
  entries, the archive format, file/folder counts, and a best-guess content type (Application, Source Code,
  Media Files, Documents, Fonts, 3D Models, Archives, or Mixed Files). ZIP indexes are read from the central
  directory without decompressing entry data; compressed tar streams are scanned with a 256 MB budget, and a
  partial result is marked with `+`. 7Z headers are decoded through their compressed (encoded) form without
  extracting file data. Password-protected ZIP, RAR and 7Z archives (including archives with encrypted headers)
  show a padlock over the card, an "Encrypted" content type, and a password-required message in the preview
  pane instead of a contents list. The preview pane shows the same contents list with total uncompressed size.
- **HTML thumbnails**: `.html` and `.htm` cards render the page itself in a live, sandboxed frame (scripts,
  forms and navigation disabled) served through the `page://` protocol, so relative stylesheets, images and
  fonts load from the file's own folder. Only visible cards mount a frame, and a bounded pool is recycled as
  you scroll.
- **Markdown thumbnails**: `.md` and `.markdown` cards show a typeset document preview instead of a generic
  file icon. Markdown is rendered to HTML on the fly (headings, lists, task lists, tables, code fences,
  quotes, links and images) and served through the same sandboxed `page://` frame, with raw HTML escaped
  and script URLs stripped.
- **Treemap visualization** for the active folder: squarified tiles, drill-down, hover tooltip, large-file and
  extension/contents insights, hidden-file support, and cancellable scans. Folder tiles show their immediate
  children nested inside so a folder's makeup is visible without drilling in.
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
- **System Menu** (Windows): right-click any drive, file or folder — including treemap tiles — and open
  the real shell context menu, with shell extensions and submenus, as a submenu of the app menu.
- **File Explorer integration** (Windows): **Settings → Windows integration → Add AltFile Context Menu Items**
  adds **Explore in AltFile** to the right-click menu for folders. It is a per-user registration and needs no
  administrator rights. Choosing it launches the app at that folder; if AltFile is already running, the window
  comes to the front and its active tab navigates there, while the second launch hands its request to the first
  instance and exits.
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
the executable at compile time.

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
| `Ctrl+Shift+N` | New folder |
| `Ctrl+F` or `/` | Focus search |
| `Ctrl+A` | Select all |
| `Ctrl+C` / `Ctrl+X` / `Ctrl+V` | Copy / cut / paste |
| `Alt+Left` / `Alt+Right` | Back / forward |
| `Alt+Up`, `Backspace` | Parent folder |
| `F5`, `Ctrl+R` | Refresh |
| `F2` | Rename focused item |
| `Delete` | Move selection to Trash |
| `Enter` | Open focused item |
| Arrows, `Home`, `End`, `PageUp`, `PageDown` | Move focus (hold `Shift` to extend selection) |
| `Menu` (application key) | Open the context menu at the current focus; the command palette opens when nothing is selected |
| `Ctrl+Menu` | Command palette, bypassing the context menu |
| `Alt+Menu` | Open the window (title bar) menu on Windows |
| `Escape` | Clear search / selection, or close overlays |

## How it works

- `src-tauri/src/fsops.rs` — directory listings, places/drives, previews, clipboard, copy/move/delete,
  folder creation, renaming, and filesystem watching (`fs:changed`).
- `src-tauri/src/thumbs.rs` — hash-keyed thumbnail cache, image decoding with orientation, Windows shell
  thumbnails, model renders for `.stl`/`.obj`/`.ply`/`.3mf`, and Linux `ffmpeg`/`pdftoppm` helpers. Served
  through the `thumb://` / `http://thumb.localhost` protocol with immutable cache headers.
- `src-tauri/src/viz.rs` — bounded recursive folder scan with progress events and generation-based
  cancellation; returns a pruned tree, largest files, and extension statistics.
- `src-tauri/src/search.rs` — fuzzy, gitignore-aware recursive filename search.
- `src-tauri/src/shellmenu.rs` — Windows shell `IContextMenu` enumeration and invocation behind the System Menu.
- `src-tauri/src/network.rs` — shared-folder discovery for the sidebar: `WNetEnumResourceW` for the browse
  list and the shell Network folder for the machines Windows discovers by itself. Both run on their own
  threads with a time budget, because a machine that is offline can stall either call for minutes.
- `src-tauri/src/fonts.rs` — streams `.ttf`/`.otf`/`.woff`/`.woff2` bytes with the right media type over the
  `font://` / `http://font.localhost` protocol so the UI can register them as live `FontFace` specimens.
- `src-tauri/src/pages.rs` — serves an HTML file and its sibling assets (CSS, images, fonts, media) over the
  `page://` / `http://page.localhost` protocol so grid cards can render the page in a sandboxed frame.
  Markdown files are converted to a styled HTML document by `md.rs` before being served the same way.
- `src-tauri/src/md.rs` — the Markdown subset renderer used for `.md` card previews: headings, fences,
  lists, tables, quotes, links and images, with raw HTML escaped and `javascript:` targets rejected.
- `src-tauri/src/settings.rs` — atomic JSON settings/session storage.
- `src-tauri/src/lib.rs` — app bootstrap, including the per-user Explorer registration under
  `Directory\shell\AltFileExplore`, and single-instance forwarding: a second launch with `--path` focuses the
  running window, navigates it, and exits.
- `src-tauri/src/mesh.rs` — mesh parsing for OBJ, STL (ASCII and binary), PLY (ASCII and binary) and
  glTF/GLB/OFF: flat triangle lists for the renderer, bounding-box extents for the Details column, and
  sampled triangle corners streamed to the preview viewer as a binary payload (with per-facet colors and a
  scene summary for 3MF).
- `src-tauri/src/threemf.rs` — the 3MF reader: its own ZIP + XML scanner, multi-file packages, build items,
  components and transforms, spec materials, Bambu/Orca and PrusaSlicer configs, and painted-region decoding.
- `src-tauri/src/render.rs` — the software rasterizer behind model thumbnails: orthographic fit, a 2×
  supersampled z-buffer, two-sided Lambert shading and depth fade, so a thumbnail needs no shell handler or GPU.
- `src-tauri/src/archive.rs` — header-only archive summaries for the cards, preview pane and Details column:
  ZIP central directory (including Zip64), TAR block headers, gzip/bzip2-decompressed tar streams, plain
  gzip/bzip2, RAR 4/5 block walks, and 7Z headers (decoded through `sevenz-rust2` when the header is encoded).
  Encryption flags (ZIP general-purpose bit 0, RAR 4/5 encryption headers, 7Z AES coders) mark an archive as
  locked so the UI can replace contents with a padlock. It also votes on a content type from entry extensions.
- `ui/js/` — the application: `files.js` (rendering, selection, lazy thumbnails), `fonts.js` (font specimens),
  `pages.js` (live sandboxed HTML and rendered Markdown card thumbnails), `details.js` (the smart Details
  column), `model.js` (rotating WebGL model preview), `viz.js` (treemap), `preview.js`, `ops.js`,
  `palette.js`, `settings.js`, and `main.js` (navigation, tabs, shortcuts).

Data locations:

- Portable (`portable.txt` beside the executable): `<exe dir>/data` and `<exe dir>/data/thumbnails`.
- Installed: platform app-data/app-cache directories (`dev.h3rb.altfileexplorer`).

## License

MIT — see [LICENSE](LICENSE).
