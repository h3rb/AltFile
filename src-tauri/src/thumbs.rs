use crate::{mesh, paths, AppState};
use image::{DynamicImage, ImageDecoder, Rgb, RgbImage};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;
use tauri::State;

const CACHE_LIMIT: u64 = 512 * 1024 * 1024;
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ThumbInfo {
    pub url: String,
    pub width: u32,
    pub height: u32,
    pub source: String,
    pub bytes: u64,
    pub cached: bool,
    pub locked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub bytes: u64,
    pub files: u64,
    pub dir: String,
    pub max_bytes: u64,
}

fn url_for(name: &str) -> String {
    if cfg!(windows) {
        format!("http://thumb.localhost/{name}")
    } else {
        format!("thumb://localhost/{name}")
    }
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_candidate(kind: &str, ext: &str) -> bool {
    match kind {
        "image" | "video" | "audio" | "exe" | "shortcut" => true,
        "model" => matches!(ext, "stl" | "obj" | "ply" | "3mf"),
        "doc" => !matches!(
            ext,
            "txt" | "md" | "markdown" | "log" | "csv" | "tsv" | "rtf"
        ),
        _ => false,
    }
}

fn decode_image(path: &Path) -> image::ImageResult<DynamicImage> {
    let reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let mut decoder = reader.into_decoder()?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder)?;
    img.apply_orientation(orientation);
    Ok(img)
}

fn flatten(img: &DynamicImage, max: u32) -> RgbImage {
    let resized = if img.width() > max || img.height() > max {
        img.thumbnail(max, max)
    } else {
        img.clone()
    };
    let rgba = resized.to_rgba8();
    let mut out = RgbImage::new(rgba.width(), rgba.height());
    for (dst, src) in out.pixels_mut().zip(rgba.pixels()) {
        let a = src[3] as u32;
        let blend = |c: u8| ((c as u32 * a + 16 * (255 - a)) / 255) as u8;
        *dst = Rgb([blend(src[0]), blend(src[1]), blend(src[2])]);
    }
    out
}

fn encode_jpeg(img: &RgbImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 84);
    encoder
        .encode_image(img)
        .map_err(|e| format!("Could not encode thumbnail: {e}"))?;
    Ok(bytes)
}

fn write_cache(dir: &Path, target: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create cache: {e}"))?;
    let tmp = dir.join(format!(
        ".tmp-{}-{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("Could not write thumbnail: {e}"))?;
    match fs::rename(&tmp, target) {
        Ok(()) => Ok(()),
        Err(_) if target.is_file() => {
            let _ = fs::remove_file(&tmp);
            Ok(())
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(format!("Could not cache thumbnail: {e}"))
        }
    }
}

fn cached_info(dir: &Path, name: &str, source: &str) -> ThumbInfo {
    let path = dir.join(name);
    let dims = image::image_dimensions(&path).unwrap_or((0, 0));
    let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    ThumbInfo {
        url: url_for(name),
        width: dims.0,
        height: dims.1,
        source: source.to_string(),
        bytes,
        cached: true,
        locked: false,
    }
}

fn locked_info(bytes: u64) -> ThumbInfo {
    ThumbInfo {
        url: String::new(),
        width: 0,
        height: 0,
        source: "pdf-locked".to_string(),
        bytes,
        cached: false,
        locked: true,
    }
}

/// Looks for the `/Encrypt` entry that encrypted PDFs carry in their trailer or
/// cross-reference stream. Only the tail is scanned; rendered pages are tried
/// first, so this is just a confirmation for files that will not open.
fn pdf_is_encrypted(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    const TAIL: u64 = 64 * 1024;
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return false,
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file.seek(SeekFrom::Start(len.saturating_sub(TAIL))).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    if file.take(TAIL).read_to_end(&mut buf).is_err() {
        return false;
    }

    let needle = b"/Encrypt";
    let mut from = 0;
    while let Some(offset) = buf[from..]
        .windows(needle.len())
        .position(|window| window == needle)
    {
        let mut i = from + offset + needle.len();
        let token_end = i;
        while i < buf.len() && buf[i].is_ascii_whitespace() {
            i += 1;
        }
        // A real trailer entry is either `/Encrypt N G R` or an inline `/Encrypt <<` dict.
        if i > token_end && (buf.get(i).is_some_and(u8::is_ascii_digit) || buf.get(i) == Some(&b'<'))
        {
            return true;
        }
        from = token_end;
    }
    false
}

pub fn generate(
    thumb_dir: &Path,
    path: &str,
    requested_size: u32,
    force: bool,
) -> Result<Option<ThumbInfo>, String> {
    let p = paths::canonical(&paths::expand(path));
    let meta = match fs::metadata(&p) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    if !meta.is_file() || meta.len() == 0 {
        return Ok(None);
    }
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = paths::ext_of(&name);
    let kind = paths::classify(&ext, false);
    if !is_candidate(kind, &ext) {
        return Ok(None);
    }

    let size = requested_size.clamp(64, 2048);
    let revision = if ext == "3mf" { "thumb-v6-3mf3" } else { "thumb-v6" };
    let key = blake3::hash(
        format!(
            "{revision}|{}|{}|{}|{}",
            paths::text(&p),
            meta.len(),
            mtime_ms(&meta),
            size
        )
        .as_bytes(),
    )
    .to_hex()
    .to_string();
    let file_name = format!("{key}.jpg");
    let cache_path = thumb_dir.join(&file_name);

    if !force && cache_path.is_file() {
        return Ok(Some(cached_info(thumb_dir, &file_name, "cache")));
    }

    let mut source = "image";
    let image_data: Option<DynamicImage> = if kind == "image" {
        match decode_image(&p) {
            Ok(img) => Some(img),
            Err(_) => {
                #[cfg(windows)]
                {
                    source = "shell";
                    shell::image(&p, size, false)
                }
                #[cfg(not(windows))]
                {
                    None
                }
            }
        }
    } else if kind == "model" {
        source = "mesh";
        mesh::render_image(&p, &ext, size).map(DynamicImage::ImageRgb8)
    } else if ext == "pdf" {
        #[cfg(windows)]
        {
            source = "pdf";
            pdf_win::first_page(&p, size)
        }
        #[cfg(target_os = "linux")]
        {
            source = "poppler";
            linux_media::pdf_first_page(&p, size, thumb_dir)
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            None
        }
    } else {
        #[cfg(windows)]
        {
            if kind == "exe" || kind == "shortcut" {
                source = "icon";
                shell::image(&p, size, true)
            } else {
                source = "shell";
                shell::image(&p, size, false)
            }
        }
        #[cfg(target_os = "linux")]
        {
            if kind == "video" {
                source = "ffmpeg";
                linux_media::video_frame(&p, size, thumb_dir)
            } else if ext == "pdf" {
                source = "poppler";
                linux_media::pdf_first_page(&p, size, thumb_dir)
            } else {
                None
            }
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            None
        }
    };

    let Some(img) = image_data else {
        if ext == "pdf" && pdf_is_encrypted(&p) {
            return Ok(Some(locked_info(meta.len())));
        }
        return Ok(None);
    };
    let rgb = flatten(&img, size);
    let dims = (rgb.width(), rgb.height());
    let bytes = encode_jpeg(&rgb)?;
    write_cache(thumb_dir, &cache_path, &bytes)?;
    let _ = prune(thumb_dir, CACHE_LIMIT);

    Ok(Some(ThumbInfo {
        url: url_for(&file_name),
        width: dims.0,
        height: dims.1,
        source: source.to_string(),
        bytes: bytes.len() as u64,
        cached: false,
        locked: false,
    }))
}

#[tauri::command]
pub async fn thumbnail(
    state: State<'_, AppState>,
    path: String,
    size: Option<u32>,
    force: Option<bool>,
) -> Result<Option<ThumbInfo>, String> {
    let dir = state.thumb_dir.clone();
    let requested = size.unwrap_or(256);
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || generate(&dir, &path, requested, force))
        .await
        .map_err(|e| format!("Thumbnail task failed: {e}"))?
}

pub fn prune(dir: &Path, max_bytes: u64) -> u64 {
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return 0,
    };
    let now = std::time::SystemTime::now();
    let mut files: Vec<(u64, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    for item in read.flatten() {
        let p = item.path();
        if !p.is_file() {
            continue;
        }
        let meta = match item.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if p.file_name()
            .map(|n| n.to_string_lossy().starts_with(".tmp-"))
            .unwrap_or(false)
            && modified > 3600
        {
            let _ = fs::remove_file(&p);
            continue;
        }
        total += meta.len();
        files.push((modified, meta.len(), p));
    }
    if total <= max_bytes {
        return 0;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let target = max_bytes.saturating_mul(8) / 10;
    let mut freed = 0u64;
    for (_, size, p) in files {
        if total.saturating_sub(freed) <= target {
            break;
        }
        if fs::remove_file(&p).is_ok() {
            freed += size;
        }
    }
    freed
}

pub fn cache_stats(dir: &Path) -> CacheStats {
    let mut bytes = 0u64;
    let mut files = 0u64;
    if let Ok(read) = fs::read_dir(dir) {
        for item in read.flatten() {
            if let Ok(meta) = item.metadata() {
                if meta.is_file() {
                    bytes += meta.len();
                    files += 1;
                }
            }
        }
    }
    CacheStats {
        bytes,
        files,
        dir: paths::text(dir),
        max_bytes: CACHE_LIMIT,
    }
}

#[tauri::command]
pub fn thumbnail_cache_stats(state: State<'_, AppState>) -> CacheStats {
    cache_stats(&state.thumb_dir)
}

#[tauri::command]
pub fn clear_thumbnail_cache(state: State<'_, AppState>) -> Result<u64, String> {
    let mut freed = 0u64;
    let read = fs::read_dir(&state.thumb_dir).map_err(|e| e.to_string())?;
    for item in read.flatten() {
        let p = item.path();
        if p.is_file() {
            let size = item.metadata().map(|m| m.len()).unwrap_or(0);
            if fs::remove_file(&p).is_ok() {
                freed += size;
            }
        }
    }
    Ok(freed)
}

#[cfg(windows)]
mod shell {
    use image::{DynamicImage, RgbaImage};
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::path::Path;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
        SIIGBF_THUMBNAILONLY,
    };

    unsafe fn bitmap_to_rgba(hbmp: HBITMAP) -> Option<RgbaImage> {
        let mut bmp = BITMAP::default();
        if GetObjectW(
            HGDIOBJ(hbmp.0),
            size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut BITMAP as *mut c_void),
        ) == 0
        {
            return None;
        }
        let width = bmp.bmWidth;
        let height = bmp.bmHeight;
        if width <= 0 || height <= 0 || (width as i64) * (height as i64) > 64_000_000 {
            return None;
        }

        let hdc = GetDC(None);
        if hdc.is_invalid() {
            return None;
        }
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB.0;

        let mut buf = vec![0u8; (width as usize) * (height as usize) * 4];
        let lines = GetDIBits(
            hdc,
            hbmp,
            0,
            height as u32,
            Some(buf.as_mut_ptr() as *mut c_void),
            &mut info,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, hdc);
        if lines == 0 {
            return None;
        }

        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        if buf.chunks_exact(4).all(|px| px[3] == 0) {
            for px in buf.chunks_exact_mut(4) {
                px[3] = 255;
            }
        }
        RgbaImage::from_raw(width as u32, height as u32, buf)
    }

    pub fn image(path: &Path, size: u32, icon_only: bool) -> Option<DynamicImage> {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        unsafe {
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let initialized = hr.is_ok();
            let target = size.max(32) as i32;
            let flags = if icon_only {
                SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK
            } else {
                SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK
            };

            let result: Option<HBITMAP> = (|| {
                let factory: IShellItemImageFactory =
                    SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()?;
                let hbmp = factory
                    .GetImage(
                        SIZE {
                            cx: target,
                            cy: target,
                        },
                        flags,
                    )
                    .ok()?;
                Some(hbmp)
            })();

            let out = result.and_then(|hbmp| {
                let converted = bitmap_to_rgba(hbmp);
                let _ = DeleteObject(HGDIOBJ(hbmp.0));
                converted
            });
            if initialized {
                CoUninitialize();
            }
            out.map(DynamicImage::ImageRgba8)
        }
    }
}

#[cfg(windows)]
mod pdf_win {
    use image::DynamicImage;
    use std::path::{Path, PathBuf};

    pub fn first_page(path: &Path, size: u32) -> Option<DynamicImage> {
        let path: PathBuf = path.to_path_buf();
        // WinRT needs a COM apartment; a dedicated thread keeps its MTA state
        // away from the shell thumbnail calls, which use their own STA.
        std::thread::spawn(move || first_page_inner(&path, size))
            .join()
            .ok()
            .flatten()
    }

    fn first_page_inner(path: &Path, size: u32) -> Option<DynamicImage> {
        use windows::core::HSTRING;
        use windows::Data::Pdf::{PdfDocument, PdfPageRenderOptions};
        use windows::Storage::Streams::{DataReader, InMemoryRandomAccessStream};
        use windows::Storage::StorageFile;
        use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

        unsafe { RoInitialize(RO_INIT_MULTITHREADED).ok()? };
        let hpath = HSTRING::from(path.to_string_lossy().as_ref());
        let file = StorageFile::GetFileFromPathAsync(&hpath).ok()?.join().ok()?;
        let doc = PdfDocument::LoadFromFileAsync(&file).ok()?.join().ok()?;
        if doc.IsPasswordProtected().ok()? || doc.PageCount().ok()? == 0 {
            return None;
        }

        let page = doc.GetPage(0).ok()?;
        let bounds = page.Size().ok()?;
        let width = bounds.Width.max(1.0);
        let height = bounds.Height.max(1.0);
        let target_w = size.clamp(32, 2048);
        let target_h = ((target_w as f32 * height / width).round() as u32).clamp(1, 4096);
        let options = PdfPageRenderOptions::new().ok()?;
        options.SetDestinationWidth(target_w).ok()?;
        options.SetDestinationHeight(target_h).ok()?;

        let stream = InMemoryRandomAccessStream::new().ok()?;
        page.RenderWithOptionsToStreamAsync(&stream, &options)
            .ok()?
            .join()
            .ok()?;
        let len = stream.Size().ok()?;
        if len == 0 || len > 64 * 1024 * 1024 {
            return None;
        }
        stream.Seek(0).ok()?;
        let reader = DataReader::CreateDataReader(&stream).ok()?;
        reader.LoadAsync(len as u32).ok()?.join().ok()?;
        let mut bytes = vec![0u8; len as usize];
        reader.ReadBytes(&mut bytes).ok()?;
        let _ = reader.Close();
        let _ = page.Close();
        image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).ok()
    }
}

#[cfg(target_os = "linux")]
mod linux_media {
    use super::{paths, DynamicImage};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::OnceLock;

    fn has_command(name: &str) -> bool {
        static FFMPEG: OnceLock<bool> = OnceLock::new();
        static PDFTOPPM: OnceLock<bool> = OnceLock::new();
        static FFPROBE: OnceLock<bool> = OnceLock::new();
        match name {
            "ffmpeg" => *FFMPEG.get_or_init(|| probe("ffmpeg")),
            "pdftoppm" => *PDFTOPPM.get_or_init(|| probe("pdftoppm")),
            "ffprobe" => *FFPROBE.get_or_init(|| probe("ffprobe")),
            _ => false,
        }
    }

    fn probe(name: &str) -> bool {
        Command::new(name)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn temp_path(dir: &Path, tag: &str, ext: &str) -> PathBuf {
        dir.join(format!(
            ".probe-{}-{}-{tag}.{ext}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
    }

    pub fn video_frame(path: &Path, size: u32, dir: &Path) -> Option<DynamicImage> {
        if !has_command("ffmpeg") {
            return None;
        }
        let _ = std::fs::create_dir_all(dir);
        let out = temp_path(dir, "frame", "jpg");
        let scale = format!(
            "scale={s}:{s}:force_original_aspect_ratio=decrease",
            s = size
        );
        let status = Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                "0.4",
                "-i",
            ])
            .arg(path)
            .args(["-frames:v", "1", "-vf", &scale, "-q:v", "3"])
            .arg(&out)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?;
        let image = if status.success() {
            image::open(&out).ok()
        } else {
            None
        };
        let _ = std::fs::remove_file(&out);
        image
    }

    pub fn pdf_first_page(path: &Path, size: u32, dir: &Path) -> Option<DynamicImage> {
        if !has_command("pdftoppm") {
            return None;
        }
        let _ = std::fs::create_dir_all(dir);
        let prefix = temp_path(dir, "pdf", "");
        let status = Command::new("pdftoppm")
            .args([
                "-f",
                "1",
                "-l",
                "1",
                "-singlefile",
                "-scale-to",
                &size.to_string(),
                "-png",
            ])
            .arg(path)
            .arg(&prefix)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok()?;
        let out = prefix.with_extension("png");
        let image = if status.success() {
            image::open(&out).ok()
        } else {
            None
        };
        let _ = std::fs::remove_file(&paths::text(&out));
        image
    }
}
