# Butler 计划 2：Handoff 采集与规则简报 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Butler 每个工作日 16:00 用公司 Claude Code（fork、只读、不落盘）为每个有新进展的 ticket 生成结构化 handoff，会话里的 `/handoff` 也能入库；合并 followups、自动推导 ticket 状态；用纯规则生成早间简报和晚间小结。首页变成简报，每一条都能一键回到对应 session，提示预填在输入框里。

**Architecture:** 主进程新增四块，都是不依赖 Electron 的普通 TS 模块：`HandoffRunner`（用 cross-spawn 起 headless `claude -p`，prompt 走 stdin，`--json-schema` 约束输出，zod 二次校验，失败重试一次再降级）、`/handoff` 采集（Stop hook → 读 transcript 末尾 → 解析 `butler-handoff` 代码块）、`BriefEngine`（纯函数规则引擎）、`Scheduler`（`jobs` 表 + `powerMonitor` 事件 + 每分钟 tick，错过就补跑）。headless 运行一律带 `BUTLER_SESSION=headless:<runId>` 和 `--no-session-persistence`：hook 上报被忽略，磁盘上也不留 fork 的 transcript，“未认领”列表不会被污染。渲染进程只新增页面和组件，文案仍集中在 `strings.ts`。

**Tech Stack:** 计划 1 的全部依赖（Electron 44.9.0、electron-vite 6.0.0、React 19.3.1、node-pty 1.1.0、node:sqlite、vitest 5.0.5、TypeScript 5.9.3），新增 zod 4.6.5（schema + `z.toJSONSchema` 生成 `--json-schema`）、cross-spawn 7.0.6 + @types/cross-spawn 6.0.6（Windows 上 `claude.cmd` 的参数转义）、Electron `powerMonitor` / `Notification`。

**Spec:** `docs/superpowers/specs/2026-10-19-butler-design.md`（重点：第 3 节 followups 与状态推导、第 5 节、第 6 节、第 10 节相关行、13.1 节）。另见计划 1 的遗留清单 `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md`，以及本文末尾的“验证记录”。

## 本计划在整体中的位置

| 计划 | 内容 | 结束时能做什么 |
|------|------|--------------|
| 1（已完成） | 框架、数据库、ticket、内嵌终端、hook、session 发现、托盘 | 用 Butler 管理所有 ticket 的 Claude Code session |
| **2（本计划）** | 计划 1 遗留修复、handoff 采集（headless fork + `/handoff`）、followups、状态推导、规则简报、调度、简报首页 | 晚间小结 + 早间简报（纯规则），一键回到 session |
| 3 | PrivacyGateway、LLM 服务商、审计页、预算 | 简报带“今日重点”润色（本计划留好 `narrative` / `narrativeStatus` 接口） |
| 4 | StateCore 记忆层（含 handoff 写入 StateCore、`--mcp-config`）、首次启动向导、打包、E2E、双平台 CI | 可发布的 v1.0 |

## Global Constraints

- 平台：Windows + macOS 功能一致；路径一律用 `node:path`，不手拼分隔符。
- **prompt 永远不进 argv**：headless 调用把 prompt 写进子进程 stdin（`claude -p` 从 stdin 读 prompt，验证记录 V1）。argv 里只放 Butler 自己构造的参数（schema JSON、工具名、UUID）。headless 进程一律用 `cross-spawn` 启动，Windows 上 `claude.cmd` 的参数由它转义；不要用 `execText` 跑 headless claude。
- **每个 Butler 启动的 headless claude**（handoff、刷新、MCP 探测）都必须：环境变量用 `headlessEnv()` 生成（`BUTLER_SESSION=headless:<runId>`，不设 `BUTLER_TICKET`），并带 `--no-session-persistence`。`applyHookEnvelope` 对这种信封直接返回 `ignored`。返回的 session id 用 `SessionsRepo.recordHeadless` 记成已忽略。
- **headless 只读**：`--permission-mode dontAsk` + `--disallowedTools Edit Write NotebookEdit` + `--allowedTools` 白名单（`Read`、`Grep`、`Glob`、`Bash(gh pr view:*)`、`Bash(gh pr checks:*)`、`Bash(git log:*)`、`Bash(git status)`，再加设置里的 tracker MCP 工具名）。
- 并发上限 2，单个超时 5 分钟；遇到限流，本批剩下的 ticket 不再发起，标为 skipped，留给早间补跑。
- 晚间 handoff 默认 **16:00**；工作日默认周一到周五（设置 `workingDays` = `1,2,3,4,5`，按 JS `getDay()`，0 是周日）；非工作日不跑晚间 handoff。
- 所有“哪一天”的计算都用本地时区（`src/main/schedule/calendar.ts`）。测试里一律用 `new Date(y, m, d, h, mm)` 构造时间，不写 UTC 字符串。
- 本计划不调用任何个人 LLM API，也不发起网络请求（本机 `claude` 进程自己的网络除外）。简报存 `narrative: null`、`narrativeStatus: "off"`。
- `handoffs` 只追加不覆盖；数据库迁移只在 `MIGRATIONS` 末尾追加，永远不改已有条目。
- 改 Claude Code 用户目录下的文件只能合并：`~/.claude/commands/handoff.md` 已存在、又不是 Butler 写的（没有标记行），就不覆盖，状态报 `conflict`。
- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；新增 IPC 通道必须进白名单（`src/shared/ipc.test.ts` 会检查）。渲染进程不能 import `src/main/**`，跨进程的类型放 `src/shared/`。
- UI 文案用中文，集中在 `src/renderer/src/strings.ts`；主进程的系统通知文案集中在 `src/main/strings.ts`。
- 依赖版本精确锁定（不带 `^`）。包管理器用 pnpm；每个任务结束时 `pnpm typecheck`、`pnpm lint`、`pnpm test` 必须通过。
- 每个 commit message 末尾加执行者所在 harness 的署名提醒给出的那一行 `Co-Authored-By: ...`（计划 1 Ruling R3）。

## Review Focus

1. **电脑在 16:00 睡着了、app 没开、跨周末、改了时区或夏令时切换**：错过的晚间 handoff 在下一次解锁/唤醒/启动时补跑，而且在早间简报之前；同一天不会跑两次；第一次启动不补历史。测试见任务 12（`isNightlyDue` / `Scheduler` 的假时钟用例）和任务 11（`daysBetween` 跨夏令时）。
2. **用户正开着同一个 session 的终端时晚间 fork 在跑，或 Butler 自己的 `claude -p` 触发了用户级 hook**：原 transcript 不变，fork 不出现在“未认领”，headless 的 Stop 不会把任何 session 标成“等你输入”或被当成 `/handoff`。测试见任务 7（`ignores every event from Butler's own headless runs`）和任务 8（参数含 `--fork-session --no-session-persistence`、fork id 记为 dismissed）。
3. **claude 输出不合规**（结构化输出缺失、JSON 外面包了一段话、字段缺失、超时、额度用完或限流）：校验失败重试一次再存 degraded 并保留原文；超时和失败不写入；限流后本批停止发起，状态 partial，早间补跑。测试见任务 8。
4. **Windows 上 claude 是 npm 装的 `claude.cmd`、参数里有 JSON、括号、`%`、`&`、空格和中文**：参数必须原样到达 claude。测试见任务 7（`passes tricky args through untouched`，Windows CI 上假 claude 是 `.cmd`，同一个用例会走 cmd.exe 转义）。
5. **模型忘了 followup id、在同一次 handoff 里重复列出同一项、或者重新提起用户已忽略的项**：不产生重复、被忽略的永不复活、已完成的不会被重新打开。测试见任务 6（`planFollowupMerge` 用例）。

---

## 文件结构

```
src/
  shared/
    text.ts                 stripControl / sanitizePrefill（任务 2）
    handoff.ts              zod：HandoffSchema / RefreshSchema 与类型（任务 4）
    brief.ts                简报类型（任务 5）
    settings.ts             可编辑设置键（任务 5）
    types.ts                + Followup / HandoffRecord / HandoffOutcome / McpProbe 等
    hook-envelope.ts        + HEADLESS_SESSION_PREFIX / isHeadlessEnvelope（任务 7）
    ipc.ts, ipc.test.ts     + 新通道与白名单检查（任务 13）
  main/
    strings.ts              系统通知文案（任务 13）
    db/
      migrations.ts         + 迁移 2（任务 5）
      database.ts           + withTransaction（任务 5）
      handoffs-repo.ts, followups-repo.ts, briefs-repo.ts, marks-repo.ts, jobs-repo.ts（任务 5）
      tickets-repo.ts, sessions-repo.ts, settings-repo.ts（修改）
    settings/settings-values.ts   设置值解析与校验（任务 5）
    handoff/
      schema.ts             JSON Schema 生成、校验、宽松解析（任务 4）
      templates.ts          默认 prompt、/handoff 命令文本、示例（任务 4）
      followup-merge.ts     followup 合并规则（任务 6）
      status.ts             ticket 状态推导（任务 6）
      ingest.ts             入库（事务）（任务 6）
      prompt.ts             模板渲染（任务 8）
      runner.ts             HandoffRunner（任务 8）
      command.ts            安装 /handoff 命令（任务 9）
      transcript.ts         读 transcript 末尾（任务 9）
      capture.ts            Stop → /handoff 入库（任务 9）
    claude/
      headless.ts           runHeadless（任务 7）
      mcp-probe.ts          探测 MCP 工具名（任务 10）
      spawn.ts              + headlessEnv（任务 7）
    brief/
      engine.ts             规则引擎（纯函数）（任务 11）
      brief-service.ts      组装输入、存取简报、条目标记（任务 12）
    schedule/
      calendar.ts           本地日期工具（任务 11）
      scheduler.ts          到期判断 + 串行调度（任务 12）
      daily-jobs.ts         晚间/早间任务的组合（任务 12）
    util/pool.ts            并发池（任务 8）
  renderer/src/
    brief-view.ts           简报条目的标题/预填/操作（任务 14）
    followup-view.ts        followup 与 handoff 结果文案（任务 15）
    settings-form.ts        设置表单小工具（任务 15）
    components/BriefPage.tsx（替换 HomePage.tsx）、TicketOverview.tsx、ScheduleSettings.tsx
```

测试文件与源文件放在一起（`*.test.ts`）。需要真 claude 的测试命名为 `*.live.test.ts`，只有设置 `BUTLER_LIVE_CLAUDE=1` 才运行。

---

### Task 1: 新建 ticket 的错误处理（计划 1 遗留）

计划 1 遗留：`GitError` 在 `TicketService.create` 里没有映射（界面显示 `internal` + git 原始输出）；用户填的分支名没有校验；空仓库（还没有任何提交）报的是 git 原文。

**Files:**
- Modify: `src/main/tickets/git.ts`
- Modify: `src/main/tickets/ticket-service.ts`
- Modify: `src/main/tickets/ticket-service.test.ts`
- Modify: `src/renderer/src/strings.ts`

**Interfaces:**
- Consumes: `git(cwd, args)`、`GitError { stderr }`（`src/main/tickets/git.ts`）
- Produces:
  - `hasCommits(cwd: string): Promise<boolean>`
  - `isValidBranchName(cwd: string, name: string): Promise<boolean>`
  - `gitErrorSummary(e: GitError): string`
  - `TicketErrorCode` 增加 `"invalid_branch" | "empty_repo" | "git_failed"`

- [ ] **Step 1: 写失败测试**

在 `src/main/tickets/ticket-service.test.ts` 顶部加 `import { execFileSync } from "node:child_process";`，并在文件末尾追加：

```ts
describe("TicketService.create input checks", () => {
  it("rejects an empty repository with a friendly message", async () => {
    const { service, tickets } = setup();
    const dir = tempDir("butler-empty-");
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    await expect(service.create({ key: "PROJ-20", repoPath: dir, workMode: "branch" })).rejects.toMatchObject({
      code: "empty_repo",
      message: "这个仓库还没有任何提交",
    });
    expect(tickets.get("PROJ-20")).toBeNull();
  });

  it("rejects branch names git would refuse or expand", async () => {
    const { service } = setup();
    const repo = makeRepo();
    for (const branch of ["has space", "-x", "a..b", "@{-1}", "end/"]) {
      expect(await code(service.create({ key: "PROJ-21", repoPath: repo, workMode: "branch", branch }))).toBe("invalid_branch");
    }
    expect(await code(service.create({ key: "PROJ-21", repoPath: repo, workMode: "branch", branch: "yc/功能-1" }))).toBe("no-error");
  });

  it("maps git failures to git_failed with git's own reason and stores nothing", async () => {
    const { service, tickets } = setup();
    const repo = makeRepo();
    // main 已经在主工作区检出，git 不允许再给它建 worktree。
    const err = await service.create({ key: "PROJ-22", repoPath: repo, workMode: "worktree", branch: "main" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TicketError);
    expect(err).toMatchObject({ code: "git_failed" });
    expect((err as Error).message).toMatch(/^git 操作失败：/);
    expect((err as Error).message).not.toMatch(/fatal:/);
    expect(tickets.get("PROJ-22")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/tickets/ticket-service.test.ts`
Expected: 新增的 3 个用例 FAIL（空仓库报的是 git 原文、坏分支名没有被拒绝、worktree 失败的 code 是 `undefined`）。

- [ ] **Step 3: 实现**

`src/main/tickets/git.ts` 末尾追加：

```ts
/** 仓库是否至少有一个提交。空仓库没有 HEAD，建分支和 worktree 都会失败。 */
export async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 用 git 自己的规则校验分支名。`git check-ref-format --branch` 会把 `@{-1}` 这类写法展开成别的分支，
 * 所以输出必须和输入完全相同才算合法；以 `-` 开头的名字会被当成选项，直接拒绝。
 */
export async function isValidBranchName(cwd: string, name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;
  try {
    return (await git(cwd, ["check-ref-format", "--branch", name])) === name;
  } catch {
    return false;
  }
}

/** git 报错里给用户看的那一句：第一行 fatal:/error: 的原因，去掉前缀。 */
export function gitErrorSummary(e: GitError): string {
  const lines = e.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? e.message;
  return line.replace(/^(fatal|error):\s*/i, "");
}
```

`src/main/tickets/ticket-service.ts`：

1. import 改为：

```ts
import {
  addWorktree, branchExists, checkout, createBranch, currentBranch, GitError, gitErrorSummary, hasCommits, isDirty,
  isValidBranchName, repoRoot,
} from "./git";
```

2. 错误码和映射函数：

```ts
export type TicketErrorCode =
  | "invalid_key" | "exists" | "not_git_repo" | "worktree_exists" | "dirty" | "not_found"
  | "invalid_branch" | "empty_repo" | "git_failed";
```

在 `TicketError` 类后面加：

```ts
/** git 命令失败转成带 code 的 TicketError，界面上显示 git 给出的原因而不是整段输出。 */
function asTicketError(e: unknown): unknown {
  return e instanceof GitError ? new TicketError("git_failed", `git 操作失败：${gitErrorSummary(e)}`) : e;
}
```

3. `create` 里从 `let root` 到 `const ticket: Ticket = {` 之前的部分替换为：

```ts
    let root: string;
    try {
      root = await repoRoot(input.repoPath);
    } catch {
      throw new TicketError("not_git_repo", `${input.repoPath} 不是 git 仓库`);
    }
    if (!(await hasCommits(root))) throw new TicketError("empty_repo", "这个仓库还没有任何提交");

    const branch = input.branch?.trim() || renderBranch(this.d.settings.get("branchTemplate"), key);
    if (!(await isValidBranchName(root, branch))) throw new TicketError("invalid_branch", `分支名不合法：${branch}`);

    let worktreePath: string | null = null;
    try {
      if (input.workMode === "worktree") {
        worktreePath = join(dirname(root), `${basename(root)}-worktrees`, key);
        if (existsSync(worktreePath)) throw new TicketError("worktree_exists", `目录已存在：${worktreePath}`);
        await addWorktree(root, worktreePath, branch, !(await branchExists(root, branch)));
      } else if (!(await branchExists(root, branch))) {
        await createBranch(root, branch);
      }
    } catch (e) {
      throw asTicketError(e);
    }
```

4. `switchBranch` 改为：

```ts
  async switchBranch(t: Ticket): Promise<void> {
    if (await isDirty(t.repoPath)) throw new TicketError("dirty", "工作区有未提交的改动，不会自动切换分支");
    try {
      await checkout(t.repoPath, t.branch);
    } catch (e) {
      throw asTicketError(e);
    }
  }
```

`src/renderer/src/strings.ts` 的 `createErrors` 里追加两项（`git_failed` 不加：界面直接显示 `err.message`，它已经是中文原因）：

```ts
    invalid_branch: "分支名不合法（git 不接受这个名字）。",
    empty_repo: "这个仓库还没有任何提交",
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/tickets/ticket-service.test.ts`
Expected: 全部 PASS（包括计划 1 原有用例）。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/main/tickets src/renderer/src/strings.ts
git commit -m "fix: friendly errors for empty repos, invalid branch names and git failures when creating tickets"
```

---

### Task 2: 终端卫生（计划 1 遗留）

计划 1 遗留：ConPTY 在进程退出后吐出的尾部数据会清掉退出提示；预填文本里的换行会直接提交；拖入的文件名里的控制字符会进到 Claude 的界面；未捕获异常在 dev 下只写文件、控制台看不到。

**Files:**
- Create: `src/shared/text.ts`, `src/shared/text.test.ts`
- Modify: `src/renderer/src/drop.ts`, `src/renderer/src/drop.test.ts`
- Modify: `src/main/sessions/pty-manager.ts`, `src/main/sessions/pty-manager.test.ts`
- Modify: `src/main/sessions/session-service.ts`, `src/main/sessions/session-service.test.ts`
- Modify: `src/main/logger.ts`, `src/main/logger.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces:
  - `stripControl(text: string): string`
  - `sanitizePrefill(text: string, limit?: number): string`（`PREFILL_LIMIT = 500`）
  - `createFileLogger(file, now?, tee?: (line: string) => void): Logger`
- 行为：`PtyManager` 在终端退出后丢弃该进程的输出；`SessionService.open` 预填前先 `sanitizePrefill`。

- [ ] **Step 1: 写失败测试**

`src/shared/text.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { sanitizePrefill, stripControl } from "./text";

describe("stripControl", () => {
  it("removes C0, DEL and C1 control characters but keeps normal text", () => {
    expect(stripControl("a\u0000b\u001b[31mc\u007fd\u009be")).toBe("ab[31mcde");
    expect(stripControl("张 三.txt")).toBe("张 三.txt");
  });
});

describe("sanitizePrefill", () => {
  it("turns newlines and tabs into single spaces so the text is never submitted", () => {
    expect(sanitizePrefill("继续 follow-up：\n改 staging config\r\n\t（来自 PROJ-56）")).toBe("继续 follow-up： 改 staging config （来自 PROJ-56）");
  });

  it("drops escape sequences, trims and caps the length", () => {
    expect(sanitizePrefill("  \u001b[2Jhi\u0003  ")).toBe("[2Jhi");
    expect(sanitizePrefill("x".repeat(600))).toHaveLength(500);
  });
});
```

`src/renderer/src/drop.test.ts` 的 `describe` 里追加：

```ts
  it("strips control characters from dropped names", () => {
    expect(quotePath("/tmp/evil\u001b[31m\nname.txt", "darwin")).toBe("'/tmp/evil[31mname.txt'");
    expect(dropText(["C:\\a\rb.txt"], "win32")).toBe('"C:\\ab.txt"');
  });
```

`src/main/sessions/pty-manager.test.ts` 的 `describe("PtyManager")` 里追加：

```ts
  it("drops output that arrives after the process exited", () => {
    const { mgr, spawned, data } = setup();
    mgr.open("t1", spec, opts);
    spawned[0].pty.emit("before");
    spawned[0].pty.emitExit(0);
    spawned[0].pty.emit("trailing");
    expect(data).toEqual([["t1", "before"]]);
    expect(mgr.snapshot("t1")).toEqual({ data: "before", exitCode: 0 });
  });
```

`src/main/sessions/session-service.test.ts` 的 `describe("SessionService.open")` 里追加：

```ts
  it("prefills a single line even when the request text has newlines", async () => {
    const { service, spawned } = await setup();
    await service.open({ ticketKey: "PROJ-1" });
    spawned[0].pty.emit("ready");
    expect(await service.open({ ticketKey: "PROJ-1", sessionId: "new-1", prefill: "继续\n做 PROJ-1\r\n" })).toMatchObject({ alreadyOpen: true });
    expect(spawned[0].pty.written).toEqual(["继续 做 PROJ-1"]);
  });
```

`src/main/logger.test.ts` 的 `describe` 里追加：

```ts
  it("also passes each line to the tee (the dev console)", () => {
    const lines: string[] = [];
    const log = createFileLogger(join(tempDir(), "main.log"), () => new Date("2026-01-02T03:04:05.000Z"), (l) => lines.push(l));
    log("hello");
    log("boom", new Error("bad"));
    expect(lines[0]).toBe("2026-01-02T03:04:05.000Z hello");
    expect(lines[1]).toContain("boom Error: bad");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/shared/text.test.ts src/renderer/src/drop.test.ts src/main/sessions src/main/logger.test.ts`
Expected: FAIL（`./text` 不存在；尾部数据被转发；预填里带换行；tee 没被调用）。

- [ ] **Step 3: 实现**

`src/shared/text.ts`：

```ts
/** C0 控制字符（含换行、Tab、ESC）、DEL 和 C1 控制字符。 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export const PREFILL_LIMIT = 500;

/** 去掉所有控制字符：要写进终端的外部文本（例如文件名）里不能带 ESC 序列或回车。 */
export function stripControl(text: string): string {
  return text.replace(CONTROL_RE, "");
}

/**
 * 预填到 claude 输入框的文本：换行和 Tab 变成空格，其他控制字符去掉，压缩空白，限制长度。
 * 这样写进 PTY 的永远是一行，不会被当成“回车发送”。
 */
export function sanitizePrefill(text: string, limit = PREFILL_LIMIT): string {
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(CONTROL_RE, "").replace(/ {2,}/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) : flat;
}
```

`src/renderer/src/drop.ts` 改为：

```ts
import { stripControl } from "../../shared/text";

/**
 * 把一个路径转成适合粘贴进 shell 的形式（mac/linux 单引号，Windows 双引号）。
 * 文件名里的控制字符（恶意命名的 ESC、换行）一律去掉，免得被 claude 的界面当成按键。
 */
export function quotePath(path: string, platform: string): string {
  const clean = stripControl(path);
  if (platform === "win32") return `"${clean}"`;
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

/** 多个拖入的文件用空格连接，不带回车。 */
export function dropText(paths: string[], platform: string): string {
  return paths.map((p) => quotePath(p, platform)).join(" ");
}
```

`src/main/sessions/pty-manager.ts` 的 `proc.onData` 回调改为：

```ts
    proc.onData((data) => {
      // ConPTY 在进程退出后还可能吐出尾部数据；退出后一律丢弃，否则渲染进程会以为终端被重新打开而清掉退出提示。
      if (term.exited) return;
      term.lastOutputAt = this.now();
      term.buffer = (term.buffer + data).slice(-BUFFER_LIMIT);
      this.events.data(termId, data);
    });
```

`src/main/sessions/session-service.ts`：顶部加 `import { sanitizePrefill } from "../../shared/text";`，`open` 里在 `await this.d.ready();` 之后加一行：

```ts
    const prefill = req.prefill ? sanitizePrefill(req.prefill) : "";
```

并把 `open` 里两处 `if (req.prefill) this.prefill(..., req.prefill ...)` 改成用 `prefill`：

```ts
        if (prefill) this.prefill(existing, prefill, 0);
```

```ts
    if (prefill) this.prefill(termId, prefill);
```

`src/main/logger.ts` 改为：

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Logger = (msg: string, err?: unknown) => void;

const describe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/**
 * 追加写入带时间戳的日志行；同步写，任何失败都被吞掉，绝不抛出。
 * tee 用于 dev 模式下同时打印到控制台。
 */
export function createFileLogger(file: string, now: () => Date = () => new Date(), tee?: (line: string) => void): Logger {
  return (msg, err) => {
    const line = `${now().toISOString()} ${msg}${err === undefined ? "" : ` ${describe(err)}`}`;
    try {
      tee?.(line);
    } catch {
      // 控制台出错不影响写文件。
    }
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${line}\n`);
    } catch {
      // 日志本身不能让主进程出错。
    }
  };
}
```

`src/main/index.ts` 里创建 logger 的那一行改为：

```ts
  logger = createFileLogger(join(paths.logs, "main.log"), undefined, app.isPackaged ? undefined : (line) => console.error(line));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/shared/text.test.ts src/renderer/src/drop.test.ts src/main/sessions src/main/logger.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/shared/text.ts src/shared/text.test.ts src/renderer/src/drop.ts src/renderer/src/drop.test.ts src/main/sessions src/main/logger.ts src/main/logger.test.ts src/main/index.ts
git commit -m "fix: drop pty output after exit, single-line prefill, strip control chars from dropped names, tee logs to console in dev"
```

---

### Task 3: session 记录卫生（计划 1 遗留）

计划 1 遗留：启动 claude 失败或用户一句话没说就退出时，留下一个空的 session 行；先被扫描发现、后来在 Butler 终端里续接的 session 的 `origin` 一直是 `discovered`；hook 每来一次事件，只要 session 没挂 ticket 就扫描整个磁盘。

**Files:**
- Modify: `src/main/db/sessions-repo.ts`, `src/main/db/repos.test.ts`
- Modify: `src/main/sessions/session-service.ts`, `src/main/sessions/session-service.test.ts`
- Modify: `src/main/hooks/hook-events.ts`, `src/main/hooks/hook-events.test.ts`
- Modify: `src/main/sessions/discovery.ts`, `src/main/sessions/discovery.test.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Produces:
  - `SessionsRepo.setOrigin(id: string, origin: SessionOrigin): void`
  - `SessionsRepo.delete(id: string): void`（同时清掉指向它的 `replaced_by`）
  - `SessionService.handleExit(termId: string): void`
  - `needsDiscovery(s: Session, requested: ReadonlySet<string>): boolean`

- [ ] **Step 1: 写失败测试**

`src/main/db/repos.test.ts` 的 `describe("SessionsRepo")` 里追加：

```ts
  it("setOrigin and delete (clearing pointers to the deleted row)", () => {
    const repo = setup();
    repo.insertIfAbsent({ id: "a", ticketKey: "PROJ-1", cwd: "/x", origin: "discovered", createdAt: 1 });
    repo.insertIfAbsent({ id: "b", ticketKey: "PROJ-1", cwd: "/x", origin: "butler", createdAt: 2 });
    repo.setOrigin("a", "butler");
    expect(repo.get("a")?.origin).toBe("butler");
    repo.setReplacedBy("a", "b");
    repo.delete("b");
    expect(repo.get("b")).toBeNull();
    expect(repo.get("a")?.replacedBy).toBeNull();
  });
```

`src/main/sessions/session-service.test.ts`：

1. 顶部 import 增加 `import type { PtyFactory } from "./pty-manager";`（和已有的 `PtyManager` import 合并为 `import { PtyManager, type PtyFactory } from "./pty-manager";`）。
2. `setup` 的参数类型增加 `factory?: PtyFactory`，创建 PtyManager 那一行改为：

```ts
  const pty = new PtyManager(opts.factory ?? factory, { data: () => undefined, exit: () => undefined });
```

3. 文件末尾追加：

```ts
describe("SessionService orphan rows", () => {
  it("removes the row it inserted when claude cannot be spawned", async () => {
    const { service, sessions } = await setup({
      factory: () => {
        throw new Error("spawn ENOENT");
      },
    });
    await expect(service.open({ ticketKey: "PROJ-1" })).rejects.toThrow("spawn ENOENT");
    expect(sessions.listByTicket("PROJ-1")).toEqual([]);
  });

  it("forgets a new session that exited before the first message and keeps real ones", async () => {
    const { service, sessions } = await setup({ transcripts: [] });
    await service.open({ ticketKey: "PROJ-1" });
    await service.open({ ticketKey: "PROJ-1" });
    sessions.fillDetails("new-2", { firstPrompt: "修登录" });
    service.handleExit("new-1");
    service.handleExit("new-2");
    expect(sessions.get("new-1")).toBeNull();
    expect(sessions.get("new-2")).not.toBeNull();
  });

  it("keeps sessions that have a transcript", async () => {
    const { service, sessions } = await setup({ transcripts: ["new-1"] });
    await service.open({ ticketKey: "PROJ-1" });
    service.handleExit("new-1");
    expect(sessions.get("new-1")).not.toBeNull();
  });
});
```

`src/main/hooks/hook-events.test.ts` 的 `describe` 里追加：

```ts
  it("upgrades a discovered session to butler once a Butler terminal reports it", () => {
    const { sessions, deps } = setup();
    sessions.insertIfAbsent({ id: "d1", ticketKey: "PROJ-1", cwd: "/w", origin: "discovered", createdAt: 1 });
    applyHookEnvelope(env("Stop", "d1"), deps);
    expect(sessions.get("d1")?.origin).toBe("discovered");
    applyHookEnvelope(env("UserPromptSubmit", "d1", { ticket: "PROJ-1", butlerSession: "d1" }), deps);
    expect(sessions.get("d1")?.origin).toBe("butler");
  });
```

`src/main/sessions/discovery.test.ts`：import 里加上 `needsDiscovery`，文件末尾追加：

```ts
describe("needsDiscovery", () => {
  const base = {
    id: "a", ticketKey: null, cwd: "/w", origin: "discovered" as const, gitBranch: "main", firstPrompt: "hi",
    lastActivityAt: 1, waitingForInput: false, replacedBy: null, dismissed: false, createdAt: 1,
  };

  it("only asks for a scan when an unclaimed session is missing details, once per session", () => {
    expect(needsDiscovery(base, new Set())).toBe(false);
    expect(needsDiscovery({ ...base, gitBranch: null }, new Set())).toBe(true);
    expect(needsDiscovery({ ...base, cwd: "" }, new Set())).toBe(true);
    expect(needsDiscovery({ ...base, firstPrompt: null }, new Set(["a"]))).toBe(false);
    expect(needsDiscovery({ ...base, gitBranch: null, ticketKey: "PROJ-1" }, new Set())).toBe(false);
    expect(needsDiscovery({ ...base, gitBranch: null, dismissed: true }, new Set())).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/db/repos.test.ts src/main/sessions src/main/hooks/hook-events.test.ts`
Expected: FAIL（`setOrigin`、`delete`、`handleExit`、`needsDiscovery` 不存在；spawn 失败后行还在；origin 没升级）。

- [ ] **Step 3: 实现**

`src/main/db/sessions-repo.ts` 在 `dismiss` 方法后面加：

```ts
  setOrigin(id: string, origin: SessionOrigin): void {
    this.db.prepare(`UPDATE sessions SET origin = ? WHERE id = ?`).run(origin, id);
  }

  /** 删除一行；指向它的 replaced_by 一并清掉，免得前一个 session 被当成“已替换”而从列表里消失。 */
  delete(id: string): void {
    this.db.prepare(`UPDATE sessions SET replaced_by = NULL WHERE replaced_by = ?`).run(id);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  }
```

`src/main/sessions/session-service.ts` 的 `open`：

1. 在 `let args: string[];` 后面加 `let insertedRow = false;`，把新建分支里的 `this.d.sessions.insertIfAbsent({...})` 改成 `insertedRow = this.d.sessions.insertIfAbsent({...});`。
2. `this.d.pty.open(...)` 调用改为：

```ts
    try {
      this.d.pty.open(termId, spawnSpec(claudePath, args, this.d.platform), {
        cwd,
        env: sessionEnv(this.d.baseEnv, { pathValue, ticketKey: ticket.key, sessionId: termId }),
      });
    } catch (e) {
      // claude 没能启动：刚插入的那一行只是空壳，不能留在列表里。
      if (insertedRow) this.d.sessions.delete(termId);
      throw e;
    }
```

3. 在 `open` 后面加方法：

```ts
  /**
   * 终端退出时调用。Butler 新建、但用户一句话都没说就退出的 session 没有 transcript，也不能 --resume；
   * 留着只会多出一个空的“新对话”按钮，删掉。
   */
  handleExit(termId: string): void {
    const s = this.d.sessions.get(termId);
    if (!s || s.origin !== "butler" || s.firstPrompt || s.replacedBy) return;
    if (this.d.transcriptExists(termId)) return;
    this.d.sessions.delete(termId);
  }
```

`src/main/hooks/hook-events.ts` 的 `ensure` 里，`const cur = sessions.get(id);` 之后、`if (key && cur ...` 之前加：

```ts
    // 先被磁盘扫描发现、后来在 Butler 终端里续接的 session：来源升级为 butler。
    if (fromButler && cur && cur.origin === "discovered" && !cur.dismissed) sessions.setOrigin(id, "butler");
```

`src/main/sessions/discovery.ts`：顶部加 `import type { Session } from "../../shared/types";`，文件末尾加：

```ts
/**
 * hook 事件只带 cwd；分支和首条提示要靠扫描磁盘补全。已经齐全、已归属 ticket、已忽略，
 * 或者这次运行里已经为它扫描过的 session，都不再触发扫描。
 */
export function needsDiscovery(s: Session, requested: ReadonlySet<string>): boolean {
  if (s.ticketKey || s.dismissed || requested.has(s.id)) return false;
  return !s.cwd || !s.gitBranch || !s.firstPrompt;
}
```

`src/main/index.ts`：

1. discovery 的 import 加上 `needsDiscovery`。
2. 在 `let hookDiscoveryTimer` 上面加 `const discoveryRequested = new Set<string>();`。
3. inbox `handle` 里触发扫描的部分改为：

```ts
      // 还没归属 ticket、又缺 cwd / 分支 / 首条提示的 session：触发一次发现（每个 session 每次运行最多一次）。
      if (effect.kind !== "nested") {
        const s = sessions.get(effect.sessionId);
        if (s && needsDiscovery(s, discoveryRequested)) {
          discoveryRequested.add(s.id);
          scheduleDiscovery();
        }
      }
```

4. PtyManager 的 `exit` 事件改为：

```ts
    exit: (id, code) => {
      safeSend(IPC.ptyExit, id, code);
      try {
        sessionService.handleExit(id);
      } catch (e) {
        logger("handleExit failed", e);
      }
      notify();
    },
```

（`sessionService` 在 PtyManager 之后才声明；回调只会在终端退出时执行，那时它早已创建好。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/db/repos.test.ts src/main/sessions src/main/hooks/hook-events.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/main/db src/main/sessions src/main/hooks/hook-events.ts src/main/hooks/hook-events.test.ts src/main/index.ts
git commit -m "fix: no orphan session rows, upgrade discovered sessions to butler, scan disk only when details are missing"
```

---

### Task 4: Handoff schema、CLI JSON Schema、宽松解析与模板

设计文档 5.3 节的 schema 用 zod 写一份，既做第二道校验，也用 `z.toJSONSchema` 生成传给 `--json-schema` 的 JSON Schema（验证记录 V1：结构化结果在输出的 `structured_output` 字段，`result` 字段里是同一份 JSON 的字符串）。

**Files:**
- Modify: `package.json`（新增依赖 zod）
- Modify: `src/shared/types.ts`
- Create: `src/shared/handoff.ts`
- Create: `src/main/handoff/schema.ts`
- Create: `src/main/handoff/templates.ts`
- Test: `src/main/handoff/schema.test.ts`

**Interfaces:**
- Produces:
  - `src/shared/types.ts`：`FOLLOWUP_KINDS`、`FollowupKind`、`FOLLOWUP_TRIGGERS`、`FollowupTrigger`
  - `src/shared/handoff.ts`：`PrSchema`、`JiraSchema`、`HandoffFollowupSchema`、`HandoffSchema`、`RefreshSchema`；类型 `Handoff`、`HandoffFollowup`、`RefreshResult`
  - `src/main/handoff/schema.ts`：`toCliJsonSchema(schema)`、`HANDOFF_JSON_SCHEMA`、`REFRESH_JSON_SCHEMA`、`Validated<T>`、`validate<T>(schema, value): Validated<T>`、`parseJsonLoose(text): unknown`、`extractHandoffBlock(text): string | null`、`pickStructured({ structured, resultText }): unknown`、`emptyHandoff(ticket): Handoff`
  - `src/main/handoff/templates.ts`：`HANDOFF_SCHEMA_DOC`、`HANDOFF_EXAMPLE_VALUE`、`HANDOFF_EXAMPLE`、`DEFAULT_HANDOFF_PROMPT`、`DEFAULT_REFRESH_PROMPT`、`HANDOFF_COMMAND_MARKER`、`HANDOFF_COMMAND_MD`

- [ ] **Step 1: 安装 zod**

```bash
pnpm add zod@4.6.5
```

Expected：`package.json` 的 `dependencies` 里出现 `"zod": "4.6.5"`（不带 `^`；如果 pnpm 加了 `^`，手动去掉再 `pnpm install`）。

- [ ] **Step 2: 写失败测试**

`src/main/handoff/schema.test.ts`：

````ts
import { describe, expect, it } from "vitest";
import { HandoffSchema, RefreshSchema } from "../../shared/handoff";
import {
  emptyHandoff, extractHandoffBlock, HANDOFF_JSON_SCHEMA, parseJsonLoose, pickStructured, REFRESH_JSON_SCHEMA, validate,
} from "./schema";
import {
  DEFAULT_HANDOFF_PROMPT, DEFAULT_REFRESH_PROMPT, HANDOFF_COMMAND_MARKER, HANDOFF_COMMAND_MD, HANDOFF_EXAMPLE, HANDOFF_EXAMPLE_VALUE,
} from "./templates";

describe("handoff schema", () => {
  it("accepts the documented example and an empty handoff", () => {
    expect(HandoffSchema.safeParse(JSON.parse(HANDOFF_EXAMPLE)).success).toBe(true);
    expect(HandoffSchema.safeParse(emptyHandoff("PROJ-1")).success).toBe(true);
  });

  it("reports missing and wrong fields with their path", () => {
    const bad: Record<string, unknown> = { ...HANDOFF_EXAMPLE_VALUE, status: "shipping" };
    delete bad.done_today;
    const r = validate(HandoffSchema, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toContain("done_today");
      expect(r.errors).toContain("status");
    }
  });

  it("drops unknown keys instead of failing", () => {
    const r = validate(HandoffSchema, { ...HANDOFF_EXAMPLE_VALUE, extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).not.toHaveProperty("extra");
  });
});

describe("CLI JSON Schema", () => {
  it("describes every handoff field and leaves out constraints claude may not support", () => {
    const s = JSON.parse(HANDOFF_JSON_SCHEMA) as {
      type: string;
      required: string[];
      properties: Record<string, { items?: { properties?: Record<string, unknown> } }>;
    };
    expect(s.type).toBe("object");
    expect([...s.required].sort()).toEqual([
      "blockers", "decisions", "done_today", "followups", "jira", "learnings", "next_steps", "open_questions", "pr", "status", "ticket",
    ]);
    expect(Object.keys(s.properties.followups.items?.properties ?? {})).toContain("due_date");
    for (const key of ["$schema", "minimum", "maximum", "minLength", "pattern"]) expect(HANDOFF_JSON_SCHEMA).not.toContain(`"${key}"`);
  });

  it("refresh schema only asks for status, pr and jira", () => {
    expect((JSON.parse(REFRESH_JSON_SCHEMA) as { required: string[] }).required.sort()).toEqual(["jira", "pr", "status"]);
    expect(RefreshSchema.safeParse({ status: "in_review", pr: null, jira: null }).success).toBe(true);
  });
});

describe("loose parsing", () => {
  it("parses bare JSON, fenced JSON with prose around it, or gives up", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('好的，结果如下：\n```json\n{"a":2}\n```\n以上。')).toEqual({ a: 2 });
    expect(parseJsonLoose("没有 JSON")).toBeUndefined();
  });

  it("takes the last butler-handoff block", () => {
    const text = '示例：\n```butler-handoff\n{"n":1}\n```\n真正的：\n```butler-handoff\n{"n":2}\n```';
    expect(extractHandoffBlock(text)).toBe('{"n":2}');
    expect(extractHandoffBlock('```json\n{}\n```')).toBeNull();
  });

  it("prefers structured_output and falls back to the result text", () => {
    expect(pickStructured({ structured: { a: 1 }, resultText: "x" })).toEqual({ a: 1 });
    expect(pickStructured({ structured: null, resultText: '{"b":2}' })).toEqual({ b: 2 });
  });
});

describe("templates", () => {
  it("default prompts carry every placeholder the runner fills", () => {
    for (const p of ["{{ticket}}", "{{title}}", "{{branch}}", "{{tracker_tools}}", "{{previous_handoff}}", "{{open_followups}}", "{{schema}}", "{{example}}"]) {
      expect(DEFAULT_HANDOFF_PROMPT).toContain(p);
    }
    for (const p of ["{{ticket}}", "{{branch}}", "{{tracker_tools}}", "{{current_status}}", "{{schema}}"]) expect(DEFAULT_REFRESH_PROMPT).toContain(p);
  });

  it("the /handoff command asks for a butler-handoff block and passes arguments", () => {
    expect(HANDOFF_COMMAND_MD.startsWith("---\ndescription:")).toBe(true);
    expect(HANDOFF_COMMAND_MD).toContain(HANDOFF_COMMAND_MARKER);
    expect(HANDOFF_COMMAND_MD).toContain("```butler-handoff");
    expect(HANDOFF_COMMAND_MD).toContain("$ARGUMENTS");
  });
});
````

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/handoff/schema.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现**

`src/shared/types.ts` 在 `TicketStatus` 定义后面追加：

```ts
export const FOLLOWUP_KINDS = ["config", "flag", "deploy", "doc", "other"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];
export const FOLLOWUP_TRIGGERS = ["after_merge", "after_deploy", "on_date", "none"] as const;
export type FollowupTrigger = (typeof FOLLOWUP_TRIGGERS)[number];
```

`src/shared/handoff.ts`：

```ts
import { z } from "zod";
import { FOLLOWUP_KINDS, FOLLOWUP_TRIGGERS, TICKET_STATUSES } from "./types";

/**
 * 设计文档 5.3 节的 handoff schema。
 * 渲染进程只能 `import type` 这个文件里的类型，不要把 zod 打进渲染包。
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PrSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  review: z.enum(["pending", "changes_requested", "approved"]).nullable(),
});

export const JiraSchema = z.object({
  status: z.string(),
  subtasks: z.array(z.object({ key: z.string(), status: z.string() })),
});

export const HandoffFollowupSchema = z.object({
  id: z.string().nullable(),
  kind: z.enum(FOLLOWUP_KINDS),
  description: z.string().min(1),
  trigger: z.enum(FOLLOWUP_TRIGGERS),
  due_date: isoDate.nullable(),
  done: z.boolean(),
});

export const HandoffSchema = z.object({
  ticket: z.string(),
  status: z.enum(TICKET_STATUSES),
  done_today: z.array(z.string()),
  next_steps: z.array(z.string()),
  blockers: z.array(z.string()),
  pr: PrSchema.nullable(),
  jira: JiraSchema.nullable(),
  followups: z.array(HandoffFollowupSchema),
  decisions: z.array(z.object({ key: z.string(), statement: z.string() })),
  learnings: z.array(z.string()),
  open_questions: z.array(z.string()),
});

/** 早间快速刷新只查 PR 和 tracker 状态（schema 的子集）。 */
export const RefreshSchema = z.object({
  status: z.enum(TICKET_STATUSES),
  pr: PrSchema.nullable(),
  jira: JiraSchema.nullable(),
});

export type Handoff = z.infer<typeof HandoffSchema>;
export type HandoffFollowup = z.infer<typeof HandoffFollowupSchema>;
export type RefreshResult = z.infer<typeof RefreshSchema>;
```

`src/main/handoff/schema.ts`：

```ts
import { z } from "zod";
import { HandoffSchema, RefreshSchema, type Handoff } from "../../shared/handoff";

/** 这些约束只交给 zod 校验；传给 --json-schema 的版本里去掉，免得 claude 那一侧不支持而整个请求失败。 */
const DROPPED_KEYS = new Set(["$schema", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "pattern", "format"]);

function strip(node: unknown, isPropertyMap = false): unknown {
  if (Array.isArray(node)) return node.map((n) => strip(n));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    // properties 里的键是字段名，不能当成约束去掉。
    if (!isPropertyMap && DROPPED_KEYS.has(k)) continue;
    out[k] = strip(v, !isPropertyMap && k === "properties");
  }
  return out;
}

export function toCliJsonSchema(schema: z.ZodType): string {
  return JSON.stringify(strip(z.toJSONSchema(schema, { target: "draft-7" })));
}

export const HANDOFF_JSON_SCHEMA = toCliJsonSchema(HandoffSchema);
export const REFRESH_JSON_SCHEMA = toCliJsonSchema(RefreshSchema);

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string };

export function validate<T>(schema: z.ZodType<T>, value: unknown): Validated<T> {
  const r = schema.safeParse(value);
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: z.prettifyError(r.error) };
}

/** claude 的文本输出里找 JSON：整段就是 JSON，或者在代码块里（从最后一个往前试）。 */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // 继续找代码块。
  }
  const blocks = [...t.matchAll(/```[^\n]*\n([\s\S]*?)\n?```/g)].map((m) => m[1]);
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(blocks[i]);
    } catch {
      // 试下一个。
    }
  }
  return undefined;
}

const HANDOFF_BLOCK_RE = /```butler-handoff[^\n]*\n([\s\S]*?)\n?```/g;

/** 最后一个 ```butler-handoff 代码块的内容；没有就是 null。 */
export function extractHandoffBlock(text: string): string | null {
  const all = [...text.matchAll(HANDOFF_BLOCK_RE)];
  return all.length ? all[all.length - 1][1].trim() : null;
}

/** `--json-schema` 的结果在 structured_output；没有时退回解析 result 文本。 */
export function pickStructured(r: { structured: unknown; resultText: string }): unknown {
  return r.structured !== null && r.structured !== undefined ? r.structured : parseJsonLoose(r.resultText);
}

export function emptyHandoff(ticket: string): Handoff {
  return {
    ticket, status: "active", done_today: [], next_steps: [], blockers: [], pr: null, jira: null,
    followups: [], decisions: [], learnings: [], open_questions: [],
  };
}
```

`src/main/handoff/templates.ts`：

````ts
import type { Handoff } from "../../shared/handoff";

const FENCE = "```";

/** 给 claude 看的字段说明，和 src/shared/handoff.ts 的 zod schema 一一对应。 */
export const HANDOFF_SCHEMA_DOC = `{
  ticket: string,                 // ticket 号，例如 "PROJ-123"
  status: "active" | "in_review" | "blocked" | "merged_pending_followup" | "done",
  done_today: string[],           // 今天实际完成的事
  next_steps: string[],           // 接下来要做的事，第一条是明天最先做的一步
  blockers: string[],             // 卡住的原因，没有就是 []
  pr: null | {                    // 没有 PR 就是 null
    number: number, url: string,
    state: "open" | "merged" | "closed",
    review: "pending" | "changes_requested" | "approved" | null
  },
  jira: null | {                  // tracker 读不到就是 null，不要编造
    status: string,
    subtasks: { key: string, status: string }[]
  },
  followups: {                    // 合并或部署之后还要做的事
    id: string | null,            // 已有的项填原来的 id；新项填 null
    kind: "config" | "flag" | "deploy" | "doc" | "other",
    description: string,
    trigger: "after_merge" | "after_deploy" | "on_date" | "none",
    due_date: string | null,      // YYYY-MM-DD，只有 trigger 是 on_date 时填写
    done: boolean
  }[],
  decisions: { key: string, statement: string }[],   // 做出的决定，key 用简短的英文标识
  learnings: string[],            // 以后别的 ticket 也用得上的经验
  open_questions: string[]
}`;

export const HANDOFF_EXAMPLE_VALUE: Handoff = {
  ticket: "PROJ-123",
  status: "in_review",
  done_today: ["登录页改用新的 token 刷新逻辑", "补了 refresh 失败的单元测试"],
  next_steps: ["根据 review 意见拆分 AuthService", "合并后改 staging 的 token TTL 配置"],
  blockers: [],
  pr: { number: 456, url: "https://github.com/acme/web/pull/456", state: "open", review: "pending" },
  jira: { status: "In Review", subtasks: [{ key: "PROJ-124", status: "Done" }] },
  followups: [
    { id: "f_1a2b3c4d", kind: "config", description: "改 staging 的 token TTL 为 15 分钟", trigger: "after_merge", due_date: null, done: false },
    { id: null, kind: "flag", description: "全量打开 new_login 开关", trigger: "on_date", due_date: "2026-10-30", done: false },
  ],
  decisions: [{ key: "token-storage", statement: "refresh token 只放 httpOnly cookie" }],
  learnings: ["本仓库的 e2e 需要先跑 pnpm seed"],
  open_questions: ["TTL 是否需要和移动端一致？"],
};

export const HANDOFF_EXAMPLE = JSON.stringify(HANDOFF_EXAMPLE_VALUE, null, 2);

/** 晚间批量和“立即 handoff”用的默认 prompt（设置里可改）。占位符由 src/main/handoff/prompt.ts 填充。 */
export const DEFAULT_HANDOFF_PROMPT = `你在为 Butler 生成 ticket {{ticket}}（{{title}}，分支 {{branch}}）的 handoff：总结这个 session 到目前为止的进度，供明天早上的简报使用。

要求：
1. 用 tracker MCP 工具读取 ticket {{ticket}} 的描述、评论和子任务。可用的工具：{{tracker_tools}}。工具不可用或读取失败时 jira 填 null，不要编造。
2. 用 \`gh pr view {{branch}}\` 和 \`gh pr checks {{branch}}\` 读取 PR 状态；没有 PR 时 pr 填 null。
3. 只读：不要修改任何文件，不要提交或推送。
4. followups 是“合并或部署之后还要做的事”（改配置、开关 feature flag、部署、写文档等）。下面列出了已有的 followups：已有的项保留原来的 id；已经做完的 done 填 true；新发现的项 id 填 null。
5. done_today 只写今天实际完成的事；next_steps 的第一条写明天最先要做的一步。

上一次 handoff：
{{previous_handoff}}

已有的 followups：
{{open_followups}}

输出一个 JSON 对象，字段如下：
{{schema}}

示例：
{{example}}
`;

/** 早间快速刷新用的默认 prompt（不 resume，只查 PR 和 tracker 状态）。 */
export const DEFAULT_REFRESH_PROMPT = `只查询 ticket {{ticket}}（分支 {{branch}}）的最新状态，不要总结对话，也不要修改任何文件。

1. 用 \`gh pr view {{branch}}\` 查询 PR 的 state 和 review 状态；没有 PR 时 pr 填 null。
2. 用 tracker MCP 工具查询 ticket {{ticket}} 的状态和子任务。可用的工具：{{tracker_tools}}。不可用时 jira 填 null。
3. status：PR 已合并填 merged_pending_followup；PR 打开中填 in_review；其他情况沿用当前状态 {{current_status}}。

只输出一个 JSON 对象，包含 status、pr、jira 三个字段，含义同下：
{{schema}}
`;

/** handoff.md 里的标记行：有它才说明文件是 Butler 写的，可以更新或卸载。 */
export const HANDOFF_COMMAND_MARKER = "<!-- butler:handoff-command v1 -->";

/** 写入 Claude Code 用户级 commands 目录的 /handoff 命令。 */
export const HANDOFF_COMMAND_MD = `---
description: 生成 Butler handoff（当前 ticket 的进度摘要）
---
${HANDOFF_COMMAND_MARKER}
请为当前 session 对应的 ticket 生成一份 handoff，供 Butler 的早间简报使用。

- 依据这个 session 的完整对话；如果可以，再用 tracker MCP 工具和 \`gh pr view\` 确认 ticket 与 PR 的最新状态。
- 只读：不要修改文件，不要提交或推送。
- ticket 填当前的 ticket 号（通常在分支名里，例如 PROJ-123）。
- 已有的 followup 如果知道 id 就填 id，否则 id 填 null。
- 最后输出一个 ${FENCE}butler-handoff 代码块，里面只有一个 JSON 对象；代码块之后不要再写任何内容。

字段如下：
${HANDOFF_SCHEMA_DOC}

示例：
${FENCE}butler-handoff
${HANDOFF_EXAMPLE}
${FENCE}

$ARGUMENTS
`;
````

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/handoff/schema.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add package.json pnpm-lock.yaml src/shared/types.ts src/shared/handoff.ts src/main/handoff
git commit -m "feat: handoff schema with zod, CLI JSON schema, loose parsing and default prompt templates"
```

---

### Task 5: 迁移 2、数据仓库与设置值

**Files:**
- Modify: `src/main/db/migrations.ts`, `src/main/db/database.ts`
- Modify: `src/main/db/tickets-repo.ts`, `src/main/db/settings-repo.ts`, `src/main/ipc/register.ts`
- Create: `src/main/db/handoffs-repo.ts`, `src/main/db/followups-repo.ts`, `src/main/db/briefs-repo.ts`, `src/main/db/marks-repo.ts`, `src/main/db/jobs-repo.ts`
- Modify: `src/shared/types.ts`
- Create: `src/shared/brief.ts`, `src/shared/settings.ts`
- Create: `src/main/settings/settings-values.ts`
- Test: `src/main/db/handoff-repos.test.ts`, `src/main/settings/settings-values.test.ts`

**Interfaces:**
- Consumes: `Handoff`（任务 4）、`DEFAULT_HANDOFF_PROMPT` / `DEFAULT_REFRESH_PROMPT`（任务 4）
- Produces:
  - `withTransaction<T>(db: Db, fn: () => T): T`
  - `TicketsRepo.setStatus(key, status, at)`、`TicketsRepo.setStatusManual(key, status, at = null)`、`TicketsRepo.statusTimes(key): { changedAt: number | null; manualAt: number | null }`
  - `HandoffsRepo`：`insert(h: NewHandoff): number | null`、`get(id)`、`listByTicket(key, limit = 50)`、`latest(key)`、`latestValid(key)`、`lastCapturedAt(key): number | null`、`listBetween(fromMs, toMs)`
  - `FollowupsRepo`：`insert(f: Followup)`、`get(id)`、`listByTicket(key)`、`listActiveTickets()`、`update(id, patch: FollowupPatch)`、`setStatus(id, status, at, snoozedUntil = null)`
  - `BriefsRepo`：`insert(b: NewBrief): Brief`、`latest(kind): Brief | null`
  - `MarksRepo`：`set(itemKey, mark, untilDate, at)`、`all(): Map<string, MarkState>`
  - `JobsRepo`：`get(name): JobState`、`record(name, at, status, error)`；常量 `JOB_NIGHTLY = "nightly_handoff"`、`JOB_EVENING = "evening_brief"`、`JOB_MORNING = "morning_brief"`
  - `SettingsRepo.reset(key)`；`SETTING_DEFAULTS` 新增 `nightlyTime`、`workingDays`、`trackerTools`、`blockedDays`、`reviewWaitDays`、`staleDays`、`handoffPrompt`、`refreshPrompt`
  - `src/shared/types.ts`：`FOLLOWUP_STATUSES`、`FollowupStatus`、`FollowupSource`、`Followup`、`HandoffTrigger`、`HandoffRecord`
  - `src/shared/brief.ts`：`BriefKind`、`BriefSection`、`BriefRule`、`NarrativeStatus`、`ITEM_MARKS`、`ItemMark`、`MarkState`、`BriefItem`、`DayEntry`、`EveningEntry`、`BriefNotices`、`BriefContent`、`EMPTY_BRIEF_CONTENT`、`Brief`、`BriefView`
  - `src/shared/settings.ts`：`EDITABLE_SETTINGS`、`EditableSettingKey`、`EditableSettings`、`isEditableSetting(k)`
  - `src/main/settings/settings-values.ts`：`SettingError`（`code = "invalid_setting"`）、`ScheduleConfig`、`Thresholds`、`parseTime`、`parseWorkingDays`、`parseToolList`、`parseDays`、`normalizeSetting`、`scheduleConfig(settings)`、`thresholds(settings)`、`trackerTools(settings)`

- [ ] **Step 1: 写失败测试**

`src/main/db/handoff-repos.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Followup, Ticket } from "../../shared/types";
import { emptyHandoff } from "../handoff/schema";
import { memDb } from "../test-utils";
import { BriefsRepo } from "./briefs-repo";
import { withTransaction } from "./database";
import { FollowupsRepo } from "./followups-repo";
import { HandoffsRepo } from "./handoffs-repo";
import { JOB_NIGHTLY, JobsRepo } from "./jobs-repo";
import { MarksRepo } from "./marks-repo";
import { MIGRATIONS } from "./migrations";
import { SettingsRepo } from "./settings-repo";
import { TicketsRepo } from "./tickets-repo";

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => ({
  key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: `feature/${key}`,
  status: "active", statusManual: null, createdAt: 1, archivedAt: null, ...over,
});

const followup = (id: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "PROJ-1", kind: "config", description: `desc ${id}`, trigger: "after_merge", dueDate: null,
  status: "open", snoozedUntil: null, source: "session", createdAt: 10, doneAt: null, ...over,
});

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert(ticket("PROJ-1"));
  return { db, tickets };
}

describe("migration 2", () => {
  it("brings the schema to the latest version", () => {
    const { db } = setup();
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ["handoffs", "followups", "briefs", "item_marks", "jobs"]) expect(tables).toContain(t);
  });
});

describe("TicketsRepo status times", () => {
  it("moves status_changed_at only when the derived status changes, and records manual changes", () => {
    const { tickets } = setup();
    tickets.setStatus("PROJ-1", "active", 100);
    expect(tickets.statusTimes("PROJ-1").changedAt).toBeNull();
    tickets.setStatus("PROJ-1", "blocked", 200);
    tickets.setStatus("PROJ-1", "blocked", 300);
    expect(tickets.get("PROJ-1")?.status).toBe("blocked");
    expect(tickets.statusTimes("PROJ-1").changedAt).toBe(200);
    tickets.setStatusManual("PROJ-1", "in_review", 400);
    expect(tickets.statusTimes("PROJ-1").manualAt).toBe(400);
    tickets.setStatusManual("PROJ-1", null, 500);
    expect(tickets.statusTimes("PROJ-1")).toEqual({ changedAt: 200, manualAt: null });
  });
});

describe("HandoffsRepo", () => {
  it("appends, finds the latest (valid) one, and ignores a repeated sourceRef", () => {
    const { db } = setup();
    const repo = new HandoffsRepo(db);
    const payload = { ...emptyHandoff("PROJ-1"), next_steps: ["a"] };
    const a = repo.insert({ ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", createdAt: 100, payload, rawText: "{}" });
    const b = repo.insert({ ticketKey: "PROJ-1", sessionId: "s1", trigger: "command", createdAt: 200, payload: null, rawText: "oops", sourceRef: "u1" });
    expect(repo.insert({ ticketKey: "PROJ-1", sessionId: "s1", trigger: "command", createdAt: 300, payload: null, rawText: "oops", sourceRef: "u1" })).toBeNull();
    repo.insert({ ticketKey: "PROJ-1", sessionId: null, trigger: "refresh", createdAt: 400, payload, rawText: null });
    expect(typeof a).toBe("number");
    expect(repo.get(b!)).toMatchObject({ degraded: true, rawText: "oops", sourceRef: "u1", payload: null });
    expect(repo.latest("PROJ-1")?.trigger).toBe("refresh");
    expect(repo.latestValid("PROJ-1")?.createdAt).toBe(400);
    expect(repo.lastCapturedAt("PROJ-1")).toBe(200);
    expect(repo.lastCapturedAt("NOPE-1")).toBeNull();
    expect(repo.listByTicket("PROJ-1").map((h) => h.createdAt)).toEqual([400, 200, 100]);
    expect(repo.listBetween(150, 400).map((h) => h.createdAt)).toEqual([200]);
  });

  it("treats an unreadable payload as degraded", () => {
    const { db } = setup();
    db.prepare(`INSERT INTO handoffs (ticket_key, trigger, created_at, payload, degraded) VALUES ('PROJ-1', 'nightly', 1, '{broken', 0)`).run();
    expect(new HandoffsRepo(db).latest("PROJ-1")).toMatchObject({ payload: null, degraded: true });
  });
});

describe("FollowupsRepo", () => {
  it("inserts, updates, changes status and hides archived tickets", () => {
    const { db, tickets } = setup();
    tickets.insert(ticket("OLD-1"));
    const repo = new FollowupsRepo(db);
    repo.insert(followup("f1"));
    repo.insert(followup("f2", { trigger: "on_date", dueDate: "2026-10-30" }));
    repo.insert(followup("f3", { ticketKey: "OLD-1" }));
    repo.update("f1", { description: "new text", trigger: "none" });
    expect(repo.get("f1")).toMatchObject({ description: "new text", trigger: "none", kind: "config" });
    repo.update("f2", { dueDate: null });
    expect(repo.get("f2")?.dueDate).toBeNull();
    repo.setStatus("f1", "done", 50);
    expect(repo.get("f1")).toMatchObject({ status: "done", doneAt: 50 });
    repo.setStatus("f1", "snoozed", 60, "2026-10-22");
    expect(repo.get("f1")).toMatchObject({ status: "snoozed", doneAt: null, snoozedUntil: "2026-10-22" });
    expect(repo.listByTicket("PROJ-1").map((f) => f.id)).toEqual(["f1", "f2"]);
    tickets.archive("OLD-1", 5);
    expect(repo.listActiveTickets().map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});

describe("BriefsRepo / MarksRepo / JobsRepo / SettingsRepo", () => {
  it("round-trips a brief and returns the latest of a kind", () => {
    const { db } = setup();
    const repo = new BriefsRepo(db);
    const content = { items: [], previousDay: { date: "2026-10-20", entries: [{ ticketKey: "PROJ-1", done: ["x"] }] }, evening: [], notices: { degraded: [], trackerUnavailable: ["PROJ-1"] } };
    repo.insert({ kind: "morning", date: "2026-10-20", createdAt: 1, content, narrative: null, narrativeStatus: "off" });
    const second = repo.insert({ kind: "morning", date: "2026-10-21", createdAt: 2, content, narrative: null, narrativeStatus: "off" });
    expect(repo.latest("morning")).toEqual(second);
    expect(second).toMatchObject({ kind: "morning", date: "2026-10-21", narrative: null, narrativeStatus: "off", notices: { trackerUnavailable: ["PROJ-1"] } });
    expect(repo.latest("evening")).toBeNull();
  });

  it("upserts item marks", () => {
    const repo = new MarksRepo(memDb());
    repo.set("next:PROJ-1:3", "snoozed", "2026-10-22", 1);
    repo.set("next:PROJ-1:3", "done", null, 2);
    expect(repo.all().get("next:PROJ-1:3")).toEqual({ mark: "done", untilDate: null });
  });

  it("records jobs", () => {
    const repo = new JobsRepo(memDb());
    expect(repo.get(JOB_NIGHTLY)).toEqual({ lastRunAt: null, lastStatus: null, lastError: null });
    repo.record(JOB_NIGHTLY, 5, "partial", "429");
    repo.record(JOB_NIGHTLY, 6, "ok", null);
    expect(repo.get(JOB_NIGHTLY)).toEqual({ lastRunAt: 6, lastStatus: "ok", lastError: null });
  });

  it("has schedule defaults and resets overrides", () => {
    const repo = new SettingsRepo(memDb());
    expect(repo.get("nightlyTime")).toBe("16:00");
    expect(repo.get("workingDays")).toBe("1,2,3,4,5");
    repo.set("nightlyTime", "18:30");
    repo.reset("nightlyTime");
    expect(repo.get("nightlyTime")).toBe("16:00");
  });
});

describe("withTransaction", () => {
  it("rolls back everything when the callback throws", () => {
    const { db, tickets } = setup();
    expect(() =>
      withTransaction(db, () => {
        tickets.insert(ticket("PROJ-2"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(tickets.get("PROJ-2")).toBeNull();
    expect(withTransaction(db, () => 7)).toBe(7);
  });
});
```

`src/main/settings/settings-values.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { SettingsRepo } from "../db/settings-repo";
import { memDb } from "../test-utils";
import { normalizeSetting, parseDays, parseTime, parseToolList, parseWorkingDays, scheduleConfig, SettingError, thresholds, trackerTools } from "./settings-values";

describe("settings values", () => {
  it("parses times, working days, day counts and tool lists", () => {
    expect(parseTime("16:00")).toEqual({ h: 16, m: 0 });
    expect(parseTime("7:05")).toEqual({ h: 7, m: 5 });
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("16")).toBeNull();
    expect([...parseWorkingDays("1, 2,5,9,x")]).toEqual([1, 2, 5]);
    expect(parseDays("3", 2)).toBe(3);
    expect(parseDays("-1", 2)).toBe(2);
    expect(parseToolList("mcp__jira__get_issue, Bash(git status)\nmcp__jira__search mcp__jira__get_issue")).toEqual([
      "mcp__jira__get_issue", "Bash(git status)", "mcp__jira__search",
    ]);
  });

  it("normalizes editable values and rejects bad ones with a SettingError", () => {
    expect(normalizeSetting("nightlyTime", "7:05")).toBe("07:05");
    expect(normalizeSetting("workingDays", "5,1,1,0")).toBe("0,1,5");
    expect(normalizeSetting("workingDays", "")).toBe("");
    expect(normalizeSetting("trackerTools", "a, b\n\na")).toBe("a\nb");
    expect(normalizeSetting("staleDays", " 7 ")).toBe("7");
    expect(() => normalizeSetting("nightlyTime", "25:00")).toThrow(SettingError);
    expect(() => normalizeSetting("workingDays", "1,7")).toThrow(SettingError);
    expect(() => normalizeSetting("blockedDays", "two")).toThrow(SettingError);
    expect(() => normalizeSetting("handoffPrompt", "   ")).toThrow(SettingError);
    try {
      normalizeSetting("nightlyTime", "x");
    } catch (e) {
      expect((e as SettingError).code).toBe("invalid_setting");
    }
  });

  it("reads the schedule, thresholds and tracker tools from settings", () => {
    const s = new SettingsRepo(memDb());
    expect(scheduleConfig(s)).toEqual({ nightly: { h: 16, m: 0 }, workingDays: new Set([1, 2, 3, 4, 5]) });
    expect(thresholds(s)).toEqual({ blockedDays: 2, reviewWaitDays: 2, staleDays: 5 });
    expect(trackerTools(s)).toEqual([]);
    s.set("nightlyTime", "garbage");
    expect(scheduleConfig(s).nightly).toEqual({ h: 16, m: 0 });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/db src/main/settings`
Expected: FAIL（新模块不存在）。

- [ ] **Step 3: 实现共享类型**

`src/shared/types.ts`：

1. 文件第一行加 `import type { Handoff } from "./handoff";`（只用类型，运行时没有循环依赖）。
2. 在 `FollowupTrigger` 后面追加：

```ts
export const FOLLOWUP_STATUSES = ["open", "done", "snoozed", "ignored"] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];
export type FollowupSource = "jira" | "session" | "manual";

export interface Followup {
  id: string;
  ticketKey: string;
  kind: FollowupKind;
  description: string;
  trigger: FollowupTrigger;
  /** YYYY-MM-DD，只有 trigger 为 on_date 时有值。 */
  dueDate: string | null;
  status: FollowupStatus;
  /** YYYY-MM-DD；推迟到这一天（含）重新出现。 */
  snoozedUntil: string | null;
  source: FollowupSource;
  createdAt: number;
  doneAt: number | null;
}

export type HandoffTrigger = "nightly" | "manual" | "command" | "refresh";

export interface HandoffRecord {
  id: number;
  ticketKey: string;
  sessionId: string | null;
  trigger: HandoffTrigger;
  createdAt: number;
  /** 校验通过的 handoff；degraded 时为 null。 */
  payload: Handoff | null;
  degraded: boolean;
  rawText: string | null;
  sourceRef: string | null;
}
```

`src/shared/brief.ts`：

```ts
export type BriefKind = "morning" | "evening";
export type BriefSection = "first" | "today" | "watch";
export type BriefRule =
  | "pr_approved"
  | "pr_changes_requested"
  | "followup_after_merge"
  | "followup_due"
  | "next_step"
  | "blocked_long"
  | "review_waiting"
  | "stale"
  | "unclaimed";
export type NarrativeStatus = "ok" | "off" | "failed" | "blocked" | "budget";

export const ITEM_MARKS = ["done", "snoozed", "ignored"] as const;
export type ItemMark = (typeof ITEM_MARKS)[number];
export interface MarkState {
  mark: ItemMark;
  /** 只有 snoozed 有值：到这一天（含）重新出现。 */
  untilDate: string | null;
}

/** 简报里的一条。文案由渲染进程按 rule 拼（strings.ts），这里只放数据。 */
export interface BriefItem {
  /** 稳定 id：followup 条目是 `followup:<id>`；其余条目的“完成/推迟/忽略”按这个 key 记在 item_marks 里。 */
  key: string;
  section: BriefSection;
  rule: BriefRule;
  ticketKey: string | null;
  followupId: string | null;
  /** next step、followup 描述或阻塞原因。 */
  text: string | null;
  /** 阻塞 / 等 review / 无活动 / 逾期的天数。 */
  days: number | null;
  /** 未认领 session 的数量。 */
  count: number | null;
  pr: { number: number; url: string } | null;
  dueDate: string | null;
}

export interface DayEntry {
  ticketKey: string;
  done: string[];
}

export interface EveningEntry {
  ticketKey: string;
  done: string[];
  blockers: string[];
  next: string | null;
  degraded: boolean;
}

export interface BriefNotices {
  /** 最新一次 handoff 不完整的 ticket。 */
  degraded: string[];
  /** 最新一次 handoff 的 jira 为 null（tracker MCP 不可用）的 ticket。 */
  trackerUnavailable: string[];
}

export interface BriefContent {
  items: BriefItem[];
  /** 早间简报：上个工作日完成的事。晚间小结为 null。 */
  previousDay: { date: string; entries: DayEntry[] } | null;
  /** 晚间小结：今天每个 ticket 的进展。早间简报为空。 */
  evening: EveningEntry[];
  notices: BriefNotices;
}

export const EMPTY_BRIEF_CONTENT: BriefContent = { items: [], previousDay: null, evening: [], notices: { degraded: [], trackerUnavailable: [] } };

export interface Brief extends BriefContent {
  id: number;
  kind: BriefKind;
  /** YYYY-MM-DD（本地日期）。 */
  date: string;
  createdAt: number;
  /** 计划 3 的“今日重点”。计划 2 永远是 null，narrativeStatus 永远是 "off"。 */
  narrative: string | null;
  narrativeStatus: NarrativeStatus;
}

export interface BriefView {
  brief: Brief | null;
  /** 早间刷新（查询 PR / tracker）进行中。 */
  refreshing: boolean;
}
```

`src/shared/settings.ts`：

```ts
/** 渲染进程可以读写的设置。其余设置（claudePath、branchTemplate 等）由计划 4 的设置页处理。 */
export const EDITABLE_SETTINGS = [
  "nightlyTime",
  "workingDays",
  "trackerTools",
  "blockedDays",
  "reviewWaitDays",
  "staleDays",
  "handoffPrompt",
  "refreshPrompt",
] as const;

export type EditableSettingKey = (typeof EDITABLE_SETTINGS)[number];
export type EditableSettings = Record<EditableSettingKey, string>;

export function isEditableSetting(key: string): key is EditableSettingKey {
  return (EDITABLE_SETTINGS as readonly string[]).includes(key);
}
```

- [ ] **Step 4: 实现迁移与数据库工具**

`src/main/db/migrations.ts` 的数组末尾（第一个字符串之后）追加第二个元素：

```ts
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
```

（`briefs.items` 存整个 `BriefContent` 的 JSON：条目、上个工作日、晚间小结和提示。`jobs` 表在迁移 1 里已经有了。）

`src/main/db/database.ts` 末尾追加：

```ts
/** 同步事务：fn 抛错时整体回滚。fn 里不能有 await。 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
```

- [ ] **Step 5: 实现数据仓库**

`src/main/db/tickets-repo.ts`：`setStatusManual` 替换为下面三个方法：

```ts
  /** 自动推导出的状态。只有状态真的变化时才更新 status_changed_at（UPDATE 右边读到的是旧值）。 */
  setStatus(key: string, status: TicketStatus, at: number): void {
    this.db
      .prepare(`UPDATE tickets SET status_changed_at = CASE WHEN status = ? THEN status_changed_at ELSE ? END, status = ? WHERE key = ?`)
      .run(status, at, status, key);
  }

  setStatusManual(key: string, status: TicketStatus | null, at: number | null = null): void {
    this.db.prepare(`UPDATE tickets SET status_manual = ?, status_manual_at = ? WHERE key = ?`).run(status, status ? at : null, key);
  }

  statusTimes(key: string): { changedAt: number | null; manualAt: number | null } {
    const r = this.db.prepare(`SELECT status_changed_at, status_manual_at FROM tickets WHERE key = ?`).get(key) as
      | { status_changed_at: number | null; status_manual_at: number | null }
      | undefined;
    return { changedAt: r?.status_changed_at ?? null, manualAt: r?.status_manual_at ?? null };
  }
```

`src/main/ipc/register.ts` 的 `ticketsSetStatus` 处理器改为 `d.tickets.setStatusManual(key, status, d.now());`。

`src/main/db/handoffs-repo.ts`：

```ts
import type { Handoff } from "../../shared/handoff";
import type { HandoffRecord, HandoffTrigger } from "../../shared/types";
import type { Db } from "./database";

interface HandoffRow {
  id: number;
  ticket_key: string;
  session_id: string | null;
  trigger: string;
  created_at: number;
  payload: string | null;
  degraded: number;
  raw_text: string | null;
  source_ref: string | null;
}

function parsePayload(text: string | null): Handoff | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as Handoff;
  } catch {
    return null;
  }
}

function toRecord(r: HandoffRow): HandoffRecord {
  const payload = parsePayload(r.payload);
  return {
    id: r.id,
    ticketKey: r.ticket_key,
    sessionId: r.session_id,
    trigger: r.trigger as HandoffTrigger,
    createdAt: r.created_at,
    payload,
    degraded: r.degraded === 1 || payload === null,
    rawText: r.raw_text,
    sourceRef: r.source_ref,
  };
}

export interface NewHandoff {
  ticketKey: string;
  sessionId: string | null;
  trigger: HandoffTrigger;
  createdAt: number;
  /** null 表示 degraded（校验失败）。 */
  payload: Handoff | null;
  rawText: string | null;
  /** /handoff 输出所在的 transcript 条目 uuid，用来去重。 */
  sourceRef?: string | null;
}

export class HandoffsRepo {
  constructor(private readonly db: Db) {}

  /** 只追加。sourceRef 重复（同一个 /handoff 输出被处理两次）时不插入，返回 null。 */
  insert(h: NewHandoff): number | null {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO handoffs (ticket_key, session_id, trigger, created_at, payload, degraded, raw_text, source_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(h.ticketKey, h.sessionId, h.trigger, h.createdAt, h.payload ? JSON.stringify(h.payload) : null, h.payload ? 0 : 1, h.rawText, h.sourceRef ?? null);
    return Number(r.changes) > 0 ? Number(r.lastInsertRowid) : null;
  }

  get(id: number): HandoffRecord | null {
    const row = this.db.prepare(`SELECT * FROM handoffs WHERE id = ?`).get(id) as HandoffRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 最新的在前。 */
  listByTicket(ticketKey: string, limit = 50): HandoffRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(ticketKey, limit) as unknown as HandoffRow[];
    return rows.map(toRecord);
  }

  /** 最新的一条（任何触发方式，可能是 degraded）。 */
  latest(ticketKey: string): HandoffRecord | null {
    return this.listByTicket(ticketKey, 1)[0] ?? null;
  }

  /** 最新的一条完整 handoff（含刷新）。 */
  latestValid(ticketKey: string): HandoffRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM handoffs WHERE ticket_key = ? AND degraded = 0 AND payload IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`)
      .get(ticketKey) as HandoffRow | undefined;
    const rec = row ? toRecord(row) : null;
    return rec && rec.payload ? rec : null;
  }

  /** 最近一次读过 session 的 handoff（不算早间刷新）的时间；晚间批量据此判断有没有新活动。 */
  lastCapturedAt(ticketKey: string): number | null {
    const r = this.db.prepare(`SELECT MAX(created_at) AS at FROM handoffs WHERE ticket_key = ? AND trigger != 'refresh'`).get(ticketKey) as
      | { at: number | null }
      | undefined;
    return r?.at ?? null;
  }

  /** created_at 在 [fromMs, toMs) 之间，旧的在前。 */
  listBetween(fromMs: number, toMs: number): HandoffRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id`)
      .all(fromMs, toMs) as unknown as HandoffRow[];
    return rows.map(toRecord);
  }
}
```

`src/main/db/followups-repo.ts`：

```ts
import type { Followup, FollowupKind, FollowupSource, FollowupStatus, FollowupTrigger } from "../../shared/types";
import type { Db } from "./database";

interface FollowupRow {
  id: string;
  ticket_key: string;
  kind: string;
  description: string;
  trigger: string;
  due_date: string | null;
  status: string;
  snoozed_until: string | null;
  source: string;
  created_at: number;
  done_at: number | null;
}

function toFollowup(r: FollowupRow): Followup {
  return {
    id: r.id,
    ticketKey: r.ticket_key,
    kind: r.kind as FollowupKind,
    description: r.description,
    trigger: r.trigger as FollowupTrigger,
    dueDate: r.due_date,
    status: r.status as FollowupStatus,
    snoozedUntil: r.snoozed_until,
    source: r.source as FollowupSource,
    createdAt: r.created_at,
    doneAt: r.done_at,
  };
}

export interface FollowupPatch {
  kind?: FollowupKind;
  description?: string;
  trigger?: FollowupTrigger;
  dueDate?: string | null;
}

export class FollowupsRepo {
  constructor(private readonly db: Db) {}

  insert(f: Followup): void {
    this.db
      .prepare(
        `INSERT INTO followups (id, ticket_key, kind, description, trigger, due_date, status, snoozed_until, source, created_at, done_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.id, f.ticketKey, f.kind, f.description, f.trigger, f.dueDate, f.status, f.snoozedUntil, f.source, f.createdAt, f.doneAt);
  }

  get(id: string): Followup | null {
    const row = this.db.prepare(`SELECT * FROM followups WHERE id = ?`).get(id) as FollowupRow | undefined;
    return row ? toFollowup(row) : null;
  }

  listByTicket(ticketKey: string): Followup[] {
    const rows = this.db.prepare(`SELECT * FROM followups WHERE ticket_key = ? ORDER BY created_at, id`).all(ticketKey) as unknown as FollowupRow[];
    return rows.map(toFollowup);
  }

  /** 所有未归档 ticket 的 followups（简报用）。 */
  listActiveTickets(): Followup[] {
    const rows = this.db
      .prepare(`SELECT f.* FROM followups f JOIN tickets t ON t.key = f.ticket_key WHERE t.archived_at IS NULL ORDER BY f.created_at, f.id`)
      .all() as unknown as FollowupRow[];
    return rows.map(toFollowup);
  }

  update(id: string, p: FollowupPatch): void {
    const cur = this.get(id);
    if (!cur) return;
    this.db
      .prepare(`UPDATE followups SET kind = ?, description = ?, trigger = ?, due_date = ? WHERE id = ?`)
      .run(p.kind ?? cur.kind, p.description ?? cur.description, p.trigger ?? cur.trigger, p.dueDate !== undefined ? p.dueDate : cur.dueDate, id);
  }

  /** done 记录完成时间；snoozed 记录推迟到哪天；其他状态清空这两项。 */
  setStatus(id: string, status: FollowupStatus, at: number, snoozedUntil: string | null = null): void {
    this.db
      .prepare(`UPDATE followups SET status = ?, done_at = ?, snoozed_until = ? WHERE id = ?`)
      .run(status, status === "done" ? at : null, status === "snoozed" ? snoozedUntil : null, id);
  }
}
```

`src/main/db/briefs-repo.ts`：

```ts
import { EMPTY_BRIEF_CONTENT, type Brief, type BriefContent, type BriefKind, type NarrativeStatus } from "../../shared/brief";
import type { Db } from "./database";

interface BriefRow {
  id: number;
  kind: string;
  date: string;
  created_at: number;
  items: string;
  narrative: string | null;
  narrative_status: string;
}

function parseContent(text: string): BriefContent {
  try {
    const v = JSON.parse(text) as Partial<BriefContent>;
    return {
      items: v.items ?? [],
      previousDay: v.previousDay ?? null,
      evening: v.evening ?? [],
      notices: v.notices ?? { ...EMPTY_BRIEF_CONTENT.notices },
    };
  } catch {
    return structuredClone(EMPTY_BRIEF_CONTENT);
  }
}

function toBrief(r: BriefRow): Brief {
  return {
    id: r.id,
    kind: r.kind as BriefKind,
    date: r.date,
    createdAt: r.created_at,
    ...parseContent(r.items),
    narrative: r.narrative,
    narrativeStatus: r.narrative_status as NarrativeStatus,
  };
}

export interface NewBrief {
  kind: BriefKind;
  date: string;
  createdAt: number;
  content: BriefContent;
  narrative: string | null;
  narrativeStatus: NarrativeStatus;
}

export class BriefsRepo {
  constructor(private readonly db: Db) {}

  insert(b: NewBrief): Brief {
    const r = this.db
      .prepare(`INSERT INTO briefs (kind, date, created_at, items, narrative, narrative_status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(b.kind, b.date, b.createdAt, JSON.stringify(b.content), b.narrative, b.narrativeStatus);
    return { id: Number(r.lastInsertRowid), kind: b.kind, date: b.date, createdAt: b.createdAt, ...b.content, narrative: b.narrative, narrativeStatus: b.narrativeStatus };
  }

  latest(kind: BriefKind): Brief | null {
    const row = this.db.prepare(`SELECT * FROM briefs WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(kind) as BriefRow | undefined;
    return row ? toBrief(row) : null;
  }
}
```

`src/main/db/marks-repo.ts`：

```ts
import type { ItemMark, MarkState } from "../../shared/brief";
import type { Db } from "./database";

/** 简报里非 followup 条目的“完成 / 推迟 / 忽略”。 */
export class MarksRepo {
  constructor(private readonly db: Db) {}

  set(itemKey: string, mark: ItemMark, untilDate: string | null, at: number): void {
    this.db
      .prepare(
        `INSERT INTO item_marks (item_key, mark, until_date, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(item_key) DO UPDATE SET mark = excluded.mark, until_date = excluded.until_date, created_at = excluded.created_at`,
      )
      .run(itemKey, mark, untilDate, at);
  }

  all(): Map<string, MarkState> {
    const rows = this.db.prepare(`SELECT item_key, mark, until_date FROM item_marks`).all() as unknown as {
      item_key: string;
      mark: string;
      until_date: string | null;
    }[];
    return new Map(rows.map((r) => [r.item_key, { mark: r.mark as ItemMark, untilDate: r.until_date }]));
  }
}
```

`src/main/db/jobs-repo.ts`：

```ts
import type { Db } from "./database";

export const JOB_NIGHTLY = "nightly_handoff";
export const JOB_EVENING = "evening_brief";
export const JOB_MORNING = "morning_brief";
export type JobName = typeof JOB_NIGHTLY | typeof JOB_EVENING | typeof JOB_MORNING;

export interface JobState {
  lastRunAt: number | null;
  /** ok | partial | failed | seeded */
  lastStatus: string | null;
  lastError: string | null;
}

export class JobsRepo {
  constructor(private readonly db: Db) {}

  get(name: JobName): JobState {
    const r = this.db.prepare(`SELECT last_run_at, last_status, last_error FROM jobs WHERE name = ?`).get(name) as
      | { last_run_at: number | null; last_status: string | null; last_error: string | null }
      | undefined;
    return { lastRunAt: r?.last_run_at ?? null, lastStatus: r?.last_status ?? null, lastError: r?.last_error ?? null };
  }

  record(name: JobName, at: number, status: string, error: string | null): void {
    this.db
      .prepare(
        `INSERT INTO jobs (name, last_run_at, last_status, last_error) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = excluded.last_status, last_error = excluded.last_error`,
      )
      .run(name, at, status, error);
  }
}
```

`src/main/db/settings-repo.ts` 改为：

```ts
import { DEFAULT_HANDOFF_PROMPT, DEFAULT_REFRESH_PROMPT } from "../handoff/templates";
import type { Db } from "./database";

export const SETTING_DEFAULTS = {
  branchTemplate: "feature/{key}",
  ticketPattern: "[A-Z][A-Z0-9]+-\\d+",
  claudePath: "",
  /** 晚间 handoff 的时间（本地，HH:MM）。 */
  nightlyTime: "16:00",
  /** 工作日，JS getDay()：0 = 周日。 */
  workingDays: "1,2,3,4,5",
  /** handoff 允许调用的 tracker MCP 工具，一行一个。 */
  trackerTools: "",
  blockedDays: "2",
  reviewWaitDays: "2",
  staleDays: "5",
  handoffPrompt: DEFAULT_HANDOFF_PROMPT,
  refreshPrompt: DEFAULT_REFRESH_PROMPT,
} as const;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: SettingKey): string {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? SETTING_DEFAULTS[key];
  }

  set(key: SettingKey, value: string): void {
    this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  }

  /** 删除覆盖值，回到默认。 */
  reset(key: SettingKey): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }
}
```

- [ ] **Step 6: 实现设置值**

`src/main/settings/settings-values.ts`：

```ts
import type { EditableSettingKey } from "../../shared/settings";
import type { SettingsRepo } from "../db/settings-repo";

export class SettingError extends Error {
  readonly code = "invalid_setting";
}

export interface ScheduleConfig {
  nightly: { h: number; m: number };
  workingDays: ReadonlySet<number>;
}

export interface Thresholds {
  blockedDays: number;
  reviewWaitDays: number;
  staleDays: number;
}

export function parseTime(v: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : null;
}

/** 不认识的项直接忽略。 */
export function parseWorkingDays(v: string): Set<number> {
  return new Set(v.split(/[\s,]+/).filter((t) => /^[0-6]$/.test(t)).map(Number));
}

/** 逗号、换行或括号外的空白分隔；`Bash(git status)` 括号里的空格保留。去重，保持顺序。 */
export function parseToolList(v: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  const flush = () => {
    const t = cur.trim();
    if (t && !out.includes(t)) out.push(t);
    cur = "";
  };
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) flush();
    else cur += ch;
  }
  flush();
  return out;
}

export function parseDays(v: string, fallback: number): number {
  const t = v.trim();
  return /^\d{1,3}$/.test(t) ? Number(t) : fallback;
}

/** 渲染进程提交的设置值：规范化后返回，不合法时抛 SettingError（界面显示 message）。 */
export function normalizeSetting(key: EditableSettingKey, value: string): string {
  switch (key) {
    case "nightlyTime": {
      const t = parseTime(value);
      if (!t) throw new SettingError("时间格式应为 HH:MM，例如 16:00");
      return `${String(t.h).padStart(2, "0")}:${String(t.m).padStart(2, "0")}`;
    }
    case "workingDays": {
      const tokens = value.split(/[\s,]+/).filter(Boolean);
      if (tokens.some((t) => !/^[0-6]$/.test(t))) throw new SettingError("工作日只能是 0–6（0 是周日）");
      return [...new Set(tokens.map(Number))].sort((a, b) => a - b).join(",");
    }
    case "trackerTools":
      return parseToolList(value).join("\n");
    case "blockedDays":
    case "reviewWaitDays":
    case "staleDays":
      if (!/^\d{1,3}$/.test(value.trim())) throw new SettingError("天数必须是 0–999 的整数");
      return String(Number(value.trim()));
    case "handoffPrompt":
    case "refreshPrompt":
      if (!value.trim()) throw new SettingError("prompt 模板不能为空");
      if (value.length > 20_000) throw new SettingError("prompt 模板太长（上限 20000 字）");
      return value;
  }
}

export function scheduleConfig(s: SettingsRepo): ScheduleConfig {
  return { nightly: parseTime(s.get("nightlyTime")) ?? { h: 16, m: 0 }, workingDays: parseWorkingDays(s.get("workingDays")) };
}

export function thresholds(s: SettingsRepo): Thresholds {
  return {
    blockedDays: parseDays(s.get("blockedDays"), 2),
    reviewWaitDays: parseDays(s.get("reviewWaitDays"), 2),
    staleDays: parseDays(s.get("staleDays"), 5),
  };
}

export function trackerTools(s: SettingsRepo): string[] {
  return parseToolList(s.get("trackerTools"));
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/db src/main/settings`
Expected: 全部 PASS（包括计划 1 的 `repos.test.ts`）。

- [ ] **Step 8: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/shared src/main/db src/main/settings src/main/ipc/register.ts
git commit -m "feat: migration 2 with handoffs, followups, briefs, item marks; repositories and schedule settings"
```

---

### Task 6: followup 合并、状态推导与入库

设计文档 5.4 节：有 id 的更新对应记录，`done=true` 的置为 done，id 为 null 的新建，用户忽略的项不会被复活；入库后重新推导 ticket 状态（手动值优先，`effectiveStatus` 已经实现）。另外按规范化后的描述去重：`/handoff` 在会话里拿不到 followup id，模型也常常忘记 id，只按 id 合并会不停地产生重复项。

**Files:**
- Create: `src/main/handoff/followup-merge.ts`, `src/main/handoff/followup-merge.test.ts`
- Create: `src/main/handoff/status.ts`, `src/main/handoff/status.test.ts`
- Create: `src/main/handoff/ingest.ts`, `src/main/handoff/ingest.test.ts`

**Interfaces:**
- Consumes: `Handoff`、`HandoffFollowup`（任务 4）；`TicketsRepo.setStatus`、`HandoffsRepo`、`FollowupsRepo`、`FollowupPatch`、`withTransaction`（任务 5）
- Produces:
  - `planFollowupMerge(existing: Followup[], incoming: HandoffFollowup[], ctx: MergeContext): FollowupMergePlan`，其中 `FollowupMergePlan = { inserts: Followup[]; updates: { id: string; patch: FollowupPatch }[]; done: string[] }`，`MergeContext = { ticketKey; now; newId: () => string; source: FollowupSource }`
  - `normalizeDescription(s: string): string`
  - `StatusInput = Pick<Handoff, "status" | "pr" | "blockers">`；`deriveStatus(h: StatusInput, openFollowups: number): TicketStatus`
  - `IngestDeps = { db; tickets; handoffs; followups; now: () => number; newFollowupId: () => string }`
  - `IngestInput = { ticketKey; sessionId: string | null; trigger: HandoffTrigger; payload: Handoff | null; rawText: string | null; sourceRef?: string | null }`（`payload: null` 即 degraded）
  - `IngestResult = { stored: true; handoffId: number; degraded: boolean; status: TicketStatus | null } | { stored: false; reason: "no_ticket" | "duplicate" }`
  - `ingestHandoff(d: IngestDeps, input: IngestInput): IngestResult`
  - `rederiveTicketStatus(d: Pick<IngestDeps, "tickets" | "handoffs" | "followups" | "now">, ticketKey): TicketStatus | null`

- [ ] **Step 1: 写失败测试**

`src/main/handoff/followup-merge.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { HandoffFollowup } from "../../shared/handoff";
import type { Followup } from "../../shared/types";
import { planFollowupMerge } from "./followup-merge";

const existing = (id: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "PROJ-1", kind: "config", description: `改配置 ${id}`, trigger: "after_merge", dueDate: null,
  status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...over,
});
const incoming = (over: Partial<HandoffFollowup> = {}): HandoffFollowup => ({
  id: null, kind: "config", description: "新的事", trigger: "after_merge", due_date: null, done: false, ...over,
});
const ctx = () => {
  let n = 0;
  return { ticketKey: "PROJ-1", now: 100, newId: () => `new${++n}`, source: "session" as const };
};

describe("planFollowupMerge", () => {
  it("creates new items with app-assigned ids and keeps due_date only for on_date", () => {
    const plan = planFollowupMerge(
      [],
      [
        incoming(),
        incoming({ description: "开开关", trigger: "on_date", due_date: "2026-10-30" }),
        incoming({ description: "部署", trigger: "after_deploy", due_date: "2026-10-30" }),
      ],
      ctx(),
    );
    expect(plan.inserts.map((f) => [f.id, f.description, f.dueDate, f.status, f.createdAt, f.source])).toEqual([
      ["new1", "新的事", null, "open", 100, "session"],
      ["new2", "开开关", "2026-10-30", "open", 100, "session"],
      ["new3", "部署", null, "open", 100, "session"],
    ]);
    expect(plan.updates).toEqual([]);
    expect(plan.done).toEqual([]);
  });

  it("updates an existing item by id and marks done ones", () => {
    const plan = planFollowupMerge(
      [existing("a"), existing("b")],
      [incoming({ id: "a", description: "改配置 a（staging 和 prod）", trigger: "after_deploy" }), incoming({ id: "b", description: "改配置 b", done: true })],
      ctx(),
    );
    expect(plan.updates).toEqual([{ id: "a", patch: { trigger: "after_deploy", description: "改配置 a（staging 和 prod）" } }]);
    expect(plan.done).toEqual(["b"]);
    expect(plan.inserts).toEqual([]);
  });

  it("matches a forgotten id by description, so nothing is duplicated", () => {
    const plan = planFollowupMerge([existing("a")], [incoming({ description: "  改配置   A " })], ctx());
    expect(plan).toEqual({ inserts: [], updates: [], done: [] });
  });

  it("never revives ignored items or reopens done ones", () => {
    const plan = planFollowupMerge(
      [existing("a", { status: "ignored" }), existing("b", { status: "done" })],
      [incoming({ id: "a" }), incoming({ description: "改配置 b" }), incoming({ id: "b", trigger: "none" })],
      ctx(),
    );
    expect(plan).toEqual({ inserts: [], updates: [], done: [] });
  });

  it("treats an unknown id as a new item and drops duplicates, done-on-arrival and blank items", () => {
    const plan = planFollowupMerge(
      [],
      [incoming({ id: "f_made_up" }), incoming({ description: "新的事 " }), incoming({ description: "已做完", done: true }), incoming({ description: "  " })],
      ctx(),
    );
    expect(plan.inserts.map((f) => f.description)).toEqual(["新的事"]);
  });

  it("snoozed items can be completed or edited and keep their snooze otherwise", () => {
    const plan = planFollowupMerge(
      [existing("a", { status: "snoozed", snoozedUntil: "2026-10-22" }), existing("b", { status: "snoozed" })],
      [incoming({ id: "a", description: "改配置 a", done: true }), incoming({ id: "b", description: "改配置 b", kind: "deploy" })],
      ctx(),
    );
    expect(plan.done).toEqual(["a"]);
    expect(plan.updates).toEqual([{ id: "b", patch: { kind: "deploy" } }]);
  });
});
```

`src/main/handoff/status.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { TicketStatus } from "../../shared/types";
import { deriveStatus, type StatusInput } from "./status";

const pr = (state: "open" | "merged" | "closed", review: "pending" | "changes_requested" | "approved" | null = null) => ({ number: 1, url: "u", state, review });
const h = (over: Partial<StatusInput>): StatusInput => ({ status: "active", pr: null, blockers: [], ...over });

describe("deriveStatus", () => {
  it.each<[string, StatusInput, number, TicketStatus]>([
    ["merged PR with open followups", h({ pr: pr("merged") }), 1, "merged_pending_followup"],
    ["merged PR, nothing left", h({ pr: pr("merged") }), 0, "done"],
    ["model says done, followups left", h({ status: "done" }), 2, "merged_pending_followup"],
    ["model says merged_pending_followup but none left", h({ status: "merged_pending_followup" }), 0, "done"],
    ["explicitly blocked even with an open PR", h({ status: "blocked", pr: pr("open") }), 0, "blocked"],
    ["open PR", h({ pr: pr("open", "pending") }), 0, "in_review"],
    ["open PR with waiting listed as a blocker", h({ pr: pr("open"), blockers: ["等 review"] }), 0, "in_review"],
    ["blockers without a PR", h({ blockers: ["等后端接口"] }), 0, "blocked"],
    ["closed PR", h({ status: "in_review", pr: pr("closed") }), 0, "active"],
    ["in review without PR info", h({ status: "in_review" }), 0, "in_review"],
    ["plain active", h({}), 0, "active"],
  ])("%s", (_name, input, open, expected) => {
    expect(deriveStatus(input, open)).toBe(expected);
  });
});
```

`src/main/handoff/ingest.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Handoff, HandoffFollowup } from "../../shared/handoff";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import { ingestHandoff, rederiveTicketStatus } from "./ingest";
import { emptyHandoff } from "./schema";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  let now = 1000;
  let n = 0;
  const deps = { db, tickets, handoffs, followups, now: () => now, newFollowupId: () => `f${++n}` };
  return { deps, tickets, handoffs, followups, tick: (ms: number) => void (now += ms) };
}

const payload = (over: Partial<Handoff> = {}): Handoff => ({ ...emptyHandoff("WRONG-9"), ...over });
const fu = (over: Partial<HandoffFollowup> = {}): HandoffFollowup => ({
  id: null, kind: "config", description: "改 staging 配置", trigger: "after_merge", due_date: null, done: false, ...over,
});
const merged = { number: 7, url: "u", state: "merged" as const, review: "approved" as const };

describe("ingestHandoff", () => {
  it("stores the handoff under the right ticket, creates followups and derives the status", () => {
    const { deps, tickets, handoffs, followups } = setup();
    const r = ingestHandoff(deps, {
      ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: "{}",
      payload: payload({ pr: { number: 7, url: "u", state: "open", review: "pending" }, followups: [fu(), fu({ description: "开 flag", kind: "flag" })] }),
    });
    expect(r).toMatchObject({ stored: true, degraded: false, status: "in_review" });
    expect(handoffs.latest("PROJ-1")?.payload?.ticket).toBe("PROJ-1");
    expect(followups.listByTicket("PROJ-1").map((f) => [f.id, f.status, f.source])).toEqual([
      ["f1", "open", "session"],
      ["f2", "open", "session"],
    ]);
    expect(tickets.get("PROJ-1")?.status).toBe("in_review");
    expect(tickets.statusTimes("PROJ-1").changedAt).toBe(1000);
  });

  it("applies done flags, never revives ignored items, and lands on done when nothing is left", () => {
    const { deps, tickets, followups, tick } = setup();
    ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ followups: [fu(), fu({ description: "开 flag" })] }) });
    tick(10);
    const second = ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", rawText: null, payload: payload({ pr: merged, followups: [fu({ id: "f1", done: true })] }) });
    expect(second).toMatchObject({ status: "merged_pending_followup" });
    expect(followups.get("f1")).toMatchObject({ status: "done", doneAt: 1010 });
    followups.setStatus("f2", "ignored", 1020);
    tick(10);
    const third = ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "command", rawText: null, payload: payload({ pr: merged, followups: [fu({ description: "开 flag" })] }) });
    expect(third).toMatchObject({ status: "done" });
    expect(followups.get("f2")?.status).toBe("ignored");
    expect(followups.listByTicket("PROJ-1")).toHaveLength(2);
    expect(tickets.get("PROJ-1")?.status).toBe("done");
  });

  it("stores a degraded handoff with its raw text and leaves the status alone", () => {
    const { deps, tickets, handoffs } = setup();
    tickets.setStatus("PROJ-1", "in_review", 5);
    expect(ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: "s1", trigger: "nightly", payload: null, rawText: "我做了很多事" })).toMatchObject({
      stored: true, degraded: true, status: null,
    });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ degraded: true, rawText: "我做了很多事" });
    expect(tickets.get("PROJ-1")?.status).toBe("in_review");
  });

  it("ignores a repeated sourceRef and unknown tickets", () => {
    const { deps, handoffs } = setup();
    const input = { ticketKey: "PROJ-1", sessionId: "s1", trigger: "command" as const, payload: payload(), rawText: "{}", sourceRef: "uuid-1" };
    expect(ingestHandoff(deps, input)).toMatchObject({ stored: true });
    expect(ingestHandoff(deps, input)).toEqual({ stored: false, reason: "duplicate" });
    expect(ingestHandoff(deps, { ...input, ticketKey: "NOPE-1", sourceRef: "uuid-2" })).toEqual({ stored: false, reason: "no_ticket" });
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(1);
  });

  it("re-derives the status after a followup is completed by hand", () => {
    const { deps, tickets, followups } = setup();
    ingestHandoff(deps, { ticketKey: "PROJ-1", sessionId: null, trigger: "nightly", rawText: null, payload: payload({ pr: merged, followups: [fu()] }) });
    expect(tickets.get("PROJ-1")?.status).toBe("merged_pending_followup");
    followups.setStatus("f1", "done", 2000);
    expect(rederiveTicketStatus(deps, "PROJ-1")).toBe("done");
    expect(tickets.get("PROJ-1")?.status).toBe("done");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/handoff`
Expected: 新的 3 个测试文件 FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/main/handoff/followup-merge.ts`：

```ts
import type { HandoffFollowup } from "../../shared/handoff";
import type { Followup, FollowupSource } from "../../shared/types";
import type { FollowupPatch } from "../db/followups-repo";

export interface FollowupMergePlan {
  inserts: Followup[];
  updates: { id: string; patch: FollowupPatch }[];
  done: string[];
}

export interface MergeContext {
  ticketKey: string;
  now: number;
  newId: () => string;
  source: FollowupSource;
}

/** 比较描述时忽略首尾空白、连续空白和大小写。 */
export const normalizeDescription = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * 设计文档 5.4 节的合并规则，加上按描述去重：
 * - 按 id 找到已有项；找不到 id（模型忘了或编了一个）就按描述找。
 * - 已忽略、已完成的项保持原样：handoff 不能复活或重新打开它们。
 * - done=true 的置为完成；否则只更新变了的字段（描述只在 id 命中时更新）。
 * - 都没找到的新建（done=true 的新项、空描述、同一次 handoff 里的重复项直接丢弃）。
 * existing 必须是同一个 ticket 的 followups。
 */
export function planFollowupMerge(existing: Followup[], incoming: HandoffFollowup[], ctx: MergeContext): FollowupMergePlan {
  const plan: FollowupMergePlan = { inserts: [], updates: [], done: [] };
  const byId = new Map(existing.map((f) => [f.id, f]));
  const byDesc = new Map<string, Followup>();
  for (const f of existing) {
    const d = normalizeDescription(f.description);
    if (!byDesc.has(d)) byDesc.set(d, f);
  }
  const touched = new Set<string>();
  const newDescs = new Set<string>();

  for (const f of incoming) {
    const desc = normalizeDescription(f.description);
    if (!desc) continue;
    const dueDate = f.trigger === "on_date" ? f.due_date : null;
    const idHit = f.id !== null ? byId.get(f.id) : undefined;
    const target = idHit ?? byDesc.get(desc);
    if (target) {
      if (touched.has(target.id)) continue;
      touched.add(target.id);
      if (target.status === "ignored" || target.status === "done") continue;
      if (f.done) {
        plan.done.push(target.id);
        continue;
      }
      const patch: FollowupPatch = {};
      if (f.kind !== target.kind) patch.kind = f.kind;
      if (f.trigger !== target.trigger) patch.trigger = f.trigger;
      if (dueDate !== target.dueDate) patch.dueDate = dueDate;
      if (idHit && f.description.trim() !== target.description) patch.description = f.description.trim();
      if (Object.keys(patch).length > 0) plan.updates.push({ id: target.id, patch });
      continue;
    }
    if (f.done || newDescs.has(desc)) continue;
    newDescs.add(desc);
    plan.inserts.push({
      id: ctx.newId(),
      ticketKey: ctx.ticketKey,
      kind: f.kind,
      description: f.description.trim(),
      trigger: f.trigger,
      dueDate,
      status: "open",
      snoozedUntil: null,
      source: ctx.source,
      createdAt: ctx.now,
      doneAt: null,
    });
  }
  return plan;
}
```

`src/main/handoff/status.ts`：

```ts
import type { Handoff } from "../../shared/handoff";
import type { TicketStatus } from "../../shared/types";

export type StatusInput = Pick<Handoff, "status" | "pr" | "blockers">;

/**
 * 从最新一次 handoff（或刷新）推导 ticket 状态。手动状态优先由 effectiveStatus 处理，这里只算自动值。
 * - PR 已合并，或模型认为已完成：还有未完成的 followup → merged_pending_followup，否则 done
 * - 模型明确说 blocked → blocked
 * - PR 打开中 → in_review（“等 review”常被写进 blockers，不算阻塞）
 * - 列出了阻塞原因 → blocked
 * - PR 被关闭（没合并）→ active
 * - 其余沿用模型的 in_review，否则 active
 */
export function deriveStatus(h: StatusInput, openFollowups: number): TicketStatus {
  if (h.pr?.state === "merged" || h.status === "done" || h.status === "merged_pending_followup") {
    return openFollowups > 0 ? "merged_pending_followup" : "done";
  }
  if (h.status === "blocked") return "blocked";
  if (h.pr?.state === "open") return "in_review";
  if (h.blockers.length > 0) return "blocked";
  if (h.pr?.state === "closed") return "active";
  return h.status === "in_review" ? "in_review" : "active";
}
```

`src/main/handoff/ingest.ts`：

```ts
import type { Handoff } from "../../shared/handoff";
import type { HandoffTrigger, TicketStatus } from "../../shared/types";
import { withTransaction, type Db } from "../db/database";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { planFollowupMerge } from "./followup-merge";
import { deriveStatus } from "./status";

export interface IngestDeps {
  db: Db;
  tickets: TicketsRepo;
  handoffs: HandoffsRepo;
  followups: FollowupsRepo;
  now: () => number;
  newFollowupId: () => string;
}

export interface IngestInput {
  ticketKey: string;
  sessionId: string | null;
  trigger: HandoffTrigger;
  /** 校验通过的 handoff；null 表示 degraded。 */
  payload: Handoff | null;
  rawText: string | null;
  sourceRef?: string | null;
}

export type IngestResult =
  | { stored: true; handoffId: number; degraded: boolean; status: TicketStatus | null }
  | { stored: false; reason: "no_ticket" | "duplicate" };

type StatusDeps = Pick<IngestDeps, "tickets" | "handoffs" | "followups" | "now">;

function applyStatus(d: StatusDeps, ticketKey: string, payload: Handoff, now: number): TicketStatus {
  const open = d.followups.listByTicket(ticketKey).filter((f) => f.status === "open" || f.status === "snoozed").length;
  const status = deriveStatus(payload, open);
  d.tickets.setStatus(ticketKey, status, now);
  return status;
}

/** 写入一条 handoff（只追加），合并 followups，重新推导 ticket 状态。全部在一个事务里。 */
export function ingestHandoff(d: IngestDeps, input: IngestInput): IngestResult {
  if (!d.tickets.get(input.ticketKey)) return { stored: false, reason: "no_ticket" };
  const now = d.now();
  return withTransaction(d.db, (): IngestResult => {
    // ticket 以 Butler 的记录为准，模型写错了也不影响归属。
    const payload = input.payload ? { ...input.payload, ticket: input.ticketKey } : null;
    const id = d.handoffs.insert({
      ticketKey: input.ticketKey, sessionId: input.sessionId, trigger: input.trigger, createdAt: now,
      payload, rawText: input.rawText, sourceRef: input.sourceRef ?? null,
    });
    if (id === null) return { stored: false, reason: "duplicate" };
    if (!payload) return { stored: true, handoffId: id, degraded: true, status: null };

    const plan = planFollowupMerge(d.followups.listByTicket(input.ticketKey), payload.followups, {
      ticketKey: input.ticketKey, now, newId: d.newFollowupId, source: "session",
    });
    for (const f of plan.inserts) d.followups.insert(f);
    for (const u of plan.updates) d.followups.update(u.id, u.patch);
    for (const fid of plan.done) d.followups.setStatus(fid, "done", now);
    return { stored: true, handoffId: id, degraded: false, status: applyStatus(d, input.ticketKey, payload, now) };
  });
}

/** followup 被手动完成/忽略/恢复后重新推导（例如最后一个合并后任务做完 → done）。没有完整 handoff 时不动。 */
export function rederiveTicketStatus(d: StatusDeps, ticketKey: string): TicketStatus | null {
  const latest = d.handoffs.latestValid(ticketKey);
  if (!latest?.payload) return null;
  return applyStatus(d, ticketKey, latest.payload, d.now());
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/handoff`
Expected: 全部 PASS。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/main/handoff
git commit -m "feat: followup merge rules, ticket status derivation and transactional handoff ingest"
```

---

### Task 7: headless claude 运行器，并让 Butler 自己的运行不污染 session

验证记录 V1–V3 的结论：`-p` 运行会触发用户级 hook（SessionStart/UserPromptSubmit/Stop/SessionEnd，fork 的 SessionStart `source` 是 `"fork"`），环境变量会原样传给 hook；`--fork-session` 不改原 transcript，但会新建一个 jsonl；加上 `--no-session-persistence` 就不落盘。已安装的 `butler-hook` 只转发 `BUTLER_TICKET` 和 `BUTLER_SESSION`，所以用 `BUTLER_SESSION=headless:<runId>` 作标记，不需要重新打包 hook 程序。

**Files:**
- Modify: `package.json`（cross-spawn、@types/cross-spawn）
- Create: `src/main/claude/headless.ts`, `src/main/claude/headless.test.ts`, `src/main/claude/headless.live.test.ts`
- Modify: `src/main/claude/spawn.ts`, `src/main/claude/spawn.test.ts`
- Modify: `src/main/claude/capabilities.ts`, `src/main/claude/capabilities.test.ts`, `src/main/hooks/health.test.ts`
- Modify: `src/shared/hook-envelope.ts`
- Modify: `src/main/hooks/hook-events.ts`, `src/main/hooks/hook-events.test.ts`
- Modify: `src/main/db/sessions-repo.ts`, `src/main/db/repos.test.ts`
- Modify: `src/main/test-utils.ts`

**Interfaces:**
- Produces:
  - `HEADLESS_SESSION_PREFIX = "headless:"`、`isHeadlessEnvelope(env: HookEnvelope): boolean`（`src/shared/hook-envelope.ts`）
  - `headlessEnv(base: NodeJS.ProcessEnv, x: { pathValue: string; runId: string }): Record<string, string>`（`src/main/claude/spawn.ts`）
  - `SessionsRepo.recordHeadless(id: string, cwd: string, at: number): void`
  - `src/main/claude/headless.ts`：`HEADLESS_TIMEOUT_MS`、`READ_ONLY_TOOLS`、`DENIED_TOOLS`、`HeadlessRequest { claudePath; args; prompt; cwd; env; timeoutMs? }`、`ClaudeResult { sessionId; isError; subtype; resultText; structured; permissionDenials: string[]; apiErrorStatus; costUsd }`、`HeadlessFailure`、`HeadlessOutcome`、`HeadlessRun`、`headlessArgs({ schema, resumeSessionId?, allowedTools })`、`parseClaudeJson(stdout)`、`isRateLimited(result, stderr)`、`killTree(child)`、`runHeadless: HeadlessRun`
  - `writeFakeClaude(dir, body): { path: string; calls: () => FakeCall[] }`，`FakeCall { args; input; butlerSession; cwd }`（`src/main/test-utils.ts`）
  - `REQUIRED_FLAGS` 增加 `--no-session-persistence`、`--permission-mode`、`--disallowedTools`

- [ ] **Step 1: 安装 cross-spawn**

```bash
pnpm add cross-spawn@7.0.6 && pnpm add -D @types/cross-spawn@6.0.6
```

Expected：`dependencies` 里 `"cross-spawn": "7.0.6"`，`devDependencies` 里 `"@types/cross-spawn": "6.0.6"`（去掉 pnpm 可能加的 `^`）。

- [ ] **Step 2: 写失败测试**

`src/main/test-utils.ts`：`node:fs` 的 import 改为 `import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";`，文件末尾追加：

```ts
export interface FakeCall {
  args: string[];
  input: string;
  butlerSession: string | null;
  cwd: string;
}

/**
 * 写一个假的 claude 可执行文件（Node 脚本）。它把参数、stdin、BUTLER_SESSION 和 cwd 记到日志里，然后执行 body。
 * body 里可用：args、input、call（第几次调用，从 1 开始）、emit(obj)（写一行 JSON）、
 * result(structured, extra?)（写一条成功的 --output-format json 结果，session_id 为 "fork-<call>"）。
 * Windows 上额外生成一个 .cmd 包装并返回它的路径，这样测试会经过 cross-spawn 的 cmd.exe 转义。
 */
export function writeFakeClaude(dir: string, body: string): { path: string; calls: () => FakeCall[] } {
  const log = join(dir, "fake-claude-calls.jsonl");
  const script = join(dir, "fake-claude.cjs");
  writeFileSync(
    script,
    `#!/usr/bin/env node
const fs = require("node:fs");
const LOG = ${JSON.stringify(log)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const call = (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\\n").filter(Boolean).length : 0) + 1;
  fs.appendFileSync(LOG, JSON.stringify({ args, input, butlerSession: process.env.BUTLER_SESSION ?? null, cwd: process.cwd() }) + "\\n");
  const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  const result = (structured, extra) => emit(Object.assign({ type: "result", subtype: "success", is_error: false, session_id: "fork-" + call, result: JSON.stringify(structured), structured_output: structured, permission_denials: [] }, extra || {}));
  ${body}
});
`,
  );
  chmodSync(script, 0o755);
  let path = script;
  if (process.platform === "win32") {
    path = join(dir, "fake-claude.cmd");
    writeFileSync(path, `@echo off\r\nnode "${script}" %*\r\n`);
  }
  const calls = (): FakeCall[] =>
    existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as FakeCall) : [];
  return { path, calls };
}
```

`src/main/claude/headless.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { tempDir, writeFakeClaude } from "../test-utils";
import { headlessArgs, isRateLimited, parseClaudeJson, runHeadless } from "./headless";

const env = () => ({ ...process.env }) as Record<string, string>;

/** 验证记录 V1：真实 claude 2.1.306 的 --output-format json 输出（去掉了 usage 等字段）。 */
const OBSERVED = {
  type: "result", subtype: "success", is_error: false, api_error_status: null, num_turns: 2, stop_reason: "tool_use",
  session_id: "a861b9bd-25a8-481b-a01a-3fca83dd069f", total_cost_usd: 0.23302, permission_denials: [],
  result: '{"word":"hello","count":3}', structured_output: { word: "hello", count: 3 }, terminal_reason: "completed",
};

describe("headlessArgs", () => {
  it("resumes as a non-persistent, read-only fork and never carries the prompt", () => {
    expect(headlessArgs({ schema: '{"type":"object"}', resumeSessionId: "s-1", allowedTools: ["Read", "Bash(git status)"] })).toEqual([
      "-p", "--output-format", "json", "--json-schema", '{"type":"object"}', "--no-session-persistence", "--permission-mode", "dontAsk",
      "--resume", "s-1", "--fork-session",
      "--disallowedTools", "Edit", "Write", "NotebookEdit",
      "--allowedTools", "Read", "Bash(git status)",
    ]);
  });

  it("omits the resume flags for a fresh run", () => {
    const args = headlessArgs({ schema: "{}", allowedTools: ["Read"] });
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--fork-session");
  });
});

describe("parseClaudeJson", () => {
  it("reads the observed result shape", () => {
    expect(parseClaudeJson(`${JSON.stringify(OBSERVED)}\n`)).toEqual({
      sessionId: "a861b9bd-25a8-481b-a01a-3fca83dd069f", isError: false, subtype: "success", resultText: '{"word":"hello","count":3}',
      structured: { word: "hello", count: 3 }, permissionDenials: [], apiErrorStatus: null, costUsd: 0.23302,
    });
  });

  it("lists denied tools, accepts a message array, rejects garbage", () => {
    const denied = { ...OBSERVED, permission_denials: [{ tool_name: "Write", tool_use_id: "toolu_1", tool_input: { file_path: "/x/fork.txt", content: "x" } }] };
    expect(parseClaudeJson(JSON.stringify(denied))?.permissionDenials).toEqual(["Write"]);
    expect(parseClaudeJson(JSON.stringify([{ type: "system", subtype: "init" }, OBSERVED]))?.sessionId).toBe(OBSERVED.session_id);
    expect(parseClaudeJson("not json")).toBeNull();
    expect(parseClaudeJson(JSON.stringify({ type: "assistant" }))).toBeNull();
  });

  it("recognises rate limiting from the status or the text", () => {
    const base = parseClaudeJson(JSON.stringify(OBSERVED))!;
    expect(isRateLimited({ ...base, apiErrorStatus: 429 }, "")).toBe(true);
    expect(isRateLimited(null, "Claude usage limit reached")).toBe(true);
    expect(isRateLimited({ ...base, resultText: "Prompt is too long" }, "")).toBe(false);
  });
});

describe("runHeadless with a fake claude executable", () => {
  it("writes the prompt to stdin and passes tricky args through untouched", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, "result({ ok: true });");
    const tricky = ['{"type":"object","properties":{"a":{"type":"string"}}}', "Bash(gh pr view:*)", "张 三 & echo pwned", "100%", "a^b|c"];
    const prompt = '多行\n提示 "引号" $HOME %PATH% `x`';
    const out = await runHeadless({ claudePath: fake.path, args: tricky, prompt, cwd: dir, env: env() });
    expect(out).toMatchObject({ ok: true, result: { sessionId: "fork-1", structured: { ok: true } } });
    const [call] = fake.calls();
    expect(call.args).toEqual(tricky);
    expect(call.input).toBe(prompt);
    expect(call.cwd).toBe(dir);
  });

  it("reports invalid JSON on stdout as bad_output", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, 'process.stdout.write("not json");');
    expect(await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({ ok: false, reason: "bad_output" });
  });

  it("reports a non-zero exit without JSON together with stderr", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, 'process.stderr.write("boom"); process.exit(3);');
    expect(await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({
      ok: false, reason: "exit_nonzero", message: "boom",
    });
  });

  it("classifies an error result that mentions a rate limit", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(
      dir,
      'emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "x", api_error_status: 429, result: "API Error: 429 rate_limit_error" }); process.exitCode = 1;',
    );
    expect(await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({
      ok: false, reason: "rate_limited", result: { sessionId: "x" },
    });
  });

  it("kills a run that exceeds the timeout", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, "setTimeout(() => result({ late: true }), 30000);");
    const started = Date.now();
    const out = await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env(), timeoutMs: 300 });
    expect(out).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  it("reports a missing executable as spawn_failed", async () => {
    const dir = tempDir();
    expect(await runHeadless({ claudePath: `${dir}/missing-claude`, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({
      ok: false, reason: "spawn_failed",
    });
  });
});
```

`src/main/claude/spawn.test.ts`：import 加上 `headlessEnv`，`describe` 里追加：

```ts
  it("builds a headless env: no ticket, a headless session marker, parent markers dropped", () => {
    const env = headlessEnv(
      { PATH: "/usr/bin", BUTLER_TICKET: "OLD-1", BUTLER_SESSION: "x", CLAUDECODE: "1", ELECTRON_RUN_AS_NODE: "1", HOME: "/h" },
      { pathValue: "/login/bin", runId: "r1" },
    );
    expect(env).toEqual({ PATH: "/login/bin", HOME: "/h", BUTLER_SESSION: "headless:r1" });
  });
```

`src/main/hooks/hook-events.test.ts` 的 `describe` 里追加：

```ts
  it("ignores every event from Butler's own headless runs", () => {
    const { sessions, deps } = setup();
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
      expect(applyHookEnvelope(env(ev, "h1", { butlerSession: "headless:run-1" }, { source: "fork" }), deps)).toEqual({ kind: "ignored", reason: "headless" });
    }
    expect(sessions.get("h1")).toBeNull();
  });
```

`src/main/db/repos.test.ts`：顶部加 `import { syncDiscovered } from "../sessions/discovery";`，`describe("SessionsRepo")` 里追加：

```ts
  it("recordHeadless hides Butler's own headless sessions from unclaimed, even after a disk scan", () => {
    const repo = setup();
    repo.recordHeadless("h1", "/w", 100);
    expect(repo.get("h1")).toMatchObject({ dismissed: true, ticketKey: null });
    syncDiscovered([{ id: "h1", cwd: "/w", gitBranch: "main", firstPrompt: "x", lastActivityAt: 100 }], repo, 100);
    expect(repo.listUnclaimed(0)).toEqual([]);
  });
```

`src/main/claude/capabilities.test.ts` 的 `HELP` 常量里，在 `--allowedTools` 那一行后面追加三行：

```
  --disallowedTools, --disallowed-tools <tools...>
  --no-session-persistence              Disable session persistence
  --permission-mode <mode>              Permission mode to use for the session
```

`src/main/hooks/health.test.ts` 第一个用例里 `run` 返回的帮助文本改为：

```ts
    const run = async (_f: string, args: string[]) =>
      args[0] === "--version"
        ? "2.1.304"
        : "--print --session-id --resume --fork-session --mcp-config --output-format --json-schema --allowedTools --disallowedTools --no-session-persistence --permission-mode";
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/claude src/main/hooks src/main/db/repos.test.ts`
Expected: FAIL（`headless.ts`、`headlessEnv`、`recordHeadless` 不存在；headless 信封没被忽略；`REQUIRED_FLAGS` 还没有新参数时 capabilities 用例仍然通过，这没关系）。

- [ ] **Step 4: 实现**

`src/shared/hook-envelope.ts` 末尾追加：

```ts
/** Butler 自己启动的 headless claude 用这个前缀作 BUTLER_SESSION；它们的 hook 上报全部忽略。 */
export const HEADLESS_SESSION_PREFIX = "headless:";

export function isHeadlessEnvelope(env: HookEnvelope): boolean {
  return env.butlerSession?.startsWith(HEADLESS_SESSION_PREFIX) ?? false;
}
```

`src/main/hooks/hook-events.ts`：import 改为 `import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";`，`applyHookEnvelope` 第一行加：

```ts
  // 晚间 handoff、早间刷新、MCP 探测这些 Butler 自己的 claude 进程也会触发用户级 hook，全部忽略。
  if (isHeadlessEnvelope(env)) return { kind: "ignored", reason: "headless" };
```

`src/main/db/sessions-repo.ts` 在 `delete` 后面加：

```ts
  /** Butler 自己的 headless 运行产生的 session：记成已忽略，磁盘扫描永远不会把它列进“未认领”。 */
  recordHeadless(id: string, cwd: string, at: number): void {
    this.insertIfAbsent({ id, ticketKey: null, cwd, origin: "discovered", lastActivityAt: at, createdAt: at });
    this.dismiss(id);
  }
```

`src/main/claude/capabilities.ts` 的 `REQUIRED_FLAGS` 改为：

```ts
export const REQUIRED_FLAGS = [
  "--print",
  "--session-id",
  "--resume",
  "--fork-session",
  "--mcp-config",
  "--output-format",
  "--json-schema",
  "--allowedTools",
  "--disallowedTools",
  "--no-session-persistence",
  "--permission-mode",
] as const;
```

`src/main/claude/spawn.ts`：顶部加 `import { HEADLESS_SESSION_PREFIX } from "../../shared/hook-envelope";`，把 `sessionEnv` 替换为下面三个函数：

```ts
/** 去掉 Electron 和外层 Claude Code 的标记变量（以及 Butler 自己的标记），换上登录 shell 的 PATH。 */
function cleanEnv(base: NodeJS.ProcessEnv, pathValue: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k.startsWith("ELECTRON_") || PARENT_SESSION_VARS.has(k) || k === "BUTLER_TICKET" || k === "BUTLER_SESSION") continue;
    out[k] = v;
  }
  if (pathValue) out[pathKey(out)] = pathValue;
  return out;
}

/** 交互式终端里的 claude：挂上 ticket 和启动时的 session id。 */
export function sessionEnv(
  base: NodeJS.ProcessEnv,
  x: { pathValue: string; ticketKey: string; sessionId: string },
): Record<string, string> {
  const out = cleanEnv(base, x.pathValue);
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  out.BUTLER_TICKET = x.ticketKey;
  out.BUTLER_SESSION = x.sessionId;
  return out;
}

/** headless claude（handoff、刷新、MCP 探测）：不挂 ticket；BUTLER_SESSION 带 headless: 前缀，hook 上报会被整体忽略。 */
export function headlessEnv(base: NodeJS.ProcessEnv, x: { pathValue: string; runId: string }): Record<string, string> {
  const out = cleanEnv(base, x.pathValue);
  out.BUTLER_SESSION = `${HEADLESS_SESSION_PREFIX}${x.runId}`;
  return out;
}
```

`src/main/claude/headless.ts`：

```ts
import { execFile, type ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

export const HEADLESS_TIMEOUT_MS = 5 * 60 * 1000;
const STDOUT_LIMIT = 20 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;

/** handoff 的只读白名单：读文件、查 PR、看 git 历史。tracker MCP 工具由设置追加。 */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob", "Bash(gh pr view:*)", "Bash(gh pr checks:*)", "Bash(git log:*)", "Bash(git status)"];
/** 不管用户默认的权限模式是什么，这些写工具一律拒绝。 */
export const DENIED_TOOLS = ["Edit", "Write", "NotebookEdit"];

export interface HeadlessRequest {
  claudePath: string;
  args: string[];
  /** 写进 stdin，永远不进 argv。 */
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

/** `--output-format json` 的结果（验证记录 V1）。 */
export interface ClaudeResult {
  sessionId: string | null;
  isError: boolean;
  subtype: string | null;
  resultText: string;
  /** `--json-schema` 的结构化结果。 */
  structured: unknown;
  permissionDenials: string[];
  apiErrorStatus: number | null;
  costUsd: number | null;
}

export type HeadlessFailure = "timeout" | "spawn_failed" | "exit_nonzero" | "bad_output" | "rate_limited" | "claude_error";

export type HeadlessOutcome =
  | { ok: true; result: ClaudeResult }
  | { ok: false; reason: HeadlessFailure; message: string; result: ClaudeResult | null };

export type HeadlessRun = (req: HeadlessRequest) => Promise<HeadlessOutcome>;

/**
 * handoff / 刷新的参数。prompt 不在这里：它走 stdin。
 * `--no-session-persistence`：fork 不写 transcript，“未认领”永远看不到它（验证记录 V2）。
 * `--permission-mode dontAsk`：白名单以外的工具一律拒绝，不受用户默认权限模式影响。
 * `--allowedTools` 放最后：它是可变参数，会吃掉后面的所有值。
 */
export function headlessArgs(o: { schema: string; resumeSessionId?: string; allowedTools: string[] }): string[] {
  const args = ["-p", "--output-format", "json", "--json-schema", o.schema, "--no-session-persistence", "--permission-mode", "dontAsk"];
  if (o.resumeSessionId) args.push("--resume", o.resumeSessionId, "--fork-session");
  args.push("--disallowedTools", ...DENIED_TOOLS, "--allowedTools", ...o.allowedTools);
  return args;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** 解析 `--output-format json` 的输出：一个 type=result 的对象（防御性地也接受消息数组）。 */
export function parseClaudeJson(stdout: string): ClaudeResult | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const isResult = (m: unknown) => !!m && typeof m === "object" && (m as { type?: unknown }).type === "result";
  const obj = Array.isArray(v) ? [...v].reverse().find(isResult) : v;
  if (!isResult(obj)) return null;
  const o = obj as Record<string, unknown>;
  const denials = Array.isArray(o.permission_denials)
    ? o.permission_denials.map((d) => str((d as { tool_name?: unknown } | null)?.tool_name)).filter((x): x is string => x !== null)
    : [];
  return {
    sessionId: str(o.session_id),
    isError: o.is_error === true,
    subtype: str(o.subtype),
    resultText: str(o.result) ?? "",
    structured: o.structured_output ?? null,
    permissionDenials: denials,
    apiErrorStatus: typeof o.api_error_status === "number" ? o.api_error_status : null,
    costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
  };
}

const RATE_LIMIT_RE = /rate.?limit|usage limit|quota|overloaded|too many requests|\b429\b|\b529\b/i;

/** 额度用完或被限流（启发式：状态码或文本）。只在运行失败时调用。 */
export function isRateLimited(r: ClaudeResult | null, stderr: string): boolean {
  return r?.apiErrorStatus === 429 || r?.apiErrorStatus === 529 || RATE_LIMIT_RE.test(`${r?.resultText ?? ""}\n${stderr}`);
}

/** 结束子进程及其子进程。Windows 上 claude.cmd 经过 cmd.exe，必须杀整棵进程树。 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 3000).unref();
}

export const runHeadless: HeadlessRun = (req) =>
  new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    const finish = (o: HeadlessOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(o);
    };

    let child: ChildProcess;
    try {
      child = spawn(req.claudePath, req.args, { cwd: req.cwd, env: req.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      finish({ ok: false, reason: "spawn_failed", message: e instanceof Error ? e.message : String(e), result: null });
      return;
    }

    const timeoutMs = req.timeoutMs ?? HEADLESS_TIMEOUT_MS;
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      if (stdout.length < STDOUT_LIMIT) stdout += c;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += c;
    });
    child.on("error", (e) => finish({ ok: false, reason: "spawn_failed", message: e.message, result: null }));
    child.on("close", (code) => {
      if (timedOut) {
        finish({ ok: false, reason: "timeout", message: `超过 ${Math.round(timeoutMs / 1000)} 秒没有完成`, result: null });
        return;
      }
      const result = parseClaudeJson(stdout);
      if (!result) {
        const message = (stderr.trim() || stdout.trim()).slice(0, 500) || `exit ${code}`;
        const reason: HeadlessFailure = isRateLimited(null, `${stderr}\n${stdout}`) ? "rate_limited" : code === 0 ? "bad_output" : "exit_nonzero";
        finish({ ok: false, reason, message, result: null });
        return;
      }
      if (result.isError || code !== 0) {
        finish({ ok: false, reason: isRateLimited(result, stderr) ? "rate_limited" : "claude_error", message: (result.resultText || stderr).slice(0, 500), result });
        return;
      }
      finish({ ok: true, result });
    });

    // claude 提前退出时写 stdin 会 EPIPE，忽略即可（结果由 close 事件决定）。
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(req.prompt, "utf8");
  });
```

`src/main/claude/headless.live.test.ts`：

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo } from "../test-utils";
import { headlessArgs, READ_ONLY_TOOLS, runHeadless } from "./headless";
import { locateClaude, readLoginShellPath } from "./locate";
import { headlessEnv } from "./spawn";

/**
 * 只在 BUTLER_LIVE_CLAUDE=1 时运行：真的调用一次本机已登录的 claude（会花一点公司额度）。
 * 它验证 dontAsk + --json-schema 能拿到结构化结果，并且写工具被拒绝。
 */
describe.skipIf(!process.env.BUTLER_LIVE_CLAUDE)("runHeadless against the real claude", () => {
  it("returns structured output under dontAsk and cannot write files", async () => {
    const pathValue = await readLoginShellPath(process.platform, process.env);
    const claudePath = locateClaude({ override: "", pathValue, platform: process.platform });
    expect(claudePath).not.toBeNull();
    const repo = makeRepo();
    const schema = JSON.stringify({
      type: "object",
      properties: { gitClean: { type: "boolean" }, wroteFile: { type: "boolean" } },
      required: ["gitClean", "wroteFile"],
    });
    const out = await runHeadless({
      claudePath: claudePath!,
      cwd: repo,
      args: headlessArgs({ schema, allowedTools: READ_ONLY_TOOLS }),
      prompt: "先运行 `git status`，再尝试创建文件 live.txt（内容 x）。然后回答：gitClean = 工作区是否干净，wroteFile = live.txt 现在是否存在。",
      env: headlessEnv(process.env, { pathValue, runId: "live-test" }),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.structured).toMatchObject({ gitClean: true, wroteFile: false });
    expect(existsSync(join(repo, "live.txt"))).toBe(false);
  }, 240_000);
});
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/claude src/main/hooks src/main/db/repos.test.ts`
Expected: 全部 PASS；`headless.live.test.ts` 显示为 skipped。

- [ ] **Step 6: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add package.json pnpm-lock.yaml src/shared/hook-envelope.ts src/main/claude src/main/hooks src/main/db src/main/test-utils.ts
git commit -m "feat: headless claude runner with stdin prompts, read-only flags and hook isolation for Butler's own runs"
```

---

### Task 8: HandoffRunner（晚间批量、手动、早间刷新）

**Files:**
- Create: `src/main/handoff/prompt.ts`, `src/main/handoff/prompt.test.ts`
- Create: `src/main/util/pool.ts`, `src/main/util/pool.test.ts`
- Create: `src/main/handoff/runner.ts`, `src/main/handoff/runner.test.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Consumes: `HeadlessRun`、`HeadlessOutcome`、`headlessArgs`、`READ_ONLY_TOOLS`、`runHeadless`（任务 7）；`headlessEnv`（任务 7）；`HANDOFF_JSON_SCHEMA`、`REFRESH_JSON_SCHEMA`、`validate`、`pickStructured`、`emptyHandoff`（任务 4）；`IngestInput`、`IngestResult`（任务 6）；`trackerTools(settings)`（任务 5）；`SessionsRepo.recordHeadless`
- Produces:
  - `src/shared/types.ts`：`HandoffOutcome = { ticketKey; status: "stored"; handoffId; degraded } | { ticketKey; status: "skipped"; reason: "rate_limited" | "no_session" } | { ticketKey; status: "failed"; reason: string; message: string }`
  - `PromptContext { ticket: Ticket; status: TicketStatus; previous: Handoff | null; openFollowups: Followup[]; trackerTools: string[] }`、`renderTemplate(template, vars)`、`buildPrompt(template, ctx)`、`retryPrompt(prompt, errors)`
  - `runPool<T, R>(items, limit, fn): Promise<R[]>`
  - `HANDOFF_CONCURRENCY = 2`、`BatchResult { status: "ok" | "partial"; outcomes: HandoffOutcome[] }`、`HandoffRunnerDeps`、`HandoffRunner { candidates(): string[]; runNightly(): Promise<BatchResult>; runManual(key): Promise<HandoffOutcome>; refreshForBrief(): Promise<BatchResult> }`

- [ ] **Step 1: 写失败测试**

`src/main/handoff/prompt.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Followup, Ticket } from "../../shared/types";
import { buildPrompt, renderTemplate, retryPrompt } from "./prompt";
import { emptyHandoff } from "./schema";
import { HANDOFF_EXAMPLE } from "./templates";

const t: Ticket = {
  key: "PROJ-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "feature/PROJ-1",
  status: "active", statusManual: null, createdAt: 1, archivedAt: null,
};
const f: Followup = {
  id: "f1", ticketKey: "PROJ-1", kind: "flag", description: "开 flag {{ticket}}", trigger: "on_date", dueDate: "2026-10-30",
  status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null,
};

describe("prompt rendering", () => {
  it("fills known placeholders, keeps unknown ones and never re-expands inserted values", () => {
    expect(renderTemplate("{{a}}/{{missing}}", { a: "{{a}}x" })).toBe("{{a}}x/{{missing}}");
  });

  it("builds the handoff prompt from the ticket, previous handoff, followups and tracker tools", () => {
    const p = buildPrompt("{{ticket}}|{{title}}|{{branch}}|{{current_status}}|{{tracker_tools}}|{{previous_handoff}}|{{open_followups}}|{{example}}", {
      ticket: t, status: "in_review", previous: { ...emptyHandoff("PROJ-1"), next_steps: ["下一步"] }, openFollowups: [f], trackerTools: ["mcp__jira__get_issue"],
    });
    expect(p.startsWith("PROJ-1|无标题|feature/PROJ-1|in_review|mcp__jira__get_issue|")).toBe(true);
    expect(p).toContain('"next_steps": [\n    "下一步"\n  ]');
    expect(p).toContain('"id": "f1"');
    expect(p).toContain('"due_date": "2026-10-30"');
    expect(p).toContain("开 flag {{ticket}}");
    expect(p).toContain(HANDOFF_EXAMPLE);
  });

  it("explains a first handoff and missing tracker tools", () => {
    const p = buildPrompt("{{previous_handoff}} / {{tracker_tools}} / {{open_followups}}", { ticket: t, status: "active", previous: null, openFollowups: [], trackerTools: [] });
    expect(p).toBe("（这是第一次 handoff） / （没有配置 tracker MCP 工具：jira 填 null） / []");
  });

  it("appends validation errors for the retry", () => {
    expect(retryPrompt("原始", "✖ bad\n  → at status")).toBe(
      "原始\n\n上一次的输出没有通过校验，错误如下：\n✖ bad\n  → at status\n请修正这些问题，按 schema 重新输出完整的 JSON。",
    );
  });
});
```

`src/main/util/pool.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { runPool } from "./pool";

describe("runPool", () => {
  it("keeps the input order and caps concurrency", async () => {
    let active = 0;
    let max = 0;
    const out = await runPool([30, 10, 20, 5], 2, async (ms, i) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
    expect(max).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await runPool([], 2, async () => 1)).toEqual([]);
  });
});
```

`src/main/handoff/runner.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Handoff } from "../../shared/handoff";
import type { Ticket } from "../../shared/types";
import { runHeadless, type HeadlessOutcome, type HeadlessRequest, type HeadlessRun } from "../claude/headless";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb, tempDir, writeFakeClaude } from "../test-utils";
import { ingestHandoff, type IngestInput } from "./ingest";
import { HandoffRunner } from "./runner";
import { emptyHandoff, HANDOFF_JSON_SCHEMA, REFRESH_JSON_SCHEMA } from "./schema";

const NOW = 50_000;

const ticket = (key: string, over: Partial<Ticket> = {}): Ticket => ({
  key, title: `标题 ${key}`, repoPath: "/r", workMode: "worktree", worktreePath: `/w/${key}`, branch: `feature/${key}`,
  status: "active", statusManual: null, createdAt: 1, archivedAt: null, ...over,
});

const valid = (over: Partial<Handoff> = {}): Handoff => ({ ...emptyHandoff("X"), next_steps: ["写测试"], ...over });

const ok = (structured: unknown, sessionId = "fork-1"): HeadlessOutcome => ({
  ok: true,
  result: { sessionId, isError: false, subtype: "success", resultText: JSON.stringify(structured), structured, permissionDenials: [], apiErrorStatus: null, costUsd: 0 },
});

function setup(opts: { run?: HeadlessRun } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const settings = new SettingsRepo(db);
  const mtimes: Record<string, number> = {};
  const calls: HeadlessRequest[] = [];
  let respond: (req: HeadlessRequest, n: number) => Promise<HeadlessOutcome> = async () => ok(valid());
  const run: HeadlessRun =
    opts.run ??
    ((req) => {
      calls.push(req);
      return respond(req, calls.length);
    });
  let fid = 0;
  const ingest = (input: IngestInput) => ingestHandoff({ db, tickets, handoffs, followups, now: () => NOW, newFollowupId: () => `f${++fid}` }, input);
  const runner = new HandoffRunner({
    tickets, sessions, handoffs, followups, settings, ingest,
    workDir: (t) => t.worktreePath ?? t.repoPath,
    run,
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/login/bin" }),
    baseEnv: { HOME: "/h" },
    transcriptMtime: (id) => mtimes[id] ?? null,
    now: () => NOW,
    newRunId: () => "run-1",
  });
  /** 一个有对话记录的 ticket：session 是 s-<key>，transcript 在 mtime 时刻修改过（null 表示没有 transcript）。 */
  const addTicket = (key: string, mtime: number | null = NOW - 10) => {
    tickets.insert(ticket(key));
    sessions.insertIfAbsent({ id: `s-${key}`, ticketKey: key, cwd: `/w/${key}`, origin: "butler", lastActivityAt: 1, createdAt: 1 });
    if (mtime !== null) mtimes[`s-${key}`] = mtime;
  };
  const setRespond = (fn: typeof respond) => {
    respond = fn;
  };
  return { runner, tickets, sessions, handoffs, settings, calls, addTicket, ingest, setRespond };
}

describe("HandoffRunner", () => {
  it("picks tickets whose transcript changed after the last captured handoff", () => {
    const { runner, addTicket, ingest } = setup();
    addTicket("A-1", NOW - 10);
    addTicket("B-2", 100);
    addTicket("C-3", null);
    ingest({ ticketKey: "B-2", sessionId: "s-B-2", trigger: "nightly", payload: valid(), rawText: null });
    expect(runner.candidates()).toEqual(["A-1"]);
  });

  it("runs a read-only, non-persistent fork with the prompt on stdin and stores the handoff", async () => {
    const { runner, addTicket, calls, sessions, handoffs, ingest, settings } = setup();
    addTicket("A-1", NOW + 10);
    settings.set("trackerTools", "mcp__jira__get_issue");
    ingest({
      ticketKey: "A-1", sessionId: "s-A-1", trigger: "command", rawText: null,
      payload: valid({ next_steps: ["上一次的下一步"], followups: [{ id: null, kind: "config", description: "改配置", trigger: "after_merge", due_date: null, done: false }] }),
    });
    const batch = await runner.runNightly();
    expect(batch).toMatchObject({ status: "ok", outcomes: [{ ticketKey: "A-1", status: "stored", degraded: false }] });
    const [req] = calls;
    expect(req.claudePath).toBe("/bin/claude");
    expect(req.cwd).toBe("/w/A-1");
    expect(req.args.slice(0, 11)).toEqual([
      "-p", "--output-format", "json", "--json-schema", HANDOFF_JSON_SCHEMA, "--no-session-persistence", "--permission-mode", "dontAsk",
      "--resume", "s-A-1", "--fork-session",
    ]);
    expect(req.args.slice(req.args.indexOf("--allowedTools") + 1)).toContain("mcp__jira__get_issue");
    expect(req.args.join(" ")).not.toContain("上一次的下一步");
    expect(req.prompt).toContain("A-1");
    expect(req.prompt).toContain("上一次的下一步");
    expect(req.prompt).toContain('"id": "f1"');
    expect(req.env).toMatchObject({ BUTLER_SESSION: "headless:run-1", PATH: "/login/bin" });
    expect(req.env.BUTLER_TICKET).toBeUndefined();
    expect(sessions.get("fork-1")).toMatchObject({ dismissed: true });
    expect(handoffs.latest("A-1")).toMatchObject({ trigger: "nightly", sessionId: "s-A-1", degraded: false });
  });

  it("retries once with the validation errors, then stores a valid handoff", async () => {
    const { runner, addTicket, calls, handoffs, setRespond } = setup();
    addTicket("A-1");
    setRespond(async (_req, n) => (n === 1 ? ok({ foo: 1 }) : ok(valid())));
    expect(await runner.runManual("A-1")).toMatchObject({ status: "stored", degraded: false });
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain("上一次的输出没有通过校验");
    expect(calls[1].prompt).toContain("done_today");
    expect(handoffs.listByTicket("A-1")).toHaveLength(1);
  });

  it("stores a degraded handoff with the raw text when the retry is invalid too", async () => {
    const { runner, addTicket, calls, handoffs, tickets, setRespond } = setup();
    addTicket("A-1");
    setRespond(async () => ok({ foo: 1 }));
    expect(await runner.runManual("A-1")).toMatchObject({ status: "stored", degraded: true });
    expect(calls).toHaveLength(2);
    expect(handoffs.latest("A-1")).toMatchObject({ degraded: true, rawText: '{"foo":1}', trigger: "manual" });
    expect(tickets.get("A-1")?.status).toBe("active");
  });

  it("never runs more than two at once", async () => {
    let active = 0;
    let max = 0;
    const run: HeadlessRun = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return ok(valid());
    };
    const { runner, addTicket } = setup({ run });
    for (const k of ["A-1", "B-2", "C-3", "D-4", "E-5"]) addTicket(k);
    const batch = await runner.runNightly();
    expect(batch.outcomes.map((o) => o.status)).toEqual(["stored", "stored", "stored", "stored", "stored"]);
    expect(max).toBe(2);
  });

  it("stops starting new runs after a rate limit and reports the batch as partial", async () => {
    const { runner, addTicket, calls, setRespond } = setup();
    for (const k of ["A-1", "B-2", "C-3", "D-4"]) addTicket(k);
    setRespond(async () => ({ ok: false, reason: "rate_limited", message: "429", result: null }));
    const batch = await runner.runNightly();
    expect(batch.status).toBe("partial");
    expect(batch.outcomes.every((o) => o.status === "skipped" && o.reason === "rate_limited")).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("reports a timeout as failed and stores nothing", async () => {
    const { runner, addTicket, handoffs, setRespond } = setup();
    addTicket("A-1");
    setRespond(async () => ({ ok: false, reason: "timeout", message: "超过 300 秒没有完成", result: null }));
    expect(await runner.runManual("A-1")).toMatchObject({ status: "failed", reason: "timeout" });
    expect(handoffs.latest("A-1")).toBeNull();
  });

  it("manual runs without a session start fresh in the ticket workdir; the nightly batch skips them", async () => {
    const { runner, tickets, calls } = setup();
    tickets.insert(ticket("A-1"));
    expect(await runner.runManual("A-1")).toMatchObject({ status: "stored" });
    expect(calls[0].args).not.toContain("--resume");
    expect(calls[0].cwd).toBe("/w/A-1");
    expect((await runner.runNightly()).outcomes).toEqual([]);
  });

  it("refreshes in_review and merged tickets without resuming and keeps the rest of the last handoff", async () => {
    const { runner, addTicket, tickets, calls, handoffs, ingest, setRespond } = setup();
    addTicket("A-1");
    addTicket("B-2");
    ingest({
      ticketKey: "A-1", sessionId: "s-A-1", trigger: "nightly", rawText: null,
      payload: valid({
        pr: { number: 9, url: "u", state: "open", review: "pending" },
        done_today: ["做了 X"],
        next_steps: ["合并后改配置"],
        followups: [{ id: null, kind: "config", description: "改配置", trigger: "after_merge", due_date: null, done: false }],
      }),
    });
    expect(tickets.get("A-1")?.status).toBe("in_review");
    setRespond(async () => ok({ status: "merged_pending_followup", pr: { number: 9, url: "u", state: "merged", review: "approved" }, jira: null }));
    const batch = await runner.refreshForBrief();
    expect(batch.outcomes.map((o) => o.ticketKey)).toEqual(["A-1"]);
    expect(calls[0].args).not.toContain("--resume");
    expect(calls[0].args[calls[0].args.indexOf("--json-schema") + 1]).toBe(REFRESH_JSON_SCHEMA);
    expect(calls[0].cwd).toBe("/w/A-1");
    const latest = handoffs.latest("A-1")!;
    expect(latest).toMatchObject({ trigger: "refresh", sessionId: null });
    expect(latest.payload).toMatchObject({ done_today: [], next_steps: ["合并后改配置"], pr: { state: "merged" } });
    expect(tickets.get("A-1")?.status).toBe("merged_pending_followup");
  });

  it("shares one run when the same ticket is requested twice at once", async () => {
    const { runner, addTicket, calls } = setup();
    addTicket("A-1");
    const [a, b] = await Promise.all([runner.runManual("A-1"), runner.runManual("A-1")]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("works end to end with runHeadless and a fake claude executable", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, `result(${JSON.stringify(valid({ done_today: ["真的跑了"] }))});`);
    const { runner, addTicket, handoffs } = setup({
      run: (req) => runHeadless({ ...req, claudePath: fake.path, cwd: dir, env: { ...req.env, PATH: process.env.PATH ?? "" } }),
    });
    addTicket("A-1");
    expect(await runner.runManual("A-1")).toMatchObject({ status: "stored", degraded: false });
    const [call] = fake.calls();
    expect(call.input).toContain("A-1");
    expect(call.args).toContain("--fork-session");
    expect(call.butlerSession).toBe("headless:run-1");
    expect(handoffs.latest("A-1")?.payload?.done_today).toEqual(["真的跑了"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/handoff src/main/util`
Expected: 新的 3 个测试文件 FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/shared/types.ts` 末尾追加：

```ts
/** 一次 handoff / 刷新的结果（“立即 handoff”按钮会显示它）。 */
export type HandoffOutcome =
  | { ticketKey: string; status: "stored"; handoffId: number; degraded: boolean }
  | { ticketKey: string; status: "skipped"; reason: "rate_limited" | "no_session" }
  | { ticketKey: string; status: "failed"; reason: string; message: string };
```

`src/main/handoff/prompt.ts`：

```ts
import type { Handoff } from "../../shared/handoff";
import type { Followup, Ticket, TicketStatus } from "../../shared/types";
import { HANDOFF_EXAMPLE, HANDOFF_SCHEMA_DOC } from "./templates";

export interface PromptContext {
  ticket: Ticket;
  status: TicketStatus;
  previous: Handoff | null;
  openFollowups: Followup[];
  trackerTools: string[];
}

/** 替换 {{name}}。只扫描模板本身，插入的值不会被再次展开；不认识的占位符原样保留。 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? vars[name] : whole));
}

function vars(c: PromptContext): Record<string, string> {
  return {
    ticket: c.ticket.key,
    title: c.ticket.title ?? "无标题",
    branch: c.ticket.branch,
    current_status: c.status,
    tracker_tools: c.trackerTools.length > 0 ? c.trackerTools.join(", ") : "（没有配置 tracker MCP 工具：jira 填 null）",
    previous_handoff: c.previous ? JSON.stringify(c.previous, null, 2) : "（这是第一次 handoff）",
    open_followups: JSON.stringify(
      c.openFollowups.map((f) => ({ id: f.id, kind: f.kind, description: f.description, trigger: f.trigger, due_date: f.dueDate })),
      null,
      2,
    ),
    schema: HANDOFF_SCHEMA_DOC,
    example: HANDOFF_EXAMPLE,
  };
}

export function buildPrompt(template: string, c: PromptContext): string {
  return renderTemplate(template, vars(c));
}

export function retryPrompt(prompt: string, errors: string): string {
  return `${prompt}\n\n上一次的输出没有通过校验，错误如下：\n${errors}\n请修正这些问题，按 schema 重新输出完整的 JSON。`;
}
```

`src/main/util/pool.ts`：

```ts
/** 最多 limit 个并发，结果按输入顺序返回。fn 自己处理错误，不应 reject。 */
export async function runPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
```

`src/main/handoff/runner.ts`：

```ts
import { HandoffSchema, RefreshSchema, type Handoff } from "../../shared/handoff";
import { effectiveStatus, type HandoffOutcome, type Session, type Ticket } from "../../shared/types";
import { headlessArgs, READ_ONLY_TOOLS, type HeadlessRun } from "../claude/headless";
import { headlessEnv } from "../claude/spawn";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { trackerTools } from "../settings/settings-values";
import { runPool } from "../util/pool";
import type { IngestInput, IngestResult } from "./ingest";
import { buildPrompt, retryPrompt, type PromptContext } from "./prompt";
import { emptyHandoff, HANDOFF_JSON_SCHEMA, pickStructured, REFRESH_JSON_SCHEMA, validate } from "./schema";

export const HANDOFF_CONCURRENCY = 2;

export interface BatchResult {
  /** 有失败或被限流跳过的 ticket 时是 partial：早间简报前会再补跑一次。 */
  status: "ok" | "partial";
  outcomes: HandoffOutcome[];
}

export interface HandoffRunnerDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  handoffs: HandoffsRepo;
  followups: FollowupsRepo;
  settings: SettingsRepo;
  ingest: (input: IngestInput) => IngestResult;
  workDir: (t: Ticket) => string;
  run: HeadlessRun;
  /** 首次 health 探测完成后 resolve。 */
  ready: () => Promise<void>;
  claude: () => { path: string | null; pathValue: string };
  baseEnv: NodeJS.ProcessEnv;
  /** session 的 transcript 修改时间；没有 transcript 时为 null。 */
  transcriptMtime: (sessionId: string) => number | null;
  now: () => number;
  newRunId: () => string;
  timeoutMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

type Exec = { ok: true; value: unknown; rawText: string } | { ok: false; outcome: HandoffOutcome };

const failed = (ticketKey: string, reason: string, message: string): HandoffOutcome => ({ ticketKey, status: "failed", reason, message });

export class HandoffRunner {
  private readonly inflight = new Map<string, Promise<HandoffOutcome>>();

  constructor(private readonly d: HandoffRunnerDeps) {}

  /** 有新活动的 ticket：关联 session 的 transcript 修改时间晚于上一次读过 session 的 handoff。 */
  candidates(): string[] {
    return this.d.tickets
      .list()
      .filter((t) => {
        const latest = Math.max(0, ...this.d.sessions.listByTicket(t.key).map((s) => this.d.transcriptMtime(s.id) ?? 0));
        return latest > (this.d.handoffs.lastCapturedAt(t.key) ?? 0);
      })
      .map((t) => t.key);
  }

  runNightly(): Promise<BatchResult> {
    return this.batch(this.candidates(), (key) => this.full(key, "nightly"));
  }

  runManual(ticketKey: string): Promise<HandoffOutcome> {
    return this.once(ticketKey, () => this.full(ticketKey, "manual"));
  }

  /** 早间快速刷新：只查 in_review / merged_pending_followup 的 PR 和 tracker 状态。 */
  refreshForBrief(): Promise<BatchResult> {
    const keys = this.d.tickets
      .list()
      .filter((t) => ["in_review", "merged_pending_followup"].includes(effectiveStatus(t)))
      .map((t) => t.key);
    return this.batch(keys, (key) => this.refresh(key));
  }

  private async batch(keys: string[], fn: (key: string) => Promise<HandoffOutcome>): Promise<BatchResult> {
    let rateLimited = false;
    const outcomes = await runPool(keys, HANDOFF_CONCURRENCY, async (key): Promise<HandoffOutcome> => {
      // 公司额度用完或被限流：剩下的不再发起（不重试轰炸），留给早间补跑。
      if (rateLimited) return { ticketKey: key, status: "skipped", reason: "rate_limited" };
      const o = await this.once(key, () => fn(key));
      if (o.status === "skipped" && o.reason === "rate_limited") rateLimited = true;
      return o;
    });
    const partial = outcomes.some((o) => o.status === "failed" || (o.status === "skipped" && o.reason === "rate_limited"));
    return { status: partial ? "partial" : "ok", outcomes };
  }

  /** 同一个 ticket 同时只跑一个：手动按钮和晚间批量撞在一起时共用结果。 */
  private once(key: string, fn: () => Promise<HandoffOutcome>): Promise<HandoffOutcome> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn()
      .catch((e: unknown) => failed(key, "internal", e instanceof Error ? e.message : String(e)))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** 要 fork 的 session：最近活动的、没被替换、有 transcript 的那个。 */
  private resumeTarget(key: string): Session | null {
    return this.d.sessions.listByTicket(key).find((s) => !s.replacedBy && !s.dismissed && this.d.transcriptMtime(s.id) !== null) ?? null;
  }

  private context(t: Ticket): PromptContext {
    return {
      ticket: t,
      status: effectiveStatus(t),
      previous: this.d.handoffs.latestValid(t.key)?.payload ?? null,
      openFollowups: this.d.followups.listByTicket(t.key).filter((f) => f.status === "open" || f.status === "snoozed"),
      trackerTools: trackerTools(this.d.settings),
    };
  }

  private allowedTools(): string[] {
    return [...READ_ONLY_TOOLS, ...trackerTools(this.d.settings)];
  }

  private async full(key: string, trigger: "nightly" | "manual"): Promise<HandoffOutcome> {
    const t = this.d.tickets.get(key);
    if (!t) return failed(key, "no_ticket", `找不到 ticket ${key}`);
    const session = this.resumeTarget(key);
    // 晚间批量只为有对话记录的 ticket 生成；手动触发时没有 session 也照样跑（只能看 git、PR 和 tracker）。
    if (!session && trigger === "nightly") return { ticketKey: key, status: "skipped", reason: "no_session" };
    const cwd = session?.cwd || this.d.workDir(t);
    const prompt = buildPrompt(this.d.settings.get("handoffPrompt"), this.context(t));
    const args = headlessArgs({ schema: HANDOFF_JSON_SCHEMA, resumeSessionId: session?.id, allowedTools: this.allowedTools() });

    let attempt = await this.exec(key, args, prompt, cwd);
    if (!attempt.ok) return attempt.outcome;
    let checked = validate(HandoffSchema, attempt.value);
    if (!checked.ok) {
      this.d.log?.(`handoff ${key}: output failed validation, retrying once: ${checked.errors}`);
      attempt = await this.exec(key, args, retryPrompt(prompt, checked.errors), cwd);
      if (!attempt.ok) return attempt.outcome;
      checked = validate(HandoffSchema, attempt.value);
    }
    const r = this.d.ingest({ ticketKey: key, sessionId: session?.id ?? null, trigger, payload: checked.ok ? checked.value : null, rawText: attempt.rawText });
    if (!r.stored) return failed(key, r.reason, r.reason);
    return { ticketKey: key, status: "stored", handoffId: r.handoffId, degraded: r.degraded };
  }

  private async refresh(key: string): Promise<HandoffOutcome> {
    const t = this.d.tickets.get(key);
    if (!t) return failed(key, "no_ticket", `找不到 ticket ${key}`);
    const ctx = this.context(t);
    const prompt = buildPrompt(this.d.settings.get("refreshPrompt"), ctx);
    const args = headlessArgs({ schema: REFRESH_JSON_SCHEMA, allowedTools: this.allowedTools() });
    const attempt = await this.exec(key, args, prompt, this.d.workDir(t));
    if (!attempt.ok) return attempt.outcome;
    const checked = validate(RefreshSchema, attempt.value);
    // 刷新结果不完整就保留旧数据：不写入、不重试。
    if (!checked.ok) return failed(key, "invalid_output", checked.errors);
    // 存成一条完整的 handoff，简报永远只看“最新一条完整 handoff”。done_today 清空，免得“上个工作日”重复计算。
    const base: Handoff = ctx.previous ?? emptyHandoff(key);
    const payload: Handoff = {
      ...base, ticket: key, status: checked.value.status, pr: checked.value.pr, jira: checked.value.jira,
      done_today: [], followups: [], decisions: [], learnings: [],
    };
    const r = this.d.ingest({ ticketKey: key, sessionId: null, trigger: "refresh", payload, rawText: attempt.rawText });
    if (!r.stored) return failed(key, r.reason, r.reason);
    return { ticketKey: key, status: "stored", handoffId: r.handoffId, degraded: r.degraded };
  }

  private async exec(key: string, args: string[], prompt: string, cwd: string): Promise<Exec> {
    await this.d.ready();
    const { path, pathValue } = this.d.claude();
    if (!path) return { ok: false, outcome: failed(key, "claude_missing", "找不到 claude 命令") };
    const out = await this.d.run({
      claudePath: path, args, prompt, cwd,
      env: headlessEnv(this.d.baseEnv, { pathValue, runId: this.d.newRunId() }),
      timeoutMs: this.d.timeoutMs,
    });
    const sid = out.result?.sessionId;
    if (sid) this.d.sessions.recordHeadless(sid, cwd, this.d.now());
    if (!out.ok) {
      this.d.log?.(`handoff ${key}: ${out.reason}: ${out.message}`);
      if (out.reason === "rate_limited") return { ok: false, outcome: { ticketKey: key, status: "skipped", reason: "rate_limited" } };
      return { ok: false, outcome: failed(key, out.reason, out.message) };
    }
    return { ok: true, value: pickStructured(out.result), rawText: out.result.resultText || JSON.stringify(out.result.structured ?? null) };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/handoff src/main/util`
Expected: 全部 PASS。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/shared/types.ts src/main/handoff src/main/util
git commit -m "feat: HandoffRunner with nightly batch, manual and refresh modes, retry-then-degrade and rate-limit stop"
```

---

### Task 9: 会话内 `/handoff` 命令

Installer 把 `handoff.md` 写进 Claude Code 的用户级 commands 目录；Stop hook 上报 `transcript_path` 后，从这一轮 assistant 的文本里取最后一个 `butler-handoff` 代码块入库（`trigger=command`）。验证记录 V4：Stop 触发时，最终的 assistant 消息已经写进 transcript；命令展开后的说明文字（里面也有一个示例代码块）是一条 `isMeta` 的 user 消息，所以只看“最后一条非 tool_result 的 user 消息之后”的 assistant 文本。

**Files:**
- Create: `src/main/handoff/command.ts`, `src/main/handoff/command.test.ts`
- Create: `src/main/handoff/transcript.ts`, `src/main/handoff/transcript.test.ts`
- Create: `src/main/handoff/capture.ts`, `src/main/handoff/capture.test.ts`
- Modify: `src/shared/types.ts`（`HandoffCommandStatus`、`HealthReport.handoffCommand`）
- Modify: `src/main/hooks/health.ts`, `src/main/hooks/health.test.ts`

**Interfaces:**
- Consumes: `HANDOFF_COMMAND_MD`、`HANDOFF_COMMAND_MARKER`（任务 4）；`extractHandoffBlock`、`parseJsonLoose`、`validate`（任务 4）；`IngestInput`、`IngestResult`（任务 6）；`isHeadlessEnvelope`（任务 7）
- Produces:
  - `HandoffCommandStatus = "installed" | "missing" | "stale" | "conflict"`；`HealthReport.handoffCommand`
  - `handoffCommandPath(commandsDir)`、`handoffCommandStatus(file)`、`installHandoffCommand(file): Promise<HandoffCommandStatus>`、`uninstallHandoffCommand(file)`
  - `AssistantText { uuid: string | null; text: string }`、`readLastTurn(file, maxBytes = 1 MiB): Promise<AssistantText[]>`、`FoundHandoff { uuid; block }`、`findHandoffBlock(turn): FoundHandoff | null`
  - `StopEvent { sessionId; transcriptPath }`、`stopFromEnvelope(env): StopEvent | null`、`CaptureDeps { sessions; tickets; ingest }`、`captureCommandHandoff(d, stop): Promise<IngestResult | null>`

- [ ] **Step 1: 写失败测试**

`src/main/handoff/command.test.ts`：

```ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { handoffCommandPath, handoffCommandStatus, installHandoffCommand, uninstallHandoffCommand } from "./command";
import { HANDOFF_COMMAND_MARKER, HANDOFF_COMMAND_MD } from "./templates";

describe("/handoff command file", () => {
  it("installs into a missing commands dir, reports installed, and uninstalls", async () => {
    const file = handoffCommandPath(join(tempDir(), "commands"));
    expect(await handoffCommandStatus(file)).toBe("missing");
    expect(await installHandoffCommand(file)).toBe("installed");
    expect(readFileSync(file, "utf8")).toBe(HANDOFF_COMMAND_MD);
    expect(await handoffCommandStatus(file)).toBe("installed");
    await uninstallHandoffCommand(file);
    expect(existsSync(file)).toBe(false);
  });

  it("updates an older Butler version", async () => {
    const file = handoffCommandPath(tempDir());
    writeFileSync(file, `old\n${HANDOFF_COMMAND_MARKER}\n`);
    expect(await handoffCommandStatus(file)).toBe("stale");
    expect(await installHandoffCommand(file)).toBe("installed");
    expect(readFileSync(file, "utf8")).toBe(HANDOFF_COMMAND_MD);
  });

  it("never touches a user's own handoff.md", async () => {
    const file = handoffCommandPath(tempDir());
    writeFileSync(file, "我自己的 handoff 命令");
    expect(await installHandoffCommand(file)).toBe("conflict");
    await uninstallHandoffCommand(file);
    expect(readFileSync(file, "utf8")).toBe("我自己的 handoff 命令");
  });
});
```

`src/main/handoff/transcript.test.ts`：

````ts
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { findHandoffBlock, readLastTurn } from "./transcript";

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({ type: "user", message: { role: "user", content }, ...extra });
const assistant = (uuid: string, content: unknown) => ({ type: "assistant", uuid, message: { role: "assistant", content } });
const text = (t: string) => [{ type: "text", text: t }];
const BLOCK = '```butler-handoff\n{"ticket":"PROJ-1"}\n```';

/** 验证记录 V4 的形状：更早的一轮，然后“命令消息 + isMeta 的展开文本”，然后这一轮的 assistant 条目。 */
function writeTurn(file: string, entries: unknown[]) {
  writeFileSync(
    file,
    [
      line(user("更早的问题")),
      line(assistant("old", text('```butler-handoff\n{"ticket":"OLD"}\n```'))),
      line(user("<command-message>handoff</command-message>\n<command-name>/handoff</command-name>")),
      line(user(text("请生成 handoff……示例：\n```butler-handoff\n{}\n```"), { isMeta: true })),
      ...entries.map(line),
    ].join(""),
  );
}

describe("readLastTurn / findHandoffBlock", () => {
  it("finds the block in the last turn, not in the command text or older turns", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeTurn(file, [assistant("a1", text(`好的：\n${BLOCK}`))]);
    const turn = await readLastTurn(file);
    expect(turn).toEqual([{ uuid: "a1", text: `好的：\n${BLOCK}` }]);
    expect(findHandoffBlock(turn)).toEqual({ uuid: "a1", block: '{"ticket":"PROJ-1"}' });
  });

  it("looks past tool calls inside the turn and takes the last block", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeTurn(file, [
      assistant("a1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "gh pr view" } }]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "PR #9 open" }]),
      assistant("a2", text(BLOCK.replace("PROJ-1", "DRAFT"))),
      assistant("a3", text(BLOCK)),
    ]);
    expect(findHandoffBlock(await readLastTurn(file))).toEqual({ uuid: "a3", block: '{"ticket":"PROJ-1"}' });
  });

  it("returns nothing when the last turn has no block", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeTurn(file, [assistant("a1", text("没有代码块"))]);
    expect(findHandoffBlock(await readLastTurn(file))).toBeNull();
  });

  it("only reads the tail of a large transcript and skips the cut-off first line", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeFileSync(file, "");
    const filler = line(user("x".repeat(10_000)));
    for (let i = 0; i < 300; i++) appendFileSync(file, filler);
    appendFileSync(file, line(user("/handoff")) + line(assistant("a9", text(BLOCK))));
    expect(findHandoffBlock(await readLastTurn(file, 64 * 1024))).toEqual({ uuid: "a9", block: '{"ticket":"PROJ-1"}' });
  });

  it("skips corrupt lines", async () => {
    const file = join(tempDir(), "t.jsonl");
    writeFileSync(file, line(user("q")) + "{not json\n" + line(assistant("a1", text(BLOCK))) + "null\n");
    expect(findHandoffBlock(await readLastTurn(file))?.uuid).toBe("a1");
  });
});
````

`src/main/handoff/capture.test.ts`：

````ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEnvelope } from "../../shared/hook-envelope";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb, tempDir } from "../test-utils";
import { captureCommandHandoff, stopFromEnvelope } from "./capture";
import { ingestHandoff, type IngestInput } from "./ingest";
import { emptyHandoff } from "./schema";

const FENCE = "```";

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  for (const key of ["PROJ-1", "PROJ-2"]) {
    tickets.insert({ key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  }
  const sessions = new SessionsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  let n = 0;
  const ingest = (input: IngestInput) => ingestHandoff({ db, tickets, handoffs, followups, now: () => 100, newFollowupId: () => `f${++n}` }, input);
  return { deps: { sessions, tickets, ingest }, sessions, handoffs };
}

/** 一个只有“/handoff + 回答”的 transcript；payload 是字符串时原样放进代码块。 */
function transcript(payload: unknown, uuid = "a1"): string {
  const file = join(tempDir(), "t.jsonl");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const entries = [
    { type: "user", message: { role: "user", content: "/handoff" } },
    { type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text: `${FENCE}butler-handoff\n${body}\n${FENCE}` }] } },
  ];
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

describe("stopFromEnvelope", () => {
  const env = (payload: unknown, butlerSession: string | null = null): HookEnvelope => ({ v: 1, receivedAt: 1, ticket: null, butlerSession, payload });

  it("extracts session and transcript from Stop only, never from headless runs", () => {
    const stop = { hook_event_name: "Stop", session_id: "s1", transcript_path: "/t.jsonl" };
    expect(stopFromEnvelope(env(stop))).toEqual({ sessionId: "s1", transcriptPath: "/t.jsonl" });
    expect(stopFromEnvelope(env(stop, "headless:r1"))).toBeNull();
    expect(stopFromEnvelope(env({ ...stop, hook_event_name: "SessionEnd" }))).toBeNull();
    expect(stopFromEnvelope(env({ hook_event_name: "Stop", session_id: "s1" }))).toBeNull();
    expect(stopFromEnvelope(env(null))).toBeNull();
  });
});

describe("captureCommandHandoff", () => {
  it("stores a /handoff block under the session's ticket with trigger command", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = transcript({ ...emptyHandoff("WHATEVER-1"), done_today: ["写完了"] });
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toMatchObject({ stored: true, degraded: false });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ trigger: "command", sessionId: "s1", sourceRef: "a1", payload: { ticket: "PROJ-1", done_today: ["写完了"] } });
  });

  it("does not store the same output twice when Stop is handled again", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const file = transcript(emptyHandoff("PROJ-1"));
    await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file });
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toEqual({ stored: false, reason: "duplicate" });
    expect(handoffs.listByTicket("PROJ-1")).toHaveLength(1);
  });

  it("falls back to the ticket named in the block for an unclaimed session, else gives up", async () => {
    const { deps, handoffs } = setup();
    expect(await captureCommandHandoff(deps, { sessionId: "loose", transcriptPath: transcript(emptyHandoff("proj-2")) })).toMatchObject({ stored: true });
    expect(handoffs.latest("PROJ-2")?.trigger).toBe("command");
    expect(await captureCommandHandoff(deps, { sessionId: "loose", transcriptPath: transcript(emptyHandoff("NOPE-9"), "a2") })).toEqual({
      stored: false, reason: "no_ticket",
    });
  });

  it("keeps an invalid block as a degraded handoff with its raw text", async () => {
    const { deps, sessions, handoffs } = setup();
    sessions.insertIfAbsent({ id: "s1", ticketKey: "PROJ-1", cwd: "/w", origin: "butler", createdAt: 1 });
    const raw = '{"ticket":"PROJ-1","status":"shipping"}';
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: transcript(raw) })).toMatchObject({ stored: true, degraded: true });
    expect(handoffs.latest("PROJ-1")).toMatchObject({ degraded: true, rawText: raw });
  });

  it("returns null when there is no block or no file", async () => {
    const { deps } = setup();
    const file = join(tempDir(), "plain.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "assistant", uuid: "x", message: { content: [{ type: "text", text: "普通回答" }] } })}\n`);
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: file })).toBeNull();
    expect(await captureCommandHandoff(deps, { sessionId: "s1", transcriptPath: join(tempDir(), "missing.jsonl") })).toBeNull();
  });
});
````

`src/main/hooks/health.test.ts`：

1. `node:fs` 的 import 改为 `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";`。
2. 第一个用例里：`expect(first.hookBinInstalled).toBe(false);` 后面加 `expect(first.handoffCommand).toBe("missing");`；`expect(installed.hookBinInstalled).toBe(true);` 后面加：

```ts
    expect(installed.handoffCommand).toBe("installed");
    expect(existsSync(join(paths.claudeCommands, "handoff.md"))).toBe(true);
```

把 `expect((await health.uninstallHooks()).hooks).toBe("missing");` 换成：

```ts
    const removed = await health.uninstallHooks();
    expect(removed.hooks).toBe("missing");
    expect(removed.handoffCommand).toBe("missing");
```

3. `describe` 末尾追加：

```ts
  it("keeps a user's own /handoff command and reports the conflict", async () => {
    const home = tempDir();
    const paths = resolvePaths({ BUTLER_HOME: join(home, ".butler"), CLAUDE_CONFIG_DIR: join(home, ".claude") }, "darwin", home);
    mkdirSync(paths.claudeCommands, { recursive: true });
    writeFileSync(join(paths.claudeCommands, "handoff.md"), "mine");
    const bundled = join(home, "bundled-hook");
    writeFileSync(bundled, "#!/bin/sh\n");
    const health = new HealthService({
      paths, platform: "darwin", env: {}, settings: new SettingsRepo(memDb()), bundledHookBin: bundled,
      readPath: async () => "/usr/bin", run: async () => "",
    });
    expect((await health.installHooks()).handoffCommand).toBe("conflict");
    expect(readFileSync(join(paths.claudeCommands, "handoff.md"), "utf8")).toBe("mine");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/handoff src/main/hooks/health.test.ts`
Expected: FAIL（新模块不存在；health 报告没有 `handoffCommand`）。

- [ ] **Step 3: 实现**

`src/shared/types.ts`：在 `HookStatus` 后面加

```ts
export type HandoffCommandStatus = "installed" | "missing" | "stale" | "conflict";
```

并在 `HealthReport` 里 `hookBinInstalled: boolean;` 后面加 `handoffCommand: HandoffCommandStatus;`。

`src/main/handoff/command.ts`：

```ts
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HandoffCommandStatus } from "../../shared/types";
import { HANDOFF_COMMAND_MARKER, HANDOFF_COMMAND_MD } from "./templates";

export function handoffCommandPath(commandsDir: string): string {
  return join(commandsDir, "handoff.md");
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** installed：和当前版本一字不差；stale：Butler 写的旧版本；conflict：用户自己的同名命令。 */
export async function handoffCommandStatus(file: string): Promise<HandoffCommandStatus> {
  const text = await readOrNull(file);
  if (text === null) return "missing";
  if (text === HANDOFF_COMMAND_MD) return "installed";
  return text.includes(HANDOFF_COMMAND_MARKER) ? "stale" : "conflict";
}

/** 写入或更新 Butler 自己的版本；用户自己的 handoff.md 不覆盖，返回 conflict。 */
export async function installHandoffCommand(file: string): Promise<HandoffCommandStatus> {
  const status = await handoffCommandStatus(file);
  if (status === "conflict" || status === "installed") return status;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.butler-tmp`;
  await writeFile(tmp, HANDOFF_COMMAND_MD, "utf8");
  await rename(tmp, file);
  return "installed";
}

/** 只删除 Butler 写的文件。 */
export async function uninstallHandoffCommand(file: string): Promise<void> {
  const status = await handoffCommandStatus(file);
  if (status === "installed" || status === "stale") await unlink(file);
}
```

`src/main/handoff/transcript.ts`：

```ts
import { open } from "node:fs/promises";
import { extractHandoffBlock } from "./schema";

export interface AssistantText {
  uuid: string | null;
  text: string;
}

interface Entry {
  type?: unknown;
  uuid?: unknown;
  message?: { content?: unknown };
}

const isToolResultOnly = (content: unknown): boolean =>
  Array.isArray(content) &&
  content.length > 0 &&
  content.every((b) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "tool_result");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "text")
    .map((b) => String((b as { text?: unknown }).text ?? ""))
    .join("\n");
}

const MAX_WINDOW = 16 * 1024 * 1024;

/**
 * 读 transcript 末尾（默认 1 MiB），返回最后一轮对话里 assistant 的文本（按时间顺序）。
 * “一轮”从最后一条不是 tool_result 的 user 消息之后开始（/handoff 展开后的说明是一条 isMeta 的 user 消息，也算边界）。
 * 窗口里一条 assistant 文本都没找到时，扩大窗口再读一次。
 */
export async function readLastTurn(file: string, maxBytes = 1024 * 1024): Promise<AssistantText[]> {
  const fh = await open(file, "r");
  let text: string;
  let fromStart: boolean;
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString("utf8");
    fromStart = start === 0;
  } finally {
    await fh.close();
  }
  const lines = text.split("\n");
  if (!fromStart) lines.shift(); // 第一行可能被截断。

  const out: AssistantText[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: Entry | null;
    try {
      e = JSON.parse(lines[i]) as Entry | null;
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    if (e.type === "user") {
      if (isToolResultOnly(e.message?.content)) continue;
      break;
    }
    if (e.type === "assistant") {
      const t = textOf(e.message?.content);
      if (t) out.unshift({ uuid: typeof e.uuid === "string" ? e.uuid : null, text: t });
    }
  }
  if (out.length === 0 && !fromStart && maxBytes * 8 <= MAX_WINDOW) return readLastTurn(file, maxBytes * 8);
  return out;
}

export interface FoundHandoff {
  /** 所在 assistant 条目的 uuid（入库去重用）。 */
  uuid: string | null;
  block: string;
}

/** 这一轮里最后一个 butler-handoff 代码块。 */
export function findHandoffBlock(turn: AssistantText[]): FoundHandoff | null {
  for (let i = turn.length - 1; i >= 0; i--) {
    const block = extractHandoffBlock(turn[i].text);
    if (block !== null) return { uuid: turn[i].uuid, block };
  }
  return null;
}
```

`src/main/handoff/capture.ts`：

```ts
import { createHash } from "node:crypto";
import { HandoffSchema } from "../../shared/handoff";
import { isHeadlessEnvelope, type HookEnvelope } from "../../shared/hook-envelope";
import type { SessionsRepo } from "../db/sessions-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { IngestInput, IngestResult } from "./ingest";
import { parseJsonLoose, validate } from "./schema";
import { findHandoffBlock, readLastTurn, type FoundHandoff } from "./transcript";

export interface StopEvent {
  sessionId: string;
  transcriptPath: string;
}

/** Stop 事件里的 session 和 transcript 路径；Butler 自己的 headless 运行不算。 */
export function stopFromEnvelope(env: HookEnvelope): StopEvent | null {
  if (isHeadlessEnvelope(env)) return null;
  const p = (env.payload && typeof env.payload === "object" ? env.payload : {}) as Record<string, unknown>;
  if (p.hook_event_name !== "Stop") return null;
  const sessionId = typeof p.session_id === "string" ? p.session_id : "";
  const transcriptPath = typeof p.transcript_path === "string" ? p.transcript_path : "";
  return sessionId && transcriptPath ? { sessionId, transcriptPath } : null;
}

export interface CaptureDeps {
  sessions: SessionsRepo;
  tickets: TicketsRepo;
  ingest: (input: IngestInput) => IngestResult;
}

/**
 * Stop 之后看这一轮有没有 /handoff 的输出，有就入库（trigger=command）。
 * 归属：session 已挂的 ticket；没挂的话用代码块里写的 ticket（必须已存在）。
 * 读不到文件或没有代码块时返回 null。
 */
export async function captureCommandHandoff(d: CaptureDeps, stop: StopEvent): Promise<IngestResult | null> {
  let found: FoundHandoff | null;
  try {
    found = findHandoffBlock(await readLastTurn(stop.transcriptPath));
  } catch {
    return null;
  }
  if (!found) return null;
  const checked = validate(HandoffSchema, parseJsonLoose(found.block));
  const claimed = checked.ok ? checked.value.ticket.trim().toUpperCase() : null;
  const ticketKey = d.sessions.get(stop.sessionId)?.ticketKey ?? (claimed && d.tickets.get(claimed) ? claimed : null);
  if (!ticketKey) return { stored: false, reason: "no_ticket" };
  const sourceRef = found.uuid ?? `${stop.sessionId}:${createHash("sha1").update(found.block).digest("hex")}`;
  return d.ingest({
    ticketKey, sessionId: stop.sessionId, trigger: "command",
    payload: checked.ok ? checked.value : null, rawText: found.block, sourceRef,
  });
}
```

`src/main/hooks/health.ts`：

1. import 增加 `import type { HandoffCommandStatus } from "../../shared/types";`（和已有的 `HealthReport, HookStatus` 合并）以及 `import { handoffCommandPath, handoffCommandStatus, installHandoffCommand, uninstallHandoffCommand } from "../handoff/command";`。
2. 类里加：

```ts
  private commandFile(): string {
    return handoffCommandPath(this.d.paths.claudeCommands);
  }
```

3. `refresh()` 里在 `return` 之前加：

```ts
    let handoffCommand: HandoffCommandStatus;
    try {
      handoffCommand = await handoffCommandStatus(this.commandFile());
    } catch {
      // 读不了（权限、是目录）就当作不是 Butler 的文件，不去碰它。
      handoffCommand = "conflict";
    }
```

返回对象里 `hookBinInstalled` 后面加 `handoffCommand,`。

4. `installHooks()` 在 `await installHooks(...)` 之后加 `await installHandoffCommand(this.commandFile());`；`uninstallHooks()` 在 `await uninstallHooks(...)` 之后加 `await uninstallHandoffCommand(this.commandFile());`。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/handoff src/main/hooks`
Expected: 全部 PASS。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过（渲染进程只是多了一个用不到的 `handoffCommand` 字段，任务 15 才显示它）。

```bash
git add src/shared/types.ts src/main/handoff src/main/hooks
git commit -m "feat: /handoff command installed with the hooks and captured from the transcript on Stop"
```

---

### Task 10: 探测 tracker MCP 工具名

验证记录 V3：MCP 工具名是 `mcp__<server>__<tool>`，server 名里的非法字符会被替换（`claude.ai Claude Docs` → `mcp__claude_ai_Claude_Docs__…`，`plugin:stripe:stripe` → `mcp__plugin_stripe_stripe__…`）；不在 `--allowedTools` 里的 MCP 工具在 `-p` 下被自动拒绝；`--output-format stream-json --verbose` 的第一条 `system/init` 消息列出所有已连接的 MCP server 和完整工具名，它在模型开始回答之前就到了（约 2 秒，第一条 assistant 消息约 5 秒）。读 `~/.claude.json` 找不到 claude.ai 连接器和插件提供的 server，`claude mcp list` 只有 server 名、没有工具名。所以最省事又可靠的办法：起一个 headless claude，读到 init 就结束进程；探测不到时用户可以在设置里手填。

**Files:**
- Create: `src/main/claude/mcp-probe.ts`, `src/main/claude/mcp-probe.test.ts`
- Modify: `src/shared/types.ts`

**Interfaces:**
- Consumes: `killTree`（任务 7）、`writeFakeClaude`（任务 7）
- Produces:
  - `McpProbe { servers: { name: string; status: string }[]; tools: string[]; suggested: string[] }`（`src/shared/types.ts`）
  - `PROBE_ARGS`、`parseInitMessage(line): McpProbe | null`、`suggestReadOnly(tools): string[]`、`probeMcpTools({ claudePath, cwd, env, timeoutMs? }): Promise<McpProbe>`

- [ ] **Step 1: 写失败测试**

`src/main/claude/mcp-probe.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { tempDir, writeFakeClaude } from "../test-utils";
import { parseInitMessage, probeMcpTools, suggestReadOnly } from "./mcp-probe";

/** 验证记录 V3：stream-json 的 init 消息（只保留相关字段）。 */
const INIT = {
  type: "system",
  subtype: "init",
  session_id: "1a93e8a0-a73c-4593-8318-88675b321cff",
  tools: ["Read", "Bash", "mcp__spike__echo", "mcp__spike__secret", "mcp__claude_ai_Claude_Docs__batch"],
  mcp_servers: [
    { name: "spike", status: "connected" },
    { name: "plugin:stripe:stripe", status: "needs-auth" },
    { name: "claude.ai Claude Docs", status: "connected" },
  ],
};
const env = () => ({ ...process.env }) as Record<string, string>;

describe("parseInitMessage", () => {
  it("keeps MCP tools and servers from the init line", () => {
    expect(parseInitMessage(JSON.stringify(INIT))).toEqual({
      servers: INIT.mcp_servers,
      tools: ["mcp__claude_ai_Claude_Docs__batch", "mcp__spike__echo", "mcp__spike__secret"],
      suggested: [],
    });
    expect(parseInitMessage(JSON.stringify({ type: "system", subtype: "hook_started" }))).toBeNull();
    expect(parseInitMessage("garbage")).toBeNull();
  });
});

describe("suggestReadOnly", () => {
  it("pre-selects tools whose names read like queries", () => {
    expect(
      suggestReadOnly([
        "mcp__jira__getIssue", "mcp__jira__createIssue", "mcp__atlassian__searchJiraIssuesUsingJql",
        "mcp__linear__list_issues", "mcp__x__target_update", "mcp__gitlab__get_merge_request",
      ]),
    ).toEqual(["mcp__jira__getIssue", "mcp__atlassian__searchJiraIssuesUsingJql", "mcp__linear__list_issues", "mcp__gitlab__get_merge_request"]);
  });
});

describe("probeMcpTools", () => {
  it("returns as soon as the init line arrives and stops claude", async () => {
    const dir = tempDir();
    const init = { ...INIT, tools: ["Read", "mcp__jira__get_issue"] };
    const fake = writeFakeClaude(dir, `emit({ type: "system", subtype: "hook_started" }); emit(${JSON.stringify(init)}); setTimeout(() => {}, 60000);`);
    const started = Date.now();
    const probe = await probeMcpTools({ claudePath: fake.path, cwd: dir, env: env() });
    expect(probe.tools).toEqual(["mcp__jira__get_issue"]);
    expect(probe.suggested).toEqual(["mcp__jira__get_issue"]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(fake.calls()[0].args).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "dontAsk"]);
  }, 20_000);

  it("rejects when claude exits without an init line", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, 'process.stdout.write("oops\\n");');
    await expect(probeMcpTools({ claudePath: fake.path, cwd: dir, env: env() })).rejects.toThrow("init");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/claude/mcp-probe.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/shared/types.ts` 末尾追加：

```ts
/** 探测到的 MCP server 和工具（设置页“检测”按钮）。suggested 是名字像查询的工具，默认勾选。 */
export interface McpProbe {
  servers: { name: string; status: string }[];
  tools: string[];
  suggested: string[];
}
```

`src/main/claude/mcp-probe.ts`：

```ts
import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import type { McpProbe } from "../../shared/types";
import { killTree } from "./headless";

/** 读到 init 就结束，模型还没开始回答。不落盘，权限全拒。 */
export const PROBE_ARGS = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", "dontAsk"];

const READ_WORDS = new Set(["get", "list", "search", "read", "view", "fetch", "query", "find", "lookup", "describe"]);

/** 工具名的工具部分（mcp__server__tool 的 tool）按下划线和驼峰拆词，含查询类动词的算“只读建议”。 */
export function suggestReadOnly(tools: string[]): string[] {
  return tools.filter((t) => {
    const part = t.split("__").slice(2).join("__");
    const words = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_-]+/).map((w) => w.toLowerCase());
    return words.some((w) => READ_WORDS.has(w));
  });
}

export function parseInitMessage(line: string): McpProbe | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as { type?: unknown; subtype?: unknown; tools?: unknown; mcp_servers?: unknown };
  if (o.type !== "system" || o.subtype !== "init") return null;
  const tools = (Array.isArray(o.tools) ? o.tools : []).filter((t): t is string => typeof t === "string" && t.startsWith("mcp__")).sort();
  const servers = (Array.isArray(o.mcp_servers) ? o.mcp_servers : []).flatMap((s) => {
    const x = s as { name?: unknown; status?: unknown } | null;
    return x && typeof x.name === "string" ? [{ name: x.name, status: typeof x.status === "string" ? x.status : "" }] : [];
  });
  return { servers, tools, suggested: suggestReadOnly(tools) };
}

export function probeMcpTools(o: { claudePath: string; cwd: string; env: Record<string, string>; timeoutMs?: number }): Promise<McpProbe> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(o.claudePath, PROBE_ARGS, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    let done = false;
    let buf = "";
    const timer = setTimeout(() => finish(new Error("等待 claude 启动超时，没有收到 init 消息")), o.timeoutMs ?? 60_000);
    function finish(err: Error | null, value?: McpProbe): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child);
      if (err) reject(err);
      else resolve(value as McpProbe);
    }
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const probe = parseInitMessage(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (probe) {
          finish(null, probe);
          return;
        }
      }
    });
    child.on("error", (e) => finish(e));
    child.on("close", () => finish(new Error("claude 没有输出 init 消息就退出了")));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end("Reply with OK.", "utf8");
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/claude/mcp-probe.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/shared/types.ts src/main/claude/mcp-probe.ts src/main/claude/mcp-probe.test.ts
git commit -m "feat: detect MCP tool names from claude's stream-json init message"
```

---

### Task 11: 本地日期工具与规则引擎（纯函数）

设计文档 6.3 节的规则，全部是纯函数，用 fixture 测试。阈值和工作日来自设置（任务 5）。下面说的“超过 N 天”都是严格大于：阻塞了正好 2 天不算，3 天才算。

**Files:**
- Create: `src/main/schedule/calendar.ts`, `src/main/schedule/calendar.test.ts`
- Create: `src/main/brief/engine.ts`, `src/main/brief/engine.test.ts`

**Interfaces:**
- Consumes: `Followup`、`HandoffRecord`、`TicketStatus`；`BriefContent`、`BriefItem`、`MarkState` 等（任务 5）；`Thresholds`（任务 5）；`emptyHandoff`（任务 4，仅测试）
- Produces:
  - `localDate(ms): string`、`dayStart(date): number`、`atTime(date, h, m): number`、`addDays(date, n): string`、`weekday(date): number`、`isWorkingDay(date, days): boolean`、`previousWorkingDay(date, days): string`、`daysBetween(fromMs, toMs): number`
  - `TicketSnapshot { key; status: TicketStatus（有效状态）; createdAt; statusSince; lastActivityAt; latest: HandoffRecord | null（最新完整 handoff）; latestDegraded: boolean }`
  - `MorningInput { now; tickets; followups; marks: ReadonlyMap<string, MarkState>; unclaimedCount; previousDay; previousDayHandoffs; thresholds }`、`EveningInput { now; tickets; todayHandoffs }`
  - `followupActive(f, today)`、`markHides(m, today)`、`buildMorningBrief(i): BriefContent`、`buildEveningBrief(i): BriefContent`

- [ ] **Step 1: 写失败测试**

`src/main/schedule/calendar.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { addDays, atTime, daysBetween, dayStart, isWorkingDay, localDate, previousWorkingDay, weekday } from "./calendar";

describe("calendar", () => {
  it("formats and parses local dates", () => {
    expect(localDate(new Date(2026, 9, 21, 23, 59).getTime())).toBe("2026-10-21");
    expect(dayStart("2026-10-21")).toBe(new Date(2026, 9, 21).getTime());
    expect(atTime("2026-10-21", 16, 0)).toBe(new Date(2026, 9, 21, 16, 0).getTime());
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekday("2026-10-19")).toBe(1);
  });

  it("finds the previous working day (Monday looks back to Friday)", () => {
    const weekdays = new Set([1, 2, 3, 4, 5]);
    expect(previousWorkingDay("2026-10-19", weekdays)).toBe("2026-10-16");
    expect(previousWorkingDay("2026-10-21", weekdays)).toBe("2026-10-20");
    expect(previousWorkingDay("2026-10-18", new Set([0, 1, 2, 3, 4]))).toBe("2026-10-15");
    expect(previousWorkingDay("2026-10-21", new Set())).toBe("2026-10-20");
    expect(isWorkingDay("2026-10-17", weekdays)).toBe(false);
    expect(isWorkingDay("2026-10-16", weekdays)).toBe(true);
  });

  it("counts whole local days, unaffected by daylight-saving changes", () => {
    expect(daysBetween(new Date(2026, 2, 7, 23, 0).getTime(), new Date(2026, 2, 9, 1, 0).getTime())).toBe(2);
    expect(daysBetween(new Date(2026, 9, 24, 12).getTime(), new Date(2026, 9, 26, 8).getTime())).toBe(2);
    expect(daysBetween(new Date(2026, 9, 31, 12).getTime(), new Date(2026, 10, 2, 8).getTime())).toBe(2);
    expect(daysBetween(new Date(2026, 9, 21, 0, 1).getTime(), new Date(2026, 9, 21, 23, 59).getTime())).toBe(0);
  });
});
```

`src/main/brief/engine.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { BriefContent, MarkState } from "../../shared/brief";
import type { Handoff } from "../../shared/handoff";
import type { Followup, HandoffRecord } from "../../shared/types";
import { emptyHandoff } from "../handoff/schema";
import { buildEveningBrief, buildMorningBrief, type MorningInput, type TicketSnapshot } from "./engine";

/** 2026 年 10 月：16 日周五，19 日周一，20 日周二，21 日周三。 */
const at = (d: number, h = 9, m = 0) => new Date(2026, 9, d, h, m).getTime();
const NOW = at(21);

const snap = (key: string, over: Partial<TicketSnapshot> = {}): TicketSnapshot => ({
  key, status: "active", createdAt: at(1), statusSince: at(20), lastActivityAt: at(20), latest: null, latestDegraded: false, ...over,
});
let nextId = 1;
const rec = (key: string, payload: Partial<Handoff> | null, over: Partial<HandoffRecord> = {}): HandoffRecord => ({
  id: nextId++, ticketKey: key, sessionId: "s", trigger: "nightly", createdAt: at(20, 16),
  payload: payload ? { ...emptyHandoff(key), ...payload } : null, degraded: payload === null, rawText: null, sourceRef: null, ...over,
});
const fu = (id: string, ticketKey: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey, kind: "config", description: `任务 ${id}`, trigger: "after_merge", dueDate: null, status: "open",
  snoozedUntil: null, source: "session", createdAt: at(1), doneAt: null, ...over,
});
const input = (over: Partial<MorningInput> = {}): MorningInput => ({
  now: NOW, tickets: [], followups: [], marks: new Map(), unclaimedCount: 0, previousDay: "2026-10-20", previousDayHandoffs: [],
  thresholds: { blockedDays: 2, reviewWaitDays: 2, staleDays: 5 }, ...over,
});
const summary = (c: BriefContent) => c.items.map((i) => `${i.section}:${i.rule}:${i.ticketKey ?? ""}${i.days !== null ? `:${i.days}` : ""}`);
const openPr = (review: "pending" | "changes_requested" | "approved" | null) => ({ number: 12, url: "https://x/pr/12", state: "open" as const, review });

describe("buildMorningBrief", () => {
  it("puts approved and changes-requested PRs first", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { status: "in_review", latest: rec("A-1", { pr: openPr("approved") }) }),
        snap("B-2", { status: "in_review", latest: rec("B-2", { pr: openPr("changes_requested") }) }),
      ],
    }));
    expect(summary(c)).toEqual(["first:pr_approved:A-1", "first:pr_changes_requested:B-2"]);
    expect(c.items[0]).toMatchObject({ key: "pr_approved:A-1:12", pr: { number: 12, url: "https://x/pr/12" } });
  });

  it("lists open after-merge followups of merged tickets, but not done, ignored or unmerged ones", () => {
    const c = buildMorningBrief(input({
      tickets: [snap("A-1", { status: "merged_pending_followup" }), snap("B-2")],
      followups: [
        fu("f1", "A-1"), fu("f2", "A-1", { status: "done" }), fu("f3", "A-1", { status: "ignored" }),
        fu("f4", "A-1", { trigger: "after_deploy" }), fu("f5", "B-2"),
      ],
    }));
    expect(c.items.map((i) => i.key)).toEqual(["followup:f1"]);
    expect(c.items[0]).toMatchObject({ section: "first", rule: "followup_after_merge", followupId: "f1", text: "任务 f1" });
  });

  it("flags on_date followups due today or overdue, and respects snoozes", () => {
    const due = (id: string, dueDate: string, over: Partial<Followup> = {}) => fu(id, "A-1", { trigger: "on_date", dueDate, ...over });
    const c = buildMorningBrief(input({
      tickets: [snap("A-1", { status: "in_review" })],
      followups: [
        due("today", "2026-10-21"), due("late", "2026-10-18"), due("later", "2026-10-22"),
        due("woke", "2026-10-18", { status: "snoozed", snoozedUntil: "2026-10-21" }),
        due("asleep", "2026-10-18", { status: "snoozed", snoozedUntil: "2026-10-22" }),
      ],
    }));
    expect(c.items.map((i) => [i.rule, i.followupId, i.days])).toEqual([
      ["followup_due", "today", 0], ["followup_due", "late", 3], ["followup_due", "woke", 3],
    ]);
  });

  it("shows the first next step of active tickets only", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { latest: rec("A-1", { next_steps: ["写迁移", "补测试"] }) }),
        snap("B-2", { status: "in_review", latest: rec("B-2", { next_steps: ["等 review"] }) }),
        snap("C-3", { latest: rec("C-3", { next_steps: [] }) }),
      ],
    }));
    expect(summary(c)).toEqual(["today:next_step:A-1"]);
    expect(c.items[0].text).toBe("写迁移");
    expect(c.items[0].key).toMatch(/^next:A-1:\d+$/);
  });

  it("reports tickets blocked for more than N days", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { status: "blocked", statusSince: at(19), latest: rec("A-1", { blockers: ["等接口"] }) }),
        snap("B-2", { status: "blocked", statusSince: at(18), latest: rec("B-2", { blockers: ["等设计稿"] }) }),
      ],
    }));
    expect(summary(c)).toEqual(["today:blocked_long:B-2:3"]);
    expect(c.items[0].text).toBe("等设计稿");
  });

  it("watches PRs waiting for review longer than N days", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { status: "in_review", statusSince: at(18), latest: rec("A-1", { pr: openPr("pending") }) }),
        snap("B-2", { status: "in_review", statusSince: at(20), latest: rec("B-2", { pr: openPr(null) }) }),
      ],
    }));
    expect(summary(c)).toEqual(["watch:review_waiting:A-1:3"]);
  });

  it("watches tickets without activity for more than N days, and unclaimed sessions", () => {
    const c = buildMorningBrief(input({ unclaimedCount: 3, tickets: [snap("A-1", { lastActivityAt: at(15) }), snap("B-2", { lastActivityAt: at(16) })] }));
    expect(summary(c)).toEqual(["watch:stale:A-1:6", "watch:unclaimed:"]);
    expect(c.items[1]).toMatchObject({ count: 3, key: "unclaimed:2026-10-21" });
  });

  it("hides items marked done or ignored, and snoozed ones until their day", () => {
    const tickets = [
      snap("A-1", { latest: rec("A-1", { next_steps: ["x"] }) }),
      snap("B-2", { lastActivityAt: at(10) }),
      snap("C-3", { status: "blocked", statusSince: at(10) }),
    ];
    const keys = buildMorningBrief(input({ tickets })).items.map((i) => i.key);
    expect(keys).toHaveLength(3);
    const marks = new Map<string, MarkState>([
      [keys[0], { mark: "done", untilDate: null }],
      [keys[1], { mark: "snoozed", untilDate: "2026-10-22" }],
      [keys[2], { mark: "snoozed", untilDate: "2026-10-21" }],
    ]);
    expect(buildMorningBrief(input({ tickets, marks })).items.map((i) => i.key)).toEqual([keys[2]]);
    const ignored = new Map<string, MarkState>([[keys[2], { mark: "ignored", untilDate: null }]]);
    expect(buildMorningBrief(input({ tickets, marks: ignored })).items.map((i) => i.key)).toEqual([keys[0], keys[1]]);
  });

  it("does not let item marks hide followup items (those use the followup's own status)", () => {
    const marks = new Map<string, MarkState>([["followup:f1", { mark: "done", untilDate: null }]]);
    const c = buildMorningBrief(input({ tickets: [snap("A-1", { status: "merged_pending_followup" })], followups: [fu("f1", "A-1")], marks }));
    expect(c.items.map((i) => i.key)).toEqual(["followup:f1"]);
  });

  it("orders sections first, today, watch", () => {
    const c = buildMorningBrief(input({
      unclaimedCount: 1,
      tickets: [snap("Z-9", { latest: rec("Z-9", { next_steps: ["a"] }) }), snap("A-1", { status: "in_review", latest: rec("A-1", { pr: openPr("approved") }) })],
    }));
    expect(c.items.map((i) => i.section)).toEqual(["first", "today", "watch"]);
  });

  it("summarises what was done on the previous working day, once per item", () => {
    const c = buildMorningBrief(input({
      previousDay: "2026-10-16",
      previousDayHandoffs: [
        rec("B-2", { done_today: ["修 bug", "写测试"] }),
        rec("A-1", { done_today: ["改配置"] }),
        rec("B-2", { done_today: ["写测试", " 发 PR "] }, { trigger: "command" }),
        rec("A-1", { done_today: ["不该出现"] }, { trigger: "refresh" }),
        rec("C-3", null),
      ],
    }));
    expect(c.previousDay).toEqual({
      date: "2026-10-16",
      entries: [
        { ticketKey: "A-1", done: ["改配置"] },
        { ticketKey: "B-2", done: ["修 bug", "写测试", "发 PR"] },
      ],
    });
    expect(c.evening).toEqual([]);
  });

  it("notes degraded handoffs and missing tracker data", () => {
    const c = buildMorningBrief(input({
      tickets: [
        snap("A-1", { latestDegraded: true }),
        snap("B-2", { latest: rec("B-2", { jira: null }) }),
        snap("C-3", { latest: rec("C-3", { jira: { status: "Open", subtasks: [] } }) }),
      ],
    }));
    expect(c.notices).toEqual({ degraded: ["A-1"], trackerUnavailable: ["B-2"] });
  });
});

describe("buildEveningBrief", () => {
  it("lists today's progress per ticket from the latest handoff, with done items from all of today", () => {
    const c = buildEveningBrief({
      now: at(21, 16, 30),
      tickets: [],
      todayHandoffs: [
        rec("A-1", { done_today: ["上午做的"], next_steps: ["旧的下一步"] }, { createdAt: at(21, 11), trigger: "command" }),
        rec("A-1", { done_today: ["下午做的"], next_steps: ["明天先做这个"], blockers: ["等设计稿"] }, { createdAt: at(21, 16) }),
        rec("B-2", null, { createdAt: at(21, 16) }),
        rec("C-3", { done_today: ["x"] }, { trigger: "refresh" }),
      ],
    });
    expect(c.evening).toEqual([
      { ticketKey: "A-1", done: ["上午做的", "下午做的"], blockers: ["等设计稿"], next: "明天先做这个", degraded: false },
      { ticketKey: "B-2", done: [], blockers: [], next: null, degraded: true },
    ]);
    expect(c.items).toEqual([]);
    expect(c.previousDay).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/schedule src/main/brief`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/main/schedule/calendar.ts`：

```ts
/** 本地时区的日期工具。日期一律用 "YYYY-MM-DD" 字符串表示，时刻用毫秒。 */
const pad = (n: number) => String(n).padStart(2, "0");

export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

/** 这一天本地 00:00。 */
export function dayStart(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(y, m - 1, d).getTime();
}

/** 这一天本地 h:m（夏令时切换当天也正确）。 */
export function atTime(date: string, h: number, min: number): number {
  const [y, m, d] = parts(date);
  return new Date(y, m - 1, d, h, min).getTime();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return localDate(new Date(y, m - 1, d + n).getTime());
}

/** 0 = 周日。 */
export function weekday(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(y, m - 1, d).getDay();
}

export function isWorkingDay(date: string, workingDays: ReadonlySet<number>): boolean {
  return workingDays.has(weekday(date));
}

/** 严格早于 date 的最近一个工作日（周一 → 上周五）；没有配置工作日时就是前一天。 */
export function previousWorkingDay(date: string, workingDays: ReadonlySet<number>): string {
  for (let i = 1; i <= 7; i++) {
    const c = addDays(date, -i);
    if (workingDays.has(weekday(c))) return c;
  }
  return addDays(date, -1);
}

/** 两个时刻之间相差的整天数，按本地日期算（夏令时切换不影响）。 */
export function daysBetween(fromMs: number, toMs: number): number {
  return Math.round((dayStart(localDate(toMs)) - dayStart(localDate(fromMs))) / 86_400_000);
}
```

`src/main/brief/engine.ts`：

```ts
import type { BriefContent, BriefItem, BriefNotices, BriefRule, BriefSection, DayEntry, EveningEntry, MarkState } from "../../shared/brief";
import type { Followup, HandoffRecord, TicketStatus } from "../../shared/types";
import { daysBetween, dayStart, localDate } from "../schedule/calendar";
import type { Thresholds } from "../settings/settings-values";

export interface TicketSnapshot {
  key: string;
  /** 有效状态（手动值优先）。 */
  status: TicketStatus;
  createdAt: number;
  /** 进入当前有效状态的时间。 */
  statusSince: number;
  /** 最近一次 session 活动（没有 session 时是创建时间）。 */
  lastActivityAt: number;
  /** 最新一条完整 handoff（含刷新）。 */
  latest: HandoffRecord | null;
  /** 最新一条 handoff（任何触发方式）是 degraded。 */
  latestDegraded: boolean;
}

export interface MorningInput {
  now: number;
  tickets: TicketSnapshot[];
  followups: Followup[];
  marks: ReadonlyMap<string, MarkState>;
  unclaimedCount: number;
  /** 上个工作日（YYYY-MM-DD），用作标题。 */
  previousDay: string;
  /** 从上个工作日开始到现在的 handoff。 */
  previousDayHandoffs: HandoffRecord[];
  thresholds: Thresholds;
}

export interface EveningInput {
  now: number;
  tickets: TicketSnapshot[];
  /** 今天的 handoff，旧的在前。 */
  todayHandoffs: HandoffRecord[];
}

const SECTION_RANK: Record<BriefSection, number> = { first: 0, today: 1, watch: 2 };
const RULE_RANK: Record<BriefRule, number> = {
  pr_approved: 0, pr_changes_requested: 1, followup_after_merge: 2, followup_due: 3,
  next_step: 4, blocked_long: 5, review_waiting: 6, stale: 7, unclaimed: 8,
};

/** open 的，或推迟到今天（含）已经到期的。 */
export function followupActive(f: Followup, today: string): boolean {
  if (f.status === "open") return true;
  return f.status === "snoozed" && f.snoozedUntil !== null && f.snoozedUntil <= today;
}

/** done / ignored 永远隐藏；snoozed 隐藏到 untilDate 那天为止（那天重新出现）。 */
export function markHides(m: MarkState | undefined, today: string): boolean {
  if (!m) return false;
  if (m.mark === "snoozed") return m.untilDate !== null && today < m.untilDate;
  return true;
}

function item(section: BriefSection, rule: BriefRule, key: string, over: Partial<BriefItem> = {}): BriefItem {
  return { key, section, rule, ticketKey: null, followupId: null, text: null, days: null, count: null, pr: null, dueDate: null, ...over };
}

function doneByTicket(handoffs: HandoffRecord[]): DayEntry[] {
  const by = new Map<string, string[]>();
  for (const h of handoffs) {
    if (!h.payload || h.trigger === "refresh") continue;
    const list = by.get(h.ticketKey) ?? [];
    for (const d of h.payload.done_today) {
      const s = d.trim();
      if (s && !list.includes(s)) list.push(s);
    }
    by.set(h.ticketKey, list);
  }
  return [...by]
    .filter(([, done]) => done.length > 0)
    .map(([ticketKey, done]) => ({ ticketKey, done }))
    .sort((a, b) => a.ticketKey.localeCompare(b.ticketKey));
}

function notices(tickets: TicketSnapshot[]): BriefNotices {
  return {
    degraded: tickets.filter((t) => t.latestDegraded).map((t) => t.key).sort(),
    trackerUnavailable: tickets.filter((t) => t.latest?.payload && t.latest.payload.jira === null).map((t) => t.key).sort(),
  };
}

/** 设计文档 6.3 节的规则。 */
export function buildMorningBrief(i: MorningInput): BriefContent {
  const today = localDate(i.now);
  const active = i.followups.filter((f) => followupActive(f, today));
  const items: BriefItem[] = [];

  for (const t of i.tickets) {
    const p = t.latest?.payload ?? null;
    const pr = p?.pr ?? null;
    const prRef = pr ? { number: pr.number, url: pr.url } : null;

    // 🔴 先做
    if (pr?.state === "open" && pr.review === "approved") {
      items.push(item("first", "pr_approved", `pr_approved:${t.key}:${pr.number}`, { ticketKey: t.key, pr: prRef }));
    }
    if (pr?.state === "open" && pr.review === "changes_requested") {
      items.push(item("first", "pr_changes_requested", `pr_changes:${t.key}:${pr.number}`, { ticketKey: t.key, pr: prRef }));
    }
    for (const f of active) {
      if (f.ticketKey !== t.key) continue;
      if (t.status === "merged_pending_followup" && f.trigger === "after_merge") {
        items.push(item("first", "followup_after_merge", `followup:${f.id}`, { ticketKey: t.key, followupId: f.id, text: f.description }));
      } else if (f.trigger === "on_date" && f.dueDate !== null && f.dueDate <= today) {
        items.push(item("first", "followup_due", `followup:${f.id}`, {
          ticketKey: t.key, followupId: f.id, text: f.description, dueDate: f.dueDate, days: daysBetween(dayStart(f.dueDate), i.now),
        }));
      }
    }

    // 🟡 今天
    const next = p?.next_steps[0];
    if (t.status === "active" && next && t.latest) {
      items.push(item("today", "next_step", `next:${t.key}:${t.latest.id}`, { ticketKey: t.key, text: next }));
    }
    const inStatus = daysBetween(t.statusSince, i.now);
    if (t.status === "blocked" && inStatus > i.thresholds.blockedDays) {
      items.push(item("today", "blocked_long", `blocked:${t.key}:${localDate(t.statusSince)}`, { ticketKey: t.key, days: inStatus, text: p?.blockers[0] ?? null }));
    }

    // ⚪ 留意
    if (t.status === "in_review" && (pr === null || pr.review === null || pr.review === "pending") && inStatus > i.thresholds.reviewWaitDays) {
      items.push(item("watch", "review_waiting", `review:${t.key}:${localDate(t.statusSince)}`, { ticketKey: t.key, days: inStatus, pr: prRef }));
    }
    const idle = daysBetween(t.lastActivityAt, i.now);
    if (idle > i.thresholds.staleDays) {
      items.push(item("watch", "stale", `stale:${t.key}:${localDate(t.lastActivityAt)}`, { ticketKey: t.key, days: idle }));
    }
  }
  if (i.unclaimedCount > 0) items.push(item("watch", "unclaimed", `unclaimed:${today}`, { count: i.unclaimedCount }));

  // followup 条目由 followup 自己的状态决定；其余条目看 item_marks。
  const visible = items.filter((it) => it.followupId !== null || !markHides(i.marks.get(it.key), today));
  visible.sort(
    (a, b) =>
      SECTION_RANK[a.section] - SECTION_RANK[b.section] ||
      RULE_RANK[a.rule] - RULE_RANK[b.rule] ||
      (a.ticketKey ?? "").localeCompare(b.ticketKey ?? ""),
  );
  return { items: visible, previousDay: { date: i.previousDay, entries: doneByTicket(i.previousDayHandoffs) }, evening: [], notices: notices(i.tickets) };
}

/** 设计文档 6.1 节：按 ticket 列出今天做了什么、阻塞项和明天第一步。 */
export function buildEveningBrief(i: EveningInput): BriefContent {
  const captured = i.todayHandoffs.filter((h) => h.trigger !== "refresh");
  const latest = new Map<string, HandoffRecord>();
  for (const h of captured) latest.set(h.ticketKey, h);
  const done = new Map(doneByTicket(captured).map((e) => [e.ticketKey, e.done]));
  const evening: EveningEntry[] = [...latest.values()]
    .map((h) => ({
      ticketKey: h.ticketKey,
      done: done.get(h.ticketKey) ?? [],
      blockers: h.payload?.blockers ?? [],
      next: h.payload?.next_steps[0] ?? null,
      degraded: h.payload === null,
    }))
    .sort((a, b) => a.ticketKey.localeCompare(b.ticketKey));
  return { items: [], previousDay: null, evening, notices: notices(i.tickets) };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/schedule src/main/brief`
Expected: 全部 PASS。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/main/schedule src/main/brief
git commit -m "feat: local calendar helpers and the rule-based brief engine with fixture tests"
```

---

### Task 12: BriefService、调度器与每日任务

**Files:**
- Create: `src/main/brief/brief-service.ts`, `src/main/brief/brief-service.test.ts`
- Create: `src/main/schedule/scheduler.ts`, `src/main/schedule/scheduler.test.ts`
- Create: `src/main/schedule/daily-jobs.ts`, `src/main/schedule/daily-jobs.test.ts`

**Interfaces:**
- Consumes: 任务 5 的各个 repo 与 `scheduleConfig` / `thresholds`；任务 11 的 `buildMorningBrief` / `buildEveningBrief` / 日期工具；任务 8 的 `HandoffRunner`、`BatchResult`；任务 6 的 `ingestHandoff`（仅测试）
- Produces:
  - `BriefServiceDeps { tickets; sessions; handoffs; followups; marks; briefs; settings; now; unclaimedCount: () => number }`
  - `BriefService { snapshot(): TicketSnapshot[]; generateMorning(): Brief; generateEvening(): Brief; latest(kind): Brief | null; mark(itemKey, mark: ItemMark): void }`
  - `ScheduleTrigger = "startup" | "resume" | "unlock" | "tick"`、`MORNING_EARLIEST_HOUR = 5`、`TICK_MS = 60_000`
  - `lastNightlySlot(now, cfg)`、`isMorningDue(now, job, trigger, userActive)`、`isNightlyDue(now, cfg, job, morningDue)`
  - `SchedulerDeps { jobs; config: () => ScheduleConfig; now; userActive: () => boolean; nightly: () => Promise<"ok" | "partial">; morning: () => Promise<void>; onChange?; log? }`
  - `Scheduler { isRunning(job); check(trigger): Promise<void>; runNightlyNow(): Promise<void>; runMorningNow(): Promise<void> }`
  - `DailyJobDeps { runner; briefs; jobs; now; isWorkingDay: () => boolean; setRefreshing: (v: boolean) => void; onEvening: (b: Brief) => void }`、`nightlyJob(d): Promise<"ok" | "partial">`、`morningJob(d): Promise<void>`

- [ ] **Step 1: 写失败测试**

`src/main/brief/brief-service.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Handoff } from "../../shared/handoff";
import { BriefsRepo } from "../db/briefs-repo";
import { FollowupsRepo } from "../db/followups-repo";
import { HandoffsRepo } from "../db/handoffs-repo";
import { MarksRepo } from "../db/marks-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { ingestHandoff, type IngestInput } from "../handoff/ingest";
import { emptyHandoff } from "../handoff/schema";
import { memDb } from "../test-utils";
import { BriefService } from "./brief-service";

const at = (d: number, h = 9, m = 0) => new Date(2026, 9, d, h, m).getTime();

function setup() {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  let now = at(21);
  let unclaimed = 0;
  let fid = 0;
  const ingest = (input: IngestInput) => ingestHandoff({ db, tickets, handoffs, followups, now: () => now, newFollowupId: () => `f${++fid}` }, input);
  const service = new BriefService({
    tickets, sessions, handoffs, followups, marks: new MarksRepo(db), briefs: new BriefsRepo(db), settings: new SettingsRepo(db),
    now: () => now, unclaimedCount: () => unclaimed,
  });
  /** ticket 加一个最近有活动的 session（免得被算成“无活动”）。 */
  const addTicket = (key: string, activity = at(20)) => {
    tickets.insert({ key, title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active", statusManual: null, createdAt: at(1), archivedAt: null });
    sessions.insertIfAbsent({ id: `s-${key}`, ticketKey: key, cwd: "/w", origin: "butler", lastActivityAt: activity, createdAt: at(1) });
  };
  const handoff = (key: string, over: Partial<Handoff>) =>
    ingest({ ticketKey: key, sessionId: `s-${key}`, trigger: "nightly", rawText: null, payload: { ...emptyHandoff(key), ...over } });
  return {
    service, tickets, addTicket, handoff,
    setNow: (ms: number) => void (now = ms),
    setUnclaimed: (n: number) => void (unclaimed = n),
  };
}

describe("BriefService", () => {
  it("builds a morning brief from the database, looks back to Friday on Monday, and keeps the narrative off", () => {
    const s = setup();
    s.addTicket("A-1", at(16, 17));
    s.setNow(at(16, 16));
    s.handoff("A-1", { done_today: ["周五做的"], next_steps: ["周一先做"] });
    s.setNow(at(19, 9));
    const brief = s.service.generateMorning();
    expect(brief).toMatchObject({ kind: "morning", date: "2026-10-19", narrative: null, narrativeStatus: "off" });
    expect(brief.previousDay).toEqual({ date: "2026-10-16", entries: [{ ticketKey: "A-1", done: ["周五做的"] }] });
    expect(brief.items.map((i) => [i.rule, i.ticketKey, i.text])).toEqual([["next_step", "A-1", "周一先做"]]);
    expect(s.service.latest("morning")).toEqual(brief);
  });

  it("measures a manually blocked ticket from when it was set by hand", () => {
    const s = setup();
    s.addTicket("B-2");
    s.tickets.setStatusManual("B-2", "blocked", at(15));
    expect(s.service.generateMorning().items.map((i) => [i.rule, i.days])).toEqual([["blocked_long", 6]]);
  });

  it("snoozes an item until tomorrow", () => {
    const s = setup();
    s.addTicket("A-1");
    s.handoff("A-1", { next_steps: ["写测试"] });
    const key = s.service.generateMorning().items[0].key;
    s.service.mark(key, "snoozed");
    expect(s.service.generateMorning().items).toEqual([]);
    s.setNow(at(22));
    expect(s.service.generateMorning().items.map((i) => i.key)).toEqual([key]);
  });

  it("counts unclaimed sessions and builds the evening summary from today's handoffs", () => {
    const s = setup();
    s.setUnclaimed(2);
    expect(s.service.generateMorning().items.map((i) => [i.rule, i.count])).toEqual([["unclaimed", 2]]);
    s.addTicket("A-1");
    s.setNow(at(21, 16));
    s.handoff("A-1", { done_today: ["今天做的"], next_steps: ["明天做的"] });
    const evening = s.service.generateEvening();
    expect(evening).toMatchObject({ kind: "evening", date: "2026-10-21", narrativeStatus: "off" });
    expect(evening.evening).toEqual([{ ticketKey: "A-1", done: ["今天做的"], blockers: [], next: "明天做的", degraded: false }]);
    expect(s.service.latest("evening")?.id).toBe(evening.id);
  });
});
```

`src/main/schedule/scheduler.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { JOB_NIGHTLY, JobsRepo } from "../db/jobs-repo";
import { memDb } from "../test-utils";
import { localDate } from "./calendar";
import { isMorningDue, isNightlyDue, lastNightlySlot, Scheduler } from "./scheduler";

/** 2026 年 10 月：16 日周五，17 日周六，19 日周一，20 日周二，21 日周三。 */
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const cfg = { nightly: { h: 16, m: 0 }, workingDays: new Set([1, 2, 3, 4, 5]) };

describe("lastNightlySlot", () => {
  it("finds the latest working-day slot at or before now", () => {
    expect(lastNightlySlot(at(20, 17), cfg)).toBe(at(20, 16));
    expect(lastNightlySlot(at(20, 15), cfg)).toBe(at(19, 16));
    expect(lastNightlySlot(at(19, 10), cfg)).toBe(at(16, 16));
    expect(lastNightlySlot(at(17, 20), cfg)).toBe(at(16, 16));
    expect(lastNightlySlot(at(20, 17), { ...cfg, workingDays: new Set<number>() })).toBeNull();
  });
});

describe("isNightlyDue / isMorningDue", () => {
  it("runs the nightly batch once per slot, never on first launch, and retries a partial run before the morning brief", () => {
    expect(isNightlyDue(at(20, 16, 1), cfg, { lastRunAt: at(19, 16, 5), lastStatus: "ok" }, false)).toBe(true);
    expect(isNightlyDue(at(20, 17), cfg, { lastRunAt: at(20, 16, 1), lastStatus: "ok" }, false)).toBe(false);
    expect(isNightlyDue(at(20, 17), cfg, { lastRunAt: null, lastStatus: null }, true)).toBe(false);
    expect(isNightlyDue(at(21, 9), cfg, { lastRunAt: at(19, 16), lastStatus: "ok" }, true)).toBe(true);
    expect(isNightlyDue(at(21, 9), cfg, { lastRunAt: at(20, 16), lastStatus: "partial" }, true)).toBe(true);
    expect(isNightlyDue(at(21, 9), cfg, { lastRunAt: at(20, 16), lastStatus: "failed" }, true)).toBe(true);
    expect(isNightlyDue(at(21, 9), cfg, { lastRunAt: at(20, 16), lastStatus: "partial" }, false)).toBe(false);
    expect(isNightlyDue(at(17, 20), cfg, { lastRunAt: at(16, 16), lastStatus: "ok" }, false)).toBe(false);
  });

  it("runs the morning brief once per day after 5:00, on events, or on a tick while the user is active", () => {
    const yesterday = { lastRunAt: at(20, 9) };
    expect(isMorningDue(at(21, 9), yesterday, "unlock", false)).toBe(true);
    expect(isMorningDue(at(21, 9), { lastRunAt: at(21, 8) }, "unlock", false)).toBe(false);
    expect(isMorningDue(at(21, 4), yesterday, "startup", true)).toBe(false);
    expect(isMorningDue(at(21, 9), yesterday, "tick", false)).toBe(false);
    expect(isMorningDue(at(21, 9), yesterday, "tick", true)).toBe(true);
    expect(isMorningDue(at(21, 9), { lastRunAt: null }, "startup", false)).toBe(true);
  });
});

describe("Scheduler", () => {
  function setup(start: number) {
    let now = start;
    let nightlyStatus: "ok" | "partial" = "ok";
    const jobs = new JobsRepo(memDb());
    const log: string[] = [];
    const scheduler = new Scheduler({
      jobs, config: () => cfg, now: () => now, userActive: () => true,
      nightly: async () => {
        log.push(`nightly@${localDate(now)}`);
        return nightlyStatus;
      },
      morning: async () => {
        log.push(`morning@${localDate(now)}`);
      },
    });
    return {
      scheduler, jobs, log,
      setNow: (ms: number) => void (now = ms),
      setNightlyStatus: (s: "ok" | "partial") => void (nightlyStatus = s),
    };
  }

  it("seeds on first launch, runs the morning brief, then the nightly batch at 16:00", async () => {
    const s = setup(at(20, 9));
    await s.scheduler.check("startup");
    expect(s.log).toEqual(["morning@2026-10-20"]);
    expect(s.jobs.get(JOB_NIGHTLY).lastStatus).toBe("seeded");
    for (const [h, m] of [[15, 59], [16, 0], [16, 1]]) {
      s.setNow(at(20, h, m));
      await s.scheduler.check("tick");
    }
    expect(s.log).toEqual(["morning@2026-10-20", "nightly@2026-10-20"]);
    expect(s.jobs.get(JOB_NIGHTLY)).toMatchObject({ lastRunAt: at(20, 16), lastStatus: "ok" });
  });

  it("catches up a missed nightly run before the morning brief after the laptop slept", async () => {
    const s = setup(at(19, 9));
    await s.scheduler.check("startup");
    s.setNow(at(21, 8, 30));
    await s.scheduler.check("resume");
    expect(s.log).toEqual(["morning@2026-10-19", "nightly@2026-10-21", "morning@2026-10-21"]);
    await s.scheduler.check("unlock");
    expect(s.log).toHaveLength(3);
  });

  it("retries a partial nightly batch once before the next morning brief", async () => {
    const s = setup(at(20, 9));
    await s.scheduler.check("startup");
    s.setNightlyStatus("partial");
    s.setNow(at(20, 16));
    await s.scheduler.check("tick");
    s.setNightlyStatus("ok");
    s.setNow(at(21, 9));
    await s.scheduler.check("unlock");
    await s.scheduler.check("tick");
    expect(s.log).toEqual(["morning@2026-10-20", "nightly@2026-10-20", "nightly@2026-10-21", "morning@2026-10-21"]);
  });

  it("skips weekends and serialises triggers that arrive together", async () => {
    const s = setup(at(16, 17));
    await s.scheduler.check("startup");
    s.setNow(at(17, 16, 30));
    await Promise.all([s.scheduler.check("tick"), s.scheduler.check("unlock"), s.scheduler.check("resume")]);
    expect(s.log).toEqual(["morning@2026-10-16", "morning@2026-10-17"]);
  });

  it("records failures and reports a job as running only while it runs", async () => {
    let seen = false;
    const jobs = new JobsRepo(memDb());
    const scheduler: Scheduler = new Scheduler({
      jobs, config: () => cfg, now: () => at(20, 17), userActive: () => true,
      nightly: async () => {
        seen = scheduler.isRunning(JOB_NIGHTLY);
        throw new Error("claude 不见了");
      },
      morning: async () => undefined,
    });
    await scheduler.runNightlyNow();
    expect(seen).toBe(true);
    expect(scheduler.isRunning(JOB_NIGHTLY)).toBe(false);
    expect(jobs.get(JOB_NIGHTLY)).toMatchObject({ lastRunAt: at(20, 17), lastStatus: "failed", lastError: "claude 不见了" });
  });
});
```

`src/main/schedule/daily-jobs.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { EMPTY_BRIEF_CONTENT, type Brief, type BriefKind } from "../../shared/brief";
import { JOB_EVENING, JobsRepo } from "../db/jobs-repo";
import { memDb } from "../test-utils";
import { morningJob, nightlyJob, type DailyJobDeps } from "./daily-jobs";

const brief = (kind: BriefKind): Brief => ({ id: 1, kind, date: "2026-10-21", createdAt: 1, ...EMPTY_BRIEF_CONTENT, narrative: null, narrativeStatus: "off" });

function deps(over: Partial<DailyJobDeps> = {}) {
  const calls: string[] = [];
  const jobs = new JobsRepo(memDb());
  const d: DailyJobDeps = {
    runner: {
      runNightly: async () => {
        calls.push("runNightly");
        return { status: "partial", outcomes: [] };
      },
      refreshForBrief: async () => {
        calls.push("refresh");
        return { status: "ok", outcomes: [{ ticketKey: "A-1", status: "stored", handoffId: 1, degraded: false }] };
      },
    },
    briefs: {
      generateMorning: () => {
        calls.push("morning");
        return brief("morning");
      },
      generateEvening: () => {
        calls.push("evening");
        return brief("evening");
      },
    },
    jobs,
    now: () => 123,
    isWorkingDay: () => true,
    setRefreshing: (v) => calls.push(`refreshing=${v}`),
    onEvening: (b) => calls.push(`notify:${b.kind}`),
    ...over,
  };
  return { d, calls, jobs };
}

describe("daily jobs", () => {
  it("nightly: batch, then the evening summary and a notification", async () => {
    const { d, calls, jobs } = deps();
    expect(await nightlyJob(d)).toBe("partial");
    expect(calls).toEqual(["runNightly", "evening", "notify:evening"]);
    expect(jobs.get(JOB_EVENING)).toMatchObject({ lastRunAt: 123, lastStatus: "ok" });
  });

  it("morning: a quick brief from current data first, then refresh and regenerate on working days", async () => {
    const { d, calls } = deps();
    await morningJob(d);
    expect(calls).toEqual(["morning", "refreshing=true", "refresh", "morning", "refreshing=false"]);
  });

  it("morning: no refresh on days off, and the flag is cleared even if refresh fails", async () => {
    const off = deps({ isWorkingDay: () => false });
    await morningJob(off.d);
    expect(off.calls).toEqual(["morning"]);
    const failing = deps();
    failing.d.runner = {
      ...failing.d.runner,
      refreshForBrief: async () => {
        throw new Error("boom");
      },
    };
    await expect(morningJob(failing.d)).rejects.toThrow("boom");
    expect(failing.calls).toEqual(["morning", "refreshing=true", "refreshing=false"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/main/brief src/main/schedule`
Expected: 新的 3 个测试文件 FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/main/brief/brief-service.ts`：

```ts
import type { Brief, BriefKind, ItemMark } from "../../shared/brief";
import { effectiveStatus } from "../../shared/types";
import type { BriefsRepo } from "../db/briefs-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MarksRepo } from "../db/marks-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { addDays, dayStart, localDate, previousWorkingDay } from "../schedule/calendar";
import { scheduleConfig, thresholds } from "../settings/settings-values";
import { buildEveningBrief, buildMorningBrief, type TicketSnapshot } from "./engine";

export interface BriefServiceDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  handoffs: HandoffsRepo;
  followups: FollowupsRepo;
  marks: MarksRepo;
  briefs: BriefsRepo;
  settings: SettingsRepo;
  now: () => number;
  unclaimedCount: () => number;
}

export class BriefService {
  constructor(private readonly d: BriefServiceDeps) {}

  /** 规则引擎的输入：每个未归档 ticket 的状态、时间点和最新 handoff。 */
  snapshot(): TicketSnapshot[] {
    return this.d.tickets.list().map((t) => {
      const times = this.d.tickets.statusTimes(t.key);
      const statusSince = (t.statusManual ? times.manualAt : times.changedAt) ?? t.createdAt;
      const activity = this.d.sessions.listByTicket(t.key).map((s) => s.lastActivityAt ?? 0);
      return {
        key: t.key,
        status: effectiveStatus(t),
        createdAt: t.createdAt,
        statusSince,
        lastActivityAt: Math.max(t.createdAt, ...activity),
        latest: this.d.handoffs.latestValid(t.key),
        latestDegraded: this.d.handoffs.latest(t.key)?.degraded ?? false,
      };
    });
  }

  generateMorning(): Brief {
    const now = this.d.now();
    const today = localDate(now);
    const previousDay = previousWorkingDay(today, scheduleConfig(this.d.settings).workingDays);
    const content = buildMorningBrief({
      now,
      tickets: this.snapshot(),
      followups: this.d.followups.listActiveTickets(),
      marks: this.d.marks.all(),
      unclaimedCount: this.d.unclaimedCount(),
      previousDay,
      // 从上个工作日开始到现在：包括周末用 /handoff 记下的，也包括今天早上补跑的晚间批量。
      previousDayHandoffs: this.d.handoffs.listBetween(dayStart(previousDay), now + 1),
      thresholds: thresholds(this.d.settings),
    });
    // 计划 3 在这里接 PrivacyGateway 生成“今日重点”；计划 2 永远是 off。
    return this.d.briefs.insert({ kind: "morning", date: today, createdAt: now, content, narrative: null, narrativeStatus: "off" });
  }

  generateEvening(): Brief {
    const now = this.d.now();
    const today = localDate(now);
    const content = buildEveningBrief({ now, tickets: this.snapshot(), todayHandoffs: this.d.handoffs.listBetween(dayStart(today), now + 1) });
    return this.d.briefs.insert({ kind: "evening", date: today, createdAt: now, content, narrative: null, narrativeStatus: "off" });
  }

  latest(kind: BriefKind): Brief | null {
    return this.d.briefs.latest(kind);
  }

  /** 非 followup 条目的“完成 / 推迟到明天 / 忽略”。 */
  mark(itemKey: string, mark: ItemMark): void {
    const now = this.d.now();
    this.d.marks.set(itemKey, mark, mark === "snoozed" ? addDays(localDate(now), 1) : null, now);
  }
}
```

`src/main/schedule/scheduler.ts`：

```ts
import { JOB_MORNING, JOB_NIGHTLY, type JobsRepo, type JobState } from "../db/jobs-repo";
import type { ScheduleConfig } from "../settings/settings-values";
import { addDays, atTime, localDate, weekday } from "./calendar";

export type ScheduleTrigger = "startup" | "resume" | "unlock" | "tick";

/** 凌晨 5 点前的解锁/启动不算“早上”。 */
export const MORNING_EARLIEST_HOUR = 5;
export const TICK_MS = 60_000;

/** 不晚于 now 的最近一个工作日的晚间时刻；最近 8 天都不是工作日时为 null。 */
export function lastNightlySlot(now: number, cfg: ScheduleConfig): number | null {
  const today = localDate(now);
  for (let i = 0; i <= 7; i++) {
    const date = addDays(today, -i);
    if (!cfg.workingDays.has(weekday(date))) continue;
    const slot = atTime(date, cfg.nightly.h, cfg.nightly.m);
    if (slot <= now) return slot;
  }
  return null;
}

/** 每天第一次 startup / resume / unlock（5 点以后）；tick 只在用户正在用电脑时算数（整晚没锁屏的情况）。 */
export function isMorningDue(now: number, job: Pick<JobState, "lastRunAt">, trigger: ScheduleTrigger, userActive: boolean): boolean {
  if (new Date(now).getHours() < MORNING_EARLIEST_HOUR) return false;
  if (job.lastRunAt !== null && localDate(job.lastRunAt) === localDate(now)) return false;
  return trigger !== "tick" || userActive;
}

/**
 * 最近一个晚间时刻之后还没跑过 → 到期（错过的会在下一次唤醒/解锁/启动时补跑）。
 * 上次限流或失败 → 在早间简报之前再补一次。第一次启动（从没记录）不补历史。
 */
export function isNightlyDue(now: number, cfg: ScheduleConfig, job: Pick<JobState, "lastRunAt" | "lastStatus">, morningDue: boolean): boolean {
  if (job.lastRunAt === null) return false;
  const slot = lastNightlySlot(now, cfg);
  if (slot !== null && job.lastRunAt < slot) return true;
  return morningDue && (job.lastStatus === "partial" || job.lastStatus === "failed");
}

export interface SchedulerDeps {
  jobs: JobsRepo;
  config: () => ScheduleConfig;
  now: () => number;
  userActive: () => boolean;
  nightly: () => Promise<"ok" | "partial">;
  morning: () => Promise<void>;
  onChange?: () => void;
  log?: (msg: string, err?: unknown) => void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Scheduler {
  private chain: Promise<void> = Promise.resolve();
  private readonly running = new Set<string>();

  constructor(private readonly d: SchedulerDeps) {}

  isRunning(job: typeof JOB_NIGHTLY | typeof JOB_MORNING): boolean {
    return this.running.has(job);
  }

  /** 串行执行：同时到来的事件排队，轮到时重新判断是否到期，所以同一个任务不会重复跑。 */
  check(trigger: ScheduleTrigger): Promise<void> {
    return this.enqueue(() => this.evaluate(trigger));
  }

  runNightlyNow(): Promise<void> {
    return this.enqueue(() => this.runNightly());
  }

  runMorningNow(): Promise<void> {
    return this.enqueue(() => this.runMorning());
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn).catch((e: unknown) => this.d.log?.("scheduler step failed", e));
    this.chain = next;
    return next;
  }

  private async evaluate(trigger: ScheduleTrigger): Promise<void> {
    const now = this.d.now();
    if (this.d.jobs.get(JOB_NIGHTLY).lastRunAt === null) this.d.jobs.record(JOB_NIGHTLY, now, "seeded", null);
    const morningDue = isMorningDue(now, this.d.jobs.get(JOB_MORNING), trigger, this.d.userActive());
    // 错过的晚间 handoff 先跑，早间简报才有最新数据。
    if (isNightlyDue(now, this.d.config(), this.d.jobs.get(JOB_NIGHTLY), morningDue)) await this.runNightly();
    if (morningDue) await this.runMorning();
  }

  private async runNightly(): Promise<void> {
    const startedAt = this.d.now();
    await this.track(
      JOB_NIGHTLY,
      async () => this.d.jobs.record(JOB_NIGHTLY, startedAt, await this.d.nightly(), null),
      (e) => this.d.jobs.record(JOB_NIGHTLY, startedAt, "failed", message(e)),
    );
  }

  private async runMorning(): Promise<void> {
    const startedAt = this.d.now();
    await this.track(
      JOB_MORNING,
      async () => {
        await this.d.morning();
        this.d.jobs.record(JOB_MORNING, startedAt, "ok", null);
      },
      (e) => this.d.jobs.record(JOB_MORNING, startedAt, "failed", message(e)),
    );
  }

  private async track(name: string, fn: () => Promise<void>, onError: (e: unknown) => void): Promise<void> {
    this.running.add(name);
    this.d.onChange?.();
    try {
      await fn();
    } catch (e) {
      this.d.log?.(`${name} failed`, e);
      onError(e);
    } finally {
      this.running.delete(name);
      this.d.onChange?.();
    }
  }
}
```

`src/main/schedule/daily-jobs.ts`：

```ts
import type { Brief } from "../../shared/brief";
import type { BriefService } from "../brief/brief-service";
import { JOB_EVENING, type JobsRepo } from "../db/jobs-repo";
import type { HandoffRunner } from "../handoff/runner";

export interface DailyJobDeps {
  runner: Pick<HandoffRunner, "runNightly" | "refreshForBrief">;
  briefs: Pick<BriefService, "generateMorning" | "generateEvening">;
  jobs: JobsRepo;
  now: () => number;
  isWorkingDay: () => boolean;
  /** 早间刷新进行中（界面显示“刷新中”）。 */
  setRefreshing: (v: boolean) => void;
  /** 晚间小结生成后：弹系统通知。 */
  onEvening: (brief: Brief) => void;
}

/** 晚间：批量 handoff → 晚间小结 → 系统通知。 */
export async function nightlyJob(d: DailyJobDeps): Promise<"ok" | "partial"> {
  const batch = await d.runner.runNightly();
  const brief = d.briefs.generateEvening();
  d.jobs.record(JOB_EVENING, d.now(), "ok", null);
  d.onEvening(brief);
  return batch.status;
}

/** 早间：先用现有数据出一版（界面马上有内容），工作日再刷新 PR / tracker 状态后原地更新。 */
export async function morningJob(d: DailyJobDeps): Promise<void> {
  d.briefs.generateMorning();
  if (!d.isWorkingDay()) return;
  d.setRefreshing(true);
  try {
    const r = await d.runner.refreshForBrief();
    if (r.outcomes.length > 0) d.briefs.generateMorning();
  } finally {
    d.setRefreshing(false);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm exec vitest run src/main/brief src/main/schedule`
Expected: 全部 PASS。

- [ ] **Step 5: 全量检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全部通过。

```bash
git add src/main/brief src/main/schedule
git commit -m "feat: brief service with item marks, catch-up scheduler and the nightly/morning jobs"
```

---

### Task 13: 主进程组装、IPC 与调度事件

把任务 4–12 的模块接进主进程：新的 IPC 通道（简报、followups、handoff、设置、MCP 探测），`powerMonitor` 的 `resume` / `unlock-screen`、启动和每分钟 tick 触发调度，晚间小结弹系统通知（点击后回到简报），Stop hook 之后采集 `/handoff`。另外：设置了 `BUTLER_HOME` 时改用独立的 Electron 用户目录，否则隔离启动会被正在运行的 Butler 的单实例锁挡掉（任务 16 的隔离启动依赖这一点）。

按计划 1 的 Ruling R2，IPC 注册和 `index.ts` 不写单元测试；只加一个白名单一致性测试，任务 16 做启动冒烟，界面行为由“手动验证”覆盖。

**Files:**
- Modify: `src/shared/ipc.ts`
- Create: `src/shared/ipc.test.ts`
- Modify: `src/main/ipc/register.ts`
- Modify: `src/main/index.ts`
- Create: `src/main/strings.ts`
- Modify: `src/renderer/src/api.ts`

**Interfaces:**
- Consumes: 任务 1–12 的全部模块
- Produces:
  - IPC 通道：`briefsLatest(kind) → BriefView`、`briefsRegenerate()`、`briefsMark(key, mark)`、`followupsList(ticketKey) → Followup[]`、`followupsSetStatus(id, status)`、`handoffsList(ticketKey) → HandoffRecord[]`、`handoffsRun(ticketKey) → HandoffOutcome`、`jobsRunNightly()`、`settingsGet() → EditableSettings`、`settingsSet(key, value)`、`settingsReset(key)`、`settingsDetectTrackerTools() → McpProbe`；主进程 → 渲染进程事件 `appNavigate({ page: "home" })`
  - 渲染进程 `api`：`briefLatest`、`regenerateBrief`、`markBriefItem`、`followups`、`setFollowupStatus`、`handoffs`、`runHandoff`、`runNightly`、`settings`、`setSetting`、`resetSetting`、`detectTrackerTools`、`onNavigate`
  - `N`（`src/main/strings.ts`）：`eveningTitle`、`eveningBody(n)`

- [ ] **Step 1: 写失败测试**

`src/shared/ipc.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { EVENT_CHANNELS, INVOKE_CHANNELS, IPC, SEND_CHANNELS } from "./ipc";

describe("IPC whitelist", () => {
  it("lists every channel exactly once", () => {
    const listed = [...INVOKE_CHANNELS, ...SEND_CHANNELS, ...EVENT_CHANNELS];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(Object.values(IPC).sort());
  });
});
```

- [ ] **Step 2: 运行测试，确认它现在通过（基线），再加通道**

Run: `pnpm exec vitest run src/shared/ipc.test.ts`
Expected: PASS（计划 1 的 20 个通道都在白名单里）。这个测试是防回归用的：下一步加通道时如果漏了白名单，它会失败。

- [ ] **Step 3: 实现 IPC 契约**

`src/shared/ipc.ts` 改为：

```ts
export const IPC = {
  ticketsList: "tickets:list",
  ticketsCreate: "tickets:create",
  ticketsSetStatus: "tickets:setStatus",
  ticketsArchive: "tickets:archive",
  ticketsSwitchBranch: "tickets:switchBranch",
  sessionsOpen: "sessions:open",
  sessionsUnclaimed: "sessions:unclaimed",
  sessionsClaim: "sessions:claim",
  sessionsDismiss: "sessions:dismiss",
  ptySnapshot: "pty:snapshot",
  ptyKill: "pty:kill",
  ptyWrite: "pty:write",
  ptyResize: "pty:resize",
  ptyData: "pty:data",
  ptyExit: "pty:exit",
  stateChanged: "state:changed",
  healthGet: "health:get",
  healthInstallHooks: "health:installHooks",
  healthUninstallHooks: "health:uninstallHooks",
  dialogPickDir: "dialog:pickDir",
  briefsLatest: "briefs:latest",
  briefsRegenerate: "briefs:regenerate",
  briefsMark: "briefs:mark",
  followupsList: "followups:list",
  followupsSetStatus: "followups:setStatus",
  handoffsList: "handoffs:list",
  handoffsRun: "handoffs:run",
  jobsRunNightly: "jobs:runNightly",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  settingsReset: "settings:reset",
  settingsDetectTrackerTools: "settings:detectTrackerTools",
  appNavigate: "app:navigate",
} as const;

/** 渲染进程 → 主进程，有返回值（ipcRenderer.invoke）。 */
export const INVOKE_CHANNELS: readonly string[] = [
  IPC.ticketsList, IPC.ticketsCreate, IPC.ticketsSetStatus, IPC.ticketsArchive, IPC.ticketsSwitchBranch,
  IPC.sessionsOpen, IPC.sessionsUnclaimed, IPC.sessionsClaim, IPC.sessionsDismiss,
  IPC.ptySnapshot, IPC.ptyKill, IPC.healthGet, IPC.healthInstallHooks, IPC.healthUninstallHooks, IPC.dialogPickDir,
  IPC.briefsLatest, IPC.briefsRegenerate, IPC.briefsMark,
  IPC.followupsList, IPC.followupsSetStatus, IPC.handoffsList, IPC.handoffsRun, IPC.jobsRunNightly,
  IPC.settingsGet, IPC.settingsSet, IPC.settingsReset, IPC.settingsDetectTrackerTools,
];
/** 渲染进程 → 主进程，单向高频（键盘输入、尺寸变化）。 */
export const SEND_CHANNELS: readonly string[] = [IPC.ptyWrite, IPC.ptyResize];
/** 主进程 → 渲染进程。 */
export const EVENT_CHANNELS: readonly string[] = [IPC.ptyData, IPC.ptyExit, IPC.stateChanged, IPC.appNavigate];

export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
```

`src/preload/index.ts` 不用改：它按这三个列表放行。

- [ ] **Step 4: 注册处理器**

`src/main/ipc/register.ts` 改为：

```ts
import { dialog, ipcMain, type BrowserWindow } from "electron";
import { ITEM_MARKS, type BriefKind, type BriefView, type ItemMark } from "../../shared/brief";
import { IPC } from "../../shared/ipc";
import { EDITABLE_SETTINGS, isEditableSetting, type EditableSettings } from "../../shared/settings";
import {
  FOLLOWUP_STATUSES, type CreateTicketInput, type FollowupStatus, type McpProbe, type OpenSessionRequest, type TicketStatus,
} from "../../shared/types";
import type { BriefService } from "../brief/brief-service";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { HandoffRunner } from "../handoff/runner";
import type { HealthService } from "../hooks/health";
import { addDays, localDate } from "../schedule/calendar";
import type { Scheduler } from "../schedule/scheduler";
import type { PtyManager } from "../sessions/pty-manager";
import type { SessionService } from "../sessions/session-service";
import { normalizeSetting, SettingError } from "../settings/settings-values";
import { TicketError, type TicketService } from "../tickets/ticket-service";
import { toIpcResult } from "./result";

export interface IpcDeps {
  tickets: TicketsRepo;
  ticketService: TicketService;
  sessionService: SessionService;
  pty: PtyManager;
  health: HealthService;
  followups: FollowupsRepo;
  handoffs: HandoffsRepo;
  settings: SettingsRepo;
  briefService: BriefService;
  runner: HandoffRunner;
  scheduler: Scheduler;
  /** 早间刷新进行中。 */
  briefRefreshing: () => boolean;
  /** followup 状态变化后重新推导 ticket 状态。 */
  rederive: (ticketKey: string) => void;
  detectTrackerTools: () => Promise<McpProbe>;
  window: () => BrowserWindow | null;
  now: () => number;
  notify: () => void;
}

export function registerIpc(d: IpcDeps): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (channel: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(channel, (_e, ...args: unknown[]) => toIpcResult(() => fn(...args)));

  handle(IPC.ticketsList, () => d.sessionService.ticketViews());
  handle(IPC.ticketsCreate, async (input: CreateTicketInput) => {
    const t = await d.ticketService.create(input);
    d.notify();
    return t;
  });
  handle(IPC.ticketsSetStatus, (key: string, status: TicketStatus | null) => {
    d.tickets.setStatusManual(key, status, d.now());
    d.notify();
  });
  handle(IPC.ticketsArchive, (key: string) => {
    d.tickets.archive(key, d.now());
    d.notify();
  });
  handle(IPC.ticketsSwitchBranch, async (key: string) => {
    const t = d.tickets.get(key);
    if (!t) throw new TicketError("not_found", `找不到 ticket ${key}`);
    await d.ticketService.switchBranch(t);
  });

  handle(IPC.sessionsOpen, async (req: OpenSessionRequest) => {
    const r = await d.sessionService.open(req);
    d.notify();
    return r;
  });
  handle(IPC.sessionsUnclaimed, () => d.sessionService.unclaimed());
  handle(IPC.sessionsClaim, (id: string, key: string) => {
    d.sessionService.claim(id, key);
    d.notify();
  });
  handle(IPC.sessionsDismiss, (id: string) => {
    d.sessionService.dismiss(id);
    d.notify();
  });

  handle(IPC.ptySnapshot, (id: string) => d.pty.snapshot(id));
  handle(IPC.ptyKill, (id: string) => d.pty.kill(id));
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => d.pty.write(id, data));
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => d.pty.resize(id, cols, rows));

  handle(IPC.healthGet, () => d.health.refresh());
  handle(IPC.healthInstallHooks, () => d.health.installHooks());
  handle(IPC.healthUninstallHooks, () => d.health.uninstallHooks());

  handle(IPC.dialogPickDir, async () => {
    const w = d.window();
    const options = { properties: ["openDirectory" as const] };
    const r = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  handle(IPC.briefsLatest, (kind: BriefKind): BriefView => ({
    brief: d.briefService.latest(kind === "evening" ? "evening" : "morning"),
    refreshing: d.briefRefreshing(),
  }));
  handle(IPC.briefsRegenerate, async () => {
    await d.scheduler.runMorningNow();
    d.notify();
  });
  handle(IPC.briefsMark, (key: string, mark: ItemMark) => {
    if (!(ITEM_MARKS as readonly string[]).includes(mark)) throw new Error(`unknown mark: ${String(mark)}`);
    d.briefService.mark(String(key), mark);
    d.notify();
  });

  handle(IPC.followupsList, (ticketKey: string) => d.followups.listByTicket(ticketKey));
  handle(IPC.followupsSetStatus, (id: string, status: FollowupStatus) => {
    if (!(FOLLOWUP_STATUSES as readonly string[]).includes(status)) throw new Error(`unknown followup status: ${String(status)}`);
    const f = d.followups.get(id);
    if (!f) throw new TicketError("not_found", "找不到这条 follow-up");
    const now = d.now();
    d.followups.setStatus(id, status, now, status === "snoozed" ? addDays(localDate(now), 1) : null);
    d.rederive(f.ticketKey);
    d.notify();
  });

  handle(IPC.handoffsList, (ticketKey: string) => d.handoffs.listByTicket(ticketKey));
  handle(IPC.handoffsRun, async (ticketKey: string) => {
    const outcome = await d.runner.runManual(ticketKey);
    d.notify();
    return outcome;
  });
  handle(IPC.jobsRunNightly, async () => {
    await d.scheduler.runNightlyNow();
    d.notify();
  });

  handle(IPC.settingsGet, (): EditableSettings => Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, d.settings.get(k)])) as EditableSettings);
  handle(IPC.settingsSet, (key: string, value: unknown) => {
    if (!isEditableSetting(key)) throw new SettingError(`这个设置不能在这里修改：${key}`);
    d.settings.set(key, normalizeSetting(key, String(value ?? "")));
    d.notify();
  });
  handle(IPC.settingsReset, (key: string) => {
    if (!isEditableSetting(key)) throw new SettingError(`这个设置不能在这里修改：${key}`);
    d.settings.reset(key);
    d.notify();
  });
  handle(IPC.settingsDetectTrackerTools, () => d.detectTrackerTools());
}
```

`src/main/strings.ts`：

```ts
/** 主进程里给用户看的文案（系统通知）。渲染进程的文案在 src/renderer/src/strings.ts。 */
export const N = {
  eveningTitle: "Butler 晚间小结",
  eveningBody: (n: number) => (n > 0 ? `${n} 个 ticket 今天有进展，点开查看。` : "今天没有新的 handoff。"),
};
```

- [ ] **Step 5: 组装主进程**

`src/main/index.ts` 改为（包含任务 2、3 的修改）：

```ts
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, powerMonitor, Tray } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Brief } from "../shared/brief";
import { IPC } from "../shared/ipc";
import { BriefService } from "./brief/brief-service";
import { runHeadless } from "./claude/headless";
import { probeMcpTools } from "./claude/mcp-probe";
import { headlessEnv } from "./claude/spawn";
import { BriefsRepo } from "./db/briefs-repo";
import { openDatabase } from "./db/database";
import { FollowupsRepo } from "./db/followups-repo";
import { HandoffsRepo } from "./db/handoffs-repo";
import { JobsRepo } from "./db/jobs-repo";
import { MarksRepo } from "./db/marks-repo";
import { SessionsRepo } from "./db/sessions-repo";
import { SettingsRepo } from "./db/settings-repo";
import { TicketsRepo } from "./db/tickets-repo";
import { captureCommandHandoff, stopFromEnvelope } from "./handoff/capture";
import { ingestHandoff, rederiveTicketStatus, type IngestInput } from "./handoff/ingest";
import { HandoffRunner } from "./handoff/runner";
import { HealthService } from "./hooks/health";
import { applyHookEnvelope } from "./hooks/hook-events";
import { HookInbox } from "./hooks/inbox";
import { registerIpc } from "./ipc/register";
import { createFileLogger, type Logger } from "./logger";
import { ensureDirs, resolvePaths } from "./paths";
import { canSend } from "./safe-send";
import { isWorkingDay, localDate } from "./schedule/calendar";
import { morningJob, nightlyJob, type DailyJobDeps } from "./schedule/daily-jobs";
import { Scheduler, TICK_MS } from "./schedule/scheduler";
import { findTranscript, needsDiscovery, scanClaudeProjects, syncDiscovered, UNCLAIMED_WINDOW_MS } from "./sessions/discovery";
import { PtyManager } from "./sessions/pty-manager";
import { nodePtyFactory } from "./sessions/pty-node";
import { SessionService } from "./sessions/session-service";
import { scheduleConfig } from "./settings/settings-values";
import { runSmoke } from "./smoke";
import { N } from "./strings";
import { TicketService } from "./tickets/ticket-service";
import { circleBitmap } from "./tray-bitmap";

const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;
/** hook 发现缺信息的 session 后，稍等片刻再扫描磁盘（合并连续事件）。 */
const HOOK_DISCOVERY_DEBOUNCE_MS = 3000;
/** 系统空闲超过这么多秒就不算“正在用电脑”（用于 tick 触发早间简报）。 */
const ACTIVE_IDLE_SECONDS = 120;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 保留最近一条通知的引用，否则它可能在用户点击前被回收。 */
let lastNotification: Notification | null = null;
let quitting = false;
let logger: Logger = () => undefined;
/** bootstrap 赋值：退出前在窗口还活着时先结束所有终端进程。 */
let shutdownSessions: () => void = () => undefined;

// 隔离运行（BUTLER_HOME 指向别的目录）时也换一个 Electron 用户目录，否则单实例锁会和正在用的 Butler 冲突。
const isolatedHome = process.env.BUTLER_HOME?.trim();
if (isolatedHome) app.setPath("userData", join(isolatedHome, "electron"));

function safeSend(channel: string, ...args: unknown[]): void {
  if (win && canSend(win)) win.webContents.send(channel, ...args);
}

function bundledHookPath(): string {
  const name = process.platform === "win32" ? "butler-hook.exe" : "butler-hook";
  return app.isPackaged ? join(process.resourcesPath, "hook", name) : join(app.getAppPath(), "build", "hook", name);
}

/** dev 模式下的渲染器地址；打包后永远不用环境变量。 */
function devRendererUrl(): string | null {
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null;
}

function isOwnUrl(url: string): boolean {
  const dev = devRendererUrl();
  try {
    if (dev) return new URL(url).origin === new URL(dev).origin;
    return url === pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "Butler",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.on("ready-to-show", () => w.show());
  w.on("closed", () => {
    if (win === w) win = null;
  });
  // 关窗口只是藏到托盘，终端进程继续运行。
  w.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  // 拖入文件等导航不能替换界面（否则 preload 桥会暴露给任意页面）；也不允许新开窗口。
  w.webContents.on("will-navigate", (e, url) => {
    if (!isOwnUrl(url)) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const dev = devRendererUrl();
  const loaded = dev ? w.loadURL(dev) : w.loadFile(join(__dirname, "../renderer/index.html"));
  loaded.catch((e: unknown) => logger("renderer load failed", e));
  return w;
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray(): Tray {
  const isMac = process.platform === "darwin";
  const icon = nativeImage.createFromBitmap(circleBitmap(16, isMac ? [0, 0, 0] : [0xdf, 0x6f, 0x2f]), { width: 16, height: 16 });
  if (isMac) icon.setTemplateImage(true);
  const t = new Tray(icon);
  t.setToolTip("Butler");
  t.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 Butler", click: showWindow },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  t.on("click", showWindow);
  return t;
}

function showEveningNotification(brief: Brief): void {
  if (!Notification.isSupported()) return;
  lastNotification?.close();
  const n = new Notification({ title: N.eveningTitle, body: N.eveningBody(brief.evening.length) });
  n.on("click", () => {
    showWindow();
    safeSend(IPC.appNavigate, { page: "home" });
  });
  n.show();
  lastNotification = n;
}

async function bootstrap(): Promise<void> {
  const paths = resolvePaths();
  await ensureDirs(paths);
  logger = createFileLogger(join(paths.logs, "main.log"), undefined, app.isPackaged ? undefined : (line) => console.error(line));
  const db = openDatabase(paths.db);
  const tickets = new TicketsRepo(db);
  const sessions = new SessionsRepo(db);
  const settings = new SettingsRepo(db);
  const handoffs = new HandoffsRepo(db);
  const followups = new FollowupsRepo(db);
  const jobs = new JobsRepo(db);
  const ticketService = new TicketService({ tickets, settings, now: Date.now });
  const health = new HealthService({ paths, platform: process.platform, env: process.env, settings, bundledHookBin: bundledHookPath() });
  const notify = () => safeSend(IPC.stateChanged);
  // 健康探测可能很慢（登录 shell、claude --version）：后台进行，窗口先出来。
  const healthReady: Promise<void> = health.refresh().then(
    () => notify(),
    (e: unknown) => {
      logger("initial health refresh failed", e);
    },
  );
  const pty = new PtyManager(nodePtyFactory, {
    data: (id, data) => safeSend(IPC.ptyData, id, data),
    exit: (id, code) => {
      safeSend(IPC.ptyExit, id, code);
      try {
        sessionService.handleExit(id);
      } catch (e) {
        logger("handleExit failed", e);
      }
      notify();
    },
  }, Date.now, logger);
  const sessionService = new SessionService({
    tickets, sessions, settings, ticketService, pty,
    ready: () => healthReady,
    transcriptExists: (id) => findTranscript(paths.claudeProjects, id) !== null,
    claude: () => health.claude(),
    newId: randomUUID,
    now: Date.now,
    platform: process.platform,
    baseEnv: process.env,
    log: logger,
  });

  const transcriptMtime = (id: string): number | null => {
    const file = findTranscript(paths.claudeProjects, id);
    if (!file) return null;
    try {
      return statSync(file).mtimeMs;
    } catch {
      return null;
    }
  };
  const ingest = (input: IngestInput) =>
    ingestHandoff({ db, tickets, handoffs, followups, now: Date.now, newFollowupId: () => `f_${randomBytes(4).toString("hex")}` }, input);
  const runner = new HandoffRunner({
    tickets, sessions, handoffs, followups, settings, ingest,
    workDir: (t) => ticketService.workDir(t),
    run: runHeadless,
    ready: () => healthReady,
    claude: () => health.claude(),
    baseEnv: process.env,
    transcriptMtime,
    now: Date.now,
    newRunId: randomUUID,
    log: logger,
  });
  const briefService = new BriefService({
    tickets, sessions, handoffs, followups, marks: new MarksRepo(db), briefs: new BriefsRepo(db), settings,
    now: Date.now, unclaimedCount: () => sessionService.unclaimed().length,
  });

  let briefRefreshing = false;
  const dailyDeps: DailyJobDeps = {
    runner,
    briefs: briefService,
    jobs,
    now: Date.now,
    isWorkingDay: () => isWorkingDay(localDate(Date.now()), scheduleConfig(settings).workingDays),
    setRefreshing: (v) => {
      briefRefreshing = v;
      notify();
    },
    onEvening: (brief) => {
      notify();
      showEveningNotification(brief);
    },
  };
  const scheduler = new Scheduler({
    jobs,
    config: () => scheduleConfig(settings),
    now: Date.now,
    userActive: () => powerMonitor.getSystemIdleTime() < ACTIVE_IDLE_SECONDS,
    nightly: () => nightlyJob(dailyDeps),
    morning: () => morningJob(dailyDeps),
    onChange: notify,
    log: logger,
  });

  const detectTrackerTools = async () => {
    await healthReady;
    const { path, pathValue } = health.claude();
    if (!path) throw new Error("找不到 claude 命令，请先在“环境检查”里确认 claude 路径");
    // MCP 可以按项目配置：有 ticket 时在第一个 ticket 的目录里探测。
    const first = tickets.list()[0];
    return probeMcpTools({
      claudePath: path,
      cwd: first ? ticketService.workDir(first) : homedir(),
      env: headlessEnv(process.env, { pathValue, runId: randomUUID() }),
    });
  };

  const runDiscovery = async () => {
    try {
      syncDiscovered(await scanClaudeProjects(paths.claudeProjects, Date.now() - UNCLAIMED_WINDOW_MS), sessions, Date.now());
      notify();
    } catch (e) {
      logger("discovery failed", e);
    }
  };

  const discoveryRequested = new Set<string>();
  let hookDiscoveryTimer: NodeJS.Timeout | null = null;
  const scheduleDiscovery = () => {
    if (hookDiscoveryTimer) return;
    hookDiscoveryTimer = setTimeout(() => {
      hookDiscoveryTimer = null;
      void runDiscovery();
    }, HOOK_DISCOVERY_DEBOUNCE_MS);
  };

  const inbox = new HookInbox({
    dir: paths.inbox,
    badDir: paths.inboxBad,
    log: (m) => logger(m),
    handle: (env) => {
      const effect = applyHookEnvelope(env, { sessions, tickets });
      // Stop 之后看这一轮有没有 /handoff 的输出（异步；失败只记日志，不影响 hook 处理）。
      const stop = stopFromEnvelope(env);
      if (stop) {
        void captureCommandHandoff({ sessions, tickets, ingest }, stop).then(
          (r) => {
            if (r?.stored) notify();
          },
          (e: unknown) => logger("capture /handoff failed", e),
        );
      }
      if (effect.kind === "ignored") return;
      notify();
      // 还没归属 ticket、又缺 cwd / 分支 / 首条提示的 session：触发一次发现（每个 session 每次运行最多一次）。
      if (effect.kind !== "nested") {
        const s = sessions.get(effect.sessionId);
        if (s && needsDiscovery(s, discoveryRequested)) {
          discoveryRequested.add(s.id);
          scheduleDiscovery();
        }
      }
    },
  });

  shutdownSessions = () => pty.killAll();

  registerIpc({
    tickets, ticketService, sessionService, pty, health, followups, handoffs, settings, briefService, runner, scheduler,
    briefRefreshing: () => briefRefreshing,
    rederive: (key) => {
      rederiveTicketStatus({ tickets, handoffs, followups, now: Date.now }, key);
    },
    detectTrackerTools,
    window: () => win,
    now: Date.now,
    notify,
  });

  win = createWindow();
  tray = createTray();
  inbox.start();
  void runDiscovery();
  const discoveryTimer = setInterval(() => void runDiscovery(), DISCOVERY_INTERVAL_MS);

  // 调度：启动（health 探测完成后）、唤醒、解锁时检查到期任务；每分钟 tick，覆盖 16:00 和整晚没锁屏的情况。
  void healthReady.then(() => scheduler.check("startup"));
  powerMonitor.on("resume", () => void scheduler.check("resume"));
  powerMonitor.on("unlock-screen", () => void scheduler.check("unlock"));
  const scheduleTimer = setInterval(() => void scheduler.check("tick"), TICK_MS);

  app.on("will-quit", () => {
    clearInterval(discoveryTimer);
    clearInterval(scheduleTimer);
    if (hookDiscoveryTimer) clearTimeout(hookDiscoveryTimer);
    inbox.stop();
    pty.killAll();
    tray?.destroy();
    db.close();
  });
}

process.on("uncaughtException", (e) => logger("uncaughtException", e));
process.on("unhandledRejection", (e) => logger("unhandledRejection", e));

if (process.argv.includes("--smoke")) {
  void runSmoke()
    .then((code) => app.exit(code))
    .catch(() => app.exit(1));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
    shutdownSessions();
  });
  // 常驻托盘：窗口全部关闭也不退出。
  app.on("window-all-closed", () => undefined);
  void app
    .whenReady()
    .then(bootstrap)
    .catch((e: unknown) => {
      dialog.showErrorBox("Butler 启动失败", e instanceof Error ? (e.stack ?? e.message) : String(e));
      app.exit(1);
    });
}
```

- [ ] **Step 6: 渲染进程 API**

`src/renderer/src/api.ts` 的 import 改为：

```ts
import type { BriefKind, BriefView, ItemMark } from "../../shared/brief";
import { IPC, type IpcResult } from "../../shared/ipc";
import type { EditableSettingKey, EditableSettings } from "../../shared/settings";
import type {
  CreateTicketInput, Followup, FollowupStatus, HandoffOutcome, HandoffRecord, HealthReport, McpProbe, OpenSessionRequest,
  OpenSessionResult, Ticket, TicketStatus, TicketView, UnclaimedSession,
} from "../../shared/types";
```

并在 `api` 对象里 `onStateChanged` 之前追加：

```ts
  briefLatest: (kind: BriefKind) => call<BriefView>(IPC.briefsLatest, kind),
  regenerateBrief: () => call<void>(IPC.briefsRegenerate),
  markBriefItem: (key: string, mark: ItemMark) => call<void>(IPC.briefsMark, key, mark),
  followups: (ticketKey: string) => call<Followup[]>(IPC.followupsList, ticketKey),
  setFollowupStatus: (id: string, status: FollowupStatus) => call<void>(IPC.followupsSetStatus, id, status),
  handoffs: (ticketKey: string) => call<HandoffRecord[]>(IPC.handoffsList, ticketKey),
  runHandoff: (ticketKey: string) => call<HandoffOutcome>(IPC.handoffsRun, ticketKey),
  runNightly: () => call<void>(IPC.jobsRunNightly),
  settings: () => call<EditableSettings>(IPC.settingsGet),
  setSetting: (key: EditableSettingKey, value: string) => call<void>(IPC.settingsSet, key, value),
  resetSetting: (key: EditableSettingKey) => call<void>(IPC.settingsReset, key),
  detectTrackerTools: () => call<McpProbe>(IPC.settingsDetectTrackerTools),
  onNavigate: (cb: (route: { page: "home" }) => void) => window.butler.on(IPC.appNavigate, cb),
```

- [ ] **Step 7: 检查**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm exec electron out/main/index.js --smoke`
Expected: 全部通过；`ipc.test.ts` PASS（33 个通道各出现一次）；冒烟仍输出 `sqlite-ok 1` 和 `pty-ok`。

- [ ] **Step 8: Commit**

```bash
git add src/shared/ipc.ts src/shared/ipc.test.ts src/main/ipc/register.ts src/main/index.ts src/main/strings.ts src/renderer/src/api.ts
git commit -m "feat: wire handoff runner, brief service and scheduler into the main process with IPC and power events"
```

---

### Task 14: 简报首页

首页从“等你输入的 session”换成简报（设计文档 9 节：今日重点（如果有）→ 先做 → 今天 → 留意 → 上个工作日），另有“晚间小结”标签。条目的“打开”会跳到 ticket 页，恢复最近的 session（没有就新建）并预填一行提示；“完成 / 推迟到明天 / 忽略”作用于 followup 或条目标记。

**Files:**
- Create: `src/renderer/src/brief-view.ts`, `src/renderer/src/brief-view.test.ts`
- Create: `src/renderer/src/components/BriefPage.tsx`
- Delete: `src/renderer/src/components/HomePage.tsx`
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/components/TicketPage.tsx`
- Modify: `src/renderer/src/strings.ts`, `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: 任务 13 的 `api.briefLatest` / `regenerateBrief` / `markBriefItem` / `setFollowupStatus` / `onNavigate`；`BriefItem` 等（任务 5）
- Produces:
  - `SECTION_ORDER`、`groupItems(items)`、`itemTitle(item)`、`itemPrefill(item): string | null`、`ItemAction = "open" | "done" | "snooze" | "ignore" | "claim"`、`itemActions(item)`、`openRequest(item, ticket): OpenSessionRequest | null`
  - `TicketPage` 新 props：`initialOpen?: OpenSessionRequest | null`、`onInitialOpenDone?: () => void`

- [ ] **Step 1: 写失败测试**

`src/renderer/src/brief-view.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { BriefItem, BriefRule } from "../../shared/brief";
import type { SessionView, TicketView } from "../../shared/types";
import { groupItems, itemActions, itemPrefill, itemTitle, openRequest } from "./brief-view";

const item = (rule: BriefRule, over: Partial<BriefItem> = {}): BriefItem => ({
  key: `${rule}:A-1`, section: "first", rule, ticketKey: "A-1", followupId: null, text: "改 staging 配置",
  days: 3, count: 2, pr: { number: 7, url: "u" }, dueDate: null, ...over,
});
const RULES: BriefRule[] = [
  "pr_approved", "pr_changes_requested", "followup_after_merge", "followup_due", "next_step", "blocked_long", "review_waiting", "stale", "unclaimed",
];
const session = (id: string): SessionView => ({
  id, ticketKey: "A-1", cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: null, lastActivityAt: 1,
  waitingForInput: false, replacedBy: null, dismissed: false, createdAt: 1, termId: null,
});
const ticket = (sessions: SessionView[]): TicketView => ({
  key: "A-1", title: null, repoPath: "/r", workMode: "branch", worktreePath: null, branch: "b", status: "active",
  statusManual: null, createdAt: 1, archivedAt: null, effectiveStatus: "active", sessions, waiting: false,
});

describe("brief view helpers", () => {
  it("groups items by section in display order and drops empty sections", () => {
    const groups = groupItems([item("stale", { section: "watch" }), item("pr_approved"), item("next_step", { section: "today" })]);
    expect(groups.map((g) => g.section)).toEqual(["first", "today", "watch"]);
    expect(groupItems([item("stale", { section: "watch" })]).map((g) => g.section)).toEqual(["watch"]);
  });

  it("has a title for every rule and a prefill naming the ticket for every openable one", () => {
    for (const rule of RULES) {
      expect(itemTitle(item(rule)).length).toBeGreaterThan(0);
      const prefill = itemPrefill(item(rule));
      if (rule === "unclaimed") expect(prefill).toBeNull();
      else expect(prefill).toContain("A-1");
    }
    expect(itemTitle(item("followup_due", { days: 0, text: "开开关" }))).toBe("今天到期：开开关");
    expect(itemTitle(item("pr_approved"))).toContain("#7");
  });

  it("offers claim for unclaimed sessions and the four actions otherwise", () => {
    expect(itemActions(item("unclaimed"))).toEqual(["claim"]);
    expect(itemActions(item("next_step"))).toEqual(["open", "done", "snooze", "ignore"]);
  });

  it("opens the most recent session with the prefill, or a new one when there is none", () => {
    expect(openRequest(item("next_step"), ticket([session("s2"), session("s1")]))).toEqual({
      ticketKey: "A-1", sessionId: "s2", prefill: "继续：改 staging 配置（来自 A-1）",
    });
    expect(openRequest(item("next_step"), ticket([]))).toEqual({ ticketKey: "A-1", prefill: "继续：改 staging 配置（来自 A-1）" });
    expect(openRequest(item("unclaimed", { ticketKey: null }), undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/renderer/src/brief-view.test.ts`
Expected: FAIL（`./brief-view` 不存在）。

- [ ] **Step 3: 文案**

`src/renderer/src/strings.ts`：

1. 顶部 import 改为：

```ts
import type { BriefItem, BriefRule, BriefSection } from "../../shared/brief";
import type { TicketStatus } from "../../shared/types";
```

2. `S` 里 `home: "首页",` 改为 `home: "简报",`；删掉不再使用的 `waitingList` 和 `nothingWaiting` 两项。
3. 在 `S` 的 `loading` 后面追加：

```ts
  morningBrief: "早间简报",
  eveningBrief: "晚间小结",
  briefRefreshing: "刷新中…",
  regenerate: "重新生成",
  noBrief: "还没有简报。点“重新生成”马上生成一份。",
  noEvening: "还没有晚间小结。晚间 handoff 跑完后会自动生成。",
  briefEmpty: "今天没有需要处理的事项。",
  todayFocus: "今日重点",
  previousDay: (date: string) => `上个工作日（${date}）`,
  previousDayEmpty: "上个工作日没有记录。",
  briefSections: { first: "🔴 先做", today: "🟡 今天", watch: "⚪ 留意" } as Record<BriefSection, string>,
  briefRule: {
    pr_approved: (i: BriefItem) => `PR #${i.pr?.number ?? "?"} 已经 approve，可以合并了`,
    pr_changes_requested: (i: BriefItem) => `PR #${i.pr?.number ?? "?"} 被要求修改`,
    followup_after_merge: (i: BriefItem) => `合并后任务：${i.text ?? ""}`,
    followup_due: (i: BriefItem) => (i.days ? `已逾期 ${i.days} 天：${i.text ?? ""}` : `今天到期：${i.text ?? ""}`),
    next_step: (i: BriefItem) => `下一步：${i.text ?? ""}`,
    blocked_long: (i: BriefItem) => `已经阻塞 ${i.days ?? 0} 天${i.text ? `：${i.text}` : ""}`,
    review_waiting: (i: BriefItem) => `PR 等 review 已经 ${i.days ?? 0} 天`,
    stale: (i: BriefItem) => `${i.days ?? 0} 天没有活动`,
    unclaimed: (i: BriefItem) => `${i.count ?? 0} 个未认领的 session`,
  } as Record<BriefRule, (i: BriefItem) => string>,
  /** “打开”时预填到 claude 输入框的一行话（主进程还会再去掉换行）。 */
  briefPrefill: {
    pr_approved: (i: BriefItem) => `PR #${i.pr?.number ?? ""} 已经 approve 了，检查一下 CI 然后合并（来自 ${i.ticketKey}）`,
    pr_changes_requested: (i: BriefItem) => `处理 PR #${i.pr?.number ?? ""} 的 review 意见（来自 ${i.ticketKey}）`,
    followup_after_merge: (i: BriefItem) => `继续 follow-up：${i.text ?? ""}（来自 ${i.ticketKey}）`,
    followup_due: (i: BriefItem) => `继续 follow-up：${i.text ?? ""}（来自 ${i.ticketKey}）`,
    next_step: (i: BriefItem) => `继续：${i.text ?? ""}（来自 ${i.ticketKey}）`,
    blocked_long: (i: BriefItem) => `看看 ${i.ticketKey} 的阻塞现在解决了没有`,
    review_waiting: (i: BriefItem) => `${i.ticketKey} 的 PR 等 review 好几天了，看下要不要催一下`,
    stale: (i: BriefItem) => `回顾一下 ${i.ticketKey} 的进度，接下来做什么`,
  } as Partial<Record<BriefRule, (i: BriefItem) => string>>,
  itemActions: { open: "打开", done: "完成", snooze: "推迟到明天", ignore: "忽略", claim: "去认领" } as Record<string, string>,
  noticeDegraded: (keys: string[]) => `handoff 不完整：${keys.join("、")}`,
  noticeTracker: (keys: string[]) => `没有读到 tracker 信息：${keys.join("、")}（tracker MCP 不可用或没有配置）`,
  eveningBlockers: "阻塞：",
  eveningNext: "明天第一步：",
  eveningDegraded: "handoff 不完整",
  eveningNothingDone: "没有记录完成的事。",
```

- [ ] **Step 4: 实现 brief-view**

`src/renderer/src/brief-view.ts`：

```ts
import type { BriefItem, BriefSection } from "../../shared/brief";
import type { OpenSessionRequest, TicketView } from "../../shared/types";
import { S } from "./strings";

export const SECTION_ORDER: BriefSection[] = ["first", "today", "watch"];

export type ItemAction = "open" | "done" | "snooze" | "ignore" | "claim";

export function groupItems(items: BriefItem[]): { section: BriefSection; items: BriefItem[] }[] {
  return SECTION_ORDER.map((section) => ({ section, items: items.filter((i) => i.section === section) })).filter((g) => g.items.length > 0);
}

export function itemTitle(i: BriefItem): string {
  return S.briefRule[i.rule](i);
}

export function itemPrefill(i: BriefItem): string | null {
  const f = S.briefPrefill[i.rule];
  return f ? f(i) : null;
}

export function itemActions(i: BriefItem): ItemAction[] {
  return i.rule === "unclaimed" ? ["claim"] : ["open", "done", "snooze", "ignore"];
}

/** “打开”：恢复这个 ticket 最近的 session（ticket.sessions 已按最近活动排序），没有就新建；并预填提示。 */
export function openRequest(i: BriefItem, ticket: TicketView | undefined): OpenSessionRequest | null {
  if (!i.ticketKey || !ticket) return null;
  const prefill = itemPrefill(i);
  const recent = ticket.sessions[0];
  return { ticketKey: i.ticketKey, ...(recent ? { sessionId: recent.id } : {}), ...(prefill ? { prefill } : {}) };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run src/renderer/src/brief-view.test.ts`
Expected: PASS。

- [ ] **Step 6: 简报页组件**

`src/renderer/src/components/BriefPage.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import type { Brief, BriefItem, BriefKind, BriefView } from "../../../shared/brief";
import type { OpenSessionRequest, TicketView } from "../../../shared/types";
import { api } from "../api";
import { groupItems, itemActions, itemTitle, openRequest, type ItemAction } from "../brief-view";
import { reportError } from "../errors";
import { S } from "../strings";

interface Props {
  tickets: TicketView[];
  onOpenTicket: (key: string, req?: OpenSessionRequest) => void;
  onUnclaimed: () => void;
}

const MARK = { done: "done", snooze: "snoozed", ignore: "ignored" } as const;

export function BriefPage({ tickets, onOpenTicket, onUnclaimed }: Props) {
  const [kind, setKind] = useState<BriefKind>("morning");
  const [view, setView] = useState<BriefView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await api.briefLatest(kind));
    } catch (e) {
      reportError(e);
    }
  }, [kind]);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  async function act(item: BriefItem, action: ItemAction) {
    if (action === "claim") {
      onUnclaimed();
      return;
    }
    if (action === "open") {
      if (item.ticketKey) onOpenTicket(item.ticketKey, openRequest(item, tickets.find((t) => t.key === item.ticketKey)) ?? undefined);
      return;
    }
    try {
      if (item.followupId) await api.setFollowupStatus(item.followupId, MARK[action]);
      else await api.markBriefItem(item.key, MARK[action]);
    } catch (e) {
      reportError(e);
    }
  }

  async function regenerate() {
    setBusy(true);
    try {
      await api.regenerateBrief();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  const brief = view?.brief ?? null;
  return (
    <div className="page brief">
      <header className="brief-header">
        <div className="tabs">
          <button className={kind === "morning" ? "tab active" : "tab"} onClick={() => setKind("morning")}>{S.morningBrief}</button>
          <button className={kind === "evening" ? "tab active" : "tab"} onClick={() => setKind("evening")}>{S.eveningBrief}</button>
        </div>
        {brief && <span className="muted">{brief.date}</span>}
        {view?.refreshing && <span className="muted">{S.briefRefreshing}</span>}
        {kind === "morning" && (
          <button disabled={busy || view?.refreshing === true} onClick={() => void regenerate()}>{S.regenerate}</button>
        )}
      </header>
      {!brief ? (
        <p className="empty">{kind === "morning" ? S.noBrief : S.noEvening}</p>
      ) : kind === "morning" ? (
        <MorningBody brief={brief} onAct={(i, a) => void act(i, a)} onOpenTicket={(key) => onOpenTicket(key)} />
      ) : (
        <EveningBody brief={brief} onOpenTicket={(key) => onOpenTicket(key)} />
      )}
    </div>
  );
}

function Notices({ brief }: { brief: Brief }) {
  const { degraded, trackerUnavailable } = brief.notices;
  return (
    <>
      {degraded.length > 0 && <p className="notice-line">{S.noticeDegraded(degraded)}</p>}
      {trackerUnavailable.length > 0 && <p className="notice-line">{S.noticeTracker(trackerUnavailable)}</p>}
    </>
  );
}

function DoneList({ items }: { items: string[] }) {
  return (
    <ul className="day-list">
      {items.map((d, n) => (
        <li key={n}>{d}</li>
      ))}
    </ul>
  );
}

function MorningBody({ brief, onAct, onOpenTicket }: { brief: Brief; onAct: (i: BriefItem, a: ItemAction) => void; onOpenTicket: (key: string) => void }) {
  const groups = groupItems(brief.items);
  return (
    <>
      {/* 计划 3 的“今日重点”：计划 2 里 narrativeStatus 永远是 off，这一段不会出现。 */}
      {brief.narrativeStatus === "ok" && brief.narrative && (
        <section className="narrative">
          <h3>{S.todayFocus}</h3>
          <p>{brief.narrative}</p>
        </section>
      )}
      <Notices brief={brief} />
      {groups.length === 0 && <p className="empty">{S.briefEmpty}</p>}
      {groups.map((g) => (
        <section key={g.section} className="brief-section">
          <h3>{S.briefSections[g.section]}</h3>
          {g.items.map((i) => (
            <div key={i.key} className="brief-item">
              {i.ticketKey && <button className="chip" onClick={() => onOpenTicket(i.ticketKey!)}>{i.ticketKey}</button>}
              <span className="text">{itemTitle(i)}</span>
              <span className="actions">
                {itemActions(i).map((a) => (
                  <button key={a} className={a === "open" || a === "claim" ? "primary" : ""} onClick={() => onAct(i, a)}>
                    {S.itemActions[a]}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
      {brief.previousDay && (
        <section className="brief-section">
          <h3>{S.previousDay(brief.previousDay.date)}</h3>
          {brief.previousDay.entries.length === 0 && <p className="muted">{S.previousDayEmpty}</p>}
          {brief.previousDay.entries.map((e) => (
            <div key={e.ticketKey}>
              <button className="chip" onClick={() => onOpenTicket(e.ticketKey)}>{e.ticketKey}</button>
              <DoneList items={e.done} />
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function EveningBody({ brief, onOpenTicket }: { brief: Brief; onOpenTicket: (key: string) => void }) {
  return (
    <>
      <Notices brief={brief} />
      {brief.evening.length === 0 && <p className="empty">{S.noEvening}</p>}
      {brief.evening.map((e) => (
        <div key={e.ticketKey} className="evening-entry">
          <button className="chip" onClick={() => onOpenTicket(e.ticketKey)}>{e.ticketKey}</button>
          {e.degraded && <span className="error"> {S.eveningDegraded}</span>}
          {e.done.length > 0 ? <DoneList items={e.done} /> : <p className="muted">{S.eveningNothingDone}</p>}
          {e.blockers.length > 0 && <p>{S.eveningBlockers}{e.blockers.join("；")}</p>}
          {e.next && <p>{S.eveningNext}{e.next}</p>}
        </div>
      ))}
    </>
  );
}
```

删除 `src/renderer/src/components/HomePage.tsx`：

```bash
git rm src/renderer/src/components/HomePage.tsx
```

- [ ] **Step 7: App 与 TicketPage**

`src/renderer/src/App.tsx` 改为：

```tsx
import { useCallback, useEffect, useState } from "react";
import type { OpenSessionRequest, TicketView } from "../../shared/types";
import { api } from "./api";
import { onError, reportError } from "./errors";
import { BriefPage } from "./components/BriefPage";
import { NewTicketDialog } from "./components/NewTicketDialog";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { TicketPage } from "./components/TicketPage";
import { UnclaimedPage } from "./components/UnclaimedPage";
import { S } from "./strings";

export type Route = { page: "home" } | { page: "ticket"; key: string } | { page: "unclaimed" } | { page: "settings" };

export function App() {
  const [route, setRoute] = useState<Route>({ page: "home" });
  const [tickets, setTickets] = useState<TicketView[]>([]);
  const [unclaimedCount, setUnclaimedCount] = useState(0);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 从简报点“打开”时要在 ticket 页上执行的打开请求（执行一次后清空）。 */
  const [pendingOpen, setPendingOpen] = useState<OpenSessionRequest | null>(null);

  useEffect(() => onError(setError), []);
  // 点击晚间小结的系统通知：回到简报。
  useEffect(() => api.onNavigate(() => setRoute({ page: "home" })), []);

  const refresh = useCallback(async () => {
    try {
      const [t, u] = await Promise.all([api.listTickets(), api.unclaimed()]);
      setTickets(t);
      setUnclaimedCount(u.length);
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return api.onStateChanged(() => void refresh());
  }, [refresh]);

  const openTicket = (key: string, req?: OpenSessionRequest) => {
    setPendingOpen(req ?? null);
    setRoute({ page: "ticket", key });
  };

  const current = route.page === "ticket" ? (tickets.find((t) => t.key === route.key) ?? null) : null;

  return (
    <div className="app">
      <Sidebar tickets={tickets} unclaimedCount={unclaimedCount} route={route} onNavigate={setRoute} onNew={() => setShowNew(true)} />
      <main className="main">
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)}>{S.close}</button>
          </div>
        )}
        {route.page === "home" && <BriefPage tickets={tickets} onOpenTicket={openTicket} onUnclaimed={() => setRoute({ page: "unclaimed" })} />}
        {route.page === "ticket" && current && (
          <TicketPage
            key={current.key}
            ticket={current}
            initialOpen={pendingOpen?.ticketKey === current.key ? pendingOpen : null}
            onInitialOpenDone={() => setPendingOpen(null)}
            onArchived={() => setRoute({ page: "home" })}
          />
        )}
        {route.page === "unclaimed" && <UnclaimedPage tickets={tickets} />}
        {route.page === "settings" && <SettingsPage />}
      </main>
      {showNew && (
        <NewTicketDialog
          onClose={() => setShowNew(false)}
          onCreated={(key) => {
            setShowNew(false);
            setRoute({ page: "ticket", key });
            void refresh();
          }}
        />
      )}
    </div>
  );
}
```

`src/renderer/src/components/TicketPage.tsx`：

1. 组件签名改为：

```tsx
interface Props {
  ticket: TicketView;
  onArchived: () => void;
  /** 从简报点“打开”进来时要执行的打开请求。 */
  initialOpen?: OpenSessionRequest | null;
  onInitialOpenDone?: () => void;
}

export function TicketPage({ ticket, onArchived, initialOpen = null, onInitialOpenDone }: Props) {
```

2. 在 `const openKey = ...` 那个 `useEffect` 后面加：

```tsx
  // 从简报点“打开”：恢复 session 并预填提示，只执行一次。
  useEffect(() => {
    if (!initialOpen) return;
    onInitialOpenDone?.();
    void open(initialOpen);
  }, [initialOpen]);
```

（`open` 是组件里用 `async function` 声明的函数，会被提升，可以在这里调用。分支不一致时 `open` 会照常显示“切换分支”提示。）

- [ ] **Step 8: 样式**

`src/renderer/src/styles.css` 末尾追加：

```css
.brief-header { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
.tabs { display: flex; gap: 4px; }
.tab.active { border-color: var(--accent); color: var(--accent); }
.brief-section h3 { margin: 18px 0 8px; font-size: 13px; }
.brief-item { display: flex; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; }
.brief-item .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.brief-item .actions { display: flex; gap: 4px; flex-shrink: 0; }
.chip { font-weight: 600; background: transparent; }
.notice-line { color: var(--muted); margin: 4px 0; }
.narrative { padding: 10px 12px; background: var(--panel); border-radius: 8px; }
.day-list { margin: 4px 0 10px; padding-left: 20px; }
.evening-entry { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 6px; }
.evening-entry p { margin: 4px 0; }
```

- [ ] **Step 9: 检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: 全部通过。

```bash
git add -A src/renderer
git commit -m "feat: brief home page with morning and evening tabs and one-click open with prefill"
```

---

### Task 15: ticket 详情的概览与设置页

ticket 页加一条概览栏：PR 状态、followups（完成 / 推迟 / 忽略 / 恢复）、handoff 历史（degraded 的显示原文）、“立即 handoff”按钮。设置页加“调度与 handoff”：晚间时间、工作日、简报阈值、tracker 工具名（可从 Claude Code 检测）、两个 prompt 模板、“立即运行晚间 handoff”，以及 `/handoff` 命令的安装状态。

**Files:**
- Create: `src/renderer/src/followup-view.ts`, `src/renderer/src/followup-view.test.ts`
- Create: `src/renderer/src/settings-form.ts`, `src/renderer/src/settings-form.test.ts`
- Create: `src/renderer/src/components/TicketOverview.tsx`, `src/renderer/src/components/ScheduleSettings.tsx`
- Modify: `src/renderer/src/components/TicketPage.tsx`, `src/renderer/src/components/SettingsPage.tsx`
- Modify: `src/renderer/src/strings.ts`, `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: 任务 13 的 `api.followups` / `setFollowupStatus` / `handoffs` / `runHandoff` / `runNightly` / `settings` / `setSetting` / `resetSetting` / `detectTrackerTools`；`HealthReport.handoffCommand`（任务 9）
- Produces:
  - `splitFollowups(list)`、`followupMeta(f)`、`outcomeMessage(o)`、`triggerLabel(t)`
  - `WEEK_ORDER`、`hasDay(value, day)`、`toggleDay(value, day)`、`mergeTools(current, picked)`

- [ ] **Step 1: 写失败测试**

`src/renderer/src/followup-view.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Followup } from "../../shared/types";
import { followupMeta, outcomeMessage, splitFollowups, triggerLabel } from "./followup-view";

const f = (id: string, over: Partial<Followup> = {}): Followup => ({
  id, ticketKey: "A-1", kind: "config", description: id, trigger: "after_merge", dueDate: null,
  status: "open", snoozedUntil: null, source: "session", createdAt: 1, doneAt: null, ...over,
});

describe("followup view helpers", () => {
  it("splits active (open, snoozed) from closed (done, ignored)", () => {
    const { active, closed } = splitFollowups([f("a"), f("b", { status: "snoozed" }), f("c", { status: "done" }), f("d", { status: "ignored" })]);
    expect(active.map((x) => x.id)).toEqual(["a", "b"]);
    expect(closed.map((x) => x.id)).toEqual(["c", "d"]);
  });

  it("describes kind, trigger, due date and snooze", () => {
    expect(followupMeta(f("a"))).toBe("配置 · 合并后");
    expect(followupMeta(f("a", { kind: "flag", trigger: "on_date", dueDate: "2026-10-30", status: "snoozed", snoozedUntil: "2026-10-22" }))).toBe(
      "开关 · 到期日 · 2026-10-30 · 推迟到 2026-10-22",
    );
    expect(followupMeta(f("a", { status: "ignored" }))).toBe("配置 · 合并后 · 已忽略");
  });

  it("explains each handoff outcome", () => {
    expect(outcomeMessage({ ticketKey: "A-1", status: "stored", handoffId: 1, degraded: false })).toBe("handoff 已更新。");
    expect(outcomeMessage({ ticketKey: "A-1", status: "stored", handoffId: 1, degraded: true })).toContain("不完整");
    expect(outcomeMessage({ ticketKey: "A-1", status: "skipped", reason: "rate_limited" })).toContain("限流");
    expect(outcomeMessage({ ticketKey: "A-1", status: "failed", reason: "timeout", message: "超过 300 秒没有完成" })).toBe("handoff 失败：超过 300 秒没有完成");
    expect(triggerLabel("command")).toBe("/handoff");
  });
});
```

`src/renderer/src/settings-form.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { hasDay, mergeTools, toggleDay, WEEK_ORDER } from "./settings-form";

describe("settings form helpers", () => {
  it("toggles working days and keeps them sorted", () => {
    expect(toggleDay("1,2,3,4,5", 5)).toBe("1,2,3,4");
    expect(toggleDay("1,2,3,4,5", 0)).toBe("0,1,2,3,4,5");
    expect(toggleDay("", 3)).toBe("3");
    expect(hasDay("1,2", 2)).toBe(true);
    expect(hasDay("", 0)).toBe(false);
    expect(WEEK_ORDER).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it("merges picked tools into the list without duplicates", () => {
    expect(mergeTools("mcp__a__get\n", ["mcp__b__list", "mcp__a__get"])).toBe("mcp__a__get\nmcp__b__list");
    expect(mergeTools("", ["x"])).toBe("x");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run src/renderer/src/followup-view.test.ts src/renderer/src/settings-form.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 文案**

`src/renderer/src/strings.ts`：

1. import 改为：

```ts
import type { BriefItem, BriefRule, BriefSection } from "../../shared/brief";
import type { FollowupKind, FollowupTrigger, HandoffTrigger, TicketStatus } from "../../shared/types";
```

2. `hookExplain` 改为：

```ts
  hookExplain: "Butler 往 Claude Code 的 settings.json 里加 4 个 hook（SessionStart、Stop、UserPromptSubmit、SessionEnd），并在 commands 目录放一个 /handoff 命令。只写本地文件，不联网。你原有的 hook 和命令不受影响。",
```

3. 在 `S` 末尾（任务 14 加的 `eveningNothingDone` 后面）追加：

```ts
  followupsTab: (n: number) => `Follow-ups（${n}）`,
  historyTab: (n: number) => `Handoff 历史（${n}）`,
  runHandoff: "立即 handoff",
  handoffRunning: "handoff 进行中…",
  noFollowups: "没有未完成的 follow-up。",
  closedFollowups: (n: number) => `已完成 / 已忽略（${n}）`,
  reopen: "恢复",
  noHandoffs: "还没有 handoff。点“立即 handoff”，或者在 session 里输入 /handoff。",
  followupKind: { config: "配置", flag: "开关", deploy: "部署", doc: "文档", other: "其他" } as Record<FollowupKind, string>,
  followupTrigger: { after_merge: "合并后", after_deploy: "部署后", on_date: "到期日", none: "随时" } as Record<FollowupTrigger, string>,
  snoozedUntil: (d: string) => `推迟到 ${d}`,
  followupDone: "已完成",
  followupIgnored: "已忽略",
  handoffTrigger: { nightly: "晚间", manual: "手动", command: "/handoff", refresh: "早间刷新" } as Record<HandoffTrigger, string>,
  handoffStored: "handoff 已更新。",
  handoffDegraded: "handoff 不完整：claude 的输出没有通过校验，原文已保存。",
  handoffSkipped: {
    rate_limited: "公司 Claude 额度用完或被限流，稍后再试。",
    no_session: "这个 ticket 还没有可以总结的 session。",
  } as Record<string, string>,
  handoffFailed: (m: string) => `handoff 失败：${m}`,
  degradedBadge: "不完整",
  doneToday: "完成",
  nextSteps: "下一步",
  blockers: "阻塞",
  openQuestions: "待确认",
  prLine: (n: number, state: string, review: string | null) => `PR #${n} · ${state}${review ? ` · ${review}` : ""}`,
  schedule: "调度与 handoff",
  nightlyTime: "晚间 handoff 时间",
  workingDays: "工作日（只在这些天跑晚间 handoff）",
  weekdayNames: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
  thresholds: "简报阈值（天）",
  blockedDays: "阻塞超过",
  reviewWaitDays: "等 review 超过",
  staleDays: "无活动超过",
  trackerTools: "tracker MCP 工具（handoff 只能调用这些，一行一个）",
  trackerHint: "例如 mcp__atlassian__getJiraIssue。只选读取类的工具：handoff 是只读的。",
  detectTools: "从 Claude Code 检测",
  detecting: "检测中…",
  detectedTools: (n: number) => `检测到 ${n} 个 MCP 工具（名字像查询的已默认勾选）：`,
  noDetectedTools: "没有检测到 MCP 工具。",
  addSelected: "加入选中的工具",
  handoffPrompt: "handoff prompt 模板",
  refreshPrompt: "早间刷新 prompt 模板",
  save: "保存",
  resetDefault: "恢复默认",
  runNightlyNow: "立即运行晚间 handoff",
  nightlyRunning: "运行中…",
  handoffCommand: "/handoff 命令",
  handoffCommandStatus: {
    installed: "已安装",
    missing: "未安装",
    stale: "需要更新（点“安装 / 修复”）",
    conflict: "已有同名的 handoff.md，不是 Butler 写的，Butler 不会覆盖",
  } as Record<string, string>,
```

- [ ] **Step 4: 实现小工具**

`src/renderer/src/followup-view.ts`：

```ts
import type { Followup, HandoffOutcome, HandoffTrigger } from "../../shared/types";
import { S } from "./strings";

export function splitFollowups(list: Followup[]): { active: Followup[]; closed: Followup[] } {
  return {
    active: list.filter((f) => f.status === "open" || f.status === "snoozed"),
    closed: list.filter((f) => f.status === "done" || f.status === "ignored"),
  };
}

export function followupMeta(f: Followup): string {
  const parts = [S.followupKind[f.kind], S.followupTrigger[f.trigger]];
  if (f.dueDate) parts.push(f.dueDate);
  if (f.status === "snoozed" && f.snoozedUntil) parts.push(S.snoozedUntil(f.snoozedUntil));
  if (f.status === "done") parts.push(S.followupDone);
  if (f.status === "ignored") parts.push(S.followupIgnored);
  return parts.join(" · ");
}

export function outcomeMessage(o: HandoffOutcome): string {
  if (o.status === "stored") return o.degraded ? S.handoffDegraded : S.handoffStored;
  if (o.status === "skipped") return S.handoffSkipped[o.reason];
  return S.handoffFailed(o.message);
}

export function triggerLabel(t: HandoffTrigger): string {
  return S.handoffTrigger[t];
}
```

`src/renderer/src/settings-form.ts`：

```ts
/** 设置页里星期的显示顺序（周一在前）；数字是 JS getDay()，0 是周日。 */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const parseDays = (value: string): number[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);

export function hasDay(value: string, day: number): boolean {
  return parseDays(value).includes(day);
}

export function toggleDay(value: string, day: number): string {
  const days = new Set(parseDays(value));
  if (days.has(day)) days.delete(day);
  else days.add(day);
  return [...days].sort((a, b) => a - b).join(",");
}

/** 把勾选的工具并进现有列表：一行一个，去重，原有顺序在前。 */
export function mergeTools(current: string, picked: string[]): string {
  const lines = current.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const t of picked) if (!lines.includes(t)) lines.push(t);
  return lines.join("\n");
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm exec vitest run src/renderer/src/followup-view.test.ts src/renderer/src/settings-form.test.ts`
Expected: PASS。

- [ ] **Step 6: ticket 概览**

`src/renderer/src/components/TicketOverview.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import type { Followup, FollowupStatus, HandoffRecord } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { followupMeta, outcomeMessage, splitFollowups, triggerLabel } from "../followup-view";
import { S } from "../strings";

type Panel = "followups" | "history";

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function TicketOverview({ ticketKey }: { ticketKey: string }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [history, setHistory] = useState<HandoffRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [f, h] = await Promise.all([api.followups(ticketKey), api.handoffs(ticketKey)]);
      setFollowups(f);
      setHistory(h);
    } catch (e) {
      reportError(e);
    }
  }, [ticketKey]);

  useEffect(() => {
    void load();
    return api.onStateChanged(() => void load());
  }, [load]);

  async function runNow() {
    setRunning(true);
    setMessage(null);
    try {
      setMessage(outcomeMessage(await api.runHandoff(ticketKey)));
    } catch (e) {
      reportError(e);
    } finally {
      setRunning(false);
    }
  }

  function setStatus(id: string, status: FollowupStatus) {
    api.setFollowupStatus(id, status).catch(reportError);
  }

  const { active, closed } = splitFollowups(followups);
  const pr = history.find((h) => h.payload)?.payload?.pr ?? null;
  const toggle = (p: Panel) => setPanel(panel === p ? null : p);

  return (
    <div className="overview">
      <div className="overview-bar">
        {pr && <span className="muted">{S.prLine(pr.number, pr.state, pr.review)}</span>}
        <button className={panel === "followups" ? "active" : ""} onClick={() => toggle("followups")}>{S.followupsTab(active.length)}</button>
        <button className={panel === "history" ? "active" : ""} onClick={() => toggle("history")}>{S.historyTab(history.length)}</button>
        <button disabled={running} onClick={() => void runNow()}>{running ? S.handoffRunning : S.runHandoff}</button>
        {message && <span className="muted">{message}</span>}
      </div>
      {panel === "followups" && (
        <div className="overview-panel">
          {active.length === 0 && <p className="muted">{S.noFollowups}</p>}
          {active.map((f) => (
            <div key={f.id} className="followup">
              <span className="text">{f.description}</span>
              <span className="muted">{followupMeta(f)}</span>
              <span className="actions">
                <button onClick={() => setStatus(f.id, "done")}>{S.itemActions.done}</button>
                <button onClick={() => setStatus(f.id, "snoozed")}>{S.itemActions.snooze}</button>
                <button onClick={() => setStatus(f.id, "ignored")}>{S.itemActions.ignore}</button>
              </span>
            </div>
          ))}
          {closed.length > 0 && (
            <button className="more" onClick={() => setShowClosed(!showClosed)}>{S.closedFollowups(closed.length)}</button>
          )}
          {showClosed &&
            closed.map((f) => (
              <div key={f.id} className="followup closed">
                <span className="text">{f.description}</span>
                <span className="muted">{followupMeta(f)}</span>
                <span className="actions">
                  <button onClick={() => setStatus(f.id, "open")}>{S.reopen}</button>
                </span>
              </div>
            ))}
        </div>
      )}
      {panel === "history" && (
        <div className="overview-panel">
          {history.length === 0 && <p className="muted">{S.noHandoffs}</p>}
          {history.map((h) => (
            <HandoffEntry key={h.id} h={h} />
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <span className="muted">{title}</span>
      <ul className="day-list">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function HandoffEntry({ h }: { h: HandoffRecord }) {
  const pr = h.payload?.pr ?? null;
  return (
    <div className="handoff-entry">
      <div>
        <strong>{formatTime(h.createdAt)}</strong> <span className="muted">{triggerLabel(h.trigger)}</span>
        {h.degraded && <span className="error"> {S.degradedBadge}</span>}
        {pr && <span className="muted"> · {S.prLine(pr.number, pr.state, pr.review)}</span>}
      </div>
      {h.payload ? (
        <>
          <Section title={S.doneToday} items={h.payload.done_today} />
          <Section title={S.nextSteps} items={h.payload.next_steps} />
          <Section title={S.blockers} items={h.payload.blockers} />
          <Section title={S.openQuestions} items={h.payload.open_questions} />
        </>
      ) : (
        <pre className="raw">{h.rawText ?? ""}</pre>
      )}
    </div>
  );
}
```

`src/renderer/src/components/TicketPage.tsx`：顶部加 `import { TicketOverview } from "./TicketOverview";`，在 `</header>` 之后、`<div className="sessions-bar">` 之前插入：

```tsx
      <TicketOverview ticketKey={ticket.key} />
```

- [ ] **Step 7: 设置页**

`src/renderer/src/components/ScheduleSettings.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import type { EditableSettingKey, EditableSettings } from "../../../shared/settings";
import type { McpProbe } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { hasDay, mergeTools, toggleDay, WEEK_ORDER } from "../settings-form";
import { S } from "../strings";

const THRESHOLDS = ["blockedDays", "reviewWaitDays", "staleDays"] as const;
const PROMPTS = ["handoffPrompt", "refreshPrompt"] as const;

export function ScheduleSettings() {
  const [values, setValues] = useState<EditableSettings | null>(null);
  const [draft, setDraft] = useState<Partial<EditableSettings>>({});
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<McpProbe | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<"detect" | "nightly" | null>(null);

  const load = useCallback(async () => {
    try {
      setValues(await api.settings());
    } catch (e) {
      reportError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!values) return <p className="muted">{S.loading}</p>;
  const current = values;
  const value = (k: EditableSettingKey): string => draft[k] ?? current[k];
  const edit = (k: EditableSettingKey, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const clearDraft = (k: EditableSettingKey) =>
    setDraft((d) => {
      const next = { ...d };
      delete next[k];
      return next;
    });

  async function save(k: EditableSettingKey, v: string = value(k)) {
    setError(null);
    try {
      await api.setSetting(k, v);
      clearDraft(k);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function reset(k: EditableSettingKey) {
    setError(null);
    try {
      await api.resetSetting(k);
      clearDraft(k);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function detect() {
    setBusy("detect");
    setError(null);
    try {
      const p = await api.detectTrackerTools();
      setProbe(p);
      setPicked(p.suggested);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runNightly() {
    setBusy("nightly");
    try {
      await api.runNightly();
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  }

  const togglePick = (t: string) => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t]);

  return (
    <section className="settings-section">
      <h2>{S.schedule}</h2>
      {error && <p className="error">{error}</p>}

      <label className="field">
        {S.nightlyTime}
        <input type="time" value={value("nightlyTime")} onChange={(e) => edit("nightlyTime", e.target.value)} onBlur={() => void save("nightlyTime")} />
      </label>

      <div className="field">
        {S.workingDays}
        <div className="row">
          {WEEK_ORDER.map((day) => (
            <label key={day} className="inline">
              <input type="checkbox" checked={hasDay(current.workingDays, day)} onChange={() => void save("workingDays", toggleDay(current.workingDays, day))} />
              {S.weekdayNames[day]}
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        {S.thresholds}
        <div className="row">
          {THRESHOLDS.map((k) => (
            <label key={k} className="inline">
              {S[k]}
              <input type="number" min={0} max={999} value={value(k)} onChange={(e) => edit(k, e.target.value)} onBlur={() => void save(k)} />
            </label>
          ))}
        </div>
      </div>

      <div className="field">
        {S.trackerTools}
        <textarea rows={4} className="mono" value={value("trackerTools")} onChange={(e) => edit("trackerTools", e.target.value)} />
        <p className="muted">{S.trackerHint}</p>
        <div className="actions">
          <button onClick={() => void save("trackerTools")}>{S.save}</button>
          <button disabled={busy === "detect"} onClick={() => void detect()}>{busy === "detect" ? S.detecting : S.detectTools}</button>
        </div>
        {probe && probe.tools.length === 0 && <p className="muted">{S.noDetectedTools}</p>}
        {probe && probe.tools.length > 0 && (
          <div className="probe">
            <p className="muted">{S.detectedTools(probe.tools.length)}</p>
            {probe.tools.map((t) => (
              <label key={t} className="inline">
                <input type="checkbox" checked={picked.includes(t)} onChange={() => togglePick(t)} />
                <code>{t}</code>
              </label>
            ))}
            <button className="primary" disabled={picked.length === 0} onClick={() => void save("trackerTools", mergeTools(value("trackerTools"), picked))}>
              {S.addSelected}
            </button>
          </div>
        )}
      </div>

      {PROMPTS.map((k) => (
        <div key={k} className="field">
          {S[k]}
          <textarea rows={10} className="mono" value={value(k)} onChange={(e) => edit(k, e.target.value)} />
          <div className="actions">
            <button onClick={() => void save(k)}>{S.save}</button>
            <button onClick={() => void reset(k)}>{S.resetDefault}</button>
          </div>
        </div>
      ))}

      <div className="actions">
        <button disabled={busy === "nightly"} onClick={() => void runNightly()}>{busy === "nightly" ? S.nightlyRunning : S.runNightlyNow}</button>
      </div>
    </section>
  );
}
```

`src/renderer/src/components/SettingsPage.tsx`：

1. 顶部加 `import { ScheduleSettings } from "./ScheduleSettings";`。
2. `<dl className="kv">` 里 hook 那一行后面加：

```tsx
        <dt>{S.handoffCommand}</dt><dd className={report.handoffCommand === "installed" ? "ok" : "error"}>{S.handoffCommandStatus[report.handoffCommand]}</dd>
```

3. 在最外层 `<div className="page">` 的最后（`actions` 那个 div 之后）加 `<ScheduleSettings />`。

- [ ] **Step 8: 样式**

`src/renderer/src/styles.css` 末尾追加：

```css
textarea { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; width: 100%; resize: vertical; }
.mono { font-family: Menlo, Consolas, "Cascadia Mono", monospace; font-size: 12px; }
.overview { border-bottom: 1px solid var(--border); }
.overview-bar { display: flex; gap: 8px; align-items: center; padding: 6px 16px; flex-wrap: wrap; }
.overview-bar .active { border-color: var(--accent); color: var(--accent); }
.overview-panel { max-height: 40vh; overflow-y: auto; padding: 4px 16px 10px; }
.followup { display: flex; gap: 10px; align-items: center; padding: 4px 0; }
.followup .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.followup.closed .text { color: var(--muted); text-decoration: line-through; }
.handoff-entry { padding: 8px 0; border-top: 1px solid var(--border); }
.raw { white-space: pre-wrap; font-size: 12px; background: var(--panel); padding: 8px; border-radius: 6px; }
.settings-section { margin-top: 24px; display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field .row { flex-wrap: wrap; gap: 12px; }
label.inline { display: inline-flex; gap: 6px; align-items: center; }
.probe { display: flex; flex-direction: column; gap: 4px; }
```

- [ ] **Step 9: 检查并提交**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: 全部通过。

```bash
git add -A src/renderer
git commit -m "feat: ticket overview with followups and handoff history, schedule and tracker settings"
```

---

### Task 16: 全量检查、真 claude 冒烟与隔离启动

**Files:**
- Modify: `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md`（记录本计划解决了哪些遗留项）

- [ ] **Step 1: 全量自动检查**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm exec electron out/main/index.js --smoke`
Expected: 全部通过；`headless.live.test.ts` 显示 skipped；冒烟输出 `sqlite-ok 1` 和 `pty-ok`。

- [ ] **Step 2: 真 claude 冒烟（1 次调用）**

验证 `--permission-mode dontAsk` 和 `--json-schema` 能一起用（验证记录里唯一没有实测的组合）。`BUTLER_HOME` 指向临时目录，这样这次运行触发的用户级 butler-hook 只会写进临时 inbox，不会打扰正在运行的 Butler。如果执行者自己就在 Claude Code 里，先去掉外层会话的标记变量：

```bash
T="$(mktemp -d)"
env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SESSION_ATTENDED \
    -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN -u CLAUDE_PID \
    BUTLER_HOME="$T" BUTLER_LIVE_CLAUDE=1 pnpm exec vitest run src/main/claude/headless.live.test.ts
```

Expected: PASS（`structured` 为 `{ gitClean: true, wroteFile: false }`，`live.txt` 不存在）。

如果失败且原因是结构化输出缺失（`structured` 为 null、或 `permissionDenials` 里出现结构化输出工具）：把 `headlessArgs` 和 `PROBE_ARGS` 里的 `"--permission-mode", "dontAsk"` 去掉（只读仍由 `--disallowedTools` + `--allowedTools` 白名单保证，`-p` 下白名单外的工具会被自动拒绝，见验证记录 V2），同步修改 `headless.test.ts`、`runner.test.ts`、`mcp-probe.test.ts` 里的期望参数和 Global Constraints 那一行，重新跑 Step 1 和 Step 2，并在遗留清单里记一条 Ruling。

- [ ] **Step 3: 隔离启动**

用临时的 `BUTLER_HOME` 启动打包后的主进程 20 秒（任务 13 让它使用独立的 Electron 用户目录，不会和正在运行的 Butler 抢单实例锁）。这次启动不会调用 `claude -p`：晚间任务第一次启动只做 seed，早间刷新只针对 in_review / merged 的 ticket，而临时库里没有 ticket。

```bash
T="$(mktemp -d)"
BUTLER_HOME="$T" node -e '
const { spawn } = require("node:child_process");
const c = spawn(require("electron"), ["out/main/index.js"], { env: process.env, stdio: "inherit" });
setTimeout(() => c.kill("SIGTERM"), 20000);
c.on("exit", (code, signal) => console.log("electron exited", code, signal));
'
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
console.log(db.prepare("PRAGMA user_version").get());
console.log(db.prepare("SELECT kind, date, narrative_status FROM briefs").all());
console.log(db.prepare("SELECT name, last_status FROM jobs").all());
' "$T/app.db"
grep -E "uncaughtException|unhandledRejection|failed" "$T/logs/main.log" || echo "no errors logged"
```

Expected：
- 窗口出现约 20 秒后关闭，打印 `electron exited`。
- `user_version` 为 2。
- 本地时间在 05:00 之后时，`briefs` 里有一行 `morning`，`narrative_status` 为 `off`；`jobs` 里 `nightly_handoff` 为 `seeded`，`morning_brief` 为 `ok`。05:00 之前启动时这两张表可以是空的（`MORNING_EARLIEST_HOUR`），换个时间再验。
- 日志里没有错误（打印 `no errors logged`）。

- [ ] **Step 4: 更新计划 1 遗留清单**

在 `docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md` 末尾追加：

```markdown
## Resolved in plan 2
- Task 3 minor: GitError escapes create() unmapped → TicketError("git_failed") with git's own reason (plan 2 Task 1)
- Task 3 minor: user branch name not validated → `git check-ref-format --branch`, expansion and leading "-" rejected (plan 2 Task 1)
- Empty repository → "这个仓库还没有任何提交" (plan 2 Task 1)
- Task 9 minor: prefill with newlines would submit → sanitizePrefill in SessionService.open (plan 2 Task 2)
- Final parked: trailing PTY data after exit clears the exit banner → dropped in PtyManager (plan 2 Task 2)
- Final parked: control chars in dropped filenames → stripControl in quotePath (plan 2 Task 2)
- Final parked: uncaught exceptions only logged to file → logger tees to console in dev (plan 2 Task 2)
- Task 10 minor: orphan session row if spawn throws; empty row when claude exits before the first message (plan 2 Task 3)
- Task 7 minor: origin never upgraded discovered→butler (plan 2 Task 3)
- Final parked: hook-triggered discovery for every ticketless session → only when details are missing, once per session (plan 2 Task 3)
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-19-butler-plan-1-followups.md
git commit -m "docs: record plan 1 follow-ups resolved by plan 2"
```

---

## 手动验证

由用户在合并后、用真实的 Butler 和公司 Claude Code 执行。准备：`pnpm build:hook`，用计划 1 的练习仓库 `~/butler-playground/demo`（有 DEMO-1 ticket 和一个说过几句话的 session）。任何一项不符合就停下来，按 superpowers:systematic-debugging 排查。

1. **安装 /handoff**：设置页点“安装 / 修复” → “/handoff 命令”显示“已安装”，`~/.claude/commands/handoff.md` 存在且含 `butler:handoff-command` 标记。原有的同名文件不会被覆盖（会显示冲突提示）。
2. **配置 tracker 工具**：设置页点“从 Claude Code 检测” → 几秒内列出 MCP 工具，名字像查询的已勾选；点“加入选中的工具” → 文本框里一行一个。
3. **会话内 /handoff**：在 DEMO-1 的终端里输入 `/handoff` → 回答末尾有 `butler-handoff` 代码块；几秒后 ticket 页“Handoff 历史”出现一条“/handoff”记录，followups 出现在“Follow-ups”里；`/handoff` 期间 session 标签正常显示“等你输入”。
4. **立即 handoff**：点“立即 handoff” → 1～3 分钟后提示“handoff 已更新。”，历史里多一条“手动”。同时检查：原 session 的终端里没有新消息（fork 不写原 session）；“未认领 session”没有新增条目；`~/.claude/projects` 下没有新的 jsonl（`--no-session-persistence`）。
5. **只读保证**：临时把 handoff prompt 模板末尾加一句“请创建文件 butler-test.txt”，保存后点“立即 handoff” → 仓库里没有 `butler-test.txt`；然后点“恢复默认”。
6. **晚间批量与通知**：设置页点“立即运行晚间 handoff” → 完成后弹出系统通知“Butler 晚间小结”；点通知 → 窗口到前台并显示简报；“晚间小结”标签列出 DEMO-1 今天做了什么、阻塞和明天第一步。
7. **早间简报**：点“重新生成” → 顶部短暂出现“刷新中…”；“先做 / 今天 / 留意 / 上个工作日”按规则显示；周一时“上个工作日”显示上周五。
8. **打开并预填**：点任意一条的“打开” → 跳到 ticket 页，恢复最近的 session，输入框里预填了一行提示（没有被发送，没有换行）。
9. **完成 / 推迟 / 忽略**：对一个 followup 条目点“完成” → 简报和 ticket 页的 Follow-ups 都更新；对一个非 followup 条目点“推迟到明天” → 消失，第二天重新出现；被忽略的 followup 在下次 handoff 之后也不会回来。
10. **错过补跑**：把晚间时间设成 1 分钟前 → 1 分钟内（每分钟 tick）晚间批量自动运行一次，之后不再重复。
11. **非工作日**：在“工作日”里取消今天 → 把晚间时间设成 1 分钟前 → 等 2 分钟，晚间批量不运行。测完恢复。
12. **锁屏 / 唤醒触发**：用 `sqlite3 ~/.butler/app.db "UPDATE jobs SET last_run_at = last_run_at - 86400000 WHERE name = 'morning_brief'"` 把早间简报改成“昨天跑过”，锁屏再解锁 → 早间简报自动重新生成。
13. **新建 ticket 的错误提示**：选一个 `git init` 后还没提交的目录 → “这个仓库还没有任何提交”；分支名填 `a b` → “分支名不合法”；worktree 模式分支填 `main` → “git 操作失败：'main' is already used by worktree …”。
14. **终端细节**：在终端里退出 claude → 退出提示一直在（Windows 上尤其要看）；新建 session 后不说话直接 `/exit` → 这个空 session 从按钮栏消失；拖入名字里带换行的文件 → 终端里只出现去掉控制字符的路径。
15. **Windows（如有条件）**：claude 是 npm 装的 `claude.cmd` 时，第 4、6 项照样成功（参数里的 JSON 和括号经 cmd.exe 正确转义）。

---

## 附录：验证记录（2026-10-20，Claude Code 2.1.306，macOS）

在一个临时 git 仓库里做（`$S` = 本次的 scratch 目录，`$S/repo` 是只有一个提交的仓库）。每次运行前都去掉外层会话的标记变量，并把 `BUTLER_HOME` 指到 `$S/bh`，这样用户已安装的 butler-hook 只会写进临时 inbox。没有修改 `~/.claude` 下的任何设置；额外的 hook 用 `--settings $S/tools/settings.json` 临时挂上（每个事件把 stdin 和 `BUTLER_*` 环境变量追加到 `$S/hooks.log`）。运行器 `$S/tools/run.sh`：

```sh
exec env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_SESSION_ATTENDED \
  -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_EXECPATH -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
  -u CLAUDE_PID -u CLAUDE_CODE_SSE_PORT \
  BUTLER_HOME="$SPIKE/bh" BUTLER_HEADLESS=1 BUTLER_SESSION="headless:spike" claude "$@"
```

一共 4 次 `claude -p`。结束后删除了这些运行留在 `~/.claude/projects/<scratch>-repo/` 的 transcript 和 `~/.claude/session-env/` 下的空目录。

### V1：`--output-format json --json-schema`，prompt 走 stdin

```sh
printf 'Answer with word="hello" and count=3. Do not use any tools.' | \
  run.sh -p --output-format json --json-schema '{"type":"object","properties":{"word":{"type":"string"},"count":{"type":"integer"}},"required":["word","count"],"additionalProperties":false}' \
  --settings $S/tools/settings.json
```

观察：
- stdin 上的 prompt 被正常读取，退出码 0。
- stdout 是一个 JSON 对象：`type: "result"`、`subtype: "success"`、`is_error: false`、`session_id`、`num_turns: 2`、`stop_reason: "tool_use"`、`api_error_status: null`、`permission_denials: []`、`total_cost_usd`、`terminal_reason: "completed"`。
- **结构化结果在 `structured_output`**（`{"word":"hello","count":3}`）；`result` 字段是同一份 JSON 的字符串。结构化输出是用一次工具调用实现的（`stop_reason: "tool_use"`，两轮）。
- hook 全部触发：`SessionStart`（`source: "startup"`）、`UserPromptSubmit`（带 `prompt`）、`Stop`、`SessionEnd`，都带 `transcript_path`。hook 进程收到了 `BUTLER_HEADLESS=1`、`BUTLER_SESSION=headless:spike`，`CLAUDE_CODE_ENTRYPOINT=sdk-cli`。真实的 butler-hook 把四个信封写进了 `$S/bh/inbox`，`butlerSession` 是 `"headless:spike"`。
- 新的 transcript 写到了 `~/.claude/projects/<cwd 编码>/<session_id>.jsonl`。

设计结论：解析 `structured_output`，`result` 作为退路（`pickStructured`）；hook 会触发，所以必须标记 headless 运行（V3）。

### V2：`--resume <id> --fork-session`

```sh
shasum $ORIG; stat -f '%m %z' $ORIG      # 原 transcript 的哈希、修改时间、大小
printf 'Step 1: run `git status`. Step 2: create fork.txt ... Report gitClean, wroteFile, previousWord.' | \
  run.sh -p --resume <V1 的 session_id> --fork-session --output-format json \
  --json-schema '{"type":"object","properties":{"gitClean":{"type":"boolean"},"wroteFile":{"type":"boolean"},"previousWord":{"type":"string"}},"required":["gitClean","wroteFile","previousWord"]}' \
  --allowedTools "Bash(git status)" --settings $S/tools/settings.json
shasum $ORIG; stat -f '%m %z' $ORIG
```

观察：
- **原 transcript 完全没变**（哈希、修改时间、大小都相同）。
- **fork 有新的 session id，并在同一个项目目录里新建了 jsonl**（包含原对话历史和新的轮次）。模型拿到了原对话的上下文（`previousWord: "hello"`）。
- `Bash(git status)` 被允许；`Write` 被拒绝：`permission_denials: [{ tool_name: "Write", tool_use_id, tool_input }]`，`fork.txt` 不存在。`-p` 下白名单以外、需要授权的工具会被自动拒绝。
- fork 的 `SessionStart` hook 的 `source` 是 **`"fork"`**（不在计划 1 的 `clear` / `compact` / `resume` 链接名单里）。

设计结论：fork 本身安全，但会在磁盘上留下一个“未认领”的 jsonl。所以 handoff 一律加 `--no-session-persistence`（V3 证明它和 `--fork-session` 可以一起用），返回的 session id 再用 `recordHeadless` 记成已忽略。

### V3：`--no-session-persistence` + fork、MCP 工具名、init 消息、hook 是否触发

用一个自己写的 stdio MCP 服务器 `spike`（两个工具 `echo` 和 `secret`，被调用时记日志），配置文件 `$S/tools/mcp.json`：

```sh
printf 'Call mcp__spike__echo with text "ping", then call mcp__spike__secret with text "x". Report echoed and secretResult.' | \
  run.sh -p --resume <V1 的 session_id> --fork-session --no-session-persistence \
  --output-format stream-json --verbose --json-schema '{"type":"object","properties":{"echoed":{"type":"string"},"secretResult":{"type":"string"}},"required":["echoed","secretResult"]}' \
  --mcp-config $S/tools/mcp.json --allowedTools "mcp__spike__echo" --settings $S/tools/settings.json \
  | node $S/tools/stamp.mjs      # 每行加上距启动的毫秒数
```

观察：
- **`--fork-session --no-session-persistence` 可以一起用：没有写任何新的 jsonl**（项目目录里仍然只有 V1、V2 的两个文件）。hook 仍然触发（`SessionStart` 的 `source: "fork"`），`transcript_path` 指向一个不存在的文件。
- MCP 工具名是 **`mcp__<server>__<tool>`**（`mcp__spike__echo`）。`--allowedTools mcp__spike__echo` 允许的工具被调用了（MCP 服务器日志里有这一次调用）；没列出的 `mcp__spike__secret` 被自动拒绝，出现在 `permission_denials` 里，MCP 服务器没有收到调用。
- stream-json 的第一条 `system/init` 消息大约 2.0 秒到（在它之前只有 `hook_started` / `hook_response`），第一条 assistant 消息大约 5.3 秒才到。init 消息包含 `tools`（全部工具名，这台机器上有 382 个）和 `mcp_servers`（`[{ name, status }]`），其中包括 `~/.claude.json` 里没有的服务器：`claude.ai Claude Docs`（claude.ai 连接器）和 `plugin:stripe:stripe`（插件），状态分别是 `connected` 和 `needs-auth`。对应的工具名里，server 名里的非法字符被替换成 `_`：`mcp__claude_ai_Claude_Docs__batch`、`mcp__plugin_stripe_stripe__authenticate`；连字符保留（`mcp__chrome-devtools__click`）。
- 最终的 `result` 消息与 V1 的 `--output-format json` 形状相同，`structured_output` 是 `{"echoed":"echo:ping","secretResult":"denied"}`。

另外几项不调用模型的检查：
- `claude mcp list`（约 3.5 秒）只输出 `<name>: <command 或 url> - <状态>`，没有 `--json` 选项，也没有工具名。**它会触发一次 `SessionEnd` hook**（session id 是临时的，没有 transcript）。所以 Butler 启动的任何 claude 子进程都要带 headless 标记。
- `claude --version` / `claude --help` 不触发 hook。
- `~/.claude.json` 的 `mcpServers`（用户级）和 `projects[<path>].mcpServers`（本地级）只覆盖一部分服务器，读不到连接器和插件。
- 已安装的 butler-hook 只转发 `BUTLER_TICKET` 和 `BUTLER_SESSION`，不转发 `BUTLER_HEADLESS`。

设计结论：
- headless 标记用 `BUTLER_SESSION=headless:<runId>`，不需要重新打包 hook 程序；`applyHookEnvelope` 忽略这种信封。
- tracker 工具名用“启动 headless claude，读到 init 就结束”的方式探测（任务 10）；探测不到时用户在设置里手填（`trackerTools`）。不用 `claude mcp list`（没有工具名），也不读 `~/.claude.json`（漏掉连接器和插件）。

### V4：`/handoff` 命令与 Stop 时 transcript 的内容

在仓库里放一个项目级命令 `.claude/commands/handoff.md`（为了不碰 `~/.claude`），并临时挂一个 Stop hook，在 hook 触发的那一刻复制 transcript：

```sh
printf '/handoff extra-arg' | run.sh -p --output-format json --settings $S/tools/settings2.json
```

观察：
- `-p` 下自定义斜杠命令能展开，`$ARGUMENTS` 被替换成 `extra-arg`；`result` 是 `` ```butler-handoff\n{...}\n``` ``。
- **Stop hook 触发时，最终的 assistant 消息已经写进 transcript**（hook 当时复制的文件和最终文件的最后一条一致），所以 Stop 之后读 transcript 不需要等待重试。
- transcript 的形状：一条 user 消息 `<command-message>handoff</command-message>\n<command-name>/handoff</command-name>\n<command-args>extra-arg</command-args>`；一条 `isMeta: true` 的 user 消息，内容是命令展开后的文字（**里面也有示例代码块**）；然后是 assistant 消息，内容是 `[{ type: "text", text }]`，带 `uuid`。
- Stop hook 的 payload 字段：`session_id`、`transcript_path`、`cwd`、`hook_event_name`、`permission_mode`、`prompt_id`、`stop_hook_active`、`effort`、`background_tasks`、`session_crons`。**没有最后一条消息的内容**，只能读 transcript。

设计结论：只看“最后一条非 tool_result 的 user 消息之后”的 assistant 文本，取最后一个 `butler-handoff` 代码块；用 assistant 条目的 `uuid` 去重（任务 9）。

### 没有实测、由计划兜底的点

- `--permission-mode dontAsk` 和 `--json-schema` 同时使用（4 次调用的预算用完了）。任务 16 Step 2 用一次真实调用验证，失败时按那里写的方式去掉 `dontAsk`。
- 额度用完 / 限流时 `--output-format json` 的具体形状。`isRateLimited` 按 `api_error_status` 为 429/529 或文本里的 rate limit / usage limit / quota / overloaded 判断；判断不出来时按普通失败处理（同样不写入，批次标为 partial，早间补跑）。
- Windows 上 `claude.cmd` 经 cmd.exe 的参数转义。依赖 cross-spawn；Windows CI（计划 4）上，任务 7 的假 claude 用例会以 `.cmd` 运行，覆盖这条路径。

## 附录：与设计文档的差异（本计划有意为之）

1. headless 运行加了 `--no-session-persistence`、`--permission-mode dontAsk`、`--disallowedTools Edit Write NotebookEdit`（5.1 节命令里没有）：不让 fork 落盘污染“未认领”，并且不受用户默认权限模式影响，保证只读。
2. headless 标记用 `BUTLER_SESSION=headless:<runId>`，没有用单独的 `BUTLER_HEADLESS`：已安装的 hook 程序只转发这两个变量，这样不用重新打包 SEA。
3. 计划 2 的 headless 运行不带 `--mcp-config`：每个 ticket 的 MCP 配置文件在计划 4 才生成；用户级 tracker MCP 照常加载（V3）。handoff 写入 StateCore 也在计划 4。
4. 新增 `item_marks` 表（非 followup 条目的完成 / 推迟 / 忽略），以及 `tickets.status_changed_at` / `status_manual_at` 两列（用于“阻塞超过 N 天”和“等 review 超过 N 天”）。
5. 早间刷新的结果存成一条完整的 handoff（`trigger=refresh`，沿用上一条的其余字段，`done_today` 清空），让简报永远只需要看“最新一条完整 handoff”。
6. followup 合并除了按 id，还按规范化后的描述去重：`/handoff` 在会话里拿不到 id。
7. 调度的补充规则：第一次启动不补跑历史；早间简报最早 05:00；每分钟 tick 在用户正在用电脑时也能触发早间简报（整晚没锁屏的情况）；上次晚间批量是 partial / failed 时，在早间简报前补跑一次。`discovery_scan` 保留计划 1 的定时器，不写进 `jobs` 表。
8. “上个工作日”统计的是从上个工作日 00:00 到现在的 handoff，这样会包含周末的 `/handoff` 和早上补跑的晚间批量。
9. tracker 工具名通过 headless claude 的 init 消息探测（设计文档 9 节的“从 Claude Code 配置里自动检测”）；首次启动向导仍在计划 4。
10. 状态推导规则在任务 6 里写成了具体的优先级（设计文档只说“由最新 handoff 推导”）。
11. 系统通知的文案放在 `src/main/strings.ts`，因为它在主进程里显示。
