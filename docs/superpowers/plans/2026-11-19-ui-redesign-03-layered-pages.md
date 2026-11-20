# UI 重做第 3 层：epic / feature / ticket 页分层、总控页、「Butler 自己」各页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 epic、feature、ticket 三种页面改成「默认层只答一个问题、细节进 tab、tab 记住上次」，总控页改成左终端右对话，「Butler 自己」三页（复盘与规矩、效果与花费、审计）各加一句话说明和一个主层重点，并把被新状态模型取代的旧组件、旧 tab、旧算法删干净。

**Architecture:** 状态一律来自第 1 层的 `turn:board`，页面不再自己算 PR 状态；每页拆成「取数据的薄壳 + 只吃 props 的展示组件 + 纯函数 view 文件」，展示组件用 `renderToStaticMarkup` 测，纯函数直接测。`PageTabs` 改成永远展开、只有一个选中 tab（去掉收起），tab 记在 `local-prefs`，从「轮到你」进来时由纯函数 `landingTab(turn)` 指定落点。对话、总控右栏先放现有的汇报内容，各留一个挂载点给第 5 层。

**Tech Stack:** Electron、React 18、TypeScript、vitest（`src/**/*.test.ts`，环境 node，渲染测试用 `react-dom/server`）、Playwright e2e。

**Spec:** `docs/superpowers/specs/2026-11-19-ui-redesign-design.md`（§5.2 分层规矩、§5.3 epic 页 / ticket 页 / 总控页 / Butler 自己）；索引和共用接口：`docs/superpowers/plans/2026-11-19-ui-redesign-00-index.md`；草图：`.superpowers/brainstorm/1247-1795150005/content/full-mockup.html`（`#p-epic`、`#p-ticket`、`#p-butler`、`#p-lessons`、`#p-effect`、`#p-audit`）。

## 对前两层的假设（开工前先核对，对不上就只改本计划里引用的名字）

- 第 1 层：`src/shared/turn.ts` 按索引文件导出 `Turn`、`TurnItem`、`ScopeTurnRow`、`TurnBoard`、`ticketTurn`、`TURN_PRIORITY`；`src/renderer/src/api.ts` 有 `api.turnBoard(filter?)`、`api.onTurnChanged(cb)`、`api.turnSendToAgent(item)`；`src/renderer/src/turn-text.ts` 导出 `turnSentence(turn: Turn, item: TurnItem, t: UiStrings): string`。`turn:board({epicId})` 的 `scopes` 是「该 epic 下每个 feature 一行（`kind: "feature"`，`id` 是 feature id）」；`turn:board({featureId})` 的 `scopes` 是「该 feature 下每个 ticket 一行」；`turn:board({ticketKey})` 的 `items` 含该 ticket 每个 PR 一条（`pr` 非 null）和 session 级一条（`pr: null`）。`items` 里还有 `agent`、`external`、`done` 的条目（不止 `you`）。待决定（`ask_user`）已算进 `you/answer`。
- 第 2 层：`src/renderer/src/components/TurnCard.tsx` 导出 `TurnCard({ item }: { item: TurnItem })`；CSS 变量 `--turn-you`、`--turn-agent`、`--turn-external`、`--turn-done`、`--turn-idle` 已在 `styles.css`；`Route` 里的 `progress` 页、侧栏进度入口、`NowPage`、`ProgressPage.tsx` 已删。`TurnCard` 的「去看看」跳 ticket 页时是 `setRoute({ page: "ticket", key })`（本层 Task 1 给它补 `landing`）。
- 第 5 层会提供 `src/renderer/src/components/ConversationTab.tsx`（props 见 Task 5）；本层只放占位。

## Global Constraints

- 文案中英都要有：每个新键同时加到 `src/renderer/src/strings.ts` 和 `strings-en.ts`，`strings.test.ts` 要求两边键、类型、函数参数个数完全一致，英文里不能有汉字。英文数字旁用 ASCII 标点。
- 测试命令：`pnpm test`（= `vitest run`）、`pnpm typecheck`、`pnpm lint`、`pnpm e2e`（先 build）。e2e 里的 ticket 号必须带数字，如 `E2E-7`。
- 3.0 的功能默认全关，Butler 默认不对外做任何事；本层不新增任何对外动作。
- 不能留两套状态算法：用到 PR/ticket 状态的地方只调 `turn:board`、`ticketTurn`、`turnSentence`，不再看 `prPill`、`waitingOnOf`、`epicRowText`。
- 一页只回答一个问题，默认层不用滚动就能看完；不用你动手的东西只显示成数字或放进默认折起的块。
- 谁该动的颜色只用 `--turn-*` 变量；风险、费用这类信息写成文字，不上色。
- 设置页归第 6 层，本层不动 `SettingsPage`。

## Review Focus

1. **没有 PR 的 ticket**：概况写「还没开 PR」，不出「打开 PR」，PR 阶段那行不出现「0/6」；表格 PR 列写「—」；`ticketTurn` 只有 session 那一条时句子照样出来。（Task 2 的 `ticketRows`、Task 4 的 `prStageLine` 和 `mainActions`）
2. **多个 PR / 多个 session 的 ticket**：概况那一句取最急的 PR，后面带「另有 N 个 PR」；终端 tab 的 session 切换列出所有可见 session；`ConversationTab` 的 `sessions` 列表包含所有可见 session，`rootSessionId` 取主 session 的链根。（Task 2、Task 4、Task 5）
3. **epic 下没有 feature、空 epic、feature 下没有 ticket**：概况显示一句空状态加「新建」按钮；进度条总数为 0 时不画条、不出 NaN；「全部 ticket」表显示空状态而不是只剩表头。（Task 2 的 `progressLine`、`barSegments`，Task 6、7、8 的渲染测试）
4. **上下文用量未知**：session 没开着、`session_usage` 里没有记录、换新阈值设成 0（自动换新关）时，不显示「快要换新了」，也不显示 `NaN/150k`。（Task 3、Task 4 的 `contextLine`）
5. **agent 最后说的话取不到**（终端没开着，`ActivityMonitor` 没在跟这个 session）、**`turn:board` 还没取回来**、**记住的 tab 已经不存在**（比如 feature 页的「进行中」被去掉后旧存储里有它）：概况写一句说明而不是留空；加载中不闪空状态；`resolveTab` 回到默认 tab。（Task 1、Task 4）

---

## 文件结构

新建（`src/renderer/src/` 下，除非另写）：

| 文件 | 职责 |
|---|---|
| `ticket-tabs.ts` | `TICKET_TABS`、`SCOPE_TABS`、`landingTab(turn)` |
| `scope-view.ts` | epic/feature 页的纯函数：`ticketRows`、`groupByFeature`、`runningRows`、`progressLine`、`slowestLine`、`barSegments`、`whoLabel`、`prTag` |
| `ticket-view.ts` | ticket 概况的纯函数：`mainActions`、`contextLine`、`prStageLine`、`primarySession`、`conversationSessions`、`clipSaid` |
| `use-turn-board.ts` | `useTurnBoard(filter)`（第 2 层已有同名 hook 就复用，不新建） |
| `components/ScopeParts.tsx` | 共用展示组件：`WhoTag`、`ScopeBar`、`ScopeOverview`、`ScopeRunning`、`ScopeTicketTable`、`ControlSplit` |
| `components/ControlConversation.tsx` | 总控右栏：汇报按时间排的列表；**第 5 层的挂载点** |
| `components/TicketHome.tsx` | ticket「概况」tab |
| `components/TicketTerminalTab.tsx` | ticket「终端」tab（仓库条、session 条、提示条、终端，从 `TicketPage` 搬出来） |
| `components/TicketPrTab.tsx` | ticket「PR 详情」tab |
| `components/TicketLogTab.tsx` | ticket「记录」tab（从 `TicketOverview.tsx` 改名） |
| `components/ConversationPlaceholder.tsx` | 对话 tab 占位（第 5 层换成 `ConversationTab`） |
| `components/EpicSummaryTab.tsx` | epic「AI 总结」tab |
| `src/shared/ticket-glance.ts`、`src/main/tickets/ticket-glance.ts` | `ticket:glance` 的类型和实现 |

重写：`PageTabs.tsx`、`page-tabs.ts`、`EpicPage.tsx`、`FeaturePage.tsx`、`TicketPage.tsx`、`ButlerPage.tsx`；改：`LessonsPage.tsx`、`EffectPage.tsx`、`AuditPage.tsx`、`App.tsx`、`local-prefs.ts`、`styles.css`。

---

### Task 1: 页签机制（永远展开、记住上次、落点）

**Files:**
- Create: `src/renderer/src/ticket-tabs.ts`、`src/renderer/src/ticket-tabs.test.ts`
- Modify: `src/renderer/src/page-tabs.ts`、`page-tabs.test.ts`、`components/PageTabs.tsx`、`components/page-tabs-render.test.ts`、`local-prefs.ts`、`local-prefs.test.ts`、`styles.css`（`.page-tabs*` 一段）、`strings.ts` / `strings-en.ts`（删 `tabCollapseHint`、`tabToggleCollapseHint`、`tabToggleExpandHint`、`tabCollapse`、`tabExpand`）、`App.tsx`（`Route` 的 ticket 项）、第 2 层的 `components/TurnCard.tsx`（只改「去看看」的跳转）
- Test: 上面各 `*.test.ts`

**Interfaces:**
- Consumes: `Turn`（`src/shared/turn.ts`）。
- Produces:
  ```ts
  // ticket-tabs.ts
  export const TICKET_TABS = ["overview", "conversation", "terminal", "pr", "log"] as const;
  export type TicketTab = (typeof TICKET_TABS)[number];
  export const SCOPE_TABS = ["overview", "running", "tickets", "control", "summary"] as const;
  export type ScopeTab = (typeof SCOPE_TABS)[number];
  export function landingTab(turn: Turn): TicketTab;
  // page-tabs.ts（删掉 TabState、readTabState、tabIsOpen、clickTab、toggleTabs，保留 pickTab）
  export function resolveTab(saved: string | null, forced: string | null | undefined, ids: readonly string[], fallback: string): string;
  // PageTabs props
  { page: string; tabs: PageTab[]; defaultTab: string; forceTab?: string | null; actions?: ReactNode }
  // App.tsx
  | { page: "ticket"; key: string; landing?: boolean }
  ```

- [ ] **Step 1: 写 `landingTab` 的失败测试**（`ticket-tabs.test.ts`）。规则就是下表，每行一条断言：

  | Turn | 落点 | 理由 |
  |---|---|---|
  | `you/answer`、`you/stuck`（任何 source）、`you/unattended` 且 `why === "agent_stopped"` | `terminal` | 要在终端里回话或看现场；第 5 层把前两种改成 `conversation` |
  | `you/unattended` 的其余 `why`（`ci_failing`、`changes_requested`、`conflicts`、`behind`、`draft`、`no_reviewer`、`ci_undelivered`） | `pr` | 要看 CI、评论 |
  | `external/*` | `pr` | 看在等什么 |
  | `you/merge`、`you/review`、`you/butler`、`agent/*`、`done`、`idle` | `overview` | 主按钮就在概况里 |

- [ ] **Step 2: 运行确认失败**：`pnpm vitest run src/renderer/src/ticket-tabs.test.ts`，预期 FAIL（找不到 `landingTab`）。
- [ ] **Step 3: 实现 `ticket-tabs.ts`**，纯函数，按上表 `switch`。
- [ ] **Step 4: 改 `page-tabs.test.ts`**：删掉 `clickTab`、`toggleTabs`、`readTabState` 的用例，加 `resolveTab`：`resolveTab("log", null, ids, "overview") === "log"`；`resolveTab("gone", null, ids, "overview") === "overview"`；`resolveTab("log", "pr", ids, "overview") === "pr"`（落点压过记着的）；`resolveTab(null, "nope", ids, "overview") === "overview"`（落点不存在就当没有）；`resolveTab("", null, [], "x") === ""`。实现 `resolveTab`（落点有效 > 记着的有效 > fallback > 第一个）。
- [ ] **Step 5: 重写 `PageTabs.tsx`**：没有展开/收起，永远有一个选中 tab；`forceTab` 变化时 `saveTab(page, forceTab)` 并立刻选中（落点也被记住）；去掉 toggle 按钮和 `collapsed` 类；`aria-selected` 只给选中的；`actions` 仍放 tab 条右边。`local-prefs.ts` 删 `savedTabOpen`、`saveTabOpen`（旧键 `butler.tabOpen:*` 留在存储里不管）。
- [ ] **Step 6: 改 `page-tabs-render.test.ts`**：渲染 `PageTabs`（`page: "test-page"`，两个 tab，默认 `overview`），断言：HTML 含 `aria-selected="true"` 恰好一个、含默认 tab 的内容、不含 `page-tabs-toggle`、不含 `collapsed`；带 `className: "attention"` 的 tab 仍有该类和 `<span class="count">3</span>`。
- [ ] **Step 7: CSS**：`.page-tabs` 改成 `flex: 1 1 auto; min-height: 0`，`.page-tabs-panel` `flex: 1 1 auto; overflow-y: auto`；删 `.page-tabs.collapsed`、`.page-tabs-toggle` 相关规则；加 `.who`、`.who-you/-agent/-external/-done/-idle`（颜色取 `--turn-*`）和 `.scope-bar`（分色进度条，四段按 `--turn-*`）、`.control-split`（`display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-height: 0`，窄窗口 `@media (max-width: 900px)` 改单列）。
- [ ] **Step 8: App 与 TurnCard**：`Route` 的 ticket 项加 `landing?: boolean`；`App.tsx` 里 `openTicket` 保持不变，`TurnCard` 里「去看看」改成带 `landing: true` 的 `setRoute`（经第 2 层的跳转回调，不新增别的入口）。`TicketPage` 在 Task 5 读它。
- [ ] **Step 9: 删旧字符串后运行** `pnpm vitest run src/renderer/src && pnpm typecheck`，预期 PASS。
- [ ] **Step 10: Commit** `refactor(ui): page tabs always open, remember last tab, landing tab rule`

---

### Task 2: 范围页（epic / feature）的纯函数和共用展示件

**Files:**
- Create: `src/renderer/src/scope-view.ts`、`scope-view.test.ts`、`use-turn-board.ts`（第 2 层已有就跳过）、`components/ScopeParts.tsx`、`components/scope-parts-render.test.ts`
- Modify: `strings.ts`、`strings-en.ts`（新增 `S.lay`，键见文末「文案表」）

**Interfaces:**
- Consumes: `TurnItem`、`Turn`、`ScopeTurnRow`、`ticketTurn`、`turnSentence`（第 1 层）；`TicketView`（`src/shared/types.ts`）。
- Produces:
  ```ts
  // scope-view.ts
  export interface TicketRow {
    key: string; title: string | null; featureId: number | null;
    turn: Turn; others: number; item: TurnItem; since: number;
    prs: { tag: string; number: number; repo: string }[];
  }
  export function ticketRows(tickets: Pick<TicketView, "key" | "title" | "featureId" | "effectiveStatus">[], items: TurnItem[]): TicketRow[];
  export function groupByFeature(rows: TicketRow[], features: { id: number; name: string }[]): { feature: { id: number; name: string }; rows: TicketRow[]; merged: number }[];
  export function runningRows(rows: TicketRow[]): TicketRow[];
  export function progressLine(r: Pick<ScopeTurnRow, "total" | "merged" | "youCount">, S: UiStrings): string;
  export function slowestLine(slowest: string | null, S: UiStrings): string;
  export function barSegments(bar: ScopeTurnRow["bar"], total: number): { owner: "done" | "agent" | "you" | "external" | "idle"; pct: number }[];
  export function whoLabel(turn: Turn, S: UiStrings): string;
  export function prTag(pr: { repo: string; number: number }, multiRepo: boolean): string;
  // use-turn-board.ts
  export function useTurnBoard(filter?: { epicId?: number; featureId?: number; ticketKey?: string }): TurnBoard | null;
  // ScopeParts.tsx（全是只吃 props 的展示组件）
  export function WhoTag({ turn }: { turn: Turn }): JSX.Element;
  export function ScopeBar({ bar, total }: { bar: ScopeTurnRow["bar"]; total: number }): JSX.Element | null;
  ```

- [ ] **Step 1: 写 `scope-view.test.ts`**，断言（先让它们失败）：
  - `ticketRows`：一个 ticket 有两个 PR 的 items（`ci_running` 的 external、`ci_failing` 的 you/unattended）和一条 session 级 item → 返回一行，`turn.owner === "you"`、`others === 1`、`item` 是那条 you 的 item；ticket 没有任何 item 且 `effectiveStatus: "done"` → `turn` 是 `{owner:"done",kind:"merged"}`；没有 item 且状态不是 done → `{owner:"idle",kind:"not_started"}`，两种都有合成的 `item`（`ticketKey` 对、`pr: null`、`since: 0`）；`prs` 按 PR 号升序，只有一个仓库时 `tag` 是 `#52`，多个仓库时是 `app#52`。
  - `groupByFeature`：按传入的 feature 顺序；`featureId: null` 的行归不进任何组（不丢，放最后一组 `feature: { id: 0, name: "" }` 之外？——不要：这种行在 epic 里不会出现，直接忽略）；`merged` 数 `owner === "done"` 的行；feature 下没有 ticket 也返回该组（`rows: []`）。
  - `runningRows`：只留 `agent`、`external`，`since` 小的（等得久的）在前。
  - `progressLine`：`{total:15, merged:9, youCount:2}` → `15 个里合了 9 个 · 2 件轮到你`；`youCount: 0` → `15 个里合了 9 个 · 没有事轮到你`；`total: 0` → `还没有 ticket`。英文对应 `9 of 15 merged · 2 waiting on you` / `… · nothing waiting on you` / `No tickets yet`。
  - `slowestLine("收尾 R/X", S)` → `最慢的是「收尾 R/X」。`；`null` → `没有明显落后的。`
  - `barSegments({done:9,agent:3,you:2,external:1,idle:0}, 15)`：百分比之和 100（用最大余数法取整），`idle: 0` 的段不出现；`total: 0` → `[]`。
  - `whoLabel`：`you` → `你`，`agent` → `agent`，`external` → `names.join("、")`，`names` 为空 → `外部`，`done` → `合了`，`idle` → `没开始`。
- [ ] **Step 2: 运行**：`pnpm vitest run src/renderer/src/scope-view.test.ts`，预期 FAIL。
- [ ] **Step 3: 实现 `scope-view.ts`**。`ticketRows` 用 `ticketTurn(prTurns, sessionTurn)` 取 `{turn, others}`，`item` 取 `items` 里 `turn` 引用相同的那条；不重新判断任何 PR 状态。
- [ ] **Step 4: 实现 `useTurnBoard`**：和 `useStateRefetch` 同样的防抖重取，但订阅 `api.onTurnChanged`，key 是 `JSON.stringify(filter)`；没取到返回 `null`。
- [ ] **Step 5: 写 `scope-parts-render.test.ts`**：`WhoTag` 渲染 `you` 出现 `class="who who-you"` 和文字 `你`；`ScopeBar` `total: 0` 返回空串（`renderToStaticMarkup` 结果为 `""`）；`total > 0` 时每段 `style="width:N%"`。
- [ ] **Step 6: 实现 `ScopeParts.tsx` 的 `WhoTag`、`ScopeBar`**（后面几个展示组件在 Task 6 加进同一个文件）。
- [ ] **Step 7: 加文案**（`S.lay` 里与本任务有关的键，见「文案表」），运行 `pnpm vitest run src/renderer/src && pnpm typecheck`，预期 PASS。
- [ ] **Step 8: Commit** `feat(ui): scope view helpers and shared turn parts`

---

### Task 3: `ticket:glance`（agent 最后说的话、换新所需上下文、链根）

**Files:**
- Create: `src/shared/ticket-glance.ts`、`src/main/tickets/ticket-glance.ts`、`src/main/tickets/ticket-glance.test.ts`
- Modify: `src/shared/ipc.ts`（`IPC.ticketsGlance = "tickets:glance"`，加进 `INVOKE_CHANNELS`）、`src/main/metrics/interventions.ts`（加进 `NOT_TRIGGERS` 的「只读」一组）、`src/main/ipc/register.ts`（`handle(IPC.ticketsGlance, …)`，`Deps` 加 `ticketGlance: (ticketKey: string) => TicketGlance`）、`src/main/index.ts`（拼 deps）、`src/renderer/src/api.ts`（`ticketGlance`）

**Interfaces:**
- Produces:
  ```ts
  // src/shared/ticket-glance.ts
  export interface TicketGlance {
    /** 主 session 链的根（第 5 层的对话按它存）；ticket 没有 session 为 null。 */
    rootSessionId: string | null;
    /** 最近一个有回复的 session 的最后一条回复；终端没开着（ActivityMonitor 没在跟）为 null。 */
    lastSaid: { text: string; at: number | null } | null;
    /** 主 session 最近一轮的上下文 token 数和自动换新阈值（0 = 关）；没有用量记录为 null。 */
    context: { tokens: number; threshold: number } | null;
  }
  // src/main/tickets/ticket-glance.ts
  export interface GlanceDeps {
    /** 这个 ticket 的 session 的 head，最近活动的在前（和 TicketView.sessions 同一份）。 */
    headsOf(ticketKey: string): Pick<Session, "id" | "fixesSession">[];
    rootOf(id: string): string | null;
    lastReplyOf(id: string): { id: string; text: string; at: number | null } | null;
    contextOf(id: string): number | null;
    threshold(): number;
  }
  export function ticketGlance(ticketKey: string, d: GlanceDeps): TicketGlance;
  ```
- 主 session = `headsOf` 里第一个 `fixesSession === null` 的；没有就取第一个；`lastSaid` 取按顺序第一个有回复的 head（修复 session 也算）。

- [ ] **Step 1: 写 `ticket-glance.test.ts`**：无 session → 三项全 `null`；两个 session，第一个没回复、第二个有 → `lastSaid` 是第二个的；主 session 有 `contextOf = 148000`、`threshold = 150000` → `context: {tokens:148000, threshold:150000}`；`contextOf` 返回 `null` → `context: null`；`threshold = 0` 时 `context` 仍返回（`threshold: 0`），由界面决定不提示；`rootOf` 返回链根而不是 head；`fixesSession` 非空的排在前面时主 session 跳过它。
- [ ] **Step 2: 运行确认失败**：`pnpm vitest run src/main/tickets/ticket-glance.test.ts`。
- [ ] **Step 3: 实现 `ticketGlance` 和接线**。`index.ts` 里：`headsOf: (k) => sessions.listByTicket(k)`（沿用 `TicketView.sessions` 取 head 的方式），`rootOf: (id) => sessions.rootOf(id)`，`lastReplyOf: (id) => activityMonitor.lastReplyOf(id)`，`contextOf`（`index.ts:529` 已有），`threshold: () => refreshThreshold(settings)`。
- [ ] **Step 4: 通道登记**：仓库里有测试检查每个 `INVOKE_CHANNELS` 都被分类（`interventions.ts` 的集合）；运行 `pnpm vitest run src/main/metrics src/main/ipc src/shared`，预期 PASS（没加进 `NOT_TRIGGERS` 会在这里失败）。
- [ ] **Step 5: `api.ts` 加 `ticketGlance: (key: string) => call<TicketGlance>(IPC.ticketsGlance, key)`**；`pnpm typecheck`。
- [ ] **Step 6: Commit** `feat(ipc): ticket glance (last reply, context, chain root)`

---

### Task 4: ticket「概况」tab

**Files:**
- Create: `src/renderer/src/ticket-view.ts`、`ticket-view.test.ts`、`components/TicketHome.tsx`、`components/ticket-home-render.test.ts`
- Modify: `strings.ts`、`strings-en.ts`

**Interfaces:**
- Consumes: `ticketRows`（Task 2）、`turnSentence`、`TicketGlance`（Task 3）、`PrStagesView`（`src/shared/pr-stages.ts`）、`landingTab` 的 `TicketTab`（Task 1）。
- Produces:
  ```ts
  export interface MainAction { id: "open_pr" | "answer" | "look" | "fix" | "send" | "pr_details"; label: string; primary: boolean; goTab?: TicketTab }
  export function mainActions(turn: Turn, o: { hasPr: boolean; canFix: boolean }, S: UiStrings): MainAction[];
  export function contextLine(ctx: TicketGlance["context"], S: UiStrings): { text: string; nearRefresh: boolean };
  export function prStageLine(rows: PrStagesView[], S: UiStrings): string;
  export function primarySession(sessions: SessionView[]): SessionView | null;
  export function conversationSessions(sessions: SessionView[], S: UiStrings): { id: string; label: string }[];
  export function clipSaid(text: string, max?: number): string;   // 默认 280 个字符，超出加 …
  // TicketHome props（只吃数据）
  { ticket: TicketView; row: TicketRow | null; glance: TicketGlance | null; stages: PrStagesView[] | null;
    onGoTab: (t: TicketTab) => void; onOpenPr: (url: string) => void; onSend: () => void; onFix: () => void }
  ```

- [ ] **Step 1: 写 `ticket-view.test.ts`**：
  - `mainActions`：`you/merge` 且 `hasPr` → `[open_pr 主按钮]`；`you/merge` 且 `!hasPr`（不该发生，防御）→ `[]`；`you/answer` → `[answer, goTab:"terminal"]`；`you/stuck` → `[look(terminal)]`，`canFix` 时再加 `fix`；`you/unattended` 且 `canSend` → `[send, pr_details]`，不能送则只有 `pr_details`（`agent_stopped` 是 `look(terminal)`）；`agent/*`、`external/*`、`done`、`idle`、`you/butler` → `[]`。
  - `contextLine`：`{tokens:148000, threshold:150000}` → `{text:"148k / 150k", nearRefresh:true}`（≥ 阈值 80% 即 `nearRefresh`）；`{tokens:30000, threshold:150000}` → `nearRefresh:false`；`threshold:0` → `{text:"30k（自动换新已关）", nearRefresh:false}`；`null` → `{text:"还不知道", nearRefresh:false}`。
  - `prStageLine`：`[]` 或全是 `noPr` → `还没开 PR`；一行 `stages` 里 6 个有 5 个 `done` → `6 个阶段走完 5 个`；两个未关闭的 PR 行 → 取 `newestRow` 那行再加 `· 另有 1 个 PR`；全部 `closed` → 取最新一行并加 `（已关闭）`。
  - `primarySession`：优先非修复（`fixesSession === null`）、非 `spawnedBy` 的最近一个；全是修复 session 时取第一个；空数组 `null`。`conversationSessions` 返回所有可见 session 的 `{id, label: sessionLabel(...)}`，修复 session 标签前加 `S.lay.fixPrefix`。
  - `clipSaid("a".repeat(300))` 长度 281 且以 `…` 结尾；短文本原样；按字符（不切开代理对）。
- [ ] **Step 2: 运行确认失败**：`pnpm vitest run src/renderer/src/ticket-view.test.ts`。
- [ ] **Step 3: 实现 `ticket-view.ts`**。`prStageLine` 复用 `pr-stages-view.ts` 的 `newestRow`（把参数包成 `{rows}` 即可）。
- [ ] **Step 4: 写 `ticket-home-render.test.ts`**（`renderToStaticMarkup(createElement(TicketHome, props))`）：
  - 可合并：含 `turnSentence` 的句子、主按钮文字 `打开 PR`、`agent 最后说的` 区块、基本信息里分支和 `148k / 150k` 和 `快要换新了（对话不会丢）`。
  - 没有 PR（`stages: []`）：含 `还没开 PR`，不含 `打开 PR`。
  - `glance.lastSaid === null`：含 `S.lay.lastSaidNone`；`glance === null`（还没取到）：不含该文案、不含 `NaN`。
  - `row === null`（`turn:board` 还没回来）：渲染占位骨架，不渲染「没开始」。
  - 多 PR：`row.others = 1` → 含 `另有 1 个 PR`。
- [ ] **Step 5: 实现 `TicketHome.tsx`**（展示件）和同文件导出的取数薄壳 `TicketHomeTab({ ticket, onGoTab, onFix })`：`useTurnBoard({ ticketKey })` + `useStateRefetch(\`glance:${key}\`, () => api.ticketGlance(key))` + `usePrStages({ ticketKey })`；`onOpenPr` 调 `api.prOpen(url)`（失败 `reportError`），`onSend` 调 `api.turnSendToAgent({ ticketKey, pr })`。PR 的 url 从 `stages` 里按 `prNumber` 找。「看完整对话」按钮 `onGoTab("conversation")`。
- [ ] **Step 6: 加文案、运行** `pnpm vitest run src/renderer/src && pnpm typecheck`，预期 PASS。
- [ ] **Step 7: Commit** `feat(ui): ticket overview tab`

---

### Task 5: ticket 页五个 tab（概况、对话、终端、PR 详情、记录）

**Files:**
- Create: `components/TicketTerminalTab.tsx`、`components/TicketPrTab.tsx`、`components/ConversationPlaceholder.tsx`、`components/ticket-page-render.test.ts`
- Rename + modify: `components/TicketOverview.tsx` → `components/TicketLogTab.tsx`
- Modify: `components/TicketPage.tsx`、`App.tsx`、`styles.css`
- Delete: `TicketOverview` 里的 `overview-bar`（followups / history / memory 三个切换按钮）及 `.overview*` CSS、`components/TicketOverview.tsx` 里对 `prLabel` 的使用

**Interfaces:**
- Consumes: `TicketHomeTab`（Task 4）、`landingTab`、`PageTabs`（Task 1）、`ticketRows` 的 `turn`、`conversationSessions`、`primarySession`、`TicketGlance.rootSessionId`（Task 3）。
- Produces（**第 5 层的挂载点**）:
  ```ts
  // components/ConversationPlaceholder.tsx —— 第 5 层把 TicketPage 里的这一处换成 ConversationTab，props 一致
  export function ConversationPlaceholder(p: { rootSessionId: string | null; sessions: { id: string; label: string }[] }): JSX.Element;
  // 第 5 层的组件（本层不实现）：
  // ConversationTab({ rootSessionId: string; sessions: { id: string; label: string }[] })
  ```
  `TicketPage` 里 tab 内容写成 `rootSessionId ? <ConversationPlaceholder …/> : <p className="muted">{S.lay.convNoSession}</p>`，换组件只改这一行。

- [ ] **Step 1: 写 `ticket-page-render.test.ts`**：把 `TicketPage` 拆出一个只吃 props 的 `TicketTabs({ ticket, active, … })` 太重；改为分别渲染各 tab 组件：
  - `TicketPrTab` 的展示件（`TicketPrBody({ stages, review, comments })` 里只摆三个现有组件的位置）含三个小标题 `阶段`、`CI · review · 风险 · 就绪`、`未处理的评论`；没有 PR 时第一个组件渲染 `S.prNoRepos`/`S.prNoPrYet`，页面不抛错。
  - `TicketLogTab`（现 `TicketOverview`）渲染后含三个小节标题 `待跟进`、`交接记录`、`记忆`，**不含**任何 `overview-bar`；`立即生成交接` 按钮仍在。
  - `ConversationPlaceholder` 含 `S.lay.convPlaceholder`，且 `sessions` 里每个 label 都出现（多 session）。
- [ ] **Step 2: 运行确认失败**，然后实现各 tab 组件：
  - `TicketTerminalTab`：把 `TicketPage` 里现有的仓库条、`cleanupBlocked` 提示、移除仓库确认、session 条（`sessions-bar`，含换新 `RefreshSessionButton`、结束 `EndSessionButton`、`SessionLimit`、`SessionCost`、`CloseIdleButton`、新 session、新总控）、隐藏 session 列表、`mismatch`/`oldWorkdir` 提示、`terminals` 整段搬进来，**CSS 类名一个都不改**（e2e 靠它们）。`panes`、`active`、`open`、`closePane` 这些状态仍留在 `TicketPage`，以 props 传入——终端 tab 切走再回来 `TerminalPane` 会从快照重建，不丢。
  - `TicketPrTab`：上下依次放 `TicketPrStages`、`TicketReview`、`TicketComments`，不改它们内部。
  - `TicketLogTab`：保留 `followups`、`handoffs`、`MemoryPanel` 三块，改成三个并排的小节（不再是切换按钮），去掉顶部「N 个 PR」那一行（PR 信息归概况和 PR 详情），`立即生成交接`（`api.runHandoff`）放在「交接记录」小节标题旁；`HandoffEntry` 里的 `prLabel` 一行删掉（那是旧的 PR 状态说法）。
- [ ] **Step 3: 重写 `TicketPage.tsx` 的 return**：标题栏（名字、手动状态下拉、改标题、归档、feature 链接）保留；其下是 `PageTabs page={\`ticket:${key}\`} defaultTab="overview" forceTab={landing}`，tab 顺序 `overview`、`conversation`、`terminal`、`pr`、`log`，标签文案见文案表；`overview` tab 的 `className` 在 `you` 轮到时给 `attention`（红字，沿用现有 `.page-tab.attention`）。`landing` 的算法：`route.landing` 为真时，用 `useTurnBoard({ ticketKey })` + `ticketRows` 算出这个 ticket 的 `turn`，取 `landingTab(turn)`，只在第一次拿到数据时设置一次（之后用户自己切 tab 不再被拉回）。`initialOpen`（从别处带着 session 跳进来）存在时 `forceTab` 也是 `"terminal"`，覆盖落点。`onGoTab` 通过 `PageTabs` 的受控 `forceTab` 再触发一次切换（`TicketPage` 里 `const [force, setForce] = useState<{tab, n}>`，`n` 递增保证同一个 tab 也能再触发）。
- [ ] **Step 4: `App.tsx`**：传 `landing={route.landing}` 给 `TicketPage`；把 `TicketPage` 的 `key` 保持 `current.key`。
- [ ] **Step 5: 运行** `pnpm vitest run src/renderer/src && pnpm typecheck && pnpm lint`，预期 PASS。
- [ ] **Step 6: 手工看一遍**：`pnpm dev`，开一个有 PR 的 ticket 和一个没有 PR 的 ticket，确认默认落在概况、不用滚动；点终端 tab 能开 session。
- [ ] **Step 7: Commit** `feat(ui): ticket page tabs (overview, conversation slot, terminal, PR, log)`

---

### Task 6: 范围页的展示组件（概况、进行中、全部 ticket、总控、AI 总结）

**Files:**
- Modify: `components/ScopeParts.tsx`（接 Task 2）
- Create: `components/ControlConversation.tsx`、`components/scope-tabs-render.test.ts`
- Modify: `components/InboxPanes.tsx`（把私有的 `InboxReports` 改名导出为 `ReportFeed`）

**Interfaces:**
- Consumes: Task 2 的 `scope-view.ts`、`TurnCard`（第 2 层）、`InboxItemView`。
- Produces:
  ```ts
  export function ScopeOverview(p: { rows: ScopeTurnRow[]; total: ScopeTurnRow | null; youItems: TurnItem[];
    kind: "epic" | "feature"; emptyText: string; onOpenRow?: (id: number | string) => void; onCreate?: () => void }): JSX.Element;
  export function ScopeRunning(p: { rows: TicketRow[]; onOpenTicket: (key: string) => void }): JSX.Element;
  export function ScopeTicketTable(p: { groups: { name: string | null; merged: number; total: number; rows: TicketRow[] }[];
    onOpenTicket: (key: string) => void; emptyText: string }): JSX.Element;
  export function ControlSplit(p: { left: ReactNode; right: ReactNode }): JSX.Element;   // .control-split
  // ControlConversation.tsx —— 第 5 层的挂载点：把函数体换成 <ConversationTab …/> 加汇报穿插，props 不变
  export function ControlConversation(p: { scope: InboxScope; rootSessionId: string | null;
    sessions: { id: string; label: string }[]; footer?: ReactNode }): JSX.Element;
  ```

- [ ] **Step 1: 写 `scope-tabs-render.test.ts`**，用 `createElement` 渲染：
  - `ScopeOverview`：`total` 是 `{total:15, merged:9, youCount:2}` → 含 `15 个里合了 9 个 · 2 件轮到你` 和 `最慢的是「收尾 R/X」`；`youItems` 里每条渲染一个 `TurnCard`（用第 2 层真组件，`item.turn` 用 `you/merge`）；每个 feature 行含 `6/8 合了` 和 `ScopeBar`；**空 epic**（`rows: []`、`total.total: 0`）→ 含 `emptyText` 和（给了 `onCreate` 时）新建按钮，不含 `NaN`、不含 `scope-bar`；`youItems: []` → 含 `这里没有事轮到你`。
  - `ScopeRunning`：行含 `WhoTag`、句子、时长；`rows: []` → 含 `现在没有 agent 或 CI 在处理的事`。
  - `ScopeTicketTable`：分组行 `工作流 J–N · 3/5 合了`；列头 `ticket / 谁该动 / 现在怎么样 / PR`；PR 列没有 PR 写 `—`；多 PR 的行写 `#52 #53` 且句子带 `另有 1 个 PR`；`groups: []` → 含 `emptyText` 且不含 `<table`；某个 feature 下 `rows: []` 时该组只渲染一行说明 `S.lay.noTicketsInGroup`。
  - `ControlConversation`：`ReportFeed` 的汇报按时间从旧到新（对话习惯），`reports: []` 时含 `子 session 的完成和卡住汇报会按时间出现在这里`；`footer` 原样渲染。注意它内部用 `useInbox`，测试里改测拆出来的展示件 `ControlFeed({ reports, footer })`。
- [ ] **Step 2: 运行确认失败**：`pnpm vitest run src/renderer/src/components/scope-tabs-render.test.ts`。
- [ ] **Step 3: 实现**。`ScopeTicketTable` 保留 `.ticket-table` 类名（e2e 和样式靠它）；行点击 `onOpenTicket`；`ControlSplit` 左右两栏；`ControlConversation` 用 `useInbox(scope)` 取 `reports`，旧的 `decisions` 不再用。
- [ ] **Step 4: 运行** `pnpm vitest run src/renderer/src && pnpm typecheck`，预期 PASS。
- [ ] **Step 5: Commit** `feat(ui): scope overview, running, ticket table and control split components`

---

### Task 7: epic 页

**Files:**
- Create: `components/EpicSummaryTab.tsx`、`components/epic-summary-render.test.ts`
- Modify: `components/EpicPage.tsx`、`components/epic-row.ts`、`components/epic-row.test.ts`、`components/PrStages.tsx`、`pr-stages-view.ts`、`pr-stages-view.test.ts`、`components/pr-stages-render.test.ts`、`App.tsx`（给 `EpicPage` 传 `features`，去掉 `onOpenProgress`）
- Delete: `epic-row.ts` 里的 `epicRowText`、`firstSentence`（含对 `feature-summary-view` 的引用）、测试里对应用例；`PrStages.tsx` 的 `EpicPrRows`、`EpicPrStages`、`EpicProps`、`pr-stages-view.ts` 的 `epicPrSummary`、`EpicPrRow`（及其测试）；`EpicPage` 里的 `FeatureRow`、`ArchivedFeatures`、`inboxTabs`/`useInbox` 用法、`PrStuckBlock`

**Interfaces:**
- Consumes: Task 2、6 的组件，`api.runFeatureSummary`、`S.runFeatureSummary`、`S.featureSummaryRunning`（已有）。
- Produces: `EpicPage` 新 props：
  ```ts
  { epic: EpicView; features: FeatureView[]  /* epicId === epic.id 的未归档 feature，App 传 */;
    onOpenFeature(id: number): void; onOpenTicket(key: string): void; onFeatureCreated(id: number): void;
    focusSession?: string | null; onOpenTarget(t: NowTarget): void }
  ```
  `EpicSummaryTab({ rows: EpicFeatureRow[]; onRun(featureId: number): Promise<string>; })`（展示件）。

- [ ] **Step 1: 写 `epic-summary-render.test.ts`**：每个未归档 feature 一节：名字、`summary` 文本、生成时间（`summaryAt` 格式化）、`blockers` 逐条；`summary === null` → 含 `还没有汇总`；每节一个 `立即更新`（`S.runFeatureSummary`）；`rows: []` → 含 `S.noEpicFeatures`；归档的 feature 不出现。epic 没有「一个整体的总结」：这是有意的（每个 feature 各自更新，避免一次点出 N 次 LLM 调用）。
- [ ] **Step 2: 实现 `EpicSummaryTab`** 和取数薄壳（`onRun` 调 `api.runFeatureSummary(id)`，结果用 `summaryOutcomeMessage`，沿用 `feature-summary-view.ts`）。
- [ ] **Step 3: 重写 `EpicPage`**：标题栏 `WorkspaceHeader` 不变；`PageTabs page={\`epic:${id}\`} defaultTab="overview"`，`actions` 放 `+ 新建 feature`（沿用 `S.newFeature`，e2e 靠 `.epic-page .page-tabs-bar` 里的这个按钮，位置不变）。五个 tab：
  - `overview`：`useTurnBoard({ epicId })`；`total` = `board.scopes` 里 `kind === "epic"` 那行（没有就用各 feature 行求和）；`youItems` = `board.items` 里 `owner === "you"`；`onOpenRow` 打开 feature。取不到数据时渲染骨架（不闪空状态）。epic 没有 feature 时显示 `S.noEpicFeatures`，并带「新建 feature」按钮。
  - `running`：标签带数字（`runningRows` 数量）；
  - `tickets`：标签带数字；`groupByFeature(ticketRows(features.flatMap(f => f.tickets), board.items), features)`；
  - `control`：`ControlSplit left={SessionArea …（原样，含 epic 仓库条和终端）} right={ControlConversation scope={{ epicId }} rootSessionId={null} sessions={…} />`。`rootSessionId` 本层传 `null`（epic session 的链根要第 5 层的接口，见「对共用接口的建议」）；
  - `summary`：`EpicSummaryTab`。
  tab 标签上不再放红点/徽章，只有 `overview` 在 `youItems.length > 0` 时 `attention`。`goTo`（「去终端」）整段删除；`panes.show` 在 `focusSession` 属于 epic session 时切到 `control` tab（`forceTab`）。
- [ ] **Step 4: 删旧件**（见 Files 的 Delete 列）；`grep -rn "epicRowText\|firstSentence\|EpicPrStages\|epicPrSummary" src` 必须为空（`main/progress/progress-view.ts` 里自己的 `firstSentence` 不是同一个，不动）。已归档的 feature 入口不再放在 epic 页（归 `ArchivedPage`，第 2 层的「全部工作」页有入口）。
- [ ] **Step 5: 删 `S.epicStatus` 等不再用的键**：对每个候选键 `grep -rn "S\.<key>\|\.<key>\b" src e2e`，无引用才删（两种语言同时删）。
- [ ] **Step 6: 运行** `pnpm vitest run src && pnpm typecheck && pnpm lint`，预期 PASS。
- [ ] **Step 7: Commit** `feat(ui): layered epic page; remove epic row summary line and per-feature PR tables`

---

### Task 8: feature 页

**Files:**
- Modify: `components/FeaturePage.tsx`、`App.tsx`（去掉 `onOpenProgress`）、`feature-summary-view.ts`、`feature-summary-view.test.ts`、`components/PrStages.tsx`、`components/pr-stages-render.test.ts`
- Delete: `FeaturePage` 里的 `TicketRow`（含 `stuck-dot` 展开面板）、`openFix`、`dismissStuck`、`PrStuckBlock`、`useProgress` 引用、`summary-stale` 提示；`feature-summary-view.ts` 的 `prPill`、`prLabel`、`firstSentence` 及其测试；`PrStages.tsx` 的 `FeaturePrRows`、`FeaturePrStages`；`components/StuckPanel.tsx`（先 `grep -rn StuckPanel src`，第 2 层的 `TurnCard` 若在用就保留并只删本页的引用）；`InboxPanes.tsx` 在 Task 9 才删（`ButlerPage` 还在用）

**Interfaces:**
- Consumes: Task 2、6；`FeatureView`（含 `tickets`、`summary`、`brief`、`sessions`）。
- Produces: `FeaturePage` props 去掉 `onOpenProgress`，其余不变。

- [ ] **Step 1: 改 `feature-summary-view.test.ts`**：删 `firstSentence`、`prPill`、`prLabel` 的用例，只留 `summaryOutcomeMessage`、`summaryOutcomeIsError`。运行确认其余通过。
- [ ] **Step 2: 重写 `FeaturePage`**，五个 tab 同 epic 页，范围小一层：
  - `overview`：`useTurnBoard({ featureId })`；一句进度用 `scopes` 里整个 feature 的汇总（`kind === "feature"` 那行，没有就对 ticket 行求和）；`ScopeOverview kind="feature"`，下面的「各个 feature」卡片换成各 ticket 的小卡（`scopes` 里 `kind === "ticket"`），feature 没有 ticket 时 `S.noFeatureTickets` 加「新建 ticket」按钮；
  - `running`、`tickets`（平铺，不分组：`groups` 只有一组 `name: null`）、`control`（feature 总控 session 和修复 session，`placeOf` 沿用现有写法，右栏 `ControlConversation scope={{ featureId }}`）、`summary`（现有 `FeatureProgress` 原样搬到 `components/FeatureSummaryTab.tsx`，**去掉** `useProgress` 的「汇总可能过期」提示，保留 `summary-meta` 那一行：生成时间 · 来源 · `立即更新`；`FeatureBrief` 保留）。
  - 头部「移到别的 epic」保持。`+ 新建 ticket` 仍在 tab 条右边。
- [ ] **Step 3: 卡住的 ticket 的「开修复 session」入口**：卡住现在显示成 `你 · 卡住了` 的一行（点进 ticket 页），修复 session 由 ticket 概况的 `fix` 按钮开（Task 4 的 `onFix`：`api.openFixSession({ featureId, stuckSessionId })`，只在 ticket 有 `featureId` 且 `turn.sessionId !== null` 时 `canFix`），所以 `FeaturePage` 里不再需要 `openFix`。在 `TicketPage` 里补 `onFix` 的实现，成功后 `forceTab("terminal")`。
- [ ] **Step 4: 删旧件**（Files 的 Delete 列）。`grep -rn "prPill\|prLabel\|firstSentence\|FeaturePrStages\|PrStuckBlock\|useProgress" src --include=*.ts --include=*.tsx`：只允许剩第 2 层 `now-view` 的 `prPill`（那是 `WatchedPr` 的，不是 `feature-summary-view` 的，由第 2 层删）和 `main/` 下无关的同名函数。
- [ ] **Step 5: 运行** `pnpm vitest run src && pnpm typecheck && pnpm lint`，预期 PASS。
- [ ] **Step 6: Commit** `feat(ui): layered feature page; remove ticket-row stuck panel and old PR pill`

---

### Task 9: 总控页（`ButlerPage`）

**Files:**
- Modify: `components/ButlerPage.tsx`、`components/InboxPanes.tsx`、`strings.ts` / `strings-en.ts`（`butlerIntro` 换成一句话说明）、`App.tsx`（`ButlerPage` 的 `onOpenTarget` 若不再用就删）
- Create: `components/butler-page-render.test.ts`
- Delete: `InboxPanes.tsx` 里的 `inboxTabs`、`InboxDecisions`、`DecisionCard`（先 `grep -rn DecisionCard src`，第 2 层已不用才删）

**Interfaces:**
- Consumes: `ControlSplit`、`ControlConversation`（Task 6）、已有的 `ButlerRepliesList`。
- Produces: 无新对外接口。

- [ ] **Step 1: 写 `butler-page-render.test.ts`**：渲染拆出的展示件 `ButlerLayout({ title, lede, left, right })`：含 `h1`/`h2` 标题 `总控`、一句话说明 `管所有 epic 的那个 session：每天早上巡检、跨 epic 协调。子 session 的汇报都送到这里。`、`control-split`；不含 `page-tabs`（总控页没有 tab）。`ButlerRepliesList` 的现有测试照旧通过。
- [ ] **Step 2: 改 `ButlerPage`**：去掉 `PageTabs`、`useInbox`、`inboxTabs`、`goTo`；`left` 是原来的 `SessionArea`（含复盘分析 session 那一节）；`right` 是 `ControlConversation scope={{ all: true }} rootSessionId={null} sessions={…}`，`footer` 是默认折起的 `<details>`「总控发出的消息（N）」，里面放 `ButlerRepliesList`（`useStateRefetch("butler:messages", …)`；N 是消息数，没取到不显示）。
- [ ] **Step 3: 删 `InboxPanes` 旧件**；`InboxPanes.tsx` 只剩 `useInbox`、`ReportFeed`。
- [ ] **Step 4: 运行** `pnpm vitest run src && pnpm typecheck && pnpm lint`，预期 PASS。
- [ ] **Step 5: Commit** `feat(ui): control page as terminal + conversation split`

---

### Task 10: 「Butler 自己」三页

**Files:**
- Create: `src/renderer/src/butler-self-view.ts`、`butler-self-view.test.ts`、`components/butler-self-render.test.ts`
- Modify: `components/LessonsPage.tsx`、`components/EffectPage.tsx`、`components/AuditPage.tsx`、`strings.ts` / `strings-en.ts`

**Interfaces:**
- Produces:
  ```ts
  // butler-self-view.ts
  export function pendingLessons(s: Pick<LessonsState, "lessons">): number;               // status === "pending"
  export function firstPendingSelection(s: LessonsState): LessonsSelection | null;       // 第一个有待确认规矩的仓库或产品
  export function auditIsEmpty(a: { llmEntries: number; externalEntries: number }): boolean;
  export const EFFECT_TABS = ["overview", "trend", "spend", "rework", "automation"] as const;
  ```

- [ ] **Step 1: 写 `butler-self-view.test.ts`**：`pendingLessons` 数 `pending`、不数 `confirmed`/`disabled`；`lessons` 为空 → 0；`firstPendingSelection` 优先返回产品（`{kind:"product", id}`）下有待确认的，否则仓库 `{kind:"repo", slug}`，没有待确认返回 `null`；`auditIsEmpty({0,0})` 为真，任一为正为假。
- [ ] **Step 2: 运行确认失败**，实现。
- [ ] **Step 3: 复盘与规矩**：`h2` 下一句话说明换成 `S.lay.lessonsLede`；其下，`pendingLessons > 0` 时一张主层卡片（沿用 `.lessons-suggest` 样式）：`N 条新规矩等你看一眼` + `逐条看` 按钮（切到 `规矩` tab 并 `select(firstPendingSelection(state))`）；`= 0` 时不显示卡片。现有 7 个 tab 和 `data-testid` 一个都不改（e2e 依赖），但 `pageTab` 的初值改成 `pickTab(savedTab("lessons"), ids, "lessons")`，切换时 `saveTab("lessons", t)`，从「现在」页跳来的 `tab="checks"` 仍然优先。
- [ ] **Step 4: 效果与花费**：`EffectPage` 改成「说明 + 时间范围切换 + 四张卡（`Cards`，主层） + `PageTabs page="effect" defaultTab="overview"`」，tab：`overview`（基线说明、`o.butler.prs === 0` 的空状态）、`trend`（`Interrupts`、`InterruptCompareTable`、`Trend`）、`spend`（`Spend`、`Groups`）、`rework`（`Rework`、`Interventions`、`OtherEvents`）、`automation`（`LoopEffectSection`、`ReviewEffectSection`、`IntakeEffectSection`）。说明换成 `S.lay.effectLede(days)`。`data-testid` 不变。
- [ ] **Step 5: 审计**：`h2` 下一句话 `S.lay.auditLede`；`auditIsEmpty` 为真时在 tab 条上方放空状态说明 `S.lay.auditEmpty`（「Butler 默认不替你对外做任何事……」）；`PageTabs page="audit" defaultTab="external"`，`external` tab 放 `ExternalAudit`（`data-testid="external-audit"` 和 `externalAuditNone` 文案保持，所以 `defaults.spec.ts`、`progress.spec.ts` 里对它的断言不用改），`llm` tab 放现有的模型调用列表和 `monthSpend` 那一行。`AuditPage` 要多拿外部审计条数：`useStateRefetch("externalAudit", …)` 提到页面顶层，`ExternalAudit` 改成吃 props。
- [ ] **Step 6: 写 `butler-self-render.test.ts`**：`EffectBody` 的现有渲染测试（`review-effect-render.test.ts`）保持通过；新增 `AuditEmptyNote` 展示件含 `Butler 默认不替你对外做任何事`；`LessonsAttention({ count: 4, onOpen })` 含 `4 条新规矩等你看一眼`，`count: 0` 返回空串。
- [ ] **Step 7: 运行** `pnpm vitest run src && pnpm typecheck && pnpm lint`，预期 PASS。
- [ ] **Step 8: Commit** `feat(ui): one-line ledes and primary-layer focus on lessons, effect, audit`

---

### Task 11: e2e 更新和旧件清零检查

**Files:**
- Modify: `e2e/fixtures.ts`（`pageTab`/`openTab` 注释和实现去掉「再点会收起」；新增 `openTicketTab(page, tab)`）、`e2e/epics.spec.ts`、`e2e/features.spec.ts`、`e2e/butler.spec.ts`、`e2e/pr-stages.spec.ts`、`e2e/main-flow.spec.ts`、`e2e/multi-repo.spec.ts`、`e2e/refresh.spec.ts`、`e2e/hibernate.spec.ts`、`e2e/now.spec.ts`（若第 2 层已改写就只补终端 tab）、`e2e/ticket-edit.spec.ts`、`e2e/terminal-scroll.spec.ts`、`e2e/effect.spec.ts`
- Test: 以上各 spec；新增 `e2e/layered-pages.spec.ts`

**Interfaces:**
- Produces: `openTicketTab(page: Page, tab: "overview" | "conversation" | "terminal" | "pr" | "log"): Promise<void>`（按 tab 的中文名点，已选中就不点）。

- [ ] **Step 1: 先跑出会坏的**：`pnpm e2e e2e/epics.spec.ts e2e/features.spec.ts e2e/butler.spec.ts e2e/pr-stages.spec.ts e2e/main-flow.spec.ts e2e/multi-repo.spec.ts e2e/refresh.spec.ts e2e/hibernate.spec.ts e2e/ticket-edit.spec.ts e2e/terminal-scroll.spec.ts e2e/effect.spec.ts`，记下失败点。
- [ ] **Step 2: 按下面的规则改**（不改产品代码来迁就旧断言）：
  - 凡是点 `.sessions-bar` 里的按钮、看 `.terminals`、用 `.repos-bar`、新建 session 的，先 `openTicketTab(page, "terminal")`（ticket 页默认落在概况）；epic / feature 的同类操作先 `openTab(page, S.lay.tabControl)`。
  - epic 的 feature 表断言（`.epic-features .ticket-table`）改到「全部 ticket」tab：`.scope-tickets .ticket-table`；feature 行的内容从「一句汇总」改成 `WhoTag` 加句子，断言改成按 `你`/`agent` 文案。
  - feature 页的 `.feature-progress` 断言改到 `AI 总结` tab；「汇报和待你决定又多又长」那个用例（`features.spec.ts:380` 附近）整段删：汇报改在 `总控` tab 的右栏，待你决定已不在这里，各留一个新用例（见 Step 3）。
  - 「收起再展开」一类的用例（`features.spec.ts:311-321`、`epics.spec.ts:480-490`、`butler.spec.ts:48-71`）改成「切到别的 tab，离开再回来还是那个 tab」。
  - `effect.spec.ts` 里一次性断言多块的循环，拆成：先在概况断言四张卡，再 `openTab` 到对应 tab 断言 `effect-interrupts`、`effect-trend` 等。
  - `S.prPill.*` 英文断言（`features.spec.ts:426`）改成句子文案。
- [ ] **Step 3: 写 `e2e/layered-pages.spec.ts`**（用现有 `makeSandbox`、`launch`、假 gh 夹具，ticket 号 `E2E-1`、`E2E-2`）：
  1. 新 ticket 无 PR：进 ticket 页默认选中「概况」，含 `还没开 PR`，不含 `打开 PR`；点「终端」能开 session；离开再回来仍是「终端」（记住上次）。
  2. 夹具里给 `E2E-2` 一个 CI 失败的 PR：从首页「轮到你」点进来，直接落在「PR 详情」tab。
  3. 空 epic（刚建、没有 feature）：概况含 `S.noEpicFeatures`，不含 `NaN`；建一个 feature 后概况出现 feature 卡片。
  4. 总控 tab：epic 页点「总控」，左边有终端区、右边有 `control-split` 的对话栏，终端不在页面底部（`.control-split` 在 `.page-tabs-panel` 内）。
- [ ] **Step 4: 逐个运行**：`pnpm e2e e2e/<spec>`，全部 PASS 后再整体 `pnpm e2e`。
- [ ] **Step 5: 清零检查**：下面每条 `grep` 的结果要和注释一致，不一致就是漏删。
  ```bash
  grep -rn "epicRowText\|EpicPrStages\|FeaturePrStages\|epicPrSummary\|PrStuckBlock\|inboxTabs\|DecisionCard\|TicketOverview\b" src e2e   # 空
  grep -rn "savedTabOpen\|saveTabOpen\|toggleTabs\|clickTab\|tabIsOpen\|readTabState" src e2e                                       # 空
  grep -rn "stuck-dot\|stuck-panel\|summary-stale\|overview-bar" src e2e                                                              # 空
  pnpm typecheck && pnpm lint && pnpm test
  ```
- [ ] **Step 6: 没引用的字符串键**：对本层删掉的组件用过的键（`tabCollapse*`、`epicStatus`、`inboxDecisions`、`inboxReports`、`featureProgress`、`featureSummaryStale` 等），逐个 `grep -rn "S\.<key>\|\.<key>(" src e2e`，无引用就两种语言一起删。
- [ ] **Step 7: Commit** `test(e2e): update for layered pages; add layered-pages spec`

---

## 文案表（Task 2 起加进 `S.lay`，中英都要）

| 键 | 中文 | 英文 |
|---|---|---|
| `tabOverview` / `tabRunning` / `tabTickets` / `tabControl` / `tabSummary` | 概况 / 进行中 / 全部 ticket / 总控 / AI 总结 | Overview / In progress / All tickets / Control / AI summary |
| `tabConversation` / `tabTerminal` / `tabPr` / `tabLog` | 对话 / 终端 / PR 详情 / 记录 | Conversation / Terminal / PR details / Log |
| `progressLine(merged, total, you)` | `{total} 个里合了 {merged} 个 · {you} 件轮到你`；`you` 为 0：`… · 没有事轮到你`；`total` 为 0：`还没有 ticket` | `{merged} of {total} merged · {you} waiting on you`；`… · nothing waiting on you`；`No tickets yet` |
| `slowest(name)` / `noSlowest` | `最慢的是「{name}」。` / `没有明显落后的。` | `Slowest: "{name}".` / `Nothing is clearly behind.` |
| `youHere` / `noYouHere` | 这个范围里轮到你的 / 这里没有事轮到你。 | Waiting on you here / Nothing here is waiting on you. |
| `featuresHeading` / `featureCard(merged,total)` | 各个 feature / `{merged}/{total} 合了` | Features / `{merged}/{total} merged` |
| `runningEmpty` | 现在没有 agent 或 CI 在处理的事。 | Nothing is being worked on by an agent or CI right now. |
| `colTicket` / `colWho` / `colNow` / `colPr` | ticket / 谁该动 / 现在怎么样 / PR | Ticket / Who's up / Status / PR |
| `groupHeader(name,merged,total)` / `noTicketsInGroup` | `{name} · {merged}/{total} 合了` / 这一组还没有 ticket。 | `{name} · {merged}/{total} merged` / No tickets in this group yet. |
| `whoYou` / `whoAgent` / `whoExternal` / `whoDone` / `whoIdle` | 你 / agent / 外部 / 合了 / 没开始 | You / agent / External / Merged / Not started |
| `ctlLede` | 总控是帮你拆活、协调各个 ticket 的 session。左边是终端，右边是对话。 | The control session splits up work and coordinates the tickets. Terminal on the left, conversation on the right. |
| `ctlEmpty` | 子 session 的完成和卡住汇报会按时间出现在这里。 | Reports from child sessions (done or blocked) show up here in time order. |
| `lastSaid` / `lastSaidNone` / `seeConversation` | agent 最后说的 / 现在看不到（终端没开着时取不到最后一句） / 看完整对话 | What the agent said last / Not available (the last line can't be read while the terminal is closed) / See the full conversation |
| `thisTicket` / `kvBranch` / `kvPr` / `kvContext` | 这个 ticket / 分支 / PR / 上下文 | This ticket / Branch / PR / Context |
| `noPrYet` / `stagesDone(done,total)` / `morePrs(n)` / `prClosedNote` | 还没开 PR / `{total} 个阶段走完 {done} 个` / `另有 {n} 个 PR` / （已关闭） | No PR yet / `{done} of {total} stages done` / `{n} more PR(s)` / (closed) |
| `ctxUnknown` / `ctxOff(k)` / `ctxNear` | 还不知道 / `{k}（自动换新已关）` / 快要换新了（对话不会丢） | Unknown / `{k} (auto refresh off)` / Refresh is close (the conversation is kept) |
| `actOpenPr` / `actAnswer` / `actLook` / `actFix` / `actSend` / `actPrDetails` | 打开 PR / 去回答 / 去看看 / 开修复 session / 送给 agent / 看 PR 详情 | Open PR / Go answer / Take a look / Open fix session / Send to agent / See PR details |
| `prSecStages` / `prSecReview` / `prSecComments` | 阶段 / CI · review · 风险 · 就绪 / 未处理的评论 | Stages / CI · review · risk · readiness / Unresolved comments |
| `logFollowups` / `logHandoffs` / `logMemory` | 待跟进 / 交接记录 / 记忆 | Follow-ups / Handoffs / Memory |
| `convPlaceholder` / `convNoSession` | 所有说过的话会按时间排在这里，换新也不会丢。现在先到「终端」看。 | Everything said will be listed here in time order and kept across refreshes. For now, use the Terminal tab. / This ticket has no session yet. |
| `fixPrefix` | 修复 · | Fix · |
| `butlerLede` | 管所有 epic 的那个 session：每天早上巡检、跨 epic 协调。子 session 的汇报都送到这里。 | The session that oversees every epic: a morning sweep and cross-epic coordination. Reports from child sessions arrive here. |
| `butlerSent(n)` | 总控发出的消息（{n}） | Messages sent by control ({n}) |
| `lessonsLede` | Butler 从合了的 PR 里总结出来的规矩。确认过的会在以后的 session 里提醒 agent。 | Rules Butler distilled from merged PRs. Confirmed ones are passed to future sessions. |
| `lessonsAttention(n)` / `lessonsReview` | `{n} 条新规矩等你看一眼` / 逐条看 | `{n} new rule(s) waiting for a look` / Review one by one |
| `effectLede(days)` | 最近 {days} 天 Butler 替你省了多少事、花了多少钱。 | What Butler saved you and what it cost over the last {days} days. |
| `effectTabs` | 概况 / 趋势 / 花费明细 / 返工 / 自动化的效果 | Overview / Trend / Spend / Rework / Automation effect |
| `auditLede` | Butler 自己调过的模型和替你做过的对外动作，一条一条可查。 | Every model call Butler made and every outside action it took for you, one by one. |
| `auditEmpty` | Butler 默认不替你对外做任何事（发评论、改 PR 都默认关着），所以这里还没有记录。 | Butler does nothing outside by default (commenting and editing PRs are off), so there is nothing here yet. |
| `auditTabs` | 对外动作 / 模型调用 | Outside actions / Model calls |

---

## 本层删除清单

- 旧 tab：epic / feature 的「汇报」「待你决定」（`inboxTabs`）、feature 的「整体进度」「PR 进度」（`stages`）和 epic 的「PR 进度」；ticket 的 `stages` / `comments` / `review` 三个上半部 tab（并入「PR 详情」）；ticket 页下半截固定的 `TicketOverview` 切换条；`PageTabs` 的展开/收起和 `tabOpen` 存储。
- 旧组件和函数：`epicRowText`、`firstSentence`（`epic-row.ts`）、`prPill`、`prLabel`、`firstSentence`（`feature-summary-view.ts`）、`EpicPrRows`/`EpicPrStages`/`FeaturePrRows`/`FeaturePrStages`、`epicPrSummary`、`FeaturePage` 的 `TicketRow` 和 stuck 展开面板（`StuckPanel` 在无人使用时一并删）、`PrStuckBlock`、`DecisionCard`/`InboxDecisions`、`useProgress` 在 feature 页的「汇总可能过期」。
- 对应测试：`epic-row.test.ts` 里 `firstSentence`、`epicRowText` 的用例，`feature-summary-view.test.ts` 里 `firstSentence`、`prPill`、`prLabel` 的用例，`pr-stages-view.test.ts` 里 `epicPrSummary` 的用例，`pr-stages-render.test.ts` 里 epic/feature 表的用例，`page-tabs.test.ts` 里收起相关用例；旧的 e2e 收起/汇报/待你决定用例。保留的测试按新行为改写，不留「旧算法 + 新算法」两套。
- 不在本层删：`S.prPill`（`NowPage` 和 PR 阶段表还在用，第 2 层负责）、`main/progress/*` 和 `shared/progress.ts` 的 `waitingOnOf`（`butler-control` 和 `feature-templates` 的后台文案还在调，属于第 1 层「替换状态算法」的范围）。

## 对共用接口的建议

1. **第 1 层**：请确认 `turn:board` 在三种 filter 下的 `scopes` 含义（epic 过滤返回「epic 自己一行 + 每个 feature 一行」，feature 过滤返回「feature 一行 + 每个 ticket 一行」），本计划按此假设；以及 `items` 里 `agent`/`external`/`done` 条目是否都在（「进行中」和「全部 ticket」要用）。`ticketTurn` 对「没有任何 PR 也没有 session 条目」的行为请写明（本层自己兜底成 `done`/`idle`）。
2. **第 1 层**：待决定（`ask_user`）要算进 `you/answer`，且 `askId` 要能让 `api.answerInbox` 回答——本层没有再保留任何「待你决定」入口。
3. **第 4、5 层**：渲染进程现在拿不到 session 的链根。本层让 `ticket:glance` 返回 `rootSessionId`（ticket 页用）；epic、feature、总控页的 `ControlConversation` 先传 `null`。建议第 4 层给 `SessionView` 加 `rootId`，或第 5 层的 `conv:list` 接受 head id 并在主进程用 `sessions.rootOf` 解析，这样三个范围页都能直接挂 `ConversationTab`。
4. **第 5 层**：把 `landingTab` 里 `you/answer`、`you/stuck` 的落点从 `terminal` 改成 `conversation`（同时改 `ticket-tabs.test.ts`）；把 `TicketPage` 里的 `ConversationPlaceholder` 换成 `ConversationTab`；把 `ControlConversation` 的函数体换成「`ConversationTab` + 汇报穿插」。
5. **第 2 层**：`WhoTag`、`ScopeBar` 在本层的 `ScopeParts.tsx`，首页「各个 epic」小表如果已经有同样的进度条组件，请合并成一份（本层实现时先 `grep` 第 2 层有没有，有就复用并删掉本层这份）。「对话不会丢」那句提示在第 4 层合并之前不成立，四层要在同一个发布里合。
