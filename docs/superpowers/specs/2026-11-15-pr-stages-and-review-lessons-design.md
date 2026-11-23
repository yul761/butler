# PR 进度条和 review 经验（设计）

来源：2026-11-15 用户在 BTL-190 里提出的两件事。两件互相独立，按顺序做：先做第一件 PR 进度条，再做第二件 review 经验。

## 为什么要做

- **PR 进度条。** 每个 PR 都要走 设计 → 开发 → 自我 code review → CI → peer review → 合并。现在只有后三步的一点状态（ticket 上的 PR / CI 标记），看不出一个 PR 走到哪一步、被打回过几次。用户想在 ticket、feature 总控、epic 三层都能实时看到。
- **review 经验。** 用户的目标原话是"写代码的时候第一下就写对"：让 Copilot review 和 peer review 在 PR 上能挑出来的问题尽量少。做法是读历史 PR，找出 review 挑出来、开发时漏掉的问题，提炼成规矩。规矩在开发时和自我 review 时都自动用上，越用越准。

## 目标、非目标、反目标

目标：
- ticket 页、feature 总控页、epic 页各有一个「PR 进度」tab，内容实时更新。
- 有一个单独的「review 经验」页面（左侧菜单），按仓库和产品分组，管理从历史 PR 提炼出来的规矩。
- 已确认的规矩自动送进 Shipherd 开的 ticket session，开发时和自我 review 时都要用上。

非目标（这次不做）：
- 把规矩导出到仓库自己的 `CLAUDE.md` 或 `.github/copilot-instructions.md`，以后可以加一个按钮。
- 给不是 Shipherd 开的 session（用户自己在终端里开的 claude）送规矩。
- 统计每个仓库的 review 问题数量、画趋势图。

反目标（做出来但出现这些就算失败）：
- 进度条占地方：tab 和时间线都必须能收起，收起状态要记住。
- 进度停在旧的那一步不动，或者跟实际对不上。宁可显示"跳过"或"未知"，也不要显示错的。
- 没经用户确认的规矩送进了 session。
- 规矩越堆越多，session 的说明越来越长，开发时反而抓不住重点。

## 现状（相关部分）

- **tab。** `PageTabs`（`src/renderer/src/components/PageTabs.tsx`，`page-tabs.ts`）已经支持点当前 tab 收起、记住选中的 tab。feature 页有 `progress`、`tickets`，后面跟着汇报和待你决定两个 tab（`...inboxTabs`，`InboxPanes.tsx:50,55`）。epic 页有 `features` 加同样两个 inbox tab。ticket 页（`TicketPage.tsx`）还没有 tab，从上到下是标题、仓库条、提示、session 条、终端。
- **PR / CI。** `prwatch/pr-watcher.ts` 按 ticket 的每个仓库分支轮询 `gh`：开着 session 且 CI 在跑时每分钟一次，否则 5 分钟一次。PR 合并或关闭后不再查（`pr-watcher.ts:54`），只看未归档 ticket 的分支（`pr-targets.ts`）。存在 `pr_watch` 表，有 `state`、`review`、`ci`、`headSha`。`review` 来自 GitHub 的 `reviewDecision`，可能是 pending / changes_requested / approved，也可能是 null：仓库没开"必须 review"时一直是 null（`tickets/gh.ts:86,176`）。目前不拉 review 和评论的内容。
- **hook。** 全局 hook（`hooks/installer.ts`）只装了 `SessionStart`、`Stop`、`UserPromptSubmit`、`SessionEnd`，hook 往 `~/.shipherd/inbox` 写信封，`hooks/hook-events.ts` 处理。session 的 `--settings` 文件（`claude/project-mcp.ts:261`）另有 `PreToolUse` / `PostToolUse` 的 Bash matcher，给合并闸门用。这个文件按内容取 hash，内容相同的 session 共用一个（`project-mcp.ts:265`）。hook 程序是当前版本时才写进 hook（`project-mcp.ts:260`）。现在看不到 session 调了哪个 skill。
- **换新。** 换新是在原来的终端里敲 `/clear`（`session-refresher.ts`），不重启 claude，`--append-system-prompt-file` 只在启动时传一次（`spawn.ts:34`）。
- **隐私。** handoff 的 headless claude（`headless-exec.ts`）只记用量，不写 `llm_audit`，也不做敏感词过滤。`llm_audit` 和隐私档位只管可选的个人 LLM API（StateCore 蒸馏，`gateway/gateway.ts`）。README 的说法是：公司的活只走用户自己的 `claude`。
- **session 归属。** 多仓库 ticket 的总控 session `repoId` 是 null（`ticket-service.ts:384`）。修复 session 在 feature 工作区里跑，`ticketKey` 是 null（`session-service.ts:590-597`）。
- **汇报。** session 的 `report` 工具（`memory-mcp/sessions-server.ts`）有 progress / done / blocked 三种，存在 `inbox_items` 表里。
- **session 说明。** `claude/session-guide.ts` 按 kind 和语言生成一份文件，用 `--append-system-prompt-file` 带上。现在同一种 kind 的所有 session 共用一个文件（`guide-${kind}-${lang}.md`）。
- **后台 claude。** `handoff/headless-exec.ts` 已经能跑 headless claude、拿结构化输出、记用量。
- **仓库。** Shipherd 里没有独立的仓库表。仓库只是 `ticket_repos`、`feature_repos`、`epic_repos` 里的路径，同一个仓库的不同 worktree 路径也不同。

## 第一件：PR 进度条

### 怎么做（用户选的做法）

考虑过三种识别前三步的办法：
1. 全自动识别：靠 hook 看到的 skill 调用和 git commit 判断。不靠 AI 记得报告，但时间线上只有"发生了什么"，没有内容。
2. session 自己报告：加一个工具让 session 进入某一步时调用。内容具体，但 AI 常常忘记调用，进度会停在旧的那一步。
3. **自动识别为主，session 的汇报补内容（用户选了这个）。** 哪一步开始、哪一步结束按 1 自动判断；session 的 progress / report 挂在当时那一步的时间线下面当说明。

### 六步各自怎么认

每个 PR 对应 ticket 的一个仓库（一个 `ticket_repos` 行），一个 ticket 有几个仓库就有几条进度条。

| 步骤 | 开始 | 结束 |
|---|---|---|
| 设计 | 这个 ticket 的 session 调用了 brainstorming 或 writing-plans 一类的 skill（Skill 工具，或者用户输入的 `/` 命令） | 分支上出现第一个 commit。没调用过就显示"跳过"，例外见下面"feature 层的设计" |
| 开发 | 分支上出现第一个比 base 新的 commit | 开始自我 review，或者开了 PR |
| 自我 review | 调用了 code-review、requesting-code-review、simplify 一类的 skill | 下一次 push（`headSha` 变了），或者开了 PR。没调用过就显示"跳过" |
| CI | 有 PR、CI 在跑 | CI 通过或失败；失败就回到"开发" |
| peer review | CI 通过、PR 开着 | 有一个人（不是 PR 作者、不是 bot）的最新 review 是 APPROVED。有人的最新 review 是 CHANGES_REQUESTED 时回到"开发"，下一轮 peer review 记作第 2 轮。批准跟 GitHub 一样：an approval stands across pushes and CI rounds until dismissed or superseded by CHANGES_REQUESTED（批准跨 push 和 CI 轮次一直有效，直到被撤销或被 CHANGES_REQUESTED 取代）；有人的修改请求还在时，别人的批准不算。没有人批准就合并了，显示"跳过"；合并时还有人的修改请求在，显示"失败" |
| 合并 | peer review 结束（批准或跳过） | PR merged；closed 没合并就整条标成"已关闭" |

peer review 不看 `reviewDecision`，看拉回来的 reviews 列表，这样没开"必须 review"的仓库也能判断（我的判断）。Copilot 的 review 不算 peer review（用户把它们当成两件事说），只作为时间线条目出现。

具体规则：
- **回退和轮数。** CI 失败、peer review 要求修改都会回到"开发"，之后的自我 review、CI、peer review 按新一轮重新走（还在的批准带进新一轮，peer review 不用重做）。步骤条显示当前这一轮。轮数大于 1 时，在当前那一步上标"第 N 轮"。
- **识别 skill 调用。** 两条来源都要：
  - session 的 `--settings` 内容加一个 `PostToolUse` 的 `Skill` matcher，命令走现有的 shipherd hook（写信封），不走闸门。按内容 hash 共用文件不影响这件事；和闸门一样，只在 hook 程序是当前版本时写进去，不是当前版本时这两步显示"未知"而不是"跳过"。
  - `UserPromptSubmit` 里，用户输入以 `/skill名` 开头的也算。
- **事件挂到哪条进度条（我的判断）。**
  - session 有 `repoId`：挂到那个仓库。
  - 多仓库 ticket 的总控（`repoId` 为 null）：挂到这个 ticket 的所有仓库。
  - 修复 session：挂到它修的那个 session 所属的 ticket 和仓库；找不到就不挂。
- **feature 层的设计（我的判断）。** Shipherd 的 feature / epic 流程里，设计常常是 feature 总控或 epic session 做的。如果 ticket 建出来之前，它所在 feature 的总控或 epic session 调用过设计类 skill，这个 ticket 的"设计"显示"在 feature 层完成"（算完成，悬停显示时间）。

  哪些 skill 名算"设计"、哪些算"自我 review"，写成一张可以改的表，放在代码里一处，匹配时忽略插件前缀（`superpowers:brainstorming` 也算 brainstorming）。
- **commit。** 不额外轮询 git：PR 监视查分支时顺便取第一个 commit 的时间（没有 PR 时用 `git log base..branch`）。精确到分钟级就够。
- **Copilot 和 peer review 的评论（我的判断）。** Copilot 的 review 往往在开 PR 或 push 几分钟后才出来，人只留评论也不会改 `reviewDecision`，所以不能只在状态变化时拉。做法：
  - 现有每轮那次 `gh pr view` 的 `--json` 里加上 `reviews` 和 `comments`，不增加调用次数。
  - 行内的 review 评论要另调一次 `gh api .../pulls/N/comments`，只在 reviews 或 comments 的数量比上一轮变多时调。
  - 评论按作者分成 Copilot、人（不是作者）、作者自己。时间线上记"Copilot 留了 N 条"、"peer review：要求修改"。原文存下来，第二件要用。
- **时间线的说明。** 这个 ticket 的 session 发的 report（任何 kind）按时间挂到当时所在的那一步下面。session 说明里加一句：自我 review 做完，用 report（progress）汇报找到了什么、改了什么。

### 存储

新加一张 `pr_stage_events` 表，每个事件一行：ticket_repo id、步骤、事件类型（开始 / 结束 / 跳过 / 回退 / 评论 / 汇报）、轮数、时间、一句说明、来源。进度条和时间线都从这张表算出来，不另存"当前步骤"，避免和事件对不上。算法是一个纯函数，输入事件列表，输出每一步的状态和时间线，单独测试。

### 界面

用户看了草图，选的是"步骤条 + 时间线"（B），并要求时间线能单独收起来。

ticket 页：
- 在仓库条下面、session 条上面新加 `PageTabs`，只有一个 tab「PR 进度」，现有内容不拆、不挪。草图里的「概览」「活动」是示意，不做。
- 每个仓库一条步骤条，六个格子：做完的绿、进行中的蓝、失败或被打回的红、没到的灰、跳过的灰色加"跳过"字样。第 N 轮标在当前那一步上。
- 步骤条下面是时间线：时间、步骤、一句话。有一个"收起时间线"的开关，状态记在本地（参考 `useCollapsed.ts`）。
- tab 本身点一下收起，沿用 `PageTabs` 的行为。

```
[PR 进度 ▾]
设计 ✓ → 开发 ✓ → 自我 review ✓ → CI ✓ → peer review · 第 2 轮 → 合并
▾ 时间线
  09:12  设计：spec 写完
  10:40  开发：4 个 commit
  11:05  自我 review：找到 2 处，已改
  11:20  CI ✗ → 回到开发
  11:48  CI ✓ · Copilot 留了 3 条
  14:30  peer review：要求修改 → 回到开发
  15:10  peer review 第 2 轮 · 等待中
```

feature 总控页和 epic 页的新 tab 都放在现有内容 tab 之后、汇报和待你决定两个 tab 之前。

feature 总控页：新加「PR 进度」tab。一张表，每个 ticket 的每个仓库一行，每一步一列，格子颜色同上，当前那一格写"进行中"、"✗"或"第 N 轮"。点一行进那个 ticket 的页面。

epic 页：新加「PR 进度」tab。每个 feature 一行：一条分段彩色进度条（已合并、进行中、失败或被打回、没开始各占多少个 PR）加"N/M 已合并"。点一行展开成 feature 页那种表。

数据实时推送：沿用现有渲染进程收状态的方式（`stateChanged` 一类的事件），有新事件就刷新，不在渲染进程轮询。

## 第二件：review 经验

### 怎么做（用户选的做法）

考虑过三种把规矩送进开发的办法：
1. **存在 Shipherd 里，开 session 时带上（用户选了这个）。** 规矩存在 Shipherd 的数据库里，打开 ticket session 时，按它的仓库和产品挑出已确认的规矩，写进这个 session 的说明。
2. 写进仓库的 `CLAUDE.md` 或 `.github/copilot-instructions.md`：Copilot 也能读到，但每改一次规矩都要在用户的仓库里提一次 PR，团队都看得见，产品级的规矩要在前后端各写一份。以后可以作为导出按钮补上。
3. 放进 StateCore 记忆：recall 按相关度截断，条目多了会被截掉，不适合"必须遵守"的规矩。

### 仓库和产品

- **仓库的身份**用 GitHub 的 `owner/name`（从 git remote 取），不用路径。这样同一个仓库的不同 worktree 和 clone 算同一个。没有 GitHub remote 的仓库不能分析，页面上说明原因。
- **产品**是用户在这个页面上把几个仓库归成一组，比如前端加后端。一个仓库可以属于多个产品（一个后端给两个前端用），表结构是多对多（我的判断）。规矩挂在仓库上，或者挂在产品上（跨仓库的那种）。开发产品里任一个仓库时，带上那个仓库的规矩和产品的规矩。
- **建议归组。** 同一个 ticket 或 feature 里一起出现过两次以上的几个仓库，页面上提示"要不要归成一个产品"，用户点了才建。

### 素材从哪来

对每个已合并的 PR：
- **review 挑出来的。** Copilot 的 review 和评论、人的 review 和评论（`gh api`），按作者分开。
- **开发时的决定。** Shipherd 做的 PR（能对上 ticket 的）用它的 handoff 和对话记录里讲到为什么这样写的部分。不是 Shipherd 做的 PR 只用 PR 描述和 commit message。
- **最后怎么改的。** 评论之后的 commit diff，只看评论指到的那几处。

### 分析流程

1. **回溯。** 用户在页面上对一个仓库点"分析历史"，处理最近 100 个已合并的 PR。没有任何 review 评论的 PR 直接跳过，不花分析的钱。
2. **持续（我的判断）。** 两条路进队列：
   - PR 监视看到 Shipherd 跟踪的 PR merged，马上排进去。
   - 对每个分析过历史的仓库，每天一次按仓库拉"上次拉取以来合并的 PR"（`gh pr list --state merged --search merged:>…`），同事的、不经 Shipherd 的 PR 也进来。每个仓库记一个游标（上次拉到的合并时间）。
3. **每个 PR 一次后台 claude**（`headless-exec`）。输入这个 PR 的素材，加上这个仓库现有的规矩（已确认的和待确认的）。输出结构化 JSON：每个 review 挑出的问题，判断它是不是开发时本来能避免的、为什么当时漏了；能提炼成规矩的，给出规矩正文、适用范围（仓库或产品）和出处（PR 号、评论链接）。和现有规矩意思一样的，标成"又出现一次"，不新建。
4. 新规矩进「待确认」，不送进任何 session。

分析用默认的后台模型（和 handoff 一样），用量记进现有的用量统计。同时最多跑 2 个，队列持久化，退出 app 不丢。

### 规矩的生命周期

- **待确认** → 用户可以确认、改了再确认、或者驳回。
- **已确认**：开 session 时送进去。用户可以随时改、停用、删。
- **驳回**的记下来，以后分析再提出意思一样的规矩时直接丢掉，不再打扰用户。
- **每条规矩**记出处（哪几个 PR、哪几条评论）、出现次数、最后一次出现的时间。
- **上限（我的判断）。** 按 session 算：一个 session 收到的已确认规矩合计不超过 30 条，不管它涉及几个仓库、几个产品。超了按出现次数和最近出现时间排序，只送前 30 条。页面上按仓库显示"单独开这个仓库的 session 时，有几条送不进去"，建议合并。合并两条规矩由用户在页面上操作，也可以让后台 claude 给出合并建议，进待确认。

### 送进 session

- **每个 session 一份说明。** session 说明改成每个 session 单独生成一个文件（现在同一种 kind 共用一个）。共用的那些段落不变，最后加一段这个 ticket 所有仓库和产品的已确认规矩。只给 ticket session 和修复 session 加，总控、epic、Shipherd 总控不加。修复 session 用它修的那个 session 所属 ticket 的仓库；找不到就用 feature 的仓库（我的判断）。
- **规矩这一段的内容：**
  - 开头说明：这是从这个仓库以前的 review 里总结出来的规矩，写代码时就照着做；做自我 review 时逐条对照，在 report 里写明对照的结果。
  - 每条一行，前面是仓库名或产品名。
- **生效时机（我的判断）。** 规矩改了，对已经开着的 session 不生效，下一次打开或恢复时才生效。换新只敲 `/clear`、不重启 claude，所以换新之后还是旧规矩，这次不为此改换新的流程。

### 页面

左侧菜单新加一项「review 经验」，放在「审计」上面。

- **顶部**：产品和仓库的列表（产品下面缩进列出它的仓库），选一个看它的规矩。每个仓库显示：上次分析的时间、分析过多少个 PR、队列里还有几个，以及"分析历史"按钮。
- **待确认**：每条显示规矩正文、为什么提这条（一两句）、出处链接，三个按钮：确认、编辑后确认、驳回。
- **已确认**：每条显示正文、出现次数、最后出现时间、出处，可以编辑、停用、删除。
- **管理产品**：新建产品、把仓库拖进去或移出来；归组建议显示在这里。

## 约束

- 中英文界面字符串成对加（`strings.ts` / `strings-en.ts`），README 中英文成对更新。
- 新表通过 `db/migrations.ts` 加。
- 所有对 GitHub 的调用走现有 `tickets/gh.ts` 的模式（超时、并发上限）。PR 监视现有的轮询频率不变：评论只在 PR 状态或 headSha 变化时多拉一次。
- 渲染进程不直接调 `gh`。
- 后台分析和 handoff 一样走用户自己的 `claude`（`headless-exec`），只记用量，不写 `llm_audit`，不受隐私档位影响，因为不用个人 LLM API（我的判断，和 README"公司的活只走你自己的 claude"一致）。README 的隐私一节要补一句：review 经验的分析会把 PR 评论和 Shipherd 的对话记录交给你自己的 `claude`。

## 留给实现的人

- 哪些 skill 名算设计、哪些算自我 review 的初始表。
- Copilot 在 GitHub API 里的作者 login 具体是什么（REST 和 GraphQL 可能不一样），用一个真实带 Copilot review 的 PR 验证。
- 后台分析的 prompt 和 JSON schema。
- 时间线里一句话的具体措辞。
- 「PR 进度」tab 在 ticket 页上默认展开还是收起（建议默认展开，记住用户的选择）。
