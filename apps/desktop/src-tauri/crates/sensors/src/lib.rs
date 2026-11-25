//! Activity sensors.
//!
//! What this crate reads: how many key presses, clicks and mouse moves happened, how long the
//! machine has been idle, which app and window is in front (name and title), the address of the
//! front browser tab without its query string, the folder the front terminal is working in, and
//! whether the microphone is in use.
//!
//! What it never reads: which keys were pressed, anything drawn on the screen, page contents,
//! sound, or anything at all from a private browser window.

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

    /// The app in front, e.g. "Code" or "Google Chrome", and its process id.
    pub fn front(&self) -> Option<Front> {
        os::front()
    }
}

pub struct Front {
    pub app: String,
    pub pid: i32,
}

/// A web page: where it is, never what is on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page {
    /// e.g. "github.com"
    pub host: String,
    /// e.g. "/acme/api/pulls". The query string and fragment are dropped.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tab {
    Page(Page),
    /// A private or incognito window. Nothing about it is recorded.
    Private,
    /// Not a browser we can ask, or it did not answer.
    Unknown,
}

/// True if `app` is a browser this crate knows how to ask for its front tab.
pub fn is_browser(app: &str) -> bool {
    os::is_browser(app)
}

/// The front tab of `app` if it is a supported browser.
pub fn browser_tab(app: &str) -> Tab {
    match os::browser_url(app) {
        Some((_, true)) => Tab::Private,
        Some((url, false)) => page_of(&url).map(Tab::Page).unwrap_or(Tab::Unknown),
        None => Tab::Unknown,
    }
}

/// Title of the front window of the process, with private windows and sensitive apps left out.
pub fn window_title(app: &str, pid: i32) -> Option<String> {
    if is_sensitive_app(app) {
        return None;
    }
    let title = os::window_title(pid)?;
    let title = title.trim();
    if title.is_empty() || is_private_title(title) {
        return None;
    }
    Some(title.chars().take(200).collect())
}

/// Whether the system lets this app read window titles (macOS asks the person once).
pub fn titles_allowed() -> bool {
    os::titles_allowed()
}

/// Shows the system's own request to allow reading window titles, if not allowed yet.
pub fn ask_for_titles() {
    os::ask_for_titles()
}

/// Folder the front terminal (or an editor's terminal) is working in, if `pid` has one.
pub fn working_dir(pid: i32) -> Option<String> {
    os::working_dir(pid)
}

/// True while any app is using the microphone. Says nothing about the sound itself.
pub fn mic_in_use() -> bool {
    os::mic_in_use()
}

/// Apps whose window titles are personal by nature and are never read.
pub fn is_sensitive_app(app: &str) -> bool {
    const APPS: [&str; 16] = [
        "1password", "bitwarden", "lastpass", "dashlane", "keepassxc", "keeper", "enpass", "passwords",
        "keychain access", "messages", "facetime", "photos", "whatsapp", "signal", "telegram", "health",
    ];
    let name = app.to_ascii_lowercase();
    APPS.iter().any(|a| name == *a || name.starts_with(&format!("{a} ")))
}

/// Browsers put these words in the title of a private window.
pub fn is_private_title(title: &str) -> bool {
    let t = title.to_ascii_lowercase();
    ["inprivate", "incognito", "private browsing", "private window"].iter().any(|w| t.contains(w))
}

fn page_of(url: &str) -> Option<Page> {
    let host = host_of(url)?;
    let rest = url.trim().split_once("://")?.1;
    let path = match rest.find('/') {
        Some(i) => rest[i..].split(['?', '#']).next().unwrap_or("/"),
        None => "/",
    };
    Some(Page { host, path: path.chars().take(200).collect() })
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
    use super::{host_of, is_private_title, is_sensitive_app, page_of};

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

    #[test]
    fn keeps_the_path_but_never_the_query() {
        let p = page_of("https://www.github.com/org/repo/pulls?q=secret#frag").unwrap();
        assert_eq!((p.host.as_str(), p.path.as_str()), ("github.com", "/org/repo/pulls"));
        assert_eq!(page_of("https://claude.ai").unwrap().path, "/");
        assert_eq!(page_of("https://x.com?token=abc").unwrap().path, "/");
        assert!(page_of("chrome://settings").is_none());
    }

    #[test]
    fn knows_what_not_to_read() {
        assert!(is_private_title("New Tab - Google Chrome (Incognito)"));
        assert!(is_private_title("Bank - [InPrivate] - Microsoft Edge"));
        assert!(!is_private_title("Pull requests - GitHub"));
        assert!(is_sensitive_app("1Password"));
        assert!(is_sensitive_app("1Password 7"));
        assert!(is_sensitive_app("Messages"));
        assert!(!is_sensitive_app("Slack"));
    }
}
