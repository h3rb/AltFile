# Alt File Explorer

A fast, dark, keyboard-first file explorer built with **Rust + Tauri 2**. It adds smart media
thumbnails, quick previews, fuzzy/recursive search, file operations, and a FolderExplorer-style
treemap visualization of any folder — and it builds as a portable executable for Windows and Linux.

## Features

- **Dark UI** with grid and list views, tabs, breadcrumbs, sidebar places, bookmarks, and a details pane.
- **Smart thumbnails** generated on demand and cached by content hash (512 MB LRU-style cache):
  - Windows: images (with EXIF orientation), video/audio posters, PDF and Office documents, and executable icons via the shell.
  - Linux: images, video posters through `ffmpeg`, and PDF first pages through `pdftoppm` when available.
- **Treemap visualization** for the active folder: squarified tiles, drill-down, hover tooltip, large-file and
  extension/contents insights, hidden-file support, and cancellable scans.
- **Preview pane** with media thumbnails, file metadata, image dimensions, and text previews (UTF-8/UTF-16).
- **Media previews and playlist**: audio waveforms with duration, bitrate, sample rate, and channels; video
  frame previews with hover scrubbing over the timeline; and a persistent player with a queue you can fill
  from the preview pane, context menu, or command palette (`Space` toggles playback).
- **Search** the current folder instantly, or recurse into subfolders with gitignore-aware walking.
- **File operations**: create folder, rename, copy/cut/paste with collision-safe names, reveal, properties,
  and delete to the system Trash.
- **Keyboard-first**: command palette, quick paths, vim-free arrow navigation, and standard shortcuts.
- **Portable mode**: place `portable.txt` next to the executable and settings, session, and thumbnails are kept
  in a `data` folder beside it. On Windows the WebView2 profile moves there too.
- **Session restore**: tabs, bookmarks, recent folders, thumbnail size, panel state, and the playlist persist across runs.

## Portable builds

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-windows.ps1
```

Output: `dist/AltFileExplorer-<version>-win-x64.zip` containing `altfileexplorer.exe`, `portable.txt`,
`README.md`, and `LICENSE`. Unzip anywhere and run the executable. WebView2 Runtime is required
(preinstalled on Windows 10/11; the evergreen runtime can be installed from Microsoft).

### Linux

```bash
bash scripts/package-linux.sh
```

Output: `dist/AltFileExplorer-<version>-linux-<arch>.tar.gz`. Extract and run `./altfileexplorer`.
The binary is dynamically linked against WebKitGTK, so the target system needs the Tauri runtime
libraries (see below). The `portable.txt` marker keeps user data beside the binary.

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
| `Escape` | Clear search / selection, or close overlays |

## How it works

- `src-tauri/src/fsops.rs` — directory listings, places/drives, previews, clipboard, copy/move/delete,
  folder creation, renaming, and filesystem watching (`fs:changed`).
- `src-tauri/src/thumbs.rs` — hash-keyed thumbnail cache, image decoding with orientation, Windows shell
  thumbnails, and Linux `ffmpeg`/`pdftoppm` helpers. Served through the `thumb://` / `http://thumb.localhost`
  protocol with immutable cache headers.
- `src-tauri/src/viz.rs` — bounded recursive folder scan with progress events and generation-based
  cancellation; returns a pruned tree, largest files, and extension statistics.
- `src-tauri/src/search.rs` — fuzzy, gitignore-aware recursive filename search.
- `src-tauri/src/settings.rs` — atomic JSON settings/session storage.
- `ui/js/` — the application: `files.js` (rendering, selection, lazy thumbnails), `viz.js` (treemap),
  `preview.js`, `ops.js`, `palette.js`, `settings.js`, and `main.js` (navigation, tabs, shortcuts).

Data locations:

- Portable (`portable.txt` beside the executable): `<exe dir>/data` and `<exe dir>/data/thumbnails`.
- Installed: platform app-data/app-cache directories (`dev.h3rb.altfileexplorer`).

## License

MIT — see [LICENSE](LICENSE).
