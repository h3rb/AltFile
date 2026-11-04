mod fsops;
mod media;
mod paths;
mod search;
mod settings;
mod thumbs;
mod viz;

use serde::Serialize;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct AppState {
    pub data_dir: PathBuf,
    pub thumb_dir: PathBuf,
    pub portable: bool,
    pub scan_gen: Arc<AtomicU64>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub home: String,
    pub platform: String,
    pub sep: String,
    pub portable: bool,
    pub data_dir: String,
    pub cache_dir: String,
    pub version: String,
}

#[tauri::command]
fn app_info(state: tauri::State<'_, AppState>) -> AppInfo {
    AppInfo {
        home: paths::text(&paths::home()),
        platform: std::env::consts::OS.to_string(),
        sep: std::path::MAIN_SEPARATOR.to_string(),
        portable: state.portable,
        data_dir: paths::text(&state.data_dir),
        cache_dir: paths::text(&state.thumb_dir),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn portable_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("ALTFE_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    let marker = exe_dir().join("portable.txt");
    if marker.is_file() {
        return Some(exe_dir().join("data"));
    }
    None
}

fn valid_cache_name(name: &str) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    ext == "jpg" && stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit())
}

fn serve_thumbnail<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    use tauri::http::{header, Response, StatusCode};

    let state = ctx.app_handle().state::<AppState>();
    let name = request.uri().path().trim_start_matches('/');

    if !valid_cache_name(name) {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .body(Cow::Owned(Vec::new()))
            .expect("static response");
    }

    let file = state.thumb_dir.join(name);
    match std::fs::read(&file) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(
                header::CACHE_CONTROL,
                "public, max-age=31536000, immutable",
            )
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Owned(bytes))
            .expect("valid thumbnail response"),
        Err(_) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Cow::Owned(Vec::new()))
            .expect("static response"),
    }
}

pub fn run() {
    #[cfg(windows)]
    {
        if let Some(root) = portable_root() {
            let webview_data = root.join("webview");
            let _ = std::fs::create_dir_all(&webview_data);
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", webview_data);
        }
    }

    tauri::Builder::default()
        .register_uri_scheme_protocol("thumb", serve_thumbnail)
        .register_uri_scheme_protocol("media", media::serve)
        .setup(|app| {
            let portable = portable_root();
            let data_dir = match &portable {
                Some(root) => root.clone(),
                None => app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| exe_dir().join("data")),
            };
            let thumb_dir = if portable.is_some() {
                data_dir.join("thumbnails")
            } else {
                app.path()
                    .app_cache_dir()
                    .unwrap_or_else(|_| data_dir.join("thumbnails"))
                    .join("thumbnails")
            };

            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&thumb_dir)?;

            app.manage(AppState {
                data_dir,
                thumb_dir: thumb_dir.clone(),
                portable: portable.is_some(),
                scan_gen: Arc::new(AtomicU64::new(0)),
                watcher: Mutex::new(None),
            });

            std::thread::spawn(move || {
                thumbs::prune(&thumb_dir, 512 * 1024 * 1024);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            fsops::list_dir,
            fsops::list_places,
            fsops::open_path,
            fsops::reveal_path,
            fsops::copy_text,
            fsops::file_info,
            fsops::text_preview,
            fsops::copy_paths,
            fsops::delete_paths,
            fsops::create_folder,
            fsops::rename_path,
            fsops::watch_directory,
            thumbs::thumbnail,
            thumbs::thumbnail_cache_stats,
            thumbs::clear_thumbnail_cache,
            viz::viz_scan,
            viz::cancel_scan,
            search::search_files,
            settings::load_settings,
            settings::save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running Alt File Explorer");
}
