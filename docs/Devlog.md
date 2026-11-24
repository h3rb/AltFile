# Devlog

A chronological record of how Alt File Explorer was built, from an empty repository on 2026-11-03 to the
current tree. It is reconstructed from the session export kept in `untracked/` (169 requests), the git history
and the published GitHub release notes; every milestone below corresponds to a real commit or release.

**Shape of the project so far:** 169 user requests, 26 commits, 26 tags (`preview`, `v0.1.0`, `v0.2.0`–`v0.2.23`)
and 25 published releases (including the `preview` pre-release) in three weeks. Development runs in request
batches: a feature request or a group of related refinements, then "commit, push, tag, release", which produces
one broad commit, one annotated tag and one release — carrying five platform assets since `v0.2.8`.

## Timeline

| Version | Tagged | Commit | Theme |
| --- | --- | --- | --- |
| `preview` | 2026-11-03 | `b1dbf2d` | Initial portable build, pre-release |
| `v0.1.0` | 2026-11-04 | `4d5a755` | First tagged release: explorer core, media, treemap, System Menu |
| `v0.2.0` | 2026-11-04 | `115fc99` | Archive previews, network shares, 3D thumbnails, playlists |
| `v0.2.1` | 2026-11-04 | `1759d9a` | 3D orientation patch (tag only, no release object) |
| `v0.2.2` | 2026-11-05 | `8e36f6c` | HTML thumbnails, drag-out, 3D controls, theme hue |
| `v0.2.3` | 2026-11-11 | `7724f85` | 7z, Explorer context menu, playlist sidebar |
| `v0.2.4` | 2026-11-11 | `ba47c12` | Move audio waveform to the list view |
| `v0.2.5` | 2026-11-11 | `8021aaa` | Brighter list-view waveforms |
| `v0.2.6` | 2026-11-11 | `c471da7` | Update check with a version pill |
| `v0.2.7` | 2026-11-14 | `8c652e8` | Colored 3MF, Markdown cards, padlocks, Menu key |
| `v0.2.8` | 2026-11-14 | `5f2053f` | In-place updates for portable and NSIS installs |
| `v0.2.9` | 2026-11-14 | `a02fe6e` | ISO autorun icons and labels |
| `v0.2.10` | 2026-11-15 | `4f22f6d` | MIDI/SoundFont playback, RAR listings, date column |
| `v0.2.11` | 2026-11-15 | `3e0db38` | MIDI endianness fix |
| `v0.2.12` | 2026-11-16 | `a724325` | Extract To, treemap rewrite with streaming scans |
| `v0.2.13` | 2026-11-16 | `93a07fe` | Live treemap refresh and nested contents |
| `v0.2.14` | 2026-11-16 | `88cc527` | Non-destructive treemap refresh, always-on navigation |
| `v0.2.15` | 2026-11-16 | `47efd71` | Depth-threshold slider, treemap cache, menu toggle |
| `v0.2.16` | 2026-11-20 | `f603624` | Terminal, rebindable shortcuts, search modes |
| `v0.2.17` | 2026-11-20 | `215c22c` | Folder mosaics, treemap actions, adaptive filter pills |
| `v0.2.18` | 2026-11-20 | `6234ecf` | Folder cards as outline frames |
| `v0.2.19` | 2026-11-21 | `7d5109a` | Rubber-band selection |
| `v0.2.20` | 2026-11-21 | `db19640` | Gradient selection and cursor-based grid navigation |
| `v0.2.21` | 2026-11-22 | `1875d58` | Windows Cross Device section |
| `v0.2.22` | 2026-11-23 | `e643917` | Disconnected devices flagged and hideable |
| `v0.2.23` | 2026-11-24 | `82a9a0b` | Legacy formats, disc contents, tracker playback, operation queue |

After `v0.2.23`: Ctrl+right-click parity, the README audit, `docs/Internals.md` and this file. Those changes are
unreleased at the time of writing.

## 1. Genesis: an empty folder to v0.1.0 (Nov 3–4)

The project opened with a single brief: a Rust + Tauri 2 alternative file explorer with smarter options, media
thumbnails, portable builds for Windows and Linux, a dark UI and a FolderExplorer-style visualization of the
current folder. The first architectural calls shaped everything after it:

- **Tauri 2 with a plain ES-module frontend.** No bundler, no Node runtime, no dev server — `ui/` is embedded
  into the executable, which keeps the portable story simple.
- **Rust owns the filesystem and decoding.** Thumbnails were planned around the `image` crate, Windows shell
  image factories for formats the decoder cannot read, `ffmpeg` on Linux, and later software rendering for 3D.
- **Portable-first state.** Settings, session and thumbnails live in a `data` folder next to the executable when
  `portable.txt` is present, later extended to the WebView2 profile.
- **A treemap as the third view**, computed in Rust from a size scan rather than read from an external index.

The first day then added the conveniences that defined the feel of the app: the focused path in the title bar
with **Copy to Clipboard**, command-palette-style navigation, folder icons and recursion inside the visualizer,
playlist queueing with waveform and video previews, a Linux target built through WSL, and the MIT license.
Font specimens, recursive folder sizes and counts, and the real Windows **System Menu** (shell
`IContextMenu` verbs, including submenus) followed. The first tagged build, `v0.1.0`, shipped two archive assets
and already included grid, list and treemap views, tabs, breadcrumbs, bookmarks, a details pane, fuzzy
gitignore-aware search, a command palette and keyboard navigation.

Note: the visualizer originally exposed a recursive depth setting (default 64, up to 255). That idea was
abandoned in `v0.2.12` when the treemap was rebuilt around one level per scan plus drill-down.

## 2. Media depth and document previews (v0.2.0–v0.2.2, Nov 4–5)

`v0.2.0` was the first large breadth pass: a smart Details column that shows per-kind metadata (duration, pixel
dimensions, child counts, model bounds), `File: EXT` labels in the Kind column, a global search-scope setting,
the Windows **Network** group, software-rendered STL/PLY/OBJ/3MF thumbnails with a rotating preview, archive
summaries and entry lists, named playlists, GIF hover playback, muted video hover, video playback with a
hover-scrubbed timeline, a slow 3D rotation, `.lnk` shortcut badges, and a beat-reactive pulse on the card of
the playing track.

`v0.2.1` was a pure patch: the rotating 3D model rendered upside down compared with its thumbnail. It was
committed and tagged but never published as a GitHub release — the only tag in that state.

`v0.2.2` pushed previews further: sandboxed `.html`/`.htm` cards with sibling assets, drag files out to other
applications, a **Rotate 3D models** toggle, the theme hue slider, a full ASCII font sweep, a spectrum analyzer
on the playing card, and denser double-sided model rendering after a user-supplied STL exposed winding and
facet-budget problems.

## 3. Platform integration and playlist workflow (v0.2.3–v0.2.6, Nov 11)

`v0.2.3` moved the app into the operating system: `.7z` summaries (including encoded headers and solid
archives), the optional **Explore in AltFile** Explorer verb, single-instance behavior with `--path <folder>`,
restored focus and navigation from a second launch, playlists in the sidebar with drag-and-drop targets, folder
cards badged with audio/video/3D hints, and a tab context menu. It also introduced the audio waveform on details
— in the wrong place, which the next release corrected.

The next three releases were deliberate corrections rather than new scope: `v0.2.4` moved the waveform behind
filenames in the list view (not the preview pane), `v0.2.5` brightened it, and `v0.2.6` added the update check:
ask the GitHub releases API at most every six hours and show a version pill on the Settings button. **Get
update** at this point only opened the release page, which directly motivated the next chapter.

## 4. Models, documents and discs (v0.2.7–v0.2.9, Nov 14)

`v0.2.7` made 3MF a first-class format: core-spec materials, color groups, composites, Bambu/Orca/PrusaSlicer
filaments and painted regions, with vertex-clustering simplification for very large plates. The same release
added Markdown cards, padlocks for encrypted archives and PDFs, playlist expansion in the sidebar, list
drift/autoscroll gestures, breadcrumb folder menus, and the full Menu-key matrix (context, palette, window menu,
browser menu suppressed).

`v0.2.8` delivered real in-place updates: NSIS installs download `-setup.exe` and run it silently, portable
copies download the bare executable, swap it once the old process exits and relaunch. This is the point where
each release grew from two archives to five assets (Windows zip, setup, bare exe; Linux tarball and bare
binary), because the updater depends on them.

`v0.2.9` taught the app to read disc metadata: autorun labels and icons, root ICO files, `.disk/info` and
volume-label fallbacks, ICO/PNG/BMP and PE resource extraction, and read-only ISO 9660/Joliet/UDF parsing.

## 5. Audio breadth and the treemap rewrite (v0.2.10–v0.2.15, Nov 15–17)

`v0.2.10` added MIDI playback through a generative General MIDI synth, SF2 SoundFont cards and activation,
RAR 4/5 listings, type-to-filter focus, and a single Date column (the latest of modified or created) replacing
the platform-specific column set. MIDI shipped silent; `v0.2.11` was a targeted parser fix: Standard MIDI File
headers and track chunks are big-endian and had been parsed little-endian.

`v0.2.12` began the treemap rework with a clear diagnosis: drive-level maps were wrong because folder sizes were
capped at 600,000 entries, and one level of depth is enough if every folder carries its full recursive size.
The release removed the cap, returned one level per scan, re-scanned on drill-down with breadcrumb history, and
streamed partial layouts during the scan with navigation locked; the old scan-depth setting disappeared. It also
added **Extract To…** for archives and fixed date sorting to use the same touched date shown in the list.

The next three releases refined that foundation:

- `v0.2.13` sized top-level tiles by full contents, watched the displayed subtree and re-scanned on change, and
  nested contents inside folders that exceed 20% of their section — 75% opacity, fading 5% per level to a 25%
  floor, with node/depth/entry budgets and cancellation.
- `v0.2.14` stopped discarding the map when a background scan finished: deltas merge into the displayed tree and
  preserve hover, selection and ordering, and navigation stays live during streaming or stale scans. The user
  had to ask twice, which is recorded here as a signal that "do not blank the canvas" was the real requirement.
- `v0.2.15` exposed the depth threshold as a 1–50% slider (default 1%), added a gzipped on-disk scan cache
  (roughly 256 MB / 48 entries) with instant redraws, and re-scanned cached maps older than 15 minutes in the
  background. It also fixed the Windows 11 Explorer integration (background registration; classic menu via
  **Show more options**) and made the Settings button toggle installation and removal.

## 6. Input, terminal and search (v0.2.16–v0.2.18, Nov 20)

`v0.2.16` was the interaction release: fully rebindable keyboard shortcuts with scopes, conflict rejection, reset
and unbind; a portable-pty terminal rendered by xterm.js; DOS wildcard and regex search modes that can be
combined; live drive/share refresh (prompted by a VHDX that never appeared); and arrow-key folder navigation.

`v0.2.17` added folder mosaics (when more than half the files are images/videos, packed with a configurable pick
order), treemap right-click actions (new tab, one tab per first-level folder, PNG export), adaptive filter pills
that shed labels and then non-pinned pills, Tab path completion, and the rule that any archive containing an
`.exe` is **Application**.

`v0.2.18` replaced the folder glyph in grid cards with a thin folder-with-tab outline framing the content. It
took three passes: widen the rim for subpixel rendering, tint the interior and invert the glow to fade inward,
then fix cropped right and bottom edges by stroking inside the paint box.

## 7. Selection and navigation model (v0.2.19–v0.2.20, Nov 21)

`v0.2.19` added rubber-band selection in grid and list view, including whole-row drags from the list margin and
Ctrl/Shift augmentation. One bug report in this batch was withdrawn by the user ("it was me playing with it"), a
reminder that not every observed anomaly is a defect.

`v0.2.20` separated "selected" from "focused": selection uses the teal-to-blue drive-meter gradient while the
cursor keeps the accent ring. It added `Ctrl+Space` toggling, `Ctrl+Arrow` add-and-move selection, `Ctrl+Shift+A`
invert, **Select all**/**Invert selection** in the context menu, row-wise Up/Down in the grid, and Left/Right as
cursor movement in the grid (list view keeps enter/leave semantics). The steering here was iterative: the user
refined list-only arrows and grid semantics over three consecutive prompts.

## 8. Devices, legacy formats and trackers (v0.2.21–v0.2.23, Nov 22–24)

`v0.2.21` listed Windows Cross Device gadgets in their own sidebar section, opening like folders. `v0.2.22`
sharpened the lifecycle: disconnected gadgets stay visible but dimmed, availability is re-checked once a minute
while visible (and on focus), and **Remove from view** hides one until it reconnects. The first request asked to
remove disconnected devices outright; the user changed the requirement to "indicate is disconnected" mid-batch.

`v0.2.23` was the largest single release and consolidated several long threads:

- **Tracker modules** (`.mod`, `.stm`, `.s3m`, `.s3i/.s3t`, `.xm`, `.it`, `.mptm` and compressed variants) with
  a built-in mixer, pattern-grid preview, click-to-seek rows, keyboard cursor movement, a sound bank with
  per-sample audition, and **Export as…** / **Quick Export** to OGG Vorbis, FLAC or WAV.
- **Legacy formats** behind **Support Legacy File Formats**: content-based tests for MS-DOS, Amiga, Commodore
  and Atari files so only files that pass the sniff join the Legacy group. The user corrected the semantics:
  Legacy is a group, not a label — cards show the real kind (ATR/XEX/CAS, DI/XFD/APE/ATX, CART, ARC/LZH/LZW,
  tokenized BASIC, MAC/65, fonts, GR8/GR9/G15 pictures, SAP/SID/NSF/RMT/CMC/ProTracker music, and more).
  Legacy ARC/LZH archives list their contents like ZIP/7Z.
- **Disc contents** for ISO and Atari disk images, with disc-style thumbnails, filesystem/volume metadata and
  counts; copy-protected DCM/ATX images report that contents cannot be listed.
- **A file-operation queue** in a dedicated tab for copies, moves, deletes and extractions, opened automatically
  when work is queued.
- **Ogg Vorbis** playback and export support.

A completeness audit against Jindroush's Atari format table was run twice: 77 of 97 extensions covered, 11
missing, 9 blocked by conflicts or missing samples. Work then continued on the remaining gaps, excluding the
blocked set.

## 9. Documentation (Nov 24, unreleased)

Ctrl+right-click was made equivalent to Ctrl+Menu. The README was then audited against the code and expanded
with a supported-file-types table: what is detected, how content sniffing works, what thumbnail and preview each
kind gets, and which actions apply. Finally the architecture description was moved out of the README into
[docs/Internals.md](Internals.md) and expanded (process model, command surface, protocols and events, thumbnail
pipeline, previews, archives, treemap, storage, platform differences), while portable-data details stayed in the
README under **Transparent Footprint**.

## Recurring patterns

**Thumbnails are the product.** Nearly every chapter adds a format: shell images and posters, 3D, archives,
fonts, HTML, PDF, Markdown, SoundFonts, ISO autorun art, tracker modules, legacy formats. Previews and Details
follow the same format coverage, so a new decoder usually lands in three places at once.

**Portability is maintained through updates.** Portable mode governs state, caches and WebView2 data; the
updater had to learn both NSIS and replace-in-place before it could be called complete.

**Budgets everywhere.** 13 KB legacy sniffs, 256 MB/200k-entry archive scans, 20,000 listing entries, 512 MB
thumbnail cache, 20,000-node treemap enrichment, 96 KB text previews, 2 MB regex limits. The treemap chapters
show the pattern clearly: remove an arbitrary cap, replace it with recursive accounting plus explicit budgets.

**Windows integration grows by request.** System Menu, Explorer verb, drives/network discovery, Cross Device,
classic-menu registration and the updater all came from concrete user scenarios (a VHDX mount, a Windows 11
right-click, an offline NAS).

**Verification and release discipline.** Batches are verified in the running UI (source build and packaged
build via CDP), both platform packages are rebuilt, the version is bumped in the three version files, one broad
commit is made, and the five release assets are published. Two packaging pitfalls recur in the log: bundling
fails with `os error 32` if any app or test instance is still running, and Linux packages built with
`-SkipBuild` silently embed a stale UI because the frontend is compiled into the binary.

**The user drives precision.** Many releases are single-purpose corrections (waveform placement, 3% of a glow,
one edge line, a label rename, a key binding). Two requirements changed after being stated: disconnected
devices stay visible, and Legacy is a group rather than a label.

## Appendix: request index

Each row is one user request in the session export; `#` is its position.

| # | Shipped | Request |
| --- | --- | --- |
| 1 | preview | Init repo; Rust/Tauri 2 explorer with thumbnails, portable builds, dark mode, treemap |
| 2 | v0.1.0 | Show focused path in the title bar; add Copy to Clipboard |
| 3 | v0.1.0 | Folder icons in the visualizer; recursive depth setting (default 64) |
| 4 | v0.1.0 | Remove the background from the Windows app icon |
| 5 | v0.1.0 | Playlists; audio waveform/metadata; video preview and hover timeline |
| 6 | v0.1.0 | Add a Linux target |
| 7 | v0.1.0 | Commit all changes |
| 8 | v0.1.0 | Click a waveform to start playback at that position |
| 9 | v0.1.0 | Show first-level contents inside visualizer folders |
| 10 | v0.1.0 | Full-size folder icon with folder/file counts in grid |
| 11 | v0.1.0 | Enlarge folder icon and count text by 25% |
| 12 | v0.1.0 | Hover text: "of &lt;total&gt;" instead of "of view" |
| 13 | v0.1.0 | Move app identity and Portable pill into the Settings header |
| 14 | v0.1.0 | System Menu submenu with real shell verbs for drives/files/folders |
| 15 | v0.1.0 | Font thumbnails render AaBbCc…Zz0123 |
| 16 | v0.1.0 | Folder content size in grid and list |
| 17 | v0.1.0 | Add MIT license |
| 18 | v0.1.0 | Resume interrupted work |
| 19 | v0.1.0 | Do font thumbnails first |
| 20 | v0.1.0 | Add MIT LICENSE at repo root |
| 21 | v0.1.0 | Rebuild, commit, tag, push, attach dist to a release |
| 22 | v0.2.0 | Per-kind details column (duration, W×H, counts, bounds) |
| 23 | v0.2.0 | Kind column shows "File: EXT" |
| 24 | v0.2.0 | Folder-vs-subfolder search scope becomes a setting |
| 25 | v0.2.0 | Network section under This PC with shared folders |
| 26 | v0.2.0 | 3D thumbnails for STL/PLY/OBJ/3MF |
| 27 | v0.2.0 | Archive thumbnails with counts and content guess |
| 28 | v0.2.0 | Animate GIFs on hover in grid and preview |
| 29 | v0.2.0 | Advance video in the preview when Play is pressed |
| 30 | v0.2.0 | Muted video playback on grid hover |
| 31 | v0.2.0 | Slowly rotate 3D models in the preview |
| 32 | v0.2.0 | Play icon only for audio/video; open icon otherwise |
| 33 | v0.2.0 | Label `.lnk` as Shortcut and overlay a link icon |
| 34 | v0.2.0 | Widen Clear filters so it does not wrap |
| 35 | v0.2.0 | Save queue to an existing or newly named playlist |
| 36 | v0.2.0 | Pulse grid thumbnail shading to the beat |
| 37 | v0.2.0 | Commit everything and push |
| 38 | v0.2.0 | Build and publish a release |
| 39 | v0.2.1 | Fix upside-down rotating model |
| 40 | v0.2.1 | Patch, rebuild, tag, push |
| 41 | v0.2.2 | Spectrum/oscilloscope overlay on the playing audio card |
| 42 | v0.2.2 | Display model polygons double-sided |
| 43 | v0.2.2 | Repro STL: BT Assembled Space Base |
| 44 | v0.2.2 | Render HTML/HTM in grid thumbnails |
| 45 | v0.2.2 | Full letter/number/punctuation font sweep |
| 46 | v0.2.2 | Drag files out to other applications |
| 47 | v0.2.2 | Setting to disable 3D auto-rotation |
| 48 | v0.2.2 | Theme hue slider under Settings → Appearance |
| 49 | v0.2.2 | Commit, tag, push, release |
| 50 | v0.2.3 | Rename tab copy action to Copy path to clipboard |
| 51 | v0.2.3 | Bookmark command in the tab menu |
| 52 | v0.2.3 | Playlist picker; sidebar playlists setting |
| 53 | v0.2.3 | Waveform behind the audio filename in Details |
| 54 | v0.2.3 | Folder cards hint at contained audio/video/3D |
| 55 | v0.2.3 | Loop toggle next to Play; loop on by default |
| 56 | v0.2.3 | Loop toggle on the bottom player |
| 57 | v0.2.3 | Settings button adds Explore in AltFile to Explorer |
| 58 | v0.2.3 | 7z support |
| 59 | v0.2.3 | Rebuild, commit, tag, push, release |
| 60 | v0.2.4 | Waveform belongs behind filenames in list view, not preview |
| 61 | v0.2.4 | Commit, push, release |
| 62 | v0.2.5 | Brighten list-view waveforms |
| 63 | v0.2.5 | Commit, push, release |
| 64 | v0.2.6 | Update check with a version pill on Settings |
| 65 | v0.2.6 | Commit, push, release |
| 66 | v0.2.7 | Drag files onto sidebar playlists |
| 67 | v0.2.7 | "+" button next to Playlists |
| 68 | v0.2.7 | PDF page thumbnails; padlock when encrypted |
| 69 | v0.2.7 | Markdown thumbnails |
| 70 | v0.2.7 | Padlock for encrypted archives |
| 71 | v0.2.7 | Ctrl+wheel zooms grid cards |
| 72 | v0.2.7 | List Ctrl+wheel drift and Ctrl+middle autoscroll |
| 73 | v0.2.7 | Playlist right-click lists tracks; click to play |
| 74 | v0.2.7 | Breadcrumb right-click equals folder right-click |
| 75 | v0.2.7 | Remove "Quick Access" heading |
| 76 | v0.2.7 | Menu key opens context, defaults to palette |
| 77 | v0.2.7 | Ctrl+Menu always opens the palette |
| 78 | v0.2.7 | Alt+Menu opens the window menu |
| 79 | v0.2.7 | Menu key: suppress the browser context menu |
| 80 | v0.2.7 | 3MF previews with materials and colors |
| 81 | v0.2.7 | Document, commit, push, release |
| 82 | v0.2.7 | Resume |
| 83 | v0.2.8 | Get update downloads and installs in place (NSIS or portable) |
| 84 | v0.2.8 | Document, commit, push, release |
| 85 | v0.2.9 | ISO thumbnails use autorun icon and label |
| 86 | v0.2.9 | Resume |
| 87 | v0.2.9 | Commit, push, release |
| 88 | v0.2.10 | Remove the Modified column on Windows |
| 89 | v0.2.10 | RAR content listings |
| 90 | v0.2.10 | Sort labels include extensions ("Archive ZIP") |
| 91 | v0.2.10 | Typing with no text box focuses the filter |
| 92 | v0.2.10 | One date column with the latest touched date |
| 93 | v0.2.10 | Clarification: in list view |
| 94 | v0.2.10 | Resume interrupted work |
| 95 | v0.2.10 | SF2 sound fonts; default generative synth for MIDI |
| 96 | v0.2.10 | Tag, commit, push, release |
| 97 | v0.2.11 | MIDI files still not playing |
| 98 | v0.2.11 | Commit, push, tag, release |
| 99 | v0.2.12 | Extract To… for archives |
| 100 | v0.2.12 | Fix date sort; show date and time |
| 101 | v0.2.12 | Remove treemap entry cap; recursive sizes, one level |
| 102 | v0.2.12 | Populate treemap while scanning; lock navigation |
| 103 | v0.2.12 | Keep one-level content hints |
| 104 | v0.2.12 | Commit, push, tag, release |
| 105 | v0.2.13 | Size level-1 treemap folders by contents |
| 106 | v0.2.13 | Update the treemap when subfolders change |
| 107 | v0.2.13 | Nest >20% folders at 75% opacity, fading to 25% |
| 108 | v0.2.13 | Commit, push, tag, release |
| 109 | v0.2.14 | Merge scan deltas instead of discarding the map |
| 110 | v0.2.14 | Allow navigation on a stale map |
| 111 | v0.2.14 | Repeat: incomplete or stale maps must stay navigable |
| 112 | v0.2.15 | Change the nesting threshold from 20% to 1% |
| 113 | v0.2.15 | Slider for the threshold (1–50%) |
| 114 | v0.2.15 | Cache visualizations; refresh stale entries on access |
| 115 | v0.2.15 | Explorer verb not visible on Windows 11 |
| 116 | v0.2.15 | Toggle button to remove the Explorer verbs |
| 117 | v0.2.15 | Commit, push, tag, release |
| 118 | v0.2.16 | Detect newly mounted drives (VHDX) |
| 119 | v0.2.16 | "." or ":" opens a terminal; backslash cycles shells |
| 120 | v0.2.16 | Right enters, Left goes up, Right on file opens preview/menu |
| 121 | v0.2.16 | DOS wildcards and regex, each toggleable, combinable |
| 122 | v0.2.16 | Rebind keyboard commands in Settings |
| 123 | v0.2.16 | Resume, commit, push, tag, release |
| 124 | v0.2.17 | Default shell setting |
| 125 | v0.2.17 | Tab completion in search and path editing |
| 126 | v0.2.17 | Pipe/backtick/F4 opens the terminal (not tilde) |
| 127 | v0.2.17 | "Pipe" means Shift+Backslash on US keyboards |
| 128 | v0.2.17 | Archive with any EXE is Application |
| 129 | v0.2.17 | Unbind "/" from terminal hotkeys |
| 130 | v0.2.17 | Folder mosaics over 50% media with bin packing |
| 131 | v0.2.17 | Visualize in new tab; one tab per first-level folder |
| 132 | v0.2.17 | Also export the visualization as PNG |
| 133 | v0.2.17 | Filter pills only for present kinds; adapt to width |
| 134 | v0.2.17 | Commit, push, tag, release |
| 135 | v0.2.18 | Folder outline frames instead of the folder glyph |
| 136 | v0.2.18 | Slightly wider rim; subtle interior tint |
| 137 | v0.2.18 | Invert the folder glow to fade inward |
| 138 | v0.2.18 | Right edge line is cropped (screenshot) |
| 139 | v0.2.18 | Bottom edge line is also cropped |
| 140 | v0.2.18 | Commit, push, tag, release |
| 141 | v0.2.19 | Rubber-band selection in grid and list margin |
| 142 | v0.2.19 | Withdrawn report: "it was me playing with it" |
| 143 | v0.2.19 | Shift augment for rubber band; update docs |
| 144 | v0.2.20 | Distinct selection gradient; Ctrl+Arrow/Space; invert/select all |
| 145 | v0.2.20 | List view: only Ctrl+Up/Down move selection |
| 146 | v0.2.20 | Grid Up/Down move one full row |
| 147 | v0.2.20 | Grid Left/Right only move the cursor |
| 148 | v0.2.20 | Commit, push, tag, release |
| 149 | v0.2.21 | Windows Cross Device section under Network |
| 150 | v0.2.21 | Commit, push, tag, release |
| 151 | v0.2.22 | Remove Cross Device entries when disconnected |
| 152 | v0.2.22 | Change of mind: indicate disconnected instead |
| 153 | v0.2.22 | Remove from view for disconnected devices |
| 154 | v0.2.22 | Commit, push, tag, release |
| 155 | v0.2.23 | Tracker formats, preview tracker, WAV/MIDI conventions |
| 156 | v0.2.23 | Preview action buttons right after the path |
| 157 | v0.2.23 | Sound bank audition; samples in tracker previews |
| 158 | v0.2.23 | Queue tab, sample export, tracker cursor, legacy setting, Atari formats |
| 159 | v0.2.23 | Legacy is a group, not a label |
| 160 | v0.2.23 | Ogg Vorbis support |
| 161 | v0.2.23 | Completeness report vs Jindroush's Atari table |
| 162 | v0.2.23 | Continue implementing legacy extensions |
| 163 | v0.2.23 | Legacy archives show internal files |
| 164 | v0.2.23 | Revise the legacy coverage report |
| 165 | v0.2.23 | Disc thumbnails and contents for all disc images |
| 166 | v0.2.23 | Finish remaining gaps except the 9 blocked |
| 167 | v0.2.23 | Commit, push, tag, release |
| 168 | unreleased | Ctrl+right-click equals Ctrl+Menu |
| 169 | unreleased | Audit README; add supported-file-types table |

## See also

- [README.md](../README.md) — user-facing features, formats and footprint.
- [docs/Internals.md](Internals.md) — how the code works today.
