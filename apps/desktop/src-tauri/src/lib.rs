mod assist;
mod claude;
mod collector;
mod git;
mod store;
mod sync;

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use store::Store;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tauri_plugin_updater::UpdaterExt as _;

/// Where the app reports to unless told otherwise. Set OPENSTAFF_SERVER at build time to change it.
const DEFAULT_SERVER: &str = match option_env!("OPENSTAFF_SERVER") {
    Some(server) => server,
    None => "https://openstaff-app.vercel.app",
};

pub struct Shared {
    pub store: Store,
    /// Private time. Not kept across restarts, so a forgotten pause cannot last for days.
    pub paused: AtomicBool,
    /// Ask the background worker to run now instead of waiting for its next turn.
    pub kick: AtomicBool,
    pub error: Mutex<Option<String>>,
}

struct TrayItems {
    today: MenuItem<Wry>,
    pause: MenuItem<Wry>,
    assist: CheckMenuItem<Wry>,
}

pub fn now_minute() -> i64 {
    chrono::Utc::now().timestamp().div_euclid(60)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Status {
    connected: bool,
    member: Option<String>,
    org: Option<String>,
    today_minutes: i64,
    paused: bool,
    server: String,
    version: &'static str,
    error: Option<String>,
    /// The system lets the app read window titles (macOS asks; Windows always does).
    titles: bool,
    /// Claude Code is installed here, so it can be asked to suggest projects.
    claude_found: bool,
    /// The person turned on daily project suggestions by Claude.
    assist: bool,
    assist_note: Option<String>,
}

fn status(shared: &Shared) -> Status {
    let store = &shared.store;
    Status {
        connected: store.get("token").is_some(),
        member: store.get("member"),
        org: store.get("org"),
        today_minutes: store.get("today_minutes").and_then(|v| v.parse().ok()).unwrap_or(0),
        paused: shared.paused.load(Ordering::Relaxed),
        server: store.get("server").unwrap_or_else(|| DEFAULT_SERVER.to_string()),
        version: env!("CARGO_PKG_VERSION"),
        error: shared.error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        titles: sensors::titles_allowed(),
        claude_found: assist::find_claude().is_some(),
        assist: store.get("assist").as_deref() == Some("on"),
        assist_note: store.get("assist_note"),
    }
}

fn hm(minutes: i64) -> String {
    format!("{}h {:02}m", minutes / 60, minutes % 60)
}

/// Pushes the current state to the tray menu and the window.
fn refresh_ui(app: &AppHandle) {
    let shared = app.state::<Arc<Shared>>();
    let s = status(&shared);
    if let Some(items) = app.try_state::<TrayItems>() {
        let today = if !s.connected {
            "Not connected yet".to_string()
        } else if s.paused {
            format!("Paused · {} counted today", hm(s.today_minutes))
        } else {
            format!("{} counted today", hm(s.today_minutes))
        };
        let _ = items.today.set_text(today);
        let _ = items.pause.set_text(if s.paused { "Resume tracking" } else { "Pause for private time" });
        let _ = items.pause.set_enabled(s.connected);
        let _ = items.assist.set_checked(s.assist);
        let _ = items.assist.set_enabled(s.connected && s.claude_found);
    }
    let _ = app.emit("status", s);
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn set_paused_now(app: &AppHandle, paused: bool) {
    app.state::<Arc<Shared>>().paused.store(paused, Ordering::Relaxed);
    refresh_ui(app);
}

fn open_my_page_now(app: &AppHandle) -> Result<(), String> {
    let shared = app.state::<Arc<Shared>>();
    let (Some(server), Some(token)) = (shared.store.get("server"), shared.store.get("token")) else {
        return Err("Connect this computer first.".into());
    };
    let url = sync::view_link(&server, &token).ok_or("Could not reach the server. Try again in a moment.")?;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_status(shared: State<'_, Arc<Shared>>) -> Status {
    status(&shared)
}

#[tauri::command(async)]
fn connect(app: AppHandle, code: String, server: Option<String>) -> Result<Status, String> {
    connect_now(&app, code, server)
}

fn connect_now(app: &AppHandle, code: String, server: Option<String>) -> Result<Status, String> {
    let shared = app.state::<Arc<Shared>>().inner().clone();
    let server = server
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_SERVER.to_string());
    if !server.starts_with("https://") && !server.starts_with("http://localhost") && !server.starts_with("http://127.0.0.1") {
        return Err("The server address must start with https://".into());
    }
    let code = code.trim().to_uppercase();
    if code.is_empty() {
        return Err("Enter the code from your invite.".into());
    }
    let reply = sync::claim(&server, &code)?;
    let token = reply["token"].as_str().ok_or("The server reply was not understood.")?;
    let store = &shared.store;
    store.clear_queue();
    store.set("server", &server);
    store.set("member", reply["member"].as_str().unwrap_or(""));
    store.set("org", reply["org"].as_str().unwrap_or(""));
    // Only activity from this moment on is recorded, never what happened before joining.
    store.set("connected_at", &chrono::Utc::now().timestamp().to_string());
    store.del("today_minutes");
    store.set("token", token);
    let _ = app.autolaunch().enable();
    if !sensors::titles_allowed() {
        sensors::ask_for_titles();
    }
    shared.kick.store(true, Ordering::Relaxed);
    refresh_ui(app);
    Ok(status(&shared))
}

#[tauri::command]
fn set_paused(app: AppHandle, paused: bool) {
    set_paused_now(&app, paused);
}

#[tauri::command(async)]
fn open_my_page(app: AppHandle) -> Result<(), String> {
    open_my_page_now(&app)
}

/// Shows the system's request to let the app read window titles, and opens the settings page
/// where it is granted.
#[tauri::command]
fn allow_titles(app: AppHandle) {
    sensors::ask_for_titles();
    #[cfg(target_os = "macos")]
    let _ = app.opener().open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", None::<&str>);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

fn set_assist_now(app: &AppHandle, on: bool) {
    let shared = app.state::<Arc<Shared>>();
    shared.store.set("assist", if on { "on" } else { "off" });
    if on {
        // Run soon after being switched on, not at the next daily turn.
        shared.store.del("assist_day");
        shared.kick.store(true, Ordering::Relaxed);
    } else {
        shared.store.del("assist_note");
    }
    refresh_ui(app);
}

#[tauri::command]
fn set_assist(app: AppHandle, on: bool) {
    set_assist_now(&app, on);
}

/// Once a day in the afternoon (or right after being switched on), ask Claude for suggestions.
fn assist_if_due(app: &AppHandle, shared: &Arc<Shared>) {
    use chrono::Timelike;
    if shared.store.get("assist").as_deref() != Some("on") {
        return;
    }
    let now = chrono::Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let switched_on = shared.store.get("assist_day").is_none();
    if shared.store.get("assist_day").as_deref() == Some(today.as_str()) || (!switched_on && now.hour() < 16) {
        return;
    }
    shared.store.set("assist_day", &today);
    let Ok(dir) = app.path().app_data_dir() else { return };
    let note = match assist::run(shared, &dir) {
        Ok(0) => format!("Claude looked on {today}. Nothing new to suggest."),
        Ok(n) => format!("Claude suggested projects for {n} items on {today}. Accept them under My projects."),
        Err(e) => e,
    };
    shared.store.set("assist_note", &note);
}

#[cfg_attr(debug_assertions, allow(dead_code))]
/// Checks for a newer version now and every six hours, installs it and restarts quietly.
fn keep_updated(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Ok(updater) = app.updater() {
                if let Ok(Some(update)) = updater.check().await {
                    if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                        app.restart();
                    }
                }
            }
            tokio_sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

#[cfg_attr(debug_assertions, allow(dead_code))]
async fn tokio_sleep(duration: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration)).await;
}

/// Background worker: read Claude logs, find commits, upload, repeat.
fn worker(app: AppHandle, shared: Arc<Shared>) {
    let mut scanner = claude::Scanner::new();
    let mut round: u64 = 0;
    // Hands-free setup: an installer or IT script can pass the invite code in the environment.
    if shared.store.get("token").is_none() {
        if let Ok(code) = std::env::var("OPENSTAFF_INVITE") {
            let _ = connect_now(&app, code, std::env::var("OPENSTAFF_SERVER_URL").ok());
        }
    }
    loop {
        if shared.store.get("token").is_some() {
            let now = chrono::Utc::now().timestamp();
            let since = shared.store.get("connected_at").and_then(|v| v.parse().ok()).unwrap_or(now);
            scanner.scan(&shared.store, since);
            if round % 10 == 0 {
                git::scan(&shared.store, now, since);
            }
            let mut error = None;
            for _ in 0..20 {
                match sync::upload(&shared) {
                    sync::Outcome::Sent => continue,
                    sync::Outcome::NothingToSend => break,
                    sync::Outcome::Disconnected => {
                        for key in ["token", "member", "org", "today_minutes", "connected_at"] {
                            shared.store.del(key);
                        }
                        shared.store.clear_queue();
                        error = Some("This computer was disconnected by your team. Enter a new invite code to reconnect.".to_string());
                        show_window(&app);
                        break;
                    }
                    sync::Outcome::Failed => {
                        error = Some("Offline. Your time is saved here and will upload when you are back online.".to_string());
                        break;
                    }
                }
            }
            *shared.error.lock().unwrap_or_else(|e| e.into_inner()) = error;
            assist_if_due(&app, &shared);
            if round % 120 == 0 {
                shared.store.prune(now_minute() - 30 * 24 * 60);
            }
            round += 1;
            refresh_ui(&app);
        }
        for _ in 0..30 {
            if shared.kick.swap(false, Ordering::Relaxed) {
                break;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .invoke_handler(tauri::generate_handler![get_status, connect, set_paused, open_my_page, allow_titles, set_assist])
        .on_window_event(|window, event| {
            // Closing the window only hides it. The app keeps running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("openstaff.db"))?;
            let shared = Arc::new(Shared {
                store,
                paused: AtomicBool::new(false),
                kick: AtomicBool::new(false),
                error: Mutex::new(None),
            });
            app.manage(shared.clone());

            let today = MenuItem::with_id(app, "today", "Open Staff", false, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "Pause for private time", true, None::<&str>)?;
            let mine = MenuItem::with_id(app, "mine", "See what is recorded about me", true, None::<&str>)?;
            let assist = CheckMenuItem::with_id(app, "assist", "Suggest projects with Claude each day", true, false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "Open Open Staff", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&today, &PredefinedMenuItem::separator(app)?, &pause, &mine, &assist, &open, &PredefinedMenuItem::separator(app)?, &quit],
            )?;
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("Open Staff")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "pause" => {
                        let paused = app.state::<Arc<Shared>>().paused.load(Ordering::Relaxed);
                        set_paused_now(app, !paused);
                    }
                    "mine" => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            if open_my_page_now(&app).is_err() {
                                show_window(&app);
                            }
                        });
                    }
                    "assist" => {
                        let on = app.state::<Arc<Shared>>().store.get("assist").as_deref() == Some("on");
                        set_assist_now(app, !on);
                    }
                    "open" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            app.manage(TrayItems { today, pause, assist });

            if shared.store.get("token").is_none() {
                show_window(app.handle());
            }
            refresh_ui(app.handle());

            let collector_shared = shared.clone();
            std::thread::spawn(move || collector::run(collector_shared));
            let handle = app.handle().clone();
            std::thread::spawn(move || worker(handle, shared));
            #[cfg(not(debug_assertions))]
            keep_updated(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Open Staff");
}
