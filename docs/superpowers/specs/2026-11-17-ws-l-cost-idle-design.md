# 工作流 L：成本熔断与空闲时段调度（设计 addendum）

总设计：`2026-11-17-butler-3-design.md`。本文只写 L 自己的决定；契约（4.1 路由、4.2 三层作用域、4.7 事件、4.8 外部动作、4.9 通用规则）按总设计。

范围：源计划 7.10（成本熔断）、7.11（空闲与离线时段调度），以及它们引用的第六部分软阈值配合。

## 0. 核实过的现状

| 项 | 现状 | 用法 |
|---|---|---|
| 计量 | `usage/usage-scanner.ts` 每 30 秒增量读 transcript，写 `session_usage`；headless 调用由 `recordHeadlessUsage` 写，`session_id` 为空，**没有 ticket 归属** | 熔断按 session 链、按 ticket 汇总；headless 行加 `ticket_key` 列（新迁移） |
| 花费权重 | `USAGE_WEIGHTS`（输入 1、缓存写 1.25 / 2、缓存读 0.1、输出 5） | 上限单位为 tokens 时按加权 token 算 |
| 金额 | 有 `cost_usd` 的行直接用；没有的按 A 的注册表单价折算（`spend.ts`） | 上限单位为 usd 时同样算法；有行估不出价格时标「部分」 |
| 配额与阈值 | A：`routingQuotas`、`routingThresholds`（默认 70,90）、`summarizeSpend` 给每个配额 ok / soft / hard | 后台任务的「额度紧张」「额度充裕」都看这个；上限的提醒线也复用第一个阈值 |
| 降档 | 交互 session：`SessionModelSwitcher.switch`（结束终端，`--resume --model 下一档`）；headless：A 的 `planTask`，soft 时 fallback 策略的任务降一档 | 熔断复用这两条，不另写降档逻辑 |
| 空闲信号 | `powerMonitor.getSystemIdleTime()`（Butler 已用于夜间任务的「用户在用」判断，阈值 120 秒）；`getSystemIdleState` 能报 `locked`；`lock-screen` / `unlock-screen` / `suspend` / `resume` 事件。这几样 Electron 在 macOS（CGEventSource / 会话锁屏通知）和 Windows（GetLastInputInfo / WTS 会话通知）上都有实现。`user-did-resign-active` 只有 macOS | 见第 2 节 |
| 防休眠 | `KeepAwake`：只在内存里，开着时阻止显示器休眠 | 不是「人在不在」的信号，不当空闲判断；它只保证机器醒着，空闲时段才跑得起来（记在文档里） |
| 活动监控 | `ActivityMonitor` 看的是 Claude session 在干什么，不是人 | 不当空闲判断；用来判断熔断暂停后 session 还在不在跑 |
| 休眠 | M：`Hibernator`，`isHibernated`、`wake` | 休眠的 session 不算活跃；后台任务不能叫醒它（第 3.4 节） |
| 现有后台任务 | 复盘分析队列 `LessonRunner`：队列在库里，重启时 running 回 queued；`origin` 有 merged / daily / backfill | 迁到调度器（第 3.3 节） |
| H 的 `recordEvent` | 不在 main 上 | 留接入点 `CostEvents.onEvent` / `BackgroundScheduler.onEvent`（第 5 节） |
| W 的 #40 内存准入 | 不在 main 上；分支里是 `MemoryAdmission.admit(what) → { ok, release } \| { ok: false, reason }` | 调度器的 `SessionAdmission` 按同样形状定义，W 合并后直接把它的实例接进来 |
| 4.8 外部动作 | 熔断和调度都不往外写（不碰 GitHub、tracker） | 不需要开关 |
| 4.1 路由 | 熔断、调度本身不调模型 | 不新增任务 id |

## 1. 默认值等于 2.1.0 的行为

- 花费上限默认都不设：不熔断。
- 后台时段默认「随时」，不设插队、不让路：复盘队列和现在一样跑。
- 额度相关的暂停只在配了 A 的配额时才可能发生（2.1.0 没有配额）。

## 2. 空闲检测（双平台）

`background/idle.ts`：

```ts
interface IdleSignal {
  idleSeconds(): number;      // 系统多久没有键鼠输入
  locked(): boolean;          // 屏幕锁着
  subscribe(fn): () => void;  // 锁屏/解锁/休眠/唤醒/macOS 切走 时触发
}
```

- 生产实现 `electronIdleSignal(powerMonitor, platform)`：`getSystemIdleTime()`、`getSystemIdleState(1) === "locked"`；监听 `lock-screen`、`unlock-screen`、`suspend`、`resume`（两个平台都有），macOS 再加 `user-did-resign-active` / `user-did-become-active`（快速切换用户）。`suspend` 到 `resume` 之间算离开；`resume` 后按系统空闲时间重新判断。
- 「用户空闲」= 锁屏，或系统空闲时间 ≥ `bgIdleMinutes`（默认 10 分钟）。「用户回来」= 解锁、唤醒，或空闲时间回到阈值以下。
- 没有「空闲满 N 分钟」这种事件，所以调度器每 30 秒看一次（只在有任务等着空闲时开定时器）。
- 测试用 `fakeIdle`（可注入空闲秒数和锁屏状态）和注入时钟，不依赖真机。

## 3. 后台调度器

### 3.1 登记表（`src/shared/background.ts`）

每种后台任务一条：

| kind | 谁的 | 优先级 | 可在空闲时段跑 | 可打断 | 可续跑 | 开 session | 路由任务 |
|---|---|---|---|---|---|---|---|
| `lesson_analyze` | C（已有，迁移） | normal | 是 | 是 | 是（回队列，重跑这一项） | 否 | `lesson_analyze` |
| `lesson_backfill` | C（已有，迁移） | low | 是 | 是 | 是 | 否 | `lesson_analyze` |
| `lesson_admission` | D | normal | 是 | 是 | 是 | 否 | `lesson_classify` |
| `backtest` | F | low | 是 | 是 | 是 | 否 | `backtest_judge` |
| `pre_review` | G | normal | 是 | 是 | 是 | 否 | `pre_review` |
| `repo_scan` | 向导 / 仓库扫描 | low | 是 | 是 | 是 | 否 | `repo_scan_infer` |
| `intake` | N | high | 否 | 否 | 是 | 是 | `intake_classify` |

D、F、G、N 的条目先登记好（它们的任务以后直接用），路由任务 id 取自 `TASKS`，没有的留 null。登记表里的值是默认值，用户可以按种类改优先级和时段（`bgKinds`）。

「优先级」三档：high（不受时段限制，只在额度 hard 和熔断时让路）、normal、low。

### 3.2 闸门 `BackgroundScheduler.gate(kind, { ticketKey? })`

按顺序看，第一个不放行的就是原因：

1. `manual`：用户在设置页把这一种停了。
2. `cost`：这个 ticket 被熔断暂停了后台任务（第 4 节）。
3. `quota`：额度紧张（第 3.5 节）。
4. `window`：不在它的时段里（`user_active` 或 `outside_hours`）。额度充裕时（`bgPlentifulPercent`，见 3.5）跳过这一条。

返回 `{ run: true }` 或 `{ run: false, reason, until }`（until 能算出来时给，比如时段的开始时间）。状态一变（空闲变化、设置改了、花费变了、到了时段边界）`subscribe` 的回调都会被调；正在跑的可打断任务这时会收到 `yield`。

时段 `bgWindow`：`anytime`（默认）、`idle`（只在空闲时跑）、`hours`（只在 `bgHours` 这些小时内跑，格式 `22:00-07:00`，可以跨午夜，可以写多段用逗号分开）、`idle_or_hours`（空闲或在这些小时内）。

让路的方式 `bgYield`：`finish`（默认：跑着的跑完，不取新的）或 `interrupt`（可打断的马上停，放回队列）。「不丢进度」：停下的项回到 queued，有检查点的从检查点接着跑（3.6）；不可打断的种类永远是跑完再停。

### 3.3 复盘队列迁移

`LessonRunner` 加一个可选依赖 `scheduler`：取队列前问 `gate`，origin 为 backfill 的是 `lesson_backfill`，其余是 `lesson_analyze`；`take` 只取放行了的 origin。订阅调度器变化重新 pump。收到 `yield` 且 `bgYield = interrupt` 时中止正在跑的项，运行记为 aborted（原因 `yielded`），队列项回到 queued，不算失败、不计次数。原来的闸门（限额、手动暂停）不变。

### 3.4 和休眠、内存准入的关系

- 休眠的 session 不算活跃：空闲判断只看人；调度器给任务的 `ctx.sessionAwake(id)` 对休眠的 session 返回 false，任务要往某个 session 里递东西时先看它，休眠着就延后（`defer`），不调 `wake`。
- 开 session 的种类（`opensSession`）在开之前走 `ctx.admitSession(what)`：接的是 W 的 `MemoryAdmission`（`SessionAdmission` 接口和它同形）；没接时放行。不放行时延后，原因 `memory`。

### 3.5 和 A 的软阈值配合（额度紧张）

某种任务的额度级别 = 针对它的路由任务所在档位（或那一档里的模型）的配额里最高的级别（ok / soft / hard）。没配额时总是 ok。

`bgQuotaOrder`：

- `pause_first`（默认）：soft 时先停 low 的后台任务（normal 照常跑，由路由器按 A 的规则降档）；hard 时 low、normal 都停，只剩 high。
- `downgrade_first`：soft 时都不停，全交给路由器降档；hard 时停 low。

「额度充裕」`bgPlentifulPercent`（默认空 = 不用）：配了配额并且每个配额都用了不到这个百分比时，时段限制不算（空闲 / 小时），后台任务随时跑。

### 3.6 通用后台队列（给 D、F、G、N）

新表 `background_jobs`（kind、payload、state queued/running/done/failed/cancelled、checkpoint、priority、ticket_key、not_before、attempts、error、时间）。`BackgroundQueue.register(kind, handler)`；`enqueue(kind, payload, { ticketKey, notBefore })`。handler 拿到 `{ payload, checkpoint, signal, save(checkpoint), sessionAwake, admitSession }`，返回 `done` / `{ failed }` / `{ defer, notBefore }`。启动时 running 回到 queued，checkpoint 留着：重启、让路都不丢进度。每种默认同时跑 1 个。

## 4. 成本熔断

### 4.1 上限配置（契约 4.2 三层）

新表 `cost_caps`（scope_kind、product_id、repo_slug、overrides JSON），经 `LayeredResolver<CostPolicy>` 解析：

| 字段 | 默认 | 说明 |
|---|---|---|
| `unit` | `usd` | `usd` 或 `tokens`（按花费权重加权） |
| `sessionCap` | null（不限） | 一个 session（含 /clear 换出来的整条链）一共能花多少 |
| `ticketCap` | null（不限） | 一个 ticket 下所有 session 加上归到它名下的后台调用一共能花多少 |
| `action` | `downgrade_then_pause` | 或 `pause` |
| `pauseScope` | `session` | 或 `background`（只停它的后台任务，交互 session 不动） |
| `graceAfterDowngradePercent` | 20 | 降档以后再超出上限这么多才暂停 |
| `raisePercent` | 50 | 「继续并提高上限」一次加多少 |

session 的作用域按它所在 ticket 的仓库解析；一个 ticket 有多个仓库时每个字段取最严的（上限取最小、动作取 pause、范围取 session）。feature、epic、Butler 总控的 session 按全局。

### 4.2 什么时候算

- 每次用量扫描写完（`UsageScanner` 新增 `onScanned`）、每次记 headless 用量之后，看一遍有变化的 session 和 ticket。
- session 花费 = 链上所有 id 的 `session_usage`（含子代理）；ticket 花费 = 这个 ticket 的所有 session 链 + `ticket_key` 是它的 headless 行。
- headless 的 ticket 归属：`ExecOptions` 加 `ticketKey`，handoff、换新、「需要你」判断、卡住判断这些按 ticket 跑的调用带上；`UsageReport` 带出来写进 `session_usage.ticket_key`。

### 4.3 状态和动作

每个对象（session 按链的根 id、ticket 按 key）一行 `cost_breaker`：state、生效上限（用户提高过就是提高后的）、降档前后模型、各个时间。

- 用到上限的 `routingThresholds` 第一个值（默认 70%）：`warn`，「现在」页提醒，不动作。
- 用到上限：
  - `downgrade_then_pause` 且还有下一档：
    - session：`SessionModelSwitcher.switch`（同 A 的「换下一档继续」），换好后经 DeliveryGuard 递一句「接着做」；状态 `downgraded`。
    - ticket：它的 headless 调用规划时按 soft 算（A 的路由器让能降的降一档），交互 session 也逐个降档。
  - 没有下一档、动作是 `pause`、或降档后用到上限 ×（1 + 宽限）：`paused`。
- 暂停 session：正在干活就发 Esc 打断这一轮；DeliveryGuard 多一个阻挡原因 `cost_paused`，Butler 不再往里自动输入；暂停后 90 秒还有新用量、并且用户没在这个终端里打过字，结束终端（可以 `--resume` 接上，和休眠一样不丢对话）。用户自己往暂停的终端里打字算自己接手，不再结束，提醒留着。
- 暂停后台：这个 ticket 的 headless 调用直接拒绝（失败原因 `cost_paused`，调用方当作延后），调度器对这个 ticket 的任务给 `cost`。
- 「继续并提高上限」（IPC `cost:resume`）：新上限 = max(上限, 已花) + 上限 × raisePercent%；清掉暂停，降过档的不自动升回（用户可以在 session 上手动换）；session 递一句「继续」。
- 卡住判断不动；熔断是并列的一道（死循环烧 token 的测试见计划）。

### 4.4 提示

- 「现在」页：`NowNotice` 加 `cost`：对象、标题、状态、已花、上限、单位、降档前后模型，按钮「继续并提高上限」、「打开」。
- session 行上（和撞限提示同一处）显示同样的条。
- 托盘提示文字：有暂停的时候加一句。
- 文案中英两份。

## 5. 日志和事件

熔断的 warn / downgrade / pause / stop / resume / raise 和调度器的 yield / resume 都写日志、写 `cost_events`（熔断）表；并调可选的 `onEvent(kind, refs)`——H 的 `recordEvent` 合并以后在 index.ts 里接上即可。

## 6. 设置

| 键 | 默认 | 位置 |
|---|---|---|
| `bgWindow` | `anytime` | 设置 →「花费与后台」 |
| `bgHours` | `22:00-07:00` | 同上 |
| `bgIdleMinutes` | `10` | 同上 |
| `bgYield` | `finish` | 同上 |
| `bgQuotaOrder` | `pause_first` | 同上 |
| `bgPlentifulPercent` | 空 | 同上 |
| `bgKinds` | 空 | 同上：每种任务的优先级、时段、停用 |
| 花费上限（`cost_caps` 表） | 都不设 | 同上，带作用域选择（全局 / 产品 / 仓库） |

额度阈值仍是 A 的 `routingThresholds`，这里显示并链到「模型路由」页。

## 7. 给其他工作流的接口

- `BackgroundScheduler.gate(kind, ctx)`、`subscribe`、`onYield`：自己有队列的任务（像复盘）用。
- `BackgroundQueue.register / enqueue`：没有自己队列的新任务用。
- `CostBreaker.allowBackground(ticketKey)`、`state(subject)`：N 开工前看这个 ticket 是不是被熔断了。
- `SessionAdmission`：W 的 #40 接进来。

## 8. 决定记录

1. 「额度紧张」默认先停低优先级（`pause_first`），因为它只在配了配额时才生效，不影响 2.1.0 的默认行为；A 原来的降档规则不变。
2. 防休眠不当空闲信号（它表达的是「让机器醒着」，不是「人走了」）；Butler 终端里的键入已经包含在系统空闲时间里，不单独看。
3. 熔断暂停 session 先 Esc，不先结束终端：正在写的这一轮不被硬切；只有暂停后还在花钱、用户也没接手时才结束终端。
4. 上限默认单位 usd：用户最直观；估不出价格的行在提示里标「部分」，这种情况推荐用 tokens。
5. headless 的降档不改 A 的路由器：熔断的 ticket 在规划时按 soft 算，让 A 现有的降档规则生效（新增 `PlanContext.minLevel`）。
6. 复盘的一项分析被打断后从头重跑这一项（一次 headless 调用没有中间状态可存），队列进度不丢；通用队列支持检查点。
7. 一个 PR：调度器和熔断共用设置页、通知、事件接入点，拆开反而要重复接线。
8. 「现有通知」= 「现在」页提醒、托盘提示的第二行、session 行上的条。应用里没有系统通知；要发系统 / 手机推送得走 B 的 `externalPushNotification` 开关（契约 4.8），这次不加。L 的动作全在本机（终端里的 Esc 和「接着做」、本机提醒），没有对外动作，不接 4.8 的开关。
9. ticket 的标题按 `KEY 标题` 显示；session 用它的标题，没有标题时用 id。
10. H 的 `recordEvent`：`CostBreaker` 的 `onEvent` 现在在 index.ts 里是空的，H 合并后接上。
11. W 的 #40 已合：`index.ts` 把队列的 `admission` 接到 `MemoryAdmission`（它在后台队列 `start()` 之前建好），`ctx.admitSession` 不放行时任务延后、原因 `memory`；`queue.test.ts` 用真的 `MemoryAdmission` 测了这一条。
12. session 行上的条：先看 session 自己的熔断，再看它的 ticket 的（ticket 只是 `warned` 时不在每一行上提醒，避免一个 ticket 的提醒铺满所有行）。
13. 花费上限这一层的输入：空 = 继承，`none` = 这一层明确不限（`null`），和准入策略的「空 = 继承」一致，只多一个 `none`。
14. 花费上限暂不进导出文件（契约 4.3 没把 L 列为某个部分的提供方）；以后要导出就注册一个 `cost` 部分，读写 `cost_caps`。
15. 设置里改了上限会作废之前「继续并提高上限」的提高（`raised_cap` 清空），以设置为准。
16. （审查后）复盘项的 ticket 被熔断停了后台：这一次记 `aborted`（`cost_paused`），队列项 5 分钟后再试，不立刻放回，免得 pump 一直取同一项空转。
17. （审查后）Butler 自己按的 Esc 走 `PtyManager.interrupt`，不算用户输入；否则熔断会把它当成「用户接手了」，再也不结束还在花钱的终端。
18. （审查后）暂停后结束终端的条件：过了 90 秒、暂停后又花了钱、而且终端此刻还在跑。安静下来的（晚到的用量扫描、重启后重新打开的）不结束。
19. （审查后）策略变了也接着原来的状态走：暂停着的、新上限还是不够就还停着，不会再降一档把暂停冲掉；单位换了时暂停时的花费换成新单位。
20. （审查后）一次检查里 session 和 ticket 同时到上限，同一个 session 只换一档模型。
21. （审查后）session 不管是整个暂停还是只停后台，它所在 ticket 的后台调用都停（文档原来就这么写）；卡住判断和「需要你」判断都不受熔断影响。
22. （审查后）正在检查时又来的检查不丢，看完再来一遍；「接着做」先拿走再递，并发时不会递两次。
23. （审查后）`cost_events` 留 180 天、结束了的 `background_jobs` 留 30 天，启动时清一次。`rootOf` 往回最多走 1000 段，`replaced_by` 成环也会返回。
