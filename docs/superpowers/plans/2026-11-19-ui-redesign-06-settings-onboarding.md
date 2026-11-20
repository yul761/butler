# UI 重做第 6 层：设置的 4 个 tab、功能页、新用户引导 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设置页重组成「基本 / 功能 / 高级 / 健康检查」四个 tab，做出「功能」页（每个 3.0 功能一行、一个开关），并给首页空状态做 `<FirstRunHome/>`，向导结尾跳到它。

**Architecture:** 「功能」页不新增任何总开关，也不迁移设置：一行是一组现有开关（全局设置键，或全局那一层的策略键）的视图，由 `src/shared/feature-rows.ts` 里的纯函数 `featureRows` 算出状态、`applyFeatureToggle` 算出要写哪些键。仓库、产品层的覆盖只数个数、不改。旧的 8 个设置 tab 和「常规」页的大页面删掉，原来的各组组件原样搬进「高级」tab 的 12 个默认收起的分组里。

**Tech Stack:** Electron、React 18、TypeScript、SQLite（`node:sqlite`）、vitest（node 环境，组件用 `renderToStaticMarkup`）、Playwright e2e。

**Spec:** `docs/superpowers/specs/2026-11-19-ui-redesign-design.md`（§3 约束、§5.3「设置」、§5.5 新用户引导）；索引与共用接口：`docs/superpowers/plans/2026-11-19-ui-redesign-00-index.md`；草图：`.superpowers/brainstorm/1247-1795150005/content/full-mockup.html`（`#homeFresh`、`#p-settings`）。

## Global Constraints

- 3.0 的功能默认全部关闭，这一点不变；Butler 默认不替用户对外做任何事（spec §3）。`src/main/db/settings-defaults-3.test.ts` 必须一直通过，本层不改任何默认值。
- 不新加总开关，也不做迁移：功能页每一行直接对应现有的全局开关；一行对应几个开关时一起开、一起关（spec §5.3）。
- 打开「review 评论自动送回」（`comments.enabled`）不连带打开任何对外动作开关（`external*`，共 14 个）；这一行的一句话说明里写清「不对外发任何东西」（spec §5.3）。
- 仓库或产品另有覆盖设置时，这一行下面注明「N 个仓库另有设置」，可点进「高级」查看（spec §5.3）。
- 界面中英双语：新文案同时进 `src/renderer/src/strings.ts` 和 `strings-en.ts`，`strings.test.ts` 要求两边键、种类、函数参数个数一致，英文里不能有汉字。
- 不留两套并存的设置布局：旧的 `SettingsPage` 8 个 tab、`S.settingsTabs`、`GeneralSettings.tsx`、`section` 的旧分支在本层删掉（见 Task 3）。
- 新开关、新文案的「3.0」标记：功能页每行带「3.0」。
- 项目命令：`pnpm test`（= `vitest run`，只匹配 `src/**/*.test.ts`）、`pnpm typecheck`、`pnpm lint`、`pnpm e2e`（`pree2e` 会先 build）。e2e 里的 ticket 号必须带数字，如 `E2E-7`。
- 向导的步骤不变（`WIZARD_STEPS` 仍是 claude、hooks、tracker、privacy、permissions、done）；`wizard.ts` 不改。理由：tracker、隐私、权限档案三步都可以跳过，砍掉它们要重写 `interrupts.spec.ts` 里的向导用例，收益是零（这三项在设置里本来就有）。如果要把向导砍成只剩 claude 和 hook，那是另一个很小的后续改动。

## Review Focus

按最可能先咬到人的顺序。每一条在对应任务里有测试（括号里是任务号）。

1. **老用户已经打开了部分细项**：「复盘规矩自动整理」一行对应 3 个设置、「少打断」对应 2 个、「内存紧张时让路」对应 2 个，老用户可能只开了其中一部分。这一行必须显示成「部分开（1/3）」，不能显示成关，也不能显示成开；点开关不能默默把没开的也打开。显示成两个按钮「全部打开」「全部关闭」。（Task 1、Task 5）
2. **覆盖设置很多，以及「全局关、某个仓库开着」**：一个用户可能有上百个仓库层覆盖。数覆盖只用一次查询、一次 IPC，不能每个仓库调一次 `*PolicyGet`；全局关着但有仓库自己开着时，这一行要写明「已关，但 N 个仓库自己开着」，不能只显示关。（Task 1、Task 2）
3. **设置读取失败**：`api.settings()` 或覆盖查询失败时，功能页显示错误和「重试」，不画任何开关（不能把读不到的开关画成「关」，用户点一下就等于写入）。（Task 5）
4. **全局那一层写策略不能冲掉同层其他覆盖**：`loopPolicySet` 等是把整层换掉；功能页改 `ci.enabled` 时，同一层已有的 `ci.maxReruns`、`comments.ignorePatterns` 等必须原样保留。（Task 2）
5. **语言切换**：切换语言会整窗重新加载（`LanguagePicker`）。行的文案不能存在状态里；`featureRows` 只返回 id，文案在渲染时从 `S` 取；两种语言每个 id 都有标题和说明，英文里没有汉字。（Task 1、Task 5）

另外在任务里单独有测试、没列进上面的：多键一行写到一半失败（Task 5，`runFeatureWrites`）；「自动接活」打开了但还没选来源（Task 1、Task 5）；深链 `section` 指到收起的分组时要自动展开（Task 4）。

---

## 现有设置 → 新 tab 对照表

「功能」列里的键同时也留在「高级」对应分组里（同一个设置、两个入口；一次只挂载一个 tab，不会互相显示旧值）。`EDITABLE_SETTINGS`（`src/shared/settings.ts`）里的每一个键都在 `SETTING_PLACEMENT`（Task 1）里登记，类型是 `Record<EditableSettingKey, …>`，漏一个就编译不过。

| 现有位置（组件 · 设置） | 新位置 |
|---|---|
| `GeneralSettings`：语言 `language`、`claudePath`、`branchTemplate`、`ticketPattern`、开机启动（`api.autostart`）、`memoryEnabled`（+记忆目录/MCP 状态/statecore 警告）、`refreshThresholdTokens`、「重新运行向导」（`onboardingDone`） | **基本** |
| `GeneralSettings`：`sessionMemoryReserveMb`、`sessionMemoryEstimateMb`、`sessionMaxRunning`、`idleCloseMinutes`、`memoryMonitor`、`backgroundPriority`、`orphanCleanup`、`refreshMemoryMb`、`hibernateEnabled`、`hibernateYouMinutes`、`hibernateCiMinutes`、`hibernateReviewMinutes`、`hibernateIdleMinutes`、`hibernateEndWatchers`、`memoryPressureEnabled`、`memoryPressureFreePercent`、`sharedMcp`、性能提示 | **高级 › Session 与内存**（`sessions`） |
| `ScheduleSettings`：`nightlyTime`、`workingDays`、`butlerPatrolTime`、`handoffPrompt`、`refreshPrompt`、`trackerTools`、`headlessProjectMcp` | 高级 › 定时与 handoff（`schedule`） |
| `RoutingSettings`：`routingQuotas`、`routingThresholds`、`routingPeriodStartDay`、`routingEffort`、`routingMaxConcurrent`、`routingAutoSwitch`、模型登记表 | 高级 › 模型路由（`routing`） |
| `CostBackgroundSettings`：费用熔断三层策略（`cost_caps`）、`bgWindow`、`bgHours`、`bgIdleMinutes`、`bgYield`、`bgQuotaOrder`、`bgPlentifulPercent`、`bgKinds` | 高级 › 花费与后台（`cost`）。熔断没有布尔开关（设了上限就生效、上限为 null 不限），所以不进功能页 |
| `LoopSettings`：`loop_policies` 三层（`comments.*`、`ci.*`）、flaky 名单、效果、评论/CI 用到的对外开关 | 高级 › 评论与 CI（`loop`）；`ci.enabled`、`comments.enabled` 两个全局值同时是功能页两行 |
| `ReviewSettings`：`preReviewEnabled`、`pr_policies` 三层、就绪/证据/风险、用到的对外开关 | 高级 › 预审和就绪（`review`） |
| `StackSettings`（`StacksPanel.tsx`）：`stack_policies` 三层、栈用到的对外开关 | 高级 › 栈（`stacks`）；`autoRebase` 全局值是功能页一行 |
| `IntakeSettings`：`intakeSource`、`intakeTrackerQuery`、`intakeTrackerDir`、`intakeFilePath`、`intakePollMinutes`、`intakeRepoMap`、`intake_policies` 三层 | 高级 › 自动接活（`intake`）；`enabled` 全局值是功能页一行 |
| `InterruptSettings`：`permissionProfiles`、`interruptChoiceRule`、`interruptChoiceDefaults`、`interruptSelfServe`、`notifyFormat`、`notifyEvents`、`notifyDetails`、`notifyQuietHours`、权限档案、选择题默认答案 | 高级 › 打断与通知（`interrupts`） |
| `LessonsSettings`：`lessonsAutoAdmit`、`lessonsPrinciples`、`lessonsCoreGuide`、`configBackupIntervalDays`、`configBackupKeep`、`configExportReminderDays`、准入策略三层 | 高级 › 规矩与备份（`lessons`） |
| `PrivacySettings`：`llmLevel`、`llmBaseUrl`、`llmModel`、`llmMonthlyBudgetUsd`、`llmPrices`、`llmConfirm`、`auditRetentionDays`、API key | 高级 › 隐私与个人 API（`privacy`） |
| `ExternalActionSettings`：14 个 `external*`（`EXTERNAL_ACTION_SETTINGS`） | 高级 › 对外动作（`external`）。不进功能页：它们不是「功能」，而是 Butler 对外做事的许可 |
| `SettingsPage` 顶部健康块（`HealthReport`：claude 路径/版本/缺的参数、hook、/handoff 命令、Butler home、claude settings）、`ClaudeAvailability`、安装/卸载 hook 按钮 | **健康检查**；新增 gh 一行（`lessonsState().ghAvailable`）、用量一行（`usageSummary`） |
| 没有任何设置 UI、由别处写的内部状态：`skillTrackingSince`、`metricsSince`、`metricsBaselineCutoff`、`admissionPolicyVersion`、`configLastExportAt`、`admissionCalibratedAt`、`lessonsPrinciplesRegroupedAt`、`backtestThresholdReviewAt`、`interruptReductionSince`；以及在「复盘与规矩」页自己的区块里编辑的 `checksEnabled`、`checksEditTimeoutSec`、`checksPushTimeoutSec`、`baselineInfer`、`baselineAutoRescan`、`baselineGuideChars`、`legacyScanMaxFiles` | 不动（登记为 `elsewhere`） |

### 功能页的 11 行（真实键名）

「全局值」= 全局那一层的策略值（`loop_policies`/`stack_policies`/`intake_policies` 里 `scope_kind = 'global'` 那一行，没有就是默认值 false）。

| id | 一句话（要写进 strings 的意思） | 对应的键（一起开关） | 仓库/产品覆盖 |
|---|---|---|---|
| `ci_triage` | CI 挂了先判断是环境抖动还是代码问题，代码问题把日志送回 session；重跑要另开「对外动作 › 重跑 CI」 | 策略 `loop` / `ci.enabled` | 有 |
| `review_comments` | 有人在 PR 上提意见，分类后转给 session 去改。不对外发任何东西（回复、标 resolved 要另开对外动作） | 策略 `loop` / `comments.enabled` | 有 |
| `stacks` | 底下的 PR 合了，自动把上面的分支 rebase 好 | 策略 `stacks` / `autoRebase` | 有 |
| `prereview` | 开 PR 前让另一个 agent 先审一遍，算出风险和还差什么 | 设置 `preReviewEnabled` | 无（全局设置） |
| `intake` | 从 tracker 或文件里领活、建 ticket。还要在高级里选来源 | 策略 `intake` / `enabled` | 有 |
| `lessons_auto` | 复盘出来的规矩自动判断、每天归成原则、session 说明里只留核心规矩 | 设置 `lessonsAutoAdmit` + `lessonsPrinciples` + `lessonsCoreGuide`（3 个） | 无 |
| `fewer_interrupts` | 让 session 少停下来问你：选择题按推荐项选、缺信息先自己查 | 设置 `interruptChoiceRule` + `interruptSelfServe`（2 个）。`interruptChoiceDefaults`（按你设的默认答案替你答）不进这一行，留在高级 | 无 |
| `hibernate` | 没事做的 session 先关掉省内存，需要时原样接上 | 设置 `hibernateEnabled` | 无 |
| `routing_switch` | 撞到用量上限时换一个档位的模型接着干 | 设置 `routingAutoSwitch` | 无 |
| `mem_relief` | 内存紧张时让看不见的 session 让路（降优先级、休眠最闲的） | 设置 `backgroundPriority` + `memoryPressureEnabled`（2 个） | 无 |
| `shared_mcp` | 所有 session 共用一组记忆和 Butler MCP 进程，省内存 | 设置 `sharedMcp` | 无 |

不进功能页的 3.0 能力和原因：费用熔断、后台任务时段、配置自动备份、每日巡检（都是数字或时间，空/0 = 关，没有布尔开关）；`permissionProfiles`（默认就是开，不是「默认全关」的 3.0 功能）；`notifyDetails`、各 `external*`（对外的许可，留在高级）。

---

## File Structure

新建：
- `src/shared/settings-layout.ts` — `SettingsTabId`、`AdvancedGroupId`、`SettingsSection`、`sectionTarget`、`SETTING_PLACEMENT`。
- `src/shared/feature-rows.ts` — `FeatureId`、`FEATURES`、`featureRows`、`applyFeatureToggle`、覆盖状态的类型。
- `src/main/settings/feature-policy.ts` — `readFeaturePolicy(db, productName)`：一次读三张策略表，算全局值和覆盖列表。
- `src/main/ipc/feature-policy-handlers.ts` — `featurePolicyHandlers(deps)`：读状态、`patch`（合并写全局那一层）。
- `src/renderer/src/components/useSettingsForm.tsx` — 把 `GeneralSettings` 里的 load/save/reset/draft/开关/数字字段助手抽成 hook。
- `src/renderer/src/components/BasicSettings.tsx`、`SessionPerfSettings.tsx` — 拆自 `GeneralSettings.tsx`。
- `src/renderer/src/components/AdvancedSettings.tsx` — 12 个默认收起的分组。
- `src/renderer/src/components/HealthSettings.tsx` — 健康检查 tab。
- `src/renderer/src/components/FeatureSettings.tsx` — 功能 tab。
- `src/renderer/src/feature-toggle.ts` — `runFeatureWrites`、`featureViewState`（纯函数）。
- `src/renderer/src/components/FirstRunHome.tsx` — 首页空状态。
- 测试：`src/shared/feature-rows.test.ts`、`src/shared/settings-layout.test.ts`、`src/main/settings/feature-policy.test.ts`、`src/main/ipc/feature-policy-handlers.test.ts`、`src/renderer/src/feature-toggle.test.ts`、`src/renderer/src/components/feature-settings-render.test.ts`、`src/renderer/src/components/first-run-home-render.test.ts`、`e2e/onboarding.spec.ts`。

修改：`src/renderer/src/components/SettingsPage.tsx`（重写）、`src/renderer/src/local-prefs.ts`（+测试）、`src/renderer/src/components/useCollapsed.ts`、`src/shared/ipc.ts`、`src/main/ipc/register.ts`、`src/main/index.ts`（接线）、`src/renderer/src/api.ts`、`src/renderer/src/App.tsx`（route 类型）、`src/renderer/src/strings.ts`、`strings-en.ts`、`CostBackgroundSettings.tsx`、`IntakeSettings.tsx`（两处用 `S.settingsTabs` 的标题）、`Wizard` 的完成页文案、e2e 里进设置各 tab 的地方。

删除：`src/renderer/src/components/GeneralSettings.tsx`、`S.settingsTabs`。

## 与别的层的接口

- **第 2 层渲染 `<FirstRunHome/>`**。props 定死（Task 6）：
  ```ts
  export interface FirstRunHomeProps {
    onNewTicket(): void;   // 第 2 层接 setShowNew(true)
    onNewFeature(): void;  // setShowNewFeature(true)
    onNewEpic(): void;     // setShowNewEpic(true)
    onOpenSettings(): void; // 接线方 setRoute({ page: "settings", section: "features" })
  }
  ```
  组件自己不判断「有没有工作」，也不认识路由、不自己开对话框；第 2 层决定什么时候渲染。按索引「实际开工的顺序」：本层（BTL-236）只做组件本身，不碰首页接线；第 2 层开工时若分支里已有该文件就直接渲染它，否则先用 `NoWorkLine`，由第 3 层换掉。第 2 层不建占位文件，所以本层的 Task 6 是新建该文件。
- **路由**：`{ page: "settings"; section?: SettingsSection }`（`SettingsSection` 从 `src/shared/settings-layout.ts` 引）。旧值 `"health"`、`"routing"`、`"cost"` 仍然有效（分别落到健康检查 tab、高级的 routing 分组、cost 分组），新增 `"basic"`、`"features"` 和其余高级分组 id。第 2、3 层里指向设置的链接（比如首页「Butler 要你点一下」的限额/模型不可用提醒）继续写 `section: "health"` / `"routing"` 即可。

---

### Task 1: 设置布局登记和「功能」行的纯函数

**Files:**
- Create: `src/shared/settings-layout.ts`、`src/shared/feature-rows.ts`
- Test: `src/shared/settings-layout.test.ts`、`src/shared/feature-rows.test.ts`

**Interfaces:**
- Consumes: `EDITABLE_SETTINGS`、`EditableSettingKey`、`EditableSettings`（`src/shared/settings.ts`）；`PolicyScope`（`src/shared/admission-policy.ts`）；`LOOP_POLICY_KEYS`、`STACK_POLICY_KEYS`、`INTAKE_POLICY_KEYS`。
- Produces（后面的任务用这些名字）：
  ```ts
  // src/shared/settings-layout.ts
  export const SETTINGS_TABS = ["basic", "features", "advanced", "health"] as const;
  export type SettingsTabId = (typeof SETTINGS_TABS)[number];
  export const ADVANCED_GROUPS = ["schedule","sessions","routing","cost","loop","review","stacks","intake","interrupts","lessons","privacy","external"] as const;
  export type AdvancedGroupId = (typeof ADVANCED_GROUPS)[number];
  export type SettingsSection = SettingsTabId | AdvancedGroupId;   // "health" | "routing" | "cost" 是旧值
  export function sectionTarget(s: SettingsSection | undefined): { tab: SettingsTabId; group: AdvancedGroupId | null };
  export type Placement = { tab: "basic" } | { tab: "advanced"; group: AdvancedGroupId } | { tab: "health" } | { tab: "elsewhere" };
  export const SETTING_PLACEMENT: Record<EditableSettingKey, Placement>;

  // src/shared/feature-rows.ts
  export const FEATURE_IDS = ["ci_triage","review_comments","stacks","prereview","intake","lessons_auto","fewer_interrupts","hibernate","routing_switch","mem_relief","shared_mcp"] as const;
  export type FeatureId = (typeof FEATURE_IDS)[number];
  export type PolicyFamily = "loop" | "stacks" | "intake";
  export type FeatureSwitch = { kind: "setting"; key: EditableSettingKey } | { kind: "policy"; family: PolicyFamily; key: string };
  export const FEATURES: Record<FeatureId, { switches: readonly FeatureSwitch[]; group: AdvancedGroupId }>;
  export interface PolicyOverrideEntry { family: PolicyFamily; key: string; scope: PolicyScope; label: string; value: boolean }
  export interface FeaturePolicyState { globals: Record<string, boolean>; overrides: PolicyOverrideEntry[] } // globals 的键是 `${family}:${key}`
  export type FeatureOnState = "off" | "on" | "partial";
  export interface FeatureRow {
    id: FeatureId;
    state: FeatureOnState;
    on: number; total: number;                       // 开着几个、一共几个键
    otherScopes: { repos: number; products: number; differing: number }; // differing：覆盖值和全局值不一样的层数
    needsSetup: "intake_source" | null;
    group: AdvancedGroupId;                          // 「点进高级」去哪个分组
  }
  export function featureRows(settings: EditableSettings, policy: FeaturePolicyState): FeatureRow[];  // 顺序 = FEATURE_IDS
  export type FeatureWrite =
    | { kind: "setting"; key: EditableSettingKey; value: "1" | "0" }
    | { kind: "policy"; family: PolicyFamily; key: string; value: boolean };
  export function applyFeatureToggle(id: FeatureId, on: boolean): FeatureWrite[];   // 只写全局，不碰覆盖
  export const FEATURE_POLICY_KEYS: Record<PolicyFamily, readonly string[]>;        // ["ci.enabled","comments.enabled"]、["autoRebase"]、["enabled"]
  ```
  `SETTING_PLACEMENT` 把上面「对照表」里每个键登记到位置；`sectionTarget(undefined)` 返回 `{ tab: "basic", group: null }`，`sectionTarget("routing")` 返回 `{ tab: "advanced", group: "routing" }`。

- [ ] **Step 1: 写失败的测试 `src/shared/feature-rows.test.ts`**，断言：
  - `it("has a row for every feature and every key is real")`：`FEATURE_IDS` 与 `Object.keys(FEATURES)` 相同；所有 `setting` 键 ∈ `EDITABLE_SETTINGS`；所有 `policy` 键 ∈ `LOOP_POLICY_KEYS` 的 key / `STACK_POLICY_KEYS` / `INTAKE_POLICY_KEYS`，并且那个键的默认值是 `false`（`LOOP_POLICY_DEFAULTS`、`STACK_POLICY_DEFAULTS`、`INTAKE_POLICY_DEFAULTS`）；`FEATURE_POLICY_KEYS` 与 `FEATURES` 里的策略键一致。
  - `it("shows every row off for a user who changed nothing")`：用 `SETTING_DEFAULTS`（`src/main/db/settings-repo.ts`）当 `settings`、`{ globals: {}, overrides: [] }` 当策略，每行 `state === "off"`，`otherScopes` 全 0。
  - `it("never turns on an outward action")`：对每个 id，`applyFeatureToggle(id, true)` 的每个写入，setting 键不以 `external` 开头，policy 键不是 `comments.reply`、`comments.resolve`；`review_comments` 的写入恰好是 `[{ kind: "policy", family: "loop", key: "comments.enabled", value: true }]`。
  - `it("writes all keys of a multi-key row together")`：`applyFeatureToggle("lessons_auto", true)` 是 `lessonsAutoAdmit`、`lessonsPrinciples`、`lessonsCoreGuide` 三个 `value: "1"`；关闭时是 `"0"`；`fewer_interrupts` 恰好 `interruptChoiceRule` + `interruptSelfServe`，且不含 `interruptChoiceDefaults`。
  - `it("reports a half-enabled row as partial, with the count")`：`lessonsAutoAdmit: "1"` 其余默认 → `lessons_auto` 的 `state: "partial"`、`on: 1`、`total: 3`；三个都 "1" → `on`；`interruptSelfServe: "1"` → `fewer_interrupts` `partial` 1/2。
  - `it("counts layers that override, and notes the ones that disagree with the global value")`：`globals: { "loop:ci.enabled": false }`，`overrides` 里 3 个 repo 层（其中 2 个 `value: true`、1 个 `false`）、1 个 product 层 `true` → `ci_triage.otherScopes` 是 `{ repos: 3, products: 1, differing: 3 }`，`state` 仍是 `off`；同一个 repo 层同时覆盖了 `ci.enabled` 和（另一行的）`comments.enabled`，各行只数自己的键；同一个 scope 对同一行只数一次。
  - `it("handles hundreds of overrides")`：500 个 repo 层覆盖，`featureRows` 一次调用返回，`otherScopes.repos === 500`（只数，不逐个展开）。
  - `it("flags intake that is on but has no source")`：`globals: { "intake:enabled": true }` 且 `settings.intakeSource === "none"` → `needsSetup: "intake_source"`；`intakeSource: "file"` → `null`；关着时 → `null`。
  - `it("treats a policy global as off when the state has no entry for it")`：`globals: {}` → off。

  `src/shared/settings-layout.test.ts`：`it("places every editable setting")`（`Object.keys(SETTING_PLACEMENT)` 与 `EDITABLE_SETTINGS` 集合相同）；每个 `advanced` 的 group ∈ `ADVANCED_GROUPS`，每个 group 至少有一个键或属于「策略为主」的白名单 `["cost","loop","review","stacks"]`……（`cost`、`loop`、`stacks` 的设置键主要是策略，没有设置键也可以，白名单写在测试里）；`FEATURES` 里每个 setting 键的 `SETTING_PLACEMENT` 是 `advanced` 且 group 等于该行的 `group`；`sectionTarget("health")` → `{ tab: "health", group: null }`、`sectionTarget("cost")` → `{ tab: "advanced", group: "cost" }`、`sectionTarget("features")` → `{ tab: "features", group: null }`、`sectionTarget(undefined)` → basic。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/shared/feature-rows.test.ts src/shared/settings-layout.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/shared/settings-layout.ts`**：按对照表登记每个键（`language`、`claudePath`、`branchTemplate`、`ticketPattern`、`memoryEnabled`、`refreshThresholdTokens`、`onboardingDone` → basic；对照表里列的各组 → 对应 advanced group；上表最后一行的键 → `elsewhere`）。`SETTING_PLACEMENT` 声明为 `Record<EditableSettingKey, Placement>`。

- [ ] **Step 4: 实现 `src/shared/feature-rows.ts`**：`FEATURES` 就是上面「11 行」表里的键和 `group`（`ci_triage`/`review_comments` → `loop`，`stacks` → `stacks`，`prereview` → `review`，`intake` → `intake`，`lessons_auto` → `lessons`，`fewer_interrupts` → `interrupts`，`hibernate`/`mem_relief`/`shared_mcp` → `sessions`，`routing_switch` → `routing`）。setting 键的开 = `settings[key] === "1"`；policy 键的开 = `policy.globals[`${family}:${key}`] === true`。`otherScopes` 按 `scope` 去重（同一 scope 对同一行只算一次），`differing` = 覆盖值与该键全局值不同的 scope 数。`applyFeatureToggle` 按 `FEATURES[id].switches` 的顺序返回写入。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run src/shared/feature-rows.test.ts src/shared/settings-layout.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/settings-layout.ts src/shared/feature-rows.ts src/shared/settings-layout.test.ts src/shared/feature-rows.test.ts
git commit -m "feat(settings): pure feature rows and settings placement table"
```

---

### Task 2: 读覆盖、合并写全局那一层（main + IPC）

**Files:**
- Create: `src/main/settings/feature-policy.ts`、`src/main/ipc/feature-policy-handlers.ts`
- Modify: `src/shared/ipc.ts`（新增两个通道并加进白名单列表，`src/shared/ipc.test.ts` 会检查）、`src/main/ipc/register.ts`（用 `d.loop`/`d.stacks`/`d.intake` 接线）、`src/main/index.ts`（把 `db` 和产品名查询交给 handlers，照 `settingsHandlers` 的接法）、`src/renderer/src/api.ts`
- Test: `src/main/settings/feature-policy.test.ts`、`src/main/ipc/feature-policy-handlers.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FeaturePolicyState`、`PolicyOverrideEntry`、`FEATURE_POLICY_KEYS`、`PolicyFamily`；`sanitizeLoopOverrides`、`sanitizeStackOverrides`、`sanitizeIntakeOverrides`；表 `loop_policies`、`stack_policies`、`intake_policies`（列 `scope_kind, product_id, repo_slug, overrides`）；`d.loop.policyView/policySet`、`d.stacks.policyView/policySet`、`d.intake.policyView/policySet`（`register.ts` 的 `Deps`）。
- Produces:
  ```ts
  // src/main/settings/feature-policy.ts
  export function readFeaturePolicy(db: Db, productName: (id: number) => string | null): FeaturePolicyState;
  // src/main/ipc/feature-policy-handlers.ts
  export interface FeaturePolicyDeps {
    read(): FeaturePolicyState;
    globalLayer(family: PolicyFamily): Record<string, unknown>;          // 全局层现有的覆盖（没覆盖的键不在里面）
    writeLayer(family: PolicyFamily, layer: Record<string, unknown>): void; // 调用现有 policySet；失败抛错
    notify(): void;
  }
  export function featurePolicyHandlers(d: FeaturePolicyDeps): { get(): FeaturePolicyState; patch(raw: unknown): void };
  // IPC：IPC.settingsFeaturePolicy = "settings:featurePolicy"；IPC.settingsPolicyPatch = "settings:policyPatch"，参数 { family, key, value: boolean }
  // api.ts：featurePolicy(): Promise<FeaturePolicyState>；policyPatch(p: { family: PolicyFamily; key: string; value: boolean }): Promise<void>
  ```

- [ ] **Step 1: 写失败的测试**

  `feature-policy.test.ts`（用 `src/main/test-utils.ts` 的 `memDb()`，直接 INSERT 三张表的行）：
  - `it("reads the global value from the global layer and falls back to the default")`：没有全局行 → `globals` 里三个家族的键全是 `false`；全局行 `{"ci.enabled":true}` → `globals["loop:ci.enabled"] === true`。
  - `it("lists non-global layers that set a feature key, with labels")`：repo 层 `{"comments.enabled":true,"ci.maxReruns":3}` → 只出现 `comments.enabled` 一条（`ci.maxReruns` 不是功能键）；product 层带 `label` = `productName(id)`（查不到时 `#id`）；repo 层 `label` 是 slug。
  - `it("drops garbage in stored overrides instead of throwing")`：`overrides` 是坏 JSON 或含未知键，不抛错、该层当没有。
  - `it("reads 500 repo layers with a single pass")`：插入 500 个仓库层，结果 `overrides.length === 500`；用包一层 `db.prepare` 的计数断言每张表只 `prepare` 一次 SELECT。

  `feature-policy-handlers.test.ts`（假的 deps）：
  - `it("keeps the other overrides in the global layer when it flips one key")`：`globalLayer("loop")` 返回 `{ "ci.maxReruns": 3, "comments.ignorePatterns": ["x"] }`，`patch({ family: "loop", key: "ci.enabled", value: true })` → `writeLayer` 收到 `{ "ci.maxReruns": 3, "comments.ignorePatterns": ["x"], "ci.enabled": true }`，并 `notify` 一次。
  - `it("rejects keys that are not feature switches")`：`family` 不认识、`key` 是 `"comments.reply"`、`value` 不是布尔，都抛错且不写。
  - `it("does not notify when the write fails")`。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm vitest run src/main/settings/feature-policy.test.ts src/main/ipc/feature-policy-handlers.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `readFeaturePolicy`**：对三张表各 `SELECT scope_kind, product_id, repo_slug, overrides` 一次；用各自的 `sanitize*Overrides` 过滤；`FEATURE_POLICY_KEYS` 里的键才进结果。

- [ ] **Step 4: 实现 `featurePolicyHandlers`**：`patch` 先校验（`family` ∈ `FEATURE_POLICY_KEYS` 的键、`key` ∈ 该家族的列表、`value` 是 boolean，渲染进程不可信，照 `settings-handlers.ts` 的写法抛 `SettingError`），再 `writeLayer(family, { ...globalLayer(family), [key]: value })`，成功后 `notify()`。

- [ ] **Step 5: 接线**：`register.ts` 里 `globalLayer` 用 `d.<family>.policyView({ kind: "global" })`，取 `override !== null`（loop）或 `set === true`（stacks、intake）的键组成对象；`writeLayer` 调现有的 `d.loop.policySet`、`d.stacks.policySet`、`d.intake.policySet`（后两个返回 `{ ok: false, message }` 时抛 `Error(message)`）。`api.ts` 加 `featurePolicy`、`policyPatch`。

- [ ] **Step 6: 运行确认通过**

Run: `pnpm vitest run src/main src/shared/ipc.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main src/shared/ipc.ts src/renderer/src/api.ts
git commit -m "feat(settings): read feature overrides in one pass and patch the global policy layer"
```

---

### Task 3: 把「常规」页拆开，「默认收起」的分组状态

只重构，行为不变；此时 `SettingsPage` 仍是旧的 8 个 tab，只是把 `GeneralSettings` 换成 `BasicSettings` + `SessionPerfSettings` 两块。

**Files:**
- Create: `src/renderer/src/components/useSettingsForm.tsx`、`BasicSettings.tsx`、`SessionPerfSettings.tsx`
- Delete: `src/renderer/src/components/GeneralSettings.tsx`
- Modify: `src/renderer/src/local-prefs.ts`、`src/renderer/src/components/useCollapsed.ts`、`SettingsPage.tsx`（临时：旧「常规」tab 里依次渲染 `BasicSettings` 和 `SessionPerfSettings`）
- Test: `src/renderer/src/local-prefs.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // useSettingsForm.tsx
  export interface SettingsForm {
    current: EditableSettings; value(k: EditableSettingKey): string;
    save(k: EditableSettingKey, v?: string): Promise<void>; reset(k: EditableSettingKey): Promise<void>;
    flagField(k: EditableSettingKey, label: string, help: string): JSX.Element;
    numberField(k: EditableSettingKey, label: string, help?: string, range?: { min?: number; max?: number }): JSX.Element;
    textBlur(k: EditableSettingKey): { value: string; onChange(e: ChangeEvent<HTMLInputElement>): void; onBlur(): void };
    error: string | null;
  }
  export function useSettingsForm(onSaved?: (k: EditableSettingKey) => void): SettingsForm | null; // null = 还没读到
  // local-prefs.ts
  export const isCollapsed: (id: string, defaultCollapsed?: boolean) => boolean;
  export function setCollapsed(id: string, on: boolean, defaultCollapsed?: boolean): void;
  // useCollapsed.ts
  export function useCollapsed(id: string, defaultCollapsed?: boolean): [boolean, () => void];
  ```
  `BasicSettings({ report, onHealth, onRerunWizard })`（内容：`LanguagePicker`、`claudePath`/`branchTemplate`/`ticketPattern`、开机启动、记忆开关和记忆信息、`refreshThresholdTokens`、重新运行向导按钮；保存 `claudePath`/`memoryEnabled` 后调 `onHealth(await api.health())`）；`SessionPerfSettings()`（其余所有，包括休眠、内存、共享 MCP、性能提示）。

- [ ] **Step 1: 写失败的测试**（加进 `local-prefs.test.ts`，沿用该文件里已有的 localStorage 假实现）：
  - `it("is collapsed by default when asked, and an explicit open is remembered")`：`isCollapsed("g", true)` 为 true；`setCollapsed("g", false, true)` 后 `isCollapsed("g", true)` 为 false；再 `setCollapsed("g", true, true)` 回到 true；
  - `it("keeps the old default (expanded) for ids that do not ask")`：`isCollapsed("x")` 为 false，行为和以前一样；
  - `it("keeps default-collapsed opens apart from plain collapsed ids")`：两种 id 同名时互不影响（默认收起的「已展开」用 `open:` 前缀的条目存在同一个列表里）。

- [ ] **Step 2: 运行确认失败**：`pnpm vitest run src/renderer/src/local-prefs.test.ts`，Expected: FAIL

- [ ] **Step 3: 实现** `isCollapsed(id, defaultCollapsed = false)` = `defaultCollapsed ? !list.includes("open:" + id) : list.includes(id)`；`setCollapsed(id, on, defaultCollapsed = false)` 在默认收起时增删 `open:` 条目，其余路径不变；`onCollapsedChange` 的回调参数照旧（id 用原始 id）。`useCollapsed` 透传第二个参数。

- [ ] **Step 4: 拆 `GeneralSettings.tsx`**：先把 load/save/reset/draft/`flagField`/`numberField` 抽成 `useSettingsForm`（读失败时 `reportError`、返回 null，和原来一样不画东西），再把 JSX 按上面的分工搬进 `BasicSettings.tsx` 和 `SessionPerfSettings.tsx`，`perfHelp`、`perfTips`、`byPlatform`、`SESSION_FIELDS` 跟着搬到 `SessionPerfSettings.tsx`。所有 `data-testid`、文案、字段顺序保持不变。删掉 `GeneralSettings.tsx`。

- [ ] **Step 5: 验证**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: PASS（`SettingsPage` 临时的 tab 照常能渲染）

- [ ] **Step 6: Commit**

```bash
git add -A src/renderer/src
git commit -m "refactor(settings): split the general page and let collapsible groups start collapsed"
```

---

### Task 4: 四个 tab 的外壳：基本、高级、健康检查（删掉旧布局）

**Files:**
- Modify: `src/renderer/src/components/SettingsPage.tsx`（整体重写）、`App.tsx`（route 类型 `section?: SettingsSection`）、`CostBackgroundSettings.tsx`（`<h2>{S.settingsTabs.cost}</h2>` 改成 `S.set.groups.cost`）、`IntakeSettings.tsx`（同理 `S.set.groups.intake`）、`strings.ts`、`strings-en.ts`（删 `settingsTabs`、加 `set` 命名空间的 tab 名、分组名、健康检查文案）、所有进设置各 tab 的 e2e（见 Step 7）
- Create: `AdvancedSettings.tsx`、`HealthSettings.tsx`
- Test: `src/renderer/src/components/settings-page-render.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `SettingsSection`、`sectionTarget`、`ADVANCED_GROUPS`、`AdvancedGroupId`；Task 3 的 `BasicSettings`、`SessionPerfSettings`、`useCollapsed(id, true)`；`saveTab`/`savedTab`（`local-prefs.ts`）。
- Produces:
  ```ts
  export function SettingsPage(props: { onRerunWizard: () => void; section?: SettingsSection }): JSX.Element;
  // AdvancedSettings.tsx
  export function AdvancedSettings(props: { openGroup: AdvancedGroupId | null }): JSX.Element;
  // HealthSettings.tsx
  export function HealthSettings(props: { report: HealthReport | null; busy: boolean; error: string | null; onRecheck(): void; onInstall(): void; onUninstall(): void; scrollToAvailability: boolean }): JSX.Element;
  // 固定的 testid：settings-tab-basic|features|advanced|health；高级分组的头 adv-group-<id>（button，aria-expanded），内容 adv-body-<id>
  ```

- [ ] **Step 1: 写失败的测试 `settings-page-render.test.ts`**（`renderToStaticMarkup` + `createElement`，不挂 `api`）：
  - 对 `AdvancedSettings({ openGroup: null })`：12 个 `adv-group-<id>` 按钮都在，每个 `aria-expanded="false"`，没有任何分组内容（`adv-body-*` 不存在，也不会渲染各分组组件，免得进页面就发十几个读设置的请求）。
  - `openGroup: "loop"`：`adv-group-loop` 的 `aria-expanded="true"`，`adv-body-loop` 存在，其余仍收起。
  - 分组顺序等于 `ADVANCED_GROUPS`，文案是 `S.set.groups[id]`。
  - 在 `setUiLang("en")` 后同样渲染，标题不含汉字。
  - 把 `SETTINGS_TABS` 的四个 tab 名在 zh/en 下都有文案（`S.set.tabs`）。

- [ ] **Step 2: 运行确认失败**：`pnpm vitest run src/renderer/src/components/settings-page-render.test.ts`，Expected: FAIL

- [ ] **Step 3: 实现 `AdvancedSettings.tsx`**：12 个分组按 `ADVANCED_GROUPS` 顺序，一个 `AdvancedGroup`（头部是 button，状态用 `useCollapsed("settings-adv:" + id, true)`；`openGroup === id` 时强制展开且不写入记忆）。分组与组件的对应：`schedule` → `ScheduleSettings`；`sessions` → `SessionPerfSettings`；`routing` → `RoutingSettings`；`cost` → `CostBackgroundSettings`；`loop` → `LoopSettings`；`review` → `ReviewSettings`；`stacks` → `StackSettings`；`intake` → `IntakeSettings`；`interrupts` → `InterruptSettings`；`lessons` → `LessonsSettings`；`privacy` → `PrivacySettings`；`external` → `ExternalActionSettings`。收起时只渲染头部，展开才挂载组件。各组件内部的 `<h2>` 保持不动（e2e 里有按标题找的用例）。

- [ ] **Step 4: 实现 `HealthSettings.tsx`**：把旧 `SettingsPage` 的健康块（`dl.kv`、`ClaudeAvailability`、hook 说明、三个按钮、`error`）原样搬过来；新增两行：`gh`（`useStateRefetch("health-gh", api.lessonsState)` 的 `ghAvailable`，读不到时显示「未知」，不当成未装）和 `用量`（`api.usageSummary()`：「近期 cache 命中 N%」一句，失败时那一行省略）。`ClaudeAvailability` 保持 `scrollIntoView` 行为。

- [ ] **Step 5: 重写 `SettingsPage.tsx`**：状态 `tab: SettingsTabId`，初始值 = `sectionTarget(section).tab`，没有 `section` 时用 `savedTab("settings")`（不是合法值就 `basic`）；点 tab 时 `saveTab("settings", id)`；`section` 变化时（`useEffect`）同步 tab 和 `openGroup`。保留原来的 `seq` 防旧结果覆盖逻辑（`run`、`applyHealth`）和进页面就检测一次 health 的行为；`basic` tab 渲染 `BasicSettings`，`advanced` 渲染 `AdvancedSettings`，`health` 渲染 `HealthSettings`，`features` 先渲染一个占位（Task 5 替换）。health 未返回时在 `basic` tab 里 `BasicSettings` 需要 `report`：没有 `report` 时显示 `S.loading`/错误，和旧页面一样。删掉旧的 8 个 tab 分支和 `S.settingsTabs`。

- [ ] **Step 6: 文案**：`S.set = { tabs: {basic,features,advanced,health}, groups: Record<AdvancedGroupId,string>, advancedIntro, health: { gh, usage, usageValue: (pct:number)=>string, unknown } }`，中文分组名用对照表里的名字，英文同步翻译（两边函数参数个数相同）。`App.tsx` 的 route 类型改成 `{ page: "settings"; section?: SettingsSection }`；`NowPage.tsx` 里 `section: "health"` / `"routing"` 的两处不用改（旧值仍有效）。

- [ ] **Step 7: 更新 e2e**：在 `e2e/fixtures.ts` 加
  ```ts
  /** 侧栏进设置 → 高级 → 展开分组 id（已展开就不点）。 */
  export async function openSettingsGroup(page: Page, group: AdvancedGroupId): Promise<void>;
  ```
  （点 `settings-tab-advanced`，再点 `adv-group-<group>`，等 `adv-body-<group>` 可见。）把 `setLoopPolicy`（`settings-tab-loop`）和 `cost-breaker.spec.ts`、`intake.spec.ts`、`interrupts.spec.ts`、`progress.spec.ts`、`prereview.spec.ts`、`routing.spec.ts`、`stacks.spec.ts`、`defaults.spec.ts` 里所有 `settings-tab-<routing|cost|loop|interrupts|stacks|review|intake>` 的点击改成 `openSettingsGroup(page, "<同名分组>")`（`grep -rn "settings-tab-\|getByTestId(\"setting-" e2e` 逐个看；`setting-*` 在 `general` 里的用例改成先进 `basic` 或 `sessions` 分组）。

- [ ] **Step 8: 验证**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint && pnpm e2e -- e2e/cost-breaker.spec.ts e2e/intake.spec.ts e2e/interrupts.spec.ts e2e/routing.spec.ts e2e/stacks.spec.ts e2e/prereview.spec.ts e2e/ci-triage.spec.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A src e2e
git commit -m "feat(settings): four tabs with grouped, collapsed advanced settings and a health tab"
```

---

### Task 5: 「功能」tab

**Files:**
- Create: `src/renderer/src/components/FeatureSettings.tsx`、`src/renderer/src/feature-toggle.ts`
- Modify: `SettingsPage.tsx`（`features` tab 换成 `FeatureSettings`）、`strings.ts`、`strings-en.ts`
- Test: `src/renderer/src/feature-toggle.test.ts`、`src/renderer/src/components/feature-settings-render.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `featureRows`、`applyFeatureToggle`、`FeatureRow`、`FeatureWrite`、`FEATURE_IDS`；Task 2 的 `api.featurePolicy`、`api.policyPatch`；`api.settings`、`api.setSetting`、`api.onStateChanged`。
- Produces:
  ```ts
  // feature-toggle.ts
  export type FeaturesView =
    | { kind: "loading" }
    | { kind: "failed"; message: string }
    | { kind: "ready"; rows: FeatureRow[] };
  export function featuresView(input: { settings: EditableSettings | null; policy: FeaturePolicyState | null; error: string | null }): FeaturesView;
  export function runFeatureWrites(
    writes: FeatureWrite[],
    exec: (w: FeatureWrite) => Promise<void>,
  ): Promise<{ ok: true } | { ok: false; failedAt: number; error: unknown }>; // 顺序执行，第一个失败就停
  // FeatureSettings.tsx
  export function FeatureSettings(props: { onOpenAdvanced(group: AdvancedGroupId): void }): JSX.Element;
  // 渲染纯视图（供测试）：FeatureList(props: { rows: FeatureRow[]; busyId: FeatureId | null; onToggle(id, on): void; onOpenAdvanced(group): void })
  // testid：feature-row-<id>（带 data-state="off|on|partial"）、feature-toggle-<id>（单键行的 checkbox）、feature-all-on-<id> / feature-all-off-<id>（partial 行的两个按钮）、feature-others-<id>（「N 个仓库另有设置」链接）、feature-setup-<id>（需要先配置的提示）、features-retry
  ```
  文案：`S.set.feat: Record<FeatureId, { title: string; desc: string }>`、`S.set.featuresIntro`、`S.set.new3 = "3.0"`、`S.set.partial(on: number, total: number)`、`S.set.allOn`、`S.set.allOff`、`S.set.otherRepos(n)`、`S.set.otherProducts(n)`、`S.set.offButElsewhere(n)`（「已关，但 N 个仓库/产品自己开着」）、`S.set.needsIntakeSource`、`S.set.featuresFailed`、`S.set.retry`。中文标题、说明按上面「11 行」表的意思写（`review_comments` 的说明必须含「不对外发任何东西」，英文含 "does not post anything outside"）。

- [ ] **Step 1: 写失败的测试**

  `feature-toggle.test.ts`：
  - `it("never shows switches when settings could not be read")`：`featuresView({ settings: null, policy: null, error: "boom" })` → `{ kind: "failed", message: "boom" }`；`settings` 有、`policy` 为 null 且有 error → 也是 `failed`（只有设置没有覆盖信息时不能画，因为会漏掉「仓库自己开着」）；都为 null 且无 error → `loading`。
  - `it("stops at the first failed write and says which one")`：三个写入，第二个 `exec` 抛错 → `{ ok: false, failedAt: 1 }`，第三个没被调用。
  - `it("runs the writes in order")`。

  `feature-settings-render.test.ts`（`renderToStaticMarkup` 渲染 `FeatureList`）：
  - `it("renders 11 rows, all switches off, each with the 3.0 mark")`：`featureRows(SETTING_DEFAULTS, empty)` → 11 个 `feature-row-*`，每个有 `3.0`，单键行的 checkbox 都不带 `checked`。
  - `it("shows a half-on row as partial with two buttons, not as a switch")`：`lessons_auto` 为 partial 1/3 → `data-state="partial"`、含 `1/3`、有 `feature-all-on-lessons_auto` 和 `feature-all-off-lessons_auto`，没有 `feature-toggle-lessons_auto`。
  - `it("says the feature is off but running somewhere")`：`ci_triage` 为 off、`otherScopes.differing = 2` → 含 `S.set.offButElsewhere(2)` 的文字，且有 `feature-others-ci_triage`。
  - `it("links to advanced when other scopes exist, and not otherwise")`。
  - `it("warns that intake is on but has no source")`：有 `feature-setup-intake`。
  - `it("has no text in the row state: titles come from S")`：`setUiLang("en")` 渲染后不含汉字、`setUiLang("zh")` 后含 `S.set.feat.ci_triage.title`；`Object.keys(S.set.feat)` 与 `FEATURE_IDS` 相同（zh 和 en 都是）。

- [ ] **Step 2: 运行确认失败**：`pnpm vitest run src/renderer/src/feature-toggle.test.ts src/renderer/src/components/feature-settings-render.test.ts`，Expected: FAIL

- [ ] **Step 3: 实现 `feature-toggle.ts`** 和 `FeatureSettings.tsx`：组件挂载时同时取 `api.settings()` 和 `api.featurePolicy()`（`Promise.allSettled`，任何一个失败 → `failed` + 「重试」按钮 `features-retry`），订阅 `api.onStateChanged` 重取；点开关时 `applyFeatureToggle(id, on)` → `runFeatureWrites(writes, w => w.kind === "setting" ? api.setSetting(w.key, w.value) : api.policyPatch(w))`；写完（无论成败）都重取一次，失败时 `reportError` 并让界面回到真实状态（不做乐观更新，避免显示成开、其实只写了一半）。写入进行中该行的控件禁用。「点进高级」调 `props.onOpenAdvanced(row.group)`，`SettingsPage` 把它接到 `tab = advanced` + `openGroup = group`。

- [ ] **Step 4: 文案**：zh/en 各 11 条标题和说明；`strings.test.ts` 会检查两种语言形状一致和英文无汉字。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat(settings): features tab with one row per 3.0 feature"
```

---

### Task 6: 首页空状态 `<FirstRunHome/>` 和向导结尾

**Files:**
- Create: `src/renderer/src/components/FirstRunHome.tsx`（新建；首页接线不在本层）
- Modify: `src/renderer/src/strings.ts`、`strings-en.ts`（`S.firstRun`，`wizardDoneHelp` 改文案）、`src/renderer/src/styles.css`（流程图、三步卡片，沿用现有变量，注意 `styles-contrast.test.ts`）
- Test: `src/renderer/src/components/first-run-home-render.test.ts`、`e2e/onboarding.spec.ts`

**Interfaces:**
- Produces: `FirstRunHomeProps` 和 `FirstRunHome`（见上面「与别的层的接口」）。testid：`first-run-home`、`first-run-new-ticket`、`first-run-new-feature`、`first-run-new-epic`、`first-run-flow`、`first-run-settings-link`。文案：`S.firstRun = { title, lede, empty, stepTicket: { title, desc, button }, stepFeature, stepEpic, flow: [string, string, string, string], flowNote, defaultsOff, openFeatureSettings }`。

文案要点（照草图 `#homeFresh`）：标题「欢迎用 Butler」；一句话「Butler 替你看着一堆 Claude Code session：谁在干活、谁卡住了、哪个 PR 能合了。需要你的时候，就会出现在这一页。」；三种开工方式（①一个小活 → 新建 ticket：一个分支、一个 Claude session，做完开 PR；②一组相关的活 → 新建 feature：一个总控 session 帮你拆成几个 ticket 并行做；③一个大项目 → 新建 epic：先和总控规划，它会建 feature 和 ticket）；流程图四个节点「ticket 开工」→「agent 写代码、开 PR」→「CI / review」（旁注「失败自动送回 agent」；注意这句话要和功能页一致：`ci_triage` 关着时 CI 失败也会送回 session，那是 2.1 就有的行为，所以旁注不能说成要先开某个功能）→「可以合并 → 轮到你」；最后一句「Butler 默认什么都不替你对外做（不发评论、不合并）。想让它多做点，去 设置 › 功能 里一个个打开。」，其中「设置 › 功能」是按钮，点了调 `onOpenSettings`。

- [ ] **Step 1: 写失败的测试 `first-run-home-render.test.ts`**：
  - `it("offers the three ways to start, each with its own button")`：渲染含 `first-run-new-ticket`、`first-run-new-feature`、`first-run-new-epic`，按钮文字是 `S.newTicket`、`S.newFeature`、`S.newEpic`（用现有的按钮文案，确认这三个键名后再写断言）。
  - `it("draws the main flow in order")`：`first-run-flow` 文本里四个节点按 `S.firstRun.flow` 的顺序出现。
  - `it("says nothing is done outside by default and links to settings")`：含 `S.firstRun.defaultsOff`，有 `first-run-settings-link`。
  - `it("reads in both languages")`：`setUiLang("en")` 下渲染没有汉字，`setUiLang("zh")` 后恢复；`S.firstRun` 在两种语言下形状一致（已有 `strings.test.ts` 会兜底）。
  - 回调：直接调用元素 props（用 `createElement` 取到 `onClick`，或把组件拆出一个纯的 `FirstRunHomeView(props)`）验证四个回调各被调一次——选后者。

- [ ] **Step 2: 运行确认失败**：`pnpm vitest run src/renderer/src/components/first-run-home-render.test.ts`，Expected: FAIL

- [ ] **Step 3: 实现 `FirstRunHome.tsx`**（`FirstRunHome` 就是 `FirstRunHomeView` 的薄封装，无自己的数据请求）；文案和样式。

- [ ] **Step 4: 向导完成页**：`Wizard.tsx` 的 `done` 步骤只改 `S.wizardDoneHelp`（zh/en）：去掉「点左侧“新建 ticket”开始」，改成「点完成进入首页，从那里选一种方式开始第一件事；3.0 的各个功能在 设置 › 功能 里，默认都关着。每晚 Butler 会为有活动的 ticket 生成 handoff……」（保留后半句原意）。`finish()` 和 `App.tsx` 的 `onDone → setRoute({ page: "home" })` 已经是「跳到首页」，不改；`wizard.ts` 不改。

- [ ] **Step 5: 写 e2e `e2e/onboarding.spec.ts`**（沿用 `wizard.spec.ts` 的写法：`makeSandbox`、`launch`、`completeWizard`）：
  - `test("a fresh install has every feature off")`：走完向导 → 侧栏进设置 → 点 `settings-tab-features`（`aria-selected="true"`）；11 个 `feature-row-*` 的 `data-state` 全是 `off`。首页空状态的 e2e（落到 `first-run-home`、三个按钮开对话框、`first-run-settings-link` 进功能 tab）依赖首页接线，由接线的那一层（第 2/3 层）补，本层用 render 测试覆盖组件。
  - `test("turning on a feature writes the setting, leaves outward actions off, and survives a language switch")`：打开 `hibernate` 一行 → 重新读回仍是开（`data-state="on"`）；打开 `review_comments` 之后去高级 › 对外动作，14 个 `external-<kind>` 全没勾；切到英文（`LanguagePicker`，整窗重载）后同一行还是 `on`，标题是英文。
  - `test("a half-enabled row is shown as partial")`：用沙盒的 db 先把 `lessonsAutoAdmit` 设成 `1`（参考 `e2e` 里已有的直接写 db 的用例，如 `lessons-admission.spec.ts` 里 `db.prepare(...)` 的方式）→ `lessons_auto` 的 `data-state="partial"`；点「全部打开」后三个设置都是 `1`。
  - 向导里 `S.wizardNext` 的次数和 `completeWizard` 不变，不需要改 `fixtures.ts` 的向导部分。

- [ ] **Step 6: 验证**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint && pnpm e2e -- e2e/onboarding.spec.ts e2e/wizard.spec.ts e2e/language.spec.ts e2e/defaults.spec.ts`
Expected: PASS（`wizard.spec.ts` 里等待首页标题的断言由第 2 层改成新标题；如果第 2 层已经改了就直接通过）

- [ ] **Step 7: Commit**

```bash
git add -A src e2e
git commit -m "feat(onboarding): first-run home with the three ways to start, and a wizard that ends there"
```

---

## 自查记录

- **Spec 覆盖**：§5.3 设置四个 tab（Task 3、4）、功能页每行一句话/3.0/开关/默认全关/不加总开关/不迁移/覆盖提示/review 评论不连带对外（Task 1、2、5）；§5.5 首页空状态（一句话、三个按钮、流程图、默认不对外 + 跳转，Task 6）、向导结尾（Task 6）、功能页是说明书（Task 5 的说明文案）。
- **类型一致**：`FeatureId`、`FeatureRow`、`FeatureWrite`、`FeaturePolicyState`、`SettingsSection`、`AdvancedGroupId` 只在 Task 1 定义，后面任务只引用；`FirstRunHomeProps` 在「与别的层的接口」和 Task 6 一致。
- **与别的层的待确认点**：首页接线（渲染 `FirstRunHome`、传四个回调）由第 2/3 层做；第 2、3 层里指向设置的链接继续用 `section`（旧值有效）。
