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
    pub elapsed_ms: u64,
    pub top_files: Vec<TopFile>,
    pub ext_stats: Vec<ExtStat>,
    pub include_hidden: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PartialNode {
    name: String,
    path: String,
    size: u64,
    is_dir: bool,
    ext: String,
    kind: String,
    file_count: u64,
    dir_count: u64,
    children: Vec<PartialNode>,
}

impl PartialNode {
    fn summary(node: &VizNode) -> Self {
        Self {
            name: node.name.clone(),
            path: node.path.clone(),
            size: node.size,
            is_dir: node.is_dir,
            ext: node.ext.clone(),
            kind: node.kind.clone(),
            file_count: node.file_count,
            dir_count: node.dir_count,
            children: Vec::new(),
        }
    }
}

// Mirrors the frontend's nested preview limit so partial tiles show the same one-level hints.
const PREVIEW_CHILDREN: usize = 80;
const PREVIEW_FOLDERS: usize = 80;

fn preview_children(node: &VizNode) -> Vec<PartialNode> {
    let mut nodes: Vec<&VizNode> = node.children.iter().filter(|child| child.size > 0).collect();
    if nodes.is_empty() {
        return Vec::new();
    }
    if nodes.len() > PREVIEW_CHILDREN {
        nodes.select_nth_unstable_by(PREVIEW_CHILDREN, |a, b| b.size.cmp(&a.size));
        nodes.truncate(PREVIEW_CHILDREN);
    }
    nodes.sort_by(|a, b| b.size.cmp(&a.size));
    nodes.into_iter().map(PartialNode::summary).collect()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VizPartial {
    gen: u64,
    root: String,
    scanned: u64,
    bytes: u64,
    total_size: u64,
    file_count: u64,
    dir_count: u64,
    errors: u64,
    current: String,
    children: Vec<PartialNode>,
}

struct ScanCtx<'a> {
    app: &'a tauri::AppHandle,
    gen: u64,
    current_gen: Arc<AtomicU64>,
    include_hidden: bool,
    scanned: u64,
    bytes: u64,
    errors: u64,
    cancelled: bool,
    last_emit: Instant,
    root_label: String,
    root: VizNode,
    active: Option<VizNode>,
    root_leftover_size: u64,
    root_leftover_files: u64,
    root_leftover_dirs: u64,
    top: BinaryHeap<Reverse<(u64, u64, String, String, String)>>,
    counter: u64,
    ext: HashMap<String, (u64, u64)>,
}

impl<'a> ScanCtx<'a> {
    fn step(&mut self, dir: &Path) -> bool {
        self.scanned += 1;
        if self.scanned % 128 == 0 {
            if self.current_gen.load(Ordering::Relaxed) != self.gen {
                self.cancelled = true;
                return false;
            }
            if self.last_emit.elapsed().as_millis() >= 110 {
                self.last_emit = Instant::now();
                self.emit_partial(dir);
            }
        }
        true
    }

    fn emit_partial(&self, dir: &Path) {
        let sources: Vec<&VizNode> = self
            .root
            .children
            .iter()
            .chain(self.active.iter())
            .filter(|node| node.size > 0)
            .collect();
        let mut order: Vec<usize> = (0..sources.len()).collect();
        order.sort_by(|&a, &b| sources[b].size.cmp(&sources[a].size));
        let children: Vec<PartialNode> = order
            .iter()
            .enumerate()
            .map(|(rank, &index)| {
                let mut summary = PartialNode::summary(sources[index]);
                if rank < PREVIEW_FOLDERS {
                    summary.children = preview_children(sources[index]);
                }
                summary
            })
            .collect();

        let active = self.active.as_ref();
        let _ = self.app.emit(
            "viz:partial",
            VizPartial {
                gen: self.gen,
                root: self.root_label.clone(),
                scanned: self.scanned,
                bytes: self.bytes,
                total_size: self.bytes,
                file_count: self.root.file_count + active.map_or(0, |node| node.file_count),
                dir_count: self.root.dir_count + active.map_or(0, |node| node.dir_count + 1),
                errors: self.errors,
                current: paths::text(dir),
                children,
            },
        );
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

fn begin_child(ctx: &mut ScanCtx, name: String, path: &Path) {
    ctx.active = Some(VizNode {
        name,
        path: paths::text(path),
        is_dir: true,
        kind: "folder".to_string(),
        ..Default::default()
    });
}

fn finish_child(ctx: &mut ScanCtx) {
    let Some(mut child) = ctx.active.take() else {
        return;
    };
    child.children.sort_by(|a, b| b.size.cmp(&a.size));
    ctx.root.size += child.size;
    ctx.root.file_count += child.file_count;
    ctx.root.dir_count += child.dir_count + 1;
    if ctx.root.children.len() < MAX_CHILDREN {
        ctx.root.children.push(child);
    } else {
        ctx.root_leftover_size += child.size;
        ctx.root_leftover_files += child.file_count;
        ctx.root_leftover_dirs += child.dir_count + 1;
    }
}

// Walks a retained top-level folder: direct files become child nodes, subfolders only add totals.
fn walk_child(path: &Path, ctx: &mut ScanCtx) {
    let read = match fs::read_dir(path) {
        Ok(r) => r,
        Err(_) => {
            ctx.errors += 1;
            return;
        }
    };

    let mut leftover_size = 0u64;
    let mut leftover_files = 0u64;

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
            let (bytes, files, dirs) = measure_dir(&entry_path, ctx);
            if let Some(active) = ctx.active.as_mut() {
                active.size += bytes;
                active.file_count += files;
                active.dir_count += dirs + 1;
            }
        } else if meta.is_file() {
            let len = meta.len();
            let ext = paths::ext_of(&entry_name);
            let kind = paths::classify(&ext, false).to_string();
            ctx.bytes += len;
            ctx.record(&entry_name, &entry_path, len);

            let Some(active) = ctx.active.as_mut() else {
                leftover_size += len;
                leftover_files += 1;
                continue;
            };
            active.size += len;
            active.file_count += 1;
            if active.children.len() < MAX_CHILDREN {
                active.children.push(VizNode {
                    name: entry_name,
                    path: paths::text(&entry_path),
                    size: len,
                    is_dir: false,
                    kind,
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

    if leftover_size > 0 || leftover_files > 0 {
        if let Some(active) = ctx.active.as_mut() {
            active.children.push(VizNode {
                name: format!("{leftover_files} more items"),
                path: active.path.clone(),
                size: leftover_size,
                is_dir: true,
                kind: "other".to_string(),
                file_count: leftover_files,
                dir_count: 0,
                ..Default::default()
            });
        }
    }
}

fn scan_root(path: &Path, ctx: &mut ScanCtx) {
    let read = match fs::read_dir(path) {
        Ok(r) => r,
        Err(_) => {
            ctx.errors += 1;
            return;
        }
    };

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
            begin_child(ctx, entry_name, &entry_path);
            walk_child(&entry_path, ctx);
            finish_child(ctx);
        } else if meta.is_file() {
            let len = meta.len();
            let ext = paths::ext_of(&entry_name);
            let kind = paths::classify(&ext, false).to_string();
            ctx.bytes += len;
            ctx.record(&entry_name, &entry_path, len);
            ctx.root.size += len;
            ctx.root.file_count += 1;
            if ctx.root.children.len() < MAX_CHILDREN {
                ctx.root.children.push(VizNode {
                    name: entry_name,
                    path: paths::text(&entry_path),
                    size: len,
                    is_dir: false,
                    kind,
                    ext,
                    file_count: 1,
                    dir_count: 0,
                    children: Vec::new(),
                });
            } else {
                ctx.root_leftover_size += len;
                ctx.root_leftover_files += 1;
            }
        }
    }

    if ctx.root_leftover_size > 0 || ctx.root_leftover_files > 0 || ctx.root_leftover_dirs > 0 {
        ctx.root.children.push(VizNode {
            name: format!(
                "{} more items",
                ctx.root_leftover_files + ctx.root_leftover_dirs
            ),
            path: ctx.root.path.clone(),
            size: ctx.root_leftover_size,
            is_dir: true,
            kind: "other".to_string(),
            file_count: ctx.root_leftover_files,
            dir_count: ctx.root_leftover_dirs,
            ..Default::default()
        });
    }

    ctx.root.children.sort_by(|a, b| b.size.cmp(&a.size));
}

// Totals a folder recursively without building nodes; used below the retained depth.
fn measure_dir(path: &Path, ctx: &mut ScanCtx) -> (u64, u64, u64) {
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut dirs = 0u64;

    let read = match fs::read_dir(path) {
        Ok(r) => r,
        Err(_) => {
            ctx.errors += 1;
            return (0, 0, 0);
        }
    };

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
            let (child_bytes, child_files, child_dirs) = measure_dir(&entry_path, ctx);
            bytes += child_bytes;
            files += child_files;
            dirs += child_dirs + 1;
        } else if meta.is_file() {
            let len = meta.len();
            bytes += len;
            files += 1;
            ctx.bytes += len;
            ctx.record(&entry_name, &entry_path, len);
        }
    }

    (bytes, files, dirs)
}

fn scan(
    app: &tauri::AppHandle,
    root: &Path,
    include_hidden: bool,
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
        scanned: 0,
        bytes: 0,
        errors: 0,
        cancelled: false,
        last_emit: Instant::now(),
        root_label: paths::text(root),
        root: VizNode {
            name: label,
            path: paths::text(root),
            is_dir: true,
            kind: "folder".to_string(),
            ..Default::default()
        },
        active: None,
        root_leftover_size: 0,
        root_leftover_files: 0,
        root_leftover_dirs: 0,
        top: BinaryHeap::new(),
        counter: 0,
        ext: HashMap::new(),
    };

    ctx.emit_partial(root);
    scan_root(root, &mut ctx);

    if ctx.cancelled {
        return Err("cancelled".to_string());
    }

    let node = std::mem::take(&mut ctx.root);

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
) -> Result<VizResult, String> {
    let root = paths::resolve_dir(&path)?;
    let gen = state.scan_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let current_gen = state.scan_gen.clone();
    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        scan(&app_handle, &root, include_hidden, gen, current_gen)
    })
    .await
    .map_err(|e| format!("Scan task failed: {e}"))?
}

#[tauri::command]
pub fn cancel_scan(state: State<'_, AppState>) {
    state.scan_gen.fetch_add(1, Ordering::SeqCst);
}
