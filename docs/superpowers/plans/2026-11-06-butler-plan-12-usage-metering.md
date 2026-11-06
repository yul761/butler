# token 用量记录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Butler 按轮次记下它开的每个 session（含子代理）和每次 headless 调用的 token 用量，存进数据库，供上下文换新（计划 16）取"当前上下文长度"，供「现在」页（计划 14）显示几个汇总数字。

**Architecture:** 一个纯函数把 transcript 的一行解析成一轮用量；`UsageScanner` 按文件记住读到的字节位置，增量读 Butler session 的 transcript 和它的 `subagents/*.jsonl`，写进 `session_usage`（按 `message.id` 去重）。headless 调用的 JSON 结果里的 `usage` 由 `execHeadlessJson` 交给一个回调记下。汇总在主进程算好，经 IPC 给渲染进程。

**Tech Stack:** TypeScript、Electron 主进程、node:sqlite（`src/main/db`）、vitest。

**Spec:** `docs/superpowers/specs/2026-11-06-now-page-and-token-savings-design.md`（"token 用量"两节）

## Global Constraints

- 不在界面上报花费金额，只显示 token 数和占比（占比按价格比例折算，见 Task 4 的 `USAGE_WEIGHTS`）。
- 同一个 API 回复在 transcript 里拆成多行（每个 content block 一行，`usage` 相同）：按 `message.id` 去重，没有 `message.id` 时用 `requestId`，两者都没有就跳过这一行。
- 增量读：每个文件记住读到的字节位置；文件变短就从头读；半行留到下次。读不了的文件跳过，下次再试，不抛错。
- 只读 Butler 开的 session（`sessions.origin = 'butler'`）的 transcript，不碰用户在 Butler 外开的。
- 新 migration 加在 `src/main/db/migrations.ts` 的 `MIGRATIONS` 数组末尾（之后的计划也各自往末尾加，按计划顺序执行）。
- 主进程文案中英两套（`src/main/strings.ts`）；渲染进程的文案在计划 14 里加。
- 支持 macOS 和 Windows：路径一律用 `node:path` 拼。

## Review Focus

1. transcript 里同一条 assistant 消息拆成 3 行（thinking、text、tool_use），`usage` 一样：只记一轮 → Task 1 的测试 `dedupes split content blocks`。
2. Butler 运行中 transcript 被 `/clear` 换了新 id：新 id 的文件也要被扫到，旧文件扫完最后一段就不再读 → Task 3 的测试 `follows the head after clear`。
3. transcript 一次涨了几十 MB（长 session 第一次被扫）：分块读，内存有界，不能一次 `readFile` 全读进来 → Task 2 的测试 `reads a big file in chunks`。
4. `usage` 字段缺了 `cache_creation` 子对象（老版本 Claude Code）：把 `cache_creation_input_tokens` 整个算成 5 分钟写入 → Task 1 的测试 `falls back when cache_creation is missing`。
5. headless 调用失败（`ok: false`）但 `result` 里有 `usage`：照样记，花掉的 token 也是花了 → Task 5 的测试 `records usage of a failed run`。

---

### Task 1: 解析一行用量

**Files:**
- Create: `src/main/usage/usage-parse.ts`
- Test: `src/main/usage/usage-parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface UsageCounts { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number }
  export interface UsageTurn extends UsageCounts { messageId: string; at: number; model: string | null; /** input + 全部缓存读写 */ context: number }
  export function parseUsageLine(line: string): UsageTurn | null
  export function usageCounts(u: unknown): UsageCounts | null   // 也给 headless 结果用
  ```

- [ ] **Step 1: 写失败的测试**

```ts
const line = (o: object) => JSON.stringify({ type: "assistant", timestamp: "2026-11-06T10:00:00.000Z", requestId: "req_1",
  message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 5000, output_tokens: 40,
    cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 } } }, ...o });

it("parses one assistant turn", () => {
  expect(parseUsageLine(line({}))).toEqual({ messageId: "msg_1", at: Date.parse("2026-11-06T10:00:00.000Z"), model: "claude-opus-5-5",
    input: 2, cacheWrite5m: 0, cacheWrite1h: 100, cacheRead: 5000, output: 40, context: 5102 });
});
it("falls back when cache_creation is missing", () => {
  const l = JSON.stringify({ type: "assistant", message: { id: "m", usage: { input_tokens: 1, cache_creation_input_tokens: 30, cache_read_input_tokens: 0, output_tokens: 1 } } });
  expect(parseUsageLine(l)).toMatchObject({ cacheWrite5m: 30, cacheWrite1h: 0, context: 31 });
});
it("uses requestId when message.id is missing and skips lines with neither", () => { /* 两条断言 */ });
it("ignores user lines, summaries, malformed json and assistant lines without usage", () => { /* 都返回 null */ });
it("dedupes split content blocks", () => {
  // 三行同一个 message.id：parseUsageLine 三次都返回同一个 messageId；去重在 Task 2 的 repo 里用主键做，这里断言 messageId 相同
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm vitest run src/main/usage/usage-parse.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `parseUsageLine` 和 `usageCounts`**

先用 `line.includes('"usage"')` 快速跳过不相关的行再 `JSON.parse`。`type !== "assistant"` 返回 null。`timestamp` 解析不了时 `at` 用 `Date.now()`。`isSidechain` 不过滤（子代理文件里的行都是 sidechain，也要记）。

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm vitest run src/main/usage/usage-parse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/usage/usage-parse.ts src/main/usage/usage-parse.test.ts
git commit -m "feat(usage): parse per-turn token usage from transcript lines"
```

### Task 2: 用量表和读取位置

**Files:**
- Modify: `src/main/db/migrations.ts`（末尾加一个 migration）
- Create: `src/main/db/usage-repo.ts`
- Test: `src/main/db/usage-repo.test.ts`

**Interfaces:**
- Consumes: `UsageTurn`、`UsageCounts`（Task 1）
- Produces:
  ```ts
  export type UsageSource = "session" | "subagent" | "headless";
  export interface UsageRow extends UsageTurn { sessionId: string | null; agentId: string | null; source: UsageSource; job: string | null }
  export class UsageRepo {
    constructor(db: Db)
    /** 已有的 messageId 忽略（INSERT OR IGNORE），返回新写入的行数。一次调用一个事务。 */
    record(rows: UsageRow[]): number
    cursor(file: string): { offset: number; size: number } | null
    setCursor(file: string, offset: number, size: number): void
    /** 这个 session 最新一轮（按 at）的 context；没有记录返回 null。只看 source='session'。 */
    latestContext(sessionId: string): number | null
    /** at >= sinceMs 的所有行，给汇总用。 */
    since(sinceMs: number): UsageRow[]
  }
  ```

Migration：

```sql
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
```

headless 的行没有 message id：调用方给它一个 `headless:<runId>` 的 id（Task 5）。

- [ ] **Step 1: 写失败的测试**（用 `memDb()`，`src/main/test-utils`）

```ts
it("records rows once per message id", () => { const r = new UsageRepo(memDb()); expect(r.record([row("m1"), row("m1")])).toBe(1); expect(r.record([row("m1")])).toBe(0); });
it("latestContext returns the newest session turn", () => { /* at 100 context 10、at 200 context 50、subagent at 300 context 999 → 50 */ });
it("stores and reads cursors", () => { /* setCursor 后 cursor 返回同样的值；不存在返回 null */ });
it("since filters by time", () => { /* at 100、at 200，since(150) 只返回后者 */ });
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm vitest run src/main/db/usage-repo.test.ts`
Expected: FAIL

- [ ] **Step 3: 加 migration，实现 `UsageRepo`**（写法照 `merge-gate-repo.ts`：Row 接口 + 转换函数）

- [ ] **Step 4: 跑测试和全部 db 测试**

Run: `pnpm vitest run src/main/db`
Expected: PASS（`migrations` 相关测试里如果断言了 migration 个数，同步改掉）

- [ ] **Step 5: Commit**

```bash
git add src/main/db/migrations.ts src/main/db/usage-repo.ts src/main/db/usage-repo.test.ts
git commit -m "feat(usage): session_usage and usage_cursors tables"
```

### Task 3: 增量扫描 transcript 和子代理文件

**Files:**
- Create: `src/main/usage/usage-scanner.ts`
- Test: `src/main/usage/usage-scanner.test.ts`

**Interfaces:**
- Consumes: `parseUsageLine`（Task 1）、`UsageRepo`（Task 2）
- Produces:
  ```ts
  export const USAGE_SCAN_MS = 30_000;
  export const USAGE_CHUNK_BYTES = 1024 * 1024;
  export interface UsageScannerDeps {
    repo: UsageRepo;
    /** 现在要扫的 session id（Butler 开的、终端开着的 head，以及刚退出的）。 */
    sessionIds: () => string[];
    transcriptFile: (sessionId: string) => string | null;
    log?: (msg: string, err?: unknown) => void;
  }
  export class UsageScanner {
    constructor(d: UsageScannerDeps)
    start(intervalMs?: number): void
    stop(): void
    /** 扫一遍 sessionIds()；同一时间只跑一次，正在跑时直接返回。 */
    scanAll(): Promise<void>
    /** 终端退出时调用：把这个 session 读到文件末尾。 */
    scanSession(sessionId: string): Promise<void>
  }
  /** `<dir>/<id>.jsonl` → `<dir>/<id>/subagents`。 */
  export function subagentsDir(transcriptFile: string): string
  ```

做法：对每个 session，主 transcript 记 `source='session'`、`sessionId=该 id`；`subagentsDir` 下每个 `agent-*.jsonl` 记 `source='subagent'`、`sessionId=该 id`、`agentId=文件名去掉 agent- 和 .jsonl`。每个文件从 `repo.cursor(file)` 的位置起，按 `USAGE_CHUNK_BYTES` 分块读到当前大小，最后一个不完整的行不消费（位置停在它开头）；文件比记录的 size 小就从 0 开始。每块解析完 `record` 一次，再 `setCursor`。

- [ ] **Step 1: 写失败的测试**（用 `tempDir()` 造 transcript 文件）

```ts
it("records new turns and resumes from the cursor", async () => { /* 写 2 轮 → scanAll → 2 行；追加 1 轮 → scanAll → 共 3 行 */ });
it("keeps a half line for the next scan", async () => { /* 写一行的前半 → 0 行；补后半 → 1 行 */ });
it("restarts from zero when the file shrinks", async () => {});
it("reads a big file in chunks", async () => { /* USAGE_CHUNK_BYTES 用构造参数或导出常量调小，写 3 块的数据，断言全部记到 */ });
it("records subagent files under the parent session", async () => { /* <id>/subagents/agent-abc.jsonl → source subagent、agentId abc、sessionId 父 id */ });
it("follows the head after clear", async () => { /* sessionIds 先返回 A，后返回 B：A 的文件扫完不再读（不在 sessionIds 里），B 被扫 */ });
it("skips unreadable files without throwing", async () => {});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm vitest run src/main/usage/usage-scanner.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `UsageScanner`**（`node:fs/promises` 的 `open` + `read(buf, 0, len, offset)`，照 `TranscriptTail.read` 的写法，但不跳到尾部）

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm vitest run src/main/usage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/usage/usage-scanner.ts src/main/usage/usage-scanner.test.ts
git commit -m "feat(usage): incremental transcript and subagent usage scanner"
```

### Task 4: 汇总

**Files:**
- Create: `src/main/usage/usage-summary.ts`
- Modify: `src/shared/types.ts`（加 `UsageSummary`）
- Test: `src/main/usage/usage-summary.test.ts`

**Interfaces:**
- Consumes: `UsageRow`（Task 2）
- Produces:
  ```ts
  // src/shared/types.ts
  export type UsageKind = "ticket" | "coordinator" | "subagent" | "headless";
  export interface UsageSummary {
    sinceMs: number;
    totalTokens: number;                 // 五项之和
    /** 下面三个都是 0..1，按 USAGE_WEIGHTS 折算后的占比；没有数据时为 0。 */
    cacheReadShare: number;
    over200kShare: number;               // context >= 200_000 的轮次
    byKind: Record<UsageKind, number>;   // 每类的折算占比
    byModel: Record<string, number>;     // 模型 → 折算占比；model 为 null 的记在 "unknown"
  }
  // src/main/usage/usage-summary.ts
  /** 相对价格（Opus 的比例，基础输入 = 1）。只用来算占比，不换算金额。 */
  export const USAGE_WEIGHTS = { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 } as const;
  export const USAGE_WINDOW_MS = 7 * 24 * 60 * 60_000;
  export function summarizeUsage(rows: UsageRow[], kindOf: (sessionId: string | null) => "ticket" | "coordinator", sinceMs: number): UsageSummary
  ```

`kind`：`source='subagent'` → subagent，`'headless'` → headless，否则 `kindOf(sessionId)`（主进程里传 `sessions.get(id)?.coordinator ? "coordinator" : "ticket"`）。

- [ ] **Step 1: 写失败的测试**

```ts
it("computes weighted shares", () => {
  // 一轮：cacheRead 1000（权重 100）、output 20（权重 100）→ cacheReadShare 0.5；totalTokens 1020
});
it("counts turns at or over 200k context", () => {});
it("splits by kind and model", () => {});
it("returns zeros for no rows", () => { expect(summarizeUsage([], () => "ticket", 0)).toMatchObject({ totalTokens: 0, cacheReadShare: 0, over200kShare: 0 }); });
```

- [ ] **Step 2: 跑测试，确认失败** — Run: `pnpm vitest run src/main/usage/usage-summary.test.ts` / Expected: FAIL
- [ ] **Step 3: 实现 `summarizeUsage`**
- [ ] **Step 4: 跑测试，确认通过** — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/main/usage/usage-summary.ts src/main/usage/usage-summary.test.ts src/shared/types.ts
git commit -m "feat(usage): weighted usage summary"
```

### Task 5: 记 headless 调用的用量

**Files:**
- Modify: `src/main/claude/headless.ts`（`ClaudeResult` 加 `usage`、`model`；`parseClaudeJson` 填它们）
- Modify: `src/main/handoff/headless-exec.ts`（`HeadlessExecDeps` 加可选 `onUsage`）
- Test: `src/main/claude/headless.test.ts`、`src/main/handoff/headless-exec.test.ts`（没有就新建）

**Interfaces:**
- Consumes: `usageCounts`（Task 1）
- Produces:
  ```ts
  // ClaudeResult 新增
  usage: UsageCounts | null;
  /** modelUsage 里的第一个键；没有为 null。 */
  model: string | null;
  // HeadlessExecDeps 新增
  onUsage?: (u: { runId: string; label: string; at: number; model: string | null; usage: UsageCounts }) => void;
  ```

`execHeadlessJson` 在 `d.run` 返回后、判断 `ok` 之前：`out.result?.usage` 有值就调 `onUsage`，`runId` 用这次传给 `headlessEnv` 的那个（先存进变量）。`label` 就是现有的 `o.label`（"handoff BTL-1"、"feature summary 3"、"stuck judge"），记进 `job` 时只保留第一个词之前的类型部分：`handoff`、`feature summary`、`stuck judge`（用一个 `jobOf(label)` 去掉末尾的 ticket 号或数字）。

- [ ] **Step 1: 写失败的测试**

```ts
it("parses usage and model from the result object", () => { /* {type:"result", usage:{...}, modelUsage:{"claude-sonnet-5-5":{}}} → usage 对上、model "claude-sonnet-5-5" */ });
it("records usage of a failed run", async () => { /* run 返回 ok:false 且 result 带 usage → onUsage 被调一次 */ });
it("does not call onUsage when the result has no usage", async () => {});
```

- [ ] **Step 2: 跑测试，确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 用真实的 claude 看一次结果的形状**

Run: `echo hi | claude -p --output-format json --no-session-persistence | head -c 2000`
Expected: 输出里有 `usage`（含 `cache_read_input_tokens`）和 `modelUsage`。字段名和测试里用的不一致就改测试和实现，以真实输出为准，并在 commit message 里写明。

- [ ] **Step 5: 跑测试，确认通过** — Run: `pnpm vitest run src/main/claude src/main/handoff` / Expected: PASS
- [ ] **Step 6: Commit**

```bash
git add src/main/claude/headless.ts src/main/handoff/headless-exec.ts src/main/claude/headless.test.ts src/main/handoff/headless-exec.test.ts
git commit -m "feat(usage): report token usage of headless runs"
```

### Task 6: 接进主进程，加 IPC

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/shared/ipc.ts`（`IPC.usageSummary = "usage:summary"`，加进 `INVOKE_CHANNELS`）
- Modify: `src/main/ipc/register.ts`、`src/renderer/src/api.ts`
- Test: `src/shared/ipc.test.ts`（如果它断言了频道列表）

**Interfaces:**
- Consumes: Task 2–5
- Produces（给计划 14、16）：
  - 主进程里的 `usageRepo: UsageRepo`、`usageScanner: UsageScanner`
  - `api.usageSummary(): Promise<UsageSummary>`（最近 `USAGE_WINDOW_MS`）
  - `contextOf(sessionId: string): number | null` = `usageRepo.latestContext(sessions.head(sessionId)?.id ?? sessionId)`，作为一个局部函数留在 `bootstrap` 里，计划 16 会用

接线：
- `usageScanner = new UsageScanner({ repo: usageRepo, sessionIds: () => pty.openIds().map((t) => sessions.head(t)).filter((s) => s?.origin === "butler").map((s) => s!.id), transcriptFile: (id) => findTranscript(paths.claudeProjects, id), log: logger })`；`activityMonitor.start()` 之后 `usageScanner.start()`；`will-quit` 里 `usageScanner.stop()`。
- pty 的 `exit` 回调里，在 `sessionService.handleExit(id)` 之前取 `sessions.head(id)?.id`，之后 `void usageScanner.scanSession(headId)`。
- 给 `HandoffRunner`、`FeatureSummaryRunner`、`judgeStuck` 的 deps 都加 `onUsage: recordHeadlessUsage`，其中 `recordHeadlessUsage` 写一行 `{ messageId: \`headless:${runId}\`, sessionId: null, agentId: null, source: "headless", job: jobOf(label), at, model, ...usage, context: input + 三项缓存 }`。

- [ ] **Step 1: 加频道和 IPC handler**（`register.ts` 里 `handle(IPC.usageSummary, () => summarizeUsage(d.usage.since(now - USAGE_WINDOW_MS), kindOf, now - USAGE_WINDOW_MS))`，`RegisterDeps` 加 `usage: Pick<UsageRepo, "since">` 和 `sessions`（已有就复用））
- [ ] **Step 2: 接 `index.ts`**
- [ ] **Step 3: 跑全部测试和类型检查**

Run: `pnpm typecheck && pnpm test`
Expected: 全部通过

- [ ] **Step 4: 真机验证**

Run: `pnpm dev`，在 Butler 里开一个 ticket session，让它读两个文件；等 30 秒后
`sqlite3 ~/.butler/app.db "select source, count(*), max(context) from session_usage group by source"`
Expected: 有 `session` 行，`max(context)` 和这个 session 的上下文大小相当；让它开一个子代理后再查，出现 `subagent` 行。

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/shared/ipc.ts src/main/ipc/register.ts src/renderer/src/api.ts src/shared/ipc.test.ts
git commit -m "feat(usage): scan Butler sessions in the background and expose a usage summary"
```
