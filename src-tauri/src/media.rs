use crate::paths;
use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use tauri::http::{header, Method, Request, Response, StatusCode};

const CHUNK: u64 = 16 * 1024 * 1024;
const FULL_CAP: u64 = 64 * 1024 * 1024;

fn mime_for(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        "flv" => "video/x-flv",
        "mpg" | "mpeg" => "video/mpeg",
        "3gp" => "video/3gpp",
        "m2ts" => "video/mp2t",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wma" => "audio/x-ms-wma",
        "mid" | "midi" => "audio/midi",
        "aiff" => "audio/aiff",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

pub(crate) fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (head, tail) = spec.split_once('-')?;
    let (start, end) = if head.trim().is_empty() {
        let suffix: u64 = tail.trim().parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start: u64 = head.trim().parse().ok()?;
        let end = if tail.trim().is_empty() {
            total - 1
        } else {
            tail.trim().parse::<u64>().ok()?.min(total - 1)
        };
        (start, end)
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end))
}

fn base(status: StatusCode) -> tauri::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "range")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "content-range, accept-ranges, content-length",
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
}

fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    base(status)
        .body(Cow::Owned(Vec::new()))
        .expect("static media response")
}

pub fn serve<R: tauri::Runtime>(
    _ctx: tauri::UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    if request.method() == Method::OPTIONS {
        return base(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .body(Cow::Owned(Vec::new()))
            .expect("cors response");
    }

    let raw_path = request.uri().path();
    let encoded = raw_path.strip_prefix('/').unwrap_or(raw_path);
    let decoded = match percent_decode(encoded) {
        Some(value) if !value.is_empty() => value,
        _ => return empty(StatusCode::BAD_REQUEST),
    };

    let path = paths::canonical(&paths::expand(&decoded));
    let meta = match std::fs::metadata(&path) {
        Ok(meta) if meta.is_file() => meta,
        _ => return empty(StatusCode::NOT_FOUND),
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = paths::ext_of(&name);
    let kind = paths::classify(&ext, false);
    let gif = ext == "gif";
    if kind != "audio" && kind != "video" && !gif {
        return empty(StatusCode::FORBIDDEN);
    }
    let cache = if gif {
        "public, max-age=3600"
    } else {
        "no-store"
    };

    let total = meta.len();
    if total == 0 {
        return base(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_for(&ext))
            .header(header::CONTENT_LENGTH, "0")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CACHE_CONTROL, cache)
            .body(Cow::Owned(Vec::new()))
            .expect("empty media response");
    }

    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());

    let (start, end, partial) = match range {
        Some(value) => match parse_range(value, total) {
            Some((start, end)) => (start, end.min(start + CHUNK - 1), true),
            None => {
                return base(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .body(Cow::Owned(Vec::new()))
                    .expect("range response");
            }
        },
        None if total > FULL_CAP => (0, CHUNK - 1, true),
        None => (0, total - 1, false),
    };

    let want = end - start + 1;
    let mut body = Vec::new();
    if request.method() != Method::HEAD {
        let mut file = match File::open(&path) {
            Ok(file) => file,
            Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
        };
        if file.seek(SeekFrom::Start(start)).is_err() {
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
        body.reserve(want as usize);
        if file.by_ref().take(want).read_to_end(&mut body).is_err() {
            return empty(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }

    let length = if request.method() == Method::HEAD {
        want
    } else {
        body.len() as u64
    };
    let end = start + length.saturating_sub(1);

    let mut builder = base(if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    })
    .header(header::CONTENT_TYPE, mime_for(&ext))
    .header(header::ACCEPT_RANGES, "bytes")
    .header(header::CONTENT_LENGTH, length.to_string())
    .header(header::CACHE_CONTROL, cache);
    if partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }

    builder.body(Cow::Owned(body)).expect("media response")
}
