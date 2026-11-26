//! Reads the local session logs of Claude Code and Codex for usage numbers, including the copies
//! kept by apps that run them for you (T3 Code and its profiles).
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
    /// Codex log file -> (session, folder, model). Codex states these once, not on every line.
    codex: HashMap<String, (String, String, Option<String>)>,
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
    /// A Codex line: session and folder come from the file's header, not the line.
    pub codex: bool,
    /// Started by an app (T3 Code, an editor) and not typed into a terminal.
    pub from_app: bool,
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
    let ts = chrono::DateTime::parse_from_rfc3339(v["timestamp"].as_str()?).ok()?;
    if matches!(kind, "session_meta" | "turn_context" | "event_msg" | "token_usage_record") {
        return parse_codex(kind, &v["payload"], ts.timestamp().div_euclid(60));
    }
    if kind != "user" && kind != "assistant" {
        return None;
    }
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
        codex: false,
        from_app: v["entrypoint"].as_str().map(|e| e != "cli").unwrap_or(false),
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

/// Codex lines. A header gives the session and folder; a started task is a prompt; a usage
/// record gives tokens. Nothing else is looked at.
fn parse_codex(kind: &str, p: &Value, m: i64) -> Option<Line> {
    let mut out = Line {
        m, session: String::new(), cwd: String::new(), project: String::new(), model: None,
        prompts: 0, tokens: 0, message_id: None, codex: true, from_app: false,
    };
    match kind {
        "session_meta" => {
            out.session = p["id"].as_str().or_else(|| p["session_id"].as_str())?.to_string();
            out.cwd = p["cwd"].as_str().unwrap_or("").to_string();
        }
        "turn_context" => {
            out.cwd = p["cwd"].as_str().unwrap_or("").to_string();
            out.model = p["model"].as_str().map(str::to_string);
        }
        "event_msg" if p["type"] == "task_started" => out.prompts = 1,
        "token_usage_record" => {
            let n = |k: &str| p["usage"][k].as_i64().unwrap_or(0).max(0);
            out.tokens = (n("input_tokens") - n("cached_input_tokens")).max(0) + n("output_tokens");
        }
        _ => return None,
    }
    Some(out)
}

/// Recently changed .jsonl files under `root`, at most `depth` folders down.
fn log_files(root: &Path, newer_than: SystemTime, depth: u8) -> Vec<PathBuf> {
    let mut out = vec![];
    let Ok(entries) = std::fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if depth > 0 {
                out.extend(log_files(&path, newer_than, depth - 1));
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl")
            && meta.modified().map(|t| t >= newer_than).unwrap_or(false)
        {
            out.push(path);
        }
    }
    out
}

/// Home folders that may hold agent logs: the person's own, and one per T3 Code profile.
fn agent_homes(home: &Path) -> Vec<PathBuf> {
    let mut homes = vec![home.to_path_buf()];
    if let Ok(profiles) = std::fs::read_dir(home.join(".t3-profiles")) {
        homes.extend(profiles.flatten().map(|p| p.path()).filter(|p| p.is_dir()));
    }
    homes
}

/// The header of a Codex log, for when reading resumes in the middle of the file.
fn codex_header(path: &Path) -> Option<(String, String, Option<String>)> {
    use std::io::BufRead;
    let mut first = String::new();
    std::io::BufReader::new(File::open(path).ok()?).take(8 * 1024 * 1024).read_line(&mut first).ok()?;
    let line = parse_line(&first).filter(|l| l.codex && !l.session.is_empty())?;
    Some((line.session, line.cwd, None))
}

impl Scanner {
    pub fn new() -> Self {
        Scanner { seen: HashSet::new(), projects: HashMap::new(), codex: HashMap::new() }
    }

    /// Reads whatever was appended to the logs since the last scan.
    pub fn scan(&mut self, store: &Store, since_secs: i64) {
        let Some(home) = dirs::home_dir() else { return };
        let now = SystemTime::now();
        let now_secs = now.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        // The same folder can be reached through more than one profile; read each file once.
        let mut done = HashSet::new();
        for agent_home in agent_homes(&home) {
            let claude = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).filter(|_| agent_home == home);
            let roots = [
                (claude.unwrap_or_else(|| agent_home.join(".claude")).join("projects"), 1),
                (agent_home.join(".codex").join("sessions"), 4),
            ];
            for (root, depth) in roots {
                for path in log_files(&root, now - BACKFILL, depth) {
                    if done.insert(path.canonicalize().unwrap_or_else(|_| path.clone())) {
                        self.scan_file(store, &path, now_secs, since_secs);
                    }
                }
            }
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
            let Some(mut line) = parse_line(text) else { continue };
            if line.codex {
                if !self.codex.contains_key(&key) {
                    if let Some(header) = codex_header(path) {
                        self.codex.insert(key.clone(), header);
                    }
                }
                let ctx = self.codex.entry(key.clone()).or_default();
                if !line.session.is_empty() {
                    ctx.0 = line.session.clone();
                }
                if !line.cwd.is_empty() {
                    ctx.1 = line.cwd.clone();
                }
                if line.model.is_some() {
                    ctx.2 = line.model.clone();
                }
                if ctx.0.is_empty() || (line.prompts == 0 && line.tokens == 0) {
                    continue;
                }
                line.session = ctx.0.clone();
                line.cwd = ctx.1.clone();
                line.model = ctx.2.clone();
                line.project = project_name(&line.cwd);
            }
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
                // Which folder an agent was last working in, for apps that do not say themselves.
                let keys: &[&str] = if line.from_app { &["agent_recent", "agent_recent_app"] } else { &["agent_recent"] };
                for key in keys {
                    let newest = store.get(key).and_then(|v| v.split_once('|').and_then(|(m, _)| m.parse::<i64>().ok())).unwrap_or(0);
                    if line.m >= newest {
                        store.set(key, &format!("{}|{}", line.m, line.cwd));
                    }
                }
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

    #[test]
    fn reads_codex_lines() {
        let meta = parse_line(r#"{"timestamp":"2026-11-15T10:00:30Z","type":"session_meta","payload":{"id":"c1","cwd":"/Users/a/work/shop","base_instructions":"..."}}"#).unwrap();
        assert!(meta.codex);
        assert_eq!((meta.session.as_str(), meta.cwd.as_str()), ("c1", "/Users/a/work/shop"));
        let turn = parse_line(r#"{"timestamp":"2026-11-15T10:00:31Z","type":"turn_context","payload":{"cwd":"/Users/a/work/shop","model":"gpt-x"}}"#).unwrap();
        assert_eq!(turn.model.as_deref(), Some("gpt-x"));
        let prompt = parse_line(r#"{"timestamp":"2026-11-15T10:00:32Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}"#).unwrap();
        assert_eq!(prompt.prompts, 1);
        assert!(parse_line(r#"{"timestamp":"2026-11-15T10:00:33Z","type":"event_msg","payload":{"type":"token_count"}}"#).is_none());
        let usage = parse_line(r#"{"timestamp":"2026-11-15T10:00:34Z","type":"token_usage_record","payload":{"usage":{"input_tokens":17284,"cached_input_tokens":11904,"output_tokens":79,"total_tokens":17363}}}"#).unwrap();
        assert_eq!(usage.tokens, 17284 - 11904 + 79);
    }
}
