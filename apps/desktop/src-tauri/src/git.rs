//! Finds the person's own commits in the repositories they have used Claude Code in.

use crate::store::{CommitRow, Store};
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

const LOOKBACK_SECS: i64 = 14 * 24 * 3600;

fn git(dir: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn shortstat(text: &str) -> (i64, i64) {
    let mut added = 0;
    let mut removed = 0;
    for part in text.split(',') {
        let n = part.trim().split(' ').next().and_then(|n| n.parse::<i64>().ok()).unwrap_or(0);
        if part.contains("insertion") {
            added = n;
        } else if part.contains("deletion") {
            removed = n;
        }
    }
    (added, removed)
}

pub fn parse_log(out: &str, repo: &str) -> Vec<CommitRow> {
    out.split('\u{1e}')
        .filter_map(|record| {
            let mut lines = record.trim().lines();
            let mut head = lines.next()?.split('\u{1f}');
            let sha = head.next()?.to_string();
            let at: i64 = head.next()?.parse().ok()?;
            let subject: String = head.next().unwrap_or("").chars().take(200).collect();
            if sha.len() < 7 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            let (added, removed) = lines.find(|l| l.contains("changed")).map(shortstat).unwrap_or((0, 0));
            Some(CommitRow { sha, repo: repo.to_string(), m: at.div_euclid(60), added, removed, subject })
        })
        .collect()
}

pub fn scan(store: &Store, now_secs: i64, connected_at: i64) {
    // Nothing from before this computer joined the team.
    let since = connected_at.max(now_secs - LOOKBACK_SECS);
    let mut roots = HashSet::new();
    for dir in store.repos_since(now_secs - LOOKBACK_SECS) {
        if !Path::new(&dir).is_dir() {
            continue;
        }
        if let Some(root) = git(&dir, &["rev-parse", "--show-toplevel"]) {
            roots.insert(root);
        }
    }
    for root in roots {
        let Some(email) = git(&root, &["config", "user.email"]).filter(|e| !e.is_empty()) else { continue };
        let repo = Path::new(&root).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let Some(out) = git(
            &root,
            &[
                "log",
                "--all",
                "--no-merges",
                "-F",
                &format!("--author={email}"),
                &format!("--since={since}"),
                "--pretty=format:%x1e%H%x1f%at%x1f%s",
                "--shortstat",
            ],
        ) else {
            continue;
        };
        for commit in parse_log(&out, &repo) {
            if !store.was_paused(commit.m) {
                store.add_commit(&commit);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_git_log_records() {
        let out = "\u{1e}0123456789abcdef0123456789abcdef01234567\u{1f}1794650400\u{1f}Fix checkout\n\n 3 files changed, 40 insertions(+), 7 deletions(-)\n\u{1e}89abcdef0123456789abcdef0123456789abcdef\u{1f}1794650460\u{1f}Docs only\n\n 1 file changed, 2 insertions(+)";
        let rows = parse_log(out, "storefront");
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].added, rows[0].removed, rows[0].subject.as_str()), (40, 7, "Fix checkout"));
        assert_eq!((rows[1].added, rows[1].removed), (2, 0));
        assert_eq!(rows[1].m, 1794650460 / 60);
        assert!(parse_log("", "x").is_empty());
    }
}
