# UI 重做第 2 层：侧栏、首页（轮到你）、全部工作 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把侧栏收成「轮到你 / 全部工作树 / 总控 / Butler 自己 / 防休眠」，用「轮到你」首页取代「现在」页，新增「全部工作」页，拆掉进度页的入口，颜色只表示谁该动。

**Architecture:** 渲染进程只消费第 1 层的 `turn:board`，不再自己算状态。纯函数放进 `home-view.ts`、`sidebar-view.ts`，组件只拿 `TurnBoard` 当 props（所以能用 `renderToStaticMarkup` 在 vitest 里测，照 `progress-render.test.ts` 的做法）；取数、防抖、失败处理集中在一个 `useTurnBoard` hook，由 `App` 持有一份，侧栏、首页、全部工作共用。旧的状态算法（`needsYouText`、`rowText` 等）和 `NowPage` 在本层删除，不留两套。

**Tech Stack:** Electron + React 19 + TypeScript，vitest（`src/**/*.test.ts`，组件用 `createElement` + `renderToStaticMarkup`），Playwright e2e（`e2e/`）。

**Spec:** `docs/superpowers/specs/2026-11-19-ui-redesign-design.md`（重点 §5.1、§5.2、§5.3 侧栏/首页/全部工作）；共用接口见 `docs/superpowers/plans/2026-11-19-ui-redesign-00-index.md`；草图 `.superpowers/brainstorm/1247-1795150005/content/full-mockup.html`（`nav.sb`、`#p-home`、`#p-all`）。

**依赖：** 第 1 层已合入，提供 `src/shared/turn.ts`（`Turn`、`TurnItem`、`ScopeTurnRow`、`TurnBoard`、`TURN_PRIORITY`）、`src/renderer/src/turn-text.ts` 的 `turnSentence(turn, item, t)`，以及 IPC `turn:board`、`turn:changed`、`turn:send-to-agent`。本层在 `src/renderer/src/api.ts` 里用的包装名约定为：`api.turnBoard(filter?)`、`api.onTurnChanged(cb)`、`api.turnSendToAgent(item)`（若第 1 层起了别的名字，改本计划里的调用点，不要在本层重复包装）。**另外需要第 1 层给 `TurnItem.pr` 加 `url: string`**（merge 卡的「打开 PR」要用；gh 企业版的域名不是 github.com，不能从 `repo` 拼）。

## Global Constraints

- 颜色只表示谁该动（spec §5.1 表）：你·要你回答 红、你·可以合并 绿、你·要你 review 红、你·卡住了 紫、Butler 要你点一下 琥珀、agent 蓝、外部 灰、合了 浅绿、没开始 灰。风险、费用熔断等写成文字，不再用颜色表示严重程度。
- 一种状态只有一种说法：每张卡、每一行的那句话都来自 `turnSentence(turn, item, t)`，本层不自己拼状态文案。
- 默认层只回答一个问题：首页默认层是「标题 + 一句话 + 轮到你的卡片 + 各个 epic 小表」；「进行中 N」和「运行情况」默认折起来。
- 新文案中英文都要有（`strings.ts` / `strings-en.ts`，`strings.test.ts` 比较两边的键、函数参数个数）。英文里不能有中文，数量词要处理单复数。
- 3.0 的功能默认全关、Butler 默认不对外做任何事：本层不新增任何会对外发东西的按钮；「送给 agent」只走 `turn:send-to-agent`（复用现有递送路径）。
- 不改后台行为；不改 `buildNowView`、`buildProgress` 的主进程代码（它们的消费者在第 3 层之前仍然存在）。
- e2e 里 ticket 号必须带数字（`E2E-7`）。
- 测试命令：`pnpm vitest run <file>`；类型 `pnpm typecheck`；`pnpm lint`；e2e `pnpm e2e e2e/<name>.spec.ts`（`pree2e` 会先 build）。

## 本层的取舍（执行者要知道）

1. **首页没有任何工作时**：`HomePage` 有一个 `noWork: boolean` 和 `firstRun: ReactNode` 的约定。`noWork` 为真（`tickets`、`features`、`epics` 三个列表全空）时，首页整个主体换成 `firstRun`；**第 6 层**提供 `<FirstRunHome onNewTicket onNewFeature onNewEpic onOpenSettings />` 并在 `App.tsx` 里传进来。本层 `App` 传的是 `firstRun={<NoWorkLine/>}`（一句 `S.hm.noWork` 加三个新建按钮，约 15 行，写在 `HomePage.tsx` 里），第 6 层把它换掉并删除 `NoWorkLine`。`noWork` 为假但 0 件轮到你时，不显示 `firstRun`，显示「没有事轮到你」加下面的小表。
2. **「现在」页上不属于 spec 首页的几块**（实况窗口、内存卡、最近合并、自动接活最近 24 小时、用量一行）：不删功能，整块搬进首页最底部一个默认折起来的「运行情况」（`HomeMore.tsx`，代码原样搬）。它们读的仍是 `api.nowView()`，所以 `App` 继续取 `NowView`，但只给这一块和总控页用。第 3 层处理「Butler 自己」各页时可以把其中的内存卡、用量搬到「效果与花费」。
3. **进度页**：`route.page === "progress"`、侧栏入口、`ProgressPage` 组件删除。进度页独有的「栈」（`ManagedStacks`）和「自动接活队列」（`IntakeQueue`）挪到「全部工作」页底部默认折起来的「栈与自动接活」。`ProgressBody`、PR 表、待 review 队列、`progress-ui.ts`、`progress-render.test.ts` **留给第 3 层**（它们要并进 epic/feature/ticket 页的 tab，第 3 层并完后整份删除；`PrStuckBlock` 和 `useProgress` 仍被 `FeaturePage`、`EpicPage` 使用）。这是本层唯一有意留下的过渡，在文件头加注释写明。
4. **「卡住了」卡的「开修复 session」**：`api.openFixSession` 需要 `featureId` 和 `stuckSessionId`，所以只有 `item.featureId !== null` 且 `turn.sessionId !== null` 才出现这个按钮；成功后跳到那个 feature 页（修复 session 的终端在那里已经开着）。
5. **`unattended`（没人推进）的颜色用紫色**，和「卡住了」同色：都是「没有人在动，要你拿主意」。排序：answer、review、stuck、unattended、merge、butler，同类里先来的在前。

## File Structure

新建：
- `src/renderer/src/home-view.ts` / `home-view.test.ts`：首页和全部工作用的纯函数（标题、一句话、卡片排序和按钮、位置文字、小表、进行中行、进度条分段）。
- `src/renderer/src/sidebar-view.ts` / `sidebar-view.test.ts`：侧栏树的状态点（`scopeDots`）。
- `src/renderer/src/components/useTurnBoard.ts`：取 `turn:board`，订阅 `turn:changed`，失败不丢旧数据。
- `src/renderer/src/components/Notice.tsx`：从 `NowPage.tsx` 原样搬出的 `Notice`、`noticeKey`（Butler 要你点一下的按钮逻辑）。
- `src/renderer/src/components/TurnCard.tsx`：一张「轮到你」的卡。
- `src/renderer/src/components/HomePage.tsx`：首页（`HomePage` 取数 + `HomeBody` 纯展示）。
- `src/renderer/src/components/HomeMore.tsx`：折起来的「运行情况」，装从 `NowPage.tsx` 搬来的 `MemoryCard`、`RecentMerges`、`IntakeRecent`、`UsageLine`、`LiveWindow` 挂载点。
- `src/renderer/src/components/AllWorkPage.tsx`：全部工作页（`AllWorkBody` 纯展示）。
- `src/renderer/src/components/home-render.test.ts`：卡片、首页、全部工作、侧栏的渲染测试。
- `e2e/home.spec.ts`：取代 `e2e/now.spec.ts` 里被删掉的部分。

修改：`styles.css`、`styles-contrast.test.ts`、`strings.ts`、`strings-en.ts`、`App.tsx`、`components/Sidebar.tsx`、`components/ProgressPage.tsx`（删页面、删 `onOpenProgress`）、`components/FeaturePage.tsx`、`components/EpicPage.tsx`、`now-view.ts` / `now-view.test.ts`、`e2e/fixtures.ts` 和用到侧栏「+ 新建」「已归档」「进度」的 e2e。

删除：`components/NowPage.tsx`、`group.ts`、`group.test.ts`（侧栏不再按状态给散 ticket 分组；先确认没有别的引用）。

## Review Focus

按最可能出事的顺序：
1. **0 件轮到你**：标题是「没有事轮到你」，不是「0 件事轮到你」；不渲染空的卡片区；侧栏徽标不显示 0。有工作但没有轮到你时，小表照常显示。
2. **几十件轮到你**：首页最多先画 20 张卡，下面一个「显示全部 N 件」按钮；侧栏徽标显示真实数字（超过 99 写 `99+`）。
3. **turn:board 拉取失败**：从没成功过 → 首页显示错误和「重试」，不是空白也不是「没有事轮到你」；成功过之后失败 → 保留旧数据，顶上一条「数据可能不是最新的」加重试；侧栏徽标沿用旧数字。
4. **epic 很多**：首页小表默认最多 8 行（轮到你多的在前，全合了的排最后），其余折成「全部工作里看全部 N 个」链接；侧栏树在自己的区域里滚动，不把「总控」「Butler 自己」「防休眠」挤出屏幕。
5. **名字很长**：卡片位置行、小表名字、侧栏树、全部工作表的名字都单行省略并带 `title`，按钮不被挤出卡片；ticket 号不省略。
另外：回答按钮点了之后 `api.answerInbox` 返回 `false`（问题已经不在了）要提示并重拉，不留一张点不动的卡；`askId` 为 `null`（终端里直接问的）只给「去看看」；选项超过 2 个只显示前 2 个，其余在「去看看」里答。

---

### Task 1: 颜色 token 和对比度测试

**Files:**
- Modify: `src/renderer/src/styles.css`（`:root` 和暗色 `@media` 里的 `:root` 各加一组 token；文件末尾加 `.turn-tag`、`.turn-dot`、`.turn-bar` 三个基础类）
- Test: `src/renderer/src/styles-contrast.test.ts`

**Interfaces:**
- Produces: CSS 变量 `--turn-ask`、`--turn-merge`、`--turn-stuck`、`--turn-butler`、`--turn-agent`、`--turn-external`、`--turn-done`、`--turn-idle`；类 `.turn-tag.turn-<tone>`（字色 = token，底色 = `color-mix(in srgb, var(--turn-<tone>) 14%, var(--bg))`）、`.turn-dot.turn-<tone>`（8px 圆点，背景 = token）、`.turn-bar > i.turn-<tone>`（进度条一段，背景 = token）。`<tone>` 即 `TurnTone`（Task 2 定义）：`ask | merge | stuck | butler | agent | external | done | idle`。

- [ ] **Step 1: 写失败的测试。** 在 `styles-contrast.test.ts` 末尾加 `describe("turn colours (UI redesign §5.1)")`：
  - `finds the turn tokens`：`[...light.keys()].filter(k => k.startsWith("--turn-")).sort()` 等于上面 8 个名字。
  - 对 light 和 dark 各一个用例：每个 `--turn-*` token 在 `var(--panel)` 和 `var(--bg)` 上对比度 ≥ 4.5。
  - 同样两个主题：选择器匹配 `/^\.turn-tag\.turn-\w+$/` 的每条规则，`color` 在它自己的 `background` 上 ≥ 4.5（沿用文件里已有的 `rules`、`decl`、`resolve`、`contrast`；断言规则数等于 8，防止漏写）。

- [ ] **Step 2: 跑一遍确认失败。** `pnpm vitest run src/renderer/src/styles-contrast.test.ts` → 新 describe FAIL（token 列表为空）。

- [ ] **Step 3: 在 `styles.css` 加 token 和类。** 浅色起始值：ask `#b91c1c`、merge `#166534`、stuck `#6d28d9`、butler `#92400e`、agent `#1d4ed8`、external `#5f5f5a`、done `#2f7a4d`、idle `var(--muted)`；深色：ask `#f87171`、merge `#4ade80`、stuck `#c4b5fd`、butler `#fbbf24`、agent `#6b9cf0`、external `#9b9b96`、done `#86d9a6`、idle `var(--muted)`。这些只是起点，以测试通过为准（`--turn-idle` 引用 `--muted` 时 `resolve` 会递归解析，可以保留 `var()`）。三个基础类按上面 Interfaces 写；`.turn-tag` 是行内小标签（`font-size: 11px; padding: 1px 6px; border-radius: 4px`），`.turn-bar` 是 `display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--border)`，子 `i` 宽度由行内 style 给。

- [ ] **Step 4: 跑测试确认通过。** `pnpm vitest run src/renderer/src/styles-contrast.test.ts` → PASS（原有 D-14 用例不能变红）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/styles.css src/renderer/src/styles-contrast.test.ts
git commit -m "feat(ui): turn colour tokens with contrast test"
```

---

### Task 2: 首页和全部工作的纯函数 `home-view.ts`，加文案

**Files:**
- Create: `src/renderer/src/home-view.ts`
- Test: `src/renderer/src/home-view.test.ts`
- Modify: `src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`（新增 `hm` 命名空间，键见 Step 3）

**Interfaces:**
- Consumes（第 1 层）：`Turn`、`TurnItem`、`ScopeTurnRow`、`TurnBoard`、`TURN_PRIORITY`；`formatDuration(ms, S)`（`components/TicketActivity.tsx`，已存在）；`UiStrings`（`strings.ts`）；`Route`（`App.tsx`，仅类型）。
- Produces（Task 3 到 6 使用）：

```ts
export type TurnTone = "ask" | "merge" | "stuck" | "butler" | "agent" | "external" | "done" | "idle";
export const turnTone: (turn: Turn) => TurnTone;           // answer、review → ask；merge → merge；stuck、unattended → stuck；butler → butler；其余按 owner
export const YOU_KIND_ORDER: readonly ["answer", "review", "stuck", "unattended", "merge", "butler"];
export const HOME_CARD_CAP = 20;
export const HOME_SCOPE_CAP = 8;

export function youCards(items: TurnItem[]): TurnItem[];   // 只留 owner === "you"；按 YOU_KIND_ORDER，同类 since 小的在前
export function capCards(cards: TurnItem[], expanded: boolean): { shown: TurnItem[]; hidden: number };
export function homeTitle(n: number, S: UiStrings): string;
export function homeLede(c: TurnBoard["counts"], S: UiStrings): string;

export type CardAction = { id: "answer"; option: string; primary: boolean } | { id: "openPr" | "look" | "fix" | "send"; primary: boolean };
export function cardActions(item: TurnItem): CardAction[];  // 1–3 个，规则见 Step 3
export function prUrl(item: TurnItem): string | null;       // review → turn.url，其余 → item.pr?.url ?? null
export function lookTarget(item: TurnItem): { ticketKey: string; sessionId: string | null } | null;

export interface NameCtx { epics: Map<number, string>; features: Map<number, string>; tickets: Map<string, string | null> }
export function locationOf(item: TurnItem, ctx: NameCtx, now: number, S: UiStrings): { path: string; age: string };

export function visibleScopes(rows: ScopeTurnRow[]): { shown: ScopeTurnRow[]; hidden: number };
export function barSegments(bar: ScopeTurnRow["bar"], total: number): { tone: TurnTone; pct: number }[];
export function scopeRoute(row: ScopeTurnRow): Route;
export function scopeLine(row: ScopeTurnRow, S: UiStrings): string;
export function scopeWho(row: ScopeTurnRow, S: UiStrings): { tone: TurnTone | null; text: string };  // 你 N / agent / 外部 / 合了 / 没开始

export interface RunningRow { key: string; ticketKey: string | null; owner: "agent" | "external"; who: string; sentence: string; age: string }
export function runningRows(items: TurnItem[], S: UiStrings, now: number): RunningRow[];  // 只 owner 为 agent、external；since 小（等得久）的在前
export function topItem(items: TurnItem[], ticketKey: string): TurnItem | null;           // 该 ticket 里 TURN_PRIORITY 最小的一项
```

- [ ] **Step 1: 写失败的测试 `home-view.test.ts`。** 用一个 `item(turn, o?)` 小工厂造 `TurnItem`。断言：
  - `turnTone`：answer 和 review 都是 `ask`；unattended 是 `stuck`；`{owner:"external",kind:"ci_running",names:[]}` 是 `external`；merged 是 `done`。
  - `youCards`：混入 agent、external 项后只剩 you；顺序是 answer、review、stuck、unattended、merge、butler，同类按 `since` 升序；输入不被改动。
  - `capCards`：25 张时 `expanded=false` → `shown.length === 20`、`hidden === 5`；`expanded=true` → 25、0；3 张 → 3、0。
  - `homeTitle(0, S)` 等于 `S.hm.titleZero`，`homeTitle(3, S)` 等于 `S.hm.title(3)`；英文下 `title(1)` 是 `1 thing needs you`、`title(2)` 是 `2 things need you`（用 `STRINGS.en.hm`）。
  - `homeLede({you:0,agent:5,external:2,mergedToday:5}, S)` 等于 `S.hm.lede(5,2,5)`；三个都是 0 时等于 `S.hm.ledeIdle`。
  - `cardActions`：answer 带 3 个选项且 `askId=7` → `[answer 选项1(primary), answer 选项2, look]`（只取前 2 个选项）；answer 且 `askId=null` → 只有 `[look(primary)]`；answer 且选项为空 → `[look(primary)]`；merge 且有 `pr.url` → `[openPr(primary), look]`；merge 没有 url → `[look(primary)]`；review → `[openPr(primary)]`；stuck 且 `featureId=3`、`sessionId="s"` → `[look(primary), fix]`，`featureId=null` 或 `sessionId=null` → `[look(primary)]`；unattended 且 `canSend` 且 `ticketKey`、`pr` 非空 → `[send(primary), look]`，`canSend=false` → `[look(primary)]`；butler → `[]`。
  - `lookTarget`：`ticketKey=null` → null；answer 项带 `sessionId` → `{ticketKey, sessionId}`；merge 项 → `{ticketKey, sessionId:null}`。
  - `locationOf`：ticket 在 feature 在 epic 里 → `path === "Epic名 › Feature名 › BTL-1"`；单独 ticket → 只有 ticket 号（有标题时 `BTL-1 标题` 不加，标题只给 `title`，所以 path 只放号）；review 项 → `path === "acme/app#12 · bob"`，`age` 用「请你多久了」的 `formatDuration`；找不到名字的 epic（已归档）→ 跳过那一段，不写 `undefined`。
  - `visibleScopes`：10 行 → 先按 `youCount` 降序、全合了（`merged === total && total > 0`）的排最后，取 8 行，`hidden === 2`；输入不被改动。
  - `barSegments`：`bar={done:6,agent:2,you:1,external:1,idle:0}`、`total=10` → 顺序 done、agent、you、external（`idle` 为 0 不出），百分比 60/20/10/10，tone 依次 `done`、`agent`、`ask`、`external`；`total=0` → `[]`。`you` 段的 tone 固定用 `ask`。
  - `scopeRoute`：epic → `{page:"epic", id}`；feature → `{page:"feature", id}`；ticket → `{page:"ticket", key: String(id)}`。
  - `scopeLine`：`total=15, merged=9, slowest="收尾"` → `S.hm.scopeLine(15,9,"收尾")`；`total=0` → `S.hm.scopeEmpty`。
  - `scopeWho`：`youCount=2` → `{tone:"ask", text:S.hm.whoYou(2)}`；无 you、`bar.agent>0` → agent；只有 external → external；`total>0 && merged===total` → done；其余 → idle。
  - `runningRows`：you、done、idle 的项被排除；agent 项 `who === S.hm.whoAgent`；`ci_running` 且 `names=[]` → `who === S.hm.whoCi`；`awaiting_review` 且 `names=["bob","amy"]` → `who === "bob, amy"`；`sentence` 等于 `turnSentence(turn, item, S)`。
  - `topItem`：同一 ticket 有 agent 项和 you 项时取 you 项；没有该 ticket 返回 null。

- [ ] **Step 2: 跑测试确认失败。** `pnpm vitest run src/renderer/src/home-view.test.ts` → FAIL（模块不存在）。

- [ ] **Step 3: 实现 `home-view.ts` 和 `hm` 文案。** 实现按上面签名；`scopeWho`、`runningRows` 的文字都从 `S.hm` 取。`hm` 命名空间在 `strings.ts` 和 `strings-en.ts` 各加一份，键（函数写成参数个数一致）：
  - 标题与一句话：`title(n)`（「N 件事轮到你」/ `N thing(s) need(s) you`）、`titleZero`（「没有事轮到你」）、`lede(agent, external, merged)`（「agent 在处理 N 个，在等 CI 或别人 N 个，今天合了 N 个。」）、`ledeIdle`（「现在没有在跑的事。」）。
  - 类型标签 `kind`：`answer`「要你回答」、`merge`「可以合并」、`review`「要你 review」、`stuck`「卡住了」、`unattended`「没人推进」、`butler`「Butler 要你点一下」。
  - 按钮 `act`：`openPr`「打开 PR」、`look`「去看看」、`fix`「开修复 session」、`send`「送给 agent」；`answered(text)`「已回答：…，等 session 停下来后送进去」、`answerGone`「这个问题已经没了」、`sendNot(reason)`「没送出去：…」、`fixNot(reason)`。
  - 卡片位置：`askedAgo(d)`「N 前问的」类似的时间后缀统一成 `ago(d)`（「d 前」），review 用 `reviewAgo(d)`（「请你 d 了」）。
  - 小表：`scopesHeading`「各个 epic」、`scopeLine(total, merged, slowest)`（「15 个里合了 9 个 · 最慢的是「X」」，`slowest` 为 `null` 时不带后半句）、`scopeEmpty`「还没有 ticket」、`scopeMore(n)`「全部工作里看全部 n 个」、`whoYou(n)`「你 n」、`whoAgent`「agent」、`whoCi`「CI」、`whoExternal`「外部」、`whoDone`「合了」、`whoIdle`「没开始」。
  - 进行中与运行情况：`running(n)`「进行中 n」、`moreHeading`「运行情况」、`showAll(n)`「显示全部 n 件」。
  - 失败与空：`boardFailed`「取不到「轮到你」的数据」、`boardStale`「数据可能不是最新的」、`retry`「重试」、`noWork`「还没有任何工作。」。

  `locationOf` 里 `age` 的 `since` 来自 `item.since`，`now` 由调用方传入（便于测试）。

- [ ] **Step 4: 跑测试确认通过。** `pnpm vitest run src/renderer/src/home-view.test.ts src/renderer/src/strings.test.ts` → PASS（`strings.test.ts` 会校验中英文键一致、英文无中文）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/home-view.ts src/renderer/src/home-view.test.ts src/renderer/src/strings.ts src/renderer/src/strings-en.ts
git commit -m "feat(ui): pure view functions and copy for the Your-turn home"
```

---

### Task 3: 取数 hook、Notice 抽出、`TurnCard`

**Files:**
- Create: `src/renderer/src/components/useTurnBoard.ts`、`src/renderer/src/components/Notice.tsx`、`src/renderer/src/components/TurnCard.tsx`
- Modify: `src/renderer/src/components/NowPage.tsx`（只是把 `Notice`、`noticeKey` 剪走，改成 import；整个文件在 Task 4 删除）
- Test: `src/renderer/src/components/home-render.test.ts`（本任务建文件，先写卡片部分）

**Interfaces:**
- Consumes: Task 2 的 `cardActions`、`locationOf`、`lookTarget`、`prUrl`、`turnTone`、`NameCtx`；第 1 层的 `turnSentence`、`api.turnBoard`、`api.onTurnChanged`、`api.turnSendToAgent`；现有 `api.answerInbox(id: number, text: string): Promise<boolean>`、`api.prOpen(url)`、`api.openFixSession({featureId, stuckSessionId})`、`noticeText`（`availability-view.ts`）。
- Produces:

```ts
// useTurnBoard.ts
export interface TurnBoardState { board: TurnBoard | null; error: string | null; reload: () => void }
export function useTurnBoard(filter?: { epicId?: number; featureId?: number; ticketKey?: string }): TurnBoardState;
// Notice.tsx（原样搬出，testid 保持 now-notice-*）
export function Notice(props: { notice: NowNotice; now: number; onOpen: (t: NowTarget) => void; onGo: (r: Route) => void }): JSX.Element;
export function noticeKey(n: NowNotice): string;
// TurnCard.tsx
export interface TurnCardProps {
  item: TurnItem; ctx: NameCtx; now: number;
  onLook: (t: { ticketKey: string; sessionId: string | null }) => void;
  onFix: (featureId: number, sessionId: string) => void;   // 调 api.openFixSession 并导航由 App 做，失败由 App 报错
  onOpen: (t: NowTarget) => void; onGo: (r: Route) => void;  // 给 butler 卡的 Notice
  onChanged: () => void;                                     // 回答 / 送出后让首页重拉
}
export function TurnCard(props: TurnCardProps): JSX.Element;
```

- [ ] **Step 1: 写失败的卡片渲染测试。** 在 `home-render.test.ts` 里（`createElement` + `renderToStaticMarkup`，`TurnCard` 里用到 `useState` 没问题；不要在测试里调 api）：
  - answer 卡（选项 `["可以","不行，先回测"]`、`askId=7`）：HTML 含 `class="turn-tag turn-ask"` 和 `S.hm.kind.answer`、两个选项按钮文字、`S.hm.act.look`、`turnSentence` 给的那句话、位置 `Epic名 › Feature名 › BTL-1`；`askId=null` 时不含选项按钮。
  - merge 卡：含 `S.hm.act.openPr` 和 `class="turn-tag turn-merge"`。
  - review 卡：位置是 `acme/app#12 · bob`，没有「去看看」。
  - stuck 卡：有 `featureId` 和 `sessionId` 时含「开修复 session」，`featureId=null` 时不含。
  - butler 卡：含 `data-testid="now-notice-<kind>"`（`Notice` 渲染进去了）和 `S.hm.kind.butler`，没有 `S.hm.act.look`。
  - 名字很长：卡片里位置元素带 `title` 属性等于完整路径。
  - 同一份测试里 import `noticeKey`，断言 `{kind:"lessons_paused"}` → `"lessons_paused"`、`cost` → `cost:<subjectKind>:<subjectId>`（防止搬运时改坏）。

- [ ] **Step 2: 跑测试确认失败。** `pnpm vitest run src/renderer/src/components/home-render.test.ts` → FAIL。

- [ ] **Step 3: 实现。**
  - `Notice.tsx`：把 `NowPage.tsx` 里的 `noticeKey`、`Notice` 整段剪过来，只改一处：`stacks`、`intake` 两个动作原来 `onGo({ page: "progress" })`，改成 `onGo({ page: "all", section: "stacks" })` / `onGo({ page: "all", section: "intake" })`（`Route` 的新成员在 Task 6 加；本任务先用，类型检查在 Task 6 才全绿，所以本任务的验证只跑 vitest）。
  - `useTurnBoard.ts`：`api.turnBoard(filter)` 取一次，之后每次 `api.onTurnChanged` 事件防抖 80ms 重取（参照 `useStateRefetch.ts`，用序号保证只写最新一次）；成功清掉 `error`；失败只设 `error`（用 `errorText`/`reportError` 里已有的取文字办法，不抛），**不清掉旧 `board`**；`filter` 变化用序列化后的 key 重新订阅；`reload()` 立刻重取。
  - `TurnCard.tsx`：卡片结构 = 标签 `<span class="turn-tag turn-{tone}">` + 一句话（`turnSentence`）+ 位置行（`path` 单行省略、带 `title`，后面 `age`）+ 按钮区。按钮按 `cardActions(item)` 渲染，`primary` 加 `primary` 类。动作：answer → `api.answerInbox(turn.askId, option)`，返回 `false` 显示 `S.hm.act.answerGone` 并 `onChanged()`，返回 `true` 把卡片按钮换成 `S.hm.act.answered(option)`；`openPr` → `api.prOpen(prUrl(item)!)`；`look` → `onLook(lookTarget(item)!)`；`fix` → `onFix(item.featureId!, turn.sessionId!)`；`send` → `api.turnSendToAgent({ticketKey, pr:{repo, number}})`，`ok:false` 显示 `S.hm.act.sendNot(reason)`，成功 `onChanged()`。每个按钮点击期间 `disabled`，错误用 `reportError`。butler 卡：标签 + `<Notice notice={turn.notice} ...>`，不出 `cardActions`。样式类加在 `styles.css` 末尾：`.turn-card`（flex，`min-width:0`）、`.turn-card .where`（`overflow:hidden; text-overflow:ellipsis; white-space:nowrap`）。

- [ ] **Step 4: 跑测试确认通过。** `pnpm vitest run src/renderer/src/components/home-render.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components src/renderer/src/styles.css
git commit -m "feat(ui): turn board hook, extracted Notice, and TurnCard"
```

---

### Task 4: 首页 `HomePage`，删 `NowPage` 和旧状态算法

**Files:**
- Create: `src/renderer/src/components/HomePage.tsx`、`src/renderer/src/components/HomeMore.tsx`
- Delete: `src/renderer/src/components/NowPage.tsx`
- Modify: `src/renderer/src/now-view.ts`、`src/renderer/src/now-view.test.ts`、`src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`、`src/renderer/src/styles.css`
- Test: `src/renderer/src/components/home-render.test.ts`（追加）、`src/renderer/src/now-view.test.ts`

**Interfaces:**
- Consumes: Task 2、Task 3 的全部产出；`NowView`（`api.nowView()`，给 `HomeMore`）；`LiveWindow`、`useCollapsed`、`useNow`、`SetupSkipped` 的原有实现（搬运）。
- Produces:

```ts
export interface HomeBodyProps {
  board: TurnBoard | null;
  /** 最近一次拉取的错误；board 非空时表示「旧数据」。 */
  error: string | null;
  noWork: boolean;
  firstRun: ReactNode;
  ctx: NameCtx;
  now: number;
  nowView: NowView | null;            // 给 HomeMore
  liveTickets: Set<string>;
  onRetry: () => void;
  onLook: TurnCardProps["onLook"]; onFix: TurnCardProps["onFix"]; onOpen: TurnCardProps["onOpen"]; onGo: (r: Route) => void;
  onOpenTicket: (key: string) => void;
  onResumeSetup: () => void;
}
export function HomeBody(p: HomeBodyProps): JSX.Element;   // 纯展示，渲染测试用它
export function HomePage(p: Omit<HomeBodyProps, "now" | "board" | "error" | "onRetry"> & { state: TurnBoardState }): JSX.Element; // 只多一个 useNow，供 App 用
export function NoWorkLine(p: { onNewTicket: () => void; onNewFeature: () => void; onNewEpic: () => void }): JSX.Element; // 过渡，第 6 层删
```

- [ ] **Step 1: 写失败的测试。** `home-render.test.ts` 追加 `describe("HomeBody")`，每个用例造 `board`：
  - 3 件轮到你 + 其余：HTML 含 `S.hm.title(3)`、`S.hm.lede(...)`、三张卡的标签、各个 epic 小表里每个 epic 的 `scopeLine`、`<div class="turn-bar">`（进度条）和 `S.hm.whoYou(2)`；「进行中」折叠标题含 `S.hm.running(N)` 且 N 是 `runningRows` 的长度，折叠时（默认）不含行内容。
  - 0 件：HTML 含 `S.hm.titleZero`，不含 `turn-card`，仍含小表。
  - 25 件：只出现 20 个 `turn-card`，且含 `S.hm.showAll(5)`。
  - 12 个 epic：小表只有 8 行，含 `S.hm.scopeMore(4)`。
  - `board=null, error="boom"`：含 `S.hm.boardFailed` 和 `S.hm.retry`，不含 `S.hm.titleZero`。
  - `board` 有、`error="boom"`：含 `S.hm.boardStale` 且仍含卡片。
  - `board=null, error=null`：含 `S.loading`。
  - `noWork=true`：只渲染 `firstRun` 传进来的节点（用一个带 `data-testid="first-run"` 的节点断言出现），不含标题。
  - 名字很长（200 字符的 epic 名）：小表该行元素带 `title`。
  - 「运行情况」默认折叠：不含 `MemoryCard`/用量文字（给 `nowView` 一份带 `mem` 的数据也不出现）。
  在 `now-view.test.ts` 里删掉 `needsYouText`、`rowText`、`groupSummary`、`rowPlace`、`needsYouTotal` 的用例（保留 `prPill`、`usage*`、`live*`、`mergeEvents`、`wirePath`、`rowLabel`、`inboxWho` 的）。

- [ ] **Step 2: 跑测试确认失败。** `pnpm vitest run src/renderer/src/components/home-render.test.ts src/renderer/src/now-view.test.ts` → home-render FAIL。

- [ ] **Step 3: 实现 `HomeBody` / `HomePage`。** 顺序：`SetupSkipped`（从 `NowPage` 搬来，向导点过「稍后再说」的提醒）→ 标题 `<h2>`（`homeTitle`）→ `lede`（`homeLede`）→ 失败条 → 卡片（`capCards`，「显示全部」按钮是组件内 `useState`）→ 「各个 epic」小表（`visibleScopes`；每行点击 `onGo(scopeRoute(row))`；一句状态 `scopeLine`、`<div class="turn-bar">` 里 `barSegments` 的 `<i class="turn-<tone>" style={{width}}>`、`youCount>0` 时一个 `turn-tag turn-ask` 写 `S.hm.whoYou`）→ 「进行中 N」折叠（`useCollapsed("home:running")`，这个记号的意思是「展开了」，和原来其它折叠一致；行 = ticket 号、`who`、`sentence`、`age`，整行点击 `onOpenTicket`）→ 「运行情况」折叠（`useCollapsed("home:more")`，内容 `HomeMore`，原样搬 `MemoryCard`、`RecentMerges`、`IntakeRecent`、`UsageLine`、`LiveWindow` 及其 `GroupToggle`、`useUsage`；`IntakeRecent` 的按钮改成 `onGo({ page: "all", section: "intake" })`）。`noWork` 为真时整页只渲染 `firstRun`（`SetupSkipped` 仍在上面）。`HomePage` 只是 `useNow()` 加一个 `HomeBody`。`NoWorkLine` 约 15 行：`S.hm.noWork` 加三个调用已有新建回调的按钮（文案用 `S.newTicket`、`S.newFeature`、`S.newEpic`）。

- [ ] **Step 4: 删旧的。**
  - 删除 `NowPage.tsx`（Task 3 已把 `Notice` 剪走，其余都在 `HomeMore.tsx`/`HomePage.tsx`）。
  - `now-view.ts` 删：`RowTone`、`stoppedKind`、`isStuck`、`needsYouText`、`prText`、`rowText`、`groupSummary`、`rowPlace`、`needsYouTotal`，以及随之无用的 import（`activityText`、`NowCounts`、`SessionActivity`）。保留的：`rowKey`、`prPill`、`usageLine`、`usageDetails`、`rowLabel`、`inboxWho`、`allRows`、`liveNeeds`、`liveRows`、`livePill`、`eventKey`、`mergeEvents`、`liveMemoryLine`、`Box`、`wirePath`（`LiveWindow`、`PrStages`、`FeaturePage` 还在用）。
  - `strings.ts` / `strings-en.ts` 删掉不再被引用的 `now*` 键：逐个 `grep -rn "S\.<key>\b\|<key>:" src e2e`，零引用才删（候选：`nowTitle`、`nowRunning`、`nowNeedsYou`、`nowOpen`、`nowNoEpic`、`nowNoFeature`、`nowWaitingFor`、`nowStuck`、`nowStuckWith`、`nowStuckNoReason`、`nowMergeQueued`、`nowRefreshing`、`nowClosing`、`nowStopped`、`nowWaitCi`、`nowWaitReview`、`nowChangesRequested`、`nowApproved`、`nowActive`、`nowNeedsYouCount`、`nowWaitingDecision`、`nowStuckCount`、`nowNoneActive`、`nowIdle`；`nowCiFailed`、`nowCiRunning`、`nowPr`、`nowPrUnavailable`、`nowRecentMerges`、`nowUsage*`、`nowNeedsYouBadge` 仍有人用，保留）。
  - `styles.css` 删掉只给 `NowPage` 用的规则：`.now-needs`、`.now-need`、`.now-epic`、`.now-feature`、`.now-row`（`LiveWindow` 用到的 `.now-*` 先 grep 再删）、`.now-top`。

- [ ] **Step 5: 跑测试确认通过。** `pnpm vitest run src/renderer/src/components/home-render.test.ts src/renderer/src/now-view.test.ts src/renderer/src/strings.test.ts` → PASS。（`pnpm typecheck` 要等 Task 6 接上 `App` 才全绿，这里不跑。）

- [ ] **Step 6: Commit**

```bash
git add -A src/renderer/src
git commit -m "feat(ui): Your-turn home replaces the Now page"
```

---

### Task 5: 侧栏

**Files:**
- Create: `src/renderer/src/sidebar-view.ts`、`src/renderer/src/sidebar-view.test.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx`、`src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`、`src/renderer/src/styles.css`
- Delete: `src/renderer/src/group.ts`、`src/renderer/src/group.test.ts`（先 `grep -rn "group\"" src` 确认只有 `Sidebar` 引用过）
- Test: `src/renderer/src/components/home-render.test.ts`（追加侧栏渲染）

**Interfaces:**
- Consumes: Task 2 的 `TurnTone`、`turnTone`、`YOU_KIND_ORDER`；`TurnItem`、`TURN_PRIORITY`。
- Produces:

```ts
// sidebar-view.ts
export interface Dot { tone: TurnTone; you: number }
export const dotKey = (kind: "epic" | "feature" | "ticket", id: number | string): string => `${kind}:${id}`;
/** 每个 epic / feature / ticket 一个点：tone 取下面最急的一项（TURN_PRIORITY，你 > agent > 外部；同在「你」里按 YOU_KIND_ORDER），you 是下面轮到你的件数；done、idle 不出点。 */
export function scopeDots(items: TurnItem[], featureEpic: Map<number, number | null>): Map<string, Dot>;
export const youBadge = (n: number): string; // 99 以内原样，超过写 "99+"

// Sidebar.tsx 的 Props（替换原来的）
interface Props {
  tickets: TicketView[]; features: FeatureView[]; epics: EpicView[];
  youCount: number | null;           // null = 还没取到过；0 和 null 都不显示徽标
  dots: Map<string, Dot>;
  route: Route; onNavigate: (r: Route) => void;
  keepAwake: boolean; onKeepAwake: (on: boolean) => void;
}
```

- [ ] **Step 1: 写失败的测试。**
  - `sidebar-view.test.ts`：同一个 ticket 下有 agent 项和 answer 项 → 该 ticket 的 Dot 是 `{tone:"ask", you:1}`；feature 下两个 ticket（一个 merge、一个 answer）→ feature 点 `tone:"ask"`、`you:2`；epic 通过 `item.epicId` 汇总，`item.epicId===null` 但 `featureId` 在 `featureEpic` 里时也汇总到那个 epic；只有 merged、not_started 的项不出点；只有 agent 项 → `{tone:"agent", you:0}`；`youBadge(7)==="7"`、`youBadge(100)==="99+"`。
  - 侧栏渲染（`home-render.test.ts`）：给 2 个 epic（各 1 个 feature、各 1 个 ticket）、1 个单独 ticket：HTML 按顺序含 `S.home`、`S.allWork`、树里的名字、`S.butlerNav`、`S.selfGroup`、`S.lessons`、`S.effectNav`、`S.audit`、`S.settings`、`S.keepAwake`；不含 `S.newTicket`、`S.progressNav`、`S.unclaimed`、`S.archived`；`youCount=3` 时含 `needs-you-badge` 和 `S.nowNeedsYouBadge(3)` 的隐藏描述（保持原来的无障碍做法：按钮名固定是 `S.home`，数字走 `aria-describedby`）；`youCount=0` 和 `null` 时都不含 `needs-you-badge`；有点的 epic 行含 `turn-dot turn-ask`，没点的 ticket 行不含 `turn-dot`；名字 200 字符的 ticket 行含 `title` 属性且 `.key`（ticket 号）完整。

- [ ] **Step 2: 跑测试确认失败。** `pnpm vitest run src/renderer/src/sidebar-view.test.ts src/renderer/src/components/home-render.test.ts` → FAIL。

- [ ] **Step 3: 实现 `scopeDots`、`youBadge` 和侧栏。** 侧栏从上到下：`nav home`（保留 `.nav.home`、`.needs-you-badge`、`aria-label`/`aria-describedby` 的做法）→ `nav all`（`S.allWork`；`route.page` 为 `all`、`unclaimed`、`archived` 时高亮）→ 树（`.ticket-groups`，`overflow-y:auto; min-height:0; flex:1`）→ `nav butler`（`S.butlerNav`）→ 分组标题 `S.selfGroup` → 复盘与规矩（`S.lessons`，保留待处理数和 `data-testid="lessons-nav"`）、`nav effect`（`data-testid="nav-effect"`）、审计、设置 → `keep-awake` 放最底。树的结构沿用现有类名（`.feature-group`、`.epic-group`、`.feature-row`、`.feature-tickets`、`.ticket`、`.ticket.feature`、`.key`、`.title`、`.twisty`），这样不用改既有 e2e 选择器：epic（`EpicGroup`）→ 不在 epic 里的 feature（`FeatureGroup`，不再有「Feature」小标题）→ 单独的 ticket（平铺，不再按状态分组，不再有小标题）。每个节点把原来的 `●` 等待标记和 `.stuck-mark` 换成 `<span class="turn-dot turn-{tone}">`（有 `dots` 项时才渲染，`title` 用 `S.hm.dotTitle[tone]`）和 `you>0` 时的 `<span class="cnt">{you}</span>`；`GroupRow` 的 `waiting`、`stuck` 两个 props 改成 `dot: Dot | null`。树里 ticket 的行名字沿用现有 `.key` + `.title`，加 `title` 属性。文案：`S.home` 改成「轮到你」/ `Your turn`，`S.butlerNav` 改成「总控」/ `Overseer`，`S.lessons` 改成「复盘与规矩」/ `Retros and rules`，`S.effectNav` 改成「效果与花费」/ `Impact and cost`；新增 `S.allWork`「全部工作」/ `All work`、`S.selfGroup`「Butler 自己」/ `Butler itself`、`S.hm.dotTitle`（每个 `TurnTone` 一句：「要你回答」「可以合并」「卡住了」「Butler 要你点一下」「agent 在处理」「在等别人」…）。删掉 `S.epics`、`S.features`（侧栏的小标题）、`S.progressNav` 若无别处引用。`group.ts` 和它的测试删除。树的 CSS：`.turn-dot` 在 `.ticket`、`.feature-row` 里右对齐，`.cnt` 用 `--turn-ask`。

- [ ] **Step 4: 跑测试确认通过。** `pnpm vitest run src/renderer/src/sidebar-view.test.ts src/renderer/src/components/home-render.test.ts src/renderer/src/strings.test.ts` → PASS。

- [ ] **Step 5: Commit**

```bash
git add -A src/renderer/src
git commit -m "feat(ui): slim sidebar with turn dots and the Butler-itself group"
```

---

### Task 6: 全部工作页，接上 `App`，拆进度页入口

**Files:**
- Create: `src/renderer/src/components/AllWorkPage.tsx`
- Modify: `src/renderer/src/App.tsx`、`src/renderer/src/components/ProgressPage.tsx`、`src/renderer/src/components/FeaturePage.tsx`、`src/renderer/src/components/EpicPage.tsx`、`src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`、`src/renderer/src/styles.css`
- Test: `src/renderer/src/components/home-render.test.ts`（追加）、`src/renderer/src/route-view.test.ts`（确认不受影响，不改）

**Interfaces:**
- Consumes: Task 2 的 `scopeRoute`、`scopeLine`、`scopeWho`、`barSegments`、`topItem`、`turnSentence`；`ManagedStacks`（`StacksPanel.tsx`，`filter: {epicId:null, featureId:null}`）、`IntakeQueue`；`featuresOutsideEpics`（`epic-row.ts`）。
- Produces:

```ts
// App.tsx 的 Route 变更：删 { page: "progress"; ... }，加
| { page: "all"; section?: "stacks" | "intake" }

export interface AllWorkBodyProps {
  board: TurnBoard | null; epics: EpicView[]; features: FeatureView[]; tickets: TicketView[]; // tickets = 单独的 ticket
  unclaimedCount: number; now: number; focusMore?: "stacks" | "intake";
  onNewTicket: () => void; onNewFeature: () => void; onNewEpic: () => void;
  onGo: (r: Route) => void; onOpenTicket: (key: string) => void;
}
export function AllWorkBody(p: AllWorkBodyProps): JSX.Element;
export function AllWorkPage(p: AllWorkBodyProps): JSX.Element;  // 直接渲染 AllWorkBody，折起来的「栈与自动接活」在 Body 里
```

- [ ] **Step 1: 写失败的测试。** 追加 `describe("AllWorkBody")`：
  - 2 个 epic、1 个单独 ticket：HTML 含三个新建按钮文字（`+ ${S.newTicket}`、`+ ${S.newFeature}`、`+ ${S.newEpic}`）、`S.archived` 按钮、`S.unclaimed` 按钮；`unclaimedCount=1` 时按钮上带 `· 1`，为 0 时不带数字但按钮仍在；表头四列 `S.hm.all.colName/colWho/colNow/colProgress`；每个 epic 行含 `scopeWho`（`S.hm.whoYou(2)`）、`scopeLine`、进度条；单独 ticket 行的「现在怎么样」是该 ticket `topItem` 的 `turnSentence`。
  - `board=null`：表格仍画（名字有、其余列是 `—`），不报错。
  - 一行的 `scopes` 里找不到（新建的 epic 还没有统计）：该行进度列 `—`，不是空白或 `NaN`。
  - 没有任何 epic/feature/ticket：显示 `S.hm.all.empty` 一句话，三个新建按钮还在。
  - 200 字符的名字：名字格带 `title`。
  - `focusMore="stacks"`：「栈与自动接活」折叠默认展开；不传时折叠且不含 `managed-stacks`。

- [ ] **Step 2: 跑测试确认失败。** `pnpm vitest run src/renderer/src/components/home-render.test.ts` → FAIL。

- [ ] **Step 3: 实现 `AllWorkPage`。** 标题 `S.allWork`，一句话 `S.hm.all.lede(epics, loose)`（「2 个 epic、1 个单独的 ticket。」；英文单复数）。按钮行：三个新建、右边「已归档」（`onGo({page:"archived"})`）、「未认领的 session · N」（`onGo({page:"unclaimed"})`）。表：行来自 App 传入的列表（epic、不在 epic 里的 feature、单独 ticket），按 `scopes` 里 `${kind}:${id}` 找统计，行序 = `youCount` 降序再按名字；名字格是按钮，点击走 `scopeRoute`（ticket 走 `onOpenTicket`）。底部「栈与自动接活」折叠（本地 `useState(focusMore !== undefined)`，不写 `useCollapsed`，因为这是临时落点），里面 `<ManagedStacks filter={{epicId:null, featureId:null}} onOpenTicket>` 和 `<IntakeQueue onOpenTicket>`。文案加 `S.hm.all`：`lede(epics, loose)`、`colName`、`colWho`、`colNow`、`colProgress`、`empty`、`unclaimedBtn(n)`、`moreHeading`。

- [ ] **Step 4: 接上 `App.tsx`。**
  - `Route`：删 `progress`，加 `all`。`routeGone` 不用改。
  - `useTurnBoard()` 一份；`youCount = board?.counts.you ?? null`；`dots = scopeDots(board?.items ?? [], featureEpic)`（`featureEpic` 由 `features` 列表建）；`ctx`（`NameCtx`）由 `epics`、`features`、`allTickets` 建。
  - `refresh()` 里去掉 `needsYouTotal(nowView)`；`nowView` 仍取（给 `HomeMore` 和 `ButlerPage`）。
  - `onLook({ticketKey, sessionId})` → `openTicket(ticketKey, sessionId ? {ticketKey, sessionId} : undefined)`（归档了的 ticket 沿用 `openTicket` 现有的报错）。
  - `onFix(featureId, sessionId)` → `api.openFixSession({featureId, stuckSessionId: sessionId})`；`ok` 时 `setRoute({page:"feature", id: featureId})`，失败 `reportError(new Error(S.openErrors[r.reason] ?? r.reason))`。
  - 渲染：`home` → `<HomePage .../>`（`noWork={allTickets.length + epics.length + features.length === 0}`，`firstRun={<NoWorkLine .../>}`）；`all` → `<AllWorkPage .../>`；删掉 `progress` 分支和 `ProgressPage`、`NowPage`、`needsYouTotal` 的 import；`Sidebar` 去掉 `onNew*`、`unclaimedCount`、`needsYouCount` 三个旧 props，传新的。新建对话框的开关（`showNew`、`showNewFeature`、`showNewEpic`）仍在 `App`，通过 `AllWorkPage` 的回调打开。
  - `FeaturePage`、`EpicPage` 删掉 `onOpenProgress` prop 和传给 `PrStuckBlock` 的那个值；`PrStuckBlock` 去掉「去进度页」按钮和 `onOpenProgress` prop；`strings` 里的 `prStagesOpenProgress` 若零引用则删。
  - `ProgressPage.tsx`：删 `ProgressPage` 函数、`Props`、与它独占的 import（`ManagedStacks`、`IntakeQueue`、`useState`、`useStateRefetch` 若不再用）；`ProgressBody` 里的 `<ManagedStacks>` 一并去掉（它已搬到全部工作页）；文件头加注释：`// 第 3 层接手：PR 表、待 review 队列、feature 分组并进 epic/feature/ticket 页后，整份文件和 progress-ui.ts 一起删。` 同步改 `progress-render.test.ts` 里依赖 `ManagedStacks` 的断言（如有）。

- [ ] **Step 5: 跑测试和类型检查。** `pnpm vitest run` 全量 → PASS；`pnpm typecheck` → 无错误；`pnpm lint` → 无错误（没有残留的未使用 import）。

- [ ] **Step 6: Commit**

```bash
git add -A src/renderer/src
git commit -m "feat(ui): All work page, route wiring, and progress page removal"
```

---

### Task 7: e2e 适配

**Files:**
- Create: `e2e/home.spec.ts`
- Modify: `e2e/fixtures.ts`（加 `openAllWork`、`newButton`、`openArchived`）、`e2e/now.spec.ts`（删被取代的用例，剩实况窗口那个）、`e2e/progress.spec.ts`、`e2e/epics.spec.ts`、`e2e/features.spec.ts`、`e2e/main-flow.spec.ts`、`e2e/pr-stages.spec.ts`，以及其它用到下面三类选择器的 spec
- Test: 这些 spec 本身

**Interfaces:**
- Produces（`fixtures.ts`）：

```ts
/** 点侧栏「全部工作」，等页面出来。 */
export async function openAllWork(page: Page): Promise<void>;
/** 先去全部工作页，再返回「+ 新建 ticket / feature / epic」按钮的 locator（给 create() 用）。 */
export async function newButton(page: Page, which: "newTicket" | "newFeature" | "newEpic"): Promise<Locator>;
/** 去全部工作页点「已归档」。 */
export async function openArchived(page: Page): Promise<void>;
```

- [ ] **Step 1: 摸清要改哪些。** `grep -rn "sidebar\").getByRole(\"button\", { name: \`+ \${\|S.archived\|S.progressNav\|S.unclaimed\|stuck-mark\|\.sidebar \.ticket \.badge\|ticket-groups section\|S.home\b\|\.now-" e2e/*.ts` 列出全部调用点（侧栏「+ 新建」约 40 处，集中在 epics、features、pr-stages、butler-reach、merge-gate 等）。逐类处理：
  - `.sidebar` 里的 `+ ${S.newEpic|newFeature}`：改成 `await newButton(page, "newEpic")` 取 locator 再传 `create(...)`；页面级的 `page.getByRole("button", {name: "+ 新建 ticket"})`（单独 ticket，`now.spec.ts` 的 `newTicket`、`ticket-edit`、`terminal-memory` 等）前面加 `await openAllWork(page)`；feature 页里的 `.feature-page` `+ 新建 ticket` 不用动。
  - `S.archived`：改用 `openArchived(page)`。
  - `.sidebar .ticket .badge`（`main-flow.spec.ts:38`）→ `.sidebar .ticket .turn-dot`，不再断言 `title === S.waiting`，改成断言 `turn-ask` 类；`.sidebar section` 按状态标题的断言（`main-flow.spec.ts:45`，`merged_pending_followup`）→ 改成断言该 ticket 仍在树里（散 ticket 不再分组）。
  - 侧栏里的 `.stuck-mark`（`epics.spec.ts` 471-472、`features.spec.ts` 613）→ `.turn-dot.turn-stuck` 或 `.turn-dot.turn-ask`，看那个场景下第 1 层算出来的是哪种（跑一遍看实际状态再定）；feature、epic **页面里**的 `.stuck-mark` 属第 3 层，不动。
  - `epics.spec.ts:115` 的 `.sidebar .ticket-groups section h3` 断言（原来是 Epic/Feature 小标题）→ 去掉那条（小标题已删）。
  - `.nav.home .needs-you-badge`（`features.spec.ts:620`、原 `now.spec.ts`）保持有效，期望数字按第 1 层的口径跑一遍确认。
  - `progress.spec.ts`：第一个用例（进度页每一块都在）整个删除；第二个用例（对外动作默认全关、审计页、Butler 回复 tab）的前半段若依赖 `openProgress` 则改为不经过进度页，保留设置和审计的断言；第三个用例（PR 等谁、栈、feature tab 的 stuck 块）里栈的部分改成 `openAllWork` 后展开「栈与自动接活」断言 `managed-stacks`，`openProgress` 删除。`stacks.spec.ts`、`intake.spec.ts`、`prereview.spec.ts` 里同样的 `openProgress`/`S.progressNav` 用法照此处理（`prereview` 的待 review 队列在第 3 层之前没有入口：把相关断言用 `test.fixme` 标上并写明「第 3 层恢复」，不要删）。
- [ ] **Step 2: 写 `e2e/home.spec.ts`。** 用假 claude 的 `/fake-ask`（见 `now.spec.ts` 的 `ASK_REPLY`、`typeLine`、`openSession`，从那里搬需要的小函数，ticket 号带数字，如 `HOME-1`）：
  1. 「要你回答」：session 问了问题 → 首页标题是 `S.hm.title(1)`，一张 `.turn-card` 带 `S.hm.kind.answer`，侧栏 `.nav.home .needs-you-badge` 是 `1`，`aria-describedby` 描述是 `S.nowNeedsYouBadge(1)`；点「去看看」落在那个 ticket 页且终端可见；回到首页点选项后卡片显示 `S.hm.act.answered(...)`。
  2. 0 件：没有任何问题时标题是 `S.hm.titleZero`，没有徽标，`aria-describedby` 不存在；「各个 epic」小表里有那个 feature。
  3. 空工作区（刚过完向导）：首页显示 `S.hm.noWork`（第 6 层会换掉，那时本断言改成第 6 层的元素）。
  4. 全部工作：点侧栏「全部工作」→ 三个新建按钮、`S.archived`、`S.unclaimed` 都在；新建一个 ticket 后表里有它；点「已归档」落到已归档页。
  5. 深浅两个主题下的可读性：把原 `now.spec.ts` 里「the Now page is readable in light and dark」的对比度换算函数搬来，对 `.turn-tag`、`.turn-card .where`、侧栏 `.turn-dot` 旁的 `.cnt` 算 ≥ 4.5；截图存到 `test-results/home-page`（`BUTLER_E2E_SHOTS_DIR` 优先）。
  `now.spec.ts` 里原来 `needs-you`、`groups collapse`、`readable` 三个用例删除（被 `home.spec.ts` 取代），实况窗口用例保留，且它 `newTicket`/`checkoutFeature` 里的新建按钮改走 `fixtures` 的 helper，并改为展开首页的「运行情况」再断言 `LiveWindow`。

- [ ] **Step 3: 跑。** `pnpm e2e e2e/home.spec.ts e2e/now.spec.ts e2e/progress.spec.ts` → PASS；再 `pnpm e2e` 全量一遍，逐个修剩下的选择器问题；改完全量 PASS（`test.fixme` 的除外，数量写进提交说明）。

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): follow the new sidebar, home and All work page"
```

---

### Task 8: 收尾核对：没有两套并存

**Files:**
- Modify: 按核对结果

- [ ] **Step 1: 逐条 grep，结果必须为空（除注明的）。**

```bash
git grep -nE "needsYouTotal|needsYouText|rowText\(|groupSummary|rowPlace|NowPage|page: \"progress\"|S\.progressNav|onOpenProgress" -- src e2e
git grep -nE "from \"\./group\"|from \"\.\./group\"" -- src
git grep -nE "now-needs|now-need\b|now-top|now-epic|now-feature" -- src e2e
```

唯一允许的残留：`ProgressPage.tsx`、`progress-ui.ts`、`progress-render.test.ts`（文件头带「第 3 层接手」注释）。

- [ ] **Step 2: 全量验证。** `pnpm typecheck && pnpm lint && pnpm vitest run` 全部通过；`pnpm e2e` 通过。

- [ ] **Step 3: 看一眼真界面。** 起 `pnpm dev`，用一个有 epic、feature、单独 ticket 的数据，浅色和深色各看首页、全部工作、侧栏一次，确认：颜色只出现 spec 表里的几种；窗口缩到最窄时卡片按钮不被挤出去；侧栏树滚动而「Butler 自己」组始终可见。

- [ ] **Step 4: Commit（若 Step 1–3 有修改）**

```bash
git add -A
git commit -m "chore(ui): sweep leftovers of the old Now and Progress pages"
```

---

## Self-Review 记录

- **Spec 覆盖：** §5.3 侧栏（Task 5）、首页五块（标题/一句话/卡片/小表/进行中，Task 2、3、4）、Butler 要你点一下（Task 3 的 `Notice`）、全部工作（Task 6）、进度页拆掉与两个入口按钮（Task 6）、§5.1 颜色（Task 1）、§5.2 规则 2 和 5（折叠块；空状态由 `noWork`/`firstRun` 约定留给第 6 层）。§5.2 规则 4（tab 记住、点进去落在对话或终端）：本层「去看看」带 `sessionId` 进 ticket 页并落在终端，对话 tab 属第 4、5 层，到时在 `onLook` 里改落点即可，本层不改。
- **已知缺口交给别层：** 内存卡、用量搬进「效果与花费」（第 3 层）；`ProgressBody` 等残留（第 3 层）；`NoWorkLine` 换成 `<FirstRunHome/>`（第 6 层）；`NowView.needsYou`、`decisions`、`notices` 字段在渲染进程已无人读，但主进程 `buildNowView` 仍产出，第 1 层或第 3 层决定何时删（`ButlerPage` 目前不读它们）。
