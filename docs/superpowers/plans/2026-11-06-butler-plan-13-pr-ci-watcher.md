# PR / CI 监视和自动递消息的规矩 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Butler 在后台用 `gh` 盯住每个进行中 ticket 的 PR 和 CI，CI 跑完把结果递给对应的 session，PR 状态变了更新 ticket；所有"Butler 自动往终端里输入"的动作共用一套更严格的规矩（多了"输入框里有草稿就不动"）。

**Architecture:** `PtyManager` 记下每个终端里用户有没有没发出去的草稿；`DeliveryGuard` 把"能不能自动往这个 session 里输入"的所有条件放在一处，合并总控的 `HoldWatcher` 也改用它。`PrWatcher` 按 ticket 的仓库和分支查 PR（没有 PR 就查分支的 workflow run），状态存进 `pr_watch` 表；PR 结论变了就写一条 refresh 类型的 handoff（复用现有的状态推导），CI 有了结论就通过 `DeliveryGuard` 把结果递给那个仓库的 session。session 的说明（"push 以后结束这一轮"）放进一个由 Butler 生成、用 `--append-system-prompt-file` 带给每个 Butler session 的文件。

**Tech Stack:** TypeScript、Electron 主进程、node:sqlite、`gh` CLI、vitest。

**Spec:** `docs/superpowers/specs/2026-11-06-now-page-and-token-savings-design.md`（"后台自动化""PR 和 CI""上下文换新"里关于草稿的一条）

## Global Constraints

- 全部是代码，不调模型。
- `gh` 没装、没登录、没网、超时：这个 PR 的状态记成"不可用"（`ci: "unknown"`），不抛错、不影响别的功能。每次 `gh` 调用超时 5 秒。
- 频率：有检查在跑、并且这个仓库的 session 开着的 PR，每 1 分钟查一次（`PR_FAST_MS = 60_000`）；其余每 5 分钟（`PR_SLOW_MS = 300_000`）；已合并、已关闭的不再查。同时跟踪的分支最多 `PR_WATCH_MAX = 40` 个，超出时优先保留 session 开着的。
- 失败日志取最后 60 行（`CI_LOG_LINES = 60`）。
- 自动输入的规矩（`DeliveryGuard`）：终端开着；session 停下来在等输入（`waitingForInput`）；活动是 `waiting` 或 `idle`；屏幕上没有权限确认或启动对话框；不在「需要你」里（计划 14 接上，本计划里默认 false）；用户 30 秒内没在这个终端打字（`USER_TYPING_QUIET_MS`，已有）；输入框里没有草稿。
- rebase、解决冲突不做自动化。
- 主进程文案中英两套（`src/main/strings.ts`）。
- macOS 和 Windows 都要能用：`gh` 用 `execFile`（不经过 shell），`windowsHide: true`。
- 新 migration 加在 `MIGRATIONS` 末尾。

## Review Focus

1. 用户在终端里打了半句话没发，然后去别的窗口待了 5 分钟：CI 结果不能递进去（否则半句话会连着一起发出去）→ Task 1 的测试 `typed text without enter is a draft`、Task 2 的测试 `blocks on a draft even after the quiet period`。
2. Claude Code 全屏模式下鼠标滚动会往 PTY 写 `\x1b[<64;10;5M` 这类鼠标报告：不能被当成草稿 → Task 1 的测试 `escape sequences are not a draft`。
3. CI 跑完时 session 正在忙：结果留着，等它下一次停下（Stop hook）再递，只递一次 → Task 6 的测试 `queues until the session stops`。
4. 同一个提交的 CI 重跑（re-run failed jobs）后变成通过：结论变了，要再递一次"通过了" → Task 6 的测试 `delivers again when the conclusion changes on the same sha`。
5. Butler 重启：已经递过的结论不再递 → Task 4 的测试 `delivered key survives a reopen`。

---

### Task 1: 终端草稿

**Files:**
- Modify: `src/main/sessions/pty-manager.ts`
- Test: `src/main/sessions/pty-manager.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // PtyManager
  /** 用户最后一次回车之后有没有打过可见字符（还没发出去）。Butler 的 prefill 也算草稿；deliver 不算。终端不在了返回 false。 */
  hasDraft(termId: string): boolean
  // 纯函数，导出给测试
  export function nextDraftLength(current: number, data: string): number
  ```

`nextDraftLength` 的规则：去掉 ESC 序列（CSI `\x1b[...`、OSC、SS3 `\x1bO.`，复用 `stripAnsi` 的正则，但 bracketed paste 的内容要计入：`\x1b[200~X\x1b[201~` 里 X 的可见字符数加上去）；逐字符处理剩下的：`\r` 或 `\n` → 0；`\x03`（Ctrl+C）、`\x15`（Ctrl+U）→ 0；`\x7f`、`\b` → 减 1（不低于 0）；其他控制字符忽略；可见字符加 1。`write()` 里 `draftLen = nextDraftLength(draftLen, data)`；`prefill()` 写入后 `draftLen = nextDraftLength(draftLen, text)`；`deliver()` 不改它（deliver 只在没有草稿时才会被调用，最后的回车也不经过 `write`）。

- [ ] **Step 1: 写失败的测试**

```ts
it("typed text without enter is a draft", () => { expect(nextDraftLength(0, "hel")).toBe(3); });
it("enter clears the draft", () => { expect(nextDraftLength(3, "lo\r")).toBe(0); });
it("backspace and ctrl-u shrink or clear it", () => { expect(nextDraftLength(2, "\x7f")).toBe(1); expect(nextDraftLength(5, "\x15")).toBe(0); });
it("escape sequences are not a draft", () => { expect(nextDraftLength(0, "\x1b[<64;10;5M\x1b[A\x1b[I")).toBe(0); });
it("pasted text counts", () => { expect(nextDraftLength(0, "\x1b[200~abc\x1b[201~")).toBe(3); });
it("hasDraft follows write and prefill", async () => { /* 用现有测试里的假 pty：write("ab") → true；write("\r") → false；prefill 之后 → true */ });
```

- [ ] **Step 2: 跑测试，确认失败** — Run: `pnpm vitest run src/main/sessions/pty-manager.test.ts` / Expected: FAIL
- [ ] **Step 3: 实现**（`Term` 加 `draftLen: number`，打开终端时为 0）
- [ ] **Step 4: 跑测试，确认通过** — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/pty-manager.ts src/main/sessions/pty-manager.test.ts
git commit -m "feat(pty): track unsent drafts in the prompt"
```

### Task 2: DeliveryGuard，合并总控改用它

**Files:**
- Create: `src/main/sessions/delivery-guard.ts`
- Modify: `src/main/gate/hold-watcher.ts`（deps 换成 guard）、`src/main/index.ts`（构造 guard，传给 HoldWatcher）
- Test: `src/main/sessions/delivery-guard.test.ts`、`src/main/gate/hold-watcher.test.ts`（改用新 deps）

**Interfaces:**
- Consumes: `PtyManager.hasDraft`（Task 1）、`pty.lastUserInputAt`、`pty.screenNeedsUser`、`sessions.head`、`activity(id)`
- Produces:
  ```ts
  export type DeliveryBlock = "closed" | "busy" | "screen" | "needs_you" | "typing" | "draft";
  export interface DeliveryGuardDeps {
    /** 跑着这个 session（链上任何一个 id）的终端；没有为 null。index.ts 里就是现在的 gateTerm。 */
    termOf(sessionId: string): string | null;
    head(sessionId: string): Session | null;
    activity(sessionId: string): SessionActivity | null;
    pty: Pick<PtyManager, "lastUserInputAt" | "screenNeedsUser" | "hasDraft">;
    /** 计划 14 接上「需要你」；没接时恒为 false。 */
    needsYou?: (headId: string) => boolean;
    typingQuietMs?: number;
    now(): number;
  }
  export class DeliveryGuard {
    constructor(d: DeliveryGuardDeps)
    check(sessionId: string): { ok: true; termId: string; headId: string } | { ok: false; block: DeliveryBlock }
  }
  ```

`busy`：`head.waitingForInput` 不是 true，或者活动不是 `waiting`/`idle`（活动还没读到时算 busy）。`HoldWatcherDeps` 去掉 `isWaiting`、`lastUserInput`、`typingQuietMs`，加 `guard: Pick<DeliveryGuard, "check">`；`isOpen` 保留（判断"关着就留着"）。`notice()` 里原来的 `isWaiting` 和打字检查换成 `guard.check(n.sessionId).ok`。e2e 用的 `BUTLER_GATE_TYPING_QUIET_MS` 改成传给 `DeliveryGuard` 的 `typingQuietMs`。

- [ ] **Step 1: 写失败的测试**（每个 block 一个用例，再加一个全部满足返回 ok）

```ts
it("blocks on a draft even after the quiet period", () => { /* lastUserInputAt 很久以前、hasDraft true → { ok:false, block:"draft" } */ });
it("blocks while the user typed in the last 30 seconds", () => {});
it("blocks while a permission prompt is on screen", () => {});
it("blocks when the session is busy or its activity is unknown", () => {});
it("blocks when needsYou says so", () => {});
it("passes and returns the terminal when everything is quiet", () => {});
```

- [ ] **Step 2: 跑测试，确认失败**
- [ ] **Step 3: 实现 `DeliveryGuard`，改 `HoldWatcher`，改 `index.ts`**
- [ ] **Step 4: 跑测试** — Run: `pnpm vitest run src/main/sessions src/main/gate` / Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/delivery-guard.ts src/main/sessions/delivery-guard.test.ts src/main/gate/hold-watcher.ts src/main/gate/hold-watcher.test.ts src/main/index.ts
git commit -m "feat(sessions): one guard for every automatic delivery, including drafts"
```

### Task 3: gh 查询

**Files:**
- Modify: `src/main/tickets/gh.ts`
- Test: `src/main/tickets/gh.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CiState = "pending" | "passing" | "failing" | "none" | "unknown";
  export interface CiCheck { name: string; state: "pending" | "passing" | "failing"; runId: number | null; /** 失败日志的末尾，PrWatcher 填（Task 5）。 */ log?: string }
  export interface PrStatus {
    number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED"; isDraft: boolean;
    review: "pending" | "changes_requested" | "approved" | null;   // 由 reviewDecision 换算：REVIEW_REQUIRED→pending
    headSha: string; checks: CiCheck[]; ci: CiState;
  }
  export interface BranchRuns { headSha: string; checks: CiCheck[]; ci: CiState }
  /** gh pr view <branch> --json number,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup；没有 PR 或失败返回 null。 */
  export function prStatus(cwd: string, branch: string, timeoutMs: number): Promise<PrStatus | null>
  /** gh run list --branch <branch> --limit 20 --json databaseId,headSha,status,conclusion,workflowName；只看最新的 headSha。没有 run 返回 null。 */
  export function branchRuns(cwd: string, branch: string, timeoutMs: number): Promise<BranchRuns | null>
  /** gh run view <runId> --log-failed，取最后 lines 行；失败返回 null。 */
  export function failedLog(cwd: string, runId: number, lines: number, timeoutMs: number): Promise<string | null>
  /** 纯函数：statusCheckRollup 的数组 → CiCheck[]。CheckRun 看 status/conclusion，StatusContext 看 state；runId 从 detailsUrl 的 /actions/runs/<id> 取。 */
  export function checksOf(rollup: unknown): CiCheck[]
  /** 有 failing → failing；否则有 pending → pending；有检查 → passing；空 → none。 */
  export function ciOf(checks: CiCheck[]): CiState
  ```

`conclusion` 里 `SUCCESS`、`NEUTRAL`、`SKIPPED` 算 passing；`FAILURE`、`TIMED_OUT`、`CANCELLED`、`ACTION_REQUIRED`、`STARTUP_FAILURE` 算 failing；`status` 不是 `COMPLETED` 算 pending。StatusContext 的 `SUCCESS` passing，`PENDING`/`EXPECTED` pending，`FAILURE`/`ERROR` failing。

- [ ] **Step 1: 写失败的测试**（`checksOf`、`ciOf` 用固定的 JSON；三个 exec 函数照现有 `prInfo` 的测试写法 mock `execFile`）

```ts
it("maps check runs and status contexts", () => { /* 一个 CheckRun FAILURE detailsUrl .../actions/runs/123/job/9 → {state:"failing", runId:123}；一个 StatusContext PENDING → pending */ });
it("ciOf prefers failing over pending", () => {});
it("prStatus returns null when there is no PR", async () => {});
it("branchRuns keeps only the newest head sha", async () => {});
it("failedLog returns the last lines", async () => {});
```

- [ ] **Step 2: 跑测试，确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 真实输出核对**

Run（在任意一个有 PR 和 Actions 的仓库里）：`gh pr view --json number,url,state,isDraft,reviewDecision,headRefOid,statusCheckRollup | head -c 3000` 和 `gh run list --limit 3 --json databaseId,headSha,status,conclusion,workflowName`
Expected: 字段名和 `checksOf` 处理的一致（`__typename`、`status`、`conclusion`、`detailsUrl`、`context`、`state`）。不一致就以真实输出为准改代码和测试。

- [ ] **Step 5: 跑测试，确认通过** — Run: `pnpm vitest run src/main/tickets/gh.test.ts` / Expected: PASS
- [ ] **Step 6: Commit**

```bash
git add src/main/tickets/gh.ts src/main/tickets/gh.test.ts
git commit -m "feat(gh): PR status with checks, branch runs and failed logs"
```

### Task 4: pr_watch 表

**Files:**
- Modify: `src/main/db/migrations.ts`
- Create: `src/main/db/pr-watch-repo.ts`
- Modify: `src/shared/types.ts`（`WatchedPr`）
- Test: `src/main/db/pr-watch-repo.test.ts`

**Interfaces:**
- Consumes: `CiState`、`CiCheck`（Task 3）
- Produces:
  ```ts
  // src/shared/types.ts（渲染进程也用）
  export interface WatchedPr {
    ticketKey: string; repoId: number; repoPath: string; branch: string;
    number: number | null; url: string | null;
    state: "open" | "merged" | "closed" | null;          // 没有 PR 为 null
    review: "pending" | "changes_requested" | "approved" | null;
    ci: "pending" | "passing" | "failing" | "none" | "unknown";
    headSha: string | null;
    checkedAt: number;
  }
  // src/main/db/pr-watch-repo.ts
  export interface PrWatchRow extends WatchedPr { failed: CiCheck[]; deliveredKey: string | null }
  export class PrWatchRepo {
    constructor(db: Db)
    upsert(r: Omit<PrWatchRow, "deliveredKey">): void   // 不动 deliveredKey
    get(repoId: number): PrWatchRow | null
    byTicket(ticketKey: string): PrWatchRow[]
    all(): PrWatchRow[]
    setDelivered(repoId: number, key: string): void
    remove(repoId: number): void
  }
  ```

```sql
CREATE TABLE pr_watch (
  repo_id INTEGER PRIMARY KEY REFERENCES ticket_repos(id),
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
```

- [ ] **Step 1: 写失败的测试**

```ts
it("upserts without touching the delivered key", () => {});
it("delivered key survives a reopen", () => { /* 用 tempDir 下的文件数据库 openDatabase 两次 */ });
it("lists by ticket", () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/db/pr-watch-repo.test.ts`）
- [ ] **Step 5: Commit**

```bash
git add src/main/db/migrations.ts src/main/db/pr-watch-repo.ts src/main/db/pr-watch-repo.test.ts src/shared/types.ts
git commit -m "feat(pr-watch): pr_watch table"
```

### Task 5: PrWatcher 轮询和 ticket 状态

**Files:**
- Create: `src/main/prwatch/pr-watcher.ts`
- Test: `src/main/prwatch/pr-watcher.test.ts`

**Interfaces:**
- Consumes: Task 3、Task 4；`ingestHandoff` 的包装 `ingest`（index.ts 里已有的那个）、`handoffs.latestValid`
- Produces:
  ```ts
  export const PR_FAST_MS = 60_000, PR_SLOW_MS = 300_000, PR_WATCH_MAX = 40, PR_GH_TIMEOUT_MS = 5000, CI_LOG_LINES = 60;
  export interface PrTarget { ticketKey: string; repoId: number; repoPath: string; cwd: string; branch: string; sessionOpen: boolean }
  export interface PrWatcherDeps {
    repo: PrWatchRepo;
    /** 要查的分支：未归档 ticket 的每个仓库，条件是这个仓库的 session 开着，或者 pr_watch 里它的 PR 还开着、或还没查过但 ticket 最新 handoff 里有开着的 PR。 */
    targets(): PrTarget[];
    gh: { prStatus: typeof prStatus; branchRuns: typeof branchRuns; failedLog: typeof failedLog };
    /** PR 的状态或 review 变了：把这个 ticket 所有仓库的 PR 写成一条 refresh handoff。 */
    onPrChanged(ticketKey: string): void;
    /** CI 有了新的结论（Task 6 接上）。 */
    onCiSettled(row: PrWatchRow): void;
    notify(): void;
    now(): number;
    log(msg: string, err?: unknown): void;
  }
  export class PrWatcher {
    constructor(d: PrWatcherDeps)
    start(tickMs?: number): void   // 默认 15_000：每 15 秒看一遍谁到期了
    stop(): void
    /** 立刻查这个仓库（session 刚 push、Stop 时用）。 */
    soon(repoId: number): void
    statusOf(ticketKey: string): WatchedPr[]
    /** 给 HoldWatcher 用：PR url 对应的、60 秒内查过的状态；没有为 null。 */
    cachedByUrl(url: string): PrWatchRow | null
  }
  /** 纯函数：一个仓库下次该查的时间。 */
  export function nextCheckAt(row: PrWatchRow | null, sessionOpen: boolean): number
  ```

一个仓库查一次：先 `prStatus(cwd, branch)`；有 PR 就用它；没有 PR 就 `branchRuns(cwd, branch)`（state 记 null）。两者都失败时 `ci: "unknown"`，其余字段沿用上次的。`ci === "failing"` 时对每个有 `runId` 的失败检查（最多 3 个）取 `failedLog`，填进它的 `log`，存进 `failed`。和上次比：`state` 或 `review` 变了 → `onPrChanged`；`ci` 从 `pending`/`unknown` 变成 `passing`/`failing`，或者同一个 `headSha` 下结论变了 → `onCiSettled`。PR 合并或关闭后从 targets 自然消失，行保留给页面显示。

index.ts 里的 `onPrChanged`：取 `handoffs.latestValid(key)?.payload`，没有就跳过；有就 `ingest({ ticketKey, sessionId: null, trigger: "refresh", payload: { ...payload, done_today: [], prs }, rawText: null, sourceRef: \`prwatch:${key}:${签名}\` })`，`prs` 由这个 ticket 在 `pr_watch` 里有 PR 的行换算（`state` 小写、`review`），签名是这些 PR 的 `number:state:review` 拼起来。这样 ticket 状态、ticket 页的 PR 标签、worktree 合并后清理都沿用现有逻辑。

- [ ] **Step 1: 写失败的测试**（假 gh、假 repo、固定的 now）

```ts
it("checks fast while checks run and the session is open, slow otherwise", () => { /* nextCheckAt */ });
it("falls back to branch runs when there is no PR", async () => {});
it("keeps old fields and marks ci unknown when gh fails", async () => {});
it("calls onPrChanged when state or review changes", async () => {});
it("calls onCiSettled once when checks finish", async () => {});
it("delivers again when the conclusion changes on the same sha", async () => { /* failing → (re-run) passing，同一个 headSha → onCiSettled 两次 */ });
it("fetches at most three failed logs", async () => {});
it("caps the number of watched branches, preferring open sessions", async () => {});
```

- [ ] **Step 2: 跑测试，确认失败** — Run: `pnpm vitest run src/main/prwatch` / Expected: FAIL
- [ ] **Step 3: 实现**
- [ ] **Step 4: 跑测试，确认通过** — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/main/prwatch src/main/tickets/gh.ts
git commit -m "feat(pr-watch): poll PR and CI state per ticket branch"
```

### Task 6: 把 CI 结果递给 session

**Files:**
- Create: `src/main/prwatch/ci-delivery.ts`
- Modify: `src/main/strings.ts`（`ciPassedNotice`、`ciFailedNotice`，中英）
- Test: `src/main/prwatch/ci-delivery.test.ts`

**Interfaces:**
- Consumes: `DeliveryGuard`（Task 2）、`PrWatchRepo`（Task 4）、`sanitizeTask`（`src/shared/control.ts`）
- Produces:
  ```ts
  export class CiDelivery {
    constructor(d: {
      repo: PrWatchRepo;
      guard: Pick<DeliveryGuard, "check">;
      /** 这个 ticket 这个仓库自己的 session（不算总控），终端开着的那个的 head id；没有为 null。 */
      sessionFor(ticketKey: string, repoId: number): string | null;
      deliver(termId: string, text: string): Promise<"sent" | "exited" | "timeout">;
      now(): number; log(msg: string, err?: unknown): void;
    })
    /** PrWatcher.onCiSettled：试着递一次，不行就留着。 */
    settled(row: PrWatchRow): Promise<void>
    /** Stop hook 和每轮 PrWatcher 之后调：把所有待递的过一遍。 */
    flush(): Promise<void>
  }
  /** 递过的标记：`${headSha}:${ci}`。待递 = ci 是 passing/failing 且标记和 deliveredKey 不同。 */
  export function deliveryKey(row: Pick<PrWatchRow, "headSha" | "ci">): string
  ```

文案（中文版，英文照译）：

- 通过：`Butler：{where} 的 CI 全部通过（{sha 前 7 位}）。可以继续下一步。`
- 失败：`Butler：{where} 的 CI 失败（{sha 前 7 位}）。失败的检查：{名字，逗号分隔}。\n\n{每个失败检查：名字 + 日志最后 60 行，用 \`\`\` 包起来}\n\n请修复后再 push。push 以后结束这一轮，Butler 会再告诉你结果。`
- `{where}`：有 PR 时 `PR #{number}`，没有时 `分支 {branch}`。

session 关着：不递、不标记（重新打开、再停下时 `flush` 会递）。标记只在 `deliver` 返回 `sent` 后写。同一个 session 同时只递一条。

- [ ] **Step 1: 写失败的测试**

```ts
it("delivers a failure with the failed checks and log tails", async () => {});
it("queues until the session stops", async () => { /* guard 先返回 busy → 不递；flush 时 guard ok → 递一次 */ });
it("does not deliver twice for the same key", async () => {});
it("does nothing when the repo has no open session", async () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/prwatch`）
- [ ] **Step 5: Commit**

```bash
git add src/main/prwatch/ci-delivery.ts src/main/prwatch/ci-delivery.test.ts src/main/strings.ts
git commit -m "feat(pr-watch): hand finished CI results to the session"
```

### Task 7: session 说明文件

**Files:**
- Create: `src/main/claude/session-guide.ts`
- Modify: `src/main/claude/spawn.ts`（`claudeArgs` 加 `guidePath`）、`src/main/sessions/session-service.ts`（ticket、feature、epic、修复四种 session 打开时都带上）
- Test: `src/main/claude/session-guide.test.ts`、`src/main/claude/spawn.test.ts`

**Interfaces:**
- Produces（计划 15、16 往里加段落）：
  ```ts
  export type GuideKind = "ticket" | "coordinator";
  /** 每段一个函数，按语言返回一段文字；计划 15、16 往 SECTIONS 里加。 */
  export const GUIDE_SECTIONS: Array<(lang: Lang, kind: GuideKind) => string | null>;
  export function sessionGuide(lang: Lang, kind: GuideKind): string
  /** 写到 <mcpDir>/guide-<kind>-<lang>.md（内容没变就不重写），返回路径。 */
  export function writeSessionGuide(mcpDir: string, lang: Lang, kind: GuideKind): string
  // claudeArgs 的 req 加 guidePath?: string → 追加 "--append-system-prompt-file", guidePath
  ```

本计划只加一段 CI 的：

- 中文：`Butler 会在后台盯着你的 PR 和 CI。push 之后不要循环查 CI（不要 gh run watch、gh pr checks --watch、sleep 轮询），直接结束这一轮；CI 跑完后 Butler 会把结果发给你。`
- 英文照译。

路径交给 `configPath(...)` 处理（Windows 上经过 cmd shim 时路径含空格的情况，沿用现有的写法）。

- [ ] **Step 1: 写失败的测试**（`sessionGuide("zh","ticket")` 含"不要循环查 CI"；`claudeArgs({..., guidePath:"/g.md"})` 以 `"--append-system-prompt-file","/g.md"` 结尾之前的位置出现；`writeSessionGuide` 内容不变时不改 mtime）
- [ ] **Step 2–4: 失败 → 实现 → 通过**
- [ ] **Step 5: 用真实的 claude 验证交互模式认这个参数**

Run: `printf '你收到的附加说明里第一句话是什么？只回答那句话。' > /tmp/q.txt; claude --append-system-prompt-file <写出的 guide 路径> -p "$(cat /tmp/q.txt)"`，然后在 `pnpm dev` 里开一个 session 问同样的问题。
Expected: 两次都能复述 CI 那句话。交互模式不认的话停下来，在计划里记下，改用 `--append-system-prompt "<内容>"`（内容不含换行以外的特殊字符，Windows 上要确认 cmd shim 能安全传递，不能就跳过这个参数并记日志）。

- [ ] **Step 6: Commit**

```bash
git add src/main/claude/session-guide.ts src/main/claude/session-guide.test.ts src/main/claude/spawn.ts src/main/claude/spawn.test.ts src/main/sessions/session-service.ts
git commit -m "feat(sessions): Butler session guide via --append-system-prompt-file"
```

### Task 8: 接进主进程，早上的刷新改用监视数据

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/gate/hold-watcher.ts`（`prInfo` 前先看 `cachedByUrl`）
- Modify: `src/main/schedule/daily-jobs.ts`（`morningJob`）
- Modify: `src/main/ipc/register.ts`、`src/shared/ipc.ts`、`src/renderer/src/api.ts`（`IPC.prWatchList = "prwatch:list"` → `WatchedPr[]`，计划 14 用）
- Test: `src/main/schedule/daily-jobs.test.ts`、`src/main/gate/hold-watcher.test.ts`

**Interfaces:**
- Consumes: Task 1–7
- Produces（给计划 14）：`api.prWatchList(): Promise<WatchedPr[]>`；主进程里的 `prWatcher`、`ciDelivery`、`deliveryGuard`

接线要点：
- `targets()`：遍历 `tickets.list()`（未归档）的每个 `repo`，`cwd = ticketService.workDir(repo)`，`sessionOpen = sessionService.hasRepoTerminal(t.key, repo.id)`。
- `sessionFor(key, repoId)`：`pty.openIds()` 里 head 的 `ticketKey === key && repoId === repoId && !coordinator` 的那个 head id。
- inbox 的 `handle` 里，`effect.kind === "waiting" && effect.waiting` 时，在 `holdWatcher.sessionIdle` 旁边加 `void ciDelivery.flush()`，并且对这个 session 的仓库 `prWatcher.soon(repoId)`（刚停下的 session 常常刚 push）。
- `morningJob`：去掉 PR 部分的意义——`refreshForBrief` 只在 `trackerTools(settings).length > 0`（`runner.ts` 的 `allowedTools()` 用的同一个函数）时才跑，没配 tracker 工具就跳过。`DailyJobDeps` 加 `hasTrackerTools: () => boolean`。
- `start()` 放在 `holdWatcher.start` 后面，`will-quit` 里 `stop()`。

- [ ] **Step 1: 改 `morningJob` 的测试**（没配 tracker 工具 → 不调 `refreshForBrief`）并实现
- [ ] **Step 2: `HoldWatcher` 优先用缓存的测试**（`cachedByUrl` 返回 MERGED → 不调 `prInfo`）并实现
- [ ] **Step 3: 接 `index.ts` 和 IPC**
- [ ] **Step 4: 全部测试和类型检查** — Run: `pnpm typecheck && pnpm test` / Expected: 全部通过
- [ ] **Step 5: 真机验证**

在 `pnpm dev` 里打开一个有 PR 的 ticket session（可以用这个仓库自己，开一个测试分支、开一个 draft PR），让它 push 一个会让 CI 失败的提交然后结束这一轮。
Expected: 几分钟内 `sqlite3 ~/.butler/app.db "select branch, state, ci, delivered_key from pr_watch"` 看到 `failing`，session 里收到"CI 失败"的消息，带失败的检查名和日志；在终端里先打几个字不回车，再让 CI 结束，确认消息等到草稿发出去或清掉之后才来。

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/main/gate/hold-watcher.ts src/main/gate/hold-watcher.test.ts src/main/schedule/daily-jobs.ts src/main/schedule/daily-jobs.test.ts src/main/ipc/register.ts src/shared/ipc.ts src/renderer/src/api.ts
git commit -m "feat(pr-watch): wire the PR/CI watcher into Butler"
```
