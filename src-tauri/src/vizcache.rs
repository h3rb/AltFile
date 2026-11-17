use crate::AppState;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;
use tauri::State;

const FORMAT_VERSION: u32 = 1;
const CACHE_BUDGET: u64 = 256 * 1024 * 1024;
const CACHE_ENTRIES: usize = 48;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("viz-cache")
}

fn entry_path(dir: &Path, key: &str) -> PathBuf {
    let name = blake3::hash(key.as_bytes()).to_hex();
    dir.join(format!("{name}.json.gz"))
}

#[cfg(test)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
struct Envelope<'a> {
    v: u32,
    app: &'a str,
    key: &'a str,
    saved_at: u64,
    result: &'a Value,
}

#[derive(Deserialize)]
struct StoredEnvelope {
    v: u32,
    app: String,
    key: String,
    saved_at: u64,
    result: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheHit {
    pub saved_at: u64,
    pub accessed_ms_ago: u64,
    pub result: Value,
}

fn write_entry(dir: &Path, key: &str, saved_at: u64, result: &Value) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create viz cache: {e}"))?;
    let target = entry_path(dir, key);
    let tmp = dir.join(format!(
        ".tmp-{}-{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let envelope = Envelope {
        v: FORMAT_VERSION,
        app: env!("CARGO_PKG_VERSION"),
        key,
        saved_at,
        result,
    };
    let file = fs::File::create(&tmp).map_err(|e| format!("Could not write viz cache: {e}"))?;
    let mut encoder = GzEncoder::new(file, Compression::fast());
    serde_json::to_writer(&mut encoder, &envelope)
        .map_err(|e| format!("Could not encode viz cache: {e}"))?;
    encoder
        .finish()
        .map_err(|e| format!("Could not encode viz cache: {e}"))?;
    if fs::rename(&tmp, &target).is_err() {
        let _ = fs::remove_file(&target);
        if let Err(e) = fs::rename(&tmp, &target) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("Could not save viz cache: {e}"));
        }
    }
    Ok(())
}

fn read_entry(dir: &Path, key: &str) -> Option<CacheHit> {
    let path = entry_path(dir, key);
    let accessed_ms_ago = fs::metadata(&path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(u64::MAX);
    let bytes = fs::read(&path).ok()?;
    let Ok(stored) =
        serde_json::from_reader::<_, StoredEnvelope>(GzDecoder::new(bytes.as_slice()))
    else {
        let _ = fs::remove_file(&path);
        return None;
    };
    if stored.v != FORMAT_VERSION
        || stored.app != env!("CARGO_PKG_VERSION")
        || stored.key != key
    {
        let _ = fs::remove_file(&path);
        return None;
    }
    // Last access drives the staleness check and LRU pruning.
    if let Ok(file) = fs::OpenOptions::new().write(true).open(&path) {
        let _ = file.set_modified(SystemTime::now());
    }
    Some(CacheHit {
        saved_at: stored.saved_at,
        accessed_ms_ago,
        result: stored.result,
    })
}

fn prune(dir: &Path) {
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    let mut files: Vec<(u64, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    for item in read.flatten() {
        let path = item.path();
        let Ok(meta) = item.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let age = meta
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if path
            .file_name()
            .map(|n| n.to_string_lossy().starts_with(".tmp-"))
            .unwrap_or(false)
            && age > 3600
        {
            let _ = fs::remove_file(&path);
            continue;
        }
        total += meta.len();
        files.push((age, meta.len(), path));
    }
    let mut remaining = files.len();
    if total <= CACHE_BUDGET && remaining <= CACHE_ENTRIES {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, size, path) in files {
        if total <= CACHE_BUDGET && remaining <= CACHE_ENTRIES {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
            remaining = remaining.saturating_sub(1);
        }
    }
}

#[tauri::command]
pub async fn viz_cache_get(
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<CacheHit>, String> {
    let dir = cache_dir(&state.data_dir);
    tauri::async_runtime::spawn_blocking(move || read_entry(&dir, &key))
        .await
        .map_err(|e| format!("Viz cache task failed: {e}"))
}

#[tauri::command]
pub async fn viz_cache_put(
    state: State<'_, AppState>,
    key: String,
    saved_at: u64,
    result: Value,
) -> Result<(), String> {
    let dir = cache_dir(&state.data_dir);
    tauri::async_runtime::spawn_blocking(move || {
        write_entry(&dir, &key, saved_at, &result)?;
        prune(&dir);
        Ok(())
    })
    .await
    .map_err(|e| format!("Viz cache task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "altfe-vizcache-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ))
    }

    #[test]
    fn roundtrip_hit_and_miss() {
        let dir = temp_dir("roundtrip");
        let result = serde_json::json!({
            "path": "C:/x",
            "root": { "name": "x", "children": [] }
        });
        write_entry(&dir, "C:/x|0|1", 123, &result).unwrap();
        let hit = read_entry(&dir, "C:/x|0|1").expect("cache hit");
        assert_eq!(hit.saved_at, 123);
        assert_eq!(hit.result["path"], "C:/x");
        assert!(read_entry(&dir, "C:/y|0|1").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_updates_access_marker() {
        let dir = temp_dir("touch");
        let result = serde_json::json!({ "path": "C:/x", "root": { "name": "x" } });
        write_entry(&dir, "C:/x|0|1", 1, &result).unwrap();
        let path = entry_path(&dir, "C:/x|0|1");
        let old = SystemTime::now() - std::time::Duration::from_secs(3600);
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let hit = read_entry(&dir, "C:/x|0|1").expect("cache hit");
        assert!(hit.accessed_ms_ago >= 60 * 60 * 1000 - 1000);
        let touched = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(touched > old + std::time::Duration::from_secs(60));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_entry_is_dropped() {
        let dir = temp_dir("corrupt");
        fs::create_dir_all(&dir).unwrap();
        let path = entry_path(&dir, "C:/x|0|1");
        fs::write(&path, b"not gzip").unwrap();
        assert!(read_entry(&dir, "C:/x|0|1").is_none());
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
