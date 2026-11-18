# 工作流 L 实现计划：成本熔断与空闲时段调度

设计：`docs/superpowers/specs/2026-11-17-ws-l-cost-idle-design.md`。每个任务先写测试再实现；每个任务结束跑相关单测，最后跑 `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`。

## Task 1：登记表和设置解析
- `src/shared/background.ts`：`BACKGROUND_KINDS`（第 3.1 节），`BgPriority`、`BgWindow`、`BgYield`、`BgQuotaOrder`、`BgKindOverride`，`BackgroundStatusView`。
- `src/main/background/bg-settings.ts`：解析 `bgWindow`、`bgHours`（多段、跨午夜，`inHours(now)`、`nextStart(now)`）、`bgIdleMinutes`、`bgYield`、`bgQuotaOrder`、`bgPlentifulPercent`、`bgKinds`；非法值报 `BgSettingError`（和 routing-settings 同样的 normalize 写法）。
- 设置键加进 `EDITABLE_SETTINGS`、`SETTING_DEFAULTS`、`settings-values.ts` 校验。
- 测试：解析、默认值、跨午夜时段、非法输入。

## Task 2：空闲信号
- `src/main/background/idle.ts`：`IdleSignal` 接口、`electronIdleSignal(pm, platform)`（两个平台的事件，macOS 额外事件）、`userIdle(signal, minutes)`。
- 测试：用假的 powerMonitor（EventEmitter）验证两个平台订阅的事件、锁屏即空闲、suspend 到 resume 之间算离开。

## Task 3：调度器闸门
- `src/main/background/scheduler.ts`：`BackgroundScheduler`（deps：settings、idle、quota（QuotaView[] + 档位查询）、costBlocked(ticketKey)、now、timers、log、onEvent）。`gate`、`subscribe`、`onYield`、`status()`、`pauseKind/resumeKind`（手动，存 `bgKinds`）。30 秒轮询只在有等待者时开；时段边界定时器。
- 测试：每种时段 × 空闲 / 活跃 / 锁屏；优先级 × soft / hard × 两种顺序；充裕跳过时段；手动停；cost；状态翻转时 yield 只对可打断种类、且只在 `interrupt` 模式发；订阅回调。

## Task 4：通用后台队列
- 迁移：`background_jobs` 表。
- `src/main/db/background-repo.ts`、`src/main/background/queue.ts`：register / enqueue / start（running→queued）/ pump 走 gate / handler ctx（save、sessionAwake、admitSession）/ yield 中止→queued 带检查点 / cancel。
- 测试：重启后从检查点接着跑；用户活跃时让路、空闲时继续；准入拒绝时延后；休眠 session 不叫醒。

## Task 5：复盘队列迁移
- `LessonRunner` 加 `scheduler` 依赖；`LessonsRepo.take(now, origins?)`；yield 时 aborted（原因 `yielded`）→ defer。`LessonRunReason` 加 `yielded`。
- 测试：backfill 在用户活跃时不取、空闲时取；interrupt 模式下中止回队列不算失败；重启后队列还在。

## Task 6：用量归属和花费汇总
- 迁移：`session_usage.ticket_key` 列和索引。
- `UsageRow.ticketKey`；`UsageRepo.totalsFor({ sessionIds, ticketKey })` 返回按模型的 SpendRow（含加权 token）。
- `ExecOptions.ticketKey` → `UsageReport.ticketKey` → `recordHeadlessUsage`；handoff、refresh、needs-you、stuck-judge 带上。
- `spend.ts` 导出 `spendTotal(rows, registry)`（usd、partial、weighted）。
- 测试：汇总、归属。

## Task 7：上限配置（三层）
- 迁移：`cost_caps`、`cost_breaker`、`cost_events` 表。
- `src/shared/cost.ts`：`CostPolicy`、默认、`sanitizeCostOverrides`、视图类型。
- `src/main/cost/cost-policy.ts`：`CostPolicyService`（LayeredResolver，set/clear 层，`forTicket(key)` 多仓库取最严）。
- 测试：三层覆盖、多仓库取最严、非法值丢掉。

## Task 8：熔断器
- `src/main/cost/cost-breaker.ts`：`CostBreaker`（deps：policy、spend 查询、sessions（链、ticket、终端）、switcher、interrupt(termId)、kill、deliver、lastUserInputAt、thresholds、now、onChange、log、onEvent）。`evaluate(changed)`、`resume(subject)`、`allowBackground(ticketKey)`、`sessionPaused(headId)`、`minLevelFor(ticketKey)`、`notices()`、`state()`。状态持久化，重启恢复。
- 测试（验收）：超过上限→降档；仍超→暂停（Esc、阻挡自动输入）；一键继续提高上限；只停后台模式；ticket 上限；暂停后还在花钱且用户没接手→结束终端；用户接手不结束；死循环烧 token（卡住判断说不卡也照样熔断）；重启后状态还在；warn 阈值。

## Task 9：接线
- `headless-exec`：deps 加 `costGate?(opts)`（拒绝→`cost_paused`）；规划时 `minLevel`。`PlanContext.minLevel` 在 `RoutingService.plan` 里和花费级别取高。
- `DeliveryGuard`：`costPaused` → block `cost_paused`。
- `UsageScanner.onScanned`。
- index.ts：IdleSignal、BackgroundScheduler、BackgroundQueue、CostPolicyService、CostBreaker；LessonRunner 接调度器；notices；托盘提示；IPC。
- `NowNotice` 加 `cost`；`buildNotices` 不变，index.ts 拼上 `breaker.notices()`。

## Task 10：IPC 和界面
- IPC：`cost:policy:get/set/clear`、`cost:resume`、`cost:view`、`background:status`、`background:kind`。白名单、preload、api。
- 设置页新 tab「花费与后台」`CostBackgroundSettings.tsx`：作用域选择、上限、动作、范围、宽限、提高比例；时段、小时、空闲分钟、让路方式、额度顺序、充裕百分比、每种任务的优先级 / 时段 / 停用、状态表；额度阈值显示并链到路由页。
- 「现在」页：`cost` 提醒 + 「继续并提高上限」；session 行上同样的条。
- 中英文案。

## Task 11：文档
- `docs/configuration.md`、`.zh-CN.md`：新设置键、花费上限、时段，两份标题结构一致。

## Task 12：e2e
- `e2e/cost-breaker.spec.ts`：fixture 里给一个 session 写超过上限的用量 → 「现在」页出现熔断提醒 → 点「继续并提高上限」→ 提醒消失、上限提高。

## Task 13：验证、审查、PR
- 全部检查；Opus 子代理独立审查；改；report(progress)；PR；CI；report(done)。
