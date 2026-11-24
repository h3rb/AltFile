use base64::Engine;
use std::path::Path;

const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";

pub fn write_png(path: &Path, data: &str) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|error| format!("The image data was not valid base64: {error}"))?;
    if !bytes.starts_with(PNG_MAGIC) {
        return Err("The exported image was not a PNG".into());
    }
    std::fs::write(path, bytes)
        .map_err(|error| format!("Could not write {}: {error}", path.display()))
}

#[tauri::command]
pub fn save_png(path: String, data: String) -> Result<(), String> {
    write_png(Path::new(&path), &data)
}

#[tauri::command]
pub fn save_bytes(path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|error| format!("The file data was not valid base64: {error}"))?;
    let target = Path::new(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("Folder not found: {}", parent.display()));
        }
    }
    std::fs::write(target, bytes).map_err(|error| format!("Could not write {}: {error}", target.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("altfe-png-{}-{name}.png", std::process::id()))
    }

    #[test]
    fn writes_decoded_png_bytes() {
        let target = fixture("write");
        let payload = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
        write_png(&target, &payload).expect("write should succeed");
        assert_eq!(std::fs::read(&target).unwrap(), b"\x89PNG\r\n\x1a\nrest");
        let _ = std::fs::remove_file(&target);
    }

    #[test]
    fn rejects_invalid_base64() {
        let error = write_png(&fixture("bad64"), "not base64!!").unwrap_err();
        assert!(error.contains("base64"), "{error}");
    }

    #[test]
    fn rejects_non_png_payloads() {
        let payload = base64::engine::general_purpose::STANDARD.encode(b"GIF89a");
        let error = write_png(&fixture("notpng"), &payload).unwrap_err();
        assert!(error.contains("not a PNG"), "{error}");
    }
}
