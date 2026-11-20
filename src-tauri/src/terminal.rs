use crate::paths;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShellKind {
    Default,
    Cmd,
    Powershell,
    GitBash,
}

#[derive(Serialize)]
pub struct ShellOption {
    id: ShellKind,
    label: &'static str,
    available: bool,
}

#[derive(Clone, Serialize)]
pub struct TerminalExit {
    code: Option<u32>,
    error: Option<String>,
}

#[derive(Default, Serialize)]
pub struct TerminalOutput {
    data: Vec<u8>,
    exit: Option<TerminalExit>,
}

#[derive(Serialize)]
pub struct TerminalInfo {
    id: u64,
    path: String,
}

enum Frame {
    Data(Vec<u8>),
    Exit(TerminalExit),
}

struct Session {
    id: u64,
    stopping: AtomicBool,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    output: Mutex<Option<Receiver<Frame>>>,
    closed: (Mutex<bool>, Condvar),
}

#[derive(Default)]
pub struct TerminalState {
    session: Arc<Mutex<Option<Arc<Session>>>>,
    next_id: AtomicU64,
}

fn pty_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=1000).contains(&cols) || !(1..=500).contains(&rows) {
        return Err("Invalid terminal dimensions".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[cfg(windows)]
fn find_program(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|value| {
        std::env::split_paths(&value)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    })
}

#[cfg(windows)]
fn shell_program(shell: ShellKind) -> Option<PathBuf> {
    let system = std::env::var_os("SystemRoot").map(PathBuf::from)?;
    match shell {
        ShellKind::Default => std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute() && p.is_file())
            .or_else(|| Some(system.join("System32/cmd.exe"))),
        ShellKind::Cmd => Some(system.join("System32/cmd.exe")),
        ShellKind::Powershell => find_program("pwsh.exe")
            .or_else(|| Some(system.join("System32/WindowsPowerShell/v1.0/powershell.exe"))),
        ShellKind::GitBash => {
            let mut candidates = Vec::new();
            for key in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(root) = std::env::var_os(key) {
                    candidates.push(PathBuf::from(root).join("Git/bin/bash.exe"));
                }
            }
            if let Some(root) = std::env::var_os("LOCALAPPDATA") {
                candidates.push(PathBuf::from(root).join("Programs/Git/bin/bash.exe"));
            }
            if let Some(git) = find_program("git.exe") {
                if let Some(root) = git.parent().and_then(Path::parent) {
                    candidates.push(root.join("bin/bash.exe"));
                }
            }
            candidates.into_iter().find(|p| p.is_file())
        }
    }
    .filter(|p| p.is_file())
    .map(|p| paths::canonical(&p))
}

#[cfg(not(windows))]
fn shell_program(shell: ShellKind) -> Option<PathBuf> {
    match shell {
        ShellKind::Default => Some(PathBuf::from("/bin/sh")),
        _ => None,
    }
}

fn shell_command(shell: ShellKind, path: &Path) -> Result<CommandBuilder, String> {
    let mut cmd = if cfg!(not(windows)) && matches!(shell, ShellKind::Default) {
        CommandBuilder::new_default_prog()
    } else {
        let program = shell_program(shell).ok_or("This shell is not installed")?;
        let mut cmd = CommandBuilder::new(program);
        match shell {
            ShellKind::Cmd => cmd.arg("/D"),
            ShellKind::Powershell => cmd.args(["-NoLogo"]),
            ShellKind::GitBash => {
                cmd.args(["--login", "-i"]);
                cmd.env("CHERE_INVOKING", "1");
            }
            ShellKind::Default => {}
        }
        cmd
    };
    cmd.cwd(path);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env_remove("ALTFE_DATA_DIR");
    cmd.env_remove("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
    cmd.env_remove("WEBVIEW2_USER_DATA_FOLDER");
    Ok(cmd)
}

impl Session {
    fn spawn(id: u64, cmd: CommandBuilder, size: PtySize) -> Result<Arc<Self>, String> {
        #[cfg(windows)]
        // Shells must not inherit a launcher’s ignored Ctrl+C flag.
        unsafe { windows::Win32::System::Console::SetConsoleCtrlHandler(None, false) }
            .map_err(|e| format!("Could not enable terminal interrupts: {e}"))?;
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        #[cfg(unix)]
        let mut reader = {
            use std::os::fd::BorrowedFd;
            let fd = pair
                .master
                .as_raw_fd()
                .ok_or("PTY has no file descriptor")?;
            let owned = unsafe { BorrowedFd::borrow_raw(fd) }
                .try_clone_to_owned()
                .map_err(|e| e.to_string())?;
            std::fs::File::from(owned)
        };
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
        drop(pair.slave);
        let (tx, rx) = mpsc::sync_channel(16);
        let exit = Arc::new((Mutex::new(None::<TerminalExit>), Condvar::new()));
        let session = Arc::new(Self {
            id,
            stopping: AtomicBool::new(false),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            output: Mutex::new(Some(rx)),
            closed: (Mutex::new(false), Condvar::new()),
        });
        let read_exit = exit.clone();
        #[cfg(unix)]
        let reading = session.clone();
        let reader_thread = std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut delivering = true;
            #[cfg(unix)]
            let mut exit_bytes = 0;
            loop {
                #[cfg(unix)]
                {
                    use std::os::fd::AsRawFd;
                    if reading.stopping.load(Ordering::Acquire) {
                        break;
                    }
                    let exited = read_exit.0.lock().unwrap().is_some();
                    // Drain queued bytes without following a surviving background job indefinitely.
                    if exited && exit_bytes >= 1048576 {
                        break;
                    }
                    let mut poll = libc::pollfd {
                        fd: reader.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    let result = unsafe { libc::poll(&mut poll, 1, if exited { 0 } else { 100 }) };
                    if result < 0 {
                        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
                        {
                            continue;
                        }
                        break;
                    }
                    if result == 0 {
                        if exited {
                            break;
                        }
                        continue;
                    }
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        #[cfg(unix)]
                        if read_exit.0.lock().unwrap().is_some() {
                            exit_bytes += count;
                        }
                        if delivering && tx.send(Frame::Data(buffer[..count].to_vec())).is_err() {
                            delivering = false;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let (lock, ready) = &*read_exit;
            let status = ready
                .wait_while(lock.lock().unwrap(), |status| status.is_none())
                .unwrap();
            if delivering {
                let _ = tx.send(Frame::Exit(status.as_ref().unwrap().clone()));
            }
        });
        let running = session.clone();
        std::thread::spawn(move || {
            let result = loop {
                if running.stopping.load(Ordering::Acquire) {
                    let _ = child.kill();
                    break child.wait();
                }
                #[cfg(windows)]
                if let Some(handle) = child.as_raw_handle() {
                    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
                    use windows::Win32::System::Threading::WaitForSingleObject;
                    // Exit code 259 is also STILL_ACTIVE; test process signaling first.
                    if unsafe { WaitForSingleObject(HANDLE(handle), 0) } == WAIT_OBJECT_0 {
                        break child.wait();
                    }
                }
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => std::thread::sleep(Duration::from_millis(40)),
                    Err(error) => break Err(error),
                }
            };
            let status = match result {
                Ok(status) => TerminalExit {
                    code: Some(status.exit_code()),
                    error: None,
                },
                Err(error) => TerminalExit {
                    code: None,
                    error: Some(error.to_string()),
                },
            };
            let (lock, ready) = &*exit;
            *lock.lock().unwrap() = Some(status);
            ready.notify_all();
            // ConPTY teardown must run separately from the output reader, which keeps draining on close.
            let writer = running.writer.lock().unwrap().take();
            drop(writer);
            let master = running.master.lock().unwrap().take();
            drop(master);
            let _ = reader_thread.join();
            *running.closed.0.lock().unwrap() = true;
            running.closed.1.notify_all();
        });
        Ok(session)
    }

    fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        self.output.lock().unwrap().take();
    }
}

impl TerminalState {
    fn get(&self, id: u64) -> Result<Arc<Session>, String> {
        self.session
            .lock()
            .unwrap()
            .as_ref()
            .filter(|session| session.id == id)
            .cloned()
            .ok_or_else(|| "Terminal session is closed".into())
    }

    pub fn shutdown(&self) {
        if let Some(session) = self.session.lock().unwrap().take() {
            session.stop();
            let _ = session.closed.1.wait_timeout_while(
                session.closed.0.lock().unwrap(),
                Duration::from_secs(3),
                |closed| !*closed,
            );
        }
    }
}

impl Drop for TerminalState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[tauri::command]
pub fn terminal_shells() -> Vec<ShellOption> {
    [
        (ShellKind::Default, "OS default"),
        (ShellKind::Cmd, "CMD"),
        (ShellKind::Powershell, "PowerShell"),
        (ShellKind::GitBash, "Git Bash"),
    ]
    .into_iter()
    .map(|(id, label)| ShellOption {
        id,
        label,
        available: shell_program(id).is_some(),
    })
    .collect()
}

#[tauri::command]
pub async fn terminal_start(
    state: tauri::State<'_, TerminalState>,
    path: String,
    shell: ShellKind,
    cols: u16,
    rows: u16,
) -> Result<TerminalInfo, String> {
    let size = pty_size(cols, rows)?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let slot = state.session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = paths::resolve_dir(&path)?;
        let cmd = shell_command(shell, &path)?;
        let mut guard = slot.lock().unwrap();
        if let Some(old) = guard.take() {
            old.stop();
        }
        let session = Session::spawn(id, cmd, size)?;
        *guard = Some(session);
        Ok(TerminalInfo {
            id,
            path: paths::text(&path),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn terminal_read(
    state: tauri::State<'_, TerminalState>,
    id: u64,
) -> Result<TerminalOutput, String> {
    let session = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let guard = session.output.lock().unwrap();
        let rx = guard.as_ref().ok_or("Terminal session is closed")?;
        let mut output = TerminalOutput::default();
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Frame::Data(bytes)) => output.data = bytes,
            Ok(Frame::Exit(status)) => output.exit = Some(status),
            Err(RecvTimeoutError::Timeout) => return Ok(output),
            Err(RecvTimeoutError::Disconnected) => {
                return Err("Terminal output is closed".to_string())
            }
        }
        while output.exit.is_none() && output.data.len() < 65536 {
            match rx.try_recv() {
                Ok(Frame::Data(bytes)) => output.data.extend(bytes),
                Ok(Frame::Exit(status)) => output.exit = Some(status),
                Err(_) => break,
            }
        }
        Ok(output)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn terminal_write(
    state: tauri::State<'_, TerminalState>,
    id: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    if data.len() > 16384 {
        return Err("Terminal input is too large".into());
    }
    let session = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        if session.stopping.load(Ordering::Acquire) {
            return Err("Terminal session is closed".into());
        }
        let mut guard = session.writer.lock().unwrap();
        let writer = guard.as_mut().ok_or("Terminal session has exited")?;
        writer
            .write_all(&data)
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn terminal_resize(
    state: tauri::State<'_, TerminalState>,
    id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let size = pty_size(cols, rows)?;
    let session = state.get(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        session
            .master
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("Terminal session has exited")?
            .resize(size)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn terminal_close(state: tauri::State<'_, TerminalState>, id: u64) -> Result<(), String> {
    let slot = state.session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let session = {
            let mut guard = slot.lock().unwrap();
            if guard.as_ref().is_some_and(|session| session.id == id) {
                guard.take()
            } else {
                None
            }
        };
        if let Some(session) = session {
            session.stop();
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_terminal_size() {
        assert!(pty_size(80, 24).is_ok());
        assert!(pty_size(0, 24).is_err());
        assert!(pty_size(80, 0).is_err());
        assert!(pty_size(u16::MAX, 24).is_err());
    }

    #[test]
    fn rejects_unknown_shell() {
        assert!(serde_json::from_str::<ShellKind>("\"arbitrary-command\"").is_err());
    }

    #[test]
    fn default_shell_is_available() {
        assert!(terminal_shells().first().unwrap().available);
    }

    #[test]
    fn command_keeps_working_directory_separate_from_arguments() {
        let path = Path::new("folder with spaces & symbols");
        let cmd = shell_command(ShellKind::Default, path).unwrap();
        assert_eq!(cmd.get_cwd().unwrap(), path.as_os_str());
    }

    fn test_command(script: &str) -> CommandBuilder {
        #[cfg(windows)]
        let mut cmd = CommandBuilder::new(shell_program(ShellKind::Cmd).unwrap());
        #[cfg(unix)]
        let mut cmd = CommandBuilder::new("/bin/sh");
        #[cfg(windows)]
        cmd.args(["/D", "/C", script]);
        #[cfg(unix)]
        cmd.args(["-c", script]);
        cmd
    }

    fn capture(cmd: CommandBuilder, mut input: Option<(&[u8], &[u8])>) -> (String, TerminalExit) {
        let session = Session::spawn(1, cmd, pty_size(200, 24).unwrap()).unwrap();
        let result = (|| -> Result<_, String> {
            let guard = session.output.lock().unwrap();
            let rx = guard.as_ref().unwrap();
            let mut output = Vec::new();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if std::time::Instant::now() >= deadline {
                    return Err("PTY did not exit".into());
                }
                match rx
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|e| e.to_string())?
                {
                    Frame::Data(bytes) => {
                        output.extend(bytes);
                        if output.ends_with(b"\x1b[6n") {
                            session
                                .writer
                                .lock()
                                .unwrap()
                                .as_mut()
                                .unwrap()
                                .write_all(b"\x1b[1;1R")
                                .unwrap();
                        }
                        if let Some((marker, bytes)) = input {
                            if output.windows(marker.len()).any(|part| part == marker) {
                                session
                                    .writer
                                    .lock()
                                    .unwrap()
                                    .as_mut()
                                    .unwrap()
                                    .write_all(bytes)
                                    .unwrap();
                                input = None;
                            }
                        }
                    }
                    Frame::Exit(status) => {
                        return Ok((String::from_utf8_lossy(&output).into_owned(), status))
                    }
                }
            }
        })();
        session.stop();
        let (closed, _) = session
            .closed
            .1
            .wait_timeout_while(
                session.closed.0.lock().unwrap(),
                Duration::from_secs(3),
                |closed| !*closed,
            )
            .unwrap();
        assert!(*closed, "PTY threads did not close");
        result.unwrap()
    }

    #[test]
    fn streams_output_and_reaps_shell() {
        let (output, status) = capture(test_command("echo TERMINAL_READY"), None);
        assert!(output.contains("TERMINAL_READY"), "PTY output: {output:?}");
        assert_eq!(status.code, Some(0));
    }

    #[cfg(windows)]
    #[test]
    fn reaps_windows_exit_code_259() {
        let (_, status) = capture(test_command("exit 259"), None);
        assert_eq!(status.code, Some(259));
    }

    #[cfg(windows)]
    #[test]
    fn interrupts_a_running_windows_command() {
        let (output, _) = capture(test_command("ping -t 127.0.0.1"), Some((b"TTL=", b"\x03")));
        assert!(output.contains("TTL="));
    }

    #[cfg(unix)]
    #[test]
    fn shell_exit_does_not_wait_for_inherited_slave() {
        let started = std::time::Instant::now();
        let (_, status) = capture(test_command("(trap '' HUP; sleep 3) & exit 7"), None);
        assert_eq!(status.code, Some(7));
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn closes_a_session_without_consuming_output() {
        #[cfg(windows)]
        let cmd = test_command("for /L %i in (1,1,1000000) do @echo TERMINAL_OUTPUT");
        #[cfg(unix)]
        let cmd = test_command("while :; do echo TERMINAL_OUTPUT; done");
        let session = Session::spawn(2, cmd, pty_size(80, 24).unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        session.stop();
        let (closed, _) = session
            .closed
            .1
            .wait_timeout_while(
                session.closed.0.lock().unwrap(),
                Duration::from_secs(3),
                |closed| !*closed,
            )
            .unwrap();
        assert!(*closed, "Blocked PTY output prevented shutdown");
    }
}
