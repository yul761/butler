# 配置 Butler

[English](configuration.md) | **简体中文**

Butler 没有配置文件。所有设置都在 **设置** 页里改，存在 `~/.butler/app.db`。本文列出每一项设置的作用和可填的值，也说明怎么让 Butler 适配别的公司的 tracker 和习惯。

界面有中文和英文两种（见下面的 `language`）。本文引用的是中文界面的标签；[英文版](configuration.md)引用的是英文界面的标签。`代码` 格式的名字是内部的设置键，看日志或数据库时用得上。

设置页从上到下分为这几节：

1. **环境检查**
2. **常规**
3. **记忆（StateCore）**
4. **调度与 handoff**
5. **隐私与个人 API**

合并总控，以及给总控 session 用的 `end_session` 工具，见[合并总控](#合并总控)和 [README](../README.zh-CN.md)，两者都没有设置项。

审计记录在侧边栏单独的 **审计** 页里。

## 环境检查

这一节显示：

- Butler 找到的 `claude`、它的版本，以及它的 `--help` 里缺了哪些必需的参数
- hook 的状态和 `/handoff` 命令的状态
- Butler 的数据文件夹，以及 Butler 会去改的 Claude Code `settings.json`

这一节有三个按钮：

- **重新检测**
- **安装 / 修复。** 把 `butler-hook` 复制到 `~/.butler/bin`，把四个 hook 合并写进 `settings.json`，并写入 `commands/handoff.md`。第一次运行时会先备份一份 `settings.json.butler-backup`。如果 `settings.json` 不是合法的 JSON，Butler 不会动它。不是 Butler 写的 `handoff.md`，它也不会覆盖。
- **卸载。** 只移除 Butler 自己的 hook 条目和它自己的 `handoff.md`。

Butler 只会通过这几个按钮，以及首次启动向导里的同一步，去写你的 Claude Code 配置。

## 常规

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| claude 路径 | `claudePath` | 空 | 留空表示 Butler 在你登录 shell 的 `PATH` 里找。否则填公司那份 `claude` 的绝对路径，也就是 `which claude`（Windows 上是 `where claude`）打印出来的路径。保存后会重新做一次环境检查。 |
| 分支名模板 | `branchTemplate` | `feature/{key}` | Butler 为 ticket 建分支、而你没填分支名时使用。`{key}` 换成 ticket 号，`{key_lower}` 换成小写的 ticket 号，`{title}` 换成 ticket 标题转成的小写字母、数字和 `-`（最多 50 个字符）。标题里没有这类字符时，`{title}` 连同它旁边的 `-` 或 `/` 一起省掉。模板必须包含 `{key}` 或 `{key_lower}`，最长 100 个字符，只能用字母、数字和 `. _ / -`。不能以 `-` 或 `/` 开头，不能包含 `..`、`//` 或 `/.`，不能以 `/`、`.` 或 `.lock` 结尾。例如：`users/alice/{key}`、`{key}`、`{key_lower}-{title}`（得到 `dms-1234-add-payment-api`）。 |
| ticket 号正则 | `ticketPattern` | `[A-Z][A-Z0-9]+-\d+` | 匹配 ticket 号的 JavaScript 正则表达式。见下面的 [ticket 号正则](#ticket-号正则)。 |
| 语言 / Language | `language` | `auto` | `auto`、`zh` 或 `en`。`auto` 跟随系统的首选语言：任何 `zh` 开头的区域设置用中文，其他都用英文。界面、Butler 的提示和发给 `claude` 的默认提示词（handoff、刷新、记忆笔记）都会切换；你自己改过的提示词保持原样。以前生成的内容不会翻译。从 1.2.0 或更早版本升级上来的安装从 `zh` 开始。切换之后，**环境检查** 里的 `/handoff` 命令会显示需要更新；点 **安装 / 修复**，session 里的 `/handoff` 也会换成新语言。环境变量 `BUTLER_LANG=zh` 或 `BUTLER_LANG=en` 会覆盖这项设置。 |
| 开机时自动启动 Butler | — | 关 | 只在安装好的 Butler 里可用，开发模式下不可用。 |
| 重新运行首次启动向导 | `onboardingDone` | 新安装为 `0` | 这是一个按钮，不是输入框。你完成或跳过向导时它被设为 `1`，点这个按钮会把它改回 `0`。已经有 ticket 的旧安装在迁移时被设为 `1`。 |

### ticket 号正则

Butler 在两个地方用到这个正则：

- 新建 ticket 时检查 ticket 号
- 给还没归属的 session 推荐 ticket

ticket 号在检查前会先转成大写，所以正则按大写来写。Butler 在文字里找 ticket 号时不区分大小写，而且 ticket 号前面不能紧挨着字母或数字，后面不能紧跟数字。

默认的正则能匹配 Jira 和 Linear 风格的号，例如 `PROJ-123` 或 `ENG-42`。

GitHub 的 issue 号（例如 `#123`）**不能**当 ticket 号用。分支名里不允许出现 `#`，所以像 `#\d+` 这样的正则无论配哪个分支名模板都会被拒绝。请改用带前缀的号，例如 `GH-123`，默认正则已经能匹配。

保存前，Butler 会拒绝这样的正则：

- 为空，或超过 100 个字符
- 编译不通过
- 用了反向引用（`\1`、`\k<name>`）
- 能匹配空字符串
- **回溯严重。** Butler 会在隔离的 `vm` 环境里，用一组约 5,000 个字符的刁钻输入跑这个正则，每个输入有约 250 ms 的硬超时。只要有一次超时，就拒绝。常见的原因是嵌套或重复的量词，例如 `(a+)+`。

Butler 还会把正则和分支名模板放在一起检查。如果正则接受的某个样例号（例如 `-1`、`#1` 或 `..-1`）会生成不合法的分支名，改其中任何一个都会被拒绝。

## 记忆（StateCore）

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 把 handoff 的进度、决策、follow-up 和经验写进 StateCore，并在 Butler 打开的 session 里挂上记忆 | `memoryEnabled` | `1`（开） | `1` 或 `0`。关掉后，Butler 不往 StateCore 写任何东西，启动 session 时也不挂记忆 MCP server。已有的记忆会保留。重新打开后，Butler 会把漏掉的 ticket 补上。 |
| 上下文超过多少 token 时自动换新（0 = 关） | `refreshThresholdTokens` | `150000` | `0` 表示关掉自动换新，否则填一个 token 整数（最多 7 位）。当 Butler 的某个 session 已经停下、没在等你，而且上一轮的上下文至少有这么长时，Butler 会输入 `/handoff`，等 handoff 存好后输入 `/clear`，再让它回忆做到哪了并等你的指令。需要打开记忆。运行中的 session 旁边的 ↻ 按钮，以及总控的 `refresh_session`，可以随时手动换新，不受这项设置影响。 |
| session 闲置多少分钟后自动关闭（0 = 关） | `idleCloseMinutes` | `180` | `0` 表示关掉自动关闭，否则填一个不小于 10 的分钟整数（最多 5 位）。当 Butler 的某个 session 开着终端、停下超过这个时间（电脑睡着的时间不算），没有要你决定的事、没有后台任务、没在等合并或 CI、不在换新中，如果是总控、它管的子 session 也都没在干活时，Butler 会先让它写 handoff（`/handoff`，epic session 用 handoff 工具），等记忆写完，再像 `end_session` 一样结束终端，以后可以恢复。记忆关着时 ticket 和 feature session 照样写 `/handoff`（Butler 自己存着，每日简报要用）。你隐藏的 session 超过 14 天会从 Butler 里删掉，transcript 留在磁盘上。session 栏的 **清理闲置** 会立刻对那里停下至少 5 分钟的 session 做同样的事，不受这项设置影响。 |

这一节还显示：

- StateCore 的数据文件夹（`~/.butler/statecore`）
- 有没有找到记忆 MCP 的程序包
- 如果装了 StateCore 自己的 Claude Code 采集插件，会显示警告。不要把这个插件和 Butler 一起用，否则记忆会被记两遍。
- **重新运行首次启动向导** 按钮

### 记忆是怎么工作的

- **scope。** 每个 ticket 有自己的 StateCore scope（`ticket:<KEY>`）。跨 ticket 共用的经验写进 `workspace` scope。
- **挂载。** 每次你为某个 ticket 打开 session，Butler 都会重写 `~/.butler/mcp/tickets/<ticket>.json`，并用指向它的 `--mcp-config` 启动 `claude`。这个文件挂上两个 server：`butler-memory`（ticket 的 scope）和 `butler-workspace`。两者都用 Butler 自带的 Electron 以 Node 模式运行，环境里没有任何模型 key。Claude Code 自己的 MCP 配置里什么都不注册。
- **Butler 写什么。** 每次完整的 handoff 之后（早间刷新和不完整的 handoff 不算），Butler 会写入：
  - 一个新的 handoff 版本：状态、做完了什么、下一步和待定的问题
  - 这个 ticket 未完成的 follow-up 和最新的决定，作为笔记。Butler 每个 ticket 最多保留 24 条自己的笔记，给 Claude 自己的 `remember` 留出位置。
  - handoff 里的经验，写进 `workspace` scope

  Butler 在启动时和你为某个 ticket 打开 session 时也会同步这个 ticket。你完成、忽略或重新打开它的某条 follow-up 时，也会再同步一次。
- **30 条笔记的上限。** StateCore 每个 scope 最多保留 30 条有效笔记。从 statecore-mcp 1.1 起，被遗忘的笔记（做完的 follow-up、被替换的决定）会让出位置，蒸馏出来的笔记也不会把 Butler 或 Claude 的 `remember` 写的笔记挤出去。每次写入前，Butler 会数还剩几个空位。一个都不剩时，它跳过这次写入，而不是让 StateCore 淘汰最旧的一条，所以 Butler 从不淘汰自己的笔记。空位不够时，先写未完成的 follow-up，再写决定。跳过的条目仍然在 Butler 自己的数据库里和 ticket 页上，一有空位就会写进去。在 `workspace` scope 里，笔记满 30 条后，StateCore 会淘汰最旧的经验。
- **ticket 页上的 记忆 tab** 显示最新的 handoff、决定、未完成的 follow-up 和其他笔记。点某条上的 **来历** 可以看它的版本链。这个 tab 在 Butler 每次同步后刷新，Claude 在 session 里写记忆时不会实时更新。
- **蒸馏。** 只在隐私档位为 **完整**、并且关掉了 **发送前确认** 时才会发生。它在每次晚间 handoff 之后在后台运行，包括补跑和 **立即运行晚间 handoff**。对每个有待处理事件的 scope，StateCore 会调用一次或多次你的个人 API，把事件整理成笔记。这些调用合起来会发送：
  - scope 的名字，ticket 的 scope 名里就是真实的 ticket 号（`ticket:<KEY>`）
  - 这个 scope 最近的原始事件，包括 Claude 用 `remember(consolidate: true)` 存下的内容
  - 这个 scope 已有记忆的 JSON：Butler 的 follow-up 和决定笔记、Claude 自己的笔记，以及上一次的摘要和其中的下一步
  - 这个 scope 里已遗忘笔记的原文，免得模型又把它们写回来

  在 `workspace` scope 里，每条经验都标着它来自哪个 ticket 的 ticket 号。

  **这些内容既不做假名替换，也不扫描。** 每次调用都会先对照月预算检查，超了就拒绝。每一次发出的调用和超预算被拒的调用都会记进审计，在审计页上显示为 **StateCore 记忆蒸馏**。因为其他原因被拒的调用（例如档位变了、没有可用的 key）只写进日志。

  没能处理完所有事件的一次运行会被记为部分完成，它的 ticket 会重新同步；什么都没蒸馏出来的一次运行会把事件留到第二天晚上。这些调用由 Butler 的主进程在隐私网关里发出，StateCore 的进程永远拿不到 API key。

## 调度与 handoff

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 晚间 handoff 时间 | `nightlyTime` | `16:00` | `HH:MM`，本地时间。如果到点时 Butler 没开、电脑在睡眠或锁屏，会在下次启动、唤醒或解锁时补跑，排在早间刷新之前。 |
| 每天几点让 Butler 总控巡检一次 | `butlerPatrolTime` | 空（关） | `HH:MM`，本地时间；空 = 关。到点时 Butler 打开（或接着用最近的）Butler 总控，让它看一遍 PR、CI 和待你决定的事，用 `ask_user` 列出要你亲自做的事。Butler 总控正忙就等它停下来；到点时电脑在睡眠或 Butler 没开，当天醒来、解锁或启动时补一次，过了零点不补。 |
| 工作日（只在这些天跑晚间 handoff） | `workingDays` | `1,2,3,4,5`（周一到周五） | 界面上是复选框。存的值是用逗号分隔的 `0`–`6`，`0` 是周日。晚间 handoff 和早间刷新只在这些天运行。 |
| tracker MCP 工具（handoff 只能调用这些，一行一个） | `trackerTools` | 空 | 一行一个 MCP 工具名，格式是 `mcp__<server>__<tool>`。只写 `mcp__<server>` 会放开这个 server 的所有工具，除非 server 是只读的，否则别这么写。其他内容，例如 `Bash(...)` 规则或命令行参数，都会被拒绝。handoff 和刷新可以调用这些工具，加上 `Read`、`Grep`、`Glob`、`gh pr view`、`gh pr checks`、`git log` 和 `git status`，再加上你用户级或托管（policy）的 Claude Code 设置允许的工具（见下文）。 |
| 后台 handoff 也加载本地级的 MCP… | `headlessProjectMcp` | `0`（关） | `1` 或 `0`。见[接入你的 tracker](#接入你的-tracker)。 |
| handoff prompt 模板 | `handoffPrompt` | 内置 | 做 handoff 时发给 `claude` 的指令。不能为空，最长 20,000 个字符。见[改写提示词](#改写提示词)。 |
| 早间刷新 prompt 模板 | `refreshPrompt` | 内置 | 早上快速查一遍 PR 和 tracker 状态，不总结对话。限制同上。 |

这一节还有 **立即运行晚间 handoff** 按钮。

晚间运行做完 ticket 之后，还会为每个自上次汇总以来总控 session 或 ticket 有新动静的 feature 写一份汇总。有总控 session 时，它会 fork 这个 session，并使用和 handoff 相同的只读参数。如果 ticket 那一轮被限流了，当晚不写 feature 汇总，留给早上的补跑。feature 页上还有 **立即更新**，它先为这个 feature 里有动静的 ticket 跑 handoff，再写汇总。在总控 session 里运行 `/handoff`，会直接根据对话本身写汇总。

handoff 和刷新用这些参数启动 `claude`：

- `--permission-mode dontAsk`：没被允许的工具一律拒绝，所以永远不会弹确认。
- `--disallowedTools Edit Write NotebookEdit`：这几个工具总是被禁止。
- `--setting-sources user`：你用户级的 Claude Code 设置生效，托管（policy）设置也生效，Claude Code 总会加载它们。仓库自己设置里的 allow 规则和 hook 不生效。

允许的工具是上面那张清单，加上你用户级 `settings.json` 和任何托管设置里的 allow 规则。这些运行并不是严格只读的。如果这些设置允许了比如 `Bash(npm:*)` 或者能写入的 MCP 工具，无人值守的运行也能用。只有 `Edit`、`Write` 和 `NotebookEdit` 总是被禁止。

### 接入你的 tracker

Butler 自己从不和你的 tracker 通信。handoff 通过公司 Claude Code 里配置的 MCP server 去读 tracker。只选**只读**的工具：

1. 照平常的方式在 Claude Code 里配置 tracker 的 MCP server。用户级（user scope）最简单。
2. 在设置里点 **从 Claude Code 检测**。Butler 会列出你的 Claude Code 能用的所有 MCP 工具。名字看起来是读操作的工具（get、list、search、read、view、fetch、query、find……）会预先勾上。把会写入的都取消勾选，然后点 **加入选中的工具并保存**。
3. 工具名的格式是 `mcp__<server>__<tool>`，`<server>` 是你在 Claude Code 里给 server 起的名字。名为 `atlassian` 的 Atlassian（Jira）server，工具名可能是 `mcp__atlassian__getJiraIssue`。其他 tracker（Linear、GitLab……）用检测结果里显示的名字。
4. 如果 tracker 的 MCP server 配在本地级（local scope）或仓库的 `.mcp.json` 里，打开 `headlessProjectMcp`。无人值守的运行只读你的用户级设置，默认看不到这些 server。打开后，Butler 会读仓库的 `.mcp.json` 和 `.claude/settings.local.json`，以及你的 `~/.claude.json` 和 `settings.json`，找出你批准过的 server。然后它把你本地级的 server，以及你已经在 Claude Code 里批准过的仓库 server，复制到 `~/.butler/mcp/` 下的私有文件里。这些文件里可能有 token。被禁用或没批准的 server 永远不会加载。

### 改写提示词

默认的提示词是按 Jira 一类的 tracker 和 GitHub PR（`gh pr view`、`gh pr checks`）写的。如果你用 GitLab 或别的 tracker，就改写 `handoffPrompt` 和 `refreshPrompt` 里的指令，保留只读的规则。

占位符写成 `{{name}}`。不认识的占位符原样保留。

| 占位符 | 替换为 |
|--------|--------|
| `{{ticket}}` | ticket 号 |
| `{{title}}` | ticket 标题 |
| `{{branch}}` | 分支名 |
| `{{tracker_tools}}` | `trackerTools` 里的工具 |
| `{{previous_handoff}}` | 上一次 handoff 的 JSON |
| `{{open_followups}}` | 未完成的 follow-up 的 JSON |
| `{{current_status}}` | ticket 当前的状态（刷新提示词里用得上） |
| `{{schema}}` | 字段说明 |
| `{{example}}` | 一个完整的示例 |

保留 `{{schema}}` 和关于输出的指令。Butler 还会把 JSON schema 传给 `claude --json-schema` 并校验结果。输出没通过校验时，Butler 会带上错误重试一次；还不通过，就存成一份不完整的 handoff，标为 **不完整**。不管你用哪种 tracker，schema 里 tracker 状态的字段都叫 `jira`。

## 合并总控

几个 ticket 改同一个仓库时，合并总控让它们的合并不互相撞车。它是 Butler 的一部分，没有设置项。它不问模型，两个分支冲不冲突由 git 自己判断。

**它审查什么。** 只审查两类命令，而且只限 Butler 打开的 session（epic session、feature 总控或任何 ticket session，不管属于哪个 epic 或 feature）：

- 合并进目标分支：`gh pr merge`（包括 `--auto`，目标是 PR 的 base 分支）、在目标分支上 `git merge`，以及 `git push` 到目标分支。带显式 `src:dst` refspec 的 push，检查的是 `src` 分支（`HEAD` 指当前分支）。不带 refspec 的 `git push origin main` 推的是本地 `main`，不管你在哪个分支上，所以算作推目标分支本身，不审查。推你自己的分支也不审查。`cd` 和 `git -C` 里的目录可以写成 Windows 路径（`"C:\Users\me\repo"`）、Git Bash 路径（`/c/Users/me/repo`）或带 `~`。
- 在共用文件夹里切分支（`git checkout`、`git switch`）。共用文件夹指"分支"工作模式下、另一个有打开 session 的 ticket 也在用的仓库文件夹。在你自己的 worktree 里切分支不审查。

写代码、commit、跑测试、推自己的分支都不会经过总控。它认不出的命令一律放行。

**只在 Butler 打开的 session 里。** 审查是 Butler 为每个 session 写的 `--settings` 文件里给 Bash 工具挂的 `PreToolUse` hook，再加上 `PostToolUse` 和 `PostToolUseFailure` 两个 hook，用来告诉 Butler 命令结束了。你全局的 `settings.json` 不会被改，所以你自己启动的 `claude` 不受影响。这些 hook 运行的是 **安装 / 修复** 复制到 `~/.butler/bin` 的 `butler-hook` 程序。这份副本和 app 里的不一样时（升级之后），Butler 会在启动时替换它；替换不了的话，合并就不做检查，日志里会写明原因。

**它怎么判断。**

- 先到先得。一次合并和另一个还在写的 ticket 分支冲突时，允许合并，Butler 记下另一个 ticket 之后要 rebase。
- 如果分支已经合不进最新的目标分支，会让 session 先 rebase，并告诉它和哪个 ticket 的改动冲突、冲突在哪些文件里，还会提醒它保留双方的意图。
- 如果它和一个已经被允许合并、但还没合完的分支冲突，会让它等。自己的合并已经被允许过的 session 可以直接再试，不用等。合并锁跟着真实的合并走：
  - 本地的 `git merge` 或 push 会一直锁到命令结束，不管成功还是失败。如果 Butler 一直没收到命令结束的消息，例如你拒绝了权限确认，锁会在 10 分钟后过期。
  - `gh pr merge` 会一直锁到 Butler 看到 PR 已合并（用 `gh pr view` 检查，只查被锁的 PR）或已关闭。如果允许合并 30 秒后 PR 还开着，而且没开 auto-merge，Butler 就认为合并失败了或 `--auto` 被取消了，并释放锁。`gh` 查不了的话，锁在 2 小时后过期。如果一个分支还持有本地合并的锁（比如 push 被拒之后），再对它 `gh pr merge`，这把锁会转成 PR 锁。
- 被锁住的合并完成后，等待中的 session 会收到可以合并了（rebase 之后）的消息。如果它没完成（合并失败、PR 被关、锁过期），会告诉那个 session 可以再试一次。消息会在 session 等待输入、而且你 30 秒内没在它的终端里打字时输入进去。如果 session 的终端关着，消息最多保留 24 小时，等你再打开这个 session 时送达。
- 文件夹在用的时候，在共用文件夹里切分支会被拒绝，并写明是哪个 ticket、哪个分支。你自己在界面上点切换分支时，Butler 只提醒，你仍然可以确认。

**出错时放行。** 如果 Butler 没在运行、5 秒内没响应，或者 hook 本身出错，命令照常执行。总控只是一道保险，永远不会成为 session 合并不了的原因。

**你会看到什么。** 它发现的每一次冲突（一次拒绝，或者一次允许外加之后的 rebase）都会在 **现在** 页的 **最近合并** 里加一条记录（哪个仓库、哪些 ticket、它定下的顺序）。不发系统通知。没有冲突的合并不加记录，Butler 只是锁到它合完为止。这些记录、锁和待做的 rebase 重启后都还在。

**要求。** git 2.38 或更新（为了 `git merge-tree --write-tree`）。`gh` 是可选的，只用于 PR 合并。

**它不做什么。** 它只判断 git 能看出来的冲突。合并后的代码能不能编译、行为对不对，例如一边改了字段名而另一边还在用旧名字，交给 CI。它不替你 rebase 或解决冲突，也不管你在自己终端里跑的 git。

## 隐私与个人 API

个人 API 是可选的。它只在 **完整** 档位下用于蒸馏 StateCore 记忆。其他功能都不需要它。

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 隐私档位 | `llmLevel` | `metadata` | **`off` 关闭**、**`metadata` 仅元数据** 和 **`redacted` 脱敏文本**：不调用个人 API。**`full` 完整**：启用 StateCore 蒸馏，记忆内容不经扫描直接发送（见[记忆是怎么工作的](#记忆是怎么工作的)）。 |
| 服务地址（OpenAI 兼容接口的 base URL） | `llmBaseUrl` | 空 | 例如 `https://api.openai.com/v1`、`https://api.deepseek.com/v1`、`https://openrouter.ai/api/v1`，Ollama 用 `http://localhost:11434/v1`。必须是 `https://`，`localhost`、`127.0.0.1` 和 `[::1]` 除外。不能包含用户名、密码、`?query` 或 `#fragment`。结尾的 `/chat/completions` 会被去掉。留空表示没配置，效果和 `off` 一样。 |
| 模型 | `llmModel` | 空 | 不能有空格，最长 200 个字符，例如 `deepseek-chat`。 |
| API key | — | — | 用系统钥匙串（macOS 钥匙串 / Windows DPAPI）加密后存在 `app.db` 里。保存后最多只显示末 4 位，短于 12 个字符的 key 只显示 `••••`。系统加密不可用时，Butler 拒绝保存 key。本机服务不需要。 |
| 每月预算（美元） | `llmMonthlyBudgetUsd` | `1` | 最多两位小数。每次调用前，Butler 会估算费用（输入加上最大输出）。如果本月已花的钱加上估算会超过预算，这次调用会被拒绝并记进日志。预算为 `0` 时，只有价格为零的模型能被调用。 |
| 价格表（美元 / 百万 token） | `llmPrices` | `* 15 75` | 一行一条规则：`模型名模式 输入价 输出价`。`*` 是通配符，匹配不区分大小写。第一条匹配的规则生效。空行和以 `#` 开头的行会被忽略。默认值故意设得很贵，请填上你服务商的真实价格，例如 `deepseek-chat 0.27 1.1`，本机模型写 `* 0 0`。没有匹配规则的模型永远不会被调用。 |
| 发送前确认 | `llmConfirm` | `0`（关） | `1` 或 `0`。开着的时候，StateCore 蒸馏不运行。 |
| 审计保留天数 | `auditRetentionDays` | `90` | 1 到 3650。当月的记录总是保留，因为预算检查要用。 |

已保存但解密不了的 key（例如钥匙串被重置之后）只写进日志，不记审计。

个人 API 通过 Electron 的网络栈调用，所以会跟随你的系统代理设置（包括 PAC 脚本）。

## 多家公司或多个配置

用不同的 `BUTLER_HOME` 启动 Butler。如果每家公司有自己的 Claude Code 登录，再设一个不同的 `CLAUDE_CONFIG_DIR`。每个 `BUTLER_HOME` 都是一个独立的 Butler，有自己的数据库、记忆、hook 程序、日志和设置，以及自己的 Electron 配置文件夹（`$BUTLER_HOME/electron`）。Butler 会把这两个变量传给它启动的 `claude` session，让它们的 hook 报告到正确的收件箱。

共用同一个 Claude Code 配置文件夹的两个 Butler 配置会互相覆盖对方的 hook。给每个配置一个单独的 `CLAUDE_CONFIG_DIR`。
