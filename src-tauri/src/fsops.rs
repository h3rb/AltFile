use crate::{paths, AppState};
use notify::Watcher;
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};

const MAX_ENTRIES: usize = 20_000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub modified: u64,
    pub ext: String,
    pub kind: String,
    pub hidden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderCounts {
    pub folders: u64,
    pub files: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSize {
    pub bytes: u64,
    pub truncated: bool,
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn list_dir(path: String, show_hidden: bool) -> Result<Listing, String> {
    let dir = paths::resolve_dir(&path)?;
    let read = fs::read_dir(&dir).map_err(|e| paths::io_msg(&e, &dir))?;

    let mut entries = Vec::new();
    let mut truncated = false;

    for item in read {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().into_owned();
        let item_path = item.path();
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let hidden = paths::hidden(&name, &meta);
        if hidden && !show_hidden {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }

        let is_symlink = paths::is_reparse(&meta);
        let followed = if is_symlink {
            fs::metadata(&item_path).ok()
        } else {
            None
        };
        let effective = followed.as_ref().unwrap_or(&meta);
        let is_dir = effective.is_dir();
        let size = if is_dir { 0 } else { effective.len() };
        let ext = if is_dir {
            String::new()
        } else {
            paths::ext_of(&name)
        };
        let kind = paths::classify(&ext, is_dir);

        entries.push(Entry {
            name,
            path: paths::text(&item_path),
            is_dir,
            is_symlink,
            size,
            modified: modified_ms(effective),
            ext,
            kind: kind.to_string(),
            hidden,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    let parent = dir.parent().map(paths::text);
    Ok(Listing {
        path: paths::text(&dir),
        parent,
        entries,
        truncated,
    })
}

#[tauri::command]
pub fn folder_counts(path: String, show_hidden: bool) -> Result<FolderCounts, String> {
    let dir = paths::resolve_dir(&path)?;
    let read = fs::read_dir(&dir).map_err(|e| paths::io_msg(&e, &dir))?;

    let mut folders = 0u64;
    let mut files = 0u64;

    for item in read {
        let item = match item {
            Ok(i) => i,
            Err(_) => continue,
        };
        let name = item.file_name().to_string_lossy().into_owned();
        let item_path = item.path();
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !show_hidden && paths::hidden(&name, &meta) {
            continue;
        }
        let is_dir = if paths::is_reparse(&meta) {
            fs::metadata(&item_path)
                .map(|m| m.is_dir())
                .unwrap_or(meta.is_dir())
        } else {
            meta.is_dir()
        };
        if is_dir {
            folders += 1;
        } else {
            files += 1;
        }
    }

    Ok(FolderCounts { folders, files })
}

const SIZE_ENTRY_CAP: u64 = 300_000;
const SIZE_BUDGET_MS: u64 = 1500;

#[tauri::command]
pub fn folder_size(path: String, show_hidden: bool) -> Result<FolderSize, String> {
    let dir = paths::resolve_dir(&path)?;
    let started = Instant::now();
    let mut bytes = 0u64;
    let mut visited = 0u64;
    let mut truncated = false;

    let walker = walkdir::WalkDir::new(&dir)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if show_hidden || entry.depth() == 0 {
                return true;
            }
            match entry.metadata() {
                Ok(meta) => !paths::hidden(&entry.file_name().to_string_lossy(), &meta),
                Err(_) => true,
            }
        });

    for item in walker.flatten() {
        visited += 1;
        if visited > SIZE_ENTRY_CAP || started.elapsed().as_millis() as u64 > SIZE_BUDGET_MS {
            truncated = true;
            break;
        }
        let Ok(meta) = item.metadata() else { continue };
        if meta.is_file() {
            bytes = bytes.saturating_add(meta.len());
        }
    }

    Ok(FolderSize { bytes, truncated })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free: Option<u64>,
}

#[tauri::command]
pub fn list_places(app: tauri::AppHandle) -> Vec<Place> {
    let resolver = app.path();
    let mut places: Vec<Place> = Vec::new();

    let mut push = |id: &str, name: &str, path: Option<PathBuf>, kind: &str| {
        if let Some(p) = path {
            if p.is_dir() {
                places.push(Place {
                    id: id.to_string(),
                    name: name.to_string(),
                    path: paths::text(&p),
                    kind: kind.to_string(),
                    total: None,
                    free: None,
                });
            }
        }
    };

    push("home", "Home", resolver.home_dir().ok(), "quick");
    push("desktop", "Desktop", resolver.desktop_dir().ok(), "quick");
    push(
        "documents",
        "Documents",
        resolver.document_dir().ok(),
        "quick",
    );
    push(
        "downloads",
        "Downloads",
        resolver.download_dir().ok(),
        "quick",
    );
    push("pictures", "Pictures", resolver.picture_dir().ok(), "quick");
    push("music", "Music", resolver.audio_dir().ok(), "quick");
    push("videos", "Videos", resolver.video_dir().ok(), "quick");

    let mut seen: Vec<String> = places.iter().map(|p| p.path.to_lowercase()).collect();
    for drive in system_drives() {
        if !seen.contains(&drive.path.to_lowercase()) {
            seen.push(drive.path.to_lowercase());
            places.push(drive);
        }
    }

    places
}

#[cfg(windows)]
fn system_drives() -> Vec<Place> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetLogicalDrives, GetVolumeInformationW,
    };

    let mut out = Vec::new();
    let mask = unsafe { GetLogicalDrives() };
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = std::ffi::OsStr::new(&root)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let pc = PCWSTR(wide.as_ptr());

        let mut label_buf = [0u16; 128];
        let mut fs_buf = [0u16; 64];
        let has_info = unsafe {
            GetVolumeInformationW(
                pc,
                Some(&mut label_buf),
                None,
                None,
                None,
                Some(&mut fs_buf),
            )
        }
        .is_ok();

        let label = if has_info {
            let len = label_buf.iter().position(|c| *c == 0).unwrap_or(0);
            String::from_utf16_lossy(&label_buf[..len])
        } else {
            String::new()
        };

        let name = if label.is_empty() {
            format!("Local Disk ({letter}:)")
        } else {
            format!("{label} ({letter}:)")
        };

        let mut free = 0u64;
        let mut total = 0u64;
        let space_ok = unsafe {
            GetDiskFreeSpaceExW(
                pc,
                Some(&mut free as *mut u64),
                Some(&mut total as *mut u64),
                None,
            )
        }
        .is_ok();

        out.push(Place {
            id: format!("drive-{letter}"),
            name,
            path: root,
            kind: "drive".to_string(),
            total: if space_ok { Some(total) } else { None },
            free: if space_ok { Some(free) } else { None },
        });
    }
    out
}

#[cfg(target_os = "linux")]
fn system_drives() -> Vec<Place> {
    fn unescape_mount(s: &str) -> String {
        s.replace("\\040", " ")
            .replace("\\011", "\t")
            .replace("\\012", "\n")
    }

    const PSEUDO: &[&str] = &[
        "proc",
        "sysfs",
        "devtmpfs",
        "devpts",
        "tmpfs",
        "cgroup",
        "cgroup2",
        "pstore",
        "bpf",
        "tracefs",
        "debugfs",
        "securityfs",
        "configfs",
        "fusectl",
        "mqueue",
        "hugetlbfs",
        "ramfs",
        "overlay",
        "squashfs",
        "autofs",
        "rpc_pipefs",
        "nsfs",
        "efivarfs",
        "fuse.gvfsd-fuse",
    ];

    let mut out = vec![Place {
        id: "drive-root".to_string(),
        name: "File System".to_string(),
        path: "/".to_string(),
        kind: "drive".to_string(),
        total: None,
        free: None,
    }];
    let mut seen = vec!["/".to_string()];

    if let Ok(contents) = fs::read_to_string("/proc/mounts") {
        for line in contents.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 3 {
                continue;
            }
            let mount = unescape_mount(fields[1]);
            let fstype = fields[2];
            if PSEUDO.contains(&fstype) {
                continue;
            }
            let interesting = mount == "/"
                || mount.starts_with("/media/")
                || mount.starts_with("/mnt/")
                || mount.starts_with("/run/media/");
            if !interesting || seen.contains(&mount) {
                continue;
            }
            let name = Path::new(&mount)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| mount.clone());
            seen.push(mount.clone());
            out.push(Place {
                id: format!("drive-{mount}"),
                name,
                path: mount,
                kind: "drive".to_string(),
                total: None,
                free: None,
            });
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn system_drives() -> Vec<Place> {
    let mut out = vec![Place {
        id: "drive-root".to_string(),
        name: "Macintosh HD".to_string(),
        path: "/".to_string(),
        kind: "drive".to_string(),
        total: None,
        free: None,
    }];
    if let Ok(read) = fs::read_dir("/Volumes") {
        for item in read.flatten() {
            let p = item.path();
            if p.is_dir() {
                out.push(Place {
                    id: format!("drive-{}", paths::text(&p)),
                    name: item.file_name().to_string_lossy().into_owned(),
                    path: paths::text(&p),
                    kind: "drive".to_string(),
                    total: None,
                    free: None,
                });
            }
        }
    }
    out
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn system_drives() -> Vec<Place> {
    Vec::new()
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = paths::expand(&path);
    opener::open(&p).map_err(|e| format!("Could not open {}: {e}", p.display()))
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = paths::expand(&path);
    opener::reveal(&p).map_err(|e| format!("Could not reveal {}: {e}", p.display()))
}

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("Clipboard: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("Clipboard: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub created: u64,
    pub readonly: bool,
    pub kind: String,
    pub ext: String,
    pub dimensions: Option<(u32, u32)>,
    pub entry_count: Option<u64>,
}

#[tauri::command]
pub fn file_info(path: String) -> Result<FileInfo, String> {
    let raw = paths::expand(&path);
    let p = paths::canonical(&raw);
    let meta = fs::metadata(&p).map_err(|e| paths::io_msg(&e, &p))?;
    let is_dir = meta.is_dir();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| paths::text(&p));
    let ext = if is_dir {
        String::new()
    } else {
        paths::ext_of(&name)
    };
    let kind = paths::classify(&ext, is_dir).to_string();
    let dimensions = if kind == "image" {
        image::image_dimensions(&p).ok()
    } else {
        None
    };
    let entry_count = if is_dir {
        fs::read_dir(&p)
            .ok()
            .map(|read| read.flatten().count() as u64)
    } else {
        None
    };

    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(FileInfo {
        path: paths::text(&p),
        name,
        is_dir,
        size: if is_dir { 0 } else { meta.len() },
        modified: modified_ms(&meta),
        created,
        readonly: meta.permissions().readonly(),
        kind,
        ext,
        dimensions,
        entry_count,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreview {
    pub text: String,
    pub truncated: bool,
    pub bytes: u64,
    pub binary: bool,
    pub encoding: String,
}

#[tauri::command]
pub fn text_preview(path: String, max_bytes: Option<u64>) -> Result<TextPreview, String> {
    let p = paths::resolve_file(&path)?;
    let meta = fs::metadata(&p).map_err(|e| paths::io_msg(&e, &p))?;
    let total = meta.len();
    let limit = max_bytes.unwrap_or(96 * 1024).clamp(1024, 2 * 1024 * 1024);

    let file = fs::File::open(&p).map_err(|e| paths::io_msg(&e, &p))?;
    let mut buf = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut buf)
        .map_err(|e| paths::io_msg(&e, &p))?;
    let truncated = buf.len() as u64 > limit;
    if truncated {
        buf.truncate(limit as usize);
    }

    let (text, binary, encoding) = if buf.starts_with(&[0xFF, 0xFE]) {
        let body = &buf[2..];
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        (
            String::from_utf16_lossy(&units),
            false,
            "utf-16le".to_string(),
        )
    } else if buf.starts_with(&[0xFE, 0xFF]) {
        let body = &buf[2..];
        let units: Vec<u16> = body
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        (
            String::from_utf16_lossy(&units),
            false,
            "utf-16be".to_string(),
        )
    } else {
        let body = if buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
            &buf[3..]
        } else {
            &buf[..]
        };
        let sample = &body[..body.len().min(8192)];
        let nul = sample.iter().any(|b| *b == 0);
        let controls = sample
            .iter()
            .filter(|b| **b < 0x09 || (**b > 0x0D && **b < 0x20))
            .count();
        let binary = nul || (!sample.is_empty() && controls * 10 > sample.len());
        if binary {
            (String::new(), true, "binary".to_string())
        } else {
            (
                String::from_utf8_lossy(body).into_owned(),
                false,
                "utf-8".to_string(),
            )
        }
    };

    Ok(TextPreview {
        text,
        truncated,
        bytes: total,
        binary,
        encoding,
    })
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub done: u64,
    pub errors: Vec<String>,
    pub skipped: u64,
}

fn unique_target(dest_dir: &Path, name: &str) -> PathBuf {
    let candidate = dest_dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 2..10_000u32 {
        let candidate = dest_dir.join(format!("{stem} ({i}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dest_dir.join(format!("{stem} (copy){ext}"))
}

struct OpCtx {
    app: tauri::AppHandle,
    op: &'static str,
    done: u64,
    skipped: u64,
    errors: Vec<String>,
    last_emit: Instant,
}

impl OpCtx {
    fn new(app: tauri::AppHandle, op: &'static str) -> Self {
        Self {
            app,
            op,
            done: 0,
            skipped: 0,
            errors: Vec::new(),
            last_emit: Instant::now(),
        }
    }

    fn error(&mut self, message: String) {
        if self.errors.len() < 50 {
            self.errors.push(message);
        }
    }

    fn progress(&mut self, current: &Path, force: bool) {
        if force || self.last_emit.elapsed().as_millis() >= 90 {
            self.last_emit = Instant::now();
            let _ = self.app.emit(
                "op:progress",
                serde_json::json!({
                    "op": self.op,
                    "done": self.done,
                    "skipped": self.skipped,
                    "current": paths::text(current),
                }),
            );
        }
    }
}

fn copy_entry(src: &Path, dst: &Path, ctx: &mut OpCtx) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| paths::io_msg(&e, src))?;
    if paths::is_reparse(&meta) {
        ctx.skipped += 1;
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir_all(dst).map_err(|e| paths::io_msg(&e, dst))?;
        let read = fs::read_dir(src).map_err(|e| paths::io_msg(&e, src))?;
        for item in read {
            let item = match item {
                Ok(i) => i,
                Err(e) => {
                    ctx.error(format!("{}: {}", src.display(), e));
                    continue;
                }
            };
            let child_dst = dst.join(item.file_name());
            if let Err(e) = copy_entry(&item.path(), &child_dst, ctx) {
                ctx.error(e);
            }
        }
    } else {
        fs::copy(src, dst).map_err(|e| paths::io_msg(&e, src))?;
        ctx.done += 1;
        ctx.progress(dst, false);
    }
    Ok(())
}

fn remove_entry(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| paths::io_msg(&e, path))?;
    if meta.is_dir() {
        fs::remove_dir_all(path).map_err(|e| paths::io_msg(&e, path))
    } else {
        fs::remove_file(path).map_err(|e| paths::io_msg(&e, path))
    }
}

#[tauri::command]
pub async fn copy_paths(
    app: tauri::AppHandle,
    sources: Vec<String>,
    dest_dir: String,
    cut: bool,
) -> Result<OpResult, String> {
    if sources.is_empty() {
        return Ok(OpResult::default());
    }
    let dest = paths::resolve_dir(&dest_dir)?;
    let op_name = if cut { "move" } else { "copy" };
    let app_handle = app.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut ctx = OpCtx::new(app_handle, op_name);
        for source in sources {
            let src = paths::canonical(&paths::expand(&source));
            let meta = match fs::symlink_metadata(&src) {
                Ok(m) => m,
                Err(e) => {
                    ctx.error(paths::io_msg(&e, &src));
                    continue;
                }
            };
            if meta.is_dir() && dest.starts_with(&src) {
                ctx.error(format!(
                    "Cannot copy a folder into itself: {}",
                    src.display()
                ));
                continue;
            }
            let name = match src.file_name() {
                Some(n) => n.to_string_lossy().into_owned(),
                None => {
                    ctx.error(format!("Invalid source: {}", src.display()));
                    continue;
                }
            };
            let target = unique_target(&dest, &name);

            if cut && fs::rename(&src, &target).is_ok() {
                ctx.done += 1;
                ctx.progress(&target, true);
                continue;
            }

            if let Err(e) = copy_entry(&src, &target, &mut ctx) {
                ctx.error(e);
                continue;
            }
            if cut {
                if let Err(e) = remove_entry(&src) {
                    ctx.error(e);
                }
            }
        }
        ctx.progress(&dest, true);
        Ok(OpResult {
            done: ctx.done,
            errors: ctx.errors,
            skipped: ctx.skipped,
        })
    })
    .await
    .map_err(|e| format!("Operation failed: {e}"))?
}

#[tauri::command]
pub async fn delete_paths(items: Vec<String>) -> Result<OpResult, String> {
    if items.is_empty() {
        return Ok(OpResult::default());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let list: Vec<PathBuf> = items.iter().map(|p| paths::expand(p)).collect();
        trash::delete_all(&list).map_err(|e| format!("Could not move to trash: {e}"))?;
        Ok(OpResult {
            done: list.len() as u64,
            errors: Vec::new(),
            skipped: 0,
        })
    })
    .await
    .map_err(|e| format!("Delete failed: {e}"))?
}

fn validate_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name cannot be empty".into());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("That name is reserved".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains('\0') {
        return Err("Name cannot contain path separators".into());
    }
    if cfg!(windows)
        && trimmed
            .chars()
            .any(|c| "<>:\"|?*".contains(c) || (c as u32) < 32)
    {
        return Err("Name contains characters Windows does not allow".into());
    }
    Ok(trimmed)
}

#[tauri::command]
pub fn create_folder(parent: String, name: String) -> Result<String, String> {
    let dir = paths::resolve_dir(&parent)?;
    let name = validate_name(&name)?;
    let target = dir.join(name);
    if target.exists() {
        return Err(format!("“{name}” already exists"));
    }
    fs::create_dir(&target).map_err(|e| paths::io_msg(&e, &target))?;
    Ok(paths::text(&target))
}

#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let raw = paths::expand(&path);
    let src = paths::canonical(&raw);
    let name = validate_name(&new_name)?;
    let parent = src
        .parent()
        .ok_or_else(|| format!("Cannot rename {}", src.display()))?;
    let target = parent.join(name);
    if target == src {
        return Ok(paths::text(&src));
    }
    if target.exists() {
        return Err(format!("“{name}” already exists"));
    }
    fs::rename(&src, &target).map_err(|e| paths::io_msg(&e, &src))?;
    Ok(paths::text(&target))
}

#[tauri::command]
pub fn watch_directory(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<(), String> {
    let mut guard = state
        .watcher
        .lock()
        .map_err(|_| "Watcher state is unavailable".to_string())?;
    *guard = None;

    if let Some(p) = path {
        let dir = paths::resolve_dir(&p)?;
        let handle = app.clone();
        let mut watcher = notify::recommended_watcher(
            move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    if event.kind.is_access() {
                        return;
                    }
                    let kind = match event.kind {
                        notify::EventKind::Create(_) => "create",
                        notify::EventKind::Remove(_) => "remove",
                        notify::EventKind::Modify(_) => "modify",
                        notify::EventKind::Access(_) => "access",
                        notify::EventKind::Any => "any",
                        notify::EventKind::Other => "other",
                    };
                    let payload = serde_json::json!({
                        "kind": kind,
                        "paths": event.paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>(),
                    });
                    let _ = handle.emit("fs:changed", payload);
                }
            },
        )
        .map_err(|e| format!("Could not watch folder: {e}"))?;
        watcher
            .watch(&dir, notify::RecursiveMode::NonRecursive)
            .map_err(|e| format!("Could not watch folder: {e}"))?;
        *guard = Some(watcher);
    }
    Ok(())
}
