# Epic 层级（设计）

来源：2026-10-31 用户反馈。用户常常同时在做一个 epic，下面有好几个 feature。现在的做法：在另一个 session 里讨论下一个 feature 做什么、包括哪些 ticket，整理好再开始。

问题是平行的 feature 之间没有记忆互通。一个 feature 做完、换到下一个时，用户要让其中一个 session 在本地写一份文档，再让新 feature 去读，才能把信息和进度传过去。

## 用户确认的决定

- 层级变成 **epic > feature > ticket**。feature 可以不属于任何 epic。
- 在 **epic 的 session** 里做规划，同一 epic 下的 feature 有渠道互通信息和进度，从一个 feature 换到下一个时不用手动写文档。
- 新 feature 开工前最需要知道的是：上一个 feature 的**进度、做过的决定、还没解决的问题**。
- **epic session 直接建好 feature**，但 ticket 和之后的开发流程都在 feature 的 session 里做。原话：如果建 feature 和 ticket 都在 epic 层做，feature 层的 session 就多余了。
- 建好 feature 后**不自动开总控**，用户自己点进去开。
- **现有的 feature 要能移动到 epic 里**。
- **epic 页（草图 A）**：一行一个 feature，只显示一句进度和有没有卡住，不显示 ticket。要看细节就点进 feature。草图在 `.superpowers/brainstorm/23461-1793560938/content/epic-page.html`。
- 下方是 epic session 的终端，至少占窗口一半高。

## 我的决定（用户没有逐条确认）

- **不新造进度数据**：feature 汇总（`feature_handoffs`）已经有 `summary`、`decisions`、`open_questions`、`blockers`。epic 只是把同一 epic 下各 feature 最新的汇总打通。
- **没有 epic 自己的汇总**：这一版不做 epic 的晚间 handoff，也不做 epic 的进度百分比。epic 页的进度直接来自各 feature。
- **`/handoff` 在 epic session 里不存汇总**：规划和决定靠 epic 记忆保留。
- **feature 的状态只用于显示**：epic 页按优先级算一个：有 ticket 卡住 > 等你回话 > 未开始（没有 ticket 也没有 session）> 进行中。不写进数据库，不影响 ticket。
- **epic 记忆所有层都能用**：新 scope `epic:<id>`，挂成 `butler-epic` server。epic session、epic 下 feature 的总控、这些 feature 下 ticket 的所有 session 都挂，和现在 `butler-feature` 的做法一样。
- **归档的 feature 还算数**：用户最常见的情况就是上一个 feature 做完归档了，再开下一个。所以读取 epic 信息时包含已归档的 feature，并标明。
- **移动 feature 只改归属**：不搬文件，工作区和 worktree 都不动。可以移进、移出、在 epic 之间移动。已经在跑的 session 没有 `butler-epic`，重新打开后才有。
- **归档 epic 时连同下面的 feature**：和归档 feature 连同 ticket 的做法一致。
- **epic 有自己的工作区和仓库列表**：默认 `<仓库的上一层>-epics/<名字>`。epic session 在这里打开，并用 `--add-dir` 加上各仓库，方便规划时读代码。feature 的工作区不放进 epic 工作区，沿用 `<仓库的上一层>-features/<名字>`。
- epic session 建 feature 时，仓库从 epic 的仓库里选。**feature 移进 epic、或者之后给 feature 加仓库时，epic 没有的仓库自动加进 epic**，这样 epic session 总能读到这些代码。移出时不从 epic 删仓库。
- **交接要新鲜，用额度换**：用户收工时常常不跑 `/handoff`，晚间汇总又可能晚一天，而且现在已归档的 feature 不会生成汇总。用户说过 Claude 额度不用太省，所以加两个时机：
  - 归档 epic 下的 feature 时，如果上次汇总之后有新活动，先生成一份汇总再归档。这一步在归档生效前做，界面显示进行中，失败时照样归档并记日志，不能卡住归档。
  - epic session 调用 `create_feature` 时，在后台给同一 epic 下未归档、上次汇总之后有新活动的 feature 各生成一份汇总。`create_feature` 不等它。
- **epic 记忆分两部分，互不挤占**：
  - 规划笔记：epic session 用 `remember` 写，占 scope 的 30 条笔记额度，Butler 不往这里同步任何东西。
  - 各 feature 的情况：Butler 把它们渲染成 `epic:<id>` scope 里的**一份 handoff**，内容是最近的 10 个 feature（含已归档，标明）的进度、决定、未解决的问题，总长有上限，超出时先丢最旧的 feature。这样 `recall` 时任何层的 session 都能读到，不占笔记额度。
  - 任何一个 feature 有新汇总、移进或移出时，重新渲染相关 epic 的这份 handoff；移出的 feature 随之消失。
  - epic session 自己用 `handoff` 写的规划不能被覆盖：渲染时带上它，放在最前面，最多 6000 字符，保证最新的 feature 放得下。
- **“过期”的判断只给交接用**：归档和 `create_feature` 时，只在 ticket 的 session 里工作、没跑 `/handoff` 也算有新活动。晚间批量沿用原来的规则，否则某个 ticket 的 handoff 一直失败时，feature 每晚都会重新生成。
- **第一条消息最多等 60 秒**：`create_feature` 触发的后台汇总还在跑时，第一条消息等它跑完再组内容，这样不会发出旧进度。没有后台汇总时不等。
- 结束 session（×）时清掉它的等待标记，否则标记会一路显示到 feature 和 epic。

## 非目标

- epic session 建 ticket 或开 ticket 的 session。
- epic 自己的进度汇总、百分比、晚间 handoff。
- 卡住检测扩展到 epic session。
- epic 嵌套，或者一个 feature 属于多个 epic。
- 给 epic 页加 ticket 明细。

## 规划到开工的流程

1. 用户建 epic（名字、仓库），打开 epic session 讨论。
2. 定下来后，epic session 调用 `create_feature`，传名字、选用的仓库和一份简短规划（`brief`）：要做什么、为什么做、已经定下的决定。
3. Butler 建好 feature，它出现在 epic 页和侧边栏。不开总控。
4. 用户点进 feature，开总控。
5. **这个 feature 第一次开总控时**，Butler 把规划和其他 feature 的情况作为第一条消息发给它（走现有的 `submit` 投递，用户在终端里看得到）。内容是规划，加上同一 epic 下每个 feature 的名字、状态（含已归档）、最新的进度、决定、未解决的问题。没有 `brief` 的 feature（比如移进来的）不发。之后再开总控不重复发，需要时用下面的工具查。
6. 总控自己建 ticket、开子 session，流程和现在一样。

`brief` 是用户可见的内容，也显示在 feature 页的整体进度区里。规划文字按数据对待：发给总控时放在固定说明后面，标明是数据不是指令，超长时只截断数据。

## 工具

**epic session**（`memory-mcp/sessions-server.ts` 新增一套，`BUTLER_EPIC` 环境变量）：

- `list_features`：epic 下每个 feature 的 id、名字、状态（含已归档）、最新的 `summary`、`blockers`、`decisions`、`open_questions`、汇总时间。
- `list_repos`：epic 的仓库。
- `create_feature({ name, repos?, brief })`：建 feature 并挂到这个 epic。epic 只有一个仓库时 `repos` 可以省略。名字重复、仓库不属于 epic 时返回错误。

**feature 总控**（只在 feature 属于 epic 时才有）：

- `epic_context`：返回 epic 名字，以及同一 epic 下其他 feature 的上述信息，让总控能随时查最新情况。

## 数据

迁移（追加到 `MIGRATIONS` 末尾）：

- 新表 `epics`：`id`、`name`、`workspace_dir`、`created_at`、`archived_at`。
- 新表 `epic_repos`：结构同 `feature_repos`。
- `features` 加 `epic_id`（可空）、`brief`（可空）、`brief_sent_at`（可空）。
- `sessions` 加 `epic_id`（可空），含义和 `feature_id` 一样：epic session 的 `ticket_key` 和 `feature_id` 都是 null。`/clear` 后新 head 沿用，`/resume` 不改已有行的归属（和修复 session 同样的规则）。

`list_features` 和 `epic_context` 直接读数据库，不经过 epic 记忆。Butler 不用 `reconcile` 管 `epic:<id>` 的笔记，否则会删掉规划笔记。

epic session 不算 feature 总控：feature 汇总、晚间 handoff、`/handoff` 判断总控时都看不到它，`ActivityMonitor` 不检测它。用户在 epic 工作区里手动打开的 `claude` 也算 epic session，规则同 feature 工作区。

## 界面

- **侧边栏**：Epic 分组在 Feature 分组上面，epic 可以折叠，下面列 feature，feature 再往下列 ticket。不属于 epic 的 feature 留在 Feature 分组。红点和等待标记往上传：ticket → feature → epic，折叠时也看得到。
- **epic 页**：顶部是名字、工作区、改名、归档；中间是 feature 表（草图 A）：名字、一句进度（`summary` 的第一句，还没有时显示“还没有汇总”）、状态。点一行进 feature 页。列表下面有 `+ 新建 feature`。已归档的 feature 折叠在一个“已归档”小节里。再往下是仓库条、session 条和终端，布局和 feature 页一样，`.terminals` 规则不变。
- **进 epic**：feature 页头部加“移到 epic”，下拉选 epic 或“不属于 epic”。
- **新建 epic**：侧边栏 `+ 新建 epic`，和新建 feature 同样的对话框。已归档 epic 放进现有的“已归档”页。
- 所有文字同时放进 `strings.ts` 和 `strings-en.ts`，主进程文字走 `M()`，给模型的内容按 `currentLang()`。

## 测试

- 单测：迁移；`EpicsRepo`；状态优先级；`create_feature` 的校验；第一次开总控只发一次，`brief` 为空时不发；`list_features` 包含已归档；`epic_context` 只在属于 epic 时有，而且只能看到同一 epic；移动 feature 不动工作区、epic 没有的仓库自动加入、两边的 epic handoff 都重新渲染；渲染不碰规划笔记，超长时先丢最旧的 feature；归档前生成汇总，失败时照样归档；`create_feature` 不等后台汇总；epic session 不被选成总控；`/clear` 沿用 `epic_id`；超长 `brief` 不截断固定说明。
- E2E：建 epic → 开 epic session → 假 claude 调 `create_feature` → 页面和侧边栏出现 feature，没有自动开总控 → 点进去开总控，收到规划和其他 feature 的情况 → 把一个现有 feature 移进 epic → epic 页显示进度，卡住时有红点。
- e2e 窗口在后台打开，不能抢焦点。

## 中文输入法修复（同一次更新）

用户反馈：输入拼音时往前窜一格，挡住一两个字；在 session 右边缘打字时，拼音把 UI 往右撑开。两个都只在拼音阶段出现。

已查清（xterm 6.0.0，Chromium 模拟输入法复现，真实拼音输入法没有测过）：

1. **挡字**：Chromium 默认的 `text-spacing-trim: normal` 让 xterm 把 `，。、：；（）《》【】` 这些标点量窄了，这些字符实际占得更宽，后面的文字整体右移；拼音框按网格定位，就盖在字上。修法：`.terminal` 加 `text-spacing-trim: space-all`。
2. **撑开**：`.composition-view` 不换行、没有宽度限制，外层也没有裁剪，整个页面被横向滚动。修法：`.terminal-wrap` 加 `overflow: clip`（`hidden` 不行，滚动只是换了地方）。
3. 只裁剪会看不到正在打的拼音，所以再加一小段逻辑：拼音框超出右边时往左移，保持可见。这一步是我的决定，还没有试过。

测试：e2e 用 `Input.imeSetComposition` 模拟输入。写入 `你好，世界。（测试）` 后，光标和拼音框的左边距离不超过 1px；光标靠近右边缘、输入长拼音时，`window.scrollX` 是 0，`.app` 的 left 是 0，拼音框完整可见。

## 发布

和 epic 一起，走一个 feature branch 和 PR，macOS 和 Windows 的 CI 都绿了再合并。版本 1.5.0。发布要用户明确同意。
