# 配置 Shipherd

[English](configuration.md) | **简体中文**

Shipherd 没有配置文件。所有设置都在 **设置** 页里改，存在 `~/.shipherd/app.db`。本文列出每一项设置的作用和可填的值，也说明怎么让 Shipherd 适配别的公司的 tracker 和习惯。

界面有中文和英文两种（见下面的 `language`）。本文引用的是中文界面的标签；[英文版](configuration.md)引用的是英文界面的标签。`代码` 格式的名字是内部的设置键，看日志或数据库时用得上。

设置页从上到下分为这几节：

1. **环境检查**
2. **常规**
3. **记忆（StateCore）**
4. **定时与状态**
5. **复盘规矩**（自动备份、导出提醒和准入策略，见[复盘规矩：批量操作、准入策略和导入导出](#复盘规矩批量操作准入策略和导入导出)）

**自动化** 标签见[自动化档位](#自动化档位)。设置页顶上还有四个标签：**模型路由**（见[模型路由](#模型路由)）、**评论与 CI**（见[评论与 CI](#评论与-ci)）、**打断与通知**（见[打断与通知](#打断与通知)）和 **栈**（见[栈](#栈)）。

合并总控，以及给 epic 总控用的 `end_session` 工具，见[合并总控](#合并总控)和 [Shipherd 是怎么工作的](how-it-works.zh-CN.md#合并总控)，两者都没有设置项。

审计记录在侧边栏单独的 **审计** 页里。**效果** 页也没有设置项，见[效果页](#效果页)。

## 自动化档位

设置页顶上的 **自动化** 标签决定 Shipherd 自己做多少事。

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 自动化档位 | `automationLevel` | `manual` | `manual` 或 `semi`。**全自动（以后）** 会显示，但还不能选。选一档会把它管的开关（见下面）写成这一档的预设，别的都不动。再选一次同一档，会把这些开关恢复成预设。 |

- **手动。** 受管的开关全关：评论、CI、栈、接活都等你处理。
- **半自动。** PR 评论转给 session，不回复、不标 resolved（`comments.enabled` 开，`comments.reply` 和 `comments.resolve` 关）。看起来不稳定的 CI 失败重跑一次（`ci.enabled` 开，`ci.maxReruns` 为 1，`externalCiRerun` 开）。栈自动 rebase，Shipherd 推送、强推并开 PR（`autoRebase` 开，`externalBranchPush`、`externalForcePush`、`externalPrOpen` 开）。开 PR 前预审（`preReviewEnabled` 开）。选了来源的自动接活直接开工（`enabled` 和 `autoStart` 开；`intakeSource` 还是 `none` 时，这个标签会提示一句，这一项先不动）。
- **合并永远要你自己点**，哪一档都一样；对外动作照样记进[审计](#对外动作)。

一个个开关收在默认折叠的 **高级：一个个开关** 里，和 **高级** 标签里对应的设置是同一个。只要有受管的开关和存的档位对不上（全局层，或者[评论与 CI](#评论与-ci)、[栈](#栈)、[自动接活](#自动接活)的产品层、仓库层），档位就显示 **自定义**，并写着有几个开关不一样。点档位只改全局那一层，所以这个标签会列出自己的设置不一样的产品和仓库；它们照旧在 **高级** 标签里改。

**epic 档位。** epic 页标题旁边有 **epic 档位** 下拉框：**跟随全局**（默认）、**手动** 或 **半自动**。epic 自己选的档位只管它的 ticket，对这些 ticket 盖过受管开关在全局、产品、仓库三层的设置。它存在 epic 上，不是一项设置。一个栈里每个 ticket 所在的 epic 都自己选了同一档时，这个栈才按那一档；档位混着的栈按原来的开关。自动接活从 Jira 接进来的 ticket，父 epic 在 Shipherd 里已经有了时，开不开工也按这个 epic 的档位；这个仓库接不接活仍然按接活的设置。**半自动** 就开工（也按半自动预审），哪怕仓库的接活不自动开工，并告诉 epic 总控；**手动** 只建进 epic、不开工，要澄清的只提醒你、不开 session，已经排着的在 epic 改成手动以后回到搁着。改了 epic 档位，搁着的马上按新档位重新决定。接活来源和拉取时间仍然只看全局。

## 环境检查

这一节显示：

- Shipherd 找到的 `claude`、它的版本，以及它的 `--help` 里缺了哪些必需的参数
- hook 的状态和 `/handoff` 命令的状态
- Shipherd 的数据文件夹，以及 Shipherd 会去改的 Claude Code `settings.json`

这一节有三个按钮：

- **重新检测**
- **安装 / 修复。** 把 `shipherd-hook` 复制到 `~/.shipherd/bin`，把四个 hook 合并写进 `settings.json`，并写入 `commands/handoff.md`。第一次运行时会先备份一份 `settings.json.shipherd-backup`。如果 `settings.json` 不是合法的 JSON，Shipherd 不会动它。不是 Shipherd 写的 `handoff.md`，它也不会覆盖。
- **卸载。** 只移除 Shipherd 自己的 hook 条目和它自己的 `handoff.md`。

Shipherd 只会通过这几个按钮，以及首次启动向导里的同一步，去写你的 Claude Code 配置。

### 导出诊断

这一节最下面的 **导出诊断** 会存一个 JSON 文件，反馈「Shipherd 卡」的时候可以附上。里面有：

- Shipherd、Electron 和系统的版本，CPU 和内存，以及 Shipherd 每个进程的 CPU 和内存
- 最近一小时、每分钟一个的性能窗口：主进程的事件循环延迟（p50 / p99）、每类事件发给窗口的次数、IPC 调用、超过 50 ms 的重活、窗口里的长任务，以及终端是用 WebGL 画的还是退回了 DOM
- `main.log` 的最后 1000 行

里面不会有 transcript 的内容、提示词或记忆。这些计数一直开着，几乎没有开销；一分钟里没什么值得记的，就不往日志里写。环境变量 `SHIPHERD_PERF_DIAG=off` 关掉它们，`SHIPHERD_PERF_DIAG=verbose` 每分钟都写一行。

### 发送反馈

菜单栏的 **帮助 → 发送反馈…**，和 **设置 › 关于** 里的同一个按钮，会打开一个小表单：选反馈的类型（bug、想法、首次使用时遇到的问题），标题可以不填，再写几句描述。点 **在 GitHub 上打开** 会在浏览器里打开 github.com/yul761/shipherd 的新 issue 页，套好对应的模板，填好你写的内容，以及 Shipherd 版本、系统和版本、架构、Claude Code 版本（拿不到就写 `unknown`）。Shipherd 自己不往外发任何东西：issue 由你看过以后自己点 **Submit**。内容太长、链接放不下时，描述会被截断，全文复制到剪贴板，粘贴进去就行。

首次使用向导里，某一步过不去时（找不到能用的 `claude`、hook 装不上、或者检测本身出错），会出现 **卡住了？告诉我们**，打开的是同一个表单，类型已经选好「首次使用时遇到的问题」，并填上是哪一步。

**附上诊断** 默认不勾。勾上以后，Shipherd 生成一份和 **导出诊断** 一样的文件，但把用户目录、所有绝对路径、仓库名、ticket 号和标题、epic 名、分支名、网址、邮箱和公司内部的主机名都换成 `<path>`、`<repo>` 这样的占位符，日志里引号括起来的内容和非英文的文字换成 `<text>`。你先看到完整内容；点 **存到下载目录，打开 GitHub** 以后才存进下载目录，文件名是 `shipherd-diagnostics-redacted-<时间>.json`，并在 Finder 或资源管理器里选中。把它拖进 issue 的 **Diagnostics** 框。提问和开放的讨论请去 [Discussions](https://github.com/yul761/shipherd/discussions)。

## 常规

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| claude 路径 | `claudePath` | 空 | 留空表示 Shipherd 在你登录 shell 的 `PATH` 里找。否则填公司那份 `claude` 的绝对路径，也就是 `which claude`（Windows 上是 `where claude`）打印出来的路径。保存后会重新做一次环境检查。 |
| 分支名模板 | `branchTemplate` | `feature/{key}` | Shipherd 为 ticket 建分支、而你没填分支名时使用。`{key}` 换成 ticket 号，`{key_lower}` 换成小写的 ticket 号，`{title}` 换成 ticket 标题转成的小写字母、数字和 `-`（最多 50 个字符）。标题里没有这类字符时，`{title}` 连同它旁边的 `-` 或 `/` 一起省掉。模板必须包含 `{key}` 或 `{key_lower}`，最长 100 个字符，只能用字母、数字和 `. _ / -`。不能以 `-` 或 `/` 开头，不能包含 `..`、`//` 或 `/.`，不能以 `/`、`.` 或 `.lock` 结尾。例如：`users/alice/{key}`、`{key}`、`{key_lower}-{title}`（得到 `dms-1234-add-payment-api`）。新分支从远端的默认分支开：Shipherd 先从 `origin` fetch 默认分支（`origin/HEAD` 指的那个，没有就是 `main` / `master`），再从 `origin/<默认分支>` 开，不管你自己的 checkout 停在哪个分支，也不动它。fetch 失败或离线时用上一次 fetch 到的 `origin/<默认分支>`，并在 `main.log` 里写明。没有 `origin` 的仓库用本地的 `main`（或 `master`）。新分支不设上游。用 `stack_on` 建的 ticket 从下层 ticket 的分支开。 |
| ticket 号正则 | `ticketPattern` | `[A-Z][A-Z0-9]+-\d+` | 匹配 ticket 号的 JavaScript 正则表达式。见下面的 [ticket 号正则](#ticket-号正则)。 |
| 语言 / Language | `language` | `auto` | `auto`、`zh` 或 `en`。`auto` 跟随系统的首选语言：任何 `zh` 开头的区域设置用中文，其他都用英文。界面、Shipherd 的提示和发给 `claude` 的默认提示词（handoff、刷新、记忆笔记）都会切换；你自己改过的提示词保持原样。以前生成的内容不会翻译。从 1.2.0 或更早版本升级上来的安装从 `zh` 开始。切换之后，**环境检查** 里的 `/handoff` 命令会显示需要更新；点 **安装 / 修复**，session 里的 `/handoff` 也会换成新语言。环境变量 `SHIPHERD_LANG=zh` 或 `SHIPHERD_LANG=en` 会覆盖这项设置。 |
| 请你 review / Review requests | `reviewRequestScope` | `all` | 首页显示哪些请你 review 的 PR。`all`：`gh` 账号能看到的所有仓库。`registered`：只看 Shipherd 登记过的仓库（ticket 的仓库，或者出现过 ticket PR 的仓库）。Shipherd 每 5 分钟跑一次 `gh search prs --review-requested=@me --state=open`（电脑空闲或锁屏时每 15 分钟一次；窗口切到前台、打开首页时，离上次超过 1 分钟就补查一次）。搜索只查 `gh` 的默认主机，企业版 GitHub 上请你 review 的 PR 查不到。 |
| 开机时自动启动 Shipherd | — | 关 | 只在安装好的 Shipherd 里可用，开发模式下不可用。 |
| 检查更新 | `updateCheckEnabled` | `1`（开） | `1` 或 `0`。Shipherd 每天经你自己的 `gh` 查一次 GitHub 上 Shipherd 的最新 release（相当于 `gh api repos/<Shipherd 的仓库>/releases/latest`）；Shipherd 自己不发任何 HTTP 请求。有新版本时顶部出现提示条：「X.Y.Z 可用」、可以展开的更新说明、**下载**（在浏览器里打开 release 页）、**跳过这个版本** 和关闭按钮。只提示，从不下载、不安装。草稿和预发布版本不算新版本。启动后不久查第一次，之后最多每 24 小时一次，查失败也算一次。没装 `gh`、`gh` 没登录、离线、被限流时静默跳过，不弹任何东西。每次真的查了，都在 **审计** 页的 **对外动作** 里记一条 **检查更新**。点了 **跳过这个版本**，只有更新的版本才再提示；关闭按钮只管到 Shipherd 重启。关着时 Shipherd 不自己查，也不显示提示条。菜单栏的 **帮助 → 检查更新…** 和 **设置 → 关于** 里的按钮不管开没开都马上查，并告诉你结果：已是最新、有新版本，或者为什么没查成。这是唯一默认开着的开关：它只读，不在 GitHub 上留下任何东西。 |
| 显示 Shipherd 之外开的 session | `showOutsideSessions` | `0` | `1` 或 `0`。打开后，Shipherd 在启动时和每 5 分钟看一遍 `~/.claude/projects`，把最近 7 天你在 Shipherd 之外开的 Claude Code session 列在 **全部工作 › 未认领 session** 下，可以认领到 ticket。关着（默认）时不扫描 `~/.claude/projects` 去找它们，也没有这个入口。Shipherd 自己开的 session 不受影响。打开时马上扫一次。 |
| 重启后自动恢复之前在工作的 session | `autoResumeAfterRestart` | `0` | `1` 或 `0`。打开后，Shipherd 启动时把上次退出（或崩溃）时终端还开着（在工作或在等回复）、由总控管的 session 在后台各自接着原来的对话恢复回来：有未读信箱消息的最先，然后是 ticket 有 PR 在等的，再按最近活动。每个都和 `start_session` 一样先看内存，第一次不够就停下，剩下的保持关着。你自己点 × 结束的永远不自动恢复。不管这个开没开，总控给它开的、关着的 session 发消息时，Shipherd 都会在后台恢复它（你结束的除外）再把消息送进去，并告诉总控是已恢复、在等内存还是被你结束了。 |
| 重新运行首次启动向导 | `onboardingDone` | 新安装为 `0` | 这是一个按钮，不是输入框。你完成或跳过向导时它被设为 `1`，点这个按钮会把它改回 `0`。已经有 ticket 的旧安装在迁移时被设为 `1`。 |

### ticket 号正则

Shipherd 在两个地方用到这个正则：

- 新建 ticket 时检查 ticket 号
- 给还没归属的 session 推荐 ticket

ticket 号在检查前会先转成大写，所以正则按大写来写。Shipherd 在文字里找 ticket 号时不区分大小写，而且 ticket 号前面不能紧挨着字母或数字，后面不能紧跟数字。

默认的正则能匹配 Jira 和 Linear 风格的号，例如 `PROJ-123` 或 `ENG-42`。

GitHub 的 issue 号（例如 `#123`）**不能**当 ticket 号用。分支名里不允许出现 `#`，所以像 `#\d+` 这样的正则无论配哪个分支名模板都会被拒绝。请改用带前缀的号，例如 `GH-123`，默认正则已经能匹配。

保存前，Shipherd 会拒绝这样的正则：

- 为空，或超过 100 个字符
- 编译不通过
- 用了反向引用（`\1`、`\k<name>`）
- 能匹配空字符串
- **回溯严重。** Shipherd 会在隔离的 `vm` 环境里，用一组约 5,000 个字符的刁钻输入跑这个正则，每个输入有约 250 ms 的硬超时。只要有一次超时，就拒绝。常见的原因是嵌套或重复的量词，例如 `(a+)+`。

Shipherd 还会把正则和分支名模板放在一起检查。如果正则接受的某个样例号（例如 `-1`、`#1` 或 `..-1`）会生成不合法的分支名，改其中任何一个都会被拒绝。

## 同时开几个 session

能同时开几个 session 只看这台电脑的内存，没有写死的数。Shipherd 为 `start_session`、全局总控给关着的 epic 总控发消息，或者自动接活把新的 Jira ticket 交给关着的 epic 总控而新开终端之前，会用现在可用的内存减去一个新 session 的预估占用，剩下的不少于下面的保留量才开。最近两分钟里刚开的 session 还没长起来，每个也按预估占用先扣掉。macOS 报告内存压力为「严重」时不开新的。不放行时总控会看到现在可用多少、再开一个要多少、要留多少；`start_session` 和 `list_sessions` 的结果会多一行「现在还能再开几个」。读不到内存时照样放行（只看下面可选的上限），并记日志。

macOS 上的可用内存按 Activity Monitor 的算法从 `vm_stat` 算：总量减去 wired、压缩器占用和匿名页（扣掉可清除的部分），文件缓存算可用。这里不用 `os.freemem()`，因为它只算空闲页，几十 GB 空余的机器上也常常只有几 GB。`vm_stat` 读不到时用 `memory_pressure -Q` 的空闲百分比，再不行才用 `os.freemem()`。Windows 上 `os.freemem()` 就是可用物理内存（空闲加 standby），Linux 上是 `MemAvailable`，都直接用。

日志（Shipherd 数据目录里的 `logs/main.log`）会记下启动时的读数，旁边附上 macOS 自己的空闲百分比和 `os.freemem()` 作对照；每次放行或拒绝也会连同用到的数一起记下来。如果机器看着还有空、session 却被拒了，从这几行就能看出原因。

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 开新 session 后至少留给系统的内存（MB） | `sessionMemoryReserveMb` | 空（自动） | 留空是自动：物理内存的 10%，最少 512 MB、最多 2048 MB（8 GB 的电脑留 819 MB，16 GB 的留 1638 MB，20 GB 以上留 2048 MB）。也可以填 `0` 到 `1048576` 的 MB 整数。可用内存减去一个新 session 的预估占用后不少于这个数才开。 |
| 一个新 session 预计占多少内存（MB） | `sessionMemoryEstimateMb` | `1024` | `64` 到 `1048576` 的 MB 整数：Claude 加上它的 MCP server 和子进程。现在用这个数；以后接上每个 session 的内存实测后，有实测时用开着的 session 的实测平均。 |
| 同时开着的终端最多几个（0 = 不限） | `sessionMaxRunning` | `0`（不限） | `0` 到 `999` 的整数。默认关着，只当保险：设了以后，Shipherd 已经开着这么多终端时不再开新的，不管内存还剩多少。 |

## 记忆（StateCore）

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 把状态里的进度、决策、follow-up 和经验写进 StateCore，并在 Shipherd 打开的 session 里挂上记忆 | `memoryEnabled` | `1`（开） | `1` 或 `0`。关掉后，Shipherd 不往 StateCore 写任何东西，启动 session 时也不挂记忆 MCP server。已有的记忆会保留。重新打开后，Shipherd 会把漏掉的 ticket 补上。 |
| 上下文超过多少 token 时自动换新（0 = 关） | `refreshThresholdTokens` | `150000` | `0` 表示关掉自动换新，否则填一个 token 整数（最多 7 位）。当 Shipherd 的某个 session 已经停下、没在等你，而且上一轮的上下文至少有这么长时，Shipherd 会输入 `/handoff`，等记忆真的存好 handoff，把最近几轮对话存到 `~/.shipherd/refresh/<session>.md`（不调用模型），再输入 `/clear`，然后让 session recall 那份 handoff、读这个文件，接着做换新前在做的事（如果当时在等你、等 CI 或等子 session，就说一句在等什么并继续等）。需要打开记忆。运行中的 session 旁边的 ↻ 按钮，以及总控的 `refresh_session`，可以随时手动换新，不受这项设置影响。 |
| session 闲置多少分钟后自动关闭（0 = 关） | `idleCloseMinutes` | `180` | `0` 表示关掉自动关闭，否则填一个不小于 10 的分钟整数（最多 5 位）。当 Shipherd 的某个 session 开着终端、停下超过这个时间（电脑睡着的时间不算），没有要你决定的事、没有后台任务、没在等合并或 CI、不在换新中，如果是总控、它管的子 session 也都没在干活时，Shipherd 会先让它写 handoff（`/handoff`），等记忆写完，再像 `end_session` 一样结束终端，以后可以恢复。记忆关着时 ticket 的 session 和 epic 总控照样写 `/handoff`（Shipherd 自己存着，每日简报要用）。你隐藏的 session 超过 14 天会从 Shipherd 里删掉，transcript 留在磁盘上。session 栏的 **清理闲置** 会立刻对那里停下至少 5 分钟的 session 做同样的事，不受这项设置影响。 |

这一节还显示：

- StateCore 的数据文件夹（`~/.shipherd/statecore`）
- 有没有找到记忆 MCP 的程序包
- 如果装了 StateCore 自己的 Claude Code 采集插件，会显示警告。不要把这个插件和 Shipherd 一起用，否则记忆会被记两遍。
- **重新运行首次启动向导** 按钮

### 记忆是怎么工作的

- **scope。** 每个 ticket 有自己的 StateCore scope（`ticket:<KEY>`）。跨 ticket 共用的经验写进 `workspace` scope。
- **挂载。** 每次你为某个 ticket 打开 session，Shipherd 都会重写 `~/.shipherd/mcp/tickets/<ticket>.json`，并用指向它的 `--mcp-config` 启动 `claude`。这个文件挂上两个 server：`shipherd-memory`（ticket 的 scope）和 `shipherd-workspace`。两者都用 Shipherd 自带的 Electron 以 Node 模式运行，环境里没有任何模型 key。Claude Code 自己的 MCP 配置里什么都不注册。
- **Shipherd 写什么。** 每次完整的 handoff 之后（早间刷新和不完整的 handoff 不算），Shipherd 会写入：
  - 一个新的 handoff 版本：状态、做完了什么、下一步和待定的问题
  - 这个 ticket 未完成的 follow-up 和最新的决定，作为笔记。Shipherd 每个 ticket 最多保留 24 条自己的笔记，给 Claude 自己的 `remember` 留出位置。
  - handoff 里的经验，写进 `workspace` scope

  Shipherd 在启动时和你为某个 ticket 打开 session 时也会同步这个 ticket。你完成、忽略或重新打开它的某条 follow-up 时，也会再同步一次。
- **30 条笔记的上限。** StateCore 每个 scope 最多保留 30 条有效笔记。从 statecore-mcp 1.1 起，被遗忘的笔记（做完的 follow-up、被替换的决定）会让出位置，别的东西也不会把 Shipherd 或 Claude 的 `remember` 写的笔记挤出去。每次写入前，Shipherd 会数还剩几个空位。一个都不剩时，它跳过这次写入，而不是让 StateCore 淘汰最旧的一条，所以 Shipherd 从不淘汰自己的笔记。空位不够时，先写未完成的 follow-up，再写决定。跳过的条目仍然在 Shipherd 自己的数据库里和 ticket 页上，一有空位就会写进去。在 `workspace` scope 里，笔记满 30 条后，StateCore 会淘汰最旧的经验。
- **ticket 页 记录 tab 里的 记忆 一节** 显示最新的 handoff、决定、未完成的 follow-up 和其他笔记。点某条上的 **来历** 可以看它的版本链。这一节在 Shipherd 每次同步后刷新，Claude 在 session 里写记忆时不会实时更新。
- **长内容。** Claude 调用 `remember` 时带上 `consolidate: true`，StateCore 会把这段文字（最多 2000 个字符）作为一条事件原样存下，不算笔记，所以不占那 30 条的位置。Shipherd 不调用任何模型，所以没有什么会把事件蒸馏成笔记：`recall` 在字数上限之内，把最近的事件（带查询时是最相关的事件）完整地和笔记一起返回。记忆工具的说明也这样写，`remember` 回的是 `{"ok": true, "mode": "event"}`。旧版本留下的、还在等蒸馏的事件，就一直作为事件留着，`recall` 照样能读到。

## 内存与性能

这些设置在**设置 → 常规 → 内存与性能**。没有一项是靠限制同时运行的 session 数量来省内存的。

| 设置 | 键 | 默认 | 可填的值和说明 |
|------|----|------|----------------|
| 记录每个 session 用了多少内存 | `memoryMonitor` | `1`（开） | `1` 或 `0`。Shipherd 每分钟读一次进程表（macOS 用 `ps`，Windows 用 `Get-CimInstance Win32_Process`，不调用任何模型），把每个开着的 session 的整棵进程树（claude、它的 MCP server、shell、watcher、dev server）和 Shipherd 自己的进程加起来，再读系统还有多少可用内存。**轮到你**页的「运行情况」里有一张**内存**卡片：Shipherd、session、系统可用、Shipherd 的 MCP，展开后有最近 24 小时的曲线。每 5 分钟往 Shipherd 的数据库存一个点，保留 14 天。只读，不动任何进程。 |
| 降低看不见又停着的 session 的优先级 | `backgroundPriority` | `0`（关） | `1` 或 `0`。macOS 上，不在屏幕上、又停着的 session，整棵进程树被设成后台（`taskpolicy -b`）。Windows 上，看不见的 session 设成 `BelowNormal`，又停着的再打开 EcoQoS。终端出现在屏幕上、你在里面打字、或者 session 又开始干活，马上恢复；退出 Shipherd 时全部恢复。macOS 上正在干活的 session 不降：后台优先级会把编译和测试拖得很慢。 |
| 清理 session 留下的孤儿进程 | `orphanCleanup` | `1`（开） | `1` 或 `0`。Shipherd 记着它在每个 session 下面见过哪些进程（`~/.shipherd/procs/owned.json`，带启动时间和命令行）。session 的终端结束 5 秒后，其中还活着、又不在任何开着的 session 下面的，会被结束：先正常结束，5 秒后还在就强制结束（Windows 上先 `taskkill`，再 `taskkill /F`；每个进程单独核对、单独结束，不用 `/T`）。启动时也会清掉 Shipherd 上次异常退出留下的。启动时间或命令行对不上的（比如 pid 被别的程序重用了）绝不碰。每结束一个都写进日志。 |
| claude 进程超过多少 MB 就换新（0 = 关） | `refreshMemoryMb` | `0` | 默认关，session 只按 `refreshThresholdTokens` 换新，和 2.1.0 一样；想打开的话 `2048` 是个合适的值。`0` 关掉，否则是不小于 256 的整数 MB（最多 6 位）。只算 claude 进程自己，不算它的 MCP server 和别的子进程。超过以后，Shipherd 在这个 session 下一次停下来的时候换新，检查和步骤和 `refreshThresholdTokens` 一样（所以要开着记忆）。换新以后 claude 还在阈值的 80% 以上，Shipherd 写进日志；6 小时以后再试。 |
| 停着的 session 休眠 | `hibernateEnabled` | `0`（关） | `1` 或 `0`。Shipherd 开的 session 停够了下面的分钟数，Shipherd 就结束它的整棵进程树（claude、MCP server、shell，`hibernateEndWatchers` 开着时还有 watcher），只留下对话记录，按钮上显示「休眠」。有东西要送进去时它用 `claude --resume` 醒来，原来的对话都在：CI 的结论、合并通知、给总控的汇报、你对 `ask_user` 的回答。点开它、切到它的终端也会唤醒。下面这些情况不休眠：正在干活或者有后台命令、屏幕上有权限确认或对话框、输入框里有草稿、30 秒内在终端里打过字、正在换新或者正在给它递东西、是你正在看的终端、是总控而它管的子 session 在干活、2 分钟内刚打开或者 10 分钟内刚唤醒、没有对话记录、被钉住（按钮上的 📌）。修复 session 和复盘分析 session 不休眠。休眠的 session 照样显示在「轮到你」页，照样算在等你。唤醒失败的，按钮上有个 **!**（原因在悬停提示里），并且一直留在「轮到你」页，直到你点开或者隐藏它。会过去的失败（ticket 正忙、找不到 claude、仓库在别的分支上）保留休眠，10 分钟后再自动唤醒；别的失败（claude 还没起来就退出了，或者 60 秒没起来）变成普通的关着的 session。你自己点开总会再试一次。不限制同时开的 session 数。 |
| 等你的 session 多少分钟后休眠 | `hibernateYouMinutes` | `30` | `0`（不休眠）或不小于 `5` 的整数（最多 5 位）。「等你」是「轮到你」页说它需要你，或者有没回答的 `ask_user`。 |
| 等 CI 的 session 多少分钟后休眠 | `hibernateCiMinutes` | `20` | 同上。等 CI：它的 PR（或者分支）的 CI 在跑，或者排在合并总控里。 |
| 等 review 的 session 多少分钟后休眠 | `hibernateReviewMinutes` | `30` | 同上。PR 开着、CI 跑完了、review 还没批准。 |
| 闲置的 session 多少分钟后休眠 | `hibernateIdleMinutes` | `60` | 同上。别的停着的情况。 |
| 休眠时也结束 watcher 和 dev server | `hibernateEndWatchers` | `1`（开） | `1` 或 `0`。关掉的话，session 休眠期间 watcher（`tsc --watch`、`vite` 等）和 dev server 照样跑，它醒来、被隐藏或者 Shipherd 重启时再结束。 |
| 内存紧张时休眠闲得最久的 session | `memoryPressureEnabled` | `0`（关） | `1` 或 `0`。系统可用内存低于 `memoryPressureFreePercent` 时，每次采样（每分钟一次）休眠一个 session：闲得最久、至少闲了 5 分钟、上面的规则都通过的那个。可用内存回到线以上 5 个百分点就停。`hibernateEnabled` 关着也照样生效。 |
| 可用内存低于百分之多少算紧张 | `memoryPressureFreePercent` | `10` | `1` 到 `50` 的整数。 |
| 共享 MCP | `sharedMcp` | `0`（关） | `1` 或 `0`。开着时，一个后台进程（MCP hub）经本机回环 HTTP（只监听 `127.0.0.1`，每个 session、每个 server 一个随机 token）给所有 session 提供 Shipherd 的记忆 server 和 `shipherd-sessions`，不再每个 session 各起一组进程。开着的 session 越多省的内存越多；关着时「轮到你」页「运行情况」里的内存卡片会估算能省多少。只影响之后打开的 session。hub 还在启动或者起不来的时候，新开的 session 照旧用各自的进程；一直起不来时「轮到你」页「运行情况」的「Shipherd 的其他提醒」里有提示。关掉以后，已经接上 hub 的 session 照常用到它退出。你自己 Claude 配置里的 MCP server 不受影响。 |

### Shipherd 管不了、但很有用的建议

- **Windows：**在 Windows 安全中心给 Defender 加排除：放 worktree 的目录、`node_modules`、`.git` 和 `%USERPROFILE%\.shipherd`。很多 node 和 git 进程一起跑时，实时扫描开销很大。确认页面文件够大：设成**系统管理的大小**，或者至少是内存的 1.5 倍。
- **macOS：**把放 worktree 的目录加进「聚焦」的隐私列表（系统设置 → Siri 与聚焦 → 聚焦隐私），免得每次 `pnpm install` 都被重新索引。装了第三方杀毒软件的话，同样排除这些目录。macOS 自己管交换空间：磁盘至少留 15%～20% 的空闲，它才有地方换出。
- **两边都是：**你自己的 Claude 配置里装的每个 MCP server，每个 session 都会再起一份。**轮到你**页「运行情况」里的**内存**卡片会列出你装的 MCP 里占内存最多的。不常用的可以从你的 Claude 配置里去掉；Shipherd 不会替你改这个配置。

## 定时与状态

Shipherd 内部把它为 ticket 写的状态叫 handoff，`/handoff` 命令沿用这个名字。

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 晚间状态更新的时间 | `nightlyTime` | `16:00` | `HH:MM`，本地时间。如果到点时 Shipherd 没开、电脑在睡眠或锁屏，会在下次启动、唤醒或解锁时补跑，排在早间刷新之前。 |
| 每天几点让全局总控巡检一次 | `shipherdPatrolTime` | 空（关） | `HH:MM`，本地时间；空 = 关。到点时 Shipherd 打开（或接着用最近的）全局总控，让它看一遍 PR、CI 和未决的提问，用 `send_message` 提醒该跟进的 epic 总控，用 `ask_user` 列出要你亲自做的事。全局总控正忙就排进它的信箱，它下一次调用工具时读到；到点时电脑在睡眠或 Shipherd 没开，当天醒来、解锁或启动时补一次，过了零点不补。如果在当天的巡检时间过了之后才打开这项设置，会马上巡检一次。巡检每天最多开一次 session。上一次巡检列出的提问还没处理时，下一次会等你处理完。全局总控不会被自动换新，也不会因为闲置被自动关闭。 |
| 工作日（只在这些天跑晚间状态更新） | `workingDays` | `1,2,3,4,5`（周一到周五） | 界面上是复选框。存的值是用逗号分隔的 `0`–`6`，`0` 是周日。晚间 handoff 和早间刷新只在这些天运行。 |
| tracker MCP 工具（更新状态时只能调用这些，一行一个） | `trackerTools` | 空 | 一行一个 MCP 工具名，格式是 `mcp__<server>__<tool>`。只写 `mcp__<server>` 会放开这个 server 的所有工具，除非 server 是只读的，否则别这么写。其他内容，例如 `Bash(...)` 规则或命令行参数，都会被拒绝。handoff 和刷新可以调用这些工具，加上 `Read`、`Grep`、`Glob`、`gh pr view`、`gh pr checks`、`git log` 和 `git status`，再加上你用户级或托管（policy）的 Claude Code 设置允许的工具（见下文）。 |
| 后台的状态更新也加载本地级的 MCP… | `headlessProjectMcp` | `0`（关） | `1` 或 `0`。见[接入你的 tracker](#接入你的-tracker)。 |
| 状态更新的提示词模板 | `handoffPrompt` | 内置 | 做 handoff 时发给 `claude` 的指令。不能为空，最长 20,000 个字符。见[改写提示词](#改写提示词)。 |
| 早间刷新的提示词模板 | `refreshPrompt` | 内置 | 早上快速查一遍 PR 和 tracker 状态，不总结对话。限制同上。 |

这一节还有 **现在就跑一次晚间状态更新** 按钮。

晚间运行做完 ticket 之后，还会为每个自上次汇总以来总控 session 或 ticket 有新动静的 epic 写一份汇总。有总控 session 时，它会 fork 这个 session，并使用和 handoff 相同的只读参数。如果 ticket 那一轮被限流了，当晚不写 epic 汇总，留给早上的补跑。epic 页上还有 **立即更新**，它先为这个 epic 里有动静的 ticket 跑 handoff，再写汇总。上次汇总之后 PR 的状态、CI、review 或能不能合并有变化，也算新动静，所以就算没人打字，汇总也会标成过时。每份汇总都写着读 PR 的时间（"PR 状态截至"）。在总控 session 里运行 `/handoff`，会直接根据对话本身写汇总。

handoff 和刷新用这些参数启动 `claude`：

- `--permission-mode dontAsk`：没被允许的工具一律拒绝，所以永远不会弹确认。
- `--disallowedTools Edit Write NotebookEdit`：这几个工具总是被禁止。
- `--setting-sources user`：你用户级的 Claude Code 设置生效，托管（policy）设置也生效，Claude Code 总会加载它们。仓库自己设置里的 allow 规则和 hook 不生效。

允许的工具是上面那张清单，加上你用户级 `settings.json` 和任何托管设置里的 allow 规则。这些运行并不是严格只读的。如果这些设置允许了比如 `Bash(npm:*)` 或者能写入的 MCP 工具，无人值守的运行也能用。只有 `Edit`、`Write` 和 `NotebookEdit` 总是被禁止。

### 接入你的 tracker

Shipherd 自己从不和你的 tracker 通信。handoff 通过公司 Claude Code 里配置的 MCP server 去读 tracker。只选**只读**的工具：

1. 照平常的方式在 Claude Code 里配置 tracker 的 MCP server。用户级（user scope）最简单。
2. 在设置里点 **从 Claude Code 检测**。Shipherd 会列出你的 Claude Code 能用的所有 MCP 工具。名字看起来是读操作的工具（get、list、search、read、view、fetch、query、find……）会预先勾上。把会写入的都取消勾选，然后点 **加入选中的工具并保存**。
3. 工具名的格式是 `mcp__<server>__<tool>`，`<server>` 是你在 Claude Code 里给 server 起的名字。名为 `atlassian` 的 Atlassian（Jira）server，工具名可能是 `mcp__atlassian__getJiraIssue`。其他 tracker（Linear、GitLab……）用检测结果里显示的名字。
4. 如果 tracker 的 MCP server 配在本地级（local scope）或仓库的 `.mcp.json` 里，打开 `headlessProjectMcp`。无人值守的运行只读你的用户级设置，默认看不到这些 server。打开后，Shipherd 会读仓库的 `.mcp.json` 和 `.claude/settings.local.json`，以及你的 `~/.claude.json` 和 `settings.json`，找出你批准过的 server。然后它把你本地级的 server，以及你已经在 Claude Code 里批准过的仓库 server，复制到 `~/.shipherd/mcp/` 下的私有文件里。这些文件里可能有 token。被禁用或没批准的 server 永远不会加载。

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

保留 `{{schema}}` 和关于输出的指令。Shipherd 还会把 JSON schema 传给 `claude --json-schema` 并校验结果。输出没通过校验时，Shipherd 会带上错误重试一次；还不通过，就存成一份不完整的 handoff，标为 **不完整**。不管你用哪种 tracker，schema 里 tracker 状态的字段都叫 `jira`。

## 合并总控

几个 ticket 改同一个仓库时，合并总控让它们的合并不互相撞车。它是 Shipherd 的一部分，没有设置项。它不问模型，两个分支冲不冲突由 git 自己判断。

**它审查什么。** 只审查两类命令，而且只限 Shipherd 打开的 session（epic 总控或任何 ticket session，不管属于哪个 epic）：

- 合并进目标分支：`gh pr merge`（包括 `--auto`，目标是 PR 的 base 分支）、在目标分支上 `git merge`，以及 `git push` 到目标分支。带显式 `src:dst` refspec 的 push，检查的是 `src` 分支（`HEAD` 指当前分支）。不带 refspec 的 `git push origin main` 推的是本地 `main`，不管你在哪个分支上，所以算作推目标分支本身，不审查。推你自己的分支也不审查。`cd` 和 `git -C` 里的目录可以写成 Windows 路径（`"C:\Users\me\repo"`）、Git Bash 路径（`/c/Users/me/repo`）或带 `~`。
- 在共用文件夹里切分支（`git checkout`、`git switch`）。共用文件夹指"分支"工作模式下、另一个有打开 session 的 ticket 也在用的仓库文件夹。在你自己的 worktree 里切分支不审查。

写代码、commit、跑测试、推自己的分支都不会经过总控。它认不出的命令一律放行。

**只在 Shipherd 打开的 session 里。** 审查是 Shipherd 为每个 session 写的 `--settings` 文件里给 Bash 工具挂的 `PreToolUse` hook，再加上 `PostToolUse` 和 `PostToolUseFailure` 两个 hook，用来告诉 Shipherd 命令结束了。你全局的 `settings.json` 不会被改，所以你自己启动的 `claude` 不受影响。这些 hook 运行的是 **安装 / 修复** 复制到 `~/.shipherd/bin` 的 `shipherd-hook` 程序。这份副本和 app 里的不一样时（升级之后），Shipherd 会在启动时替换它；替换不了的话，合并就不做检查，日志里会写明原因。

**它怎么判断。**

- 先到先得。一次合并和另一个还在写的 ticket 分支冲突时，允许合并，Shipherd 记下另一个 ticket 之后要 rebase。
- 如果分支已经合不进最新的目标分支，会让 session 先 rebase，并告诉它和哪个 ticket 的改动冲突、冲突在哪些文件里，还会提醒它保留双方的意图。
- 如果它和一个已经被允许合并、但还没合完的分支冲突，会让它等。自己的合并已经被允许过的 session 可以直接再试，不用等。合并锁跟着真实的合并走：
  - 本地的 `git merge` 或 push 会一直锁到命令结束，不管成功还是失败。如果 Shipherd 一直没收到命令结束的消息，例如你拒绝了权限确认，锁会在 10 分钟后过期。
  - `gh pr merge` 会一直锁到 Shipherd 看到 PR 已合并（用 `gh pr view` 检查，只查被锁的 PR）或已关闭。如果允许合并 30 秒后 PR 还开着，而且没开 auto-merge，Shipherd 就认为合并失败了或 `--auto` 被取消了，并释放锁。`gh` 查不了的话，锁在 2 小时后过期。如果一个分支还持有本地合并的锁（比如 push 被拒之后），再对它 `gh pr merge`，这把锁会转成 PR 锁。
- 被锁住的合并完成后，等待中的 session 会收到可以合并了（rebase 之后）的消息。如果它没完成（合并失败、PR 被关、锁过期），会告诉那个 session 可以再试一次。消息放进这个 session 的信箱：在干活就在下一次调用工具时读到，停着就在你 30 秒内没在它的终端里打字时输入进去，终端关着就在你再打开这个 session 时送达。
- 文件夹在用的时候，在共用文件夹里切分支会被拒绝，并写明是哪个 ticket、哪个分支。你自己在界面上点切换分支时，Shipherd 只提醒，你仍然可以确认。

**出错时放行。** 如果 Shipherd 没在运行、5 秒内没响应，或者 hook 本身出错，命令照常执行。总控只是一道保险，永远不会成为 session 合并不了的原因。

**你会看到什么。** 它发现的每一次冲突（一次拒绝，或者一次允许外加之后的 rebase）都会在 **轮到你** 页「运行情况」的 **最近合并** 里加一条记录（哪个仓库、哪些 ticket、它定下的顺序）。不发系统通知。没有冲突的合并不加记录，Shipherd 只是锁到它合完为止。这些记录、锁和待做的 rebase 重启后都还在。

**要求。** git 2.38 或更新（为了 `git merge-tree --write-tree`）。`gh` 是可选的，只用于 PR 合并。

**它不做什么。** 它只判断 git 能看出来的冲突。合并后的代码能不能编译、行为对不对，例如一边改了字段名而另一边还在用旧名字，交给 CI。它不替你 rebase 或解决冲突，也不管你在自己终端里跑的 git。

## 模型路由

Shipherd 在后台用 `claude -p` 做一些事：「需要你」和卡住判断、handoff、epic 汇总、复盘分析。**设置 → 模型路由**决定每一种调用用哪个模型，以及模型撞到限额时怎么办。

**什么都不登记就什么都不变。** 在你登记至少一个启用的模型之前，每个调用都和 Shipherd 2.1.0 用同一个模型（「需要你」和卡住判断用 haiku，handoff 刷新用 sonnet，其余用你的默认模型）。限额照旧处理：整个账号暂停。下面说的通用信号只记在页面上。

**档位和链。** 每个登记的模型有一个档位：`high`、`mid` 或 `low`。模型名可以是别名（`opus`）、完整名字（`claude-opus-5-5`），或者你的网关认识的名字；Shipherd 原样传给 `--model`。每一档有一条链，也就是试这一档模型的顺序。默认按登记的顺序。**账号**标签相同的模型共用一个订阅或网关：其中一个撞到账号级限额时，同账号同档和更高档的模型也一起标上。

**第一次设置。** **发现模型**从 `ANTHROPIC_MODEL` 等变量、Claude Code `settings.json` 里的 `model`、最近用量里出现过的模型和 CLI 别名收集候选名字，给每个发一次很小的测试调用，只列出有回应的，并给出建议档位。Shipherd 从不假设 opus、sonnet、haiku 一定存在。登记了却不存在的模型标成不可用并跳过。

### 任务和限额

每个后台调用都带着它的任务。页面上的表列出每个任务的档位、最低允许档位、撞限时怎么办、是不是关键任务，每一项都可以按任务改。

- **fallback（降级）**：试链里的下一个模型，再往下一档，最低到允许的档位。
- **wait（等待）**：先试同一档的其他模型，都不行就等其中一个恢复。不会丢掉。
- **escalate（上报）**：第一次撞限就停下并报出来。

handoff 和 epic 汇总沿用 session 自己的模型（换模型会让 prompt 缓存整个失效）。

比任务要的档位低的结果会在用量、复盘运行详情和事件记录里标成降级。在低档跑的复盘分析会排队，等它自己的档位恢复后重跑一次；页面上的**现在重跑**会马上做。

**识别限额。** 限额靠规则识别：内置规则、你加的规则（正则、HTTP 状态码或恢复时间的格式）和从你的确认里学到的规则。此外，Shipherd 把这些当作*疑似*限额：HTTP 429、529、402，报错里提到 limit、quota、billing、credit，以及同一个模型连续失败三次而别的模型成功了。疑似限额记在那个模型上（规则说是账号级的就记在账号上）。不知道恢复时间时，Shipherd 先退避，再用一次很小的调用探测。分不出来的报错列在**未识别的报错**里：**这是限额吗？**把它变成一条学到的规则，下次同样的报错就能认出来；**不是限额**清掉疑似标记。

### 交互 session

总控的 `start_session` 接受档位（`high`、`mid`、`low`）或模型名，旧的 `opus`、`sonnet` 照旧能用。Shipherd 挑这一档里健康的模型，返回实际用的模型。不认识的名字在开终端之前就拒绝。你的 `claude` 不支持 `--model` 时，session 不带它打开。

session 撞到限额时，它那一行显示限额和**换下一档继续**按钮：结束终端，用 `--resume` 加下一个模型的 `--model` 接着同一段对话。打开 `routingAutoSwitch` 后 Shipherd 直接换。

### 花费

| 设置 | 键 | 默认值 | 可接受的值和说明 |
|------|----|--------|------------------|
| 每月配额 | `routingQuotas` | 空 | JSON 列表，每项是 `{"target": "tier:high" 或 "model:<名字>", "unit": "usd" 或 "tokens", "monthly": <数字>}`。金额取 Claude Code 报的费用，没有时用 token × 登记的价格。空表示不设配额。 |
| 软阈值（%） | `routingThresholds` | `70,90` | 两个整数，前一个小于后一个。过了第一个，策略是 fallback 的任务跳过这个模型、降到低一档；过了第二个，只有关键任务还用它。配额从不挡关键任务。 |
| 周期开始日 | `routingPeriodStartDay` | `1` | 1 到 28，每月从哪天开始算配额（本地时间）。 |
| 思考强度 | `routingEffort` | 空 | JSON 对象，键是任务 id 或档位，值是 `low`、`medium`、`high`、`xhigh` 或 `max`；你的 `claude` 支持时作为 `--effort` 传。任务的设置优先于它档位的。 |
| 并发上限 | `routingMaxConcurrent` | 空 | JSON 对象，键是档位，值是同时最多跑几个后台调用的整数，比如 `{"high": 1}`。 |
| session 自动切换 | `routingAutoSwitch` | `0`（关） | `1` 或 `0`。打开时撞限的 session 马上换下一档，不再显示按钮。 |

同一页上还有按模型和按任务的花费、每个模型的健康状态和降级事件记录。**轮到你**页在模型撞限或降级期间显示提示。

## 效果页

**效果** 页（在侧栏「Shipherd 自己」一组里，**复盘与规矩** 下面）显示 Shipherd 做的 PR 要你付出多少、和之前比怎么样。全局总控的 `metrics_overview` 返回同一份数据，可以看 1 到 365 天（默认 30 天）。没有要设置的。

- **四张卡**：每个合并了的 Shipherd PR 平均的周期（开 PR → 合并，以及 ticket 开始 → 合并）、评论（人和 Copilot，以及复盘标成可避免的有几条）、人介入（以及 session 等了你多久）和花费（加权 token；也折成美元，用 Claude Code 报的金额，没有的按模型登记的价格估）。周期和评论和基线比；另外两张没有可比的，写"之前 —"。
- **基线**：Shipherd 每天从 GitHub 读一次你自己开的、在第一个 Shipherd session 之前 180 天里合并的 PR（每个仓库最多 100 个，链接到 ticket 的不算），记下周期和评论数。bot 的评论不算，和 Shipherd 的 PR 一样。这些 PR 的"ticket 开始"用第一个 commit 的时间近似。截止点在第一个 Shipherd session 出现时定下，之后不再变。还没读到这样的 PR 时（比如 gh 用不了），页面上写还没有基线。
- **打断原因**：每种停下来等你的原因（权限确认、选择题、缺信息、真问题、卡住）各有几次、各让你等了多久，以及自动放行了几次。session 停着、但不是在等你的空闲时间单独算。
- **评论与 CI**：选定时间范围里[评论闭环和 CI 分类](#评论与-ci)做了什么：自动处理了几条评论（Copilot 和人、回复了几条、resolve 了几条、还有几条在等你），CI 失败在自动重跑后通过（flaky）了几次，这些 flaky 从第一次失败起浪费了多久，以及最常 flaky 的检查和测试。
- 按周或按月的 **趋势**（最近 12 个）、按种类的 **人介入构成**、**分组**（Shipherd PR 和其他链接到 ticket 的 PR；按仓库、产品和风险等级，没有等级的是"未分级"）、按模型和按任务的 **花费构成**，以及 **返工**：CI 失败、PR 重开和合并后被 revert。重开和 revert 也是每天那次读 GitHub 找到的（标题是 `Revert "<标题>"` 或者正文写着 `Reverts #N` 的已合并 PR）。

数字每小时从本地事件汇总一次；打开页面时，上次汇总超过 10 分钟就再汇总一次。电脑睡着的时间不算等待。

这些对比从哪天算起存在三个内部键里，都不直接编辑：`metricsSince` 是 Shipherd 开始记度量的时间，`metricsBaselineCutoff` 是固定下来的基线截止点（你第一个 Shipherd session 的时间），`skillTrackingSince` 是 hook 开始记 review 和 design 这类 skill 的时间，之前的 PR 不算没做。

## 花费上限与后台任务

**设置 → 花费与后台**有两部分：session 和 ticket 的花费上限，以及后台任务什么时候可以跑。什么都不改时和 2.1.0 一样：没有上限，后台任务随时跑。

### 花费上限

上限管的是一个 **session** 能花多少（整条链，包括 `/clear` 接出来的 session），或一个 **ticket** 能花多少（它下面所有 session，加上归到它的后台调用，比如它的「需要你」和卡死判断、复盘分析）。花费来自 Shipherd 已有的用量统计：按美元时用 Claude Code 报的费用，或 token × 登记的价格；按 token 时用和[花费](#花费)里配额一样的权重。

上限和准入策略一样分层：**全局**、**产品**、**仓库**，仓库的值盖过产品的，产品的盖过全局的。空着 = 跟上一层；上限里填 `none` = 这一层明确不限。跨几个仓库的 ticket 或 session 取其中最严的上限。

| 字段 | 键 | 默认 | 可填的值和说明 |
|------|----|------|----------------|
| 每个 session 的上限 | `sessionCap` | 不限 | 正数（单位见下），或 `none`。 |
| 每个 ticket 的上限 | `ticketCap` | 不限 | 正数（单位见下），或 `none`。 |
| 单位 | `unit` | `usd` | `usd` 或 `tokens`。 |
| 到上限时 | `action` | `downgrade_then_pause` | `downgrade_then_pause`：经模型路由换到低一档的模型，还超出上限下面这个比例就暂停。`pause`：直接暂停。没有更低的模型时直接暂停。 |
| 暂停什么 | `pauseScope` | `session` | `session`：Shipherd 打断 session 正在跑的这一轮（像按了 Esc），不再往里发消息，它的后台调用也停。`background`：只停它的后台调用，终端照常。 |
| 降档后再超出多少（%）才暂停 | `graceAfterDowngradePercent` | `20` | 0 到 1000。 |
| 「继续并提高上限」一次加多少（%） | `raisePercent` | `50` | 1 到 1000。新上限 = 已经花了的 + 上限的这个比例。 |

**你会看到什么。** 过了 `routingThresholds` 的第一档（默认 70%），「轮到你」页「运行情况」的「Shipherd 的其他提醒」里提醒。到上限时，「轮到你」页、session 那一行和托盘提示都会说发生了什么。**继续并提高上限**解除暂停，只给这个 session 或 ticket 提高上限；在设置里改了上限，这次提高就作废。暂停 90 秒后还在跑、而且又花了钱的 session，只要你没往里打字，Shipherd 会结束它的终端；你自己打了字，Shipherd 就交给你。暂停的 session 不会被从休眠里叫醒。每次提醒、降档、暂停、结束和解除都列在同一页的**最近的记录**里。

花费上限不代替卡死判断：超了上限的 session 或 ticket 照样做卡死判断和「需要你」判断，没超预算的 session 卡住了也照样上报。

### 后台任务

后台任务（复盘分析和补跑、复盘准入，以及后续功能加的种类）排在你正在用的 session 后面。每种有优先级（`high`、`normal`、`low`），可以只在某些时候跑。让路时不丢东西：被打断的一项放回队列，之后再跑（存了检查点的种类从检查点接着跑），重启后也一样。后台任务不会叫醒休眠的 session。

| 设置 | 键 | 默认 | 可填的值和说明 |
|------|----|------|----------------|
| 什么时候跑 | `bgWindow` | `anytime` | `anytime`、`idle`（「只在空闲时跑」）、`hours`（「这些小时内跑」）或 `idle_or_hours`。`high` 优先级的不看这个。 |
| 这些小时 | `bgHours` | `22:00-07:00` | 逗号分开的几段 `HH:MM-HH:MM`，本地时间，可以跨午夜。 |
| 空闲的分钟数 | `bgIdleMinutes` | `10` | 1 到 240。macOS 或 Windows 上多少分钟没碰键盘鼠标算空闲；锁屏马上算空闲。 |
| 该让路时 | `bgYield` | `finish` | `finish`：已经在跑的跑完，不开新的。`interrupt`：能停的马上停，放回队列。 |
| 额度紧张时 | `bgQuotaOrder` | `pause_first` | `pause_first`：过了第一档停低优先级的后台任务，过了第二档普通优先级的也停。`downgrade_first`：后台任务用模型路由挑的低一档模型接着跑，过了第二档只停低优先级的。`high` 优先级两种都不停。不管选哪种，过了第一档模型路由照样把 fallback 的任务降档。 |
| 额度充裕（%） | `bgPlentifulPercent` | 空 | 1 到 99。每个配额都用了不到这个比例时，后台任务在时段外、你在用电脑时也跑。空 = 不用。 |
| 按种类改 | `bgKinds` | 空 | JSON 对象，种类 → `{"priority": ..., "window": ..., "paused": true}`。页面上的表格会替你写。 |

页面上的表格列出每种后台任务、现在能不能跑和为什么不能（你停了、花费熔断、额度、给你让路、不在时段内），以及排队和在跑的数量。会开 session 的种类开之前还要过内存准入，不放行时就等着。**停用**让这一种停下，直到你恢复。「复盘准入」管自动准入（`lessonsAutoAdmit`）和每天的原则重新分组（`lessonsPrinciples`）：这一行不能跑时它们等着，过一会儿再看。仓库扫描只在你点了（或引导里）才跑，所以不在表里，这些设置也管不到它。

## 复盘规矩：批量操作、准入策略和导入导出

### 批量操作和批次

在**复盘规矩**页先筛选（仓库或产品、状态、准入、可检查性、搁置原因、最少出现次数、分数范围、批次、文字、只看降级模型产出的），然后一步处理**所有符合条件的规矩**：**全部确认（N）**、**全部拒绝（N）**、**全部停用（N）**、**全部启用（N）**、**全部删除（N）**。也可以勾选几条待确认的，只处理这几条。**接受全部推荐（M）**只确认准入流水线推荐的（准入是 `auto`），其他的不动。

每次批量操作、每次单条的确认 / 拒绝 / 编辑 / 停用 / 删除 / 合并、删除产品（连同它的规矩和策略层）、每次改策略、每次导入，都记成一个**批次**，每一行改前改后各存一份快照。**批次**标签页列出它们；**撤销**把一个批次里的每一行恢复原样。那之后又被改过的行不动，算作跳过；这一批新建的产品或规矩、后来又有别的东西依赖它的，也跳过。合并只能整个撤销，不会只撤一半。至少恢复了一行才算撤销过；撤销本身也记一笔，不能再撤销。删掉一条规矩会连同合并进它的那些一起删，撤销时一起回来、仍然是合并的。页面算完数之后列表又变了（比如后台分析新加了符合条件的规矩）时，批量操作只改页面上显示过的那些；会改的比按钮上的数多，就什么都不改。合并不再删掉被合并的那条：它留着、隐藏起来、指向合并到的那条，所以合并也能撤销。

以前就确认、停用或拒绝过的规矩，状态不变，准入记成 `manual`。

### 备份和导出设置

| 设置 | 键 | 默认值 | 取值和说明 |
|------|----|--------|------------|
| 每隔几天自动备份一次全部配置（0 = 关） | `configBackupIntervalDays` | `0` | `0`（关）到 `365` 的整数。Shipherd 每个间隔把全部配置导出一份到 `<SHIPHERD_HOME>/backups/auto-<时间>.json`（任务 `config_backup`；失败一小时后重试）。备份里不会有密钥或本地路径。 |
| 自动备份保留几个 | `configBackupKeep` | `10` | `1` 到 `999` 的整数。只留最新的几个自动备份；替换导入之前写的备份和**现在备份**按钮写的备份从不删除。 |
| 多少天没导出就提醒（0 = 不提醒） | `configExportReminderDays` | `30` | `0`（不提醒）到 `365` 的整数。有已确认的规矩、而且这么多天里既没导出也没备份（从没有过就从第一条已确认规矩算起）时，导入导出标签页和规矩标签页会提醒。 |

`configLastExportAt` 记的是上一次导出的时间，给这个提醒用；不直接编辑。

### 准入策略

准入策略决定复盘流水线怎么给规矩打分、搁置、回测、影子运行和降级。每个键都能在三层设置：**全局**、**产品**、**仓库**。一个仓库先用自己的值，没有就用它所属产品的值，再没有用全局的值，最后用默认值；逐个键合并。一个仓库属于几个产品、这几个产品对同一个键设了不同的值时，名字排在最后的产品生效，**设置 → 复盘规矩 → 准入策略**会提示。每次改动都是一个可撤销的批次，并把策略版本加一（评分会记下用的是哪个版本；当前版本存在 `admissionPolicyVersion` 里，不直接编辑）。这些默认值还没校准过，页面上会注明。

| 键 | 默认值 | 取值 | 作用 |
|----|--------|------|------|
| `score.weight.evidence` | `0.24` | 0–1 | 评分里证据（出现次数、PR 数、评审人数）的权重 |
| `score.weight.clarity` | `0.16` | 0–1 | 清晰度的权重 |
| `score.weight.consistency` | `0.16` | 0–1 | 和已有规矩一致的权重 |
| `score.weight.verifiability` | `0.24` | 0–1 | 可验证性（能不能变成检查）的权重 |
| `score.weight.performance` | `0.2` | 0–1 | 影子运行实测表现的权重 |
| `score.admitLine` | `0.7` | 0–1 | 可检查的规矩达到这个分数就准入 |
| `score.dropLine` | `0.3` | 0–1 | 低于这个分数就搁置 |
| `score.proseAdmitLine` | `0.8` | 0–1 | 只能写成文字的规矩的准入线 |
| `score.untestedCap` | `0.69` | 0–1 | 没回测过的规矩最高能得的分 |
| `score.reviewerBonus` | `0.05` | 0–1 | 评审人亲自提过的加分 |
| `score.recencyHalfLifeDays` | `180` | 1–3650 的整数 | 旧证据衰减的半衰期（天） |
| `score.degradedPenalty` | `0.1` | 0–1 | 分析用的是降级模型时的扣分 |
| `score.evidenceFullHits` | `5` | 1–1000 的整数 | 出现多少次时「出现次数」拿满分 |
| `score.evidenceFullPrs` | `3` | 1–1000 的整数 | 在多少个不同的 PR 里出现时「覆盖面」拿满分 |
| `score.minClarity` | `0.4` | 0–1 | 清晰度低于这个值就搁置 |
| `batch.sampleSize` | `20` | 1–1000 的整数 | 自动批次抽查多少条 |
| `batch.minSamplePassRate` | `0.8` | 0–1 | 抽查通过率至少多少 |
| `batch.minCoverage` | `0.3` | 0–1 | 一批里至少多大比例要有结论 |
| `batch.maxShelvedShare` | `0.7` | 0–1 | 一批里最多多大比例被搁置 |
| `batch.minBacktestRecall` | `0.01` | 0–1 | 整批回测召回率至少多少 |
| `batch.maxBacktestFalsePositiveRate` | `0.2` | 0–1 | 整批回测误报率最多多少 |
| `dedupe.minSimilarity` | `0.35` | 0–1 | 文字相似度达到多少时，把两条规矩交给模型判断是不是重复 |
| `dedupe.maxGroup` | `30` | 2–100 的整数 | 每次去重或查冲突的调用最多带几条规矩 |
| `generality.minHits` | `2` | 0–1000 的整数 | 规矩至少出现几次 |
| `generality.minPrs` | `2` | 0–1000 的整数 | 至少在几个不同的 PR 里出现 |
| `generality.minReviewers` | `0` | 0–100 的整数 | 至少几个不同的评审人提过 |
| `generality.allowSingleReviewer` | `true` | `true` / `false` | 同一个评审人在几个 PR 里反复提同一件事，算团队习惯 |
| `backtest.recentPrs` | `50` | 1–1000 的整数 | 用最近多少个合并的 PR 回测 |
| `backtest.minRecall` | `0.01` | 0–1 | 回测召回率至少多少 |
| `backtest.maxFalsePositiveRate` | `0.2` | 0–1 | 回测误报率最多多少 |
| `backtest.allowUntestedShadow` | `true` | `true` / `false` | 没法回测的规矩也可以先影子运行 |
| `backtest.lineTolerance` | `3` | 0–50 的整数 | 回测命中离评审评论几行以内算同一处 |
| `backtest.judgeSample` | `20` | 0–200 的整数 | 每条规矩回测里没对上评论的命中，抽多少条让模型判断（0：没对上的都算误报） |
| `shadow.minPrs` | `5` | 0–1000 的整数 | 影子运行至少经过几个 PR 才转正 |
| `shadow.minDays` | `7` | 0–365 的整数 | 影子运行至少几天才转正 |
| `shadow.maxFalsePositiveRate` | `0.2` | 0–1 | 影子运行误报率最多多少 |
| `shadow.minAdoption` | `0.6` | 0–1 | 发现的问题至少多大比例被采纳 |
| `shadow.autoPromote` | `false` | `true` / `false` | 达标后自动转正 |
| `shadow.minHits` | `3` | 0–1000 的整数 | 影子运行里至少发现多少次问题才考虑升级 |
| `conflict.autoPickHigherHits` | `false` | `true` / `false` | 规矩冲突时自动留出现次数多的那条 |
| `demote.enabled` | `true` | `true` / `false` | 不再起作用的已准入规矩自动降级 |
| `demote.maxBypassRate` | `0.3` | 0–1 | 被绕过的比例超过这个就降级 |
| `demote.noReductionPrs` | `10` | 1–1000 的整数 | 连续这么多个 PR 重复评论没减少就降级 |
| `demote.to` | `shadow` | `shadow` / `review` | 降级到哪：shadow（影子运行）或 review（回到待审） |
| `demote.minEvents` | `5` | 1–1000 的整数 | 至少拦截多少次之后才看绕过率 |
| `review.intervalDays` | `7` | 1–365 的整数 | 每隔几天复查一次阈值 |
| `review.minSamples` | `10` | 1–1000 的整数 | 攒够多少条新的校准样本才复查阈值 |
| `admission.autoConfirm` | `false` | `true` / `false` | 通过准入的规矩自动确认，不再问 |

### 自动准入

Shipherd 可以替你判待确认的规矩。判的时候，对一个仓库、一个产品（连同它的所有仓库）或者全部的候选规矩过四道闸门，剩下的再打分：

1. **去重。** 文字够像（`dedupe.minSimilarity`）而且文件范围有重叠的规矩交给模型，由它说哪些讲的是同一件事。出现次数最多的那条留下，其余的以 `duplicate` 搁置、指向它。这一组跨了同一个产品的几个仓库时，接受的时候留下的那条提到产品层。已经确认过的规矩总是原样留着。
2. **冲突。** 可能互相矛盾的规矩交给模型。冲突的两边都以 `conflict` 搁置、互相指向，除非开了 `conflict.autoPickHigherHits`（那样留出现次数多的那条）。确认过的规矩从不被搁置，只搁置和它矛盾的候选。
3. **普遍性。** 一条规矩至少要在 `generality.minPrs` 个不同的 PR 里出现 `generality.minHits` 次。同一个评审人在几个 PR 里提同一件事算团队习惯，除非关掉 `generality.allowSingleReviewer`。只出现过一次的以 `generality` 搁置，不丢：再命中一次就回来。
4. **可检查性。** 模型把每条分成能检查的或只能是文字的，并指出已经被现有检查或 lint 覆盖的（以 `covered` 搁置）。手动改分类会重判这一条，并记成一个校准样本。

分数由证据（出现次数、PR 数、评审人数、多新）、清晰度（照着它能不能分出代码对错；降档模型产出的规矩再扣 `score.degradedPenalty`）和一致性（1，被别的规矩限定时 0.5）组成。在复盘规矩页上展开一条规矩的分数，能看到每一项和理由。达到准入线（`score.admitLine`，只能是文字的规矩用更严的 `score.proseAdmitLine`）的**推荐**；在两条线之间的以 `low_score` 搁置并写明最弱的一项；低于 `score.dropLine` 的以 `below_drop` 搁置。推荐的可检查规矩会生成一个影子模式的检查草稿；回测之前它的分数封顶在 `score.untestedCap`。

判只改字段（准入状态、搁置原因、分数），记成一个可撤销的批次。之后从推荐的规矩里抽 `batch.sampleSize` 条换一个模型复核。抽到的规矩没能全部复核（比如复核的调用失败了）、抽查通过率低于 `batch.minSamplePassRate`，或者判过的规矩里被搁置的超过 `batch.maxShelvedShare` 时，不显示「全部接受」，并指出最弱的指标；单条规矩照样可以一条条确认。**全部接受推荐**会合并重复的、把跨仓库的规矩提到它们的产品、确认推荐的规矩并把它们的检查草稿写成影子检查，全部在一个批次里，一次**撤销**就全部还原。模型的回答有缓存，再判只问新加或改过的规矩。模型调用失败时，那条规矩留在待确认，记为没做完。判的过程中你确认、拒绝或改过的规矩保留你的决定，这一遍不会覆盖。

| 设置 | 键 | 默认值 | 取值和说明 |
|------|----|--------|------------|
| 自动判新规矩 | `lessonsAutoAdmit` | `0` | `1` 或 `0`。打开后，一次分析加了或命中了规矩，就在后台判那个仓库（只推荐；只有开了 `admission.autoConfirm` 而且抽查通过时才自动确认）。 |
| 把规矩归成原则 | `lessonsPrinciples` | `0` | `1` 或 `0`。打开后，每天把讲同一个原则的已确认规矩归成一组，session 说明里写原则，并指向它的案例。 |
| 精简的核心说明 | `lessonsCoreGuide` | `0` | `1` 或 `0`。打开后，session 说明最多保留 10 条核心规矩（最常被违反的在前）。 |

`admissionCalibratedAt` 记的是你在**校准**页上把分数线标为已校准的时间，不直接编辑。`lessonsPrinciplesRegroupedAt` 记的是上一次每天的原则分组，重启以后当天不会再分一次；也不直接编辑。

### 初始化向导

复盘规矩页的**初始化向导**标签页，给一个仓库、一个产品或全部做第一遍。开始之前它列出每个仓库合并过多少个 PR、已经分析了多少个，以及预计的模型调用次数和时间（按以前分析的耗时估）。被一次接受了的向导覆盖过的仓库标着**已初始化**。合并 PR 的列表最多 10 分钟向 GitHub 拉一次。然后它：

1. 扫描现有代码（没有本地 clone 的仓库跳过；没配 lint 的仓库总结里会写）；
2. 分析还没分析过的合并 PR，给旧规矩补上缺的字段；
3. 回测范围里的每个仓库（见下文；有仓库没有本地 clone 或 `gh` 不能用时总结里写**未回测**，可检查规矩的分数一直封顶）；
4. 按上面说的规则判所有候选，然后等你。

重启 Shipherd 不影响向导：它从停下的那一步接着做，做完的项不再问。失败的调用在 1、5、15 分钟后自动重试，之后等你按**现在重试**。碰到模型限额只是推迟，不算一次尝试。之后的一遍不再需要的项（分组变了，或者规矩不再是候选）直接去掉，不再重试。分析失败的 PR 在**分析记录**页的分析队列里重试，不在这里。**取消**是最终的：还在跑的那一遍之后什么都不写。不必等重试：第一遍做完总结就出来了，里面写着有几项没做完，重试成功后总结会更新。

总结里有分析了、失败、跳过的 PR 数，候选数，推荐接受的（文字的、可做成检查的），合并的，按原因数的搁置和已覆盖的，抽查通过率（以及复核是不是只能用同一个模型），还有向导一共调了几次模型。**全部接受**在一个批次里确认推荐的规矩，一次**撤销**全部还原；抽查越线时它不显示，并点名最弱的指标。搁置的按原因分组：可以拉回一条或整组（每条记成一个校准样本），也可以整组拒绝。改了准入策略里的线以后，**按现在的线重新计算**只重算分数和结论，不重新分析；有缓存的回答直接用，只有以前没判到的规矩（比如新的线现在放过去的）才问模型，失败的项也不重试（那是**现在重试**做的）。之后被你拉回、拒绝或在别处确认过的搁置规矩不再列出。

### 校准

**校准**标签页从每个分数段（达到准入线、两条线之间、低于淘汰线）各抽最多五条打过分的规矩，问你该不该接受；每条都能展开看分项。正好在淘汰线上的算两条线之间；分数高但清晰度低于 `score.minClarity` 的算流水线搁置的。只能判这一次抽出来的规矩。每次判都记成一个校准样本，和你推翻流水线时自动记的放在一起；同一批里重判一条会替掉先前的判断。页面上有每个分数段判了几条、其中几条该接受，这一批和全部样本与流水线的一致率，以及评分的权重和线（可以就地改）。**记为已校准**把时间记进 `admissionCalibratedAt`，准入策略编辑器里「还没有校准过」的提示随之消失。

### 回测、自动升级和自动降级

可检查的规矩准入之前，Shipherd 拿它起草的检查在范围里每个仓库最近 `backtest.recentPrs` 个合并 PR 上回测。diff 和行内评论用本地 clone 里的 `gh` 拿，存在库里（重启或让路以后接着拿），检查只跑每个 PR 加的那些行。历史上不跑任何命令：`run_command` 类的检查不回测。

- **召回**：规矩出处的那些评审评论里，检查能抓到的比例：在评审人当时看的那版文件上跑检查，评论那一行前后 `backtest.lineTolerance` 行内有违规就算抓到。
- **误报**：PR 新加的行上、离这个 PR 的任何行内评论都不近的命中。每条规矩最多 `backtest.judgeSample` 个交给模型（任务 `backtest_judge`）判是不是真的违规；设成 `0` 时没对上评论的命中都算误报。
- 召回低于 `backtest.minRecall` 的规矩搁置为 `backtest_recall`，误报率高于 `backtest.maxFalsePositiveRate` 的搁置为 `backtest_fp`；否则两个数一起变成分数里的**可验证性**。
- 没有本地 clone、`gh` 不能用（没装：马上；一直失败：试三次以后）、没有可用 PR 的仓库不回测。检查的回测只算它范围里的仓库。`backtest.allowUntestedShadow` 开着时规矩照样打分（不算可验证性，分数封顶），关着时搁置为 `untested`。

**检查**标签页上每条检查显示回测结果（PR 数、命中、召回、误报率、当前代码里的存量违规）、分数、被绕过和被无视的次数，以及**重新回测**。每小时的复查也会给当前定义还没有回测结果的启用检查（手写的、导入的、改过的）排上回测。初始化向导在分析之后回测范围里的每个仓库；批次抽查会用到这一批的覆盖率和总体回测数字。

**自动升级。** `shadow.autoPromote` 开着时，Shipherd 每小时复查一次检查。影子运行的检查满足这些条件就升为强制：启用着、是拦截级别（不只是提醒）、回测通过、分数不低于 `score.admitLine`、运行了至少 `shadow.minPrs` 个 PR 或 `shadow.minDays` 天、失败至少 `shadow.minHits` 次、发现的问题至少 `shadow.minAdoption` 被改掉、误报（你对命中的判断，加上模型对抽样的判断；`backtest.judgeSample` 是 `0` 时没人标的命中都算误报）不超过 `shadow.maxFalsePositiveRate`。采纳率只看编辑时的命中：push 前跑的检查没有「改好了」的记录，不会自动升级。检查标签页上显示每条影子检查到了哪一步、还差什么。一次复查升级的检查合成一个带理由的批次，**轮到你**页「运行情况」的「Shipherd 的其他提醒」里会提醒，可以**撤销**。批次里的检查之后都改过的话，撤销什么都不恢复，提醒留着。你撤销过升级、或者自己改回影子的检查，在你清除复查标记以前不会再自动升级。

**自动降级。** `demote.enabled` 开着时，强制的拦截检查在拦下至少 `demote.minEvents` 次以后，被绕过（压制注释、`--no-verify`、关掉 hook、改了快照）或被无视（只有编辑时的拦截才算）的比例达到 `demote.maxBypassRate`，就会降级。另一个理由是强制以后 `demote.noReductionPrs` 个 PR 里同类评审评论没有减少，它要用评审评论的趋势，Shipherd 现在还不记，所以暂时不会触发。`demote.to` 是 `shadow` 时，Shipherd 自动升上去的检查降回影子模式，是一个可撤销的批次；别的检查，或者 `demote.to` 是 `review` 时，只在检查标签页上标**待复查**。**清除复查标记**去掉它，Shipherd 从那一刻重新统计拦截、绕过和修复。提醒在「Shipherd 的其他提醒」里留 14 天。

**阈值复查。** 撤销自动升级或降级、在自动升降级之后 14 天内手动改回模式，都记成校准样本；手动把影子检查改成强制也算一个。每 `review.intervalDays` 天、新样本够 `review.minSamples` 个时，Shipherd 看 `score.admitLine`、`backtest.maxFalsePositiveRate`、`shadow.minAdoption`、`shadow.maxFalsePositiveRate`、`demote.maxBypassRate` 稍微改一点（最多差 0.05）会不会更常和你一致。建议出现在**校准**标签页上，**采用**会写进全局准入策略，是一个可撤销的批次。`backtestThresholdReviewAt` 记的是上一次复查的时间，不直接编辑。

### 原则和核心说明

打开 `lessonsPrinciples` 后，Shipherd 每天一次（或者你在设置里按**现在归组**时）让模型找出同一个仓库或产品里讲同一个原则的已确认规矩；一个原则至少要三条规矩。归组是一个可撤销的批次，和规矩本身分开记：撤销以前改规矩的批次不动归组，每天的归组也不会让你撤不了以前的批次。成员没变的原则保留原来的 id，模型的回答有缓存，规矩没变就不花调用。session 说明里，一个原则用一行「原则（N 个案例）」代替它的那些规矩，案例写进说明旁边的一个文件，原则相关时 session 去读。说明里剩下不到三个案例的原则（有的规矩后来被停用或拒绝了）不显示，它的规矩各占一行。打开 `lessonsCoreGuide` 后，说明最多保留 10 条规矩，确认之后被违反得最多的在前。

### 导出文件

复盘规矩页的**导入导出**可以导出全部、一个产品或一个仓库，内容可选全部、只有规矩（含产品）或只有检查（有检查之后）。文件是 JSON：

```json
{
  "format": "shipherd-config",
  "formatVersion": 1,
  "exportedAt": 1763337600000,
  "shipherdVersion": "3.0.0",
  "scope": { "kind": "all" },
  "options": { "content": "all", "includeSourceUrls": false },
  "sections": { "products": [], "policies": [], "lessons": [] }
}
```

- **没有密钥、没有本地路径、没有评论原文、没有分数。**规矩带正文、理由、归属（仓库 slug 或产品名）、状态、准入、范围字段、出现次数，以及来自几条出处、几个不同的 PR。只有勾选**带上出处链接**时才带 PR 链接。
- 更新版本的 Shipherd 导出的文件（`formatVersion` 更高）会被拒绝；旧版本的先升级。这个 Shipherd 不认识的部分跳过并列出来。
- 每个条目都有一个稳定的**指纹**，按内容算，不用本地 id：规矩是规范后的正文（去首尾空白、连续空白合一、小写）加归属和路径通配；产品是名字；策略层是全局 / 产品名 / 仓库 slug。
- **预览**把每个条目标成新增、改动、冲突（决定不一样：规矩的状态、强度或可检查性，产品的仓库，或策略的值）、不变，或删除（只在替换时）。
- **合并**加入新的条目，改动和冲突默认留本地的；文件里没有的本地条目不动。**替换**先写一份 `<SHIPHERD_HOME>/backups/before-replace-<时间>.json`（写失败就什么都不改），默认用导入的，并删掉文件范围里本地有、文件没有的条目。两种方式都可以一键切成**全部用导入的**或**全部用本地的**，也可以逐行选。
- 导入的规矩先是**待确认**（文件里已拒绝的照样拒绝），整个导入是一个批次，可以在批次标签页撤销。这台机器上没有克隆的仓库会加进来，本地路径留空，标成**这台机器上没有克隆**；Shipherd 看到它的克隆之前不能分析它的历史。状态冲突会把一条本地没确认的规矩变成已确认时，那一行会注明。
- **起步包**导出已确认的规矩，不带归属、状态、出现次数和出处。导入起步包时会问加到哪个仓库或产品。
- **模型路由**（`models` 部分）只在导出全部内容时才有：登记的模型（名字、档位、账号、单价、备注）、每档的降级链、任务覆盖、你自己加的和学到的限额规则。健康状态、花费、事件、未识别的报错和规则备注都留在本机。导入的模型和规则先是**停用**的，所以导入本身不会改变用哪个模型，要到**设置 → 模型路由**里启用；本机已有的保留本机的启用状态。档位、账号、单价、降级链顺序或任务设置不同算冲突。路由的表不在批次撤销里：不要的在模型路由页删掉，或者用替换导入之前写的那份备份恢复。
- **权限档案**（`permissions` 部分）：每个仓库确认过和不再提的规则，按仓库名。还在等你确认的不导出。导入时每条规则都再检查一次，不是只读的直接拒绝。导入的「确认」先在 **设置 → 打断与通知** 里等你在这台机器上再确认一次；导入的「不再提」直接生效。同一条规则状态不同算冲突。

## 检查：每次编辑都跑的确定性规则

检查是不用模型就能判断的规则：禁止的写法、import 边界、注释规则、要跑的命令。检查在规矩页的**检查**标签里，和准入策略一样分三层（全局、产品、仓库；越近的层越优先，仓库可以按 key 关掉或覆盖继承来的检查）。可以手写，也可以在一条规矩上点**做成检查**：Shipherd 用模型从规矩文字起草一条，你看过再保存。没法机械检查的规矩可以标成**只有文字**。

- Shipherd 把打开的检查写到 `<SHIPHERD_HOME>/checks/snapshot.json`。Shipherd 的 session 里每次 `Edit`、`Write`、`MultiEdit` 之后，`shipherd-hook check` 只读这个文件（从不碰数据库）；agent 跑 `git push` 时，`shipherd-hook check-push` 跑 push 阶段的检查。Shipherd 之外的 session 不受影响，你自己的 Claude Code 配置从不改动。
- hook 从文件所在的文件夹找仓库（它的 `origin` remote）。没有 remote 的文件夹、读不了的快照、别的 Shipherd 版本写的快照，一律放行，并在 session 上记**没有检查**。
- 路径 glob（`globs`、`excludeGlobs`）匹配相对仓库根目录的路径，`/` 和 `\` 都行。
- **类型。**`forbidden_pattern`：新写的行里不许出现的正则（或原样文字）。`import_boundary`：匹配 `forbid` 的 import（仓库路径 glob 或 `electron` 这样的包名）不许出现，匹配 `allow` 的除外。`comment_policy`：说代码是临时的注释（内置中英文关键词，比如 *temporary*、*workaround*、*TODO*、临时、先这样）要带一个符合 ticket 格式的 ticket 号；这条内置检查一开始就有，但是**关着**。`run_command`：一条 shell 命令（macOS、Linux 用 `/bin/sh`，Windows 用 Git Bash）；`{file}` 换成改动的文件，作为参数传进去，绝不拼进命令文字；环境变量 `SHIPHERD_CHECK_FILE` 里也有这个文件。编辑阶段的命令没写 `{file}` 时，只有一条简单命令（`eslint --max-warnings 0`）才把文件接在最后；复合命令（带 `;`、`&&`、`|`、重定向或子 shell）原样执行。编辑阶段的命令只对改动的文件跑；push 阶段的命令在 push 前跑一次。
- **模式。**新建的检查、导入的检查都从**试运行**开始：命中只记录。命中列表看着对了再切到**强制**。强制的 `block` 检查用 hook 的 block 把失败告诉 agent（改动保留，要求它修根本原因）；强制的 `warn` 检查和所有试运行命中只加一条提示。只报这次编辑新引入的问题，每个只报一次。
- 超时的命令连同整棵进程树一起被杀掉，记为**没能检查**，编辑放行。正则（禁用写法、ticket 格式）每次编辑最多跑两秒；更久的（比如 `(\w+\s?)+$` 这样的嵌套量词）会被停掉，同样记为**没能检查**。调大时间限制之前就开着的 session 仍按它开始时的限制。push 阶段的检查失败会拦下 `git push` 并说明原因。合并闸门不变。
- 检查标签里每条检查显示命中次数、agent 之后改掉了多少（采纳）、你标了多少误报。超过一年的命中记录会删掉。

| 设置 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 在 session 里跑检查 | `checksEnabled` | `1` | `1` 或 `0`。关掉后新的 session 不挂 hook，已经在跑的 session 一律放行。 |
| 每次编辑后检查的时间（秒） | `checksEditTimeoutSec` | `8` | `1` 到 `30` 的整数。一次编辑的所有编辑阶段检查共用。 |
| push 前检查的时间（秒） | `checksPushTimeoutSec` | `600` | `10` 到 `3600` 的整数。所有 push 阶段检查共用。 |

检查跟着其它配置一起导出、导入（**只导出检查**或**全部**）。按 key 和层对应；行为上的改动（类型、参数、glob、严重程度、开关）算冲突，选了导入的就回到试运行；只改名字或提示语的，模式照旧。新来的或命令文字变了的 `run_command` 检查导入后是**关着**的，因为试运行也会执行命令：预览里能看到每条命令，看过再打开。只有检查的文件即使用替换导入也不会删掉你的产品。替换导入从不删除内置检查。

## 预审、就绪和风险

Shipherd 能在你 review 之前先把一遍关。默认全是关着的或只读的：什么都不配置时，只在 ticket 页和 epic 页看到每个 PR 的就绪情况和风险。

| 设置 | 键 | 默认 | 取值和说明 |
|------|-----|------|-----------|
| 预审 | `preReviewEnabled` | `0`（关） | `1` 或 `0`。打开后：开发 session 的说明文件要它交完成证据（`submit_evidence`：跑了哪些检查、命令和输出，每条验收条件怎么满足，界面改动的截图，没跑的检查和原因），并写明提 PR 前会预审；Shipherd 在那个提交上复跑仓库档案里的命令、核对证据，把 diff 和这个仓库确认过的规矩、检查结果对照，把违规清单送回 session；Shipherd 的 PR 有新 PR、新提交时也补一次预审；每次预审后写一份 review 简报。 |

每个 PR 有**就绪度**（六个条件：CI 和 block 级检查、预审无违规、证据齐全、没有未处理的 review 评论、能合并、描述写了改了什么、为什么、怎么验证）和**风险等级**（低、中、高，带理由：迁移、登录权限、公开 API、配置、CI 配置、改动大、跨多个仓库、检查有警告、缺证据、ticket 类型）。两者都不调模型、不对 GitHub 做任何事：只用来解释和给「待 review」排序。预审关着时，「预审无违规」「证据齐全」两条显示为没开，不算缺失。

**review 简报**是一页（改了什么、为什么，风险，核实过的证据，预审结论，建议重点看的文件，已知取舍）。默认只在 Shipherd 里看；「贴到 PR」把它写进 PR 描述的 `<!-- shipherd:brief -->` 块里（块以外的描述不动），记进审计。每次预审后自动贴是对外动作 `externalPrBriefPost`（见下一节）。

就绪条件、证据要求和风险规则是三层策略（全局、产品、仓库），在设置页「预审和就绪」里改，跟着配置一起导出：`readiness.<条件>.enabled`、`readiness.descriptionMinChars`（80）、`readiness.shouldBlocks`（`false`；打开时预审干净但有「应该改」的发现也算预审没过）、`readiness.whatWords`、`readiness.whyWords` 和 `readiness.verifyWords`（另外算作讲了做什么、为什么、怎么验证的词，加在内置的词后面）、`evidence.require.<test|lint|typecheck|build>`（`auto` = 按仓库档案）、`evidence.rerun`（`all`、`fast` 或 `off`）、`evidence.rerunTimeoutSec`（600）、`risk.paths.<类别>`（额外的 glob，各层取并集加在内置列表上；`risk.paths.<类别>.builtin = false` 去掉内置列表，迁移类除外）、`risk.size.*` 和 `risk.types.*`（`label=类型`、`前缀=类型`、`类型=等级`）。

## 对外动作

有些功能会让 Shipherd 代你在本机以外留下东西，比如在 PR 评论下回复。现在用到的是导出成仓库规则的**推送分支**和**开 PR**，以及[评论与 CI](#评论与-ci) 的**回复 review 评论**、**标记评论已解决**和**重跑 CI**，[栈](#栈)的**强推（force push）**、**推送分支**、**开 PR**、**改 PR 标题**、**改 PR 描述**、**加减 PR label**和**发 issue**，其余的开关等之后的功能接入时才生效。每一种动作在 **设置 → 对外动作** 里有自己的开关，默认全关。开关关着时 Shipherd 不做这个动作，只记一条"跳过"。做了的、失败的、跳过的动作都列在 **审计** 页的 **对外动作** 里（只读的[检查更新](#常规)也记在这里），写着仓库、ticket、目标和发了什么，保留时间由下面的 **审计保留天数**（`auditRetentionDays`）决定。**推送通知** 由[通知](#通知)使用。

| 设置 | 键 | 默认值 | 允许做什么 |
|------|----|--------|------------|
| 回复 review 评论 | `externalCommentReply` | `0`（关） | 在 PR 的评论下以你的账号回复。 |
| 标记评论已解决 | `externalCommentResolve` | `0`（关） | 把 PR 上的 review 讨论标成 resolved。 |
| 改 PR 描述 | `externalPrDescriptionEdit` | `0`（关） | 改写 PR 的正文。 |
| 加减 PR label | `externalPrLabel` | `0`（关） | 给 PR 加或去掉 label。 |
| 开 PR | `externalPrOpen` | `0`（关） | 用 `gh` 新开 PR。栈里把 PR 的 base 改到 trunk、把 PR 标成 ready for review、把退回成普通分支的 draft 关掉，也归它管。 |
| 推送分支 | `externalBranchPush` | `0`（关） | 把 Shipherd 建的分支（比如导出成仓库规则的分支）推到远端。 |
| 改 PR 标题 | `externalPrTitleEdit` | `0`（关） | 改 PR 的标题。 |
| 强推（force push） | `externalForcePush` | `0`（关） | 改写远端分支的历史。 |
| 重跑 CI | `externalCiRerun` | `0`（关） | 重新触发失败的 CI。 |
| 发 issue | `externalIssuePost` | `0`（关） | 在 tracker 或 GitHub 上建 issue、发评论。 |
| 推送通知 | `externalPushNotification` | `0`（关） | 往外部服务（比如手机推送、聊天工具）发通知。 |
| 贴 review 简报 | `externalPrBriefPost` | `0`（关） | 每次预审完成后把 review 简报写进 PR 描述。「贴到 PR」按钮不受这个开关影响，照样记进审计。 |
| 自动接活：到 tracker 提问 | `externalIntakeTrackerComment` | `0`（关） | [自动接活](#自动接活)发现 ticket 缺信息时，让 session 或全局总控在 tracker 的 ticket 上留言问。 |
| 自动接活：改 ticket 状态 | `externalIntakeTrackerStatus` | `0`（关） | 自动接活开的 session 先把 tracker 上的 ticket 改成进行中。 |
| 请 bot review | `externalPrReviewRequest` | `0`（关） | 工作流程走到 bot review 时，由 Shipherd 请 Copilot review，或在 PR 上评论 `@codex review`。关着时提醒 session 自己请。 |

每个开关填 `1` 或 `0`。

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 审计保留天数 | `auditRetentionDays` | `90` | 1 到 3650。审计页上的对外动作记录和[通知记录](#通知)保留多少天。更早的记录在启动时和有新记录写入时清掉。 |

## 仓库现状：每个仓库自己已经在查什么

规矩页的**仓库现状**标签会读出一个仓库自己已经在查什么（lint、类型检查、测试、构建、安全和格式工具），以及每样在哪一步跑：提交时、推送时还是 CI。不点**扫描**或**全部扫描**就什么都不发生。**全部扫描**一次扫三个仓库，其余排队。扫描只读仓库，不改文件、不跑命令、不碰分支。指到仓库外面的符号链接不读。

- **怎么读。**先看标记文件（比如 `package.json`、`pyproject.toml`、`go.mod`、`.pre-commit-config.yaml`、ESLint 和 TypeScript 的配置），再按关键词看 CI 配置里的命令（GitHub Actions、GitLab CI 等）。这两步还不够、而且**认不出的仓库用模型补全**开着时，Shipherd 让模型来读仓库（只读工具，走模型路由的 `repo_scan_infer` 任务）。模型补上的标成**模型推断**，置信是**低**。
- **monorepo。**每个项目目录（根目录下面的每个 `package.json`、`pyproject.toml`、`go.mod`……）分开列，每条检查归到自己的目录。
- **置信。**CI 里跑的命令或明写的脚本是**高**；只配了工具的是**中**；模型猜的是**低**。低置信的结果从不自己变成检查。
- 本机没有副本、读不了或者不是 git 仓库的会**跳过**，并写明原因。
- **建议先补基础检查。**缺 lint、类型检查或测试（这门语言有的话）的项目会列在这条建议下。
- **可以直接用的检查。**仓库已经在跑的每条命令都能变成一条复用这条命令的 `run_command` 检查，这样 Shipherd 的 session 跑的就是仓库 CI 会跑的。勾上再点**建**，建出来都在试运行。低置信的要先勾**我看过这条命令，确认要用**才会建。规矩上的**做成检查**也会拿到仓库现状，起草时复用仓库的命令。
- **session 说明里的仓库档案。**ticket 和修复 session 的说明里会写上它自己那几个仓库的简短档案：怎么装依赖、构建、跑全部测试、跑一个测试、lint 和类型检查，目录约定和 CI 步骤，每个仓库最多**每个仓库写进 session 说明的字数上限**个字。别的仓库不会写进去。扫描之后配置文件改过的档案会标上可能过时；**配置文件改了就在后台重扫**开着时，Shipherd 在启动后重扫（不调模型）。
- **标记文件表。**哪个文件说明用了哪个工具是数据，不是代码：内置的是默认值，在全局、产品或仓库这一层可以改字段、停用或加新的（JSON）。越近的层越优先。

### 存量扫描和导出成仓库的规则

**检查**标签里，一条检查下面的**存量 / 导出**对一个仓库有两个动作：

- **扫描存量**用这条检查把仓库里所有受 git 管的文件扫一遍，显示**存量 N 处**和明细（每次 200 处）。在后台跑，可以停；最多看**存量扫描最多看多少个文件**个文件。`run_command` 检查只有点了按钮才扫，因为那会对每个文件跑一次命令。
- **导出成仓库的规则**把检查变成仓库自己的规则，这样不只在 Shipherd 的 session 里跑，所有人都会跑。Shipherd 按仓库现状挑接法：`pre-commit` hook（禁用写法用 `pygrep`）、包名的 import 边界用 ESLint 的 `no-restricted-imports`、命令接到 lint-staged 或 husky，都不行就在仓库自己的运行环境里写一个小检查脚本（`scripts/shipherd-checks/<name>.mjs`、`scripts/shipherd_checks/<name>.py` 或 `scripts/shipherd-checks/<name>.sh`），接到上面有的那几个里，再加一个 `package.json` 脚本或 Makefile 目标。写在远端默认分支上新开的分支 `shipherd/check-<name>-<key>` 里，worktree 在 `<SHIPHERD_HOME>/exports/<id>`，本地提交（git 没有 `user.name` / `user.email` 时只暂存）。你自己的 checkout 从不碰，Shipherd 在那里提交时也不跑仓库自己的 git hook。生成的 `.sh` 文件和 husky hook 会写进 `.gitattributes`（`text eol=lf`），这样开了 `core.autocrlf` 的 Windows checkout 也不会把它们弄坏；在 Windows 上它们用 Git for Windows 自带的 `sh` 跑，git hook 本来就用它。然后就停：你能看到分支、文件和改动。导出做到一半 Shipherd 退出了的话，下次启动时会清掉没做完的 worktree 和分支。
- **推送分支**和**开 PR**是另外的按钮，受对外动作开关控制，**默认关着**；每次尝试都写日志。**丢弃**删掉 worktree 和本地分支。
- 不能导出时 Shipherd 会说明原因，什么都不建：仓库没有本地副本或还没扫描过；检查要用 Node 或 Python 而仓库两个都没有；正则用了目标工具写不出的语法（比如 `\p{…}`）；命令没有可以接的 hook 管理工具；仓库的 CI 已经在跑这条命令。

| 设置 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 认不出的仓库用模型补全 | `baselineInfer` | `auto` | `auto` 或 `off`。`auto`：标记文件和 CI 不够时，你点的扫描会问模型（只读）。后台重扫从不调模型。 |
| 配置文件改了就在后台重扫 | `baselineAutoRescan` | `1` | `1` 或 `0`。只对已经扫描过的仓库。 |
| 每个仓库写进 session 说明的字数上限 | `baselineGuideChars` | `1200` | `200` 到 `4000` 的整数。 |
| 存量扫描最多看多少个文件 | `legacyScanMaxFiles` | `50000` | `100` 到 `500000` 的整数。 |

**导入导出：**标记文件表（`baseline_rules` 部分）跟着**全部**和**只导出检查**走；产品用名字，无效的规则跳过。仓库现状（`baselines` 部分）只有勾了**带上各仓库的现状扫描**才导出，不带本地路径、文件哈希和规矩文字。导入的现状只有比本机的新才收（将来的时间按现在算），标成导入、可能过时，本机第一次扫描就把它换掉。在那之前它不写进 session 说明，从它起草的每条检查都要先勾**我看过这条命令，确认要用**才会建，因为这些命令来自别的机器。命令是新的或改过的标记规则导入后是停用的，你看过命令再启用；命令里有换行的直接不收。导入从不删除本机的仓库现状，替换导入也一样。

## 评论与 CI

**设置 → 评论与 CI** 管两个闭环，让 PR 不用你来回传话也能往前走。两个都默认关；关着时 Shipherd 和以前一样。每个键都能在全局、产品、仓库三层设置，按键合并，规则和[准入策略](#准入策略)一样（仓库自己的值，否则产品的，否则全局的，否则默认值；几个产品设得不一样时名字靠后的产品生效，页面上会提示）。

### 评论闭环

`comments.enabled` 开着的仓库，PR 监视每读一次开着的 PR，Shipherd 就读它的 review thread、review 正文和 PR 评论，把每条新评论分成四类：

- **要改**：要求改代码；
- **提问**：reviewer 在问问题；
- **可忽略**：致谢、表态、位置已过时、你已经回复过、Copilot 的总览，或者匹配 `comments.ignorePatterns`；
- **需要人判断**。

先用规则：已经 resolve 的 thread、你自己的评论和其他机器人的评论跳过，带 ```` ```suggestion ```` 的算要改，上面那几种情况算可忽略。规则判断不了的，`comments.useModel` 开着时经模型路由的 `comment_classify` 任务交给模型；模型也给不出结果的，或者模型关着时规则判断不了的，都算需要人判断。

Copilot 和人的评论分开设置（`comments.copilot`、`comments.human`）。设成 `auto` 时，要改的（`comments.questions` 是 `session` 时还有提问）送进这个 PR 分支所属的 session，也就是 CI 结论送去的那个 session。评论放进这个 session 的信箱，不会打断它：在干活就在下一次调用工具时读到，停着就直接输入进去。一次最多送 `comments.maxPerDelivery` 条，带文件、行号和原文。设成 `review`（人的评论默认这样）时，评论在 ticket 的 **评论** 标签里等你看，**轮到你** 页会有一张卡片。该送进 session 却等了 30 分钟还没送出去的评论也会有卡片。设成 `off` 就不处理。

push 之后，Shipherd 在新的 head 上核对送出去的每条评论：行内评论的 thread 在别处 resolve 了、位置过时或没了，或者这次的改动碰到了它那几行（前后 3 行以内），就算已处理；review 正文和 PR 评论有新提交就算已处理。push 两次还没改到的，交回给你。已处理的评论，`comments.reply` 开着时 Shipherd 回复"已在 <提交> 中修改。"（标明是 Shipherd 的自动回复），`comments.resolve` 开着时 resolve 这个 thread。这两件事还要各自打开[对外动作](#对外动作)里的开关（`externalCommentReply`、`externalCommentResolve`），每次尝试都记在审计页上。

在 ticket 的 **评论** 标签里，可以把评论送进 session、改分类、忽略，或者再回复一次。

| 键 | 默认值 | 取值 | 作用 |
|----|--------|------|------|
| `comments.enabled` | `false` | `true` / `false` | 启用评论闭环 |
| `comments.copilot` | `auto` | `auto` / `review` / `off` | Copilot 的评论怎么办：送进 session、先给你看、不处理 |
| `comments.human` | `review` | `auto` / `review` / `off` | 人的评论怎么办，同上 |
| `comments.questions` | `user` | `user` / `session` | 提问等你回答，还是送进 session |
| `comments.useModel` | `true` | `true` / `false` | 规则判断不了时问模型 |
| `comments.ignorePatterns` | 无 | 列表 | 匹配任意一条的评论算可忽略 |
| `comments.maxPerDelivery` | `10` | 整数 1–50 | 一次最多送进 session 几条 |
| `comments.reply` | `true` | `true` / `false` | 评论处理后自动回复（还要开 `externalCommentReply`） |
| `comments.resolve` | `true` | `true` / `false` | 评论处理后自动 resolve（还要开 `externalCommentResolve`） |
| `comments.replyLanguage` | `en` | `en` / `zh` | 回复用的语言 |

### CI 分类

仓库的 `ci.enabled` 开着时，CI 失败的结论先分类再告诉 session。失败的检查按 workflow run 分组；不是 GitHub Actions run 的检查照旧送。先用规则：

- **环境问题**：run 没分到 runner，或者在准备 job 时就失败了；日志匹配内置的环境类关键字（网络超时、DNS 错误、包仓库或限流错误、runner 被关、磁盘满）或 `ci.envPatterns`；或者失败的那一步在安装、checkout、下载，日志看着像网络问题；
- **代码问题**：日志匹配内置的代码类关键字（类型错误、断言、测试失败、lint 或编译错误）或 `ci.codePatterns`。同时命中两类时按代码问题算；
- **flaky**：失败的检查或测试在 flaky 名单上（`ci.flakyTests` 加上 Shipherd 自动列入的）。

规则判断不了的，`ci.useModel` 开着时经模型路由的 `ci_classify` 任务交给模型，否则按代码问题算。

代码问题照旧送进 session。环境问题和 flaky 用 `gh run rerun <run> --failed` 重跑，最多 `ci.maxReruns` 次，不告诉 session；这要打开[对外动作](#对外动作)里的 `externalCiRerun`，关着时照常送，并注明自动重跑没开。重跑通过了，session 收到平常的"CI 全部通过"。重跑后又是同样的失败，按代码问题送；超过次数还在失败，送的时候标上"可能是 flaky"。重跑 6 小时还没有结果的也照常送。

每次重跑后通过，都按检查名和测试名记一笔，连同从第一次失败起浪费的时间。一个名字在 `ci.autoListDays` 天里重跑后通过了 `ci.autoListThreshold` 次，就自动列入 flaky 名单。同一页的 **flaky 名单** 列出次数和浪费的时间，可以手动列入或移出。再下面是两个闭环最近 30 天做了什么。

列表在编辑器里一行一条。用 `/…/` 包起来的是正则，其余按子串匹配，都不区分大小写。

| 键 | 默认值 | 取值 | 作用 |
|----|--------|------|------|
| `ci.enabled` | `false` | `true` / `false` | 启用 CI 分类 |
| `ci.maxReruns` | `2` | 整数 0–5 | 同一个失败最多自动重跑几次 |
| `ci.useModel` | `true` | `true` / `false` | 规则判断不了时问模型 |
| `ci.envPatterns` | 无 | 列表 | 额外的、算环境问题的日志模式 |
| `ci.codePatterns` | 无 | 列表 | 额外的、算代码问题的日志模式 |
| `ci.flakyTests` | 无 | 列表 | 已知 flaky 的检查或测试 |
| `ci.autoListThreshold` | `3` | 整数 1–100 | 重跑后通过几次就列入 flaky 名单 |
| `ci.autoListDays` | `30` | 整数 1–365 | flaky 统计和自动列入看最近几天 |

## 打断与通知

**设置 → 打断与通知** 汇集了两类功能：让 session 少停下来等你，以及在真要你的时候告诉你。这里的东西在你设置之前都是关着的，或者不起作用。

### 权限档案

Shipherd 在本机读最近 30 天的 Claude Code transcript（不会传出本机），按仓库数出成功跑过的命令和 MCP 工具。跑过至少 3 次、出现在至少 2 个 session 里的，作为候选。你确认的规则写进这个仓库里每个 Shipherd session 的 `--settings` 文件，和 Shipherd 自己的工具放在一起，session 就不再停下来问。你自己的 Claude Code 设置不会改动。

只有只读的命令才算数。检查是固定的，每个 session 启动前都会再跑一遍：

- 可以：`gh pr view` 这类只读子命令、不带 `--output` 的 `git log`、不带 method 和字段的 `gh api`。
- 永远不行：
  - 会写、删、推送或运行别的程序的；
  - 用 `&&`、`|`、`;` 连起来的；
  - 带重定向、`$`、反引号或通配符的；
  - 跑仓库自己脚本的。

在一个仓库里被你拒绝过一次的命令，不会再在这个仓库里出现。**解释** 会请低档模型（任务 `permission_profile`）给每个候选写一行说明。它不能加规则；它标为有风险的候选默认不勾；MCP 工具只能按名字判断，也默认不勾。首次运行的向导里不再有这一步，只在这里。规则随时可以删。导入的规则要等你确认。

| 设置 | 键 | 默认值 | 作用 |
|------|----|--------|------|
| 使用权限档案 | `permissionProfiles` | `1`（开） | 把确认过的规则写进 session。没有确认过的规则时，什么都不变。 |

### 选择和缺信息

| 设置 | 键 | 默认值 | 作用 |
|------|----|--------|------|
| 选推荐项 | `interruptChoiceRule` | `0`（关） | 告诉 ticket session 和总控：有一个推荐项，又没有特别情况（不可撤销或对外的动作、花费、超出 ticket、你说过的偏好）时，就选它，继续做，并用 `report(kind: "choice")` 记下来。 |
| 默认答案 | `interruptChoiceDefaults` | `0`（关） | 带选项的问题里出现你设的关键词时，马上用你的答案（或 session 推荐的那个选项）回答。session 会被告知这是你的默认答案。 |
| 先查再问 | `interruptSelfServe` | `0`（关） | 问你要信息之前，session 先查：通过 tracker 查 ticket、代码和文档、记忆，epic 里的 ticket session 还会问 epic 总控。 |

这样做出的每个选择都列在 **替你做的选择** 里，新的在前，直到你标为看过。在 **效果** 页上它不算人介入，算一次自动解决的打断。

### 通知

真要你的时候，Shipherd 可以推送到一个 HTTPS webhook：`ntfy` 一类的 topic，或者聊天工具的 incoming webhook。开关是对外动作里的 **推送通知**（`externalPushNotification`）。开关关着时什么都不发，通知记录也是空的。

- **地址** 用系统钥匙串（macOS 钥匙串 / Windows DPAPI）加密保存。界面上只显示 host，导出时不带。系统加密不可用时，Shipherd 拒绝保存。
- **发什么**：默认只说是哪类事、有几件，比如「2 件事等你决定」。一分钟里同一类事合成一条发。问题原文、评论原文、路径和仓库名永远不发。
- **记录**：发出的、失败的、因为安静时段没发的、被过滤掉的，都列在 **通知记录** 里，保留时间和 `auditRetentionDays` 一样。

| 设置 | 键 | 默认值 | 作用 |
|------|----|--------|------|
| 格式 | `notifyFormat` | `json` | `json` 发 `{"text", "content", "title", "event", "count"}`，聊天工具的 webhook 都认；`ntfy` 发纯文本，带 `Title` 头。 |
| 事件 | `notifyEvents` | 全部六种 | 逗号分隔：`decision_needed`（session 问了你一件事）、`pr_high_risk`（高风险 PR 等你 review）、`pr_ready`（PR 可以提交了）、`cost_breaker`（花费熔断暂停或停止了工作）、`review_comment`（同事在 PR 上留了评论）、`intake_decision`（[自动接活](#自动接活)有个 ticket 要你决定）。 |
| 带上编号 | `notifyDetails` | `0`（关） | 消息里加上 ticket 号和 PR 号。 |
| 安静时段 | `notifyQuietHours` | 空 | `HH:MM-HH:MM`，本地时间，可以跨午夜，比如 `22:00-08:00`。这段时间里的事件不推。 |

**发一条测试** 往保存的地址发一条消息。开关关着时什么都不发，页面上会说明，对外动作的审计里记一条「跳过」。

事件从哪来：`decision_needed` 是没被默认答案答掉的新问题；`pr_high_risk` 和 `pr_ready` 来自 PR 的风险和阶段判断；`cost_breaker` 来自花费熔断暂停或停止工作；`review_comment` 是 PR 监视看到 PR 作者和机器人以外的人新留的评论或 review。Shipherd 第一次读到一个 PR 时上面已有的评论不推。

### 效果页上的前后对比

**效果** 页以这些功能第一次生效的时间为界（确认了一条权限规则，或者打开了选推荐项、默认答案、先查再问），比较前后各一段相同长度的整天（每段最多 30 天）；生效当天一半在前一半在后，不算在任何一边。每一边列出：合并的 Shipherd PR、每个 PR 的人介入次数和等人的时间、每天各类打断的次数、自动解决的打断、为卡住的 session 开的修复 session。一个都还没打开时，面板会说明从打开那天开始比较。第一次生效的时间只存一次，在 `interruptReductionSince` 里（不直接编辑）。权限档案自动解决的打断是在 session 停下时从它的 transcript 里数的，是一个上限：其中有些 Claude Code 本来也不会问。

## 栈

栈是同一个仓库里一串互相依赖的 Shipherd 分支：栈底基于 trunk，往上每一层基于下面那层。只有栈底开 PR 给人 review；上面的层在轮到它当栈底之前都只是分支，所以 reviewer 一次只看一个小 PR。

栈由 epic 总控建。epic 总控调用 `create_ticket` 时带上 `stack_on`，新 ticket 的分支就从另一个 ticket 的分支开出来，并接到那个 ticket 所在栈的顶上（它不在栈里就新建一个）；也可以用 `stack_define` 把已有的分支定成栈。`list_stacks` 看栈，`stack_rebase` 马上 rebase 一次，`stack_layer_mode` 在上面某层要跑 CI 时把它开成 draft PR，或者把 draft 关掉。epic 总控看得到有一层是它的 ticket 的栈，但只能改属于它这个 epic、或者没合并的层都是它的 ticket 的栈。全局总控也有这几个工具，但只接受它自己开着的终端发来的改动。

栈底的 PR 合并或者 trunk 更新时，Shipherd 把整栈 rebase 到新的基础上：git 2.38 以上用 `git rebase --update-refs`，旧的 git 一层一层来。rebase 在 `~/.shipherd/stack-work` 下单独的 worktree 里做，不碰开着的 session。只有分支没在别处签出着未提交的改动（或者会被新顶端覆盖的未跟踪文件）、它的 session 不在忙、远端也没人推过时，Shipherd 才挪动它，否则稍后再试。挪动之前先把旧的位置存到 `refs/shipherd/stack-backup/…`，「从备份恢复」可以放回去。有冲突时 Shipherd 停下、原样复原，把冲突文件和要执行的 `git rebase --onto` 命令放进那一层 ticket 的 session 的信箱（同一层新的冲突换掉还没送的旧冲突）；只有「强推」开着时才让 session 把结果推上去。下一次 rebase 接着 session 解好的结果做。冲突 30 分钟没交出去、或者 rebase 卡住或回滚了一天，「轮到你」页会提醒。

栈底合并后，下一层成了新的栈底：Shipherd 把它的 base 改成 trunk，`autoOpenBottomPr` 开着时把它开成 ready 的 PR。draft 层打上 `draftLabel` 的 label，标题注明不用 review。

「全部工作」页底部的「栈与自动接活」折叠里有管理中的栈：从上到下列出每一层的状态、PR、落后 trunk 几个提交、有没有改写过还没推，还有最近一次 rebase 的结果，以及马上 rebase、从备份恢复、开或关 draft、不再管这个栈（分支和 PR 不动，自动检测也不会再把它建回来）这几个按钮。

策略在「设置 → 栈」，和[评论与 CI](#评论与-ci)一样分全局、产品、仓库三层。`autoRebase` 是总开关，默认关；关着时 Shipherd 只看不动。rebase 后推上去（用 `--force-with-lease`）要[对外动作](#对外动作)里的 `externalForcePush`，第一次推一层要 `externalBranchPush`，开 PR 和 draft 要 `externalPrOpen`，往 PR 标题里写栈的位置、往描述里写依赖行要 `externalPrTitleEdit` 和 `externalPrDescriptionEdit`，draft 的 label 要 `externalPrLabel`，总览 issue 要 `externalIssuePost`。这些关着时 Shipherd 只改本地分支，并标出没推的层。

| 键 | 默认 | 取值 | 作用 |
|----|------|------|------|
| `autoRebase` | `false` | `true` / `false` | 允许 Shipherd 改这个仓库里栈的本地分支 |
| `mergeMethod` | `auto` | `auto` / `squash` / `merge` | 栈底 PR 怎么合并；`auto` 按合并结果判断 |
| `rebaseOnMainUpdate` | `true` | `true` / `false` | trunk 更新时 rebase |
| `dailyRebase` | `true` | `true` / `false` | 每个栈每天 rebase 一次 |
| `autosquash` | `true` | `true` / `false` | 某层的 review 评论处理完后把 `fixup!` 提交合进去 |
| `autoOpenBottomPr` | `true` | `true` / `false` | 旧栈底合并后把新栈底开成 ready 的 PR |
| `conflictToSession` | `true` | `true` / `false` | 冲突交给那一层的 session；关着只在「轮到你」页提醒 |
| `draftDemoteDays` | `14` | 1–365 的整数 | 一层当 draft 超过这么多天，「Shipherd 的其他提醒」里建议关掉 |
| `behindCommits` | `20` | 1–10000 的整数 | 栈底落后 trunk 这么多个提交时提醒 |
| `behindDays` | `3` | 1–365 的整数 | 栈底落后 trunk 这么多天时提醒 |
| `overview` | `off` | `off` / `issue` | 把一个 epic 的栈的总览放在一个 GitHub issue 里 |
| `draftLabel` | `stacked` | 1–50 个字，不能有逗号 | draft 层打的 label |

栈的策略和别的策略一样，包含在[备份和导出设置](#备份和导出设置)里。

## 自动接活

自动接活从 tracker 或一个 JSON 文件拉新 ticket，按大小、风险、信息全不全给每个分好类，挑一个模型档位，满足下面的条件就给它开 session 开工。只有它替你定不了时才叫你。默认关着：来源配好**并且**策略里有一层打开 `enabled` 之前，不拉、不存、不开工。

能在来源里写 ticket 的人，就能影响自动开的 session 被要求做什么。Shipherd 把 ticket 原文围起来、当作描述而不是指令交给 session，每个 PR 也照样过预审；但只对你信得过写 ticket 的人的来源打开，拿不准的地方把 `maxRisk` 压低。

### 来源

**设置 → 自动接活**里是来源的设置，全局生效。

| 设置 | 键 | 默认 | 作用 |
|------|----|------|------|
| 从哪里拉 | `intakeSource` | `none` | `none`、`tracker` 或 `file`。 |
| tracker 查询 | `intakeTrackerQuery` | 空 | `tracker` 时必填（空着不拉）：列什么：一句话或 tracker 的查询语法，例如「分给我的、待办状态的 ticket」。Shipherd 跑一个后台 `claude -p`，只能用 `trackerTools` 里的只读工具；Shipherd 自己不连 tracker。 |
| 在哪个仓库里查 | `intakeTrackerDir` | 空 | `tracker` 时查询在哪个绝对路径里跑，这样能找到你项目级的 tracker MCP。空着用仓库映射的第一个路径。 |
| JSON 文件 | `intakeFilePath` | 空 | `file` 时文件的绝对路径，内容是 `{"tickets": [...]}` 或一个数组。每个 ticket 要有 `key` 和 `title`，可以有 `description`、`type`、`labels`、`priority`、`url`、`storyPoints`、`components`、`subtasks`（`[{key, title}]`）、`repo`（绝对路径）和 `epic`，即上级 Jira epic（`{key, title}`，或者只写 key）。可以配合你自己的导出脚本用。 |
| 每隔几分钟拉 | `intakePollMinutes` | `15` | 两次拉取之间的分钟数，5–1440。队列上的「现在拉一次」立刻拉。后台任务暂停时不拉。 |
| 仓库映射 | `intakeRepoMap` | 空 | 每行一条 `匹配 => /绝对/路径`，先匹配的算：`PROJ`（号的前缀）、`label:前端`、`component:文档` 或 `*`。ticket 自己带的 `repo` 优先于映射。哪条都对不上的等你选仓库。 |

不符合 `ticketPattern` 的号跳过。已经是 Shipherd ticket 的号（包括归档的）不动。同一个号再拉到时，内容变了、还没开工才重新分类；你改过的维度保留你的值。

### 分类

先用规则，规则定不了的才问模型（路由任务 `intake_classify`）。

- **缺信息**：描述不到 40 个字符、bug 没有复现步骤、功能没有验收标准。
- **大小**：故事点（≤2 小、≤5 中、更多大）、三个以上子任务（大）、`small`、`typo`、`epic` 这类标签、文档和杂务类型（小）。
- **风险**：ticket 里提到的路径按这个仓库[预审](#预审就绪和风险)的风险路径匹配；migration、auth、payment 这类关键词和 ticket 类型的下限往上抬；文档、杂务类型，或提到的路径全是低风险的，往下放。
- **拿不准**：模型调用失败，或者它的把握低于 `uncertainBelow`。

每个决定的理由都列在队列里。规模、风险、缺不缺信息都可以在那里改；每次改都带着规则版本记下来，在效果页上计数，用来校准规则。

### 开工和排队

信息全、在上限以内的 ticket 排进后台任务 `intake`。轮到它时 Shipherd 依次看：花费熔断、并行上限（只数由接活开的、session 还开着的 ticket；你自己开的从来不算）、和同仓库正在做的工作有没有改同样的路径、内存。都过了就在 worktree 里建 ticket，按档位经[模型路由](#模型路由)选模型开 session，递任务说明。有 session 结束时，等着的马上再试一次。改了策略、接活设置或预审开关时，搁着的按新条件重新决定。

`stackSubtasks` 开着时，有两个以上子任务的大 ticket 拆成[栈](#栈)：一个子任务一层，下面那层有了 PR 或 session 结束后，上一层从它的分支开工。每个子任务的号都合法、Shipherd 里都还没有时才拆。下面那层不做了或开不成时，上面那层叫你决定；你手动开工的话从默认分支开。

自动开工还要求预审开着（`preReviewEnabled`）。关着时只分类、搁着，你可以在队列里手动开工。

**按 Jira epic 归组。** 来源是 `tracker` 时，Shipherd 还会问每个 ticket 的上级 epic（key 和标题）；来源是 `file` 时读 ticket 的 `epic`。有上级 epic 的 ticket 进关联这个 Jira epic 的 Shipherd epic。没有未归档的 epic 关联它时，Shipherd 用 Jira epic 的 key 和标题新建一个，工作区放在默认位置（文件夹被占用时依次加 `-2`、`-3`），并加上这个 ticket 的仓库；已归档的 epic 不会拿来再用。epic 还没有的仓库会加进去。没有上级 epic 的 ticket 照样单独放。栈的各层放进拆出它们的那个 ticket 所在的 epic。接下来怎样，看 `autoStart`：

- **关。** 每个有 epic 的 ticket 马上建进那个 epic，不开 session，在队列里继续搁着。不会给 epic 总控发消息：你准备好了，就让它把这些 ticket 分进 feature。已经在 Shipherd 里的 ticket、栈的各层和没有仓库的 ticket 不会建。
- **开。** ticket 照常开工，放在自己的 epic 里。每次拉取之后，Shipherd 给每个 epic 的总控发一条消息，列出新拉来、在排队、在等或已开工的 ticket，让它用 `create_feature` 和 `set_ticket_feature` 把它们分进 feature，用 `reorder_features` 排好顺序，再往前推。消息放进总控的信箱：在跑时，在干活就在下一次调用工具时读到，停着就直接输入。没在跑时，内存够了 Shipherd 就打开它（接着它最近的对话），把消息当第一条交进去；内存不够时消息留在信箱里，下次打开时读到。从没开过总控、内存又不够时就跳过并记日志，下一次给这个 epic 加了 ticket 的拉取再试。

### 什么时候叫你

只有这几种，每个 ticket 每进入一次这种状态叫一次：分类拿不准、缺信息、不知道是哪个仓库、建不成 ticket、和别的工作改同样的路径在排队。它们是**轮到你**页上的一张卡片，开了通知时还是 `intake_decision` 事件。其余的（已开工、排队、等名额或内存、搁着、拆成栈）不打扰你，在**轮到你**页「运行情况」的「自动接活」里留 24 小时，在「全部工作」页「栈与自动接活」的队列里能看到。

`clarifyMode` 设成 `session` 或 `coordinator` 时，Shipherd 让一个小 session 或正在跑的全局总控到 tracker 上问缺的信息，这要[对外动作](#对外动作)里的「自动接活：到 tracker 提问」开着；关着时只告诉你。

### 策略

策略分全局、产品、仓库三层，和别的策略一样。

| 键 | 默认 | 取值 | 作用 |
|----|------|------|------|
| `enabled` | `false` | `true` / `false` | 映射到这一层的 ticket 的总开关 |
| `autoStart` | `true` | `true` / `false` | 自动开工；关着时只分类、搁着等你（在 Jira epic 下的 ticket 会先建进它的 Shipherd epic，见 **按 Jira epic 归组**） |
| `maxSize` | `large` | `small` / `medium` / `large` | 自动开工的最大规模 |
| `maxRisk` | `high` | `low` / `medium` / `high` | 自动开工的最高风险 |
| `maxParallel` | `2` | 整数 1–50 | 由接活开的、session 还开着的 ticket 最多几个 |
| `conflictAction` | `serialize` | `serialize` / `parallel` | 同仓库同路径：排队串行，或照样并行只记一笔 |
| `clarifyMode` | `notify` | `notify` / `session` / `coordinator` | 缺信息时谁去问 |
| `uncertainBelow` | `0.6` | 0–1 | 模型的把握低于这个算拿不准 |
| `stackSubtasks` | `true` | `true` / `false` | 有子任务的大 ticket 拆成栈 |
| `tierSmall` | `mid` | `high` / `mid` / `low` | 小 ticket 的档位 |
| `tierMedium` | `mid` | `high` / `mid` / `low` | 中 ticket 的档位 |
| `tierLarge` | `high` | `high` / `mid` / `low` | 大 ticket 的档位 |
| `tierMediumRisk` | `mid` | `high` / `mid` / `low` | 中风险至少用这一档 |
| `tierHighRisk` | `high` | `high` / `mid` / `low` | 高风险至少用这一档 |

最后用的档位是规模档位和风险档位里高的那个。**效果**页有一张「自动接活」卡片：分类了多少、自动开了多少、你手动开了多少、叫了你几次，以及你改过分类的 ticket 占多少。

## 多家公司或多个配置

用不同的 `SHIPHERD_HOME` 启动 Shipherd。如果每家公司有自己的 Claude Code 登录，再设一个不同的 `CLAUDE_CONFIG_DIR`。每个 `SHIPHERD_HOME` 都是一个独立的 Shipherd，有自己的数据库、记忆、hook 程序、日志和设置，以及自己的 Electron 配置文件夹（`$SHIPHERD_HOME/electron`）。Shipherd 会把这两个变量传给它启动的 `claude` session，让它们的 hook 报告到正确的收件箱。

用 `BUTLER_HOME`（改名为 Shipherd 之前的变量名）启动的配置照常能用：没设 `SHIPHERD_HOME` 时 Shipherd 读 `BUTLER_HOME`，原样使用那个文件夹，不会搬动。请改用 `SHIPHERD_HOME`，旧名字会在以后的大版本里去掉。

共用同一个 Claude Code 配置文件夹的两个 Shipherd 配置会互相覆盖对方的 hook。给每个配置一个单独的 `CLAUDE_CONFIG_DIR`。
