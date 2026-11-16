//! Prints what the sensors see once a second. Run: cargo run -p sensors --example watch
use sensors::Sensors;
use std::{thread, time::Duration};

fn main() {
    let mut s = Sensors::start();
    let seconds: u32 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(5);
    for _ in 0..seconds {
        thread::sleep(Duration::from_secs(1));
        let c = s.take();
        let app = s.front_app();
        println!(
            "keys={} clicks={} moves={} idle={:.1}s app={:?} browser={}",
            c.keys,
            c.clicks,
            c.moves,
            s.idle_seconds(),
            app,
            app.as_deref().map(sensors::is_browser).unwrap_or(false)
        );
    }
}
