use crate::{paths, AppState};
use serde::Serialize;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, State};

const MAX_SCAN_ENTRIES: u64 = 600_000;
const MAX_CHILDREN: usize = 4_000;
const LARGE_FILE: u64 = 256 * 1024;
const TOP_N: usize = 50;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct VizNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub ext: String,
    pub kind: String,
    pub file_count: u64,
    pub dir_count: u64,
    pub children: Vec<VizNode>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TopFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub ext: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtStat {
    pub ext: String,
    pub bytes: u64,
    pub files: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VizResult {
    pub path: String,
    pub root: VizNode,
    pub total_size: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub errors: u64,
    pub truncated: bool,
    pub elapsed_ms: u64,
    pub top_files: Vec<TopFile>,
    pub ext_stats: Vec<ExtStat>,
    pub include_hidden: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VizProgress {
    gen: u64,
    root: String,
    scanned: u64,
    bytes: u64,
    current: String,
}

struct ScanCtx<'a> {
    app: &'a tauri::AppHandle,
    gen: u64,
    current_gen: Arc<AtomicU64>,
    include_hidden: bool,
    max_depth: u32,
    scanned: u64,
    bytes: u64,
    errors: u64,
    truncated: bool,
    cancelled: bool,
    last_emit: Instant,
    root_label: String,
    top: BinaryHeap<Reverse<(u64, u64, String, String, String)>>,
    counter: u64,
    ext: HashMap<String, (u64, u64)>,
}

impl<'a> ScanCtx<'a> {
    fn step(&mut self, dir: &Path) -> bool {
        self.scanned += 1;
        if self.scanned > MAX_SCAN_ENTRIES {
            self.truncated = true;
            return false;
        }
        if self.scanned % 128 == 0 {
            if self.current_gen.load(Ordering::Relaxed) != self.gen {
                self.cancelled = true;
                return false;
            }
            if self.last_emit.elapsed().as_millis() >= 110 {
                self.last_emit = Instant::now();
                let _ = self.app.emit(
                    "viz:progress",
                    VizProgress {
                        gen: self.gen,
                        root: self.root_label.clone(),
                        scanned: self.scanned,
                        bytes: self.bytes,
                        current: paths::text(dir),
                    },
                );
            }
        }
        true
    }

    fn record(&mut self, name: &str, path: &Path, len: u64) {
        let ext = paths::ext_of(name);
        let entry = self.ext.entry(ext.clone()).or_insert((0, 0));
        entry.0 += len;
        entry.1 += 1;
        if len >= LARGE_FILE {
            self.counter += 1;
            self.top.push(Reverse((
                len,
                self.counter,
                name.to_string(),
                paths::text(path),
                ext,
            )));
            if self.top.len() > TOP_N {
                self.top.pop();
            }
        }
    }
}

fn scan_dir(path: &Path, name: String, depth: u32, ctx: &mut ScanCtx) -> VizNode {
    let mut node = VizNode {
        name,
        path: paths::text(path),
        is_dir: true,
        kind: "folder".to_string(),
        ..Default::default()
    };
    if ctx.cancelled {
        return node;
    }

    let read = match fs::read_dir(path) {
        Ok(r) => r,
        Err(_) => {
            ctx.errors += 1;
            return node;
        }
    };

    let mut leftover_size = 0u64;
    let mut leftover_files = 0u64;
    let mut leftover_dirs = 0u64;

    for item in read {
        if !ctx.step(path) {
            break;
        }
        let item = match item {
            Ok(i) => i,
            Err(_) => {
                ctx.errors += 1;
                continue;
            }
        };
        let entry_name = item.file_name().to_string_lossy().into_owned();
        let entry_path = item.path();
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => {
                ctx.errors += 1;
                continue;
            }
        };
        if paths::hidden(&entry_name, &meta) && !ctx.include_hidden {
            continue;
        }
        if paths::is_reparse(&meta) {
            continue;
        }

        if meta.is_dir() {
            if depth >= ctx.max_depth {
                continue;
            }
            let child = scan_dir(&entry_path, entry_name, depth + 1, ctx);
            node.size += child.size;
            node.file_count += child.file_count;
            node.dir_count += child.dir_count + 1;

            if node.children.len() < MAX_CHILDREN {
                node.children.push(child);
            } else {
                leftover_size += child.size;
                leftover_files += child.file_count;
                leftover_dirs += child.dir_count + 1;
            }
        } else if meta.is_file() {
            let len = meta.len();
            let ext = paths::ext_of(&entry_name);
            node.size += len;
            node.file_count += 1;
            ctx.bytes += len;
            ctx.record(&entry_name, &entry_path, len);

            if node.children.len() < MAX_CHILDREN {
                node.children.push(VizNode {
                    name: entry_name,
                    path: paths::text(&entry_path),
                    size: len,
                    is_dir: false,
                    kind: paths::classify(&ext, false).to_string(),
                    ext,
                    file_count: 1,
                    dir_count: 0,
                    children: Vec::new(),
                });
            } else {
                leftover_size += len;
                leftover_files += 1;
            }
        }
    }

    if leftover_size > 0 || leftover_files > 0 || leftover_dirs > 0 {
        node.children.push(VizNode {
            name: format!("{} more items", leftover_files + leftover_dirs),
            path: node.path.clone(),
            size: leftover_size,
            is_dir: true,
            kind: "other".to_string(),
            file_count: leftover_files,
            dir_count: leftover_dirs,
            ..Default::default()
        });
    }

    node.children.sort_by(|a, b| b.size.cmp(&a.size));
    node
}

fn scan(
    app: &tauri::AppHandle,
    root: &Path,
    include_hidden: bool,
    max_depth: u32,
    gen: u64,
    current_gen: Arc<AtomicU64>,
) -> Result<VizResult, String> {
    let label = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| paths::text(root));
    let started = Instant::now();
    let mut ctx = ScanCtx {
        app,
        gen,
        current_gen,
        include_hidden,
        max_depth,
        scanned: 0,
        bytes: 0,
        errors: 0,
        truncated: false,
        cancelled: false,
        last_emit: Instant::now(),
        root_label: paths::text(root),
        top: BinaryHeap::new(),
        counter: 0,
        ext: HashMap::new(),
    };

    let _ = app.emit(
        "viz:progress",
        VizProgress {
            gen,
            root: paths::text(root),
            scanned: 0,
            bytes: 0,
            current: paths::text(root),
        },
    );

    let node = scan_dir(root, label, 0, &mut ctx);

    if ctx.cancelled {
        return Err("cancelled".to_string());
    }

    let mut top_files: Vec<TopFile> = ctx
        .top
        .into_iter()
        .map(|Reverse((size, _, name, path, ext))| TopFile {
            name,
            path,
            size,
            ext,
        })
        .collect();
    top_files.sort_by(|a, b| b.size.cmp(&a.size));

    let mut ext_stats: Vec<ExtStat> = ctx
        .ext
        .into_iter()
        .map(|(ext, (bytes, files))| ExtStat { ext, bytes, files })
        .collect();
    ext_stats.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    ext_stats.truncate(40);

    let total_size = node.size;
    let file_count = node.file_count;
    let dir_count = node.dir_count;

    Ok(VizResult {
        path: paths::text(root),
        root: node,
        total_size,
        file_count,
        dir_count,
        errors: ctx.errors,
        truncated: ctx.truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
        top_files,
        ext_stats,
        include_hidden,
    })
}

#[tauri::command]
pub async fn viz_scan(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    include_hidden: bool,
    max_depth: u32,
) -> Result<VizResult, String> {
    let root = paths::resolve_dir(&path)?;
    let max_depth = max_depth.clamp(1, 255);
    let gen = state.scan_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let current_gen = state.scan_gen.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        scan(
            &app_handle,
            &root,
            include_hidden,
            max_depth,
            gen,
            current_gen,
        )
    })
    .await
    .map_err(|e| format!("Scan task failed: {e}"))?
}

#[tauri::command]
pub fn cancel_scan(state: State<'_, AppState>) {
    state.scan_gen.fetch_add(1, Ordering::SeqCst);
}
