/** 按顺序追加，永远不要修改已发布的条目。下标 i 对应 user_version i+1。 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE tickets (
    key TEXT PRIMARY KEY,
    title TEXT,
    repo_path TEXT NOT NULL,
    work_mode TEXT NOT NULL CHECK (work_mode IN ('worktree', 'branch')),
    worktree_path TEXT,
    branch TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'in_review', 'blocked', 'merged_pending_followup', 'done')),
    status_manual TEXT
      CHECK (status_manual IS NULL OR status_manual IN ('active', 'in_review', 'blocked', 'merged_pending_followup', 'done')),
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    ticket_key TEXT REFERENCES tickets(key),
    cwd TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('butler', 'discovered')),
    git_branch TEXT,
    first_prompt TEXT,
    last_activity_at INTEGER,
    waiting_for_input INTEGER NOT NULL DEFAULT 0,
    replaced_by TEXT,
    dismissed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_ticket ON sessions(ticket_key);
  CREATE TABLE jobs (
    name TEXT PRIMARY KEY,
    last_run_at INTEGER,
    last_status TEXT,
    last_error TEXT
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE tickets ADD COLUMN status_changed_at INTEGER;
  ALTER TABLE tickets ADD COLUMN status_manual_at INTEGER;
  CREATE TABLE handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_key TEXT NOT NULL REFERENCES tickets(key),
    session_id TEXT,
    trigger TEXT NOT NULL CHECK (trigger IN ('nightly', 'manual', 'command', 'refresh')),
    created_at INTEGER NOT NULL,
    payload TEXT,
    degraded INTEGER NOT NULL DEFAULT 0,
    raw_text TEXT,
    source_ref TEXT
  );
  CREATE INDEX handoffs_ticket ON handoffs(ticket_key, created_at);
  CREATE INDEX handoffs_created ON handoffs(created_at);
  CREATE UNIQUE INDEX handoffs_source_ref ON handoffs(source_ref) WHERE source_ref IS NOT NULL;
  CREATE TABLE followups (
    id TEXT PRIMARY KEY,
    ticket_key TEXT NOT NULL REFERENCES tickets(key),
    kind TEXT NOT NULL CHECK (kind IN ('config', 'flag', 'deploy', 'doc', 'other')),
    description TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('after_merge', 'after_deploy', 'on_date', 'none')),
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'snoozed', 'ignored')),
    snoozed_until TEXT,
    source TEXT NOT NULL CHECK (source IN ('jira', 'session', 'manual')),
    created_at INTEGER NOT NULL,
    done_at INTEGER
  );
  CREATE INDEX followups_ticket ON followups(ticket_key);
  CREATE TABLE briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('morning', 'evening')),
    date TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    items TEXT NOT NULL,
    narrative TEXT,
    narrative_status TEXT NOT NULL DEFAULT 'off'
      CHECK (narrative_status IN ('ok', 'off', 'failed', 'blocked', 'budget'))
  );
  CREATE INDEX briefs_kind_created ON briefs(kind, created_at);
  CREATE TABLE item_marks (
    item_key TEXT PRIMARY KEY,
    mark TEXT NOT NULL CHECK (mark IN ('done', 'snoozed', 'ignored')),
    until_date TEXT,
    created_at INTEGER NOT NULL
  );
  `,
];
