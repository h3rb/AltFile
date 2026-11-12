mod archive;
mod fonts;
mod fsops;
mod media;
mod mesh;
mod network;
mod pages;
mod paths;
mod render;
mod search;
mod settings;
mod shellmenu;
mod thumbs;
mod viz;

use serde::Serialize;
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

pub struct AppState {
    pub data_dir: PathBuf,
    pub thumb_dir: PathBuf,
    pub portable: bool,
    pub scan_gen: Arc<AtomicU64>,
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pub pending_path: Mutex<Option<String>>,
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

fn launch_path_from<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let args: Vec<String> = args
        .into_iter()
        .map(|arg| arg.as_ref().to_string())
        .collect();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        let value = if let Some(rest) = arg.strip_prefix("--path=") {
            Some(rest.to_string())
        } else if arg == "--path" {
            index += 1;
            args.get(index).cloned()
        } else {
            None
        };
        if let Some(value) = value {
            let path = value.trim().trim_matches('"').to_string();
            if !path.is_empty() && std::path::Path::new(&path).is_dir() {
                return Some(path);
            }
        }
        index += 1;
    }
    None
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn forward_launch_path(app: &tauri::AppHandle, path: String) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut pending) = state.pending_path.lock() {
            *pending = Some(path.clone());
        }
    }
    let _ = app.emit("open-path", path);
    focus_main_window(app);
}

#[tauri::command]
fn take_launch_path(state: tauri::State<'_, AppState>) -> Option<String> {
    state
        .pending_path
        .lock()
        .ok()
        .and_then(|mut pending| pending.take())
}

#[tauri::command]
fn install_explorer_menu() -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        const LABEL: &str = "Explore in AltFile";
        const VERB_KEY: &str = r"HKCU\Software\Classes\Directory\shell\AltFileExplore";

        let exe = std::env::current_exe()
            .map_err(|error| format!("Could not locate the app executable: {error}"))?;
        let exe = exe.display().to_string();
        let icon = format!("\"{exe}\"");
        let command = format!("\"{exe}\" --path \"%1\"");
        let command_key = format!("{VERB_KEY}\\command");

        let add = |args: &[&str]| -> Result<(), String> {
            let status = Command::new("reg")
                .args(args)
                .creation_flags(0x0800_0000)
                .status()
                .map_err(|error| format!("Could not run reg.exe: {error}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("reg.exe failed with status {status}"))
            }
        };

        add(&["add", VERB_KEY, "/ve", "/d", LABEL, "/f"])?;
        add(&["add", VERB_KEY, "/v", "Icon", "/d", &icon, "/f"])?;
        add(&["add", &command_key, "/ve", "/d", &command, "/f"])?;

        Ok(LABEL.to_string())
    }
    #[cfg(not(windows))]
    {
        Err("File Explorer integration is only available on Windows".to_string())
    }
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
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
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
    let launch_path =
        launch_path_from(std::env::args_os().map(|arg| arg.to_string_lossy().into_owned()));

    #[cfg(windows)]
    {
        if let Some(root) = portable_root() {
            let webview_data = root.join("webview");
            let _ = std::fs::create_dir_all(&webview_data);
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", webview_data);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = launch_path_from(argv) {
                forward_launch_path(app, path);
            } else {
                focus_main_window(app);
            }
        }))
        .plugin(tauri_plugin_drag::init())
        .register_uri_scheme_protocol("thumb", serve_thumbnail)
        .register_uri_scheme_protocol("media", media::serve)
        .register_uri_scheme_protocol("font", fonts::serve)
        .register_uri_scheme_protocol("page", pages::serve)
        .setup(move |app| {
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
                pending_path: Mutex::new(launch_path),
            });

            std::thread::spawn(move || {
                thumbs::prune(&thumb_dir, 512 * 1024 * 1024);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            fsops::list_dir,
            fsops::folder_counts,
            fsops::folder_size,
            archive::archive_summary,
            fsops::list_places,
            network::network_places,
            network::network_computers,
            fsops::open_path,
            fsops::open_url,
            fsops::reveal_path,
            fsops::copy_text,
            fsops::file_info,
            mesh::mesh_bounds,
            mesh::mesh_geometry,
            fsops::text_preview,
            fsops::copy_paths,
            fsops::delete_paths,
            fsops::create_folder,
            fsops::rename_path,
            fsops::watch_directory,
            shellmenu::shell_menu_items,
            shellmenu::shell_menu_invoke,
            thumbs::thumbnail,
            thumbs::thumbnail_cache_stats,
            thumbs::clear_thumbnail_cache,
            viz::viz_scan,
            viz::cancel_scan,
            search::search_files,
            settings::load_settings,
            settings::save_settings,
            take_launch_path,
            install_explorer_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running Alt File Explorer");
}
