use crate::Counts;
use objc2_app_kit::NSWorkspace;
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

pub fn front_app() -> Option<String> {
    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let name = app.localizedName()?;
    Some(name.to_string())
}

/// Browsers that can report their front tab, and the AppleScript to ask each one.
fn script_for(app: &str) -> Option<String> {
    match app {
        "Safari" | "Safari Technology Preview" => {
            Some(format!("tell application \"{app}\" to get URL of front document"))
        }
        "Google Chrome" | "Google Chrome Canary" | "Brave Browser" | "Microsoft Edge" | "Arc" | "Vivaldi"
        | "Chromium" | "Opera" => Some(format!(
            "tell application \"{app}\" to get URL of active tab of front window"
        )),
        _ => None,
    }
}

pub fn is_browser(app: &str) -> bool {
    script_for(app).is_some()
}

/// Asks the browser for the address of its front tab. macOS shows a one-time permission prompt
/// per browser the first time. The caller keeps only the host.
pub fn browser_url(app: &str) -> Option<String> {
    let script = script_for(app)?;
    let out = Command::new("/usr/bin/osascript").arg("-e").arg(script).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
