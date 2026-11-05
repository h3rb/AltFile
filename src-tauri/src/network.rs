use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetworkPlace {
    pub id: String,
    pub name: String,
    pub path: String,
    /// `share` for `\\server\share`, `server` for a machine whose shares could not be listed.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[tauri::command]
pub async fn network_places() -> Vec<NetworkPlace> {
    scan()
}

/// The shell Network folder can block for tens of seconds on the first probe, so it is asked for
/// separately and its answer arrives in the sidebar whenever Windows finally resolves it.
#[tauri::command]
pub async fn network_computers() -> Vec<NetworkPlace> {
    computers()
}

#[cfg(windows)]
fn scan() -> Vec<NetworkPlace> {
    windows::scan()
}

#[cfg(windows)]
fn computers() -> Vec<NetworkPlace> {
    windows::computers()
}

#[cfg(not(windows))]
fn scan() -> Vec<NetworkPlace> {
    Vec::new()
}

#[cfg(not(windows))]
fn computers() -> Vec<NetworkPlace> {
    Vec::new()
}

#[cfg(windows)]
mod windows {
    use super::NetworkPlace;
    use std::collections::{BTreeMap, BTreeSet};
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::time::{Duration, Instant};
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, HANDLE, HWND, S_OK};
    use windows::Win32::NetworkManagement::WNet::{
        WNetCloseEnum, WNetEnumResourceW, WNetOpenEnumW, NETRESOURCEW, RESOURCETYPE_DISK,
        RESOURCEUSAGE_ALL, RESOURCEUSAGE_CONNECTABLE, RESOURCEUSAGE_CONTAINER, RESOURCE_GLOBALNET,
    };
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::Common::{ITEMIDLIST, STRRET};
    use windows::Win32::UI::Shell::{
        FOLDERID_NetworkFolder, IEnumIDList, IShellFolder, SHGetDesktopFolder,
        SHGetKnownFolderIDList, StrRetToBufW, SHCONTF_FOLDERS, SHCONTF_INCLUDEHIDDEN, SHGDNF,
        SIGDN_FILESYSPATH,
    };

    const MAX_SERVERS: usize = 24;
    const MAX_SHARES: usize = 240;
    const BUDGET: Duration = Duration::from_secs(6);
    const SERVER_WAIT: Duration = Duration::from_secs(2);
    const SHELL_BUDGET: Duration = Duration::from_secs(45);
    const PER_CALL: usize = 64;
    const STRING_SLACK: usize = 2048;

    struct Node {
        path: String,
        comment: String,
        container: bool,
        connectable: bool,
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    unsafe fn text(value: &PWSTR) -> String {
        if value.is_null() {
            String::new()
        } else {
            unsafe { value.to_string() }.unwrap_or_default()
        }
    }

    /// `\\workgroup\server\share\extra` → `["workgroup", "server", "share", "extra"]`
    fn unc_parts(remote: &str) -> Vec<String> {
        let normalized = remote.replace('/', "\\");
        let body = match normalized.strip_prefix("\\\\") {
            Some(body) => body,
            None => return Vec::new(),
        };
        body.split('\\')
            .filter(|bit| !bit.is_empty())
            .map(|bit| bit.to_string())
            .collect()
    }

    fn enumerate(parent: Option<&str>) -> Vec<Node> {
        let mut out = Vec::new();
        let parent_wide = parent.map(|p| wide(p));
        let resource = NETRESOURCEW {
            dwScope: RESOURCE_GLOBALNET,
            dwType: RESOURCETYPE_DISK,
            dwDisplayType: 0,
            dwUsage: 0,
            lpLocalName: PWSTR::null(),
            lpRemoteName: PWSTR(
                parent_wide
                    .as_ref()
                    .map(|bits| bits.as_ptr() as *mut u16)
                    .unwrap_or(std::ptr::null_mut()),
            ),
            lpComment: PWSTR::null(),
            lpProvider: PWSTR::null(),
        };

        let mut handle = HANDLE::default();
        if unsafe {
            WNetOpenEnumW(
                RESOURCE_GLOBALNET,
                RESOURCETYPE_DISK,
                RESOURCEUSAGE_ALL,
                Some(&resource as *const NETRESOURCEW),
                &mut handle,
            )
        }
        .is_err()
        {
            return out;
        }

        loop {
            // One buffer holds both the structures and the strings they point at, so it has to be
            // aligned for NETRESOURCEW while still carrying the text that follows it.
            let bytes = PER_CALL * (std::mem::size_of::<NETRESOURCEW>() + STRING_SLACK);
            let mut buffer: Vec<u64> = vec![0u64; (bytes + 7) / 8];
            let mut count = u32::MAX;
            let mut size = (buffer.len() * 8) as u32;
            let status = unsafe {
                WNetEnumResourceW(
                    handle,
                    &mut count,
                    buffer.as_mut_ptr() as *mut c_void,
                    &mut size,
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                break;
            }
            if status.is_err() && status != ERROR_MORE_DATA {
                break;
            }
            let taken = (count as usize).min(PER_CALL);
            if taken == 0 {
                break;
            }
            let items = unsafe {
                std::slice::from_raw_parts(buffer.as_ptr() as *const NETRESOURCEW, taken)
            };
            for item in items {
                let remote = unsafe { text(&item.lpRemoteName) };
                if remote.is_empty() {
                    continue;
                }
                out.push(Node {
                    comment: unsafe { text(&item.lpComment) },
                    container: item.dwUsage & RESOURCEUSAGE_CONTAINER.0 != 0,
                    connectable: item.dwUsage & RESOURCEUSAGE_CONNECTABLE.0 != 0,
                    path: remote,
                });
            }
            if status.is_ok() {
                break;
            }
        }

        let _ = unsafe { WNetCloseEnum(handle) };
        out
    }

    /// A dead server keeps `WNetEnumResourceW` blocked for minutes and the first probe of the
    /// shell Network folder blocks while Windows resolves it, so every entry point runs on its
    /// own thread and its result is dropped if the budget expires first.
    fn within<T: Send + 'static>(
        limit: Duration,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = sender.send(work());
        });
        receiver.recv_timeout(limit).ok()
    }

    fn enumerate_within(parent: Option<&str>, limit: Duration) -> Vec<Node> {
        let remote = parent.map(|value| value.to_string());
        within(limit, move || enumerate(remote.as_deref())).unwrap_or_default()
    }

    /// Computers published in the shell Network folder. On many machines this is the only source
    /// that still works, because browser-service enumeration behind `WNetOpenEnum` is often off.
    fn shell_computers(deadline: Instant) -> Vec<String> {
        let mut out = Vec::new();
        let com = crate::shellmenu::win::ComGuard::init();
        if !com.active() {
            return out;
        }

        let Ok(desktop) = (unsafe { SHGetDesktopFolder() }) else {
            return out;
        };
        let Ok(root) = (unsafe { SHGetKnownFolderIDList(&FOLDERID_NetworkFolder, 0, None) }) else {
            return out;
        };
        let folder = match unsafe {
            desktop.BindToObject::<_, IShellFolder>(root as *const ITEMIDLIST, None)
        } {
            Ok(folder) => folder,
            Err(_) => {
                unsafe { CoTaskMemFree(Some(root as *const c_void)) };
                return out;
            }
        };
        unsafe { CoTaskMemFree(Some(root as *const c_void)) };

        let flags = (SHCONTF_FOLDERS.0 | SHCONTF_INCLUDEHIDDEN.0) as u32;
        let mut enumerator: Option<IEnumIDList> = None;
        if unsafe { folder.EnumObjects(HWND::default(), flags, &mut enumerator) }.is_err() {
            return out;
        }
        let Some(enumerator) = enumerator else {
            return out;
        };

        let mut buffer = [0u16; 1024];
        loop {
            if Instant::now() >= deadline || out.len() >= MAX_SERVERS {
                break;
            }
            let mut pidls = [std::ptr::null_mut::<ITEMIDLIST>(); 1];
            let mut fetched = 0u32;
            let status = unsafe { enumerator.Next(&mut pidls, Some(&mut fetched)) };
            let pidl = pidls[0];
            if status != S_OK || fetched == 0 || pidl.is_null() {
                break;
            }
            let mut name = String::new();
            let mut strret = STRRET::default();
            let dn_flags = SHGDNF(SIGDN_FILESYSPATH.0 as u32);
            let displayed = unsafe {
                folder.GetDisplayNameOf(pidl as *const ITEMIDLIST, dn_flags, &mut strret)
            };
            if displayed.is_ok() {
                let copied = unsafe {
                    StrRetToBufW(&mut strret, Some(pidl as *const ITEMIDLIST), &mut buffer)
                };
                if copied.is_ok() {
                    let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
                    name = String::from_utf16_lossy(&buffer[..end]);
                }
            }
            if let Some(host) = name
                .strip_prefix("\\\\")
                .and_then(|rest| rest.split('\\').next())
            {
                if !host.is_empty() {
                    out.push(format!("\\\\{host}"));
                }
            }
            unsafe { CoTaskMemFree(Some(pidl as *const c_void)) };
        }

        out
    }

    pub fn scan() -> Vec<NetworkPlace> {
        let deadline = Instant::now() + BUDGET;
        let mut servers: BTreeSet<String> = BTreeSet::new();
        let mut shares: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();

        let mut collect = |node: &Node| {
            let parts = unc_parts(&node.path);
            match parts.len() {
                1 => {
                    servers.insert(format!("\\\\{}", parts[0]));
                }
                2 => {
                    let server = format!("\\\\{}", parts[0]);
                    shares
                        .entry(server)
                        .or_default()
                        .push((parts[1].clone(), node.comment.clone()));
                }
                _ => {}
            }
        };

        let mut containers = Vec::new();
        for node in enumerate_within(None, SERVER_WAIT) {
            if node.container && !node.connectable {
                containers.push(node.path.clone());
            }
            collect(&node);
        }

        for container in containers.into_iter().take(MAX_SERVERS) {
            if Instant::now() >= deadline {
                break;
            }
            for node in enumerate_within(Some(&container), SERVER_WAIT) {
                collect(&node);
            }
        }

        let mut out: Vec<NetworkPlace> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();

        for server in servers.iter().take(MAX_SERVERS) {
            let mut listed = shares.remove(server).unwrap_or_default();
            if listed.is_empty() && Instant::now() < deadline {
                for node in enumerate_within(Some(server), SERVER_WAIT) {
                    let parts = unc_parts(&node.path);
                    if parts.len() >= 2 {
                        listed.push((parts[1].clone(), node.comment.clone()));
                    }
                }
            }
            if listed.is_empty() {
                push(
                    &mut out,
                    &mut seen,
                    server.trim_start_matches('\\').to_string(),
                    server.clone(),
                    "server",
                    String::new(),
                );
                continue;
            }
            for (name, comment) in listed {
                if name.eq_ignore_ascii_case("IPC$") {
                    continue;
                }
                let path = format!("{}\\{}", server, name);
                push(&mut out, &mut seen, name, path, "share", comment);
                if out.len() >= MAX_SHARES {
                    return out;
                }
            }
        }

        for (server, listed) in shares {
            for (name, comment) in listed {
                if name.eq_ignore_ascii_case("IPC$") {
                    continue;
                }
                let path = format!("{}\\{}", server, name);
                push(&mut out, &mut seen, name, path, "share", comment);
            }
        }

        out
    }

    /// Machines published in the shell Network folder, each with its shares when they answer fast
    /// and as a bare server otherwise.
    pub fn computers() -> Vec<NetworkPlace> {
        let started = Instant::now();
        let hosts = within(SHELL_BUDGET, move || {
            shell_computers(started + SHELL_BUDGET)
        });
        let mut out: Vec<NetworkPlace> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();

        for server in hosts.unwrap_or_default() {
            let mut listed = Vec::new();
            for node in enumerate_within(Some(&server), SERVER_WAIT) {
                let parts = unc_parts(&node.path);
                if parts.len() >= 2 {
                    listed.push((parts[1].clone(), node.comment.clone()));
                }
            }
            if listed.is_empty() {
                push(
                    &mut out,
                    &mut seen,
                    server.trim_start_matches('\\').to_string(),
                    server.clone(),
                    "server",
                    String::new(),
                );
                continue;
            }
            for (name, comment) in listed {
                if name.eq_ignore_ascii_case("IPC$") {
                    continue;
                }
                let path = format!("{}\\{}", server, name);
                push(&mut out, &mut seen, name, path, "share", comment);
            }
        }

        out
    }

    fn push(
        out: &mut Vec<NetworkPlace>,
        seen: &mut BTreeSet<String>,
        name: String,
        path: String,
        kind: &str,
        comment: String,
    ) {
        if out.len() >= MAX_SHARES || !seen.insert(path.to_lowercase()) {
            return;
        }
        out.push(NetworkPlace {
            id: format!("net-{}", path.to_lowercase()),
            name,
            path,
            kind: kind.to_string(),
            comment: (!comment.trim().is_empty()).then(|| comment.trim().to_string()),
        });
    }

    #[cfg(test)]
    fn unc_probe(remote: &str) -> Vec<String> {
        unc_parts(remote)
    }

    #[cfg(test)]
    #[test]
    fn splits_unc_paths() {
        assert_eq!(unc_probe(r"\\NAS"), ["NAS".to_string()]);
        assert_eq!(
            unc_probe(r"\\NAS\Public\docs"),
            ["NAS".to_string(), "Public".to_string(), "docs".to_string()]
        );
        assert_eq!(
            unc_probe(r"//NAS/Public/"),
            ["NAS".to_string(), "Public".to_string()]
        );
        assert!(unc_probe(r"C:\Users").is_empty());
        assert!(unc_probe(r"\\").is_empty());
    }
}
