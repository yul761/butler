# 合并总控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Butler 打开的 session 要合并（或在共用目录里切 branch）时，先由 Butler 主进程用 git 判断会不会和别的进行中的 ticket 撞车，撞车就定顺序、压住后来的一方，事后通知用户。

**Architecture:** 每个 Butler session 的 `--settings` 文件里加 `PreToolUse` / `PostToolUse` 两个 Bash hook，命令是 `"<butler-hook>" gate`。hook 先在本地识别命令，只有合并、推到目标分支、共用目录里切 branch 才走文件通道（复用 `ControlInbox`，单独一对目录）问主进程。主进程的 `MergeGate` 用 `git merge-tree` 算冲突，在数据库里记合并占位、等待者和事件；一个 30 秒的定时检查释放已合并的占位，往等待的 session 里发“可以合了”。首页加一节“合并协调”，系统通知点进对应的 ticket。

**Tech Stack:** TypeScript、Electron 主进程、node:sqlite（`src/main/db`）、Node SEA hook（`hook/`）、React 渲染进程、vitest、Playwright e2e + 假 claude。

**Spec:** `docs/superpowers/specs/2026-11-04-merge-coordinator-design.md`

## Global Constraints

- 失败时放行：Butler 没开着、请求 5 秒内没有结果、hook 出错，一律放行（hook 退出码 0、不输出任何决定）。
- 不需要审核的命令不发请求、不等待：hook 在本地识别完就退出。
- 用户全局的 `~/.claude/settings.json` 不加 gate hook；只写进 Butler 自己的 `--settings` 文件。`isButlerHook` 的匹配规则不变。
- 只判断 git 看得见的冲突，不让模型判断，不自动 rebase、不自动解决冲突。
- 合并前 `git fetch` 目标分支最多 2 秒，`gh pr view` 最多 2 秒；失败就用本地已有的数据，不因此拦人。
- 合并占位跟着真正的合并走；`gh` 查不了时占位最多 2 小时（`HOLD_MAX_MS = 2 * 60 * 60_000`）。
- 定时检查间隔 30 秒（`HOLD_CHECK_MS = 30_000`），只查占位中的。
- 文案中英两套：渲染进程 `strings.ts` / `strings-en.ts`，主进程 `src/main/strings.ts` 的 ZH / EN。
- 测试不抢焦点（e2e 窗口在后台打开，沿用 `e2e/fixtures.ts`）。
- 发布：一个 feature branch 一个 PR，直接合并（memory: release-via-feature-branch-pr）。这次和已经提交的 epic 列表收起、终端滚动修复一起发，版本 1.6.0。

## Review Focus

1. `cd /path/to/repo && gh pr merge 12 --squash`、`git -C <dir> merge feat/x`、`FOO=1 git merge x`：带前缀的写法要认出来，并且用前缀里的目录当仓库 → Task 1 的测试。
2. Butler 没开着，或者留下的 `alive.json` 里的 pid 已经不在了：hook 要立刻放行，不能等满 5 秒 → Task 3 的测试。
3. feature 总控（没有 `BUTLER_TICKET`）替 ticket 执行 `gh pr merge`：按 PR 的 head branch 找到 ticket，规则照常生效 → Task 6 的测试。
4. 要合并的 branch 不属于任何 Butler ticket（用户自己的 branch）：照样和进行中的 ticket branch 比，冲突时同样处理，事件里显示 branch 名 → Task 6 的测试。
5. Butler 重启时还有占位和等待者：重启后定时检查接着跑，对方合完后等待者照样收到通知 → Task 7 的测试。

---

### Task 1: 识别要审核的命令

**Files:**
- Create: `src/shared/gate-command.ts`
- Test: `src/shared/gate-command.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GateAction =
    | { kind: "pr_merge"; dir: string | null; pr: string | null }      // gh pr merge [pr]；pr 是号码、URL 或 branch，省略为 null
    | { kind: "local_merge"; dir: string | null; source: string }      // git merge <source>（目标 = 当前分支，主进程判断）
    | { kind: "push"; dir: string | null; target: string }             // git push <remote> <src>:<dst> 或 <remote> <branch>，target 是推到的远端分支名
    | { kind: "switch"; dir: string | null; branch: string; create: boolean }; // git checkout [-b] / git switch [-c]
  export function classifyGateCommand(command: string): GateAction | null;
  ```
  `dir` 是命令里 `cd <dir> &&` 或 `git -C <dir>` 给的目录（原样，可能是相对路径），没有就是 null。命令被 `&&`、`;`、`||`、`|`、换行分成几段时，返回第一段要审核的。

- [ ] **Step 1: 写测试 `classifyGateCommand`**

  ```ts
  expect(classifyGateCommand("gh pr merge 12 --squash")).toEqual({ kind: "pr_merge", dir: null, pr: "12" });
  expect(classifyGateCommand("gh pr merge --auto --squash")).toEqual({ kind: "pr_merge", dir: null, pr: null });
  expect(classifyGateCommand("cd /w/backend && gh pr merge https://github.com/a/b/pull/7")).toEqual({ kind: "pr_merge", dir: "/w/backend", pr: "https://github.com/a/b/pull/7" });
  expect(classifyGateCommand("git -C ../frontend merge feat/x --no-ff")).toEqual({ kind: "local_merge", dir: "../frontend", source: "feat/x" });
  expect(classifyGateCommand("FOO=1 git merge dms-2")).toEqual({ kind: "local_merge", dir: null, source: "dms-2" });
  expect(classifyGateCommand("git push origin HEAD:main")).toEqual({ kind: "push", dir: null, target: "main" });
  expect(classifyGateCommand("git push origin main")).toEqual({ kind: "push", dir: null, target: "main" });
  expect(classifyGateCommand("git push -u origin dms-1")).toEqual({ kind: "push", dir: null, target: "dms-1" });
  expect(classifyGateCommand("git checkout -b dms-3")).toEqual({ kind: "switch", dir: null, branch: "dms-3", create: true });
  expect(classifyGateCommand("git switch dms-1")).toEqual({ kind: "switch", dir: null, branch: "dms-1", create: false });
  expect(classifyGateCommand("pnpm test && git merge x")).toEqual({ kind: "local_merge", dir: null, source: "x" });
  // 不审核
  for (const c of ["git status", "git push", "git merge --abort", "git merge --continue",
    "git checkout -- src/a.ts", "git checkout .", "git checkout HEAD~1 -- a.ts", "gh pr view 12", "gh pr create", "echo 'git merge x'", "git log --merges"])
    expect(classifyGateCommand(c)).toBeNull();
  ```
  没写远端分支的 `git push` 返回 null（推的是自己的 branch）；写了的一律返回 target，是不是目标分支由主进程判断（Task 6）。引号里的文字（`echo 'git merge x'`）不算命令。

- [ ] **Step 2: 跑测试确认失败** — `pnpm vitest run src/shared/gate-command.test.ts`，预期 FAIL（模块不存在）。
- [ ] **Step 3: 实现 `classifyGateCommand`** — 简单的 shell 分词（处理单双引号、反斜杠），按分隔符切段，每段跳过开头的 `VAR=value` 和 `cd <dir>`（记下 dir，作用到后面的段），再看 `git [-C dir] <sub>` / `gh pr merge`。认不准的返回 null。
- [ ] **Step 4: 跑测试确认通过** — 同上命令，预期 PASS。
- [ ] **Step 5: Commit** — `git commit -m "feat: recognise the commands the merge coordinator reviews"`

### Task 2: 请求格式和收件箱

**Files:**
- Create: `src/shared/gate.ts`、`src/shared/gate.test.ts`
- Modify: `src/main/control/control-inbox.ts`（加 `parse` 选项）、`src/main/control/control-inbox.test.ts`
- Modify: `src/main/paths.ts`、`src/main/paths.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GateAction`。
- Produces:
  ```ts
  // src/shared/gate.ts
  export const GATE_VERSION = 1;
  export const GATE_WAIT_MS = 5000;
  export type GateRequest =
    | { v: 1; phase: "pre"; action: GateAction; cwd: string; session: string | null; ticket: string | null }
    | { v: 1; phase: "post"; action: GateAction; cwd: string; session: string | null; ticket: string | null };
  export type GateResult = { v: 1; decision: "allow" } | { v: 1; decision: "deny"; reason: string };
  export function parseGateRequest(raw: unknown): GateRequest | null;
  // src/main/paths.ts 的 ButlerPaths 新增
  gateRequests: string;  // <home>/gate/requests
  gateResults: string;   // <home>/gate/results
  gateAlive: string;     // <home>/gate/alive.json，内容 { pid: number }
  // ControlInbox 变成泛型
  export class ControlInbox<Req = ControlRequest, Res = ControlResult> // 选项新增 parse?: (raw: unknown) => Req | null（默认 parseControlRequest）、badResult?: () => Res
  ```
- [ ] **Step 1: 写测试** — `parseGateRequest` 接受合法的 pre/post 请求；拒绝 `v` 不对、`action.kind` 不认识、`cwd` 不是绝对路径、字符串超过 4096 的请求（返回 null）。`ControlInbox` 用自定义 `parse` 时把解析结果交给 `handle`，解析失败写 `badResult()`。`resolvePaths` 给出 `gate/requests`、`gate/results`、`gate/alive.json`；`ensureDirs` 建好两个目录。
- [ ] **Step 2: 跑测试确认失败** — `pnpm vitest run src/shared/gate.test.ts src/main/control/control-inbox.test.ts src/main/paths.test.ts`。
- [ ] **Step 3: 实现** — 现有的总控请求行为不变（不传 `parse` 时一切照旧）。
- [ ] **Step 4: 跑测试确认通过**，并跑 `pnpm vitest run src/main/control` 确认原有测试没坏。
- [ ] **Step 5: Commit** — `git commit -m "feat: gate request format and a reusable request inbox"`

### Task 3: hook 的 gate 模式

**Files:**
- Create: `hook/gate.ts`、`hook/gate.test.ts`
- Modify: `hook/entry.ts`（`process.argv[2] === "gate"` 时走 `runGate`，否则照旧）、`hook/entry.test.ts`

**Interfaces:**
- Consumes: Task 1 `classifyGateCommand`，Task 2 `GateRequest` / `GateResult` / `GATE_WAIT_MS`，`dirFromEnv`（`src/main/paths.ts`）。
- Produces:
  ```ts
  export interface GateDeps { now(): number; sleep(ms: number): Promise<void>; pidAlive(pid: number): boolean; newId(): string }
  /** 读 hook 的 stdin JSON，返回要写到 stdout 的文字（空串表示放行、不输出）。永不抛错。 */
  export async function runGate(raw: string, env: NodeJS.ProcessEnv, deps: GateDeps): Promise<string>;
  ```
  - 只处理 `hook_event_name` 为 `PreToolUse` / `PostToolUse`、`tool_name === "Bash"` 的输入，命令取 `tool_input.command`，cwd 取 payload 的 `cwd`。
  - `classifyGateCommand` 返回 null → 立即返回 `""`，不碰文件系统。
  - 读 `<BUTLER_HOME 或 ~/.butler>/gate/alive.json`，读不到或 `pidAlive(pid)` 为 false → 返回 `""`。
  - pre：写 `requests/<id>.json`（先 `.tmp` 再 rename），每 50ms 查一次 `results/<id>.json`，最多等 `GATE_WAIT_MS`；拿到 deny 返回
    `JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })`；allow、超时、出错返回 `""`。读完删掉结果文件；超时时删掉自己的请求文件。
  - post：只写请求，不等结果，返回 `""`。
- [ ] **Step 1: 写测试**（用临时目录当 BUTLER_HOME，假的 `deps`）：
  - `git status` → `""`，而且 requests 目录里没有文件；
  - 没有 `alive.json` → `""`，用时 < 100ms（`deps.now` 计）；
  - `alive.json` 的 pid `pidAlive` 为 false → `""`；
  - 另起一个模拟主进程：读到请求后写 `{ v:1, decision:"deny", reason:"等 DMS-1" }` → 输出里 `permissionDecision` 是 `"deny"`、reason 是 `"等 DMS-1"`；请求里带着 `BUTLER_SESSION`、`BUTLER_TICKET`、`cwd`、`action`；
  - 没人回 → 等满 5000ms（假时钟）后 `""`，请求文件被删；
  - post → 立即 `""`，请求文件里 `phase` 是 `"post"`；
  - stdin 不是 JSON → `""`。
- [ ] **Step 2: 跑测试确认失败** — `pnpm vitest run hook/gate.test.ts hook/entry.test.ts`。
- [ ] **Step 3: 实现 `runGate`**；`entry.ts` 在 gate 模式下把返回值写到 stdout 再以 0 退出，异常同样以 0 退出。
- [ ] **Step 4: 跑测试确认通过**；`pnpm build:hook` 能打出可执行文件。
- [ ] **Step 5: Commit** — `git commit -m "feat: the hook asks Butler before a merge and fails open"`

### Task 4: 把 gate hook 写进 session 的 --settings

**Files:**
- Modify: `src/main/claude/project-mcp.ts`（`projectMcpApprovalSettings`）、`src/main/claude/project-mcp.test.ts`
- Modify: `src/main/index.ts:450`（传 gate 命令）

**Interfaces:**
- Consumes: `hookCommand(paths.hookBin, platform)`（`src/main/hooks/installer.ts`）。
- Produces: `projectMcpApprovalSettings(dirs: string[], p: ProjectMcpPaths & { gateCommand?: string }): string | null`。有 `gateCommand` 时内容多一项
  `hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${gateCommand} gate`, timeout: 10 }] }], PostToolUse: [同样一组] }`。
  文件名仍按内容 hash（内容相同的 session 共用一个文件）。
- [ ] **Step 1: 写测试** — 传 `gateCommand: '"/b/butler-hook"'` 时文件里有上面的 `hooks`，`enableAllProjectMcpServers` 照旧；不传时没有 `hooks` 键（和现在完全一样）。
- [ ] **Step 2: 跑测试确认失败** — `pnpm vitest run src/main/claude/project-mcp.test.ts`。
- [ ] **Step 3: 实现**；`index.ts` 里只有 hook 程序存在（`existsSync(paths.hookBin)`）时才传 `gateCommand`。
- [ ] **Step 4: 跑测试确认通过。**
- [ ] **Step 5: Commit** — `git commit -m "feat: Butler sessions run the merge gate hook"`

### Task 5: git / gh 工具函数和数据库

**Files:**
- Modify: `src/main/tickets/git.ts`、`src/main/tickets/git.test.ts`（真 git 临时仓库，沿用现有测试的做法）
- Create: `src/main/tickets/gh.ts`、`src/main/tickets/gh.test.ts`
- Modify: `src/main/db/migrations.ts`（末尾追加一条）
- Create: `src/main/db/merge-gate-repo.ts`、`src/main/db/merge-gate-repo.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // git.ts
  export function mainRepoRoot(dir: string): Promise<string>;              // worktree 里也返回主仓库目录（git rev-parse --git-common-dir 的上一层）
  export function mergeConflicts(repo: string, ours: string, theirs: string): Promise<string[]>; // git merge-tree --write-tree --name-only；无冲突返回 []
  export function isAncestor(repo: string, a: string, b: string): Promise<boolean>;
  export function fetchQuiet(repo: string, remoteBranch: string, timeoutMs: number): Promise<boolean>; // 失败或超时返回 false
  export function upstreamRef(repo: string, branch: string): Promise<string>; // 有 origin/<branch> 用它，否则 <branch>
  // gh.ts
  export interface PrInfo { number: number; url: string; head: string; base: string; state: "OPEN" | "MERGED" | "CLOSED"; autoMerge: boolean }
  export function prInfo(cwd: string, pr: string | null, timeoutMs: number): Promise<PrInfo | null>; // gh pr view [pr] --json number,url,headRefName,baseRefName,state,autoMergeRequest；失败 null
  // migrations：
  //   merge_holds(id PK, repo_path, branch, target, kind CHECK IN ('pr','local'), pr_url, session_id, ticket_key, created_at, released_at, outcome CHECK IN ('merged','cancelled','expired'))
  //   merge_waiters(id PK, hold_id REFERENCES merge_holds(id), session_id, ticket_key, branch, created_at, notified_at)
  //   merge_events(id PK, repo_path, kind CHECK IN ('wait','proceed_conflict','rebase','dir_busy'), ticket_key, branch, other_ticket, other_branch, files TEXT /* JSON 数组 */, created_at)
  // src/shared/types.ts（渲染进程的首页也用）
  export interface MergeEvent { id: number; repoPath: string; kind: "wait" | "proceed_conflict" | "rebase" | "dir_busy"; ticketKey: string | null; branch: string; otherTicket: string | null; otherBranch: string | null; files: string[]; createdAt: number }
  // merge-gate-repo.ts
  export interface MergeHold { id: number; repoPath: string; branch: string; target: string; kind: "pr" | "local"; prUrl: string | null; sessionId: string | null; ticketKey: string | null; createdAt: number }
  export class MergeGateRepo {
    addHold(h: Omit<MergeHold, "id">): number; activeHolds(): MergeHold[]; activeHold(repoPath: string, branch: string): MergeHold | null;
    releaseHold(id: number, outcome: "merged" | "cancelled" | "expired", at: number): void;
    addWaiter(w: { holdId: number; sessionId: string | null; ticketKey: string | null; branch: string; createdAt: number }): void; // 同一 hold + session 只留一条
    waitersOf(holdId: number): { id: number; sessionId: string | null; ticketKey: string | null; branch: string }[]; markNotified(waiterId: number, at: number): void;
    pendingNotices(): { waiterId: number; sessionId: string; otherTicket: string | null; otherBranch: string }[]; // 占位已 merged、还没通知的
    addEvent(e: Omit<MergeEvent, "id">): number; recentEvents(sinceMs: number, limit: number): MergeEvent[];
    lastProceedAgainst(repoPath: string, branch: string): MergeEvent | null; // 最近一条 other_branch = branch 的 proceed_conflict：后合的一方来时用来说明冲突来自谁
  }
  ```
- [ ] **Step 1: 写测试** — `mergeConflicts`：两个 branch 改同一行返回那个文件名，改不同文件返回 `[]`；`mainRepoRoot` 在 worktree 里返回主仓库；`isAncestor` 合并前 false、合并后 true；`fetchQuiet` 没有 origin 时返回 false 不抛错。`prInfo` 用假的 `gh`（PATH 前面放一个脚本）解析 JSON，`gh` 不存在返回 null。仓库测试：加占位、按 repo+branch 查到、释放后 `activeHolds()` 不再包含；同一 hold + session 的等待者只留一条；`pendingNotices` 只返回 outcome 为 merged 且没通知过的；`recentEvents` 按时间倒序、`files` 原样还原。
- [ ] **Step 2: 跑测试确认失败** — `pnpm vitest run src/main/tickets/git.test.ts src/main/tickets/gh.test.ts src/main/db/merge-gate-repo.test.ts`。
- [ ] **Step 3: 实现。** 迁移只追加，不改已有条目。`git merge-tree --write-tree` 需要 git ≥ 2.38：版本不够时 `mergeConflicts` 返回 `[]`（放行）并由调用方记一次日志。
- [ ] **Step 4: 跑测试确认通过**，`pnpm vitest run src/main/db` 全过（迁移顺序测试）。
- [ ] **Step 5: Commit** — `git commit -m "feat: git and gh helpers and tables for the merge coordinator"`

### Task 6: MergeGate 的裁决

**Files:**
- Create: `src/main/gate/merge-gate.ts`、`src/main/gate/merge-gate.test.ts`
- Modify: `src/main/strings.ts`（ZH / EN 各加下面的文案）

**Interfaces:**
- Consumes: Task 2 `GateRequest` / `GateResult`，Task 5 全部，`TicketsRepo.list()` / `listRepos()`，`SessionService.openTerminalCount(ticketKey)`。
- Produces:
  ```ts
  export interface MergeGateDeps {
    tickets: Pick<TicketsRepo, "list" | "listRepos">; repo: MergeGateRepo;
    openTerminals(ticketKey: string): number;
    git: { mainRepoRoot; mergeConflicts; isAncestor; fetchQuiet; upstreamRef; currentBranch };  // Task 5 的签名
    prInfo: typeof prInfo; notify(e: MergeEvent): void; now(): number; log(msg: string, err?: unknown): void;
    /** 文案里的“谁”：`ticket 号（feature 名）`、`ticket 号（epic 名 / feature 名）`、独立 ticket 只有号码，没有 ticket 时是 branch 名。index.ts 用 tickets / features / epics 仓库拼。 */
    whoOf(ticketKey: string | null, branch: string): string;
    /** post 阶段之后让 HoldWatcher（Task 7）尽快检查一轮。 */
    checkSoon(): void;
  }
  export class MergeGate {
    constructor(d: MergeGateDeps);
    handle(req: GateRequest): Promise<GateResult>;
    /** 共用目录被别的开着 session 的 ticket 占着时返回它，给“切换 branch”提示用。 */
    dirBusy(repo: TicketRepo): Promise<{ ticket: string; branch: string } | null>;
  }
  ```
  裁决规则（全部来自设计文档“怎么裁决”）：
  1. 仓库 = `mainRepoRoot(resolve(cwd, action.dir ?? "."))`。
  2. `pr_merge`：`prInfo` 拿 head / base；拿不到就放行。要合并的 branch = head，目标 = base。
     `local_merge`：branch = `source`，目标 = 当前分支。
     `push`：目标 = `target`；只有它是默认分支（`origin/HEAD` 指向的分支，取不到用 `main`）或某个进行中 ticket 的 PR 的 base 时才审核，branch = 当前分支；否则放行。
  3. 合并类：先 `fetchQuiet(repo, 目标, 2000)`。`mergeConflicts(repo, upstreamRef(目标), branch)` 非空 → deny `M().gateRebase(...)`，事件 `rebase`，other 取 `lastProceedAgainst(repo, branch)` 的 ticket/branch（可以为空）。
  4. 否则对同仓库每个“进行中”的别的 ticket branch（ticket 未归档、`ticket_repos.repo_path === 仓库`、branch ≠ 本 branch、`!isAncestor(repo, 它, upstreamRef(目标))`）做 `mergeConflicts(repo, branch, 它)`：
     - 冲突的那一方有活动占位（`activeHold(repo, 它)`）→ deny `M().gateWait(...)`，`addWaiter`，事件 `wait`。
     - 冲突但没有占位 → 放行，事件 `proceed_conflict`（ticket = 本方，other = 对方）。
  5. 放行时 `addHold`（`pr_merge` → kind `pr`、`prUrl`；其余 → `local`）。同一 repo + branch 已有占位就不重复加。
  6. `switch`：只在本 session 所属 ticket 在这个仓库的 `workMode === "branch"` 时审核。`dirBusy` 有结果 → deny `M().gateDirBusy(...)`，事件 `dir_busy`；否则放行。`dirBusy`：别的未归档 ticket 在同一 `repoPath` 也是 branch 模式、`openTerminals > 0`、并且 `currentBranch(repoPath) === 它的 branch`。
  7. `phase: "post"`：对应的 `local` 占位立刻检查一次：`isAncestor(repo, branch, 目标)` 为真 → `releaseHold(merged)`；否则 `releaseHold(cancelled)`。`pr` 占位不在这里释放，调 `checkSoon()` 交给 Task 7。返回 allow。
  8. 任何一步抛错：记日志，放行。
  每产生一条事件就调用 `notify(event)`。

  主进程文案（ZH；EN 同义）。`who` 来自 `whoOf`：
  ```ts
  gateWait: (who: string, files: string[]) => `先别合并：${who} 已经拿到合并许可、还没合完，它和你改了同样的地方（${files.join("、")}）。继续做别的事，不要再试合并；它合完后 Butler 会在这里告诉你，到时先 rebase 再合。`,
  gateRebase: (who: string | null, files: string[]) => `先别合并：你的分支和最新的目标分支有冲突（${files.join("、")}）${who ? `，冲突来自 ${who} 已经合进去的改动` : ""}。先 rebase 到最新的目标分支、解决冲突再合。解决冲突时两边的意图都要保留，不要直接用你的版本覆盖掉对方的。`,
  gateDirBusy: (who: string, branch: string) => `先别切换：这个目录正被 ${who} 用着（branch ${branch}），切过去会打乱它的工作。继续做不需要切 branch 的事，或者请用户把你的 ticket 改成 worktree 方式。`,
  gateMergedNotice: (who: string) => `Butler：${who} 已经合完。现在可以 rebase 到最新的目标分支后再合并。`,
  gateNotifyTitle: (repo: string) => `${repo}：合并协调`,
  gateNotifyBody: (e: MergeEvent, who: string, other: string | null) => string, // wait: `${who} 等 ${other} 合完再合`；proceed_conflict: `${who} 先合，${other} 之后要 rebase`；rebase: `${who} 要先 rebase 再合`；dir_busy: `${who} 想切 branch，目录正被 ${other} 用着`
  ```
- [ ] **Step 1: 写测试**（真 git 临时仓库：`main` 上一个文件，`dms-1`、`dms-2` 两个 branch 改它同一行，`dms-3` 改别的文件；tickets 用内存假实现）：
  - `dms-3` 合并 → allow，加了 local 占位，没有事件；
  - `dms-1` 合并，`dms-2` 没有占位 → allow，事件 `proceed_conflict`（ticket DMS-1、other DMS-2），`notify` 被调用一次；
  - 紧接着 `dms-2` 合并（`dms-1` 的占位还在）→ deny，reason 含 `DMS-1` 和冲突文件名，等待者一条，事件 `wait`；
  - `dms-1` 真的合进 main 之后（测试里执行 `git merge`）再发 `dms-2` 的合并 → deny `gateRebase`，reason 含 `DMS-1`；
  - feature 总控（`ticket: null`）发 `pr_merge`，假 `prInfo` 返回 head `dms-2` → 规则同上，按 branch 找到 DMS-2；
  - 不属于任何 ticket 的 branch `hotfix` 和 `dms-1` 冲突、`dms-1` 有占位 → deny，reason 含 `DMS-1`；
  - `prInfo` 返回 null → allow，无事件；
  - `switch`：DMS-4、DMS-5 都是 branch 模式、同一 repoPath，DMS-4 有开着的终端且目录在它的 branch 上，DMS-5 的 session 要切 → deny `gateDirBusy`；DMS-4 没有开着的终端 → allow；DMS-5 是 worktree 模式 → allow，不查；
  - `push` 推到非默认、非 PR base 的分支 → allow，不查冲突；
  - post 阶段 local 合并成功 → 占位 outcome `merged`；失败（branch 没进目标）→ `cancelled`；
  - `mergeConflicts` 抛错 → allow，记日志。
- [ ] **Step 2: 跑测试确认失败** — `pnpm vitest run src/main/gate/merge-gate.test.ts`。
- [ ] **Step 3: 实现 `MergeGate`**，`src/main/strings.ts` 加文案（`src/main/strings.test.ts` 要求两种语言的键一致，一起过）。
- [ ] **Step 4: 跑测试确认通过** — 同上，加 `pnpm vitest run src/main/strings.test.ts`。
- [ ] **Step 5: Commit** — `git commit -m "feat: the merge coordinator decides who merges first"`

### Task 7: 占位检查、通知等待者、接进主进程

**Files:**
- Create: `src/main/gate/hold-watcher.ts`、`src/main/gate/hold-watcher.test.ts`
- Modify: `src/main/index.ts`（建 `MergeGateRepo`、`MergeGate`、gate 的 `ControlInbox`、`HoldWatcher`；写和删 `alive.json`；系统通知）

**Interfaces:**
- Consumes: Task 5 `MergeGateRepo` / `prInfo` / `isAncestor` / `fetchQuiet`，Task 6 `MergeGate`，`PtyManager.deliver`，`SessionsRepo.get(id)?.waitingForInput`。
- Produces:
  ```ts
  export interface HoldWatcherDeps {
    repo: MergeGateRepo; prInfo: typeof prInfo; git: { isAncestor; fetchQuiet; upstreamRef };
    isOpen(sessionId: string): boolean; isWaiting(sessionId: string): boolean;
    deliver(sessionId: string, text: string): Promise<"sent" | "exited" | "timeout">;
    whoOf(ticketKey: string | null, branch: string): string;   // 和 Task 6 用同一个函数
    now(): number; log(msg: string, err?: unknown): void;
  }
  export class HoldWatcher {
    constructor(d: HoldWatcherDeps);
    check(): Promise<void>;          // 一轮：释放占位 + 发待发的通知。不并发（进行中再调用就合并成一次）。
    sessionIdle(sessionId: string): Promise<void>; // Stop hook 到了：这个 session 有待发的通知就发
    start(intervalMs: number): void; stop(): void;
    /** MergeGate 的 checkSoon：1 秒后跑一轮 check（合并多次调用）。 */
    soon(): void;
  }
  ```
  - `pr` 占位：`prInfo(repo, prUrl, 2000)` → `MERGED` 释放为 merged；`CLOSED`，或者 `OPEN` 且 `autoMerge === false` 且占位超过 30 秒（合并命令失败了，或者 `--auto` 被取消）→ cancelled；`prInfo` 为 null 时 `fetchQuiet` 后用 `isAncestor(branch, upstreamRef(target))` 判断 merged；超过 `HOLD_MAX_MS` → expired。
  - `local` 占位：`isAncestor(branch, target)` → merged；超过 `HOLD_MAX_MS` → expired。
  - 通知：`pendingNotices()` 里的每条，session 开着并且 `isWaiting` 时 `deliver(sessionId, M().gateMergedNotice(who))`，`sent` 后 `markNotified`；session 已经不开着 → 直接 `markNotified`（不再发）；session 在忙 → 等 `sessionIdle`。
  - `index.ts`：`MergeGate` 的 `checkSoon` 接到 `holdWatcher.soon()`，`HoldWatcher.start(Number(process.env.BUTLER_GATE_CHECK_MS) || HOLD_CHECK_MS)`（环境变量只给 e2e 用）；启动时写 `alive.json`（`{ pid: process.pid }`），退出时删；gate 的 `ControlInbox` 用 `intervalMs: 200`、`maxRequestAgeMs: 10_000`；hook 的 Stop 事件（`applyHookEnvelope` 返回 `kind: "waiting"`、`waiting: true`）时调 `holdWatcher.sessionIdle(id)`；`MergeGate` 的 `notify` 发 Electron 通知（标题 `gateNotifyTitle`、正文 `gateNotifyBody`），点击打开对应 ticket 页（`IPC.appNavigate` 的 ticket 路由；没有 ticket 时打开首页），同时 `safeSend(IPC.stateChanged)` 让首页刷新。
- [ ] **Step 1: 写测试**（假 deps，假时钟）：
  - pr 占位、`prInfo` 返回 OPEN 且没有自动合并、占位 31 秒 → cancelled，不发通知；同样的情况占位 10 秒 → 不动；
  - pr 占位 + `prInfo` 返回 MERGED → 释放为 merged，等待者的 session 空闲 → `deliver` 一次，文字是 `gateMergedNotice`，之后 `markNotified`；
  - 同上但 session 在忙 → 不发；之后 `sessionIdle` → 发一次；再调 `check` 不重复发；
  - 等待者的 session 已经关了 → 不发，标记已通知；
  - `prInfo` null、`isAncestor` 为 false、占位 2 小时 + 1ms → expired，不发通知；
  - CLOSED → cancelled，不发通知；
  - 重启：新建一个 `HoldWatcher`（同一个数据库里已有占位和等待者），`check` 后照样释放和通知；
  - `check` 并发调用两次只跑一轮。
- [ ] **Step 2: 跑测试确认失败** — `pnpm vitest run src/main/gate/hold-watcher.test.ts`。
- [ ] **Step 3: 实现 `HoldWatcher`，接进 `index.ts`。**
- [ ] **Step 4: 跑测试确认通过**；`pnpm typecheck` 通过。
- [ ] **Step 5: Commit** — `git commit -m "feat: release holds after the real merge and tell the waiting session"`

### Task 8: “切换 branch”提示里的占用提醒

**Files:**
- Modify: `src/shared/types.ts`（`branch_mismatch` 的打开结果加 `busyBy?: { ticket: string; branch: string }`）
- Modify: `src/main/sessions/session-service.ts`（`branchMismatch` 调 `MergeGate.dirBusy`，通过新的可选依赖 `dirBusy?: (repo: TicketRepo) => Promise<{ ticket: string; branch: string } | null>`）、`src/main/sessions/session-service.test.ts`
- Modify: `src/renderer/src/components/TicketPage.tsx:260-266`、`src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`

**Interfaces:**
- Consumes: Task 6 `MergeGate.dirBusy`。
- Produces: 渲染进程文案 `branchBusy: (ticket: string, branch: string) => string`（ZH：`这个目录正被 ${ticket} 用着（branch ${branch}），切过去会影响它。`；EN：`${ticket} is using this folder (branch ${branch}); switching will affect it.`）。
- [ ] **Step 1: 写测试** — `session-service.test.ts`：目录被占时 `branch_mismatch` 结果带 `busyBy`；没被占、或者没有 `dirBusy` 依赖时没有这个字段。
- [ ] **Step 2: 跑测试确认失败。**
- [ ] **Step 3: 实现**；`TicketPage` 在 `mismatch.busyBy` 存在时多显示一行 `S.branchBusy(...)`（`className="error"`），两个按钮照旧可点（不拦，只提醒）。
- [ ] **Step 4: 跑测试确认通过**；`pnpm vitest run src/renderer/src/strings.test.ts` 通过（两种语言键一致）。
- [ ] **Step 5: Commit** — `git commit -m "feat: warn when switching a shared folder another ticket is using"`

### Task 9: 首页的“合并协调”

**Files:**
- Modify: `src/shared/ipc.ts`（`mergeEvents: "merge:events"`）、`src/main/ipc/register.ts`、`src/renderer/src/api.ts`
- Create: `src/renderer/src/merge-events-view.ts`、`src/renderer/src/merge-events-view.test.ts`
- Modify: `src/renderer/src/components/BriefPage.tsx`、`src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`、`src/renderer/src/styles.css`

**Interfaces:**
- Consumes: Task 5 `MergeGateRepo.recentEvents(sinceMs, limit)`、`MergeEvent`。
- Produces:
  - IPC `mergeEvents` 返回最近 7 天、最多 20 条 `MergeEvent`（`api.mergeEvents(): Promise<MergeEvent[]>`）。
  - `mergeEventText(e: MergeEvent, S: UiStrings): { repo: string; text: string }`：`repo` 是 `repoPath` 的最后一段，`text` 按 kind 用渲染进程文案 `mergeEvent.wait / proceed_conflict / rebase / dir_busy`（意思和 Task 6 的 `gateNotifyBody` 一样，ticket 为空时用 branch 名）。
  - 首页在现有小节之后加 `<section className="brief-section merge-events">`，标题 `S.mergeEventsTitle`（ZH “合并协调”，EN “Merge coordination”），一行一条：时间、仓库、文字；ticket 号是 `button.chip`，点击 `onOpenTicket(key)`（已归档或不存在的 ticket 只显示文字）。没有事件时整节不显示。`stateChanged` 时重读。
- [ ] **Step 1: 写测试** — `merge-events-view.test.ts`：四种 kind 的文字、ticket 为空时用 branch 名、`repo` 取最后一段（Windows 路径也对）。
- [ ] **Step 2: 跑测试确认失败** — `pnpm vitest run src/renderer/src/merge-events-view.test.ts`。
- [ ] **Step 3: 实现 IPC、视图函数和首页小节。**
- [ ] **Step 4: 跑测试确认通过**；`pnpm typecheck` 通过。
- [ ] **Step 5: Commit** — `git commit -m "feat: merge coordination on the home page"`

### Task 10: 端到端测试

**Files:**
- Modify: `e2e/fake-claude/fake-claude.cjs`
- Create: `e2e/merge-gate.spec.ts`

**Interfaces:**
- Consumes: Task 1-9 全部。
- 假 claude 新增：
  - `runHooks` 除了 `CLAUDE_CONFIG_DIR/settings.json`，也读 `--settings` 文件里的 hooks；hook 的 stdout 收集起来返回。
  - 输入 `/fake-run <shell 命令>`：像 Bash 工具。先跑 `PreToolUse`（payload `{ tool_name: "Bash", tool_input: { command }, cwd }`），stdout 里的 JSON 是 deny 就打印 `denied: <reason>` 并记日志 `gate deny <reason>`；否则在 cwd 里执行命令，打印输出，再跑 `PostToolUse`，记日志 `gate allow <command>`。这一轮照常结束（Stop hook）。
- [ ] **Step 1: 写 e2e** `e2e/merge-gate.spec.ts`：
  1. 建 feature（沿用 `features.spec.ts` 的建法），两个 ticket DMS-1、DMS-2 都只用 backend 仓库（worktree 方式）。
  2. 在两个 worktree 里分别改 `README.md` 同一行并 commit（测试直接用 git 命令）。
  3. 让 DMS-2 拿着合并占位：直接往测试数据库的 `merge_holds` 插一条 DMS-2 的 local 占位（repo = backend 主目录、branch = DMS-2 的 branch、target = main），写法沿用 `features.spec.ts` 的 `DatabaseSync`。
  4. 在 DMS-1 的 session 里 `/fake-run git -C <backend 主目录> merge dms-1`：假 claude 日志出现 `gate deny`，reason 含 `DMS-2`；终端里出现 `denied:`；backend 主目录的 main 没有变（`git rev-parse main` 和之前一样）。
  5. 首页出现“合并协调”一节，有一行含 `DMS-1` 和 `DMS-2`。
  6. 把 DMS-2 真的合进 main（测试里执行 git），launch 时在沙盒的 `env` 里设 `BUTLER_GATE_CHECK_MS=500`：DMS-1 的 session 停在等输入时，DMS-1 的终端里出现 `gateMergedNotice` 的文字（含 `DMS-2`）。
  7. 再 `/fake-run git -C <backend 主目录> merge dms-1`：这次是 rebase 提醒（日志 `gate deny`，reason 含 `rebase`）。
  8. 不审核的命令 `/fake-run git status` 没有任何 gate 请求文件出现（日志 `gate allow git status`，`<BUTLER_HOME>/gate/requests` 一直为空）。
  9. 删掉 `alive.json`（模拟 Butler 不在）后 `/fake-run git -C <backend 主目录> merge dms-1` 立即被放行（日志 `gate allow`），用时 < 2 秒。
  
  第 6 步的 `BUTLER_GATE_CHECK_MS` 只在 e2e 用，文档里不提。
- [ ] **Step 2: 跑 e2e 确认失败** — `pnpm build && pnpm build:hook && pnpm e2e:only merge-gate`（在 Task 1-9 完成前写好的话预期 FAIL；如果是最后写的，先 `git stash` 掉 `src/main/gate` 的接入确认它会失败，再恢复）。
- [ ] **Step 3: 补齐假 claude**，让测试能跑起来。
- [ ] **Step 4: 跑 e2e 确认通过**，再跑全套 `pnpm e2e:only`，21 + 1 个全过。
- [ ] **Step 5: Commit** — `git commit -m "test: merge coordinator end to end"`

### Task 11: 上层 session 结束下层 session（`end_session`）

用户 2026-11-04 在对话里确认的小功能，和合并总控一起发：ticket 的 PR 都合了，session 还开着，用户不想一个个 ticket 点进去关，要让上层 session（epic、feature 总控、多仓库 ticket 的总控）能关掉下层的 session。

**Files:**
- Modify: `src/shared/control.ts`（三种请求各加 `end_session`；epic 再加 `list_sessions`、`session_activity`）、`src/shared/control.test.ts`
- Modify: `src/main/control/control-handler.ts`、`src/main/control/control-handler.test.ts`、`src/main/control/control-feature.test.ts`、`src/main/control/control-epic.test.ts`
- Modify: `memory-mcp/sessions-server.ts`（工具定义，中英两套说明）、`memory-mcp/sessions-server.test.ts`
- Modify: `src/main/strings.ts`（拒绝原因的文案，ZH / EN）
- Modify: `src/main/index.ts`（controlHandler 的新依赖）

**Interfaces:**
- Produces:
  ```ts
  // control.ts：TicketControlRequest / FeatureControlRequest / EpicControlRequest 各加
  { op: "end_session"; session: string; reason: string }          // reason 1..500 字符，必填
  // EpicControlRequest 另加
  { op: "list_sessions" } | { op: "session_activity"; session: string }
  // controlHandler 的新依赖
  kill(termId: string): void;                                       // pty.kill
  isOpen(termId: string): boolean;                                  // pty.isOpen
  screenNeedsUser(termId: string): boolean;                         // 屏幕上有权限确认或启动对话框：permissionPromptShowing(buffer) || dialogShowing(buffer)（pty-manager.ts）
  lastReply(sessionId: string): string | null;                      // 这个 session 最后一条 assistant 文字回复的结尾，最多 500 字符；读不到为 null
  ```
- 规则：
  - 能关的范围：ticket 总控 → 本 ticket 的 session（不含自己）；feature 总控 → 本 feature 下所有 ticket 的 session 和修复 session（不含自己）；epic session → 它下面所有未归档 feature 的 feature 级 session（总控、修复）和这些 feature 下 ticket 的 session（不含自己）。范围外、不存在 → 错误 `ctlNoSuchSession`（沿用）。
  - Butler 硬性拒绝（返回错误，不关）：
    - 终端没开着（已经结束）→ `ctlSessionNotRunning`；
    - 正在干活：活动的 kind 不是 `idle` / `waiting`，或者 session 没有在等输入（`waitingForInput` 为 false）→ `ctlSessionBusy(kind)`；
    - `screenNeedsUser` 为真 → `ctlSessionNeedsUser`。
  - 通过后 `kill(termId)`，记日志 `end_session <id> by <from>: <reason>`，返回 `{ ended: true }`。和界面上点 × 是同一个动作，session 留在列表里，之后能恢复。
  - `list_sessions`、`session_activity` 的每个 session 多一个字段 `last_reply`（`lastReply` 的结果）。epic 的 `list_sessions` 每行另带 `feature`（feature 名）和 `ticket`（没有为 null）。
  - 工具说明（中文；英文同义）：`结束一个已经停下来、在等输入的 session（和用户在界面上点 × 一样，记录都在，之后能恢复）。只在确认它的工作已经做完时用，比如它的 PR 已经合并、handoff 说做完了。先用 session_activity 看它的 last_reply：如果它最后在问问题、等用户做决定或等用户输入什么，不要关，留给用户。拿不准就不关。正在干活的 session Butler 会拒绝。reason 写清楚为什么可以关。`
  - 主进程文案：`ctlSessionNotRunning: (id) => \`session ${id} 已经结束了\``、`ctlSessionBusy: (id, kind) => \`session ${id} 正在干活（${kind}），不能结束\``、`ctlSessionNeedsUser: (id) => \`session ${id} 的屏幕上有一个等用户回答的确认，不能结束\``；EN 同义。
- [ ] **Step 1: 写测试** — `control.test.ts`：三种请求的 `end_session` 解析（缺 reason、reason 超过 500、session 不是字符串 → null），epic 的 `list_sessions` / `session_activity`。handler 测试（沿用现有的 fake）：feature 总控关本 feature 下一个在等输入、活动为 idle 的 ticket session → `kill` 被调用一次、返回 `{ ended: true }`；同一个 session 活动为 `test` → 错误 `ctlSessionBusy`、没有 kill；`waitingForInput` 为 false → busy；`screenNeedsUser` 为真 → `ctlSessionNeedsUser`；终端没开着 → `ctlSessionNotRunning`；关自己 → `ctlNoSuchSession`；关别的 feature 的 session → `ctlNoSuchSession`；epic 关它下面 feature 的总控 → 成功；epic 关不属于它的 feature 的 session → `ctlNoSuchSession`；ticket 总控关本 ticket 的子 session → 成功。`list_sessions` 行里有 `last_reply`。sessions-server 测试：三套工具列表里都有 `end_session`，epic 那套有 `list_sessions` 和 `session_activity`，`reason` 必填。
- [ ] **Step 2: 跑测试确认失败** — `pnpm vitest run src/shared/control.test.ts src/main/control memory-mcp/sessions-server.test.ts`。
- [ ] **Step 3: 实现**；`lastReply` 从 session 的 transcript 读（看 `src/main/sessions/activity-sources.ts`、`activity-parse.ts` 现有的 transcript 读取，复用，不另写一套解析），`index.ts` 接上依赖。
- [ ] **Step 4: 跑测试确认通过**；`pnpm typecheck`、`pnpm test` 通过。
- [ ] **Step 5: e2e** — 在 `e2e/features.spec.ts` 现有的 feature 总控测试里（它已经按 mcp 配置启动 butler-sessions 并调用工具）加一步：子 session 停在等输入时调 `end_session` → 成功，子 session 的终端退出，feature 页上这个 session 还在（可以恢复）；对一个正在跑 `/fake-bash` 的 session 调 → 返回 busy 错误，终端还在。
- [ ] **Step 6: Commit** — `git commit -m "feat: coordinators and epics can end sessions that are done"`

### Task 12: 文档、版本、发布

**Files:**
- Modify: `docs/configuration.md`（新一节：合并总控做什么、只在 Butler 打开的 session 里、失败时放行、需要 git ≥ 2.38、可选 `gh`；总控工具列表里加 `end_session`）、`README.md`（功能列表加一行）
- Modify: `package.json`（`"version": "1.6.0"`）
- Modify: memory `next-update-ideas.md`（记下 1.6.0 发了什么）

- [ ] **Step 1:** 写文档。`src/main/docs.test.ts` 如果检查文档里提到的设置项，跟着更新。
- [ ] **Step 2:** `pnpm typecheck && pnpm test && npx eslint <改过的文件>`，全过（全仓 `pnpm lint` 会扫到 `.claude/worktrees`，那是本地目录，不算）。
- [ ] **Step 3:** `pnpm build && pnpm build:hook && pnpm e2e:only` 全过。
- [ ] **Step 4:** Commit，push `feature/BTL-151`，开 PR（标题 `1.6.0: merge coordinator, end_session for coordinators, collapsible epic features, terminal scroll fix`，正文列三项改动和测试结果，结尾带 Claude Code 署名），CI 过后直接合并。
