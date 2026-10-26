# Feature（ticket 组 + 工作区）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 feature 一层（名字 + 一组 ticket + 一个放 worktree 的工作区 + feature 总控），选目录时支持上一层目录，PR 合并后自动清理 worktree。

**Architecture:** 新表 `features` / `feature_repos`，`tickets.feature_id`、`sessions.feature_id`。`FeatureService` 管 feature 本身；`TicketService` 根据 ticket 是否属于 feature 决定 worktree 放在哪，并负责清理 / 重建 worktree。feature 总控复用现有总控的启动、MCP 配置和 control inbox，只是作用域从 ticket 换成 feature。

**Tech Stack:** Electron + TypeScript，node:sqlite，React 渲染进程，vitest，Playwright（e2e，假 claude 在 `e2e/fake-claude`）。

**Spec:** `docs/superpowers/specs/2026-10-26-features-design.md`

## Global Constraints

- 界面文案、错误消息、注释用中文，和现有代码一致；新文案全部放进 `src/renderer/src/strings.ts` 的 `S`。
- 迁移只追加到 `MIGRATIONS` 末尾（迁移 6），不改已有条目。
- feature 下 ticket 的 worktree 路径：`<工作区>/<仓库目录名>-<小写 ticket 号>`（ticket 号先过 `ticketFileStem`，再小写）。
- 分支模板占位符：`{key}`、`{key_lower}`、`{title}`；`{title}` 是标题的 slug：小写，非 `a-z0-9` 换成 `-`，合并连续的 `-`，去掉首尾 `-`，最长 50。
- 终端上限：一个 feature 最多 8 个运行中的终端（`MAX_RUNNING_PER_FEATURE = 8`），单个 ticket 仍是 6 个。
- 记忆 scope：`feature:<id>`，server 名 `butler-feature`。
- feature 总控的环境：设 `BUTLER_SESSION`，不设 `BUTLER_TICKET`；sessions MCP 用 `BUTLER_FEATURE=<id>`。
- 清理用 `git worktree remove <path>`，永不加 `--force`，永不删分支。
- 每个 task 结束时 `pnpm test`、`pnpm typecheck`、`pnpm lint` 全过再提交。提交信息结尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。

## Review Focus

- 工作区目录名来自用户输入的 feature 名（中文、空格、`/`、`..`）：要得到在工作区父目录**里面**的合法目录名，绝不能逃出去。→ Task 3 的 `featureDirName` 测试。
- 同一个仓库在 feature 里有两个 ticket：两个 worktree 路径不同、分支不同，互不影响。→ Task 3 的测试。
- worktree 已被清理时恢复一个 cwd 就是那个目录的旧 session：必须先重建再启动 claude，否则 claude 在不存在的目录里起不来。→ Task 4 的测试。
- 清理时 worktree 里只有被 .gitignore 忽略的文件（node_modules）：算安全，照删。→ Task 4 的测试。
- 用户自己在 feature 工作区里开 claude 再 `/clear`：两段 session 都归到这个 feature 的总控，不出现在"未认领"里。→ Task 5 的测试。

---

### Task 1: 迁移 6 和数据层

**Files:**
- Modify: `src/main/db/migrations.ts`、`src/shared/types.ts`、`src/main/db/tickets-repo.ts`、`src/main/db/sessions-repo.ts`
- Create: `src/main/db/features-repo.ts`
- Test: `src/main/db/repos.test.ts`、`src/main/db/features-repo.test.ts`

**Interfaces:**
- Produces（`src/shared/types.ts`）：
  - `interface FeatureRepo { id: number; featureId: number; repoPath: string; createdAt: number }`
  - `interface Feature { id: number; name: string; workspaceDir: string; repos: FeatureRepo[]; createdAt: number; archivedAt: number | null }`
  - `Ticket.featureId: number | null`；`TicketRepo.worktreeRemovedAt: number | null`、`TicketRepo.cleanupBlocked: string | null`；`Session.featureId: number | null`
- Produces（`FeaturesRepo`）：`insert(f: { name; workspaceDir; createdAt }): number`、`get(id): Feature | null`、`list(opts?: { includeArchived?: boolean }): Feature[]`、`listArchived(): Feature[]`、`byWorkspace(dir: string): Feature | null`（未归档的；比较用 `samePath`）、`setName(id, name)`、`addRepo(featureId, repoPath, createdAt): number`、`removeRepo(id)`、`archive(id, at)`、`unarchive(id)`
- Produces（`TicketsRepo`）：`insert` 的 `NewTicket` 带 `featureId`；`listByFeature(featureId: number, opts?: { includeArchived?: boolean }): Ticket[]`；`markWorktreeRemoved(repoId: number, at: number | null)`；`setCleanupBlocked(repoId: number, reason: string | null)`；`updateRepo` 同时把 `worktree_removed_at` 清空；`archivedAt(key)` 不需要新增（`Ticket.archivedAt` 已有）。
- Produces（`SessionsRepo`）：`NewSession.featureId?: number | null`；`listByFeature(featureId: number): Session[]`（只 `feature_id = ?` 的总控行）；`setFeature(id: string, featureId: number)`；`listUnclaimed` 加 `AND feature_id IS NULL`。

- [ ] **Step 1: 写失败的测试**
  - `migrate` 后 `features`、`feature_repos` 存在，`tickets.feature_id`、`sessions.feature_id`、`ticket_repos.worktree_removed_at`、`ticket_repos.cleanup_blocked` 存在；迁移 5 的数据库升级后旧 ticket 的 `featureId` 是 `null`。
  - `FeaturesRepo`：插入两个、`list()` 不含归档的、`byWorkspace` 找得到、归档后找不到；`addRepo` 同一路径两次抛错（UNIQUE）。
  - `TicketsRepo.listByFeature` 只返回这个 feature 的；`markWorktreeRemoved(id, 5)` 后 `getRepo(id).worktreeRemovedAt === 5`，`updateRepo` 后变回 `null`。
  - `SessionsRepo.listUnclaimed` 不返回 `featureId` 不为空的行。
- [ ] **Step 2: `pnpm vitest run src/main/db` 确认失败**
- [ ] **Step 3: 实现**。迁移 6 的 SQL 照抄设计文档"数据（迁移 6）"一节。`FeaturesRepo` 的 `repos` 按 id 排序。
- [ ] **Step 4: `pnpm test && pnpm typecheck` 通过**（别处构造 `Ticket` / `Session` / `TicketRepo` 字面量的测试补上新字段）
- [ ] **Step 5: 提交** `feat(db): features, feature_repos, worktree cleanup columns (migration 6)`

### Task 2: 扫描子仓库 + 分支模板占位符

**Files:**
- Create: `src/shared/branch.ts`（纯函数，渲染进程也要用）
- Modify: `src/main/tickets/git.ts`、`src/main/tickets/ticket-key.ts`（`renderBranch` 改为从 `src/shared/branch.ts` re-export）、`src/main/settings/settings-values.ts`、`src/renderer/src/strings.ts`（`generalHints.branchTemplate`）
- Test: `src/main/tickets/git.test.ts`（没有就建）、`src/shared/branch.test.ts`、`src/main/settings/settings-values.test.ts`

**Interfaces:**
- Produces：`scanRepos(dir: string): Promise<{ kind: "repo"; root: string } | { kind: "parent"; repos: string[] } | { kind: "none" }>`（`git.ts`）。`repos` 是下一层里是 git 仓库根目录的子目录（`repoRoot(child) === child`），跳过以 `.` 开头的，按名字排序；绝对路径。
- Produces：`titleSlug(title: string | null): string`、`renderBranch(template: string, key: string, title?: string | null): string`（`src/shared/branch.ts`；保持旧的两参调用可用）。代入后把连续的 `-` / `/` 合成一个、去掉首尾的 `-` / `/`，以及 `-/`、`/-` 合成 `/`。
- Produces：`checkBranchTemplateFits` 对 `{key_lower}`、`{title}` 也代入样例（`title` 样例：`""`、`"Add payment API"`）。

- [ ] **Step 1: 写失败的测试**
  - `scanRepos`：仓库本身 → `repo`；仓库里的子目录 → `repo`，`root` 是仓库根；含两个仓库和一个普通目录、一个 `.hidden` 仓库的目录 → `parent`，只有那两个；空目录 → `none`。（用 `test-utils` 的 `makeRepo` / `tempDir`）
  - `titleSlug("Add Payment API!")` → `"add-payment-api"`；`titleSlug("结账改版")` → `""`；`titleSlug(null)` → `""`；60 个字母的标题 → 长度 50 且不以 `-` 结尾。
  - `renderBranch("{key_lower}-{title}", "DMS-1234", "Add payment API")` → `"dms-1234-add-payment-api"`；标题为空 → `"dms-1234"`；`renderBranch("feature/{title}/{key}", "A-1", "")` → `"feature/A-1"`；`renderBranch("feature/{key}", "A-1")` → `"feature/A-1"`。
  - `checkBranchTemplateFits("{key_lower}-{title}", 默认正则)` 不抛错。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**；`TicketService.prepareRepo` 调 `renderBranch(template, key, title)`（`prepareRepo` 的 input 加 `title?: string | null`，`create` 传 `input.title`，`addRepo` 传 ticket 的 title）；设置页的分支模板提示改成"可用 {key}、{key_lower}（小写 ticket 号）、{title}（标题，转成小写英文和 -）"。
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: 提交** `feat: scan sub-repos; branch template {key_lower} / {title}`

### Task 3: FeatureService 和 feature 下的 ticket

**Files:**
- Create: `src/main/tickets/feature-service.ts`、`src/main/tickets/feature-service.test.ts`
- Modify: `src/main/tickets/ticket-service.ts`、`src/shared/types.ts`、`src/main/util/ticket-file.ts`
- Test: `src/main/tickets/ticket-service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FeaturesRepo`、`TicketsRepo.listByFeature`；Task 2 的 `scanRepos`。
- Produces（`src/shared/types.ts`）：`CreateFeatureInput { name: string; repoPaths: string[]; workspaceDir?: string }`；`CreateTicketInput` 加 `featureId?: number`、`repoPaths?: string[]`（多选；和 `repoPath` 二选一，`repoPath` 保留给旧调用）。
- Produces：`featureDirName(name: string): string`（`ticket-file.ts`）：去掉首尾空白，`/ \ : * ? " < > |` 和控制字符换成 `_`，只有点或空 → 用 `ticketFileStem` 同样的哈希兜底，最长 80；允许非 ASCII 字母。
- Produces（`FeatureService`）：
  - `defaultWorkspace(repoPaths: string[], name: string): string` → `join(dirname(P), basename(P) + "-features", featureDirName(name))`，`P = dirname(repoPaths[0])`。
  - `create(input: CreateFeatureInput): Promise<Feature>`：名字不能为空（`invalid_name`）；每个路径用 `repoRoot` 归一，不是仓库报 `not_git_repo`；`workspaceDir` 省略用默认；已被另一个未归档 feature 占用 → `workspace_taken`；建目录。
  - `addRepo(featureId, repoPath): Promise<FeatureRepo>`（重复 → `repo_exists`）、`removeRepo(featureRepoId)`、`rename(featureId, name)`。
  - `archive(featureId, opts: { terminalsOpen: boolean }): void`：有终端 → `sessions_open`；feature 和它未归档的 ticket 用同一个 `now` 归档，并对每个 ticket 调 `onTicketArchived`（deps 里的回调，清 MCP 配置）。
  - `unarchive(featureId): void`：恢复 feature 和 `archivedAt` 等于 feature 的 `archivedAt` 的 ticket。
  - 错误用 `TicketError`，`TicketErrorCode` 加 `"invalid_name" | "workspace_taken"`。
- Produces（`TicketService`）：
  - `create` 接受 `featureId`：feature 不存在或已归档 → `not_found` / `archived`；`repoPaths` 多个时逐个 `prepareRepo`（任何一个失败就整体失败，已建的 worktree 不回滚——和现在单仓库失败时的行为一样，下一次复用）。
  - `worktreePathFor(ticket, root)` 变成实例方法 `private worktreePath(key: string, featureId: number | null, root: string): string`：有 feature → `join(feature.workspaceDir, `${basename(root)}-${ticketFileStem(key).toLowerCase()}`)`，否则保持原来的 `<仓库>-worktrees/<KEY>`。`attachWorktree`、`prepareRepo` 的 leftover 检查、`moveWork` 都改用它。TicketService deps 加 `features: FeaturesRepo`。
  - `featureWorkspaceDir(featureId): string`（建目录并返回）。

- [ ] **Step 1: 写失败的测试**
  - `featureDirName("结账 改版")` → `"结账 改版"`；`"../x"` → 不含 `/` 也不等于 `..`；`".."` → 哈希兜底；`join(base, featureDirName(任意)).startsWith(base + sep)`（对 `"../../etc"`、`"a/b"`、`"C:\\x"`、`""` 都成立）。
  - `defaultWorkspace(["/c/shop/frontend", "/c/shop/backend"], "checkout")` → `/c/shop-features/checkout`。
  - `create`：选两个仓库建 feature → 目录存在、`repos` 两个；同一工作区再建 → `workspace_taken`；非仓库路径 → `not_git_repo`。
  - feature 下建 `DMS-1234`（frontend，worktree）和 `DMS-1235`（frontend，worktree）：worktree 分别在 `<ws>/frontend-dms-1234`、`<ws>/frontend-dms-1235`，分支各自来自模板，两个都能 `git -C` 读到自己的分支。
  - `repoPaths: [frontend, backend]` 建一个 ticket → 两个 `TicketRepo`。
  - `archive` → feature 和两个 ticket 的 `archivedAt` 相同；先单独归档的 ticket 在 `unarchive` 后仍是归档。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: 提交** `feat: FeatureService; tickets in a feature put worktrees in its workspace`

### Task 4: 合并后清理 worktree，开 session 前重建

**Files:**
- Create: `src/main/tickets/worktree-cleanup.ts`、`src/main/tickets/worktree-cleanup.test.ts`
- Modify: `src/main/tickets/git.ts`、`src/main/tickets/ticket-service.ts`、`src/main/sessions/session-service.ts`、`src/main/index.ts`、`src/main/handoff/prs.ts`（只读，用 `combinedPr`）
- Test: `src/main/sessions/session-service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `markWorktreeRemoved`、`setCleanupBlocked`。
- Produces（`git.ts`）：`removeWorktree(repo: string, path: string): Promise<void>`（`git worktree remove <path>`）。
- Produces（`worktree-cleanup.ts`）：
  - `type CleanupOutcome = { repoId: number; result: "removed" | "blocked" | "skipped"; reason?: string }`
  - `cleanupTicketWorktrees(d: { tickets: TicketsRepo; ticketService: Pick<TicketService, "updating">; repoBusy: (ticketKey: string, repoId: number) => boolean; now: () => number }, ticketKey: string): Promise<CleanupOutcome[]>`
  - 规则照设计文档"合并后自动清理 worktree"：只处理 `workMode === "worktree"`、`worktreeRemovedAt === null`、目录存在的仓库；ticket `updating` → 全部 `skipped`；`repoBusy`（这个仓库自己的 session 有终端，不算总控）→ blocked `"这个仓库的终端还在运行"`；`isDirty` → blocked `"worktree 里有未提交的改动或未跟踪的文件"`；`unbranchedCommits > 0` → blocked `"游离 HEAD 上有不在任何分支上的提交"`；`removeWorktree` 失败 → blocked `git 操作失败：<gitErrorSummary>`。成功 → `markWorktreeRemoved(id, now)` + `setCleanupBlocked(id, null)`。
  - `isMerged(handoffs: HandoffsRepo, ticketKey: string): boolean`：最新有效 handoff 的 `combinedPr(payload.prs)?.state === "merged"`。
- Produces（`TicketService`）：`ensureWorktree(r: TicketRepo): Promise<TicketRepo>`：`worktreeRemovedAt` 为空就原样返回；否则在 `exclusive` 里 `pruneWorktrees` + `addWorktree(root, path, branch, !branchExists)`，清空 `worktreeRemovedAt` 和 `cleanupBlocked`，返回新的。
- Produces（`SessionService`）：`hasRepoTerminal(ticketKey: string, repoId: number): boolean`（只算 `h.repoId === repoId`，不算总控和认不出仓库的）。`place()` 在新开和恢复两条路径上，选定 `repo` 之后、分支检查之前调 `ticketService.ensureWorktree(repo)`；恢复时只在 `samePath(cwd, repo.worktreePath)` 时调。
- 接线（`index.ts`）：`ingest` 之后如果 `r.stored && !r.degraded && isMerged(...)` → `void cleanupTicketWorktrees(...).then(notify)`；启动时（`pruneEmptySessions` 之后）对所有未归档 ticket 里 `isMerged` 的跑一遍；IPC `tickets:recheckCleanup(ticketKey)` 手动再跑（Task 7 加通道）。

- [ ] **Step 1: 写失败的测试**（`worktree-cleanup.test.ts`，真 git 仓库）
  - 干净的 worktree → `removed`，目录没了，分支还在，`worktreeRemovedAt` 有值。
  - worktree 里只有被 `.gitignore` 忽略的 `node_modules/x` → `removed`。
  - 有未跟踪文件 → `blocked`，`cleanupBlocked` 是对应原因，目录还在。
  - 有已提交但没 push 的提交 → `removed`（分支上有这个提交）。
  - `repoBusy` 为 true → `blocked`；分支模式的仓库 → 不出现在结果里。
  - 第二次跑（已清理）→ 不出现在结果里。
  - `ensureWorktree`：清理后调用 → 目录回来、在原分支上、`worktreeRemovedAt` 为 null。
  - `SessionService`：恢复一个 cwd 是已清理 worktree 的 session → pty 启动时目录已存在（FakePty 记录的 cwd 存在于磁盘）。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: 提交** `feat: remove a ticket's worktrees after its PR merges; rebuild on open`

### Task 5: feature 总控 session（打开、认领、记忆）

**Files:**
- Modify: `src/main/sessions/session-service.ts`、`src/main/hooks/hook-events.ts`、`src/main/memory/mcp-config.ts`、`src/shared/memory.ts`、`src/shared/types.ts`、`src/main/index.ts`、`src/shared/control.ts`
- Test: `src/main/sessions/session-service.test.ts`、`src/main/hooks/hook-events.test.ts`、`src/main/memory/mcp-config.test.ts`

**Interfaces:**
- Consumes: Task 1、Task 3（`featureWorkspaceDir`）。
- Produces（`src/shared/types.ts`）：
  - `OpenFeatureSessionRequest { featureId: number; sessionId?: string; prefill?: string }`
  - `FeatureView extends Feature { tickets: TicketView[]; sessions: SessionView[]; hiddenSessions: SessionView[]; waiting: boolean }`
- Produces（`src/shared/memory.ts`）：`featureScope(id: number): string` → `` `feature:${id}` ``。
- Produces（`mcp-config.ts`）：`FEATURE_SERVER = "butler-feature"`；`memoryServers` 加可选参数 `featureId?: number | null`（有就多一个 `butler-feature`）、`ticketKey` 变成可选（feature 总控不挂 `butler-memory`）；`sessionsServer` 的参数改成 `scope: { ticketKey: string } | { featureId: number }`（feature 时 env 是 `BUTLER_FEATURE`）；`featureMcpFile(mcpDir, featureId)` → `mcp/features/<id>.json`；`writeTicketMcpConfig` 旁加 `writeFeatureMcpConfig`；`removeFeatureMcpConfig`。
- Produces（`src/shared/control.ts`）：`MAX_RUNNING_PER_FEATURE = 8`。
- Produces（`SessionService`）：
  - `openFeature(req: OpenFeatureSessionRequest): Promise<OpenSessionResult>`：feature 不存在/已归档 → `no_ticket`；cwd = `featureWorkspaceDir`；`addDirs` = feature 下未归档 ticket 的仓库工作目录里不在工作区里面的（同样的存在 / cmd.exe 检查）；env 用 `sessionEnv` 但不带 ticket（`sessionEnv` 的 `ticketKey` 变成可选）；新行 `featureId`、`coordinator: true`、`ticketKey: null`；恢复逻辑同 `open`。
  - `featureViews(): FeatureView[]`（`ticketViews` 不再返回属于 feature 的 ticket；`FeatureView.tickets` 里是它们）。
  - `hasFeatureTerminal(featureId): boolean`、`featureTerminalCount(featureId): number`（feature 总控 + 它所有 ticket 的终端）。
  - 普通 ticket session 的 `mcpConfig` 回调收到 ticket 的 `featureId`，挂上 `butler-feature`。
  - `SessionServiceDeps` 加 `features: FeaturesRepo`、`featureMcpConfig?: (featureId: number) => string | null`。
- Produces（`hook-events.ts`）：deps 加 `featureForCwd?: (cwd: string) => number | null`；`ensure` 里：没有 ticket 时，先沿用 `prevHead?.featureId`，再试 `featureForCwd(cwd)`，有就插入 / 设置 `featureId` + `coordinator: true`。嵌套启动（nested）的照旧不挂。

- [ ] **Step 1: 写失败的测试**
  - `openFeature` 新开：FakePty 的 cwd 是工作区；args 里没有工作区内 worktree 的 `--add-dir`，有分支模式仓库的 `--add-dir`；env 里没有 `BUTLER_TICKET`；session 行 `featureId` 对、`ticketKey` 为 null。
  - `featureViews()` 里 feature 的 `tickets` 含它的 ticket，`ticketViews()` 不含。
  - mcp 配置：feature 总控有 `butler-feature`、`butler-workspace`、`butler-sessions`（env `BUTLER_FEATURE`），没有 `butler-memory`；feature 下 ticket 的普通 session 有 `butler-memory` 和 `butler-feature`，没有 `butler-sessions`。
  - hook：discovered 的 SessionStart，cwd 是工作区 → `featureId` 有值，`unclaimed()` 不含它；随后同一终端 `/clear`（source `clear`，`BUTLER_SESSION` 是第一段）→ 新行也有 `featureId`。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: 提交** `feat: feature coordinator sessions with a shared feature memory`

### Task 6: feature 模式的 control（sessions MCP）

**Files:**
- Modify: `src/shared/control.ts`、`src/main/control/control-handler.ts`、`memory-mcp/sessions-server.ts`、`memory-mcp/sessions-entry.ts`
- Test: `src/main/control/control-handler.test.ts`、`memory-mcp/sessions-server.test.ts`

**Interfaces:**
- Produces（`control.ts`）：`ControlRequest` 加 feature 形态：`{ v: 1; featureId: number; from; op: "list_tickets" } | { …; op: "list_sessions" } | { …; op: "start_session"; ticket: string; repo?: string; task: string }`。`parseControlRequest` 接受 `ticketKey` 或 `featureId`（正整数）二者之一，不能同时有。
- Produces（`control-handler.ts`）：deps 加 `features: FeaturesRepo`、`sessionService` 的 `featureTerminalCount`。feature 请求：feature 不存在/归档 → 错；`ticket` 不属于这个 feature 或已归档 → `这个 feature 下没有 ticket <X>。现有的：...`；`repo` 省略且 ticket 只有一个仓库 → 用它，多个 → 错误里列出仓库名；上限先查 feature 再查 ticket；`spawnedBy` 只认这个 feature 的总控（`h.featureId === featureId && h.coordinator`）；`list_tickets` 返回 `{ key, title, status: effectiveStatus, repos: [{ name, dir, branch }] }`；`list_sessions` 返回 feature 总控和所有 ticket 的 session，多一个 `ticket` 字段（总控为 null）。
- Produces（`sessions-server.ts`）：`SessionsServerOptions` 的 `ticketKey` 换成 `scope: { ticketKey: string } | { featureId: number }`；feature 模式下 `TOOLS` 用另一组（`list_tickets`、`start_session` 有 `ticket`（必填）和 `repo`（可选）、`list_sessions`），描述里说明"每个 ticket 有自己的分支和 worktree；前后端的接口约定写进 feature 记忆（butler-feature）"。`sessions-entry.ts` 读 `BUTLER_FEATURE`（正整数）或 `BUTLER_TICKET`，二者都没有就退出码 2。

- [ ] **Step 1: 写失败的测试**
  - handler：feature 下的 ticket 省略 repo（单仓库）→ 开在那个仓库；别的 feature 的 ticket → 错误；feature 已有 8 个终端 → 错误；`from` 是另一个 feature 的总控 → `spawnedBy` 为 null。
  - `parseControlRequest`：同时有 `ticketKey` 和 `featureId` → null；`featureId: "1"` → null。
  - server：feature 模式 `tools/list` 返回 `list_tickets`；`tools/call start_session` 写出的请求文件含 `featureId` 和 `ticket`。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**；`index.ts` 里 `controlHandler` 的接线补上新 deps。
- [ ] **Step 4: `pnpm test && pnpm build:memory-mcp` 通过**
- [ ] **Step 5: 提交** `feat: feature-scoped butler-sessions tools`

### Task 7: IPC、preload、api

**Files:**
- Modify: `src/shared/ipc.ts`、`src/main/ipc/register.ts`、`src/main/ipc/validate.ts`、`src/preload/index.ts`、`src/renderer/src/api.ts`、`src/main/index.ts`
- Test: `src/main/ipc/validate.test.ts`

**Interfaces:**
- Produces 通道：`features:list`（`FeatureView[]`）、`features:create`、`features:rename`、`features:addRepo`、`features:removeRepo`、`features:archive`、`features:archived`（`Feature[]`）、`features:unarchive`、`features:openSession`（`OpenFeatureSessionRequest`）、`repos:scan`（`(dir: string) => ScanResult`，`ScanResult` 就是 Task 2 的返回类型，放进 `src/shared/types.ts`）、`tickets:recheckCleanup`。
- `api` 里同名方法：`listFeatures`、`createFeature`、`renameFeature`、`addFeatureRepo`、`removeFeatureRepo`、`archiveFeature`、`archivedFeatures`、`unarchiveFeature`、`openFeatureSession`、`scanRepos`、`recheckCleanup`。
- 每个入参在 `validate.ts` 里加校验函数（风格同 `addRepoArg`）：`createFeatureArg`（名字 1–100 字，`repoPaths` 1–20 个、每个 1–4096 字）、`featureIdArg`（正整数）等。`createTicket` 的校验接受 `featureId` 和 `repoPaths`。
- `features:archive` 用 `sessionService.hasFeatureTerminal`；归档后对 feature 调 `removeFeatureMcpConfig`。

- [ ] **Step 1: 写失败的测试**（validate：非法名字、空 `repoPaths`、`featureId` 不是正整数都抛错）
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: `pnpm test && pnpm typecheck` 通过**
- [ ] **Step 5: 提交** `feat(ipc): feature channels, repo scan, cleanup recheck`

### Task 8: 界面

**Files:**
- Create: `src/renderer/src/components/NewFeatureDialog.tsx`、`src/renderer/src/components/FeaturePage.tsx`、`src/renderer/src/components/RepoPicker.tsx`
- Modify: `App.tsx`（`Route` 加 `{ page: "feature"; id: number }`，状态里加 `features`，`refresh` 一起取）、`Sidebar.tsx`、`NewTicketDialog.tsx`、`RepoDialog.tsx`、`TicketPage.tsx`、`ArchivedPage.tsx`、`strings.ts`、`styles.css`
- Test: `src/renderer/src/repos.test.ts`（纯函数部分）

**Interfaces:**
- `RepoPicker`：受控组件 `{ value: string[]; onChange(paths: string[]): void; multiple: boolean }`。输入框 + "选择…"；选了 / 输入完（blur）后调 `api.scanRepos`：`repo` → 设成 `[root]`；`parent` → 列出复选框（默认全选，显示目录名）；`none` → 显示 `S.notRepoNorParent`。`multiple: false` 时（RepoDialog 改工作方式等场景不用它）只允许 `repo`。
- `NewTicketDialog` props 加 `feature?: Feature`：有 feature 时仓库是 feature 仓库的复选框列表（默认勾第一个）+ "其他目录"（RepoPicker）；没有时用 RepoPicker（多选）。分支输入框的 placeholder 用 `src/shared/branch.ts` 的 `renderBranch` 预览，模板从 `api.settingsGet` 的 `branchTemplate` 取。
- `Sidebar`：`features: FeatureView[]` 加 props；"+ 新建 feature" 按钮；feature 在最上面，下面缩进列 ticket（复用 ticket 按钮的样式和等待点）。
- `FeaturePage`：设计文档"界面"一节的内容；终端区复用 `TicketPage` 里的终端组件（把 TicketPage 里显示 session 按钮 + 终端的部分抽成 `SessionPanel`，ticket 页和 feature 页共用；它接收 `sessions`、`open(req)`）。
- `TicketPage`：feature 名链接；仓库行显示 `S.worktreeRemoved`；`cleanupBlocked` 提示条 + `S.recheckCleanup` 按钮。
- `ArchivedPage`：已归档 feature 一节，"恢复"。
- 新文案（`S`）：`newFeature: "新建 feature"`、`featureName: "feature 名字"`、`workspaceDir: "工作区目录"`、`featureRepos: "仓库"`、`newCoordinator: "新开总控"`、`notRepoNorParent: "这个目录不是 git 仓库，下一层也没有"`、`subReposFound: (n) => \`找到 ${n} 个仓库\``、`worktreeRemoved: "worktree 已清理（再开 session 时会自动重建）"`、`cleanupBlocked: (reason) => \`合并后没有自动清理 worktree：${reason}\``、`recheckCleanup: "重新检查"`、`inFeature: "属于 feature"`、`archiveFeature: "归档 feature（连同下面的 ticket）"`，以及 `createErrors` 里的 `invalid_name`、`workspace_taken`。

- [ ] **Step 1: 写失败的测试**：`repos.test.ts` 里给 RepoPicker 用的纯函数 `scanToSelection(scan: ScanResult): { paths: string[]; options: string[] | null; error: string | null }`。
- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现**
- [ ] **Step 4: `pnpm test && pnpm typecheck && pnpm lint` 通过；`pnpm dev` 手动走一遍：建 feature → 建两个 ticket → 开总控**
- [ ] **Step 5: 提交** `feat(ui): features in the sidebar, feature page, parent-directory repo picker`

### Task 9: E2E

**Files:**
- Create: `e2e/features.spec.ts`
- Modify: `e2e/fixtures.ts`（sandbox 里能建"上一层目录里两个仓库"的 helper：`makeParentWithRepos(names: string[]): string`）

- [ ] **Step 1: 写测试**：设计文档"测试"一节的 E2E 流程。合并用"写一条 PR 已合并的 handoff"模拟：通过假 claude 的 `/handoff` 输出（同 `e2e/main-flow.spec.ts` 的做法）或直接调用 `ingest` 走到的路径，选现有 e2e 里已有的方式。断言：两个 worktree 都在 `<parent>-features/<名字>/` 下；总控 cwd 是工作区（读假 claude 的日志）；`start_session` 后 ticket 页出现子 session；合并后 worktree 目录不见、ticket 页显示 `S.worktreeRemoved`。
- [ ] **Step 2: `pnpm e2e -- features` 通过；`pnpm e2e` 全部通过**
- [ ] **Step 3: 提交** `test(e2e): features end to end`
