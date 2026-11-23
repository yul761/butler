# UI 重做第 1 层：「谁该动」状态模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一套「谁该动」（`Turn`）规则，把每个 PR、每个 ticket、每个总控 session、每条要你动手的 Shipherd 提醒和「别人请你 review 的 PR」算成同一种数据（`TurnBoard`），通过 IPC 交给渲染进程。同时新加一路「请你 review」的 gh 查询。本层不改界面，旧的状态算法在第 2、3 层删。

**Architecture:**
- 规则全是纯函数，放在 `src/shared/turn.ts`：`prTurn`、`sessionTurn`、`ticketTurn`、`noticeNeedsYou`、`mostUrgent`。
- 主进程有两个文件：
  - `src/main/turn/turn-board.ts` 是纯函数 `buildTurnBoard`，负责按 filter 出 items、counts、scopes 和 slowest。
  - `src/main/turn/turn-service.ts` 是 `TurnService`，从现有的服务里取数，拼成 `BoardInput`，再交给 `buildTurnBoard`。
- `TurnService` 还负责 `turn:send-to-agent`，走的是 ci-delivery 和评论转发现有的递送路径。
- `turn:changed` 跟在现有的 `notify` 和 review 查询后面推送。
- 「请你 review」：
  - `gh.ts` 新加 `reviewRequestedPrs`。
  - 新表 `review_requests` 存第一次看到的时间。
  - 调度在 `src/main/prwatch/review-requests.ts` 的 `ReviewRequestPoller`。
- 文案只在渲染进程拼：`src/renderer/src/turn-text.ts` 的 `turnSentence`。

**Tech Stack:** Electron 主进程（`node:sqlite`）、React 渲染进程、TypeScript、vitest（`pnpm test`）、Playwright e2e（`pnpm e2e`，带假 gh）。

**Spec:** `docs/superpowers/specs/2026-11-19-ui-redesign-design.md` 的 §5.1、§5.3、§6、§7。共用接口见 `docs/superpowers/plans/2026-11-19-ui-redesign-00-index.md`，已按协调者 2026-11-19 的两次补充更新：`TurnItem.pr.url`、包装名、口径、filter 语义、`ticketTurn` 空输入、ask_user。

## Global Constraints

- **对外：** 不新增任何对外动作。
  - `gh search prs` 只是读。
  - `turn:send-to-agent` 只把东西递进本机的 session 终端，走 `CiDelivery.resend` 和 `CommentLoop` 的现有递送路径，不碰 GitHub。
  - 3.0 的开关默认值一个都不改。`comments.enabled` 仍然默认关，关着时 changes_requested 的 `canSend` 就是 `false`。
- **共用接口：** 名字和类型逐字照 `00-index.md` 的「第 1 层产出」。新加的导出（如 `prTurn`、`TimedTurn`）只能是附加的，不能改索引里的东西。
- **文案：** main 进程不拼 turn 文案。新文案中英文都要有：`strings.ts` 和 `strings-en.ts` 一起改，`UiStrings = typeof ZH` 会强制两边同形；main 进程的报错文案放在 `src/main/strings.ts` 的 `M()`，同样中英文都要有。
- **旧算法：** 本层不删旧算法，也不让新旧两套同时在界面上出现。本层不接任何界面，删的时间见文末「旧算法替换表」。
- **数据库：** 迁移只能往 `src/main/db/migrations.ts` 的 `MIGRATIONS` 末尾追加，不改旧的。
- **IPC：** 新 channel 加进 `src/shared/ipc.ts` 的 `IPC`，并各在 `INVOKE_CHANNELS` 或 `EVENT_CHANNELS` 里出现一次，`src/shared/ipc.test.ts` 会检查。
- **代码风格：** 注释用中文，照现有文件的写法。
- **命令：**
  - 单测：`pnpm vitest run <文件>`。
  - 全量：`pnpm test`、`pnpm typecheck`、`pnpm lint`。
  - e2e：`pnpm e2e -- e2e/<文件>`。`pree2e` 会先 build，单跑时用 `pnpm e2e:only e2e/<文件>`，前提是已经 build 过。
  - e2e 的 ticket 号要带数字。
- **提交：** 每个任务一个 commit，message 用 `feat(turn): …` 或 `test(turn): …`，结尾带 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

1. 「agent 在处理」和「没人推进」的分界：结论递进去以后 agent 又停了，就要回到 `you/unattended`。测试见 Task 2 的 `delivered then stopped → unattended`。
2. 「卡住了」只有 4 个来源。needs-you 的 `question`、`choice` 不算卡住，ticket 状态 `in_review` 也不算卡住。测试见 Task 3 的 `only the four sources are stuck`。
3. 不带 filter 时，`counts.you/agent/external` 正好等于 items 里对应 owner 的条数，一个 ticket 有几个 PR 也不会多算，done 和 idle 不进 items。测试见 Task 4 的 `counts equal items without a filter`。
4. review 查询的节奏：
   - 离上次超过 1 分钟才补查。
   - 离开时每 15 分钟一次。
   - gh 失败时不清掉已有的列表，也不会马上重试。

   测试见 Task 8 的 `keeps the list when gh fails`。
5. `turn:send-to-agent` 只在 `canSend` 为真时调用现有的递送路径，其余情况返回 `not_sendable`，不发任何东西。测试见 Task 9 的 `refuses when the turn cannot be sent`。

---

## 规则（各任务按这里实现）

### R1. 一个 PR 的 turn（`prTurn`）

按顺序判断，先满足哪条就是哪条：

1. 已合并：`done/merged`。
2. 已关闭：返回 `null`，这个 PR 不参与。
3. **你这边**（ready for review 之前）的原因 `why`，依次检查：
   - `isDraft`：`draft`。
   - `ci === "failing"`：如果 `ciUndelivered`，是 `ci_undelivered`，否则是 `ci_failing`。
   - 有人要求修改：`changes_requested`。判断方法照抄 `waitingOnOf`：人的 reviewer 里有 `changes_requested`；或者 `review === "changes_requested"` 且没有人 approve。
   - `mergeable === "conflicting"` 或 `mergeState === "dirty"`：`conflicts`。
   - `mergeState === "behind"`：`behind`。

   找到 `why` 后：
   - 如果 **有人在推进**（见 R2），turn 是 `agent`。kind 按 why 取：`ci_*` 对应 `fixing_ci`，`changes_requested` 对应 `addressing_review`，`conflicts` 和 `behind` 对应 `rebasing`，其余对应 `working`。sessionId 用 pusher 的。
   - 否则是 `you/unattended {why, canSend, sessionId: pusher?.sessionId ?? null}`。`canSend` 的取法：
     - `ci_failing` 和 `ci_undelivered`：取 `canResendCi`。
     - `changes_requested`：取 `canSendComments`。
     - 其余：`false`，因为现有的递送路径里没有对应的东西可以发。
4. `ci === "pending"`：`external/ci_running {names: []}`。gh 给的检查名单在 WatchedPr 里没有，所以 names 为空。
5. `mergeQueued`：`external/merge_queue {names: []}`。
6. 有人 approve，且 `review !== "pending"`、`mergeState !== "blocked"`：`you/merge {risk}`。
7. `reviewRequests` 非空：`external/awaiting_review {names: reviewRequests.map(r => r.name)}`。
8. `review === null` 且 `mergeState === "clean"`：不要求 review，返回 `you/merge {risk}`。
9. 其余，也就是没人被请 review、批准也不够：按第 3 步同样的方式处理 `why = "no_reviewer"`。

### R2. 「有人在推进」

满足下面两条之一，就算有人在推进：

- pusher 存在，并且 `pusher.working` 为真。
- pusher 存在，并且「当前结论」递进去以后它还没停：`deliveredAt !== null && (pusher.stoppedAt === null || pusher.stoppedAt < deliveredAt)`。

其中：

- **pusher**：`ciRecipient`（`index.ts` 的 `loopRecipient`）为 `ok` 时的 session（head）。没有 pusher 就一定没人推进。
- **working**：`isWorking(activity)`。休眠的 session 没有 activity，算不在干活。
- **stoppedAt**：`ActivityMonitor.lastReplyOf(id)?.at`，即这个 session 最后一次回完话的时间。
- **当前结论的 deliveredAt**：
  - `ci_*`：`ticket_prs.delivered_key === deliveryKey(row)`，且 `delivered_to` 的 head 是 pusher（旧行的 `delivered_to` 为 null 时不比），取这时的 `delivered_at`。
  - `changes_requested`：这个 PR 的评论条目里，状态是 `delivered`、`deliveredSession` 的 head 是 pusher 的，取 `deliveredAt` 的最大值。
  - 其余 why 没有可递的结论，只看 working。

### R3. 一个 session 的 turn（`sessionTurn`，不看 PR）

按顺序判断，先满足哪条就是哪条：

1. 有未回答的 ask_user：`you/answer {question, options, askId: inbox_items.id, sessionId}`。这个 `askId` 可以直接传给 `api.answerInbox(askId, option)`。
2. `activity.kind === "approval"`，或者 needs-you 的类别是 `permission`：`you/shipherd {notice: {kind: "approval", target, title}}`。`approval` 是 Task 1 给 `NowNotice` 新加的一种。
3. `refreshing`（正在换新）：`agent/working`。
4. needs-you 的类别是 `stuck` 或 `missing_info`：`you/stuck {source: "needs_you", detail: reason}`。
5. `activity.limit` 有值：`you/shipherd {notice: {kind: "session_limited", target, title, limit}}`。
6. `activity.stuck === true`（stuck-tracker 认为在跑但长时间没动静）：`you/stuck {source: "silent", detail: activity.reason}`。
7. 最近一条 report 的 `kind === "blocked"`，session 不在干活，并且 `stoppedAt === null || stoppedAt <= report.at + REPORT_STOP_SLACK_MS`（5 分钟，意思是发完 report 以后没再干过别的一轮）：`you/stuck {source: "blocked_report", detail: report.text}`。
8. needs-you 是其他类别（`question`、`choice`）：`you/answer {question: reason, options: [], askId: null}`。
9. 在干活：`agent/working`。
10. 其余（停着）：`you/unattended {why: "agent_stopped", canSend: false}`。

「卡住了」只有 4 个来源：第 4、6、7 条，加上 ticket 级的 `ticket_blocked`（R4）。

### R4. 一个 ticket 的 turn

- **非 PR 候选 `others`：**
  - 每个 head session 的 `sessionTurn`。
  - 挂在这个 ticket 上的、要你动手的 Shipherd 提醒，转成 `you/shipherd`。
  - `effectiveStatus === "blocked"` 时，加一条 `you/stuck {source: "ticket_blocked", detail: null, sessionId: 第一个 head ?? null}`。
  - 没有 PR 且 `effectiveStatus` 是 `done` 或 `merged_pending_followup` 时，加一条 `done/merged`，由调用方传进来。
- **sessionTurn：** 取 `mostUrgent(others)`。
- **ticket 的 turn：** `ticketTurn(PR 的 turn, sessionTurn)`。
  - 有 PR 时，session 给出的 `you/unattended(agent_stopped)`、`idle` 和 `done` 不参与。等 review 时 session 停着是正常的。
  - 输入全空时返回 `{ turn: { owner: "idle", kind: "not_started" }, others: 0 }`。
  - `others` 是除了选中的那个以外、owner 不是 done 的 PR turn 的个数。
- **急的顺序：** 先比 `TURN_PRIORITY`，同为 you 时再比 `YOU_KIND_RANK`：answer 0、stuck 1、shipherd 2、unattended 3、review 4、merge 5。还一样的，取先出现的。

### R5. 哪些 Shipherd 提醒算「要你动手」（`noticeNeedsYou`）

| kind | 算不算 |
|---|---|
| `claude_limited`、`model_unavailable`、`session_limited`、`approval`、`ci_undelivered`、`comments_waiting` | 算 |
| `cost` | 只有 `breaker.state === "paused"` 算。`warned` 和 `downgraded` 只是提示 |
| `stack` | 只有 `reason` 是 `conflict` 或 `stuck` 算。`draft_stale` 和 `behind` 只是提示 |
| `intake` | 只有 `INTAKE_DECISION_STATES` 里的状态算 |
| `lessons_paused`、`lessons_failing`、`shared_mcp_failed`、`routing`、`check_promoted`、`check_demoted` | 不算，只是提示，不进首页 |

**挂到哪里：**

- `ci_undelivered`：PR 行的不单独出，并进那个 PR 的 `unattended/ci_undelivered`。分支行的挂到 `ci.ticketKey`。
- `session_limited`：不取现成的提醒，改由 `sessionTurn` 根据 `activity.limit` 生成，这样不会重复。
- `comments_waiting`：挂到 `waiting.ticketKey`。
- `cost`：target 是 ticket 的挂到那个 ticket。
- `stack`：挂到 `stack.ticketKey`。
- 其余不属于任何 ticket 的进 `loose`。target 是 feature 或 epic 的，填上对应的 `featureId` 或 `epicId`。

### R6. 总控 session 和 ask_user

- `pendingDecisions()` 里的每一条 ask_user 都要出现成一条 `you/answer`。
- 按提问 session 的 head 归组。每组最早的一条作为那个 session 的 `sessionTurn` 输入（R3 第 1 条），其余的作为额外的 item（ticket 的进 `moreAsks`，总控的进 `loose`）。
- head 找不到的，按 inbox 行自带的 ticketKey、featureId、epicId 归属：有 ticketKey 的进那个 ticket 的 `moreAsks`，没有的进 `loose`。
- 总控 session（feature、epic 的总控，以及 Shipherd 总控）也算 `sessionTurn`，结果 owner 是 you 的才进 `loose`。

### R7. `since`（进入这个状态的时间）

| turn | since |
|---|---|
| PR 的 turn | `detail.statusChangedAt ?? openedAt ?? checkedAt` |
| `done`（PR） | `mergedAt` |
| `answer`（有 askId） | inbox 的 `createdAt` |
| `stuck/silent` | `activity.lastOutputAt ?? activity.startedAt ?? now` |
| `stuck/blocked_report` | report 的 `at` |
| `agent/working`（session） | `activity.startedAt ?? now` |
| `shipherd` | `ci_undelivered` 和 `comments_waiting` 用自带的 `since`，其余用 `now` |
| `review` | `review_requests.first_seen_at` |
| 其余 session 的 turn | `stoppedAt ?? now` |

### R8. items、counts、scopes 和 filter（`buildTurnBoard`）

**items：**

- **不带 filter：**
  - 每个 ticket 一条，取 `ticketTurn` 的结果。turn 来自某个 PR 时，`pr` 填那个 PR，否则为 null。
  - 每条 `moreAsks` 一条。
  - 每条 `loose` 一条。
  - 每个请你 review 的 PR 一条（`ticketKey: null`，`epicId` 和 `featureId` 都为 null）。
  - 只留 owner 是 you、agent 或 external 的。
- **带 filter：**
  - 范围内每个 ticket，每个 PR 一条（`pr` 非 null，turn 是这个 PR 自己的），再加一条 ticket 级的（`pr: null`，取 `mostUrgent(others)`，没有就不出）。
  - 范围内的 `moreAsks` 和 `loose`。
  - 不含请你 review 的 PR。
  - 不出 idle，出 done，好让 ticket 页显示「合了」。
  - 第 3 层用这些 item 自己调 `ticketTurn` 算 `others`。
- **字段：** feature 下的 ticket 要填 `epicId`，取 feature 的 `epicId`。

**counts：**

- 按「一个 ticket 一条」的口径数，加上 `moreAsks`、`loose` 和 review。不带 filter 时就等于 items 的计数。
- 带 filter 时口径不变，只数范围内的，所以不等于按 PR 拆开后的 items 条数。见文末建议 2。
- `mergedToday`：范围内 `mergedAt >= dayStart`（本地今天 0 点）的 PR 数，同一个 URL 只算一次。

**scopes：**

| filter | 返回哪些行 |
|---|---|
| 不带 | 所有 epic，所有没有 epic 的 feature，所有不属于 feature 的 ticket |
| `epicId` | 这个 epic 一行，加它下面每个 feature 一行 |
| `featureId` | 这个 feature 一行，加它下面每个 ticket 一行 |
| `ticketKey` | 只有这个 ticket 一行 |

不带 filter 时多出「没有 epic 的 feature」，见文末建议 3。归档的 epic、feature、ticket 都不算。

**一行 `ScopeTurnRow` 怎么算：**

- **ticket 行：**
  - 成员是它没关闭的 PR；没有 PR 时，成员是它自己，按 ticket 的 turn 算。
  - `total` 是成员数，`merged` 是成员里 done 的个数，`bar` 按成员的 owner 计数。
  - `youCount` 是这个 ticket 在不带 filter 口径下 owner 为 you 的条数，即 ticket 那条再加 `moreAsks`。
- **feature 行：**
  - 成员是它的 ticket，按 ticket 的 turn 算。
  - `youCount` 是各 ticket 的 `youCount` 之和，再加 `featureId` 是它的 loose 里 you 的条数。
- **epic 行：**
  - `total`、`merged`、`bar` 按它所有 feature 下的 ticket 算。
  - `youCount` 是各 feature 的 `youCount` 之和，再加 `epicId` 是它、`featureId` 为 null 的 loose 里 you 的条数。
- **name：**
  - epic、feature 用 `name`。
  - ticket 用 `title ?? key`。
  - PR 成员用 `${repo}#${number}`。

**slowest（我定的规则，写进 `slowestOf`）：**

- 只看 owner 不是 done、也不是 idle 的成员。
- 每个成员取「最近一次有进展」的时间：
  - ticket 成员和 PR 成员：取自己的 `since`。
  - epic 行的成员是 feature：取它下面这些活跃 ticket 的 `since` 的最大值，也就是这一组最近一次动的时间。
- 取这个时间最早的成员，即最久没有进展的那一组。时间一样时取先出现的。
- 活跃成员少于 2 个时返回 `null`，因为只有一组时说「最慢的是它」没有信息量。

### R9. 「请你 review」的查询节奏

- 每轮调一次 `gh search prs --review-requested=@me --state=open --limit 100 --json number,title,url,repository,author,updatedAt`，cwd 用 home。
- 平时离上次 `PR_SLOW_MS`（5 分钟）以上才查。
- 离开时离上次 15 分钟以上才查。离开的意思是 `idleSignal.locked()`，或者 `idleSignal.idleSeconds() >= 600`。
- 窗口获得焦点（`app.on("browser-window-focus")`），或者不带 filter 调 `turn:board`（也就是首页）时，离上次超过 1 分钟就马上补查。
- 每 60 秒检查一次是否到期。
- 同一时间只跑一个查询。
- gh 不可用时不查。
- gh 失败时保留已有列表，同时也记下这次查询的时间，免得失败后每分钟重试。
- 查到的结果整体替换 `review_requests` 表：还在的保留 `first_seen_at`，不在的删掉，新出现的从现在开始算。所以你提交 review 后它会消失，对方再请你时会从头计时。
- 设置 `reviewRequestScope`，默认 `"all"`。改成 `"registered"` 后，只留 slug 在「已登记仓库」里的 PR。已登记仓库是 `lessonsRepo.repos()` 的 slug 和 `ticket_prs` 里出现过的 slug 的并集。
- 这个过滤在读的时候做，改了设置马上生效，不用等下一次查询。
- 不再另外读每个 PR 的详情：卡片要用的标题、作者和链接，search 的结果里都有，而且每 5 分钟会刷新一次。见自查第 5 条。

---

## 文件一览

| 文件 | 动作 | 内容 |
|---|---|---|
| `src/shared/turn.ts` | 新建 | 索引里的类型和常量，以及 `prTurn`、`sessionTurn`、`ticketTurn`、`mostUrgent`、`noticeNeedsYou`、`slowestOf` |
| `src/shared/turn.test.ts` | 新建 | 纯函数测试 |
| `src/shared/types.ts` | 改 | `NowNotice` 加 `approval` |
| `src/renderer/src/availability-view.ts` | 改 | `noticeText` 加 `approval` 分支 |
| `src/main/turn/turn-board.ts`、`.test.ts` | 新建 | `buildTurnBoard` |
| `src/main/db/migrations.ts` | 改 | 追加两条迁移 |
| `src/main/db/ticket-prs-repo.ts`、`.test.ts` | 改 | 加 `deliveredAt`、`deliveredTo` |
| `src/main/prwatch/ci-delivery.ts`、`.test.ts` | 改 | 递送成功时记下给了谁、什么时候 |
| `src/main/db/inbox-repo.ts`、`.test.ts` | 改 | 加 `lastReport(ticketKey)` |
| `src/main/loop/comment-loop.ts`、`.test.ts` | 改 | 加 `deliveredAt`、`sendable`、`sendAll` |
| `src/main/tickets/gh.ts`、`gh.test.ts` | 改 | 加 `reviewRequestedPrs` |
| `src/main/db/review-requests-repo.ts`、`.test.ts` | 新建 | `review_requests` 表 |
| `src/main/prwatch/review-requests.ts`、`.test.ts` | 新建 | `ReviewRequestPoller`、`scopeReviews` |
| `src/main/db/settings-repo.ts`、`src/shared/settings.ts`、`src/main/settings/settings-values.ts`、`.test.ts`、`src/main/strings.ts` | 改 | 设置 `reviewRequestScope` |
| `src/main/turn/turn-service.ts`、`.test.ts` | 新建 | `TurnService` |
| `src/shared/ipc.ts`、`src/main/ipc/validate.ts`、`validate.test.ts`、`src/main/ipc/register.ts`、`src/renderer/src/api.ts`、`src/main/index.ts` | 改 | IPC 和接线 |
| `src/renderer/src/turn-text.ts`、`.test.ts` | 新建 | `turnSentence` |
| `src/renderer/src/strings.ts`、`strings-en.ts` | 改 | 加 `turn` 一节和 `noticeApproval` |
| `e2e/fake-gh/fake-gh.cjs`、`e2e/fixtures.ts`、`e2e/turn-board.spec.ts` | 改 / 新建 | 假 gh 支持 `search prs`，加 e2e |

---

### Task 1: `turn.ts` 的类型、排序、`ticketTurn` 和 `noticeNeedsYou`

**Files:**
- Create: `src/shared/turn.ts`, `src/shared/turn.test.ts`
- Modify: `src/shared/types.ts`（`NowNotice`）、`src/renderer/src/availability-view.ts`（`noticeText`）、`src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`（`noticeApproval`）
- Test: `src/shared/turn.test.ts`, `src/renderer/src/availability-view.test.ts`

**Interfaces:**
- Consumes：`NowNotice`、`NowTarget`（`src/shared/types.ts`），`INTAKE_DECISION_STATES`（`src/shared/intake.ts`）。
- Produces，逐字照索引的部分：`TurnOwner`、`UnattendedWhy`、`Turn`、`TURN_PRIORITY`、`TurnItem`（`pr` 带 `url`）、`ScopeTurnRow`、`TurnBoard`、`ticketTurn`。
- Produces，附加的部分：
```ts
export type YouKind = Extract<Turn, { owner: "you" }>["kind"];
export const YOU_KIND_RANK: Record<YouKind, number> = { answer: 0, stuck: 1, shipherd: 2, unattended: 3, review: 4, merge: 5 };
/** 一个 turn 和它进入这个状态的时间。 */
export interface TimedTurn { turn: Turn; since: number }
/** 越小越急：[TURN_PRIORITY, you 内部的顺序]。 */
export function turnRank(t: Turn): [number, number];
/** 最急的一条（R4 的顺序）；并列取先出现的；空数组为 null。 */
export function mostUrgent<T extends { turn: Turn }>(xs: readonly T[]): T | null;
export function noticeNeedsYou(n: NowNotice): boolean;
export type TurnFilter = { epicId?: number; featureId?: number; ticketKey?: string };
```
- `types.ts` 的 `NowNotice` 加一种：`| { kind: "approval"; target: NowTarget; title: string | null }`，注释写「终端停在权限确认上（第 1 层的 you/shipherd 用）」。
- `S.noticeApproval: (title: string | null) => string`。中文：`title === null ? "在终端里确认权限" : \`「${title}」在终端里等你确认权限\``；英文：`"Confirm the permission prompt in the terminal"` / `` `"${title}" is waiting for you to confirm a permission prompt` ``。

- [ ] **Step 1: 写失败的测试** `src/shared/turn.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { NowNotice } from "./types";
import { mostUrgent, noticeNeedsYou, ticketTurn, TURN_PRIORITY, type Turn } from "./turn";

const merge: Turn = { owner: "you", kind: "merge", risk: null };
const ask: Turn = { owner: "you", kind: "answer", question: "q", options: [], askId: 1, sessionId: "s" };
const ci: Turn = { owner: "external", kind: "ci_running", names: [] };
const fixing: Turn = { owner: "agent", kind: "fixing_ci", sessionId: "s" };
const merged: Turn = { owner: "done", kind: "merged" };
const stopped: Turn = { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s" };

describe("ticketTurn", () => {
  it("returns idle with no input", () => {
    expect(ticketTurn([], null)).toEqual({ turn: { owner: "idle", kind: "not_started" }, others: 0 });
  });
  it("picks the most urgent PR and counts the other unmerged PRs", () => {
    expect(ticketTurn([ci, fixing, merged], null)).toEqual({ turn: fixing, others: 1 });
  });
  it("an answer outranks a mergeable PR (same owner, earlier kind)", () => {
    expect(ticketTurn([merge, ci], ask)).toEqual({ turn: ask, others: 2 });
  });
  it("ignores a stopped session while PRs exist, but uses it without PRs", () => {
    expect(ticketTurn([ci], stopped).turn).toBe(ci);
    expect(ticketTurn([], stopped).turn).toBe(stopped);
  });
  it("all PRs merged → done; caller-passed done without PRs → done", () => {
    expect(ticketTurn([merged, merged], null)).toEqual({ turn: merged, others: 0 });
    expect(ticketTurn([], merged).turn).toBe(merged);
  });
  it("keeps the index order of TURN_PRIORITY", () => {
    expect(TURN_PRIORITY).toEqual({ you: 0, agent: 1, external: 2, idle: 3, done: 4 });
  });
});

describe("mostUrgent", () => {
  it("is stable on ties and null on empty", () => {
    const a = { turn: ci, since: 1 }, b = { turn: { ...ci }, since: 2 };
    expect(mostUrgent([a, b])).toBe(a);
    expect(mostUrgent([])).toBeNull();
  });
});

describe("noticeNeedsYou", () => {
  const breaker = (state: "warned" | "downgraded" | "paused") => ({ kind: "cost", breaker: { state }, target: null }) as unknown as NowNotice;
  it("action notices count, info notices do not", () => {
    expect(noticeNeedsYou(breaker("paused"))).toBe(true);
    expect(noticeNeedsYou(breaker("warned"))).toBe(false);
    expect(noticeNeedsYou({ kind: "lessons_paused" })).toBe(false);
    expect(noticeNeedsYou({ kind: "check_promoted", eventId: 1, batchId: null, names: [], at: 0 })).toBe(false);
    expect(noticeNeedsYou({ kind: "approval", target: { page: "shipherd", sessionId: null }, title: null })).toBe(true);
    const stack = (reason: string) => ({ kind: "stack", stack: { reason }, target: null }) as unknown as NowNotice;
    expect(noticeNeedsYou(stack("conflict"))).toBe(true);
    expect(noticeNeedsYou(stack("behind"))).toBe(false);
    const intake = (state: string) => ({ kind: "intake", item: { state } }) as unknown as NowNotice;
    expect(noticeNeedsYou(intake("needs_decision"))).toBe(true);
    expect(noticeNeedsYou(intake("queued"))).toBe(false);
  });
});
```

在 `availability-view.test.ts` 末尾加一条：`noticeText({ kind: "approval", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: "登录" }, S, 0)` 的 `text` 等于 `S.noticeApproval("登录")`，`actions` 等于 `["open"]`。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/shared/turn.test.ts src/renderer/src/availability-view.test.ts`
Expected: FAIL，`Cannot find module './turn'`，并且 `noticeApproval` 不存在。

- [ ] **Step 3: 实现**
  - 把索引里第 1 层的代码块原样抄进 `src/shared/turn.ts`。`NowNotice` 从 `./types` 用 `import type` 引入，不会出现循环依赖。
  - 实现 R4 的 `ticketTurn`、`mostUrgent`、`turnRank`，以及 R5 的 `noticeNeedsYou`。`noticeNeedsYou` 用 `switch (n.kind)` 写全所有分支，新加 kind 时 tsc 会报错。
  - 给 `types.ts` 加 `approval`，给 `noticeText` 加 `case "approval": return { text: S.noticeApproval(n.title), actions: ["open"] };`。
  - 在两个 strings 文件里加 `noticeApproval`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/shared/turn.test.ts src/renderer/src/availability-view.test.ts && pnpm typecheck`
Expected: PASS。typecheck 没有报错；如果有别的文件对 `NowNotice` 做了穷举，tsc 会指出来，照 `session_limited` 的做法补上。

- [ ] **Step 5: Commit**

```bash
git add src/shared/turn.ts src/shared/turn.test.ts src/shared/types.ts src/renderer/src/availability-view.ts src/renderer/src/availability-view.test.ts src/renderer/src/strings.ts src/renderer/src/strings-en.ts
git commit -m "feat(turn): Turn types, ticketTurn and notice classification"
```

---

### Task 2: 一个 PR 的 turn（`prTurn`）

**Files:**
- Modify: `src/shared/turn.ts`, `src/shared/turn.test.ts`

**Interfaces:**
- Consumes：`WaitingInput`、`PrReviewer`（`src/shared/progress.ts`，只用类型）。
- Produces：
```ts
export interface Pusher { sessionId: string; working: boolean; stoppedAt: number | null }
export interface PrTurnInput extends Omit<WaitingInput, "author"> {
  mergeQueued: boolean;
  risk: "low" | "medium" | "high" | null;
  /** 结论该递给的 session（ciRecipient 为 ok）；没有为 null。 */
  pusher: Pusher | null;
  /** 当前 head 的 CI 结论递给 pusher 的时间（R2）。 */
  ciDeliveredAt: number | null;
  /** 这一轮 review 评论递给 pusher 的最近时间（R2）。 */
  commentsDeliveredAt: number | null;
  /** CiDelivery.undelivered() 里有这个 PR（超过 30 分钟没递出去）。 */
  ciUndelivered: boolean;
  canResendCi: boolean;
  canSendComments: boolean;
}
/** R1。已关闭为 null。 */
export function prTurn(i: PrTurnInput): Turn | null;
```

- [ ] **Step 1: 写失败的测试**（追加到 `turn.test.ts`）

```ts
import { prTurn, type PrTurnInput } from "./turn";

const T = 1_000_000;
const pr = (o: Partial<PrTurnInput> = {}): PrTurnInput => ({
  state: "open", isDraft: false, ci: "passing", review: null, reviewers: [], reviewRequests: [], mergeable: "mergeable", mergeState: "blocked",
  mergeQueued: false, risk: null, pusher: { sessionId: "s", working: false, stoppedAt: T - 10 }, ciDeliveredAt: null, commentsDeliveredAt: null,
  ciUndelivered: false, canResendCi: true, canSendComments: false, ...o,
});

describe("prTurn", () => {
  it("merged → done, closed → null", () => {
    expect(prTurn(pr({ state: "merged" }))).toEqual({ owner: "done", kind: "merged" });
    expect(prTurn(pr({ state: "closed" }))).toBeNull();
  });
  it("ci failing with a working session → agent fixing_ci", () => {
    expect(prTurn(pr({ ci: "failing", pusher: { sessionId: "s", working: true, stoppedAt: null } }))).toEqual({ owner: "agent", kind: "fixing_ci", sessionId: "s" });
  });
  it("delivered and not stopped since → agent", () => {
    expect(prTurn(pr({ ci: "failing", ciDeliveredAt: T, pusher: { sessionId: "s", working: false, stoppedAt: T - 5 } }))?.owner).toBe("agent");
  });
  it("delivered then stopped → unattended", () => {
    expect(prTurn(pr({ ci: "failing", ciDeliveredAt: T, pusher: { sessionId: "s", working: false, stoppedAt: T + 5 } }))).toEqual({
      owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: "s",
    });
  });
  it("no recipient → unattended, cannot send", () => {
    expect(prTurn(pr({ ci: "failing", pusher: null, canResendCi: false }))).toEqual({ owner: "you", kind: "unattended", why: "ci_failing", canSend: false, sessionId: null });
  });
  it("undelivered for 30 min → ci_undelivered", () => {
    expect(prTurn(pr({ ci: "failing", ciUndelivered: true }))).toMatchObject({ kind: "unattended", why: "ci_undelivered", canSend: true });
  });
  it("changes requested: comments decide delivery and sendability", () => {
    const human = { login: "amy", state: "changes_requested" as const, at: 1, bot: false };
    expect(prTurn(pr({ reviewers: [human], canSendComments: false }))).toMatchObject({ why: "changes_requested", canSend: false });
    expect(prTurn(pr({ reviewers: [human], commentsDeliveredAt: T }))).toEqual({ owner: "agent", kind: "addressing_review", sessionId: "s" });
  });
  it("draft / conflicts / behind map to their whys; conflicts with a working agent → rebasing", () => {
    expect(prTurn(pr({ isDraft: true }))).toMatchObject({ why: "draft", canSend: false });
    expect(prTurn(pr({ mergeable: "conflicting" }))).toMatchObject({ why: "conflicts" });
    expect(prTurn(pr({ mergeState: "behind" }))).toMatchObject({ why: "behind" });
    expect(prTurn(pr({ mergeState: "dirty", pusher: { sessionId: "s", working: true, stoppedAt: null } }))).toEqual({ owner: "agent", kind: "rebasing", sessionId: "s" });
  });
  it("after ready for review: ci pending, merge queue, awaiting review are external", () => {
    expect(prTurn(pr({ ci: "pending" }))).toEqual({ owner: "external", kind: "ci_running", names: [] });
    expect(prTurn(pr({ mergeQueued: true }))).toEqual({ owner: "external", kind: "merge_queue", names: [] });
    expect(prTurn(pr({ reviewRequests: [{ kind: "user", name: "bob" }] }))).toEqual({ owner: "external", kind: "awaiting_review", names: ["bob"] });
  });
  it("approved, or review not required and clean → merge with risk", () => {
    const ok = { login: "amy", state: "approved" as const, at: 1, bot: false };
    expect(prTurn(pr({ reviewers: [ok], review: "approved", mergeState: "clean", risk: "low" }))).toEqual({ owner: "you", kind: "merge", risk: "low" });
    expect(prTurn(pr({ review: null, mergeState: "clean" }))).toEqual({ owner: "you", kind: "merge", risk: null });
    expect(prTurn(pr({ reviewers: [ok], review: "approved", mergeState: "blocked" }))?.kind).not.toBe("merge");
  });
  it("nobody asked to review → no_reviewer", () => {
    expect(prTurn(pr({ review: "pending" }))).toMatchObject({ owner: "you", kind: "unattended", why: "no_reviewer", canSend: false });
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/shared/turn.test.ts`
Expected: FAIL，`prTurn is not a function` 或导出不存在。

- [ ] **Step 3: 实现 `prTurn`**，严格按 R1、R2 的顺序。`ci === "unknown"` 当 `none` 处理。判断 changes_requested 的函数照抄 `waitingOnOf` 里的那几行，不要 import `waitingOnOf`，它会在第 3 层被删掉。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/shared/turn.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/turn.ts src/shared/turn.test.ts
git commit -m "feat(turn): per-PR turn with agent vs unattended rule"
```

---

### Task 3: 一个 session 的 turn（`sessionTurn`）

**Files:**
- Modify: `src/shared/turn.ts`, `src/shared/turn.test.ts`

**Interfaces:**
- Consumes：`SessionActivity`、`isWorking`（`src/shared/activity.ts`），`InterruptCategory`（`src/shared/metrics.ts`），`ReportKind`（`src/shared/control.ts`），`NowTarget`。
- Produces：
```ts
/** 发完 blocked 汇报以后，这么久之内停下的还算「就停在那份汇报上」。 */
export const REPORT_STOP_SLACK_MS = 5 * 60_000;
export interface SessionTurnInput {
  sessionId: string;
  target: NowTarget;
  title: string | null;
  activity: Pick<SessionActivity, "kind" | "stuck" | "reason" | "startedAt" | "lastOutputAt" | "limit"> | null;
  /** 这个 session 最早一条没回答的 ask_user（inbox_items.id）。 */
  ask: { id: number; question: string; options: string[]; at: number } | null;
  needsYou: { reason: string; category: InterruptCategory } | null;
  /** 这个 ticket 最近的一条 report；总控为 null。 */
  lastReport: { kind: ReportKind; text: string; at: number } | null;
  refreshing: boolean;
  stoppedAt: number | null;
  now: number;
}
/** R3 + R7。 */
export function sessionTurn(i: SessionTurnInput): TimedTurn;
```

- [ ] **Step 1: 写失败的测试**（追加）

```ts
import { REPORT_STOP_SLACK_MS, sessionTurn, type SessionTurnInput } from "./turn";
import type { SessionActivity } from "./activity";

const N = 5_000_000;
const act = (o: Partial<SessionActivity> = {}) => ({ kind: "waiting", stuck: null, reason: null, startedAt: null, lastOutputAt: null, ...o }) as SessionTurnInput["activity"];
const ses = (o: Partial<SessionTurnInput> = {}): SessionTurnInput => ({
  sessionId: "s", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: "登录", activity: act(), ask: null, needsYou: null,
  lastReport: null, refreshing: false, stoppedAt: N - 100, now: N, ...o,
});

describe("sessionTurn", () => {
  it("ask_user → answer with the inbox id, since = asked at", () => {
    expect(sessionTurn(ses({ ask: { id: 7, question: "用哪个库？", options: ["a", "b"], at: N - 50 } }))).toEqual({
      turn: { owner: "you", kind: "answer", question: "用哪个库？", options: ["a", "b"], askId: 7, sessionId: "s" }, since: N - 50,
    });
  });
  it("permission prompt → shipherd approval notice", () => {
    expect(sessionTurn(ses({ activity: act({ kind: "approval" }) })).turn).toEqual({
      owner: "you", kind: "shipherd", notice: { kind: "approval", target: { page: "ticket", key: "BTL-1", sessionId: "s" }, title: "登录" },
    });
  });
  it("only the four sources are stuck", () => {
    expect(sessionTurn(ses({ needsYou: { reason: "缺 API key", category: "missing_info" } })).turn).toMatchObject({ kind: "stuck", source: "needs_you", detail: "缺 API key" });
    expect(sessionTurn(ses({ activity: act({ kind: "command", stuck: true, reason: "20 分钟没输出" }) })).turn).toMatchObject({ kind: "stuck", source: "silent" });
    expect(sessionTurn(ses({ lastReport: { kind: "blocked", text: "测试环境挂了", at: N - 200 }, stoppedAt: N - 150 })).turn).toMatchObject({ kind: "stuck", source: "blocked_report" });
    // 不是卡住：普通提问、发完 blocked 又干了很久才停
    expect(sessionTurn(ses({ needsYou: { reason: "要不要拆 PR？", category: "question" } })).turn).toMatchObject({ kind: "answer", askId: null, options: [] });
    expect(sessionTurn(ses({ lastReport: { kind: "blocked", text: "x", at: N - REPORT_STOP_SLACK_MS - 200 }, stoppedAt: N - 100 })).turn).toMatchObject({ kind: "unattended", why: "agent_stopped" });
  });
  it("working or refreshing → agent working; stopped → unattended agent_stopped", () => {
    expect(sessionTurn(ses({ activity: act({ kind: "edit", startedAt: N - 9 }) }))).toEqual({ turn: { owner: "agent", kind: "working", sessionId: "s" }, since: N - 9 });
    expect(sessionTurn(ses({ refreshing: true })).turn).toEqual({ owner: "agent", kind: "working", sessionId: "s" });
    expect(sessionTurn(ses({ activity: null }))).toEqual({ turn: { owner: "you", kind: "unattended", why: "agent_stopped", canSend: false, sessionId: "s" }, since: N - 100 });
  });
});
```

`ticket_blocked` 是 ticket 级的，在 Task 4 和 Task 9 里测。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/shared/turn.test.ts`
Expected: FAIL，`sessionTurn` 不存在。

- [ ] **Step 3: 实现**，按 R3 的顺序和 R7 的 since 表。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/shared/turn.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/turn.ts src/shared/turn.test.ts
git commit -m "feat(turn): per-session turn with the four stuck sources"
```

---

### Task 4: `buildTurnBoard`：items、counts、scopes、slowest

**Files:**
- Create: `src/main/turn/turn-board.ts`, `src/main/turn/turn-board.test.ts`
- Modify: `src/shared/turn.ts`（加 `slowestOf`）, `src/shared/turn.test.ts`

**Interfaces:**
- Consumes：Task 1 到 3 的 `ticketTurn`、`mostUrgent`、`TimedTurn`、`TurnFilter`。
- Produces：
```ts
// src/shared/turn.ts
/** R8 的 slowest：活跃成员（非 done / idle）里最久没有进展的那个的名字；活跃成员少于 2 个为 null。 */
export function slowestOf(members: { name: string; owner: TurnOwner; progressAt: number }[]): string | null;

// src/main/turn/turn-board.ts
export interface BoardPr { repo: string; number: number; title: string; url: string; turn: Turn; since: number; mergedAt: number | null }
export interface BoardTicket {
  key: string;
  name: string;
  featureId: number | null;
  /** 没关闭的 PR。 */
  prs: BoardPr[];
  /** 非 PR 的候选（R4）。 */
  others: TimedTurn[];
  /** 第一条以后没回答的 ask_user（R6）。 */
  moreAsks: TimedTurn[];
}
export interface LooseItem { turn: Turn; since: number; epicId: number | null; featureId: number | null }
export interface BoardReview { repo: string; number: number; title: string; url: string; author: string; since: number }
export interface BoardInput {
  epics: { id: number; name: string }[];
  features: { id: number; name: string; epicId: number | null }[];
  tickets: BoardTicket[];
  loose: LooseItem[];
  reviews: BoardReview[];
  /** 本地今天 0 点。 */
  dayStart: number;
  now: number;
}
export function buildTurnBoard(input: BoardInput, filter: TurnFilter | null): TurnBoard;
```

- [ ] **Step 1: 写失败的测试** `src/main/turn/turn-board.test.ts`

```ts
import { describe, expect, it } from "vitest";
import type { Turn } from "../../shared/turn";
import { buildTurnBoard, type BoardInput, type BoardPr, type BoardTicket } from "./turn-board";

const NOW = 10_000_000;
const ext: Turn = { owner: "external", kind: "ci_running", names: [] };
const agent: Turn = { owner: "agent", kind: "working", sessionId: "s1" };
const merge: Turn = { owner: "you", kind: "merge", risk: "low" };
const done: Turn = { owner: "done", kind: "merged" };
const ask = (id: number): Turn => ({ owner: "you", kind: "answer", question: `q${id}`, options: [], askId: id, sessionId: "s1" });
const prOf = (n: number, turn: Turn, since = NOW - n, mergedAt: number | null = null): BoardPr =>
  ({ repo: "acme/app", number: n, title: `PR ${n}`, url: `https://ghe.example.com/acme/app/pull/${n}`, turn, since, mergedAt });
const tk = (key: string, featureId: number | null, o: Partial<BoardTicket> = {}): BoardTicket => ({ key, name: key, featureId, prs: [], others: [], moreAsks: [], ...o });

const input = (): BoardInput => ({
  epics: [{ id: 1, name: "支付" }],
  features: [{ id: 10, name: "收银台", epicId: 1 }, { id: 11, name: "退款", epicId: 1 }, { id: 12, name: "杂项", epicId: null }],
  tickets: [
    tk("PAY-1", 10, { prs: [prOf(1, merge), prOf(2, ext)] }),
    tk("PAY-2", 10, { others: [{ turn: agent, since: NOW - 500 }], moreAsks: [{ turn: ask(9), since: NOW - 5 }] }),
    tk("PAY-3", 11, { prs: [prOf(3, done, NOW - 900, NOW - 10)] }),
    tk("PAY-4", 11, { others: [{ turn: ask(8), since: NOW - 7 }] }),
    tk("SOLO-1", null),
  ],
  loose: [{ turn: ask(5), since: NOW - 3, epicId: 1, featureId: null }],
  reviews: [{ repo: "other/lib", number: 77, title: "Fix", url: "https://github.com/other/lib/pull/77", author: "amy", since: NOW - 60 }],
  dayStart: NOW - 1000,
  now: NOW,
});

describe("buildTurnBoard", () => {
  it("counts equal items without a filter; done and idle are not items", () => {
    const b = buildTurnBoard(input(), null);
    const n = (o: string) => b.items.filter((i) => i.turn.owner === o).length;
    // PAY-1（merge，两个 PR 只算一条）、PAY-2 的额外提问、PAY-4、loose、review = 5 条 you；PAY-2 是 agent
    expect(b.counts).toEqual({ you: n("you"), agent: n("agent"), external: n("external"), mergedToday: 1 });
    expect(b.counts.you).toBe(5);
    expect(b.items.some((i) => i.turn.owner === "done" || i.turn.owner === "idle")).toBe(false);
    const pay1 = b.items.find((i) => i.ticketKey === "PAY-1")!;
    expect(pay1).toMatchObject({ epicId: 1, featureId: 10, pr: { number: 1, url: "https://ghe.example.com/acme/app/pull/1" } });
    expect(b.items.find((i) => i.turn.kind === "review")).toMatchObject({ ticketKey: null, epicId: null, pr: { repo: "other/lib", number: 77 } });
  });
  it("no filter: scopes are every epic, epic-less features and standalone tickets", () => {
    const ids = buildTurnBoard(input(), null).scopes.map((s) => `${s.kind}:${s.id}`);
    expect(ids).toEqual(["epic:1", "feature:12", "ticket:SOLO-1"]);
  });
  it("epic filter: the epic row plus its feature rows; items split per PR, done included, reviews excluded", () => {
    const b = buildTurnBoard(input(), { epicId: 1 });
    expect(b.scopes.map((s) => `${s.kind}:${s.id}`)).toEqual(["epic:1", "feature:10", "feature:11"]);
    expect(b.items.filter((i) => i.ticketKey === "PAY-1").map((i) => i.pr?.number)).toEqual([1, 2]);
    expect(b.items.some((i) => i.turn.owner === "done")).toBe(true);
    expect(b.items.some((i) => i.turn.kind === "review")).toBe(false);
    expect(b.counts.you).toBe(4);
  });
  it("feature filter → feature row plus ticket rows; ticket filter → only that row", () => {
    expect(buildTurnBoard(input(), { featureId: 10 }).scopes.map((s) => s.id)).toEqual([10, "PAY-1", "PAY-2"]);
    const t = buildTurnBoard(input(), { ticketKey: "PAY-1" });
    expect(t.scopes).toEqual([{ kind: "ticket", id: "PAY-1", name: "PAY-1", total: 2, merged: 0, bar: { done: 0, agent: 0, you: 1, external: 1, idle: 0 }, youCount: 1, slowest: "acme/app#1" }]);
  });
  it("epic row totals count tickets; youCount adds loose epic-level asks", () => {
    const epic = buildTurnBoard(input(), null).scopes[0];
    expect(epic).toMatchObject({ total: 4, merged: 1, youCount: 4, bar: { done: 1, agent: 1, you: 2, external: 0, idle: 0 } });
  });
});
```

在 `turn.test.ts` 里加 `slowestOf` 的测试：

```ts
it("slowestOf picks the oldest active member, null below two", () => {
  expect(slowestOf([{ name: "A", owner: "agent", progressAt: 5 }, { name: "B", owner: "you", progressAt: 3 }, { name: "C", owner: "done", progressAt: 1 }])).toBe("B");
  expect(slowestOf([{ name: "A", owner: "agent", progressAt: 5 }, { name: "C", owner: "idle", progressAt: 1 }])).toBeNull();
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/turn/turn-board.test.ts src/shared/turn.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**，按 R8。说明：
  - 先给每个 ticket 算一次 `ticketTurn(prs.map(p => p.turn), mostUrgent(others)?.turn ?? null)`。用返回的 `turn` 按引用到 `prs` 里找来源：找到就填 `pr` 和那个 PR 的 since，没找到就用 `others` 里那条的 since。
  - counts、items 和 scope 行都从这一份结果算，不重复判断。
  - epic 行的成员是 feature，每个 feature 的 `progressAt` 取它活跃 ticket 的 since 的最大值。
  - scope 行的顺序：先按 filter 的那一行，然后是子行，子行按输入的顺序。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/turn/turn-board.test.ts src/shared/turn.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/turn/turn-board.ts src/main/turn/turn-board.test.ts src/shared/turn.ts src/shared/turn.test.ts
git commit -m "feat(turn): build the turn board with filters, scopes and slowest"
```

---

### Task 5: 记下 CI 结论递给了谁、什么时候（`ticket_prs.delivered_at` 和 `delivered_to`）

**Files:**
- Modify: `src/main/db/migrations.ts`, `src/main/db/ticket-prs-repo.ts`, `src/main/prwatch/ci-delivery.ts`
- Test: `src/main/db/ticket-prs-repo.test.ts`, `src/main/prwatch/ci-delivery.test.ts`

**Interfaces:**
- Consumes：现有的 `TicketPrsRepo.setDelivered(id, key)`、`CiDelivery` 的 `Pending.mark`。
- Produces：
  - 迁移，追加在末尾：
    ```sql
    ALTER TABLE ticket_prs ADD COLUMN delivered_at INTEGER;
    ALTER TABLE ticket_prs ADD COLUMN delivered_to TEXT;
    ```
  - `TicketPr` 加 `deliveredAt: number | null; deliveredTo: string | null`。
  - `setDelivered(id: number, key: string | null, to?: { sessionId: string; at: number }): void`。`key` 为 null 或者没给 `to` 时，两列写 null。
  - `ci-delivery.ts` 的 `Pending.mark` 改成 `mark(sessionId: string, at: number): void`。PR 行调 `this.d.prs.setDelivered(r.id, key, { sessionId, at })`，分支行不变，`branch_watch` 不加列。

- [ ] **Step 1: 写失败的测试**
  - `ticket-prs-repo.test.ts`：新 link 的行 `deliveredAt` 和 `deliveredTo` 都是 `null`。`setDelivered(id, "sha:failing", { sessionId: "s1", at: 42 })` 之后，`get(id)` 是 `{ deliveredKey: "sha:failing", deliveredAt: 42, deliveredTo: "s1" }`。再 `setDelivered(id, null)`，三列都变回 null。
  - `ci-delivery.test.ts`：在现有的「failing PR 递出去」用例旁边加一条，断言 fake `prs.setDelivered` 收到第三个参数 `{ sessionId: <收件 session>, at: <fake now> }`。沿用该文件现有的 fake deps 写法。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/db/ticket-prs-repo.test.ts src/main/prwatch/ci-delivery.test.ts`
Expected: FAIL，`deliveredAt` 是 undefined，`setDelivered` 只收到两个参数。

- [ ] **Step 3: 实现**
  - 追加迁移。
  - 在 repo 的行映射里加两个字段。
  - 改 `setDelivered`。
  - 在 `CiDelivery` 递送成功的分支里调用 `p.mark(sessionId, this.d.now())`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/db src/main/prwatch && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/db/migrations.ts src/main/db/ticket-prs-repo.ts src/main/db/ticket-prs-repo.test.ts src/main/prwatch/ci-delivery.ts src/main/prwatch/ci-delivery.test.ts
git commit -m "feat(turn): record who got the CI result and when"
```

---

### Task 6: 补两路输入：最近的 report 和评论的递送情况

**Files:**
- Modify: `src/main/db/inbox-repo.ts`, `src/main/loop/comment-loop.ts`
- Test: `src/main/db/inbox-repo.test.ts`, `src/main/loop/comment-loop.test.ts`

**Interfaces:**
- Consumes：`inbox_items`、`CommentItemsRepo.byPr`、`CommentLoop.act` 和 `flush`，以及 `list()` 里用的 `primaryRow`。
- Produces：
```ts
// InboxRepo
/** 这个 ticket 最近的一条 report；没有为 null。 */
lastReport(ticketKey: string): { kind: ReportKind; text: string; at: number; sessionId: string } | null;

// CommentLoop
/** 这个 PR 的评论条目里，state = delivered、deliveredSession 的 head 是 sessionId 的最晚 deliveredAt；没有为 null。 */
deliveredAt(prId: number, sessionId: string): number | null;
/** 有没有可以一键送出的评论：state 是 review 或 pending。 */
sendable(prId: number): boolean;
/** 把 review / pending 的条目都按 act({op:"send"}) 的规则改成 queued，再 flush 一次；返回排上的条数。 */
sendAll(prId: number): Promise<number>;
```
- `prId` 按 `primaryRow` 的规则映射到主行，和 `list()` 一致。
- 比较 head 要用 session 的 head，所以 `CommentLoop` 的 deps 加 `headOf(id: string): string | null`。如果 deps 里已经有等价的函数，就用现有的。

- [ ] **Step 1: 写失败的测试**
  - `inbox-repo.test.ts`：同一个 ticket 先 `addReport(progress, at 1)`，再 `addReport(blocked, at 2)`，`lastReport` 返回 `{kind: "blocked", at: 2}`。没有 report 的 ticket 返回 `null`。
  - `comment-loop.test.ts`，沿用现有的 setup：
    - 两条 review 状态的条目，`sendable` 为 `true`。`sendAll` 返回 `2`，之后两条都是 `queued`，并且 flush 后递进了 session。
    - 一条 delivered 给 `s1`、`deliveredAt=50` 的条目，`deliveredAt(prId, "s1")` 是 `50`，`deliveredAt(prId, "s2")` 是 `null`。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/db/inbox-repo.test.ts src/main/loop/comment-loop.test.ts`
Expected: FAIL，方法不存在。

- [ ] **Step 3: 实现**
  - `lastReport` 用 `SELECT … WHERE kind = 'report' AND ticket_key = ? ORDER BY created_at DESC, id DESC LIMIT 1`。
  - `sendAll` 复用 `act` 里 `send` 的状态改写，抽成一个私有方法，两处一起调用，不要复制一份。改完调 `this.d.changed()`，再 `await this.flush()`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/db/inbox-repo.test.ts src/main/loop && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/db/inbox-repo.ts src/main/db/inbox-repo.test.ts src/main/loop/comment-loop.ts src/main/loop/comment-loop.test.ts
git commit -m "feat(turn): last report per ticket and comment delivery helpers"
```

---

### Task 7: `gh search prs` 和 `review_requests` 表

**Files:**
- Modify: `src/main/tickets/gh.ts`, `src/main/tickets/gh.test.ts`, `src/main/db/migrations.ts`
- Create: `src/main/db/review-requests-repo.ts`, `src/main/db/review-requests-repo.test.ts`

**Interfaces:**
- Consumes：`runGh` 和 `parseJson`（`gh.ts` 内部），`prUrlParts`、`prUrlKey`（`src/shared/pr-url.ts`）。
- Produces：
```ts
// gh.ts
export interface ReviewRequestedPr { url: string; slug: string; number: number; title: string; author: string }
/** gh search prs --review-requested=@me --state=open（R9 的参数）；cwd 用 home。失败返回 null，从不抛错。slug、number 从 url 用 prUrlParts 取（企业版主机带 host 前缀）；解析不了的项跳过。 */
export async function reviewRequestedPrs(timeoutMs: number): Promise<ReviewRequestedPr[] | null>;
export const REVIEW_SEARCH_TIMEOUT_MS = 30_000;
```
- 迁移，追加：
```sql
CREATE TABLE review_requests (
  url_key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  slug TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
```
- Repo：
```ts
export interface ReviewRequestRow extends ReviewRequestedPr { firstSeenAt: number; lastSeenAt: number }
export class ReviewRequestsRepo {
  constructor(db: Db);
  /** 一次查询的结果整体替换：还在的保留 first_seen_at、更新标题 / 作者 / last_seen_at；不在的删掉；新的 first_seen_at = now。一个事务。 */
  replaceAll(list: ReviewRequestedPr[], now: number): void;
  /** 按 first_seen_at 从早到晚。 */
  list(): ReviewRequestRow[];
}
```

- [ ] **Step 1: 写失败的测试**
  - `gh.test.ts`，用文件里现有的 `fakeGh`，并且放在 `describe.skipIf(process.platform === "win32")` 里：
```ts
describe.skipIf(process.platform === "win32")("reviewRequestedPrs", () => {
  it("passes the search args and parses items, enterprise hosts keep their host in the slug", async () => {
    const dir = fakeGh(`echo "$@" >> "$(dirname "$0")/args.txt"\necho '[{"number":7,"title":"Fix","url":"https://github.com/o/r/pull/7","repository":{"nameWithOwner":"o/r"},"author":{"login":"amy"},"updatedAt":"2026-11-19T00:00:00Z"},{"number":8,"title":"X","url":"https://ghe.co/o/r/pull/8","repository":{"nameWithOwner":"o/r"},"author":{"login":"bob"},"updatedAt":"2026-11-19T00:00:00Z"},{"number":9,"title":"bad","url":"nope","repository":{},"author":{}}]'`);
    expect(await reviewRequestedPrs(5000)).toEqual([
      { url: "https://github.com/o/r/pull/7", slug: "o/r", number: 7, title: "Fix", author: "amy" },
      { url: "https://ghe.co/o/r/pull/8", slug: "ghe.co/o/r", number: 8, title: "X", author: "bob" },
    ]);
    expect(readFileSync(join(dir, "args.txt"), "utf8")).toContain("search prs --review-requested=@me --state=open");
  });
  it("returns null when gh fails", async () => {
    fakeGh("exit 1");
    expect(await reviewRequestedPrs(5000)).toBeNull();
  });
});
```
  - `review-requests-repo.test.ts`，用 `memDb()`：
    1. `replaceAll([A, B], 100)`。
    2. `replaceAll([B', C], 200)`，其中 B' 是改了标题的 B。之后 `list()` 是 `[B(first 100, title 新), C(first 200)]`，A 不在了。
    3. `replaceAll([A], 300)`，A 的 `firstSeenAt` 是 300，也就是被重新请 review 时从头算。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/tickets/gh.test.ts src/main/db/review-requests-repo.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**，照 `mergedPrs` 的写法：`runGh(homedir(), args, timeoutMs, 8 * 1024 * 1024)`，再 `parseJson`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/tickets/gh.test.ts src/main/db/review-requests-repo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/tickets/gh.ts src/main/tickets/gh.test.ts src/main/db/migrations.ts src/main/db/review-requests-repo.ts src/main/db/review-requests-repo.test.ts
git commit -m "feat(turn): gh search for review requests and their table"
```

---

### Task 8: `ReviewRequestPoller` 和设置 `reviewRequestScope`

**Files:**
- Create: `src/main/prwatch/review-requests.ts`, `src/main/prwatch/review-requests.test.ts`
- Modify: `src/main/db/settings-repo.ts`（`SETTING_DEFAULTS`）、`src/shared/settings.ts`（`EDITABLE_SETTINGS`）、`src/main/settings/settings-values.ts`（`normalizeSetting`）、`src/main/settings/settings-values.test.ts`、`src/main/strings.ts`
- Test: `src/main/prwatch/review-requests.test.ts`, `src/main/settings/settings-values.test.ts`

**Interfaces:**
- Consumes：`PR_SLOW_MS`（`src/main/prwatch/pr-schedule.ts`），`IdleSignal`（`src/main/background/idle.ts`，只用类型），Task 7 的 `ReviewRequestedPr` 和 `ReviewRequestsRepo`。
- Produces：
```ts
export const REVIEW_AWAY_MS = 15 * 60_000;
export const REVIEW_CATCHUP_MS = 60_000;
export const REVIEW_AWAY_IDLE_SECONDS = 600;
export const REVIEW_TICK_MS = 60_000;
export type ReviewRequestScope = "all" | "registered";
/** 到点了吗：没查过就到；平时 PR_SLOW_MS，离开时 REVIEW_AWAY_MS。 */
export function reviewPollDue(lastAt: number | null, now: number, away: boolean): boolean;
/** 补查：没查过，或者离上次超过 REVIEW_CATCHUP_MS。 */
export function reviewCatchUpDue(lastAt: number | null, now: number): boolean;
/** 读的时候按设置过滤（R9）。 */
export function scopeReviews<T extends { slug: string }>(list: T[], scope: ReviewRequestScope, registered: ReadonlySet<string>): T[];
export interface ReviewPollerDeps {
  fetch(): Promise<ReviewRequestedPr[] | null>;
  repo: Pick<ReviewRequestsRepo, "replaceAll" | "list">;
  /** idle.locked() || idle.idleSeconds() >= REVIEW_AWAY_IDLE_SECONDS */
  away(): boolean;
  ghAvailable(): boolean;
  /** 列表变了（增、删、改标题）才调。 */
  changed(): void;
  now(): number;
  log(msg: string, e?: unknown): void;
}
export class ReviewRequestPoller {
  constructor(d: ReviewPollerDeps);
  start(tickMs?: number): void;
  stop(): void;
  /** 定时器调：reviewPollDue 才查。 */
  tick(): Promise<void>;
  /** 窗口切到前台、打开首页时调：reviewCatchUpDue 才查。不等结果。 */
  catchUp(): void;
}
```
- 设置部分：
  - `SETTING_DEFAULTS.reviewRequestScope = "all"`，注释写「请你 review 的查询：all = 账号能看到的所有仓库，registered = 只看 Shipherd 登记过的」。
  - 把这个 key 加进 `EDITABLE_SETTINGS`。设置界面由第 6 层做。
  - `normalizeSetting` 只接受 trim 之后的 `all` 或 `registered`，其他值抛 `SettingError(M().reviewRequestScope)`。
  - `M().reviewRequestScope` 中文是「请你 review 的范围只能是 all 或 registered」，英文是 "The review request scope can only be all or registered"。

- [ ] **Step 1: 写失败的测试** `review-requests.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import { PR_SLOW_MS } from "./pr-schedule";
import { REVIEW_AWAY_MS, REVIEW_CATCHUP_MS, ReviewRequestPoller, reviewCatchUpDue, reviewPollDue, scopeReviews } from "./review-requests";

describe("review request schedule", () => {
  it("polls every PR_SLOW_MS, every 15 min when away", () => {
    expect(reviewPollDue(null, 0, false)).toBe(true);
    expect(reviewPollDue(0, PR_SLOW_MS - 1, false)).toBe(false);
    expect(reviewPollDue(0, PR_SLOW_MS, false)).toBe(true);
    expect(reviewPollDue(0, PR_SLOW_MS, true)).toBe(false);
    expect(reviewPollDue(0, REVIEW_AWAY_MS, true)).toBe(true);
  });
  it("catches up only after a minute", () => {
    expect(reviewCatchUpDue(0, REVIEW_CATCHUP_MS)).toBe(false);
    expect(reviewCatchUpDue(0, REVIEW_CATCHUP_MS + 1)).toBe(true);
  });
  it("scope registered keeps known slugs only", () => {
    const list = [{ slug: "a/b" }, { slug: "c/d" }];
    expect(scopeReviews(list, "all", new Set())).toEqual(list);
    expect(scopeReviews(list, "registered", new Set(["c/d"]))).toEqual([{ slug: "c/d" }]);
  });
});

describe("ReviewRequestPoller", () => {
  const make = (fetch: () => Promise<unknown>) => {
    let now = 1_000;
    const d = {
      fetch: vi.fn(fetch), repo: { replaceAll: vi.fn(), list: vi.fn(() => []) }, away: () => false, ghAvailable: () => true,
      changed: vi.fn(), now: () => now, log: vi.fn(),
    };
    return { d, poller: new ReviewRequestPoller(d as never), advance: (ms: number) => (now += ms) };
  };
  it("keeps the list when gh fails, and does not retry right away", async () => {
    const { d, poller, advance } = make(async () => null);
    await poller.tick();
    expect(d.repo.replaceAll).not.toHaveBeenCalled();
    advance(REVIEW_CATCHUP_MS - 1);
    poller.catchUp();
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });
  it("replaces the list and reports a change", async () => {
    const pr = { url: "u", slug: "a/b", number: 1, title: "t", author: "amy" };
    const { d, poller } = make(async () => [pr]);
    await poller.tick();
    expect(d.repo.replaceAll).toHaveBeenCalledWith([pr], 1_000);
    expect(d.changed).toHaveBeenCalled();
  });
  it("skips when gh is not available", async () => {
    const { d, poller } = make(async () => []);
    d.ghAvailable = () => false;
    await poller.tick();
    expect(d.fetch).not.toHaveBeenCalled();
  });
});
```

在 `settings-values.test.ts` 里照 `language` 那一组加：`all` 和 ` registered ` 能通过，`ALL`、`""`、`mine` 抛 `SettingError`。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/prwatch/review-requests.test.ts src/main/settings/settings-values.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**
  - 用一个 `running: Promise<void> | null` 保证同一时间只跑一个查询。
  - `lastAt` 在每次查询结束后记 `now`，成功、失败都记。
  - 判断「列表变了」：比较 `replaceAll` 前后 `repo.list()` 的 `url_key|title|author` 集合。
  - 定时器写法照 `PrWatcher.start` 和 `stop`：`setInterval` 和 `clearInterval`。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/prwatch/review-requests.test.ts src/main/settings && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/prwatch/review-requests.ts src/main/prwatch/review-requests.test.ts src/main/db/settings-repo.ts src/shared/settings.ts src/main/settings/settings-values.ts src/main/settings/settings-values.test.ts src/main/strings.ts
git commit -m "feat(turn): review request poller and its scope setting"
```

---

### Task 9: `TurnService`：取数、拼 `BoardInput`、一键发给 agent

**Files:**
- Create: `src/main/turn/turn-service.ts`, `src/main/turn/turn-service.test.ts`

**Interfaces:**
- Consumes：Task 1 到 8 的全部产出；`deliveryKey`、`Recipient`、`CiSkipReason`（`ci-delivery.ts`）；`TicketView`、`FeatureView`、`EpicView`、`Session`、`WatchedPr`、`NowNotice`、`NowTarget`、`CiUndelivered`、`CiItemRef`（`types.ts`）；`InboxItem`（`inbox-repo.ts`）；`isWorking`。
- Produces：
```ts
export interface TurnServiceDeps {
  tickets(): TicketView[];                 // sessionService.ticketViews()
  features(): FeatureView[];               // sessionService.featureViews()
  epics(): EpicView[];                     // sessionService.epicViews()
  /** 休眠着的 head（WatchedPr 之外，ticket 的 session 列表里可能没有）。 */
  hibernatedHeads(): Session[];
  /** feature / epic 总控和 Shipherd 总控的 head，各带页面 target。 */
  coordinators(): { session: Session; featureId: number | null; epicId: number | null; target: NowTarget; title: string | null }[];
  head(id: string): Session | null;
  prs(ticketKey: string): WatchedPr[];     // prWatcher.statusOf
  prRow(prId: number): TicketPr | null;    // ticketPrs.get
  recipient(ticketKey: string, repoId: number, branch: string): Recipient; // loopRecipient
  activity(id: string): SessionActivity | null;
  lastReplyAt(id: string): number | null;  // activityMonitor.lastReplyOf(id)?.at ?? null
  needsYou(): { reasons: Map<string, string>; categories: Map<string, InterruptCategory> };
  decisions(): InboxItem[];                // inboxRepo.pendingDecisions()
  lastReport(ticketKey: string): { kind: ReportKind; text: string; at: number } | null;
  refreshing(id: string): boolean;         // refresher.stepOf(id) !== null
  mergeQueued(id: string): boolean;        // gateRepo.waitingSessionIds() 换成 head 后
  risk(prId: number, headSha: string | null): "low" | "medium" | "high" | null; // AssessRepo.risk，headSha 对得上才算
  ciUndelivered(): CiUndelivered[];
  comments: Pick<CommentLoop, "deliveredAt" | "sendable" | "sendAll">;
  ciResend(item: CiItemRef): Promise<string>; // 现有的 ciResend 依赖：ciDelivery.resend + ciStuckChanged
  /** 和 nowView 同一份提醒（不含 session_limited）。 */
  notices(): NowNotice[];
  reviews(): ReviewRequestRow[];
  reviewScope(): ReviewRequestScope;
  registeredSlugs(): string[];             // lessonsRepo.repos() 的 slug ∪ lessonsRepo.slugs()
  /** 不带 filter 的 board（首页）被取时调，做 R9 的补查。 */
  homeOpened(): void;
  /** 推 turn:changed。 */
  emit(): void;
  now(): number;
}
export const TURN_CHANGED_DEBOUNCE_MS = 200;
export type TurnSendReason = "not_found" | "not_sendable" | "no_comments" | CiSkipReason;
export class TurnService {
  constructor(d: TurnServiceDeps);
  board(filter: TurnFilter | null): TurnBoard;
  sendToAgent(item: { ticketKey: string; pr: { repo: string; number: number } }): Promise<{ ok: boolean; reason?: TurnSendReason }>;
  /** 防抖 TURN_CHANGED_DEBOUNCE_MS 后 emit。 */
  changed(): void;
  dispose(): void;
}
/** 本地今天 0 点。 */
export function localDayStart(now: number): number;
```

`board` 的拼法，按 R1 到 R8：
1. 取一次 `needsYou()`、`decisions()`、`notices()` 和 `ciUndelivered()`，后面只查这几份结果，不再调接口。
2. 处理 ask_user：把每条 decision 的 session 换成 head，按 head 分组（R6）。
3. 处理每个 ticket。归档的跳过。
   - **它的 PR：** 取 `prs(key)` 里状态不是 closed 的，每个和 `prRow(prId)` 一起拼成 `PrTurnInput`：
     - pusher：`recipient()` 为 ok 时取它的 sessionId；`repoId` 为 null 时没有 pusher。
     - `ciDeliveredAt`：按 R2 取，比 `delivered_to` 时先换成 head。
     - `commentsDeliveredAt`：`comments.deliveredAt`。
     - `ciUndelivered`：`ciUndelivered()` 里有 `{kind: "pr", id}`。
     - `canResendCi`：`ci === "failing" && pusher !== null`。
     - `canSendComments`：`comments.sendable(prId) && pusher !== null`。
     - `mergeQueued`：这个 ticket 任一 head 的 `mergeQueued` 为真。
     - `risk`：`risk(prId, headSha)`。
     - `BoardPr`：`repo` 取 `TicketPr.slug`，`title` 取 `detail?.title ?? \`#${number}\``，`url` 取 `WatchedPr.url`。
   - **它的 `others`：**
     - 每个 head session，包括 `t.sessions` 和 `hibernatedHeads()` 里属于这个 ticket 的，各算一次 `sessionTurn`。
     - 加上挂在这个 ticket 上、`noticeNeedsYou` 的提醒（R5）。
     - 加上 `ticket_blocked` 和 `done`（R4）。
   - **它的 `moreAsks`：** R6。
4. 总控：对 `coordinators()` 各算一次 `sessionTurn`，owner 是 you 的进 `loose`；再加上它们的额外 ask_user，以及没挂到 ticket 上的提醒（R5、R6）。
5. reviews：`scopeReviews(reviews(), reviewScope(), new Set(registeredSlugs()))`。
6. 调 `buildTurnBoard(input, filter)`。filter 为 null 时先调 `homeOpened()`。

`sendToAgent` 的步骤：
1. 在 `prs(ticketKey)` 里找 `slug === repo && number === number` 的 PR，找不到就返回 `not_found`。
2. 用同一套拼法算出这个 PR 的 turn。如果不是 `you/unattended` 且 `canSend`，就返回 `not_sendable`。
3. why 是 `ci_*` 时，调 `await ciResend({kind: "pr", id: prId})`，结果是 `"sent"` 返回 `{ok: true}`，否则返回 `{ok: false, reason: 结果}`。
4. why 是 `changes_requested` 时，调 `await comments.sendAll(prId)`，结果大于 0 返回 `{ok: true}`，否则返回 `no_comments`。
5. 最后调 `changed()`。

- [ ] **Step 1: 写失败的测试** `turn-service.test.ts`

先写一个 `fakeDeps(over)` 工厂，默认是空数据。字段照 `TurnServiceDeps`，`emit` 和 `homeOpened` 用 `vi.fn()`。用例：

```ts
it("a failing PR whose recipient is working shows as agent fixing_ci", () => { /* ticket BTL-1 + WatchedPr ci failing + recipient ok s1 + activity edit → items[0].turn = agent fixing_ci, pr.url = WatchedPr.url */ });
it("a coordinator's ask_user is a loose you/answer with the inbox id", () => { /* decisions: [{id: 7, sessionId: "c1", ticketKey: null, featureId: 3, epicId: 1, ...}] → items 里有 {ticketKey: null, featureId: 3, epicId: 1, turn: {kind: "answer", askId: 7}} */ });
it("two asks on one ticket: the ticket item answers the first, the second is its own item", () => { /* counts.you === 2 */ });
it("a ticket marked blocked is stuck/ticket_blocked; in_review is not stuck", () => {});
it("a done ticket without PRs shows only with a filter", () => { /* board(null).items 不含；board({ticketKey}).items 有 done */ });
it("review scope registered drops unknown repos, and the home board triggers a catch-up", () => { /* homeOpened 只在 filter 为 null 时被调 */ });
it("sends CI through ciResend and comments through sendAll", async () => {});
it("refuses when the turn cannot be sent", async () => { /* agent 在修 → not_sendable；找不到 PR → not_found；ciResend 返回 "busy" → {ok:false, reason:"busy"}；两种情况下 ciResend 和 sendAll 都没有被调用 */ });
it("changed() is debounced into one emit", () => { /* vi.useFakeTimers；连调 3 次，推进 TURN_CHANGED_DEBOUNCE_MS → emit 1 次 */ });
```

每个用例都要写全 fake 数据和断言。注释里的内容就是要断言的东西。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/turn/turn-service.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**，按上面列出的拼法。`TurnService` 只把数据转换后交给纯函数，不在这里写任何判断规则。规则只在 `turn.ts` 和 `turn-board.ts` 里。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/turn && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/turn/turn-service.ts src/main/turn/turn-service.test.ts
git commit -m "feat(turn): TurnService assembles the board and sends to the agent"
```

---

### Task 10: IPC 和主进程接线

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/ipc/validate.ts`, `src/main/ipc/validate.test.ts`, `src/main/ipc/register.ts`, `src/renderer/src/api.ts`, `src/main/index.ts`
- Test: `src/main/ipc/validate.test.ts`, `src/shared/ipc.test.ts`（现有）

**Interfaces:**
- Consumes：Task 8 的 `ReviewRequestPoller`，Task 9 的 `TurnService`，现有的 `notify`、`safeSend`、`idleSignal`、`loopRecipient`、`ciDelivery`、`ciStuckChanged`、`commentLoop`、`gateRepo`、`refresher`、`activityMonitor`、`needsYou`、`inboxRepo`、`AssessRepo`、`lessonsRepo`、`ticketPrs` 和 `prWatcher`。
- Produces：
  - `IPC.turnBoard = "turn:board"`、`IPC.turnSendToAgent = "turn:send-to-agent"`，这两个进 `INVOKE_CHANNELS`。
  - `IPC.turnChanged = "turn:changed"`，进 `EVENT_CHANNELS`。
  - `validate.ts`：
```ts
/** undefined / null → null；只认 epicId、featureId（正整数）、ticketKey（1–200 字符的字符串）三个键，最多给一个。 */
export function turnFilterArg(v: unknown): TurnFilter | null;
/** { ticketKey: string; pr: { repo: string; number: 正整数 } }，不许多余的键。 */
export function turnSendArg(v: unknown): { ticketKey: string; pr: { repo: string; number: number } };
```
  - `IpcDeps` 加 `turnBoard: (filter: TurnFilter | null) => TurnBoard` 和 `turnSendToAgent: (item) => Promise<{ ok: boolean; reason?: string }>`。
  - handler：`handle(IPC.turnBoard, (raw: unknown) => d.turnBoard(turnFilterArg(raw)))`，`handle(IPC.turnSendToAgent, (raw: unknown) => d.turnSendToAgent(turnSendArg(raw)))`。
  - `api.ts`：
```ts
turnBoard: (filter?: TurnFilter) => call<TurnBoard>(IPC.turnBoard, filter ?? null),
turnSendToAgent: (item: { ticketKey: string; pr: { repo: string; number: number } }) => call<{ ok: boolean; reason?: string }>(IPC.turnSendToAgent, item),
onTurnChanged: (cb: () => void) => window.shipherd.on(IPC.turnChanged, cb),
```

`index.ts` 的接线：
- **notify：** `notify` 定义在 `TurnService` 之前，所以先声明 `let turnChanged: (() => void) | null = null`，再把 `notify` 改成 `() => { safeSend(IPC.stateChanged); turnChanged?.(); }`。建好 `turnService` 后赋值 `turnChanged = () => turnService.changed()`。
- **提醒：** 把 `nowView` 依赖里 `notices: [...]` 那一串抽成 `const currentNotices = (): NowNotice[] => [...]`，`nowView` 和 `TurnService` 共用。只是搬位置，内容不改。
- **review 查询：** 建 `reviewRequests = new ReviewRequestsRepo(db)` 和 `reviewPoller = new ReviewRequestPoller({...})`：
  - `fetch` 用 `() => reviewRequestedPrs(REVIEW_SEARCH_TIMEOUT_MS)`。
  - `away` 用 `() => idleSignal.locked() || idleSignal.idleSeconds() >= REVIEW_AWAY_IDLE_SECONDS`。
  - `ghAvailable` 用 `ghAvailable`。
  - `changed` 用 `() => turnService.changed()`。
- **启动和退出：** 在 `prWatcher.start()` 旁边，也就是 `healthReady.then` 里面，加 `reviewPoller.start()`。在 `prWatcher.stop()` 旁边加 `reviewPoller.stop()` 和 `turnService.dispose()`。
- **补查：** `app.on("browser-window-focus", () => reviewPoller.catchUp())`。
- **新设置立即生效：** 设置 `reviewRequestScope` 被改了以后要调 `turnService.changed()`。现有的 `settingsSet` 会调 `notify`，这样就够了。实现时确认一下。

- [ ] **Step 1: 写失败的测试**，在 `validate.test.ts` 里：
  - `turnFilterArg`：`undefined` 和 `null` 返回 `null`；`{ epicId: 2 }` 原样返回；`{ ticketKey: "BTL-1" }` 原样返回。
  - `turnFilterArg` 抛错的输入：`{ epicId: 0 }`、`{ epicId: 1, featureId: 2 }`、`{ foo: 1 }`、`{ ticketKey: "" }`、`[]`、`"x"`。
  - `turnSendArg`：`{ ticketKey: "BTL-1", pr: { repo: "o/r", number: 3 } }` 原样返回。
  - `turnSendArg` 抛错的输入：缺 `pr`、`number: 1.5`、多一个键。

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/main/ipc/validate.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**，内容见上面的 Interfaces 和接线说明。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/main/ipc src/shared/ipc.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS。`ipc.test.ts` 里新的三个 channel 各出现一次。

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/validate.ts src/main/ipc/validate.test.ts src/main/ipc/register.ts src/renderer/src/api.ts src/main/index.ts
git commit -m "feat(turn): turn:board, turn:send-to-agent and turn:changed"
```

---

### Task 11: `turnSentence` 和中英文文案

**Files:**
- Create: `src/renderer/src/turn-text.ts`, `src/renderer/src/turn-text.test.ts`
- Modify: `src/renderer/src/strings.ts`, `src/renderer/src/strings-en.ts`

**Interfaces:**
- Consumes：`Turn`、`TurnItem`（`src/shared/turn.ts`），`UiStrings`。
- Produces：
```ts
/** 一个 Turn 的那一句话（第 2、3 层的卡片、行都用它）。位置、多久以前不在句子里。 */
export function turnSentence(turn: Turn, item: TurnItem, t: UiStrings): string;
```
- `strings.ts` 的 `ZH` 加 `turn` 一节，`EN` 同形。文案如下：

| key | 中文 | English |
|---|---|---|
| `answer(q)` | `问你：${q}` | `Asks you: ${q}` |
| `merge` / `mergeRisk(level)` | `可以合并了` / `可以合并了，风险${低/中/高}` | `Ready to merge` / `Ready to merge — ${low/medium/high} risk` |
| `review(author, title)` | `${author} 请你 review：${title}` | `${author} asked for your review: ${title}` |
| `stuck.needs_you(d)` | `卡住了：${d}`（d 为 null 时是 `卡住了，说做不下去`） | `Stuck: ${d}` / `Stuck, says it can't go on` |
| `stuck.blocked_report(d)` | `报告做不下去：${d}` | `Reported it's blocked: ${d}` |
| `stuck.silent(d)` | `在跑，但很久没动静`（有 d 时加上 `：${d}`） | `Running but silent for a long time` |
| `stuck.ticket_blocked` | `ticket 标成了阻塞` | `The ticket is marked blocked` |
| `unattended.ci_failing` | `CI 挂了，没人在修` | `CI failed and nobody is fixing it` |
| `unattended.changes_requested` | `review 要求修改，没人在改` | `Changes requested and nobody is on it` |
| `unattended.conflicts` | `有冲突，没人在处理` | `Has conflicts and nobody is on it` |
| `unattended.behind` | `落后主干，没人在更新` | `Behind the base branch and nobody is updating it` |
| `unattended.draft` | `还是草稿，没人在推进` | `Still a draft and nobody is moving it` |
| `unattended.no_reviewer` | `还没请人 review` | `No reviewer requested yet` |
| `unattended.agent_stopped` | `agent 停下了，等你接着说` | `The agent stopped and is waiting for you` |
| `unattended.ci_undelivered` | `CI 结论半小时没送到 agent` | `The CI result hasn't reached the agent for 30 min` |
| `agent.fixing_ci` / `addressing_review` / `rebasing` / `working` | `agent 在修 CI` / `agent 在按 review 改` / `agent 在处理冲突` / `agent 在做` | `The agent is fixing CI` / `…addressing review` / `…resolving conflicts` / `The agent is working` |
| `external.ci_running` | `在等 CI` | `Waiting for CI` |
| `external.awaiting_review(names)` | `在等 ${names.join("、")} review`（空时是 `在等 review`） | `Waiting for review from ${names.join(", ")}` / `Waiting for review` |
| `external.merge_queue` | `在合并队列里` | `In the merge queue` |
| `done` / `idle` | `合了` / `还没开始` | `Merged` / `Not started` |
| `shipherd.<kind>` | 见下 | 见下 |

`shipherd` 按 notice 的 kind 出一句短话，只覆盖 `noticeNeedsYou` 为真的那几种：
- `approval`：`在终端里等你确认权限` / `Waiting for you to confirm a permission prompt`
- `claude_limited`：`Claude 到额度了，等你处理` / `Claude hit its limit`
- `model_unavailable`：`模型用不了` / `The model is unavailable`
- `session_limited`：`这个 session 到额度停了` / `This session hit its limit`
- `ci_undelivered`：`CI 结论没送到 session` / `The CI result wasn't delivered`
- `cost`：`花费到上限暂停了，等你决定要不要继续` / `Paused at its cost limit; continue?`
- `comments_waiting`：`review` 原因是 `有 ${n} 条评论等你分类`，`undelivered` 原因是 `有 ${n} 条评论没送到 session`；英文是 `${n} comments to triage` 和 `${n} comments not delivered`
- `stack`：`栈里有冲突没交给 session` / `A stack conflict wasn't handed to a session`；`stuck` 原因是 `栈的 rebase 卡住了` / `The stack rebase is stuck`
- `intake`：`自动接活拿不准，等你决定` / `Auto-intake needs your decision`

其余 kind 不会出现在 turn 里。`switch` 的 default 返回 `t.turn.shipherd.other`：`Shipherd 要你点一下` / `Shipherd needs a click`。

- [ ] **Step 1: 写失败的测试** `turn-text.test.ts`

```ts
import { afterEach, describe, expect, it } from "vitest";
import type { Turn, TurnItem } from "../../shared/turn";
import { S, setUiLang } from "./strings";
import { turnSentence } from "./turn-text";

const item = (turn: Turn): TurnItem => ({ ticketKey: "BTL-1", pr: null, epicId: null, featureId: null, turn, since: 0 });
afterEach(() => setUiLang("zh"));

describe("turnSentence", () => {
  it("covers every owner and kind in zh", () => {
    const cases: [Turn, string][] = [
      [{ owner: "you", kind: "answer", question: "用哪个库？", options: [], askId: 1, sessionId: "s" }, "问你：用哪个库？"],
      [{ owner: "you", kind: "merge", risk: "high" }, "可以合并了，风险高"],
      [{ owner: "you", kind: "review", author: "amy", title: "Fix", url: "u" }, "amy 请你 review：Fix"],
      [{ owner: "you", kind: "unattended", why: "ci_failing", canSend: true, sessionId: null }, "CI 挂了，没人在修"],
      [{ owner: "agent", kind: "fixing_ci", sessionId: "s" }, "agent 在修 CI"],
      [{ owner: "external", kind: "awaiting_review", names: ["bob", "amy"] }, "在等 bob、amy review"],
      [{ owner: "done", kind: "merged" }, "合了"],
      [{ owner: "idle", kind: "not_started" }, "还没开始"],
    ];
    for (const [turn, text] of cases) expect(turnSentence(turn, item(turn), S)).toBe(text);
  });
  it("has the same keys in en", () => {
    setUiLang("en");
    expect(turnSentence({ owner: "you", kind: "merge", risk: null }, item({ owner: "you", kind: "merge", risk: null }), S)).toBe("Ready to merge");
  });
  it("shipherd sentences come from the notice kind", () => {
    const t: Turn = { owner: "you", kind: "shipherd", notice: { kind: "approval", target: { page: "shipherd", sessionId: null }, title: null } };
    expect(turnSentence(t, item(t), S)).toBe("在终端里等你确认权限");
  });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm vitest run src/renderer/src/turn-text.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**：在 `ZH` 和 `EN` 里加 `turn` 一节，再写 `turnSentence`。用 `switch` 把 turn 的每个 kind 都写全；`stuck` 和 `unattended` 再按 source 和 why 查表。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm vitest run src/renderer/src/turn-text.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/turn-text.ts src/renderer/src/turn-text.test.ts src/renderer/src/strings.ts src/renderer/src/strings-en.ts
git commit -m "feat(turn): turnSentence with zh and en copy"
```

---

### Task 12: 假 gh 支持 `search prs`，加 e2e

**Files:**
- Modify: `e2e/fake-gh/fake-gh.cjs`, `e2e/fixtures.ts`
- Create: `e2e/turn-board.spec.ts`

**Interfaces:**
- Consumes：`IPC.turnBoard`、`IPC.turnSendToAgent`，以及 `fixtures.ts` 里的 `test`、`completeWizard`、`unsupportedGhCalls`、`makeGitRepo`、`FAKE_GH_ORIGIN`。
- Produces：
  - `FakeGhFixture` 加 `reviewRequested?: { number: number; title: string; url: string; repository: { nameWithOwner: string }; author: { login: string }; updatedAt: string }[]`。
  - 假 gh 加一条：`search prs … --review-requested=@me …` 输出 `fixture().reviewRequested ?? []`。
  - 文件头的说明列表里加一行：`search prs --review-requested=@me --state=open …：reviewRequested，没有就是 []`。

- [ ] **Step 1: 写 e2e** `e2e/turn-board.spec.ts`

```ts
import type { Page } from "@playwright/test";
import { IPC } from "../src/shared/ipc";
import type { TurnBoard } from "../src/shared/turn";
import { completeWizard, expect, test, unsupportedGhCalls } from "./fixtures";

const board = (page: Page, filter?: unknown) =>
  page.evaluate(([ch, f]) => (window as unknown as { shipherd: { invoke(c: string, ...a: unknown[]): Promise<{ ok: boolean; value: TurnBoard }> } }).shipherd.invoke(ch as string, f ?? null), [IPC.turnBoard, filter] as const);

/**
 * 第 1 层：「请你 review」的 PR 经 gh search prs 进 turn:board，不属于任何 ticket；带 filter 时不出现。
 * Windows 上跳过：假 gh 是 sh 包装，resolveGh 只认 gh.exe。
 */
test("a PR someone asked you to review shows up on the turn board", async ({ makeSandbox, launch }) => {
  test.skip(process.platform === "win32", "the fake gh is an sh wrapper; resolveGh only accepts gh.exe on Windows");
  const url = "https://github.com/other/lib/pull/77";
  const s = makeSandbox({ gh: { branches: {}, prs: {}, reviewRequested: [{ number: 77, title: "Fix parser", url, repository: { nameWithOwner: "other/lib" }, author: { login: "amy" }, updatedAt: "2026-11-19T00:00:00Z" }] } });
  const { page } = await launch(s);
  await completeWizard(page, s);
  await expect.poll(async () => (await board(page)).value.items.find((i) => i.turn.kind === "review")?.pr?.url).toBe(url);
  const b = (await board(page)).value;
  const review = b.items.find((i) => i.turn.kind === "review")!;
  expect(review).toMatchObject({ ticketKey: null, epicId: null, featureId: null, turn: { owner: "you", kind: "review", author: "amy", title: "Fix parser", url } });
  expect(b.counts.you).toBe(b.items.filter((i) => i.turn.owner === "you").length);
  expect((await board(page, { ticketKey: "E2E-7" })).value.items.some((i) => i.turn.kind === "review")).toBe(false);
  expect(unsupportedGhCalls(s)).toEqual([]);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `pnpm e2e -- e2e/turn-board.spec.ts`
Expected: FAIL。假 gh 把 `search prs` 记成 unsupported，`expect.poll` 超时。

- [ ] **Step 3: 实现**：在 `fake-gh.cjs` 的 `--version` 分支后面加 `cmd === "search" && sub === "prs" && args.includes("--review-requested=@me")`，输出 `fixture().reviewRequested ?? []`。`fixture()` 的返回值里加上 `reviewRequested`。`fixtures.ts` 的类型加上这个字段。

- [ ] **Step 4: 运行，确认通过**

Run: `pnpm e2e -- e2e/turn-board.spec.ts && pnpm test && pnpm typecheck && pnpm lint`
Expected: 全部 PASS。现有的 e2e 不受影响：它们的 fixture 没有 `reviewRequested`，假 gh 返回 `[]`，不算 unsupported。如果时间允许，再跑一遍 `pnpm e2e` 全量。

- [ ] **Step 5: Commit**

```bash
git add e2e/fake-gh/fake-gh.cjs e2e/fixtures.ts e2e/turn-board.spec.ts
git commit -m "test(turn): e2e for review requests on the turn board"
```

---

## 旧算法替换表

现在显示 PR 或 ticket 状态的有 4 套算法、7 个地方，已经 grep 确认。本层只加新的，不删。删的时候，连同相应的测试和不再使用的文案一起删。

| # | 旧算法 | 在哪里用（调用点） | 换成 | 哪层删 |
|---|---|---|---|---|
| A | `waitingOnOf`（`src/shared/progress.ts:57`） | ① `ProgressPage.tsx:54/216`，经 `progress-view.ts:59/72` 和 `progress-ui.ts:22` 的 `waitingText`，包括 `BLOCKING` 和 stuck 列表（`progress-view.ts:175-181`） | 「全部工作」页用 `turn:board` | 第 2 层删页面和 `progress-ui.waitingText`。`main/progress/progress-view.ts` 和 `shared/progress.ts` 的 `waitingOnOf` 由第 3 层删，见建议 4 |
| A | 同上 | ② `src/main/control/shipherd-control.ts:276`（MCP `progress_overview` 的 `waitingOn`）；③ `src/main/handoff/feature-templates.ts:169`（feature 汇总的后台文案） | 用 `TurnService.board` 的 turn。字段名可以保留，内容换成 owner 和 kind | 第 3 层（总控页那一层），见建议 4 |
| B | 主进程 `now-view.ts` 的 `sessionRow` 中 needsYou 和 idle 的判断（约 71-97 行），以及 `buildNowView` 产出的 `needsYou`、`decisions`、`notices` | ④ `NowPage.tsx`（`needsYouText`、`needsYouTotal`）；⑤ `App.tsx:167` 侧栏的 `needsYouTotal(nowView)` | 首页和侧栏用 `turn:board` 的 `counts.you` | 渲染进程这边由第 2 层删。主进程 `NowView.needsYou`、`decisions`、`notices` 字段的产出由 **第 3 层** 删，那时渲染进程已经不读了；`ShipherdPage` 也不读，删之前用 grep 再确认一次 |
| C | 渲染进程 `now-view.ts` 的 `prText`、`prPill`、`rowText`、`livePill`，以及 `feature-summary-view.ts` 的 `prPill` | ④ `NowPage.tsx:277`；⑥ `LiveWindow.tsx:175`（`livePill`）；⑦ `FeaturePage.tsx:358`（`prPill`、`prLabel`） | `turnSentence` 加 owner 色 | `now-view.ts` 的这些函数和 `LiveWindow` 的 `livePill` 由第 2 层删。`feature-summary-view.ts` 的 `prPill`、`prLabel` 由第 3 层删，第 3 层的删除清单里已经写了。`S.prPill` 在第 2 层最后一个用它的地方删掉后一起删 |
| D | epic 和 feature 的状态：`epic-info.ts:54` 的 `statusOf`（`EpicFeatureStatus`），以及 `epic-row.ts` 的 `epicRowText` 和 `firstSentence` | ⑦' `EpicPage.tsx:144`；侧栏的卡住标记（`.stuck-mark`）；`epic-brief.ts:64/95` 的总控文案 | `ScopeTurnRow`（数字、进度条、`youCount`、`slowest`） | 侧栏的标记由第 2 层删。`EpicPage` 和 `epic-row.ts` 由第 3 层删。`EpicFeatureStatus`、`statusOf` 和 `S.epicStatus` 由第 3 层在最后一个调用点删掉后删 |

## 自查

1. **spec 覆盖：**
   - §5.1 的状态表：Task 1 到 3。
   - 数据来源：pickRecipient 和 delivered_key 在 Task 5、9；hibernation 的等待状态，由 needs-you、CI、review 的原始输入直接表达（见 R3），休眠的 session 算不在干活。
   - 「请你 review」：Task 7、8、12。
   - 可合并的判断：R1 第 6、8 条。
   - 卡住的 4 个来源：R3、R4。
   - 每个 PR 单独算、ticket 取最急的：Task 1、4。
   - 首页的数字（N 件事轮到你、agent 在处理多少、在等多少、今天合了多少）：Task 4 的 counts。
   - Shipherd 卡片的 7 种来源：R5 和 Task 1。其中「屏幕上的权限确认」是新加的 `approval`。只做提示的提醒不进首页。
   - epic 的「数字 + 进度条」和「最慢的地方」：Task 4。
   - 中英文：Task 8、11。
   - 不改后台行为：Task 5、6 只多记了时间，和加了一个由用户触发的、走现有路径的「一键发送」。
2. **步骤：** 每个任务都有失败的测试、运行命令和预期、实现、再次运行和 commit。Task 9 的测试只列了用例名和要断言的内容，不展开 fake 数据，这是有意的：fake 数据完全由 `TurnServiceDeps` 决定。
3. **类型一致：**
   - `TurnItem.pr.url` 来自 `WatchedPr.url`，review 的来自 gh 返回的 url，都不靠拼出来。
   - `askId` 是 `inbox_items.id`，可以传给 `api.answerInbox`。
   - 包装名是 `api.turnBoard`、`api.onTurnChanged`、`api.turnSendToAgent`。
   - `turnSentence(turn, item, t: UiStrings)` 和第 2、3 层的调用方式一致。
4. **Review Focus：** 5 条，各在 Task 2、3、4、8、9 有对应的测试。
5. **有意和 spec 不同的地方：** spec 说「查到的 PR 再按现有的慢速节奏读详情」，本层不读。卡片要的标题、作者和链接，search 的结果里都有，而且每 5 分钟刷新一次；多读一次详情要多调 N 次 gh，界面上却没有地方用得到。以后卡片要显示 CI 等信息时再加。
6. **规模：** 12 个任务。每个改 2 到 6 个文件，大约 1 到 2 小时。Task 9 最大，但它的规则都已经在纯函数里测过了。

## 对共用接口的建议

本层仍然完全按索引写，下面只是建议，由协调者决定。

1. **`TurnItem` 加 `others: number`。** `ticketTurn` 返回了 `others`，用来说「另有 1 个 PR 在等 CI」，但 `TurnItem` 里没有这个字段。不带 filter 时，item 已经是 ticket 级的，渲染进程拿不到 PR 的 turn，没法自己算。现在第 2 层的首页卡片说不出这半句。建议在 item 上加 `others`，并让 `turnSentence` 接上这半句。
2. **带 filter 时 items 的粒度和 counts。** 第 3 层要按 PR 拆开的 items（每个 PR 一条，再加 ticket 级一条），协调者的口径又是「counts 等于 items 的计数」。两者在带 filter 时不能同时成立。本计划的做法是：counts 始终按「一个 ticket 一条」数，不带 filter 时正好等于 items 的计数，带 filter 时不等于。建议把索引的口径改成「counts 按 ticket 级计数；不带 filter 时等于 items」。另外，同一个 ticket 有几条没回答的 ask_user 时，第一条以后的会是额外的 `pr: null` item。第 3 层取「session 级那一条」时，应该在 `pr === null` 的 item 里取 `mostUrgent`，不要取第一条。
3. **不带 filter 时的 scopes 要包括「没有 epic 的 feature」。** 协调者第二次说的是「所有 epic 和所有单独的 ticket」，第一次说的是「所有 feature」。如果只照第二次，没有 epic 的 feature 在首页的小表里就没有行了，第 3 层的 `featuresOutsideEpics` 也没有数据。本计划把它们加了进来。如果第 2 层不想要，可以在渲染进程过滤掉。
4. **`waitingOnOf` 的后台调用点没人删。** 第 3 层的计划写的是「`shipherd-control` 和 `feature-templates` 的 `waitingOnOf` 属于第 1 层」，而给我的范围是「本层只出新算法和测试」。按现在的写法，这两处和 `main/progress/*` 谁都不删。建议在第 3 层加一个任务，把它们换成 `TurnService.board` 的结果；或者允许本层加第 13 个任务来做。不管哪种，表 A 的「哪层删」都要在索引里定下来。
5. **`NowNotice` 新加了 `approval`。** 索引里 `you/shipherd` 的 `notice: NowNotice` 没有能表示「屏幕上的权限确认」的 kind，所以本层加了 `{ kind: "approval"; target; title }`，并在 `noticeText` 里补上了对应的分支。第 2 层的 `Notice` 组件如果按 kind 穷举，要认这一种。
6. **总控和全局的 item。** 协调者要求「所有 ask_user，包括总控 session 的，都要出现在 items 里」，所以 items 里会有 `ticketKey: null && pr === null` 的项：总控的 ask_user 和卡住，以及不挂在 ticket 上的 Shipherd 提醒（Claude 到额度、自动接活等）。建议在索引的口径里写明，「一条 item 是一个 ticket、一个请你 review 的 PR，或者一件不属于 ticket 的要你动手的事」。
7. **`turn:send-to-agent` 的 `reason`。** 取值是 `TurnSendReason`：`not_found | not_sendable | no_comments`，或 `CiSkipReason`（`busy`、`no_session` 等）。第 2 层的 `S.hm.act.sendNot(reason)` 按这个列表出文案；索引里的 `reason?: string` 可以收紧成这个类型。
8. **企业版 GitHub 上的「请你 review」。** `gh search prs` 只查 gh 默认的主机，企业版的 review 请求要按主机再查一次。本层没有做，建议记进 spec 的「已知限制」。
