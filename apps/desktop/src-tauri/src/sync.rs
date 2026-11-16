//! Uploads the local queue and learns today's counted time from the reply.

use crate::Shared;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

pub enum Outcome {
    Sent,
    NothingToSend,
    /// The server no longer knows this device (removed by the owner).
    Disconnected,
    Failed,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build()
}

pub fn claim(server: &str, code: &str) -> Result<Value, String> {
    let body = json!({
        "code": code,
        "platform": std::env::consts::OS,
        "hostname": gethostname::gethostname().to_string_lossy(),
        "appVersion": env!("CARGO_PKG_VERSION"),
    });
    match agent().post(&format!("{server}/api/devices/claim")).send_json(body) {
        Ok(res) => res.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(_, res)) => Err(res
            .into_json::<Value>()
            .ok()
            .and_then(|v| v["error"].as_str().map(str::to_string))
            .unwrap_or_else(|| "The server did not accept that code.".into())),
        Err(_) => Err("Could not reach the server. Check your internet connection.".into()),
    }
}

pub fn view_link(server: &str, token: &str) -> Option<String> {
    let res = agent()
        .post(&format!("{server}/api/me/link"))
        .set("authorization", &format!("Bearer {token}"))
        .call()
        .ok()?;
    res.into_json::<Value>().ok()?["url"].as_str().map(str::to_string)
}

fn remember_today(shared: &Shared, reply: &Value) {
    if let Some(minutes) = reply["verifiedMinutes"].as_i64() {
        shared.store.set("today_minutes", &minutes.to_string());
        shared.store.set("today_day", reply["day"].as_str().unwrap_or(""));
    }
}

pub fn upload(shared: &Arc<Shared>) -> Outcome {
    let (Some(server), Some(token)) = (shared.store.get("server"), shared.store.get("token")) else {
        return Outcome::NothingToSend;
    };
    let auth = format!("Bearer {token}");
    let batch = shared.store.pending();
    if batch.is_empty() {
        // Still check in, so the dashboard shows the tracker as alive and the tray stays current.
        return match agent().get(&format!("{server}/api/me/today")).set("authorization", &auth).call() {
            Ok(res) => {
                if let Ok(v) = res.into_json::<Value>() {
                    remember_today(shared, &v);
                }
                Outcome::NothingToSend
            }
            Err(ureq::Error::Status(401, _)) => Outcome::Disconnected,
            Err(_) => Outcome::Failed,
        };
    }
    let body = json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "minutes": batch.minutes,
        "claude": batch.claude,
        "commits": batch.commits,
    });
    match agent().post(&format!("{server}/api/ingest")).set("authorization", &auth).send_json(body) {
        Ok(res) => {
            shared.store.mark_sent(&batch);
            if let Ok(v) = res.into_json::<Value>() {
                remember_today(shared, &v["today"]);
            }
            Outcome::Sent
        }
        Err(ureq::Error::Status(401, _)) => Outcome::Disconnected,
        Err(_) => Outcome::Failed,
    }
}
