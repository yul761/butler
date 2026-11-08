# Butler

[English](README.md) | **简体中文**

一个桌面版的"工作管家"，给同时开好几个 [Claude Code](https://docs.claude.com/en/docs/claude-code) session 的人用，一个 ticket 一个 session。
支持 macOS（Apple silicon）和 Windows（x64）。MIT 协议。网站：[butler.statecore.io](https://butler.statecore.io)。

几个 ticket 可以归成一个 feature，几个 feature 可以归成一个 epic。在 epic session 里商量好怎么拆，它会建出 feature 并附上计划；feature 的总控 session 再替你建 ticket、在每个 ticket 里开 session、派任务。session 之间不直接对话，而是靠本地 StateCore 里分层的共享记忆互通：一个 session 记下的进展和决定，同一个 ticket、feature 或 epic 里的其他 session 都能读到。**现在** 页按 epic、feature、ticket 列出每个 session 在做什么，需要你处理的排在最前面。每晚 Butler 还会为有进展的 ticket 写一份交接（handoff）。

**本地优先。** Butler 的数据都存在本地的 SQLite 文件里。数据只会经由两条路离开你的电脑：你自己的 `claude`，以及你配置了的话，一个个人 LLM API。这个 API 只在"完整"隐私档位下用于记忆蒸馏，它收到的每一次调用都记在审计页上。

**界面语言。** 界面有中文和英文两种。首次启动时跟随系统语言（中文系统用中文，其他用英文），之后可以在 **设置 → 常规 → 语言 / Language** 或首次运行向导里改。语言也会切换 Butler 发给 `claude` 的默认提示词，所以 handoff 和记忆会用这种语言来写；你自己改过的提示词不变。从 1.2.0 或更早版本升级上来的安装保持中文，直到你手动改。切换之后，在环境检查里点一次 **安装 / 修复**，`/handoff` 命令就会换成新语言。本文引用的是中文界面的标签；[英文 README](README.md) 引用的是英文界面的标签。

## 和其他工具的区别

同时开好几个 Claude Code session、每个跑在自己的 git worktree 里，现在已经很常见：Claude Code 官方桌面版能做，Conductor、Claude Squad 这类工具也能做。Butler 同样能做，但它围绕的是"工作"，而不是"agent"：

- **管的是工作，不只是 session。** session 属于 ticket，ticket 属于 feature，feature 属于 epic。在 epic session 里定下的计划，会连同前面几个 feature 的进展、决定和待解决的问题，一起交给下一个 feature 的总控。
- **记忆比 session 活得久。** 每个 session 都能 `recall` 同一个 ticket、feature 或 epic 里之前的 session 记下的东西，所以不用写文档留给下一个 session 读。上下文太长的 session 会先写交接、清空，再从记忆里接着干。
- **你始终在回路里。** **现在** 页把等你的 session 排在最前面。停住不动的 session 会被标出来，附上可能的原因，你不点就不会去修。
- **少撞车。** 同一个仓库里，一个合并会和另一个 ticket 的分支冲突时，合并总控会先拦下它。
- **交接自动写好。** 每天晚上，以及你输入 `/handoff` 时，Butler 会让你自己的 `claude` 为每个 ticket 写一份结构化的交接，为每个 feature 写一份进度汇总。

Butler 只支持 Claude Code。

## 功能

- **以 ticket 为中心。** 每个 ticket 有自己的 worktree 或分支、自己的 Claude Code session（内嵌终端）、PR 状态和合并后的跟进事项。最近 7 天里你在 Butler 之外开的 session 会出现在 **未认领 session** 下，可以把它们挂到某个 ticket 上。一个 ticket 可以跨几个仓库（比如一个前端加一个后端）：建 ticket 时可以选仓库也可以不选，之后在 ticket 页上再加。每个仓库有自己的工作方式和分支，之后可以用 **编辑** 修改。新建 session 时会问你在哪个仓库里工作。正在运行的 session（包括总控开的）按钮旁边有个 ×：点两下就结束这个 session。它的对话会保留，再点按钮就能重新打开。没在运行的 session 也可以用同一个 × 隐藏，它只是从列表里拿掉（对话仍在），**已隐藏** 能把它找回来。Butler 开的 session 不会卡在 Claude Code 询问"要启用仓库 `.mcp.json` 里哪些 server"那一步：Butler 会替你启用，你之前在这个仓库里关掉的除外。**总控** session 运行在 ticket 的工作区文件夹（`~/.butler/workspaces/<ticket>`）里，通过 `--add-dir` 能看到所有仓库。一个 ticket 的所有 session 共享它的记忆。总控还有一个 `butler-sessions` MCP server，提供五个工具：
- `list_repos` 列出 ticket 的仓库。
- `start_session` 在某个仓库里开一个新 session，并把任务作为第一条消息发给它。新 session 出现在同一个 ticket 下，你可以看着它、接手、回答它的权限提示。
- `list_sessions` 显示每个 session 在做什么。
- `session_activity` 显示某个 session 的动态和它最后一条命令的输出（最多 4 KB）。
- `end_session` 关掉这个 ticket 里一个已经完成的 session，效果和点它的 × 一样。正在工作的、正显示等你回应的提示的、没在运行的 session，以及调用者自己，它都会拒绝。

有几条刻意设下的限制：
- **通信：** 总控不能往别的 session 里打字。session 之间靠共享的 ticket 记忆协作。
- **session 上限：** 每个 ticket 最多同时运行 6 个终端。归档的 ticket 列在 **已归档** 下，可以从那里恢复。在 Windows 的终端里，Ctrl+V 和右键是粘贴，选中文字时 Ctrl+C 是复制。
- **Feature：几个 ticket，一个工作区。** 一个 feature 有名字，下面归着几个 ticket，比如两个前端 ticket 和两个后端 ticket，各有自己的 Jira 号和分支。用 **+ 新建 feature** 创建。被问到仓库时，你可以选放仓库的那个上层文件夹，比如里面有 `frontend/` 和 `backend/` 的 `~/Code/shop`。Butler 会列出下一层的仓库，你勾选需要的就行。建 ticket 或添加仓库时选上层文件夹也是一样。feature 里每个 ticket 的 worktree 都放在 feature 的工作区里，默认是上层文件夹旁边的 `<上层>-features/<feature 名>`，比如 `~/Code/shop-features/checkout/frontend-dms-1234`。这样同一个仓库里的几个 ticket 可以同时开工。feature 的 **总控** session 运行在工作区里，能看到每个 ticket 的 worktree。它的 `butler-sessions` server 提供：
  - `list_tickets`：列出 feature 的 ticket 和它们的仓库；
  - `list_repos`：列出 feature 的仓库；
  - `create_ticket`：在 feature 里建一个 ticket（ticket 号、可选的标题、用到的仓库和可选的分支），worktree 放在工作区里。ticket 会立刻出现在 Butler 里。所以你可以先和总控把 feature 聊清楚，让它建好 ticket，再让它在每个 ticket 里开 session；
  - `start_session`：在某个 ticket 里开一个 session（ticket 有多个仓库时才需要指定仓库），并给它派任务；
  - `list_sessions`：显示总控和每个 ticket 的 session，以及各自在做什么；
  - `session_activity`：显示某个 session 的动态和它最后一条命令的输出（最多 4 KB）；
  - `end_session`：关掉 feature 里某个 ticket 已经完成的 session，或 feature 的某个修复 session（不能关总控自己）。拒绝的规则和 ticket 总控的一样。

  一个 feature 最多同时运行 8 个终端。它的所有 session 还共享一份 feature 记忆 `butler-feature`，用来记前后端之间的 API 约定这类东西。你自己在工作区文件夹里开的 `claude` 也算这个 feature 的总控。归档 feature 时它的 ticket 一起归档；恢复时一起归档的 ticket 也会恢复。

  feature 页最上面是 **整体进度**：跨 feature 里所有 ticket 的汇总，写着卡在哪里、下一步做什么，下面是 ticket 和它们 PR 的表格。汇总由晚间任务为有新动静的 feature 生成，或者在总控里输入 `/handoff`，或者点 **立即更新**。它从不显示完成百分比。整体进度和 ticket 表格都可以点标题前的三角形折叠；折叠后整体进度只显示汇总的开头，以及有几件事卡着。不管上面内容有多少，终端至少占窗口一半的高度。

  ticket 表格的状态列显示每个 ticket 正在运行的 session 此刻在做什么，每 10 秒刷新一次：写代码（以及哪个文件）、读代码、运行带 pre-push hook 的 `git push`、盯 CI、跑测试或其他命令（以及跑了多久）、思考、等你批准，或者等你回话。一轮对话结束后还在跑的命令标为 **后台**。没有运行中 session 的 ticket 显示它平常的状态；有好几个的，显示最需要你的那个。不在 feature 里的 ticket 暂时还没有这一列。

  **卡住的 session。** 没有固定的超时，所以一个还在干活的慢 pre-push hook 不会被打扰。Butler 每 3 分钟看一次 feature 里每个 ticket 的运行中 session。如果 transcript、命令输出和 session 子进程的 CPU 占用连续两次都没变化，Butler 会用你自己的 `claude`（不带任何工具）问一次：这个 session 是不是真卡住了。它会发送当前动态、最后一条命令的输出和终端末尾的内容。如果答案是"是"，ticket 那一行和侧栏里的 feature 上会出现一个红点。不会弹系统通知。点红点会在这一行下面展开一个面板，写着可能的原因、最后的输出和该怎么办：
  - **开新 session 解决** 在 feature 的工作区里开一个新 session，把详情交给它。卡住的 session 保持运行，两者共用它的 worktree，所以新 session 的任务里写明：切分支或停进程前先告诉卡住的 session，杀任何东西前先问你，问题解决后告诉总控。
  - **看终端** 跳到 ticket 页。
  - **没事，忽略** 清掉红点。只有当这个 session 再动起来、然后又卡住时，红点才会回来。
  - **收起** 关掉面板。红点还在，再点一下就重新打开面板。

  session 有新动态时红点也会自己消失。不经你点击，什么都不会去修；卡住标记只存在内存里，所以 Butler 重启后会重新检查。
- **Epic：几个 feature，一份规划。** 一个 epic 把相关的 feature 归在一起，把进展、决定和待解决的问题从一个 feature 传到下一个，不需要哪个 session 专门写文档给下一个读。feature 不一定要属于某个 epic。用 **+ 新建 epic** 创建，填上名字和它的仓库。它的工作区默认是仓库旁边的 `<上层>-epics/<epic 名>`。feature 保留各自的工作区。

  从规划到开工：
  1. 在 epic 页上打开一个 **epic session**。它运行在 epic 的工作区里，能读 epic 的所有仓库。在里面讨论要做什么、怎么拆成几个 feature。
  2. 某个 feature 定下来后，epic session 用 `create_feature` 建出它。它会传入名字、feature 用到的仓库（从 epic 的仓库里选；epic 只有一个仓库时可以不填）以及一份不超过 4,000 字符的简短规划：做什么、为什么、已经定了什么。这一步不建 ticket。
  3. feature 出现在 epic 页和侧栏的 epic 下面，它的规划在 feature 页上显示为 **规划**。Butler 不会替它打开总控。
  4. 点进 feature，打开它的总控。第一次打开时，Butler 会把规划作为总控的第一条消息发过去，你在终端里能看到。随规划一起发的还有 epic 里其他 feature 的名字、状态、最新进展、阻塞、决定和待解决的问题，已归档的也包括在内并标明已归档。消息里会告诉总控：这些都是数据，不是指令。内容太长时只截断数据部分。恢复总控或再开一个总控时不会再发。没有规划的 feature（比如你移进来的）不会收到这条消息。
  5. 总控建 ticket、开 session，和其他 feature 一样。

  epic session 的 `butler-sessions` server 提供 `list_features`、`list_repos`、`create_feature`、`list_sessions`、`session_activity` 和 `end_session`。`list_sessions` 和 `session_activity` 还会显示每个 session 的最后一条回复。`end_session` 关掉 epic 里某个未归档 feature 已经完成的 session：它的总控、修复 session，或它某个 ticket 的 session。它从不关 epic session 自己，拒绝的规则和 ticket 总控的一样。属于某个 epic 的 feature，其总控还有 `epic_context`，用来查看 epic 里的其他 feature。这两个工具读的都是 Butler 的最新数据，所以 session 不必依赖开始时被告知的内容。

  epic 页每个 feature 一行：汇总的第一句话和一个状态（有 ticket 卡住、等你回话、未开始或进行中）。点一行看详情；ticket 只在 feature 页上列出。归档的 feature 折叠在 **已归档** 下。行下面是仓库、epic session，以及一个至少占窗口一半高度的终端。侧栏里 Epic 分组在 Feature 上面，每个 epic 都能折叠。等待标记和红点会从 ticket 传到 feature 再传到 epic，epic 折叠时也看得见。

  feature 页头部的 **移到 epic** 可以把已有的 feature 移进某个 epic、移出来，或移到另一个 epic。只改归属：工作区和 worktree 都不动。epic 还没有的仓库会加到 epic 上，移出 feature 时不会删 epic 的仓库。已经在运行的 session 要重新打开后才能看到 epic 的记忆。

  归档 epic 会把它的 feature 和这些 feature 的 ticket 一起归档。只要 epic、它的 feature 或这些 ticket 还有终端在运行，Butler 就会拒绝，什么都不改。恢复 epic 时，跟它一起归档的东西也会恢复。你单独归档的 feature 保持归档，但仍然算数：下一个 feature 的总控会读到它。

  epic 没有自己的汇总：没有晚间任务，没有完成百分比，在 epic session 里输入 `/handoff` 也不会存任何东西。规划时的决定记在 epic 的记忆里（见 [StateCore 记忆](#statecore-记忆)）。卡住检测不看 epic session。你自己在 epic 工作区里开的 `claude` 也算 epic session。

  **Epic 会多用你的 Claude 额度。** 为了让下一个 feature 读到新鲜的进展，除了晚间任务，Butler 还会在两个时刻在后台运行你自己的 `claude`：
  - **归档 epic 或其中某个 feature 时。** 自上次汇总以来有动静的 feature 会先生成新汇总，其中有动静的 ticket 会生成 handoff。这期间归档按钮会提示正在进行。全部加起来限时 2 分钟，某个汇总失败或超时的话，归档照样进行，Butler 会记日志。
  - **epic session 调用 `create_feature` 时。** epic 里其他未归档的 feature 会在后台做同样的刷新。`create_feature` 不等它完成。

  发给总控的第一条消息也会在总控一打开时就开始一轮对话。
- **合并总控。** 同一个仓库里的两个 ticket 快要撞车时，Butler 会在合并前介入。它盯着自己开的 session，不管属于哪个 epic、feature 或 ticket，只检查合并进目标分支，以及在共用文件夹里切分支这两类操作。它用 git 判断分支是否冲突，冲突的那个先合进去之前，会先拦下这次合并。详见[配置 Butler](docs/configuration.md#merge-coordinator)。
- **关掉已完成的 session。** 总控或 epic session 可以用 `end_session` 关掉一个已经停下、在等输入的 session。正在工作的、在等你回答的，以及它自己，它都会拒绝。
- **合并后清理 worktree。** 一旦 handoff 报告某个 ticket 的 PR 已合并，Butler 就用 `git worktree remove` 删掉这个 ticket 的 worktree。分支保留，在那里再开 session 时会重建 worktree。有未提交改动或未跟踪文件的 worktree，或者自己的 session 还在终端里运行的，Butler 不会删。这时 ticket 页会说明原因，并给一个 **重新检查** 按钮，那个终端退出时 Butler 也会再试一次。被 `.gitignore` 忽略的文件（`node_modules`、本地的 `.env`）会随 worktree 一起删掉。
- **晚间 handoff。** 在你选定的时间，Butler 让你自己登录好的 `claude` 为每个有动静的 ticket 写一份结构化的 handoff。
  - `Edit`、`Write` 和 `NotebookEdit` 一律禁止。
  - Butler 允许读文件、`gh pr view`、`gh pr checks`、`git log`、`git status`，以及你选定的 tracker MCP 工具。
  - 其他权限都来自你自己的 Claude Code 设置：用户级的 allow 规则（这些运行使用 `--setting-sources user`）和托管的策略设置。
  - 这些运行并不是严格只读的。如果你的设置允许了比如 `Bash(npm:*)` 或一个能写的 MCP 工具，它们也能用。

  在 session 里你也可以输入 `/handoff`。在 feature 的总控里，`/handoff` 写的是 feature 的汇总而不是 ticket handoff，之后 Butler 会在后台为自上次 handoff 以来有动静的 ticket 补写 handoff。
- **首页。** **现在** 页列出 Butler 开的每个 session，按 epic、feature 和 ticket 分组，显示每个在做什么、它的 PR 和 CI，以及已经做了多久。等你的 session（一个问题、一个确认，或卡住了）置顶在 **需要你** 下面，侧栏入口会显示有几个。点一行打开它的终端。最下面一行显示最近 7 天的 token 用量：总量、缓存读取的占比，以及上下文达到 20 万 token 以上的轮次占比。它统计 Butler 开的 session、它们的子 agent，以及 Butler 在后台启动的 `claude` 运行（handoff、feature 汇总、卡住检测），数据读自你本机上 Claude Code 的 transcript。点这一行能看到按类别（**ticket session**、**总控**、**子 agent**、**后台任务**）和按模型的拆分。占比按相对价格加权，只用于比较；Butler 不会换算成钱。
- **防止休眠。** 想在你离开、盖子开着的时候让 session 继续跑，就勾上侧栏底部或托盘菜单里的 **防止休眠**。开着时电脑空闲也不会睡眠，屏幕保持亮着。取消勾选、电脑睡眠（合上盖子）或 Butler 退出时它会关掉，Butler 每次启动时它都是关的。合上盖子照样会让 Mac 睡眠；Windows 上取决于你的合盖设置。
- **记忆。** 进展、决定、未完成的跟进和跨 ticket 的经验都存进本地的 [StateCore](https://github.com/yul761/StateCore)。Butler 开的每个 session 都能 `recall` 它们。ticket 页有个 **记忆** 标签页，能看到每条记录的历史。
- **可选的个人 LLM API。** 在"完整"隐私档位下，Butler 会在每次晚间任务之后，用一个你自己付费的、兼容 OpenAI 的 API 来蒸馏 StateCore 记忆。每次调用都经过隐私网关，有审计页和每月预算。在你配置服务商并选择"完整"档位之前，什么都不会发出去；见[隐私模型](#隐私模型)。

## Butler 不会碰的东西

- **你的 Claude Code 配置。** 只有当你点安装 hook 时 Butler 才会改它，要么在首次运行向导里，要么在 **设置 → 环境检查 → 安装 / 修复**。这会往你用户级的 `settings.json` 里加四个 hook 和一个 `/handoff` 命令。你的其他 hook 和命令都会保留。记忆从不通过 `claude mcp add` 注册，而是在 Butler 启动每个 session 时通过命令行参数 `--mcp-config` 传入。
- **你的 tracker 和代码托管平台。** Butler 自己没有 Jira、GitHub 或 Claude 登录。Jira、Linear、GitLab 或其他 tracker 只由你公司的 Claude Code 通过它自己的 MCP server 读取。PR 由 `claude` 用你的 `gh` 读取。
- **网络。** Butler 里唯一的网络代码是给可选个人 API 用的隐私网关。有一条 lint 规则强制保证这一点。

## 系统要求

- Apple silicon 的 macOS，或 Windows 10/11 x64。Intel Mac 可以[从源码构建](CONTRIBUTING.md)。
- 已安装并登录 Claude Code。终端里 `claude --version` 必须能运行。
- `PATH` 上有 Git。Windows 上请安装 **Git for Windows**：Claude Code 通过 Git Bash 运行 hook，而 Butler 在 `PATH` 上找不到 `git.exe` 时完全不会运行 git。
- 可选：在 Claude Code 里配置好一个 tracker MCP server（Jira、Linear、GitLab……），handoff 就能读到 ticket 状态。

## 安装

从本仓库的 Releases 页面下载最新版本：

- macOS：`Butler-x.y.z-arm64.dmg`（或 `Butler-x.y.z-arm64-mac.zip`）
- Windows：`Butler-Setup-x.y.z.exe`

大小（在本地 macOS 1.0.0 构建上测得，Windows 安装包未测）：

- **dmg** 约 175 MB。
- **安装后的 app** 约 457 MB。其中约 288 MB 是 Electron 的框架，约 143 MB 是 `butler-hook`，也就是 Claude Code 每次触发 hook 时运行的程序。它是内置 Node 26.3.0 的 Node 单文件可执行程序。
- **安装 hook** 会把 `butler-hook` 复制到 `~/.butler/bin`。

这些构建**没有代码签名**，所以浏览器和系统会警告你。

### macOS（Gatekeeper）

app 是 ad-hoc 签名，没有经过公证，而且 macOS 版只有 arm64。

1. 打开 `.dmg`，把 Butler 拖进"应用程序"。
2. 打开 Butler。macOS 会拒绝：提示 Apple 无法验证这个 app，或者无法验证开发者。
3. 用下面任一方法放行：
   - **方法 A：仍要打开。** 打开 **系统设置 → 隐私与安全性**，往下滚到关于 Butler 的提示，点 **仍要打开** 并确认。在 macOS 14 及更早版本上，也可以在"应用程序"里右键（Control-点按）Butler，选 **打开**，再点一次 **打开**。
   - **方法 B：终端。** 去掉 app 及其内部所有文件的隔离标记，然后正常打开 Butler：

     ```sh
     xattr -dr com.apple.quarantine /Applications/Butler.app
     ```

如果 macOS 提示 Butler "已损坏，无法打开"，就不会有 **仍要打开** 按钮，请用方法 B。

每次下载新版本后都要重复一遍。

### Windows（SmartScreen）

NSIS 安装包目前没有签名（见[代码签名政策](#代码签名政策)）。

1. 浏览器可能会警告这个下载。在 Edge 里，打开下载项的 **…** 菜单，选 **保留**。
2. 运行 `Butler-Setup-x.y.z.exe`。
3. SmartScreen 提示"Windows 已保护你的电脑"。点 **更多信息 → 仍要运行**。
4. 选"仅为我安装"（不需要管理员权限）和安装文件夹。

如果开着 Windows 11 的**智能应用控制**，它会拦下未签名的 app，而且不提供"仍要运行"。开着它时装不了 Butler。关掉它之前请先看 Microsoft 的说明。

没有自动更新。升级时下载新版本，直接覆盖安装。你在 `~/.butler` 里的数据会保留。

## 首次运行

一个简短的向导 **欢迎使用 Butler** 会带你走完这几步：

1. **检查 Claude Code。** Butler 在你登录 shell 的 `PATH` 上找 `claude`，或者由你给出绝对路径。它还会检查 `claude --help` 是否列出了 Butler 依赖的参数。没有能用的 `claude` 就无法继续。
2. **安装 hook 和 /handoff 命令。** Butler 把四个 hook（`SessionStart`、`Stop`、`UserPromptSubmit`、`SessionEnd`）合并进你用户级的 Claude Code `settings.json`，保留你已有的 hook。
   - 第一次会把原文件备份为 `settings.json.butler-backup`。
   - 还会写入 `commands/handoff.md`。
   - 这些 hook 只往 `~/.butler/inbox` 里放小 JSON 文件。它们从不访问网络，退出码永远是 0。
   - 要移除它们，用 **设置 → 环境检查 → 卸载**。
3. **tracker 的 MCP 工具。** Butler 列出你的 Claude Code 暴露的 MCP 工具，由你挑出 handoff 可以调用的只读工具。
4. **隐私档位与个人 API（可选）。**

向导可以在设置里重新运行。[docs/configuration.md](docs/configuration.md) 介绍了每一项设置，包括怎么让 Butler 适配别的公司的 tracker 和习惯。

## 数据存放位置

| 路径 | 内容 |
|------|------|
| `~/.butler/app.db` | ticket、session、handoff、跟进事项、设置、LLM 审计日志和加密后的 API key（SQLite）。旧版本留下的行（早间简报、敏感词列表）还在，但已不再使用。 |
| `~/.butler/statecore/statecore.db` | StateCore 记忆 |
| `~/.butler/inbox/` | 等待处理的 hook 报告（读不了的放在 `inbox/bad/`） |
| `~/.butler/bin/butler-hook` | Claude Code 运行的 hook 程序（Windows 上是 `butler-hook.exe`） |
| `~/.butler/mcp/tickets/<ticket>.json` | 记忆用的 `--mcp-config` 文件，每次为这个 ticket 打开 session 时重写 |
| `~/.butler/mcp/features/<id>.json` | feature 总控的 `--mcp-config` 文件 |
| `~/.butler/mcp/epics/<id>.json` | epic session 的 `--mcp-config` 文件，epic 归档时删除 |
| `~/.butler/workspaces/<ticket>/` | ticket 总控运行所在的空文件夹 |
| `~/.butler/mcp/project-*.json`、`local-*.json` | 给无人值守运行用的 MCP server 配置副本。只有开启 **后台 handoff 也加载本地级的 MCP…**（`headlessProjectMcp`）时才会写。因为可能含有 token，这些是私有文件。 |
| `~/.butler/logs/main.log` | 日志 |

feature 的工作区不在 `~/.butler` 下：它在你的仓库旁边（见[功能](#功能)），放着这个 feature 的 worktree。epic 的工作区也在仓库旁边。

Windows 上 `~` 是 `%USERPROFILE%`。设置 `BUTLER_HOME` 可以换一个文件夹。Butler 读取的 Claude Code 配置和它安装的 hook 也遵循 `CLAUDE_CONFIG_DIR`。

除了安装 hook，Butler 对 Claude Code 的文件只读不写：

- `settings.json`：hook 状态、插件检查、MCP 批准情况
- `commands/handoff.md`：是不是 Butler 自己写的
- `~/.claude.json`：你的 MCP server 和批准情况
- `~/.claude/projects` 下的 session transcript：未认领 session、`/handoff` 的输出和 feature 页的实时状态
- Claude Code 在系统临时目录（macOS 上是 `/private/tmp`）下 `claude-<uid>/<project>/<session>/tasks/` 里写的命令输出文件：实时状态和卡住检测
- `~/.claude/sessions/` 里的 session 登记文件：运行中 session 的名字，这样修复 session 才能给它发消息
- 开启 **后台 handoff 也加载本地级的 MCP…**（`headlessProjectMcp`）时，仓库的 `.mcp.json` 和 `.claude/settings.local.json`，用来找到你批准过的 server

transcript、输出文件和登记文件都是 Claude Code 的内部文件，更新可能会改变它们。Butler 读不了时，实时状态会退回到只显示命令和它跑了多久。

你的个人 API key 用系统钥匙串加密（macOS 钥匙串 / Windows DPAPI）。保存后，界面最多显示它的最后 4 个字符。短于 12 个字符的 key 只显示为 `••••`。

Butler 只在你保存 key 时，以及之后需要显示最后 4 个字符或调用你的 API 时才会用到钥匙串。如果你从没保存过 key，Butler 从不碰钥匙串。

在 macOS 上，可能会弹框问 Butler 能否使用钥匙串里的"butler Safe Storage"（Electron 用 app 的内部名 `butler` 来命名这一项）。点 **始终允许**。这些构建是 ad-hoc 签名，不是 Developer ID 签名，所以 macOS 把每个新版本都当作不同的 app，每次升级后都会再问一次。如果定时的记忆蒸馏需要 key，这个弹框可能在启动时就出现。你回答之前，Butler 的窗口不会响应。如果点了 **拒绝**，Butler 读不了已保存的 key，设置里会显示为无法读取；重新输入一次即可。

Electron 还有自己的配置文件夹，里面是 Chromium 的缓存和单实例锁：macOS 上是 `~/Library/Application Support/butler`，Windows 上是 `%APPDATA%\butler`。设置了 `BUTLER_HOME` 时，Butler 改用 `<BUTLER_HOME>/electron`。在 Windows 上，这个文件夹还存着保护已保存 API key 的 DPAPI 加密密钥，所以删掉它之后要重新输入 API key。

## StateCore 记忆

Butler 内置了 StateCore。Butler 启动的每个 session 都有两个不需要 key 的 MCP server：`butler-memory` 存这个 ticket 的记忆，`butler-workspace` 存跨 ticket 共享的经验。feature 里 ticket 的 session 还有 `butler-feature`，即 feature 的记忆（scope 为 `feature:<id>`），feature 的总控也有它，外加 `butler-workspace`。

epic 下的所有东西还有 `butler-epic`，即 epic 的记忆（scope 为 `epic:<id>`）：epic 的 session、它的 feature 的总控，以及这些 feature 下所有 ticket 的 session。它分两部分，互不挤占空间。规划笔记是 epic session 用 `remember` 存下的内容，计入这个 scope 的 30 条上限。各 feature 的状态是 Butler 写进这个 scope 的一份 handoff，每当某个 feature 有了新汇总，或被移进、移出时就重写。它涵盖最近的 10 个 feature，已归档的也包括并标明，最多 8,000 字符。最旧的 feature 最先被去掉。

**不要再另外安装 StateCore 自己的 Claude Code 采集插件。** Butler 已经在它启动的 session 里提供了 StateCore 记忆，两个都装的话记忆会记两遍。设置页发现这个插件时会提醒你。

- **StateCore 拿不到任何模型 key。** Claude Code 启动的记忆 server 不会得到模型 API key：Butler 会从它们的环境变量里去掉模型相关的变量。Butler 自己写入的内容（handoff、决定、跟进事项、经验）是确定性的，不需要模型。
- **蒸馏，只在"完整"档位。** 当隐私档位是 **完整** 且"发送前确认"关闭时，Butler 通过你的个人 API 运行 StateCore 的蒸馏。调用由 Butler 主进程发起，key 一直留在隐私网关里。每次晚间 handoff 之后都会在后台运行蒸馏，包括补跑和 **立即运行晚间 handoff**。对每个有待处理事件的 scope，调用会发送：
  - scope 名，对 ticket 来说就是真实的 ticket 号（`ticket:<KEY>`）
  - 这个 scope 最近的原始事件，包括 Claude 用 `remember(consolidate: true)` 存下的内容
  - 这个 scope 现有的记忆（JSON）：Butler 的跟进和决定笔记、Claude 自己的笔记，以及上一份摘要和其中的下一步
  - 这个 scope 里被 forget 的笔记原文，免得模型把它们又带回来

  在 `workspace` scope 里，每条经验都标着它来自哪个 ticket。**这些内容都不做假名化，也不做扫描。** 每次发出的调用都以 **StateCore 记忆蒸馏** 记在审计页上，并计入你的每月预算。
- **每个 ticket 最多 30 条有效笔记。** StateCore 每个 scope（每个 ticket 一个 scope）最多保留 30 条笔记。从 statecore-mcp 1.1 起，完成的跟进和被替换的决定会让出位置，蒸馏也不会把 Butler 的笔记挤出去。但如果同时有超过 30 条未完成的跟进和决定（Butler 自己最多保留 24 条），或者 Claude 自己写了很多笔记，一个 ticket 仍然可能写满。见 [docs/configuration.md](docs/configuration.md#how-memory-works)。

## 隐私模型

公司的工作只经过你公司的 `claude`。可选的个人 API 只用来做一件事：在 **完整** 隐私档位下蒸馏 StateCore 记忆。它会发送真实的 ticket 号、原始对话片段和现有的记忆，不做扫描（见 [StateCore 记忆](#statecore-记忆)）。在 **关闭**、**仅元数据（默认）** 和 **脱敏文本** 档位下，个人 API 从不会被调用。

**审计** 页列出每一次发出的调用，以及因超出预算而被拒绝的调用。有些拒绝只写进日志，比如因为档位变了而被拒绝的蒸馏调用，或者已保存的 key 无法再解密。

## 代码签名政策

**现状：** 目前的 Windows 安装包没有签名。Butler 已经申请了 [SignPath Foundation](https://signpath.org) 项目，它为开源项目提供免费的代码签名。申请通过后这一节会更新。

**通过之后：**
- **签什么。** 只签 `Butler-Setup-<version>.exe`。它必须由 GitHub Actions 上的 [`.github/workflows/release.yml`](.github/workflows/release.yml) 从这个公开仓库的版本 tag 构建。任何人在自己机器上做的构建都不会被签名。
- **谁来签。** 安装包上会写明：free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)。证书属于 SignPath Foundation，所以 Windows 显示的发布者是他们的名字。
- **审批。** 每个版本的签名请求都由人手动批准。

团队角色：

- **提交者和审阅者：** [@yul761](https://github.com/yul761)
- **审批者：** [@yul761](https://github.com/yul761)

### 隐私政策

除非用户或安装、运行本程序的人明确要求，本程序不会向其他联网系统传输任何信息。

- **网络。** Butler 不发送遥测数据，没有账号或许可证检查，也不检查更新。
- **Claude Code。** Butler 启动的是你自己的 `claude` CLI。这个 CLI 以你的登录和设置连接 Anthropic，或者你公司配置的地址。
- **个人 API。** 只有你配置了个人 LLM API，Butler 才会调用它，而且只发送你所选隐私档位允许的内容（见[隐私模型](#隐私模型)）。
- **本地数据。** Butler 存的所有东西都留在你的电脑上（见[数据存放位置](#数据存放位置)）。

## 已知问题

- 构建没有签名（见上文）。macOS 版只支持 Apple silicon。
- 没有自动更新。
- 每次升级后，macOS 都会再问一次能否访问钥匙串里已保存的 API key（因为是 ad-hoc 签名）。没保存 key 就不会弹。
- **实时状态的局限。** 管道接到 `| tail` 的命令在结束前什么都不输出，所以状态里看不到它的输出。在 Windows 上，Butler 不检查子进程的 CPU，也可能找不到命令的输出，所以状态可能只显示命令和它跑了多久。
- **Windows 上用 npm 安装的 Claude Code。** Butler 不经过 `cmd.exe`，直接启动 npm/pnpm 的 `claude.cmd` shim 指向的目标，可能是原生的 `claude.exe`，也可能是 `node <script>`。
  - 如果 Claude Code 是用 `--ignore-scripts` 安装的，或者缺了原生的可选包，`bin\claude.exe` 只是一个小小的占位文件。
  - 这时 session 会启动失败，而且看不到 npm 那句"native binary not installed"的提示。
  - 解决办法是不带 `--ignore-scripts` 重新安装 Claude Code。

## 卸载

1. **设置 → 环境检查 → 卸载** 会从 Claude Code 里移除 Butler 的 hook 和 `/handoff` 命令。
2. 删除 app。macOS 上把 Butler 从"应用程序"里拖出去。Windows 上在 设置 → 应用 → Butler → 卸载。
3. 如果也要删除数据，删掉 `~/.butler`。以上步骤都不会删除 Electron 的配置文件夹（macOS 上是 `~/Library/Application Support/butler`，Windows 上是 `%APPDATA%\butler`）；要卸载干净，把它也删掉。在 macOS 上，如果你保存过 API key，还可以在"钥匙串访问"里删掉"butler Safe Storage"这一项。

## 开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。

## 许可证

[MIT](LICENSE)
