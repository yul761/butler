# 上下文换新、epic 规划单独存放、长期记忆 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上下文太长的 session（包括总控）停下来时，Butler 自动让它写好 handoff、清空、再从记忆里接上；总控和界面也能手动触发。为了让 epic 总控也能安全换新，epic 规划改为单独存放。每周、以及 feature 归档时，把 epic 的成果和决定整理成长期记忆。

**Architecture:** `SessionRefresher` 是一个小状态机，每个 session 走"写 handoff → 等收进来 → /clear → 等新 id 接上 → 发接着做的话"这几步，每步有超时，失败就停在原地，30 分钟内不重试。自动触发的条件来自计划 12 的上下文长度和计划 13 的 `DeliveryGuard`。feature 总控换新时跳过 `/handoff` 后面那一连串 ticket handoff。epic 规划挪到 `epics.plan`，epic 总控用新操作 `set_epic_plan` 写它。`EpicDigestRunner` 用 Sonnet 读数据库里的总结和决定，写进 `epic_history` 表，再更新 epic 作用域里的一条滚动 note。

**Tech Stack:** TypeScript、Electron、node:sqlite、StateCore（`statecore-mcp`）、MCP server（`memory-mcp/sessions-server.ts`）、React、vitest、Playwright e2e。

**Spec:** `docs/superpowers/specs/2026-11-06-now-page-and-token-savings-design.md`（"上下文换新"两节、"长期记忆"）

**依赖:** 计划 12（`contextOf`）、计划 13（`DeliveryGuard`、`GUIDE_SECTIONS`）、计划 14（`NeedsYouTracker`）、计划 15（`headlessArgs` 的 `model` 用 `"sonnet"`）。

## Global Constraints

- 阈值设置 `refreshThresholdTokens`，默认 `150000`，`0` 表示关掉自动换新（手动和总控触发不受影响）。
- 自动触发的条件：上下文（`contextOf`）≥ 阈值，`DeliveryGuard.check` 通过（含「需要你」、草稿、30 秒打字、屏幕确认），这个 session 不在换新中，30 分钟内没有失败过。手动和总控触发：除了「需要你」之外，`DeliveryGuard` 的其余条件照样要满足。
- 等 handoff 收进来最多 10 分钟（`REFRESH_HANDOFF_MS = 600_000`），等 `/clear` 后的新 id 最多 60 秒（`REFRESH_CLEAR_MS = 60_000`），失败冷却 30 分钟（`REFRESH_COOLDOWN_MS = 1_800_000`）。
- 任何一步失败都停下：不再往下输入任何东西，已经写下的 handoff 留着。
- 接着做的那句话只让 session 调回进度、说一两句做到哪了，然后等用户，不自己开始新的工作。
- 修好 epic 规划之前（Task 1 合并之前），epic 总控不自动换新。
- 长期记忆：每周第一个工作日跟着每晚的任务跑一次，只处理上周有新活动的 epic；feature 归档时对它的 epic 立刻跑一次。用 Sonnet，不 fork session。滚动 note 最多 360 字（`NOTE_BODY_LIMIT`），拼进第一条消息的"以往的决定"最多 3000 字（`EPIC_HISTORY_BRIEF_CHARS = 3000`），超出时去掉最旧的。
- 文案、工具描述、session 说明中英两套。
- 往终端里输入一律用 `PtyManager.deliver`，先 `sanitizeTask`；Windows 上 `singleLine: true`。

## Review Focus

1. 换新途中（写 handoff 那一步）用户切过去开始打字：下一步（`/clear`）不能执行，整个换新取消 → Task 3 的测试 `aborts when the guard fails between steps`。
2. 用户自己的 `/handoff` 命令文件被改过（`handoffCommandStatus` 是 `conflict`）：Butler 没法确定 `/handoff` 的输出格式，自动换新对 ticket session 关掉并记日志 → Task 3 的测试 `skips tickets when the handoff command is not Butler's`。
3. feature 总控换新时写的 `/handoff`：不能带动下面每个 ticket 跑 handoff → Task 2 的测试 `skips the ticket fan-out while refreshing`。
4. 老的 epic：规划还在 epic 作用域的 handoff 里（分隔符包着，或者整份是 epic session 自己写的）→ 升级后迁到 `epics.plan`，epic 记忆里的内容不变 → Task 1 的测试 `migrates the carried plan`。
5. 「现在」页上正在换新的 session：显示"换新中"，不出现在「需要你」里，也不在这期间递 CI 结果 → Task 4 的测试 `refreshing sessions are busy for every delivery`。

---

### Task 1: epic 规划单独存放

**Files:**
- Modify: `src/main/db/migrations.ts`（`ALTER TABLE epics ADD COLUMN plan TEXT; ALTER TABLE epics ADD COLUMN plan_at INTEGER;`）
- Modify: `src/main/db/epics-repo.ts`（`setPlan(id, plan, at)`；`Epic` 加 `plan: string | null`、`planAt: number | null`）
- Modify: `src/shared/types.ts`
- Modify: `src/main/memory/memory-service.ts`（`syncEpicNow`：规划从 `epics.plan` 取；作用域里当前的 handoff 不是 Butler 渲染的（`carriedEpicPlan` 认出来的那种）时，把它当作 epic session 的**进度**，一起渲染进去；第一次遇到还没迁移的老 epic（`plan IS NULL` 且 active handoff 里认出了规划）时，把认出的规划写进 `epics.plan`）
- Modify: `src/main/epics/epic-info.ts`（`renderEpicHandoff(rows, lang, plan, progress)` 加一个 `progress: string | null` 参数和一段"epic 总控的进度"；进度最多 2000 字）
- Modify: `src/shared/control.ts`、`memory-mcp/sessions-server.ts`（epic 模式加 `set_epic_plan`：`{ plan: string }`，最长 `EPIC_PLAN_MAX_CHARS`）
- Modify: `src/main/control/control-handler.ts`（处理 `set_epic_plan`：`epics.setPlan`，然后 `syncEpic(id)`）
- Modify: `src/main/epics/epic-brief.ts`（规划从 `epics.plan` 取）
- Modify: epic session 用的说明（`sessions-server.ts` 里 epic 工具的描述，以及 epic 总控收到的引导文字——在 `session-service.ts` 的 `openEpic` 或 `epic-info.ts` 的模板里，按现有位置改）：规划定下来、或者改了规划时调用 `set_epic_plan`；`handoff` 只写进度
- Test: `src/main/db/epics-repo.test.ts`、`src/main/memory/memory-service.test.ts`、`src/main/epics/epic-info.test.ts`、`src/main/control/control-epic.test.ts`、`memory-mcp/sessions-server.test.ts`

**Interfaces:**
- Produces: `EpicsRepo.setPlan(id: number, plan: string, at: number): void`；控制操作 `{ v: 1; epicId: number; from: string | null; op: "set_epic_plan"; plan: string }`

- [ ] **Step 1: 写失败的测试**

```ts
it("an epic session's progress handoff no longer replaces the plan", async () => { /* setPlan("A 计划")；作用域里写一份 epic session 自己的 handoff "做到第二步" → syncEpic 后渲染的内容同时含 "A 计划" 和 "做到第二步" */ });
it("migrates the carried plan", async () => { /* 老格式：分隔符包着的规划在 active handoff 里，epics.plan 为空 → syncEpic 后 epics.plan 是那段规划，渲染结果和迁移前一致 */ });
it("set_epic_plan stores the plan and resyncs", async () => {});
it("the first message of a new feature takes the plan from the epic row", () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/db src/main/memory src/main/epics src/main/control memory-mcp`）
- [ ] **Step 5: Commit**

```bash
git add src/main/db src/shared src/main/memory src/main/epics src/main/control memory-mcp src/main/sessions/session-service.ts
git commit -m "fix(epic): keep the plan apart from the epic session's handoff"
```

### Task 2: 能知道"这个 session 的 handoff 收进来了"

**Files:**
- Modify: `src/main/index.ts`（`captureCommandHandoff` 的结果 `stored` 时调 `refresher.handoffStored(stop.sessionId)`；`afterFeatureCommand` 包一层：`refresher.isRefreshing(sessionId)` 时直接返回，不跑 ticket handoff、也不 fork）
- Modify: `src/main/memory/memory-service.ts`（`epicHandoffVersion(epicId): Promise<string | null>`：epic 作用域当前 handoff 的 id，没有为 null，给 epic 总控换新用）
- Test: `src/main/handoff/capture.test.ts`（行为不变的确认）、`src/main/memory/memory-service.test.ts`、Task 3 的测试里覆盖 `skips the ticket fan-out while refreshing`

**Interfaces:**
- Produces: `MemoryService.epicHandoffVersion(epicId: number): Promise<string | null>`
- Consumes（Task 3 定义）：`SessionRefresher.handoffStored(sessionId)`、`SessionRefresher.isRefreshing(sessionId)`

- [ ] **Step 1: 写 `epicHandoffVersion` 的失败测试** → 实现 → 通过
- [ ] **Step 2: Commit**

```bash
git add src/main/memory
git commit -m "feat(refresh): expose the epic handoff version"
```

（`index.ts` 的接线放在 Task 4，和 `SessionRefresher` 一起做。）

### Task 3: SessionRefresher

**Files:**
- Create: `src/main/sessions/session-refresher.ts`
- Modify: `src/main/strings.ts`（三句要输入的话，中英）
- Test: `src/main/sessions/session-refresher.test.ts`

**Interfaces:**
- Consumes: `DeliveryGuard`（计划 13）、`contextOf`（计划 12）、`sessions.head`、`pty.deliver`、`handoffCommandStatus`（`src/main/handoff/command.ts`）
- Produces:
  ```ts
  export const REFRESH_HANDOFF_MS = 600_000, REFRESH_CLEAR_MS = 60_000, REFRESH_COOLDOWN_MS = 1_800_000;
  export type RefreshKind = "ticket" | "feature" | "epic";
  export type RefreshTrigger = "auto" | "coordinator" | "manual";
  export type RefreshStep = "handoff" | "clear" | "resume";
  export type RefreshResult = "done" | "busy" | "already" | "cooldown" | "failed";
  export interface SessionRefresherDeps {
    guard: Pick<DeliveryGuard, "check">;
    /** 计划 14 的 NeedsYouTracker；手动和总控触发时忽略它（guard 用一个不带 needsYou 的实例，见 Task 4）。 */
    guardIgnoringNeedsYou: Pick<DeliveryGuard, "check">;
    head(sessionId: string): Session | null;
    kindOf(s: Session): RefreshKind | null;          // 修复 session、headless、非 Butler 的返回 null
    contextOf(sessionId: string): number | null;
    threshold(): number;                             // 设置 refreshThresholdTokens，0 = 关
    /** ticket session 的 /handoff 是 Butler 自己的命令（handoffCommandStatus === "installed"）。 */
    handoffCommandReady(): Promise<boolean>;
    epicPlanReady(): boolean;                        // Task 1 合并后恒为 true；留着这个开关是为了按顺序上线
    epicHandoffVersion(epicId: number): Promise<string | null>;
    deliver(termId: string, text: string): Promise<"sent" | "exited" | "timeout">;
    sessions(): Session[];                           // 开着终端的 Butler session 的 head，自动检查用
    notify(): void;
    now(): number;
    sleep?: (ms: number) => Promise<void>;
    log(msg: string, err?: unknown): void;
  }
  export class SessionRefresher {
    constructor(d: SessionRefresherDeps)
    /** 每个活动 tick 之后调：找满足条件的 session，一次最多启动一个。 */
    autoCheck(): void
    refresh(sessionId: string, trigger: RefreshTrigger): Promise<RefreshResult>
    isRefreshing(sessionId: string): boolean          // 链上任何一个 id 都认
    stepOf(sessionId: string): RefreshStep | null     // 给「现在」页显示"换新中"
    handoffStored(sessionId: string): void            // capture 存下了这个 session 的 /handoff
  }
  ```

每种 session 第一步输入什么：
- `ticket`、`feature`：`/handoff`，等 `handoffStored(id)`（按 head 比较）。
- `epic`：先记下 `epicHandoffVersion(epicId)`，输入 `M().refreshEpicHandoff`（"Butler 要清空这个 session 的上下文。请先用 butler-epic 的 handoff 写下现在的进度和没解决的问题；规划有改动的话先用 set_epic_plan 更新。写完就停下。"），等 `epicHandoffVersion` 变化（每 5 秒查一次）。

之后每一步之前都重新 `check(id)`（自动用 `guard`，其他用 `guardIgnoringNeedsYou`），不通过就以 `failed` 结束并进入冷却。第二步输入 `/clear`，等 `head(termId)` 的 id 变了；第三步输入 `M().refreshResume(kind, name)`：

- 中文 ticket：`上下文已由 Butler 换新。先用 recall 调出 {ticket} 最新的 handoff，用一两句话说明做到哪了，然后等用户的下一条指令，不要自己开始新的工作。`
- feature / epic：把 `{ticket}` 换成"这个 feature"/"这个 epic"，recall 的对象是 butler-feature / butler-epic。
- 英文照译。

- [ ] **Step 1: 写失败的测试**（假时钟、假 deliver、假 guard）

```ts
it("runs handoff, clear and resume in order for a ticket session", async () => {});
it("waits for the epic handoff version to change for an epic session", async () => {});
it("aborts when the guard fails between steps", async () => { /* handoff 收到后 guard 返回 typing → 不输入 /clear，结果 failed，冷却 */ });
it("gives up when the handoff never arrives", async () => { /* 10 分钟 → failed，不输入 /clear */ });
it("autoCheck only picks sessions over the threshold and not in cooldown", async () => {});
it("autoCheck is off at threshold 0", async () => {});
it("skips tickets when the handoff command is not Butler's", async () => {});
it("does not auto-refresh epic sessions before the plan fix", async () => {});
it("skips the ticket fan-out while refreshing", async () => { /* isRefreshing 在 handoff 步骤为 true；index.ts 的包装在 Task 4 用它 */ });
it("manual refresh ignores needs-you but not drafts", async () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/sessions/session-refresher.test.ts`）
- [ ] **Step 5: Commit**

```bash
git add src/main/sessions/session-refresher.ts src/main/sessions/session-refresher.test.ts src/main/strings.ts
git commit -m "feat(refresh): handoff, clear and resume a long session"
```

### Task 4: 接进主进程、总控的操作、按钮、设置

**Files:**
- Modify: `src/main/index.ts`（构造 `SessionRefresher`；`ActivityMonitor` 的 notify 之后 `refresher.autoCheck()`；`DeliveryGuard` 的 busy 判断加上 `refresher.isRefreshing(id)`；Task 2 说的两处接线）
- Modify: `src/main/sessions/delivery-guard.ts`（deps 加可选 `refreshing?: (headId) => boolean`，为 true 时 `busy`）
- Modify: `src/shared/control.ts`、`memory-mcp/sessions-server.ts`（ticket、feature、epic 三种模式都加 `refresh_session`：`{ session: string }`，描述："让 Butler 给一个停下来的子 session 换新上下文：先写 handoff，再清空，再从记忆里接上。只能对你管的、已经停下来的 session 用。"）
- Modify: `src/main/control/control-handler.ts`（`refresh_session`：范围和 `end_session` 一样用 `belongs`；不能对自己；调 `refresher.refresh(id, "coordinator")`，**不等它跑完**，先返回 `{ started: true }`；`busy`/`already`/`cooldown` 返回对应的错误）
- Modify: `src/shared/ipc.ts`（`IPC.sessionsRefresh = "sessions:refresh"`）、`register.ts`、`api.ts`
- Create: `src/renderer/src/components/RefreshSessionButton.tsx`（放在 `EndSessionButton` 旁边：`WorkspaceParts.tsx:210`、`TicketPage.tsx:223`）
- Modify: `src/shared/types.ts`（`NowRow` 加 `refreshing: RefreshStep | null`）、`src/main/now/now-view.ts`（填它；为 true 时 `needsYou` 为 null）、`src/renderer/src/now-view.ts`（`rowText`："换新中"）
- Modify: `src/shared/settings.ts`（`EDITABLE_SETTINGS` 加 `refreshThresholdTokens`）、`settings-values.ts`（读取，非法值用默认）、`GeneralSettings.tsx`（一个数字输入框："上下文超过多少 token 时自动换新（0 = 关）"）
- Modify: 文案（三处 strings）
- Test: `src/main/control/control-handler.test.ts`、`control-feature.test.ts`、`control-epic.test.ts`、`memory-mcp/sessions-server.test.ts`、`src/main/now/now-view.test.ts`、`src/renderer/src/now-view.test.ts`、`src/main/sessions/delivery-guard.test.ts`、`settings-form.test.ts`

- [ ] **Step 1: 写失败的测试**

```ts
it("refresh_session starts a refresh for a managed session and returns at once", async () => {});
it("refresh_session refuses the coordinator itself and sessions it does not manage", async () => {});
it("refreshing sessions are busy for every delivery", () => { /* guard.check → busy；now-view 里 needsYou 为 null、refreshing 有值 */ });
it("reads refreshThresholdTokens with a default of 150000", () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm typecheck && pnpm test`）
- [ ] **Step 5: 真机验证（关键：斜杠命令能不能靠粘贴执行）**

`pnpm dev`，设置里把阈值临时调到 `20000`，开一个 ticket session 读几个大文件，让它停下。
Expected：几十秒内终端里依次出现 `/handoff` 的输出、`/clear`、接着做的话；session 回答"做到哪了"后停下；`sqlite3 ~/.butler/app.db "select id, replaced_by from sessions order by created_at desc limit 3"` 看到新旧 id 接上；`session_usage` 里新 id 的 context 很小。
如果粘贴进去的 `/handoff` 或 `/clear` 没有被当成命令执行（被当成普通文字发给了模型）：把这两步改成逐个字符写入（`pty.write` 每个字符，再写 `\r`），并在 `PtyManager` 里加一个 `typeCommand(termId, command)` 方法，带同样的就绪检查；改完重新验证。Windows 上也要验证一遍（ConPTY）。
再开一个 feature 总控，重复一次，确认 ticket 没有跟着跑 handoff（日志里没有 `handoff <ticket>`）。

- [ ] **Step 6: Commit**

```bash
git add src
git commit -m "feat(refresh): automatic, coordinator and manual session refresh"
```

### Task 5: 派活只发任务，session 说明里加记忆的规矩

**Files:**
- Modify: `src/shared/control.ts`（`taskMessage(task, lang)` 的前缀后面加一句：中文"开始之前先用 recall 读一下 feature 记忆（butler-feature）里的背景和约定。"，英文照译；只有 feature 总控开的 session 加，ticket 总控开的用 butler-memory）
- Modify: `memory-mcp/sessions-server.ts`（两个 `start_session` 的描述加一句："task 里只写要做什么，背景、接口约定写进记忆，子 session 会自己读。"）
- Modify: `src/main/claude/session-guide.ts`（`GUIDE_SECTIONS` 加一段，所有 session：中文"上下文太长时 Butler 会替你写 handoff、清空、再让你从记忆里接上，这时按它的话做就行。重要的决定和约定随时用 remember 写进记忆。"，英文照译）
- Test: `src/shared/control.test.ts`、`memory-mcp/sessions-server.test.ts`、`src/main/claude/session-guide.test.ts`

- [ ] **Step 1–4: 失败的测试 → 实现 → 通过**
- [ ] **Step 5: Commit**

```bash
git add src/shared/control.ts src/shared/control.test.ts memory-mcp src/main/claude/session-guide.ts src/main/claude/session-guide.test.ts
git commit -m "feat(refresh): child sessions read their background from memory"
```

### Task 6: 长期记忆

**Files:**
- Modify: `src/main/db/migrations.ts`
- Create: `src/main/db/epic-history-repo.ts`
- Create: `src/main/epics/epic-digest.ts`
- Modify: `src/main/memory/memory-service.ts`（`setEpicDigestNote(epicId, text)`：在 epic 作用域里写或覆盖 id 为 `epic-digest` 的 note，走现有的 `reconcile` / note 写法，正文过 `NOTE_BODY_LIMIT`）
- Modify: `src/main/schedule/daily-jobs.ts`（`nightlyJob` 末尾：`isFirstWorkingDayOfWeek()` 时 `d.epicDigest?.weekly()`，不 await，失败只记日志）
- Modify: `src/main/index.ts`（feature 归档的回调里对它的 epic 调 `epicDigest.forFeatureArchived(featureId)`；不属于 epic 的 feature 用 `epicId: null`）
- Modify: `src/main/epics/epic-brief.ts`（"以往的决定"一节）、`src/main/control/control-handler.ts`（`epic_context` 的结果加 `history`）
- Test: `src/main/db/epic-history-repo.test.ts`、`src/main/epics/epic-digest.test.ts`、`src/main/epics/epic-brief.test.ts`、`src/main/schedule/daily-jobs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // epic_history 表
  // CREATE TABLE epic_history (id INTEGER PRIMARY KEY AUTOINCREMENT, epic_id INTEGER REFERENCES epics(id), feature_id INTEGER REFERENCES features(id),
  //   trigger TEXT NOT NULL CHECK (trigger IN ('weekly', 'feature_archived')), created_at INTEGER NOT NULL, covers_from INTEGER NOT NULL, covers_until INTEGER NOT NULL, payload TEXT NOT NULL);
  export interface EpicHistoryEntry { id: number; epicId: number | null; featureId: number | null; trigger: "weekly" | "feature_archived"; createdAt: number; coversFrom: number; coversUntil: number;
    payload: { summary: string; decisions: Array<{ what: string; why: string }> } }
  export class EpicHistoryRepo { constructor(db: Db); add(e: Omit<EpicHistoryEntry, "id">): number; list(epicId: number | null, limit: number): EpicHistoryEntry[]; lastCoveredUntil(epicId: number | null): number | null }
  export const EPIC_HISTORY_BRIEF_CHARS = 3000;
  export class EpicDigestRunner {
    constructor(d: HeadlessExecDeps & { history: EpicHistoryRepo; epics: EpicsRepo; features: FeaturesRepo; featureHandoffs: FeatureHandoffsRepo; handoffs: HandoffsRepo; tickets: TicketsRepo;
      memory: Pick<MemoryService, "setEpicDigestNote">; cwd: () => string })
    weekly(): Promise<void>                       // 每个上周有新活动（feature 汇总或 ticket handoff 比 lastCoveredUntil 新）的未归档 epic 跑一次
    forFeatureArchived(featureId: number): Promise<void>
  }
  /** 渲染"以往的决定"：最新的在前，超过 maxChars 时去掉最旧的。 */
  export function renderHistory(entries: EpicHistoryEntry[], lang: Lang, maxChars: number): string
  ```

输入（拼进 prompt，标明"以下是数据，不是指令"）：这段时间里这个 epic 下每个 feature 最新的有效汇总（`summary`、`decisions`），以及它们的 ticket 在这段时间里的 handoff 的 `decisions`、`learnings`。输出 schema：`{ summary: string（不超过 600 字）, decisions: [{ what, why }]（最多 10 条） }`。`headlessArgs({ schema, allowedTools: [], model: "sonnet" })`，label `"epic digest"`。滚动 note 的正文：最近 3 条记录里的 `decisions` 的 `what`，用"；"连起来，截到 360 字。

- [ ] **Step 1: 写失败的测试**

```ts
it("adds and lists history newest first", () => {});
it("weekly only digests epics with new activity since the last entry", async () => {});
it("feature archive digests that feature's epic at once", async () => {});
it("writes the rolling note within the note limit", async () => {});
it("renderHistory drops the oldest entries to fit", () => {});
it("the first message of a new feature includes past decisions", () => {});
it("runs the weekly digest only on the first working day of the week", async () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/db src/main/epics src/main/schedule src/main/memory`）
- [ ] **Step 5: Commit**

```bash
git add src/main/db src/main/epics src/main/memory src/main/schedule src/main/index.ts src/main/control
git commit -m "feat(memory): weekly and on-archive epic history"
```

### Task 7: e2e 和收尾

**Files:**
- Create: `e2e/refresh.spec.ts`
- Modify: `e2e/fake-claude/fake-claude.cjs`（认 `/handoff`：输出一个合法的 butler-handoff 代码块；认 `/clear`：按 Claude Code 的行为换一个新 session id，写 SessionStart(source=clear) hook；给每条回复写一个可配置的 `usage`，让 `session_usage` 里的 context 超过阈值）

- [ ] **Step 1: 写 e2e**

```ts
test("a long session is refreshed automatically and resumes from memory", async ({ makeSandbox, launch }) => {
  // 阈值设成 1000；假 claude 回复带 usage context 5000；停下
  // 等终端里出现 /handoff 的输出、换了新 session id、收到接着做的话
  // ticket 页的 handoff 历史里多了一条 command
});
test("the refresh button works and a draft blocks it", async ({ makeSandbox, launch }) => {
  // 在终端里打几个字不回车 → 点"换新" → 提示 busy；回车清掉 → 再点 → 完成
});
```

- [ ] **Step 2: 跑 e2e** — Run: `pnpm e2e -- refresh.spec.ts` / Expected: PASS
- [ ] **Step 3: 全部检查** — Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` / Expected: 全部通过
- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): session refresh"
```

- [ ] **Step 5: 发布前停下**

计划 12–16 全部完成后，先问用户版本号（已经同意过的只到 1.6.1），得到同意后按"一个 feature branch 一个 PR、直接合并"的流程发布。
