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
    /// Only set for Cross Device entries; `None` when the portable-device probe is unavailable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected: Option<bool>,
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

/// Phones, cameras and other gadgets linked through the Windows Cross Device service. The
/// service mirrors each device as a folder under `%USERPROFILE%\CrossDevice`, and the folder is
/// absent (or empty) when the service is unavailable, so the section disappears with it.
#[tauri::command]
pub async fn cross_device_places() -> Vec<NetworkPlace> {
    devices()
}

#[cfg(windows)]
fn scan() -> Vec<NetworkPlace> {
    windows::scan()
}

#[cfg(windows)]
fn devices() -> Vec<NetworkPlace> {
    windows::devices()
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
fn devices() -> Vec<NetworkPlace> {
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
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Devices::PortableDevices::{
        IPortableDeviceManager, PortableDeviceManager,
    };
    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, HANDLE, HWND, S_OK};
    use windows::Win32::NetworkManagement::WNet::{
        WNetCloseEnum, WNetEnumResourceW, WNetOpenEnumW, NETRESOURCEW, RESOURCETYPE_DISK,
        RESOURCEUSAGE_ALL, RESOURCEUSAGE_CONNECTABLE, RESOURCEUSAGE_CONTAINER, RESOURCE_GLOBALNET,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_INPROC_SERVER};
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

    /// Device folders linger after the Cross Device service loses the gadget, so each name is
    /// compared against the portable devices Windows reports as attached right now.
    fn normalize_device_name(name: &str) -> String {
        name.chars()
            .filter(|ch| ch.is_alphanumeric())
            .flat_map(|ch| ch.to_lowercase())
            .collect()
    }

    fn name_matches(folder: &str, connected: &[String]) -> bool {
        let wanted = normalize_device_name(folder);
        if wanted.is_empty() {
            return false;
        }
        connected.iter().any(|name| {
            let other = normalize_device_name(name);
            if other.is_empty() {
                return false;
            }
            other == wanted
                || (wanted.len() >= 3
                    && other.len() >= 3
                    && (other.contains(&wanted) || wanted.contains(&other)))
        })
    }

    /// Friendly names of the portable devices attached right now; `None` when the WPD service
    /// could not be queried, so callers can leave the devices unbadged instead of guessing.
    fn connected_names() -> Option<Vec<String>> {
        within(Duration::from_secs(3), probe_names).flatten()
    }

    fn probe_names() -> Option<Vec<String>> {
        let com = crate::shellmenu::win::ComGuard::init();
        if !com.active() {
            return None;
        }
        unsafe {
            let manager: IPortableDeviceManager =
                CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER).ok()?;
            let _ = manager.RefreshDeviceList();
            let mut count = 0u32;
            manager.GetDevices(std::ptr::null_mut(), &mut count).ok()?;
            if count == 0 {
                return Some(Vec::new());
            }
            let mut ids = vec![PWSTR::null(); count as usize];
            let mut written = count;
            manager.GetDevices(ids.as_mut_ptr(), &mut written).ok()?;
            let mut out = Vec::new();
            for id in ids.into_iter().take(written as usize) {
                if id.is_null() {
                    continue;
                }
                let mut chars = 0u32;
                let _ = manager.GetDeviceFriendlyName(PCWSTR(id.0), PWSTR::null(), &mut chars);
                if chars > 0 {
                    let mut buffer = vec![0u16; chars as usize];
                    let mut length = chars;
                    if manager
                        .GetDeviceFriendlyName(
                            PCWSTR(id.0),
                            PWSTR(buffer.as_mut_ptr()),
                            &mut length,
                        )
                        .is_ok()
                    {
                        let end = buffer.iter().position(|ch| *ch == 0).unwrap_or(buffer.len());
                        out.push(String::from_utf16_lossy(&buffer[..end]));
                    }
                }
                CoTaskMemFree(Some(id.0 as *const c_void));
            }
            Some(out)
        }
    }

    /// One entry per linked device directory; a missing root yields nothing, which hides the
    /// whole section in the sidebar.
    fn device_places(root: &std::path::Path, connected: Option<&[String]>) -> Vec<NetworkPlace> {
        let Ok(entries) = std::fs::read_dir(root) else {
            return Vec::new();
        };
        let mut out: Vec<NetworkPlace> = entries
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                let path = entry.path().to_string_lossy().into_owned();
                NetworkPlace {
                    id: format!("xd-{}", path.to_lowercase()),
                    name: name.clone(),
                    path,
                    kind: "device".to_string(),
                    comment: None,
                    connected: connected.map(|names| name_matches(&name, names)),
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    }

    pub fn devices() -> Vec<NetworkPlace> {
        let Some(root) = std::env::var_os("USERPROFILE")
            .map(std::path::PathBuf::from)
            .map(|home| home.join("CrossDevice"))
            .filter(|root| root.is_dir())
        else {
            return Vec::new();
        };
        let connected = connected_names();
        device_places(&root, connected.as_deref())
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
            connected: None,
        });
    }

    #[cfg(test)]
    fn unc_probe(remote: &str) -> Vec<String> {
        unc_parts(remote)
    }

    #[cfg(test)]
    #[test]
    fn lists_cross_device_folders_only() {
        let root =
            std::env::temp_dir().join(format!("altfe-crossdevice-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("phone")).unwrap();
        std::fs::create_dir_all(root.join("Camera")).unwrap();
        std::fs::write(root.join("notes.txt"), b"x").unwrap();
        let places = device_places(&root, None);
        let names: Vec<&str> = places.iter().map(|place| place.name.as_str()).collect();
        assert_eq!(names, ["Camera", "phone"]);
        assert_eq!(places[0].kind, "device");
        assert!(places[0].path.ends_with("Camera"));
        assert_eq!(places[0].id, format!("xd-{}", places[0].path.to_lowercase()));
        assert_eq!(places[0].connected, None);
        assert!(device_places(&root.join("missing"), None).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(test)]
    #[test]
    fn marks_devices_missing_from_the_portable_device_list() {
        let root =
            std::env::temp_dir().join(format!("altfe-crossdevice-mark-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Camera")).unwrap();
        std::fs::create_dir_all(root.join("Herb's S23")).unwrap();
        let attached = ["Samsung Herb's S23 (MTP)".to_string()];
        let places = device_places(&root, Some(&attached));
        assert_eq!(places[0].name, "Camera");
        assert_eq!(places[0].connected, Some(false));
        assert_eq!(places[1].connected, Some(true));
        let none = device_places(&root, Some(&[]));
        assert!(none.iter().all(|place| place.connected == Some(false)));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(test)]
    #[test]
    fn matches_device_names_loosely() {
        let attached = vec!["Herb's S23".to_string(), "DSC-RX100".to_string()];
        assert!(name_matches("Herb's S23", &attached));
        assert!(name_matches("herbs s23", &attached));
        assert!(name_matches("Samsung Herb's S23 (MTP)", &attached));
        assert!(!name_matches("rx", &attached));
        assert!(!name_matches("Pixel 9", &attached));
        assert_eq!(normalize_device_name("Herb's S23"), "herbss23");
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
