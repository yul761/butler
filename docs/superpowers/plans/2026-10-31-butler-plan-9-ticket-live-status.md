# Ticket 实时状态和卡住处理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** feature 页的 ticket 行显示 session 此刻在干什么；卡住时标红点、发通知，展开面板后一键在 feature 层开修复 session；总控能直接查到实时状态。

**Architecture:** 主进程新增 `ActivityMonitor`：每 10 秒增量读取运行中 session 的 transcript，用纯函数状态机算出活动，再读 Claude Code 的命令输出文件。每 3 分钟做一次本地检查（transcript、输出文件、子进程 CPU），连续两次没变化时调用一次 headless Claude 判断。结果放在内存里，经 `FeatureView` 给界面，经 `list_sessions` 和新工具 `session_activity` 给总控。修复 session 用迁移 9 的 `fixes_session` 标记，不被当成总控。

**Tech Stack:** Electron + TypeScript，node:sqlite，zod，React 渲染进程，vitest，Playwright（e2e，假 claude 在 `e2e/fake-claude`）。

**Spec:** `docs/superpowers/specs/2026-10-31-ticket-live-status-design.md`

## Global Constraints

- 注释用中文，和现有代码一致；界面文案中英文都要有（`src/renderer/src/strings.ts` 和 `strings-en.ts`），主进程消息走 `M()`，给模型的 prompt 按 `currentLang()` 出中文或英文。
- 迁移只追加到 `MIGRATIONS` 末尾（迁移 9），不改已有条目。
- 所有读 Claude Code 内部文件的地方：文件不存在、格式不对、权限不够都不能抛错，退回只显示命令和时长。
- 卡住状态只存内存。
- 检测范围：只检测 feature 下 ticket 的 session；其他 session 的 `stuck` 是 `null`。
- 参数：活动刷新 10 秒；本地检查 3 分钟；连续 2 次没变化算可疑；`stuck: false` 后 10 分钟内不再调用；子进程 CPU 变化至少 2 秒才算有变化；面板最后输出最多 6 行；`session_activity` 的输出上限 4KB；命令文字最多 40 个字符。
- 不改 `.terminals` 的 `flex: 1 0 50vh; min-height: 50vh`。
- e2e 窗口在后台打开，不能抢焦点（`BUTLER_BACKGROUND_WINDOWS`）。用 `pnpm e2e`，不要直接 `npx playwright test`。
- 每个 task 结束时 `pnpm test`、`pnpm typecheck` 全过、改到的文件 `npx eslint <文件>` 无错再提交（整仓 `pnpm lint` 被 `.claude/worktrees/` 干扰）。暂存时不要带上 `.claude`。提交信息结尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

- 电脑睡了一觉：醒来时距上次检查远超 3 分钟，transcript 和进程都没变化。不能算“没动静”：两次检查间隔超过 6 分钟时计数清零。→ Task 3 的测试。
- 用户在卡住的 session 里 `/clear`，或者 session 退出：红点和面板要消失，不能留在旧 id 上。→ Task 4 的测试。
- 用户连点两次“开新 session 解决”：只开一个修复 session，第二次打开已有的那个。→ Task 6 的测试。
- Butler 在一个长后台命令运行中重启：从 transcript 尾部 4MB 重建，后台命令还能显示；开始记录在 4MB 之外时不报错，退回按当前轮次显示。→ Task 2 的测试。
- 输出文件里有 ANSI 颜色、进度条的 `\r`、半行 UTF-8：面板显示干净的文字，不乱码。→ Task 2 的测试。

---

### Task 1: 活动类型和 transcript 状态机

**Files:**
- Create: `src/shared/activity.ts`、`src/main/sessions/activity-parse.ts`
- Test: `src/main/sessions/activity-parse.test.ts`

**Interfaces:**
- Produces:
  - `src/shared/activity.ts`：
    ```ts
    export type ActivityKind = "edit" | "read" | "push" | "ci" | "test" | "command" | "agent" | "thinking" | "approval" | "waiting" | "idle";
    export interface SessionActivity {
      sessionId: string;
      kind: ActivityKind;
      /** 文件名，或命令的前 40 个字符。 */
      detail: string | null;
      background: boolean;
      startedAt: number | null;
      lastOutputAt: number | null;
      /** null：不在检测范围内。 */
      stuck: boolean | null;
      reason: string | null;
      action: string | null;
      lastOutput: string[];
    }
    ```
  - `activity-parse.ts`：`classifyCommand(command: string): { kind: "push" | "ci" | "test" | "command"; detail: string }`；`newTranscriptState(): TranscriptState`；`applyEntry(s: TranscriptState, entry: unknown): void`；`currentTool(s: TranscriptState): RunningTool | null`；`backgroundTasks(s: TranscriptState): BackgroundTask[]`。
  - `interface RunningTool { id: string; name: string; command: string | null; file: string | null; startedAt: number }`；`interface BackgroundTask { taskId: string; toolUseId: string; command: string; outputFile: string | null; startedAt: number }`；`TranscriptState` 还有 `turnOpen: boolean`。

- [ ] **Step 1: 写失败的测试**：`classifyCommand("git push origin x")` 是 `push`；`gh run watch 123`、`gh pr checks 5 --watch` 是 `ci`；`pnpm test`、`npx vitest run`、`pytest -q`、`go test ./...`、`cargo test`、`npx playwright test` 是 `test`；其他是 `command`，`detail` 截断到 40 个字符。`applyEntry`：`assistant` 的 `tool_use` 进入运行中，`user` 的 `tool_result` 按 `tool_use_id` 移除；`isSidechain: true` 的条目忽略；`tool_result` 的条目带 `toolUseResult.backgroundTaskId` 时，这个工具变成后台任务，`outputFile` 从文字 `Output is being written to: <路径>.` 取出；`type: "queue-operation", operation: "enqueue"` 且内容含 `<task-notification>` 时，按 `<task-id>` 移除后台任务；`system` 的 `subtype: "turn_duration"` 或 `stop_hook_summary`、`assistant` 的 `stop_reason: "end_turn"` 把 `turnOpen` 设为 false，真实用户消息设为 true；非对象、缺字段的条目不抛错。

- [ ] **Step 2: 运行确认失败**：`npx vitest run src/main/sessions/activity-parse.test.ts`，预期报模块不存在。

- [ ] **Step 3: 实现**：状态机只处理上面列出的情况。实现前用当前真实 transcript 确认结束轮次的字段（`assistant.message.stop_reason`），用它作主要判断，其余作补充。

- [ ] **Step 4: 运行确认通过**：同上，全过。

- [ ] **Step 5: 提交**：`git commit -m "feat: parse session activity from transcripts"`

### Task 2: 读取数据源

**Files:**
- Create: `src/main/sessions/activity-sources.ts`、`src/main/sessions/proc-tree.ts`
- Test: `src/main/sessions/activity-sources.test.ts`、`src/main/sessions/proc-tree.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `applyEntry`、`newTranscriptState`。
- Produces:
  - `class TranscriptTail { constructor(file: string, maxInitialBytes?: number /* 默认 4MB */); read(): Promise<{ state: TranscriptState; size: number }> }`：每次从上次的偏移继续读，只处理完整的行；文件变短时从头重建。
  - `tasksDirFor(transcriptFile: string, sessionId: string, opts?: { platform?: NodeJS.Platform; uid?: number }): string | null`：`<tmp>/claude-<uid>/<transcript 所在目录名>/<sessionId>/tasks`，`tmp` 在 darwin 是 `/private/tmp`，linux 是 `/tmp`，win32 返回 null。
  - `foregroundOutputFile(tasksDir: string, sinceMs: number, exclude: Set<string>): Promise<string | null>`：`lstat` 跳过符号链接，取修改时间 ≥ `sinceMs - 2000` 里最新的文件。
  - `readOutputTail(file: string, maxBytes?: number): Promise<{ size: number; mtimeMs: number; lines: string[]; text: string } | null>`：读最后 64KB，去 ANSI，把 `\r` 覆盖的进度行只留最后一段，丢掉开头的半行，`lines` 最多 6 行。
  - `sessionRegistryName(sessionsDir: string, sessionId: string): Promise<string | null>`：扫描 `~/.claude/sessions/*.json`，返回 `sessionId` 相同的 `name`。
  - `proc-tree.ts`：`parsePsOutput(out: string): Map<number, { ppid: number; cpuMs: number }>`；`descendantCpuMs(rootPid: number, table): number`（不含根进程：Claude 的动画会让根进程一直用 CPU）；`childCpuMs(rootPid: number, platform: NodeJS.Platform, run?: (cmd: string, args: string[]) => Promise<string>): Promise<number | null>`，用 `ps -A -o pid=,ppid=,cputime=`，win32 或出错返回 null。

- [ ] **Step 1: 写失败的测试**：`TranscriptTail` 增量读、半行留到下次、文件变短重建、超过 `maxInitialBytes` 时从尾部开始并丢掉第一段半行、开始记录在范围外时不抛错（Review Focus）。`readOutputTail`：`"\x1b[32mok\x1b[0m\n"` 变成 `ok`；`"a 10%\rb 20%\r c 30%\n"` 只留 `c 30%`；开头是半个 UTF-8 字符不乱码（Review Focus）；文件不存在返回 null。`foregroundOutputFile`：跳过符号链接、`exclude`、过旧的文件。`tasksDirFor`：三个平台。`parsePsOutput`：`"  12    1   0:03.50"`、`"1:02:03"`、`"1-02:03:04"` 的 cputime 都解析对；`descendantCpuMs` 不含根进程。`childCpuMs` 在 win32 和 `run` 抛错时返回 null。

- [ ] **Step 2: 运行确认失败**：`npx vitest run src/main/sessions/activity-sources.test.ts src/main/sessions/proc-tree.test.ts`

- [ ] **Step 3: 实现**：放在这两个文件里。去 ANSI 用现有的 `stripAnsi`。

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**：`git commit -m "feat: read session transcripts, command output and child CPU"`

### Task 3: 卡住判断

**Files:**
- Create: `src/main/sessions/stuck-tracker.ts`、`src/main/sessions/stuck-judge.ts`
- Modify: `src/main/sessions/pty-manager.ts`
- Test: `src/main/sessions/stuck-tracker.test.ts`、`src/main/sessions/stuck-judge.test.ts`、`src/main/sessions/pty-manager.test.ts`

**Interfaces:**
- Produces:
  - `STUCK_CHECK_MS = 180_000`、`STUCK_REJUDGE_MS = 600_000`、`CPU_CHANGE_MS = 2000`。
  - `interface StuckSample { transcriptSize: number; outputSize: number; childCpuMs: number | null; eligible: boolean }`
  - `class StuckTracker { observe(id: string, sample: StuckSample, now: number): boolean /* true：现在该请 Claude 判断 */; judged(id: string, verdict: { stuck: boolean; reason: string; action: string } | null, now: number): "newly_stuck" | "none"; dismiss(id: string): void; state(id: string): { stuck: boolean; reason: string | null; action: string | null }; forget(id: string): void }`
  - `permissionPromptShowing(buffer: string): boolean`（`pty-manager.ts`，和 `dialogShowing` 同样的写法，匹配 `do you want to proceed`、`do you want to make this edit`、`do you want to create`）。
  - `judgeStuck(d: HeadlessExecDeps, input: { cwd: string; activity: string; minutes: number; lastOutput: string; terminalTail: string; children: boolean | null }): Promise<{ stuck: boolean; reason: string; action: string } | null>`：用 `execHeadlessJson`，`allowedTools: []`，JSON schema 要求三个字段，失败返回 null。

- [ ] **Step 1: 写失败的测试**：连续两次没变化第二次返回 true；任何一项有变化计数清零；`childCpuMs` 变化小于 2000 不算变化，`null` 时只看另外两项；`eligible: false` 时计数清零、返回 false；两次检查间隔超过 `STUCK_CHECK_MS * 2` 时计数清零（Review Focus）；`judged({stuck:false})` 后 10 分钟内 `observe` 不返回 true；`judged({stuck:true})` 返回 `newly_stuck`，同一次卡住再判断返回 `none`（只通知一次）；`judged(null)` 下一轮可疑时可以再试；`dismiss` 后不再标记，直到有变化后再次卡住；有变化时 `stuck` 自动清除。`permissionPromptShowing` 用带 ANSI 的提示文字测试。`judgeStuck`：headless 失败返回 null，prompt 里有活动和最后输出，`currentLang()` 为 en 时是英文。

- [ ] **Step 2: 运行确认失败**：`npx vitest run src/main/sessions/stuck-tracker.test.ts src/main/sessions/stuck-judge.test.ts`

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行确认通过**

- [ ] **Step 5: 提交**：`git commit -m "feat: decide when a session is stuck"`

### Task 4: ActivityMonitor 接进主进程

**Files:**
- Create: `src/main/sessions/activity-monitor.ts`
- Modify: `src/main/index.ts`、`src/main/sessions/session-service.ts`、`src/shared/types.ts`、`src/shared/ipc.ts`、`src/main/ipc/register.ts`、preload、`src/main/strings.ts`
- Test: `src/main/sessions/activity-monitor.test.ts`、`src/main/sessions/session-service.test.ts`

**Interfaces:**
- Consumes: Task 1 到 3。
- Produces:
  - `class ActivityMonitor { constructor(d: ActivityDeps); start(): void; stop(): void; tick(now: number): Promise<void>; get(sessionId: string): SessionActivity | null; dismiss(sessionId: string): void }`。
  - `ActivityDeps`：`sessions`、`tickets`、`pty`（`openIds()`、`snapshot()`、pid）、`transcriptFile(id)`、`judge`、`notify()`（活动变化时发 `stateChanged`，内容没变不发）、`onStuck(info: { sessionId; ticketKey; featureId; reason })`、`now`。
  - `FeatureView.activity: Record<string, SessionActivity>`，键是 ticket 号，按规范的优先级选：卡住 > 等你批准 > 等你回话 > 最近有活动。
  - `IPC.activityDismiss`，参数 `sessionId`。
  - `M().stuckTitle(ticket: string)`、`M().stuckBody(reason: string)`。

活动的算法：终端退出的 session 不算。`permissionPromptShowing` 为真 → `approval`。有运行中的工具 → 按工具分类（`Edit`、`Write`、`NotebookEdit` 是 `edit`；`Read`、`Grep`、`Glob` 是 `read`；`Bash` 走 `classifyCommand`；`Agent`、`Task` 是 `agent`；其他是 `command`）。没有运行中的工具但有后台任务 → 最新的后台任务，`background: true`。`turnOpen` → `thinking`。否则 `waiting`。以 `sessions.head()` 为准，`/clear` 后的新 id 接替旧 id。

- [ ] **Step 1: 写失败的测试**：用假的 deps 喂 transcript 片段：各分类；这一轮结束但后台命令还在时显示命令、`background: true`、`eligible: true`；后台结束后回到 `waiting`、`eligible: false`；单独 ticket 的 session `stuck` 是 `null`，不调用 `judge`；feature 总控和修复 session（`fixesSession` 不为空，Task 6 加字段）不检测；`judge` 同时最多 2 个；`onStuck` 一次卡住只调一次；session 退出或 `/clear` 后 `get(旧 id)` 是 null，tracker 被 `forget`（Review Focus）；内容没变不调 `notify`。`featureViews()` 的 `activity` 按优先级选。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**：`index.ts` 在 `will-quit` 时 `stop()`；`onStuck` 发 Electron 通知，点击时 `showWindow()` 并发 `IPC.appNavigate`，`{ page: "feature", featureId, stuckTicket: ticketKey }`。

- [ ] **Step 4: 运行确认通过**：`pnpm test`、`pnpm typecheck`

- [ ] **Step 5: 提交**：`git commit -m "feat: track live session activity and notify when stuck"`

### Task 5: 总控的接口

**Files:**
- Modify: `src/shared/control.ts`、`src/main/control/control-handler.ts`、`memory-mcp/sessions-server.ts`、`src/main/index.ts`、`src/main/strings.ts`
- Test: `src/main/control/control-handler.test.ts`、`src/main/control/control-feature.test.ts`、`memory-mcp/sessions-server.test.ts`、`src/shared/control.test.ts`

**Interfaces:**
- Consumes: `ActivityMonitor.get`、`SessionActivity`。
- Produces: control ops `{ op: "session_activity"; session: string }`（ticket 和 feature 两种请求都有）；`ControlDeps.activity?: (sessionId: string) => SessionActivity | null`；`ControlDeps.activityOutput?: (sessionId: string) => Promise<string>`（上限 4KB）；`sessionRow` 加 `activity`（不含 `lastOutput`）。

- [ ] **Step 1: 写失败的测试**：`list_sessions` 每行有 `activity`，`stuck` 可以是 `null`；`session_activity` 返回活动加 `output`，`output` 不超过 4096 字节；feature 总控查别的 feature 的 session、ticket 总控查别的 ticket 的 session 都返回失败（`M().ctlNoSuchSession`）；MCP server 的 `FEATURE_TOOLS` 顺序是 `list_tickets, list_repos, create_ticket, start_session, list_sessions, session_activity`，ticket 工具也有 `session_activity`，中英文描述都有。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行确认通过**：`pnpm test`（`bundle.test.ts` 要过）

- [ ] **Step 5: 提交**：`git commit -m "feat: let coordinators read live session activity"`

### Task 6: 修复 session

**Files:**
- Modify: `src/main/db/migrations.ts`、`src/main/db/sessions-repo.ts`、`src/shared/types.ts`、`src/main/sessions/session-service.ts`、`src/main/handoff/feature-runner.ts`、`src/main/hooks/hook-events.ts`、`src/main/control/control-handler.ts`（`taskMessage` 所在处按实际位置）、`src/shared/ipc.ts`、`src/main/ipc/register.ts`、preload、`src/main/index.ts`
- Create: `src/main/sessions/fix-task.ts`
- Test: `src/main/db/repos.test.ts`、`src/main/sessions/session-service.test.ts`、`src/main/sessions/fix-task.test.ts`、`src/main/handoff/feature-runner.test.ts`、`src/main/hooks/hook-events.test.ts`

**Interfaces:**
- Consumes: `ActivityMonitor.get`、`sessionRegistryName`。
- Produces:
  - 迁移 9：`ALTER TABLE sessions ADD COLUMN fixes_session TEXT;`。`Session.fixesSession: string | null`。
  - `fixTaskMessage(input: { ticket: string; sessionId: string; sessionName: string | null; coordinatorName: string | null; cwd: string; activity: string; reason: string; lastOutput: string[] }, lang: Lang): string`。
  - `SessionService.openFix(req: { featureId: number; stuckSessionId: string }): Promise<OpenSessionResult>`；`IPC.sessionOpenFix`。

`fixTaskMessage` 必须写明规范“开新 session 解决”里的四条规则：目标是让卡住的 session 能继续，不接手 ticket 的工作；杀进程先问用户，确认后才杀；改 branch、停进程这类可能影响原 session 的事先用 `SendMessage` 告诉原 session 再动手，其他事不用同步；解决后告诉总控问题已解决，没有运行中的总控时跳过。`sessionName` 为 null 时让它用 `ListAgents` 按目录找。

- [ ] **Step 1: 写失败的测试**：迁移后旧数据的 `fixesSession` 是 null；`openFix` 建的行 `featureId` 有值、`coordinator` 是 false、`fixesSession` 是卡住的 id，不检查运行数量上限；同一个卡住 session 再点一次，已有运行中的修复 session 时返回 `alreadyOpen: true`，不开第二个（Review Focus）；`feature-runner` 的候选判断和 `resumable session` 都跳过 `fixesSession` 不为空的行；修复 session `/clear` 后的新 head 沿用 `fixesSession`、不变成总控；`fixTaskMessage` 中英文都含四条规则，`coordinatorName` 为 null 时没有“告诉总控”的收件人；任务用 `pty.submit` 同样的投递方式发出，不是 prefill。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**：`openFix` 和 `openFeature` 共用启动代码，抽一个私有方法，不复制。

- [ ] **Step 4: 运行确认通过**：`pnpm test`、`pnpm typecheck`

- [ ] **Step 5: 提交**：`git commit -m "feat: open a fix session for a stuck ticket"`

### Task 7: 界面

**Files:**
- Modify: `src/renderer/src/components/FeaturePage.tsx`、`src/renderer/src/components/Sidebar.tsx`、`src/renderer/src/strings.ts`、`src/renderer/src/strings-en.ts`、`src/renderer/src/styles.css`、`src/renderer/src/App.tsx`、`src/main/ipc/register.ts`
- Create: `src/renderer/src/components/TicketActivity.tsx`、`src/renderer/src/components/StuckPanel.tsx`
- Test: `src/renderer/src/components/ticket-activity.test.ts`（纯函数 `activityText`、`formatDuration`）

**Interfaces:**
- Consumes: `FeatureView.activity`、`IPC.activityDismiss`、`IPC.sessionOpenFix`、`appNavigate` 的 `stuckTicket`。
- Produces: `activityText(a: SessionActivity, S: Strings, now: number): { main: string; sub: string | null }`。

沿用草图 A（`.superpowers/brainstorm/59274-1793509433/content/stuck-ticket.html`，文字和状态表以规范为准）。状态列：有 `activity` 且不是 `idle` 时显示活动，否则显示原来的 `STATUS_LABEL`。卡住的行加红点和淡红底色；红点是按钮，`stopPropagation`，切换下面的面板，不进 ticket 页。面板是紧跟这一行的 `<tr>`，用 `useCollapsed("stuck:<ticketKey>")`（默认展开状态为收起）。按钮：“开新 session 解决”调 `sessionOpenFix`，成功后切到这个新 session；“看终端”调 `onOpenTicket`；“没事，忽略”调 `activityDismiss`。ticket 区收起时标题行显示红点；侧边栏的 feature 行也显示。通知点进来时展开这个 ticket 的面板，ticket 区是收起的话也展开。时长每 30 秒重新算一次。不改 `.terminals`。

- [ ] **Step 1: 写失败的测试**：`activityText`：`push` 且 18 分钟 → `跑 git push（pre-push hook）`、`18 分钟`；`background: true` 带“后台”；`stuck: true` 的 `sub` 含“已 N 分钟没有新输出”；`waiting`、`approval` 的文字；`formatDuration` 分钟、小时；英文同样有。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行确认通过**：`pnpm test`、`pnpm typecheck`、`npx eslint` 改到的文件

- [ ] **Step 5: 提交**：`git commit -m "feat: show live ticket status and stuck panel on the feature page"`

### Task 8: E2E 和文档

**Files:**
- Modify: `e2e/fake-claude/fake-claude.cjs`、`e2e/features.spec.ts`、`README.md`、英文 README（如有）
- Test: `e2e/features.spec.ts`

**Interfaces:**
- Consumes: 全部。为了不等 3 分钟，`ActivityMonitor` 的两个间隔读 `BUTLER_ACTIVITY_TICK_MS`、`BUTLER_STUCK_CHECK_MS` 环境变量，只在测试里设置（和 `BUTLER_BACKGROUND_WINDOWS` 同样的做法）。假 claude 按指令写一段 transcript，并写 `tasks/<id>.output`；假的 headless 返回 `{ stuck: true, reason, action }`。

- [ ] **Step 1: 写 e2e**：规范“测试”一节的流程：feature 页显示活动 → 模拟可疑和 `stuck: true` → 红点出现 → 展开、缩回、再打开内容还在 → 量 `.terminals` 高度至少是窗口的 50% → 点“开新 session 解决” → 新 session 收到含四条规则的任务 → 不存成总控。

- [ ] **Step 2: 运行**：`pnpm e2e`，全过。截图放 scratchpad 核对中文、英文、深色下的样子。

- [ ] **Step 3: 更新 README**：写清状态列、卡住处理、读取 Claude Code 本地文件的范围。

- [ ] **Step 4: 提交**：`git commit -m "test: cover live status and stuck handling end to end"`
