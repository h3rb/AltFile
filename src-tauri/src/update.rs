use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

const API_URL: &str = "https://api.github.com/repos/h3rb/AltFile/releases/latest";
const USER_AGENT: &str = "AltFileExplorer-Updater";
const WAIT_ENV: &str = "ALTFE_UPDATE_WAIT_PID";

static RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Nsis,
    Portable,
}

impl Kind {
    fn label(self) -> &'static str {
        match self {
            Kind::Nsis => "nsis",
            Kind::Portable => "portable",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Platform {
    Windows,
    Linux,
}

fn platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Clone, Deserialize)]
pub struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: String,
    pub kind: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    phase: &'static str,
    received: u64,
    total: u64,
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<Report, String> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err("An update is already in progress".into());
    }
    let worker = app.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || run(&worker)).await;
    RUNNING.store(false, Ordering::SeqCst);
    let report = match joined {
        Ok(result) => result?,
        Err(error) => return Err(format!("The update task stopped unexpectedly: {error}")),
    };
    let _ = app.emit("update:done", &report);
    std::thread::sleep(Duration::from_millis(400));
    app.exit(0);
    Ok(report)
}

fn run(app: &AppHandle) -> Result<Report, String> {
    let portable = app.state::<AppState>().portable;
    let kind = detect_kind(portable);
    let release = fetch_release(&endpoint())?;
    let version = release.tag_name.trim_start_matches('v').to_string();
    let installed = env!("CARGO_PKG_VERSION");
    if !is_newer(&version, installed) {
        return Err(format!(
            "Alt File Explorer {installed} is already the latest version"
        ));
    }
    let platform = platform();
    let asset = pick_asset(kind, &version, platform, std::env::consts::ARCH, &release.assets)
        .ok_or_else(|| {
            format!(
                "Release {version} does not include a {} package for this platform",
                kind.label()
            )
        })?;
    let name = safe_name(&asset.name);
    let dir = std::env::temp_dir().join("altfe-update");
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not prepare the download folder: {error}"))?;
    let dest = dir.join(name);

    let mut last = Instant::now() - Duration::from_secs(1);
    let received = download(
        &asset.browser_download_url,
        &dest,
        asset.size,
        |received, total| {
            if last.elapsed() >= Duration::from_millis(120) {
                let _ = app.emit("update:progress", Progress { phase: "download", received, total });
                last = Instant::now();
            }
        },
    )?;
    let _ = app.emit(
        "update:progress",
        Progress { phase: "installing", received, total: received },
    );

    match kind {
        Kind::Nsis => apply_nsis(&dest)?,
        Kind::Portable => apply_portable(&dest)?,
    }
    Ok(Report { version, kind: kind.label() })
}

fn endpoint() -> String {
    std::env::var("ALTFE_UPDATE_API")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| API_URL.to_string())
}

fn fetch_release(url: &str) -> Result<Release, String> {
    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(30))
        .call()
        .map_err(|error| format!("Could not reach the release server: {error}"))?;
    response
        .into_json::<Release>()
        .map_err(|error| format!("The release information was not readable: {error}"))
}

fn download<F: FnMut(u64, u64)>(
    url: &str,
    dest: &Path,
    expected: u64,
    mut progress: F,
) -> Result<u64, String> {
    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(Duration::from_secs(30 * 60))
        .call()
        .map_err(|error| format!("Could not download the update: {error}"))?;
    let total = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(expected);
    let mut reader = response.into_reader();
    let mut file = std::fs::File::create(dest)
        .map_err(|error| format!("Could not create the update file: {error}"))?;
    let mut buffer = vec![0u8; 128 * 1024];
    let mut received = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("The update download was interrupted: {error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("Could not save the update: {error}"))?;
        received += read as u64;
        progress(received, total);
    }
    file.flush()
        .map_err(|error| format!("Could not finish saving the update: {error}"))?;
    if received == 0 {
        return Err("The update download was empty".into());
    }
    if total > 0 && received != total {
        return Err(format!("The download stopped early ({received} of {total} bytes)"));
    }
    let mut head = [0u8; 4];
    std::fs::File::open(dest)
        .and_then(|mut file| file.read_exact(&mut head))
        .map_err(|error| format!("The update file could not be read back: {error}"))?;
    if !looks_executable(&head) {
        return Err("The downloaded file is not a valid executable".into());
    }
    Ok(received)
}

fn looks_executable(head: &[u8; 4]) -> bool {
    if cfg!(windows) {
        head.starts_with(b"MZ")
    } else {
        head.starts_with(b"\x7fELF")
    }
}

fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("update");
    let cleaned: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "update.bin".to_string()
    } else {
        cleaned
    }
}

fn win_arch(arch: &str) -> &str {
    match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn pick_asset<'a>(
    kind: Kind,
    version: &str,
    platform: Platform,
    arch: &str,
    assets: &'a [Asset],
) -> Option<&'a Asset> {
    let version = version.trim_start_matches('v');
    if kind == Kind::Nsis {
        return assets
            .iter()
            .find(|asset| asset.name.to_ascii_lowercase().ends_with("-setup.exe"));
    }
    let (exact, suffix) = match platform {
        Platform::Windows => (
            format!("AltFileExplorer-{version}-win-{}.exe", win_arch(arch)),
            format!("-win-{}.exe", win_arch(arch)),
        ),
        Platform::Linux => (
            format!("AltFileExplorer-{version}-linux-{arch}.bin"),
            format!("-linux-{arch}.bin"),
        ),
    };
    assets
        .iter()
        .find(|asset| asset.name == exact)
        .or_else(|| {
            assets.iter().find(|asset| {
                asset.name.starts_with("AltFileExplorer-") && asset.name.ends_with(&suffix)
            })
        })
}

fn parse_version(value: &str) -> Option<(u64, u64, u64)> {
    let trimmed = value.trim().trim_start_matches('v');
    let core = trimmed.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

fn is_newer(latest: &str, installed: &str) -> bool {
    match (parse_version(latest), parse_version(installed)) {
        (Some(latest), Some(installed)) => latest > installed,
        _ => false,
    }
}

fn detect_kind(portable: bool) -> Kind {
    if portable {
        return Kind::Portable;
    }
    #[cfg(windows)]
    {
        if let Some(dir) = nsis_install_dir() {
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf))
                .and_then(|dir| dunce::canonicalize(dir).ok());
            let install_dir = dunce::canonicalize(dir).ok();
            if exe_dir.is_some() && exe_dir == install_dir {
                return Kind::Nsis;
            }
        }
    }
    Kind::Portable
}

#[cfg(windows)]
fn nsis_install_dir() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;

    for root in ["HKCU", "HKLM"] {
        let key = format!(
            "{root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Alt File Explorer"
        );
        let Ok(output) = Command::new("reg")
            .args(["query", &key, "/v", "InstallLocation"])
            .creation_flags(0x0800_0000)
            .output()
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let Some((_, value)) = line.split_once("REG_SZ") else {
                continue;
            };
            let value = value.trim().trim_matches('"');
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

#[cfg(windows)]
fn apply_nsis(installer: &Path) -> Result<(), String> {
    Command::new(installer)
        .args(["/S", "/UPDATE", "/R"])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not start the installer: {error}"))
}

#[cfg(not(windows))]
fn apply_nsis(_installer: &Path) -> Result<(), String> {
    Err("The installer update path is only available on Windows".into())
}

fn apply_portable(downloaded: &Path) -> Result<(), String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("Could not locate the running executable: {error}"))?;
    let dir = exe
        .parent()
        .ok_or("The executable has no parent folder")?
        .to_path_buf();
    let file_name = exe
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("altfileexplorer")
        .to_string();
    let old = dir.join(format!("{file_name}.old-{}", std::process::id()));

    std::fs::rename(&exe, &old)
        .map_err(|error| format!("Could not move the current executable aside: {error}"))?;
    if let Err(error) = std::fs::copy(downloaded, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("Could not write the new executable: {error}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
    }
    let spawned = Command::new(&exe)
        .env(WAIT_ENV, std::process::id().to_string())
        .spawn();
    if let Err(error) = spawned {
        let _ = std::fs::remove_file(&exe);
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("Could not restart the app: {error}"));
    }
    Ok(())
}

/// Called at startup of a freshly updated process: it must not claim the
/// single-instance lock while the old process is still shutting down.
pub fn wait_for_previous() {
    let Some(pid) = std::env::var(WAIT_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
    else {
        return;
    };
    std::env::remove_var(WAIT_ENV);
    if pid == 0 || pid == std::process::id() {
        return;
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && process_alive(pid) {
        std::thread::sleep(Duration::from_millis(40));
    }
    std::thread::sleep(Duration::from_millis(120));
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) else {
            return false;
        };
        let wait = WaitForSingleObject(handle, 0);
        let _ = CloseHandle(handle);
        wait == WAIT_TIMEOUT
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(not(any(windows, unix)))]
fn process_alive(_pid: u32) -> bool {
    false
}

pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let prefix = format!(
                "{}.old-",
                exe.file_name().and_then(|name| name.to_str()).unwrap_or("")
            );
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().starts_with(&prefix) {
                        let _ = std::fs::remove_file(entry.path());
                    }
                }
            }
        }
    }
    let dir = std::env::temp_dir().join("altfe-update");
    if std::fs::remove_dir_all(&dir).is_err() && dir.exists() {
        // The NSIS installer runs from this folder and may still be exiting
        // when the relaunched app starts, so try again once it is gone.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(6));
            if !RUNNING.load(Ordering::SeqCst) {
                let _ = std::fs::remove_dir_all(&dir);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, url: &str) -> Asset {
        Asset {
            name: name.to_string(),
            browser_download_url: url.to_string(),
            size: 7,
        }
    }

    #[test]
    fn picks_portable_windows_binary() {
        let assets = vec![
            asset("AltFileExplorer-0.2.8-win-x64.zip", "zip"),
            asset("AltFileExplorer-0.2.8-win-x64.exe", "exe"),
            asset("Alt File Explorer_0.2.8_x64-setup.exe", "setup"),
        ];
        let picked = pick_asset(Kind::Portable, "v0.2.8", Platform::Windows, "x86_64", &assets)
            .expect("portable asset");
        assert_eq!(picked.name, "AltFileExplorer-0.2.8-win-x64.exe");
    }

    #[test]
    fn picks_linux_binary_by_arch() {
        let assets = vec![
            asset("AltFileExplorer-0.2.8-linux-x86_64.tar.gz", "tar"),
            asset("AltFileExplorer-0.2.8-linux-aarch64.bin", "arm"),
            asset("AltFileExplorer-0.2.8-linux-x86_64.bin", "bin"),
        ];
        let picked = pick_asset(Kind::Portable, "0.2.8", Platform::Linux, "x86_64", &assets)
            .expect("linux asset");
        assert_eq!(picked.name, "AltFileExplorer-0.2.8-linux-x86_64.bin");
    }

    #[test]
    fn picks_nsis_setup() {
        let assets = vec![
            asset("AltFileExplorer-0.2.8-win-x64.exe", "exe"),
            asset("Alt File Explorer_0.2.8_x64-setup.exe", "setup"),
        ];
        let picked = pick_asset(Kind::Nsis, "0.2.8", Platform::Windows, "x86_64", &assets)
            .expect("setup asset");
        assert_eq!(picked.name, "Alt File Explorer_0.2.8_x64-setup.exe");
    }

    #[test]
    fn rejects_missing_assets() {
        let assets = vec![asset("AltFileExplorer-0.2.8-win-x64.zip", "zip")];
        assert!(pick_asset(Kind::Portable, "0.2.8", Platform::Windows, "x86_64", &assets).is_none());
        assert!(pick_asset(Kind::Nsis, "0.2.8", Platform::Windows, "x86_64", &assets).is_none());
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer("v0.2.8", "0.2.7"));
        assert!(is_newer("0.3.0", "0.2.9"));
        assert!(!is_newer("0.2.7", "0.2.7"));
        assert!(!is_newer("0.2.6", "0.2.7"));
        assert!(!is_newer("nonsense", "0.2.7"));
    }

    #[test]
    fn sanitizes_asset_names() {
        assert_eq!(
            safe_name("AltFileExplorer-0.2.8-win-x64.exe"),
            "AltFileExplorer-0.2.8-win-x64.exe"
        );
        assert_eq!(
            safe_name("Alt File Explorer_0.2.8_x64-setup.exe"),
            "Alt_File_Explorer_0.2.8_x64-setup.exe"
        );
        assert_eq!(safe_name("../../evil.exe"), "evil.exe");
    }

    #[test]
    fn downloads_asset_to_disk() {
        use std::io::{Read as _, Write as _};
        use std::net::TcpListener;

        let body: &[u8] = if cfg!(windows) { b"MZpayload" } else { b"\x7fELFpayload" };
        let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
        let address = listener.local_addr().expect("address");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 2048];
                let _ = stream.read(&mut buffer);
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(body);
            }
        });

        let dir = std::env::temp_dir().join(format!("altfe-update-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let dest = dir.join("update.bin");
        let mut seen = Vec::new();
        let received = download(&format!("http://{address}/asset"), &dest, 0, |got, total| {
            seen.push((got, total));
        })
        .expect("download");
        assert_eq!(received, body.len() as u64);
        assert_eq!(std::fs::read(&dest).expect("saved file"), body);
        assert!(seen.iter().all(|(_, total)| *total == body.len() as u64));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
