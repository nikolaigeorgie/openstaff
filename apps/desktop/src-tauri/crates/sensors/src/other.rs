use crate::Counts;

pub struct Inner;

impl Inner {
    pub fn start() -> Self {
        Inner
    }
    pub fn take(&mut self) -> Counts {
        Counts::default()
    }
}

pub fn idle_seconds() -> f64 {
    0.0
}
pub fn front_app() -> Option<String> {
    None
}
pub fn is_browser(_app: &str) -> bool {
    false
}
pub fn browser_url(_app: &str) -> Option<String> {
    None
}
