//! Reads Claude Code's local session logs for usage numbers.
//!
//! Kept from each line: when it happened, which session and project folder, the model, and token
//! counts. The text of prompts and replies is never stored or uploaded. The message content is only
//! looked at to tell a typed prompt apart from a tool result.

use crate::store::Store;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const BACKFILL: Duration = Duration::from_secs(14 * 24 * 3600);
const MAX_READ: u64 = 64 * 1024 * 1024;

pub struct Scanner {
    /// Assistant message ids already counted. One reply can span several log lines.
    seen: HashSet<String>,
    /// Working folder -> project name, so the disk is only checked once per folder.
    projects: HashMap<String, String>,
}

pub struct Line {
    pub m: i64,
    pub session: String,
    pub cwd: String,
    pub project: String,
    pub model: Option<String>,
    pub prompts: i64,
    pub tokens: i64,
    pub message_id: Option<String>,
}

fn project_name(cwd: &str) -> String {
    cwd.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

/// The repository a working folder belongs to (the nearest parent holding `.git`), so work in
/// `shop/apps/web` and `shop/apps/api` is reported as one project, "shop".
pub fn repo_name(cwd: &str) -> Option<String> {
    let mut dir = Path::new(cwd);
    loop {
        if dir.join(".git").exists() {
            return dir.file_name().map(|n| n.to_string_lossy().to_string());
        }
        dir = dir.parent()?;
    }
}

/// A prompt the person typed, as opposed to a tool result or an injected note.
fn is_typed_prompt(v: &Value) -> bool {
    if v["isSidechain"].as_bool().unwrap_or(false) || v["isMeta"].as_bool().unwrap_or(false) {
        return false;
    }
    match &v["message"]["content"] {
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(blocks) => {
            let has_text = blocks.iter().any(|b| b["type"] == "text");
            let has_tool_result = blocks.iter().any(|b| b["type"] == "tool_result");
            has_text && !has_tool_result
        }
        _ => false,
    }
}

pub fn parse_line(line: &str) -> Option<Line> {
    if !line.contains("\"timestamp\"") {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let kind = v["type"].as_str()?;
    if kind != "user" && kind != "assistant" {
        return None;
    }
    let ts = chrono::DateTime::parse_from_rfc3339(v["timestamp"].as_str()?).ok()?;
    let session = v["sessionId"].as_str().or_else(|| v["session_id"].as_str())?.to_string();
    let cwd = v["cwd"].as_str().unwrap_or("").to_string();
    let mut out = Line {
        m: ts.timestamp().div_euclid(60),
        session,
        project: project_name(&cwd),
        cwd,
        model: None,
        prompts: 0,
        tokens: 0,
        message_id: None,
    };
    if kind == "user" {
        out.prompts = is_typed_prompt(&v) as i64;
    } else {
        let usage = &v["message"]["usage"];
        let n = |k: &str| usage[k].as_i64().unwrap_or(0).max(0);
        out.tokens = n("input_tokens") + n("output_tokens") + n("cache_creation_input_tokens");
        out.model = v["message"]["model"].as_str().filter(|m| !m.starts_with('<')).map(str::to_string);
        out.message_id = v["message"]["id"].as_str().map(str::to_string);
    }
    Some(out)
}

fn log_files(root: &Path, newer_than: SystemTime) -> Vec<PathBuf> {
    let mut out = vec![];
    let Ok(projects) = std::fs::read_dir(root) else { return out };
    for project in projects.flatten() {
        let Ok(files) = std::fs::read_dir(project.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let recent = file.metadata().and_then(|m| m.modified()).map(|t| t >= newer_than).unwrap_or(false);
            if recent {
                out.push(path);
            }
        }
    }
    out
}

impl Scanner {
    pub fn new() -> Self {
        Scanner { seen: HashSet::new(), projects: HashMap::new() }
    }

    /// Reads whatever was appended to the logs since the last scan.
    pub fn scan(&mut self, store: &Store, since_secs: i64) {
        let Some(home) = dirs::home_dir() else { return };
        let root = home.join(".claude").join("projects");
        let now = SystemTime::now();
        let now_secs = now.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        for path in log_files(&root, now - BACKFILL) {
            self.scan_file(store, &path, now_secs, since_secs);
        }
        if self.seen.len() > 50_000 {
            self.seen.clear();
        }
    }

    fn scan_file(&mut self, store: &Store, path: &Path, now_secs: i64, since_secs: i64) {
        let key = path.to_string_lossy().to_string();
        let Ok(mut file) = File::open(path) else { return };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let mut offset = store.offset(&key).unwrap_or(0);
        if offset > size {
            offset = 0; // the file was replaced
        }
        if offset == size || file.seek(SeekFrom::Start(offset)).is_err() {
            return;
        }
        let mut bytes = Vec::new();
        if file.take(MAX_READ).read_to_end(&mut bytes).is_err() {
            return;
        }
        // Only whole lines; a line still being written is picked up next time.
        let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else { return };
        // Nothing from before this computer joined the team.
        let oldest = since_secs.max(now_secs - BACKFILL.as_secs() as i64).div_euclid(60);
        for raw in bytes[..end].split(|b| *b == b'\n') {
            let Ok(text) = std::str::from_utf8(raw) else { continue };
            let Some(line) = parse_line(text) else { continue };
            // The app's own question to Claude about sorting is not the person's work.
            if line.cwd.ends_with(crate::assist::WORKDIR) {
                continue;
            }
            if line.m < oldest || store.was_paused(line.m) {
                continue;
            }
            let mut tokens = line.tokens;
            if let Some(id) = &line.message_id {
                if !self.seen.insert(id.clone()) {
                    tokens = 0;
                }
            }
            let project = self
                .projects
                .entry(line.cwd.clone())
                .or_insert_with(|| repo_name(&line.cwd).unwrap_or_else(|| line.project.clone()))
                .clone();
            store.add_claude(line.m, &line.session, &project, line.model.as_deref(), line.prompts, tokens);
            if !line.cwd.is_empty() {
                store.note_repo(&line.cwd, now_secs);
            }
        }
        store.set_offset(&key, offset + end as u64 + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_a_typed_prompt() {
        let l = parse_line(r#"{"type":"user","timestamp":"2026-11-15T10:00:30.000Z","sessionId":"s1","cwd":"/Users/a/work/storefront","message":{"role":"user","content":"please fix it"}}"#).unwrap();
        assert_eq!((l.prompts, l.tokens), (1, 0));
        assert_eq!(l.project, "storefront");
        assert_eq!(l.m % 60, 0); // 10:00 UTC is the start of an hour
    }

    #[test]
    fn tool_results_and_side_chains_are_not_prompts() {
        let tool = parse_line(r#"{"type":"user","timestamp":"2026-11-15T10:00:30Z","sessionId":"s1","cwd":"/x","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#).unwrap();
        assert_eq!(tool.prompts, 0);
        let side = parse_line(r#"{"type":"user","isSidechain":true,"timestamp":"2026-11-15T10:00:30Z","sessionId":"s1","cwd":"/x","message":{"content":"do a thing"}}"#).unwrap();
        assert_eq!(side.prompts, 0);
        let meta = parse_line(r#"{"type":"user","isMeta":true,"timestamp":"2026-11-15T10:00:30Z","sessionId":"s1","cwd":"/x","message":{"content":"note"}}"#).unwrap();
        assert_eq!(meta.prompts, 0);
    }

    #[test]
    fn reads_tokens_from_replies() {
        let l = parse_line(r#"{"type":"assistant","timestamp":"2026-11-15T10:01:00Z","sessionId":"s1","cwd":"C:\\work\\api","message":{"id":"msg_1","model":"claude-x","usage":{"input_tokens":10,"output_tokens":200,"cache_creation_input_tokens":5,"cache_read_input_tokens":9000}}}"#).unwrap();
        assert_eq!(l.tokens, 215);
        assert_eq!(l.project, "api");
        assert_eq!(l.model.as_deref(), Some("claude-x"));
    }

    #[test]
    fn skips_other_lines() {
        assert!(parse_line(r#"{"type":"cost-state","timestamp":"2026-11-15T10:01:00Z","sessionId":"s1"}"#).is_none());
        assert!(parse_line("not json").is_none());
        assert!(parse_line(r#"{"type":"user","sessionId":"s1"}"#).is_none());
    }
}
