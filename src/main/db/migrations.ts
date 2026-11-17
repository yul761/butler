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
  `
  CREATE TABLE llm_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('off', 'metadata', 'redacted', 'full')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'blocked', 'budget', 'declined')),
    payload_sent TEXT,
    response TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    cost_usd REAL,
    blocked_reason TEXT,
    error TEXT
  );
  CREATE INDEX llm_audit_ts ON llm_audit(ts);
  CREATE TABLE sensitive_terms (
    term TEXT PRIMARY KEY COLLATE NOCASE,
    category TEXT NOT NULL CHECK (category IN ('person', 'term'))
  );
  CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    value BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE memory_sync (
    ticket_key TEXT PRIMARY KEY REFERENCES tickets(key),
    handoff_id INTEGER NOT NULL,
    synced_at INTEGER NOT NULL
  );
  ALTER TABLE llm_audit ADD COLUMN source TEXT NOT NULL DEFAULT 'narrative' CHECK (source IN ('narrative', 'statecore'));
  INSERT OR IGNORE INTO settings (key, value) SELECT 'onboardingDone', '1' WHERE EXISTS (SELECT 1 FROM tickets);
  `,
  `
  CREATE TABLE ticket_repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_key TEXT NOT NULL REFERENCES tickets(key),
    repo_path TEXT NOT NULL,
    work_mode TEXT NOT NULL CHECK (work_mode IN ('worktree', 'branch')),
    worktree_path TEXT,
    branch TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (ticket_key, repo_path)
  );
  INSERT INTO ticket_repos (ticket_key, repo_path, work_mode, worktree_path, branch, created_at)
    SELECT key, repo_path, work_mode, worktree_path, branch, created_at FROM tickets WHERE repo_path <> '';
  ALTER TABLE sessions ADD COLUMN repo_id INTEGER REFERENCES ticket_repos(id);
  ALTER TABLE sessions ADD COLUMN coordinator INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN spawned_by TEXT;
  UPDATE sessions SET repo_id = (SELECT r.id FROM ticket_repos r WHERE r.ticket_key = sessions.ticket_key)
    WHERE ticket_key IS NOT NULL;
  `,
  `
  CREATE TABLE features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    workspace_dir TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE TABLE feature_repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL REFERENCES features(id),
    repo_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (feature_id, repo_path)
  );
  ALTER TABLE tickets ADD COLUMN feature_id INTEGER REFERENCES features(id);
  ALTER TABLE sessions ADD COLUMN feature_id INTEGER REFERENCES features(id);
  ALTER TABLE ticket_repos ADD COLUMN worktree_removed_at INTEGER;
  ALTER TABLE ticket_repos ADD COLUMN cleanup_blocked TEXT;
  `,
  `
  INSERT OR IGNORE INTO settings (key, value)
    SELECT 'language', 'zh'
    WHERE EXISTS (SELECT 1 FROM tickets) OR EXISTS (SELECT 1 FROM settings WHERE key = 'onboardingDone' AND value = '1');
  `,
  `
  CREATE TABLE feature_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL REFERENCES features(id),
    session_id TEXT,
    trigger TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    covers_until INTEGER,
    payload TEXT,
    degraded INTEGER NOT NULL DEFAULT 0,
    raw_text TEXT,
    source_ref TEXT UNIQUE
  );
  CREATE INDEX idx_feature_handoffs_feature ON feature_handoffs (feature_id, created_at);
  `,
  `
  ALTER TABLE sessions ADD COLUMN fixes_session TEXT;
  `,
  `
  CREATE TABLE epics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    workspace_dir TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );
  CREATE TABLE epic_repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_id INTEGER NOT NULL REFERENCES epics(id),
    repo_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (epic_id, repo_path)
  );
  ALTER TABLE features ADD COLUMN epic_id INTEGER REFERENCES epics(id);
  ALTER TABLE features ADD COLUMN brief TEXT;
  ALTER TABLE features ADD COLUMN brief_sent_at INTEGER;
  ALTER TABLE sessions ADD COLUMN epic_id INTEGER REFERENCES epics(id);
  `,
  `
  CREATE TABLE merge_holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('pr', 'local')),
    pr_url TEXT,
    session_id TEXT,
    ticket_key TEXT,
    created_at INTEGER NOT NULL,
    released_at INTEGER,
    outcome TEXT CHECK (outcome IN ('merged', 'cancelled', 'expired'))
  );
  CREATE INDEX idx_merge_holds_repo ON merge_holds (repo_path, branch);
  CREATE TABLE merge_waiters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hold_id INTEGER NOT NULL REFERENCES merge_holds(id),
    session_id TEXT,
    ticket_key TEXT,
    branch TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    notified_at INTEGER
  );
  CREATE TABLE merge_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('wait', 'proceed_conflict', 'rebase', 'dir_busy')),
    ticket_key TEXT,
    branch TEXT NOT NULL,
    other_ticket TEXT,
    other_branch TEXT,
    files TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_merge_events_created ON merge_events (created_at);
  `,
  // 每轮 token 用量 + transcript 增量读取位置
  `
  CREATE TABLE session_usage (
    message_id TEXT PRIMARY KEY,
    session_id TEXT,
    agent_id TEXT,
    source TEXT NOT NULL CHECK (source IN ('session', 'subagent', 'headless')),
    job TEXT,
    at INTEGER NOT NULL,
    model TEXT,
    input INTEGER NOT NULL,
    cache_write_5m INTEGER NOT NULL,
    cache_write_1h INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    output INTEGER NOT NULL,
    context INTEGER NOT NULL
  );
  CREATE INDEX idx_session_usage_session ON session_usage (session_id, at);
  CREATE INDEX idx_session_usage_at ON session_usage (at);
  CREATE TABLE usage_cursors (
    file TEXT PRIMARY KEY,
    offset INTEGER NOT NULL,
    size INTEGER NOT NULL
  );
  `,
  // 被监视的 PR：每个 ticket 仓库一行，投递去重键跨重启保留
  `
  CREATE TABLE pr_watch (
    repo_id INTEGER PRIMARY KEY REFERENCES ticket_repos(id) ON DELETE CASCADE,
    ticket_key TEXT NOT NULL,
    repo_path TEXT NOT NULL,
    branch TEXT NOT NULL,
    number INTEGER,
    url TEXT,
    state TEXT,
    review TEXT,
    ci TEXT NOT NULL,
    head_sha TEXT,
    failed TEXT NOT NULL DEFAULT '[]',
    checked_at INTEGER NOT NULL,
    delivered_key TEXT
  );
  `,
  // session 开出来时用的模型（opus / sonnet；null：没指定，用 Claude Code 自己的默认），恢复时沿用
  `ALTER TABLE sessions ADD COLUMN model TEXT;`,
  // epic 的规划单独存放（计划 16）：plan 是 epic session 用 set_epic_plan 写的规划；plan_at 是规划这一栏最后一次定下的时间。
  // 升级前的 epic 两个都是 NULL：规划还在 epic 记忆的 handoff 里，第一次同步时迁过来（MemoryService.syncEpicNow）。
  `ALTER TABLE epics ADD COLUMN plan TEXT;
  ALTER TABLE epics ADD COLUMN plan_at INTEGER;`,
  // epic 的长期记忆（计划 16 任务 6）：每周和 feature 归档时整理一次，全文追加在这里。不属于 epic 的 feature 归档时 epic_id 为 NULL。
  `
  CREATE TABLE epic_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_id INTEGER REFERENCES epics(id),
    feature_id INTEGER REFERENCES features(id),
    trigger TEXT NOT NULL CHECK (trigger IN ('weekly', 'feature_archived')),
    created_at INTEGER NOT NULL,
    covers_from INTEGER NOT NULL,
    covers_until INTEGER NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX idx_epic_history_epic ON epic_history (epic_id, created_at);
  `,
  // session 隐藏的时间（BTL-190 第 8 点）：隐藏超过 14 天的 session 行自动删掉。升级前就隐藏着的从升级这一刻算起，
  // 不会一升级就被删。
  `ALTER TABLE sessions ADD COLUMN dismissed_at INTEGER;
  UPDATE sessions SET dismissed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE dismissed = 1;`,
  // 「待你决定」和汇报（BTL-190 第 2+3 点）。kind = decision：ask_user 记下的问题，status 是 pending / answered / dismissed /
  // superseded；answer 有值而 status 还是 pending 表示用户答了、还没送进终端。kind = report：report 交的汇报，report_kind 是
  // progress / done / blocked；status pending 表示还要送给总控，answered 表示送到了，dismissed 表示不用送（progress、没有总控、太旧）。
  // session_id 是提问 / 汇报时的 session（不加外键：session 换新以后沿着 replaced_by 找到当前那个；删 session 时一起删掉）。
  `
  CREATE TABLE inbox_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'report')),
    session_id TEXT NOT NULL,
    ticket_key TEXT,
    feature_id INTEGER,
    epic_id INTEGER,
    text TEXT NOT NULL,
    options TEXT,
    context TEXT,
    report_kind TEXT CHECK (report_kind IS NULL OR report_kind IN ('progress', 'done', 'blocked')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered', 'dismissed', 'superseded')),
    answer TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX idx_inbox_items_status ON inbox_items (kind, status);
  CREATE INDEX idx_inbox_items_session ON inbox_items (session_id);
  `,
  // Butler 总控（BTL-190 第 5 点）：全局只有一个的 session，ticket、feature、epic 都是空的。单独一列标出来，
  // 免得被当成没归属的 session（认领页）或者 epic session。
  `ALTER TABLE sessions ADD COLUMN butler INTEGER NOT NULL DEFAULT 0;`,
  // PR 进度条（pr-stages）：记录观察到的原始事件（skill 调用、首次提交、push、CI、review、评论、合并），阶段由纯函数从这些事件推导。
  // ticket_key 不加外键：feature/epic 层的 skill 事件没有 ticket。
  `
  CREATE TABLE pr_stage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key TEXT NOT NULL UNIQUE,
    ticket_key TEXT,
    repo_id INTEGER REFERENCES ticket_repos(id) ON DELETE CASCADE,
    branch TEXT,
    feature_id INTEGER,
    epic_id INTEGER,
    session_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('skill','first_commit','pr_opened','push','ci','review','comment','merged','closed')),
    at INTEGER NOT NULL,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_pr_stage_events_ticket ON pr_stage_events (ticket_key, at);
  CREATE INDEX idx_pr_stage_events_upper ON pr_stage_events (feature_id, epic_id);
  `,
  // 复盘规矩（review-lessons）：从已合并 PR 的 review 里提炼出来的规矩，只存在 Butler 里。
  // lessons 属于一个仓库或一个产品（二选一）；lesson_queue 是待分析的 PR，(repo_slug, pr_number) 唯一，不会排两次。
  `
  CREATE TABLE lesson_repos (
    slug TEXT PRIMARY KEY, local_path TEXT NOT NULL,
    merged_cursor TEXT,
    backfilled_at INTEGER, last_analyzed_at INTEGER, analyzed_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL);
  CREATE TABLE lesson_products (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
  CREATE TABLE lesson_product_repos (
    product_id INTEGER NOT NULL REFERENCES lesson_products(id) ON DELETE CASCADE,
    repo_slug TEXT NOT NULL REFERENCES lesson_repos(slug) ON DELETE CASCADE,
    PRIMARY KEY (product_id, repo_slug));
  CREATE TABLE lessons (
    id INTEGER PRIMARY KEY,
    repo_slug TEXT REFERENCES lesson_repos(slug) ON DELETE CASCADE,
    product_id INTEGER REFERENCES lesson_products(id) ON DELETE CASCADE,
    text TEXT NOT NULL, why TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','confirmed','disabled','rejected')),
    hits INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK ((repo_slug IS NULL) <> (product_id IS NULL)));
  CREATE TABLE lesson_sources (
    id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    pr_number INTEGER NOT NULL, url TEXT, at INTEGER NOT NULL,
    UNIQUE (lesson_id, pr_number, url));
  CREATE TABLE lesson_queue (
    id INTEGER PRIMARY KEY, repo_slug TEXT NOT NULL REFERENCES lesson_repos(slug) ON DELETE CASCADE,
    pr_number INTEGER NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('backfill','merged','daily')),
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','skipped','failed')),
    error TEXT, enqueued_at INTEGER NOT NULL, finished_at INTEGER, not_before INTEGER,
    UNIQUE (repo_slug, pr_number));
  CREATE INDEX lesson_queue_status ON lesson_queue(status, enqueued_at);
  `,
  // PR 进度按 PR 记（ticket_prs），不再按 ticket 仓库记；branch_watch 只记分支的 CI。pr_stage_events 加 pr_id。
  `
  CREATE TABLE ticket_prs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_key TEXT NOT NULL REFERENCES tickets(key),
    url TEXT NOT NULL,
    slug TEXT NOT NULL,
    repo_id INTEGER REFERENCES ticket_repos(id) ON DELETE SET NULL,
    number INTEGER NOT NULL,
    head_branch TEXT,
    state TEXT NOT NULL CHECK (state IN ('open','merged','closed')),
    review TEXT,
    ci TEXT NOT NULL DEFAULT 'unknown',
    read_error INTEGER NOT NULL DEFAULT 0,
    head_sha TEXT,
    failed TEXT NOT NULL DEFAULT '[]',
    opened_at INTEGER, merged_at INTEGER, closed_at INTEGER,
    source TEXT NOT NULL CHECK (source IN ('branch','handoff','merge_gate','backfill')),
    linked_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL DEFAULT 0,
    delivered_key TEXT,
    merged_handled_at INTEGER,
    UNIQUE (ticket_key, url)
  );
  CREATE INDEX idx_ticket_prs_url ON ticket_prs (url);
  CREATE INDEX idx_ticket_prs_state ON ticket_prs (state);
  CREATE TABLE branch_watch (
    repo_id INTEGER PRIMARY KEY REFERENCES ticket_repos(id) ON DELETE CASCADE,
    ticket_key TEXT NOT NULL, branch TEXT NOT NULL,
    ci TEXT NOT NULL DEFAULT 'unknown', head_sha TEXT, failed TEXT NOT NULL DEFAULT '[]',
    read_error INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0, delivered_key TEXT
  );
  ALTER TABLE pr_stage_events ADD COLUMN pr_id INTEGER REFERENCES ticket_prs(id) ON DELETE CASCADE;
  CREATE INDEX idx_pr_stage_events_pr ON pr_stage_events (pr_id);
  `,
  // pr_watch 的行搬进 ticket_prs（有 PR 的）和 branch_watch（只有分支的），事件补上 pr_id，然后删掉 pr_watch。
  // 已合并、已关闭但没有对应事件的行 checked_at 记 0：再读一次拿到 GitHub 的时间；已合并的记作 onMerged 处理过，不再排复盘。
  `
  WITH w AS (
    SELECT *, lower(rtrim(trim(url), '/')) AS u FROM pr_watch
    WHERE number IS NOT NULL AND url IS NOT NULL AND state IS NOT NULL AND instr(lower(url), '/pull/') > 0
  ), p AS (
    SELECT *, substr(u, instr(u, '://') + 3) AS rest FROM w
  ), q AS (
    SELECT *, substr(rest, 1, instr(rest, '/pull/') - 1) AS path,
      (SELECT MIN(at) FROM pr_stage_events e WHERE e.repo_id = p.repo_id AND e.branch = p.branch AND e.kind = 'pr_opened') AS opened,
      (SELECT MIN(at) FROM pr_stage_events e WHERE e.repo_id = p.repo_id AND e.branch = p.branch AND e.kind = 'merged') AS merged,
      (SELECT MIN(at) FROM pr_stage_events e WHERE e.repo_id = p.repo_id AND e.branch = p.branch AND e.kind = 'closed') AS closed
    FROM p
  )
  INSERT OR IGNORE INTO ticket_prs (ticket_key, url, slug, repo_id, number, head_branch, state, review, ci, read_error, head_sha, failed,
    opened_at, merged_at, closed_at, source, linked_at, checked_at, delivered_key, merged_handled_at)
  SELECT ticket_key, u, CASE WHEN path LIKE 'github.com/%' THEN substr(path, 12) ELSE path END, repo_id, number, branch, state,
    review, ci, 0, head_sha, failed, opened, merged, closed, 'branch', checked_at,
    CASE WHEN (state = 'merged' AND merged IS NULL) OR (state = 'closed' AND closed IS NULL) THEN 0 ELSE checked_at END,
    delivered_key, CASE WHEN state = 'merged' THEN checked_at END
  FROM q;
  INSERT INTO branch_watch (repo_id, ticket_key, branch, ci, head_sha, failed, read_error, checked_at, delivered_key)
    SELECT repo_id, ticket_key, branch, ci, head_sha, failed, 0, checked_at, delivered_key FROM pr_watch WHERE number IS NULL;
  UPDATE pr_stage_events SET pr_id = (SELECT t.id FROM ticket_prs t WHERE t.repo_id = pr_stage_events.repo_id AND t.head_branch = pr_stage_events.branch)
    WHERE pr_id IS NULL AND kind IN ('pr_opened','push','ci','review','comment','merged','closed');
  DROP TABLE pr_watch;
  `,
  // 分析运行记录（lesson_runs）、队列的重试/错误信息、规矩出处带仓库和运行、Claude 可用性、session 关联运行。
  `
  CREATE TABLE lesson_runs (
    id INTEGER PRIMARY KEY,
    queue_id INTEGER REFERENCES lesson_queue(id) ON DELETE SET NULL,
    repo_slug TEXT NOT NULL REFERENCES lesson_repos(slug) ON DELETE CASCADE,
    pr_number INTEGER NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','done','skipped','failed','limited','aborted','cancelled')),
    reason TEXT, message TEXT, stderr_tail TEXT, gh_stderr TEXT,
    pr_title TEXT, pr_url TEXT,
    material TEXT, raw_output TEXT, findings_json TEXT,
    trimmed INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL DEFAULT 0, hit INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
    model TEXT, cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER,
    started_at INTEGER NOT NULL, finished_at INTEGER);
  CREATE INDEX lesson_runs_pr ON lesson_runs (repo_slug, pr_number, started_at);
  CREATE INDEX lesson_runs_started ON lesson_runs (started_at);
  ALTER TABLE lesson_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lesson_queue ADD COLUMN last_run_id INTEGER REFERENCES lesson_runs(id) ON DELETE SET NULL;
  ALTER TABLE lesson_queue ADD COLUMN error_message TEXT;
  ALTER TABLE lesson_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lesson_sources ADD COLUMN repo_slug TEXT;
  ALTER TABLE lesson_sources ADD COLUMN run_id INTEGER REFERENCES lesson_runs(id) ON DELETE SET NULL;
  UPDATE lesson_sources SET repo_slug = (SELECT l.repo_slug FROM lessons l WHERE l.id = lesson_sources.lesson_id);
  UPDATE lesson_sources SET repo_slug = substr(url, 20, instr(url, '/pull/') - 20)
    WHERE repo_slug IS NULL AND url LIKE 'https://github.com/%/pull/%';
  CREATE TABLE claude_availability (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, updated_at INTEGER NOT NULL);
  ALTER TABLE sessions ADD COLUMN lesson_run_id INTEGER REFERENCES lesson_runs(id) ON DELETE SET NULL;
  `,
  // PR 一直读不到：连续失败的次数；失败到上限后 read_retry_at 之前不再读（一天试一次）。读成功两个都清掉。
  `
  ALTER TABLE ticket_prs ADD COLUMN read_failures INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ticket_prs ADD COLUMN read_retry_at INTEGER;
  `,
];
