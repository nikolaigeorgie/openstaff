//! Prints what the sensors see once a second. Run: cargo run -p sensors --example watch
use sensors::Sensors;
use std::{thread, time::Duration};

fn main() {
    let mut s = Sensors::start();
    let seconds: u32 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(5);
    println!("titles allowed: {}", sensors::titles_allowed());
    // Probe one app by process id: cargo run -p sensors --example watch 0 <pid> <app name>
    if let Some(pid) = std::env::args().nth(2).and_then(|a| a.parse::<i32>().ok()) {
        let app = std::env::args().nth(3).unwrap_or_default();
        println!("pid {pid}: title={:?} dir={:?}", sensors::window_title(&app, pid), sensors::working_dir(pid));
        if sensors::is_browser(&app) {
            println!("tab={:?}", sensors::browser_tab(&app));
        }
    }
    for _ in 0..seconds {
        thread::sleep(Duration::from_secs(1));
        let c = s.take();
        let front = s.front();
        let (app, pid) = front.map(|f| (f.app, f.pid)).unwrap_or_default();
        println!(
            "keys={} clicks={} moves={} idle={:.1}s app={:?} title={:?} dir={:?} tab={:?} mic={}",
            c.keys,
            c.clicks,
            c.moves,
            s.idle_seconds(),
            app,
            sensors::window_title(&app, pid),
            sensors::working_dir(pid),
            if sensors::is_browser(&app) { Some(sensors::browser_tab(&app)) } else { None },
            sensors::mic_in_use(),
        );
    }
}
