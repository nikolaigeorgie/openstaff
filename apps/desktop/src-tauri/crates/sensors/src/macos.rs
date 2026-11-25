use crate::Counts;
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::{CFString, CFStringRef};
use objc2_app_kit::NSWorkspace;
use std::collections::HashMap;
use std::ffi::{c_void, CStr};
use std::process::Command;

// Hardware-level event state, so events synthesised inside the login session are left out.
const HID_SYSTEM_STATE: i32 = 1;
const ANY_INPUT: u32 = u32::MAX;

const LEFT_DOWN: u32 = 1;
const RIGHT_DOWN: u32 = 3;
const MOUSE_MOVED: u32 = 5;
const LEFT_DRAGGED: u32 = 6;
const KEY_DOWN: u32 = 10;
const SCROLL: u32 = 22;
const OTHER_DOWN: u32 = 25;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    // Running totals kept by the system. They say how many events happened, not which.
    // Reading them needs no Accessibility or Input Monitoring permission.
    fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}

fn counter(event_type: u32) -> u32 {
    unsafe { CGEventSourceCounterForEventType(HID_SYSTEM_STATE, event_type) }
}

#[derive(Clone, Copy)]
struct Snapshot {
    keys: u32,
    clicks: u32,
    moves: u32,
}

fn snapshot() -> Snapshot {
    Snapshot {
        keys: counter(KEY_DOWN),
        clicks: counter(LEFT_DOWN)
            .wrapping_add(counter(RIGHT_DOWN))
            .wrapping_add(counter(OTHER_DOWN))
            .wrapping_add(counter(SCROLL)),
        moves: counter(MOUSE_MOVED).wrapping_add(counter(LEFT_DRAGGED)),
    }
}

pub struct Inner {
    last: Snapshot,
}

impl Inner {
    pub fn start() -> Self {
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
    unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT) }
}

pub fn front() -> Option<crate::Front> {
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let name = app.localizedName()?;
    Some(crate::Front { app: name.to_string(), pid: app.processIdentifier() })
}

// ---------------------------------------------------------------------------------------------
// Browser tab

/// Browsers that can report their front tab, and the AppleScript to ask each one. Chromium
/// browsers also say whether the window is incognito.
fn script_for(app: &str) -> Option<String> {
    match app {
        "Safari" | "Safari Technology Preview" | "Arc" => {
            let what = if app == "Arc" { "URL of active tab of front window" } else { "URL of front document" };
            Some(format!("tell application \"{app}\" to get {what}"))
        }
        "Google Chrome" | "Google Chrome Canary" | "Brave Browser" | "Microsoft Edge" | "Vivaldi" | "Chromium"
        | "Opera" => Some(format!(
            "tell application \"{app}\" to get (mode of front window) & \"|\" & (URL of active tab of front window)"
        )),
        _ => None,
    }
}

pub fn is_browser(app: &str) -> bool {
    script_for(app).is_some()
}

/// Asks the browser for the address of its front tab, and whether the window is private.
/// macOS shows a one-time permission prompt per browser the first time.
pub fn browser_url(app: &str) -> Option<(String, bool)> {
    let script = script_for(app)?;
    let out = Command::new("/usr/bin/osascript").arg("-e").arg(script).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match text.split_once('|') {
        Some((mode, url)) if mode == "incognito" || mode == "normal" => Some((url.to_string(), mode == "incognito")),
        _ => Some((text, false)),
    }
}

// ---------------------------------------------------------------------------------------------
// Window title, through the Accessibility API. Needs the person's permission, asked once.

type AXUIElementRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(element: AXUIElementRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> i32;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

pub fn titles_allowed() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

pub fn ask_for_titles() {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), CFBoolean::true_value().as_CFType())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
    }
}

/// Copies one attribute of an accessibility element. The caller owns the result.
unsafe fn ax_copy(element: AXUIElementRef, name: &str) -> Option<CFType> {
    let attribute = CFString::new(name);
    let mut value: CFTypeRef = std::ptr::null();
    let err = AXUIElementCopyAttributeValue(element, attribute.as_concrete_TypeRef(), &mut value);
    if err != 0 || value.is_null() {
        return None;
    }
    Some(CFType::wrap_under_create_rule(value))
}

pub fn window_title(pid: i32) -> Option<String> {
    if !titles_allowed() {
        return None;
    }
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }
        let app = CFType::wrap_under_create_rule(app);
        // An app that is busy must not hold up the once-a-second loop.
        AXUIElementSetMessagingTimeout(app.as_CFTypeRef(), 0.25);
        let window = ax_copy(app.as_CFTypeRef(), "AXFocusedWindow")?;
        let title = ax_copy(window.as_CFTypeRef(), "AXTitle")?;
        title.downcast::<CFString>().map(|s| s.to_string())
    }
}

// ---------------------------------------------------------------------------------------------
// Working folder of the front terminal: the folder of whatever is running in the tab that was
// used most recently, among the processes started from the app in front.

struct Proc {
    pid: i32,
    ppid: i32,
    pgid: u32,
    tty: u32,
    tty_pgid: u32,
    started: u64,
}

fn processes() -> Vec<Proc> {
    unsafe {
        let count = libc::proc_listallpids(std::ptr::null_mut(), 0);
        if count <= 0 {
            return vec![];
        }
        let mut pids = vec![0i32; count as usize + 64];
        let count = libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * 4) as i32);
        if count <= 0 {
            return vec![];
        }
        pids.truncate(count as usize);
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        pids.into_iter()
            .filter_map(|pid| {
                let mut info: libc::proc_bsdinfo = std::mem::zeroed();
                let got = libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size);
                if got != size {
                    // Another user's process (`login` runs as root): only its parent can be read,
                    // which is all that is needed to follow the chain from a shell up to the app.
                    let mut short: libc::proc_bsdshortinfo = std::mem::zeroed();
                    let short_size = std::mem::size_of::<libc::proc_bsdshortinfo>() as i32;
                    let got = libc::proc_pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, 0, (&mut short as *mut libc::proc_bsdshortinfo).cast(), short_size);
                    return (got == short_size).then(|| Proc { pid, ppid: short.pbsi_ppid as i32, pgid: 0, tty: 0, tty_pgid: 0, started: 0 });
                }
                Some(Proc {
                    pid,
                    ppid: info.pbi_ppid as i32,
                    pgid: info.pbi_pgid,
                    tty: info.e_tdev,
                    tty_pgid: info.e_tpgid,
                    started: info.pbi_start_tvsec,
                })
            })
            .collect()
    }
}

fn cwd_of(pid: i32) -> Option<String> {
    unsafe {
        let mut info: libc::proc_vnodepathinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as i32;
        let got = libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size);
        if got != size {
            return None;
        }
        let path = CStr::from_ptr(info.pvi_cdir.vip_path.as_ptr().cast()).to_string_lossy().to_string();
        (!path.is_empty()).then_some(path)
    }
}

/// When the terminal device was last read from or written to, in seconds.
fn tty_activity(dev: u32) -> i64 {
    unsafe {
        let name = libc::devname(dev as libc::dev_t, libc::S_IFCHR);
        if name.is_null() {
            return 0;
        }
        let path = format!("/dev/{}\0", CStr::from_ptr(name).to_string_lossy());
        let mut st: libc::stat = std::mem::zeroed();
        if libc::stat(path.as_ptr().cast(), &mut st) != 0 {
            return 0;
        }
        st.st_mtime.max(st.st_atime)
    }
}

pub fn working_dir(app_pid: i32) -> Option<String> {
    let all = processes();
    let parent: HashMap<i32, i32> = all.iter().map(|p| (p.pid, p.ppid)).collect();
    let under_app = |mut pid: i32| {
        for _ in 0..16 {
            if pid == app_pid {
                return true;
            }
            match parent.get(&pid) {
                Some(&next) if next > 1 => pid = next,
                _ => return false,
            }
        }
        false
    };
    // Processes in the foreground of a terminal tab that belongs to this app.
    let in_tabs: Vec<&Proc> = all
        .iter()
        .filter(|p| p.pid != app_pid && p.tty != 0 && p.tty != u32::MAX && p.pgid == p.tty_pgid && under_app(p.pid))
        .collect();
    if let Some(tab) = in_tabs.iter().map(|p| p.tty).max_by_key(|&tty| tty_activity(tty)) {
        let front = in_tabs.iter().filter(|p| p.tty == tab).max_by_key(|p| p.started)?;
        return cwd_of(front.pid);
    }
    // No terminal tabs (an editor or agent app that runs tools itself): go by the newest thing
    // it started in a real folder.
    let mut started: Vec<&Proc> = all.iter().filter(|p| p.pid != app_pid && p.started > 0 && under_app(p.pid)).collect();
    started.sort_by_key(|p| std::cmp::Reverse(p.started));
    started
        .iter()
        .take(40)
        .filter_map(|p| cwd_of(p.pid))
        .find(|dir| dir != "/" && !dir.contains(".app/") && !dir.starts_with("/private/var") && !dir.starts_with("/System"))
}

// ---------------------------------------------------------------------------------------------
// Microphone in use, as CoreAudio reports for the default input device. Only "is it running".

#[repr(C)]
struct AudioObjectPropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyData(
        object: u32,
        address: *const AudioObjectPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> i32;
}

const fn four(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

fn audio_u32(object: u32, selector: u32) -> Option<u32> {
    let address = AudioObjectPropertyAddress { selector, scope: four(b"glob"), element: 0 };
    let mut value: u32 = 0;
    let mut size = 4u32;
    let err = unsafe {
        AudioObjectGetPropertyData(object, &address, 0, std::ptr::null(), &mut size, (&mut value as *mut u32).cast())
    };
    (err == 0).then_some(value)
}

pub fn mic_in_use() -> bool {
    const SYSTEM_OBJECT: u32 = 1;
    let Some(device) = audio_u32(SYSTEM_OBJECT, four(b"dIn ")) else { return false };
    device != 0 && audio_u32(device, four(b"gone")).unwrap_or(0) != 0
}
