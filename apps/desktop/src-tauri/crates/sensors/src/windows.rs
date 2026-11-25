use crate::Counts;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Once;
use windows_sys::Win32::Foundation::{CloseHandle, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ, RRF_RT_REG_QWORD,
};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowTextW, GetWindowThreadProcessId,
    SetWindowsHookExW, TranslateMessage, MSG, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYDOWN, WM_LBUTTONDOWN,
    WM_MBUTTONDOWN, WM_MOUSEHWHEEL, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_SYSKEYDOWN,
    WM_XBUTTONDOWN,
};

static KEYS: AtomicU32 = AtomicU32::new(0);
static CLICKS: AtomicU32 = AtomicU32::new(0);
static MOVES: AtomicU32 = AtomicU32::new(0);
static HOOKS: Once = Once::new();

// The hooks only add one to a counter. The key code and pointer position passed in `lparam`
// are never read.
unsafe extern "system" fn on_keyboard(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let message = wparam as u32;
        if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
            KEYS.fetch_add(1, Ordering::Relaxed);
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

unsafe extern "system" fn on_mouse(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        match wparam as u32 {
            WM_MOUSEMOVE => {
                MOVES.fetch_add(1, Ordering::Relaxed);
            }
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN | WM_MOUSEWHEEL
            | WM_MOUSEHWHEEL => {
                CLICKS.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }
    CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam)
}

fn install_hooks() {
    HOOKS.call_once(|| {
        // Low-level hooks are delivered to the thread that installed them, which must pump messages.
        std::thread::spawn(|| unsafe {
            let module = GetModuleHandleW(std::ptr::null());
            SetWindowsHookExW(WH_KEYBOARD_LL, Some(on_keyboard), module, 0);
            SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), module, 0);
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        });
    });
}

#[derive(Clone, Copy)]
struct Snapshot {
    keys: u32,
    clicks: u32,
    moves: u32,
}

fn snapshot() -> Snapshot {
    Snapshot {
        keys: KEYS.load(Ordering::Relaxed),
        clicks: CLICKS.load(Ordering::Relaxed),
        moves: MOVES.load(Ordering::Relaxed),
    }
}

pub struct Inner {
    last: Snapshot,
}

impl Inner {
    pub fn start() -> Self {
        install_hooks();
        Inner { last: snapshot() }
    }

    pub fn take(&mut self) -> Counts {
        let now = snapshot();
        let counts = Counts {
            keys: now.keys.wrapping_sub(self.last.keys),
            clicks: now.clicks.wrapping_sub(self.last.clicks),
            moves: now.moves.wrapping_sub(self.last.moves),
        };
        self.last = now;
        counts
    }
}

pub fn idle_seconds() -> f64 {
    unsafe {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if GetLastInputInfo(&mut info) == 0 {
            return 0.0;
        }
        GetTickCount().wrapping_sub(info.dwTime) as f64 / 1000.0
    }
}

/// The program that owns the foreground window, e.g. "Code" or "Google Chrome".
pub fn front() -> Option<crate::Front> {
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, &mut pid);
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return None;
        }
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut len);
        CloseHandle(process);
        if ok == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buffer[..len as usize]);
        let stem = Path::new(&path).file_stem()?.to_string_lossy().to_string();
        Some(crate::Front { app: friendly(&stem), pid: pid as i32 })
    }
}

/// Title of the foreground window, if it belongs to this process.
pub fn window_title(pid: i32) -> Option<String> {
    unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut owner = 0u32;
        GetWindowThreadProcessId(window, &mut owner);
        if owner as i32 != pid {
            return None;
        }
        let mut buffer = [0u16; 512];
        let len = GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32);
        (len > 0).then(|| String::from_utf16_lossy(&buffer[..len as usize]))
    }
}

pub fn titles_allowed() -> bool {
    true
}

pub fn ask_for_titles() {}

/// Not read on Windows: terminals and editors there put the folder in the window title.
pub fn working_dir(_pid: i32) -> Option<String> {
    None
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Windows notes, per app, when it started and stopped using the microphone. A start with no
/// stop yet means it is in use now.
fn mic_open_under(path: &str) -> bool {
    unsafe {
        let mut key: HKEY = std::ptr::null_mut();
        if RegOpenKeyExW(HKEY_CURRENT_USER, wide(path).as_ptr(), 0, KEY_READ, &mut key) != 0 {
            return false;
        }
        let value = wide("LastUsedTimeStop");
        let mut found = false;
        for index in 0..512u32 {
            let mut name = [0u16; 512];
            let mut len = name.len() as u32;
            let err = RegEnumKeyExW(
                key, index, name.as_mut_ptr(), &mut len, std::ptr::null(), std::ptr::null_mut(),
                std::ptr::null_mut(), std::ptr::null_mut(),
            );
            if err != 0 {
                break;
            }
            let mut stop: u64 = 1;
            let mut size = 8u32;
            let got = RegGetValueW(
                key, name.as_ptr(), value.as_ptr(), RRF_RT_REG_QWORD, std::ptr::null_mut(),
                (&mut stop as *mut u64).cast(), &mut size,
            );
            if got == 0 && stop == 0 {
                found = true;
                break;
            }
        }
        RegCloseKey(key);
        found
    }
}

pub fn mic_in_use() -> bool {
    const STORE: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
    mic_open_under(STORE) || mic_open_under(&format!(r"{STORE}\NonPackaged"))
}

fn friendly(stem: &str) -> String {
    match stem.to_ascii_lowercase().as_str() {
        "chrome" => "Google Chrome".into(),
        "msedge" => "Microsoft Edge".into(),
        "firefox" => "Firefox".into(),
        "brave" => "Brave Browser".into(),
        "code" => "Code".into(),
        "windowsterminal" => "Terminal".into(),
        "explorer" => "File Explorer".into(),
        _ => stem.to_string(),
    }
}

pub fn is_browser(_app: &str) -> bool {
    false
}

/// The front tab's address is not read on Windows; the window title carries the page name.
pub fn browser_url(_app: &str) -> Option<(String, bool)> {
    None
}
