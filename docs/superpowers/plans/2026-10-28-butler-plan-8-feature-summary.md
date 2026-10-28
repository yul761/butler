# Feature 汇总 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 feature 加一层整体进度汇总：晚间自动生成、feature 页"立即更新"、总控里的 `/handoff` 都能写入；feature 页顶部显示汇总和合并后的 ticket / PR 表；简报按 feature 归组。

**Architecture:** 新表 `feature_handoffs`（迁移 8）和 `FeatureHandoffSchema`。新的 `FeatureSummaryRunner` 复用 ticket handoff 的 headless 执行（抽出 `execHeadlessJson`），fork 最近的 feature 总控 session，把各 ticket 最新的 handoff 放进 prompt。`/handoff` 的采集按 session 的 `featureId` 分流，feature 汇总入库后在后台给有活动的子 ticket 跑 handoff，跑完把 `covers_until` 记到这份汇总上，候选规则据此不重复生成。

**Tech Stack:** Electron + TypeScript，node:sqlite，zod，React 渲染进程，vitest，Playwright（e2e，假 claude 在 `e2e/fake-claude`）。

**Spec:** `docs/superpowers/specs/2026-10-28-feature-summary-design.md`

## Global Constraints

- 注释用中文，和现有代码一致；界面文案中英文都要有（`src/renderer/src/strings.ts` 和 `strings-en.ts`），主进程消息走 `M()`，给模型的 prompt 按 `currentLang()` 出中文或英文（同计划 7）。
- 迁移只追加到 `MIGRATIONS` 末尾（迁移 8），不改已有条目。
- `feature_handoffs` 只追加，不更新已有行；唯一的例外是 `covers_until`（只从 NULL 写成一个时间，写一次）。
- `/handoff` 的 feature 代码块信息串正好是 `butler-feature-handoff`；ticket 的 `butler-handoff` 正则不能匹配到它，反之亦然。
- 归属以 Butler 的记录为准：Stop 事件的 session 的 `featureId` 不为空 → feature 汇总；否则走现有的 ticket 逻辑，行为不变。
- "新的 ticket handoff"只算 `trigger != 'refresh'` 且 `degraded = 0` 的（即 `HandoffsRepo.lastCapturedAt` 的口径）。
- 不显示完成百分比；feature 没有自己的状态。
- 个人 API 的 LLM 润色（`narrate`）不接收汇总的文字。
- 每个 task 结束时 `pnpm test`、`pnpm typecheck` 全过、改到的文件 `npx eslint <文件>` 无错再提交（整仓 `pnpm lint` 目前被未提交的 `.claude/worktrees/` 干扰，与本计划无关）。提交信息结尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

- 总控 `/clear` 之后在新 session 里跑 `/handoff`：新 head 继承了 `feature_id`，必须照样存成 feature 汇总。→ Task 3 的测试。
- 总控按习惯输出了 ticket 的 `butler-handoff` 代码块（命令文件还是旧版本）：不存成任何 ticket 的 handoff（总控不属于 ticket，代码块里的 ticket 号也不能"认领"它），但照样触发子 ticket handoff。→ Task 3 的测试。
- feature 下一个 ticket 都没有、或者 ticket 全归档了：手动"立即更新"不报错，照样生成（只靠总控对话）；没有总控 session 也没有 ticket handoff 时返回 skipped（`nothing_to_summarize`），不花额度。→ Task 2 的测试。
- 汇总里的 `next_steps[].ticket` 写了小写、多空格或别的 feature 的 ticket 号：规范成大写后在本 feature 里找，找不到就当 null，文字保留。→ Task 1 的测试。
- 晚间批次被限流：ticket 批次限流后不再跑任何 feature，批次记为 partial，早间补跑。→ Task 4 的测试。

---

### Task 1: 迁移 8、schema、数据层、入库

**Files:**
- Modify: `src/main/db/migrations.ts`、`src/shared/handoff.ts`、`src/shared/types.ts`、`src/main/handoff/schema.ts`
- Create: `src/main/db/feature-handoffs-repo.ts`、`src/main/handoff/feature-ingest.ts`
- Test: `src/main/db/feature-handoffs-repo.test.ts`、`src/main/handoff/feature-ingest.test.ts`、`src/shared/handoff.test.ts`

**Interfaces:**
- Produces（`src/shared/handoff.ts`）：`FeatureHandoffSchema`（字段照设计文档"数据"一节：`summary`、`blockers`、`next_steps: { ticket: string | null; text: string }[]`、`decisions`、`open_questions`），`type FeatureHandoff`。
- Produces（`src/shared/types.ts`）：
  - `type FeatureHandoffTrigger = "nightly" | "manual" | "command"`
  - `interface FeatureHandoffRecord { id: number; featureId: number; sessionId: string | null; trigger: FeatureHandoffTrigger; createdAt: number; coversUntil: number | null; payload: FeatureHandoff | null; degraded: boolean; rawText: string | null; sourceRef: string | null }`
  - `type FeatureHandoffOutcome = { featureId: number; status: "stored"; handoffId: number; degraded: boolean } | { featureId: number; status: "skipped"; reason: "rate_limited" | "no_activity" | "nothing_to_summarize" } | { featureId: number; status: "failed"; reason: string; message: string }`
- Produces（`schema.ts`）：`FEATURE_HANDOFF_JSON_SCHEMA = toCliJsonSchema(FeatureHandoffSchema)`
- Produces（`FeatureHandoffsRepo`）：`insert(h: NewFeatureHandoff): number | null`（`source_ref` 重复返回 null，同 `HandoffsRepo.insert`）、`get(id)`、`listByFeature(featureId, limit = 50)`（新的在前）、`latest(featureId)`、`latestValid(featureId)`、`setCoversUntil(id: number, at: number): void`（只在当前为 NULL 时写）。
- Produces（`feature-ingest.ts`）：
  - `interface FeatureIngestInput { featureId: number; sessionId: string | null; trigger: FeatureHandoffTrigger; payload: FeatureHandoff | null; rawText: string | null; sourceRef?: string | null }`
  - `type FeatureIngestResult = { stored: true; handoffId: number; degraded: boolean } | { stored: false; reason: "no_feature" | "duplicate" }`
  - `ingestFeatureHandoff(d: { features: FeaturesRepo; tickets: TicketsRepo; featureHandoffs: FeatureHandoffsRepo; now: () => number }, input: FeatureIngestInput): FeatureIngestResult`

- [ ] **Step 1: 写失败的测试**
  - 迁移：`migrate` 后有 `feature_handoffs` 表，列照设计文档，另加 `covers_until INTEGER`；迁移 7 的库升级后照常可用。
  - Schema：合法对象通过；`summary: ""` 不通过；`next_steps: [{ ticket: null, text: "x" }]` 通过。
  - Repo：同一 `sourceRef` 插两次第二次返回 null；`latestValid` 跳过 degraded；`setCoversUntil(id, 5)` 后再 `setCoversUntil(id, 9)`，读出来仍是 5。
  - Ingest：feature 不存在 → `{ stored: false, reason: "no_feature" }`；feature 有 ticket `DMS-1234`，payload 的 `next_steps` 为 `[{ ticket: " dms-1234 ", text: "a" }, { ticket: "OTHER-1", text: "b" }]` → 存下来是 `[{ ticket: "DMS-1234", text: "a" }, { ticket: null, text: "b" }]`；payload 为 null → `degraded: true`。
- [ ] **Step 2: `pnpm vitest run src/main/db src/main/handoff/feature-ingest.test.ts src/shared/handoff.test.ts` 确认失败**
- [ ] **Step 3: 实现**。表结构照设计文档"数据（迁移 8）"，加 `covers_until INTEGER`，`feature_id` 上建索引。payload 读不出来按 degraded 处理（同 `HandoffsRepo.toRecord`）。
- [ ] **Step 4: `pnpm test && pnpm typecheck` 通过**
- [ ] **Step 5: 提交** `feat(db): feature_handoffs and the feature summary schema (migration 8)`

### Task 2: FeatureSummaryRunner（生成、手动、候选）

**Files:**
- Create: `src/main/handoff/headless-exec.ts`、`src/main/handoff/feature-runner.ts`、`src/main/handoff/feature-templates.ts`
- Modify: `src/main/handoff/runner.ts`（`exec` 改用 `execHeadlessJson`，行为不变）、`src/main/tickets/ticket-service.ts`
- Test: `src/main/handoff/feature-runner.test.ts`、`src/main/handoff/feature-templates.test.ts`；`runner.test.ts` 不改且全过

**Interfaces:**
- Consumes: Task 1 的 repo、`ingestFeatureHandoff`、`FEATURE_HANDOFF_JSON_SCHEMA`、`FeatureHandoffOutcome`。
- Produces（`headless-exec.ts`）：`execHeadlessJson(d: HeadlessExecDeps, o: { label: string; args: string[]; prompt: string; cwd: string; resumedId?: string }): Promise<{ ok: true; value: unknown; rawText: string } | { ok: false; reason: string; message: string }>`。`HeadlessExecDeps` 是 `HandoffRunnerDeps` 里 `ready`、`claude`、`run`、`baseEnv`、`newRunId`、`timeoutMs`、`signal`、`sessions`、`now`、`log` 这几项。限流时 `reason === "rate_limited"`。headless session 记成 headless 的逻辑（`recordHeadless`）搬进来。
- Produces（`TicketService`）：`featureHeadlessDirs(featureId: number): HeadlessDirs`：`cwd` 是 `featureWorkspaceDir(featureId)`；`repoDirs` 是 feature 下未归档 ticket 的所有 `workDir`；`addDirs` 是其中不在工作区里、目录存在的（去重，同 `SessionService.featureAddDirs` 的规则，可以把共用部分抽出来）。
- Produces（`feature-templates.ts`）：`defaultFeatureHandoffPrompt(l: Lang): string`（占位符 `{{feature}}`、`{{previous}}`、`{{tickets}}`），`featureHandoffSchemaDoc(l)`、`featureHandoffExample(l)`，`renderFeatureTickets(rows: FeatureTicketContext[], l: Lang): string`，`interface FeatureTicketContext { key: string; title: string | null; status: TicketStatus; prs: Pr[]; latest: Handoff | null }`。
- Produces（`FeatureSummaryRunner`）：
  - `constructor(d: FeatureRunnerDeps)`，deps：`features`、`tickets`、`sessions`、`handoffs`、`featureHandoffs`、`settings`、`ingest: (i: FeatureIngestInput) => FeatureIngestResult`、`ticketRunner: Pick<HandoffRunner, "candidates" | "runManual">`、`dirs: (featureId: number) => HeadlessDirs`、`transcriptMtime`、`projectMcp?`，以及 `HeadlessExecDeps` 的各项。
  - `candidates(): number[]`
  - `runNightly(): Promise<{ status: "ok" | "partial"; outcomes: FeatureHandoffOutcome[] }>`
  - `runManual(featureId: number): Promise<FeatureHandoffOutcome>`
  - `runChildren(featureId: number): Promise<HandoffOutcome[]>`：feature 下属于 `ticketRunner.candidates()` 的 ticket 各 `runManual`。
  - `afterCommand(featureId: number, handoffId: number | null): Promise<void>`：`runChildren`，然后有 `handoffId` 时 `setCoversUntil(handoffId, now())`。

- [ ] **Step 1: 写失败的测试**（假 `run` 返回预设 JSON，同 `runner.test.ts` 的写法）
  - `candidates`：(a) 总控 session 的 transcript 修改时间晚于最新有效汇总的 `createdAt` → 是候选；(b) 只有子 ticket 的 `lastCapturedAt` 晚于最新有效汇总的 `coversUntil ?? createdAt` → 是候选；(c) 子 ticket 只有晚于汇总的 `refresh` handoff → 不是；(d) 子 ticket handoff 的时间早于 `coversUntil` → 不是；(e) 从没有汇总、有总控 transcript → 是；(f) 已归档的 feature → 不是。
  - `runNightly`：只跑候选；第一个 feature 返回限流后剩下的记 `skipped / rate_limited`，`status: "partial"`。
  - 生成：有总控 session 时 args 含 `--resume <最近的那个> --fork-session`，cwd 是工作区，`--add-dir` 是工作区外的仓库；没有总控 session 时 args 不含 `--resume`；prompt 里有每个 ticket 的号、PR 和最新 handoff 的 `next_steps`；第一次输出校验失败、重试成功 → 存有效的；两次都失败 → 存 degraded。
  - `runManual`：先对有活动的子 ticket 调 `ticketRunner.runManual`（断言调用顺序在 headless 生成之前），trigger 记 `manual`；没有总控 session 且没有任何有效 ticket handoff → `skipped / nothing_to_summarize`，`run` 没被调用；同一个 feature 并发两次只跑一次（共用 promise）。
  - `afterCommand(id, 7)`：子 ticket 跑完后 `coversUntil` 被写成 `now()`；`afterCommand(id, null)` 不写。
  - `renderFeatureTickets`：中英文各一个快照式断言（包含 ticket 号、PR `#455 open`、next step 文字）。
- [ ] **Step 2: `pnpm vitest run src/main/handoff` 确认新测试失败、`runner.test.ts` 仍通过**
- [ ] **Step 3: 实现**。先抽 `execHeadlessJson`（`runner.test.ts` 必须原样通过），再写 `FeatureSummaryRunner`。resume 目标：`sessions.listByFeature(id)` 里第一个没被替换、没隐藏、有 transcript 的（同 `HandoffRunner.resumeTarget`）。`allowedTools` 和 `mcpConfigs` 照 `HandoffRunner`。并发：feature 之间串行（ticket 子任务仍受 `HANDOFF_CONCURRENCY` 约束）。prompt 文案：说明这是给 feature 页"整体进度"用的、只写跨 ticket 的情况、提到 ticket 只写 ticket 号、不要百分比、只读不改文件。
- [ ] **Step 4: `pnpm test && pnpm typecheck` 通过**
- [ ] **Step 5: 提交** `feat: FeatureSummaryRunner — nightly and manual feature summaries`

### Task 3: 总控里的 `/handoff`

**Files:**
- Modify: `src/main/handoff/templates.ts`、`src/main/handoff/schema.ts`、`src/main/handoff/transcript.ts`、`src/main/handoff/capture.ts`
- Test: `src/main/handoff/capture.test.ts`、`src/main/handoff/schema.test.ts`、`src/main/handoff/command.test.ts`、`src/main/i18n-prompts.test.ts`（如有覆盖命令正文的断言）

**Interfaces:**
- Consumes: Task 1 的 `FeatureIngestInput / FeatureIngestResult`。
- Produces（`schema.ts`）：`extractFeatureHandoffBlock(text: string): string | null`（最后一个非空的 ` ```butler-feature-handoff ` 代码块）。
- Produces（`transcript.ts`）：`findFeatureHandoffBlock(turn: AssistantText[]): FoundHandoff | null`。
- Produces（`capture.ts`）：`CaptureDeps` 加 `ingestFeature: (i: FeatureIngestInput) => FeatureIngestResult` 和 `afterFeatureCommand: (featureId: number, handoffId: number | null) => void`；返回类型改为 `IngestResult | FeatureCaptureResult | null`，`type FeatureCaptureResult = { featureId: number } & (FeatureIngestResult | { stored: false; reason: "no_block" | "wrong_block" })`。

- [ ] **Step 1: 写失败的测试**
  - 正则：` ```butler-feature-handoff ` 不被 `extractHandoffBlock` 匹配，` ```butler-handoff ` 不被 `extractFeatureHandoffBlock` 匹配。
  - capture：session `featureId: 3`（`ticketKey: null`），这一轮是 `/handoff`、有 feature 代码块 → `ingestFeature` 收到 `{ featureId: 3, trigger: "command", sessionId }`，`afterFeatureCommand(3, <id>)` 被调用一次。
  - capture：同上但代码块是 `butler-handoff` 且写了存在的 ticket 号 → 不调 `ingest`、不调 `ingestFeature`，返回 `{ featureId: 3, stored: false, reason: "wrong_block" }`，`afterFeatureCommand(3, null)` 被调用。
  - capture：feature 总控里一直没有代码块（重试用完）→ `reason: "no_block"`，`afterFeatureCommand(3, null)` 被调用。
  - capture：`/clear` 之后的新 head（`featureId` 继承为 3）→ 同第一条。
  - capture：普通 ticket session 的现有测试全部原样通过。
  - 命令正文：中英文正文都包含 `butler-feature-handoff` 和 `list_tickets`；`handoffCommandStatus` 对上一版正文返回 `stale`。
- [ ] **Step 2: `pnpm vitest run src/main/handoff src/main/i18n-prompts.test.ts` 确认失败**
- [ ] **Step 3: 实现**。命令正文（中英文）加一段：能调用 `butler-sessions` 的 `list_tickets` 工具时，说明这是 feature 总控，先用它看各 ticket，再输出 ` ```butler-feature-handoff ` 代码块（字段用 `featureHandoffSchemaDoc`、示例用 `featureHandoffExample`），不输出 `butler-handoff`；否则照旧。capture 先看 `d.sessions.get(stop.sessionId)?.featureId`，不为空就走 feature 分支（同样的重试等待），`sourceRef` 规则同 ticket。
- [ ] **Step 4: `pnpm test && pnpm typecheck` 通过**
- [ ] **Step 5: 提交** `feat: /handoff in a feature coordinator writes the feature summary`

### Task 4: 接进主进程：晚间任务、采集、记忆

**Files:**
- Modify: `src/main/schedule/daily-jobs.ts`、`src/main/memory/memory-service.ts`、`src/main/index.ts`
- Test: `src/main/schedule/daily-jobs.test.ts`、`src/main/memory/memory-service.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `FeatureSummaryRunner`，Task 3 的 `CaptureDeps`。
- Produces（`DailyJobDeps`）：`features?: Pick<FeatureSummaryRunner, "runNightly">`。
- Produces（`MemoryService`）：deps 加 `features: Pick<FeaturesRepo, "get" | "list">`、`featureHandoffs: Pick<FeatureHandoffsRepo, "listByFeature">`；`syncFeature(featureId: number): Promise<void>`（进同一个队列）；`syncAll` 也同步未归档的 feature。

- [ ] **Step 1: 写失败的测试**
  - `nightlyJob`：`runNightly` 之后、`generateEvening` 之前调用 `features.runNightly`；ticket 批次的 outcomes 里有 `rate_limited` 时不调用 `features.runNightly`，返回 `"partial"`；feature 批次 partial 时返回 `"partial"`；没传 `features` 时行为和现在一样。
  - `syncFeature(3)`：在 `featureScope(3)` 写一次 StateCore `handoff`（summary、next_steps 的文字、open_questions）；`decisions` 按 key 变成 note，再同步一份去掉了某个 key 的汇总后，那条 note 被 forget；游标用 `featureScope(3)` 作 key，第二次同步没有新汇总时不再写 `handoff`；记忆关掉时什么都不做。
- [ ] **Step 2: `pnpm vitest run src/main/schedule src/main/memory` 确认失败**
- [ ] **Step 3: 实现**。`index.ts`：建 `FeatureHandoffsRepo` 和 `FeatureSummaryRunner`（`dirs: (id) => ticketService.featureHeadlessDirs(id)`）；`ingestFeature` 入库有效汇总后 `void memory.syncFeature(id)` 并 `notify()`；采集处传 `ingestFeature` 和 `afterFeatureCommand: (id, hid) => void featureRunner.afterCommand(id, hid).then(notify, (e) => logger(...))`；`wrong_block` / `no_block` 各记一行日志；把 `featureRunner` 交给 `nightlyJob` 的 deps。
- [ ] **Step 4: `pnpm test && pnpm typecheck` 通过**
- [ ] **Step 5: 提交** `feat: feature summaries in the nightly job, /handoff capture and feature memory`

### Task 5: IPC 和 FeatureView

**Files:**
- Modify: `src/shared/types.ts`、`src/shared/ipc.ts`、`src/main/ipc/register.ts`、`src/main/sessions/session-service.ts`、`src/preload/index.ts`、`src/renderer/src/api.ts`
- Test: `src/shared/ipc.test.ts`、`src/main/sessions/feature-sessions.test.ts`

**Interfaces:**
- Produces（`FeatureView` 新字段）：`summary: FeatureHandoffRecord | null`（最新一条，可能 degraded）；`ticketPrs: Record<string, Pr[]>`（每个 ticket 取 `handoffs.latestValid(key)?.payload?.prs ?? []`）。
- Produces（IPC）：`IPC.featuresSummaryRun = "features:summaryRun"`，参数 `{ featureId: number }`，返回 `FeatureHandoffOutcome`；`api.runFeatureSummary(featureId: number): Promise<FeatureHandoffOutcome>`。`SessionServiceDeps` 加 `featureHandoffs?: Pick<FeatureHandoffsRepo, "latest">` 和 `handoffs?: Pick<HandoffsRepo, "latestValid">`。

- [ ] **Step 1: 写失败的测试**：`featureViews()` 里 `summary` 是最新一条（degraded 也返回），`ticketPrs["DMS-1234"]` 来自最新的有效 handoff（包括 refresh），没有 handoff 的 ticket 是 `[]`；IPC 通道在允许列表里、参数校验拒绝非整数 `featureId`。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**（`register.ts` 调 `featureRunner.runManual`，完成后 `notify()`）
- [ ] **Step 4: `pnpm test && pnpm typecheck` 通过**
- [ ] **Step 5: 提交** `feat(ipc): feature summary in FeatureView, run it on demand`

### Task 6: 界面：feature 页和简报

**Files:**
- Modify: `src/renderer/src/components/FeaturePage.tsx`、`src/renderer/src/components/TicketOverview.tsx`（把 `prLabel` 挪到共享位置）、`src/renderer/src/components/BriefPage.tsx`、`src/renderer/src/App.tsx`（把 `features` 传给简报页）、`src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`、样式文件
- Create: `src/renderer/src/feature-summary-view.ts`（纯函数，便于测试）
- Test: `src/renderer/src/feature-summary-view.test.ts`、`src/renderer/src/strings.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `FeatureView.summary`、`ticketPrs`、`api.runFeatureSummary`。
- Produces（`feature-summary-view.ts`）：
  - `firstSentence(text: string): string`：到第一个 `。！？.!?`（含）或换行为止，最长 80 个字符。
  - `groupByFeature<T extends { ticketKey: string }>(entries: T[], tickets: TicketView[], features: FeatureView[]): { feature: FeatureView | null; entries: T[] }[]`：保持原顺序，feature 组按第一次出现的位置排，不属于 feature 的放在 `feature: null` 的组。
  - `prPill(pr: Pr): "merged" | "approved" | "changes" | "pending" | "closed"`。

- [ ] **Step 1: 写失败的测试**：`firstSentence("后端已合并。前端在等 review")` → `"后端已合并。"`；`firstSentence("Backend merged. Frontend")` → `"Backend merged."`；`groupByFeature` 两个 feature 交错的条目分成两组且组内顺序不变；`prPill` 覆盖五种；新文案在 `S` 和英文表里都存在（`strings.test.ts` 的现有一致性检查）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
  - feature 页顺序照设计文档"feature 页"一节：标题和工作区 → 整体进度（汇总那段话；"卡住"用醒目颜色；"下一步"列表，带 ticket 号的可点；小字时间和来源"晚间自动 / 总控 /handoff / 手动更新"；"立即更新"按钮，运行中禁用并显示"更新中…"，失败显示原因；没有汇总时的提示；degraded 时显示原文和"汇总不完整"）→ ticket 表（原 ticket 列表加 PR 标签，没有 PR 显示"还没有 PR"，"+ 新建 ticket"留在这里）→ 仓库、总控 session、终端。
  - 简报：早间分区不变，属于 feature 的条目前加 feature 名小标签；"上个工作日"和晚间按 `groupByFeature` 分组，组标题是 feature 名加 `firstSentence(summary.payload.summary)`。旧简报（没有 feature 的 ticket）照常显示。
- [ ] **Step 4: `pnpm test && pnpm typecheck` 通过，`pnpm dev` 里手动看一眼 feature 页在中英文下的样子**
- [ ] **Step 5: 提交** `feat(ui): feature summary and the ticket/PR table on the feature page; briefs grouped by feature`

### Task 7: E2E

**Files:**
- Modify: `e2e/fake-claude/fake-claude.cjs`（支持输出 `butler-feature-handoff` 代码块、headless 时按 `--json-schema` 返回 feature 汇总）、`e2e/features.spec.ts`
- Docs: `README.md` / `docs/configuration.md` 里讲 `/handoff` 和 feature 的地方补一句

- [ ] **Step 1: 写 e2e**：建 feature（两个仓库）→ 建两个 ticket → 开总控 → 假 claude 在总控里完成一轮 `/handoff`，输出 feature 代码块 → feature 页出现汇总那段话、"卡住"和"下一步" → ticket 表里显示两个 ticket 的 PR 标签（预先给一个 ticket 写入带 PR 的 handoff）→ 有活动的子 ticket 出现新的 handoff → 点"立即更新"，汇总的来源变成"手动更新"。
- [ ] **Step 2: `pnpm e2e -- features.spec.ts` 通过**；`pnpm e2e` 全部通过
- [ ] **Step 3: 更新文档，提交** `test(e2e): feature summary end to end; docs`
