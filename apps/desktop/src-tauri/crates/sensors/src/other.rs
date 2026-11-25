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
pub fn front() -> Option<crate::Front> {
    None
}
pub fn is_browser(_app: &str) -> bool {
    false
}
pub fn browser_url(_app: &str) -> Option<(String, bool)> {
    None
}
pub fn window_title(_pid: i32) -> Option<String> {
    None
}
pub fn titles_allowed() -> bool {
    false
}
pub fn ask_for_titles() {}
pub fn working_dir(_pid: i32) -> Option<String> {
    None
}
pub fn mic_in_use() -> bool {
    false
}
