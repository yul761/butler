# 工作流 N 实现计划：自动接活

设计：`docs/superpowers/specs/2026-11-17-ws-n-intake-design.md`。每一步先写测试再写实现，做完跑 `pnpm typecheck && pnpm lint && pnpm test`。

## T1 共享类型和策略默认值
- `src/shared/intake.ts`：`IncomingTicket`、`IntakeSize`、`IntakeRisk`、`IntakeState`、`IntakeItemView`、`IntakeView`、`IntakePolicy`、`INTAKE_POLICY_DEFAULTS`、`INTAKE_POLICY_KEYS`、`sanitizeIntakeOverrides`、`IntakeAction`、`IntakeEffect`。
- 测试：sanitize 丢掉非法值、保留合法值。

## T2 迁移和仓储
- 追加迁移：`intake_items`、`intake_overrides`、`intake_policies`。
- `src/main/db/intake-repo.ts`：upsert、get、list、setState、setClassification、overrides、effect 统计。
- 测试：迁移从上一版升上来；repo 的读写。

## T3 规则分类（纯函数）
- `src/main/intake/rules.ts`：`classifyByRules(ticket, risk policy) → { size, risk, clarify, missing, expectedPaths, reasons, undecided[] }`，`extractPaths`、`clarifyQuestions(missing, lang)`。
- 测试：每条规则各一例；中英关键词；路径提取；判不了的情况。

## T4 模型分类和 tracker 拉取
- `TASK_IDS` 加 `intake_fetch`（low、fallback），路由测试表、任务文案。
- `src/main/intake/model.ts`：`classifyByModel(exec, cwd, ticket, decided)`、`fetchFromTracker(exec, cwd, query, tools)`，zod schema。
- 测试：用假的 ExecRun；失败返回 null；输出校验。

## T5 来源和仓库映射
- `src/main/intake/sources.ts`：`fileSource`、`trackerSource`、`parseRepoMap`、`mapRepo`、`normalizeIncoming`（限长、去重）。
- 测试：文件格式两种、坏文件、映射规则优先级。

## T6 分层策略服务
- `src/main/intake/policy.ts`：`IntakePolicyService`（同 `CostPolicyService`）：`setLayer`、`view`、`layers`、`forSlug`、`anyEnabled`。
- 测试：三层覆盖、`anyEnabled`。

## T7 档位和冲突预判（纯函数 + git）
- `src/main/intake/tier.ts`：`pickTier(size, risk, policy)`。
- `src/main/intake/conflicts.ts`：`pathsOverlap`、`changedPaths(repo, branch, worktree)`、`predictConflicts(expected, running[])`。
- 测试：档位映射各组合；路径重叠（文件、目录前缀、Windows 大小写）；在临时 git 仓库里取改过的文件。

## T8 接活服务
- `src/main/intake/intake-service.ts`：`poll()`、`ingest(tickets)`、`classify(item)`、`decide(item)`、`handler(ctx)`（开工条件）、`act(action)`、`editClassification`、`view()`、`notices()`、`recent()`、`effect(days)`、拆栈、澄清方式、对外动作、提醒（`notifyDecision`）、度量事件。
- 测试（假依赖）：总开关关着什么都不做；小低完整的自动开且档位对；缺验收标准不开只提醒；超过并行上限 defer、名额空出后开；同路径冲突不同时开；允许并行后开；用户改分类有记录；拆栈第二层等第一层；澄清方式三种 + 开关关着退回；tracker 状态开关；花费熔断拦住；内存不放行延后；重拉内容变了重新分类。

## T9 B / J / H 的登记
- `EXTERNAL_ACTIONS` 加两种、设置、默认值、文案、文档；动作测试的数量改成 14。
- `NOTIFY_EVENTS` 加 `intake_decision`，主进程正文、渲染进程标签、默认值、文档。
- `METRIC_KINDS` 加 `intake.*`。
- 新设置写进 `EDITABLE_SETTINGS`、默认值、`normalizeSetting`。

## T10 装配和 IPC
- `index.ts`：建 `IntakeRepo`、`IntakePolicyService`、`IntakeService`，`bgQueue.register("intake", ...)`，定时拉取，session 结束时 `pump`，「现在」页提醒，IPC 处理。
- `ipc.ts`、`register.ts`、`interventions.ts` 归类、`preload`、`api.ts`。

## T11 界面
- 设置页「自动接活」标签（`IntakeSettings.tsx`）。
- 「进度」页「接活队列」（`IntakeQueue.tsx`）。
- 「现在」页 `intake` 提醒 + 「自动接活」记录。
- 「效果」页卡片。
- 中英文案。

## T12 文档
- `docs/configuration.md` 和 `.zh-CN.md` 的「自动接活」一节（标题层级两边一致）。

## T13 e2e
- `e2e/intake.spec.ts`：file 来源；关着时什么都没有；打开后三个 ticket：小低完整 → 自动开、`--model` 对；缺验收标准 → 「现在」页提醒；并行上限 1 → 第三个排队，关掉第一个终端后开起来；改分类 → 「效果」页的卡片计数。

## T14 review 和合并
- Opus 子代理独立 review，处理意见。
- 合并锁、rebase、检查、合并、report done。
