//! Once a second: read the input counters. Every few seconds: note what is in front.
//! Once a minute: write one row.

use crate::store::{MinuteRow, Store};
use crate::{now_minute, Shared};
use sensors::{Counts, Sensors, Tab};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

/// After this long with no input at all, stop writing rows until the person comes back.
const AWAY_SECONDS: f64 = 20.0 * 60.0;
/// The microphone must be on this long before it is taken for a call rather than dictation.
const CALL_AFTER_SECONDS: u32 = 120;

/// What was in front at one moment. The one seen most in a minute stands for that minute.
#[derive(Default, Clone, PartialEq, Eq, Hash)]
struct Context {
    app: String,
    title: Option<String>,
    domain: Option<String>,
    path: Option<String>,
    repo: Option<String>,
}

#[derive(Default)]
struct Minute {
    counts: Counts,
    contexts: HashMap<Context, u32>,
    call_samples: u32,
    paused: bool,
}

/// Project name for a working folder: its repository, else the folder itself. The home folder
/// and the disk root are nobody's project.
fn repo_for(dir: &str) -> Option<String> {
    let home = dirs::home_dir().map(|h| h.to_string_lossy().to_string());
    if dir == "/" || home.as_deref() == Some(dir) {
        return None;
    }
    // Settings folders in the home folder (~/.config, an app's profile) are not projects either,
    // except the worktrees an agent app checks projects out into.
    if let Some(rest) = home.as_deref().and_then(|h| dir.strip_prefix(h)) {
        if rest.starts_with("/.") && !rest.contains("/worktrees/") {
            return None;
        }
    }
    crate::claude::repo_name(dir).or_else(|| {
        std::path::Path::new(dir).file_name().map(|n| n.to_string_lossy().to_string())
    })
}

/// Apps that run a coding agent for you and do not put the project in their window title.
fn is_agent_app(app: &str) -> bool {
    let name = app.to_ascii_lowercase();
    if name == "claude" || name.contains("t3 code") || name.contains("codex") || name.contains("conductor") {
        return true;
    }
    // T3 Code profiles are apps of their own, named after the profile ("B3 Code" for "b3").
    let Some(home) = dirs::home_dir() else { return false };
    std::fs::read_dir(home.join(".t3-profiles"))
        .map(|dirs| {
            dirs.flatten().any(|d| {
                let profile = d.file_name().to_string_lossy().to_ascii_lowercase();
                !profile.ends_with("-backup") && name.replace(' ', "").starts_with(&profile)
            })
        })
        .unwrap_or(false)
}

/// The project an agent was working in during the last few minutes, from its own logs.
fn agent_repo(store: &Store) -> Option<String> {
    // A session started by an app is a better guess than one typed into a terminal.
    ["agent_recent_app", "agent_recent"].iter().find_map(|key| {
        let recent = store.get(key)?;
        let (m, dir) = recent.split_once('|')?;
        (now_minute() - m.parse::<i64>().ok()? <= 5).then(|| repo_for(dir)).flatten()
    })
}

fn look(sensors: &Sensors, store: &Store, with_tab: bool, last: &Option<Context>) -> Option<Context> {
    let front = sensors.front()?;
    let mut ctx = Context { app: front.app.clone(), ..Default::default() };
    if sensors::is_browser(&front.app) {
        // Asking the browser is slow, so reuse the last answer between asks while the app stays.
        let same_app = last.as_ref().filter(|l| l.app == front.app);
        if with_tab || same_app.is_none() {
            match sensors::browser_tab(&front.app) {
                Tab::Private => return Some(ctx),
                Tab::Page(page) => {
                    ctx.domain = Some(page.host);
                    ctx.path = Some(page.path);
                }
                Tab::Unknown => {}
            }
        } else if let Some(l) = same_app {
            ctx.domain = l.domain.clone();
            ctx.path = l.path.clone();
        }
    } else if let Some(dir) = sensors::working_dir(front.pid) {
        ctx.repo = repo_for(&dir);
    }
    if ctx.repo.is_none() && is_agent_app(&front.app) {
        ctx.repo = agent_repo(store);
    }
    ctx.title = sensors::window_title(&front.app, front.pid);
    Some(ctx)
}

fn flush(store: &Store, m: i64, minute: &Minute, idle: f64) {
    let c = minute.counts;
    let blank = MinuteRow {
        m, keys: 0, clicks: 0, moves: 0, app: None, domain: None, paused: false,
        title: None, path: None, repo: None, call: false, dirty: 1,
    };
    if minute.paused {
        // Private time: note that it was paused, and nothing else.
        store.put_minute(&MinuteRow { paused: true, ..blank });
        return;
    }
    let had_input = c.keys > 0 || c.clicks > 0 || c.moves > 0;
    // On a call for most of the minute.
    let call = minute.call_samples >= 6;
    if !had_input && !call && idle > AWAY_SECONDS {
        return;
    }
    let top = minute.contexts.iter().max_by_key(|(_, n)| **n).map(|(ctx, _)| ctx.clone()).unwrap_or_default();
    store.put_minute(&MinuteRow {
        keys: c.keys as i64,
        clicks: c.clicks as i64,
        moves: c.moves as i64,
        app: Some(top.app).filter(|a| !a.is_empty()),
        domain: top.domain,
        title: top.title,
        path: top.path,
        repo: top.repo,
        call,
        ..blank
    });
}

pub fn run(shared: Arc<Shared>) {
    let mut sensors = Sensors::start();
    let mut current = now_minute();
    let mut minute = Minute::default();
    let mut last: Option<Context> = None;
    let mut mic_seconds: u32 = 0;
    let mut tick: u64 = 0;
    loop {
        std::thread::sleep(Duration::from_secs(1));
        tick += 1;
        let connected = shared.store.get("token").is_some();
        let counts = sensors.take();
        let now = now_minute();
        if now != current {
            if connected {
                flush(&shared.store, current, &minute, sensors.idle_seconds());
            }
            current = now;
            minute = Minute::default();
        }
        if !connected {
            continue;
        }
        if shared.paused.load(Ordering::Relaxed) {
            minute.paused = true;
            mic_seconds = 0;
            continue;
        }
        minute.counts.keys = minute.counts.keys.saturating_add(counts.keys);
        minute.counts.clicks = minute.counts.clicks.saturating_add(counts.clicks);
        minute.counts.moves = minute.counts.moves.saturating_add(counts.moves);

        if tick % 5 != 0 {
            continue;
        }
        // A call counts with no typing at all, so it is watched even when the person is idle.
        mic_seconds = if sensors::mic_in_use() { mic_seconds.saturating_add(5) } else { 0 };
        let on_call = mic_seconds >= CALL_AFTER_SECONDS;
        if on_call {
            minute.call_samples += 1;
        }
        // What is in front, every 5 seconds while in use; the browser is asked every 15.
        if sensors.idle_seconds() < 60.0 || on_call {
            if let Some(ctx) = look(&sensors, &shared.store, tick % 15 == 0, &last) {
                *minute.contexts.entry(ctx.clone()).or_default() += 1;
                last = Some(ctx);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::repo_for;

    #[test]
    fn home_and_root_are_not_projects() {
        assert_eq!(repo_for("/"), None);
        if let Some(home) = dirs::home_dir() {
            assert_eq!(repo_for(&home.to_string_lossy()), None);
        }
        if let Some(home) = dirs::home_dir() {
            let home = home.to_string_lossy();
            assert_eq!(repo_for(&format!("{home}/.t3-profiles/slabops")), None);
            assert_eq!(repo_for(&format!("{home}/.t3/worktrees/shop-x1")).as_deref(), Some("shop-x1"));
        }
        assert_eq!(repo_for("/tmp/definitely-not-a-repo-xyz").as_deref(), Some("definitely-not-a-repo-xyz"));
    }
}
