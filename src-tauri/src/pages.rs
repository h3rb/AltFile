use crate::md;
use crate::media::percent_decode;
use crate::paths;
use std::borrow::Cow;
use tauri::http::{header, Request, Response, StatusCode};

const MAX_PAGE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_MARKDOWN_BYTES: usize = 512 * 1024;

fn mime_for(ext: &str) -> Option<&'static str> {
    match ext {
        "html" | "htm" => Some("text/html; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "json" | "map" => Some("application/json"),
        "xml" => Some("application/xml"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "txt" | "md" | "csv" | "log" => Some("text/plain; charset=utf-8"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "ogg" => Some("audio/ogg"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        _ => None,
    }
}

fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .body(Cow::Owned(Vec::new()))
        .expect("static response")
}

/// Serves a local HTML file and its sibling assets to the sandboxed thumbnail
/// iframes. The URL path is the absolute file path, so relative links inside the
/// document resolve to the real neighbouring files.
pub fn serve<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let raw_path = request.uri().path();
    let encoded = raw_path.strip_prefix('/').unwrap_or(raw_path);
    let decoded = match percent_decode(encoded) {
        Some(value) if !value.is_empty() => value,
        _ => return empty(StatusCode::BAD_REQUEST),
    };

    let path = paths::canonical(&paths::expand(&decoded));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = paths::ext_of(&name);
    let markdown = ext == "md" || ext == "markdown";
    let content_type = match mime_for(&ext) {
        Some(value) => value,
        None => return empty(StatusCode::NOT_FOUND),
    };

    let meta = match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_PAGE_BYTES => meta,
        _ => return empty(StatusCode::NOT_FOUND),
    };

    if markdown {
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
        };
        let cut = bytes.len().min(MAX_MARKDOWN_BYTES);
        let text = String::from_utf8_lossy(&bytes[..cut]);
        let html = md::page(&text);
        let length = html.len();
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_LENGTH, length.to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "no-cache")
            .header("x-content-type-options", "nosniff")
            .header(
                "content-security-policy",
                "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
            )
            .body(Cow::Owned(html.into_bytes()))
            .expect("markdown response");
    }

    let body = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
    };

    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, meta.len().to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-content-type-options", "nosniff");
    if content_type.starts_with("text/html") {
        builder = builder.header(
            "content-security-policy",
            "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        );
    }
    builder.body(Cow::Owned(body)).expect("page response")
}
