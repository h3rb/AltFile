# Internals

Alt File Explorer is a [Tauri 2](https://tauri.app/) application: one Rust process hosts a native window and a
WebView, and the entire interface is plain ES modules loaded from `ui/`. There is no bundler, no Node runtime and
no separate frontend dev server — Tauri embeds `ui/` into the executable at compile time
(`frontendDist: ../ui` in [tauri.conf.json](../src-tauri/tauri.conf.json)), so a UI change only reaches the binary
after `cargo build`. New files under `ui/` additionally need `touch src-tauri/build.rs` so Cargo re-embeds the
resource.

The split of responsibilities is strict:

- **Rust** ([src-tauri/src](../src-tauri/src)) owns the filesystem, decoders, processes, native shell integration
  and all persistence. It exposes Tauri commands and four custom protocols.
- **JavaScript** ([ui/js](../ui/js)) owns state, rendering, keyboard handling and media engines. It reaches the
  backend through `window.__TAURI__.core.invoke`, wrapped by [api.js](../ui/js/api.js).

## Process and startup

`src-tauri/src/main.rs` calls `lib::run()` in [lib.rs](../src-tauri/src/lib.rs), which:

1. Waits for a previous process left behind by an in-place update (`update::wait_for_previous`), then cleans up
   updater leftovers (`update::cleanup`).
2. Parses `--path <dir>` / `--path=<dir>` into a pending launch path.
3. In portable mode, points `WEBVIEW2_USER_DATA_FOLDER` at `<data>/webview` on Windows before the window exists.
4. Registers the single-instance plugin: a second launch forwards its `--path` through the `open-path` event and
   focuses the running window instead of opening a new one.
5. Registers the `thumb`, `media`, `font` and `page` protocols.
6. Resolves the data directories, creates `AppState`, and prunes the thumbnail cache on a background thread.
7. On Windows, starts the drive watcher (`fsops::watch_drives`).

The frontend boots from [index.html](../ui/index.html) → [main.js](../ui/js/main.js), which loads settings/session
in [state.js](../ui/js/state.js), renders the sidebar, opens the last tabs, starts watchers and wires keyboard
dispatch.

`AppState` ([lib.rs](../src-tauri/src/lib.rs)) holds the data directory, the thumbnail directory, the portable
flag, the visualization generation counter, the directory watcher handles and the pending launch path.

## Command surface

Commands are declared in the `invoke_handler` in [lib.rs](../src-tauri/src/lib.rs) and mirrored one-to-one in
[api.js](../ui/js/api.js):

| Area | Commands |
| --- | --- |
| App and Windows integration | `app_info`, `take_launch_path`, `open_window_menu`, `install_explorer_menu`, `uninstall_explorer_menu`, `explorer_menu_status` |
| Browsing | `list_dir`, `list_places`, `file_info`, `folder_counts`, `folder_size`, `folder_media`, `watch_directory` |
| Search | `search_files`, `filter_names` |
| Previews | `text_preview`, `mesh_bounds`, `mesh_geometry`, `thumbnail`, `thumbnail_cache_stats`, `clear_thumbnail_cache` |
| Archives and discs | `archive_summary`, `disc_summary`, `archive_extract`, `iso_info` |
| Network | `network_places`, `network_computers`, `cross_device_places` |
| File operations | `open_path`, `open_url`, `reveal_path`, `copy_text`, `copy_paths`, `delete_paths`, `create_folder`, `rename_path` |
| Visualization | `viz_scan`, `cancel_scan`, `viz_watch`, `viz_cache_get`, `viz_cache_put` |
| Shell menu | `shell_menu_items`, `shell_menu_invoke` |
| Storage | `load_settings`, `save_settings`, `save_png`, `save_bytes` |
| Terminal | `terminal_shells`, `terminal_start`, `terminal_read`, `terminal_write`, `terminal_resize`, `terminal_close` |
| Updater | `install_update` |

Long or blocking work (recursive scans, search, archive decoding, shell thumbnails) runs inside
`spawn_blocking` or a dedicated thread, so the IPC thread never stalls. Scans and visualizations are
cancellable by generation number rather than by killing threads.

## Protocols and events

Tauri exposes the custom protocols as `scheme://localhost/<path>` on Linux and as
`http://scheme.localhost/<path>` on Windows, because WebView2 only routes HTTP-style origins. [api.js](../ui/js/api.js)
builds the URL for the current platform.

| Protocol | Serves | Notes |
| --- | --- | --- |
| `thumb` | Cached thumbnail files (`<64-hex>.jpg` / `.png`) | Names are validated as 64 hex digits before the file is read; responses carry `Cache-Control: immutable`. The backend constructs these URLs in `thumbs::url_for`. |
| `media` | Original image/video/audio bytes | Supports HTTP `Range` and CORS headers, so large media streams and GIF hover playback work without copying files into the app. |
| `font` | `.ttf`/`.otf`/`.woff`/`.woff2` bytes | Sets the matching `font/*` media type so the UI can register a live `FontFace`. |
| `page` | HTML files plus sibling assets, and Markdown rendered to HTML | Used by sandboxed card frames; assets resolve relative to the page's own folder. |

Backend-to-frontend events:

| Event | Payload | Purpose |
| --- | --- | --- |
| `fs:changed` | `{ kind, paths }` | Non-recursive folder watching ([fsops.rs](../src-tauri/src/fsops.rs)); the active tab refreshes. |
| `drives:changed` | — | A drive was added/removed; the sidebar reloads places. |
| `open-path` | path | A second instance forwarded its `--path` argument. |
| `viz:partial` | scan counters and a summary tree | Progressive treemap drawing during a scan. |
| `viz:changed` | path | The visualized subtree changed on disk; it re-scans. |
| `op:progress` | item counts | Long copy operations update the file-operation queue. |
| `update:progress` / `update:done` | phases and report | Update download/install feedback. |

## Kind classification and listings

[paths.rs](../src-tauri/src/paths.rs) owns path normalization, home/drive expansion, hidden/reparse detection and
the extension → kind table used everywhere (`classify`). [fsops.rs](../src-tauri/src/fsops.rs) renders a directory
entry with that classification, follows symlinks only for metadata, and caps a listing at 20,000 entries so a
runaway folder cannot freeze the UI.

Before classifying, listing asks [legacy.rs](../src-tauri/src/legacy.rs) `identify(path, ext, size)`. It reads at
most 13 KB and returns a label only when the format test passes; when it does, the entry's kind becomes `legacy`
and the label travels with it. Detection is always computed; the **Support Legacy File Formats** setting is applied
in the frontend, which strips legacy kinds and the Legacy filter when it is off.

Folder metadata is lazy and budgeted:

- `folder_counts` counts immediate children for the folder card.
- `folder_size` walks recursively with a 300,000-entry / 1.5-second budget and reports `truncated` when it stops
  early, so the card can show `+`.
- `folder_media` returns the image/video thumbnails for a mosaic only when media files are more than half of the
  folder's files.

## Thumbnail pipeline

[thumbs.rs](../src-tauri/src/thumbs.rs) is the only thumbnail producer.

**Cache key.** `blake3(revision | path | size | mtime | requested size)` produces the file name. The cache is
content-independent but path-specific; changing a file or asking for a new card size creates a new key, so
entries are immutable. The cache directory is pruned at startup and whenever it grows past 512 MB, removing the
oldest files until it is back to 80%. The card grid requests 192–512 px thumbnails.

**Candidates.** Images, video, audio, executables, shortcuts, documents (except `txt`/`md`/`markdown`/`log`/`csv`/
`tsv`/`rtf`) and the four renderable model formats.

**Sources, in order:**

1. **Native image decode** with EXIF orientation. If the decoder cannot read the format, Windows falls back to the
   shell image factory; Linux returns no thumbnail.
2. **Models** (`stl`, `obj`, `ply`, `3mf`) through [mesh.rs](../src-tauri/src/mesh.rs),
   [threemf.rs](../src-tauri/src/threemf.rs) and the software rasterizer in [render.rs](../src-tauri/src/render.rs):
   orthographic fit, 2× supersampled z-buffer, two-sided Lambert shading, depth fade. 3MF carries per-facet colors
   from materials, filaments and painted regions.
3. **PDF** first page: the Windows PDF engine, or `pdftoppm` on Linux. Encrypted PDFs are detected by scanning the
   trailer for `/Encrypt`; the thumbnail call returns `locked` instead of an image.
4. **Windows shell** for everything else (video/audio posters, Office documents, executable and shortcut icons).
   Linux has no shell equivalent, so those formats keep their kind icon.

Thumbnails are converted to RGB and encoded as JPEG at quality 84, except ISO autorun icons which are cached as PNG.

## Preview and playback

[preview.js](../ui/js/preview.js) composes the pane; it never does heavy parsing itself.

- **Text** comes from `fsops::text_preview`: up to 96 KB is read (clamped to 2 MB), UTF-16 LE/BE by BOM, UTF-8
  otherwise, with binary detection. The UI displays at most 14,000 characters and marks truncation and encoding.
- **Images** are shown at natural size with dimensions. GIFs switch between the still thumbnail and the animated
  original (through the `media` protocol) on hover.
- **Audio** is decoded by the WebView; [waveform.js](../ui/js/waveform.js) streams peaks and draws the waveform.
  Clicking it seeks. The same waveform module feeds the player bar.
- **Video** uses a poster plus an inline `<video>`; preview and player bar stay in sync for the same file, and the
  timeline scrubs on hover.
- **MIDI** is rendered by the generative synth in [midi.js](../ui/js/midi.js) or, when selected, by the parsed
  SoundFont in [sf2.js](../ui/js/sf2.js). Both feed the normal audio pipeline and produce a rendered waveform.
- **Tracker modules** are decoded in [tracker.js](../ui/js/tracker.js) and
  [tracker-formats.js](../ui/js/tracker-formats.js) (pattern data, samples, per-channel panning), mixed in the
  player, and rendered as a pattern grid. [tracker-export.js](../ui/js/tracker-export.js) encodes single samples
  to WAV, FLAC or OGG Vorbis (the Vorbis encoder is the vendored `wasm-media-encoders` build in `ui/vendor/`).
- **Models** stream packed triangle corners from `mesh_geometry` into the WebGL viewer in
  [model.js](../ui/js/model.js), which rotates slowly unless **Rotate 3D models** is off.
- **HTML/Markdown** cards are not part of the preview pane: [pages.js](../ui/js/pages.js) mounts a sandboxed
  `page://` iframe per visible card and recycles a bounded pool (16 frames) with an IntersectionObserver.
- **Playlists and queue** live in [player.js](../ui/js/player.js); loop, volume and queue state are part of the
  saved session.

## Archives, extracts and discs

[archive.rs](../src-tauri/src/archive.rs) produces the summary shown on cards, in Details and in the preview:
format, best-guess content type, counts, total uncompressed bytes, the first six entries, lock state and
truncation. It parses headers only:

- ZIP central directory (including Zip64), TAR block headers, gzip/bzip2 streams with tar sniffing, plain
  gzip/bzip2, RAR 4/5 block walks, and 7Z headers (decoded through `sevenz-rust2` when encoded).
- Budgets: 256 MB scanned, 200,000 entries, 64 MB central directory; anything cut short is marked `truncated`.
- Encryption flags (ZIP bit 0, RAR encryption headers, 7Z AES coders) mark the summary `locked`; the UI replaces
  contents with a padlock.
- Content type is a vote over entry extensions, with `.exe` promoting the archive to **Application**.

[extract.rs](../src-tauri/src/extract.rs) unpacks through `zip`, `tar` + flate2/bzip2, `sevenz-rust2`, and external
`bsdtar`/`7z`/`unrar` for RAR. Entry paths are sanitized so nothing escapes the destination folder.

Disc images use dedicated readers:

- [iso.rs](../src-tauri/src/iso.rs) parses ISO 9660, Joliet and UDF, resolves paths and reads files, extracts the
  autorun label (`.disk/info` fallback) and decodes the autorun icon from ICO/PNG/BMP or PE resources into the
  thumbnail cache. It also builds the recursive contents summary.
- [disk.rs](../src-tauri/src/disk.rs) handles Atari ATR, DI, XFD and APE ProSystem images: sector mapping through
  the boot layout, DOS 2.x/MyDOS directory and VTOC walks.
- DCM/DC3/DSK and ATX are recognized as discs but have no readable directory; the UI says contents are
  unavailable instead of hiding the tile.

## Search

[search.rs](../src-tauri/src/search.rs) has two paths:

- `search_files` walks recursively with the `ignore` crate's gitignore rules (hidden optionally included),
  matching names with fuzzy subsequence scoring or with wildcard/regex patterns, and stops at a bounded result
  limit.
- `filter_names` scores an already-listed set of names for the instant, in-folder filter without touching disk.

Both refuse oversized queries, and the recursive walk runs on the blocking pool.

## Treemap

[viz.rs](../src-tauri/src/viz.rs) scans recursively with no entry cap, streams `viz:partial` snapshots and
supports cancellation through a generation counter. The returned tree is nested: root and its children are
complete, and deeper levels are expanded only into folders whose size exceeds the **depth threshold** percentage
of their parent, up to a depth and node budget. Besides the tree it returns largest files and extension stats.

[vizcache.rs](../src-tauri/src/vizcache.rs) persists completed scans to `<data>/viz-cache` as gzipped JSON
(256 MB / 48-entry budget). [viz.js](../ui/js/viz.js) keeps an in-memory LRU, draws nested levels with decreasing
opacity, watches the visualized folder for changes, merges refreshed scans in place, and treats a cache entry not
opened for 15 minutes as stale: it renders immediately and re-scans in the background.

## Sidebar discovery

[network.rs](../src-tauri/src/network.rs) runs two independent discovery paths on their own threads with time
budgets, because offline machines can stall either call for minutes: `WNetEnumResourceW` for the browse list, and
the Windows shell Network folder for machines the browse list misses. Results are merged and deduplicated.

Cross Device enumerates linked gadgets from `%USERPROFILE%\CrossDevice`. The sidebar checks portable devices once a
minute and on window focus and dims entries whose gadget is gone; hidden entries are stored in the session so
they stay hidden until the device reconnects.

## File operations and the queue

[ops.js](../ui/js/ops.js) implements the queue: operations are serialized, each emits progress, and the queue
view ([queue.js](../ui/js/queue.js)) renders it in a dedicated tab. Copy/move use `fsops::copy_paths` with the
`cut` flag (collision-safe target names via `unique_target`), delete uses the `trash` crate, and extraction
delegates to `archive_extract`. Long operations report progress through `op:progress`. Rename, new folder,
properties, reveal and open stay synchronous commands.

## Windows-specific systems

- [shellmenu.rs](../src-tauri/src/shellmenu.rs) enumerates `IContextMenu` verbs (including submenus and shell
  extensions) for the System Menu and invokes the chosen verb with the original path.
- [lib.rs](../src-tauri/src/lib.rs) registers/unregisters **Explore in AltFile** under
  `HKCU\Software\Classes\Directory\shell\AltFileExplore` and `...\Directory\Background\shell\AltFileExplore` via
  `reg.exe`, and implements the title-bar menu with `GetSystemMenu`/`TrackPopupMenu`.
- [update.rs](../src-tauri/src/update.rs) asks the GitHub releases API, picks the NSIS setup or the raw portable
  executable, downloads it, and either runs the setup in silent update mode or replaces the executable and
  relaunches. A successor process waits for its predecessor's PID before claiming the single-instance lock.

## Terminal

[terminal.rs](../src-tauri/src/terminal.rs) hosts PTYs through `portable-pty`: it lists available shells
(cmd/PowerShell/Git Bash on Windows, the default shell elsewhere), starts sessions, and exposes read/write/resize/
close commands. [terminal.js](../ui/js/terminal.js) renders xterm.js. Sessions are shut down when the window is
destroyed.

## Storage

[settings.rs](../src-tauri/src/settings.rs) reads and writes `<data>/settings.json` with a temp-file + rename so a
crash cannot leave a half-written file. The single file holds the whole snapshot built by `captureSession` in
[state.js](../ui/js/state.js): keybindings, tabs, bookmarks, recent folders, hidden devices, playback and playlist
state, preview preferences and the legacy-format toggle. Saving is debounced and best-effort; a failed save never
interrupts browsing.

[export.rs](../src-tauri/src/export.rs) writes the two user-chosen outputs: validated PNG bytes for treemap
exports and arbitrary base64 bytes for tracker sample exports.

Data locations are documented in the README under **Transparent Footprint**.

## UI module map

| Module | Responsibility |
| --- | --- |
| [main.js](../ui/js/main.js) | Bootstrap, tab/navigation model, command dispatch, keyboard routing, overlays |
| [state.js](../ui/js/state.js) | Global state, settings/session load and debounced save |
| [api.js](../ui/js/api.js) | Command wrappers, protocol URL builders, event listening |
| [files.js](../ui/js/files.js) | Grid/list rendering, selection, focus, drag out, thumbnail scheduling, card tiles |
| [preview.js](../ui/js/preview.js) | Preview pane, metadata, text/media panels |
| [player.js](../ui/js/player.js) | Playback queue, audio engines, playlists |
| [ops.js](../ui/js/ops.js) / [queue.js](../ui/js/queue.js) | File operations and the operations tab |
| [dialogs.js](../ui/js/dialogs.js) | Toasts, prompts, confirms, properties and modal shell |
| [sidebar.js](../ui/js/sidebar.js) | Places, bookmarks, network and Cross Device groups, playlists |
| [palette.js](../ui/js/palette.js) | Command palette and quick paths |
| [keyboard.js](../ui/js/keyboard.js) | Keymap definitions, rebinding and chord capture |
| [details.js](../ui/js/details.js) | Lazy Details column (counts, pixels, durations, bounds, archive/disc info) |
| [viz.js](../ui/js/viz.js) | Treemap rendering, caching, drill-down, live refresh |
| [chipfit.js](../ui/js/chipfit.js) / [mosaic.js](../ui/js/mosaic.js) / [marquee.js](../ui/js/marquee.js) | Filter pill fitting, folder mosaics, rubber-band geometry |
| [pathcomplete.js](../ui/js/pathcomplete.js) | Path-bar completion |
| [fonts.js](../ui/js/fonts.js) / [pages.js](../ui/js/pages.js) | Font specimens and sandboxed page cards |
| [model.js](../ui/js/model.js) | WebGL model viewer |
| [midi.js](../ui/js/midi.js) / [sf2.js](../ui/js/sf2.js) | General MIDI synth and SoundFont parsing |
| [tracker.js](../ui/js/tracker.js), [tracker-formats.js](../ui/js/tracker-formats.js), [tracker-export.js](../ui/js/tracker-export.js) | Module playback, decoders, sample export |
| [waveform.js](../ui/js/waveform.js) | Peak extraction and waveform drawing |
| [systemmenu.js](../ui/js/systemmenu.js) | System Menu bridge |
| [terminal.js](../ui/js/terminal.js) | xterm.js terminal pane |
| [updates.js](../ui/js/updates.js) | Update check, download progress, install |
| [icons.js](../ui/js/icons.js) / [util.js](../ui/js/util.js) | Inline SVG icons and formatting/path helpers |

## Platform differences

| Feature | Windows | Linux |
| --- | --- | --- |
| Image fallback | Shell image factory | Built-in decoder only |
| Video posters | Shell | `ffmpeg` |
| PDF pages | Windows PDF engine | `pdftoppm` (poppler-utils) |
| Office/document thumbnails | Shell, when a handler is installed | None |
| Executable icons | Shell icons | None |
| System Menu, window menu, Explorer registration | Yes | Hidden |
| Network / Cross Device sidebar groups | Yes | Hidden |
| Terminal shells | cmd, PowerShell, Git Bash | Default shell from `$SHELL` |

## Tests

Rust unit tests live beside the code (`#[cfg(test)]` modules in the backend files, covering classification,
archive parsing, ISO/UDF, Atari disks, legacy sniffers, mesh bounds, the rasterizer, extraction safety and merge
rules). Frontend logic with no DOM dependency is tested from `scripts/` with plain Node scripts
(`test-chips.mjs`, `test-keyboard.mjs`, `test-marquee.mjs`, `test-mosaic.mjs`, `test-tracker.mjs`).
