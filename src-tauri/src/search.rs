use crate::paths;
use ignore::WalkBuilder;
use serde::Serialize;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

const MAX_VISITED: usize = 250_000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub name: String,
    pub path: String,
    pub parent: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
    pub ext: String,
    pub kind: String,
}

fn score(name: &str, query: &str) -> Option<i32> {
    let lower = name.to_lowercase();
    if lower == query {
        return Some(2_000);
    }
    if lower.starts_with(query) {
        return Some(1_600 - name.len() as i32);
    }
    if let Some(pos) = lower.find(query) {
        return Some(1_200 - pos as i32);
    }
    let mut chars = lower.chars();
    let mut matched = 0i32;
    for q in query.chars() {
        if chars.any(|c| c == q) {
            matched += 1;
        } else {
            return None;
        }
    }
    Some(400 + matched * 8 - name.len() as i32)
}

fn walk(root: &PathBuf, query: &str, limit: usize, include_hidden: bool) -> Vec<SearchHit> {
    let mut builder = WalkBuilder::new(root);
    builder
        .hidden(!include_hidden)
        .git_ignore(true)
        .git_global(false)
        .git_exclude(false)
        .follow_links(false)
        .same_file_system(true)
        .max_depth(Some(16));

    let mut scored: Vec<(i32, SearchHit)> = Vec::new();
    let mut visited = 0usize;

    for result in builder.build() {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        visited += 1;
        if visited > MAX_VISITED {
            break;
        }
        if entry.depth() == 0 {
            continue;
        }
        let name = match entry.file_name().to_str() {
            Some(n) => n.to_string(),
            None => entry.file_name().to_string_lossy().into_owned(),
        };
        let Some(s) = score(&name, query) else {
            continue;
        };
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_dir = meta.is_dir();
        let ext = if is_dir {
            String::new()
        } else {
            paths::ext_of(&name)
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        scored.push((
            s,
            SearchHit {
                name,
                path: paths::text(path),
                parent: path
                    .parent()
                    .map(paths::text)
                    .unwrap_or_else(|| paths::text(root)),
                is_dir,
                size: if is_dir { 0 } else { meta.len() },
                modified,
                kind: paths::classify(&ext, is_dir).to_string(),
                ext,
            },
        ));
        if scored.len() > limit * 6 {
            scored.sort_by(|a, b| b.0.cmp(&a.0));
            scored.truncate(limit * 2);
        }
    }

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    scored.truncate(limit);
    scored.into_iter().map(|(_, hit)| hit).collect()
}

#[tauri::command]
pub async fn search_files(
    path: String,
    query: String,
    limit: Option<usize>,
    include_hidden: Option<bool>,
) -> Result<Vec<SearchHit>, String> {
    let root = paths::resolve_dir(&path)?;
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(300).clamp(1, 2_000);
    let include_hidden = include_hidden.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || walk(&root, &query, limit, include_hidden))
        .await
        .map_err(|e| format!("Search failed: {e}"))
}
