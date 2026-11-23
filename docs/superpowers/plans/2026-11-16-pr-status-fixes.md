# PR Status Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track PR progress per PR instead of per ticket repo, and fix every C-*, D-* and L item from the 2026-11-16 audit. This lets a ticket with sequential PRs, PRs on other branches, or PRs that merged long ago show correct rows, counts and status.

**Architecture:** A new `ticket_prs` table holds every PR linked to a ticket (from its branch, handoffs, the merge gate or the backfill), with the live watch state that `pr_watch` held. A small `branch_watch` table keeps branch-only CI while a repo has no open PR. `pr_watch` is migrated into both tables and dropped.

The watcher polls open PRs by URL and re-checks ticket branches with `gh pr list --head`. Stage events carry `pr_id`. Repo-level events (skills, first commits, reports) are assigned to a PR by a pure window function, and the renderer shows one row per PR.

**Tech Stack:** Electron, TypeScript, `node:sqlite` (`DatabaseSync`), vitest, Playwright (Electron), React, zod, the gh CLI, git, and Claude Code hooks (Node SEA binary).

**Spec:** `docs/superpowers/specs/2026-11-16-pr-status-fixes-design.md`

## Global Constraints

- Every commit message ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (after a blank line).
- Implementers do not push. Commit on `fix/pr-status` only.
- Migrations are append-only entries in `src/main/db/migrations.ts`; entry `i` sets `user_version = i + 1`. Today there are 21 entries. This plan adds entry 22 (Task 1) and entry 23 (Task 4).
- The user's real DB is at `user_version` 20 (app 1.9.0). Every migration must run cleanly from 20 straight to the latest.
- gh and git calls never throw to callers. On failure they return `null` and the failure is logged (existing convention in `src/main/tickets/gh.ts`).
- Main-process work never blocks startup. The backfill runs in the background.
- The UI has two string tables: every new string goes in both `src/renderer/src/strings.ts` (zh) and `src/renderer/src/strings-en.ts` (en). Main-process strings go in `src/main/strings*.ts`.
- Light-theme stage text must reach a contrast ratio of at least 4.5:1. The dark theme is unchanged (D-14).
- Commands:
  - single test: `pnpm vitest run <path>`
  - all tests: `pnpm test`
  - types: `pnpm typecheck`
  - lint: `pnpm exec eslint src e2e hook`
  - e2e: `pnpm e2e` (pree2e builds the app and the hook) or `pnpm e2e:only <spec>` after a build.
- Out of scope: non-Shipherd terminals; exporting lessons to repos.

## Review Focus

These are the five cases most likely to break for a real user that the spec does not cover directly. Each has a pinned test in the task named.

1. **Upgrade straight from user_version 20.** A `pr_watch` row with `number` null and `ci` unknown (the old neverRead latch) and a merged row with no `merged` event must become one `branch_watch` row and one `ticket_prs` row. The merged row needs `checked_at` 0 so it is read once for its real mergedAt, and `merged_handled_at` set so lessons are not re-queued. Test in Task 4: `migration 23 from a v20 database`.
2. **One PR linked to two tickets.** A coordinator handoff of BTL-190 lists a PR that another ticket's branch also found. It must be polled once per round, and both rows must be updated. Events must not dedupe across tickets, and each ticket gets its own CI delivery. Test in Task 4: `polls a URL shared by two tickets once and updates both rows`.
3. **Backfill interrupted, offline or rate-limited.** gh fails for some repos. The job must not be recorded as done, it must retry on the next start, it must never duplicate rows or events, and startup must not wait for it. Test in Task 7: `records failed and links nothing twice when gh fails for one repo`.
4. **Enterprise GitHub hosts.** For a URL like `https://ghe.acme.io/team/app/pull/3`:
   - the slug must be `ghe.acme.io/team/app`;
   - `gh api` calls must target that host;
   - the PR link must open, while `https://github.com@evil.com/...` and lookalike hosts are refused.

   Tests in Tasks 1, 2 and 12.
5. **Empty-URL handoff PRs in a multi-repo ticket.** `#3` with `url: ""` beside `https://github.com/a/x/pull/3` must collapse into the URL entry (C-V9). An empty-URL `#5` in a two-repo ticket must never be linked to a guessed repo. Tests in Task 5: `dedupes an empty-URL entry into the URL entry with the same number` and `does not link an empty-URL PR in a multi-repo ticket`.

## Spec deviations and decisions the spec left open

Each item is restated in the owning task.

- **The fake gh does not exist (spec and task brief both assume one).** `e2e/` only has `fake-claude`, and the sandbox PATH is `[bin, /usr/bin, /bin]`, so gh is simply missing in e2e. Task 19 creates `e2e/fake-gh/fake-gh.cjs`. It is installed only for sandboxes that ask for it. On Windows, `resolveGh` only accepts `gh.exe`, so the new PR e2e tests skip on win32.
- **The spec's L wording on `ghBinary()` describes the current bug, not a change.** `applyGhResolution` already falls back to `"gh"` on macOS/Linux, so `ghBinary() !== null` is always true there and `no_gh` never shows. Task 14 adds a real availability check, `ghAvailable()`.
- **PR events are scoped by `pr_id`, not only by PR number (spec item 5).** The number is ambiguous across repos and across tickets that share a PR. Events keep `data.number`, and the assignment order is `pr_id` → number → branch → window.
- **Two migrations instead of one.** Entry 22 only creates the new tables (Task 1). Entry 23 copies `pr_watch` and drops it, landing with the watcher switch (Task 4), so the app works between tasks. A real user runs both in one go.
- **"Watcher: any PR it observes" is not a fifth link source.** The watcher only observes PRs through the branch (`source = 'branch'`) or already-linked rows. The `source` CHECK keeps the spec's four values.
- **Status (C-V8), read precisely:**
  - an open own-or-linked PR → `in_review`;
  - the model says `active` → `active`, even if PRs are merged (this is what lets sequential PRs "return to active");
  - the model says `in_review` and the PRs it reported itself are all merged → done/mpf;
  - merges known only from memory or from linked rows never override the model.

  The existing tests "merged PR with open followups" and "in_review + all merged" use the `h()` default status `active`. They are updated to `in_review`. Separately, the watcher's refresh promotes a ticket to `done` when a PR merged after the base handoff was written and none is open (Task 6). Otherwise a model `active` written before the PR existed would stick forever.
- **`rederiveTicketStatus` cannot tell own PRs from remembered ones after storage.** It now only moves between done and mpf when the current automatic status is one of them. Otherwise it derives with every stored PR treated as remembered (Task 6).
- **Codex keeps the internal reviewer kind `"copilot"` (C-S1).** Stored events already use `who: "copilot"` for Copilot. The UI label becomes "AI review", and the timeline kind name `copilot_review` stays.
- **The feature table shows one row per ticket, not per PR** (not specified). That row shows the newest PR's stages and a PR count, and the ticket tab shows every PR. The epic bar counts tickets with the D-6 rule.
- **`onMerged` fires only for merges seen within 24 h of linking** (C-S5 plus the backfill). Rows linked by the backfill or by an old handoff whose merge is older than `linked_at - 24h` are marked handled without queuing a lessons analysis. Lessons has its own "analyse history" button, and re-analysing every historical PR would cost one headless run each.
- **Slug-only PRs (repo not in the ticket):** `onMerged` uses the lessons repo row for that slug if one exists, and skips otherwise. CI is not delivered for them because no session owns that repo.
- **Discovered sessions (C-S6)** get only `UserPromptSubmit /skill` events. Global hooks don't include PostToolUse, and installing a global PostToolUse hook into the user's `~/.claude/settings.json` is not something this fix should do.
- **D-1 tracking window.** `skillTrackingSince` is seeded once, with the earliest stored skill event or else the first time the current hook is seen. Tracking is judged by the PR's dev start time. A later uninstall of the hook is not modelled (open risk).
- **D-12 also corrects the 2026-11-15 design doc.** The F2 behaviour (a fix push after failed CI resets an approval) contradicts F1 (an approval survives a re-push). Both now follow GitHub: an approval stands until it is dismissed or superseded. Task 11 updates `pr-stages.test.ts` (the "approval after failed CI…" case), the `pr-stages.ts` header comment, and the peer-review row in `docs/superpowers/specs/2026-11-15-pr-stages-and-review-lessons-design.md` (line 60).
- **fixRange (L).** The spec allows either fallback. The plan skips the fixes section explicitly, with a one-line note in the material, because `PrLessonData` has no base sha for a "full diff" fallback.

## Data model (settled here; Tasks 1 and 4 implement it)

```sql
-- migration 22
CREATE TABLE ticket_prs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_key TEXT NOT NULL REFERENCES tickets(key),
  url TEXT NOT NULL,                 -- prUrlKey(): trimmed, no trailing '/', lower case
  slug TEXT NOT NULL,                -- 'owner/repo' on github.com, 'host/owner/repo' elsewhere (parseRemoteSlug form)
  repo_id INTEGER REFERENCES ticket_repos(id) ON DELETE SET NULL,  -- the ticket repo whose slug matches; null = not one of the ticket's repos
  number INTEGER NOT NULL,
  head_branch TEXT,
  state TEXT NOT NULL CHECK (state IN ('open','merged','closed')),
  review TEXT,                       -- pending | changes_requested | approved | null
  ci TEXT NOT NULL DEFAULT 'unknown',-- pending | passing | failing | none | unknown (unknown = never read successfully)
  read_error INTEGER NOT NULL DEFAULT 0,  -- 1 = the last gh read failed; ci/state are the previous values (C-V7)
  head_sha TEXT,
  failed TEXT NOT NULL DEFAULT '[]', -- CiCheck[] with log tails
  opened_at INTEGER, merged_at INTEGER, closed_at INTEGER,          -- GitHub times (ms); merged_at may come from merge_holds.released_at
  source TEXT NOT NULL CHECK (source IN ('branch','handoff','merge_gate','backfill')),
  linked_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0,  -- 0 = never read
  delivered_key TEXT,                -- CiDelivery: `${headSha}:${ci}` last handed to the session
  merged_handled_at INTEGER,         -- onMerged done (C-S5); null + state merged = retry next round
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
```

How each consumer keeps working:

- **CI delivery:**
  - PR rows deliver `${headSha}:${ci}` through `ticket_prs.delivered_key`; branch-only CI uses `branch_watch.delivered_key`.
  - Delivery goes to the ticket repo's non-coordinator session only when `repo_id` is set and `head_branch` equals the repo's current branch (C-S3).
- **Review comments:** these are fetched per PR. `reviewComments` and `reviewAuthors` get the PR's slug, so they work from any cwd and for enterprise hosts.
- **prHandoff refresh:**
  - It runs over `ticketPrs.byTicket(key)` and is ingested as today.
  - New: it carries a status. Handoff ingest links PR URLs back into `ticket_prs`.
- **Merge gate:**
  - `cachedByUrl(url)` reads `ticket_prs` by `prUrlKey`. It only returns rows with `read_error = 0` that were checked in the last 60 s.
  - PR holds are linked as `merge_gate`, and `released_at` is a fallback merge time.
- **Lessons `onMerged`:** it fires per PR row. `merged_handled_at` is set only after it returns, so it is retried each round.
- **Status:** `deriveStatus` gets the linked rows' open state.
- **Event dedupe keys:**
  - They keep today's formats with `scope = repoId` (or `${ticketKey}@${slug}` for slug-only PRs) and `branch = head_branch`, so migrated events are not duplicated.
  - `first_commit` for a later round gets the suffix `:after:${lastPrId}`.

---

## Task 1: New tables, repos and PR URL helpers

**Files:**
- Modify: `src/main/db/migrations.ts` (append entry 22, the SQL above)
- Create: `src/shared/pr-url.ts`, `src/shared/pr-url.test.ts`
- Create: `src/main/db/ticket-prs-repo.ts`, `src/main/db/ticket-prs-repo.test.ts`
- Create: `src/main/db/branch-watch-repo.ts`, `src/main/db/branch-watch-repo.test.ts`
- Modify: `src/main/db/pr-stage-repo.ts`, `src/main/db/pr-stage-repo.test.ts`
- Modify: `src/shared/pr-memory.ts`, `src/main/prwatch/pr-handoff.ts` (use `prUrlKey`, no behaviour change)

**Interfaces:**
- Produces:
  - `prUrlKey(url: string): string`: trim, strip trailing `/`, lower-case. It is the same rule `pr-memory.ts` and `pr-handoff.ts` use today.
  - `prUrlParts(url: string): { host: string; slug: string; number: number } | null`. It parses `https://<host>/<owner>/<repo>/pull/<n>[/...]`. On github.com the slug is `owner/repo`; elsewhere it is `host/owner/repo`, all lower-case.
  - `type PrLinkSource = "branch" | "handoff" | "merge_gate" | "backfill"`
  - `interface TicketPr { id: number; ticketKey: string; url: string; slug: string; repoId: number | null; number: number; headBranch: string | null; state: "open" | "merged" | "closed"; review: WatchedPr["review"]; ci: WatchedPr["ci"]; readError: boolean; headSha: string | null; failed: CiCheck[]; openedAt: number | null; mergedAt: number | null; closedAt: number | null; source: PrLinkSource; linkedAt: number; checkedAt: number; deliveredKey: string | null; mergedHandledAt: number | null }`
  - `interface NewPrLink { ticketKey: string; url: string; slug: string; repoId: number | null; number: number; headBranch: string | null; state: TicketPr["state"]; openedAt?: number | null; mergedAt?: number | null; closedAt?: number | null; source: PrLinkSource; linkedAt: number; mergedHandledAt?: number | null }`
  - `type TicketPrPatch = Partial<Pick<TicketPr, "state" | "review" | "ci" | "readError" | "headSha" | "failed" | "headBranch" | "openedAt" | "mergedAt" | "closedAt" | "checkedAt">>`
  - `class TicketPrsRepo`:
    - `link(l: NewPrLink): { pr: TicketPr; created: boolean }`
    - `get(id: number): TicketPr | null`
    - `byTicket(ticketKey: string): TicketPr[]`, newest first by `COALESCE(opened_at, linked_at) DESC, id DESC`
    - `byUrl(url: string): TicketPr[]`
    - `needingRead(): TicketPr[]`, i.e. `state = 'open' OR checked_at = 0`
    - `pendingMerged(): TicketPr[]`
    - `update(id: number, p: TicketPrPatch): void`
    - `setDelivered(id: number, key: string | null): void`
    - `setMergedHandled(id: number, at: number): void`
    - `pruneStale(repoId: number, currentBranch: string): number`
    - `slugs(): string[]`
  - `interface BranchWatchRow { repoId: number; ticketKey: string; branch: string; ci: WatchedPr["ci"]; headSha: string | null; failed: CiCheck[]; readError: boolean; checkedAt: number; deliveredKey: string | null }`
  - `class BranchWatchRepo`:
    - `get(repoId: number): BranchWatchRow | null`
    - `upsert(r: Omit<BranchWatchRow, "deliveredKey">): void`
    - `setDelivered(repoId: number, key: string | null): void`
    - `all(): BranchWatchRow[]`
  - `StageEvent` gains `prId: number | null`. `PrStageRepo` adds:
    - `forTicket(ticketKey: string): StageEvent[]`, ordered `at, id`
    - `lastCi(prId: number): { sha: string | null; result: string } | null`
    - `firstSkillAt(): number | null`

  `forRepo` stays until Task 9.

- [ ] **Step 1: Write the failing tests**

  `pr-url.test.ts`:
  - `prUrlKey(" https://github.com/A/B/pull/3/ ") === "https://github.com/a/b/pull/3"`
  - `prUrlParts("https://github.com/Acme/App/pull/12")` equals `{ host: "github.com", slug: "acme/app", number: 12 }`
  - `prUrlParts("https://ghe.acme.io/team/app/pull/3/files")?.slug === "ghe.acme.io/team/app"`
  - `prUrlParts("https://github.com/a/b/issues/3") === null`
  - `prUrlParts("") === null`

  `ticket-prs-repo.test.ts`:
  - `link creates a row, and a second link of the same ticket+url updates nothing but fills null repo_id/head_branch/merged_at`: the second link has `repoId: 4` where the first had null, and `state: "open"` where the stored state is `merged` with `checkedAt > 0`. Expected: `repoId === 4`, `state === "merged"`, and `created === false`.
  - `link on a never-read row takes the newer reported state`: stored `checked_at` 0 with `open`, then linked `merged` → `merged`.
  - `the same url under two tickets is two rows; byUrl returns both`.
  - `needingRead lists open rows and never-read terminal rows only`.
  - `pruneStale removes non-merged branch/backfill rows of an old head branch and keeps merged rows and handoff rows`.
  - `deleting the ticket repo sets repo_id to null`: needs `PRAGMA foreign_keys = ON`.

  `branch-watch-repo.test.ts`:
  - `upsert with a new branch clears delivered_key`.

  `pr-stage-repo.test.ts`:
  - `add stores pr_id and forTicket returns it`.
  - `lastCi returns the newest ci event of that PR only`.
  - `deleting a ticket_prs row cascades to its events`.
  - `migrate() from user_version 21 adds the tables and pr_id`: `PRAGMA table_info(pr_stage_events)` includes `pr_id`.

- [ ] **Step 2: Run them and verify they fail**

  Run: `pnpm vitest run src/shared/pr-url.test.ts src/main/db/ticket-prs-repo.test.ts src/main/db/branch-watch-repo.test.ts src/main/db/pr-stage-repo.test.ts`

  Expected: FAIL (modules or columns missing).

- [ ] **Step 3: Implement**

  - Append migration 22 exactly as in "Data model".
  - `link` is one `INSERT … ON CONFLICT (ticket_key, url) DO UPDATE`:
    - `repo_id = COALESCE(ticket_prs.repo_id, excluded.repo_id)`, and likewise for `head_branch`, `opened_at`, `merged_at` and `closed_at`;
    - `state = CASE WHEN ticket_prs.checked_at = 0 THEN excluded.state ELSE ticket_prs.state END`.

    `created` comes from `changes()` plus a pre-read.
  - `pruneStale` deletes rows where:
    - `repo_id = ?`;
    - `source IN ('branch','backfill')`;
    - `head_branch IS NOT ?`;
    - `state != 'merged'`.
  - Switch `pr-memory.ts` `prId()` and `pr-handoff.ts` `key()` to `prUrlKey`.
  - `PrStageRepo.add` writes `pr_id`. The existing callers pass `prId: null` for now; update `stage-hook.ts`, `pr-observe.ts` and the test fixtures.

- [ ] **Step 4: Run and verify they pass**

  Run the same command, then `pnpm test` and `pnpm typecheck`.

  Expected: PASS. The app still runs on `pr_watch`.

- [ ] **Step 5: Commit**

  `git commit -m "feat(prwatch): ticket_prs and branch_watch tables with repos"` (with the trailer).

## Task 2: gh additions for per-PR watching, and AI reviewers (C-S1)

**Files:**
- Modify: `src/main/tickets/gh.ts`, `src/main/tickets/gh.test.ts`

**Interfaces:**
- Produces:
  - `interface BranchPr { number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED"; headRefName: string; createdAt: number | null; mergedAt: number | null; closedAt: number | null }`
  - `prsForBranch(cwd: string, branch: string, timeoutMs: number): Promise<BranchPr[] | null>` runs `gh pr list --head <branch> --state all --limit 30 --json number,url,state,headRefName,createdAt,mergedAt,closedAt`. `[]` means no PR and `null` means gh failed.
  - `prStatus(cwd, ref, timeoutMs)`: same signature. `ref` may be a URL (document it), `PR_FIELDS` gains `headRefName`, and `PrStatus` gains `headBranch: string`.
  - `reviewComments(cwd, number, timeoutMs, repo?: string | null)`, `reviewAuthors(cwd, number, timeoutMs, repo?: string | null)` and `failedLog(cwd, runId, lines, timeoutMs, repo?: string | null)`. When `repo` (a slug) is given, gh runs with env `GH_REPO=<slug>` and, for a three-part slug, also `GH_HOST=<host>`. The `{owner}/{repo}` placeholders then resolve from it instead of the cwd.
  - `reviewerKind(login, prAuthor)` returns `"copilot"` for any AI reviewer: a login containing `copilot`, or one in the new `AI_REVIEWERS = ["chatgpt-codex-connector", "copilot-pull-request-reviewer"]` (compared with the `[bot]` suffix stripped). `chatgpt-codex-connector` is removed from `BOT_LOGINS`.

Today, Copilot is typed `copilot`, logged as a `copilot_review` timeline item and gets its inline comments fetched. Codex is in `BOT_LOGINS`, typed `bot`, and dropped entirely. After this task both behave like Copilot.

- [ ] **Step 1: Write the failing tests** (use the existing fake-binary pattern at `gh.test.ts:264`)
  - `prsForBranch parses gh pr list and returns [] for an empty list and null on a non-zero exit`.
  - `prStatus accepts a URL ref and reads headRefName`.
  - `reviewComments with a repo sets GH_REPO and GH_HOST for an enterprise slug`: the fake gh echoes its env into a file, and the test asserts `GH_REPO=ghe.acme.io/team/app` and `GH_HOST=ghe.acme.io`.
  - `reviewerKind treats chatgpt-codex-connector and chatgpt-codex-connector[bot] as copilot`, and `dependabot[bot]` is still `bot`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/tickets/gh.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement**

  `runGhDetail` gains an optional `env?: NodeJS.ProcessEnv`, which is merged over `process.env`. Keep every function non-throwing.

- [ ] **Step 4: Run and verify they pass**

  Run the same command, then `pnpm typecheck`.

  Expected: PASS. Existing callers still compile because the new parameters are optional.

- [ ] **Step 5: Commit**

  `feat(gh): pr list by branch, slug-scoped api calls, Codex as AI reviewer`

## Task 3: Watch scheduling as pure functions (C-V4, C-S2, C-S4, C-S7)

**Files:**
- Create: `src/main/prwatch/pr-schedule.ts`, `src/main/prwatch/pr-schedule.test.ts`
- Modify: `src/main/tickets/ticket-service.ts` (+ test), `src/main/sessions/session-service.ts` (+ test)

**Interfaces:**
- Consumes: `TicketPr`, `BranchWatchRow` (Task 1).
- Produces:
  - `BRANCH_IDLE_MS = 30 * 60_000`. `PR_FAST_MS`, `PR_SLOW_MS` and `PR_WATCH_MAX` move here from `pr-watcher.ts` (same values: 60 000, 300 000, 40).
  - `interface BranchTarget { ticketKey: string; repoId: number; repoPath: string; cwd: string; branch: string; sessionOpen: boolean }`
  - `interface PrPoll { url: string; rows: TicketPr[]; cwd: string; repoPath: string | null; slug: string; sessionOpen: boolean }`. There is one poll per URL, and `rows` holds every ticket's row for it.
  - `branchTargets(tickets: Pick<Ticket, "key" | "repos">[], d: { ghWorkDir(r: TicketRepo): string; sessionOpen(ticketKey: string, repoId: number): boolean }): BranchTarget[]`
  - `prPolls(rows: TicketPr[], d: { repoOf(repoId: number): TicketRepo | null; ghWorkDir(r: TicketRepo): string; home: string; sessionOpen(ticketKey: string, repoId: number | null): boolean }): PrPoll[]`. The cwd is the PR's ticket repo work dir, or `home` when `repoId` is null.
  - `nextPrCheckAt(pr: Pick<TicketPr, "state" | "checkedAt" | "ci">, sessionOpen: boolean): number`:
    - `checkedAt === 0` → 0;
    - terminal → `Infinity`;
    - open → `checkedAt + (ci === "pending" && sessionOpen ? PR_FAST_MS : PR_SLOW_MS)`.
  - `nextBranchCheckAt(row: BranchWatchRow | null, sessionOpen: boolean, hasOpenPr: boolean): number`:
    - `hasOpenPr` → `Infinity` (GitHub allows one open PR per head branch, and the PR poll will see it close);
    - no row → 0;
    - session open → `checkedAt + (ci pending ? FAST : SLOW)`;
    - otherwise → `checkedAt + BRANCH_IDLE_MS`. There is no neverRead latch (C-S2).
  - `capRound<T extends { sessionOpen: boolean }>(items: T[]): T[]`: session-open items first, then the original order, sliced to `PR_WATCH_MAX`.
  - `TicketService.ghWorkDir(r: TicketRepo): string`: returns `repoPath` when `r.worktreeRemovedAt !== null` or `worktreePath` is null, otherwise `worktreePath` (C-S4).
  - `SessionService.hasTicketTerminal(ticketKey: string, repoId: number | null): boolean`: true when an open head of that ticket is a coordinator, has `repoId` null, or has the same `repoId` (C-V4).

- [ ] **Step 1: Write the failing tests**

  `pr-schedule.test.ts`:
  - `a never-checked branch is due now; an idle one after 30 minutes; one with an open PR never`.
  - `an open PR with pending CI and an open session is due after 60 s, otherwise after 300 s; a merged PR never; a never-read merged PR now`.
  - `prPolls groups two tickets' rows for one URL into one poll and is session-open if either ticket's session is open`.
  - `a slug-only PR polls from home`.
  - `capRound keeps session-open items first and stops at 40`.

  `ticket-service.test.ts`:
  - `ghWorkDir falls back to the repo path after the worktree was removed`.

  `session-service.test.ts`:
  - `hasTicketTerminal counts the ticket's coordinator for every repo`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/prwatch/pr-schedule.test.ts src/main/tickets/ticket-service.test.ts src/main/sessions/session-service.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement** the functions above. Nothing is wired yet.

- [ ] **Step 4: Run and verify they pass**

  Same command plus `pnpm typecheck`.

  Expected: PASS.

- [ ] **Step 5: Commit**

  `feat(prwatch): per-PR and per-branch watch schedule`

## Task 4: Switch the watcher to per-PR state; migrate and drop pr_watch (C-V7, C-S3, C-S5, C-S7, mixed clocks)

**Files:**
- Modify: `src/main/db/migrations.ts` (append entry 23)
- Rewrite: `src/main/prwatch/pr-watcher.ts`, `src/main/prwatch/pr-observe.ts`, `src/main/prwatch/ci-delivery.ts` and their tests
- Modify: `src/main/prwatch/pr-handoff.ts` (+ test), `src/main/gate/hold-watcher.ts` (+ test), `src/main/lessons/lesson-runner.ts` (+ test)
- Modify: `src/shared/types.ts` (`WatchedPr`), `src/main/tickets/git.ts` (+ test), `src/main/index.ts`
- Delete: `src/main/db/pr-watch-repo.ts` (+ test), `src/main/prwatch/pr-targets.ts` (+ test)
- Test: `src/main/db/repos.test.ts` (migration case)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - Migration 23 (SQL below).
  - `WatchedPr` becomes `{ ticketKey; prId: number | null; repoId: number | null; repoPath: string | null; branch: string; number: number | null; url: string | null; state; review; ci; headSha; checkedAt }`. PR rows come from `ticket_prs`, and branch-only rows (number null) come from `branch_watch` when that repo has no open PR.
  - `interface ObsScope { ticketKey: string; prId: number | null; repoId: number | null; scope: string; branch: string | null }`, where `scope = repoId !== null ? String(repoId) : \`${ticketKey}@${slug}\``.
  - `stageKey` takes `{ scope, branch }` instead of `{ repoId, branch }`. The formats are unchanged, so old keys still dedupe.
  - `prObservations(s: ObsScope, prev: PrSnapshot | null, next: PrSnapshot, pr: PrStatus | null, inline: PrComment[], now: number, bots: ReviewAuthors | null, lastCi: { sha: string | null; result: string } | null): Observation[]`, with `type PrSnapshot = Pick<TicketPr, "number" | "state" | "review" | "ci" | "headSha" | "failed" | "checkedAt">`.
  - `firstCommitObservation(t: BranchTarget, at: number, afterPrId: number | null): Observation`, with key `${repoId}:first_commit:${branch}` and suffix `:after:${afterPrId}` when it is not null.
  - `firstCommitAt(cwd: string, branch: string, afterMs: number | null = null): Promise<number | null>`: the earliest author time among commits in `origin/<base>..branch` whose committer time is greater than `afterMs`. Use `--format=%at %ct`.
  - `type CiItem = { kind: "pr"; id: number } | { kind: "branch"; repoId: number }`
  - `CiDeliveryDeps` becomes `{ prs: Pick<TicketPrsRepo, "get" | "needingRead" | "setDelivered">; branches: Pick<BranchWatchRepo, "get" | "all" | "setDelivered">; currentBranch(repoId: number): string | null; guard; sessionFor(ticketKey: string, repoId: number): string | null; deliver; now; log }`, with `settled(item: CiItem): Promise<void>` and `flush(): Promise<void>`.
  - `PrWatcherDeps`:
    - `prs: TicketPrsRepo`, `branches: BranchWatchRepo`
    - `tickets(): Pick<Ticket, "key" | "repos">[]` (unarchived)
    - `repoOf(repoId: number): TicketRepo | null`, `ghWorkDir(r: TicketRepo): string`
    - `sessionOpen(ticketKey: string, repoId: number | null): boolean`
    - `home: string`, `slugOf(path: string): string | null`
    - `gh: { prStatus; prsForBranch; branchRuns; failedLog; reviewComments; reviewAuthors }`, `git: { firstCommitAt }`
    - `stages: Pick<PrStageRepo, "has" | "add" | "lastCi">`
    - `onMerged(pr: TicketPr, repoPath: string | null): void`, `onPrChanged(ticketKey: string): void`, `onCiSettled(item: CiItem): void`
    - `notify(): void`, `roundDone?(): void`, `now(): number`, `log(msg: string, err?: unknown): void`
  - `PrWatcher` methods:
    - `start(tickMs?)`, `stop()`, `soon(repoId: number)`, `soonTicket(ticketKey: string)`, `check(): Promise<void>`
    - `statusOf(ticketKey: string): WatchedPr[]`
    - `cachedByUrl(url: string): Pick<TicketPr, "state"> | null`: only `readError === false` and `now - checkedAt < 60_000`.
  - `MERGED_RECENT_MS = 24 * 60 * 60_000`.
  - `prHandoff(ticketKey: string, rows: TicketPr[], base: { id: number; createdAt: number; status: Handoff["status"]; prs: Pr[] }): { prs: Pr[]; status: Handoff["status"]; sourceRef: string } | null`. In this task it returns `status: base.status`; Task 6 adds the rule.
  - `LessonRunner.merged(t: { repoPath: string | null; slug: string }, prNumber: number): void`. The slug comes from `repoPath` when it is known, otherwise from `t.slug`, but only if `repo.repo(slug)` exists; otherwise the call returns.
  - `HoldWatcherDeps.cachedByUrl?: (url: string) => Pick<TicketPr, "state"> | null`. The `ci !== "unknown"` test is gone, because the watcher only returns successful fresh reads.

Migration 23 (load-bearing):

```sql
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
```

Round algorithm, in order. Each part is wrapped so one failure doesn't stop the others.

1. Prune and re-key (C-S3). For every ticket repo, call `prs.pruneStale(r.id, r.branch)`. If `branch_watch.branch !== r.branch`, upsert a fresh row for the new branch with ci unknown.
2. PR polls. Take `prPolls(prs.needingRead(), …)` and keep those due by `nextPrCheckAt` or forced by `soon`/`soonTicket`. Then `capRound`, and run with at most 4 gh calls in parallel (`GH_PARALLEL`). Each poll calls `prStatus(cwd, url)`:
   - **On `null` (C-V7):** update every row with `readError: true, checkedAt: now` and keep `ci` and `state`. Emit no events.
   - **On success**, for each row:
     - Build `next`, `prev`, the inline comments and the bots, the same as today's `record()`. Inline comments are fetched for `copilot`-kind reviews. Pass `repo: slug` to the review calls and to `failedLog`.
     - Update the row: state, review, ci, headSha, headBranch, failed, `readError: false`, checkedAt, and the GitHub times. Store `mergedAt = min(pr.mergedAt ?? row.mergedAt ?? now, now)`.
     - Add the observations with `prId`.
     - Mark changes for `onPrChanged` (once per ticket per round) and for `notify`.
     - Call `onCiSettled({ kind: "pr", id })` when the CI result settled.
3. Branch checks. Take `branchTargets(tickets, …)`, keep those due by `nextBranchCheckAt` (with `hasOpenPr` = an open row with `repoId` equal to the target's and `headBranch` equal to its branch) or forced, then `capRound`. For each:
   - `prsForBranch(cwd, branch)`:
     - `null` → `branch_watch` gets `readError: true, checkedAt: now`.
     - Otherwise, link each PR: `source: "branch"`, `repoId: t.repoId`, `slug` from `prUrlParts(url)`, the GitHub times, and `linkedAt: now`. A newly created row is read in the same round: queue it for step 2 of the next tick via `soon`.
   - When no PR is open, call `branchRuns` and upsert `branch_watch` (CI deliverable as `{ kind: "branch", repoId }` as today).
   - Then `firstCommitAt(cwd, branch, lastEnd)`, where `lastEnd` is the latest `mergedAt ?? closedAt` of this repo's rows. Add `firstCommitObservation(t, at, lastPrIdOrNull)`.
4. Merged handling (C-S5). For each `prs.pendingMerged()` row:
   - If `mergedAt !== null && mergedAt < linkedAt - MERGED_RECENT_MS`, call `setMergedHandled(id, now)` without `onMerged`.
   - Otherwise `try { onMerged(row, repoPath); setMergedHandled(id, now) } catch { log; leave null }`. It is retried next round.
5. Then `onPrChanged` per changed ticket, `notify` if anything changed, and `roundDone`.

Observations (pr-observe):
- **CI event (C-V7):** emitted only when `next.ci ∈ {pending, passing, failing}` and the result differs from the PR's last stored CI event. That is, `lastCi === null || lastCi.sha !== sha || lastCi.result !== next.ci`. A previous `unknown` row value plays no part.
- **Reviews (mixed clocks):** `at = seen`, except when `prev === null || prev.checkedAt === 0` (the first read of this PR), where `at = min(submittedAt, seen)`. DISMISSED keeps `seen` as today.
- **`merged` / `closed`:** emitted when `prev?.state !== next.state` or `prev.checkedAt === 0`. The time is the GitHub time, falling back to the row's stored `mergedAt` (the hold release), then `now`, and is never later than `now`. Keys are as today, so they dedupe.
- **`pr_opened`:** emitted on the first read, at `pr.createdAt ?? now`, with the existing key.

index.ts wiring (replace lines ~956–1020 and 1060; the line numbers are from HEAD d54ea74):
- `new TicketPrsRepo(db)` and `new BranchWatchRepo(db)` replace `PrWatchRepo`.
- `sessionOpen: (k, id) => sessionService.hasTicketTerminal(k, id)`, `ghWorkDir: (r) => ticketService.ghWorkDir(r)`, `home: os.homedir()`, `slugOf: (p) => repoIdentity.slugOf(p)`.
- `onMerged: (pr, repoPath) => lessonRunner.merged({ repoPath, slug: pr.slug }, pr.number)`.
- `onPrChanged` passes `prs.byTicket(key)` and `base: { id, createdAt, status: base.payload.status, prs: base.payload.prs }` to `prHandoff`, and ingests with `status: next.status`.
- `CiDelivery` gets `currentBranch: (id) => tickets.repoById(id)?.branch ?? null`. Add `TicketsRepo.repoById` if it is missing.
- `sessionStopped`:
  - If the head has a `ticketKey`, call `prWatcher.soonTicket(key)`.
  - Else, if it is a feature coordinator, call `soonTicket` for each unarchived ticket of the feature.
  - Else, if it has a `repoId`, call `soon(repoId)`.
- Remove `handoffHasOpenPr` and `watchTargets` (C-S7). `PrStagesService` keeps working by reading `prs.byTicket` filtered to `repoId === r.id && headBranch === r.branch`, newest first. Task 9 replaces this.

- [ ] **Step 1: Write the failing tests**

  `repos.test.ts`:
  - `migration 23 from a v20 database`. Seed a DB migrated to 20 with:
    - a `ticket_repos` row;
    - a pr_watch row with `number` null and `ci` unknown;
    - a pr_watch row for `#25` merged with no merged event;
    - one ci event on that repo and branch.

    Run `migrate`, then assert:
    - one `branch_watch` row;
    - one `ticket_prs` row with `slug = "acme/app"`, `checked_at = 0` and `merged_handled_at` set;
    - the ci event's `pr_id` equals that row's id;
    - `pr_watch` is gone.

  `pr-observe.test.ts` (rewrite for the new signature):
  - `a gh blip does not produce a second CI passed event`: the last ci is `passing@s1` and next is `passing@s1` → no ci event.
  - `a review seen on a later read is placed at observation time; on the first read at min(submittedAt, seen)`.
  - `slug-only scope keys include the ticket`.

  `pr-watcher.test.ts` (rewrite on fake repos):
  - `keeps the previous ci and flags read_error when prStatus fails; cachedByUrl then returns null`.
  - `polls a URL shared by two tickets once and updates both rows` (Review Focus 2).
  - `finds sequential PRs on one branch and links both`.
  - `a throwing onMerged is retried next round and recorded once it succeeds`.
  - `a merge older than linked_at - 24h is marked handled without onMerged`.
  - `after a branch change the old branch's open row is pruned and CI for it is not delivered`.
  - `soonTicket forces branch checks for all repos of the ticket`.
  - `the coordinator's open session makes every repo of the ticket fast-polled`.
  - `no PR open: branchRuns feeds branch_watch; first_commit after the last merge gets the :after: key`.

  `ci-delivery.test.ts`:
  - `delivers a PR row's CI only when head_branch is the repo's current branch`.
  - `branch rows deliver with ciWhereBranch`.

  `hold-watcher.test.ts`:
  - `trusts a cached merged state and ignores rows with read_error`.

  `lesson-runner.test.ts`:
  - `merged with no repoPath uses the slug's lessons repo, and skips unknown slugs`.

  `git.test.ts`:
  - `firstCommitAt with afterMs ignores commits committed before it`.

  `pr-handoff.test.ts`:
  - port the existing cases to `TicketPr` rows, plus `appends linked PRs from other branches`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/db/repos.test.ts src/main/prwatch src/main/gate/hold-watcher.test.ts src/main/lessons/lesson-runner.test.ts src/main/tickets/git.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement**, following the round algorithm and wiring above. Delete `pr-watch-repo.ts`, `pr-targets.ts` and their tests.

- [ ] **Step 4: Run and verify they pass**

  Run `pnpm test`, `pnpm typecheck` and `pnpm exec eslint src e2e hook`. Also run `pnpm e2e:only e2e/pr-stages.spec.ts e2e/merge-gate.spec.ts e2e/features.spec.ts` after `pnpm build && pnpm build:hook`.

  Expected: PASS.

- [ ] **Step 5: Commit**

  `feat(prwatch): watch PRs per PR; migrate pr_watch into ticket_prs`

## Task 5: Link PRs from handoffs and the merge gate; dedupe empty-URL PRs (C-V9)

**Files:**
- Create: `src/main/prwatch/pr-links.ts`, `src/main/prwatch/pr-links.test.ts`
- Modify: `src/shared/pr-memory.ts` (+ test), `src/main/prwatch/pr-handoff.ts` (+ test), `src/main/handoff/ingest.ts` (+ `ingest.test.ts`), `src/main/gate/merge-gate.ts` (+ test), `src/main/db/merge-gate-repo.ts` (+ test), `src/main/db/handoffs-repo.ts` (+ test), `src/main/index.ts`

**Interfaces:**
- Produces:
  - `dedupeHandoffPrs(prs: Pr[]): Pr[]` in `src/shared/pr-memory.ts`. It drops an entry whose `url.trim()` is empty when another entry has the same `number` and a non-empty URL, and keeps the first entry among URL duplicates by `prUrlKey`. Both `rememberMergedPrs` (on input and output) and `prHandoff` (on `base.prs`) apply it.
  - `class PrLinker`:
    - constructor deps: `{ prs: TicketPrsRepo; tickets: Pick<TicketsRepo, "get">; slugOf(path: string): string | null; now(): number }`
    - `repoFor(ticketKey: string, slug: string): number | null`: the ticket repo whose `slugOf(repoPath)` equals the slug.
    - `linkHandoffPrs(ticketKey: string, prs: Pr[]): number`: links PRs with a parseable URL as `source "handoff"`, `state` as reported and `headBranch` null. It returns the number created.
    - `linkHold(h: MergeHold, sessionTicket: (sessionId: string) => string | null): boolean`: uses `ticket_key ?? sessionTicket(session_id)`, `source "merge_gate"`, and `mergedAt = h.outcome === "merged" ? h.releasedAt : null`.
  - `IngestDeps.linkPrs?: (ticketKey: string, prs: Pr[]) => void`, called inside the ingest transaction with the stored PR list.
  - `MergeGateDeps.onPrHold?: (holdId: number) => void`, called after `addHold`/`toPrHold` with `kind === "pr"`.
  - `MergeGateRepo.prHolds(): MergeHold[]` returns every hold with `kind = 'pr' AND pr_url IS NOT NULL`, any status.
  - `HandoffsRepo.allPrs(ticketKey: string): Pr[]`: every PR in any valid handoff of the ticket, newest record first, passed through `dedupeHandoffPrs`.

Empty-URL PRs are never linked here. The backfill (Task 7) links them only for single-repo tickets.

- [ ] **Step 1: Write the failing tests**
  - `pr-memory.test.ts`: `dedupes an empty-URL entry into the URL entry with the same number` (Review Focus 5), and `rememberMergedPrs no longer returns both #3 and https://…/pull/3`.
  - `pr-links.test.ts`:
    - `links a handoff PR to the ticket repo with the same slug`;
    - `a PR from another repo is linked with repo_id null and its slug`;
    - `does not link an empty-URL PR in a multi-repo ticket`;
    - `linkHold resolves a null ticket through the session and uses released_at as mergedAt`.
  - `ingest.test.ts`: `ingesting a handoff links its PRs in the same transaction`. A throwing `linkPrs` rolls the handoff back. That is the existing transaction behaviour; assert that no handoff row exists.
  - `merge-gate.test.ts`: `a PR hold calls onPrHold`.
  - `merge-gate-repo.test.ts`: `prHolds returns released and active PR holds`.
  - `handoff-repos.test.ts`: `allPrs collects PRs from every valid handoff, deduped`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/shared/pr-memory.test.ts src/main/prwatch/pr-links.test.ts src/main/handoff/ingest.test.ts src/main/gate src/main/db/merge-gate-repo.test.ts src/main/db/handoff-repos.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement and wire in index.ts:**
  - `linkPrs: (k, prs) => prLinker.linkHandoffPrs(k, prs)`;
  - `onPrHold: (id) => { prLinker.linkHold(gateRepo.hold(id)!, (s) => sessions.get(s)?.ticketKey ?? null); prWatcher.soonTicket(...) }`. Add `MergeGateRepo.hold(id)` if it is missing.

- [ ] **Step 4: Run and verify they pass**

  `pnpm test` and `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

  `feat(prwatch): link PRs from handoffs and merge holds; dedupe empty-URL PRs`

## Task 6: Ticket status from own, remembered and linked PRs (C-V8)

**Files:**
- Modify: `src/main/handoff/status.ts`, `src/main/handoff/status.test.ts`, `src/main/handoff/ingest.ts` (+ test), `src/main/prwatch/pr-handoff.ts` (+ test), `src/main/index.ts`

**Interfaces:**
- Produces:
  - `interface StatusContext { remembered: Pr[]; linkedOpen: boolean }`
  - `deriveStatus(h: StatusInput, openFollowups: number, ctx: StatusContext = { remembered: [], linkedOpen: false }): TicketStatus`. Here `h.prs` is the PR list the model (or the watcher refresh) reported itself. The order is:
    1. any open PR in `h.prs`, or `ctx.linkedOpen`, or an open PR in `remembered` → `blocked` if the model said blocked, else `in_review`;
    2. model `done`/`merged_pending_followup` → mpf or done by followups;
    3. model `in_review` and `combinedPr(h.prs)?.state === "merged"` → mpf or done;
    4. model `blocked`, or blockers → `blocked`;
    5. `combinedPr(h.prs)?.state === "closed"` → `active`;
    6. otherwise the model's `in_review` → `in_review`, else `active`.

    Remembered or linked merged PRs never reach step 3.
  - `IngestDeps.linkedOpen?: (ticketKey: string) => boolean`. In index.ts this is `prs.byTicket(k).some((p) => p.state === "open")`.
  - `rederiveTicketStatus`: if the ticket's current automatic `status` is `done` or `merged_pending_followup`, it returns done/mpf by the followup count. Otherwise it calls `deriveStatus({ ...payload, prs: [] }, open, { remembered: payload.prs, linkedOpen })`.
  - The `prHandoff` status rule: if `base.status ∈ {active, in_review}`, no PR in the merged list is open, and some row has `mergedAt !== null && mergedAt > base.createdAt`, return `status: "done"`. Otherwise return `base.status`.

- [ ] **Step 1: Write the failing tests**

  `status.test.ts`:
  - Change the `h()` default status used by "merged PR with open followups" and "in_review + all merged" to `in_review`. The expectations are unchanged.
  - Add:
    - `a remembered merged PR does not override an explicit active`;
    - `a remembered merged PR does not override in_review`;
    - `an open linked PR makes an active ticket in_review`;
    - `model active with its own merged PR stays active (sequential PRs)`.

  `ingest.test.ts`:
  - `ingest passes the model's own prs and the remembered ones separately`.
  - `rederive keeps done/mpf in sync with followups and leaves active alone`.

  `pr-handoff.test.ts`:
  - `a PR merged after the base handoff, none open, promotes active to done`.
  - `a PR merged before the base handoff does not`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/handoff src/main/prwatch/pr-handoff.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement.** In `ingestHandoff`, compute `stored = rememberMergedPrs(...)` as today, and call `deriveStatus(input.payload, open, { remembered: stored, linkedOpen })` with the model's own `input.payload.prs`.

- [ ] **Step 4: Run and verify they pass**

  `pnpm test`. Expected: PASS.

- [ ] **Step 5: Commit**

  `fix(status): merged PRs from memory no longer override the model; linked open PRs count`

## Task 7: One-off backfill at startup

**Files:**
- Create: `src/main/prwatch/pr-backfill.ts`, `src/main/prwatch/pr-backfill.test.ts`
- Modify: `src/main/db/jobs-repo.ts` (add `JOB_PR_BACKFILL = "pr_backfill"` to `JobName`), `src/main/index.ts`

**Interfaces:**
- Consumes: `PrLinker` (Task 5), `prsForBranch` (Task 2), `TicketsRepo.list({ includeArchived: true })`, `HandoffsRepo.allPrs`, `MergeGateRepo.prHolds`, `TicketService.ghWorkDir`.
- Produces: `runPrBackfill(d: PrBackfillDeps): Promise<{ ok: boolean; linked: number; failed: number }>`, where `PrBackfillDeps` is:
  - `tickets(): Ticket[]` (including archived)
  - `linker: PrLinker`, `prs: TicketPrsRepo`
  - `handoffPrs(ticketKey: string): Pr[]`
  - `holds(): MergeHold[]`, `sessionTicket(sessionId: string): string | null`
  - `prsForBranch: typeof prsForBranch`, `ghWorkDir(r: TicketRepo): string`
  - `jobs: Pick<JobsRepo, "get" | "record">`
  - `now(): number`, `log(msg: string, e?: unknown): void`

Behaviour:
- If `jobs.get(JOB_PR_BACKFILL).lastStatus === "ok"`, return immediately.
- For each ticket repo (2 gh calls in parallel at most), call `prsForBranch(ghWorkDir(r), r.branch)` and link each result with `source "backfill"`, the GitHub times, and `mergedHandledAt: now` when its state is MERGED/CLOSED. Then link every handoff URL and every PR hold.
- An empty-URL handoff PR is linked only when the ticket has exactly one repo and that repo's `prsForBranch` result contains its number. The URL comes from that result.
- After 5 consecutive gh failures, stop early.
- Record `"ok"` only if no gh call failed, else `"failed"` with the count. The next startup retries, and every write is an upsert.
- No reads happen here. The watcher reads rows with `checked_at = 0` and writes `pr_opened`/`merged`/`closed` events at their real times (Task 4). `MERGED_RECENT_MS` keeps those merges from queuing lessons.
- In index.ts, call `void runPrBackfill(...).catch(log)` after `prWatcher.start()`, and call `prWatcher.soon` for touched repos afterwards.

- [ ] **Step 1: Write the failing tests** (`pr-backfill.test.ts`, on an in-memory DB with real repos)
  - `links sequential PRs on an archived ticket's branch and records ok`.
  - `links handoff URLs and merge holds with a null ticket via the session`.
  - `records failed and links nothing twice when gh fails for one repo` (Review Focus 3): run twice, the second time with gh fixed; row counts are equal to a clean single run.
  - `an empty-URL PR in a single-repo ticket takes the URL from the branch list`.
  - `does nothing once recorded ok`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/prwatch/pr-backfill.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement and wire.**

- [ ] **Step 4: Run and verify they pass**

  `pnpm test` and `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

  `feat(prwatch): one-off backfill of PR links for all tickets`

## Task 8: Hook capture: review agents, discovered sessions, skill branch, tracking start (D-2, C-S6, D-1 setting)

**Files:**
- Modify: `src/main/claude/project-mcp.ts` (+ test), `hook/shipherd-hook.ts` (+ `hook/shipherd-hook.test.ts`), `src/main/hooks/stage-hook.ts` (+ test), `src/shared/pr-stages.ts` (+ test), `src/main/db/settings-repo.ts`, `src/main/index.ts`
- Create: `src/main/prwatch/skill-tracking.ts`, `src/main/prwatch/skill-tracking.test.ts`

**Interfaces:**
- Produces:
  - In `projectMcpApprovalSettings`, `PostToolUse` gains `{ matcher: "Agent|Task", hooks: [{ type: "command", command: p.gateCommand, timeout: 10 }] }`, only when `gateCommand` is set (the same condition as the Skill matcher).
  - In `buildEnvelope`, for `hook_event_name === "PostToolUse"` with `tool_name` `Agent` or `Task`, the payload keeps only `hook_event_name`, `session_id`, `tool_name`, `tool_use_id`, `cwd` and `tool_input: { description: (≤200 chars), subagent_type }`. `tool_response` and `tool_input.prompt` are dropped.
  - `REVIEW_SKILLS` adds `"subagent-driven-development"` and `"receiving-code-review"`.
  - `skillCategory(name)` returns `"review"` for names starting with `agent:`, checked before the prefix strip.
  - `stageEventFromHook`:
    - For Agent/Task with `description` or `subagent_type` matching `/review/i`, it records a skill event `{ name: "agent:" + (description || subagent_type), category: "review" }`.
    - The `origin === "shipherd"` requirement is gone (C-S6). The owner rules are unchanged.
    - `event.branch = session.gitBranch ?? null`.
  - `SETTING_DEFAULTS.skillTrackingSince = ""`
  - `ensureSkillTrackingSince(d: { settings: Pick<SettingsRepo, "get" | "set">; firstSkillAt(): number | null; now(): number }): number`. This is idempotent; it seeds `min(firstSkillAt ?? now, now)`.
  - `skillTrackingSince(settings): number | null` returns null when the setting is empty.
  - In index.ts, when `health.syncHookBinary()` resolves `true` (and on startup if `hookBinCurrent()`), call `ensureSkillTrackingSince`.

- [ ] **Step 1: Write the failing tests**
  - `project-mcp.test.ts`: `adds the Agent|Task matcher next to Skill only with a gate command`.
  - `shipherd-hook.test.ts`: `trims an Agent PostToolUse payload to description and subagent_type`, with a 1 MB `tool_response` input. Assert the envelope's JSON is under 2 KB.
  - `stage-hook.test.ts`:
    - `an Agent dispatch described "Review task 3" records agent:Review task 3 as review`;
    - `a non-review agent records nothing`;
    - `a discovered session attached to a ticket records /skill`;
    - `the skill event carries the session's git branch`.
  - `pr-stages.test.ts` (shared): `skillCategory maps subagent-driven-development, receiving-code-review and agent:* to review`.
  - `skill-tracking.test.ts`:
    - `seeds from the earliest skill event`;
    - `seeds now with no events`;
    - `never moves once set`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/claude/project-mcp.test.ts hook/shipherd-hook.test.ts src/main/hooks/stage-hook.test.ts src/shared/pr-stages.test.ts src/main/prwatch/skill-tracking.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement and wire.**

- [ ] **Step 4: Run and verify they pass**

  Run `pnpm test`. Then `pnpm build:hook` and `pnpm e2e:only e2e/pr-stages.spec.ts` after `pnpm build`.

  Expected: PASS.

- [ ] **Step 5: Commit**

  `feat(stages): count review agents and discovered sessions; persist tracking start`

## Task 9: Scope events to PRs; one view per PR (spec item 5, D-11 placement, C-V6)

**Files:**
- Create: `src/main/prwatch/pr-scope.ts`, `src/main/prwatch/pr-scope.test.ts`
- Modify: `src/shared/pr-stages.ts`, `src/main/prwatch/pr-stages-service.ts` (+ test), `src/main/prwatch/pr-stages.ts` (input type only), `src/main/ipc/register.ts`, `src/renderer/src/pr-stages-view.ts` (+ test), `src/renderer/src/components/PrStages.tsx`, `src/main/index.ts`, `src/main/db/pr-stage-repo.ts` (remove `forRepo`)

**Interfaces:**
- Consumes: `TicketPr`, `PrStageRepo.forTicket`, `skillTrackingSince` (Task 8).
- Produces:
  - `interface Scoped { at: number; repoId: number | null; branch: string | null; prId: number | null; number: number | null }`
  - `interface ScopePr { id: number; repoId: number | null; slug: string; number: number; headBranch: string | null; start: number; end: number }`. Here `start = openedAt ?? linkedAt`, and `end = prEnd(pr)`.
  - `prEnd(pr: Pick<TicketPr, "state" | "mergedAt" | "closedAt" | "checkedAt">): number` gives `Infinity` when open, otherwise `mergedAt ?? closedAt ?? checkedAt`.
  - `assignToPrs<T extends Scoped>(items: T[], prs: ScopePr[], repos: { id: number; branch: string }[]): { byPr: Map<number, T[]>; noPr: Map<number, T[]> }`. Groups are `repoId` for ticket repos, and `slug` for slug-only PRs. Rules, in order:
    1. `prId` set and in `prs` → that PR.
    2. `number` set → the PR in the item's group with that number.
    3. Candidate groups: the item's `repoId` group, or every group when `repoId` is null.
    4. In each candidate group, the candidate PRs are those with `headBranch === branch` if `branch` is set and any exist, otherwise all the group's PRs. Pick the candidate with the smallest `end >= at`. On ties (several open PRs) the latest `start` wins.
    5. If no candidate's `end >= at`, the item is after the group's last merged or closed PR. It goes to `noPr` for a ticket-repo group, and is dropped for a slug group. So events after a merge never land on it (C-V6, D-11).
  - `PrStagesView` gains `prId: number | null; slug: string | null; noPr: boolean`. `slug` is set only when the PR is not in a ticket repo, and `repoName` shows it.
  - `interface PrStagesTicket { ticketKey: string; title: string | null; archived: boolean; merged: boolean; hasRepos: boolean; rows: PrStagesView[] }`. Rows are the no-PR rows first, then PRs newest first. `merged` follows the D-6 rule in Task 13 and is `false` until then.
  - `PrStagesService.view(scope: PrStagesScope): PrStagesTicket[]`, with `IPC.prStages` returning `PrStagesTicket[]`.
  - The service shows a `noPr` row for a ticket repo only when `noPr.get(repoId)` contains a `first_commit` event.
  - `DeriveInput` becomes:
    - `repoId: number | null`, `repoName: string`
    - `events: StageEvent[]` (already scoped)
    - `reports: { at: number; text: string }[]` (already scoped)
    - `pr: { number: number; url: string; state: "open" | "merged" | "closed"; ci: WatchedPr["ci"]; review: WatchedPr["review"]; mergedAt: number | null; closedAt: number | null; checkedAt: number } | null`
    - `skillTrackingSince: number | null`

    Task 9 maps the old boolean as `since !== null`. Task 10 uses the time.
  - Renderer (temporary until Tasks 12–13): `usePrStages` returns `PrStagesTicket[] | null`. The ticket tab renders `tickets[0]?.rows`, and the feature and epic views flatten `rows`.

- [ ] **Step 1: Write the failing tests**

  `pr-scope.test.ts`:
  - `a skill before #25 merged goes to #25, one after it to #26`.
  - `a report after the last merge goes to the no-PR bucket`.
  - `a skill with branch feature/x goes to the PR on feature/x even inside another PR's window`.
  - `a repo-less event is assigned in every repo group`.
  - `events with pr_id stay on their PR even after its merge`.
  - `a slug group drops events after its last PR`.

  `pr-stages-service.test.ts`:
  - `BTL-190 shape: two sequential PRs on the branch plus one on another branch give three rows, newest first`.
  - `a no-PR row appears only with a first_commit after the last merge`.
  - `archived tickets are included and flagged`.
  - `a ticket with no repos returns hasRepos false and no rows`.
  - `a slug-only PR row shows its slug`.

  `pr-stages-view.test.ts`: update the fixtures to `PrStagesTicket`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/prwatch/pr-scope.test.ts src/main/prwatch/pr-stages-service.test.ts src/renderer/src/pr-stages-view.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement.** Reports become `Scoped` items with `repoId` = the report's session repo, `branch` = the session's git branch, `prId` and `number` null. `features.byEpic` / `tickets.byFeature` use the include-archived variants (`listByFeature(id, { includeArchived: true })`).

- [ ] **Step 4: Run and verify they pass**

  Run `pnpm test`, `pnpm typecheck` and `pnpm e2e:only e2e/pr-stages.spec.ts`.

  Expected: PASS.

- [ ] **Step 5: Commit**

  `feat(stages): assign events to PRs; one progress row per PR`

## Task 10: Derivation fixes, timeline (D-1, D-3, D-4, D-5, D-9, late first_commit, feature-level design)

**Files:**
- Modify: `src/main/prwatch/pr-stages.ts`, `src/main/prwatch/pr-stages.test.ts`, `src/main/prwatch/pr-stages-service.ts`

**Interfaces:**
- Consumes: `DeriveInput` from Task 9.
- Produces (behaviour only):
  - **devStart:** `min(first_commit.at, pr_opened.at)`. Without either, it is the first ci or push time, else `ticketCreatedAt`.
  - **D-1:** `tracked = skillTrackingSince !== null && devStart >= skillTrackingSince`. When not tracked, `design` and `self_review` start and stay `unknown` unless an event says otherwise; they never become `skipped`.
  - **D-3:** a review-category skill event after `pr_opened`, before the merge and in the current round sets `self_review` to `done` at its time if the cell is `skipped`, `unknown` or `todo`. `cur` does not move.
  - **D-4:** when `pr.state === "merged"` and there is no `merged` event, the synthetic merged event is at `min(pr.mergedAt ?? pr.checkedAt, pr.checkedAt || Infinity)`. Events after it are frozen out as with a real merge. The same applies to `closed` with `closedAt`.
  - **D-5:** "observed" means there are `ci`, `push` or `review` events.
    - If no `ci` event exists, the ci cell is seeded from `pr.ci` (`passing` → done, `failing` → failed, `pending` → active if nothing else is active).
    - If no human `review` event exists, peer_review is seeded from `pr.review` (`approved` → done, `changes_requested` → failed).
    - When a PR is frozen without being observed, todo cells become `unknown`, not `skipped`. `merge` is still `done` when merged.
  - **D-9:** `closed` events freeze only when `pr.state === "closed"`. A reopened PR (state open) logs the closed event in the timeline and keeps going. `view.closed = pr?.state === "closed"`.
  - **Late first_commit:** dev counts as started at devStart. A ci event before a later `first_commit` is no longer dropped.
  - **Feature-level design:** an `upperDesign` event counts when `at < devStart` (it was `< ticketCreatedAt`).

- [ ] **Step 1: Write the failing tests** (in `pr-stages.test.ts`; switch `input()` to `skillTrackingSince: 0` and the new `pr` shape)
  - `work before skill tracking began shows design and self-review unknown, not skipped`.
  - `a review skill after the PR opened marks a skipped self-review done`.
  - `a merged row without a merged event uses the real mergedAt and does not pull later events in`. This replaces the "latest event time" case at `pr-stages.test.ts:288`. A ci event at 300 after mergedAt 200 stays out of the stages.
  - `a backfilled merged PR with no history: ci seeded from the row, peer review from review, the rest unknown, merge done`.
  - `a closed then reopened PR is not frozen`.
  - `a first_commit after pr_opened: CI before it still counts`.
  - `feature-level design after ticket creation but before the first commit counts`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/prwatch/pr-stages.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement**, and pass the real `skillTrackingSince` from the service.

- [ ] **Step 4: Run and verify they pass**

  Run the same command plus `pnpm test`. Expected: PASS. Every test keeps its "at most one active" assertion.

- [ ] **Step 5: Commit**

  `fix(stages): honest unknowns, real merge times, late reviews and reopened PRs`

## Task 11: Derivation fixes, review stances (D-8, D-12, D-13, stance key)

**Files:**
- Modify: `src/main/prwatch/pr-stages.ts`, `src/main/prwatch/pr-stages.test.ts`, `docs/superpowers/specs/2026-11-15-pr-stages-and-review-lessons-design.md` (peer-review row, line 60)

**Interfaces (behaviour):**
- **Stance key:** `login ?? \`review:${id}\``, with the same key in the dismissal path.
- **D-8:** an `APPROVED` while `standing("CHANGES_REQUESTED")` holds for anyone else keeps peer_review `failed` and merge not active. This is the same rule as the DISMISSED path.
- **D-12:**
  - The push-back after a failure resets `self_review`, `ci` and `merge` to `todo`.
  - `peer_review` is reset only when no approval stands (`!standing("APPROVED") || standing("CHANGES_REQUESTED")`); otherwise it stays `done`, carried into the new round.
  - A push alone never clears an approval.
  - Update the `pr-stages.ts` header comment, and the 2026-11-15 design doc row: "an approval stands across pushes and CI rounds until dismissed or superseded by CHANGES_REQUESTED".
- **D-13:** on merge while a `CHANGES_REQUESTED` stance stands, `peer_review = failed` (not skipped) and `merge = done`.

- [ ] **Step 1: Write the failing tests**
  - `alice requests changes, bob approves: peer review stays failed`.
  - Rewrite `an approval after failed CI keeps the approval…` (`pr-stages.test.ts:307`) so that after the fix push, `peer_review` is still `done` and `dev` is active in round 2.
  - `changes requested then push: peer review resets to todo` (a push does not clear a change request).
  - `merged with a standing change request: peer review failed, merge done`.
  - `two reviews without login do not overwrite each other`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/prwatch/pr-stages.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement** and edit the doc and comment.

- [ ] **Step 4: Run and verify they pass**

  Same command. Expected: PASS.

- [ ] **Step 5: Commit**

  `fix(stages): approvals follow GitHub; standing change requests win`

## Task 12: Ticket tab display: PR rows, links, slugs, reports (D-14 links, D-11, C-S1 label)

**Files:**
- Create: `src/main/util/github-url.ts`, `src/main/util/github-url.test.ts`
- Modify:
  - `src/main/lessons/lessons-service.ts` (+ test)
  - `src/shared/ipc.ts`, `src/main/ipc/validate.ts` (+ test), `src/main/ipc/register.ts`
  - `src/renderer/src/api.ts`
  - `src/renderer/src/components/PrStages.tsx`, `src/renderer/src/pr-stages-view.ts` (+ test)
  - `src/renderer/src/strings.ts`, `src/renderer/src/strings-en.ts`
  - `src/main/index.ts`
- Create: `src/renderer/src/components/pr-stages-render.test.ts`

**Interfaces:**
- Produces:
  - `isAllowedGithubUrl(url: string, knownSlugs: readonly string[]): boolean`:
    - https only;
    - no username or password in the URL;
    - hostname `github.com`, or equal to the host of a three-part known slug;
    - no lookalike matching: an exact hostname comparison.

    `LessonsService.allowedUrl` delegates to it with `repo.repos().map((r) => r.slug)`.
  - `IPC.prOpen = "pr:open"`, added to `INVOKE_CHANNELS`. The validator is `prUrlArg(raw: unknown): string`, a string of at most 2000 chars.
  - The `register.ts` handler `(url) => prLinks.open(url)` returns `{ ok: true } | { ok: false; reason: "bad_url" }`. It opens only when `prs.byUrl(prUrlKey(url)).length > 0 && isAllowedGithubUrl(url, prs.slugs())`, then calls `shell.openExternal`.
  - `api.prOpen(url: string)`.
  - `RepoStages`:
    - The PR number is a `<button className="pr-link link">` that calls `api.prOpen(row.prUrl)`.
    - It shows `row.slug` when set.
    - A no-PR row shows `S.prNoPrYet`.
    - The stage name is shown in the ticket tab.
  - `timelineText(e)`: for `e.kind === "report"` it returns `S.prTimeline.report(detail)` without the stage prefix. Other kinds are unchanged.
  - Strings, zh then en:
    - `prNoPrYet`: "进行中，还没有 PR" / "In progress, no PR yet"
    - `prTimeline.copilot_review`: "AI review（n 条评论）" / "AI review (n comments)"
    - `prArchived`: "已归档" / "Archived"

- [ ] **Step 1: Write the failing tests**

  `github-url.test.ts`:
  - accepts `https://github.com/a/b/pull/1`;
  - accepts `https://ghe.acme.io/t/a/pull/3` with known slug `ghe.acme.io/t/a`;
  - rejects `https://github.com@evil.com/a/b/pull/1`, `https://github.com.evil.com/a/b`, `https://evilgithub.com/a`, `http://github.com/a` and `https://user:pw@github.com/a`.

  `lessons-service.test.ts` (openSource): the enterprise host is accepted, and `@evil.com` and lookalikes are rejected through `act({ op: "openSource" })`.

  `validate.test.ts`: `prUrlArg` rejects non-strings and over-long values.

  `pr-stages-view.test.ts`: `a report entry has no stage prefix`.

  `pr-stages-render.test.ts` (renderToStaticMarkup, like `page-tabs-render.test.ts`):
  - `the ticket tab renders three PR rows newest first with clickable numbers`;
  - `a slug-only PR shows its slug`;
  - `the no-PR row says so`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/util/github-url.test.ts src/main/lessons/lessons-service.test.ts src/main/ipc/validate.test.ts src/renderer/src`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and verify they pass**

  `pnpm test`, `pnpm typecheck` and lint. Expected: PASS.

- [ ] **Step 5: Commit**

  `feat(ui): one row per PR with links, slugs and plain reports`

## Task 13: Feature and epic counts, archived tickets, empty states, contrast (D-6, D-7, D-14)

**Files:**
- Modify: `src/main/prwatch/pr-stages-service.ts` (+ test), `src/renderer/src/pr-stages-view.ts` (+ test), `src/renderer/src/components/PrStages.tsx`, `src/renderer/src/styles.css`, both string files
- Create: `src/renderer/src/styles-contrast.test.ts`

**Interfaces:**
- Produces:
  - `ticketMerged(t: Pick<Ticket, "status" | "statusManual">, prs: Pick<TicketPr, "state">[]): boolean` in `pr-stages-service.ts`. It is true when either:
    - `prs.length > 0 && prs.every(terminal) && prs.some(merged)`; or
    - `effectiveStatus(t) ∈ {merged_pending_followup, done}`.

    It fills `PrStagesTicket.merged`.
  - `epicPrSummary(tickets: PrStagesTicket[], featureOf: (ticketKey: string) => number | null): Map<number, EpicPrRow>`. It counts tickets, not rows: merged per `t.merged`, and active/failed/notStarted from the ticket's newest row.
  - The feature table has one row per ticket, showing the newest row's stages. It shows `S.prCount(n)` when the ticket has more than one PR and `S.prArchived` for archived tickets. Clicking opens the ticket.
  - Empty states:
    - a feature with no tickets → `S.prNoTickets`;
    - a ticket with `hasRepos === false` → a row with `S.prTicketNoRepos`;
    - an epic feature with 0 tickets shows `S.prNoTickets`, not `0/0`.
  - Strings, zh then en:
    - `prNoTickets`: "还没有 ticket" / "No tickets yet"
    - `prTicketNoRepos`: "这个 ticket 还没有仓库" / "This ticket has no repos"
    - `prCount(n)`: "`${n} 个 PR`" / "`${n} PRs`"

    `prNoRepos` stays for the ticket tab.
  - Light theme tokens in the first `:root` block:
    - `--stage-ok: #166534`
    - `--stage-accent: #1d4ed8`
    - `--stage-danger: #9a3412`
    - `--stage-muted: #5f5f5a`

    Dark theme: `--stage-*` equal to the existing `--ok/--accent/--danger/--muted`. `.pr-cell.*` and `.pr-closed` text uses `--stage-*`; the borders and backgrounds are unchanged. Measured: ok 5.37, accent 5.03, danger 5.42 on the 18% mixes, and muted 5.88 on the panel. Today's values are 3.71–4.32.

- [ ] **Step 1: Write the failing tests**

  `pr-stages-service.test.ts`:
  - `feature 1 shape: five merged_pending_followup tickets count 5/5, including one with no PRs`.
  - `all PRs closed, none merged, status active: not merged`.

  `pr-stages-view.test.ts`:
  - `epicPrSummary counts tickets, not PR rows`.
  - `an epic feature with no tickets has total 0`.

  `styles-contrast.test.ts`: read `styles.css` and parse the first `:root` block. For each `--stage-*` text colour, assert a WCAG ratio ≥ 4.5 against `--panel` and against `color-mix(<token> 18%, --bg)`. Use the same formula as the tokens' own colours, implemented in the test.

  `pr-stages-render.test.ts`:
  - `a feature with no tickets does not say 还没有仓库`;
  - `archived tickets show the tag`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/prwatch/pr-stages-service.test.ts src/renderer/src`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and verify they pass**

  `pnpm test` and `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

  `fix(ui): count merged tickets, include archived, readable stage colours`

## Task 14: Lessons: gh availability, daily failures, page counts, pendingCount (L)

**Files:**
- Modify: `src/main/tickets/gh.ts` (+ test), `src/main/lessons/lesson-runner.ts` (+ test), `src/main/db/lessons-repo.ts` (+ test), `src/main/lessons/lessons-service.ts` (+ test), `src/main/index.ts`

**Interfaces:**
- Produces:
  - `ghAvailable(): boolean` is true when the last `applyGhResolution` found a path, or when the cached probe succeeded.
  - `probeGh(timeoutMs: number): Promise<boolean>` runs `<ghBinary()> --version` and caches the result until the next `applyGhResolution`. index.ts calls it after each `applyGhResolution`.
  - The lessons `gh.available` and `ghAvailable` use `ghAvailable()`.
  - `daily()`:
    - It counts attempted and failed repos. When `attempted > 0 && failed === attempted`, it records `"failed"` with `"all repos failed"`.
    - The "already ran today" check now requires `lastStatus === "ok"`.
    - Repos that failed are retried on the next trigger.
  - `LessonRunner.process` calls `notify()` (in try/catch) after every item finishes: done, skipped or failed. The call at the end of `analyze` is removed.
  - `LessonsRepo.pendingCount(): number` runs `SELECT COUNT(*) FROM lessons WHERE status = 'pending'`, and `LessonsService.pendingCount` uses it.

- [ ] **Step 1: Write the failing tests**
  - `gh.test.ts`: `ghAvailable is false on macOS when gh is not on PATH and the probe fails`, and `true after a successful probe`.
  - `lesson-runner.test.ts`:
    - `daily with every repo failing records failed and runs again on the next call the same day`;
    - `a skipped analysis notifies`;
    - `a failed analysis notifies`.
  - `lessons-repo.test.ts`: `pendingCount counts pending lessons only`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/tickets/gh.test.ts src/main/lessons src/main/db/lessons-repo.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and verify they pass**

  Same command plus `pnpm typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

  `fix(lessons): real gh availability, honest daily status, fresh counts`

## Task 15: Lessons: repo discovery without needless writes or spawns (L)

**Files:**
- Modify: `src/main/lessons/lessons-service.ts` (+ test), `src/main/lessons/repo-identity.ts` (+ test), `src/main/index.ts` (`knownRepoPaths` SQL)

**Interfaces:**
- Produces:
  - `state()` reads `repo.repos()` once and calls `upsertRepo` only when the slug is missing or its `localPath` differs.
  - `LessonsServiceDeps.exists?: (p: string) => boolean` (default `existsSync`). Known paths that don't exist are skipped entirely: not resolved and not listed in `unknownRepos`.
  - The `knownRepoPaths` SQL excludes archived tickets:
    - `SELECT tr.repo_path FROM ticket_repos tr JOIN tickets t ON t.key = tr.ticket_key WHERE t.archived_at IS NULL`
    - plus a `UNION` with feature repos of unarchived features and epic repos of unarchived epics.

    `repoGroups` applies the same filter.
  - `RepoIdentity` deps gain `exists?: (p: string) => boolean`.
    - A missing path → `null`, not cached.
    - An existing path without `.git` → cached as not-git with no git spawn, and `resolve` gives `not_git`.
  - `defaultGit(path: string, exec = execFileSync): string | null` is exported for tests.

- [ ] **Step 1: Write the failing tests**
  - `lessons-service.test.ts`:
    - `state() does not upsert an unchanged repo` (spy on `upsertRepo`);
    - `state() skips paths that do not exist`.
  - `repo-identity.test.ts`:
    - `a path without .git is not spawned twice and resolves not_git`;
    - `a missing path is not cached`;
    - `defaultGit returns null on status 2 and throws on other errors`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/lessons`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and verify they pass**

  Same command. Expected: PASS.

- [ ] **Step 5: Commit**

  `fix(lessons): no writes or git spawns on every page refresh`

## Task 16: Lessons: confirm, product ops, UI cleanups (L)

**Files:**
- Modify: `src/main/lessons/lessons-service.ts` (+ test), `src/main/db/lessons-repo.ts` (+ test), `src/renderer/src/lessons-view.ts` (+ test), `src/renderer/src/components/LessonsPage.tsx`, both string files

**Interfaces:**
- Produces:
  - `confirm` returns `{ ok: false, reason: "bad_status" }` unless the lesson is `pending`.
  - `LessonsRepo.product(id: number): LessonProductView | null`.
  - `deleteProduct`, `addToProduct` and `removeFromProduct` return `not_found` for a missing product. `addToProduct` also returns `not_found` for a slug with no `lesson_repos` row.
  - `pruneLessonsUi` also takes `sel: LessonsSelection | null`. It becomes `null` when the selection is a product that no longer exists, or a repo no longer in `s.repos`. LessonsPage applies it.
  - Product membership rows use error and React keys `product-${p.id}-repo-${slug}`.
  - Remove `lessonsProducts` and `lessonsProductScope` from both string files.

- [ ] **Step 1: Write the failing tests**
  - `lessons-service.test.ts`:
    - `confirm on a rejected lesson returns bad_status and leaves it rejected`;
    - `deleteProduct on a missing id returns not_found`;
    - `addToProduct on a missing product returns not_found, not an FK error`.
  - `lessons-view.test.ts`:
    - `prune clears a selection whose product was deleted`;
    - `prune keeps a live repo selection`.
  - `strings.test.ts`: the existing key-parity test passes after the removal.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/lessons src/renderer/src/lessons-view.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and verify they pass**

  `pnpm test`, `pnpm typecheck` and lint (this catches unused imports). Expected: PASS.

- [ ] **Step 5: Commit**

  `fix(lessons): confirm only pending, product ops check existence, UI key fixes`

## Task 17: Lessons material: fixRange fallback and capped headers (L)

**Files:**
- Modify: `src/main/lessons/material.ts` (+ test), `src/main/lessons/lesson-runner.ts` (+ test), both main string files if the note is localized (`src/main/strings*.ts`)

**Interfaces:**
- Produces:
  - `Material` gains `fixesNote: "rewritten" | null`. In `analyze()`, when there are inline items with a path but `fixRange` returns null, it sets `fixesNote = "rewritten"` and logs it.
  - `render` prints one line under the fixes heading, saying that the fixes are unavailable because history was rewritten, from the localized material headings.
  - `ITEM_HEADER_MAX = 200`. Every `#### …` header line (items and fix filenames) passes through `cut(header, ITEM_HEADER_MAX)`.

- [ ] **Step 1: Write the failing tests**
  - `material.test.ts`:
    - `a 5000-char author or path is cut in the header`;
    - `the 1500-char body cap and the 4000-char patch cap hold`;
    - `a rewritten-history note renders when fixesNote is set`.
  - `lesson-runner.test.ts`: `inline comments with no fix range set fixesNote and still analyse`.

- [ ] **Step 2: Run and verify they fail**

  Run: `pnpm vitest run src/main/lessons/material.test.ts src/main/lessons/lesson-runner.test.ts`

  Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run and verify they pass**

  Same command. Expected: PASS.

- [ ] **Step 5: Commit**

  `fix(lessons): say when fixes are unavailable; cap item headers`

## Task 18: Fill the listed test gaps (L)

**Files (tests only, plus the one export from Task 15):**
- `src/main/lessons/tail.test.ts`
- `src/main/lessons/lesson-runner.test.ts`
- `src/main/lessons/select.test.ts`
- `src/main/sessions/feature-sessions.test.ts`
- `src/main/ipc/validate.test.ts`
- `src/main/lessons/lessons-service.test.ts`
- `src/main/lessons/analyze.test.ts`
- `src/renderer/src/components/lessons-page-render.test.ts` (create)

These are tests for existing behaviour, so they are expected to pass on the first run. A failure here is a bug: fix it in the same task and say so in the commit message.

- [ ] **Step 1: Write the tests**
  - `tail.test.ts`:
    - `an empty file gives no lines`;
    - `a tail starting inside a multi-byte character drops the partial character`.
  - `lesson-runner.test.ts`:
    - `rate-limit pause`: with `vi.useFakeTimers()`, after a `rate_limited` result nothing is taken before `RATE_LIMIT_PAUSE_MS` and the item is taken after `advanceTimersByTime(RATE_LIMIT_PAUSE_MS + 1000)`.
    - Rewrite `does not analyze an already analyzed PR again when the overlap returns it` (`:327`) so the `mergedPrs` mock returns the PR only when `after` equals `overlapped(cursor)`. Assert that the call's `after` is the cursor minus one hour.
  - `select.test.ts`: `equal rank: lower id first`.
  - `feature-sessions.test.ts`: `openFix for a stuck session without a ticket returns no_session`.
  - `validate.test.ts` (lessonActionArg): `every op accepts a valid payload`, covering confirm with and without text, reject, edit, setDisabled, delete, merge, createProduct, deleteProduct, addToProduct, removeFromProduct, backfill and openSource.
  - `lessons-service.test.ts`:
    - `setDisabled on a pending lesson returns bad_status`;
    - `disable then enable returns to confirmed`.
  - `analyze.test.ts`: replace the `as unknown as Material` cast (`:110`) with a typed `Material` fixture, including `fixesNote: null`.
  - `lessons-page-render.test.ts`: render `LessonsPage` pieces with `renderToStaticMarkup` where they take props. Interaction (select, prune, prefill) is covered by the pure `pruneLessonsUi` tests (Task 16) and `e2e/lessons.spec.ts`. Note this in the file header.
  - The `pr-watcher` case with a throwing onMerged is already covered by Task 4.

- [ ] **Step 2: Run them**

  Run: `pnpm vitest run src/main/lessons src/main/sessions/feature-sessions.test.ts src/main/ipc/validate.test.ts src/renderer/src`

  Expected: PASS, or a failure that exposes a real bug, which you fix.

- [ ] **Step 3: Run the full suite**

  `pnpm test`, `pnpm typecheck` and `pnpm exec eslint src e2e hook`. Expected: PASS.

- [ ] **Step 4: Commit**

  `test(lessons): cover the deferred gaps`

## Task 19: e2e with a fake gh, and a check against the real DB

**Files:**
- Create: `e2e/fake-gh/fake-gh.cjs`
- Modify: `e2e/fixtures.ts`, `e2e/pr-stages.spec.ts`
- Create: `src/main/prwatch/verify-real-db.test.ts` (skipped unless `SHIPHERD_VERIFY_DB` is set)

**Interfaces:**
- `fake-gh.cjs`:
  - On every call it reads `FAKE_GH_FIXTURE`, a JSON file path read fresh each time so tests can change it: `{ branches: Record<string, BranchPrFixture[]>, prs: Record<urlKey, PrViewFixture> }`. It appends `argv` to `FAKE_GH_LOG`.
  - It supports:
    - `--version`;
    - `pr list --head <b> --state all …` → `branches[b] ?? []`;
    - `pr view <url|branch> --json …` → `prs[prUrlKey(ref)]` or exit 1;
    - `run list …` → `[]`;
    - `api …` → empty output.

    Anything else exits 1.
- `makeSandbox({ gh?: FakeGhFixture })` writes `bin/gh` (an sh wrapper with the pinned node, like `bin/claude`) and the fixture file only when `gh` is given. It returns a `setGh(fixture)` helper. The tests skip on win32 (see the deviations).
- The sandbox repo gets `git remote add origin https://github.com/acme/app.git`, so slugs match.

- [ ] **Step 1: Write the e2e tests** in `e2e/pr-stages.spec.ts`
  - `three PRs: two sequential on the branch and one on another branch linked by handoff`:
    1. Create a feature with ticket `DMS-1` (repo `acme/app`, branch `feature/DMS-1`).
    2. Set up the fixture: `branches["feature/DMS-1"]` holds #1 MERGED and #2 MERGED, and `prs` holds #1, #2 and #3 (#3 MERGED, `headRefName` `other`).
    3. In the ticket session, `/handoff` with a fake handoff whose `prs` lists `https://github.com/acme/app/pull/3`. This needs a fake-claude variant: add a `FAKE_HANDOFF_PRS` env override in `fake-claude.cjs`.

    Expect: the ticket tab shows three rows (#3, #2, #1), and the feature tab shows `1/1` merged for the ticket with `3 个 PR`.
  - `backfill of an old merged ticket`:
    1. Launch, create ticket `OLD-1`, archive it, and close the app.
    2. Set the fixture to `branches["feature/OLD-1"]` with #9 MERGED, plus `prs` #9 with `createdAt`/`mergedAt` in 2025.
    3. In the sandbox DB, `DELETE FROM jobs WHERE name = 'pr_backfill'` (same DB access pattern as `e2e/lessons.spec.ts`).
    4. Relaunch and open the archived ticket.

    Expect: one row with merge done, design and self-review unknown, and the archived tag.

- [ ] **Step 2: Run and verify they fail before the fixture work**

  Run: `pnpm e2e:only e2e/pr-stages.spec.ts` (after `pnpm build && pnpm build:hook`).

  Expected: FAIL (no gh).

- [ ] **Step 3: Implement the fake gh and the fixtures. Make them pass.**

- [ ] **Step 4: Run the full verification**

  `pnpm typecheck`, `pnpm exec eslint src e2e hook`, `pnpm test` and `pnpm e2e`. Expected: all PASS.

- [ ] **Step 5: Run the real-DB check (manual, once; read-only copy)**

  `verify-real-db.test.ts`, guarded by `describe.skipIf(!process.env.SHIPHERD_VERIFY_DB)`:
  1. Open the DB at that path; `migrate`.
  2. Build the real `PrLinker`, run `runPrBackfill` with the real gh, and run three watcher rounds with real gh (no notify, no delivery).
  3. Assert:
     - `PrStagesService.view({ featureId: 1 })` has five tickets, all `merged`;
     - `view({ ticketKey: "BTL-190" })[0].rows` lists PR numbers `[29, 28, 27, 26, 25]`.

  Copy `~/.shipherd/app.db` (and `app.db-wal` if present) into the session scratchpad first, never the live file. Then run `SHIPHERD_VERIFY_DB=<copy> pnpm vitest run src/main/prwatch/verify-real-db.test.ts`.

  Expected: PASS. Record the output in the task report.

- [ ] **Step 6: Commit**

  `test(e2e): fake gh; per-PR rows, feature counts and backfill`. Do not commit any DB copy.

---

## Self-review notes

- **Spec coverage:**

  | Spec item | Task |
  |---|---|
  | core 1 | 1, 4 |
  | core 2 (branch) | 4 |
  | core 2 (handoff, gate) | 5 |
  | core 3 | 3, 4 |
  | core 4 | 7 |
  | core 5 | 9 |
  | core 6 | 9, 12, 13 |
  | D-1 | 8, 10 |
  | D-2 | 8 |
  | D-3, D-4, D-5, D-9 | 10 |
  | D-8, D-12, D-13 | 11 |
  | suspicions: mixed clocks | 4 |
  | suspicions: late first_commit, feature-level design | 10 |
  | suspicions: stance key | 11 |
  | C-V7, C-S3, C-S5, C-S7 | 4 |
  | C-V8 | 6 |
  | C-V9 | 5 |
  | C-S1 | 2, 12 |
  | C-S4 | 3 |
  | C-S6 | 8 |
  | C-V4, C-S2 | 3, 4 |
  | D-14 links | 12 |
  | D-14 contrast, empty states | 13 |
  | D-11 placement | 9 |
  | D-11 prefix | 12 |
  | D-6, D-7 | 13 |
  | L: gh, daily, notify, pendingCount | 14 |
  | L: state() writes, knownRepoPaths, non-git | 15 |
  | L: confirm, products, cleanups, strings | 16 |
  | L: fixRange, headers | 17 |
  | L: test gaps | 12 (openSource), 15 (defaultGit), 18 |
  | Verification | 19 |

- **Type names used across tasks:**
  - `TicketPr`, `TicketPrsRepo`, `BranchWatchRow`, `BranchWatchRepo`
  - `prUrlKey`, `prUrlParts`, `BranchTarget`, `PrPoll`, `CiItem`, `ObsScope`, `PrSnapshot`
  - `PrLinker`, `dedupeHandoffPrs`, `StatusContext`, `runPrBackfill`
  - `Scoped`, `ScopePr`, `assignToPrs`, `prEnd`, `PrStagesTicket`, `ticketMerged`
  - `isAllowedGithubUrl`, `ghAvailable`, `probeGh`, `MERGED_RECENT_MS`, `JOB_PR_BACKFILL`, `skillTrackingSince`
- **Open risks (also in the hand-off report):**
  - **gh rate limits.** The watcher's first rounds after the backfill read every never-read row, capped at 40 per round with 4 in parallel.
  - **Hook payload cost.** Agent hooks add one hook process per subagent dispatch, and payloads are trimmed in the hook binary.
  - **Old review agents.** Review agents are only seen from 2.1.0, so PRs between `skillTrackingSince` and 2.1.0 that were reviewed only by subagents still show self-review skipped.
  - **`skillTrackingSince` ignores a later hook uninstall.**
  - **`gh pr list --head` matches by branch name only.** It can list a fork PR with the same head name; such a PR links to the ticket.
  - **Linked open PRs without a handoff** don't change ticket status until a handoff exists.
