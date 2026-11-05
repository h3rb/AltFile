use crate::media::percent_decode;
use crate::paths;
use std::borrow::Cow;
use tauri::http::{header, Request, Response, StatusCode};

const MAX_FONT_BYTES: u64 = 24 * 1024 * 1024;

fn mime_for(ext: &str) -> Option<&'static str> {
    match ext {
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        _ => None,
    }
}

fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .body(Cow::Owned(Vec::new()))
        .expect("static response")
}

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
    let content_type = match mime_for(&paths::ext_of(&name)) {
        Some(value) => value,
        None => return empty(StatusCode::FORBIDDEN),
    };

    let meta = match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_FONT_BYTES => meta,
        _ => return empty(StatusCode::NOT_FOUND),
    };
    let body = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, meta.len().to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(Cow::Owned(body))
        .expect("font response")
}
