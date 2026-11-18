# Workstream H：度量与「效果」页（设计补充）

上级文档：`2026-11-17-butler-3-design.md`（第 3 节 H、第 4.7 节、第 4.6 节、第 4.9 节）。
这里只记 H 自己做的决定；契约以上级文档为准，这里只扩展不修改。

## 0. 开工前核实过的点

- **activity-monitor 能不能累计等人时间。** 不能。`ActivityMonitor` 只存内存里的"此刻在做什么"（`waiting` / `approval` / `thinking` …），没有时长；`sessions.waiting_for_input` 只是一个开关，没有起止时间。H 新加 `metrics_wait_spans` 表和 `WaitTracker`（第 3 节）。
- **休眠的 session。** WS-M 的休眠记在 `sessions.hibernated_at`；休眠的 head 在「现在」页上冻结在"需要你"里（`needsYouFrozen`）。H 规定：**休眠期间不算等待**，进入休眠时关掉这个 session 正开着的等待段，唤醒后重新开始。
- **合并是不是 agent 做的。** session 里跑 `gh pr merge`（或者 `git merge` + push）会先过合并闸（`merge-gate.ts`），在 `merge_holds` 记一行（`kind = 'pr'` 带 `pr_url`，本地合并是 `kind = 'local'` 带分支，都有 `outcome`）。所以"合并了、但没有 outcome 为 merged 的占位"的 PR 就是人手动合的；不用改 hook。占位还没释放（最多 `HOLD_MAX_MS`）的先不判断。
- **重开（closed → open）。** `prObservations` 不记重开，而且 `PrWatcher` 不再轮询关闭了的 PR（`nextPrCheckAt` 对非 open 的返回 Infinity），在 watcher 里根本看不到 closed → open。所以重开由 `MetricsGhJob`（第 8 节，PR 2）只读地查：对最近 30 天里还开着、或者合并 / 关闭了的 ticket PR，读 `gh api repos/<slug>/issues/<n>/events` 里的 `reopened`，每一条记一次 `pr_reopened`（dedupe `reopen:<prId>:<事件 id>`）。每次最多查 200 个 PR。
- **评论的来源。** `pr_stage_events` 的 `comment` 事件带 `who`（`copilot` / `human` / `author` / `bot`），`review` 事件带 `who` 和 `body`。H 只读，不重新调 gh。可避免评论读 C 的 `lesson_runs.findings_json` 里 `avoidable = true` 的条目（同一个 `(repo_slug, pr_number)` 最新一次 `done` 的运行）。
- **花费。** `session_usage` 每行有 `session_id`、`model`、`task`、`source`、`cost_usd`（可能为空）和五种 token。加权 token 用 `USAGE_WEIGHTS`；美元先用 `cost_usd`，空的按模型注册表的价格（`routing/spend.ts` 的 `usdOf`）算，两样都没有的记成"部分"。
- **风险等级。** G 的 `pr_risk`（契约 4.6）还没合进 main。H 只读：表不存在、没有这个 PR 的行，都显示"未分级"。H 期望的列是 `pr_risk(pr_id INTEGER, level TEXT)`；如果 G 的列名不同，按 `level` → `risk` → `tier` 的顺序找第一个存在的 TEXT 列（`PRAGMA table_info`），找不到同样算未分级。H 自己不算风险。
- **L 的熔断事件。** L 的 `CostBreaker` / `BackgroundScheduler` 留了可选的 `onEvent(kind, refs)`；合并以后在 index.ts 里接到 `recordEvent`（L 的分支还没进 main，接线留给后合的那一方，见第 1 节）。

## 1. `recordEvent`（契约 4.7 的接口，先合进 main）

```ts
// src/main/metrics/events.ts
export interface MetricRefs {
  sessionId?: string | null;
  ticketKey?: string | null;
  /** ticket_prs.id */
  prId?: number | null;
  repoSlug?: string | null;
  /** 默认 now()。 */
  at?: number;
  /** 小的 JSON 对象：类别、子类型、来源等。不放用户写的原文（问题、回复、命令）。 */
  data?: Record<string, string | number | boolean | null>;
  /** 同一个 key 只记一次（重试、重复观察）。 */
  dedupeKey?: string;
}
export type RecordEvent = (kind: string, refs?: MetricRefs) => boolean;
```

- `kind` 是 `snake_case` 字符串，可以带一个点号分的前缀（`cost.pause`）。不在 `METRIC_KINDS` 里的也收（别的 workstream 不用改 H 的代码），只是「效果」页把它们放在"其他事件"里按次数显示；在表里的有中英文名字和归类（人介入 / 打断 / 返工 / 评论 / 其他）。
- **永不抛错**：写库失败只写日志、返回 false。重复的 `dedupeKey` 返回 false。
- 写进 `metrics_events`，由 rollup（第 5 节）汇总进 `metrics_daily`。
- 一个 `Metrics` 实例在 index.ts 里建，别的模块通过依赖拿到 `recordEvent`（不用全局单例，测试好替换）。
- 预先登记的、给别的 workstream 用的 kind：`comment_auto_handled`（I：评论已自动处理，带 `prId`，指标里算"已自动处理的评论"）、`cost.warn` / `cost.downgrade` / `cost.pause` / `cost.stop` / `cost.resume` / `cost.raise`、`background.yield` / `background.resume`（L）、`interrupt_auto_resolved`（J：按白名单 / 默认选项自动放行的打断，带 `category`）。

## 2. 人介入：每个采集点

人介入 = 人为推动工作所做的一次操作。每一个采集点一个 kind，各有单测。

| kind | 采集点 | 条件 | data |
|---|---|---|---|
| `terminal_input` | UserPromptSubmit hook（index.ts，`pty.markSubmitted` 之前） | 只算 Butler 开着终端的 session（外部终端里认领的、复盘分析 session 不算），hook 的 session 和终端在同一条 head 链上（终端里 agent 跑的嵌套 `claude -p` 不算）；这个终端此刻**没有** Butler 在递东西（`pty.autoInputInFlight` 为 false）：Butler 递回答、递汇报、交任务、换新时的 `/handoff` 都不算 | `mode: "prompt"`；`answered`：`ask_user`（有未决的 ask_user）/ `needs_you`（被判断成需要你）/ 缺省 |
| `terminal_input` | `pty:write`（`register.ts`） | 终端停在权限确认上（`pty.permissionShowing`）或活动是 `approval` 而且有工具在跑（`startedAt` 不为空：AskUserQuestion、ExitPlanMode；只有 `approval` 的是刚答完、还没重读的权限确认），按下回车、数字、y/n、Esc；同一个终端 2 秒内只记一次 | `mode: "dialog"`，`answered: "permission"` / `"choice"` |
| `terminal_input` | `pty:write` | session 在干活（`isWorking`）时单独按 Esc（打断）；2 秒去重 | `mode: "interrupt"` |
| `needs_you_answer` | `InboxService.answer`（卡片上回答「待你决定」） | 答案非空、条目是未决的 decision | `via: "card"`，`options`（选项个数） |
| `needs_you_answer` | `InboxService.dismiss`（「不用了」） | 同上 | `via: "dismiss"` |
| `manual_merge` | rollup 开头的 `recordMerges`（`metricsSince` 之后合并的 PR） | `merge_holds` 里没有这个 PR 的、占位时间不晚于合并时间、`outcome = 'merged'` 的占位（PR 占位按 `prUrlKey` 对；本地占位按 head 分支，再对 ticket 或仓库路径）；cancelled、expired 的都算人合的。这个 PR 还有没释放的占位时先不记，下一次 rollup 再判断。dedupe `merge:<prId>`，`at` = 合并时间 | `agent: false` |
| `agent_merge` | 同上 | 有这样的占位（agent 的 `gh pr merge` 或本地合并过了合并闸） | `agent: true`（不算人介入，用来核对） |
| `manual_trigger` | `register.ts` 的 `handle()`（`meteredIpcResult`） | IPC 通道在 `MANUAL_TRIGGERS` 里（下面的表）；调用成功、而且真做了事才记（唤醒的结果不是 `woken`、返回 `{ok: false}` 的不算） | `channel` |

`MANUAL_TRIGGERS`（控制面板上推动工作的操作）：`tickets:setStatus`、`tickets:switchBranch`、`tickets:recheckCleanup`、`sessions:open`、`sessions:openFix`、`sessions:refresh`、`sessions:wake`、`sessions:switchModel`、`sessions:closeIdle`、`activity:dismiss`、`pty:kill`、`handoffs:run`、`features:summaryRun`、`features:openSession`、`epics:openSession`、`butler:openSession`、`jobs:runNightly`、`ci:resend`、`followups:setStatus`、`lessons:run`、`availability:act`。

`inbox:answer`、`inbox:dismiss` 在 `COUNTED_ELSEWHERE` 里：它们已经记成 `needs_you_answer`，不再算一次手动触发（不重复计数）。`sessions:dismissLimit`（关掉撞限提示）是整理，不算。手动触发能看出对象的带上：`sessions:refresh` / `sessions:wake` / `sessions:switchModel` / `activity:dismiss` / `pty:kill` 的第一个参数是 session，`tickets:setStatus` / `tickets:recheckCleanup` / `handoffs:run` 的是 ticket，`sessions:open` 读请求里的 `ticketKey`（`recordInvoke`）。

不算的：只读的（`*:list`、`*:view`、`*:get`、`pr:open`……）、配置和整理（设置、隐私、术语、检查、准入策略、复盘的采纳 / 拒绝、导入导出、建 ticket / feature / epic、归档）——这些是"搭环境"，不是推动一次工作。`ipc.test` 风格的测试列出 `IPC` 的每一个值，要求它要么在 `MANUAL_TRIGGERS` 里，要么在 `NOT_TRIGGERS` 里：新加的通道没归类测试就失败，不会悄悄漏掉。

"需要你"的终端回答不重复记：用户在终端里回答，是一次 `terminal_input`（`answered` 标上它答的是什么），不再另记 `needs_you_answer`。

**接线（index.ts）。** `Metrics` 和 `MetricsRepo` 在 `UsageRepo` 旁边建，同时 `ensureMetricsSince`（内部设置 `metricsSince`，第一次启动时写成当时）。`TerminalInputMeter.promptSubmitted` 在 `pty.markSubmitted` 之前调；"Butler 在递"= `pty.autoInputInFlight(term) || refresher.isRefreshing(head)`。`register.ts` 新加两个可选依赖：`terminalKeys(termId, data)`（`pty:write` 里）和 `onInvoked(channel, args)`（`handle()` 包装里，调用成功之后，出错吞掉）。

## 3. 等人时间

新表 `metrics_wait_spans`：`id, session_id, ticket_key, kind ('human'|'idle'), category, source, started_at, ended_at, last_seen_at`。

`WaitTracker.sync()` 在这些时候调：每次活动变化（index.ts 的 activity notify，和 needs-you 的 update 同一处）、needs-you 判断出需要你、来了一条 ask_user（分类出来后再调一次）、用户在终端里按下对话框的键之前（权限确认常常在下一次活动 tick 之前就答掉了；按完 1.5 秒后再调一次关段），以及每 30 秒一次（`TOUCH_MS`，状态没变也要更新 `last_seen_at`）。它对每个开着终端的 Butler head（复盘分析 session 除外）算出此刻的状态：

- **在等人（human）**，按优先级：
  1. 终端停在权限确认上 → `category: permission`，`source: permission_prompt`
  2. 活动是 `approval` 而且有工具在跑（AskUserQuestion / ExitPlanMode）→ `choice`，`source: question_tool`
  3. 停着等输入、没在干活，有未决的 ask_user → 这条的类别（第 4 节），`source: ask_user`
  4. 停着等输入、没在干活，被判断成需要你 → 判断给的类别，`source: needs_you`
- **空闲（idle）**：停着等输入，但不在等人。
- **不算**：在干活（有没答的 ask_user 也不算，比如总控挂着待办接着干活）、休眠、终端关了。

状态变了就关掉旧段（`ended_at = now`）、开新段；没变就更新 `last_seen_at`。启动时没关的段按 `last_seen_at` 关（Butler 退出期间不算）。电脑睡眠也不算：`powerMonitor` 的 suspend 关掉所有段；两次 sync 隔了 90 秒以上（`GAP_MS`，睡眠没收到 suspend、主进程卡住）的段在最后看到的时间关掉，醒来那次 sync 重新开。「效果」页上的"等人时间"只算 `human`；`idle` 另列，供参考。

## 4. 打断原因（7.4 的统计部分）

类别：`permission`（权限确认）/ `choice`（选择题）/ `missing_info`（缺信息）/ `question`（真问题）/ `stuck`（卡住）。

每次打断记一条 `interrupt` 事件（`data: {category, source}`），dedupe 保证一次打断只记一次：

| 来源 | 什么时候记 | 类别怎么定 | dedupe |
|---|---|---|---|
| 权限确认 | WaitTracker 开了一个 permission 段 | 确定：`permission` | `interrupt:span:<spanId>` |
| AskUserQuestion / ExitPlanMode | 开了一个 question_tool 段 | 确定：`choice` | `interrupt:span:<spanId>` |
| ask_user | `InboxService.ask` 之后 | 有两个以上选项 → `choice`（确定）；否则走路由（`task: "needs_you"`，label `interrupt classify`）判断，失败记 `question` | `interrupt:ask:<itemId>` |
| 需要你 | needs-you 判断说需要你 | 同一次判断（`needs_you` 的 schema 加一个 `category` 字段，不多调一次模型）；不认识的值记 `question` | `interrupt:needs_you:<sessionId>:<replyId>` |
| 卡住 | `ActivityMonitor` 的 `onStuck`（newly_stuck，每次卡住只调一次） | 确定：`stuck` | 不需要（调用本身只有一次） |

- 有未决 ask_user 的 session 被 needs-you 判断成需要你时**不另记**（「现在」页也是这样去重的）。
- 类别也写回等待段（`category`），所以「效果」页能给出"每类打断占多少次、占多少等人时间"。
- 白名单、默认选项（7.4 的规则部分）是 J 的，H 不做；J 自动放行时记 `interrupt_auto_resolved`。

## 5. 汇总：`metrics_daily`

长表：`day TEXT（本地日期 YYYY-MM-DD）, group_kind TEXT, group_key TEXT, butler INTEGER, metric TEXT, n INTEGER, total REAL`，主键是前五列。

- `group_kind`：`all`（`group_key = ''`）/ `repo`（slug）/ `product`（C 的 `lesson_products.name`，一个仓库属于几个产品就各算一行）/ `risk`（G 的等级，或者 `unrated`）。
- `butler`：PR 类指标是"这个 PR 是不是 Butler 做的"（第 6 节）；事件类指标是"事件所在的 session 是不是 Butler 开的"（`origin = 'butler'`）。
- 每个指标一行，`n` 是样本数，`total` 是总和，平均 = total / n。

| metric | 归到哪天 | n | total |
|---|---|---|---|
| `pr_merged` | 合并日 | 1 | 1 |
| `cycle_open_ms` | 合并日 | 1 | 合并 − 开 PR |
| `cycle_ticket_ms` | 合并日 | 1 | 合并 − ticket 第一个 session 的创建时间 |
| `comments_human` / `comments_copilot` / `comments_avoidable` / `comments_auto_handled` | 合并日 | 1 | 条数 |
| `interventions` | 合并日 | 1 | 归到这个 PR 的人介入次数 |
| `wait_human_ms` | 合并日 | 1 | 归到这个 PR 的等人时间 |
| `cost_weighted` / `cost_usd` | 合并日 | 1 | 归到这个 PR 的花费；`cost_usd_partial` 记有没算出价格的行 |
| `cost_model:<model>` / `cost_task:<task>` | 合并日 | 1 | 归到这个 PR 的加权 token（`all` 组） |
| `spend_model:<model>` / `spend_task:<task>` | 用量那天 | 行数 | 全部用量的加权 token（`all` 组），不分给 PR：后台的 headless 任务（handoff、需要你判断、打断分类、复盘）没有 session，只在这里看得到；没有 session 的算 Butler 的 |
| `ci_failures` / `reopens` / `reverts` | 合并日 | 1 | 次数 |
| `ticket_done` / `ticket_cost_weighted` / `ticket_cost_usd` | ticket 最后一个 PR 合并那天 | 1 | 整个 ticket 的花费 |
| `event:<kind>` | 事件那天 | 次数 | 次数 |
| `interrupt:<category>` | 事件那天 | 次数 | 次数 |
| `wait_human:<category>` / `wait_idle` | 段开始那天 | 段数 | 毫秒 |

**Butler 的还是别的**：有 session 的按 session 的 `origin`；没有 session 的事件（`manual_merge`、按 ticket 的手动触发）按 PR 的 `butler_made`，没有 PR 的看 ticket 有没有 Butler 的 session。

**归到 PR**：session 的 `git_branch` 等于 PR 的 head 分支，这个 session 的花费、介入、等待都归这个 PR；ticket 里别的 session 的平均分给这个 ticket 的 PR。只算 PR 合并之前发生的。

**重算**：`MetricsRollup.run()` 在一个事务里删掉窗口内（最近 400 天，从那天的本地零点算）的行，再从源表全部重算，窗口之前的行删掉——幂等，不怕重复跑、不怕源表晚到。启动后一分钟跑一次，之后每小时一次；界面打开「效果」页、控制工具查询时如果上次超过 10 分钟也跑一次。

## 6. Butler 做的 PR

`ticket_prs` 加一列 `butler_made INTEGER`（null = 还没判断），rollup 时写。满足任一就是 1：

- `branch_owners` 里这个 (ticket, 仓库, head 分支) 的推送者是 Butler 开的 session；
- 来源是 `merge_gate`，占位的 session 是 Butler 开的；
- 这个 ticket 有 Butler 开的 session，`git_branch` 是这个 PR 的 head 分支。

其余（链接到 ticket、但不是 Butler session 推的 PR）是 0，单独算一组，「效果」页上是"其他 PR"。

## 7. 返工

- **CI 失败**：`pr_stage_events` 里 `ci` 事件 `result = failing` 的条数。
- **重开**：`pr_reopened` 事件，`MetricsGhJob` 读 gh 的 issue events 记（第 0 节）。
- **合并后被 revert**：`MetricsGhJob`（第 8 节）每天对每个有 ticket PR 的仓库跑一次只读的 `gh pr list --state merged --search "Revert in:title"`，标题是 `Revert "<原标题>"` 或正文有 `Reverts <owner/repo>#<N>` 的，对上 `ticket_prs` 里已合并的 PR，记 `pr_reverted`（dedupe `revert:<prId>`）。

## 8. 基线

- `metricsSince`（内部设置，不可编辑，和 `skillTrackingSince` 一样）：第一次跑到这个版本的时间。
- **基线截止点** = 最早的 Butler session 的创建时间（没有就用 `metricsSince`）：基线是"Butler 之前"。
- `MetricsGhJob`（`JOB_METRICS_GH`，每天一次，和 PR 回填一样同时最多 2 个 gh）对每个已知仓库（ticket 仓库和复盘仓库的 slug）只读地 `gh pr list --author @me --state merged --search "merged:<截止日"`，最多取截止点前 180 天、每个仓库 100 个，跳过 `ticket_prs` 里已有的；每个 PR 再 `gh pr view` 读开 PR 时间、合并时间、第一个 commit 的时间、评论和 review（按 `reviewerKind` 分 human / copilot）。写进 `metrics_baseline_prs`，已有的不重读。
- 基线只有周期和评论（花费、人介入那时没记），界面上显示"—"。基线的"ticket 开始 → 合并"用第一个 commit 的时间近似，页面上注明。

## 9. 「效果」页

侧栏新加一项「效果」（Effect），在「进度」下面。和 B 的进度页分开。

- **顶部四张卡**：最近 30 天 Butler PR 的平均周期（开 PR → 合并；下面小字 ticket 开始 → 合并）、平均评论数（人 / Copilot / 可避免）、平均人介入次数、平均花费（加权 token，有价格时带美元）。每张卡和基线比：差多少、百分比。
- **趋势**：按周（最近 12 周）/ 按月（最近 12 个月）切换，周期、评论、介入、花费四条折线（SVG，没有新依赖）。
- **打断原因**：五类各占多少次、占多少等人时间（横向条），加上自动放行的（J 记了才有）。
- **人介入构成**：按 kind / mode 的次数。
- **分组**：Butler PR / 其他 PR；按仓库、按产品、按风险等级（"未分级"）的表。
- **花费构成**：按模型、按任务类型。
- **返工**：CI 失败、重开、revert 的次数和每 PR 平均。

## 10. 控制工具 `metrics_overview`

只读，参数 `days`（默认 30，1–365）。返回和「效果」页同一份 `MetricsOverview`（JSON），总控能回答"过去 30 天 Butler PR 平均周期、评论、介入、成本，和 Butler 之前比"。接线和 `progress_overview` 一样（`control.ts`、`butler-control.ts`、`sessions-server.ts`、`mcp-config.ts` 的只读列表、session guide）。

## 11. 跨平台

- 日期按本地时区切天（`Date` 的本地方法），Windows、macOS 一样。
- gh 走现有的 `runGh` / `repoEnv`，不拼 shell 字符串。
- 只用 SQLite 和 Node 自带的东西，没有新依赖。

## 12. 测试

- `metrics/events.test.ts`：recordEvent 写库、dedupe、坏 kind、写库失败不抛错。
- `metrics/interventions.test.ts`：每一个采集点各一条（prompt / Butler 递的不算 / dialog / interrupt / 2 秒去重 / 卡片回答 / 不用了 / manual_merge / agent_merge / 占位未释放先不判断 / manual_trigger），外加"每个 IPC 通道都归类了"。
- `metrics/wait-tracker.test.ts`：human / idle / 休眠不算 / 启动时补关 / 类别优先级。
- `metrics/interrupts.test.ts`：五类各自的来源、ask_user 选项、模型失败退回 question、有 ask_user 时 needs-you 不另记。
- `metrics/rollup.test.ts`、`metrics/pr-metrics.test.ts`：周期、评论、花费分摊、返工、Butler 标记、分组（风险表不存在 / 存在）。
- `metrics/baseline.test.ts`：gh 输出解析、截止点、跳过 ticket PR、revert 匹配。
- `metrics/overview.test.ts`：30 天 vs 基线、周 / 月趋势、打断占比。
- e2e `effect.spec.ts`：打开「效果」页，看到四张卡和打断原因一块。

## 13. 拆 PR

1. `recordEvent` + 表 + 人介入采集 + 等人时间 + 打断原因 + Butler 标记 + rollup（先合，别的 workstream 能接）。
2. 返工（revert、重开，都在 `MetricsGhJob` 里读 gh）、基线回填、`metrics_overview`、「效果」页、e2e。
