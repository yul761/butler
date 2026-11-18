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
6. **复盘规矩**（自动备份、导出提醒和准入策略，见[复盘规矩：批量操作、准入策略和导入导出](#复盘规矩批量操作准入策略和导入导出)）

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

## 同时开几个 session

能同时开几个 session 只看这台电脑的内存，没有写死的数。Butler 为 `start_session`、`start_feature`，或者 Butler 总控给关着的总控发消息而新开终端之前，会用现在可用的内存减去一个新 session 的预估占用，剩下的不少于下面的保留量才开。最近两分钟里刚开的 session 还没长起来，每个也按预估占用先扣掉。macOS 报告内存压力为「严重」时不开新的。不放行时总控会看到现在可用多少、再开一个要多少、要留多少；`start_session`、`start_feature` 和 `list_sessions` 的结果会多一行「现在还能再开几个」。读不到内存时照样放行（只看下面可选的上限），并记日志。

macOS 上的可用内存按 Activity Monitor 的算法从 `vm_stat` 算：总量减去 wired、压缩器占用和匿名页（扣掉可清除的部分），文件缓存算可用。这里不用 `os.freemem()`，因为它只算空闲页，几十 GB 空余的机器上也常常只有几 GB。`vm_stat` 读不到时用 `memory_pressure -Q` 的空闲百分比，再不行才用 `os.freemem()`。Windows 上 `os.freemem()` 就是可用物理内存（空闲加 standby），Linux 上是 `MemAvailable`，都直接用。

日志（Butler 数据目录里的 `logs/main.log`）会记下启动时的读数，旁边附上 macOS 自己的空闲百分比和 `os.freemem()` 作对照；每次放行或拒绝也会连同用到的数一起记下来。如果机器看着还有空、session 却被拒了，从这几行就能看出原因。

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 开新 session 后至少留给系统的内存（MB） | `sessionMemoryReserveMb` | 空（自动） | 留空是自动：物理内存的 10%，最少 512 MB、最多 2048 MB（8 GB 的电脑留 819 MB，16 GB 的留 1638 MB，20 GB 以上留 2048 MB）。也可以填 `0` 到 `1048576` 的 MB 整数。可用内存减去一个新 session 的预估占用后不少于这个数才开。 |
| 一个新 session 预计占多少内存（MB） | `sessionMemoryEstimateMb` | `1024` | `64` 到 `1048576` 的 MB 整数：Claude 加上它的 MCP server 和子进程。现在用这个数；以后接上每个 session 的内存实测后，有实测时用开着的 session 的实测平均。 |
| 同时开着的终端最多几个（0 = 不限） | `sessionMaxRunning` | `0`（不限） | `0` 到 `999` 的整数。默认关着，只当保险：设了以后，Butler 已经开着这么多终端时不再开新的，不管内存还剩多少。 |

## 记忆（StateCore）

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 把 handoff 的进度、决策、follow-up 和经验写进 StateCore，并在 Butler 打开的 session 里挂上记忆 | `memoryEnabled` | `1`（开） | `1` 或 `0`。关掉后，Butler 不往 StateCore 写任何东西，启动 session 时也不挂记忆 MCP server。已有的记忆会保留。重新打开后，Butler 会把漏掉的 ticket 补上。 |
| 上下文超过多少 token 时自动换新（0 = 关） | `refreshThresholdTokens` | `150000` | `0` 表示关掉自动换新，否则填一个 token 整数（最多 7 位）。当 Butler 的某个 session 已经停下、没在等你，而且上一轮的上下文至少有这么长时，Butler 会输入 `/handoff`，等记忆真的存好 handoff，把最近几轮对话存到 `~/.butler/refresh/<session>.md`（不调用模型），再输入 `/clear`，然后让 session recall 那份 handoff、读这个文件，接着做换新前在做的事（如果当时在等你、等 CI 或等子 session，就说一句在等什么并继续等）。需要打开记忆。运行中的 session 旁边的 ↻ 按钮，以及总控的 `refresh_session`，可以随时手动换新，不受这项设置影响。 |
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

## 内存与性能

这些设置在**设置 → 常规 → 内存与性能**。没有一项是靠限制同时运行的 session 数量来省内存的。

| 设置 | 键 | 默认 | 可填的值和说明 |
|------|----|------|----------------|
| 记录每个 session 用了多少内存 | `memoryMonitor` | `1`（开） | `1` 或 `0`。Butler 每分钟读一次进程表（macOS 用 `ps`，Windows 用 `Get-CimInstance Win32_Process`，不调用任何模型），把每个开着的 session 的整棵进程树（claude、它的 MCP server、shell、watcher、dev server）和 Butler 自己的进程加起来，再读系统还有多少可用内存。**现在**页每一行上显示最近一次的读数（悬停看明细），最上面有一行**内存**：Butler、session、系统可用、Butler 的 MCP，展开后有最近 24 小时的曲线。每 5 分钟往 Butler 的数据库存一个点，保留 14 天。只读，不动任何进程。 |
| 降低看不见又停着的 session 的优先级 | `backgroundPriority` | `0`（关） | `1` 或 `0`。macOS 上，不在屏幕上、又停着的 session，整棵进程树被设成后台（`taskpolicy -b`）。Windows 上，看不见的 session 设成 `BelowNormal`，又停着的再打开 EcoQoS。终端出现在屏幕上、你在里面打字、或者 session 又开始干活，马上恢复；退出 Butler 时全部恢复。macOS 上正在干活的 session 不降：后台优先级会把编译和测试拖得很慢。 |
| 清理 session 留下的孤儿进程 | `orphanCleanup` | `1`（开） | `1` 或 `0`。Butler 记着它在每个 session 下面见过哪些进程（`~/.butler/procs/owned.json`，带启动时间和命令行）。session 的终端结束 5 秒后，其中还活着、又不在任何开着的 session 下面的，会被结束：先正常结束，5 秒后还在就强制结束（Windows 上先 `taskkill`，再 `taskkill /F`；每个进程单独核对、单独结束，不用 `/T`）。启动时也会清掉 Butler 上次异常退出留下的。启动时间或命令行对不上的（比如 pid 被别的程序重用了）绝不碰。每结束一个都写进日志。 |
| claude 进程超过多少 MB 就换新（0 = 关） | `refreshMemoryMb` | `2048` | `0` 关掉，否则是不小于 256 的整数 MB（最多 6 位）。只算 claude 进程自己，不算它的 MCP server 和别的子进程。超过以后，Butler 在这个 session 下一次停下来的时候换新，检查和步骤和 `refreshThresholdTokens` 一样（所以要开着记忆）。换新以后 claude 还在阈值的 80% 以上，Butler 写进日志；6 小时以后再试。 |
| 停着的 session 休眠 | `hibernateEnabled` | `0`（关） | `1` 或 `0`。Butler 开的 session 停够了下面的分钟数，Butler 就结束它的整棵进程树（claude、MCP server、shell，`hibernateEndWatchers` 开着时还有 watcher），只留下对话记录，按钮上显示「休眠」。有东西要送进去时它用 `claude --resume` 醒来，原来的对话都在：CI 的结论、合并通知、给总控的汇报、你对 `ask_user` 的回答。点开它、切到它的终端也会唤醒。下面这些情况不休眠：正在干活或者有后台命令、屏幕上有权限确认或对话框、输入框里有草稿、30 秒内在终端里打过字、正在换新或者正在给它递东西、是你正在看的终端、是总控而它管的子 session 在干活、2 分钟内刚打开或者 10 分钟内刚唤醒、没有对话记录、被钉住（按钮上的 📌）。修复 session 和复盘分析 session 不休眠。休眠的 session 照样算进每个 ticket、每个 feature 的 session 上限，照样显示在「现在」页，照样算在等你。唤醒失败的，按钮上有个 **!**（原因在悬停提示里），并且一直留在「现在」页，直到你点开或者隐藏它。会过去的失败（ticket 正忙、找不到 claude、仓库在别的分支上）保留休眠，10 分钟后再自动唤醒；别的失败（claude 还没起来就退出了，或者 60 秒没起来）变成普通的关着的 session。你自己点开总会再试一次。不限制同时开的 session 数。 |
| 等你的 session 多少分钟后休眠 | `hibernateYouMinutes` | `30` | `0`（不休眠）或不小于 `5` 的整数（最多 5 位）。「等你」是「现在」页说它需要你，或者有没回答的 `ask_user`。 |
| 等 CI 的 session 多少分钟后休眠 | `hibernateCiMinutes` | `20` | 同上。等 CI：它的 PR（或者分支）的 CI 在跑，或者排在合并总控里。 |
| 等 review 的 session 多少分钟后休眠 | `hibernateReviewMinutes` | `30` | 同上。PR 开着、CI 跑完了、review 还没批准。 |
| 闲置的 session 多少分钟后休眠 | `hibernateIdleMinutes` | `60` | 同上。别的停着的情况。 |
| 休眠时也结束 watcher 和 dev server | `hibernateEndWatchers` | `1`（开） | `1` 或 `0`。关掉的话，session 休眠期间 watcher（`tsc --watch`、`vite` 等）和 dev server 照样跑，它醒来、被隐藏或者 Butler 重启时再结束。 |
| 内存紧张时休眠闲得最久的 session | `memoryPressureEnabled` | `0`（关） | `1` 或 `0`。系统可用内存低于 `memoryPressureFreePercent` 时，每次采样（每分钟一次）休眠一个 session：闲得最久、至少闲了 5 分钟、上面的规则都通过的那个。可用内存回到线以上 5 个百分点就停。`hibernateEnabled` 关着也照样生效。 |
| 可用内存低于百分之多少算紧张 | `memoryPressureFreePercent` | `10` | `1` 到 `50` 的整数。 |
| 共享 MCP | `sharedMcp` | `0`（关） | `1` 或 `0`。开着时，一个后台进程（MCP hub）经本机回环 HTTP（只监听 `127.0.0.1`，每个 session、每个 server 一个随机 token）给所有 session 提供 Butler 的记忆 server 和 `butler-sessions`，不再每个 session 各起一组进程。开着的 session 越多省的内存越多；关着时「现在」页的内存卡片会估算能省多少。只影响之后打开的 session。hub 还在启动或者起不来的时候，新开的 session 照旧用各自的进程；一直起不来时「现在」页有提醒。关掉以后，已经接上 hub 的 session 照常用到它退出。你自己 Claude 配置里的 MCP server 不受影响。 |

### Butler 管不了、但很有用的建议

- **Windows：**在 Windows 安全中心给 Defender 加排除：放 worktree 的目录、`node_modules`、`.git` 和 `%USERPROFILE%\.butler`。很多 node 和 git 进程一起跑时，实时扫描开销很大。确认页面文件够大：设成**系统管理的大小**，或者至少是内存的 1.5 倍。
- **macOS：**把放 worktree 的目录加进「聚焦」的隐私列表（系统设置 → Siri 与聚焦 → 聚焦隐私），免得每次 `pnpm install` 都被重新索引。装了第三方杀毒软件的话，同样排除这些目录。macOS 自己管交换空间：磁盘至少留 15%～20% 的空闲，它才有地方换出。
- **两边都是：**你自己的 Claude 配置里装的每个 MCP server，每个 session 都会再起一份。**现在**页的**内存**那一行会列出你装的 MCP 里占内存最多的。不常用的可以从你的 Claude 配置里去掉；Butler 不会替你改这个配置。

## 调度与 handoff

| 设置 | 键 | 默认值 | 可填的值和说明 |
|------|----|--------|----------------|
| 晚间 handoff 时间 | `nightlyTime` | `16:00` | `HH:MM`，本地时间。如果到点时 Butler 没开、电脑在睡眠或锁屏，会在下次启动、唤醒或解锁时补跑，排在早间刷新之前。 |
| 每天几点让 Butler 总控巡检一次 | `butlerPatrolTime` | 空（关） | `HH:MM`，本地时间；空 = 关。到点时 Butler 打开（或接着用最近的）Butler 总控，让它看一遍 PR、CI 和待你决定的事，用 `ask_user` 列出要你亲自做的事。Butler 总控正忙就等它停下来；到点时电脑在睡眠或 Butler 没开，当天醒来、解锁或启动时补一次，过了零点不补。如果在当天的巡检时间过了之后才打开这项设置，会马上巡检一次。巡检每天最多开一次 session。上一次巡检列出的待你决定还没处理时，下一次会等你处理完。Butler 总控不会被自动换新，也不会因为闲置被自动关闭。 |
| 工作日（只在这些天跑晚间 handoff） | `workingDays` | `1,2,3,4,5`（周一到周五） | 界面上是复选框。存的值是用逗号分隔的 `0`–`6`，`0` 是周日。晚间 handoff 和早间刷新只在这些天运行。 |
| tracker MCP 工具（handoff 只能调用这些，一行一个） | `trackerTools` | 空 | 一行一个 MCP 工具名，格式是 `mcp__<server>__<tool>`。只写 `mcp__<server>` 会放开这个 server 的所有工具，除非 server 是只读的，否则别这么写。其他内容，例如 `Bash(...)` 规则或命令行参数，都会被拒绝。handoff 和刷新可以调用这些工具，加上 `Read`、`Grep`、`Glob`、`gh pr view`、`gh pr checks`、`git log` 和 `git status`，再加上你用户级或托管（policy）的 Claude Code 设置允许的工具（见下文）。 |
| 后台 handoff 也加载本地级的 MCP… | `headlessProjectMcp` | `0`（关） | `1` 或 `0`。见[接入你的 tracker](#接入你的-tracker)。 |
| handoff prompt 模板 | `handoffPrompt` | 内置 | 做 handoff 时发给 `claude` 的指令。不能为空，最长 20,000 个字符。见[改写提示词](#改写提示词)。 |
| 早间刷新 prompt 模板 | `refreshPrompt` | 内置 | 早上快速查一遍 PR 和 tracker 状态，不总结对话。限制同上。 |

这一节还有 **立即运行晚间 handoff** 按钮。

晚间运行做完 ticket 之后，还会为每个自上次汇总以来总控 session 或 ticket 有新动静的 feature 写一份汇总。有总控 session 时，它会 fork 这个 session，并使用和 handoff 相同的只读参数。如果 ticket 那一轮被限流了，当晚不写 feature 汇总，留给早上的补跑。feature 页上还有 **立即更新**，它先为这个 feature 里有动静的 ticket 跑 handoff，再写汇总。上次汇总之后 PR 的状态、CI、review 或能不能合并有变化，也算新动静，所以就算没人打字，汇总也会标成过时。每份汇总都写着读 PR 的时间（"PR 状态截至"）。在总控 session 里运行 `/handoff`，会直接根据对话本身写汇总。

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

## 模型路由

Butler 在后台用 `claude -p` 做一些事：「需要你」和卡住判断、handoff、feature 汇总、epic 摘要、复盘分析。**设置 → 模型路由**决定每一种调用用哪个模型，以及模型撞到限额时怎么办。

**什么都不登记就什么都不变。** 在你登记至少一个启用的模型之前，每个调用都和 Butler 2.1.0 用同一个模型（「需要你」和卡住判断用 haiku，handoff 刷新和 epic 摘要用 sonnet，其余用你的默认模型）。限额照旧处理：整个账号暂停。下面说的通用信号只记在页面上。

**档位和链。** 每个登记的模型有一个档位：`high`、`mid` 或 `low`。模型名可以是别名（`opus`）、完整名字（`claude-opus-5-5`），或者你的网关认识的名字；Butler 原样传给 `--model`。每一档有一条链，也就是试这一档模型的顺序。默认按登记的顺序。**账号**标签相同的模型共用一个订阅或网关：其中一个撞到账号级限额时，同账号同档和更高档的模型也一起标上。

**第一次设置。** **发现模型**从 `ANTHROPIC_MODEL` 等变量、Claude Code `settings.json` 里的 `model`、最近用量里出现过的模型和 CLI 别名收集候选名字，给每个发一次很小的测试调用，只列出有回应的，并给出建议档位。Butler 从不假设 opus、sonnet、haiku 一定存在。登记了却不存在的模型标成不可用并跳过。

### 任务和限额

每个后台调用都带着它的任务。页面上的表列出每个任务的档位、最低允许档位、撞限时怎么办、是不是关键任务，每一项都可以按任务改。

- **fallback（降级）**：试链里的下一个模型，再往下一档，最低到允许的档位。
- **wait（等待）**：先试同一档的其他模型，都不行就等其中一个恢复。不会丢掉。
- **escalate（上报）**：第一次撞限就停下并报出来。

handoff 和 feature 汇总沿用 session 自己的模型（换模型会让 prompt 缓存整个失效）。

比任务要的档位低的结果会在用量、复盘运行详情和事件记录里标成降级。在低档跑的复盘分析会排队，等它自己的档位恢复后重跑一次；页面上的**现在重跑**会马上做。

**识别限额。** 限额靠规则识别：内置规则、你加的规则（正则、HTTP 状态码或恢复时间的格式）和从你的确认里学到的规则。此外，Butler 把这些当作*疑似*限额：HTTP 429、529、402，报错里提到 limit、quota、billing、credit，以及同一个模型连续失败三次而别的模型成功了。疑似限额记在那个模型上（规则说是账号级的就记在账号上）。不知道恢复时间时，Butler 先退避，再用一次很小的调用探测。分不出来的报错列在**未识别的报错**里：**这是限额吗？**把它变成一条学到的规则，下次同样的报错就能认出来；**不是限额**清掉疑似标记。

### 交互 session

总控的 `start_session` 接受档位（`high`、`mid`、`low`）或模型名，旧的 `opus`、`sonnet` 照旧能用。Butler 挑这一档里健康的模型，返回实际用的模型。不认识的名字在开终端之前就拒绝。你的 `claude` 不支持 `--model` 时，session 不带它打开。

session 撞到限额时，它那一行显示限额和**换下一档继续**按钮：结束终端，用 `--resume` 加下一个模型的 `--model` 接着同一段对话。打开 `routingAutoSwitch` 后 Butler 直接换。

### 花费

| 设置 | 键 | 默认值 | 可接受的值和说明 |
|------|----|--------|------------------|
| 每月配额 | `routingQuotas` | 空 | JSON 列表，每项是 `{"target": "tier:high" 或 "model:<名字>", "unit": "usd" 或 "tokens", "monthly": <数字>}`。金额取 Claude Code 报的费用，没有时用 token × 登记的价格。空表示不设配额。 |
| 软阈值（%） | `routingThresholds` | `70,90` | 两个整数，前一个小于后一个。过了第一个，策略是 fallback 的任务跳过这个模型、降到低一档；过了第二个，只有关键任务还用它。配额从不挡关键任务。 |
| 周期开始日 | `routingPeriodStartDay` | `1` | 1 到 28，每月从哪天开始算配额（本地时间）。 |
| 思考强度 | `routingEffort` | 空 | JSON 对象，键是任务 id 或档位，值是 `low`、`medium`、`high`、`xhigh` 或 `max`；你的 `claude` 支持时作为 `--effort` 传。任务的设置优先于它档位的。 |
| 并发上限 | `routingMaxConcurrent` | 空 | JSON 对象，键是档位，值是同时最多跑几个后台调用的整数，比如 `{"high": 1}`。 |
| session 自动切换 | `routingAutoSwitch` | `0`（关） | `1` 或 `0`。打开时撞限的 session 马上换下一档，不再显示按钮。 |

同一页上还有按模型和按任务的花费、每个模型的健康状态和降级事件记录。**现在**页在模型撞限或降级期间显示提示。

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

## 复盘规矩：批量操作、准入策略和导入导出

### 批量操作和批次

在**复盘规矩**页先筛选（仓库或产品、状态、准入、可检查性、搁置原因、最少出现次数、分数范围、批次、文字、只看降级模型产出的），然后一步处理**所有符合条件的规矩**：**全部确认（N）**、**全部拒绝（N）**、**全部停用（N）**、**全部启用（N）**、**全部删除（N）**。也可以勾选几条待确认的，只处理这几条。**接受全部推荐（M）**只确认准入流水线推荐的（准入是 `auto`），其他的不动。

每次批量操作、每次单条的确认 / 拒绝 / 编辑 / 停用 / 删除 / 合并、删除产品（连同它的规矩和策略层）、每次改策略、每次导入，都记成一个**批次**，每一行改前改后各存一份快照。**批次**标签页列出它们；**撤销**把一个批次里的每一行恢复原样。那之后又被改过的行不动，算作跳过；这一批新建的产品或规矩、后来又有别的东西依赖它的，也跳过。合并只能整个撤销，不会只撤一半。至少恢复了一行才算撤销过；撤销本身也记一笔，不能再撤销。删掉一条规矩会连同合并进它的那些一起删，撤销时一起回来、仍然是合并的。页面算完数之后列表又变了（比如后台分析新加了符合条件的规矩）时，批量操作只改页面上显示过的那些；会改的比按钮上的数多，就什么都不改。合并不再删掉被合并的那条：它留着、隐藏起来、指向合并到的那条，所以合并也能撤销。

以前就确认、停用或拒绝过的规矩，状态不变，准入记成 `manual`。

### 备份和导出设置

| 设置 | 键 | 默认值 | 取值和说明 |
|------|----|--------|------------|
| 每隔几天自动备份一次全部配置（0 = 关） | `configBackupIntervalDays` | `0` | `0`（关）到 `365` 的整数。Butler 每个间隔把全部配置导出一份到 `<BUTLER_HOME>/backups/auto-<时间>.json`（任务 `config_backup`；失败一小时后重试）。备份里不会有密钥或本地路径。 |
| 自动备份保留几个 | `configBackupKeep` | `10` | `1` 到 `999` 的整数。只留最新的几个自动备份；替换导入之前写的备份和**现在备份**按钮写的备份从不删除。 |
| 多少天没导出就提醒（0 = 不提醒） | `configExportReminderDays` | `30` | `0`（不提醒）到 `365` 的整数。有已确认的规矩、而且这么多天里既没导出也没备份（从没有过就从第一条已确认规矩算起）时，导入导出标签页和规矩标签页会提醒。 |

### 准入策略

准入策略决定复盘流水线怎么给规矩打分、搁置、回测、影子运行和降级。每个键都能在三层设置：**全局**、**产品**、**仓库**。一个仓库先用自己的值，没有就用它所属产品的值，再没有用全局的值，最后用默认值；逐个键合并。一个仓库属于几个产品、这几个产品对同一个键设了不同的值时，名字排在最后的产品生效，**设置 → 复盘规矩 → 准入策略**会提示。每次改动都是一个可撤销的批次，并把策略版本加一（评分会记下用的是哪个版本）。这些默认值还没校准过，页面上会注明。

| 键 | 默认值 | 取值 | 作用 |
|----|--------|------|------|
| `score.weight.evidence` | `0.3` | 0–1 | 评分里证据（出现次数、PR 数、评审人数）的权重 |
| `score.weight.clarity` | `0.2` | 0–1 | 清晰度的权重 |
| `score.weight.consistency` | `0.2` | 0–1 | 和已有规矩一致的权重 |
| `score.weight.verifiability` | `0.3` | 0–1 | 可验证性（能不能变成检查）的权重 |
| `score.weight.performance` | `0` | 0–1 | 影子运行实测表现的权重 |
| `score.admitLine` | `0.7` | 0–1 | 可检查的规矩达到这个分数就准入 |
| `score.dropLine` | `0.3` | 0–1 | 低于这个分数就搁置 |
| `score.proseAdmitLine` | `0.8` | 0–1 | 只能写成文字的规矩的准入线 |
| `score.untestedCap` | `0.69` | 0–1 | 没回测过的规矩最高能得的分 |
| `score.reviewerBonus` | `0.05` | 0–1 | 评审人亲自提过的加分 |
| `score.recencyHalfLifeDays` | `180` | 1–3650 的整数 | 旧证据衰减的半衰期（天） |
| `score.degradedPenalty` | `0.1` | 0–1 | 分析用的是降级模型时的扣分 |
| `batch.sampleSize` | `20` | 1–1000 的整数 | 自动批次抽查多少条 |
| `batch.minSamplePassRate` | `0.8` | 0–1 | 抽查通过率至少多少 |
| `batch.minCoverage` | `0.3` | 0–1 | 一批里至少多大比例要有结论 |
| `batch.maxShelvedShare` | `0.7` | 0–1 | 一批里最多多大比例被搁置 |
| `batch.minBacktestRecall` | `0.01` | 0–1 | 整批回测召回率至少多少 |
| `batch.maxBacktestFalsePositiveRate` | `0.2` | 0–1 | 整批回测误报率最多多少 |
| `generality.minHits` | `2` | 0–1000 的整数 | 规矩至少出现几次 |
| `generality.minPrs` | `2` | 0–1000 的整数 | 至少在几个不同的 PR 里出现 |
| `generality.minReviewers` | `0` | 0–100 的整数 | 至少几个不同的评审人提过 |
| `backtest.recentPrs` | `50` | 1–1000 的整数 | 用最近多少个合并的 PR 回测 |
| `backtest.minRecall` | `0.01` | 0–1 | 回测召回率至少多少 |
| `backtest.maxFalsePositiveRate` | `0.2` | 0–1 | 回测误报率最多多少 |
| `backtest.allowUntestedShadow` | `true` | `true` / `false` | 没法回测的规矩也可以先影子运行 |
| `shadow.minPrs` | `5` | 0–1000 的整数 | 影子运行至少经过几个 PR 才转正 |
| `shadow.minDays` | `7` | 0–365 的整数 | 影子运行至少几天才转正 |
| `shadow.maxFalsePositiveRate` | `0.2` | 0–1 | 影子运行误报率最多多少 |
| `shadow.minAdoption` | `0.6` | 0–1 | 发现的问题至少多大比例被采纳 |
| `shadow.autoPromote` | `false` | `true` / `false` | 达标后自动转正 |
| `conflict.autoPickHigherHits` | `false` | `true` / `false` | 规矩冲突时自动留出现次数多的那条 |
| `demote.enabled` | `true` | `true` / `false` | 不再起作用的已准入规矩自动降级 |
| `demote.maxBypassRate` | `0.3` | 0–1 | 被绕过的比例超过这个就降级 |
| `demote.noReductionPrs` | `10` | 1–1000 的整数 | 连续这么多个 PR 重复评论没减少就降级 |
| `demote.to` | `shadow` | `shadow` / `review` | 降级到哪：shadow（影子运行）或 review（回到待审） |
| `admission.autoConfirm` | `false` | `true` / `false` | 通过准入的规矩自动确认，不再问 |

### 导出文件

复盘规矩页的**导入导出**可以导出全部、一个产品或一个仓库，内容可选全部、只有规矩（含产品）或只有检查（有检查之后）。文件是 JSON：

```json
{
  "format": "butler-config",
  "formatVersion": 1,
  "exportedAt": 1763337600000,
  "butlerVersion": "3.0.0",
  "scope": { "kind": "all" },
  "options": { "content": "all", "includeSourceUrls": false },
  "sections": { "products": [], "policies": [], "lessons": [] }
}
```

- **没有密钥、没有本地路径、没有评论原文、没有分数。**规矩带正文、理由、归属（仓库 slug 或产品名）、状态、准入、范围字段、出现次数，以及来自几条出处、几个不同的 PR。只有勾选**带上出处链接**时才带 PR 链接。
- 更新版本的 Butler 导出的文件（`formatVersion` 更高）会被拒绝；旧版本的先升级。这个 Butler 不认识的部分跳过并列出来。
- 每个条目都有一个稳定的**指纹**，按内容算，不用本地 id：规矩是规范后的正文（去首尾空白、连续空白合一、小写）加归属和路径通配；产品是名字；策略层是全局 / 产品名 / 仓库 slug。
- **预览**把每个条目标成新增、改动、冲突（决定不一样：规矩的状态、强度或可检查性，产品的仓库，或策略的值）、不变，或删除（只在替换时）。
- **合并**加入新的条目，改动和冲突默认留本地的；文件里没有的本地条目不动。**替换**先写一份 `<BUTLER_HOME>/backups/before-replace-<时间>.json`（写失败就什么都不改），默认用导入的，并删掉文件范围里本地有、文件没有的条目。两种方式都可以一键切成**全部用导入的**或**全部用本地的**，也可以逐行选。
- 导入的规矩先是**待确认**（文件里已拒绝的照样拒绝），整个导入是一个批次，可以在批次标签页撤销。这台机器上没有克隆的仓库会加进来，本地路径留空，标成**这台机器上没有克隆**；Butler 看到它的克隆之前不能分析它的历史。状态冲突会把一条本地没确认的规矩变成已确认时，那一行会注明。
- **起步包**导出已确认的规矩，不带归属、状态、出现次数和出处。导入起步包时会问加到哪个仓库或产品。
- **模型路由**（`models` 部分）只在导出全部内容时才有：登记的模型（名字、档位、账号、单价、备注）、每档的降级链、任务覆盖、你自己加的和学到的限额规则。健康状态、花费、事件、未识别的报错和规则备注都留在本机。导入的模型和规则先是**停用**的，所以导入本身不会改变用哪个模型，要到**设置 → 模型路由**里启用；本机已有的保留本机的启用状态。档位、账号、单价、降级链顺序或任务设置不同算冲突。路由的表不在批次撤销里：不要的在模型路由页删掉，或者用替换导入之前写的那份备份恢复。

## 检查：每次编辑都跑的确定性规则

检查是不用模型就能判断的规则：禁止的写法、import 边界、注释规则、要跑的命令。检查在规矩页的**检查**标签里，和准入策略一样分三层（全局、产品、仓库；越近的层越优先，仓库可以按 key 关掉或覆盖继承来的检查）。可以手写，也可以在一条规矩上点**做成检查**：Butler 用模型从规矩文字起草一条，你看过再保存。没法机械检查的规矩可以标成**只有文字**。

- Butler 把打开的检查写到 `<BUTLER_HOME>/checks/snapshot.json`。Butler 的 session 里每次 `Edit`、`Write`、`MultiEdit` 之后，`butler-hook check` 只读这个文件（从不碰数据库）；agent 跑 `git push` 时，`butler-hook check-push` 跑 push 阶段的检查。Butler 之外的 session 不受影响，你自己的 Claude Code 配置从不改动。
- hook 从文件所在的文件夹找仓库（它的 `origin` remote）。没有 remote 的文件夹、读不了的快照、别的 Butler 版本写的快照，一律放行，并在 session 上记**没有检查**。
- 路径 glob（`globs`、`excludeGlobs`）匹配相对仓库根目录的路径，`/` 和 `\` 都行。
- **类型。**`forbidden_pattern`：新写的行里不许出现的正则（或原样文字）。`import_boundary`：匹配 `forbid` 的 import（仓库路径 glob 或 `electron` 这样的包名）不许出现，匹配 `allow` 的除外。`comment_policy`：说代码是临时的注释（内置中英文关键词，比如 *temporary*、*workaround*、*TODO*、临时、先这样）要带一个符合 ticket 格式的 ticket 号；这条内置检查一开始就有，但是**关着**。`run_command`：一条 shell 命令（macOS、Linux 用 `/bin/sh`，Windows 用 Git Bash）；`{file}` 换成改动的文件，作为参数传进去，绝不拼进命令文字；环境变量 `BUTLER_CHECK_FILE` 里也有这个文件。编辑阶段的命令没写 `{file}` 时，只有一条简单命令（`eslint --max-warnings 0`）才把文件接在最后；复合命令（带 `;`、`&&`、`|`、重定向或子 shell）原样执行。编辑阶段的命令只对改动的文件跑；push 阶段的命令在 push 前跑一次。
- **模式。**新建的检查、导入的检查都从**试运行**开始：命中只记录。命中列表看着对了再切到**强制**。强制的 `block` 检查用 hook 的 block 把失败告诉 agent（改动保留，要求它修根本原因）；强制的 `warn` 检查和所有试运行命中只加一条提示。只报这次编辑新引入的问题，每个只报一次。
- 超时的命令连同整棵进程树一起被杀掉，记为**没能检查**，编辑放行。正则（禁用写法、ticket 格式）每次编辑最多跑两秒；更久的（比如 `(\w+\s?)+$` 这样的嵌套量词）会被停掉，同样记为**没能检查**。调大时间限制之前就开着的 session 仍按它开始时的限制。push 阶段的检查失败会拦下 `git push` 并说明原因。合并闸门不变。
- 检查标签里每条检查显示命中次数、agent 之后改掉了多少（采纳）、你标了多少误报。超过一年的命中记录会删掉。

| 设置 | 键 | 默认 | 说明 |
| --- | --- | --- | --- |
| 在 session 里跑检查 | `checksEnabled` | `1` | `1` 或 `0`。关掉后新的 session 不挂 hook，已经在跑的 session 一律放行。 |
| 每次编辑后检查的时间（秒） | `checksEditTimeoutSec` | `8` | `1` 到 `30` 的整数。一次编辑的所有编辑阶段检查共用。 |
| push 前检查的时间（秒） | `checksPushTimeoutSec` | `600` | `10` 到 `3600` 的整数。所有 push 阶段检查共用。 |

检查跟着其它配置一起导出、导入（**只导出检查**或**全部**）。按 key 和层对应；行为上的改动（类型、参数、glob、严重程度、开关）算冲突，选了导入的就回到试运行；只改名字或提示语的，模式照旧。新来的或命令文字变了的 `run_command` 检查导入后是**关着**的，因为试运行也会执行命令：预览里能看到每条命令，看过再打开。只有检查的文件即使用替换导入也不会删掉你的产品。替换导入从不删除内置检查。

## 对外动作

之后的一些功能会让 Butler 代你在本机以外留下东西，比如在 PR 评论下回复。每一种动作在 **设置 → 对外动作** 里有自己的开关，默认全关。开关关着时 Butler 不做这个动作，只记一条"跳过"。做了的、失败的、跳过的动作都列在 **审计** 页的 **对外动作** 里，写着仓库、ticket、目标和发了什么，保留时间和 `auditRetentionDays` 一样。现在还没有功能用到这些开关。

| 设置 | 键 | 默认值 | 允许做什么 |
|------|----|--------|------------|
| 回复 review 评论 | `externalCommentReply` | `0`（关） | 在 PR 的评论下以你的账号回复。 |
| 标记评论已解决 | `externalCommentResolve` | `0`（关） | 把 PR 上的 review 讨论标成 resolved。 |
| 改 PR 描述 | `externalPrDescriptionEdit` | `0`（关） | 改写 PR 的正文。 |
| 加减 PR label | `externalPrLabel` | `0`（关） | 给 PR 加或去掉 label。 |
| 开 PR | `externalPrOpen` | `0`（关） | 用 `gh` 新开 PR。 |
| 改 PR 标题 | `externalPrTitleEdit` | `0`（关） | 改 PR 的标题。 |
| 强推（force push） | `externalForcePush` | `0`（关） | 改写远端分支的历史。 |
| 重跑 CI | `externalCiRerun` | `0`（关） | 重新触发失败的 CI。 |
| 发 issue | `externalIssuePost` | `0`（关） | 在 tracker 或 GitHub 上建 issue、发评论。 |
| 推送通知 | `externalPushNotification` | `0`（关） | 往外部服务（比如手机推送、聊天工具）发通知。 |

每个开关填 `1` 或 `0`。

## 多家公司或多个配置

用不同的 `BUTLER_HOME` 启动 Butler。如果每家公司有自己的 Claude Code 登录，再设一个不同的 `CLAUDE_CONFIG_DIR`。每个 `BUTLER_HOME` 都是一个独立的 Butler，有自己的数据库、记忆、hook 程序、日志和设置，以及自己的 Electron 配置文件夹（`$BUTLER_HOME/electron`）。Butler 会把这两个变量传给它启动的 `claude` session，让它们的 hook 报告到正确的收件箱。

共用同一个 Claude Code 配置文件夹的两个 Butler 配置会互相覆盖对方的 hook。给每个配置一个单独的 `CLAUDE_CONFIG_DIR`。
