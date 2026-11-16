//! Once a second: read the input counters. Once a minute: write one row.

use crate::store::{MinuteRow, Store};
use crate::{now_minute, Shared};
use sensors::{Counts, Sensors};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

/// After this long with no input at all, stop writing rows until the person comes back.
const AWAY_SECONDS: f64 = 20.0 * 60.0;

#[derive(Default)]
struct Minute {
    counts: Counts,
    apps: HashMap<String, u32>,
    domains: HashMap<String, u32>,
    paused: bool,
}

fn top(votes: &HashMap<String, u32>) -> Option<String> {
    votes.iter().max_by_key(|(_, n)| **n).map(|(name, _)| name.clone())
}

fn flush(store: &Store, m: i64, minute: &Minute, idle: f64) {
    let c = minute.counts;
    if minute.paused {
        // Private time: note that it was paused, and nothing else.
        store.put_minute(&MinuteRow { m, keys: 0, clicks: 0, moves: 0, app: None, domain: None, paused: true, dirty: 1 });
        return;
    }
    let had_input = c.keys > 0 || c.clicks > 0 || c.moves > 0;
    if !had_input && idle > AWAY_SECONDS {
        return;
    }
    store.put_minute(&MinuteRow {
        m,
        keys: c.keys as i64,
        clicks: c.clicks as i64,
        moves: c.moves as i64,
        app: top(&minute.apps),
        domain: top(&minute.domains),
        paused: false,
        dirty: 1,
    });
}

pub fn run(shared: Arc<Shared>) {
    let mut sensors = Sensors::start();
    let mut current = now_minute();
    let mut minute = Minute::default();
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
            continue;
        }
        minute.counts.keys = minute.counts.keys.saturating_add(counts.keys);
        minute.counts.clicks = minute.counts.clicks.saturating_add(counts.clicks);
        minute.counts.moves = minute.counts.moves.saturating_add(counts.moves);

        // Sample the front app every 5 seconds, and the browser's site every 15, only while in use.
        if tick % 5 == 0 && sensors.idle_seconds() < 60.0 {
            if let Some(app) = sensors.front_app() {
                if tick % 15 == 0 && sensors::is_browser(&app) {
                    if let Some(domain) = sensors::browser_domain(&app) {
                        *minute.domains.entry(domain).or_default() += 1;
                    }
                }
                *minute.apps.entry(app).or_default() += 1;
            }
        }
    }
}
