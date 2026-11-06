# 「现在」页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 首页的简报换成全局的「现在」总览：所有进行中的工作按 epic → feature → ticket 排，每层可收起，最上面固定「需要你」；去掉简报和全部系统通知；侧边栏「现在」入口上显示红点和数字。

**Architecture:** 主进程用一个纯函数 `buildNowView` 把 tickets、features、epics、session、活动、PR 监视、合并排队、「需要你」的判断拼成一份 `NowView`，经 IPC 给渲染进程；渲染进程的 `NowPage` 只负责显示和跳转。「需要你」的第三种（停下来在向用户要东西）由 `NeedsYouTracker` 用 Haiku 看最后一条回复判断，按消息 id 缓存。卡住检测扩大到 Butler 开的所有 session。简报相关的主进程代码、IPC、设置项和系统通知整块删掉。

**Tech Stack:** TypeScript、Electron、React、node:sqlite、vitest、Playwright e2e（假 claude）。

**Spec:** `docs/superpowers/specs/2026-11-06-now-page-and-token-savings-design.md`（"「现在」页""简报和通知""去掉简报和通知"）

**依赖:** 计划 12（`api.usageSummary`、`UsageSummary`）、计划 13（`WatchedPr`、`api.prWatchList` 的数据来源 `prWatcher.statusOf`、`DeliveryGuard.needsYou`）。

## Global Constraints

- 除「需要你」的回复判断以外，整个页面不调模型。
- 判断用 Haiku（`--model haiku`），输入只有最后一条回复，最多 1500 字（`NEEDS_YOU_REPLY_CHARS = 1500`），不带工具，同时最多 2 个判断。每条回复（按 transcript 里的 `message.id`）只判断一次。判断失败或者超时：回复去掉末尾空白后以 `?` 或 `？` 结尾就算需要你，理由取最后一句（最多 80 字）。
- 配色只用 `styles.css` 里的变量（`--bg`、`--panel`、`--text`、`--muted`、`--danger`、`--ok`、`--pill-*`），浅色和深色主题都要看得清；不写死颜色。
- 每一层都能收起，收起状态用现有的 `useCollapsed`（存在 local-prefs 里）。
- 活动每 10 秒刷新（跟着现有的 `stateChanged`）；时长每 30 秒走一次（`useNow`）。
- 新文案中英两套：渲染进程 `strings.ts` / `strings-en.ts`，主进程 `src/main/strings.ts`。
- e2e 不抢焦点（沿用 `e2e/fixtures.ts`）。
- 不保留 ticket 页以外的简报入口；ticket 页里的 handoff 历史和 followup 不动。

## Review Focus

1. 一个 session 刚停下、最后一句是"已经推上去了，CI 在跑。"：不能出现在「需要你」里（不是问句，Haiku 也会说不需要）→ Task 2 的测试 `a plain status report is not needs-you`。
2. 用户回了「需要你」里的那个 session（它开始干活）：这一条马上消失，不等下一次判断 → Task 2 的测试 `clears once the session is busy again`。
3. Butler 外面开的、没归属 ticket 的 session：不出现在「现在」页 → Task 3 的测试 `ignores sessions Butler did not open`。
4. 深色主题下所有文字、标签、红点都看得清 → Task 5 的步骤"深色主题截图核对"。
5. 点「需要你」里一个 feature 总控的条目：打开 feature 页，并且切到这个总控的终端（不是第一个终端）→ Task 5 的测试 `opens the coordinator terminal it names`。

---

### Task 1: 卡住检测扩大范围，活动里认出 rebase

**Files:**
- Modify: `src/shared/activity.ts`（`ActivityKind` 加 `"rebase"`）
- Modify: `src/main/sessions/activity-parse.ts`（`classifyCommand` 认 `git rebase`、`git pull --rebase`）
- Modify: `src/main/sessions/activity-monitor.ts`（`StuckScope`、`scope()`、`StuckInfo`）
- Modify: `src/main/strings.ts`、`src/renderer/src/strings.ts`、`strings-en.ts`（`activityKinds.rebase`、`S.activity.rebase`："rebase 中" / "rebasing"）
- Test: `src/main/sessions/activity-parse.test.ts`、`src/main/sessions/activity-monitor.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface StuckScope { ticketKey: string | null; featureId: number | null; epicId: number | null }
  export interface StuckInfo { sessionId: string; ticketKey: string | null; featureId: number | null; epicId: number | null; reason: string }
  ```

`scope(head)`：`head.origin === "butler"` 且不是修复 session（`fixesSession === null`）就参与检测；ticket 已归档、feature 已归档的仍然排除。`ticketKey`、`featureId`（ticket 的或者 session 自己的）、`epicId`（session 自己的）照实填。`FeaturePage` 的 `StuckPanel` 只看 `featureId` 对得上的，不受影响。

- [ ] **Step 1: 写失败的测试**

```ts
it("classifies git rebase as rebase", () => { expect(classifyCommand("git rebase origin/main").kind).toBe("rebase"); expect(classifyCommand("git pull --rebase").kind).toBe("rebase"); });
it("checks coordinators and tickets outside features for stuck", async () => { /* 总控 session、没有 feature 的 ticket session 都进入采样 */ });
it("still skips fix sessions and archived tickets", async () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/sessions`）
- [ ] **Step 5: Commit**

```bash
git add src/shared/activity.ts src/main/sessions src/main/strings.ts src/renderer/src/strings.ts src/renderer/src/strings-en.ts
git commit -m "feat(activity): stuck checks for every Butler session, recognise rebase"
```

### Task 2: 「需要你」的回复判断

**Files:**
- Modify: `src/main/sessions/activity-parse.ts`（`TranscriptState` 加 `lastReplyId: string | null`，取那条 assistant 消息的 `message.id`）
- Modify: `src/main/claude/headless.ts`（`headlessArgs` 的参数加 `model?: string` → `--model <model>`，放在 `-p` 后面）
- Create: `src/main/sessions/needs-you.ts`
- Modify: `src/main/sessions/activity-monitor.ts`（`lastReplyOf(id): { id: string; text: string } | null`，不截到 500 字）
- Test: `src/main/sessions/needs-you.test.ts`、`src/main/claude/headless.test.ts`

**Interfaces:**
- Consumes: `execHeadlessJson`、`HeadlessExecDeps`（含计划 12 加的 `onUsage`）
- Produces:
  ```ts
  export const NEEDS_YOU_REPLY_CHARS = 1500;
  export interface NeedsYouVerdict { needsYou: boolean; reason: string }
  export function judgeNeedsYou(d: HeadlessExecDeps, reply: string, cwd: string): Promise<NeedsYouVerdict | null>
  /** 判断失败时的退路。 */
  export function fallbackNeedsYou(reply: string): NeedsYouVerdict
  export class NeedsYouTracker {
    constructor(d: {
      judge: (reply: string, cwd: string) => Promise<NeedsYouVerdict | null>;
      /** 开着终端的 Butler session 的 head：id、cwd、是否停着等输入、活动、最后一条回复。 */
      sessions: () => Array<{ id: string; cwd: string; waiting: boolean; kind: ActivityKind | null; reply: { id: string; text: string } | null }>;
      notify: () => void;
      log?: (msg: string, err?: unknown) => void;
    })
    /** 每个活动 tick 之后调：停着、活动是 waiting、回复 id 没判断过的，排队判断（最多 2 个同时）。 */
    update(): void
    /** 需要你时返回理由，否则 null。session 不再停着（或活动不是 waiting）时立刻返回 null。 */
    reasonOf(sessionId: string): string | null
  }
  ```

判断用的 prompt（中文版；英文版照译，理由用当前语言）：

```
下面是一个写代码的 Claude session 停下来时给用户看的最后一条消息。
判断：它是不是在等用户回答问题、做决定、或者去做某件事之后才能继续？
单纯汇报进度或结果、说"做完了"、说"在等 CI"，都不算。
用 JSON 回答：needs_user（布尔），reason（一句话，说它在等用户什么，不超过 30 个字；不需要就留空）。

消息：
<最后 1500 字>
```

`judgeNeedsYou` 的参数：`headlessArgs({ schema, allowedTools: [], model: "haiku" })`，label `"needs-you judge"`。

- [ ] **Step 1: 写失败的测试**

```ts
it("passes --model to headless args", () => { expect(headlessArgs({ schema: "{}", allowedTools: [], model: "haiku" })).toContain("--model"); });
it("judges each reply id once", async () => {});
it("a plain status report is not needs-you", async () => { /* 假 judge 返回 { needsYou:false } → reasonOf 为 null */ });
it("falls back to a trailing question mark when the judge fails", async () => { expect(fallbackNeedsYou("要拆成两个 PR 吗？").needsYou).toBe(true); expect(fallbackNeedsYou("推上去了。").needsYou).toBe(false); });
it("clears once the session is busy again", async () => { /* 判断为需要；sessions() 里 waiting 变 false → reasonOf null，不调 judge */ });
it("runs at most two judges at a time", async () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/sessions src/main/claude`）
- [ ] **Step 5: Commit**

```bash
git add src/main/sessions src/main/claude/headless.ts src/main/claude/headless.test.ts
git commit -m "feat(now): judge whether a stopped session is waiting on the user"
```

### Task 3: NowView

**Files:**
- Modify: `src/shared/types.ts`（下面的类型）
- Create: `src/main/now/now-view.ts`
- Test: `src/main/now/now-view.test.ts`

**Interfaces:**
- Consumes: `TicketView`、`FeatureView`、`EpicView`、`SessionActivity`、`WatchedPr`（计划 13）、`MergeEvent`
- Produces:
  ```ts
  export type NowTarget =
    | { page: "ticket"; key: string; sessionId: string | null }
    | { page: "feature"; id: number; sessionId: string | null }
    | { page: "epic"; id: number; sessionId: string | null };
  export interface NowRow {
    sessionId: string | null;          // 没有开着的 session、只有 PR 的行为 null
    ticketKey: string | null;
    title: string | null;
    repo: string | null;               // 一个 ticket 开了几个仓库的 session 时才填（basename）
    coordinator: boolean;
    activity: SessionActivity | null;
    mergeQueued: boolean;              // 这个 session 在合并总控的等待名单里
    needsYou: string | null;           // 理由；卡住时是卡住的 reason；approval 时是固定文案
    prs: WatchedPr[];
    /** 停着、不需要你、没有开着的 PR / CI：默认折起来。 */
    idle: boolean;
    /** 这个状态从什么时候开始（activity.startedAt，没有就用 session 的 lastActivityAt）。 */
    since: number | null;
    target: NowTarget;
  }
  export interface NowCounts { active: number; needsYou: number; stuck: number }
  export interface NowFeature { id: number | null; name: string; rows: NowRow[]; counts: NowCounts }
  export interface NowEpic { id: number | null; name: string; rows: NowRow[]; features: NowFeature[]; counts: NowCounts }
  export interface NowView { needsYou: NowRow[]; epics: NowEpic[]; running: number; merges: MergeEvent[] }
  // src/main/now/now-view.ts
  export interface NowInput {
    tickets: TicketView[]; features: FeatureView[]; epics: EpicView[];
    activity: (sessionId: string) => SessionActivity | null;
    needsYouReason: (sessionId: string) => string | null;
    prs: (ticketKey: string) => WatchedPr[];
    mergeQueued: (sessionId: string) => boolean;
    merges: MergeEvent[];
    approvalText: string;              // "等你确认"
  }
  export function buildNowView(i: NowInput): NowView
  ```

规则（spec"我的决定 ·「现在」页"）：
- 一行 = 一个开着终端的 Butler session（`SessionView.termId !== null` 且 `origin === "butler"`），或者一个没有开着的 session、但有 `state === "open"` 的 `WatchedPr` 的 ticket。
- 分组：epic 的总控 session → `NowEpic.rows`；feature 总控 → 那个 `NowFeature.rows` 的最前面；ticket 的行 → 它的 feature；feature 不属于 epic 的放进 `id: null` 的"无 epic"组；不属于 feature 的 ticket 放进"无 epic"组里一个 `id: null` 的 feature。
- `needsYou`：活动是 `approval` → `approvalText`；`activity.stuck === true` → 卡住的 reason；否则 `needsYouReason(id)`。
- `NowView.needsYou` 是全部 `needsYou !== null` 的行，按 `since` 从早到晚。
- 没有任何行的 epic、feature 不出现。
- `target`：ticket 行 → `{ page: "ticket", key, sessionId }`；feature 总控 → `{ page: "feature", id, sessionId }`；epic 总控 → `{ page: "epic", id, sessionId }`。

- [ ] **Step 1: 写失败的测试**

```ts
it("groups ticket rows under their feature and epic", () => {});
it("puts coordinators first in their group", () => {});
it("shows a ticket with an open PR and no open session", () => {});
it("ignores sessions Butler did not open", () => {});
it("splits a ticket with sessions in two repos into two rows with repo names", () => {});
it("collects needs-you from approvals, stuck and judged replies, oldest first", () => {});
it("marks quiet rows idle and counts per group", () => {});
it("drops empty epics and features", () => {});
```

- [ ] **Step 2–4: 失败 → 实现 → 通过**（`pnpm vitest run src/main/now`）
- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/now
git commit -m "feat(now): build the Now view from sessions, activity and PRs"
```

### Task 4: 去掉简报和系统通知

**Files:**
- Delete: `src/main/brief/`（`brief-service.ts`、`engine.ts`、`narrate.ts` 和它们的测试）、`src/main/db/briefs-repo.ts`、`src/main/db/marks-repo.ts`、`src/renderer/src/components/BriefPage.tsx`、`src/renderer/src/brief-view.ts`（+ test）、`src/shared/brief.ts`（类型还有人用就只删用不到的部分）
- Modify: `src/main/gateway/gateway.ts`（删 `narrate()` 和只给它用的代码）、`src/main/gateway/narrative.ts`（只给 narrate 用的就删文件）及其测试
- Modify: `src/main/schedule/daily-jobs.ts`（`nightlyJob` 去掉晚间小结和 `onEvening`；`morningJob` 去掉 `generateMorning` 和 `narrate`，只剩计划 13 留下的 tracker 刷新）
- Modify: `src/main/index.ts`（删 `showEveningNotification`、`showStuckNotification`、`showGateNotification` 和三个通知集合；`BriefService`、`briefs`、`briefNarrating`、`briefRefreshing` 相关的；`MergeGate` 的 `notify` 只剩 `notify()`；`ActivityMonitor` 的 `onStuck` 改成只 `notify()`）
- Modify: `src/shared/ipc.ts`（删 `briefsLatest`、`briefsRegenerate`、`briefsMark`、`appNavigate` 和 `AppNavigateRoute`）、`src/preload/index.ts`、`src/main/ipc/register.ts`、`src/renderer/src/api.ts`
- Modify: `src/renderer/src/App.tsx`（删 `onNavigate` 监听、`navNonce`、`stuckReveal`；`FeaturePage` 的 `reveal` / `onRevealed` 属性一并删掉）
- Modify: 设置页（`ScheduleSettings.tsx` 等）：去掉 `blockedDays`、`reviewWaitDays`、`staleDays` 三项（它们只给简报规则用）；`EDITABLE_SETTINGS` 里同时去掉，`settings-values.ts` 里的读取函数一并删
- Modify: `src/main/strings.ts`、`src/renderer/src/strings.ts`、`strings-en.ts`（删只给简报和通知用的文案）
- Modify: `docs/configuration.md`（删简报、晚间通知、三项简报设置的说明）
- Test: 跟着删掉和改掉的测试；`e2e/main-flow.spec.ts` 第 6 步在 Task 6 里改

不动：`merge_events` 表和 `IPC.mergeEvents`（「现在」页底部用）；`briefs` 表（不再读写，不加 migration）；`jobs` 表；ticket 页的 handoff 历史、followup。

- [ ] **Step 1: 删文件、改引用**
- [ ] **Step 2: 按类型检查的报错清理剩下的引用**

Run: `pnpm typecheck`
Expected: 没有报错

- [ ] **Step 3: 确认通知真的没了**

Run: `grep -rn "new Notification" src/main`
Expected: 没有结果

- [ ] **Step 4: 跑单元测试** — Run: `pnpm test` / Expected: 全部通过
- [ ] **Step 5: Commit**

```bash
git add -A src docs/configuration.md
git commit -m "feat(now)!: remove the brief, its settings and all system notifications"
```

### Task 5: NowPage 和侧边栏

**Files:**
- Modify: `src/shared/ipc.ts`（`IPC.nowView = "now:view"`，进 `INVOKE_CHANNELS`）、`src/main/ipc/register.ts`、`src/renderer/src/api.ts`（`api.nowView(): Promise<NowView>`）
- Modify: `src/main/index.ts`（构造 `NeedsYouTracker`，在 `ActivityMonitor` 的 `notify` 里先 `needsYou.update()`；`nowView` handler 调 `buildNowView`；计划 13 的 `DeliveryGuard` 的 `needsYou` 接 `(id) => needsYou.reasonOf(id) !== null`）
- Create: `src/renderer/src/components/NowPage.tsx`
- Create: `src/renderer/src/now-view.ts`（行文字的纯函数，便于测试）
- Modify: `src/renderer/src/App.tsx`（`home` 显示 `NowPage`；`refresh()` 里一起取 `api.nowView()`；`openTarget(t: NowTarget)`）
- Modify: `src/renderer/src/components/Sidebar.tsx`（"首页"按钮改名"现在"，后面有 `needsYou.length > 0` 时显示红点和数字）
- Modify: `src/renderer/src/components/WorkspaceParts.tsx`（`useSessionPanes` 加 `initialActive?: string | null`）、`FeaturePage.tsx`、`EpicPage.tsx`（加 `focusSession?: string | null` 属性，传给 `initialActive`）
- Modify: `src/renderer/src/styles.css`（`.now-*` 样式，只用变量）
- Modify: `src/renderer/src/strings.ts`、`strings-en.ts`
- Test: `src/renderer/src/now-view.test.ts`

**Interfaces:**
- Consumes: `NowView`（Task 3）、`api.usageSummary()`（计划 12）、`activityText`、`formatDuration`、`useNow`（`TicketActivity.tsx`）、`useCollapsed`、`merge-events-view.ts`
- Produces:
  ```ts
  // now-view.ts
  export function rowText(r: NowRow, S: UiStrings, now: number): { main: string; sub: string | null; tone: "ok" | "warn" | "danger" | "muted" }
  export function prPill(p: WatchedPr, S: UiStrings): { text: string; tone: "merged" | "approved" | "changes" | "pending" } | null
  export function groupSummary(c: NowCounts, S: UiStrings): string     // "3 个进行中 · 1 需要你"
  export function usageLine(u: UsageSummary, S: UiStrings): string     // "近 7 天：12.3M token · 缓存读取占 66% · 上下文超过 20 万的轮次占 63%"
  ```

页面结构（参考样稿 `.superpowers/brainstorm/45777-1793984679/content/overview-v2.html`）：
1. 标题"现在"，右边小字"N 个 session 在跑"。
2. 「需要你」：`view.needsYou` 不为空才显示；每条一行：ticket 号或"总控"、feature 名、理由、时长、"打开 →"。
3. 每个 epic 一个可收起的块（`useCollapsed("now:epic:<id|none>")`），标题后是 `groupSummary`；里面先是 epic 总控的行，再是每个 feature 的可收起块（`now:feature:<id|none>`）；feature 里 `idle` 的行收进一个默认收起的"空闲 N"（`now:idle:<featureId|none>`，默认收起）。
4. 行：ticket 号（等宽）、`rowText` 的 main 和 sub、PR 标签（`prPill`，CI 失败时标签用 `--pill-changes-*`，跑着用 `--pill-pending-*`）、时长；整行可点。
5. 底部："最近合并"（默认收起，用 `merge-events-view.ts` 的现有函数渲染 `view.merges`）；一行用量小字（`usageLine`，点开列出 `byKind`、`byModel`，默认收起）。用量每 60 秒重取一次，不跟每次 `stateChanged`。

`rowText` 的 main：`needsYou` 不为空 → "等你：<理由>"（tone danger）；`activity.stuck` → "卡住"（danger）；`mergeQueued` → "合并排队"（warn）；有活动 → `activityText(...).main`（ok）；没有 session、PR 的 ci 是 pending → "等 CI"（warn），failing → "CI 失败"（danger），否则按 review → "等 review" / "要修改" / "已批准"（muted）。

跳转 `openTarget`：ticket → `openTicket(key, sessionId ? { ticketKey: key, sessionId } : undefined)`（现有的 `pendingOpen` 流程会切到那个终端）；feature / epic → `setRoute({ page, id })` 并把 `sessionId` 传给页面的 `focusSession`。

- [ ] **Step 1: 写 `now-view.ts` 的失败测试**

```ts
it("needs-you rows read 等你 with the reason", () => {});
it("rows without a session read from their PR and CI", () => { /* ci failing → "CI 失败" */ });
it("merge queue beats the plain activity", () => {});
it("usageLine formats tokens and shares", () => { /* totalTokens 12_345_678 → "12.3M"；share 0.661 → "66%" */ });
it("groupSummary skips zero counts", () => {});
```

- [ ] **Step 2: 跑测试，确认失败** — Run: `pnpm vitest run src/renderer/src/now-view.test.ts` / Expected: FAIL
- [ ] **Step 3: 实现 `now-view.ts`、`NowPage.tsx`、IPC、App、Sidebar、`focusSession`**
- [ ] **Step 4: 跑测试和类型检查** — Run: `pnpm typecheck && pnpm test` / Expected: PASS
- [ ] **Step 5: 深色主题截图核对**

Run: `pnpm dev`，系统切到深色模式，打开「现在」页，开两个 ticket session，让其中一个问一个问题停下。用 `/run` 技能或手动截图。
Expected: 所有文字、标签、红点在深色背景上清楚可读；「需要你」里出现问问题的那个 session，并带理由；点它打开那个终端。浅色模式再看一遍。

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/register.ts src/main/index.ts src/renderer/src
git commit -m "feat(now): the Now page replaces the brief as the home page"
```

### Task 6: e2e

**Files:**
- Modify: `e2e/main-flow.spec.ts`（第 6 步：不再看早间简报，改成回到「现在」页，看到这个 ticket 的行，点它回到同一个终端）
- Create: `e2e/now.spec.ts`
- Modify: `e2e/fake-claude/fake-claude.cjs`（如需要：让假 claude 能输出一条以问号结尾的回复然后停下；假 claude 不会被 Haiku 判断——e2e 里 headless 判断失败，走问号退路）

- [ ] **Step 1: 写 `now.spec.ts`**

```ts
test("a session that asks a question shows up under 需要你 and opens its terminal", async ({ makeSandbox, launch }) => {
  // 建 ticket、开 session，假 claude 回复"要把它拆成两个 PR 吗？"并停下
  // 「现在」页：.now-needs 里有这个 ticket；侧边栏"现在"后面有红点和 1
  // 点"打开 →"：进入 ticket 页，活动的终端是这个 session
});
test("groups collapse and stay collapsed after a refresh", async ({ makeSandbox, launch }) => {});
```

- [ ] **Step 2: 跑 e2e** — Run: `pnpm e2e -- now.spec.ts main-flow.spec.ts` / Expected: PASS（窗口在后台，不抢焦点）
- [ ] **Step 3: 跑全部 e2e** — Run: `pnpm e2e` / Expected: PASS（Windows 上跳过的照旧跳过）
- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): Now page and needs-you"
```
