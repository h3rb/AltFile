use crate::AppState;
use serde_json::Value;
use std::fs;
use tauri::State;

const MAX_SETTINGS_BYTES: usize = 4 * 1024 * 1024;

#[tauri::command]
pub fn load_settings(state: State<'_, AppState>) -> Option<Value> {
    let path = state.data_dir.join("settings.json");
    let meta = fs::metadata(&path).ok()?;
    if meta.len() > MAX_SETTINGS_BYTES as u64 {
        return None;
    }
    let text = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Could not serialize settings: {e}"))?;
    if text.len() > MAX_SETTINGS_BYTES {
        return Err("Settings payload is too large".to_string());
    }
    fs::create_dir_all(&state.data_dir)
        .map_err(|e| format!("Could not create data folder: {e}"))?;
    let path = state.data_dir.join("settings.json");
    let tmp = state.data_dir.join("settings.json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("Could not write settings: {e}"))?;
    if fs::rename(&tmp, &path).is_err() {
        let _ = fs::remove_file(&path);
        fs::rename(&tmp, &path).map_err(|e| format!("Could not save settings: {e}"))?;
    }
    Ok(())
}
