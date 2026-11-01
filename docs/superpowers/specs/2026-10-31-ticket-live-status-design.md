# Ticket 实时状态和卡住处理（设计）

来源：2026-10-31 用户反馈。用户想要“更直来直去”的 UI，讨论下来最具体的需求是：同时跑很多个 ticket session 时，各处的汇报交错，不好判断每个 ticket 现在到底什么情况。

现在的问题：

1. feature 页的 ticket 列表只显示 ticket 状态和 PR 状态（等 review、已合并），看不出 session 此刻在干什么：写代码、跑 pre-push hook、监控 CI，还是卡住了。
2. 打开 session 也不一定看得到。pre-push hook 这类命令在 shell 里跑，Claude Code 的界面只显示运行时间，看不到进行到哪了。
3. 用户怀疑卡住时会问总控，再让总控解决。但总控从 Butler 拿到的只有 `firstPrompt`、`running`、`waitingForInput`、`lastActivityAt`，而且 Claude Code 的跨 session 消息要等对方下一轮工具调用才读到，所以子 session 跑长命令时问不到答案。

## 用户确认的决定

- 实时状态在**页面上标出来**。真卡住时同时**发通知**，并在 feature 页这个 ticket 的行上加**红点**，防止用户没看到通知。
- 点红点后，在**这一行下面展开**（草图 A），写着要做什么。面板可以缩回，再打开时恢复。
- 展开时 Claude Code 终端区至少占窗口一半高的规则不变，session 仍然能正常输入和回复。
- 面板上点一下，在 **feature 层开一个新 session** 去解决，**不影响原来的 session**。解决后发消息告诉总控 session 问题已解决。
- 新 session 要杀进程时，**先问用户，确认后才杀**。
- 新 session **只在做可能影响原 session 的事时才发消息**，比如改 branch、停进程，不用每一步都同步。原因：否则原 session 还在等一个已经被停掉的进程，自己却不知道。
- **不设固定时限**判断卡住：用户的 pre-push hook 最长要二三十分钟，时间随机器内存变化。改成每隔几分钟看一次。
- 用 Claude 判断不用太省，公司额度够。

## 我的决定（用户没有逐条确认）

- **实时信息也给总控**：用户的动作是先问总控，所以总控要能直接查到，不用等子 session 回话。
- **卡住检测分两步**：Butler 先做不花钱的本地检查，可疑时才调用一次 headless Claude。只有 Claude 判断真卡住，才标红点、发通知。这个方案用户同意了，具体参数是我定的：每 3 分钟检查一次，连续两次没有变化算可疑。
- **先发消息，再动手**：消息要等下一轮工具调用才读到，先发的话，命令一被杀，原 session 拿回控制权时就能看到是谁停的、为什么停。
- 面板上的“看终端”和“没事，忽略”两个按钮是我加的。
- 状态列的规则：ticket 有运行中的 session 时显示此刻在干什么；没有时显示原来的 ticket 状态。PR 列不变。
- 一个 ticket 有多个运行中的 session（多仓库）时，这一行显示最需要注意的那个：卡住 > 等你批准 > 等你回话 > 最近有活动。
- 侧边栏的 feature 行也显示红点，用户在别的页面时也能看到。这一版不改其他页面的状态显示。
- 卡住状态只存内存，Butler 重启后重新判断。
- 只做 feature 下的 ticket。单独的 ticket 这一版没有状态列和红点。
- **卡住检测的范围**：只检查 feature 下 ticket 的 session。单独 ticket 的 session、feature 总控、修复 session 不检查，因为它们没有能放红点的行。这些 session 的活动照常读取，`stuck` 返回 `null`（表示“没检查”，不是“没卡住”）。
- **后台命令优先于“等你回话”**：这一轮结束但后台命令还在跑时，session 在等命令，不是等用户，所以显示命令，并且进入卡住检测。`waitingForInput` 本身和其他页面的等待标记不变。
- **修复 session 不受运行数量上限限制**：`openFeature` 现在就不检查上限，保持这样。上限只卡总控的 `start_session`。否则最忙的时候救不了卡住的 session，用户还得先关掉一个正常的。

## 非目标

- epic 层级、中文输入法问题，这两项是单独的工作。
- 其他 UI 调整。用户说其他页面暂时没有想法。
- 自动解决：Butler 不会不经用户点击就开新 session。
- 给子 session 发消息的新工具：Claude Code 的 `SendMessage` 已经能做到。
- 新 session 的 worktree 隔离。它和原 session 用同一个 worktree，靠上面的消息规则避免互相踩到。

## 数据从哪来

Butler 现在只监听 `SessionStart`、`Stop`、`UserPromptSubmit`、`SessionEnd`，下面这些都是新增的读取。

- **session 在干什么**：读 session transcript 的尾部（`~/.claude/projects/<项目>/<session id>.jsonl`），找最后一个还没有 `tool_result` 的 `tool_use`。2.1.316 实测：运行中的命令开始后 3 到 6 秒内就出现在 transcript 里。`src/main/handoff/transcript.ts` 已经有只读尾部的写法。
- **shell 跑到哪了**：读 Claude Code 写的命令输出文件 `<临时目录>/claude-<uid>/<项目>/<session id>/tasks/<id>.output`。实测后台命令跑到一半能读到已经打印的内容，前台命令观察到一次同样的情况。
- **后台命令**：长命令常常是后台跑的。Bash 工具前台上限 10 分钟，用户二三十分钟的 pre-push hook 只能放后台，而且用户说打开 shell 只能看到运行时间，也符合后台 shell 的表现。这时 `tool_result` 马上返回，Claude 可能结束这一轮，`Stop` 把 session 标成等待输入。所以光看“最后一个没结果的 `tool_use`”不够，Butler 要跟踪每个 session 的后台命令：从 `run_in_background` 的 `tool_use` 和它的返回里拿到任务 id 和输出文件，看到这个任务的完成通知才算结束。
- **终端输出不能当活动信号**：`pty-manager` 的 `lastOutputAt` 会被 Claude Code 的动画刷新，不代表命令有进展。

已知限制：命令后面接 `| tail` 时跑完才有输出；hook 打印得少，这里能看到的也少；transcript 和 tasks 目录都是 Claude Code 的内部细节，版本升级可能会变。读不到输出文件时退回只显示命令和时长，功能不能因此报错。

## 状态怎么显示

状态分类和文字：

| 情况 | 显示 |
| --- | --- |
| 编辑文件 | 写代码 + 文件名 |
| 读文件、搜索 | 看代码 |
| `git push` | 跑 git push（pre-push hook）+ 时长 |
| `gh run watch`、`gh pr checks --watch` 这类 | 监控 CI + 时长 |
| 测试命令 | 跑测试 + 时长 |
| 其他 shell 命令 | 运行命令 + 命令前 40 个字符 + 时长 |
| 子 agent | 子 agent 在跑 + 时长 |
| 这一轮没结束，也没有工具在跑 | 思考中 |
| 权限确认 | 等你批准 |
| 这一轮结束了，后台命令还在跑 | 按上面的命令分类显示，加“后台” |
| `waitingForInput`，也没有后台命令 | 等你回话 |
| 判定卡住 | 显示原来的活动，加“已 N 分钟没有新输出” |

Butler 运行时，每 10 秒更新一次有运行中终端的 session。列表的活动文字最多一行，长了截断。

## 卡住检测

每 3 分钟检查一次 feature 下 ticket 的运行中 session，条件是这一轮没结束，或者还有后台命令在跑。比较和上一次相比：

- transcript 有没有增长；
- 输出文件有没有增长；
- session 的子进程树有没有在用 CPU。

都没有变化算一次“没动静”，连续两次就算可疑。正在等用户批准的 session 不算；等用户回话但没有后台命令的 session 不算。任何一项有变化，计数清零。

可疑时调用一次 headless Claude（只读），把活动、时长、最后的输出、子进程情况给它，返回 `{ stuck, reason, action }`。

- `stuck: false`：不打扰用户，这个 session 10 分钟内不再调用。
- `stuck: true`：标红点、发一次通知，面板上显示 `reason` 和 `action`。
- headless 失败：不标红点，下一轮可疑时再试。

卡住状态的结束：session 出现新活动时红点自动消失；用户点“没事，忽略”后，这一次不再提醒，直到它恢复活动后再次卡住。

每次卡住只发一次通知。点通知打开这个 feature 页，并展开这个 ticket 的面板。

## 界面

沿用草图 A（`.superpowers/brainstorm/59274-1793509433/content/stuck-ticket.html`）。

- feature 页 ticket 表：状态列按上面的规则显示。
- 卡住的行：红点、淡红底色。点红点展开面板，不进 ticket 页；点这一行的其他位置还是进 ticket 页。
- 面板内容：可能的原因、最后的输出（最多 6 行）、要做什么，按钮是“开新 session 解决”“看终端”“没事，忽略”。
- 每行各自记住展开状态，用现有的 `useCollapsed`，可以同时展开多行。
- ticket 区收起时，标题行显示红点，和现有的等待标记一样。
- 面板放在 `.feature-overview` 里，这个区域空间不够时会先缩、自己滚动。不改 `.terminals` 的 50vh。
- 所有文字同时放进 `strings.ts` 和 `strings-en.ts`，主进程文字走 `M()`。

## 开新 session 解决

点“开新 session 解决”：

1. 用 `SessionService.openFeature` 在 feature 工作区开新 session，不受运行数量上限限制。
2. 用现有的 `task` 投递机制把任务发给它，内容包括：ticket、卡住 session 的 id、名字和目录、活动、原因、最后的输出，以及下面的规则。
3. 新 session 出现在 feature 页，用户能看到、能接手。

任务里写明的规则：

- 目标是让卡住的 session 能继续，不接手那个 ticket 的工作。
- 要杀进程时先问用户，用户确认后才杀。
- 改 branch、停进程这类可能影响原 session 的事，先用 `SendMessage` 告诉原 session，再动手。其他事不用同步。
- 解决后告诉总控 session 问题已解决。没有运行中的总控时跳过这一步。

这个 session 不是总控：feature 汇总、晚间 handoff、`/handoff` 判断总控 session 时都不能选到它。

**名字问题**：`SendMessage` 用 session 名字寻址。Claude Code 为每个运行中的 session 写一份登记文件 `~/.claude/sessions/<pid>.json`，里面有 `sessionId`、`name`、`status`，实测 `name` 和 `ListAgents` 显示的一致。Butler 开任务时按 `sessionId` 查出名字写进任务；查不到时让新 session 自己用 `ListAgents` 按目录找。

## 给总控的接口

`memory-mcp/sessions-server.ts` 的 feature 和 ticket 两套工具：

- `list_sessions` 每一行加上 `activity`：分类、文字、开始时间、最后一次有新输出的时间、是否卡住及原因。`stuck` 是 `true`、`false`，或者 `null`（不在检测范围内）。
- 新工具 `session_activity({ session })`：返回 `list_sessions` 里的内容，加上最后的输出（上限 4KB）。feature 总控只能查自己 feature 下的 session，ticket 总控只能查自己 ticket 下的。

## 开工前要验证

2026-10-31 在 macOS、Claude Code 2.1.316 上已确认：

- 前台命令运行中也写 `tasks/<id>.output`，但 transcript 里没有这个 id，只能取 `tool_use` 开始后修改过的最新普通文件（子 agent 的是符号链接，要跳过）。
- 后台命令的 `tool_result` 带 `toolUseResult.backgroundTaskId`，文字里有输出文件路径；完成时 transcript 里有一条 `queue-operation`，内容是 `<task-notification>`，带 `task-id`、`tool-use-id`、`status`。

还没验证，退路写在后面：

1. 读取 session 子进程树的 CPU：macOS 和 Linux 用 `ps`。Windows 这一版不做：只比较 transcript 和输出文件。
2. Windows 上的 `tasks` 目录位置。这一版不猜，读不到就只显示命令和时长。
3. 用户手动杀掉后台 shell 时是否也有完成记录。没有的话，这个命令一直显示为后台在跑，卡住判断这一步看子进程是否还在。

权限确认的判断不用新 hook：看终端最后一段有没有 Claude Code 的确认提示，和启动对话框 `dialogShowing` 的做法一样。这是文字匹配，版本升级可能失效；失效时会进入可疑判断，这时 Claude 能看到终端内容，所以不算致命。

## 测试

- 单测：transcript 尾部解析成活动（各种工具、未完成的调用、半行 JSON）；这一轮结束但后台命令还在跑时显示命令、进入检测，后台命令结束后回到等你回话；命令分类；本地检查的计数（有变化清零、连续两次、等用户时不算）；`stuck: false` 的 10 分钟静默；忽略后不再提醒；恢复活动后红点消失；一次卡住只通知一次；输出文件不存在时不报错；修复 session 不被选成总控；`session_activity` 的权限范围。
- E2E：假 claude 写一段 transcript 和输出文件 → feature 页显示活动 → 模拟可疑和 `stuck: true` → 红点出现 → 展开、缩回、再打开内容还在 → 终端区仍然至少 50vh → 点“开新 session 解决” → 新 session 收到任务。
- e2e 窗口在后台打开，不能抢焦点（`BUTLER_BACKGROUND_WINDOWS`）。

## 发布

走 feature branch 和 PR，不用 review，直接合并。版本 1.4.0，用户同意这次打包好后直接发布。
