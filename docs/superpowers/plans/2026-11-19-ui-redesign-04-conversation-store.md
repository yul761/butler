# UI 重做第 4 层：对话另存（BTL-234）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Butler 自己存一份每条 `replaced_by` 链上双方说的话，并标出哪些轮是问答。这样换新和 `/clear` 照常进行，对话不会丢；换新后的恢复提示里多带上最近的问答。渲染进程能按链根翻页、搜索，也能收到「有新对话」的推送。本层不做界面。

**Architecture:**
- **存储**：SQLite 三张新表，外加一张可选的 FTS5 索引：
  - `conv_turns`：一轮对话，带问答标记。
  - `conv_messages`：只存说的话。
  - `conv_cursors`：每个 transcript 读到哪里。
  - `conv_fts`：trigram 全文索引；SQLite 没有 FTS5 时退回 LIKE。
- **读取**：主进程的 `ConvIngester` 从 Claude Code 的 JSONL 增量读：
  - 开着的 session 用 `DebouncedWatch` 监视。
  - 启动时和每 10 分钟补读一遍，app 关着时产生的对话也能补上。
  - 每读一块，写入和游标更新在同一个事务里提交。
  - 用 entry 的 `uuid` 去重。所以重读、文件被替换、`--resume` 复制的历史，都不会重复。
- **问答判断**：一轮结束后先跑规则，规则判不了的交给新任务 `conv_qa`（low、fallback、legacy haiku）。它走现有的 `execHeadlessJson`，所以路由、花费熔断、用量记录都沿用现有的做法。
- **对外接口**：`ConversationStore` 提供 `list`、`search`、`recentQa`、`append`、`byFork`。任何链上的 id 都先在主进程转成链根。分叉讨论的消息由第 5 层用 `append` 写入，`qa` 一律为 false，不走本层的问答规则，也不进 `recentQa`。
- **其他**：`SessionView` 加 `rootId`。`refresh-tail.ts` 不动。

**Tech Stack:** Electron 44（`node:sqlite`，SQLite 3.53，带 FTS5）、TypeScript、vitest（node 环境，`.node-version` 是 26.3.0，也带 FTS5）、zod。

**Spec:** `docs/superpowers/specs/2026-11-19-ui-redesign-design.md` §5.4（对话另存和换新）、§3（文案、150k 阈值不变）；索引和共用接口：`docs/superpowers/plans/2026-11-19-ui-redesign-00-index.md`「第 4 层产出」；第 3 层对本层的要求：`docs/superpowers/plans/2026-11-19-ui-redesign-03-layered-pages.md`「对共用接口的建议」第 3 条。

## 开工前已核实的事实

- **FTS5 可用**：
  - Electron 44.9.0 的 SQLite 3.53.4 编进了 `ENABLE_FTS5`。`CREATE VIRTUAL TABLE … USING fts5(text, tokenize='trigram')` 能建，中文能搜。
  - 本机 node 26.3.0 的 SQLite 3.53.1 也一样。
  - trigram 要求每个词至少 3 个字符，所以更短的词走 LIKE。
- **代码里没有「等用户看完再换新」的逻辑，也没有那个黄色提示**。
  - 黄框「上下文快满了。你刚问完问题，等你看完再换新」只出现在草图 `.superpowers/brainstorm/1247-1795150005/content/session-layout.html` 里，从没实现过。
  - 所以本层没有东西可删，只加一条回归测试，钉住「问答停下的 session 照常自动换新」（Task 7）。
  - `session-refresher.ts` 里现有的这些保护都要留着：
    - 「需要你」那道 guard（`autoRefreshNeedsYou`）：session 在等用户的决定，和「等用户看完」不是一回事。
    - R36：终端刚打开时等 60 秒，即 `REFRESH_OPEN_QUIET_MS`。
    - 打字、草稿、`awaiting_user`。
- **隐私**：
  - `sensitive_terms`（`src/main/db/terms-repo.ts`）和假名化只作用于经过 `PrivacyGateway` 发给个人 LLM 的请求。
  - 本机 `claude` 的后台调用不经过网关，也不写 `llm_audit`。`needs_you` 判断就是这样，直接把回复原文给 Haiku。
  - 仓库里没有密钥扫描器。
- **`SessionView`**：
  - 定义在 `src/shared/types.ts:164`，形如 `interface SessionView extends Session { termId: string | null }`。
  - 主进程有三处构造：
    - `src/main/sessions/session-service.ts:889` 的 `split()`
    - 同一文件 `:540` 的 `butlerView()` 里的 `lessonSessions`
    - `src/main/index.ts:2945` 给 `buildNowView` 的 `butler`
  - 测试里手搓 `SessionView` 的有：
    - `src/main/now/now-view.test.ts` 的 `session()`
    - `src/main/control/control-butler.test.ts:68` 的 `view()`
    - `src/renderer/src/sessions.test.ts` 的 `s()`
    - `src/renderer/src/repos.test.ts`

## Global Constraints

- **测试命令**照 `package.json` 写：
  - `pnpm test`（就是 `vitest run`），单个文件用 `pnpm test <路径>`
  - `pnpm typecheck`，即 `tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json`
  - `pnpm lint`，即 `eslint .`
  - 每个 Task 的最后一步都跑这三个命令，全部通过才能 commit。
  - 本层不改界面，不加 e2e。
- **commit 格式**：每个 commit 的 message 末尾都加一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- **新文案中英都要有**：
  - 主进程文案加在 `src/main/strings.ts` 的 `ZH` 和 `EN` 里。`EN` 的类型是 `MainStrings = typeof ZH`，少一个键 typecheck 就不过。
  - 英文里不能有汉字。
  - 本层不加渲染进程文案。
- **默认值不变**：3.0 的功能默认全关、Butler 默认不对外做任何事，这两条不能改。本层的情况：
  - 不新增任何对外动作。
  - `conv_qa` 是本机 `claude` 的后台调用，和 `needs_you` 一样走路由和花费熔断。它不在 `EXEMPT_TASKS` 里，熔断后就停，等恢复了再判。
  - 换新阈值 150k 和「session 停下」这个触发条件不变。
- **只存说的话**：
  - 工具调用、工具结果、bash 输出、本地命令输出、thinking、读了哪个文件，一律不存。
  - 工具调用只用来判断「改没改东西」，而且只在内存里记三个布尔量：`mutated`、`other_tools`，以及开轮时的 `asked`。
- **对话原文只留在本机**：
  - 和 JSONL、`handoffs.raw_text` 同一个信任级别。
  - 绝不放进 `PrivacyGateway` 的投影，也绝不放进发给个人 LLM 的任何东西。
  - 唯一离开数据库的路径有两条，都是本机 `claude`：
    - `conv_qa` 判断，问句取开头 1500 字、回答取结尾 1500 字
    - 换新的恢复文件
- **不留两套算法**：
  - 问答规则只有 `src/main/conversation/conv-qa.ts` 一份。
  - 「哪些 user 文本不算话」的规则只在 `src/main/conversation/conv-parse.ts` 一份。
  - `refresh-tail.ts` 有自己的过滤逻辑。它服务的是另一件事（给新 session 的工具摘要），本层不动它，也不让它依赖本层。
- **迁移只往 `MIGRATIONS` 末尾追加**：
  - 写本计划时有 82 条，本层这条会是 user_version 83。别的层先合并的话序号顺延。
  - 测试一律用 `MIGRATIONS.length`，不写死 83。
- **范围**：
  - 不加界面，也不加临时入口，这些归第 5 层。
  - 第 5 层的分叉讨论 session 不能被本层当成 transcript 去读，它们是 `recordHeadless` 记的 `discovered` 行，不在 `listConvTargets` 里。分叉的话由第 5 层调 `ConversationStore.append` 写进来，读回用 `ConversationStore.byFork`。

## Review Focus

1. **很长的回答或贴进来的长日志**：
   - 单条存储上限是 `CONV_TEXT_MAX = 20_000` 个字符：保留开头 16k 和结尾 4k，中间放中性标记 `[… N chars omitted …]`。
   - 一行 JSONL 比读块大（1 MiB）时，读块要扩大，不能截断。
   - 一行超过 `maxLineBytes`（默认 64 MiB）时，跳过这一行，游标照样往前走。
   - `recentQa` 遇到一轮比 `maxChars` 还长时，保留问题（最多 800 字）和回答的结尾，不会返回空，也不会超长。
   - 测试在 Task 3 的 `capText`、Task 5 的「超长行」、Task 7 的「单轮超长」。
2. **transcript 格式变了、坏行、半行**：
   - 坏 JSON、不认识的 `type`、`message` 缺失或者 content 形状不对：这一行跳过，不抛错，也不影响后面的行。
   - 没写完的最后半行不消费，等写完再读，只读一次。
   - 没有 `uuid` 的行用 `h:<sha1(行内容)>` 当去重键。
   - 测试在 Task 3 的「坏行和未知形状」、Task 5 的「半行」。
3. **同一个 session 在两个终端里开着**：
   - 比如用户在外面又 `claude --resume` 了同一个 id，两个进程交错往一个文件里写。
   - assistant 和工具 entry 按 `parentUuid` 归到它所属的那一轮。内存里的 uuid 到轮的映射最多记 2000 条，查不到时才退回「当前打开的轮」。
   - 读文件按 session 串行，两次 change 事件不会并发读同一个文件。
   - 测试在 Task 5 的「交错写入」和「并发 ingest」。
4. **app 关着时产生的对话**：
   - 启动时补读所有 target 的整条链：14 天内活动过的 head，以及每个 head 的 `chainOf`。
   - 游标在数据库里。app 重启、文件被替换（inode 变了）、文件变短、`/clear` 产生新 id 再连上 `replaced_by`，都不丢也不重复。
   - 补读出来的轮，如果结束时间早于 24 小时前，就直接记成 `no`，`qa_by` 写 `old`，不会一次触发几百个 Haiku 调用。
   - 先读到、后连上 `replaced_by` 的 session，会整体搬到新的链根下。
   - 测试在 Task 5 的「重启」「换文件」「变短」「迟到的链接」，Task 6 的「启动补读」「旧轮不判」。
5. **隐私**：
   - 不经过网关，不进个人 LLM，不写 `llm_audit`。
   - `conv_qa` 只拿截断后的问答，和 `needs_you` 一样。`sensitive_terms` 不适用，这一点在 `conv-qa.ts` 文件头写明。
   - 只读 target 的 transcript：Butler 自己开的、或者已认领到 ticket/feature/epic/Butler 总控的 session。没认领的 discovered session、headless 调用、复盘分析 session 都不读。
   - 测试在 Task 6 的「非 target 不读」，Task 4 的「判断的输入被截断」。

---

## 文件结构

新建：

| 文件 | 职责 |
|---|---|
| `src/shared/conversation.ts` | `ConvMessage`、`ConvPage`（按索引原样）、`ConvListOpts`、`CONV_LIST_MAX`、`CONV_QUERY_MAX` |
| `src/main/db/conv-repo.ts` | 三张表加 FTS 的读写；FTS 的探测、建立、退回 |
| `src/main/conversation/conv-parse.ts` | 纯函数：一行 JSONL → `ConvEntry[]`；文本清洗、`capText`、工具效果分类 |
| `src/main/conversation/conv-qa.ts` | `isQuestionLike`、`ruleQa`、`judgeConvQa`（任务 `conv_qa`） |
| `src/main/conversation/jsonl-reader.ts` | 按字节游标分块读完整行，处理 inode 变化和文件变短 |
| `src/main/conversation/conv-ingester.ts` | 轮次构建、游标、改链根；监视、补读、判断队列 |
| `src/main/conversation/conversation-store.ts` | `ConversationStore`：`list`、`search`、`recentQa`、`append`、`byFork`、`rootOf`；`withRecentQa`（写恢复文件） |
| `src/main/ipc/conv-handlers.ts` | `conv:list`、`conv:search` 的参数校验和转发 |
| `src/main/conversation/__fixtures__/conv.jsonl` | 解析和读取的样例 |
| 以上每个 `.ts` 对应的 `.test.ts` | |

修改：

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | `SessionView` 加 `rootId: string` |
| `src/main/db/sessions-repo.ts` | 加 `rootsOf(ids)`、`listConvTargets(sinceMs)` |
| `src/main/sessions/session-service.ts` | `split()`、`butlerView()` 填 `rootId` |
| `src/main/db/migrations.ts` | 追加一条迁移 |
| `src/shared/model-routing.ts` 及其 `.test.ts` | 登记 `conv_qa` |
| `src/main/strings.ts` | `convResume` 文案（中英） |
| `src/shared/ipc.ts` 及其 `.test.ts` | 加 `convList`、`convSearch`、`convAppended` |
| `src/main/metrics/interventions.ts` | 新 invoke 通道加进 `NOT_TRIGGERS`（只读） |
| `src/main/ipc/validate.ts` 及其 `.test.ts` | `convListOptsArg`、`convQueryArg`、`convRootArg` |
| `src/main/ipc/register.ts` | `IpcDeps.conv` 和 handler 注册 |
| `src/renderer/src/api.ts` | `convList`、`convSearch`、`onConvAppended` |
| `src/main/index.ts` | 组装、生命周期、`writeTail` 接线、`butler` 视图的 `rootId` |
| `src/main/sessions/session-refresher.test.ts` | 回归测试 |
| `src/main/now/now-view.test.ts`、`src/main/control/control-butler.test.ts`、`src/renderer/src/sessions.test.ts`、`src/renderer/src/repos.test.ts` | 构造 `SessionView` 的地方补上 `rootId` |

不动：`src/main/sessions/refresh-tail.ts`、`src/main/sessions/transcript-watch.ts`（只 import）、`src/main/sessions/session-refresher.ts`。

---

### Task 1: `SessionView.rootId`（第 3 层要的链根）

**Files:**
- Modify:
  - `src/shared/types.ts`
  - `src/main/db/sessions-repo.ts`
  - `src/main/sessions/session-service.ts`
  - `src/main/index.ts`（只改 `:2945` 一处）
  - 四个测试文件里构造 `SessionView` 的地方
- Test: `src/main/db/sessions-repo.test.ts`、`src/main/sessions/session-service.test.ts`

**Interfaces:**
- Consumes: `SessionsRepo.rootOf(id)`（`sessions-repo.ts:417`）的语义：从 head 往回走到最深的祖先；同一深度有多个时取 id 最小的；不认识的 id 返回 `null`。
- Produces:
  ```ts
  // src/shared/types.ts
  export interface SessionView extends Session {
    termId: string | null;
    /** replaced_by 链的根 session id（第 4 层对话按它存）；换新、/clear 以后不变。没有更早的段时等于 id。 */
    rootId: string;
  }
  // src/main/db/sessions-repo.ts
  /** 一次查完一批 id 的链根（视图每次刷新都要算，不能每行一条递归查询）；不认识的 id 映射到它自己。 */
  rootsOf(ids: readonly string[]): Map<string, string>;
  ```

- [ ] **Step 1: 写失败的测试**
  - 在 `sessions-repo.test.ts` 的 `describe("SessionsRepo.rootOf (workstream L)")` 旁边新加 `describe("SessionsRepo.rootsOf")`，覆盖三种情况：
    - 链 `a → b → c`（`setReplacedBy("a","b")`、`setReplacedBy("b","c")`）加上单独的 `x` 时，`rootsOf(["c","b","x","nope"])` 等于 `Map{c→a, b→a, x→x, nope→nope}`。
    - 对上面每个已知 id，`rootsOf([id]).get(id)` 都等于 `rootOf(id)`。
    - `rootsOf([])` 返回空 Map，并且不查库。
  - 在 `session-service.test.ts` 的 `describe("SessionService views")` 里加一个测试：
    - 准备一条链：`sessions.insertIfAbsent` 建 `old`，`setReplacedBy("old","c2")`。
    - `service.ticketViews()[0].sessions` 里 `c2` 的 `rootId` 应该是 `"old"`，`new-1` 的 `rootId` 是它自己。
    - `butlerView().lessonSessions` 每一项都要有 `rootId`。

- [ ] **Step 2: 运行确认失败**
  - `pnpm test src/main/db/sessions-repo.test.ts src/main/sessions/session-service.test.ts`
  - 预期 FAIL：`rootsOf is not a function`，`rootId` 是 `undefined`。

- [ ] **Step 3: 实现**
  - `rootsOf` 用一条递归 CTE 实现，`ids` 通过 `json_each(?)` 传入，参数是 `JSON.stringify(ids)`：
    ```sql
    WITH RECURSIVE chain(start, id, depth) AS (
      SELECT value, value, 0 FROM json_each(?)
      UNION SELECT c.start, s.id, c.depth + 1 FROM sessions s JOIN chain c ON s.replaced_by = c.id WHERE c.depth < ${ROOT_MAX_DEPTH}
    )
    SELECT start, id FROM chain ORDER BY start, depth DESC, id
    ```
    每个 `start` 取第一行。
  - `SessionView` 加字段。
  - `session-service.ts` 的 `split()` 改成：先 `const roots = this.d.sessions.rootsOf(rows.map((s) => s.id))`，再 `({ ...s, termId: …, rootId: roots.get(s.id) ?? s.id })`。`butlerView()` 的 `lessonSessions` 同样处理。
  - `index.ts:2945` 改成 `{ ...b, termId: sessionService.termIdOf(b.id), rootId: sessions.rootOf(b.id) ?? b.id }`。

- [ ] **Step 4: 补齐测试里的构造**
  - 跑 `pnpm typecheck`，按报错给每个手搓的 `SessionView` 补上 `rootId`：
    - `now-view.test.ts` 的 `session()` 默认 `rootId: id`。
    - `control-butler.test.ts:68` 是 `rootId: id`。
    - `sessions.test.ts` 和 `repos.test.ts` 的工厂默认 `rootId: id`，放在 `...over` 前面。
  - 再跑一次 `pnpm typecheck`，预期 PASS。

- [ ] **Step 5: 全量验证**
  - `pnpm test && pnpm typecheck && pnpm lint`，预期全部 PASS。

- [ ] **Step 6: Commit**
  - `git add src/shared/types.ts src/main/db/sessions-repo.ts src/main/db/sessions-repo.test.ts src/main/sessions/session-service.ts src/main/sessions/session-service.test.ts src/main/index.ts src/main/now/now-view.test.ts src/main/control/control-butler.test.ts src/renderer/src/sessions.test.ts src/renderer/src/repos.test.ts`
  - message 是 `feat(sessions): expose chain root id on SessionView`。

---

### Task 2: 共享类型、迁移、`ConvRepo`、搜索

**Files:**
- Create: `src/shared/conversation.ts`、`src/main/db/conv-repo.ts`
- Modify: `src/main/db/migrations.ts`
- Test: `src/main/db/conv-repo.test.ts`

**Interfaces:**
- Consumes: `Db`、`migrate`、`withTransaction`（`src/main/db/database.ts`），`memDb()`（`src/main/test-utils.ts`）。
- Produces:
  ```ts
  // src/shared/conversation.ts（ConvMessage、ConvPage 和索引逐字一致）
  export interface ConvMessage { id: number; rootSessionId: string; sessionId: string; role: "user" | "assistant"; text: string; at: number; forkId: number | null; qa: boolean; }
  export interface ConvPage { messages: ConvMessage[]; refreshMarks: { at: number; sessionId: string }[]; hasMore: boolean }
  /** conv:list 的选项。before 是已显示的最早那条消息的 id（不是时间）。 */
  export interface ConvListOpts { before?: number; limit: number; qaOnly?: boolean }
  export const CONV_LIST_MAX = 200;
  export const CONV_QUERY_MAX = 200;
  export const CONV_SEARCH_LIMIT = 50;

  // src/main/db/conv-repo.ts
  export type TurnKind = "user" | "silent" | "handoff" | "fork" | "orphan";
  export type QaState = "pending" | "yes" | "no";
  export type QaBy = "rule" | "judge" | "fork" | "judge_failed" | "old";
  export interface ConvTurn {
    id: number; rootSessionId: string; sessionId: string; sourceKey: string | null; forkId: number | null; kind: TurnKind;
    startedAt: number; lastAt: number; endedAt: number | null; asked: boolean; mutated: boolean; otherTools: boolean; qa: QaState; qaBy: QaBy | null;
  }
  export interface ConvCursor { sessionId: string; rootSessionId: string; file: string; ino: number; offset: number; openTurnId: number | null; updatedAt: number }
  export class ConvRepo {
    constructor(db: Db, opts?: { fts?: boolean });   // 不给 fts 时探测
    readonly searchMode: "fts" | "like";
    /** INSERT OR IGNORE：同一链根下 sourceKey 已有时返回已有那一轮的 id，不改它。 */
    openTurn(t: { rootSessionId: string; sessionId: string; sourceKey: string | null; forkId: number | null; kind: TurnKind; at: number; asked: boolean }): number;
    turn(id: number): ConvTurn | null;
    /** 标志只会从 0 变 1（重读同一段不会把 mutated 清掉）；lastAt 取较大值；endedAt 只在还是 NULL 时写。 */
    touchTurn(id: number, p: { at: number; mutated?: boolean; otherTools?: boolean; endedAt?: number }): void;
    /** 返回是否真的改了（已经是这个值就返回 false）。 */
    setQa(id: number, qa: QaState, by: QaBy): boolean;
    /** kind='user'、qa='pending'、已结束的轮，最早结束的在前。 */
    pendingEnded(limit: number): ConvTurn[];
    /** 一直没结束、lastAt 早于 before 的轮写上 endedAt = lastAt；返回条数。 */
    endStale(before: number): number;
    /** 同一链根下 sourceKey 重复时返回 null（什么都不写）。 */
    addMessage(m: { turnId: number; rootSessionId: string; sessionId: string; role: "user" | "assistant"; text: string; at: number; forkId: number | null; sourceKey: string | null }): ConvMessage | null;
    turnMessages(turnId: number): ConvMessage[];
    page(rootSessionId: string, opts: ConvListOpts): { messages: ConvMessage[]; hasMore: boolean };
    search(rootSessionId: string | null, query: string, limit?: number): ConvMessage[];
    /** qa='yes' 且不是分叉的轮，最新的在前，每次最多 limit 轮（recentQa 往前取够字数为止）。 */
    qaTurns(rootSessionId: string, o: { beforeStartedAt?: number; limit: number }): ConvTurn[];
    /** 这个链根下这个分叉最新的一轮（append 写 assistant 时挂在它上面）。 */
    latestForkTurn(rootSessionId: string, forkId: number): ConvTurn | null;
    /** 这个分叉的全部消息，按 (at, id) 升序。 */
    forkMessages(forkId: number): ConvMessage[];
    cursor(sessionId: string): ConvCursor | null;
    saveCursor(c: ConvCursor): void;
    /** 把这个 session 的轮、消息、游标搬到新链根；新链根下已有同一个 sourceKey 的，丢掉旧链根下的那份。 */
    reroot(sessionId: string, newRoot: string): void;
  }
  ```
- 迁移，追加到 `MIGRATIONS` 末尾，前面加中文注释「第 4 层对话另存（BTL-234）」：
  ```sql
  CREATE TABLE conv_turns (
    id INTEGER PRIMARY KEY,
    root_session_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    source_key TEXT,
    fork_id INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('user','silent','handoff','fork','orphan')),
    started_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    ended_at INTEGER,
    asked INTEGER NOT NULL DEFAULT 0,
    mutated INTEGER NOT NULL DEFAULT 0,
    other_tools INTEGER NOT NULL DEFAULT 0,
    qa TEXT NOT NULL DEFAULT 'pending' CHECK (qa IN ('pending','yes','no')),
    qa_by TEXT CHECK (qa_by IN ('rule','judge','fork','judge_failed','old')));
  CREATE UNIQUE INDEX conv_turns_source ON conv_turns (root_session_id, source_key) WHERE source_key IS NOT NULL;
  CREATE INDEX conv_turns_pending ON conv_turns (ended_at) WHERE qa = 'pending';
  CREATE INDEX conv_turns_root ON conv_turns (root_session_id, qa, started_at);
  CREATE TABLE conv_messages (
    id INTEGER PRIMARY KEY,
    turn_id INTEGER NOT NULL REFERENCES conv_turns(id) ON DELETE CASCADE,
    root_session_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    fork_id INTEGER,
    source_key TEXT);
  CREATE UNIQUE INDEX conv_messages_source ON conv_messages (root_session_id, source_key) WHERE source_key IS NOT NULL;
  CREATE INDEX conv_messages_root_at ON conv_messages (root_session_id, at, id);
  CREATE INDEX conv_messages_turn ON conv_messages (turn_id, at, id);
  CREATE INDEX conv_messages_fork ON conv_messages (fork_id, at, id) WHERE fork_id IS NOT NULL;
  CREATE TABLE conv_cursors (
    session_id TEXT PRIMARY KEY,
    root_session_id TEXT NOT NULL,
    file TEXT NOT NULL,
    ino INTEGER NOT NULL,
    byte_offset INTEGER NOT NULL,
    open_turn_id INTEGER,
    updated_at INTEGER NOT NULL);
  ```
  - `fork_id` 不加外键，`fork_discussions` 是第 5 层建的表。
  - 列名用 `byte_offset`，避开 SQL 关键字 `OFFSET`。
- **FTS 不进迁移**：`fts5` 模块缺失时，迁移会整条失败，app 就打不开了。所以 FTS 放在 `ConvRepo` 构造函数里建，幂等：
  1. 先 `CREATE VIRTUAL TABLE IF NOT EXISTS conv_fts USING fts5(text, content='conv_messages', content_rowid='id', tokenize='trigram')`。这一步抛错时：
     - `DROP TRIGGER IF EXISTS` 删掉三个触发器。删触发器不需要模块，删掉以后插入不会因为缺模块而失败。
     - `searchMode` 设成 `"like"`。
  2. 建成功了，就建 `conv_fts_ai`、`conv_fts_ad` 和 `conv_fts_au` 三个触发器，都用 `IF NOT EXISTS`；其中 `conv_fts_au` 是 `AFTER UPDATE OF text`。
  3. 如果这次是新建的表、而 `conv_messages` 里已经有数据，就执行一次 `INSERT INTO conv_fts(conv_fts) VALUES('rebuild')`。
  4. `opts.fts === false` 时直接走第 1 步里失败的那条路径，测试用它。

- [ ] **Step 1: 写失败的测试 `conv-repo.test.ts`**
  - **迁移**：`migrate(memDb())` 返回 `MIGRATIONS.length`，三张表都在。
  - **建表的环境**：`new ConvRepo(db).searchMode === "fts"`。这同时证明测试环境和 Electron 一样带 FTS5。
  - **`openTurn` 去重**：同一个 `(root, sourceKey)` 开两次，返回同一个 id。`sourceKey` 是 `null` 时每次都新开一轮。
  - **`addMessage` 去重**：同一个 `sourceKey` 写两次，第二次返回 `null`，总条数不变。
  - **`touchTurn`**：`mutated: true` 以后再传 `mutated: false`，结果仍是 true；`endedAt` 只写第一次。
  - **`page` 翻页**：25 条消息，`limit: 10` 时：
    - 第一页是最新的 10 条，按升序排，`hasMore: true`。
    - `before: 第一页[0].id` 取下一页。
    - 最后一页 `hasMore: false`。
    - 同一个 `at` 的两条按 id 区分，不重复也不漏。
    - `qaOnly: true` 只返回 `qa='yes'` 那些轮的消息，`ConvMessage.qa` 也是 `true`。
  - **`search`**：用 `describe.each([{ fts: undefined }, { fts: false }])` 两种模式各跑一遍：
    - 中文 3 字以上（「换新阈值」）能命中；
    - 两个字的词（「蓝色」）走 LIKE，也能命中；
    - 多个词是 AND 的关系；
    - `%`、`_`、`"` 当普通字符处理；
    - 空串和全空白返回 `[]`；
    - `rootSessionId` 为 `null` 时跨链根搜索；
    - 结果最新的在前，最多 `CONV_SEARCH_LIMIT` 条。
  - **`reroot`**：
    - 准备：session `s2` 的消息记在根 `s2` 下，新链根 `s1` 下已有一条同 `sourceKey` 的消息。
    - 执行 `reroot("s2","s1")` 以后：`s1` 下只有一份；`s2` 根下什么都不剩；游标的 `rootSessionId` 变成 `s1`；FTS 仍然能搜到。

- [ ] **Step 2: 运行确认失败**
  - `pnpm test src/main/db/conv-repo.test.ts`，预期 FAIL：模块不存在。

- [ ] **Step 3: 实现 `src/shared/conversation.ts`、迁移和 `ConvRepo`**
  - `page`：
    - 先查 `before` 那条的 `(at, id)`。`before` 不存在时按「没有 before」处理。
    - 条件是 `m.at < ? OR (m.at = ? AND m.id < ?)`，`ORDER BY m.at DESC, m.id DESC LIMIT limit+1`。
    - 用 `JOIN conv_turns t ON t.id = m.turn_id` 取 `qa`。
    - 多出来的一条决定 `hasMore`，其余倒序返回。
  - `search`：
    - 先截到 `CONV_QUERY_MAX`，再按空白切词。
    - fts 模式下，至少 3 个码点的词写成 `"…"` 短语（内部的 `"` 写两遍），用 AND 连起来去 MATCH。
    - 其余的词，以及 like 模式下的所有词，都是 `m.text LIKE ? ESCAPE '\'`，`%`、`_`、`\` 先转义。
  - `reroot`：在 `withTransaction` 里依次执行：
    1. `UPDATE OR IGNORE conv_turns SET root_session_id = ? WHERE session_id = ?`
    2. 撞上唯一索引没搬走的轮：把它的消息改挂到新链根下同 `source_key` 的那一轮，然后删掉它。
    3. `UPDATE OR IGNORE conv_messages SET root_session_id = ? WHERE session_id = ?`，再删掉剩下的。
    4. 更新游标。

- [ ] **Step 4: 运行确认通过**
  - `pnpm test src/main/db/conv-repo.test.ts`，预期 PASS。

- [ ] **Step 5: 全量验证**
  - `pnpm test && pnpm typecheck && pnpm lint`。

- [ ] **Step 6: Commit**
  - `git add src/shared/conversation.ts src/main/db/conv-repo.ts src/main/db/conv-repo.test.ts src/main/db/migrations.ts`
  - message 是 `feat(conv): conversation tables, repo and search`。

---

### Task 3: 解析和过滤规则（纯函数）

**Files:**
- Create:
  - `src/main/conversation/conv-parse.ts`
  - `src/main/conversation/conv-parse.test.ts`
  - `src/main/conversation/__fixtures__/conv.jsonl`
- Test 里还复用 `src/main/sessions/__fixtures__/refresh-tail.jsonl`

**Interfaces:**
- Consumes:
  - `isToolResultOnly`、`isHandoffInvocation`，来自 `src/main/handoff/transcript.ts`
  - `classifyCommand`，来自 `src/main/sessions/activity-parse.ts`，只用来认 push 和 rebase
  - `MAIN_STRINGS`，来自 `src/main/strings.ts`，用两种语言的文案开头拼出匹配表，做法同 `refreshCommandMatcher`
- Produces:
  ```ts
  export const CONV_TEXT_MAX = 20_000;
  export type ToolEffect = "read" | "mutate" | "other";
  /** user 文本怎么处理：user 存且开一轮；relay 存但开的是不判问答的一轮；silent 不存只开一轮；handoff 不存、这一轮 agent 的话也不存。 */
  export type UserOpen = "user" | "relay" | "silent" | "handoff";
  export type ConvEntry =
    | { kind: "user"; key: string; parent: string | null; at: number | null; open: UserOpen; text: string | null }
    | { kind: "assistant"; key: string; parent: string | null; at: number | null; text: string; stop: boolean }
    | { kind: "tool"; key: string; parent: string | null; at: number | null; name: string; effect: ToolEffect; stop: boolean }
    /** 不是话、也不开新轮（工具结果、本地命令输出、isMeta、compact 摘要、API 错误……）：只用来接上 parentUuid。 */
    | { kind: "noise"; key: string; parent: string | null; at: number | null };
  export function convEntriesOf(line: string): ConvEntry[];
  export function cleanUserText(raw: string): string;
  export function userOpenOf(content: unknown, cleaned: string): UserOpen | "noise";
  export function toolEffect(name: string, input: unknown): ToolEffect;
  export function capText(text: string, max?: number): string;
  ```
- **规则**（文件头把下面几条逐条写成注释，测试也逐条覆盖）：
  1. **整行跳过，返回 `[]`**：
     - JSON 解析失败
     - `type` 不是 `user`，也不是 `assistant`
     - `isSidechain === true`，即子 agent 的对话
  2. **返回 `noise`**：
     - `isMeta`
     - `isCompactSummary`
     - `isApiErrorMessage`
     - `message.model === "<synthetic>"`
     - user 的 content 只有 `tool_result`（`isToolResultOnly`）
     - 清洗后文本为空
     - 见第 4 条
  3. **user 文本清洗**（`cleanUserText`）：
     - 去掉 `<system-reminder>…</system-reminder>`、`<ide_selection>…`、`<ide_opened_file>…`、`<ide_diagnostics>…`。
     - 再 trim。
     - content 是数组时，`text` 块用 `\n\n` 连起来；每个 `image` 块记成 `[image]`。
  4. **不是话、也不开新轮，算 noise**：清洗后满足下面任一条：
     - 以 `<local-command-stdout>`、`<local-command-stderr>`、`<local-command-caveat>`、`<bash-input>`、`<bash-stdout>`、`<bash-stderr>`、`<task-notification>` 开头
     - 以 `[Request interrupted by user` 开头
  5. **`handoff`**（不存，这一轮 agent 的话也不存）：
     - `isHandoffInvocation(content)`
     - 以 `refreshEpicHandoff` 或 `idleCloseEpicHandoff` 的开头开始，中英各取文案的前 24 个字符
  6. **`silent`**（不存，开一轮 `qa='no'`；agent 的话照存）：
     - 其他含 `<command-name>` 的斜杠命令
     - 匹配 `/^Butler(：|: )/` 的通知，CI、合并、review 评论都是这种
     - 以 `refreshResume("ticket","X-1",null)` 或 `inboxReportsIntro` 的开头开始，中英各取前 16 个字符
  7. **`relay`**（存成 user 消息，但这一轮 `qa='no'`）：以 `inboxAnswersIntro` 的开头开始。这是 Butler 转给 agent 的用户回答，内容是用户说的话。
  8. **其余都是 `user`**。
  9. **assistant**：
     - 只取 `text` 块，用 `\n\n` 连起来，不要 `thinking`；结果为空时不产生 assistant entry。
     - 每个 `tool_use` 块产生一个 `tool` entry。
     - `stop` 等于 `message.stop_reason === "end_turn"`，只挂在这一行的最后一个 entry 上。
  10. **key**：
      - 用 `uuid`；没有 `uuid` 时用 `h:` 加上 sha1 的十六进制，sha1 是对整行原文算的。
      - 同一行有多个 entry 时，第二个起在 key 后面加 `#1`、`#2`……
  11. **时间**：`at` 是 `Date.parse(timestamp)`，解析失败时为 `null`。
  12. **工具效果**（`toolEffect`）：
      - **mutate**：
        - `Edit`、`Write`、`MultiEdit`、`NotebookEdit`
        - `Bash`，命令匹配下列任一种：
          - `\bgit\s+(commit|push|merge|rebase|reset|cherry-pick|am|revert|tag|stash)\b`
          - `\bgh\s+pr\s+(create|merge|edit|comment|close|ready)\b`
          - `\bsed\s+-i\b`
          - `(^|[;&|]\s*)(rm|mv|cp|mkdir|touch|chmod)\s`
          - 包含 `>` 或 `>>` 重定向，但写到 `/dev/null` 的不算
          - `classifyCommand` 返回 `push` 或 `rebase`
        - 名字以 `mcp__` 开头、且含 `create|push|merge|update|delete|write|commit|remember|forget|handoff|set_` 的
      - **read**：
        - `Read`、`Grep`、`Glob`、`LS`、`WebFetch`、`WebSearch`、`TodoWrite`、`BashOutput`、`ToolSearch`、`AskUserQuestion`
        - `Bash`：按 `&&`、`;`、`|` 拆开后，每一段的第一个词都在只读表里：
          - `git status|log|diff|show|blame|branch`
          - `ls`、`cat`、`grep`、`rg`、`find`、`head`、`tail`、`wc`、`pwd`、`echo`
          - `gh pr view|checks|list|diff`
          - `gh run view|list`
        - `mcp__` 名字含 `get|list|search|read|view|recall|facts|why|status|activity` 的
      - **other**：其余全部，比如 `Task`、不认识的 Bash、不认识的 mcp。
  13. **长度上限**（`capText`）：超过 `max` 时保留开头 `max-4000` 个字符和结尾 4000 个，中间插入 `\n\n[… ${n} chars omitted …]\n\n`。按码点切，不切坏代理对。

- [ ] **Step 1: 写 fixture `conv.jsonl`**，每行一个 entry，按顺序：
  1. user 问「换新阈值是多少？」，带一个 `<system-reminder>`
  2. assistant 先写 text「我看一下」，再调一次 `Read`
  3. user 的 `tool_result`
  4. assistant 回答「150k。」，`stop_reason: "end_turn"`
  5. user 说「把按钮改成蓝色」
  6. assistant 调 `Edit`
  7. `tool_result`
  8. assistant 回「改好了」，`end_turn`
  9. `/model` 命令，跟一条 `<local-command-stdout>`
  10. `Butler：PROJ-1 的 CI 全部通过（abc1234）。可以继续下一步。`
  11. assistant 回「收到」
  12. 一行坏 JSON：`{"type":"user",`
  13. 一行 sidechain
  14. 一个只有 image 的 user 消息
  15. 一行 `{"type":"summary"}`
  16. 一行没有 `uuid` 的 assistant text

- [ ] **Step 2: 写失败的测试 `conv-parse.test.ts`**
  - fixture 整体：`fixture.flatMap(convEntriesOf)` 的 `kind`、`open`、`text`、`effect` 序列和上面的说明一一对应，用 `toEqual` 写出完整的期望数组。
    - 坏行、sidechain、summary 都不出现。
    - image 那条的 text 是 `"[image]"`。
    - 没有 uuid 的那行，key 以 `h:` 开头，同样的行算出同样的 key。
  - 复用 `refresh-tail.jsonl`：
    - `/model sonnet` 是 `silent`，它的 stdout 是 `noise`。
    - 「开 PR 吧」去掉了 system-reminder。
    - `mcp__github__create_pull_request` 是 `mutate`。
    - `/handoff` 是 `handoff`，它的 isMeta 展开是 `noise`。
    - sidechain 不出现。
    - thinking 不出现在任何 text 里。
  - Butler 文案两种语言都要认对：对 `setLang("zh")` 和 `setLang("en")` 各跑一遍，`afterEach` 还原成 zh。
    - `M().refreshEpicHandoff` 和 `M().idleCloseEpicHandoff` 是 `handoff`。
    - `M().refreshResume("ticket","PROJ-1","/x")`、`M().ciPassedNotice("PROJ-1","abc1234")`、`M().inboxReportsIntro + "\n…"` 是 `silent`。
    - `M().inboxAnswersIntro + "\n" + M().inboxAnswer("q","a")` 是 `relay`。
    - 普通的「这个怎么做？」是 `user`。
  - `toolEffect` 用表驱动：每条 mutate 和 read 规则至少一例正、一例反。
    - `git status && git diff` 是 read。
    - `git log | head > /tmp/x` 是 mutate。
    - `echo hi > /dev/null` 是 read。
    - `pnpm test` 是 other。
    - `mcp__butler-workspace__recall` 是 read。
    - `mcp__butler-workspace__remember` 是 mutate。
  - **坏行和未知形状**：
    - `message` 缺失
    - `content` 是数字
    - `content` 数组里有未知块
    - `tool_use` 没有 `input`
    - `timestamp` 不是字符串

    都不抛错：要么返回 `[]`，要么返回带 `at: null` 的 entry。
  - `capText`：
    - 长度不超过 `max` 时原样返回。
    - `"a".repeat(30_000)` 处理后长度不超过 `CONV_TEXT_MAX + 40`，以 16000 个 `a` 开头、4000 个 `a` 结尾，中间写着 `10000 chars omitted`。
    - 把 emoji 放在切口位置，结果里没有孤立的代理字符。

- [ ] **Step 3: 运行确认失败**
  - `pnpm test src/main/conversation/conv-parse.test.ts`。

- [ ] **Step 4: 实现 `conv-parse.ts`**
  - 只 import `transcript.ts`、`activity-parse.ts`、`strings.ts` 和 `node:crypto`。
  - 不读文件，不碰数据库。

- [ ] **Step 5: 运行确认通过，再全量验证**
  - `pnpm test src/main/conversation/conv-parse.test.ts`
  - `pnpm test && pnpm typecheck && pnpm lint`

- [ ] **Step 6: Commit**
  - `git add src/main/conversation/conv-parse.ts src/main/conversation/conv-parse.test.ts src/main/conversation/__fixtures__/conv.jsonl`
  - message 是 `feat(conv): transcript speech parser and filtering rules`。

---

### Task 4: 问答规则和 `conv_qa` 判断

**Files:**
- Create: `src/main/conversation/conv-qa.ts`、`src/main/conversation/conv-qa.test.ts`
- Modify: `src/shared/model-routing.ts`、`src/shared/model-routing.test.ts`

**Interfaces:**
- Consumes:
  - `execHeadlessJson`、`HeadlessExecDeps`，来自 `src/main/handoff/headless-exec.ts`
  - `headlessArgs`，来自 `src/main/claude/headless.ts`
  - `toCliJsonSchema`、`validate`，来自 `src/main/handoff/schema.ts`
  - `currentLang`，来自 `src/main/i18n.ts`
  - 写法和 `src/main/sessions/needs-you.ts` 的 `judgeNeedsYou` 一样
- Produces:
  ```ts
  export const CONV_QA_QUESTION_CHARS = 1500;   // 问句取开头
  export const CONV_QA_ANSWER_CHARS = 1500;     // 回答取结尾
  export const CONV_QA_SHORT_REPLY = 6;         // 不像问句、没调工具、回答不超过这么多字：不是问答
  export function isQuestionLike(text: string): boolean;
  export type RuleVerdict = "yes" | "no" | "judge";
  export function ruleQa(t: { asked: boolean; mutated: boolean; otherTools: boolean; answerChars: number }): RuleVerdict;
  /** true / false：模型的结论；"paused"：花费熔断，这一轮留着下次再判；null：其它失败（调用方记 no / judge_failed）。 */
  export type ConvQaVerdict = boolean | "paused" | null;
  export async function judgeConvQa(d: HeadlessExecDeps, turn: { question: string; answer: string }, cwd: string, ticketKey?: string | null): Promise<ConvQaVerdict>;
  ```
- **`isQuestionLike`**：先去掉代码块（```…```）、行内代码、URL，然后满足下面任一条就算问句：
  - 有 `?` 或 `？`
  - 包含下面任一个词：吗、嘛、呢、怎么、怎样、如何、为什么、为啥、什么、是不是、能不能、可不可以、会不会、有没有、要不要、对不对、行不行、哪里、哪个、哪些、多少、区别
  - 某个英文句子以下面任一个词开头（不分大小写）：what、why、how、when、where、which、who、is、are、does、do、can、could、should、would、will
- **`ruleQa`**，按顺序判断：
  1. `mutated` 时是 `no`。
  2. `answerChars === 0` 时是 `no`。
  3. `asked && !otherTools` 时是 `yes`。
  4. `asked && otherTools` 时是 `judge`。
  5. `!asked && otherTools` 时是 `no`。
  6. `!asked && answerChars <= CONV_QA_SHORT_REPLY` 时是 `no`。
  7. 其余是 `judge`。
- **`judgeConvQa`**：
  - 参数是 `args = headlessArgs({ schema: toCliJsonSchema(z.object({ qa: z.boolean() })), allowedTools: [] })`。
  - 调 `execHeadlessJson(d, { task: "conv_qa", label: "conv qa judge", args, prompt, cwd, ticketKey })`。
  - 提示按 `currentLang()` 分中英两版，大意是：「下面是用户的一句话和 agent 的回答。这一轮是不是用户在提问、agent 在回答（而不是布置任务、agent 去做事）？只回答 JSON。」
  - 问句截到开头 `CONV_QA_QUESTION_CHARS`，回答截到结尾 `CONV_QA_ANSWER_CHARS`。
  - 返回值：
    - `!r.ok && r.reason === "cost_paused"` 时返回 `"paused"`。
    - 其它失败，以及 `validate` 不通过，都返回 `null`。
  - 文件头注释写明：本机 `claude` 调用，不经过 `PrivacyGateway`；`sensitive_terms` 不适用；用量由 `onUsage` 记进 `session_usage`。
- **`model-routing.ts`**：
  - `TASK_IDS` 里加 `"conv_qa"`，放在 `"stuck_judge"` 后面。
  - `TASKS` 里加 `t("conv_qa", "low", "fallback", { legacy: "haiku" })`。
  - 不加进 `src/main/cost/cost-breaker.ts:91` 的 `EXEMPT_TASKS`。

- [ ] **Step 1: 写失败的测试**
  - `model-routing.test.ts`：在「registers every task id…」那张表里加 `conv_qa: ["low", "fallback"]`，在「keeps today's model…」里加 `expect(TASKS.conv_qa.legacy).toBe("haiku")`。
  - `conv-qa.test.ts`：
    - `isQuestionLike` 表驱动：
      - 应该是 true 的：「换新阈值是多少？」「这个能不能改」「为啥挂了」「How does refresh work」「is it safe」
      - 应该是 false 的：「把按钮改成蓝色」「开 PR 吧」「`a?b` 这个函数改一下」「看 https://x.com/?q=1」「what」写在代码块里
    - `ruleQa`：七条规则每条一例。
    - `judgeConvQa`：照 `src/main/sessions/needs-you.test.ts` 的假 `HeadlessExecDeps` 写法：
      - 返回 `{qa:true}` 时得 `true`。
      - 输出不合规时得 `null`。
      - `cost_paused` 时得 `"paused"`。
      - 调用参数里 `task` 是 `"conv_qa"`，`ticketKey` 原样传。
      - **判断的输入被截断**：5000 字的问句和 5000 字的回答，进到 prompt 里的分别只有开头 1500 和结尾 1500。
      - `setLang("en")` 时提示是英文。

- [ ] **Step 2: 运行确认失败**
  - `pnpm test src/main/conversation/conv-qa.test.ts src/shared/model-routing.test.ts`。

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行确认通过，再全量验证**
  - `pnpm test && pnpm typecheck && pnpm lint`。

- [ ] **Step 5: Commit**
  - `git add src/main/conversation/conv-qa.ts src/main/conversation/conv-qa.test.ts src/shared/model-routing.ts src/shared/model-routing.test.ts`
  - message 是 `feat(conv): question rules and conv_qa judge`。

---

### Task 5: 增量读取、轮次和游标（`ConvIngester` 的核心）

**Files:**
- Create:
  - `src/main/conversation/jsonl-reader.ts`、`src/main/conversation/jsonl-reader.test.ts`
  - `src/main/conversation/conv-ingester.ts`、`src/main/conversation/conv-ingester.test.ts`
- Modify: `src/main/db/sessions-repo.ts`，加 `listConvTargets`
- Test 里还要改：`src/main/db/sessions-repo.test.ts`

**Interfaces:**
- Consumes:
  - `ConvRepo`（Task 2）
  - `convEntriesOf`、`capText`（Task 3）
  - `isQuestionLike`（Task 4）
  - `SessionsRepo.rootOf`、`head`、`chainOf`、`get`
  - `findTranscript(projectsDir, sessionId)`，来自 `src/main/sessions/discovery.ts:92`
  - `withTransaction`
- Produces:
  ```ts
  // src/main/conversation/jsonl-reader.ts
  export const CHUNK_BYTES = 1 << 20;
  export const MAX_LINE_BYTES = 64 << 20;
  export interface ReadChunk { lines: string[]; ino: number; start: number; next: number; reset: boolean; skipped: number }
  /** 从 from.offset 读一块完整的行；inode 变了或文件比 offset 短就从 0 开始（reset=true）；最后没写完的半行不读。没有新内容返回 lines=[] 且 next=start；文件不在返回 null。 */
  export async function readChunk(file: string, from: { ino: number | null; offset: number }, o?: { chunkBytes?: number; maxLineBytes?: number }): Promise<ReadChunk | null>;

  // src/main/db/sessions-repo.ts
  /** 对话另存要读的 head：没被替换、Butler 开的或已认领到 ticket / feature / epic / Butler 总控、不是复盘分析、since 之后有活动。 */
  listConvTargets(sinceMs: number): Session[];

  // src/main/conversation/conv-ingester.ts
  export const PARENT_MAP_MAX = 2000;
  export interface ConvIngesterDeps {
    repo: ConvRepo;
    sessions: Pick<SessionsRepo, "rootOf" | "head" | "chainOf" | "get" | "listConvTargets">;
    transcriptOf: (sessionId: string) => string | null;
    onAppended: (rootSessionId: string) => void;
    now: () => number;
    chunkBytes?: number;
    maxLineBytes?: number;
    log?: (msg: string) => void;
  }
  export class ConvIngester {
    constructor(d: ConvIngesterDeps);
    /** 把这个 session 的 transcript 读到最新（同一个 session 串行：前一次没完就排在它后面）。 */
    ingest(sessionId: string): Promise<void>;
  }
  ```
- `listConvTargets` 的 SQL：
  ```sql
  SELECT * FROM sessions
   WHERE replaced_by IS NULL AND lesson_run_id IS NULL
     AND (origin = 'butler' OR ticket_key IS NOT NULL OR feature_id IS NOT NULL OR epic_id IS NOT NULL OR butler = 1)
     AND COALESCE(last_activity_at, created_at) >= ?
  ```
  - `recordHeadless` 记的行是 `discovered`，也没有归属，所以不会被选中。
- **轮次构建**，在 `ingest` 里按 entry 的顺序处理：
  - **开始前**：
    - `root = sessions.rootOf(id) ?? id`。
    - 游标存在、但它的 `rootSessionId !== root` 时，先 `repo.reroot(id, root)`。这处理的是「先读到、后连上 `replaced_by`」的情况。
    - 从游标取 `openTurnId`。
  - **每一块**，在一个 `withTransaction` 里做完：
    - **`user` entry**：
      1. 打开的那一轮先 `touchTurn(endedAt = at)`。
      2. 开新的一轮：`kind` 按 `open` 映射，`user` 对 `user`，`relay` 和 `silent` 都对 `silent`，`handoff` 对 `handoff`。`sourceKey` 是 entry 的 key，`asked` 是 `open === "user" && isQuestionLike(text)`。
      3. 如果 `kind` 不是 `user`，马上 `setQa("no","rule")`。
      4. 如果 `open` 是 `user` 或 `relay`，就 `addMessage(role:"user", text: capText(text))`。
      5. 打开的轮换成新开的这一轮。
    - **`assistant` 和 `tool` entry**：
      - 先定它属于哪一轮：`parentMap.get(parent) ?? openTurnId`。
      - 两个都没有时，开一轮 `orphan`：`sourceKey` 是 `orphan:${key}`，`qa` 记 `no`，`qa_by` 记 `rule`。
      - assistant：所属的轮不是 `handoff` 时 `addMessage(role:"assistant", text: capText(text))`。
      - tool：`touchTurn(mutated: effect === "mutate", otherTools: effect === "other")`。如果 `mutated`，而这一轮已经是 `yes`，就 `setQa("no","rule")`。
      - `stop` 为 true 时 `touchTurn(endedAt = at)`。
    - **`noise` entry**：只更新 `parentMap`。
    - **每个 entry**：
      - `parentMap.set(key, turnId)`。
      - `at` 为 `null` 时，用这一轮的 `lastAt`；这一轮也没有就用 `now()`。
    - **最后**：`saveCursor({ offset: chunk.next, ino, openTurnId, rootSessionId: root, file, updatedAt: now() })`。
  - **事务之后**：这一块新写了消息、或者问答结论变了，就记下这个 root。整次 `ingest` 结束时，对每个记下的 root 调一次 `onAppended(root)`。
  - **出错时**：事务回滚，并且清掉这个 session 的 `parentMap`，避免它指向已经回滚掉的轮。错误交给 `log`，不往上抛。
  - **`parentMap`**：每个 session 一个 Map，超过 `PARENT_MAP_MAX` 时删掉最早放进去的。它只在内存里，重启以后靠游标里的 `openTurnId` 接上。

- [ ] **Step 1: 写失败的测试 `jsonl-reader.test.ts`**，用 `tempDir()` 写临时文件：
  - 完整的三行读出三行，`next` 等于文件大小。
  - **半行**：最后半行（没有 `\n`）不读，`next` 停在半行前面；补上 `\n` 以后再读，只读出这一行。
  - 文件变短时 `reset: true`，从 0 开始读。
  - 用 `rename` 把文件换成新文件（inode 变了）时 `reset: true`。
  - **超长行**：`chunkBytes: 16` 时，一行 100 字节照样读成完整的一行；`maxLineBytes: 50` 时这一行被跳过，`skipped: 1`，`next` 越过这一行。
  - 文件不存在时返回 `null`。

- [ ] **Step 2: 写失败的测试 `conv-ingester.test.ts`**
  - 测试环境：`memDb()` 加真的 `SessionsRepo` 和 `ConvRepo`，transcript 写在 `tempDir()` 里，`transcriptOf` 返回这个文件，`now` 由测试控制，`onAppended` 记下调用的参数。
  - 测试用例：
    - **fixture**：`conv.jsonl` 读完以后，`repo.page(root, {limit: 50})` 的 `role`、`text` 序列是：
      1. 用户「换新阈值是多少？」，已去掉 reminder
      2. agent「我看一下」
      3. agent「150k。」
      4. 用户「把按钮改成蓝色」
      5. agent「改好了」
      6. agent「收到」，属于 Butler 通知那一轮
      7. 用户 `[image]`
      8. 没有 uuid 的那行 assistant 文本

      各轮的 `kind`、`asked`、`mutated`、`otherTools`，以及 silent 轮的 `qa: no`，都要对。
    - **`refresh-tail.jsonl`**：`/handoff` 之后 agent 写 handoff 的文字不存。
    - **重启**：同一个 db 新建一个 `ConvIngester` 再 `ingest` 一次，消息条数不变。再往文件追加一条 assistant 回复，它挂在原来那一轮上，靠的是游标里的 `openTurnId`。
    - **半行**：分两次写入一行，只存一次。
    - **换文件**：用 `rename` 换成「原内容加两行」的新文件，结果是原来的消息不重复，新的两行加进来。
    - **变短**：把文件截成前一半再 `ingest`，消息不重复，也不删除已经存下的。
    - **`/clear` 链**：
      - 准备：`s1` 先读完，然后 `setReplacedBy("s1","s2")`，再读 `s2` 的文件。
      - `s2` 的文件开头是 `M().refreshResume(...)`，接着是 agent 的回复，然后是一个用户问题。
      - 期望：`s2` 的消息都在根 `s1` 下；`refreshResume` 那条不存，它的回复存在一轮 `silent` 里。
    - **resume 复制的历史**：`s2` 的文件开头逐字复制了 `s1` 的若干行（uuid 相同），这些行不重复。
    - **迟到的链接**：
      - 先读 `s2`（这时它的根是 `s2` 自己），再 `setReplacedBy("s1","s2")`，然后再 `ingest("s2")`。
      - 期望：`repo.page("s1")` 包含 `s2` 的消息，`repo.page("s2")` 为空，`onAppended` 收到的是 `"s1"`。
    - **交错写入**：
      - 写入顺序：用户 A 问「x？」（uuid `ua`）、用户 B 问「y？」（uuid `ub`）、agent 回 A（parent `ua`）、agent 回 B（parent `ub`）。
      - 期望：两条回复分别挂在各自那一轮上，通过 `repo.turnMessages` 核对。
    - **并发 ingest**：同一个 session 同时 `Promise.all([ingest, ingest])`，结果不重复，游标只往前走。
    - **坏行**：在中间插一行坏 JSON 和一行 `{"type":"assistant","message":{"content":42}}`，后面的行照常存下。
    - **超长行**：`chunkBytes: 64`、`maxLineBytes: 10_000` 时：一条 5000 字节的 assistant 文本整条存下；一条 20000 字节的行被跳过，`log` 收到一次；后面的行照常存下。
    - **很长的回答**：一条 30000 字的回答，存下来的长度不超过 `CONV_TEXT_MAX + 40`，并且包含 `chars omitted`。
    - **改动后降级**：一轮已经 `setQa("yes","judge")`，又读到一个 `Edit`，`qa` 变成 `no`，`qa_by` 是 `rule`，同时调一次 `onAppended`。
  - `sessions-repo.test.ts`：`listConvTargets` 选中 `butler` 来源的、有 ticket 的、有 feature 的、有 epic 的、Butler 总控；不选 `discovered` 且没归属的、`recordHeadless` 的、有 `lesson_run_id` 的、已被替换的、`since` 之前的。

- [ ] **Step 3: 运行确认失败**
  - `pnpm test src/main/conversation/jsonl-reader.test.ts src/main/conversation/conv-ingester.test.ts src/main/db/sessions-repo.test.ts`。

- [ ] **Step 4: 实现**
  - `readChunk`：
    - 用 `fs/promises.open` 加 `fh.stat()`。
    - `st.ino !== from.ino`（`from.ino` 不为 null 时）或者 `st.size < from.offset` 时，从 0 开始读。
    - 读 `chunkBytes`，在 `Buffer` 里找最后一个 `0x0a`：
      - 找到了，就解码到这个位置为止。
      - 没找到、并且读满了，就把块大小加倍再读，直到找到换行或超过 `maxLineBytes`。超过时往后扫到下一个 `0x0a`，把这一行算作跳过。
      - 按字节切行，不按字符切，避免多字节字符被切开。
  - `ConvIngester.ingest`：
    - 按 session 维护一条 promise 链，同一个 session 串行处理。
    - 循环调 `readChunk`，直到 `lines.length === 0 && skipped === 0`。

- [ ] **Step 5: 运行确认通过，再全量验证**
  - `pnpm test && pnpm typecheck && pnpm lint`。

- [ ] **Step 6: Commit**
  - `git add src/main/conversation/jsonl-reader.ts src/main/conversation/jsonl-reader.test.ts src/main/conversation/conv-ingester.ts src/main/conversation/conv-ingester.test.ts src/main/db/sessions-repo.ts src/main/db/sessions-repo.test.ts`
  - message 是 `feat(conv): incremental transcript ingest with persistent cursors`。

---

### Task 6: 调度：监视、启动补读、问答判断队列

**Files:**
- Modify: `src/main/conversation/conv-ingester.ts`
- Test: `src/main/conversation/conv-ingester.test.ts`，在 Task 5 的基础上加 `describe`

**Interfaces:**
- Consumes:
  - `DebouncedWatch`、`WatchFn`，来自 `src/main/sessions/transcript-watch.ts`
  - `WATCH_DEBOUNCE_MS`，来自 `src/main/sessions/activity-monitor.ts:21`
  - `ruleQa`、`ConvQaVerdict`（Task 4）
- Produces，在 `ConvIngesterDeps` 和 `ConvIngester` 上新增：
  ```ts
  export const CONV_BACKFILL_MS = 14 * 24 * 3600_000;   // 启动补读多久以内活动过的
  export const CONV_SWEEP_MS = 10 * 60_000;
  export const CONV_TICK_MS = 10_000;                   // 开着的 head：确认监视在、顺便比一下文件大小
  export const CONV_JUDGE_MAX_AGE_MS = 24 * 3600_000;   // 结束超过这么久的轮不判，记 no / old
  export const CONV_STALE_TURN_MS = 30 * 60_000;        // 一直没 stop 的轮，静止这么久算结束
  // ConvIngesterDeps 增加：
  openHeads: () => string[];
  judge: (turn: { question: string; answer: string }, session: { cwd: string; ticketKey: string | null }) => Promise<ConvQaVerdict>;
  watch?: WatchFn;
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  // ConvIngester 增加：
  start(): void;                       // 马上 sweep 一次，然后起 tick 和 sweep 两个定时器
  stop(): void;                        // 关掉所有监视和定时器；之后的 ingest / judge 直接返回，不碰数据库
  sweep(): Promise<void>;              // 所有 target 的整条链逐个 ingest，然后 endStale、判断队列
  syncNow(sessionId: string): Promise<void>;   // 这个 id 所在整条链 ingest 到最新（换新前用）
  runJudges(): Promise<void>;          // 串行，一次一个；正在跑就直接返回
  ```
- **监视**：
  - 每次 tick，对 `openHeads()` 里的每个 head 找到 transcript，确保挂着一个 `DebouncedWatch(file, { delayMs: WATCH_DEBOUNCE_MS, onChange: () => ingest(head) })`，并调 `ensure()`。重命名以后监视会掉，`ensure()` 会重新挂上。
  - 已经不在 `openHeads()` 里的 head，`close()` 掉它的监视。
  - 每次 tick 还要拿文件大小和游标比一下，不一样就 `ingest`。`fs.watch` 会漏事件，这一步是兜底。
  - `/clear` 以后，新 id 成了 head，下一次 tick 就会挂上它的监视。旧文件不再变化，所以不用再监视。
- **`sweep`**：
  - 对 `listConvTargets(now - CONV_BACKFILL_MS)` 的每个 head，把 `chainOf(head)` 逐个 `ingest`。
  - 某一段的 transcript 找不到（`transcriptOf` 返回 null）就跳过，不报错。
  - 最后 `repo.endStale(now - CONV_STALE_TURN_MS)`，再 `runJudges()`。
- **`runJudges`**：循环 `repo.pendingEnded(20)`，对每一轮：
  - `endedAt < now - CONV_JUDGE_MAX_AGE_MS` 时 `setQa("no","old")`。
  - 否则先用 `turnMessages` 拼出问句和回答，回答是这一轮所有 assistant 消息连起来，然后跑 `ruleQa`：
    - 结论是 `yes` 或 `no`，就按结论写，`qa_by` 记 `rule`。
    - 结论是 `judge`，就 `await d.judge(...)`。`session` 用 `sessions.get(turn.sessionId)` 的 `cwd` 和 `ticketKey`；行不存在时这一轮记 `no`，`qa_by` 记 `judge_failed`。判断的结果：
      - 返回 `true` 或 `false` 时，写 `yes` 或 `no`，`qa_by` 记 `judge`。
      - 返回 `"paused"` 时，这一轮保持 `pending`，并结束这一次 `runJudges`，等下次 sweep 再试。
      - 返回 `null` 时，写 `no`，`qa_by` 记 `judge_failed`，以后不再判。
  - 结论有变化时 `onAppended(root)`。
  - 每次 `ingest` 结束后，用 `void this.runJudges()` 接一下。

- [ ] **Step 1: 写失败的测试**
  - 测试环境：用一个假的 `watch`，记下回调、可以手动触发；`timers` 用 `vi.useFakeTimers()`；`judge` 是 `vi.fn`。
  - 测试用例：
    - **启动补读**：
      - 准备：`start()` 之前，transcript 里已经有两轮。`sessions` 里有一个有 ticket 的 head `h`，它的链是 `a → h`，两个文件都在。
      - 期望：`start()` 以后，两段都读进来了，根是 `a`。
    - **非 target 不读**：一个 `discovered` 且没有归属的 session，以及一个 `recordHeadless` 的 session，即使有 transcript，`sweep()` 以后也没有任何消息和游标。
    - **监视**：
      - `openHeads` 返回 `h` 时，tick 以后挂上了监视；追加一行并触发回调，这一行就存下了。
      - `openHeads` 变空以后，下一次 tick 会关掉这个监视。
    - **漏事件兜底**：不触发 watch 回调，只追加一行，下一次 tick 以后这一行也存下了。
    - **判断**：
      - 规则判 `yes` 的轮不调 `judge`。
      - 规则判 `judge` 的轮，`judge` 返回 `true` 时 `qa` 变成 `yes`、`qa_by` 是 `judge`，并且 `onAppended` 被调用。
      - 返回 `null` 时是 `no` 和 `judge_failed`，下次 `runJudges` 不再调它。
      - 返回 `"paused"` 时还是 `pending`，下次 `runJudges` 再调一次。
      - 两个待判的轮，`judge` 同一时间最多只有一个在跑：用一个不 resolve 的 promise 来卡住。
    - **旧轮不判**：一轮的 `ended_at` 在 25 小时前，`runJudges` 以后是 `no` 和 `old`，`judge` 没被调用。
    - **没 stop 的轮**：最后一轮一直没有 `end_turn`，把时钟拨过 30 分钟再 `sweep`，它就有了 `endedAt`，并进入判断。
    - **`syncNow`**：写入以后马上 `await syncNow("h")`，不靠监视也能看到新的消息。
    - **`stop`**：`stop()` 以后再 tick 或触发回调，不再读文件，`repo` 也没有新的写入。

- [ ] **Step 2: 运行确认失败**
  - `pnpm test src/main/conversation/conv-ingester.test.ts`。

- [ ] **Step 3: 实现**

- [ ] **Step 4: 运行确认通过，再全量验证**
  - `pnpm test && pnpm typecheck && pnpm lint`。

- [ ] **Step 5: Commit**
  - `git add src/main/conversation/conv-ingester.ts src/main/conversation/conv-ingester.test.ts`
  - message 是 `feat(conv): watch open sessions, backfill on start, judge queue`。

---

### Task 7: `ConversationStore`、`recentQa`、恢复提示、换新不等用户

**Files:**
- Create: `src/main/conversation/conversation-store.ts`、`src/main/conversation/conversation-store.test.ts`
- Modify: `src/main/strings.ts`、`src/main/sessions/session-refresher.test.ts`

**Interfaces:**
- Consumes:
  - `ConvRepo`
  - `SessionsRepo.rootOf`、`head`、`chainOf`、`get`
  - `M().refreshTail.user`、`M().refreshTail.assistant`，和 refresh-tail 用同一套标题
- Produces:
  ```ts
  // src/main/conversation/conversation-store.ts
  export const RECENT_QA_CHARS = 6000;
  export const RECENT_QA_QUESTION_CHARS = 800;
  export interface ConversationStoreDeps {
    repo: ConvRepo;
    sessions: Pick<SessionsRepo, "rootOf" | "head" | "chainOf" | "get">;
    onAppended: (rootSessionId: string) => void;
    now: () => number;
  }
  export class ConversationStore {
    constructor(d: ConversationStoreDeps);
    /** 任意一个链上的 id（head、中间段、根）→ 链根；不认识的 id 原样返回。 */
    rootOf(sessionId: string): string;
    list(sessionId: string, opts: ConvListOpts): ConvPage;
    search(sessionId: string | null, query: string): ConvMessage[];
    /** 最近的问答（不含分叉），按时间先后拼成 markdown；没有问答返回 ""。 */
    recentQa(rootSessionId: string, maxChars: number): string;
    /**
     * 第 5 层写分叉讨论的一条消息（第 5 层计划按这个名字用）。
     * - msg.forkId 必须非空，否则抛错：非分叉的对话只从 transcript 来，不留两个写入口。
     * - msg.rootSessionId 先转成链根；text 过 capText。
     * - user：开一轮 kind='fork'，qa='no'、qa_by='fork'（分叉消息的 qa 一律是 false，msg.qa 传什么都按 false 存；分叉里的问答由第 5 层自己处理）。
     * - assistant：挂在这个 forkId 最新的那一轮上；没有就先开一轮。
     * - 写完调 onAppended(链根)，返回存下的消息（qa: false）。
     */
    append(msg: Omit<ConvMessage, "id">): ConvMessage;
    /** 这个分叉的全部消息，按时间升序（第 5 层「接着问」、发结论时用）；没有返回 []。 */
    byFork(forkId: number): ConvMessage[];
  }
  /** 换新的恢复文件：tail 写成了就在后面追加问答；tail 没写成但有问答，就只写问答。返回最终的文件路径，什么都没写返回 null。 */
  export async function withRecentQa(out: string, tailPath: string | null, qa: string): Promise<string | null>;

  // src/main/strings.ts，ZH 和 EN 各加一组
  convResume: {
    title: string;                       // "最近的问答" / "Recent questions and answers"
    intro: (turns: number) => string;    // 说明这是 Butler 存下的最近 N 段问答，最早的在前；以 handoff 和仓库为准
  },
  ```
- **`list`**：
  - `root = rootOf(id)`，`limit` 限制在 1 到 `CONV_LIST_MAX` 之间。
  - `refreshMarks`：
    - 取 `chainOf(head(root).id)` 里除了根以外的每一段，`{ at: get(id).createdAt, sessionId: id }`，按 `at` 升序。
    - 只保留落在这一页时间范围里的：
      - 下界：`hasMore` 为 true 时是这一页最早那条的 `at`，否则不设下界。
      - 上界：有 `before` 时是 `before` 那条的 `at`，不含这个值；没有 `before` 时不设上界。
    - 这一页没有消息时，如果有 `before` 就是 `[]`，否则返回全部。
- **`recentQa`**：
  - `rootOf` 之后，用 `repo.qaTurns` 一批批往前取轮。每一轮渲染成 `## ${user}\n\n${问}\n\n## ${assistant}\n\n${答}`，累计到超过 `maxChars` 为止。
  - 第一轮（最新的一轮）自己就超长时：问句截到 `RECENT_QA_QUESTION_CHARS`，回答取结尾，凑满 `maxChars` 减去问句和标题的长度，开头放 `M().refreshTail.cut`。
  - 输出 `# ${convResume.title}\n\n${convResume.intro(n)}\n\n${blocks.join("\n\n")}\n`，各段按时间先后排。
  - 总长度不超过 `maxChars`；`maxChars <= 0` 时返回 `""`。
- **`withRecentQa`**：
  - `qa` 为空时，返回 `tailPath`。
  - `tailPath` 不为 null 时，`appendFile(tailPath, "\n" + qa)`，返回 `tailPath`。
  - 否则 `mkdir`，再 `writeFile(out, qa)`，返回 `out`。
- **换新不等用户**：`session-refresher.ts` 不改，只加回归测试。

- [ ] **Step 1: 写失败的测试 `conversation-store.test.ts`**
  - **任意链上的 id 都转成根**：链是 `a → b → c`，消息写在根 `a` 下。
    - `list("a")`、`list("b")`、`list("c")` 结果相同。
    - `search("c", …)` 等于 `search("a", …)`。
    - `recentQa("b", …)` 等于 `recentQa("a", …)`。
    - 不认识的 id 返回空页，不抛错。
  - **`refreshMarks`**：
    - `b`、`c` 的 `createdAt` 分别落在第 1 页和第 2 页的时间范围里，各自只出现在对应的那一页。
    - 最新一页包含晚于最后一条消息的标记（刚换新、还没说话的情况）。
    - 最早一页（`hasMore: false`）包含早于第一条消息的标记。
  - **`limit` 越界**：0 当成 1，1000 当成 200。
  - **`recentQa`**：
    - 只有 `qa='yes'` 的轮，`no`、`pending`、分叉都不算。
    - 最早的在前。
    - `maxChars: 300` 时，只放得下最新的几轮，总长度不超过 300。
    - **单轮超长**：一轮的回答有 10000 字、`maxChars: 2000` 时，结果长度不超过 2000，问句完整（短于 800 字），回答是结尾那一段，并且有 `cut` 标记。
    - 没有问答时返回 `""`。
    - `setLang("en")` 时标题是英文。
  - **`append`**：
    - user 开出一轮 `fork`，返回的消息 `qa: false`、`forkId` 正确；传入 `qa: true` 也按 false 存。
    - assistant 挂在同一轮上。
    - 不同的 `forkId` 各自成轮。
    - `forkId: null` 时抛错，什么都不写。
    - `onAppended` 收到的是链根，用中间段的 id 写入也是一样，存下的 `rootSessionId` 也是链根。
    - `recentQa` 不包含分叉的内容：即使分叉的轮被手动改成 `qa='yes'` 也不包含（`qaTurns` 按 `fork_id IS NULL` 过滤）。
    - 超过 `CONV_TEXT_MAX` 的文本被 `capText` 截断。
  - **`byFork`**：两个分叉交替写入，`byFork(1)` 只返回分叉 1 的消息，按时间升序；不认识的 forkId 返回 `[]`。
  - **`withRecentQa`**，用 `tempDir()`，三种组合：
    - tail 加问答：文件以 tail 开头，以问答结尾。
    - 只有问答：文件就是问答，返回 `out`。
    - 都没有：返回 `null`，不创建文件。

- [ ] **Step 2: 在 `session-refresher.test.ts` 的 autoCheck 那组里加回归测试**
  - 名字是 `"auto refresh does not wait for the user to read the last answer"`。
  - 准备：`t.addTerm("s1", { context: 160_000 })`。默认状态就是 waiting、没有「需要你」、没有后台任务，相当于「用户刚问完一个问题，agent 答完停下」。
  - 执行：`t.r.autoCheck(); await t.settle();`
  - 期望：`t.typed` 里马上有了 `/handoff`。没有设置任何「等用户看完」的 guard，`deps` 里也没有这种依赖。
  - 这个测试一写好就能通过，因为现有代码本来就不等。它的作用是防止以后有人加回去，在测试的注释里写明这一点和 spec §5.4。

- [ ] **Step 3: 运行确认失败**
  - `pnpm test src/main/conversation/conversation-store.test.ts`，预期 FAIL。
  - `pnpm test src/main/sessions/session-refresher.test.ts`，预期 PASS。

- [ ] **Step 4: 实现 `conversation-store.ts` 和 `convResume` 文案（中英）**

- [ ] **Step 5: 运行确认通过，再全量验证**
  - `pnpm test && pnpm typecheck && pnpm lint`。

- [ ] **Step 6: Commit**
  - `git add src/main/conversation/conversation-store.ts src/main/conversation/conversation-store.test.ts src/main/strings.ts src/main/sessions/session-refresher.test.ts`
  - message 是 `feat(conv): conversation store (list, search, recentQa, fork append) and resume notes`。

---

### Task 8: IPC、`api.ts`、主进程接线

**Files:**
- Create: `src/main/ipc/conv-handlers.ts`、`src/main/ipc/conv-handlers.test.ts`
- Modify:
  - `src/shared/ipc.ts`、`src/shared/ipc.test.ts`
  - `src/main/metrics/interventions.ts`
  - `src/main/ipc/validate.ts`、`src/main/ipc/validate.test.ts`
  - `src/main/ipc/register.ts`
  - `src/renderer/src/api.ts`
  - `src/main/index.ts`

**Interfaces:**
- Consumes:
  - `ConversationStore`（Task 7）
  - `ConvIngester`（Task 6）
  - `judgeConvQa`（Task 4）
  - `index.ts:724` 的 `judgeDeps`
  - `safeSend`
  - `openButlerHeads()`（`index.ts:1665`）
  - `findTranscript`
  - `paths.claudeProjects`
  - `refreshTailPath`
  - `writeRefreshTail`
- Produces:
  ```ts
  // src/shared/ipc.ts
  convList: "conv:list",
  convSearch: "conv:search",
  convAppended: "conv:appended",
  // convList、convSearch 放进 INVOKE_CHANNELS；convAppended 放进 EVENT_CHANNELS

  // src/main/ipc/validate.ts
  /** conv:list 的选项：limit 必须是正整数（大于 CONV_LIST_MAX 的取 CONV_LIST_MAX），before 是正整数或不给，qaOnly 是布尔或不给。 */
  export function convListOptsArg(v: unknown): ConvListOpts;
  /** 搜索词：必须是字符串，超出 CONV_QUERY_MAX 的部分截掉。 */
  export function convQueryArg(v: unknown): string;
  /** null 或 sessionIdArg。 */
  export function convRootArg(v: unknown): string | null;

  // src/main/ipc/conv-handlers.ts
  export function convHandlers(d: { conv: Pick<ConversationStore, "list" | "search"> }): {
    list: (id: unknown, opts: unknown) => ConvPage;
    search: (id: unknown, query: unknown) => ConvMessage[];
  };

  // src/main/ipc/register.ts 的 IpcDeps 增加：
  /** 对话另存（UI 重做第 4 层）：只读。 */
  conv: Pick<ConversationStore, "list" | "search">;

  // src/renderer/src/api.ts
  convList: (sessionId: string, opts: ConvListOpts) => call<ConvPage>(IPC.convList, sessionId, opts),
  convSearch: (sessionId: string | null, query: string) => call<ConvMessage[]>(IPC.convSearch, sessionId, query),
  onConvAppended: (cb: (rootSessionId: string) => void) => window.butler.on(IPC.convAppended, cb),
  ```
  - `onConvAppended` 的写法照现有 `onX` 的形状，核对 `api.ts` 里 `onMemoryChanged` 的签名。
- **`index.ts` 接线**：
  - 在 `sessions` 和 `judgeDeps` 都建好之后：
    ```ts
    const convRepo = new ConvRepo(db);
    const convAppended = (root: string) => safeSend(IPC.convAppended, root);
    const conv = new ConversationStore({ repo: convRepo, sessions, onAppended: convAppended, now: Date.now });
    const convIngester = new ConvIngester({
      repo: convRepo, sessions, onAppended: convAppended, now: Date.now, log: logger,
      transcriptOf: (id) => findTranscript(paths.claudeProjects, id),
      openHeads: () => openButlerHeads().map((h) => h.id),
      judge: (turn, s) => judgeConvQa({ ...judgeDeps, timeoutMs: 60_000 }, turn, existsSync(s.cwd) ? s.cwd : paths.butlerHome, s.ticketKey),
    });
    ```
    - `paths.butlerHome` 要按 `src/main/paths.ts` 里实际的名字改：用 Butler 自己的数据目录，原因是 worktree 被清掉以后 headless 不能在不存在的 cwd 里启动。
  - 在 `activityMonitor.start()`（`:3140`）旁边调 `convIngester.start()`。
  - 在 `will-quit`（`:3238`）里、`db.close()` 之前调 `convIngester.stop()`。
  - 换新的 `writeTail`（`:1682` 一带）改成下面这样，`delay` 用仓库里现有的工具函数：
    ```ts
    writeTail: async (oldHeadId, termId, kind) => {
      // 换新前把旧 session 读到最新，最多等 3 秒（不能让换新卡住）。
      await Promise.race([convIngester.syncNow(oldHeadId), delay(3000)]).catch(() => {});
      const out = refreshTailPath(paths, termId);
      const tail = await writeRefreshTail({ transcript: findTranscript(paths.claudeProjects, oldHeadId), out, sessionId: oldHeadId, kind });
      return withRecentQa(out, tail, conv.recentQa(oldHeadId, RECENT_QA_CHARS));
    },
    ```
    - `M().refreshResume(kind, ticket, tailPath)` 的文案不用改：它本来就说「再读一下 tailPath 里换新前的最近对话」，现在这个文件里多了问答。
    - 文件里只有问答时，这句话照样成立。
  - `registerIpc({ … conv, … })`。
  - 第 5 层要用的 `conv.recentQa`、`conv.append`、`conv.byFork`，由第 5 层自己从 `conv`（`ConversationStore` 实例）取，本层不再导出别的东西。
- **`register.ts`**：照 `memoryHandlers` 的写法：
  ```ts
  const cv = convHandlers({ conv: d.conv });
  handle(IPC.convList, cv.list);
  handle(IPC.convSearch, cv.search);
  ```
- **`interventions.ts`**：在 `NOT_TRIGGERS` 的「只读」那一组加上 `IPC.convList, IPC.convSearch`。

- [ ] **Step 1: 写失败的测试**
  - `validate.test.ts`：
    - `convListOptsArg`：
      - `{limit: 50}` 原样返回。
      - `{limit: 500}` 变成 `{limit: 200}`。
      - `{limit: 0}`、`{limit: 1.5}`、`{before: -1}`、`{qaOnly: "y"}`、`null`、`"x"` 都抛错。
    - `convQueryArg`：
      - 300 字的输入截成 200 字。
      - `42` 抛错。
    - `convRootArg`：
      - `null` 返回 `null`。
      - `"a-1"` 原样返回。
      - `"../x"` 抛错。
  - `conv-handlers.test.ts`，用假的 `conv` 记下调用：
    - `list("b", {limit: 10})` 把 `"b"` 原样交给 `conv.list`，转根由 service 负责，Task 7 已经测过。
    - 参数非法时抛错，并且不调用 `conv`。
  - `ipc.test.ts`：现有的「每个通道正好登记一次」测试会覆盖新加的三个通道。在 event-only 那组里加一条，确认 `convAppended` 只出现在 `EVENT_CHANNELS` 里。
  - 运行 `pnpm test src/main/metrics/interventions.test.ts`。这时新通道已经加进 `INVOKE_CHANNELS`、还没加进 `NOT_TRIGGERS`，预期 FAIL，失败信息会列出这两个通道。

- [ ] **Step 2: 运行确认失败**
  - `pnpm test src/main/ipc src/shared/ipc.test.ts src/main/metrics/interventions.test.ts`。

- [ ] **Step 3: 实现**：通道、校验、handler、`IpcDeps`、`api.ts`、`interventions.ts`、`index.ts` 接线。

- [ ] **Step 4: 运行确认通过，再全量验证**
  - `pnpm test && pnpm typecheck && pnpm lint`。
  - `pnpm typecheck` 会检查渲染进程这边 `api.ts` 的类型。

- [ ] **Step 5: 手动冒烟**（不写 e2e，因为本层没有界面）
  - `pnpm dev` 起 app，开一个 ticket session，问一句「换新阈值是多少？」，等它回答。
  - 在 DevTools 的 console 里执行 `await window.butler.invoke("conv:list", "<head id>", { limit: 20 })`，看到这一问一答，并且 `qa: true`。具体的调用方式以 preload 里实际暴露的名字为准。
  - 退出 app，在外面用 `claude --resume <id>` 再问一句，然后重新打开 app，`conv:list` 里能看到这一句。

- [ ] **Step 6: Commit**
  - `git add src/main/ipc/conv-handlers.ts src/main/ipc/conv-handlers.test.ts src/shared/ipc.ts src/shared/ipc.test.ts src/main/metrics/interventions.ts src/main/ipc/validate.ts src/main/ipc/validate.test.ts src/main/ipc/register.ts src/renderer/src/api.ts src/main/index.ts`
  - message 是 `feat(conv): conv:list / conv:search / conv:appended and wiring`。

---

## Self-review

- **spec §5.4 每一条的落点**：
  - 「所有对话都存，只存说的话，加上时间、session id、链根、是否分叉、是否问答」：Task 2 的表、Task 3 的过滤。
  - 「从 JSONL 增量读，复用 transcript-watch」：Task 5、Task 6。
  - 「分叉讨论直接写入」：Task 7 的 `ConversationStore.append` 和 `byFork`。
  - 「先规则，判不了的交给 Haiku」：Task 4、Task 6。spec 和任务说明里的「分叉一律算问答」按总控后来的约定改了：分叉消息存进库时 `qa` 一律写 false，分叉里的问答由第 5 层另外处理，本层的问答规则不碰分叉。
  - 「换新不等用户」：Task 7 的回归测试，外加核实过代码里没有这种逻辑。
  - 「refresh-tail 保留，恢复提示里再加最近的问答」：Task 7 的 `withRecentQa`、Task 8 的 `writeTail`。
  - 「按 `replaced_by` 链存，链根作为主键」：所有表都以 `root_session_id` 为键，外加 `reroot`。
- **任务说明的每一条**：
  - IPC 两个、推送一个、`api.ts`：Task 8。
  - 「无界面、无临时入口」：符合，冒烟走 DevTools。
  - 测试命令都取自 `package.json`。
- **总控追加的要求**：
  - 「`SessionView` 加 `rootId`」：Task 1，测试里有链和单个 session 两种情况。
  - 「`conv:list` 接受任意 head id，在主进程转成根」：Task 7 的「任意链上的 id 都转成根」那条测试，加上 Task 8 的 handler 原样转发。
- **Review Focus 五条都对应到了具体测试**：
  1. 很长的回答：Task 3 的 `capText`、Task 5 的「超长行」和「很长的回答」、Task 7 的「单轮超长」。
  2. 格式变化和坏行：Task 3 的「坏行和未知形状」、Task 5 的「坏行」和「半行」。
  3. 两个终端：Task 5 的「交错写入」和「并发 ingest」。
  4. app 关着：Task 5 的「重启」「换文件」「变短」「迟到的链接」，Task 6 的「启动补读」和「旧轮不判」。
  5. 隐私：Task 4 的「判断的输入被截断」、Task 6 的「非 target 不读」。
- **名字前后一致**：
  - `ConvMessage`、`ConvPage`、`recentQa(rootSessionId, maxChars)`、第 5 层要的 `ConversationStore.append` 和 `ConversationStore.byFork`、`conv:list`、`conv:search`、`conv:appended` 和索引逐字一致。
  - `ConvRepo` 的 `openTurn`、`touchTurn`、`setQa`、`pendingEnded`、`endStale`、`addMessage`、`turnMessages`、`page`、`search`、`qaTurns`、`latestForkTurn`、`forkMessages`、`cursor`、`saveCursor`、`reroot`，在 Task 5、6、7 里引用时用的都是这些名字。
  - `ConvIngesterDeps` 在 Task 5 定义，Task 6 只往里加字段。
- **没留占位**：每一步都有文件、要测什么、要跑的命令。`paths.butlerHome` 和 `onMemoryChanged` 这两处明确要求「以实际的名字为准」，因为它们只是接线时的命名，不影响设计。
- **已知取舍**：
  - **重启后丢 `parentMap`**：两个终端交错写入时，如果中间重启了 app，重启后第一批 assistant entry 会退回挂到「当前打开的轮」，可能挂错一轮。只影响问答标记和分组，不丢话。
  - **回答里有多段 text**（中间夹着工具调用）：存成多条 assistant 消息，每条一个 `ConvMessage`，由第 5 层合并显示。
  - **删除 session 时不删它的对话**：和 `deleteChain` 保留 handoff、用量记录的做法一致。见下面的建议第 4 条。

## 对共用接口的建议

1. **`conv:list` 和 `conv:search` 的第一个参数**：
   - 索引里叫 `rootSessionId`。本层按总控的要求，接受链上任意一个 id（head、中间段、根都行），在主进程里转成根，`recentQa` 也一样。
   - 建议索引把参数名改成 `sessionId`，并注明「任意链上的 id，主进程转根」。渲染进程可以直接传 `SessionView.id`，也可以传 `SessionView.rootId`。
   - `conv:appended` 推送的永远是链根，所以第 5 层要拿 `SessionView.rootId` 去比对，不能拿 `id`。
2. **`ConvListOpts.before`** 是消息 `id`，不是时间。建议在索引里写明这一点，并写明返回的 `messages` 按时间升序、`limit` 上限是 200。
3. **分叉**：按总控的约定，`recentQa` 不收 `forkId` 非空的消息，分叉消息的 `qa` 一律存 false。本层提供 `ConversationStore.append(msg: Omit<ConvMessage,"id">): ConvMessage` 和 `ConversationStore.byFork(forkId: number): ConvMessage[]`。`append` 要求 `forkId` 非空，否则抛错，这样非分叉的对话只有 transcript 一个来源。建议索引的「第 4 层产出」补上这两个方法，并把 spec §5.4「分叉讨论一律算问答」改成「分叉的问答由第 5 层处理」，免得两处说法不一样。另外，`recentQa` 是 `ConversationStore` 上的方法，第 5 层通过注入 `conv` 来调用，不是一个独立导出的函数。
4. **删除 session 时要不要连对话一起删**：现在不删，和 `deleteChain` 保留 handoff 一致。如果用户觉得「全部删除」应该连对话一起删，需要第 5 层或第 6 层在界面上说明，再在 `deleteChain` 的调用方顺带调用一个新的 `ConvRepo.deleteRoot(root)`。本层不做。
5. **`ConvMessage` 没有轮次 id**：回答中间夹着工具调用时，会是连续几条 assistant 消息。第 5 层如果要把一轮显示成一块，建议把 `turnId: number` 加进 `ConvMessage`，这是只增字段的改动，本层实现时顺手就能加。不加的话，第 5 层可以按「连续的同一角色」来合并。
6. **子 session 的汇报**：汇报来自 `inbox_items`（`inboxReportsIntro` 那条送到总控的消息，本层把它当作 `silent`，不存）。第 3、5 层「对话加汇报穿插」要从 inbox 取汇报，不能指望对话库里有。
