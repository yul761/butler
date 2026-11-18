# Workstream B：总控短板、进度页、对外动作开关（设计补充）

上级文档：`2026-11-17-butler-3-design.md`（第 3 节 B、第 4.8 节、第 4.9 节、第 6 节"Dashboard placement"）。
这里只记 B 自己做的决定；契约以上级文档为准，这里只扩展不修改。

## 0. 开工前核实过的点

- **epic、feature 页的「PR 进度」tab 做到哪了。** 2026-11-15 的设计里三层都已经做完：ticket 页（`TicketPrStages`）、feature 页（`FeaturePrStages`，一张 ticket × 六步的表）、epic 页（`EpicPrStages`，每个 feature 一条分段进度条，点开是 feature 的表），数据由 `pr-stages-service` 算、`stateChanged` 推送。缺的是**卡在谁手上**：表里看得出哪一步红了，看不出在等哪个 reviewer、等 CI 还是等作者自己。B 把"卡在谁手上"算成一份共用数据（见第 4 节），进度页和这两个 tab 用同一份。
- **总控有没有重新生成 feature 汇总的操作。** 没有：`butler-control.ts`、`control-handler.ts` 的 op 里都没有，只有界面上的"立即更新"（IPC → `FeatureSummaryRunner.runManual`）。B 新加 `refresh_feature_summary`。
- **`lastReplyId`。** `activity-monitor.lastReplyOf(id)` 给出最后一条 assistant 文字回复和它的 `message.id`，但没有时间。B 在 `activity-parse` 里顺手记下这条记录的时间（`lastReplyAt`），回复回流靠它排除"发消息之前就有的那条回复"。
- **gh 的字段。** `gh pr view --json` 支持 `baseRefName`、`title`、`labels`、`reviewRequests`、`mergeable`、`mergeStateStatus`；这些字段在 gh 2.x 里都有，和现有的 `commits`、`statusCheckRollup` 同一批，不需要再判断 gh 版本。仍然一次调用读完，不加调用次数。
- **audit-repo。** 现有 `audit-repo.ts` 是 LLM 请求的审计（`llm_audit`，列是 provider / model / level），不适合放对外动作。4.8 说记进 "audit log (`audit-repo`)"：B 在同一个文件里加一个 `ExternalActionAuditRepo` 和一张新表 `external_action_audit`，审计页上加一块显示它。保留期沿用 `auditRetentionDays`。

## 1. `list_prs` 补字段

`ticket_prs` 新加的列（一条 migration）：

| 列 | 来源 | 说明 |
|---|---|---|
| `base_branch` | `baseRefName` | 画叠放树（K 用） |
| `is_draft` | `isDraft` | 0/1 |
| `title` | `title` | 按标题前缀分组 |
| `author` | `author.login` | "卡在作者手上"时点名 |
| `labels` | `labels[].name` | JSON 数组，按 label 分组 |
| `review_requests` | `reviewRequests` | JSON：`[{kind: "user"\|"team", name}]`，还没给 review 的人和团队 |
| `reviewers` | `reviews` | JSON：每个人（不是作者）最新的态度 `[{login, state, at, bot}]` |
| `mergeable` | `mergeable` | `mergeable` / `conflicting` / `unknown` |
| `merge_state` | `mergeStateStatus` | 小写：`clean` / `blocked` / `behind` / `dirty` / `draft` / `unstable` / `has_hooks` / `unknown` |
| `status_changed_at` | Butler 算 | 上面这些、或 state / review / CI / head 变了的那一刻；H 的指标和汇总新鲜度都看它 |

- **reviewer 的最新态度**按 GitHub 的规则：一个人有 APPROVED / CHANGES_REQUESTED / DISMISSED 的话，取最后一条这样的；只留过评论的记 `commented`。作者自己的不算。login 以 `[bot]` 结尾、或者是 Copilot 的 review，`bot: true`，不当作人在 review。
- `WatchedPr` 加同名字段（没有 PR 的分支行给空值），`list_prs` 原样带出，另外加一个算好的 `waitingOn`（见第 4 节）。旧字段不变，总控已有的用法不受影响。

## 2. 回复回流

### 数据

新表 `butler_messages`，一条 `send_message` 一行：

- `id`：`requestId`（随机 UUID），`send_message` 的结果里返回。
- `from_session`：发消息的 Butler 总控。`target_session`：送到的那个 session（head）。`feature_id` / `epic_id`：目标。
- `base_reply_id`：送之前目标的最后一条回复 id。`queued_at`：交给终端的时间。
- `status`：`sending`（在等 deliver 结果）→ `waiting`（送到了，等回复）→ `replied`（拿到回复，等送回总控）→ `delivered`。也可能是 `failed`（没送进去，`error` 写原因）或 `expired`（24 小时没回复 / 回复 6 小时没能送回去）。
- `reply_id`、`reply_text`（最多 `MESSAGE_LIMIT` 字符）、`replied_at`、`delivered_at`。

没有把回复写成 `inbox_items` 的一行：那张表的 `kind`、`report_kind` 有 CHECK 约束，改它要整表重建，别的 workstream 也在往收件箱上加东西，重建容易冲突；而且回复的去向是"发消息的那个总控"，不是 report 按层级找的总控。两张表各管各的：`list_inbox` 的结果多一个 `messages`（最近 30 条，含状态），Butler 总控页的收件箱多一个"回复"tab。

### 流程

1. `send_message` 先记一行（`sending`），`base_reply_id` 取目标 head 当前的 `lastReplyOf`。终端开着就 `sendNow`，关着就 `openAndSend`（沿用现有路径）；打开的情况下 `target_session` 在拿到新 head 之后写上。deliver / submit 的结果回来：`sent` → `waiting`，否则 `failed`。
2. 目标 session 停下来（`sessionStopped`，和递汇报同一个时机，先重读活动）：`ButlerMessages.targetStopped(id)` 找这个 head 上 `waiting` 的行，`lastReplyOf(head)` 的 id 和 `base_reply_id` 不同、而且回复时间不早于 `queued_at`，就记成 `replied`。时间的条件挡掉"resume 之后的第一次 Stop 看到的是旧回复"。同一个 head 上同时等着的几行拿同一条回复，送回时合成一条消息。
3. 送回：发消息的总控开着，过和递汇报同一道 guard（总控在忙、用户在打字、有草稿时不贴），贴一条"【回复】<目标> 回复了你的消息 <requestId>：…"。没送成的按 `inboxService.flush` 的节奏（每个 tick、总控自己停下来时）再试。
4. **给 M 留的钩子**：`ensureRunning(sessionId): Promise<boolean>`。`send_message` 交消息之前、送回回复之前各调一次；默认实现只看终端开没开（开着返回 true，关着返回 false，走现有的打开流程或者等下一次）。M 做休眠以后在这里把休眠的 session 唤醒。

### 不做的

- 不把用户自己在目标终端里打的话和总控的消息区分开：目标 session 正在忙时 guard 本来就不让送，送进去之后的下一次回复就是对这条消息的回复。
- 目标是 ticket session 的情况不存在（`send_message` 只能发给 feature 总控和 epic session）。

## 3. `refresh_feature_summary`，以及汇总的新鲜度

### 操作

`refresh_feature_summary { feature }`：按名字或 id 找 feature，后台跑 `FeatureSummaryRunner.runManual`（先给有活动的子 ticket 跑 handoff，再生成汇总），**立刻返回**：`{started: true, feature, lastSummaryAt, stale}`；同一个 feature 已经在跑时返回 `{started: false, running: true}`（runner 的 `once` 本来就合并）。和 `refresh_session` 一样只接受开着的 Butler 总控自己发的请求（会花额度）。生成完成后 `notify()`，总控再 `list_features` 就能看到新的 `summaryAt`。它不建、不删、不改任何东西，只触发一次已有的生成。走的是现有的 `feature_summary` 调用，模型路由（4.1）合进来以后它自动经过路由，B 不新加后台调用。

### 新鲜度

- `hasNewActivity` 加第三条：这个 feature 下任何 ticket 的 PR，`status_changed_at` 晚于上一份汇总读 PR 状态的时间。没人在 feature 里干活、但 PR 合了 / CI 挂了 / 有人要求修改，晚间批量和 `staleFeature` 都会认为该重新生成了。
- 汇总的 prompt 里每个 ticket 的 PR 行改成用 `ticket_prs` 的实时状态（状态、review、CI、draft、在等谁），开头写"PR 状态截至 <时间>"。以前用的是 handoff 里记下的 PR（可能是几天前的）。没有实时行的 PR（handoff 里提到、还没链接上的）照旧列出来。
- `feature_handoffs` 加一列 `pr_status_at`：Butler 自己生成的汇总记下读 PR 状态的时间；总控 `/handoff` 交上来的汇总没有（null），按 `created_at` 算。`list_features` 加 `prStatusAt`、`stale`，feature 页和进度页的汇总旁边写"PR 状态截至 …"。

## 4. 进度（共用的聚合）

`src/main/progress/progress-view.ts`：一个纯函数 `buildProgress(input, filter)`，输入 ticket、feature、epic、PR（`WatchedPr`）、feature 汇总、哪些 ticket 开工过，输出 `ProgressView`（类型在 `src/shared/progress.ts`）。进度页（IPC `progress:get`）和总控的 `progress_overview` 用同一个函数，结果一样。

### 汇总条的口径

每个未归档的 ticket 恰好落进一格，按顺序判断：

1. **已合并**：`effectiveStatus` 是 `done` 或 `merged_pending_followup`；或者有合并了的 PR、没有开着的 PR。
2. **阻塞**：`effectiveStatus` 是 `blocked`；或者有开着的 PR 处于 CI 失败、有人要求修改、有冲突。
3. **review 中**：有开着的、不是 draft 的 PR。
4. **开发中**：有 draft PR；或者开工过（有过 session，或者 PR 进度里记过第一个 commit）。
5. **未开工**：其余。

源计划的手写看板只有四格；"开发中"是 B 加的第五格：已经在写、还没开 PR 的 ticket 放进"未开工"会误导。

### 卡在谁手上

对每个开着的 PR 算 `waitingOn`（`src/shared/progress.ts` 的 `waitingOnOf`，纯函数，进度页、`list_prs` 和 PR 进度 tab 共用），按顺序：

| 情况 | 卡在 | 原因 |
|---|---|---|
| draft | 作者 | `draft` |
| CI 失败 | 作者 | `ci_failing` |
| 有人最新的态度是要求修改 | 作者（附上提要求的人） | `changes_requested` |
| 有冲突（`mergeable = conflicting` 或 `merge_state = dirty`） | 作者 | `conflicts` |
| 落后 base（`merge_state = behind`） | 作者 | `behind` |
| CI 在跑 | CI | `ci_pending` |
| 有人批准、没有要求修改 | 能合并的人（作者） | `ready_to_merge` |
| 请了 reviewer、还没人批准 | 被请的人和团队 | `review_requested` |
| 没请 reviewer、也没人批准 | 作者 | `no_reviewer` |

阻塞的 ticket 没有开着的 PR 时，记一条"卡在 ticket 上：标成了阻塞"。列表按 `status_changed_at` 从早到晚：卡得最久的在最上面。

### 其余几块

- **PR 叠放树**：开着的 PR 按仓库（slug）分组，`base_branch` 等于同一个仓库里另一个开着的 PR 的 head 分支时挂在它下面；不跨 ticket、不跨 feature 限制。有上下关系的树在前，单独的 PR 合成一行"另外 N 个单独的 PR"可展开。
- **PR 表分组**：按 label（一个 PR 有几个 label 就出现在几组里，没有 label 的进"无 label"）或按标题前缀（`[xxx]` 或 `type(scope):` 里的 `type(scope)`，再不行取第一个 `:` 之前不超过 32 个字符的部分；都没有进"无前缀"）。页面上切换，默认按 label。不写死任何业务名字。
- **按 feature 的 ticket 分组**：每个 feature 一块，标题旁边是汇总的第一句（`summary` 截到第一个句号，最多 140 字）、汇总时间、"PR 状态截至 …"、过期标记；下面是 ticket 列表（号、标题、格子、PR 数），可以展开成 feature 页那张 PR 进度表（直接复用 `FeaturePrRows`）。
- **数据新鲜度页脚**：生成时间；PR 状态最早、最晚读取时间；读失败的 PR 数；最旧的 feature 汇总时间。

### 页面

左侧菜单在「Butler 总控」下面加「进度」。顶部两个下拉：epic、feature（选了 epic，feature 只列这个 epic 的）。依次是汇总条、卡在谁手上、PR 叠放树、PR 表、按 feature 分组、页脚。数据打开时取一次，之后每次 `stateChanged` 重取（`useStateRefetch`），不轮询。

feature 页、epic 页的「PR 进度」tab 上方加一块"卡在谁手上"（同一份数据按 feature / epic 过滤），表本身不动。

### 控制工具

`progress_overview { epic?, feature? }`：返回同一个 `ProgressView`（时间写成 ISO 字符串，名字代替 id 旁边带上）。只读。

## 5. 对外动作（契约 4.8）

`src/main/external/actions.ts`：

```ts
export const EXTERNAL_ACTIONS = ["comment_reply", "comment_resolve", "pr_description_edit", "pr_label", "pr_open",
  "pr_title_edit", "force_push", "ci_rerun", "issue_post", "push_notification"] as const;
export type ExternalActionKind = (typeof EXTERNAL_ACTIONS)[number];
export interface ExternalScope { repoSlug?: string | null; productIds?: number[]; ticketKey?: string | null }
export class ExternalActions {
  allowed(kind, scope?): boolean;
  record(kind, detail: { scope?, target, summary, payload?, outcome: "done" | "failed" | "skipped", error? }): number;
  /** 不允许时也记一笔 skipped，方便抽查 "本来会做什么"。 */
  attempt(kind, scope, detail, run: () => Promise<T>): Promise<{ ran: false } | { ran: true; value: T }>;
}
```

- 每个 kind 一个设置，`external<Kind>`（如 `externalCommentReply`），`0` / `1`，默认 `0`。设置里加一块「对外动作」集中显示十个开关和一句说明（每一项会在 GitHub 或外部服务上留下什么）。
- `allowed(kind, scope)` 先看全局设置；按 4.2 分层的覆盖通过构造时注入的 `layered?: (key, scope) => string | undefined` 读（C 的 `scope/layered.ts` 合进来之前不注入，只看全局）。B 不建 `scope/layered.ts`，免得和 C 冲突。
- `record` 写 `external_action_audit`（时间、kind、仓库、ticket、目标 url、一句话、内容、结果、错误），审计页加一块"对外动作"列表。按 `auditRetentionDays` 清理。
- B 只做框架和设置；没有任何调用方。I、K、J 等 workstream 接入时走 `attempt`。

## 6. 跨平台

全是数据和界面，没有新的子进程。路径只出现在仓库名的显示里（`basename` 已处理两种分隔符）。

## 7. 测试

- 纯函数：`waitingOnOf`、`buildProgress`（每一格、分组、叠放树、过滤）、reviewer 最新态度、标题前缀。
- 仓库：migration 之后的列读写；`butler_messages` 的状态流转；`external_action_audit`。
- `PrWatcher.apply` 写新列和 `status_changed_at`；`hasNewActivity` 的第三条；prompt 里的 PR 状态时间。
- `butlerControl`：`list_prs` 新字段、`send_message` 的 `requestId`、`refresh_feature_summary`、`progress_overview`。
- `ButlerMessages`：resume 之后的旧回复不算、回复送回、总控关着时留着、过期。
- 设置：十个开关默认关、文档里都有（docs.test）。
- e2e：进度页打开、汇总条和几块都在；设置里的「对外动作」块。
