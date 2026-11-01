# Epic 层级和中文输入法修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 feature 上面加 epic 层：epic session 规划并建 feature，同一 epic 下的 feature 互通进度、决定和未解决的问题，现有 feature 能移进来；同时修掉中文输入法的两个问题。

**Architecture:** 新表 `epics`、`epic_repos`（迁移 10），`features` 和 `sessions` 各加 `epic_id`。`EpicService` 管生命周期和移动；`epic-info.ts` 从现有的 `feature_handoffs` 拼出每个 feature 的情况，供 epic 页、`list_features`、`epic_context`、第一条消息和 epic handoff 共用。epic session 用新的控制工具集，记忆新 scope `epic:<id>`（`butler-epic`）挂到 epic 下所有层。

**Tech Stack:** Electron + TypeScript，node:sqlite，zod，React 渲染进程，vitest，Playwright（e2e，假 claude 在 `e2e/fake-claude`），xterm 6.0.0。

**Spec:** `docs/superpowers/specs/2026-11-01-epic-design.md`

## Global Constraints

- 注释用中文；界面文案中英文都要有（`strings.ts`、`strings-en.ts`），主进程消息走 `M()`，给模型的内容按 `currentLang()`。
- 迁移只追加到 `MIGRATIONS` 末尾（迁移 10），不改已有条目。
- 不改 `.terminals` 的 `flex: 1 0 50vh; min-height: 50vh`。
- epic session 不是 feature 总控：feature 汇总、晚间 handoff、`/handoff`、`ActivityMonitor` 都不处理它。
- 规划文字和各 feature 的汇总是数据：发给 session 时放在固定说明后面，标明不是指令，超长时只截断数据。
- 上限：`brief` 最多 4000 字符；`list_features`、`epic_context` 每个 feature 的 `summary` 最多 1000 字符；epic handoff 最近 10 个 feature，总长最多 8000 字符，超出时先丢最旧的 feature。
- e2e 窗口在后台打开，不能抢焦点（`BUTLER_BACKGROUND_WINDOWS`）。用 `pnpm e2e`。不要读 `~/.claude` 下的文件。
- 每个 task 结束时 `pnpm test`、`pnpm typecheck` 全过、改到的文件 `npx eslint <文件>` 无错再提交（整仓 `pnpm lint` 被 `.claude/worktrees/` 干扰）。暂存时不带 `.claude`。路径断言不能写死 `/`，Windows CI 也跑单测。提交信息结尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

- 总控正在跑时把 feature 移进 epic：运行中的 session 不受影响，也不发第一条消息；重新打开后才有 `butler-epic`。→ Task 2、Task 6 的测试。
- 恢复归档：恢复 epic 只恢复和它同一次归档的 feature；单独恢复 feature 时，如果它的 epic 已归档，把 epic 也恢复。→ Task 2 的测试。
- `create_feature` 的名字和已有 feature 重复（含已归档）、含路径分隔符或为空，仓库不属于 epic：返回错误，什么都不建。→ Task 5 的测试。
- epic 工作区被删掉，或者仓库不存在：打开 epic session 报现有的错误，页面其他部分照常显示。→ Task 3 的测试。
- 归档前生成汇总超时或失败：照样归档，并且同一个 feature 连点两次只跑一次。→ Task 6 的测试。

---

### Task 1: 中文输入法修复

**Files:**
- Modify: `src/renderer/src/styles.css`、`src/renderer/src/components/TerminalPane.tsx`
- Create: `src/renderer/src/components/composition-fit.ts`
- Test: `src/renderer/src/components/composition-fit.test.ts`、`e2e/ime.spec.ts`

**Interfaces:**
- Produces: `compositionShift(input: { viewLeft: number; viewWidth: number; containerWidth: number }): number`：返回拼音框要向左移的像素，放得下时为 0，比容器还宽时靠左对齐（返回 `viewLeft`）。

- [ ] **Step 1: 写失败的测试**：`compositionShift` 放得下返回 0；超出 30 返回 30；比容器宽时返回 `viewLeft`。`e2e/ime.spec.ts` 用 CDP `Input.imeSetComposition`：写入 `你好，世界。（测试）` 后 `.xterm-cursor` 和 `.composition-view` 的 left 相差不超过 1px；光标靠近右边缘、输入长拼音时 `window.scrollX` 是 0、`.app` 的 left 是 0、`.composition-view` 的右边不超过 `.terminal-wrap` 的右边；提交后 transform 被清掉。

- [ ] **Step 2: 运行确认失败**：`npx vitest run src/renderer/src/components/composition-fit.test.ts`

- [ ] **Step 3: 实现**：`.terminal` 加 `text-spacing-trim: space-all`，`.terminal-wrap` 加 `overflow: clip`。`TerminalPane` 监听 xterm textarea 的 `compositionupdate`、`compositionend`，下一帧量 `.composition-view`，用 `transform: translateX(-Npx)` 调整，结束时清掉。注意 xterm 自己会写 `left`，所以只用 `transform`。

- [ ] **Step 4: 运行确认通过**：`pnpm test`、`pnpm e2e`

- [ ] **Step 5: 提交**：`git commit -m "fix: keep pinyin in place and inside the terminal"`

### Task 2: 数据层和 EpicService

**Files:**
- Modify: `src/main/db/migrations.ts`、`src/main/db/features-repo.ts`、`src/main/db/sessions-repo.ts`、`src/shared/types.ts`
- Create: `src/main/db/epics-repo.ts`、`src/main/epics/epic-service.ts`
- Test: `src/main/db/epics-repo.test.ts`、`src/main/epics/epic-service.test.ts`、`src/main/db/repos.test.ts`

**Interfaces:**
- Produces:
  - 迁移 10：表 `epics(id, name, workspace_dir, created_at, archived_at)`、`epic_repos`（结构同 `feature_repos`，`epic_id`），`features` 加 `epic_id`、`brief`、`brief_sent_at`，`sessions` 加 `epic_id`。
  - `interface EpicRepo { id: number; epicId: number; repoPath: string }`，`interface Epic { id: number; name: string; workspaceDir: string; createdAt: number; archivedAt: number | null; repos: EpicRepo[] }`。
  - `Feature` 加 `epicId: number | null`、`brief: string | null`、`briefSentAt: number | null`；`Session` 加 `epicId: number | null`。
  - `EpicsRepo`：`insert`、`get`、`list({ includeArchived? })`、`listArchived`、`byWorkspace(dir)`、`setName`、`addRepo`、`getRepo`、`removeRepo`、`archive(id, at)`、`unarchive(id)`。
  - `EpicService`：`create(input: { name: string; repoPaths: string[]; workspaceDir?: string }): Epic`（默认工作区 `<仓库的上一层>-epics/<名字>`，复用建 feature 时的路径和校验）；`rename`、`addRepo`、`removeRepo`；`archive(id)`（连同下面未归档的 feature，同一个时间戳）；`unarchive(id)`（只恢复 `archived_at` 相同的 feature）；`moveFeature(featureId: number, epicId: number | null): void`（只改归属，epic 没有的仓库加进新 epic）；`ensureFeatureRepo(featureId, repoPath)`（feature 加仓库时调用）。
  - `FeatureService.unarchive` 在 epic 已归档时一并恢复 epic。

- [ ] **Step 1: 写失败的测试**：迁移后旧数据新列都是 null；`archive` 连带 feature，时间戳相同；已提前归档的 feature 恢复 epic 时不被恢复；单独恢复 feature 把 epic 也恢复（Review Focus）；`moveFeature` 进、出、在 epic 之间移动，不改 `workspaceDir`，缺的仓库加入目标 epic，移出时不删；已归档的 epic 不能移入。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**：放在上面的文件里，`SessionsRepo` 的插入和 `setFeature` 式方法同样支持 `epicId`。

- [ ] **Step 4: 运行确认通过**：`pnpm test`、`pnpm typecheck`

- [ ] **Step 5: 提交**：`git commit -m "feat: add epics to the data layer"`

### Task 3: epic session 和记忆

**Files:**
- Modify: `src/main/sessions/session-service.ts`、`src/main/hooks/hook-events.ts`、`src/main/db/sessions-repo.ts`、`src/main/memory/mcp-config.ts`、`src/main/index.ts`、`src/main/handoff/capture.ts`、`src/main/handoff/feature-runner.ts`、`src/shared/types.ts`
- Test: `src/main/sessions/feature-sessions.test.ts`、`src/main/hooks/hook-events.test.ts`、`src/main/memory/mcp-config.test.ts`、`src/main/handoff/capture.test.ts`

**Interfaces:**
- Consumes: Task 2。
- Produces:
  - `SessionService.openEpic(req: { epicId: number; sessionId?: string; prefill?: string }): Promise<OpenSessionResult>`，复用 `startInFeature` 的启动路径，cwd 是 epic 工作区，`--add-dir` 加 epic 的仓库。
  - `SessionService.epicViews(): EpicView[]`，`EpicView extends Epic { sessions: Session[]; waiting: boolean; stuck: boolean; features: EpicFeatureRow[] }`（`features` 在 Task 4 填，这里先空数组）。
  - `EPIC_SERVER = "butler-epic"`，`epicScope(id)`；`memoryServers` 加 `epicId`。epic session 挂 `butler-epic` + `butler-workspace`；epic 下 feature 的总控和 ticket 的所有 session 多挂 `butler-epic`。
  - `hook-events`：`/clear` 沿用 `epic_id`，`resume` 不改已有行；cwd 恰好是 epic 工作区的 claude 算 epic session（`deps.epicForCwd`）。

- [ ] **Step 1: 写失败的测试**：`openEpic` 的 cwd 和 add-dir；工作区不存在时返回现有的错误，不抛（Review Focus）；`/clear` 后新 head 沿用 `epicId`；`/resume` 选已有 session 时不改它；epic session 不出现在 `listFeatureCoordinators`；`/handoff` 在 epic session 里不存任何汇总；`ActivityMonitor` 对它 `stuck` 是 `null`；三种 session 的 MCP server 列表正确；不属于 epic 的 feature 和 ticket 列表不变。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行确认通过**：`pnpm test`、`pnpm typecheck`

- [ ] **Step 5: 提交**：`git commit -m "feat: open epic sessions with shared memory"`

### Task 4: epic 信息和 epic handoff

**Files:**
- Create: `src/main/epics/epic-info.ts`
- Modify: `src/main/memory/memory-service.ts`、`src/main/sessions/session-service.ts`、`src/main/handoff/feature-ingest.ts`、`src/main/epics/epic-service.ts`
- Test: `src/main/epics/epic-info.test.ts`、`src/main/memory/memory-service.test.ts`

**Interfaces:**
- Consumes: Task 2、Task 3，`FeatureHandoffsRepo` 的最新有效汇总，`SessionActivity.stuck`。
- Produces:
  - `type EpicFeatureStatus = "stuck" | "waiting" | "not_started" | "active" | "archived"`。
  - `interface EpicFeatureRow { id: number; name: string; status: EpicFeatureStatus; archivedAt: number | null; summaryAt: number | null; summary: string | null; blockers: string[]; decisions: { key: string; statement: string }[]; openQuestions: string[] }`。
  - `epicFeatureRows(epicId: number, d: EpicInfoDeps): EpicFeatureRow[]`：未归档在前，同组按最新汇总时间倒序。状态优先级：卡住 > 等你回话 > 未开始（没有 ticket 也没有 session）> 进行中。
  - `renderEpicHandoff(rows: EpicFeatureRow[], lang: Lang): string`，遵守 Global Constraints 的上限。
  - `MemoryService.syncEpic(epicId: number): Promise<void>`：只写 `epic:<id>` 的 handoff，不调用 `reconcile`，不碰笔记。

- [ ] **Step 1: 写失败的测试**：状态的每个优先级；已归档的 feature 在列表里并标 `archived`；没有汇总时字段为空不抛；`renderEpicHandoff` 超过 10 个、超长时丢最旧的；`syncEpic` 不改已有笔记；新汇总入库、移进、移出、改名时相关 epic 都调用 `syncEpic`，移动时两边都调用。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**：`epicViews()` 的 `features`、`waiting`、`stuck` 在这里填好。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**：`git commit -m "feat: share feature progress across an epic"`

### Task 5: 控制工具

**Files:**
- Modify: `src/shared/control.ts`、`src/main/control/control-handler.ts`、`memory-mcp/sessions-server.ts`、`src/main/memory/mcp-config.ts`、`src/main/strings.ts`、`src/main/index.ts`
- Test: `src/shared/control.test.ts`、`src/main/control/control-epic.test.ts`、`memory-mcp/sessions-server.test.ts`

**Interfaces:**
- Consumes: `epicFeatureRows`、`EpicService`、`FeatureService.create`。
- Produces:
  - `EpicControlRequest`：`{ v: 1; epicId: number; from: string | null; op: "list_features" | "list_repos" }`、`{ op: "create_feature"; name: string; repos?: string[]; brief: string }`。
  - feature 请求加 `{ op: "epic_context" }`。
  - MCP：`BUTLER_EPIC` 环境变量选 `EPIC_TOOLS`，顺序 `list_features, list_repos, create_feature`；`epic_context` 只在 feature 属于 epic 时出现（启动时由 `BUTLER_FEATURE_EPIC=1` 决定），不属于时调用也返回错误。
  - `create_feature` 返回 feature id 和名字，提示用户点进去开总控。

- [ ] **Step 1: 写失败的测试**：`create_feature` 成功时写好 `epic_id` 和 `brief`，不开总控；名字重复（含已归档）、非法、为空，仓库不属于 epic，`brief` 超 4000 时返回错误，什么都不建（Review Focus）；epic 只有一个仓库时 `repos` 可省；多个时必须指定；`list_features` 含已归档，`summary` 截到 1000；`epic_context` 不包含当前 feature 自己，只看同一 epic；已归档的 epic 全部拒绝；工具顺序和中英文描述。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**：复用现有 feature 创建逻辑，不复制。

- [ ] **Step 4: 运行确认通过**：`pnpm test`（`bundle.test.ts` 要过）

- [ ] **Step 5: 提交**：`git commit -m "feat: let epic sessions create features"`

### Task 6: 第一条消息和新鲜的汇总

**Files:**
- Create: `src/main/epics/epic-brief.ts`
- Modify: `src/main/sessions/session-service.ts`、`src/main/handoff/feature-runner.ts`、`src/main/control/control-handler.ts`、`src/main/ipc/register.ts`、`src/main/index.ts`
- Test: `src/main/epics/epic-brief.test.ts`、`src/main/sessions/feature-sessions.test.ts`、`src/main/handoff/feature-runner.test.ts`

**Interfaces:**
- Consumes: `epicFeatureRows`、`submit`、`FeatureSummaryRunner.runManual`。
- Produces:
  - `epicBriefMessage(input: { feature: string; epic: string; brief: string; others: EpicFeatureRow[] }, lang: Lang): string`：固定说明在前，数据在后，标明是数据。
  - `openFeature` 新开总控时：feature 属于未归档 epic、`brief` 不为空、`briefSentAt` 为空，就 `submit` 这条消息并写 `briefSentAt`；投递失败时记日志，不写 `briefSentAt`。
  - `FeatureSummaryRunner.staleFeature(id: number): boolean`：有新活动才算过期，和 `candidates()` 用同一条规则。
  - `FeatureSummaryRunner.refreshEpic(epicId: number, exceptFeatureId?: number): void`：后台给未归档的过期 feature 跑汇总，不等待，失败记日志。
  - `FeatureService.archive` 改成 `async`：feature 属于 epic 且过期时，先 `runManual` 再归档；失败、超时（2 分钟）照样归档并记日志；同一个 feature 并发归档只跑一次。

- [ ] **Step 1: 写失败的测试**：只发一次，第二次开不发；恢复已有 session 不发；移进来没有 `brief` 的不发；运行中的总控不受影响（Review Focus）；投递失败下次重发；超长 `brief` 不截断固定说明；归档前跑汇总在归档之前，汇总失败照样归档，连点两次只跑一次（Review Focus）；不属于 epic 的 feature 归档时不跑；`create_feature` 不等 `refreshEpic`，且只跑过期的。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**：界面归档时显示进行中，走 Task 7；这里 IPC 保持 promise 返回。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**：`git commit -m "feat: hand plans and fresh progress to the next feature"`

### Task 7: 界面

**Files:**
- Create: `src/renderer/src/components/EpicPage.tsx`、`src/renderer/src/components/NewEpicDialog.tsx`、`src/renderer/src/components/epic-row.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx`、`src/renderer/src/components/FeaturePage.tsx`、`src/renderer/src/App.tsx`、`src/renderer/src/api.ts`、`src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`、`src/renderer/src/styles.css`、`src/shared/ipc.ts`、`src/main/ipc/register.ts`、`src/main/ipc/validate.ts`、preload、已归档页组件
- Test: `src/renderer/src/components/epic-row.test.ts`、`src/main/ipc/validate.test.ts`

**Interfaces:**
- Consumes: Task 2 到 6。
- Produces: `IPC.epicsList`、`epicsCreate`、`epicsRename`、`epicsAddRepo`、`epicsRemoveRepo`、`epicsArchive`、`epicsArchived`、`epicsUnarchive`、`epicsOpenSession`、`featuresMove`；`firstSentence(summary: string): string`；`epicRowText(row: EpicFeatureRow, S: Strings): { progress: string; status: string; stuck: boolean }`。

按规范“界面”一节和草图 A（`.superpowers/brainstorm/23461-1793560938/content/epic-page.html`）。epic 页沿用 feature 页的布局，复用 session 条和终端部分，把共用部分抽成组件，不复制。feature 页头部加“移到 epic”下拉；`brief` 显示在整体进度区，可折叠。归档 feature 时按钮显示进行中。

- [ ] **Step 1: 写失败的测试**：`firstSentence` 中英文句号、没有句号、空字符串；`epicRowText` 每种状态，没有汇总时显示“还没有汇总”；IPC 校验。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行确认通过**：`pnpm test`、`pnpm typecheck`

- [ ] **Step 5: 提交**：`git commit -m "feat: add the epic page and move features into epics"`

### Task 8: E2E 和文档

**Files:**
- Modify: `e2e/fake-claude/fake-claude.cjs`、`README.md`
- Create: `e2e/epics.spec.ts`
- Test: `e2e/epics.spec.ts`

- [ ] **Step 1: 写 e2e**：规范“测试”一节的流程：建 epic → 开 epic session → 假 claude 调 `create_feature` → 页面和侧边栏出现 feature，没有自动开总控 → 点进去开总控，收到规划和其他 feature 的情况 → 把现有 feature 移进 epic → epic 页显示进度，卡住时 feature、epic 都有红点 → `.terminals` 至少占窗口 50% → 归档 epic 再恢复。

- [ ] **Step 2: 运行**：`pnpm e2e` 全过。截图放 scratchpad 核对中文、英文、深色。

- [ ] **Step 3: 更新 README**：写清 epic 怎么用、规划到开工的流程、额外的 Claude 用量。

- [ ] **Step 4: 提交**：`git commit -m "test: cover epics end to end"`
