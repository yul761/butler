# Workstream H 实现计划：度量与「效果」页

设计：`docs/superpowers/specs/2026-11-17-ws-h-metrics-design.md`。每一步先写失败的测试，再实现，跑 `pnpm typecheck && pnpm lint && pnpm test`。

## PR 1：recordEvent、表、人介入采集、等人时间、打断原因、rollup

1. **迁移**（追加一条）：`metrics_events`、`metrics_wait_spans`、`metrics_daily`、`metrics_baseline_prs`、`ticket_prs.shipherd_made`。`settings-repo` 加内部设置 `metricsSince`。
2. **`db/metrics-repo.ts`**：事件写入（dedupe）、按时间读；等待段的开 / 更新 / 关 / 启动补关；daily 的整窗替换和查询。测试：`metrics-repo.test.ts`。
3. **`metrics/events.ts`**：`METRIC_KINDS` 登记、`MetricRefs`、`Metrics.recordEvent`（不抛错、kind 校验、data 只收标量）。测试：`events.test.ts`。
4. **`metrics/interventions.ts`**：
   - `TerminalInputMeter`：`promptSubmitted(term)`（在 `markSubmitted` 之前调）、`keys(term, data)`（pty:write），2 秒去重，`answered` 标记。
   - `MANUAL_TRIGGERS` / `NOT_TRIGGERS` 和 `triggerOf(channel)`；`register.ts` 的 `handle()` 成功后调 `d.onTrigger?.(channel)`。
   - `classifyMerges(prs, holds)`：manual / agent / 先不判断。
   - 测试：`interventions.test.ts`（每个采集点一条 + IPC 全归类）。
5. **InboxService**：可选依赖 `onEvent`：`answer` 记 `needs_you_answer{via: card}`，`dismiss` 记 `{via: dismiss}`，`ask` 之后交给打断分类。测试补在 `inbox-service.test.ts`。
6. **needs-you**：schema 加 `category`（string，归一化成五类），`NeedsYouVerdict.category`，`NeedsYouTracker` 可选 `onNeedsYou(sessionId, replyId, category)`。测试补在 `needs-you.test.ts`。
7. **`metrics/interrupts.ts`**：`normalizeCategory`、`askCategory`（选项 → choice，否则路由判断，失败 question）、`InterruptRecorder`（ask / needs-you / stuck / 等待段）。测试：`interrupts.test.ts`。
8. **`metrics/wait-tracker.ts`**：`WaitTracker.sync(now)`、`recover()`。测试：`wait-tracker.test.ts`。
9. ~~PrWatcher：closed → open~~ 改了：watcher 不再轮询关闭的 PR，看不到重开。重开挪到 PR 2 的 `MetricsGhJob`（读 issue events），见设计第 0、7 节。
10. **`metrics/pr-metrics.ts`、`metrics/rollup.ts`**：Shipherd 标记、每 PR 的指标、归属、分组（repo / product / risk）、事件和等待段汇总、整窗重算。测试：`pr-metrics.test.ts`、`rollup.test.ts`。
11. **index.ts 接线**：Metrics、TerminalInputMeter（hook、pty:write）、WaitTracker（activity notify、启动补关）、InterruptRecorder（onStuck、needs-you、inbox）、rollup 定时（启动后 1 分钟、每小时）。
12. `pnpm e2e`（动了 IPC、session、hook 路径）。自我 review（opus 子代理），开 PR 1。

## PR 2：返工 revert、基线、overview、「效果」页

13. **`metrics/gh-job.ts`**：`JOB_METRICS_GH`；revert 扫描、基线回填（`metrics_baseline_prs`），解析函数单测（`gh-job.test.ts`）。每天一次，同时最多 2 个 gh。
14. **`metrics/overview.ts`**：从 `metrics_daily` 和基线表算 `MetricsOverview`（30 天、周 / 月趋势、打断占比、分组、花费构成、返工）。测试：`overview.test.ts`。
15. **IPC `metrics:view`**、preload、`shared/metrics.ts` 类型。
16. **控制工具 `metrics_overview`**：`control.ts`、`shipherd-control.ts`、`sessions-server.ts`、`mcp-config.ts`、session guide、`strings.ts` 的巡检提示。测试补在现有的控制工具测试里。
17. **「效果」页**：`EffectPage.tsx`、侧栏、路由、`strings.ts` / `strings-en.ts`。
18. **e2e `effect.spec.ts`**：打开页面，看到卡片和打断原因。
19. 文档：`docs/configuration.md` / `.zh-CN.md`（「效果」页一节、`metricsSince` 不可编辑不用写进设置表）。
20. `pnpm e2e`、自我 review、开 PR 2。
