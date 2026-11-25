//! Local queue. Everything is written here first and uploaded later, so nothing is lost offline.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Serialize, Clone)]
pub struct MinuteRow {
    pub m: i64,
    pub keys: i64,
    pub clicks: i64,
    pub moves: i64,
    pub app: Option<String>,
    pub domain: Option<String>,
    pub paused: bool,
    pub title: Option<String>,
    pub path: Option<String>,
    pub repo: Option<String>,
    pub call: bool,
    #[serde(skip)]
    pub dirty: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRow {
    pub m: i64,
    pub session_id: String,
    pub project: String,
    pub model: Option<String>,
    pub prompts: i64,
    pub tokens: i64,
    #[serde(skip)]
    pub dirty: i64,
}

#[derive(Serialize, Clone)]
pub struct CommitRow {
    pub sha: String,
    pub repo: String,
    pub m: i64,
    pub added: i64,
    pub removed: i64,
    pub subject: String,
}

#[derive(Default)]
pub struct Batch {
    pub minutes: Vec<MinuteRow>,
    pub claude: Vec<ClaudeRow>,
    pub commits: Vec<CommitRow>,
}

impl Batch {
    pub fn is_empty(&self) -> bool {
        self.minutes.is_empty() && self.claude.is_empty() && self.commits.is_empty()
    }
}

const LIMIT: i64 = 1500;

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "pragma journal_mode = wal;
             create table if not exists config (key text primary key, value text not null);
             create table if not exists minutes (
               m integer primary key, keys integer not null, clicks integer not null, moves integer not null,
               app text, domain text, paused integer not null, dirty integer not null default 1);
             create table if not exists claude (
               m integer not null, session_id text not null, project text not null, model text,
               prompts integer not null, tokens integer not null, dirty integer not null default 1,
               primary key (m, session_id));
             create table if not exists commits (
               sha text primary key, repo text not null, m integer not null, added integer not null,
               removed integer not null, subject text not null, dirty integer not null default 1);
             create table if not exists offsets (path text primary key, offset integer not null);
             create table if not exists repos (path text primary key, seen integer not null);",
        )?;
        // Columns added in 0.2. Each fails harmlessly when it is already there.
        for column in ["title text", "path text", "repo text", "call integer not null default 0"] {
            let _ = conn.execute(&format!("alter table minutes add column {column}"), []);
        }
        Ok(Store { conn: Mutex::new(conn) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.conn()
            .query_row("select value from config where key = ?1", [key], |r| r.get(0))
            .optional()
            .ok()
            .flatten()
    }

    pub fn set(&self, key: &str, value: &str) {
        let _ = self.conn().execute(
            "insert into config (key, value) values (?1, ?2) on conflict(key) do update set value = ?2",
            params![key, value],
        );
    }

    pub fn del(&self, key: &str) {
        let _ = self.conn().execute("delete from config where key = ?1", [key]);
    }

    pub fn put_minute(&self, row: &MinuteRow) {
        let _ = self.conn().execute(
            "insert into minutes (m, keys, clicks, moves, app, domain, paused, title, path, repo, call, dirty)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1)
             on conflict(m) do update set keys = ?2, clicks = ?3, moves = ?4, app = ?5, domain = ?6,
               paused = ?7, title = ?8, path = ?9, repo = ?10, call = ?11, dirty = dirty + 1",
            params![row.m, row.keys, row.clicks, row.moves, row.app, row.domain, row.paused, row.title, row.path, row.repo, row.call],
        );
    }

    /// True if the person had tracking paused during this minute.
    pub fn was_paused(&self, m: i64) -> bool {
        self.conn()
            .query_row("select paused from minutes where m = ?1", [m], |r| r.get::<_, bool>(0))
            .optional()
            .ok()
            .flatten()
            .unwrap_or(false)
    }

    pub fn add_claude(&self, m: i64, session: &str, project: &str, model: Option<&str>, prompts: i64, tokens: i64) {
        let _ = self.conn().execute(
            "insert into claude (m, session_id, project, model, prompts, tokens, dirty)
             values (?1, ?2, ?3, ?4, ?5, ?6, 1)
             on conflict(m, session_id) do update set prompts = prompts + ?5, tokens = tokens + ?6,
               model = coalesce(?4, model), dirty = dirty + 1",
            params![m, session, project, model, prompts, tokens],
        );
    }

    pub fn add_commit(&self, row: &CommitRow) {
        let _ = self.conn().execute(
            "insert or ignore into commits (sha, repo, m, added, removed, subject) values (?1, ?2, ?3, ?4, ?5, ?6)",
            params![row.sha, row.repo, row.m, row.added, row.removed, row.subject],
        );
    }

    pub fn offset(&self, path: &str) -> Option<u64> {
        self.conn()
            .query_row("select offset from offsets where path = ?1", [path], |r| r.get::<_, i64>(0))
            .optional()
            .ok()
            .flatten()
            .map(|n| n as u64)
    }

    pub fn set_offset(&self, path: &str, offset: u64) {
        let _ = self.conn().execute(
            "insert into offsets (path, offset) values (?1, ?2) on conflict(path) do update set offset = ?2",
            params![path, offset as i64],
        );
    }

    pub fn note_repo(&self, path: &str, now: i64) {
        let _ = self.conn().execute(
            "insert into repos (path, seen) values (?1, ?2) on conflict(path) do update set seen = ?2",
            params![path, now],
        );
    }

    pub fn repos_since(&self, since: i64) -> Vec<String> {
        let conn = self.conn();
        let Ok(mut stmt) = conn.prepare("select path from repos where seen >= ?1") else { return vec![] };
        let rows = stmt.query_map([since], |r| r.get::<_, String>(0));
        rows.map(|r| r.flatten().collect()).unwrap_or_default()
    }

    pub fn pending(&self) -> Batch {
        let conn = self.conn();
        let mut batch = Batch::default();
        if let Ok(mut stmt) = conn.prepare(
            "select m, keys, clicks, moves, app, domain, paused, dirty, title, path, repo, call from minutes where dirty > 0 order by m limit ?1",
        ) {
            if let Ok(rows) = stmt.query_map([LIMIT], |r| {
                Ok(MinuteRow {
                    m: r.get(0)?,
                    keys: r.get(1)?,
                    clicks: r.get(2)?,
                    moves: r.get(3)?,
                    app: r.get(4)?,
                    domain: r.get(5)?,
                    paused: r.get(6)?,
                    dirty: r.get(7)?,
                    title: r.get(8)?,
                    path: r.get(9)?,
                    repo: r.get(10)?,
                    call: r.get(11)?,
                })
            }) {
                batch.minutes = rows.flatten().collect();
            }
        }
        if let Ok(mut stmt) = conn.prepare(
            "select m, session_id, project, model, prompts, tokens, dirty from claude where dirty > 0 order by m limit ?1",
        ) {
            if let Ok(rows) = stmt.query_map([LIMIT], |r| {
                Ok(ClaudeRow {
                    m: r.get(0)?,
                    session_id: r.get(1)?,
                    project: r.get(2)?,
                    model: r.get(3)?,
                    prompts: r.get(4)?,
                    tokens: r.get(5)?,
                    dirty: r.get(6)?,
                })
            }) {
                batch.claude = rows.flatten().collect();
            }
        }
        if let Ok(mut stmt) = conn.prepare(
            "select sha, repo, m, added, removed, subject from commits where dirty > 0 order by m limit ?1",
        ) {
            if let Ok(rows) = stmt.query_map([LIMIT], |r| {
                Ok(CommitRow {
                    sha: r.get(0)?,
                    repo: r.get(1)?,
                    m: r.get(2)?,
                    added: r.get(3)?,
                    removed: r.get(4)?,
                    subject: r.get(5)?,
                })
            }) {
                batch.commits = rows.flatten().collect();
            }
        }
        batch
    }

    /// Marks rows as uploaded, unless they changed again while the upload was in flight.
    pub fn mark_sent(&self, batch: &Batch) {
        let mut conn = self.conn();
        let Ok(tx) = conn.transaction() else { return };
        for r in &batch.minutes {
            let _ = tx.execute("update minutes set dirty = 0 where m = ?1 and dirty = ?2", params![r.m, r.dirty]);
        }
        for r in &batch.claude {
            let _ = tx.execute(
                "update claude set dirty = 0 where m = ?1 and session_id = ?2 and dirty = ?3",
                params![r.m, r.session_id, r.dirty],
            );
        }
        for r in &batch.commits {
            let _ = tx.execute("update commits set dirty = 0 where sha = ?1", [&r.sha]);
        }
        let _ = tx.commit();
    }

    /// Drops uploaded rows older than `before` (unix minutes).
    pub fn prune(&self, before: i64) {
        let conn = self.conn();
        let _ = conn.execute("delete from minutes where dirty = 0 and m < ?1", [before]);
        let _ = conn.execute("delete from claude where dirty = 0 and m < ?1", [before]);
        let _ = conn.execute("delete from commits where dirty = 0 and m < ?1", [before]);
    }

    /// Forgets everything queued. Used when the device is disconnected from its team.
    pub fn clear_queue(&self) {
        let _ = self.conn().execute_batch("delete from minutes; delete from claude; delete from commits;");
    }
}
