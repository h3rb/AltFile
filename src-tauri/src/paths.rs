use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn expand(input: &str) -> PathBuf {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed == "~" {
        return home();
    }
    if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        return home().join(rest);
    }
    PathBuf::from(trimmed)
}

pub fn canonical(path: &Path) -> PathBuf {
    let canon = dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    // dunce keeps network paths verbatim (`\\?\UNC\server\share`); the UI shows the plain form.
    match canon.to_string_lossy().strip_prefix(r"\\?\UNC\") {
        Some(rest) => PathBuf::from(format!(r"\\{rest}")),
        None => canon,
    }
}

pub fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub fn io_msg(err: &std::io::Error, path: &Path) -> String {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::NotFound => format!("Path not found: {}", path.display()),
        ErrorKind::PermissionDenied => format!("Permission denied: {}", path.display()),
        ErrorKind::AlreadyExists => format!("Already exists: {}", path.display()),
        _ => format!("{}: {}", path.display(), err),
    }
}

pub fn resolve_dir(input: &str) -> Result<PathBuf, String> {
    let raw = expand(input);
    let canon = canonical(&raw);
    let meta = std::fs::metadata(&canon).map_err(|e| io_msg(&e, &canon))?;
    if !meta.is_dir() {
        return Err(format!("Not a folder: {}", canon.display()));
    }
    Ok(canon)
}

pub fn resolve_file(input: &str) -> Result<PathBuf, String> {
    let raw = expand(input);
    let canon = canonical(&raw);
    let meta = std::fs::metadata(&canon).map_err(|e| io_msg(&e, &canon))?;
    if !meta.is_file() {
        return Err(format!("Not a file: {}", canon.display()));
    }
    Ok(canon)
}

pub fn hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let attrs = meta.file_attributes();
        if attrs & 0x2 != 0 || attrs & 0x4 != 0 {
            return true;
        }
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
    }
    false
}

pub fn is_reparse(meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return meta.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

pub fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub fn classify(ext: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "folder";
    }
    match ext {
        "jpg" | "jpeg" | "jfif" | "png" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "ico"
        | "svg" | "avif" | "heic" | "heif" | "raw" | "cr2" | "nef" => "image",
        "mp4" | "mkv" | "avi" | "mov" | "wmv" | "flv" | "webm" | "m4v" | "mpg" | "mpeg" | "3gp"
        | "m2ts" | "ogv" => "video",
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "wma" | "opus" | "mid" | "midi"
        | "aiff" => "audio",
        "rs" | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "py" | "rb" | "go" | "java" | "c"
        | "h" | "cpp" | "hpp" | "cc" | "cs" | "php" | "swift" | "kt" | "kts" | "scala" | "sh"
        | "bash" | "zsh" | "ps1" | "bat" | "cmd" | "lua" | "r" | "sql" | "html" | "htm" | "css"
        | "scss" | "sass" | "less" | "vue" | "svelte" | "astro" | "json" | "jsonc" | "yaml"
        | "yml" | "toml" | "xml" | "ini" | "cfg" | "conf" | "env" | "gradle" | "cmake"
        | "ipynb" => "code",
        "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx" | "odt" | "ods" | "odp"
        | "rtf" | "txt" | "md" | "markdown" | "epub" | "mobi" | "csv" | "tsv" | "log" => "doc",
        "zip" | "rar" | "7z" | "tar" | "gz" | "bz2" | "xz" | "zst" | "iso" | "dmg" | "cab"
        | "rpm" | "deb" => "archive",
        "exe" | "dll" | "so" | "dylib" | "msi" | "msix" | "appx" | "app" | "appimage"
        | "url" => "exe",
        "lnk" => "shortcut",
        "ttf" | "otf" | "woff" | "woff2" => "font",
        "obj" | "stl" | "ply" | "gltf" | "glb" | "dae" | "fbx" | "blend" | "3ds" | "3mf"
        | "usd" | "usda" | "usdz" | "abc" | "off" | "step" | "stp" | "iges" | "igs" | "wrl"
        | "vrml" | "lwo" => "model",
        _ => "file",
    }
}
