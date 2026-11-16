//! Activity sensors.
//!
//! What this crate reads: how many key presses, clicks and mouse moves happened, how long the
//! machine has been idle, the name of the app in front, and (macOS) the site domain of the
//! front browser tab. It never reads which keys were pressed, window contents or page titles.

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as os;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as os;

#[cfg(not(any(target_os = "macos", windows)))]
mod other;
#[cfg(not(any(target_os = "macos", windows)))]
use other as os;

/// Input events since the previous call to [`Sensors::take`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Counts {
    pub keys: u32,
    /// Mouse button presses and scroll events.
    pub clicks: u32,
    pub moves: u32,
}

pub struct Sensors {
    inner: os::Inner,
}

impl Sensors {
    pub fn start() -> Self {
        Sensors { inner: os::Inner::start() }
    }

    /// Events since the last call. The first call returns zeros.
    pub fn take(&mut self) -> Counts {
        self.inner.take()
    }

    /// Seconds since the last keyboard or mouse input of any kind.
    pub fn idle_seconds(&self) -> f64 {
        os::idle_seconds()
    }

    /// Name of the app in front, e.g. "Code" or "Google Chrome".
    pub fn front_app(&self) -> Option<String> {
        os::front_app()
    }
}

/// Site domain of the front tab if `app` is a supported browser, e.g. "github.com".
/// Only the host is kept; the rest of the address is dropped here and never leaves this function.
pub fn browser_domain(app: &str) -> Option<String> {
    let url = os::browser_url(app)?;
    host_of(&url)
}

/// True if `app` is a browser this crate knows how to ask for its front tab.
pub fn is_browser(app: &str) -> bool {
    os::is_browser(app)
}

fn host_of(url: &str) -> Option<String> {
    let rest = url.trim().split_once("://").map(|(scheme, rest)| (scheme.to_ascii_lowercase(), rest))?;
    if rest.0 != "http" && rest.0 != "https" {
        return None;
    }
    let authority = rest.1.split(['/', '?', '#']).next()?;
    let host = authority.rsplit('@').next()?.split(':').next()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return None;
    }
    Some(host)
}

#[cfg(test)]
mod tests {
    use super::host_of;

    #[test]
    fn keeps_only_the_host() {
        assert_eq!(host_of("https://www.github.com/org/repo?tab=1#x").as_deref(), Some("github.com"));
        assert_eq!(host_of("https://user:pw@claude.ai:443/chat/abc").as_deref(), Some("claude.ai"));
        assert_eq!(host_of("http://localhost:3000/").as_deref(), Some("localhost"));
    }

    #[test]
    fn ignores_non_web_addresses() {
        assert_eq!(host_of("chrome://settings"), None);
        assert_eq!(host_of("file:///Users/me/secret.html"), None);
        assert_eq!(host_of("about:blank"), None);
        assert_eq!(host_of(""), None);
    }
}
