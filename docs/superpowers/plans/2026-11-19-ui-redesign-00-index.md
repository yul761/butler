# UI 重做：计划索引和共用接口

**Spec:** `docs/superpowers/specs/2026-11-19-ui-redesign-design.md`（已批准，commit 6a560e3）
**草图:** `.superpowers/brainstorm/1247-1795150005/content/full-mockup.html`

spec 里有 6 块，各自可以独立测试，所以拆成 6 份计划。每份计划对应栈里的一层，也就是一个 ticket、一个 PR，按顺序往上叠，每一层都建在下面一层的改动上。

| 层 | 计划 | 内容 | 依赖 |
|---|---|---|---|
| 1 | `2026-11-19-ui-redesign-01-turn-model.md` | 「谁该动」状态模型、数据接线、「请你 review」的查询、IPC | — |
| 2 | `2026-11-19-ui-redesign-02-home-nav.md` | 侧栏、首页（轮到你）、全部工作 | 1 |
| 3 | `2026-11-19-ui-redesign-03-layered-pages.md` | epic、feature、ticket 页的分层和 tab，总控页，「Butler 自己」各页的主层 | 1、2 |
| 4 | `2026-11-19-ui-redesign-04-conversation-store.md` | 对话另存、问答标记、换新不等用户、恢复提示带问答 | — |
| 5 | `2026-11-19-ui-redesign-05-conversation-tab.md` | 对话 tab、分叉讨论（先做缓存试验）、「按这个改」 | 3、4 |
| 6 | `2026-11-19-ui-redesign-06-settings-onboarding.md` | 设置的 4 个 tab、功能页、新用户空状态、向导结尾 | 2 |

第 4 层不依赖 1 到 3。不过为了按栈的顺序合并，它还是放在第 4 层。

## 共用接口（各层计划必须用这里的名字）

### 第 1 层产出：`src/shared/turn.ts`

```ts
/** 谁该动。done = 合了；idle = 没开始。 */
export type TurnOwner = "you" | "agent" | "external" | "done" | "idle";

/** 「你」这一类里，没人推进的原因（spec §7：ready for review 之前都算你这边）。 */
export type UnattendedWhy =
  | "ci_failing" | "changes_requested" | "conflicts" | "behind"
  | "draft" | "no_reviewer" | "agent_stopped" | "ci_undelivered";

export type Turn =
  | { owner: "you"; kind: "answer"; question: string; options: string[]; askId: number | null; sessionId: string }
  | { owner: "you"; kind: "merge"; risk: "low" | "medium" | "high" | null }
  | { owner: "you"; kind: "review"; author: string; title: string; url: string }
  | { owner: "you"; kind: "stuck"; source: "needs_you" | "blocked_report" | "silent" | "ticket_blocked"; detail: string | null; sessionId: string | null }
  | { owner: "you"; kind: "unattended"; why: UnattendedWhy; canSend: boolean; sessionId: string | null }
  | { owner: "you"; kind: "butler"; notice: NowNotice }
  | { owner: "agent"; kind: "fixing_ci" | "addressing_review" | "rebasing" | "working"; sessionId: string }
  | { owner: "external"; kind: "ci_running" | "awaiting_review" | "merge_queue"; names: string[] }
  | { owner: "done"; kind: "merged" }
  | { owner: "idle"; kind: "not_started" };

/** 急的顺序：同一个 ticket 有几个 PR 时，取最急的那个（spec §5.1）。 */
export const TURN_PRIORITY: Record<TurnOwner, number> = { you: 0, agent: 1, external: 2, idle: 3, done: 4 };

export interface TurnItem {
  /** 别人请你 review 的 PR 不属于任何 ticket，这里为 null。 */
  ticketKey: string | null;
  pr: { repo: string; number: number; title: string; url: string } | null;
  epicId: number | null;
  featureId: number | null;
  turn: Turn;
  /** 进入这个状态的时间（epoch ms），用来显示「12 分钟前」。 */
  since: number;
}

export interface ScopeTurnRow {
  /** epic、feature，或者单独的 ticket。 */
  kind: "epic" | "feature" | "ticket";
  id: number | string;
  name: string;
  total: number;
  merged: number;
  /** 进度条的四段，按 owner 计数。 */
  bar: Record<"done" | "agent" | "you" | "external" | "idle", number>;
  youCount: number;
  /** 最慢的那一组的名字；规则见第 1 层计划。 */
  slowest: string | null;
}

export interface TurnBoard {
  items: TurnItem[];
  counts: { you: number; agent: number; external: number; mergedToday: number };
  scopes: ScopeTurnRow[];
  generatedAt: number;
}

/** ticket 显示的那一句：按 TURN_PRIORITY 取最急的 PR，再说明还有几个别的 PR。 */
export function ticketTurn(prTurns: Turn[], sessionTurn: Turn | null): { turn: Turn; others: number };
```

IPC（沿用现有 `src/main/ipc` 的注册方式和 `src/renderer/src/api.ts` 的包装方式）：
- `turn:board(filter?: { epicId?: number; featureId?: number; ticketKey?: string }) => TurnBoard`
- 推送事件 `turn:changed`：渲染进程收到后重新拉 `turn:board`，用法跟现有 `useStateRefetch` 一样。
- `turn:send-to-agent(item: { ticketKey: string; pr: { repo: string; number: number } }) => { ok: boolean; reason?: string }`：把 CI 日志或 review 评论发给负责的 session，复用 ci-delivery 和评论转发现有的递送路径。

渲染进程包装名：`api.turnBoard(filter?)`、`api.onTurnChanged(cb)`、`api.turnSendToAgent(item)`。

口径：`counts.you` 等于 `items` 里 owner 为 you 的条数；`counts.agent`、`counts.external` 也按 items 计数，一条 item 是一个 ticket 或一个请你 review 的 PR。`items` 包含所有非 done 和 idle 的项。feature 下的 ticket，`epicId` 也要填上。`scopes` 包含所有 epic、所有 feature 和所有单独的 ticket。

文案：每个 `Turn` 显示的那一句话，由渲染进程的 `turnSentence(turn, item, t)` 生成，放在 `src/renderer/src/turn-text.ts`，中英文都放进 `strings.ts` 和 `strings-en.ts`。main 进程不拼文案。

### 第 4 层产出：对话存储

```ts
// src/shared/conversation.ts
export interface ConvMessage {
  id: number;
  /** replaced_by 链的根 session id，换新以后这个值不变。 */
  rootSessionId: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  /** 属于哪个分叉讨论；不是分叉讨论的为 null（分叉讨论由第 5 层写入）。 */
  forkId: number | null;
  qa: boolean;
}
export interface ConvPage { messages: ConvMessage[]; refreshMarks: { at: number; sessionId: string }[]; hasMore: boolean }
```

IPC：
- `conv:list(rootSessionId: string, opts: { before?: number; limit: number; qaOnly?: boolean }) => ConvPage`
- `conv:search(rootSessionId: string | null, query: string) => ConvMessage[]`
- 推送事件 `conv:appended(rootSessionId)`

main 进程函数：`recentQa(rootSessionId: string, maxChars: number): string`。它把最近几段问答拼成文本，供换新后的恢复提示使用；第 5 层的精简版分叉也会调用它。

### 第 5 层产出

- `fork_discussions` 表：`id, root_session_id, fork_session_id, mode('full'|'light'), cost_usd, started_at, last_at, summary_sent_at`。
- IPC：
  - `fork:ask(rootSessionId, forkId | null, question) => { forkId }`。回答通过 `conv:appended` 推送过来。
  - `fork:send-conclusion(forkId) => { ok }`
  - `fork:reask-full(forkId) => { forkId }`

## 各层计划通用的约定

- 项目的测试命令、lint 命令、e2e 用法，都照仓库现有的 `package.json` 和 `e2e/` 来写。e2e 里的 ticket 号必须带数字，比如 `E2E-7`。
- 不能留两套并存的状态算法。被新状态模型替换掉的旧算法和旧组件，在接手它的那一层里删掉，并在计划里写明。
- 3.0 的功能默认全关，Butler 默认不对外做任何事，这两点不能改。
- 新文案中英文都要有。

## 实际开工的顺序（总控定，2026-11-19 夜）

ticket 号对应：BTL-231 是第 1 层，BTL-232 第 2 层，BTL-233 第 3 层，BTL-234 第 4 层，BTL-235 第 5 层，BTL-236 第 6 层。

- 先同时开三个，都直接从 main 开分支，各开各的 PR：
  - BTL-231（第 1 层）
  - BTL-234（第 4 层）
  - BTL-236（第 6 层）：只做设置页、`FirstRunHome.tsx` 组件本身和向导文案，不碰首页的接线。
- BTL-232（第 2 层）叠在 BTL-231 上；BTL-233（第 3 层）叠在 BTL-232 上；BTL-235（第 5 层）叠在 BTL-233 上。第 5 层开工前，BTL-234 必须已经合进 main。
- 首页空状态：第 2 层开工时，看分支里是否已经有 `src/renderer/src/components/FirstRunHome.tsx`（BTL-236 合进 main 并 rebase 之后就会有）。
  - 有：直接渲染 `<FirstRunHome onNewTicket onNewFeature onNewEpic onOpenSettings/>`，不写 `NoWorkLine`。
  - 没有：先用 `NoWorkLine`。等 BTL-236 合进来，由第 3 层把它换掉，并删掉 `NoWorkLine`。
  - 第 2 层不准自己建 `FirstRunHome.tsx` 占位，以免和 BTL-236 冲突。
- 第 6 层和第 2 层都会改 `App.tsx`。第 6 层只改 settings 路由的类型，冲突在 rebase 时解决。

## 计划写完后补的约定（总控定，以这里为准，和各层计划冲突时按这里来）

- 第 4 层的写入函数：
  - `ConversationStore.append(msg: Omit<ConvMessage,"id">): ConvMessage`，只用来写分叉消息，forkId 为空时抛错；
  - `ConversationStore.byFork(forkId: number): ConvMessage[]`。
- 分叉消息存库时 `qa` 写 false，照第 4、5 层计划。但 spec 说分叉讨论一律算问答，所以 `conv:list` 带 `qaOnly` 时，条件是 `qa = true OR forkId IS NOT NULL`，「只看讨论」也能看到分叉。第 5 层计划里「qaOnly 时不返回分叉消息」那句作废。`recentQa` 不收 forkId 不为空的消息。
- `ConvMessage` 加一个字段 `turnId: number`。同一轮的几条 assistant 消息 turnId 相同，第 5 层把同一轮合成一块显示。
- `conv:list` 和 `conv:search` 的第一个参数叫 `sessionId`，可以是链上任意一个 id，由主进程转成链根。`conv:appended` 推送的永远是链根，渲染进程拿 `SessionView.rootId` 去比对。`before` 是消息 id；结果按时间升序；`limit` 最大 200。
- `fork:send-conclusion` 返回 `{ ok: true, at } | { ok: false, reason }`。第 5 层新增的 IPC 有 `fork:list`、`fork:remember`、`conv:send`、`inbox:reports`，推送事件 `fork:changed`。
- 删除 session 时不删对话。子 session 的汇报从 inbox 取，不进对话库。
- 第 1 层计划写完后补的约定：
  1. `TurnItem` 加 `others: number`：这个 ticket 除了显示的这个 PR，还有几个别的 PR，没有就是 0。首页据此显示「另有 N 个 PR」。
  2. 口径：
     - 不带 filter 时，一个 ticket 一条 item，`counts` 等于 items 按 owner 计数的结果。
     - 带 filter 时，items 按 PR 拆开，`counts` 仍按 ticket 计。
     - 第 3 层要找 session 级的那一条时，在 `pr` 为 null 的 items 里用 mostUrgent 取，不要取第一条。
     - `ticketKey` 和 `pr` 都为 null 的 item 是总控的提问或全局提醒，首页照常显示成卡片。
  3. 不带 filter 时，`scopes` 里还要包括不属于任何 epic 的 feature。
  4. 剩下的 `waitingOnOf` 调用点：`butler-control` 的 progress_overview、`feature-templates`、`src/main/progress`。由第 3 层的最后一个任务改成用 turn 模型，然后删掉 `waitingOnOf`，不留两套。第 3 层删 `ProgressBody` 的同时做。
  5. `NowNotice` 新增一种 `approval`，表示 session 停在权限确认上。第 2 层的 `Notice.tsx` 和 `turnSentence` 要能显示它，按钮是「去看看」，落到那个 session 的终端。
  6. `turn:send-to-agent` 的 reason 类型收紧成 `TurnSendReason`，由第 1 层定义。
  7. 已知限制：`gh search` 只查默认主机，企业版 GitHub 上请你 review 的 PR 查不到。这条写进发版说明。
