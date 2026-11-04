use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellMenuItem {
    pub id: u32,
    pub label: String,
    pub disabled: bool,
    pub checked: bool,
    pub separator: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<ShellMenuItem>>,
}

#[cfg(windows)]
mod win {
    use super::ShellMenuItem;
    use windows::core::{HSTRING, PCSTR, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        IContextMenu, IShellItem, SHCreateItemFromParsingName, BHID_SFUIObject,
        CMINVOKECOMMANDINFO, CMINVOKECOMMANDINFOEX, CMF_NORMAL,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreatePopupMenu, DestroyMenu, GetMenuItemCount, GetMenuItemInfoW, HMENU, MENUITEMINFOW,
        MFS_CHECKED, MFS_DISABLED, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING,
        MIIM_SUBMENU, SW_SHOWNORMAL,
    };

    const CMD_FIRST: u32 = 1;
    const CMD_LAST: u32 = 0x7fff;
    const MAX_DEPTH: u32 = 4;
    const CMIC_MASK_UNICODE: u32 = 0x0000_4000;

    struct ComGuard(bool);

    impl ComGuard {
        fn init() -> Self {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            ComGuard(hr.is_ok())
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    struct MenuGuard(HMENU);

    impl Drop for MenuGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = DestroyMenu(self.0);
            }
        }
    }

    fn context_menu(path: &str) -> Result<IContextMenu, String> {
        let native = path.replace('/', "\\");
        let item: IShellItem = unsafe {
            SHCreateItemFromParsingName(&HSTRING::from(&native), None::<&IBindCtx>)
        }
        .map_err(|e| format!("Cannot open {path}: {e}"))?;
        unsafe { item.BindToHandler(None::<&IBindCtx>, &BHID_SFUIObject) }
            .map_err(|e| format!("No system menu for {path}: {e}"))
    }

    fn shared_menu(path: &str) -> Result<(IContextMenu, MenuGuard), String> {
        let ctx = context_menu(path)?;
        let handle = unsafe { CreatePopupMenu() }.map_err(|e| format!("Cannot create menu: {e}"))?;
        let guard = MenuGuard(handle);
        unsafe {
            ctx.QueryContextMenu(handle, 0, CMD_FIRST, CMD_LAST, CMF_NORMAL)
                .ok()
                .map_err(|e| format!("Cannot read system menu: {e}"))?;
        }
        Ok((ctx, guard))
    }

    fn clean_label(raw: &str) -> String {
        raw.split('\t')
            .next()
            .unwrap_or("")
            .replace('&', "")
            .trim()
            .to_string()
    }

    fn read_menu(menu: HMENU, depth: u32) -> Vec<ShellMenuItem> {
        let count = unsafe { GetMenuItemCount(Some(menu)) };
        let mut out: Vec<ShellMenuItem> = Vec::new();
        for index in 0..count {
            let mut buffer = [0u16; 512];
            let mut info = MENUITEMINFOW {
                cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
                fMask: MIIM_FTYPE | MIIM_ID | MIIM_STATE | MIIM_STRING | MIIM_SUBMENU,
                dwTypeData: PWSTR(buffer.as_mut_ptr()),
                cch: buffer.len() as u32,
                ..Default::default()
            };
            if unsafe { GetMenuItemInfoW(menu, index as u32, true, &mut info) }.is_err() {
                continue;
            }
            if info.fType.contains(MFT_SEPARATOR) {
                if out.last().is_some_and(|item| !item.separator) {
                    out.push(ShellMenuItem {
                        id: 0,
                        label: String::new(),
                        disabled: false,
                        checked: false,
                        separator: true,
                        children: None,
                    });
                }
                continue;
            }
            let len = (info.cch as usize).min(buffer.len());
            let label = clean_label(&String::from_utf16_lossy(&buffer[..len]));
            if label.is_empty() {
                continue;
            }
            let disabled = info.fState.0 & MFS_DISABLED.0 != 0;
            let checked = info.fState.contains(MFS_CHECKED);
            let has_children = !info.hSubMenu.is_invalid();
            if has_children && depth < MAX_DEPTH {
                let children = read_menu(info.hSubMenu, depth + 1);
                if children.is_empty() {
                    continue;
                }
                out.push(ShellMenuItem {
                    id: 0,
                    label,
                    disabled,
                    checked: false,
                    separator: false,
                    children: Some(children),
                });
            } else if !has_children && info.wID != 0 {
                out.push(ShellMenuItem {
                    id: info.wID,
                    label,
                    disabled,
                    checked,
                    separator: false,
                    children: None,
                });
            }
        }
        while out.last().is_some_and(|item| item.separator) {
            out.pop();
        }
        out
    }

    pub fn items(path: &str) -> Result<Vec<ShellMenuItem>, String> {
        let _com = ComGuard::init();
        let (_ctx, menu) = shared_menu(path)?;
        Ok(read_menu(menu.0, 0))
    }

    pub fn invoke(path: &str, id: u32, hwnd: HWND) -> Result<(), String> {
        let offset = id
            .checked_sub(CMD_FIRST)
            .ok_or_else(|| "Invalid system menu command".to_string())?;
        let _com = ComGuard::init();
        let (ctx, _menu) = shared_menu(path)?;
        let info = CMINVOKECOMMANDINFOEX {
            cbSize: std::mem::size_of::<CMINVOKECOMMANDINFOEX>() as u32,
            fMask: CMIC_MASK_UNICODE,
            hwnd,
            lpVerb: PCSTR(offset as usize as *const u8),
            lpVerbW: PCWSTR(offset as usize as *const u16),
            nShow: SW_SHOWNORMAL.0,
            ptInvoke: POINT::default(),
            ..Default::default()
        };
        unsafe {
            ctx.InvokeCommand(&info as *const CMINVOKECOMMANDINFOEX as *const CMINVOKECOMMANDINFO)
        }
        .map_err(|e| format!("System menu command failed: {e}"))
    }
}

#[tauri::command]
pub fn shell_menu_items(path: String) -> Result<Vec<ShellMenuItem>, String> {
    #[cfg(windows)]
    {
        win::items(&path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("The system menu is only available on Windows".into())
    }
}

#[tauri::command]
pub fn shell_menu_invoke(
    window: tauri::WebviewWindow,
    path: String,
    id: u32,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().unwrap_or_default();
        win::invoke(&path, id, hwnd)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, path, id);
        Err("The system menu is only available on Windows".into())
    }
}
