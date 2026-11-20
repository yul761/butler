# UI 重做第 5 层：对话 tab 与分叉讨论 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第一，ticket 页的「对话」tab 和 epic、feature、总控页的对话区，改成一条按时间排的对话流。换新的地方有分隔线，分叉讨论显示成黄框，框里写着用的哪种上下文、花了多少钱。第二，用户可以「只问不改」：从开发 session 分叉出一个只读的讨论，可以接着问，可以把结论发给 session，可以记进记忆，也可以用完整上下文重问。第三，不想分叉时，输入框也能直接把话发给开发 session。

**Architecture:**
- **先做 spike。** 第 1 个任务实测一件事：用 `claude -p --resume <id> --fork-session`，参数跟开发 session 完全一样，第一轮能不能读到开发 session 留下的缓存。结果写成常量 `FULL_FORK`，决定「完整上下文」用哪套参数。
- **只读靠 hook 保证。** 分叉的只读不靠删工具，因为删工具会破缓存。保证它的是一个新的 PreToolUse hook 模式 `butler-hook readonly`，只放行读的工具，出错时一律拒绝。
- **主进程。** `ForkService` 管 `fork_discussions` 表：
  - 选模式：完整或精简；
  - 起跑：直接调 `HeadlessRun`，不走 `execHeadlessJson`，因为它的路由会换模型、破缓存；
  - 接着问：`--resume <分叉 id>`；
  - 记费用：写进表，同时进 `session_usage`；
  - 问答：用第 4 层的写函数写进对话存储，带 `forkId`。
- **发给 session 的路。** `DevSender` 用跟「回答待你决定」一样的投递守卫，把话发给链上现在的 head。
- **渲染进程。** 纯函数 `conversation-view.ts` 负责：合并消息、换新分隔线、黄框、汇报，还有筛选和费用文字。`ConversationTab.tsx` 只管取数据和渲染。

**Tech Stack:** Electron、React 19、TypeScript、node:sqlite、vitest（`src/**/*.test.ts`、`hook/**/*.test.ts`，环境 node，渲染测试用 `react-dom/server`）、Playwright e2e（`e2e/fake-claude/fake-claude.cjs`）。

**Spec:** `docs/superpowers/specs/2026-11-19-ui-redesign-design.md`，主要看 §5.3「对话 tab」、§5.4「分叉讨论」和「分叉讨论怎么省钱」。

**其他参考：**
- 索引和共用接口：`docs/superpowers/plans/2026-11-19-ui-redesign-00-index.md`；
- 第 3 层计划（本层的挂载点在这里）：`docs/superpowers/plans/2026-11-19-ui-redesign-03-layered-pages.md`；
- 草图：`.superpowers/brainstorm/1247-1795150005/content/full-mockup.html` 的 `id="t-conv"`。

ticket：BTL-235，叠在 BTL-233（第 3 层）上。开工前 BTL-234（第 4 层）必须已经合进 main。

## 对第 3、4 层的假设（开工前先核对，对不上就只改本计划里引用的名字）

**第 3 层**（按它的计划）：
- `src/renderer/src/components/ConversationPlaceholder.tsx`：
  ```ts
  ConversationPlaceholder(p: { rootSessionId: string | null; sessions: { id: string; label: string }[] })
  ```
  `TicketPage.tsx` 里只有一行用它：`rootSessionId ? <ConversationPlaceholder …/> : <p className="muted">{S.lay.convNoSession}</p>`。
- `src/renderer/src/components/ControlConversation.tsx`：
  ```ts
  ControlConversation(p: { scope: InboxScope; rootSessionId: string | null; sessions: { id: string; label: string }[]; footer?: ReactNode })
  ```
  - 它里面有个展示件 `ControlFeed({ reports, footer })`，汇报按时间从旧到新排；
  - epic、feature、总控三页现在给 `rootSessionId` 传的是 `null`。
- `src/renderer/src/ticket-tabs.ts` 里的 `landingTab(turn)`：`you/answer`、`you/stuck`、`you/unattended(agent_stopped)` 都落在 `terminal`。
- `S.lay.convPlaceholder`、`S.lay.convNoSession` 两个文案键已经有了。

**第 4 层**：
- 索引里定死的名字：
  - `src/shared/conversation.ts` 的 `ConvMessage`、`ConvPage`；
  - `conv:list(rootSessionId, { before?, limit, qaOnly? })`，第一个参数可以是链上任意一个 id，主进程用 `sessions.rootOf` 解析；
  - `conv:search(rootSessionId | null, query)`；
  - 推送事件 `conv:appended(rootSessionId)`；
  - 主进程函数 `recentQa(rootSessionId, maxChars)`。
- 渲染进程能从 `SessionView.rootId` 拿到链根 id。
- `src/renderer/src/api.ts` 里有 `conv:list`、`conv:search` 的封装，还有 `api.onConvAppended(cb)`（名字以第 4 层为准）。
- 索引里**没有**写函数的名字。本计划假定第 4 层有：
  ```ts
  // src/main/conversation/conversation-store.ts
  export class ConversationStore {
    append(m: Omit<ConvMessage, "id">): ConvMessage;   // 写完发 conv:appended(m.rootSessionId)
    byFork(forkId: number): ConvMessage[];             // 从旧到新
  }
  ```
  它在 `src/main/index.ts` 里建成 `conversationStore`。
  - 名字不一样就照第 4 层的改；
  - 没有 `byFork`，就在 Task 4 里给它补一个（一条 `SELECT … WHERE fork_id = ? ORDER BY at, id`），连同测试；
  - 详见「对共用接口的建议」1。
- 开发 session 里用户和 agent 说的话，由第 4 层从 transcript 记进对话存储。所以本层通过 `conv:send` 发给开发 session 的话**不再自己写一遍**，否则会出现两条。

## Global Constraints

- **文案中英都要有。**
  - 渲染进程的键同时加到 `src/renderer/src/strings.ts` 和 `strings-en.ts`。`strings.test.ts` 要求两边的键、类型、函数参数个数完全一致，英文里不能有汉字。
  - 主进程给模型的提示词放在 `src/main/strings.ts` 的 `fork` 段，`ZH` 和 `EN` 两份都要写。
  - 主进程不拼给人看的文案，只给 code，由渲染进程翻成句子。
- **测试命令：**
  - `pnpm test`（= `vitest run`）；跑单个文件写 `pnpm test <路径>`；
  - `pnpm typecheck`、`pnpm lint`；
  - `pnpm e2e`（会先 `pnpm build && pnpm build:hook`）；只跑一个 spec 写 `pnpm e2e e2e/conversation.spec.ts`。
  - e2e 里的 ticket 号必须带数字，比如 `E2E-7`。
- **3.0 的功能默认全关，Butler 默认不对外做任何事。**
  - 分叉讨论和「发给开发 session」只在用户点了以后才跑，没有后台触发，所以不加开关。
  - 分叉对外的事一律被 readonly hook 拒绝：不发评论、不 push、不调 WebFetch。
- **不能留两套并存的算法。**
  - 「完整上下文」用哪套参数，只看 `FULL_FORK` 常量，不留两条代码路径一起跑。
  - 「发给开发 session」和「按这个改」共用 `DevSender` 一条路。
  - 对话区汇报的排法只在 `conversation-view.ts` 里写一份；第 3 层 `ControlFeed` 里排汇报的那段，在 Task 10 删掉。
- **分叉是用户自己点的，不受成本熔断的「暂停后台调用」影响**（这跟交互 session 一样），但费用照实记进 `session_usage`。每个黄框都显示花了多少钱，没有上限。

## Review Focus

1. **开发 session 正在跑时分叉。**
   - `chooseMode` 只在开发 session 停在输入框（`waitingForInput`）时才选完整模式。开发 session 正在跑，它的 transcript 可能停在一个没有结果的 `tool_use` 上，这时分叉出来的对话是半截的，所以这种情况一律走精简模式。
   - 用户这时点「用完整上下文重问」，返回 `dev_busy`，框里写「开发 session 正在跑，等它停下再用完整上下文」。
   - 测试位置：Task 5 的 `chooseMode` 和 `fullBlock`，Task 6 的 `reaskFull`。
2. **分叉进行中开发 session 被换新。**
   - 分叉行按 `root_session_id` 存。接着问用的是行里存的 `fork_session_id`、`cwd` 和 `launch_args`，不再去看开发 session 现在的状态。
   - 「按这个改」投递时，用 `sessions.head(root)` 取**现在的** head。换新还没完成（`refresher.isRefreshing`）时，守卫返回 `refreshing`，框里提示「正在换新，等一下再发」，结论留着不丢。
   - 换新分隔线来自 `refreshMarks`。黄框按 `started_at` 排进去，换新前后都能看到。
   - 测试位置：Task 6、Task 7、Task 9。
3. **分叉失败或撞限额。**
   - 行的 `status` 记成 `failed`，同时记下 `error_code` 和 `error_reset_at`。撞限额时报给 `availability`，`job` 是 `"fork discussion"`。
   - 失败的那一轮如果有 `result`，照样记费用。
   - 用户的问题已经写进对话存储，不会丢。框里写清楚原因，限额要写到什么时候恢复，并给一个「再问一次」。
   - 分叉的第一轮就失败（还没有 `fork_session_id`）时，再问一次会按第一轮的参数重跑。
   - app 在分叉跑到一半时退出：下次启动，`running` 的行一律标成 `interrupted`。
   - readonly hook 自己出错时**拒绝**这次工具调用，不放行。注意，现有的 hook 出错时是放行的。
   - 测试位置：Task 2、Task 6。
4. **用户连点。**
   - 主进程侧：
     - 同一个分叉正在跑时再问，返回 `fork_busy`；
     - 同一个链根、同一句问题的新分叉还在跑时，返回那个已有的 `forkId`；
     - 同一个分叉的「按这个改」「记进记忆」各有一个在途标记，第二次直接返回 `busy`；
     - 「用完整上下文重问」已经有一个在跑时，返回那一个。
   - 渲染进程侧：按钮在等待时禁用，发出去以后显示「已发给 session · 14:32」。
   - 测试位置：Task 6、Task 7、Task 10。
5. **费用显示为空。**
   - 算法：
     - 有 `total_cost_usd` 就用它；
     - 没有就用价格表按 `usdOf` 估一个；
     - 价格表里也没有这个模型，费用记为未知，`cost_partial = 1`。
   - 显示：
     - 正在跑、还没有任何费用：「在算…」；
     - 一轮都没算出来：「费用未知」；
     - 有一部分算不出来：「至少 $0.03」；
     - 不到 1 分：「<$0.01」。
   - 永远不显示 `$NaN`，也不显示空白。
   - 测试位置：Task 6 的 `costOf`，Task 9 的 `costText`。

---

## 文件结构

新建：

| 文件 | 职责 |
|---|---|
| `scripts/fork-cache-spike.mjs` | Task 1 的实测脚本（开发时手动跑，不进 app） |
| `src/main/fork/fork-cache.ts` | spike 的结论常量 `FULL_FORK`，附实测数据注释 |
| `hook/readonly.ts`、`hook/readonly.test.ts` | 只读判断纯函数 `readonlyDecision` |
| `src/main/fork/fork-args.ts`、`.test.ts` | 分叉参数（纯函数）：`devForkArgs`、`strictForkArgs`、`continueArgs`、`forkSettings`、`FORK_ALLOWED_TOOLS` |
| `src/main/fork/fork-mode.ts`、`.test.ts` | `chooseMode`、`fullBlock`、`costOf`、`lightPrompt` 的输入裁剪 |
| `src/main/fork/fork-service.ts`、`.test.ts` | `ForkService`：问、接着问、重问、列表、结论、记忆 |
| `src/main/fork/dev-send.ts`、`.test.ts` | `DevSender`：经投递守卫发给链上现在的 head |
| `src/main/db/fork-discussions-repo.ts`、`.test.ts` | `fork_discussions` 表的读写 |
| `src/main/ipc/fork-handlers.ts`、`.test.ts` | IPC 处理函数 |
| `src/shared/fork.ts` | `ForkView`、`ForkError`、`DevSendResult`、`RememberResult` 等共用类型 |
| `src/renderer/src/conversation-view.ts`、`.test.ts` | 对话流的纯函数：`buildTimeline`、`costText`、`modeText`、`errorText`、`sendBlockText` |
| `src/renderer/src/components/ConversationTab.tsx` | 对话 tab：取数据、渲染、输入框 |
| `src/renderer/src/components/ForkBox.tsx` | 黄框（只吃 props） |
| `src/renderer/src/components/conversation-tab-render.test.ts` | 展示件渲染测试 |
| `e2e/conversation.spec.ts` | 端到端 |

修改：
- `hook/entry.ts`、`hook/entry.test.ts`；
- `src/main/sessions/session-service.ts`、`.test.ts`；
- `src/main/db/migrations.ts`；
- `src/main/db/usage-repo.ts`、`.test.ts`；
- `src/main/memory/memory-service.ts`、`.test.ts`；
- `src/main/db/inbox-repo.ts`、`src/main/inbox/inbox-service.ts` 及其测试；
- `src/main/index.ts`、`src/main/strings.ts`；
- `src/main/ipc/register.ts`、`src/main/ipc/validate.ts`、`.test.ts`；
- `src/shared/ipc.ts`；
- `src/renderer/src/api.ts`、`strings.ts`、`strings-en.ts`、`styles.css`、`local-prefs.ts`；
- `src/renderer/src/components/TicketPage.tsx`、`ControlConversation.tsx`、`EpicPage.tsx`、`FeaturePage.tsx`、`ButlerPage.tsx`；
- `src/renderer/src/ticket-tabs.ts`、`.test.ts`；
- `e2e/fake-claude/fake-claude.cjs`。

删除：`src/renderer/src/components/ConversationPlaceholder.tsx`，以及它的渲染用例和 `S.lay.convPlaceholder`（两种语言都删）。

---

### Task 1: 缓存 spike——完整分叉第一轮能不能读到缓存

这一个任务不写 app 代码，只写一个实测脚本、跑它，再把结论写成常量。其余任务都按常量写，这样 Task 2 起可以并行开工，Task 6 合并前再核对一次常量的值。

**背景：** 现有的 handoff 分叉走 `headlessArgs`，带着 `--disallowedTools`、`--json-schema`、自己的 MCP 配置、`--setting-sources user` 和 `--no-session-persistence`。它们的第一轮一直是整段写 1h 缓存，从来没有读到过。比如 `~/.butler/app.db` 里 handoff 的行是 write1h 113386、read 112810，这是两轮合计，第一轮全是写。

原因可以从缓存前缀的规则推出来。前缀的顺序是：工具列表 → system → 消息。下面任何一样变了，缓存都会失效：
- 工具列表：`--disallowedTools` 删掉整个工具、MCP server 集合不一样、`--json-schema` 加进来的结构化输出工具；
- system：CLAUDE.md 的加载方式（`--setting-sources`）、`--append-system-prompt-file` 的内容；
- 模型、thinking 和 effort 的设置。

而 `--allowedTools`、权限模式、hook 只影响放不放行，按理不进 prompt。

**Files:**
- Create: `scripts/fork-cache-spike.mjs`、`src/main/fork/fork-cache.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/main/fork/fork-cache.ts
  export interface FullForkPlan {
    /** 完整分叉照抄开发 session 的参数，第一轮能读到它的缓存（spike 实测）。false：完整分叉走 strictForkArgs，自动选择永远选精简。 */
    cacheOk: boolean;
    /** 加 --permission-mode dontAsk 和 --allowedTools 后缓存还在。false 时这两样不加（只读全靠 readonly hook；-p 下没放行的工具本来就是拒绝）。 */
    permissionArgs: boolean;
    /** 分叉另写一份 MCP 配置（换了 termId、server 集合不变）缓存还在。false 时直接用开发 session 那份配置文件。 */
    ownMcpConfig: boolean;
  }
  export const FULL_FORK: FullForkPlan;
  ```

- [ ] **Step 1: 写 `scripts/fork-cache-spike.mjs`。** 用纯 Node 写，不 import `src`，只在 macOS 和 Linux 上用。
  - 用法：`node scripts/fork-cache-spike.mjs <开发 session id> --variant v1|v2|v2-no-perm|v2-dev-mcp [--dry-run]`。
  - 找开发 session 的进程：在 `ps -axo pid=,args=` 里找带这个 session id、又不带 `-p` 的 claude 进程，取它的命令行参数。
    - 找不到就退出，提示「这个 session 得开着」。
    - 参数里有空格，`ps` 拆不准，就打印出来让人确认。
  - 取进程的工作目录：`lsof -a -p <pid> -d cwd -Fn`。
  - 取开发 session 的上下文大小：只读打开 `~/.butler/app.db`（`node:sqlite`，`{ readOnly: true }`），查这个 session 最新一行 `source='session'` 的 `context` 和 `at`。查法照 `src/main/db/usage-repo.ts` 里的 `latestContext`。
  - 四个变体的参数：
    - **v1**：开发参数原样。只把 `--session-id X` 换成 `--resume X`（原来就是 `--resume X` 的不动），再加 `-p --output-format json --fork-session`。`--mcp-config`、`--settings`、`--add-dir`、`--append-system-prompt-file`、`--model` 都照抄，不加 `--setting-sources`。
    - **v2**（生产候选）：v1 再加下面三样：
      - `--permission-mode dontAsk --allowedTools Read Grep Glob "Bash(git diff:*)" "Bash(git log:*)" "Bash(git status)" "Bash(git show:*)"`；
      - 把 `--settings` 换成一份拷贝，写在 `os.tmpdir()` 下：原文件的 JSON，其中 `permissions.allow` 改成 `[]`，`hooks` 换成 `{ PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "true", timeout: 10 }] }] }`，其余键原样；
      - 把 `--mcp-config` 换成一份拷贝：原文件内容里开发 session 的 termId 全部换成 `fork-spike`。
    - **v2-no-perm**：v2 去掉 `--permission-mode` 和 `--allowedTools`。
    - **v2-dev-mcp**：v2 的 `--mcp-config` 用开发 session 的原文件。
  - 环境变量：`process.env` 加上 `BUTLER_SESSION=headless:spike`、`CLAUDE_CODE_SUBAGENT_MODEL`（没设就是 `sonnet`）、`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（没设就是 `250000`），跟 `sessionEnv` 一致。
  - 提示词经 stdin 传，内容是「只回答 OK 两个字母，不要调用任何工具。」。不调工具，整次运行就只有一轮，usage 的合计就等于第一轮。
  - 输出：
    - `input`、`cacheWrite5m`、`cacheWrite1h`、`cacheRead`、`output`、`total_cost_usd`、分叉的 `session_id`；
    - `r1 = cacheRead / (input + cacheWrite5m + cacheWrite1h + cacheRead)`；
    - `r2 = cacheRead / 开发 context`；
    - 开发 session 最后一轮离现在几分钟；
    - `PASS` 或 `FAIL`。
  - `--dry-run`：只打印拼好的参数，不跑。
  - 跑完提示分叉 transcript 在 `~/.claude/projects/` 下，可以手动删。
- [ ] **Step 2: 干跑核对参数。** 在 Butler 里开一个 ticket session，让它跑一两轮（上下文最好大于 50k），等它停在输入框。然后跑 `node scripts/fork-cache-spike.mjs <id> --variant v2 --dry-run`，确认下面几点：
  - 参数里**没有** `--disallowedTools`、`--json-schema`、`--setting-sources`、`--no-session-persistence`；
  - `--model` 跟开发 session 一样；
  - 工作目录跟开发 session 一样。
- [ ] **Step 3: 实跑并判定。** 每次跑之前，开发 session 都必须停在输入框，而且最后一轮在 10 分钟以内。
  - 先跑 v2。
  - **PASS 的标准**（两条都要满足）：`r1 ≥ 0.9`，且 `r2 ≥ 0.8`。
  - v2 在两个不同的开发 session 上都要 PASS：一个普通 ticket session，一个带 `--add-dir` 的总控 session。
  - 预算：总共最多跑 6 次。没命中的一次大约 $1，命中的一次只要几分钱。
  - 基线不用另外再跑。上面 handoff 的数据已经证明 `headlessArgs` 那套参数不命中。
- [ ] **Step 4: 按结果分支，写 `src/main/fork/fork-cache.ts`。** 在 `FULL_FORK` 上面的注释里写清楚：日期、Claude Code 版本（`claude --version`）、每次跑的变体、`r1`、`r2`、花费。
  - **A（v2 通过）**：`{ cacheOk: true, permissionArgs: true, ownMcpConfig: true }`。
  - **A'（v2 不通过，但 v1 通过）**：一次加一样来找出破缓存的那一项，最多再跑 3 次：
    - 先跑 `v2-no-perm`：通过的话，设 `permissionArgs: false`；
    - 再跑 `v2-dev-mcp`：通过的话，设 `ownMcpConfig: false`。只读由 hook 拦，开发 session 那份 MCP 配置里的 butler-sessions 会把分叉当成开发 session 本人，所以 readonly hook 必须拦住它所有会写东西的工具，Task 2 已经这么做；
    - 两样都去掉还是不通过，说明 `--settings` 拷贝（权限或 hook）进了 prompt，按 B 处理。
  - **B（v1 也不通过，说明 `-p` 模式本身就跟交互模式的前缀不一样）**：`{ cacheOk: false, permissionArgs: true, ownMcpConfig: true }`。这时：
    - 完整分叉走 `strictForkArgs`，它的保护跟现有 handoff 一样，再加 readonly hook；
    - `chooseMode` 永远选精简；
    - 只有用户点「用完整上下文重问」时才走完整，代价大约 $1，框里照实显示。
    - 把判定的数据写进 PR 描述，方便以后 Claude Code 升级后重测。
- [ ] **Step 5: 核对。** 跑 `pnpm typecheck`（`fork-cache.ts` 只导出常量，没有测试）。
- [ ] **Step 6: Commit**
  ```bash
  git add scripts/fork-cache-spike.mjs src/main/fork/fork-cache.ts
  git commit -m "spike(fork): measure first-turn cache reads of a full fork"
  ```

---

### Task 2: readonly hook——分叉只读的真正保证

光靠 `dontAsk` 和 `--allowedTools` 保证不了只读，有两个原因：
- 开发 session 的 `--settings` 里放行了 `SESSIONS_AUTO_ALLOW`；
- 用户、项目、本地的 settings 里也可能有放行规则（比如 `Bash(npm:*)`、`Edit`）。

PreToolUse hook 返回 `deny`，能压过所有放行规则；而且 hook 不进 prompt，不会破缓存。

**Files:**
- Create: `hook/readonly.ts`、`hook/readonly.test.ts`
- Modify: `hook/entry.ts`（加 `readonly` 模式）、`hook/entry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // hook/readonly.ts
  export type ReadonlyDecision = { allow: true } | { allow: false; reason: string };
  export function readonlyDecision(input: unknown): ReadonlyDecision;
  export const READONLY_MCP_SUFFIXES: readonly string[];   // ["__recall", "__facts", "__why"]
  export const READONLY_SESSIONS_TOOLS: readonly string[]; // butler-sessions 里只读的那几个
  ```
  `butler-hook readonly` 从 stdin 读 PreToolUse 的 JSON：
  - 拒绝时，在 stdout 写 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":<reason>}}`，格式跟 `hook/gate.ts` 一样；
  - 放行时什么都不写；
  - 退出码总是 0。

- [ ] **Step 1: 写失败测试 `hook/readonly.test.ts`。** 每行一条断言：

  | 输入 | 结果 |
  |---|---|
  | `{tool_name:"Read"}`、`"Grep"`、`"Glob"`、`"TodoWrite"` | 放行 |
  | `Bash`，`git status`、`git diff HEAD~1 -- src`、`git log --oneline -5`、`git show abc123:src/a.ts` | 放行 |
  | `Bash`，`git diff --output=x.patch`、`git log --output x`（`git diff` 和 `git log` 带 `--output` 会写文件） | 拒绝 |
  | `Bash`，`git status; rm -rf x`、`git log \| sh`、`git diff > a`、`` git log `id` ``、`git log $(id)`、带换行的命令 | 拒绝 |
  | `Bash`，`git push`、`git commit -m x`、`git checkout .`、`npm test`、`ls` | 拒绝 |
  | `Edit`、`Write`、`NotebookEdit`、`Agent`、`Task`、`WebFetch`、`WebSearch` | 拒绝 |
  | `mcp__butler-ticket__recall`、`mcp__statecore__facts` | 放行 |
  | `mcp__butler-ticket__remember`、`mcp__butler-sessions__report`、`mcp__butler-sessions__ask_user`、`mcp__butler-sessions__submit_evidence` | 拒绝 |
  | `mcp__butler-sessions__list_tickets`、`mcp__butler-sessions__session_activity` | 放行 |
  | `null`、`"x"`、`{}`、`{tool_name: 3}` | 拒绝 |

  拒绝的理由要用英文写一句话，说明这是只读的讨论，不能改东西。理由会回给模型看，所以不进 i18n。
- [ ] **Step 2: 运行确认失败。** 跑 `pnpm test hook/readonly.test.ts`，预期 FAIL（找不到模块）。
- [ ] **Step 3: 实现 `hook/readonly.ts`。** 用白名单：
  - Bash 先拒绝含 `;&|<>` `` ` `` `$(`、换行、`--output` 的命令，再匹配 `^git (status|diff|log|show)(\s|$)`；
  - MCP 工具按后缀判断，`butler-sessions` 只放行 `list_*` 和 `session_activity`；
  - 其余一律拒绝。
- [ ] **Step 4: 给 `hook/entry.test.ts` 加用例。** 用已经打好的 bundle 跑 `[bundle, "readonly"]`：
  - stdin 是 `{"hook_event_name":"PreToolUse","tool_name":"Edit"}`：stdout 解析出 `permissionDecision: "deny"`，退出码 0；
  - stdin 是 `Read`：stdout 为空；
  - stdin 是坏 JSON `{{`：stdout 也是 deny；
  - 不写 inbox 信封：`BUTLER_HOME` 下没有 `inbox/*.json`。
- [ ] **Step 5: 改 `hook/entry.ts`。** 在 `mode === "gate"` 那一串判断里加一支 `mode === "readonly"`：
  - 同步读 stdin，调 `readonlyDecision`，写出结果；
  - 这一支自己 `try/catch`，catch 里也写 deny。这跟其他模式「出错就放行」**正好相反**，要在注释里写明原因：分叉是用户要求的只读讨论，宁可错拒，也不能错放。
- [ ] **Step 6: 运行。** 跑 `pnpm test hook/ && pnpm typecheck`，预期 PASS。再跑一次 `pnpm build:hook`，确认能打包。
- [ ] **Step 7: Commit**
  ```bash
  git add hook/readonly.ts hook/readonly.test.ts hook/entry.ts hook/entry.test.ts
  git commit -m "feat(hook): readonly mode that denies every non-read tool, failing closed"
  ```

---

### Task 3: 分叉参数和开发 session 的启动参数记录

**Files:**
- Create: `src/main/fork/fork-args.ts`、`src/main/fork/fork-args.test.ts`
- Modify: `src/main/sessions/session-service.ts`（记下每个 head 的启动参数）、`src/main/sessions/session-service.test.ts`

**Interfaces:**
- Consumes: `claudeArgs`、`ClaudeArgsInput`（`src/main/claude/spawn.ts`），`FULL_FORK`（Task 1），`SETTING_SOURCES_ARGS`、`DENIED_TOOLS`（`src/main/claude/headless.ts`）。
- Produces:
  ```ts
  // src/main/fork/fork-args.ts
  export const FORK_ALLOWED_TOOLS: readonly string[];  // Read Grep Glob Bash(git diff:*) Bash(git log:*) Bash(git status) Bash(git show:*)
  /** 开发 session 这次启动时传给 claude 的参数（claudeArgs 的输出，不含 resolveLaunch 的前缀）。 */
  export interface DevLaunch {
    sessionId: string; cwd: string; claudeArgs: string[];
    mcpConfigPath: string | null; settingsPath: string | null; addDirs: string[]; model: string | null;
  }
  /** 完整分叉（FULL_FORK.cacheOk）：开发参数原样，--session-id 换成 --resume，加 -p --output-format json --fork-session；
   *  --settings 换成 forkSettingsPath；ownMcpConfig 时 --mcp-config 换成 forkMcpConfigPath；permissionArgs 时加 dontAsk 和 FORK_ALLOWED_TOOLS（放最后）。 */
  export function devForkArgs(dev: DevLaunch, o: { forkSettingsPath: string; forkMcpConfigPath: string | null; plan: FullForkPlan }): string[];
  /** 严格参数：精简分叉和 B 分支的完整分叉。
   *  -p --output-format json --permission-mode dontAsk --setting-sources user [--model] [--resume id --fork-session] [--add-dir…] [--settings]
   *  --disallowedTools Edit Write NotebookEdit --allowedTools …FORK_ALLOWED_TOOLS。没有 --json-schema，没有 --no-session-persistence，没有 MCP。 */
  export function strictForkArgs(o: { resumeSessionId?: string; model: string | null; addDirs: string[]; forkSettingsPath: string | null }): string[];
  /** 接着问：把第一轮参数里的 `--resume <开发 id> --fork-session` 换成 `--resume <分叉 id>`；第一轮没有 --resume（精简）就在 -p 后面插入 `--resume <分叉 id>`。 */
  export function continueArgs(first: readonly string[], forkSessionId: string): string[];
  /** 分叉用的 settings：开发那份 JSON 里除 permissions、hooks 以外原样保留（enableAllProjectMcpServers、disabledMcpjsonServers 不变，工具集合才不变）；
   *  permissions.allow = []，hooks = { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${guardCommand} readonly`, timeout: 10 }] }] }。dev 为 null 时只有这两项。 */
  export function forkSettings(dev: Record<string, unknown> | null, guardCommand: string): Record<string, unknown>;

  // session-service.ts
  devLaunchOf(sessionId: string): DevLaunch | null;   // 只有这个 Butler 进程里开过、pty 还开着的 head 才有
  ```

- [ ] **Step 1: 写 `fork-args.test.ts` 的失败测试。** 用一个固定的 `DevLaunch`（`claudeArgs` 用 `claudeArgs({ mode: "new", sessionId: "s1", mcpConfigPath: "/m.json", settingsPath: "/s.json", addDirs: ["/r2"], guidePath: "/g.md", model: "opus" })` 生成），断言下面几组。
  - `devForkArgs`（`plan` 全为 true 时）：
    - 含 `-p`、`--output-format json`、`--resume s1 --fork-session`，不含 `--session-id`；
    - `--settings` 后面跟的是分叉那份；`--mcp-config` 后面跟的是分叉那份；
    - `--append-system-prompt-file /g.md`、`--add-dir /r2`、`--model opus` 原样保留；
    - **不含** `--disallowedTools`、`--json-schema`、`--setting-sources`、`--no-session-persistence`；
    - `--allowedTools` 在最后。
  - `devForkArgs`，`plan.permissionArgs=false`：不含 `--permission-mode` 和 `--allowedTools`。
  - `devForkArgs`，`plan.ownMcpConfig=false`：`--mcp-config /m.json` 原样。
  - `strictForkArgs`：
    - 没有 `resumeSessionId` 时不含 `--resume`；
    - 有的时候含 `--resume X --fork-session`；
    - 始终含 `--setting-sources user` 和 `--disallowedTools Edit Write NotebookEdit`；
    - 不含 `--json-schema`，也不含 `--no-session-persistence`。
  - `continueArgs`：
    - 对完整参数：结果里 `--resume f1` 出现一次，没有 `--fork-session`，也没有开发 id；
    - 对精简参数：插入 `--resume f1`；
    - 其余参数次序不变；
    - 连续调两次（先 f1 再 f2）只剩 `--resume f2`。
  - `forkSettings`：
    - 保留 `enableAllProjectMcpServers` 和 `disabledMcpjsonServers`；
    - `permissions.allow` 是 `[]`；
    - `hooks` 只有 PreToolUse 一组，命令以 ` readonly` 结尾；
    - 开发 settings 里原有的 gate、Skill 等 hook 都不在了；
    - `dev = null` 时也能生成。
- [ ] **Step 2: 运行确认失败。** 跑 `pnpm test src/main/fork/fork-args.test.ts`。
- [ ] **Step 3: 实现 `fork-args.ts`。** 都是纯函数，不碰文件。分叉 settings 由 Task 6 的依赖写盘：写到 `paths.mcp` 下，文件名是 `fork-<sha1(JSON)>.json`，跟 `projectMcpApprovalSettings` 写 `approve-*.json` 的写法一样。
- [ ] **Step 4: 给 `session-service.test.ts` 加用例。**
  - `open()` 一个 ticket session 以后，`devLaunchOf(headId)` 的 `claudeArgs` 跟传给 `pty.open` 的参数去掉 `resolveLaunch` 前缀后完全一样；`cwd`、`settingsPath`、`mcpConfigPath`、`model` 都对。
  - workspace targets 那一路（`session-service.ts` 约 718 行）也一样。
  - pty 退出以后 `devLaunchOf` 返回 `null`。
  - 从来没开过的 id 也返回 `null`。
- [ ] **Step 5: 实现。**
  - 在 `SessionService` 里加 `private readonly launches = new Map<string, DevLaunch>()`。
  - 在 `open()` 拼好 `args` 的地方（`claudeArgs({...})` 之后、`pty.open` 之前，约 225–295 行）和 workspace targets 那一处，各记一条。key 是 `head.id`。
  - 在 session 退出的处理里删掉这一条。退出处理就是现有 pty `exit` 回调里改 session 状态的那一处，`grep -n "exit" src/main/sessions/session-service.ts` 能找到。
  - `devLaunchOf` 先用 `pty.isOpen(termId)` 核对。
  - 不改任何现有参数的拼法。
- [ ] **Step 6: 运行。** 跑 `pnpm test src/main/fork src/main/sessions/session-service.test.ts && pnpm typecheck`，预期 PASS。
- [ ] **Step 7: Commit**
  ```bash
  git add src/main/fork/fork-args.ts src/main/fork/fork-args.test.ts src/main/sessions/session-service.ts src/main/sessions/session-service.test.ts
  git commit -m "feat(fork): fork argument builders and recorded dev launch args"
  ```

---

### Task 4: `fork_discussions` 表、repo、共用类型

**Files:**
- Modify: `src/main/db/migrations.ts`（在第 4 层那条之后追加一条）
- Create: `src/main/db/fork-discussions-repo.ts`、`src/main/db/fork-discussions-repo.test.ts`、`src/shared/fork.ts`
- Modify（只在第 4 层没有 `byFork` 时）: `src/main/conversation/conversation-store.ts` 及其测试

**Interfaces:**
- Produces:
  ```sql
  CREATE TABLE fork_discussions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_session_id TEXT NOT NULL,
    fork_session_id TEXT,                       -- 第一轮跑完才知道
    mode TEXT NOT NULL CHECK (mode IN ('full','light')),
    cost_usd REAL,                              -- 已知部分的合计；一轮都不知道时为 NULL
    cost_partial INTEGER NOT NULL DEFAULT 0,    -- 有一轮算不出钱
    started_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    summary_sent_at INTEGER,
    ticket_key TEXT,
    feature_id INTEGER,
    cwd TEXT NOT NULL,
    launch_args TEXT NOT NULL,                  -- 第一轮的参数（JSON string[]），接着问时用 continueArgs 换 resume 目标
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','idle','failed')),
    error_code TEXT,
    error_reset_at INTEGER,
    conclusion TEXT,
    conclusion_at INTEGER,
    reask_of INTEGER REFERENCES fork_discussions(id)
  );
  CREATE INDEX fork_discussions_root ON fork_discussions(root_session_id, started_at);
  ```
  ```ts
  // src/shared/fork.ts
  import type { ConvMessage } from "./conversation";
  export type ForkMode = "full" | "light";
  export type ForkStatus = "running" | "idle" | "failed";
  /** 失败原因：HeadlessFailure 的取值，加上 interrupted（app 退出时还在跑）、no_answer（跑完了但回答是空的）。 */
  export type ForkErrorCode = "timeout" | "spawn_failed" | "exit_nonzero" | "bad_output" | "rate_limited" | "claude_error"
    | "model_unavailable" | "aborted" | "interrupted" | "no_answer";
  export interface ForkView {
    id: number; rootSessionId: string; mode: ForkMode; status: ForkStatus;
    costUsd: number | null; costPartial: boolean; startedAt: number; lastAt: number;
    summarySentAt: number | null; conclusion: string | null; reaskOf: number | null;
    error: { code: ForkErrorCode; resetAt: number | null } | null;
    /** 这个分叉的问答，从旧到新（第 4 层 byFork）。 */
    messages: ConvMessage[];
  }
  /** IPC 拒绝时的 code（经 toIpcResult 变成 { ok:false, code }）。 */
  export type ForkRefusal = "fork_busy" | "dev_busy" | "no_transcript" | "no_claude" | "not_found" | "bad_question";
  export class ForkError extends Error { constructor(readonly code: ForkRefusal, message?: string); }
  /** 发给开发 session 被挡下的原因：DeliveryBlock 的取值加上 refreshing、投递结果和本层自己的几种。 */
  export type DevSendBlock = "closed" | "hibernated" | "busy" | "screen" | "needs_you" | "typing" | "draft" | "cost_paused"
    | "refreshing" | "exited" | "timeout" | "blocked" | "in_flight" | "fork_busy" | "no_conclusion" | "not_found";
  export type DevSendResult = { ok: true; at: number } | { ok: false; reason: DevSendBlock };
  export type RememberResult = "written" | "full" | "disabled" | "failed" | "busy" | "no_conclusion";
  ```
  ```ts
  // src/main/db/fork-discussions-repo.ts
  export interface ForkRow { id; rootSessionId; forkSessionId: string | null; mode: ForkMode; costUsd: number | null; costPartial: boolean;
    startedAt; lastAt; summarySentAt: number | null; ticketKey: string | null; featureId: number | null; cwd: string; launchArgs: string[];
    status: ForkStatus; errorCode: ForkErrorCode | null; errorResetAt: number | null; conclusion: string | null; conclusionAt: number | null; reaskOf: number | null }
  export class ForkDiscussionsRepo {
    constructor(db: Db);
    create(r: { rootSessionId: string; mode: ForkMode; ticketKey: string | null; featureId: number | null; cwd: string; launchArgs: string[]; at: number; reaskOf?: number | null }): ForkRow;
    get(id: number): ForkRow | null;
    listByRoot(rootSessionId: string): ForkRow[];          // started_at 从旧到新
    runningReaskOf(id: number): ForkRow | null;
    start(id: number, at: number): boolean;               // 只有不是 running 时才改成 running；返回改没改（连点的原子判断）
    finish(id: number, o: { at: number; forkSessionId?: string | null; addCost: number | null; partial: boolean;
      error?: { code: ForkErrorCode; resetAt: number | null } | null }): void;   // status 变成 idle 或 failed
    setConclusion(id: number, text: string, at: number): void;
    markSent(id: number, at: number): void;
    failRunning(code: "interrupted", at: number): number;  // 启动时用
  }
  ```

- [ ] **Step 1: 写失败测试 `fork-discussions-repo.test.ts`。** 用 `memDb()`（`src/main/test-utils.ts`）。
  - **建表**：`PRAGMA table_info(fork_discussions)` 含上面所有列。
  - **升级**：用 `MIGRATIONS.slice(0, n - 1)` 建库、插一行 `session_usage`，再跑全部迁移，表在、旧数据不丢（写法照 `src/main/db/notify-events-migration.test.ts`）。
  - **`create`**：`status = running`、`cost_usd` 为 NULL、`launchArgs` 原样读回。
  - **`start`**：running 时再 `start` 返回 `false`，`finish` 之后 `start` 返回 `true`。
  - **`finish`，费用累计**：
    - `addCost: 0.02` 两次，读回 0.04（误差用 `toBeCloseTo`）；
    - 第一次 `addCost: null, partial: true`，`cost_usd` 仍为 NULL、`costPartial` 为 true；
    - 再来一次 `addCost: 0.01`，读回 0.01、`costPartial` 仍为 true。
  - **`finish` 带 `error`**：`status = failed`。下一次 `finish` 不带 `error`，会把 `error_code` 清空。
  - **`forkSessionId`**：只在传了时才写，后面不传不会被清掉。
  - **`failRunning`**：只改 running 的行，返回改了几行。
  - **`listByRoot`**：只返回这个根下的行，顺序对。
- [ ] **Step 2: 运行确认失败。** 跑 `pnpm test src/main/db/fork-discussions-repo.test.ts`。
- [ ] **Step 3: 实现。**
  - 在 `MIGRATIONS` 末尾追加一条（只能追加，不改前面的）。
  - repo 照 `src/main/db/butler-messages-repo.ts` 的写法：`Row` 类型、`toFork` 映射、构造函数收 `Db`。
  - `finish` 的费用用一条 SQL 累计：`cost_usd = CASE WHEN ? IS NULL THEN cost_usd ELSE COALESCE(cost_usd, 0) + ? END`，`cost_partial = MAX(cost_partial, ?)`。
  - 写 `src/shared/fork.ts`。
  - 第 4 层没有 `byFork` 的话，在它的 store 里补上，连同一条测试（两条分叉消息、一条普通消息，只返回前两条，按 `at` 排序）。
- [ ] **Step 4: 运行。** 跑 `pnpm test src/main/db && pnpm typecheck`，预期 PASS。
- [ ] **Step 5: Commit**
  ```bash
  git add src/main/db/migrations.ts src/main/db/fork-discussions-repo.ts src/main/db/fork-discussions-repo.test.ts src/shared/fork.ts
  git commit -m "feat(fork): fork_discussions table, repo and shared types"
  ```

---

### Task 5: 选模式、最后一轮的时间、记忆的读写

**Files:**
- Create: `src/main/fork/fork-mode.ts`、`src/main/fork/fork-mode.test.ts`
- Modify: `src/main/db/usage-repo.ts`、`usage-repo.test.ts`、`src/main/memory/memory-service.ts`、`memory-service.test.ts`

**Interfaces:**
- Consumes: `FULL_FORK`（Task 1），`usdOf`（`src/main/metrics/rollup.ts`），`RegistryModel`（`src/shared/model-routing.ts`），`UsageCounts`（`src/main/usage/usage-parse.ts`），`NOTE_BODY_LIMIT`、`ticketScope`、`featureScope`（`src/shared/memory.ts`）。
- Produces:
  ```ts
  // fork-mode.ts
  export const FULL_FRESH_MS = 55 * 60_000;   // 1h 缓存，留 5 分钟余量
  export const LIGHT_RECALL_CHARS = 8_000;
  export const LIGHT_QA_CHARS = 24_000;      // 加上问题，精简版约 30k token 以内
  export interface ModeInput { cacheOk: boolean; launchKnown: boolean; transcriptExists: boolean; devIdle: boolean; lastTurnAt: number | null; now: number }
  export function chooseMode(i: ModeInput): ForkMode;
  /** 用完整上下文重问能不能跑：开发 session 在跑 → dev_busy；没有 transcript → no_transcript；否则 null。 */
  export function fullBlock(i: { transcriptExists: boolean; devIdle: boolean }): "dev_busy" | "no_transcript" | null;
  /** 一轮的花费：CLI 给了 total_cost_usd 用它；否则按价格表估；都没有 → { usd: null, partial: true }。 */
  export function costOf(r: { costUsd: number | null; usage: UsageCounts | null; model: string | null }, registry: readonly RegistryModel[]): { usd: number | null; partial: boolean };

  // usage-repo.ts
  lastSessionTurnAt(sessionId: string): number | null;   // source='session' 的 MAX(at)

  // memory-service.ts
  /** 精简分叉用：这个范围的交接摘要 + 记忆条目拼成文本，最多 maxChars；记忆关着或读不到时返回 ""。只读，不排队。 */
  recallText(scope: string, maxChars: number): Promise<string>;
  /** 把一段纯文本记进这个范围（过 slotGuard，截到 NOTE_BODY_LIMIT），走写队列，永不 reject。 */
  rememberText(scope: string, text: string): Promise<"written" | "full" | "disabled" | "failed">;
  ```

- [ ] **Step 1: 写失败测试。**
  - **`fork-mode.test.ts`，`chooseMode`**：下面六条各一条断言，只有满足全部条件时才是 `full`：
    1. `cacheOk = false` → `light`；
    2. `launchKnown = false`（开发 session 没开着）→ `light`；
    3. `transcriptExists = false` → `light`；
    4. `devIdle = false` → `light`；
    5. `lastTurnAt` 为 null，或离 `now` 刚好超过 `FULL_FRESH_MS` → `light`；
    6. 全部满足、`lastTurnAt = now - 54 分钟` → `full`。
  - **`fork-mode.test.ts`，`fullBlock`**：分别得到 `dev_busy`、`no_transcript`、`null`。
  - **`fork-mode.test.ts`，`costOf`**：
    - 有 `costUsd: 0.03`：直接用；
    - 没有 `costUsd`，价格表里有这个模型：按 `usdOf` 算出的数；
    - 模型不在价格表里：`{ usd: null, partial: true }`；
    - `usage` 也是 null：`{ usd: null, partial: true }`。
  - **`usage-repo.test.ts`，`lastSessionTurnAt`**：
    - 只看 `source='session'`，`headless` 和 `subagent` 的行不算；
    - 别的 session 的行不算；
    - 没有记录时返回 null。
  - **`memory-service.test.ts`**，照文件里现有的假 StateCore 写法：
    - `rememberText` 写进去以后，`view` 里能看到这条；
    - 文本超过 `NOTE_BODY_LIMIT` 会被截断；
    - 槽满时返回 `"full"`；
    - `enabled()` 为 false 时返回 `"disabled"`；
    - StateCore 抛错时返回 `"failed"`，不会 reject；
    - `reconcile` 不会把这条纯文本记忆当成 decision 或 followup 删掉；
    - `recallText`：有交接也有条目时两样都在，结果长度不超过 `maxChars`；记忆关着时返回 `""`。
- [ ] **Step 2: 运行确认失败。** 跑 `pnpm test src/main/fork/fork-mode.test.ts src/main/db/usage-repo.test.ts src/main/memory/memory-service.test.ts`。
- [ ] **Step 3: 实现。**
  - `costOf` 调 `usdOf` 时，把 `UsageCounts` 拼成 `UsageFact`：`sessionId: null`、`at: 0`、`task: null`、`source: "headless"`、`costUsd: null`。`usdOf` 返回 `partial` 时，结果记为 `usd: null`。
  - `rememberText` 走 `enqueue(label, fn, fallback)`，在 `fn` 里先过 `slotGuard`，再 `withScope(...).remember(text)`。
  - `recallText` 复用 `view` 的读法，拿 `activeHandoff()` 和 `facts()`。
- [ ] **Step 4: 运行。** 跑同上的命令，再跑 `pnpm typecheck`，预期 PASS。
- [ ] **Step 5: Commit**
  ```bash
  git add src/main/fork/fork-mode.ts src/main/fork/fork-mode.test.ts src/main/db/usage-repo.ts src/main/db/usage-repo.test.ts src/main/memory/memory-service.ts src/main/memory/memory-service.test.ts
  git commit -m "feat(fork): mode choice, cost of a run, memory recall and remember text"
  ```

---

### Task 6: `ForkService`——问、接着问、重问、费用、失败

**Files:**
- Create: `src/main/fork/fork-service.ts`、`src/main/fork/fork-service.test.ts`
- Modify: `src/main/strings.ts`（`ZH.fork`、`EN.fork`）、`src/main/index.ts`（`recordHeadlessUsage` 不再要求有 `task` 才记 `costUsd`）

**Interfaces:**
- Consumes：
  - Task 3：`devForkArgs`、`strictForkArgs`、`continueArgs`、`forkSettings`、`DevLaunch`；
  - Task 4：`ForkDiscussionsRepo`、`ForkView`、`ForkError`；
  - Task 5：`chooseMode`、`fullBlock`、`costOf`；
  - `headless.ts`：`HeadlessRun`、`HeadlessOutcome`；
  - `spawn.ts`：`headlessEnv`；
  - `headless-exec.ts`：`UsageReport`；
  - 第 4 层：`ConversationStore`、`recentQa`。
- Produces:
  ```ts
  export interface ForkDeps {
    repo: ForkDiscussionsRepo;
    conv: { append(m: Omit<ConvMessage, "id">): ConvMessage; byFork(forkId: number): ConvMessage[] };
    recentQa: (rootSessionId: string, maxChars: number) => string;
    sessions: { rootOf(id: string): string | null; head(id: string): Session | null };
    devLaunchOf: (sessionId: string) => DevLaunch | null;
    transcriptExists: (sessionId: string) => boolean;
    lastTurnAt: (sessionId: string) => number | null;
    recall: (scope: string, maxChars: number) => Promise<string>;
    /** 写分叉 settings / MCP 配置到 paths.mcp；hook 没装（readonly 不可用）时返回 null → 不起跑，报 no_claude。 */
    files: { settings(devSettingsPath: string | null): string | null; mcp(dev: DevLaunch, forkRunId: string): string | null };
    run: HeadlessRun;
    claude: () => { path: string | null; pathValue: string };
    baseEnv: NodeJS.ProcessEnv;
    recordHeadless: (sessionId: string, cwd: string, at: number) => void;
    onUsage: (r: UsageReport) => void;
    onLimit: (hit: LimitHit, job: string) => void;
    registry: () => readonly RegistryModel[];
    changed: (rootSessionId: string) => void;          // 推 fork:changed
    plan: FullForkPlan;                                 // FULL_FORK
    now: () => number; newRunId: () => string; signal?: AbortSignal; log: (msg: string, err?: unknown) => void;
  }
  export const FORK_JOB = "fork discussion";
  export class ForkService {
    constructor(d: ForkDeps);
    /** 立刻写入用户的问题、返回 forkId，回答异步写进对话存储。anyId 可以是链上任意 id。 */
    ask(anyId: string, forkId: number | null, question: string): { forkId: number };
    reaskFull(forkId: number): { forkId: number };
    list(anyId: string): ForkView[];
    /** 有新鲜的结论（conclusion_at ≥ 最后一条消息）就用它，否则在分叉里再问一句要结论。 */
    conclusion(forkId: number): Promise<{ ok: true; text: string } | { ok: false; reason: "fork_busy" | "no_conclusion" | "not_found" }>;
    /** 启动时调用：上次没跑完的标成 interrupted。 */
    recover(): void;
    /** 测试用：等所有在途的跑完。 */
    idle(): Promise<void>;
  }
  // src/main/strings.ts 的 fork 段（ZH / EN 各一份）
  fork: {
    lightPrompt: (p: { recall: string; qa: string; question: string }) => string;  // 说明这是只读讨论、上下文是精简的、不要改文件
    reaskPrompt: (questions: string[]) => string;
    conclusionAsk: string;   // 「用不超过 300 字写出结论：要开发 session 做什么、改哪里、为什么。只写结论。」
    conclusionForDev: (conclusion: string) => string;   // 「（来自一次只读的分叉讨论）…」
  }
  ```

- [ ] **Step 1: 写失败测试 `fork-service.test.ts`。** `run` 用一个假 `HeadlessRun`，记下每次调用的 `args`、`cwd`、`prompt`，按测试设定的结果 resolve；其余依赖用内存的 repo（`memDb()`）和假对象。
  - **新分叉（精简）**：`ask("head-2", null, "为什么这么改？")`，`head-2` 的根是 `root-1`。
    - 马上返回 `{ forkId }`；
    - `conv.append` 收到一条 `role: "user"`、`rootSessionId: "root-1"`、`sessionId: "head-2"`、`forkId`、`qa: false`；
    - 行是 `running`，`changed("root-1")` 被调用；
    - `idle()` 之后：
      - `conv.append` 收到 assistant 回答；
      - 行变成 `idle`，`fork_session_id` 是结果里的 `sessionId`；
      - `recordHeadless(forkSessionId, cwd, …)` 被调用；
      - `onUsage` 收到 `label: "fork discussion"`、`costUsd`、`ticketKey`；
      - `args` 来自 `strictForkArgs`，不含 `--resume`；
      - `prompt` 里含 recall、`recentQa` 和问题。
  - **新分叉（完整）**：`plan.cacheOk`、`devLaunchOf` 有值、开发 session 停在输入框、`lastTurnAt` 在 10 分钟内。
    - `args` 等于 `devForkArgs(...)`，`cwd` 等于 `DevLaunch.cwd`；
    - `prompt` 只有问题本身；
    - 行的 `mode = full`。
  - **接着问**：对上面那个 `forkId` 再 `ask`。
    - `args` 等于 `continueArgs(launch_args, forkSessionId)`，`cwd` 用行里存的；
    - 回答写进同一个 `forkId`。
  - **开发 session 正在跑时分叉**：`head.waitingForInput = false`，`chooseMode` 选 `light`；`reaskFull` 抛 `ForkError("dev_busy")`。
  - **分叉进行中开发 session 被换新**：第一轮还在跑时，把 `sessions.head("root-1")` 换成 `head-3`。
    - 接着问照样用行里的 `fork_session_id`、`cwd`，不看 `head-3`；
    - `list("head-3")` 能列出这个分叉。
  - **连点**：
    - 同一个 `forkId` 在跑时再 `ask`，抛 `ForkError("fork_busy")`，不写入用户消息；
    - 同一个根、同一句问题连着两次 `ask(…, null, q)`，返回同一个 `forkId`，`run` 只被调用一次；
    - `reaskFull` 连点两次，返回同一个新 `forkId`。
  - **失败**：
    - `run` 返回 `{ ok: false, reason: "rate_limited", limit: { resetAt: 123, … }, result: { costUsd: 0.01 … } }`：
      - 行变成 `failed`，`error = { code: "rate_limited", resetAt: 123 }`；
      - `onLimit(hit, "fork discussion")` 被调用；
      - 费用记了 0.01；
      - 用户消息还在，没有写 assistant 消息。
    - 失败以后再 `ask`：
      - 第一轮就失败（没有 `fork_session_id`）：用 `launch_args` 原样重跑；
      - 不是第一轮：用 `continueArgs`。
    - 跑完但 `resultText` 是空的：`error.code = "no_answer"`。
    - `claude().path` 为 null，或 `files.settings` 返回 null：抛 `ForkError("no_claude")`，不建行。
  - **问题不合法**：空白或超过 20000 字，抛 `bad_question`。
  - **`recover`**：`running` 的行变成 `failed / interrupted`。
  - **`conclusion`**：
    - 没有结论时，在分叉里接着问一轮 `M().fork.conclusionAsk`：用户消息和 assistant 消息都带 `forkId` 写进对话存储，回答存成 `conclusion`；
    - 再调一次时直接返回，`run` 不再被调用；
    - 之后用户又问了一句，结论过期，下次会重新要；
    - 分叉正在跑时返回 `fork_busy`。
  - **费用为空**：`costUsd: null`，模型也不在价格表里：`cost_usd` 为 NULL，`costPartial = true`，`list` 里的 `ForkView.costUsd` 为 null。
  - **`recordHeadlessUsage`**：在 `src/main/index.ts` 里，把这个函数抽成可测的 `headlessUsageRow(r: UsageReport): UsageRow`，放到 `src/main/usage/headless-usage.ts`，并在那里加测试：
    - 没有 `task` 时 `costUsd` 也写进去；
    - 原来有 `task` 的路径，结果不变。
- [ ] **Step 2: 运行确认失败。** 跑 `pnpm test src/main/fork/fork-service.test.ts src/main/usage/headless-usage.test.ts`。
- [ ] **Step 3: 实现 `ForkService`。** 要点：
  - **解析根和 head**：`rootOf(anyId) ?? anyId`，`head(root)`。没有 head 就抛 `not_found`。
  - **范围**：有 `ticketKey` 用 `ticketScope`，否则有 `featureId` 用 `featureScope`；都没有时 recall 是 `""`。
  - **起跑**：
    - 环境变量：`headlessEnv(baseEnv, { pathValue, runId })`，再补上 `CLAUDE_CODE_SUBAGENT_MODEL ??= "sonnet"` 和 `CLAUDE_CODE_AUTO_COMPACT_WINDOW ??= "250000"`，跟 `sessionEnv` 的默认值一致。
    - 超时用 `HEADLESS_TIMEOUT_MS`，取消信号用 `signal`。
    - **不**走 `execHeadlessJson`，不做路由，不过成本闸门。
  - **精简模式**：
    - 模型用 `head.model`（开发 session 存的模型；为 null 就不传 `--model`）；
    - `addDirs` 取 `DevLaunch.addDirs`，没有就是 `[]`；
    - 提示词用 `M().fork.lightPrompt`。
  - **在途标记**：用两个 `Map<string, Promise<void>>`，一个按 `forkId`，一个按「根 + 问题」。再加上 `repo.start` 的原子判断，两层一起挡连点。
  - **每次状态变化都调 `changed(root)`**。回答由 `conv.append` 推送 `conv:appended`。
  - **费用**：
    - 用 `costOf` 算，写进 `repo.finish` 的 `addCost` 和 `partial`；
    - 再调 `onUsage({ runId, label: FORK_JOB, at, model, usage, costUsd, ticketKey })`。`session_usage.message_id` 是 `headless:<runId>`，`job` 是 `fork discussion`，`task` 为空。成本统计和效果页按 `job` 和 `source` 汇总，不用另加接口。
  - **`onUsage` 和 `onLimit` 各自 `try/catch`**，出错不影响分叉本身的结果。
- [ ] **Step 4: 实现 `headlessUsageRow`，并在 `src/main/index.ts` 的 `recordHeadlessUsage` 里改用它。** 原来的 `...(task !== undefined && { task, requestedTier, fallbackFrom, costUsd })` 拆成两段：`task` 那三项照旧，`costUsd` 只要不是 `undefined` 就写。
- [ ] **Step 5: 写 `src/main/strings.ts` 的 `fork` 段**，中英各一份。`src/main/i18n-prompts.test.ts` 里加一条：`setLang("en")` 之后，`M().fork.lightPrompt(...)` 和 `conclusionAsk` 里都没有汉字。
- [ ] **Step 6: 运行。** 跑 `pnpm test src/main && pnpm typecheck`，预期 PASS。
- [ ] **Step 7: Commit**
  ```bash
  git add src/main/fork/fork-service.ts src/main/fork/fork-service.test.ts src/main/usage/headless-usage.ts src/main/usage/headless-usage.test.ts src/main/index.ts src/main/strings.ts src/main/i18n-prompts.test.ts
  git commit -m "feat(fork): fork service with full and light modes, follow-ups, cost and failures"
  ```

---

### Task 7: 发给开发 session、按这个改、记进记忆

**Files:**
- Create: `src/main/fork/dev-send.ts`、`src/main/fork/dev-send.test.ts`
- Modify: `src/main/fork/fork-service.ts`（加 `sendConclusion`、`remember`）、`fork-service.test.ts`

**Interfaces:**
- Consumes: `DeliveryGuard`（`src/main/sessions/delivery-guard.ts`）的 `check` 和 `recheckAfter`，`PtyManager.deliver`，`sanitizeTask`（Task 8 接线时从 `src/main/index.ts` 现有的 import 取），`MemoryService.rememberText`（Task 5）。
- Produces:
  ```ts
  // dev-send.ts
  export interface DevSendDeps {
    sessions: { rootOf(id: string): string | null; head(id: string): Session | null };
    /** 用户自己的话：refreshing 挡，needsYou 不挡——就是 index.ts 里给 inbox 用的那个 answerGuard。 */
    guard: Pick<DeliveryGuard, "check" | "recheckAfter">;
    deliver: (termId: string, text: string, o: { singleLine: boolean; timeoutMs: number; recheck: () => boolean }) => Promise<DeliverResult>;
    sanitize: (text: string) => string;
    platform: NodeJS.Platform; now: () => number; log: (msg: string, err?: unknown) => void;
  }
  export class DevSender {
    constructor(d: DevSendDeps);
    /** 发给 anyId 所在链现在的 head。同一个 head 有一条在途就返回 in_flight。 */
    send(anyId: string, text: string): Promise<DevSendResult>;
  }
  // fork-service.ts 增加（构造时多收 send: DevSender["send"] 和 remember: MemoryService["rememberText"]）
  sendConclusion(forkId: number): Promise<DevSendResult>;   // 成功后 markSent
  remember(forkId: number): Promise<RememberResult>;
  ```

- [ ] **Step 1: 写失败测试。**
  - **`dev-send.test.ts`**：
    - 守卫通过时，`deliver` 收到 `termId` 和处理过的文本，`singleLine` 在 win32 上为 true；返回 `{ ok: true, at }`。
    - 守卫返回 `{ ok: false, block: "draft" }`（用户在终端里打了半句）时，返回 `{ ok: false, reason: "draft" }`，`deliver` 不被调用。
    - 守卫的 `refreshing`、`hibernated`、`closed`、`busy` 各一条，都原样作为 `reason` 返回。
    - `deliver` 返回 `"timeout"` 或 `"exited"` 或 `"blocked"` 时，返回对应的 `reason`。
    - 换新以后：`send("root-1", …)` 发到 `head("root-1")` 现在指向的那个 head。
    - 同一个 head 连着 `send` 两次，第一次还没完时第二次返回 `in_flight`。
    - `deliver` 抛错时返回 `{ ok: false, reason: "blocked" }`，并写日志。
  - **`fork-service.test.ts`，`sendConclusion`**：
    - 没有结论时先要结论（同 Task 6），再调 `send(root, M().fork.conclusionForDev(结论))`；
    - 成功后 `summary_sent_at` 有值，`changed` 被调用；
    - `send` 返回 `draft` 时，`summary_sent_at` 不变，结论还留着；下次不再重新要结论，`run` 不再被调用；
    - 分叉正在跑时返回 `fork_busy`；
    - 要结论失败时返回 `no_conclusion`；
    - 连点两次，第二次返回 `in_flight`。
  - **`fork-service.test.ts`，`remember`**：
    - 用结论（先确保有）调 `rememberText(scope, 结论)`，返回 `"written"`；
    - 槽满返回 `"full"`；
    - 连点返回 `"busy"`；
    - ticket 和 feature 都没有时返回 `"disabled"`，不调用 `rememberText`。
- [ ] **Step 2: 运行确认失败。** 跑 `pnpm test src/main/fork/dev-send.test.ts src/main/fork/fork-service.test.ts`。
- [ ] **Step 3: 实现。** `DevSender.send` 照 `src/main/inbox/inbox-service.ts`（约 281 行）的回答投递写：先 `guard.check(head.id)`，通过后调 `deliver(g.termId, sanitize(text), { singleLine: platform === "win32", timeoutMs: 60_000, recheck: guard.recheckAfter(head.id, g) })`。在途标记用 `Set<headId>`，放在 `finally` 里清掉。
- [ ] **Step 4: 运行。** 跑同上的命令，再跑 `pnpm typecheck`，预期 PASS。
- [ ] **Step 5: Commit**
  ```bash
  git add src/main/fork/dev-send.ts src/main/fork/dev-send.test.ts src/main/fork/fork-service.ts src/main/fork/fork-service.test.ts
  git commit -m "feat(fork): send conclusion to the dev session and remember it"
  ```

---

### Task 8: IPC、汇报分页、主进程接线

**Files:**
- Create: `src/main/ipc/fork-handlers.ts`、`src/main/ipc/fork-handlers.test.ts`
- Modify: `src/shared/ipc.ts`、`src/main/ipc/validate.ts`、`validate.test.ts`、`src/main/ipc/register.ts`、`src/renderer/src/api.ts`、`src/main/db/inbox-repo.ts`、`src/main/inbox/inbox-service.ts` 及其测试、`src/main/index.ts`

**Interfaces:**
- Produces:
  - 索引里定死的 IPC：
    - `fork:ask(rootSessionId, forkId | null, question) => { forkId }`
    - `fork:send-conclusion(forkId) => { ok }`。实际返回 `DevSendResult`，也就是 `{ ok: true, at } | { ok: false, reason }`，是在 `{ ok }` 上加字段，见「对共用接口的建议」2。
    - `fork:reask-full(forkId) => { forkId }`
  - 本层新增的 IPC：
    - `fork:list(anyId) => ForkView[]`
    - `fork:remember(forkId) => { result: RememberResult }`
    - `conv:send(anyId, text) => DevSendResult`：输入框选「开发 session」时用。
    - `inbox:reports(scope, { before?: number; limit: number }) => { reports: InboxItemView[]; hasMore: boolean }`：总控对话区的汇报分页。
  - 本层新增的推送事件：`fork:changed(rootSessionId)`。
  ```ts
  // shared/ipc.ts 的 IPC 表里加：forkAsk "fork:ask"、forkSendConclusion "fork:send-conclusion"、forkReaskFull "fork:reask-full"、
  //   forkList "fork:list"、forkRemember "fork:remember"、convSend "conv:send"、inboxReports "inbox:reports"、forkChanged "fork:changed"
  // 前七个进 INVOKE_CHANNELS，forkChanged 进 EVENT_CHANNELS
  // api.ts
  forkAsk: (rootSessionId: string, forkId: number | null, question: string) => call<{ forkId: number }>(IPC.forkAsk, rootSessionId, forkId, question),
  forkSendConclusion: (forkId: number) => call<DevSendResult>(IPC.forkSendConclusion, forkId),
  forkReaskFull: (forkId: number) => call<{ forkId: number }>(IPC.forkReaskFull, forkId),
  forkList: (anyId: string) => call<ForkView[]>(IPC.forkList, anyId),
  forkRemember: (forkId: number) => call<{ result: RememberResult }>(IPC.forkRemember, forkId),
  convSend: (anyId: string, text: string) => call<DevSendResult>(IPC.convSend, anyId, text),
  inboxReports: (scope: InboxScope, o: { before?: number; limit: number }) => call<{ reports: InboxItemView[]; hasMore: boolean }>(IPC.inboxReports, scope, o),
  onForkChanged: (cb: (rootSessionId: string) => void) => window.butler.on(IPC.forkChanged, cb),
  // validate.ts
  export function forkIdArg(v: unknown): number;        // 正整数
  export function forkQuestionArg(v: unknown): string;  // trim 后非空、≤ 20000 字
  export function reportsPageArg(v: unknown): { before?: number; limit: number };  // limit 1–100
  ```

- [ ] **Step 1: 写失败测试。**
  - **`validate.test.ts`**：
    - `forkIdArg`：`0`、`-1`、`1.5`、`"1"` 都抛错；
    - `forkQuestionArg`：`"  "` 和 20001 个字都抛错；
    - `reportsPageArg`：`{ limit: 0 }` 和 `{ limit: 101 }` 都抛错。
  - **`fork-handlers.test.ts`**：照 `src/main/ipc/memory-handlers.ts` 的测试写法。每个处理函数先校验参数，再调 `ForkService` 或 `DevSender` 的方法；`ForkError` 抛出时经 `toIpcResult` 变成 `{ ok: false, code: "fork_busy" }`。这一条用 `toIpcResult` 直接测。
  - **`inbox-repo` 和 `inbox-service` 的测试**：`recentReports(filter, limit, before)` 只返回 `created_at < before` 的；`reportsPage` 多取一条来判断 `hasMore`；原来不带 `before` 的调用结果不变。
- [ ] **Step 2: 运行确认失败。** 跑 `pnpm test src/main/ipc src/main/inbox src/main/db/inbox-repo.test.ts`。如果 inbox-repo 的测试在别的文件里，用 `grep -rln recentReports src/main` 找出来。
- [ ] **Step 3: 实现。**
  - **`fork-handlers.ts`**：`forkHandlers({ fork, devSend })` 返回各个处理函数。在 `register.ts` 里照第 799 行的 memory 写法，用 `handle(IPC.forkAsk, …)` 等逐一注册。
  - **`IpcDeps`** 加 `fork` 和 `devSend` 两项。
  - **`inbox-repo.recentReports`** 加一个可选参数 `before?: number`。`inbox-service` 加 `reportsPage(scope, o)`，复用现有的 `itemView`。
  - **`src/main/index.ts` 接线**：
    - 建 `ForkDiscussionsRepo` 和 `ForkService`，启动时调 `recover()`。
    - `files.settings(devSettingsPath)`：
      - hook 没装好（`hookInstalled()` 为 false）时返回 null；
      - 否则读开发那份 JSON，读不到就当 null；
      - 用 `forkSettings(dev, hookCommand(paths.hookBin, process.platform))` 生成内容，写到 `paths.mcp/fork-<sha1>.json`。
    - `files.mcp(dev, runId)`：用 `memoryMcpConfig(ticketKey, opts, \`fork-${runId}\`)` 生成同一组 server。
    - `transcriptExists` 用 SessionService 依赖里现有的那个。
    - 下面几项都用现有的：
      - `lastTurnAt`：`usageRepo.lastSessionTurnAt`；
      - `recall`：`memoryService.recallText`；
      - `onUsage`：`recordHeadlessUsage`；
      - `onLimit`：`availabilityHooks.onLimit`；
      - `registry`：`routing.config().registry`；
      - `signal`：`headlessAbort.signal`；
      - `claude`：`health.claude()`；
      - `recordHeadless`：`sessionsRepo.recordHeadless`。
    - `changed`：`safeSend(IPC.forkChanged, root)`。
    - `DevSender` 的 `guard` 用 `answerGuard`（第 1738 行那个 `new DeliveryGuard({ ...guardDeps, refreshing })`）：先把它提成一个具名常量，再给 inbox 和 `DevSender` 共用。`deliver` 用 `pty.deliver`。
- [ ] **Step 4: 运行。** 跑 `pnpm test src/main && pnpm typecheck && pnpm lint`，预期 PASS。
- [ ] **Step 5: Commit**
  ```bash
  git add src/shared/ipc.ts src/main/ipc src/renderer/src/api.ts src/main/db/inbox-repo.ts src/main/inbox src/main/index.ts
  git commit -m "feat(fork): IPC for forks, sending to the dev session and paged reports"
  ```

---

### Task 9: 对话流的纯函数

**Files:**
- Create: `src/renderer/src/conversation-view.ts`、`src/renderer/src/conversation-view.test.ts`
- Modify: `src/renderer/src/strings.ts`、`strings-en.ts`（加 `S.conv` 段，见文案表）

**Interfaces:**
- Consumes: `ConvMessage`、`ConvPage`（第 4 层），`ForkView`、`DevSendBlock`、`RememberResult`（Task 4），`InboxItemView`。
- Produces:
  ```ts
  export type ConvFilter = "all" | "forks" | "search";
  export type TimelineItem =
    | { kind: "msg"; key: string; msg: ConvMessage }
    | { kind: "sep"; key: string; at: number; sessionId: string }
    | { kind: "fork"; key: string; fork: ForkView }
    | { kind: "report"; key: string; report: InboxItemView };
  export interface TimelineInput {
    messages: ConvMessage[]; refreshMarks: ConvPage["refreshMarks"]; convHasMore: boolean;
    forks: ForkView[]; reports: InboxItemView[]; reportsHasMore: boolean; filter: "all" | "forks";
  }
  /** 从旧到新。forkId 不为 null 的消息不进主流，它们在各自的黄框里（ForkView.messages）；黄框按 startedAt 排。
   *  分页的截断线：两边都还有更早的时，取两者最早时间里较晚的那个为界，比它早的消息、汇报、黄框、分隔线先不显示（等「更早的」加载）。
   *  "forks"：只出黄框（全部，不受截断线限制，分叉数量少）。 */
  export function buildTimeline(i: TimelineInput): TimelineItem[];
  export function costText(f: Pick<ForkView, "costUsd" | "costPartial" | "status">, t: UiStrings): string;
  export function modeText(mode: ForkMode, t: UiStrings): string;
  export function errorText(e: NonNullable<ForkView["error"]>, t: UiStrings, now: number): string;
  export function sendBlockText(r: DevSendBlock, t: UiStrings): string;
  export function rememberText(r: RememberResult, t: UiStrings): string;
  export function refusalText(code: string, t: UiStrings): string;   // ButlerError.code → 句子；不认识的给通用的
  ```

- [ ] **Step 1: 写失败测试 `conversation-view.test.ts`。**
  - **基本顺序**：
    - 三条普通消息，`refreshMarks` 一条（时间落在第 2、3 条之间）：结果依次是 `msg`、`msg`、`sep`、`msg`；
    - 分叉消息（`forkId: 7`）不出现在主流；`forks` 里 `id: 7`、`startedAt` 落在第 1、2 条之间：黄框排在那里；
    - 同一时间先排消息，再排黄框和汇报，最后排分隔线；`key` 都不重复。
  - **换新前后**：一个分叉 `startedAt` 早于换新、`lastAt` 晚于换新：黄框只出现一次，在换新以前的位置。
  - **截断线**：`convHasMore: true`、最早消息在 100；有一条汇报在 50、一条在 150：只出 150 那条。两边都没有更早的时，全出。
  - **汇报穿插**：`reportKind` 是 `done`、`blocked` 的汇报按 `createdAt` 排进消息之间，两种都在，没有丢。
  - **只看讨论**：只有 `fork` 项，全部黄框都在，包括截断线以前的。
  - **`costText`**：
    - `{ costUsd: null, costPartial: false, status: "running" }` → `S.conv.costPending`；
    - `{ null, true, "idle" }` → `S.conv.costUnknown`；
    - `{ 0.0312, true, … }` → `至少 $0.03`；
    - `{ 0.004, false }` → `<$0.01`；
    - `{ 1.2, false }` → `$1.20`；
    - 所有结果里都不含 `NaN`，也都不是空字符串。
  - **`errorText`**：
    - `rate_limited` 且 `resetAt` 在 `now` 之后：含恢复的时间；
    - `rate_limited` 且 `resetAt` 为 null：不含时间；
    - `interrupted`、`no_answer`、`timeout` 各有一句。
  - **`sendBlockText`**：`DevSendBlock` 的每一个取值都有一句非空的话。这条用循环来测，取值列表在测试里写死，跟类型对照。
- [ ] **Step 2: 运行确认失败。** 跑 `pnpm test src/renderer/src/conversation-view.test.ts`。
- [ ] **Step 3: 实现**，并按文案表加 `S.conv` 的中英两份。
- [ ] **Step 4: 运行。** 跑 `pnpm test src/renderer/src && pnpm typecheck`，预期 PASS（`strings.test.ts` 检查两种语言的键一致）。
- [ ] **Step 5: Commit**
  ```bash
  git add src/renderer/src/conversation-view.ts src/renderer/src/conversation-view.test.ts src/renderer/src/strings.ts src/renderer/src/strings-en.ts
  git commit -m "feat(ui): conversation timeline view logic"
  ```

---

### Task 10: `ConversationTab`、黄框、挂进 ticket 页和三个总控对话区、改落点

**Files:**
- Create: `src/renderer/src/components/ConversationTab.tsx`、`src/renderer/src/components/ForkBox.tsx`、`src/renderer/src/components/conversation-tab-render.test.ts`
- Modify:
  - 组件：`components/TicketPage.tsx`、`components/ControlConversation.tsx`、`components/EpicPage.tsx`、`components/FeaturePage.tsx`、`components/ButlerPage.tsx`；
  - 组件测试：`components/ticket-page-render.test.ts`、`components/scope-tabs-render.test.ts`；
  - 其他：`ticket-tabs.ts`、`ticket-tabs.test.ts`、`local-prefs.ts`、`styles.css`。
- Delete: `components/ConversationPlaceholder.tsx`、`S.lay.convPlaceholder`（中英）

**Interfaces:**
- Consumes: Task 8 的 `api.*`，Task 9 的 `buildTimeline` 等，`TerminalPane`，`useStateRefetch`。
- Produces:
  ```ts
  // ConversationTab.tsx（挂载点的 props 照第 3 层，另加三个可选项）
  export function ConversationTab(p: {
    rootSessionId: string;                       // 链上任意 id；默认显示的那个 session
    sessions: { id: string; label: string }[];   // 多于一个时顶上出切换条
    /** ticket 页传：渲染这个 session 的终端（复用 TicketPage 已有的 TerminalPane 状态）。不传就不出「并排显示终端」。 */
    renderTerminal?: (sessionId: string) => ReactNode;
    /** 总控对话区传：把这个范围的汇报按时间排进来。 */
    reportScope?: InboxScope;
  }): JSX.Element;
  // 只吃 props 的展示件（测试用）
  export function ConversationFeed(p: { items: TimelineItem[]; hasOlder: boolean; onOlder: () => void; actions: ForkActions; now: number }): JSX.Element;
  export function SendBar(p: { target: "dev" | "fork"; onTarget: (t: "dev" | "fork") => void; busy: boolean; notice: string | null;
    draft: string; onDraft: (s: string) => void; onSend: () => void }): JSX.Element;
  // ForkBox.tsx
  export interface ForkActions { followUp(forkId: number, q: string): void; sendConclusion(forkId: number): void; remember(forkId: number): void;
    reaskFull(forkId: number): void; retry(forkId: number): void; pending: Record<number, "ask" | "send" | "remember" | "reask" | undefined>;
    notice: Record<number, string | undefined> }
  export function ForkBox(p: { fork: ForkView; actions: ForkActions; now: number }): JSX.Element;
  // local-prefs.ts
  export function savedSendTarget(): "dev" | "fork";      // 默认 "fork"（草图里默认选中「只问不改」）
  export function saveSendTarget(t: "dev" | "fork"): void;
  ```

- [ ] **Step 1: 写失败的渲染测试 `conversation-tab-render.test.ts`。** 用 `createElement` 加 `renderToStaticMarkup`。
  - **`ForkBox`**：
    - 正在跑的精简分叉：
      - 含 `fork` 类；
      - 标题 `S.conv.forkHead`，即「讨论 · 从开发 session 分出来，只读，不影响它」；
      - 含 `精简上下文` 和 `S.conv.costPending`；
      - 「按这个改 → 发给 session」「记进记忆」「接着问」三个按钮都是 `disabled`；
      - 有「用完整上下文重问」。
    - 空闲的完整分叉：
      - 含 `完整上下文` 和 `$0.02`；
      - 没有「用完整上下文重问」；
      - 三个按钮都可以点。
    - 失败（`rate_limited`）：含 `errorText` 和「再问一次」。
    - 已发给 session：含 `已发给 session · ` 和时间。
    - `pending[id] === "send"` 时：那个按钮 `disabled`，文字是 `S.conv.sending`。
  - **`ConversationFeed`**：
    - `items` 里各种 `kind` 各一个：
      - 用户消息带 `msg-u`，并以「你：」开头；
      - agent 消息带 `msg-a`；
      - 分隔线带 `sep`，文字是 `S.conv.refreshSep(时间)`；
      - 汇报带 `inbox-report` 和类型标签。
    - `hasOlder` 为 true 时有「更早的」按钮。
    - `items: []` 时含 `S.conv.empty`。
  - **`SendBar`**：
    - `target: "fork"` 时，「只问不改（分叉讨论）」是选中的；
    - 有 `notice` 时把它显示出来，比如「你在终端里打了半句，先发完或清掉」；
    - `busy` 时发送按钮是 `disabled`。
  - **`ticket-page-render.test.ts`**：删掉 `ConversationPlaceholder` 的用例。
  - **`scope-tabs-render.test.ts`**：`ControlFeed` 的用例改成测 `ConversationFeed` 收到汇报项的情况。`ControlConversation` 在 `rootSessionId` 为 null 时还用 `ControlFeed`，保留它在 `reports: []` 时显示 `ctlEmpty` 的用例。
  - **`ticket-tabs.test.ts`**：`you/answer`、`you/stuck`（任何 source）→ `conversation`；`you/unattended` + `agent_stopped` 仍是 `terminal`。其余各行不变。
- [ ] **Step 2: 运行确认失败。** 跑 `pnpm test src/renderer/src/components/conversation-tab-render.test.ts src/renderer/src/ticket-tabs.test.ts`。
- [ ] **Step 3: 实现 `ForkBox.tsx` 和 `ConversationTab.tsx`。**
  - **选中的 session**：`useState(p.rootSessionId)`。`sessions.length > 1` 时，顶上出一排切换按钮（`conv-switch`）。切换以后清空已经加载的页。
  - **取数据**：
    - `conv:list(selected, { limit: 50 })`；点「更早的」时带上 `before: 最早一条的 at`；
    - `fork:list(selected)`；
    - 给了 `reportScope` 时，另取 `inbox:reports(scope, { limit: 30 })`，「更早的」也带 `before`。
  - **订阅**：`api.onConvAppended`（第 4 层的封装）和 `api.onForkChanged`。事件里的根跟当前显示的根一样时，重新取最新一页和分叉列表，用 `useStateRefetch` 的 80ms 防抖。当前的根取自 `ConvMessage.rootSessionId`；还没有消息时，用 `fork:list` 结果里的 `rootSessionId`。
  - **筛选**：「全部」「只看讨论」「搜索」：
    - 选「搜索」时出一个输入框，用 `conv:search(根, q)` 拿结果，平铺显示；属于分叉的那条带「讨论」标记。
    - 「只看讨论」把 `filter: "forks"` 交给 `buildTimeline`。
  - **「并排显示终端」**：只在给了 `renderTerminal` 时显示。点了以后外层加 `conv-split` 类，左边是 `renderTerminal(selected)`，右边是对话。这个开关按页面记在 `local-prefs`：`butler.convSplit:<page>`。
  - **输入框**：`SendBar` 下面的「发给」切换，用 `savedSendTarget` 记住上次选的。
    - 选「开发 session」：调 `api.convSend(selected, text)`。
      - `ok`：清空输入框；这句话由第 4 层从 transcript 记进对话，会自己出现。
      - 不 `ok`：保留草稿，用 `sendBlockText` 显示原因。
    - 选「只问不改」：调 `api.forkAsk(selected, null, text)`，成功后清空。
    - `ButlerError` 用 `refusalText(code)` 显示。
    - 发送中把按钮禁用。
  - **`ForkActions`**：
    - 每个动作都先把 `pending[id]` 设好，`finally` 里清掉。
    - `sendConclusion` 的结果：
      - `ok`：显示「已发给 session · 时间」；
      - 不 `ok`：显示 `sendBlockText`。
    - `remember`：显示 `rememberText`。
    - `reaskFull`：收到 `dev_busy`、`no_transcript` 时，用 `refusalText` 写在框里。
    - 「接着问」在框里展开一个小输入框，调 `forkAsk(selected, id, q)`。
    - 「再问一次」重发这个分叉里最后一条用户消息。
- [ ] **Step 4: 挂上去。**
  - **`TicketPage.tsx`**：把 `<ConversationPlaceholder …/>` 换成 `<ConversationTab rootSessionId={rootSessionId} sessions={…原样} renderTerminal={(id) => …} />`。
    - `renderTerminal` 用 `TicketPage` 里已经有的 `panes` 和 `open`，渲染同一个 `TerminalPane`：`termId` 取这个 session 的 `termId`，`visible` 为 true，`hibernated` 用 `hibernationOf`，`onClose` 和 `onResume` 跟终端 tab 一样。
    - session 没开着（没有 `termId`）时，渲染一句 `S.conv.termClosed` 和一个「到终端 tab 打开」按钮，它调用已有的 `onGoTab("terminal")`。
  - **删掉 `ConversationPlaceholder.tsx` 和 `S.lay.convPlaceholder`。** 先跑 `grep -rn "convPlaceholder\|ConversationPlaceholder" src e2e`，确认没有别的引用。
  - **`ControlConversation.tsx`**：props 不变。函数体改成：
    - `rootSessionId ?? sessions[0]?.id` 有值时，渲染 `<ConversationTab rootSessionId=… sessions={p.sessions} reportScope={p.scope} />`，再加 `footer`；
    - 都没有，也就是还没有总控 session 时，保留 `ControlFeed`，汇报照旧按时间显示，不丢。
    - `ControlFeed` 里自己排序的那段删掉，改用 `buildTimeline({ messages: [], …, reports })`，只留一种排法。
  - **`EpicPage.tsx`、`FeaturePage.tsx`、`ButlerPage.tsx`**：把传给 `ControlConversation` 的 `rootSessionId={null}` 改成那个总控 session 的 `SessionView.rootId`（第 4 层加的字段），也就是 `sessions` 列表的第一个。
  - **`ticket-tabs.ts`**：按 Step 1 的测试改 `landingTab`，文件里的规则注释同步改。
- [ ] **Step 5: CSS（`styles.css`）。** 照草图 `#t-conv` 的样式，颜色用变量，写在 `:root` 和暗色两处：
  - `.conv`、`.conv .tools`、`.conv .feed`；
  - `.msg-u`、`.msg-a`；
  - `.sep`：虚线，居中；
  - `.fork`：`border: 1px solid var(--fork-border)`，`background: var(--fork-bg)`。浅色时这两个变量取 `#f0c36d` 和 `#fffaf0`，暗色另外给一套；
  - `.fork .h`：`color: var(--fork-head)`，浅色取 `#a46a00`；
  - `.fork .acts`、`.conv-input`、`.conv-mode`、`.conv-switch`；
  - `.conv-split`：`display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-height: 0`，窗口窄于 900px 时改成单列。

  费用和模式只用文字表达，不另外上色。
- [ ] **Step 6: 运行。** 跑 `pnpm test src/renderer/src && pnpm typecheck && pnpm lint`，预期 PASS。
- [ ] **Step 7: 手工看一遍。** 跑 `pnpm dev`，开一个 ticket session，跑两轮。
  1. 打开对话 tab，按「只问不改」问一句：黄框出现，模式和费用都对；
  2. 接着问：回答进了同一个框；
  3. 点「按这个改」：终端里收到结论；
  4. 换新一次：出现分隔线，黄框还在；
  5. 在总控页确认汇报排在对话里；
  6. 从「轮到你」里点一条 `you/answer`：落在对话 tab。
- [ ] **Step 8: Commit**
  ```bash
  git add src/renderer/src
  git commit -m "feat(ui): conversation tab with fork boxes, send switch and side terminal"
  ```

---

### Task 11: e2e

**Files:**
- Modify: `e2e/fake-claude/fake-claude.cjs`
- Create: `e2e/conversation.spec.ts`

**Interfaces:**
- 给 `fake-claude.cjs` 加一种 `-p` 用法：带 `-p` 但**没有** `--json-schema` 时，当作分叉讨论。
  - 在运行记录里写一行 `fork-run <JSON：argv>`。
  - 回一个 `type: "result"`：
    - `result`：`分叉回答：<prompt 的最后一行>`；
    - `session_id`：有 `--fork-session` 或者没有 `--resume` 时，生成一个新 id；只有 `--resume X` 时就是 X；
    - `usage`：`{ input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0, output_tokens: 50 }`；
    - `total_cost_usd`：`0.02`。
  - prompt 里含「结论」两个字（也就是 `conclusionAsk`）时，回 `结论：把 X 改成 Y`。
  - 环境变量 `FAKE_CLAUDE_FORK=limit` 时，照 lessons 的 `limit:` 写法回一个撞额度的结果，然后退出 1。
  - 文件头部的用法注释也补上这一条。

- [ ] **Step 1: 写 `e2e/conversation.spec.ts`。** 照 `e2e/refresh.spec.ts` 的写法起 app，建 ticket `E2E-7`，开 session，在终端里发一句话让它记一轮。然后：
  1. **分叉**：打开「对话」tab，「发给」选「只问不改」，问「为什么？」。
     - 黄框出现，含「分叉回答：为什么？」和 `$0.02`；
     - 运行记录里那行 `fork-run` 的参数不含 `--no-session-persistence`、`--json-schema`，含 `dontAsk`。
  2. **接着问**：在框里问「还有呢？」。回答进了同一个框；新的那行 `fork-run` 含 `--resume <上一轮的 session_id>`，不含 `--fork-session`。
  3. **按这个改**：点「按这个改 → 发给 session」。框里显示「已发给 session」；fake claude 的运行记录里有一行 `prompt`，内容含「把 X 改成 Y」。
  4. **记进记忆**：点「记进记忆」，显示「已记下」。
  5. **撞限额**：设 `FAKE_CLAUDE_FORK=limit` 重新起 app，再分叉一次。框里显示限额那句话；用户的问题还在。
  6. **发给开发 session**：「发给」切到「开发 session」，发「继续」。运行记录里的 `prompt` 出现「继续」。
  7. **连点**：连点发送两次。只出一个黄框，运行记录里只多一行 `fork-run`。
- [ ] **Step 2: 运行。** 跑 `pnpm e2e e2e/conversation.spec.ts`，预期 PASS。然后跑全量 `pnpm e2e`。第 3 层改过的 e2e 里，凡是有点 ticket 页「对话」tab 的，按新内容更新。
- [ ] **Step 3: Commit**
  ```bash
  git add e2e/fake-claude/fake-claude.cjs e2e/conversation.spec.ts
  git commit -m "test(e2e): fork discussion, follow-up, send conclusion and limit"
  ```

---

## 文案表（渲染进程 `S.conv`，中英都要）

| 键 | 中文 | 英文 |
|---|---|---|
| `filterAll` / `filterForks` / `filterSearch` / `searchPlaceholder` | 全部 / 只看讨论 / 搜索 / 搜对话… | All / Discussions only / Search / Search the conversation… |
| `sideTerminal` / `hideTerminal` / `termClosed` / `openInTerminalTab` | 并排显示终端 / 收起终端 / 这个 session 没开着。 / 到终端 tab 打开 | Show terminal alongside / Hide terminal / This session isn't open. / Open it in the Terminal tab |
| `you` / `older` / `empty` | 你： / 更早的 / 还没有对话。 | You: / Earlier / No conversation yet. |
| `refreshSep(time)` | `{time} 换新了上下文 · handoff 已保存 · 对话已另存` | `{time} context refreshed · handoff saved · conversation kept` |
| `forkHead` | 讨论 · 从开发 session 分出来，只读，不影响它 | Discussion · forked from the dev session, read-only, doesn't touch it |
| `modeFull` / `modeLight` | 完整上下文 / 精简上下文 | Full context / Light context |
| `costPending` / `costUnknown` / `costAtLeast(usd)` / `costUnder` | 在算… / 费用未知 / `至少 {usd}` / <$0.01 | Calculating… / Cost unknown / `at least {usd}` / <$0.01 |
| `actSend` / `actRemember` / `actFollowUp` / `actReaskFull` / `actRetry` | 按这个改 → 发给 session / 记进记忆 / 接着问 / 用完整上下文重问 / 再问一次 | Do this → send to session / Save to memory / Ask more / Ask again with full context / Try again |
| `sending` / `sentAt(time)` / `remembered` / `memoryFull` / `memoryOff` / `memoryFailed` | 正在发… / `已发给 session · {time}` / 已记下 / 记忆满了，先清掉几条 / 记忆没开 / 没记上，稍后再试 | Sending… / `Sent to session · {time}` / Saved / Memory is full; clear some first / Memory is off / Couldn't save; try again later |
| `sendTo` / `toDev` / `toFork` / `askPlaceholder` / `send` | 发给： / 开发 session / 只问不改（分叉讨论） / 问点什么… / 发送 | Send to: / Dev session / Ask only (forked discussion) / Ask something… / Send |
| `block.closed` / `hibernated` / `busy` / `screen` / `needs_you` / `typing` / `draft` / `cost_paused` / `refreshing` / `exited` / `timeout` / `blocked` / `in_flight` / `fork_busy` / `no_conclusion` / `not_found` | session 没开着，先到终端 tab 打开它 / session 睡着了，先唤醒 / session 正在跑，等它停下再发 / 终端里开着别的界面，先关掉 / session 在等你回答，先回答它 / 你正在终端里打字，等一下再发 / 你在终端里打了半句，先发完或清掉 / 花费超了，已暂停 / 正在换新，等一下再发 / session 退出了 / 等了一分钟没发出去 / 没发出去 / 上一条还在发 / 讨论还在回答，等它答完 / 没拿到结论，再试一次 / 找不到这个 session | The session isn't open; open it in the Terminal tab / The session is asleep; wake it first / The session is working; send when it stops / Another screen is open in the terminal; close it first / The session is waiting for your answer; answer it first / You're typing in the terminal; send in a moment / There's a half-typed line in the terminal; send or clear it first / Spending is over the limit and paused / Refreshing; send in a moment / The session exited / Couldn't send within a minute / Not sent / The last one is still sending / The discussion is still answering; wait for it / Didn't get a conclusion; try again / Can't find this session |
| `refusal.fork_busy` / `dev_busy` / `no_transcript` / `no_claude` / `not_found` / `bad_question` / `other` | 这个讨论还在回答 / 开发 session 正在跑，等它停下再用完整上下文 / 这个 session 还没有对话记录，只能用精简上下文 / 找不到 claude，或 butler-hook 没装好（只读保护要靠它） / 找不到这个讨论 / 问题是空的或太长 / 出错了，再试一次 | This discussion is still answering / The dev session is working; use full context once it stops / This session has no transcript yet; only light context is possible / Can't find claude, or butler-hook isn't installed (read-only protection needs it) / Can't find this discussion / The question is empty or too long / Something went wrong; try again |
| `error.rate_limited(time\|null)` / `interrupted` / `no_answer` / `timeout` / `other` | `撞到用量限额了，{time} 后恢复` / 撞到用量限额了 / Butler 退出时还没答完 / 答完了，但是是空的 / 等太久没答完 / 没答上来 | `Hit the usage limit; back at {time}` / Hit the usage limit / Butler quit before it finished / It finished with an empty answer / Took too long / Couldn't answer |
| `forkTag` | 讨论 | Discussion |

---

## 对共用接口的建议

1. **第 4 层，写函数和按分叉读。** 索引里只定了读的 IPC，没有定写函数。本层假定有 `ConversationStore.append(m: Omit<ConvMessage, "id">): ConvMessage`，写完自己推送 `conv:appended`；还有 `byFork(forkId): ConvMessage[]`。
   - 如果第 4 层用了别的名字，请写进索引，本层照改。
   - 还请第 4 层确认两点：
     - `recentQa` 不收 `forkId` 不为 null 的消息。否则换新后的恢复提示会混进分叉里的闲聊，精简分叉也会把自己以前的问答再喂一遍。
     - 分叉消息的 `qa` 本层写 `false`；`conv:list` 带 `qaOnly` 时不返回它们。
2. **第 5 层，`fork:send-conclusion` 的返回。** 索引里写的是 `{ ok }`。本层返回 `{ ok: true, at } | { ok: false, reason: DevSendBlock }`，只是加了字段，不破坏 `{ ok }` 的读法。被挡下时用户要知道为什么（终端里有半句、正在换新、session 睡着了），所以 `reason` 必须有。建议在索引里补上。
3. **第 5 层，新增的 IPC。** 下面这些索引里没有，建议补进去：
   - `fork:list(anyId) => ForkView[]`：渲染黄框用；
   - `fork:remember(forkId) => { result }`：「记进记忆」；
   - `conv:send(anyId, text) => DevSendResult`：输入框「发给开发 session」；
   - `inbox:reports(scope, { before?, limit }) => { reports, hasMore }`：总控对话区的汇报要跟着对话一起往回翻，现在的 `inbox:list` 只给最近 30 条；
   - 推送事件 `fork:changed(rootSessionId)`：状态和费用变了，但对话没有新消息时也要刷新。
4. **第 5 层，`fork_discussions` 的列。** 索引里定的 8 列都在，另外加了这些：
   - `cost_partial`：区分「费用未知」和「至少 $x」；
   - `ticket_key`、`feature_id`：记忆的范围、费用归属；
   - `cwd`、`launch_args`：接着问时不依赖开发 session 现在的状态；
   - `status`、`error_code`、`error_reset_at`：失败和限额显示在框里；
   - `conclusion`、`conclusion_at`：连点或被挡下以后不用重新要结论，省钱；
   - `reask_of`：重问连点去重。
5. **第 3 层，`ConversationTab` 的 props。** 本层在 `{ rootSessionId, sessions }` 之外加了两个可选项：
   - `renderTerminal?: (sessionId) => ReactNode`：「并排显示终端」复用 `TicketPage` 已有的 `TerminalPane` 状态，不在对话 tab 里另开一份；
   - `reportScope?: InboxScope`：总控对话区把汇报排进对话流。

   两项都可选，第 3 层的挂载代码不用改。
6. **第 1 层，落点。** 本层把 `landingTab` 里 `you/answer`、`you/stuck` 的落点改成 `conversation`。如果第 1 层的 `TurnCard`「去看看」对这两种另有落点的写法，请统一走 `landingTab`。
