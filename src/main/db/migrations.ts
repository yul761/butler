/** 迁移里写了这一行：只加列，migrate 先查 PRAGMA table_info 再逐列加（见 addColumns）。 */
export const CHECKED_ADD_COLUMNS = "-- shipherd:checked-add-columns";

/**
 * 只加列的迁移（4.3.0 起这样写）。rebase 后迁移换了位置、用户装过把它排在前面的测试版本时，这几列在升到这一步之前就已经在了：
 * 那个版本在这个位置跑的是这条，现在排在它前面的别的迁移这份数据没跑过。migrate 认到 CHECKED_ADD_COLUMNS 就逐列查，
 * 有已经在的列就抛 MigrationOrderError（起不来、告诉用户换回备份），不悄悄跳过别的迁移，也不报看不懂的 duplicate column。
 * 生成的仍是普通 SQL（测试里直接 db.exec 照样能跑）。cols 每一项是「列名 类型 约束」，和 ALTER TABLE … ADD COLUMN 后面写的一样。
 */
export function addColumns(table: string, cols: readonly string[]): string {
  if (!/^\w+$/.test(table) || cols.length === 0 || cols.some((c) => !/^\w+\s+\S/.test(c) || c.includes(";") || c.includes("\n"))) throw new Error(`addColumns: bad ${table} ${cols.join(", ")}`);
  return [CHECKED_ADD_COLUMNS, ...cols.map((c) => `ALTER TABLE ${table} ADD COLUMN ${c};`)].join("\n");
}

/**
 * 按顺序追加，永远不要修改已发布的条目。下标 i 对应 user_version i+1。
 * 产品改名（BTL-260）以前的条目里还是旧名字 butler（列名、表名、取值）：它们已经在用户的库上跑过，只能原样保留，
 * 最后一条迁移再把它们改成 shipherd。
 */
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
  // 有号但 url / state 不全、url 不是 PR 的，当作只有分支：进 branch_watch，不丢。ticket 已经不在的（pr_watch.ticket_key 没有外键）
  // 不进 ticket_prs：它的外键会让整个迁移失败、启动不了。
  `
  WITH w AS (
    SELECT *, lower(rtrim(trim(url), '/')) AS u FROM pr_watch
    WHERE number IS NOT NULL AND url IS NOT NULL AND ifnull(state, '') IN ('open','merged','closed') AND instr(lower(url), '/pull/') > 0
      AND ticket_key IN (SELECT key FROM tickets)
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
    SELECT repo_id, ticket_key, branch, ci, head_sha, failed, 0, checked_at, delivered_key FROM pr_watch
    WHERE NOT (number IS NOT NULL AND url IS NOT NULL AND ifnull(state, '') IN ('open','merged','closed') AND instr(lower(url), '/pull/') > 0);
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
  // PR 一直读不到：连续失败的次数和这一串失败开始的时间；失败到上限、而且已经失败了一天，read_retry_at 之前不再读（一天试一次）。读成功三个都清掉。
  `
  ALTER TABLE ticket_prs ADD COLUMN read_failures INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ticket_prs ADD COLUMN read_failing_since INTEGER;
  ALTER TABLE ticket_prs ADD COLUMN read_retry_at INTEGER;
  `,
  // 规矩的准入和评分（Butler 3 工作流 C）：批次（每次批量或自动改动一批，带逐行的前后快照，可整批撤销）、三层准入策略、
  // 批次评审和校准样本；lessons 加适用范围、强度、可检查性、准入、评分、合并目标和降级产出标记。
  // status 不变；已经由人决定过的（confirmed / disabled / rejected）admission 记 manual，自动降级不碰它们。
  `
  CREATE TABLE admission_batches (
    id INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('manual','auto','import')),
    entity TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT '{}',
    policy_snapshot TEXT,
    summary TEXT NOT NULL DEFAULT '{}',
    affected INTEGER NOT NULL DEFAULT 0,
    undone_at INTEGER,
    undo_of INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL);
  CREATE INDEX admission_batches_created ON admission_batches (created_at);
  CREATE TABLE admission_batch_items (
    batch_id INTEGER NOT NULL REFERENCES admission_batches(id) ON DELETE CASCADE,
    entity TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    before TEXT,
    after TEXT,
    PRIMARY KEY (batch_id, entity, entity_id));
  CREATE INDEX admission_batch_items_entity ON admission_batch_items (entity, entity_id);
  ALTER TABLE lessons ADD COLUMN scope_globs TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE lessons ADD COLUMN scope_lang TEXT;
  ALTER TABLE lessons ADD COLUMN scope_layer TEXT;
  ALTER TABLE lessons ADD COLUMN strength TEXT CHECK (strength IS NULL OR strength IN ('must','should'));
  ALTER TABLE lessons ADD COLUMN checkability TEXT CHECK (checkability IS NULL OR checkability IN ('checkable','prose','converted','covered'));
  ALTER TABLE lessons ADD COLUMN admission TEXT NOT NULL DEFAULT 'pending' CHECK (admission IN ('pending','auto','manual','shelved'));
  ALTER TABLE lessons ADD COLUMN shelved_reason TEXT;
  ALTER TABLE lessons ADD COLUMN shelved_ref INTEGER;
  ALTER TABLE lessons ADD COLUMN batch_id INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL;
  ALTER TABLE lessons ADD COLUMN merged_into INTEGER REFERENCES lessons(id) ON DELETE SET NULL;
  ALTER TABLE lessons ADD COLUMN score REAL;
  ALTER TABLE lessons ADD COLUMN score_parts TEXT;
  ALTER TABLE lessons ADD COLUMN scored_at INTEGER;
  ALTER TABLE lessons ADD COLUMN score_policy_version INTEGER;
  ALTER TABLE lessons ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE lessons ADD COLUMN degraded_from TEXT;
  UPDATE lessons SET admission = 'manual' WHERE status IN ('confirmed','disabled','rejected');
  CREATE INDEX lessons_merged ON lessons (merged_into);
  CREATE TABLE admission_policies (
    id INTEGER PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','product','repo')),
    product_id INTEGER REFERENCES lesson_products(id) ON DELETE CASCADE,
    repo_slug TEXT,
    overrides TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    CHECK ((scope_kind = 'global' AND product_id IS NULL AND repo_slug IS NULL)
        OR (scope_kind = 'product' AND product_id IS NOT NULL AND repo_slug IS NULL)
        OR (scope_kind = 'repo' AND product_id IS NULL AND repo_slug IS NOT NULL)));
  CREATE UNIQUE INDEX admission_policies_layer ON admission_policies (scope_kind, COALESCE(product_id, 0), COALESCE(repo_slug, ''));
  CREATE TABLE batch_reviews (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES admission_batches(id) ON DELETE CASCADE,
    sample_size INTEGER NOT NULL DEFAULT 0,
    pass_rate REAL,
    coverage REAL,
    shelved_shares TEXT NOT NULL DEFAULT '{}',
    backtest_recall REAL,
    backtest_false_positives INTEGER,
    verdicts TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL);
  CREATE INDEX batch_reviews_batch ON batch_reviews (batch_id);
  CREATE TABLE score_calibration (
    id INTEGER PRIMARY KEY,
    entity TEXT NOT NULL DEFAULT 'lesson',
    lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
    entity_id INTEGER,
    auto_verdict TEXT NOT NULL,
    human_verdict TEXT NOT NULL,
    score REAL,
    score_parts TEXT,
    batch_id INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL,
    at INTEGER NOT NULL);
  CREATE INDEX score_calibration_at ON score_calibration (at);
  `,
  // 工作流 E1：确定性检查（契约 4.5）。checks 按层存（全局 / 产品 / 仓库），同一个 key 在更窄的层里是覆盖；
  // check_hits 是 hook 命中日志的入库；sessions.checks_absent 记 session 启动时为什么没有检查。
  // 种一条全局、默认关闭的注释规则（名字和文案留空，写快照时按界面语言补默认）。
  `
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','product','repo')),
    product_id INTEGER REFERENCES lesson_products(id) ON DELETE CASCADE,
    repo_slug TEXT,
    type TEXT NOT NULL CHECK (type IN ('forbidden_pattern','import_boundary','comment_policy','run_command')),
    name TEXT NOT NULL DEFAULT '',
    params TEXT NOT NULL DEFAULT '{}',
    globs TEXT NOT NULL DEFAULT '[]',
    exclude_globs TEXT NOT NULL DEFAULT '[]',
    severity TEXT NOT NULL CHECK (severity IN ('block','warn')),
    mode TEXT NOT NULL CHECK (mode IN ('shadow','enforce')),
    enabled INTEGER NOT NULL DEFAULT 1,
    message TEXT NOT NULL DEFAULT '',
    lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
    batch_id INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((scope_kind = 'global' AND product_id IS NULL AND repo_slug IS NULL)
        OR (scope_kind = 'product' AND product_id IS NOT NULL AND repo_slug IS NULL)
        OR (scope_kind = 'repo' AND product_id IS NULL AND repo_slug IS NOT NULL)));
  CREATE UNIQUE INDEX checks_layer_key ON checks (scope_kind, COALESCE(product_id, 0), COALESCE(repo_slug, ''), key);
  CREATE INDEX checks_lesson ON checks (lesson_id);
  CREATE TABLE check_hits (
    id INTEGER PRIMARY KEY,
    check_id INTEGER REFERENCES checks(id) ON DELETE SET NULL,
    check_key TEXT NOT NULL,
    repo_slug TEXT,
    file TEXT NOT NULL DEFAULT '',
    line INTEGER,
    stage TEXT NOT NULL CHECK (stage IN ('edit','push')),
    mode TEXT NOT NULL CHECK (mode IN ('shadow','enforce')),
    severity TEXT NOT NULL CHECK (severity IN ('block','warn')),
    outcome TEXT NOT NULL CHECK (outcome IN ('fail','resolved','timeout','unavailable','error')),
    blocked INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('false_positive','true_positive')),
    verdict_at INTEGER,
    at INTEGER NOT NULL,
    ingest_key TEXT NOT NULL UNIQUE);
  CREATE INDEX check_hits_check ON check_hits (check_id, at);
  CREATE INDEX check_hits_key ON check_hits (check_key, at);
  CREATE INDEX check_hits_session ON check_hits (session_id);
  ALTER TABLE sessions ADD COLUMN checks_absent TEXT;
  INSERT INTO checks (key, scope_kind, type, params, severity, mode, enabled, created_at, updated_at)
    VALUES ('builtin:comment_policy', 'global', 'comment_policy', '{}', 'block', 'enforce', 0, 0, 0);
  `,
  // 模型路由（工作流 A）：模型注册表、每档的降级链、任务覆盖、识别规则、按模型的健康状态、未识别报错、路由事件；
  // 用量和复盘运行记下任务、要的档位、实际模型、从哪个模型降下来；复盘队列的「待升级重跑」。
  `
  CREATE TABLE model_registry (
    name TEXT PRIMARY KEY, tier TEXT NOT NULL CHECK (tier IN ('high','mid','low')), enabled INTEGER NOT NULL DEFAULT 1,
    account TEXT NOT NULL DEFAULT 'default', price_in REAL, price_out REAL, note TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE model_chains (
    tier TEXT NOT NULL CHECK (tier IN ('high','mid','low')), position INTEGER NOT NULL, model TEXT NOT NULL,
    PRIMARY KEY (tier, position));
  CREATE TABLE task_routes (
    task TEXT PRIMARY KEY, tier TEXT CHECK (tier IS NULL OR tier IN ('high','mid','low')),
    min_tier TEXT CHECK (min_tier IS NULL OR min_tier IN ('high','mid','low')),
    policy TEXT CHECK (policy IS NULL OR policy IN ('fallback','wait','escalate')), critical INTEGER);
  CREATE TABLE limit_rules (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('regex','status','field','reset')), pattern TEXT NOT NULL,
    category TEXT CHECK (category IS NULL OR category IN ('usage_limit','rate_limit','overloaded','model_unavailable')),
    account_level INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL CHECK (source IN ('builtin','user','learned')),
    enabled INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  CREATE TABLE model_health (
    model TEXT PRIMARY KEY, state TEXT NOT NULL CHECK (state IN ('ok','limited','unavailable','probing')),
    kind TEXT, until INTEGER, reset_known INTEGER NOT NULL DEFAULT 0, backoff_step INTEGER NOT NULL DEFAULT 0,
    hit_at INTEGER, suspected INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0, failure_streak_since INTEGER,
    last_success_at INTEGER, last_failure_at INTEGER, last_failure_text TEXT, updated_at INTEGER NOT NULL);
  CREATE TABLE unrecognized_errors (
    id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, sample TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1,
    models TEXT NOT NULL DEFAULT '[]', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','dismissed')),
    category TEXT, signal TEXT NOT NULL DEFAULT 'observed', rule_id TEXT);
  CREATE TABLE route_events (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, task TEXT, model TEXT, to_model TEXT, detail TEXT);
  CREATE INDEX route_events_at ON route_events (at);
  ALTER TABLE session_usage ADD COLUMN task TEXT;
  ALTER TABLE session_usage ADD COLUMN requested_tier TEXT;
  ALTER TABLE session_usage ADD COLUMN fallback_from TEXT;
  ALTER TABLE session_usage ADD COLUMN cost_usd REAL;
  ALTER TABLE lesson_runs ADD COLUMN requested_tier TEXT;
  ALTER TABLE lesson_runs ADD COLUMN actual_model TEXT;
  ALTER TABLE lesson_runs ADD COLUMN fallback_from TEXT;
  ALTER TABLE lesson_queue ADD COLUMN upgrade_pending INTEGER NOT NULL DEFAULT 0;
  `,
  // 工作流 W：分支是谁的（session 推过、开过 PR 的分支），CI 结论按它递（设计文档 2026-11-18-ws-w-ci-delivery）。
  `
  CREATE TABLE branch_owners (
    ticket_key TEXT NOT NULL,
    repo_id INTEGER NOT NULL REFERENCES ticket_repos(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    session_id TEXT NOT NULL,
    dir TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (ticket_key, repo_id, branch));
  CREATE INDEX branch_owners_at ON branch_owners (at);
  `,
  // 内存与卡顿（WS-M A）：每个 session 最近一次采到的进程树内存，和每 5 分钟一行的历史（留 14 天）。
  // kind：session（session_id 是 head）、butler（Butler 自己的进程）、system（系统可用内存）。detail 是各类别的 JSON。
  `
  ALTER TABLE sessions ADD COLUMN mem_kb INTEGER;
  ALTER TABLE sessions ADD COLUMN mem_at INTEGER;
  CREATE TABLE memory_samples (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('session','butler','system')),
    session_id TEXT,
    total_kb INTEGER NOT NULL,
    detail TEXT);
  CREATE INDEX memory_samples_at ON memory_samples (at);
  `,
  // 休眠（WS-M B）：记在 head 上。hibernated_at 非空表示进程被 Butler 结束了、等着 --resume；hibernate_reason 是当时在等什么
  // （you、ci、review、idle、pressure、memory）。pinned：用户钉住的不休眠、不降优先级，/clear 以后跟着新 head 走。
  // wake_error：上一次自动唤醒失败的原因和时间，下一次成功打开时清掉。
  `
  ALTER TABLE sessions ADD COLUMN hibernated_at INTEGER;
  ALTER TABLE sessions ADD COLUMN hibernate_reason TEXT;
  ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN wake_error TEXT;
  ALTER TABLE sessions ADD COLUMN wake_error_at INTEGER;
  `,
  // ws-b（设计文档 2026-11-17 ws-b）：PR 的 base、draft、标题、作者、label、reviewer、合并状态和状态最后变化的时间；
  // feature 汇总读 PR 状态的时间；send_message 的回复回流；对外动作的审计。
  `
  ALTER TABLE ticket_prs ADD COLUMN base_branch TEXT;
  ALTER TABLE ticket_prs ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ticket_prs ADD COLUMN title TEXT;
  ALTER TABLE ticket_prs ADD COLUMN author TEXT;
  ALTER TABLE ticket_prs ADD COLUMN labels TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE ticket_prs ADD COLUMN review_requests TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE ticket_prs ADD COLUMN reviewers TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE ticket_prs ADD COLUMN mergeable TEXT;
  ALTER TABLE ticket_prs ADD COLUMN merge_state TEXT;
  ALTER TABLE ticket_prs ADD COLUMN status_changed_at INTEGER;
  ALTER TABLE feature_handoffs ADD COLUMN pr_status_at INTEGER;
  CREATE TABLE butler_messages (
    id TEXT PRIMARY KEY,
    from_session TEXT NOT NULL,
    target_session TEXT,
    feature_id INTEGER,
    epic_id INTEGER,
    text TEXT NOT NULL,
    base_reply_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('sending', 'waiting', 'replied', 'delivered', 'failed', 'expired')),
    error TEXT,
    queued_at INTEGER NOT NULL,
    reply_id TEXT,
    reply_text TEXT,
    replied_at INTEGER,
    delivered_at INTEGER
  );
  CREATE INDEX idx_butler_messages_status ON butler_messages (status);
  CREATE TABLE external_action_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    repo_slug TEXT,
    ticket_key TEXT,
    target TEXT,
    summary TEXT NOT NULL,
    payload TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('done', 'failed', 'skipped')),
    error TEXT
  );
  CREATE INDEX idx_external_action_audit_ts ON external_action_audit (ts);
  `,
  // ws-h 度量（契约 4.7）：事件、等人时间段、每日汇总、基线 PR，以及 ticket_prs 的「Butler 做的」标记。
  `
  CREATE TABLE metrics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL,
    session_id TEXT,
    ticket_key TEXT,
    pr_id INTEGER,
    repo_slug TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    dedupe_key TEXT UNIQUE
  );
  CREATE INDEX idx_metrics_events_at ON metrics_events (at);
  CREATE INDEX idx_metrics_events_kind_at ON metrics_events (kind, at);
  CREATE TABLE metrics_wait_spans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    ticket_key TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'idle')),
    category TEXT,
    source TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX idx_metrics_wait_spans_open ON metrics_wait_spans (ended_at);
  CREATE INDEX idx_metrics_wait_spans_started ON metrics_wait_spans (started_at);
  CREATE TABLE metrics_daily (
    day TEXT NOT NULL,
    group_kind TEXT NOT NULL CHECK (group_kind IN ('all', 'repo', 'product', 'risk')),
    group_key TEXT NOT NULL,
    butler INTEGER NOT NULL,
    metric TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (day, group_kind, group_key, butler, metric)
  );
  CREATE TABLE metrics_baseline_prs (
    slug TEXT NOT NULL,
    number INTEGER NOT NULL,
    opened_at INTEGER NOT NULL,
    merged_at INTEGER NOT NULL,
    first_commit_at INTEGER,
    human_comments INTEGER NOT NULL DEFAULT 0,
    copilot_comments INTEGER NOT NULL DEFAULT 0,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (slug, number)
  );
  ALTER TABLE ticket_prs ADD COLUMN butler_made INTEGER;
  `,
  // 规矩质量与自动准入（工作流 D）：出处记下 reviewer、文件、行号和评论原文（只在本机，不导出）；
  // 规矩记下补填时间、分类理由、搁置说明、所属原则、确认时间；模型判断的缓存、初始化向导的运行 / 工作项 / 结论、原则表；
  // 校准样本分来源（人推翻流水线 / 校准页上判的）。
  `
  ALTER TABLE lesson_sources ADD COLUMN reviewer TEXT;
  ALTER TABLE lesson_sources ADD COLUMN path TEXT;
  ALTER TABLE lesson_sources ADD COLUMN line INTEGER;
  ALTER TABLE lesson_sources ADD COLUMN excerpt TEXT;
  CREATE TABLE lesson_principles (
    id INTEGER PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('repo','product')),
    repo_slug TEXT,
    product_id INTEGER REFERENCES lesson_products(id) ON DELETE CASCADE,
    text TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    batch_id INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL);
  ALTER TABLE lessons ADD COLUMN enriched_at INTEGER;
  ALTER TABLE lessons ADD COLUMN checkability_reason TEXT;
  ALTER TABLE lessons ADD COLUMN shelved_note TEXT;
  ALTER TABLE lessons ADD COLUMN principle_id INTEGER REFERENCES lesson_principles(id) ON DELETE SET NULL;
  ALTER TABLE lessons ADD COLUMN confirmed_at INTEGER;
  UPDATE lessons SET confirmed_at = updated_at WHERE status IN ('confirmed','disabled');
  CREATE TABLE lesson_judgments (
    kind TEXT NOT NULL, key TEXT NOT NULL, input_hash TEXT NOT NULL, result TEXT NOT NULL,
    model TEXT, degraded INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL,
    PRIMARY KEY (kind, key));
  CREATE TABLE lesson_wizard_runs (
    id INTEGER PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('repo','product','all')),
    repo_slug TEXT,
    product_id INTEGER REFERENCES lesson_products(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('scanning','extracting','generating','judging','awaiting_accept','accepted','cancelled','failed')),
    detail TEXT NOT NULL DEFAULT '{}',
    policy_version INTEGER,
    plan_batch INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL,
    accept_batch INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL,
    review_id INTEGER REFERENCES batch_reviews(id) ON DELETE SET NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
  CREATE TABLE lesson_wizard_items (
    run_id INTEGER NOT NULL REFERENCES lesson_wizard_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','skipped')),
    attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER, error TEXT,
    PRIMARY KEY (run_id, kind, key));
  CREATE TABLE lesson_wizard_verdicts (
    run_id INTEGER NOT NULL REFERENCES lesson_wizard_runs(id) ON DELETE CASCADE,
    lesson_id INTEGER NOT NULL,
    verdict TEXT NOT NULL CHECK (verdict IN ('admit','merged','shelved','covered','unfinished')),
    reason TEXT, ref INTEGER, score REAL,
    PRIMARY KEY (run_id, lesson_id));
  ALTER TABLE score_calibration ADD COLUMN source TEXT NOT NULL DEFAULT 'override' CHECK (source IN ('override','review'));
  `,
  // 工作流 L：通用后台队列（设计 2026-11-17-ws-l-cost-idle 第 3.6 节）。state：queued / running / done / failed / cancelled；
  // checkpoint 是任务自己存的 JSON（让路、重启后从这里接着跑）；dedupe_key 在排队和在跑的行里每种唯一。
  // session_usage.ticket_key：headless 调用归到哪个 ticket（成本熔断按 ticket 汇总）。
  // cost_caps：花费上限的三层覆盖（契约 4.2）；cost_breaker：每个 session（链的根 id）/ ticket 的熔断状态；cost_events：熔断的记录。
  `
  CREATE TABLE background_jobs (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed','cancelled')),
    checkpoint TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    ticket_key TEXT,
    dedupe_key TEXT,
    not_before INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    enqueued_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER);
  CREATE INDEX background_jobs_pick ON background_jobs (state, kind, priority DESC, id);
  CREATE UNIQUE INDEX background_jobs_dedupe ON background_jobs (kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');
  ALTER TABLE session_usage ADD COLUMN ticket_key TEXT;
  CREATE INDEX session_usage_ticket ON session_usage (ticket_key) WHERE ticket_key IS NOT NULL;
  CREATE TABLE cost_caps (
    id INTEGER PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','product','repo')),
    product_id INTEGER,
    repo_slug TEXT,
    overrides TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX cost_caps_scope ON cost_caps (scope_kind, COALESCE(product_id, 0), COALESCE(repo_slug, ''));
  CREATE TABLE cost_breaker (
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('session','ticket')),
    subject_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ok','warned','downgraded','paused')),
    cap REAL,
    raised_cap REAL,
    unit TEXT,
    spent REAL NOT NULL DEFAULT 0,
    scope TEXT,
    from_model TEXT,
    to_model TEXT,
    tripped_at INTEGER,
    paused_at INTEGER,
    stopped_at INTEGER,
    taken_over_at INTEGER,
    paused_spent REAL,
    partial INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (subject_kind, subject_id));
  CREATE TABLE cost_events (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    spent REAL,
    cap REAL,
    unit TEXT,
    detail TEXT);
  CREATE INDEX cost_events_subject ON cost_events (subject_kind, subject_id, at);
  `,
  // 工作流 I（设计补充 2026-11-17-ws-i）：评论闭环和 CI 分类。loop_policies 是三层策略（契约 4.2）；pr_comment_items 每个 (PR 行, 评论) 一行；
  // ci_triage 每个 (条目, head sha, run) 一行；ci_flaky_events 每次重跑后通过记一行；ci_flaky_list 是 flaky 名单（auto / manual）。
  `
  CREATE TABLE loop_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'product', 'repo')),
    product_id INTEGER,
    repo_slug TEXT,
    overrides TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX loop_policies_layer ON loop_policies (scope_kind, COALESCE(product_id, 0), COALESCE(repo_slug, ''));
  CREATE TABLE pr_comment_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id INTEGER NOT NULL,
    comment_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('inline', 'review', 'issue')),
    thread_id TEXT,
    database_id INTEGER,
    author TEXT NOT NULL,
    who TEXT NOT NULL,
    path TEXT,
    line INTEGER,
    body TEXT NOT NULL,
    url TEXT,
    commented_at INTEGER,
    seen_sha TEXT,
    first_seen INTEGER NOT NULL,
    category TEXT CHECK (category IN ('fix', 'question', 'ignore', 'human')),
    source TEXT CHECK (source IN ('rule', 'model', 'user')),
    reason TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'review', 'queued', 'delivered', 'addressed', 'ignored', 'dismissed', 'closed')),
    queued_at INTEGER,
    delivered_at INTEGER,
    delivered_sha TEXT,
    delivered_session TEXT,
    unchanged INTEGER NOT NULL DEFAULT 0,
    checked_sha TEXT,
    addressed_at INTEGER,
    addressed_sha TEXT,
    verified TEXT,
    replied_at INTEGER,
    resolved_at INTEGER,
    reply_error TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (pr_id, comment_key)
  );
  CREATE INDEX idx_pr_comment_items_state ON pr_comment_items (state);
  CREATE TABLE ci_triage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_kind TEXT NOT NULL CHECK (item_kind IN ('pr', 'branch')),
    item_id INTEGER NOT NULL,
    repo_slug TEXT,
    ticket_key TEXT,
    head_sha TEXT NOT NULL,
    run_id INTEGER NOT NULL,
    checks TEXT NOT NULL DEFAULT '[]',
    tests TEXT NOT NULL DEFAULT '[]',
    attempt INTEGER NOT NULL DEFAULT 1,
    category TEXT CHECK (category IN ('env', 'flaky', 'code')),
    source TEXT,
    reason TEXT,
    signature TEXT,
    prev_signature TEXT,
    reruns INTEGER NOT NULL DEFAULT 0,
    rerun_attempt INTEGER,
    state TEXT NOT NULL CHECK (state IN ('classifying', 'classified', 'rerunning', 'delivered', 'passed', 'abandoned')),
    outcome TEXT,
    first_failed_at INTEGER NOT NULL,
    rerun_at INTEGER,
    passed_at INTEGER,
    delivered_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE (item_kind, item_id, head_sha, run_id)
  );
  CREATE INDEX idx_ci_triage_item ON ci_triage (item_kind, item_id, id);
  CREATE TABLE ci_flaky_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_slug TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('check', 'test')),
    name TEXT NOT NULL,
    triage_id INTEGER,
    at INTEGER NOT NULL,
    wasted_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_ci_flaky_events_name ON ci_flaky_events (repo_slug, kind, name, at);
  CREATE TABLE ci_flaky_list (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_slug TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('check', 'test')),
    name TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
    added_at INTEGER NOT NULL,
    UNIQUE (repo_slug, kind, name)
  );
  `,
  // 仓库现状（工作流 E2）：每次扫描一行（只留最近 10 次）、标记文件表的用户层、存量扫描和它找到的违规、导出成 lint 的记录。
  `
  CREATE TABLE repo_baselines (
    id INTEGER PRIMARY KEY, repo_slug TEXT NOT NULL, scanned_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','partial','skipped','failed')), skip_reason TEXT, detail TEXT,
    origin TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','imported')),
    projects TEXT NOT NULL DEFAULT '[]', checks TEXT NOT NULL DEFAULT '[]', advice TEXT NOT NULL DEFAULT '[]', profile TEXT NOT NULL DEFAULT '{}',
    inputs TEXT NOT NULL DEFAULT '[]', listing_hash TEXT NOT NULL DEFAULT '', stale_at INTEGER,
    inferred TEXT NOT NULL DEFAULT 'none' CHECK (inferred IN ('none','ran','failed','skipped_off')), infer_detail TEXT,
    duration_ms INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX repo_baselines_slug ON repo_baselines (repo_slug, scanned_at);
  CREATE TABLE baseline_rules (
    id INTEGER PRIMARY KEY, key TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','product','repo')),
    product_id INTEGER REFERENCES lesson_products(id) ON DELETE CASCADE, repo_slug TEXT,
    rule TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX baseline_rules_layer ON baseline_rules (key, scope_kind, IFNULL(product_id, 0), IFNULL(repo_slug, ''));
  CREATE TABLE legacy_scans (
    id INTEGER PRIMARY KEY, check_id INTEGER REFERENCES checks(id) ON DELETE CASCADE, check_key TEXT NOT NULL, repo_slug TEXT NOT NULL,
    started_at INTEGER NOT NULL, finished_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('running','done','cancelled','failed','truncated')),
    files_total INTEGER NOT NULL DEFAULT 0, files_scanned INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, error TEXT);
  CREATE INDEX legacy_scans_key ON legacy_scans (check_key, repo_slug, started_at);
  CREATE TABLE legacy_violations (
    id INTEGER PRIMARY KEY, scan_id INTEGER NOT NULL REFERENCES legacy_scans(id) ON DELETE CASCADE, file TEXT NOT NULL, line INTEGER, snippet TEXT NOT NULL DEFAULT '');
  CREATE INDEX legacy_violations_scan ON legacy_violations (scan_id, id);
  CREATE TABLE check_exports (
    id INTEGER PRIMARY KEY, check_id INTEGER REFERENCES checks(id) ON DELETE SET NULL, check_key TEXT NOT NULL, repo_slug TEXT NOT NULL,
    target TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, worktree TEXT NOT NULL, files TEXT NOT NULL DEFAULT '[]', diff TEXT NOT NULL DEFAULT '',
    committed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('ready','pushed','pr_opened','discarded','failed')), detail TEXT, pr_url TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX check_exports_key ON check_exports (check_key, created_at);
  `,
  // 打断与通知（工作流 J）：每个仓库确认过的权限档案规则；session 自己做的选择和按默认答案自动答的选择（可复查）；
  // 用户设的默认答案；外部通知的发送记录（只记事件种类、数量和结果）。
  `
  CREATE TABLE permission_profiles (
    slug TEXT NOT NULL, rule TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('confirmed','dismissed','pending')),
    source TEXT NOT NULL CHECK (source IN ('history','import','manual')),
    runs INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0,
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (slug, rule));
  CREATE TABLE auto_choices (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('rule','default')),
    session_id TEXT, ticket_key TEXT, decision_id INTEGER, default_id INTEGER,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL, reviewed_at INTEGER);
  CREATE INDEX auto_choices_created ON auto_choices(created_at);
  CREATE TABLE choice_defaults (
    id INTEGER PRIMARY KEY,
    pattern TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL);
  CREATE TABLE notification_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL, event TEXT NOT NULL, count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('sent','failed','quiet','filtered')),
    host TEXT, payload TEXT, error TEXT);
  CREATE INDEX notification_log_ts ON notification_log(ts);
  `,
  // 工作流 K：栈式 PR（设计 2026-11-17-ws-k-stacks-design 第 2.1 节）。stacks：本地维护的栈；stack_layers：每层的分支、状态、
  // 上次同步时的起点（base_sha）和顶端（tip_sha）；stack_runs：每次整栈 rebase 的记录（detail 是 JSON：新旧顶端、备份引用、冲突）；
  // stack_policies：三层覆盖（契约 4.2）。
  `
  CREATE TABLE stacks (
    id INTEGER PRIMARY KEY,
    repo_path TEXT NOT NULL,
    repo_slug TEXT,
    trunk TEXT NOT NULL,
    remote TEXT NOT NULL DEFAULT 'origin',
    name TEXT NOT NULL,
    epic_id INTEGER,
    feature_id INTEGER,
    source TEXT NOT NULL CHECK (source IN ('mcp','ticket','detected')),
    merge_method TEXT CHECK (merge_method IN ('squash','merge')),
    trunk_sha TEXT,
    overview_number INTEGER,
    overview_url TEXT,
    overview_hash TEXT,
    last_daily_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    removed_at INTEGER);
  CREATE TABLE stack_layers (
    id INTEGER PRIMARY KEY,
    stack_id INTEGER NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    branch TEXT NOT NULL,
    ticket_key TEXT,
    ticket_repo_id INTEGER,
    mode TEXT NOT NULL DEFAULT 'branch' CHECK (mode IN ('branch','draft')),
    state TEXT NOT NULL DEFAULT 'branch_only' CHECK (state IN ('branch_only','draft','ready','merged')),
    pr_number INTEGER,
    pr_url TEXT,
    base_sha TEXT,
    tip_sha TEXT,
    remote_ok_sha TEXT,
    merged_head TEXT,
    draft_since INTEGER,
    merged_at INTEGER,
    last_rebase_at INTEGER,
    conflict_key TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (stack_id, branch));
  CREATE INDEX stack_layers_branch ON stack_layers (branch);
  CREATE TABLE stack_runs (
    id INTEGER PRIMARY KEY,
    stack_id INTEGER NOT NULL REFERENCES stacks(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    mode TEXT,
    outcome TEXT NOT NULL,
    reason TEXT,
    detail TEXT NOT NULL DEFAULT '{}',
    started_at INTEGER NOT NULL,
    finished_at INTEGER);
  CREATE INDEX stack_runs_stack ON stack_runs (stack_id, id);
  CREATE TABLE stack_policies (
    id INTEGER PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','product','repo')),
    product_id INTEGER,
    repo_slug TEXT,
    overrides TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX stack_policies_scope ON stack_policies (scope_kind, COALESCE(product_id, 0), COALESCE(repo_slug, ''));
  `,
  // 回测、影子模式自动升级、自动降级（工作流 F）：回测素材（合并 PR 的 diff、行内评论指向的提交、某个提交上的文件）、
  // 回测结果（按检查定义的哈希存，草稿和存下来的检查共用）、hook 记的绕过、检查的综合分、降级 / 待复审的原因、
  // 自动升降级的事件（Now 上的通知和撤回从这里来）、定期阈值复查的建议。
  `
  CREATE TABLE backtest_prs (
    repo_slug TEXT NOT NULL, pr_number INTEGER NOT NULL, merged_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending','ok','failed','too_large')), attempts INTEGER NOT NULL DEFAULT 0,
    diff TEXT, fetched_at INTEGER, comments_at INTEGER,
    PRIMARY KEY (repo_slug, pr_number));
  CREATE TABLE backtest_repos (
    repo_slug TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('ok','no_gh','failed')), attempts INTEGER NOT NULL DEFAULT 0,
    window TEXT NOT NULL DEFAULT '[]', fetched_at INTEGER NOT NULL, error TEXT);
  CREATE TABLE backtest_comments (
    repo_slug TEXT NOT NULL, pr_number INTEGER NOT NULL, comment_id INTEGER NOT NULL,
    author TEXT, path TEXT, line INTEGER, original_line INTEGER, original_commit TEXT, fetched_at INTEGER NOT NULL,
    PRIMARY KEY (repo_slug, pr_number, comment_id));
  CREATE TABLE backtest_files (
    repo_slug TEXT NOT NULL, sha TEXT NOT NULL, path TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','missing','too_large','binary','failed')), content TEXT, fetched_at INTEGER NOT NULL,
    PRIMARY KEY (repo_slug, sha, path));
  CREATE TABLE check_backtests (
    id INTEGER PRIMARY KEY, def_hash TEXT NOT NULL, sources_hash TEXT NOT NULL DEFAULT '', material_key TEXT NOT NULL DEFAULT '',
    lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL, check_key TEXT, repo_slug TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('done','skipped','failed')), skip_reason TEXT,
    prs INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, matched_hits INTEGER NOT NULL DEFAULT 0,
    judged INTEGER NOT NULL DEFAULT 0, judged_fp INTEGER NOT NULL DEFAULT 0, false_positives REAL NOT NULL DEFAULT 0, fp_rate REAL,
    comments INTEGER NOT NULL DEFAULT 0, comments_matched INTEGER NOT NULL DEFAULT 0, recall REAL,
    legacy INTEGER, legacy_scan_id INTEGER, samples TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
  CREATE INDEX check_backtests_def ON check_backtests (def_hash, repo_slug, created_at);
  CREATE INDEX check_backtests_key ON check_backtests (check_key, repo_slug, created_at);
  CREATE TABLE check_bypasses (
    id INTEGER PRIMARY KEY, check_id INTEGER REFERENCES checks(id) ON DELETE SET NULL, check_key TEXT NOT NULL, repo_slug TEXT,
    file TEXT NOT NULL DEFAULT '', line INTEGER,
    how TEXT NOT NULL CHECK (how IN ('suppress','no_verify','hooks_off','tamper')), detail TEXT NOT NULL DEFAULT '',
    session_id TEXT, at INTEGER NOT NULL, ingest_key TEXT NOT NULL UNIQUE);
  CREATE INDEX check_bypasses_check ON check_bypasses (check_id, at);
  CREATE INDEX check_bypasses_key ON check_bypasses (check_key, at);
  CREATE TABLE check_scores (
    check_id INTEGER PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
    score REAL, score_parts TEXT NOT NULL DEFAULT '{}', scored_at INTEGER NOT NULL, policy_version INTEGER);
  CREATE TABLE check_lifecycle (
    check_id INTEGER PRIMARY KEY REFERENCES checks(id) ON DELETE CASCADE,
    needs_review INTEGER NOT NULL DEFAULT 0, reason TEXT, reason_data TEXT NOT NULL DEFAULT '{}',
    last_action TEXT CHECK (last_action IS NULL OR last_action IN ('promote','demote','flag','cleared')),
    last_batch_id INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE check_lifecycle_events (
    id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('promote','demote','flag')),
    batch_id INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL,
    checks TEXT NOT NULL DEFAULT '[]', at INTEGER NOT NULL, dismissed_at INTEGER, undone_at INTEGER);
  CREATE INDEX check_lifecycle_events_at ON check_lifecycle_events (at);
  CREATE TABLE threshold_reviews (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, key TEXT NOT NULL, current REAL NOT NULL, suggested REAL NOT NULL,
    basis TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL CHECK (status IN ('open','applied','dismissed')),
    batch_id INTEGER REFERENCES admission_batches(id) ON DELETE SET NULL, decided_at INTEGER);
  CREATE INDEX threshold_reviews_status ON threshold_reviews (status, at);
  `,
  // 工作流 G（设计补充 2026-11-17-ws-g 第 2 节，契约 4.6）：预审、证据、就绪度、风险、简报、就绪和风险的三层策略、review 效果统计。
  // 证据和简报可能早于 PR（栈的上层只 push 分支），所以 pr_id 可空，另带 (repo_slug, branch, head_sha)；就绪和风险每个 PR 一行。
  `
  CREATE TABLE pre_reviews (
    id INTEGER PRIMARY KEY, ticket_key TEXT, session_id TEXT, repo_slug TEXT NOT NULL, cwd TEXT, branch TEXT NOT NULL, base TEXT,
    head_sha TEXT NOT NULL, pr_id INTEGER REFERENCES ticket_prs(id) ON DELETE SET NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('evidence','pr','manual')),
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','skipped')),
    job_id INTEGER, files TEXT NOT NULL DEFAULT '[]', lessons TEXT NOT NULL DEFAULT '[]', checks TEXT NOT NULL DEFAULT '{}',
    violations TEXT NOT NULL DEFAULT '[]', summary TEXT,
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('clean','violations','error')),
    detail TEXT, model TEXT, notes TEXT, delivered_at INTEGER, deliver_tries INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, finished_at INTEGER);
  CREATE INDEX pre_reviews_target ON pre_reviews (repo_slug, branch, head_sha);
  CREATE INDEX pre_reviews_pr ON pre_reviews (pr_id);
  CREATE INDEX pre_reviews_session ON pre_reviews (session_id, created_at);
  CREATE TABLE pr_evidence (
    id INTEGER PRIMARY KEY, pre_review_id INTEGER REFERENCES pre_reviews(id) ON DELETE CASCADE,
    pr_id INTEGER REFERENCES ticket_prs(id) ON DELETE SET NULL, ticket_key TEXT, session_id TEXT,
    repo_slug TEXT NOT NULL, branch TEXT NOT NULL, head_sha TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('check','acceptance','ui','not_run')),
    category TEXT CHECK (category IS NULL OR category IN ('test','lint','typecheck','build','other')),
    name TEXT NOT NULL DEFAULT '', command TEXT, claimed TEXT CHECK (claimed IS NULL OR claimed IN ('pass','fail')),
    summary TEXT NOT NULL DEFAULT '',
    verified TEXT NOT NULL DEFAULT 'pending' CHECK (verified IN ('pending','rerun_pass','rerun_fail','consistent','mismatch','unverifiable')),
    verify_detail TEXT, rerun_output TEXT, created_at INTEGER NOT NULL, verified_at INTEGER);
  CREATE INDEX pr_evidence_review ON pr_evidence (pre_review_id);
  CREATE INDEX pr_evidence_pr ON pr_evidence (pr_id);
  CREATE INDEX pr_evidence_target ON pr_evidence (repo_slug, branch, head_sha);
  CREATE TABLE pr_readiness (
    pr_id INTEGER PRIMARY KEY REFERENCES ticket_prs(id) ON DELETE CASCADE, head_sha TEXT,
    ready INTEGER NOT NULL, conditions TEXT NOT NULL DEFAULT '[]', missing TEXT NOT NULL DEFAULT '[]', computed_at INTEGER NOT NULL);
  CREATE TABLE pr_risk (
    pr_id INTEGER PRIMARY KEY REFERENCES ticket_prs(id) ON DELETE CASCADE, head_sha TEXT,
    level TEXT NOT NULL CHECK (level IN ('low','medium','high')), reasons TEXT NOT NULL DEFAULT '[]', inputs TEXT NOT NULL DEFAULT '{}',
    rules_version INTEGER NOT NULL, computed_at INTEGER NOT NULL);
  CREATE TABLE pr_briefs (
    id INTEGER PRIMARY KEY, pr_id INTEGER REFERENCES ticket_prs(id) ON DELETE SET NULL,
    pre_review_id INTEGER REFERENCES pre_reviews(id) ON DELETE SET NULL,
    repo_slug TEXT NOT NULL, branch TEXT NOT NULL, head_sha TEXT NOT NULL, markdown TEXT NOT NULL,
    summary_ok INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, posted_at INTEGER, posted_url TEXT, audit_id INTEGER);
  CREATE INDEX pr_briefs_pr ON pr_briefs (pr_id, created_at);
  CREATE INDEX pr_briefs_target ON pr_briefs (repo_slug, branch, created_at);
  CREATE TABLE pr_policies (
    id INTEGER PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','product','repo')),
    product_id INTEGER REFERENCES lesson_products(id) ON DELETE CASCADE,
    repo_slug TEXT,
    overrides TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    CHECK ((scope_kind = 'global' AND product_id IS NULL AND repo_slug IS NULL)
        OR (scope_kind = 'product' AND product_id IS NOT NULL AND repo_slug IS NULL)
        OR (scope_kind = 'repo' AND product_id IS NULL AND repo_slug IS NOT NULL)));
  CREATE UNIQUE INDEX pr_policies_layer ON pr_policies (scope_kind, COALESCE(product_id, 0), COALESCE(repo_slug, ''));
  CREATE TABLE review_effect_prs (
    pr_id INTEGER PRIMARY KEY REFERENCES ticket_prs(id) ON DELETE CASCADE, repo_slug TEXT NOT NULL, number INTEGER NOT NULL,
    butler INTEGER NOT NULL DEFAULT 0, opened_at INTEGER, merged_at INTEGER, files TEXT NOT NULL DEFAULT '[]',
    comments_human INTEGER NOT NULL DEFAULT 0, comments_copilot INTEGER NOT NULL DEFAULT 0, avoidable INTEGER NOT NULL DEFAULT 0,
    rounds INTEGER NOT NULL DEFAULT 0, first_review_ms INTEGER, submit_to_merge_ms INTEGER,
    brief_posted INTEGER NOT NULL DEFAULT 0, retro_done INTEGER NOT NULL DEFAULT 0, computed_at INTEGER NOT NULL);
  CREATE INDEX review_effect_prs_merged ON review_effect_prs (repo_slug, merged_at);
  CREATE TABLE review_effect_comments (
    id INTEGER PRIMARY KEY, pr_id INTEGER NOT NULL REFERENCES review_effect_prs(pr_id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL, lesson_id INTEGER, who TEXT NOT NULL CHECK (who IN ('human','copilot')), path TEXT,
    lesson_confirmed_before INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    UNIQUE (pr_id, source_id));
  CREATE INDEX review_effect_comments_lesson ON review_effect_comments (lesson_id);
  `,
  // 工作流 N（设计补充 2026-11-17-ws-n 第 7 节）：自动接活的接活项、用户改分类的记录（校准用）、接活策略的三层覆盖（契约 4.2）。
  // 开工前的风险是预估，存在 intake_items 里，不写 G 的 pr_risk。
  `
  CREATE TABLE intake_items (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    url TEXT,
    content_hash TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    repo_path TEXT,
    repo_slug TEXT,
    state TEXT NOT NULL CHECK (state IN ('needs_repo','needs_clarification','needs_decision','held','queued','waiting','started','split','skipped','exists','failed')),
    wait_reason TEXT,
    detail TEXT,
    classification TEXT NOT NULL DEFAULT '{}',
    user_dims TEXT NOT NULL DEFAULT '[]',
    tier TEXT,
    model TEXT,
    allow_parallel INTEGER NOT NULL DEFAULT 0,
    force_start INTEGER NOT NULL DEFAULT 0,
    parent_key TEXT,
    layer INTEGER,
    ticket_key TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    alerted_at INTEGER,
    first_seen_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER);
  CREATE INDEX intake_items_state ON intake_items (state, updated_at);
  CREATE INDEX intake_items_parent ON intake_items (parent_key) WHERE parent_key IS NOT NULL;
  CREATE TABLE intake_overrides (
    id INTEGER PRIMARY KEY,
    item_key TEXT NOT NULL,
    dim TEXT NOT NULL CHECK (dim IN ('size','risk','clarify')),
    from_value TEXT,
    to_value TEXT NOT NULL,
    rules_version INTEGER NOT NULL,
    class_source TEXT NOT NULL,
    at INTEGER NOT NULL);
  CREATE INDEX intake_overrides_at ON intake_overrides (at);
  CREATE TABLE intake_policies (
    id INTEGER PRIMARY KEY,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','product','repo')),
    product_id INTEGER,
    repo_slug TEXT,
    overrides TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX intake_policies_scope ON intake_policies (scope_kind, COALESCE(product_id, 0), COALESCE(repo_slug, ''));
  `,
  // 工作流 R：外部通知「推哪些事件」存过的人（工作流 J 加了这个设置，N 后来加了 intake_decision）也收到新事件。
  // 存的是空串表示一个都不要，不动；没存过的走默认值，也不动。
  `
  UPDATE settings SET value = value || ',intake_decision'
    WHERE key = 'notifyEvents' AND value <> '' AND (',' || value || ',') NOT LIKE '%,intake_decision,%';
  `,
  // 第 4 层对话另存（BTL-234）：只存双方说的话；按 replaced_by 链根存，换新、/clear 以后不变。
  // fork_id 不加外键（fork_discussions 是第 5 层建的表）；全文索引不进迁移，由 ConvRepo 探测 FTS5 后建。
  `
  CREATE TABLE conv_turns (
    id INTEGER PRIMARY KEY,
    root_session_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_key TEXT,
    fork_id INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('user','silent','handoff','fork','orphan')),
    started_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    ended_at INTEGER,
    asked INTEGER NOT NULL DEFAULT 0,
    mutated INTEGER NOT NULL DEFAULT 0,
    other_tools INTEGER NOT NULL DEFAULT 0,
    qa TEXT NOT NULL DEFAULT 'pending' CHECK (qa IN ('pending','yes','no')),
    qa_by TEXT CHECK (qa_by IN ('rule','judge','fork','judge_failed','old')));
  CREATE UNIQUE INDEX conv_turns_source ON conv_turns (root_session_id, source_key) WHERE source_key IS NOT NULL;
  CREATE INDEX conv_turns_pending ON conv_turns (ended_at) WHERE qa = 'pending';
  CREATE INDEX conv_turns_root ON conv_turns (root_session_id, qa, started_at);
  CREATE INDEX conv_turns_session ON conv_turns (session_id);
  CREATE TABLE conv_messages (
    id INTEGER PRIMARY KEY,
    turn_id INTEGER NOT NULL REFERENCES conv_turns(id) ON DELETE CASCADE,
    root_session_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    fork_id INTEGER,
    source_key TEXT);
  CREATE UNIQUE INDEX conv_messages_source ON conv_messages (root_session_id, source_key) WHERE source_key IS NOT NULL;
  CREATE INDEX conv_messages_root_at ON conv_messages (root_session_id, at, id);
  CREATE INDEX conv_messages_turn ON conv_messages (turn_id, at, id);
  CREATE INDEX conv_messages_fork ON conv_messages (fork_id, at, id) WHERE fork_id IS NOT NULL;
  CREATE INDEX conv_messages_session ON conv_messages (session_id);
  CREATE TABLE conv_cursors (
    session_id TEXT PRIMARY KEY,
    root_session_id TEXT NOT NULL,
    file TEXT NOT NULL,
    ino INTEGER NOT NULL,
    byte_offset INTEGER NOT NULL,
    open_turn_id INTEGER,
    updated_at INTEGER NOT NULL);
  `,
  // UI 重做第 1 层：CI 结论递给了谁、什么时候（判断「agent 在处理」还是「没人推进」）。
  `
  ALTER TABLE ticket_prs ADD COLUMN delivered_at INTEGER;
  ALTER TABLE ticket_prs ADD COLUMN delivered_to TEXT;
  `,
  // UI 重做第 1 层：别人请你 review 的 PR（gh search prs --review-requested=@me 的结果，整体替换）。
  `
  CREATE TABLE review_requests (
    url_key TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    slug TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  `,
  // UI 重做第 5 层：对话 tab 的「问一问」分叉讨论（一行一个分叉，费用逐轮累计）。
  `
  CREATE TABLE fork_discussions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_session_id TEXT NOT NULL,
    fork_session_id TEXT,
    mode TEXT NOT NULL CHECK (mode IN ('full','light')),
    cost_usd REAL,
    cost_partial INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    summary_sent_at INTEGER,
    ticket_key TEXT,
    feature_id INTEGER,
    cwd TEXT NOT NULL,
    launch_args TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','idle','failed')),
    error_code TEXT,
    error_reset_at INTEGER,
    conclusion TEXT,
    conclusion_at INTEGER,
    reask_of INTEGER REFERENCES fork_discussions(id)
  );
  CREATE INDEX fork_discussions_root ON fork_discussions(root_session_id, started_at);
  `,
  // UI 重做第 5 层：CLI 上次报的 total_cost_usd。续 session 时它是那个 session 的累计（--fork-session 时还带着被分叉 session 以前的花费），
  // 这一轮的费用按它取差。
  `
  ALTER TABLE fork_discussions ADD COLUMN cost_seen_total REAL;
  `,
  // UI 重做第 5 层：分叉的费用有一轮是约数（按份额从累计里拆、或按价格表估），界面显示成「约 $X」。
  // BTL-239 起完整分叉第一轮读得到开发 session 存下的累计时取 T1 − 它，是准数，不再标。
  `
  ALTER TABLE fork_discussions ADD COLUMN cost_approx INTEGER NOT NULL DEFAULT 0;
  `,  // BTL-245：每个 session 一个信箱。消息一律排队、存进库里，状态只有 queued / delivered / replied。
  // to_session 是排队那一刻的 head，送的时候按 head 链找最新的；ref 是来源键（report:12 之类），同一个 ref 同时只有一条在排队。
  // 旧的 butler_messages 留着不用。
  `
  CREATE TABLE session_messages (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('instruction','report','answer','butler','reply','review','comments','convention')),
    from_session TEXT,
    to_session TEXT NOT NULL,
    feature_id INTEGER,
    body TEXT NOT NULL,
    interrupt INTEGER NOT NULL DEFAULT 0,
    ref TEXT,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','replied')),
    via TEXT CHECK (via IN ('hook','input')),
    expects_reply INTEGER NOT NULL DEFAULT 0,
    base_reply_id TEXT,
    reply_text TEXT,
    queued_at INTEGER NOT NULL,
    delivered_at INTEGER,
    replied_at INTEGER
  );
  CREATE INDEX session_messages_status ON session_messages (status, to_session);
  CREATE INDEX session_messages_queued_at ON session_messages (queued_at);
  CREATE UNIQUE INDEX session_messages_queued_ref ON session_messages (ref) WHERE ref IS NOT NULL AND status = 'queued';
  `,
  // BTL-243：个人 LLM API、隐私档位和记忆蒸馏都拿掉了。清掉存下的 key、这几项设置、敏感词和 LLM 调用的审计（里面是发出去的原文），
  // 表留着不用。secrets 里的 webhook 地址和 auditRetentionDays（对外动作的审计也用它）不动。
  `
  DELETE FROM secrets WHERE name = 'llm_api_key';
  DELETE FROM settings WHERE key IN ('llmLevel', 'llmBaseUrl', 'llmModel', 'llmMonthlyBudgetUsd', 'llmPrices', 'llmConfirm');
  DELETE FROM sensitive_terms;
  DELETE FROM llm_audit;
  `,
  // BTL-246 层级 A′（docs/superpowers/specs/2026-11-20-btl-246-epic-hierarchy-design.md）：界面上的 epic 就是 features 这张表，
  // epic 里的 feature 是新的 blocks（名字、可选说明、顺序，没有总控和工作区）。features.jira_epic_key：从 Jira 接进来的 epic 按它去重。
  // epic_memory_archive：epic 记忆里挤不下的旧笔记（和旧 epic 记忆里搬过来的笔记），Butler 渲染进 epic 记忆的 handoff。
  // 旧 epic：它的 feature 各自成为独立的 epic，旧 epic 的规划追加进每个 feature 的 brief；旧 epic 行归档，工作区不删。
  // 旧 epic session 和 ticket 总控隐藏成历史；还等着送给旧 epic session 的汇报（epic 里 feature 总控发的）、它们自己的汇报不再送。
  // 旧 epic session 的提问也收掉（再也没有终端能收到回答）；ticket 总控的提问留着，它按普通 ticket session 恢复。
  // epic 里 ticket session 的汇报照常等着送给 feature 总控（现在的 epic 总控），inbox_items.epic_id 不作判断依据。
  `
  CREATE TABLE blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL REFERENCES features(id),
    name TEXT NOT NULL,
    description TEXT,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (feature_id, name)
  );
  CREATE INDEX idx_blocks_feature ON blocks (feature_id, position);
  ALTER TABLE tickets ADD COLUMN block_id INTEGER REFERENCES blocks(id);
  ALTER TABLE features ADD COLUMN jira_epic_key TEXT;
  CREATE UNIQUE INDEX idx_features_jira_epic ON features (jira_epic_key) WHERE jira_epic_key IS NOT NULL AND archived_at IS NULL;
  CREATE TABLE epic_memory_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL REFERENCES features(id),
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    noted_at INTEGER NOT NULL,
    archived_at INTEGER NOT NULL
  );
  CREATE INDEX idx_epic_memory_archive ON epic_memory_archive (feature_id, archived_at);
  UPDATE features SET brief =
    CASE WHEN brief IS NULL OR trim(brief) = '' THEN '' ELSE brief || char(10) || char(10) END
    || '[' || (SELECT name FROM epics WHERE epics.id = features.epic_id) || ']' || char(10)
    || (SELECT plan FROM epics WHERE epics.id = features.epic_id)
  WHERE epic_id IN (SELECT id FROM epics WHERE plan IS NOT NULL AND trim(plan) <> '');
  UPDATE epics SET archived_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE archived_at IS NULL;
  UPDATE sessions SET dismissed = 1, dismissed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE dismissed = 0 AND (epic_id IS NOT NULL OR (coordinator = 1 AND ticket_key IS NOT NULL));
  UPDATE inbox_items SET status = 'dismissed', resolved_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE kind = 'report' AND status = 'pending' AND session_id IN (
      SELECT id FROM sessions WHERE epic_id IS NOT NULL OR (coordinator = 1 AND ticket_key IS NOT NULL)
        OR (coordinator = 1 AND ticket_key IS NULL AND feature_id IN (SELECT id FROM features WHERE epic_id IS NOT NULL)));
  UPDATE inbox_items SET status = 'dismissed', resolved_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE kind = 'decision' AND status = 'pending' AND session_id IN (SELECT id FROM sessions WHERE epic_id IS NOT NULL);
  UPDATE sessions SET coordinator = 0 WHERE ticket_key IS NOT NULL AND coordinator = 1;
  `,
  // BTL-247：epic（表名仍是 features）自己选的自动化档位；NULL = 跟随全局（设置 automationLevel）。
  `
  ALTER TABLE features ADD COLUMN automation_level TEXT CHECK (automation_level IS NULL OR automation_level IN ('manual', 'semi'));
  `,
  // BTL-248：剩下的送达路径（CI 结论、合并通知、栈冲突、每日巡检、花费提醒、换新后的「接着做」、对话 tab 里用户的话）也走信箱，
  // kind 的 CHECK 放宽。SQLite 改不了 CHECK：建新表、拷数据、换名，索引重建。
  `
  CREATE TABLE session_messages_new (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('instruction','report','answer','butler','reply','review','comments','convention','ci','merge','stack','patrol','cost','refresh','user')),
    from_session TEXT,
    to_session TEXT NOT NULL,
    feature_id INTEGER,
    body TEXT NOT NULL,
    interrupt INTEGER NOT NULL DEFAULT 0,
    ref TEXT,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','replied')),
    via TEXT CHECK (via IN ('hook','input')),
    expects_reply INTEGER NOT NULL DEFAULT 0,
    base_reply_id TEXT,
    reply_text TEXT,
    queued_at INTEGER NOT NULL,
    delivered_at INTEGER,
    replied_at INTEGER
  );
  INSERT INTO session_messages_new SELECT id, kind, from_session, to_session, feature_id, body, interrupt, ref, meta, status, via,
    expects_reply, base_reply_id, reply_text, queued_at, delivered_at, replied_at FROM session_messages ORDER BY rowid;
  DROP TABLE session_messages;
  ALTER TABLE session_messages_new RENAME TO session_messages;
  CREATE INDEX session_messages_status ON session_messages (status, to_session);
  CREATE INDEX session_messages_queued_at ON session_messages (queued_at);
  CREATE UNIQUE INDEX session_messages_queued_ref ON session_messages (ref) WHERE ref IS NOT NULL AND status = 'queued';
  `,
  // BTL-248：features.brief_sent_at 是旧 epic 层交计划时记的，那条路 BTL-246 删了以后没人写也没人读。
  `
  ALTER TABLE features DROP COLUMN brief_sent_at;
  `,
  // BTL-256：用户点 × 结束的时间（不自动恢复，再打开时清掉）；终端开着的时间（Butler 运行时终端退出清掉，退出 Butler 时不清：
  // 下次启动时还带着的就是上次退出时开着的，「重启后自动恢复」用它）。
  `
  ALTER TABLE sessions ADD COLUMN user_ended_at INTEGER;
  ALTER TABLE sessions ADD COLUMN term_open_at INTEGER;
  `,
  // BTL-260：产品改名 Shipherd。上面已发布的迁移不能改，里面的 butler 列名、表名、取值都原样留着；这里把它们改成新名字。
  // - 普通列直接 RENAME COLUMN；butler_messages（BTL-245 起不用了，数据留着）改表名，索引重建。
  // - session_messages.kind、memory_samples.kind 的 CHECK 里有 'butler'：SQLite 改不了 CHECK，照 BTL-248 的做法建新表、拷数据（顺手把值改成 'shipherd'）、换名、重建索引。
  //   memory_samples.detail 里按进程类别记的 JSON 键 mcp_butler 也改成 mcp_shipherd。
  // - sessions.origin 的 CHECK 也是 ('butler','discovered')，但 sessions 表列多、被到处读，重建风险大：库里保留旧值，
  //   sessions-repo 读写时换成 "shipherd"（见 LEGACY_ORIGIN）。
  // - 设置键 butlerPatrolTime、任务名 butler_patrol 改名（没改的话巡检时间丢了、上次巡检时间也丢了）。
  // - 仓库现状里每条检查的 JSON 字段 butlerStage 改成 shipherdStage（不改的话「编辑时检查」全退成推送时）。
  `
  ALTER TABLE sessions RENAME COLUMN butler TO shipherd;
  ALTER TABLE metrics_daily RENAME COLUMN butler TO shipherd;
  ALTER TABLE ticket_prs RENAME COLUMN butler_made TO shipherd_made;
  ALTER TABLE review_effect_prs RENAME COLUMN butler TO shipherd;
  DROP INDEX idx_butler_messages_status;
  ALTER TABLE butler_messages RENAME TO shipherd_messages;
  CREATE INDEX idx_shipherd_messages_status ON shipherd_messages (status);
  CREATE TABLE session_messages_new (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('instruction','report','answer','shipherd','reply','review','comments','convention','ci','merge','stack','patrol','cost','refresh','user')),
    from_session TEXT,
    to_session TEXT NOT NULL,
    feature_id INTEGER,
    body TEXT NOT NULL,
    interrupt INTEGER NOT NULL DEFAULT 0,
    ref TEXT,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','replied')),
    via TEXT CHECK (via IN ('hook','input')),
    expects_reply INTEGER NOT NULL DEFAULT 0,
    base_reply_id TEXT,
    reply_text TEXT,
    queued_at INTEGER NOT NULL,
    delivered_at INTEGER,
    replied_at INTEGER
  );
  INSERT INTO session_messages_new SELECT id, CASE kind WHEN 'butler' THEN 'shipherd' ELSE kind END, from_session, to_session, feature_id, body,
    interrupt, ref, meta, status, via, expects_reply, base_reply_id, reply_text, queued_at, delivered_at, replied_at FROM session_messages ORDER BY rowid;
  DROP TABLE session_messages;
  ALTER TABLE session_messages_new RENAME TO session_messages;
  CREATE INDEX session_messages_status ON session_messages (status, to_session);
  CREATE INDEX session_messages_queued_at ON session_messages (queued_at);
  CREATE UNIQUE INDEX session_messages_queued_ref ON session_messages (ref) WHERE ref IS NOT NULL AND status = 'queued';
  CREATE TABLE memory_samples_new (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('session','shipherd','system')),
    session_id TEXT,
    total_kb INTEGER NOT NULL,
    detail TEXT);
  INSERT INTO memory_samples_new SELECT id, at, CASE kind WHEN 'butler' THEN 'shipherd' ELSE kind END, session_id, total_kb,
    replace(detail, '"mcp_butler"', '"mcp_shipherd"') FROM memory_samples ORDER BY id;
  DROP TABLE memory_samples;
  ALTER TABLE memory_samples_new RENAME TO memory_samples;
  CREATE INDEX memory_samples_at ON memory_samples (at);
  UPDATE settings SET key = 'shipherdPatrolTime' WHERE key = 'butlerPatrolTime' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'shipherdPatrolTime');
  DELETE FROM settings WHERE key = 'butlerPatrolTime';
  UPDATE jobs SET name = 'shipherd_patrol' WHERE name = 'butler_patrol' AND NOT EXISTS (SELECT 1 FROM jobs WHERE name = 'shipherd_patrol');
  DELETE FROM jobs WHERE name = 'butler_patrol';
  UPDATE repo_baselines SET checks = replace(checks, '"butlerStage"', '"shipherdStage"'), infer_detail = replace(infer_detail, '"butlerStage"', '"shipherdStage"')
    WHERE checks LIKE '%"butlerStage"%' OR infer_detail LIKE '%"butlerStage"%';
  `,
  // 58（BTL-261）：仓库改名。repo_renames 记下 GitHub 确认过的改名（old_slug 现在叫 new_slug），启动时把库里存的旧名字改写成新的。
  // ticket_prs 加三列：read_not_found 是读到「不存在」（404、仓库或 PR 解析不到）的次数，read_not_found_since 是这一串里第一次的时间，
  // read_gone_at 是认定 PR 不存在的时间：之后强制读也不读，隔 PR_GONE_RETRY_MS 才再试一次。最后删掉 handoff 里解析出来、不在 ticket 的仓库里、从没读成功过、而且已经失败到放弃的 PR 行：
  // 这些链接多半写错了（BTL-190 的 yuchenlin/butler/pull/25…29），新规则下也不会再收录。review_effect_prs 等子表随外键级联删除。
  `
  CREATE TABLE repo_renames (
    old_slug TEXT PRIMARY KEY,
    new_slug TEXT NOT NULL,
    source TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    applied_at INTEGER);
  ALTER TABLE ticket_prs ADD COLUMN read_not_found INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE ticket_prs ADD COLUMN read_not_found_since INTEGER;
  ALTER TABLE ticket_prs ADD COLUMN read_gone_at INTEGER;
  DELETE FROM ticket_prs WHERE source = 'handoff' AND repo_id IS NULL AND checked_at = 0 AND read_failures >= 10 AND read_retry_at IS NOT NULL;
  `,
  // 59（BTL-265）：刷新时每次都要的查询加索引（外面开的 session 有几千个，以前要整表扫）：
  // 休眠着的 head（listHibernated）、feature 直属的 session（listByFeature）、ticket 的分支 CI（BranchWatchRepo.byTicket），
  // 链往回走（rootsOf 的递归每一步按 replaced_by 找上一个，以前每一步都整表扫）。
  // sessions_feature 带上 ticket_key：只有 feature_id 一列时，没跑过 ANALYZE 的库里 listByFeatures（feature_id IN json_each AND ticket_key IS NULL）
  // 会选 sessions_ticket，把所有没 ticket 的 session 扫一遍；两列都是等值，任何统计下都选它。
  `
  CREATE INDEX sessions_replaced_by ON sessions(replaced_by) WHERE replaced_by IS NOT NULL;
  CREATE INDEX sessions_hibernated ON sessions(hibernated_at) WHERE hibernated_at IS NOT NULL;
  CREATE INDEX sessions_feature ON sessions(feature_id, ticket_key) WHERE feature_id IS NOT NULL;
  CREATE INDEX branch_watch_ticket ON branch_watch(ticket_key);
  `,
  // 60（BTL-274）：合并相似规矩的建议。lesson_ids 是 JSON 数组；input_hash 是提建议时这些规矩（id、正文、原因、范围）的指纹：
  // 接受时规矩改过就作废（stale），拒绝过的同一组同一指纹不再提。status：pending / accepted / dismissed / stale。batch_id 是接受时的批次。
  `
  CREATE TABLE lesson_merge_proposals (
    id INTEGER PRIMARY KEY,
    scope_kind TEXT NOT NULL,
    repo_slug TEXT,
    product_id INTEGER,
    lesson_ids TEXT NOT NULL,
    text TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    batch_id INTEGER);
  CREATE INDEX lesson_merge_proposals_status ON lesson_merge_proposals(status);
  `,
  // 61（BTL-271）：预审看得见。started_at 是这一次真正开跑的时间（界面显示「预审中 3 分钟」；放回队列时清空）。
  // 按 ticket 看每个（仓库, 分支）最近一次预审（徽标、总控的 list_tickets）要按 ticket 找，加索引。
  // 预审并发数新装默认 2；已经在用的（有 ticket 或做完了引导）留在以前的 1 个，不悄悄翻倍花额度。
  `
  ALTER TABLE pre_reviews ADD COLUMN started_at INTEGER;
  CREATE INDEX pre_reviews_ticket ON pre_reviews (ticket_key, repo_slug, branch);
  INSERT OR IGNORE INTO settings (key, value)
    SELECT 'preReviewConcurrency', '1'
    WHERE EXISTS (SELECT 1 FROM tickets) OR EXISTS (SELECT 1 FROM settings WHERE key = 'onboardingDone' AND value = '1');
  `,
  // 62（BTL-269）：排着的消息为什么还没送到。blocked_reason 是上一次试着送时挡住它的原因（MailboxBlockReason），blocked_since 是这个原因开始的时间，
  // 原因变了才换；stuck_receipt_at 是给发件的总控发「还没送到」回执的时间：重启以后不重发。
  // inbox_items 的 behalf_by 是替用户回答这个提问的总控（名字；用户自己答的为 null），behalf_seen_at 是用户在「总控已代答」提醒上点了知道了、
  // 或者改了答案的时间：之前一直显示那条提醒。
  `
  ALTER TABLE session_messages ADD COLUMN blocked_reason TEXT;
  ALTER TABLE session_messages ADD COLUMN blocked_since INTEGER;
  ALTER TABLE session_messages ADD COLUMN stuck_receipt_at INTEGER;
  ALTER TABLE inbox_items ADD COLUMN behalf_by TEXT;
  ALTER TABLE inbox_items ADD COLUMN behalf_seen_at INTEGER;
  `,
  // 63（BTL-270）：ticket 关闭。tickets 的 status / status_manual 加两个值：closed（不做了，手动的终态，和 done 做完了分开）、
  // needs_decision（PR 都关了没合、也没有开着的：等人决定是重开、另开还是关掉）。SQLite 改不了 CHECK，只能重建 tickets 表：
  // 别的表的外键指着它，DROP 要在外键关着时做（下面的标记让 migrate 在事务外关掉外键，提交前查有没有新的违规，之后再开）。
  // 列按原来的顺序抄过来（ALTER ADD COLUMN 加过的四列在最后），新加 closed_at / closed_reason / closed_source：谁、为什么关的。
  // followups 加五列：resolved_reason / resolved_source 是总控或用户处理（完成、忽略）时写的原因和来源；
  // ignored_by_close 标记是关 ticket 时顺手忽略的，prior_status / prior_snoozed_until 记忽略前的状态，重新打开时按它们还原。
  // ticket_prs 加 shipherd_closed_at：Shipherd 自己关掉的 PR（栈的一层退回普通分支时关掉的 draft），不算「PR 都关了没合」。
  `
  -- shipherd:foreign-keys-off
  CREATE TABLE tickets_new (
    key TEXT PRIMARY KEY,
    title TEXT,
    repo_path TEXT NOT NULL,
    work_mode TEXT NOT NULL CHECK (work_mode IN ('worktree', 'branch')),
    worktree_path TEXT,
    branch TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'in_review', 'blocked', 'merged_pending_followup', 'done', 'needs_decision', 'closed')),
    status_manual TEXT
      CHECK (status_manual IS NULL OR status_manual IN ('active', 'in_review', 'blocked', 'merged_pending_followup', 'done', 'needs_decision', 'closed')),
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    status_changed_at INTEGER,
    status_manual_at INTEGER,
    feature_id INTEGER REFERENCES features(id),
    block_id INTEGER REFERENCES blocks(id),
    closed_at INTEGER,
    closed_reason TEXT,
    closed_source TEXT CHECK (closed_source IS NULL OR closed_source IN ('user', 'coordinator', 'routing'))
  );
  INSERT INTO tickets_new (key, title, repo_path, work_mode, worktree_path, branch, status, status_manual, created_at, archived_at, status_changed_at, status_manual_at, feature_id, block_id)
    SELECT key, title, repo_path, work_mode, worktree_path, branch, status, status_manual, created_at, archived_at, status_changed_at, status_manual_at, feature_id, block_id FROM tickets;
  DROP TABLE tickets;
  ALTER TABLE tickets_new RENAME TO tickets;
  ALTER TABLE followups ADD COLUMN resolved_reason TEXT;
  ALTER TABLE followups ADD COLUMN resolved_source TEXT;
  ALTER TABLE followups ADD COLUMN ignored_by_close INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE followups ADD COLUMN prior_status TEXT;
  ALTER TABLE followups ADD COLUMN prior_snoozed_until TEXT;
  ALTER TABLE ticket_prs ADD COLUMN shipherd_closed_at INTEGER;
  `,
  // BTL-279（4.3.0 里排在最后，rebase 时挪到数组末尾）：每条消息试着送了几次（attempts），最后一次的时间（last_attempt_at）和结果（last_attempt：
  // 挡住它的原因 MailboxBlockReason，或者直接输入的结果 recheck / exited）。只在排队时记，送到后留着：诊断导出和消息列表看得出卡在哪、试了多久。
  // 只加列，用 addColumns 写（4.3.0 复核）：分支版本把它排在第 63 个跑过的库，这几列已经在、BTL-270 却没跑过，起不来并说清楚原因。
  addColumns("session_messages", [
    "attempts INTEGER NOT NULL DEFAULT 0",
    "last_attempt_at INTEGER",
    "last_attempt TEXT",
  ]),
  // 65（BTL-272）：信息流转。每轮对话结束后抽要点：infoflow_turns 记每一轮处理过没有（不论结果，处理过就不再抽；
  // retry 是执行出错、过一会儿再试，attempts 记试了几次；capped 是今天问模型的次数到上限了、等着，老化了记 skipped / capped）；
  // infoflow_items 是抽出来的要点（来源 session 和轮、写进哪一级记忆；area 是去重比较的范围，routable 为 0 只记不发，
  // note 是写进记忆的那一整条（带来源注记，撤销时只忘这一条），change_raw 是模型给的状态变化，followed_at 是记完、发完的时间：为空的重启后接着做）；infoflow_deliveries 是发给了谁（信箱消息 id）；
  // infoflow_actions 是要同步到 Shipherd 的状态变化（自动执行的、等确认的，撤销用的旧状态）；infoflow_asks 是每次问模型的时间（每天的上限按它数）。
  // 信箱加一种消息 fact（从对话里抽出来的要点），重建 session_messages 换掉 kind 的 CHECK（BTL-269 加的 blocked_reason / blocked_since / stuck_receipt_at、BTL-279 加的 attempts / last_attempt_at / last_attempt 照搬，INSERT 写明列名）。conv_turns 按结束时间加索引（找刚结束的轮）。
  `
  CREATE TABLE infoflow_turns (
    turn_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('skipped','done','failed','retry','capped')),
    reason TEXT,
    items INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL);
  CREATE INDEX infoflow_turns_at ON infoflow_turns (at);
  CREATE TABLE infoflow_asks (id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
  CREATE INDEX infoflow_asks_at ON infoflow_asks (at);
  CREATE TABLE infoflow_items (
    id INTEGER PRIMARY KEY,
    turn_id INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    root_session_id TEXT NOT NULL,
    feature_id INTEGER,
    target_features TEXT NOT NULL DEFAULT '[]',
    text TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('decision','convention','constraint','state_change','fyi')),
    speaker TEXT NOT NULL CHECK (speaker IN ('user','agent')),
    quote TEXT NOT NULL DEFAULT '',
    targets TEXT NOT NULL,
    importance TEXT NOT NULL CHECK (importance IN ('high','normal','low')),
    confidence REAL NOT NULL,
    scope TEXT,
    memory TEXT NOT NULL CHECK (memory IN ('written','dup','full','failed','skipped','disabled','pending','held','dropped','retracted')),
    dup_of TEXT,
    note TEXT,
    area TEXT NOT NULL DEFAULT 'workspace',
    routable INTEGER NOT NULL DEFAULT 1,
    change_raw TEXT,
    followed_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (turn_id, idx));
  CREATE INDEX infoflow_items_created ON infoflow_items (created_at);
  CREATE INDEX infoflow_items_unfollowed ON infoflow_items (created_at) WHERE followed_at IS NULL;
  CREATE INDEX infoflow_items_feature ON infoflow_items (feature_id, created_at);
  CREATE TABLE infoflow_deliveries (
    item_id INTEGER NOT NULL REFERENCES infoflow_items(id) ON DELETE CASCADE,
    to_session TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, to_session));
  CREATE TABLE infoflow_actions (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL UNIQUE REFERENCES infoflow_items(id) ON DELETE CASCADE,
    change TEXT NOT NULL,
    signature TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('auto','confirm')),
    state TEXT NOT NULL CHECK (state IN ('pending','applied','partial','already','rejected','undone','failed','stale')),
    undo TEXT,
    error TEXT,
    leftovers TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    dismissed_at INTEGER);
  CREATE INDEX infoflow_actions_signature ON infoflow_actions (signature, created_at);
  CREATE INDEX infoflow_actions_state ON infoflow_actions (state);
  CREATE INDEX conv_turns_ended ON conv_turns (ended_at) WHERE ended_at IS NOT NULL;
  CREATE TABLE session_messages_new (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('instruction','report','answer','shipherd','reply','review','comments','convention','ci','merge','stack','patrol','cost','refresh','user','fact')),
    from_session TEXT,
    to_session TEXT NOT NULL,
    feature_id INTEGER,
    body TEXT NOT NULL,
    interrupt INTEGER NOT NULL DEFAULT 0,
    ref TEXT,
    meta TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','replied')),
    via TEXT CHECK (via IN ('hook','input')),
    expects_reply INTEGER NOT NULL DEFAULT 0,
    base_reply_id TEXT,
    reply_text TEXT,
    queued_at INTEGER NOT NULL,
    delivered_at INTEGER,
    replied_at INTEGER,
    blocked_reason TEXT,
    blocked_since INTEGER,
    stuck_receipt_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,
    last_attempt TEXT
  );
  INSERT INTO session_messages_new (id, kind, from_session, to_session, feature_id, body, interrupt, ref, meta, status, via,
    expects_reply, base_reply_id, reply_text, queued_at, delivered_at, replied_at, blocked_reason, blocked_since, stuck_receipt_at,
    attempts, last_attempt_at, last_attempt)
    SELECT id, kind, from_session, to_session, feature_id, body, interrupt, ref, meta, status, via,
    expects_reply, base_reply_id, reply_text, queued_at, delivered_at, replied_at, blocked_reason, blocked_since, stuck_receipt_at,
    attempts, last_attempt_at, last_attempt FROM session_messages ORDER BY rowid;
  DROP TABLE session_messages;
  ALTER TABLE session_messages_new RENAME TO session_messages;
  CREATE INDEX session_messages_status ON session_messages (status, to_session);
  CREATE INDEX session_messages_queued_at ON session_messages (queued_at);
  CREATE UNIQUE INDEX session_messages_queued_ref ON session_messages (ref) WHERE ref IS NOT NULL AND status = 'queued';
  `,
];

