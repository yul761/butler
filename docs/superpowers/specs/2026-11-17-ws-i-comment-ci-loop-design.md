# Workstream I：评论到修复的闭环、CI 失败分类与自动重跑（设计补充）

上级文档：`2026-11-17-butler-3-design.md`（第 3 节 I、第 4.1 / 4.2 / 4.7 / 4.8 / 4.9 节、第 5 节）。
源计划 7.2、7.6。这里只记 I 自己做的决定；契约以上级文档为准，这里只扩展不修改。

## 0. 开工前核实过的点

- **review 评论现在会不会送进 session。** 不会。`PrWatcher.inlineComments` 只在有新的 Copilot review 时拉 `pulls/N/comments`，拉到的只写进 `pr_stage_events`（给进度时间线和复盘用）；人的行内评论只有恰好和 Copilot review 同一轮时才会被记下。没有任何代码把评论递给 session。
- **prwatch 评论数据的存取接口。** `gh pr view --json reviews,comments` 给 review（GraphQL node id、作者、状态、正文）和 PR 级评论（没有文件和行号）；`reviewComments` 走 REST，给行内评论的数字 id、`path`、`line`、所属 review。两者都没有「这条讨论 resolve 了没有」「位置是不是已经被后来的 commit 改掉了（outdated）」，也没有 resolve 需要的 thread id。I 新加一次 GraphQL 查询（`reviewThreads`，见第 2 节），一次拿到 thread id、`isResolved`、`isOutdated`、每条评论的 `databaseId`（和 REST 的 id、`pr_stage_events` 的去重键是同一个数）。
- **gh 能不能稳定执行这几个动作。** 都是 gh 2.x 早就有的：`gh run rerun <id> --failed`（2.10 起）；回复行内评论是 REST `POST repos/{owner}/{repo}/pulls/<n>/comments/<id>/replies`；resolve 是 GraphQL mutation `resolveReviewThread(input: {threadId})`；PR 级评论没有「回复」，用 `POST repos/{owner}/{repo}/issues/<n>/comments` 引用原文回复，不能 resolve。权限：回复、resolve 要对仓库有写权限（PR 作者本来就有）；重跑要 `actions:write`，fork 上的 PR 可能没有，失败时记 `failed`，按代码问题递给 session（第 6 节）。全部用 `execFile` 和参数数组，不拼 shell，Windows、macOS 一样。
- **`{owner}`/`{repo}` 占位符。** `gh api` 在 endpoint 和 `-F` 字段里都会替换占位符；不是 ticket 仓库的 PR 用现有的 `repoEnv(slug)`（`GH_REPO` / `GH_HOST`）。
- **CI 失败日志从哪来。** `PrWatcher.failedWithLogs` 已经对每个失败的 run 取 `gh run view --log-failed` 的最后 60 行，存进 `ticket_prs.failed[].log`。判断「失败在哪一步」「runner 是不是空的」「被取消」要 job 的信息：新加 `runJobs(runId)` = `gh run view <id> --json attempt,conclusion,jobs`，每个失败的 run 一次。
- **送达机制。** `DeliveryGuard.check` 在 session 休眠时已经调 `Hibernator.wake`（WS-M），醒来走 `openHibernated`，里面调 `admission.note()`（工作流 W）。所以评论递送只要和 CI 一样过 `deliveryGuard` + `pty.deliver`，就自动走 M 的叫醒路径和 W 的准入登记，不用另写。
- **H 的 recordEvent。** #46 还没合。接口按 H 记进记忆的签名：`RecordEvent = (kind, refs?: {sessionId, ticketKey, prId, repoSlug, at, data, dedupeKey}) => boolean`，永不抛错。`comment_auto_handled` 是 H 预先登记的 kind。I 在 `src/main/loop/metrics.ts` 里放一份同签名的类型，index.ts 先传一个空实现（返回 false）；H 合并后把类型换成 `import type { RecordEvent } from "../metrics/events"`，index.ts 传 `metrics.recordEvent`。

## 1. 默认行为和开关

上级文档的反目标：什么都不配置的用户看到的必须和 2.1.0 一样。所以：

| 东西 | 默认 | 说明 |
|---|---|---|
| 评论闭环 `comments.enabled` | 关 | 开了以后才拉 review thread、分类、送进 session |
| CI 分类 `ci.enabled` | 关 | 关着时 CI 结论和 2.1.0 一样原样递给 session |
| 自动回复评论（B 的 `comment_reply`，设置 `externalCommentReply`） | 关 | 只管「在 GitHub 上回复」这一个对外动作 |
| 自动 resolve（B 的 `comment_resolve`，`externalCommentResolve`） | 关 | 同上 |
| 自动重跑 CI（B 的 `ci_rerun`，`externalCiRerun`） | 关 | 同上 |

两个总开关打开以后，**默认只推送到 session**：评论分类、送进 session、核对位置都做，但不在 GitHub 上留任何东西，直到用户另外打开对外动作的开关。对外动作一律 `ExternalActions.attempt(kind, detail, run)`：开关关着时不跑，记一笔 `skipped`（审计页能看到「本来会回复什么」）；开着时记 `done` / `failed`，`payload` 是回复的原文，可以在审计页抽查。

策略层面（第 3 节）另有 `comments.reply`、`comments.resolve`：在某个产品或仓库里关掉回复 / resolve。生效 = 对外动作开关开着 **且** 这一层的策略允许。B 的开关是全局的（`ExternalActions` 的 `layered` 没注入）；I 调 `allowed` / `attempt` 时照样传 `{repoSlug, ticketKey}`，以后谁给 B 接上分层，I 不用改。

## 2. 评论闭环（7.2）

### 2.1 读评论

`PrWatcher` 读完一个开着的 PR（`apply` 之后）调新加的可选依赖 `onPrRead(row, pr)`。`CommentLoop.observe` 决定要不要拉 thread：

- 这个 PR 的策略 `comments.enabled` 为假：什么都不做。
- 有新的 review id、PR 级评论的 id 集合变了、head sha 变了，或者有等着核对的评论（已递、还没核对）：拉一次；否则不拉（和 watcher 的轮询节奏一样，不额外加 gh 调用）。
- 同一个 PR 同时只拉一次（in-flight 标记）；拉失败下一次读到这个 PR 再试。

拉的是 `gh api graphql`（新函数 `reviewThreads(cwd, number, timeout, slug)`）：

```graphql
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes {
      id isResolved isOutdated path line originalLine
      comments(first: 50) { nodes { id databaseId author { login } body createdAt url path line originalLine commit { oid } replyTo { databaseId } } }
    } }
  } }
}
```

一个 PR 最多 100 个 thread、每个 thread 50 条评论（超过的不处理，记日志；真实 PR 远到不了）。PR 级评论和 review 正文直接用这一轮 `prStatus` 已经给的 `comments`、`reviews`。

### 2.2 一条「评论项」

存在新表 `pr_comment_items`，每个 (ticket_prs.id, 评论) 一行：

- 行内评论按 **thread** 算一项（thread 的第一条是评论，后面的是讨论），键是第一条的 `databaseId`。
- 有正文的 review（`CHANGES_REQUESTED` 或 `COMMENTED`，正文非空）算一项，键 `review:<node id>`；没有文件和行号。
- PR 级评论算一项，键 `issue:<node id>`；没有文件和行号。

字段：作者、作者种类（`copilot` / `human` / `bot` / `author`，用现有的 `reviewerKind`，REST 认出是 Bot 的按 bot）、文件、行号、原文（只存在本机库里，不进导出、不进度量事件）、链接、thread id、出现时的 head sha、分类、分类来源（`rule` / `model` / `user`）、分类理由、状态和各个时间点。

为了让 7.1 的评论数算上闭环看到的评论，拉到的行内评论也按 `pr_stage_events` 原来的去重键（`<scope>:comment:<branch>:<databaseId>`）补记 `comment` 事件；已经记过的不会重复。

### 2.3 分类

四类：`fix`（要改）、`question`（在提问）、`ignore`（可忽略）、`human`（需要人判断）。

先走规则，不调模型（`classifyByRule`，纯函数）：

1. thread 已经 resolve：跳过（不建项）。
2. thread `isOutdated`，或者行内评论的 `line` 为空：评论的位置已经被后来的 commit 改掉了，`ignore`，理由 `outdated`。
3. 作者是 PR 作者（包括 Butler 自己代你发的回复）、或者是 Copilot 以外的 bot（覆盖率、部署预览之类）：跳过。
4. thread 最后一条是 PR 作者发的：已经有人回过了，`ignore`，理由 `answered`。
5. 正文为空、只有表情、或者是 `LGTM`、`thanks`、`👍` 这类：`ignore`，理由 `ack`。
6. 正文命中策略 `comments.ignorePatterns` 的任何一条（不区分大小写的子串，`/…/` 包起来的按正则）：`ignore`，理由 `pattern`。
7. 正文带 GitHub 的 ```` ```suggestion ```` 块：`fix`，理由 `suggestion`。
8. Copilot 的 review 正文（「Pull request overview」那段总述）：`ignore`，理由 `overview`；它的行内评论才是要处理的。

剩下的交给后台模型，任务 id `comment_classify`（中档、撞限降级，契约 4.1 已登记）。一个 PR 一次调用，最多 20 条，每条带作者种类、文件、行号、原文（截到 1500 字）和 thread 里后面的讨论（截到 600 字），返回 `[{id, category, reason}]`（JSON schema 校验，理由清掉混进来的标签）。模型失败、撞限、返回不认识的 id：这些项记成 `human`，理由 `model_failed`，不会猜成 `fix`。策略 `comments.useModel = false` 时规则判断不了的都记成 `human`。

### 2.4 归属策略

Copilot 和人的评论各有一个策略（三层配置，第 3 节）：

| 策略值 | 意思 |
|---|---|
| `auto` | 分好类就把 `fix` 送进 session，不等你 |
| `review`（人的评论默认） | 分好类先在「现在」页和 ticket 页的「评论」标签里给你看一眼；你点「送进 session」才送，也可以改分类、忽略 |
| `off` | 这类作者的评论不进闭环 |

Copilot 默认 `auto`，人默认 `review`。`question` 默认给你看（`comments.questions = user`）；设成 `session` 时和 `fix` 一起送进 session，请它在终端里说明（session 自己决定要不要回复）。`human` 一律给你看。`ignore` 只在「评论」标签里折叠显示，可以手动改成「要改」。

### 2.5 送进 session

`CommentDelivery`：和 CI 共用 `DeliveryGuard`（等 session 停下来、没在打字、没有草稿、不在「需要你」里，休眠的叫醒）和 `pty.deliver`（粘贴前再检查一遍）。递给谁和 CI 一样用 `ciRecipient`（推这个分支的 session > 启动时就在这个分支上的 > ticket 分支上的唯一一个，休眠的也算）。时机：每次分类完、`PrWatcher` 每轮结束（`roundDone`）、session 停下来（`sessionStopped`），和 `flushCi` 一起。

一个 PR 的待送项一次送完（最多 `comments.maxPerDelivery` 条，默认 10；多的下一次），文字（中英文跟着界面语言）：

```
PR #34 有 3 条 review 评论要处理（Copilot 2 条，人 1 条）：
1. src/a.ts:12（Copilot）
   <原文，截到 800 字>
2. …
请逐条修改，改好后 commit 并 push。不同意的那条，在终端里说明原因，不要改。Butler 会在你 push 之后核对这些位置并回复评论。
```

整条过 `sanitizeTask`（和 CI 一样的长度上限）。送出去才把这些项标成 `delivered`（记下送达时的 head sha 和 session）；没送出去留着下一次。超过 30 分钟还没送出去的，「现在」页提醒（和 CI 的「未能送达」同一种提醒，可以重发）。

### 2.6 push 之后核对、回复、resolve

PR 的 head sha 变了，而且有 `delivered` 的项：`CommentLoop` 拉一次 thread，逐项核对：

- **行内评论**：thread 变成 `isOutdated`，或者 `gh api repos/{owner}/{repo}/compare/<送达时的 sha>...<新 sha>` 里这个文件的 patch 有一段旧侧的行范围和评论的行号（±3 行）重叠：算「位置已经变了」→ `addressed`。
- **review 正文、PR 级评论**（没有位置）：送达之后有新的 commit 就算 `addressed`（弱一些，在界面上标「没有位置可核对」）。
- 位置没变：记一次 `unchanged`；等下一次 push 再核对。连续 2 次 push 都没变：标成 `human`（「push 了两次，这条评论的位置没变」），给你看。

`addressed` 之后：

1. `recordEvent("comment_auto_handled", {prId, ticketKey, repoSlug, sessionId, dedupeKey: "comment:<prId>:<评论键>", data: {who, category, source}})`（契约 4.7）。
2. 策略 `comments.reply` 为真：`externalActions.attempt("comment_reply", …)`。行内评论回复在 thread 里，PR 级评论和 review 回复成一条新的 PR 评论（引用原文第一行）。回复措辞是固定模板，克制、不自夸：英文 `Addressed in abc1234.`、中文 `已在 abc1234 中修改。`，后面跟一行小字 `(automated reply from Butler)` / `（Butler 自动回复）`。模板的语言跟 `comments.replyLanguage`（`en` 默认，GitHub 上的同事多半读英文；可选 `zh`）。开关关着：记 `skipped`，`payload` 是本来要发的那句话。
3. 行内评论、策略 `comments.resolve` 为真、回复成功（或者回复开关关着）：`externalActions.attempt("comment_resolve", …)` 调 `resolveReviewThread`。

回复、resolve 失败只记审计和日志，项标成 `addressed`（不重试，避免重复回复）；用户可以在「评论」标签里点「再回复一次」。

### 2.7 界面

- ticket 页 PR 区多一个标签「评论」：每个 PR 的评论项，按状态分组（等你看、已送进 session、已处理、已忽略），每项显示作者种类、分类、理由来源、文件和行号、原文前两行、链接；按钮「送进 session」「改成要改 / 提问 / 忽略」「忽略」「再回复一次」。
- 「现在」页：有「等你看」的评论时一条提醒「E2E-7 的 PR #34 有 2 条评论等你看分类」，按钮打开 ticket。

## 3. 三层配置（契约 4.2）

评论闭环和 CI 分类共用一份扁平的点分键策略 `LoopPolicy`，存在新表 `loop_policies`（`scope_kind` / `product_id` / `repo_slug` / `overrides` JSON），经 `LayeredResolver<LoopPolicy>` 解析，和 C 的准入策略、L 的花费上限一样。按 PR 所在仓库的 slug 解析（产品从 `lesson_products` 来）；认不出仓库只用全局层。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `comments.enabled` | 开关 | 关 | 评论闭环总开关 |
| `comments.copilot` | `auto` / `review` / `off` | `auto` | Copilot 的评论 |
| `comments.human` | `auto` / `review` / `off` | `review` | 人的评论 |
| `comments.questions` | `user` / `session` | `user` | 「在提问」的给谁 |
| `comments.useModel` | 开关 | 开 | 规则判断不了的交给模型；关了就都给你看 |
| `comments.ignorePatterns` | 文本列表 | 空 | 命中就忽略 |
| `comments.maxPerDelivery` | 1–50 | 10 | 一次最多送几条 |
| `comments.reply` | 开关 | 开 | 「自动回复评论」开着时这一层回不回 |
| `comments.resolve` | 开关 | 开 | 「自动 resolve」开着时这一层 resolve 不 resolve |
| `comments.replyLanguage` | `en` / `zh` | `en` | 回复用哪种语言 |
| `ci.enabled` | 开关 | 关 | CI 分类总开关 |
| `ci.maxReruns` | 0–5 | 2 | 同一个 commit 上同一个 run 最多自动重跑几次 |
| `ci.useModel` | 开关 | 开 | 规则判断不了的交给模型；关了就按代码问题 |
| `ci.envPatterns` | 文本列表 | 空 | 额外的「环境问题」关键字 |
| `ci.codePatterns` | 文本列表 | 空 | 额外的「代码问题」关键字（优先于环境关键字） |
| `ci.flakyTests` | 文本列表 | 空 | 手动维护的 flaky 测试或检查名单 |
| `ci.autoListThreshold` | 1–100 | 3 | 一个测试或检查在窗口内 flaky 这么多次就自动列入名单 |
| `ci.autoListDays` | 1–365 | 30 | 上面那个窗口 |

导出 / 导入（契约 4.3）没有把 I 列为提供方，这份策略这一版不进导出文件（和 L 一样），以后要加时注册一个 section 即可。

## 4. CI 失败分类（7.6）

### 4.1 在哪一步

`CiDelivery` 加一个可选依赖 `triage`。`tryDeliver` 拿到一条失败的结论、认出递给谁之前，先问 `triage.decide(item, row)`：

- `{ action: "deliver" }`：原样递（2.1.0 的行为；`ci.enabled` 关着时永远是这个）。
- `{ action: "deliver", note }`：递，通知里多一段 Butler 的判断（「可能是 flaky：已经自动重跑 2 次还是失败」「这次失败和上一次一样，按代码问题处理」「像是环境问题，但自动重跑没开」）。
- `{ action: "hold" }`：先不递：正在分类（调模型）、刚触发了重跑、在等重跑的结果。这一条不进「未能送达」的提醒。

`decide` 不阻塞：要调 gh 或模型时先返回 `hold`，后台做完再调 `ciDelivery.settled(item)` 让它重新问。结论按 (条目, head sha, run id, attempt) 缓存在 `ci_triage` 表里，重启不丢。

### 4.2 规则（确定性，先于模型）

对每个失败的检查（`failed[]`，按 run 去重），用这一轮的日志尾巴和 `runJobs` 的 job 信息：

1. **job 层面**（不看日志）：失败的 job 0 步、`runnerName` 为空（没分到机器，排队超时被取消）、run 的结论是 `startup_failure`，或者 run 被取消（`cancelled`）而 head 没变 → `env`。
2. **名单**：检查名或者日志里认出的失败测试名在 flaky 名单里（策略 `ci.flakyTests` + 自动列入的）→ `flaky`。
3. **代码关键字**（内置 + `ci.codePatterns`）：`error TS\d+`、`AssertionError`、`expect(`…`).to`、`FAIL `、`SyntaxError`、`ESLint`…… 命中 → `code`。
4. **环境关键字**（内置 + `ci.envPatterns`）：`ETIMEDOUT`、`ECONNRESET`、`ECONNREFUSED`、`EAI_AGAIN`、`ENOTFOUND`、`socket hang up`、`network timeout`、`Could not resolve host`、`TLS handshake timeout`、`502 Bad Gateway`、`503 Service Unavailable`、`rate limit exceeded`、`ERR_PNPM_FETCH`、`npm ERR! network`、`The runner has received a shutdown signal`、`lost communication with the server`、`The hosted runner encountered an error`、`No space left on device`、`unable to access 'https://`…… 命中而且第 3 条没命中 → `env`。失败的步骤是依赖下载（`Install dependencies`、`pnpm install`、`npm ci`、`Setup Node`、`actions/checkout` 之类）而且日志里有网络字样的，也是 `env`。
5. 都不是 → 交给后台模型 `ci_classify`（低档、撞限降级）：给检查名、失败的步骤、日志尾巴（最多 3000 字），回答 `env` / `code` 和一句理由。模型失败、`ci.useModel = false` → `code`（和 2.1.0 一样递给 session）。

一个 run 里只要有一个检查是 `code`，整个结论按代码问题处理（重跑也救不了）。

### 4.3 动作

- `code`：递给 session（2.1.0 的行为）。
- `env` / `flaky`：
  - 这个 (head sha, run) 已经重跑了 `ci.maxReruns` 次：按代码问题递给 session，通知里标「可能是 flaky」。
  - 这次失败的**签名**（检查名 + 日志里认出的报错行，去掉时间戳、耗时、十六进制和数字后的哈希）和这个检查上一次失败一样（不管是重跑出来的还是新 commit 上的）：**连续两次同样的失败，按代码问题处理**，递给 session，通知里写明。
  - 否则 `externalActions.attempt("ci_rerun", …)` 跑 `gh run rerun <runId> --failed`：成功就 `hold`，并让 `PrWatcher` 马上重读这个仓库（`soon`）；开关关着（`skipped`）或者重跑失败：递给 session，通知里写「像是环境问题（理由），自动重跑没开 / 重跑失败」。

### 4.4 flaky 统计

- 一个重跑过的 run 在同一个 head sha 上变成通过：这次失败算一次 flaky。对这个检查名，以及日志里认出的失败测试名（vitest / jest 的 `FAIL …`、`✗` / `×` 行，pytest 的 `FAILED a.py::t`，go 的 `--- FAIL: TestX`，playwright 的 `✘ … › name`），各记一次（`ci_flaky_events`：仓库、种类 check / test、名字、时间、浪费的毫秒）。
- **被 flaky 浪费的时间** = 从第一次看到这次失败到看到重跑通过（也就是 flaky 让 PR 晚绿了多久）。
- 一个名字在 `ci.autoListDays` 天内 flaky 次数达到 `ci.autoListThreshold`：自动列入名单（`ci_flaky_list`，来源 `auto`），以后直接重跑（仍受次数上限和「连续两次一样」的限制）。用户可以在设置里移出或手动加入（来源 `manual`）。
- 度量事件：每次重跑 `recordEvent("ci_rerun", {prId, ticketKey, repoSlug, data: {category, source, attempt}})`，每次 flaky `recordEvent("ci_flaky", {…, data: {check, wastedMs}})`。H 的 rollup 把不在表里的 kind 归进 `event:<kind>`。

## 5. 给 H「效果」页的读取接口

主进程 `LoopStats.summary({ since, until, repoSlug? }): LoopEffect`（`src/main/loop/stats.ts`），IPC `loop:effect`（参数 `{ days }`，1–365，默认 30），类型在 `src/shared/loop.ts`：

```ts
export interface LoopEffect {
  since: number; until: number;
  comments: {
    autoHandled: number;           // 闭环处理过（位置核对通过）的评论数，= comment_auto_handled 事件数
    byWho: { copilot: number; human: number };
    delivered: number;             // 送进 session 的
    replied: number; resolved: number;   // 真的在 GitHub 上回复 / resolve 的（审计 done）
    waitingForYou: number;         // 现在等你看的
  };
  ci: {
    triaged: number;               // 分过类的失败
    byCategory: { env: number; flaky: number; code: number };
    reruns: number;                // 自动重跑次数
    passedAfterRerun: number;      // 重跑后通过（= flaky 次数）
    deliveredAsCode: number;       // 最后递给 session 的
    possiblyFlaky: number;         // 超过上限、标了「可能是 flaky」的
    flakyWastedMs: number;         // 被 flaky 浪费的时间
    topFlaky: { repoSlug: string; kind: "check" | "test"; name: string; count: number; wastedMs: number; listed: boolean }[];  // 最多 10 个
  };
}
```

H 的页面直接调 `api.loopEffect(days)` 显示一块「评论与 CI」。H 的 PR2 先合：I rebase 时把这一块加进「效果」页；I 先合：报告里告诉总控，总控转给 H。

## 6. 双平台

- 所有 gh 调用都是 `execFile(bin, args)`，`--jq`、GraphQL 查询作为参数传，不经过 shell，Windows 上不会被 cmd 改写引号。
- 日志里的换行统一按 `\r?\n` 切；签名去掉 `\r`。
- 测试：分类、签名、策略、送达、核对都是纯函数或注入依赖的类，单测两边都跑。用假 gh 的 e2e（`e2e/comment-loop.spec.ts`、`e2e/ci-triage.spec.ts`）在 Windows 上 skip（假 gh 是 sh 包装，`resolveGh` 在 Windows 上只认 gh.exe），另有一个不经 gh 的集成测试（`src/main/loop/loop.integration.test.ts`）在两边跑完整闭环：Copilot 评论 → 送进 session → push → 核对 → 回复 → resolve；网络超时 → 重跑 → 通过，session 没收到东西；同样的失败两次 → 递给 session。

## 7. 数据（迁移只追加）

```sql
CREATE TABLE loop_policies (id INTEGER PRIMARY KEY, scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global','product','repo')),
  product_id INTEGER, repo_slug TEXT, overrides TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX loop_policies_scope ON loop_policies (scope_kind, COALESCE(product_id, 0), COALESCE(repo_slug, ''));
CREATE TABLE pr_comment_items (...);   -- 第 2.2 节
CREATE TABLE ci_triage (...);          -- 每个 (条目, head sha, run id) 一行：分类、来源、理由、签名、重跑次数、状态、时间
CREATE TABLE ci_flaky_events (...);    -- 第 4.4 节
CREATE TABLE ci_flaky_list (...);      -- (repo_slug, kind, name) 唯一，source auto / manual
```

## 8. 设置页

设置页加一个标签「评论与 CI」：上面是分层策略编辑器（选一层：全局 / 产品 / 仓库，每个键的生效值、来源、这一层的覆盖，和准入策略编辑器一样），下面是三个对外动作开关的快捷方式（和「对外动作」一节是同一个设置）、flaky 名单（移出、手动加入）和最近 30 天的效果（第 5 节同一份数据）。中英文文案；每个键写进 `docs/configuration.md` 和 `docs/configuration.zh-CN.md`。

## 9. 没做 / 留给以后

- 评论的「要改」送进 session 以后，改得对不对仍然要过检查和预审（G）；I 只核对「位置变了」，不判断改得好不好（源计划的风险一节）。
- 回复内容不带改动摘要：摘要要么让 session 写（不可核对）、要么再调一次模型；源计划要求措辞克制，固定模板最稳。
