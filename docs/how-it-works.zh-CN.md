# Shipherd 是怎么工作的

[English](how-it-works.md) | **简体中文**

几个 ticket 可以归成一个 epic。一个 epic 就是一块完整的工作，比如一个 Jira epic：它有一个工作区、一个总控 session 和一份共享记忆，里面的 ticket 还可以分成几个按顺序推进的 feature。和 epic 总控商量好要做什么，它会替你建 ticket、把它们分进 feature、在每个 ticket 里开 session、派任务。session 之间不直接对话，而是靠本地 StateCore 里分层的共享记忆互通：一个 session 记下的进展和决定，同一个 ticket 或 epic 里的其他 session 都能读到。**轮到你** 页把需要你处理的排在最前面，**全部工作** 页按 epic、ticket 列出每个 session 在做什么。session 有要你拍板的事，会用 `ask_user` 提出来，用 `report` 汇报进展；它们显示在 epic 和 **全局总控** 页面的 tab 里。每晚 Shipherd 还会为有进展的 ticket 写一份交接（handoff）。

## ticket 和 session

![ticket 的概况 tab：等你的 PR、agent 最后说的话、分支](media/ticket.zh-CN.png)

每个 ticket 有自己的 worktree 或分支、自己的 Claude Code session（内嵌终端）、PR 状态和合并后的跟进事项。打开 **设置 → 基本 → 显示 Shipherd 之外开的 session**（`showOutsideSessions`，默认关）以后，最近 7 天里你在 Shipherd 之外开的 session 会出现在 **全部工作 → 未认领 session** 下，可以把它们挂到某个 ticket 上。关着时 Shipherd 不扫描 `~/.claude/projects` 去找它们。一个 ticket 可以跨几个仓库（比如一个前端加一个后端）：建 ticket 时可以选仓库也可以不选，之后在 ticket 页上再加。每个仓库有自己的工作方式和分支，之后可以用 **编辑** 修改。新建 session 时会问你在哪个仓库里工作。正在运行的 session（包括总控开的）按钮旁边有个 ×：点两下就结束这个 session。它的对话会保留，再点按钮就能重新打开。没在运行的 session 也可以用同一个 × 隐藏，它只是从列表里拿掉（对话仍在），**已隐藏** 能把它找回来。Shipherd 开的 session 不会卡在 Claude Code 询问"要启用仓库 `.mcp.json` 里哪些 server"那一步：Shipherd 会替你启用，你之前在这个仓库里关掉的除外。一个 ticket 的所有 session 共享它的记忆。ticket 没有自己的总控：它的几个 session 各干各的，在 epic 里由 epic 总控（见 [Epic](#epic)）来开、来管。每个 ticket 的 session 都有一个 `shipherd-sessions` MCP server，提供 `ask_user` 和 `report`（见[提问和汇报](#提问和汇报)），以及 [预审](configuration.zh-CN.md#预审就绪和风险) 用的 `submit_evidence` 和 `pre_review_result`。

新 ticket 的分支从远端的默认分支开：Shipherd 先 fetch origin，再从 `origin/<默认分支>`（`origin/HEAD`，或者 `main` / `master`）开，不管你的 checkout 停在哪个分支，也不去动它。离线时用上次 fetch 到的，没有远端的仓库从本地的 `main` 开。用 `stack_on` 叠在另一个 ticket 上的，仍从下层 ticket 的分支开。

Shipherd 给新 session 交第一条任务之前，会先看真实的终端屏幕，所以不会在信任对话框或权限确认上按回车；交完之后还会确认任务真的提交了。

有几条刻意设下的限制：
- **通信：** 总控从不直接往别的 session 里打字，而是通过它们的信箱说话（见[信箱](#信箱)）；session 之间也共享 ticket 和 epic 记忆。
- **同时开几个 session：** 内存够就能开。开新 session 前，Shipherd 会检查可用内存减去一个新 session 的占用后，还高于你在设置里定的保留量（见[同时开几个 session](configuration.zh-CN.md#同时开几个-session)）；ticket、epic 都没有写死的个数。归档的 ticket 列在 **已归档** 下，可以从那里恢复。在 Windows 的终端里，Ctrl+V 和右键是粘贴，选中文字时 Ctrl+C 是复制。

## 信箱

Shipherd 开的每个 session 都有一个信箱。Shipherd 或别的 session 发给它的东西都进信箱：总控的消息、汇报、`ask_user` 的回答、预审结果、PR 评论、CI 结论、合并通知、栈冲突、每日巡检、花费提醒、换新以后的「接着做」、你在对话 tab 里发的话、回复。消息排在 Shipherd 的数据库里，重启也不丢，也不会因为对方在忙而被退回。正在干活的 session 在下一次调用工具时收到，走它自己那份 session 设置里的 `PostToolUse` hook，几条合成一次送。关着的 session 先恢复（见 [session 的收尾和换新](#session-的收尾和换新)）。停着的 session 用和交第一条任务一样的安全输入送进去：先看屏幕，你在打字时等着，送完再确认真的提交了。总控的消息可以要求叫停：Shipherd 先按 Esc，再输入进去。一个 session 的信箱空着时，hook 只是一次 shell 判断，不启动 Shipherd 的 hook 程序（Apple 芯片的 Mac 上约 2 毫秒，直接启动约 28 毫秒）。epic 里一个 session 往 epic 记忆里存了东西，这个 epic 里别的在跑的 session 会收到这条**约定**，写的那个 session 自己不收。每条消息是 **已排队**、**已送达**（工具调用间隙送到，或者直接输入）或 **已回复**。**全局总控** 页面和 epic 的 **总控** tab 上的 **消息（N）** 列出最近的几条。

## Epic

一个 epic 有名字，下面归着几个 ticket，比如两个前端 ticket 和两个后端 ticket，各有自己的 Jira 号和分支。用 **+ 新建 epic** 创建。被问到仓库时，你可以选放仓库的那个上层文件夹，比如里面有 `frontend/` 和 `backend/` 的 `~/Code/shop`。Shipherd 会列出下一层的仓库，你勾选需要的就行。建 ticket 或添加仓库时选上层文件夹也是一样。epic 里每个 ticket 的 worktree 都放在 epic 的工作区里，默认是上层文件夹旁边的 `<上层>-features/<epic 名>`，比如 `~/Code/shop-features/checkout/frontend-dms-1234`。这样同一个仓库里的几个 ticket 可以同时开工。一个 epic 有一个 **epic 总控** session，它运行在工作区里，能看到每个 ticket 的 worktree。它的 `shipherd-sessions` server 提供：

- `list_tickets`：列出 epic 的 ticket、它们的仓库和各自所在的 feature；
- `list_repos`：列出 epic 的仓库；
- `create_ticket`：在 epic 里建一个 ticket（ticket 号、可选的标题、用到的仓库、可选的分支，还可以指定放进哪个 feature，或者用 `stack_on` 叠在另一个 ticket 上面），worktree 放在工作区里。ticket 会立刻出现在 Shipherd 里。所以你可以先和总控把 epic 聊清楚，让它建好 ticket，再让它在每个 ticket 里开 session；
- `start_session`：在某个 ticket 里开一个 session（ticket 有多个仓库时才需要指定仓库），并把任务作为第一条消息发给它。新 session 出现在它的 ticket 下，你可以看着它、接手、回答它的权限提示；
- `list_sessions`：显示总控和每个 ticket 的 session，以及各自在做什么、最后一条回复的结尾；
- `send_message`：把一条消息放进 epic 里某个 ticket session 或修复 session 的信箱，它正在干活也行。带 `interrupt` 时 Shipherd 先按 Esc。它这一轮最后一段回复会送回总控；
- `session_activity`：显示某个 session 的动态和它最后一条命令的输出（最多 4 KB）；
- `end_session`：关掉 epic 里某个 ticket 已经完成的 session，或 epic 的某个修复 session，效果和点它的 × 一样。正在工作的、正显示等你回应的提示的、没在运行的 session，以及总控自己，它都会拒绝。休眠的 session（Shipherd 为了省内存结束了它的进程，`list_sessions` 里标着 `hibernated`）仍然算在 session 上限里；对它调用 `end_session`，Shipherd 就不再唤醒它，名额也空出来；
- `refresh_session`：等这些 session 停下来以后给它换一个新的上下文（见 [session 的收尾和换新](#session-的收尾和换新) 里的 **换新不丢对话**）；
- [feature 工具](#epic-里的-feature)、[栈](configuration.zh-CN.md#栈) 的工具，以及 `ask_user` 和 `report`。

它的所有 session 还共享 epic 的记忆 `shipherd-feature`，用来记前后端之间的 API 约定这类东西。你自己在工作区文件夹里开的 `claude` 也算这个 epic 的总控。归档 epic 时它的 ticket 一起归档；epic 或它的 ticket 还有终端开着时 Shipherd 会拒绝。恢复时一起归档的 ticket 也会恢复。

### epic 里的 feature

feature 是一个轻量的分块：一个名字、可选的说明、在 epic 里的先后位置，加上一组 ticket。它没有自己的总控、工作区和记忆。由 epic 总控来管：

- `list_features`：按顺序列出 feature，每个带着它的 ticket、状态和合了几个，还有还不在任何 feature 里的 ticket；
- `create_feature`：建一个 feature（名字在 epic 里不能重复，说明可选、最多 2000 字，还可以用 `before` 指定排在哪个 feature 前面，不指定就排在最后）；
- `reorder_features`：重新排顺序，每个 feature 都要列到，而且只列一次；
- `set_ticket_feature`：把一个已有的 ticket 放进某个 feature，或者传 `null` 把它从所有 feature 里拿出来。从 Jira 导进来的 ticket 就是这样分进 feature 的。

总控被告知按顺序推进 feature，一次推一个，互不相关的可以同时推。一个 ticket 最多在一个 feature 里。界面上没有建、改名或排序 feature 的按钮：让总控去做，epic 页会显示结果。`reorder_features` 和 `set_ticket_feature` 只改 Shipherd 里怎么分组，所以不弹权限确认；`create_feature` 会弹。

### epic 页

![epic 页，ticket 按 feature 分块](media/epic.zh-CN.png)

epic 页有五个 tab：**概况**、**进行中**、**全部 ticket**、**总控** 和 **状态**。同一时间只显示一个，都不会收起，页面记着上次停在哪个 tab。**概况** 先是一行进度（合了几个 ticket、几件事轮到你）和最慢的 ticket，然后是 **这个范围里轮到你的** 下的卡片。再往下，epic 有了 feature 以后，**feature** 一节按顺序每个 feature 一行，可以展开收起，写着它的 ticket 合了几个；展开后用和 **全部 ticket** 一样的列显示它的 ticket，第一个还没全合的 feature 默认展开。不在任何 feature 里的 ticket 放在最后一行 **不在任何 feature 里**。还没有 feature 的 epic 则每个 ticket 一行，写着它的 PR 合了几个（或者 **还没开 PR**），还有一条按每个 PR 轮到谁上色的进度条。有卡片在等你时，**概况** 这个 tab 名会标红。**进行中** 列出此刻不用你动手、正在往前走的事：agent 在干活，或者在等 CI、某位 reviewer、合并队列、栈里下面那层 PR，写明是谁、这样多久了。**全部 ticket** 是下面说的表格，按同样的顺序按 feature 分组。**总控** 左边是仓库、总控 session 和终端，右边是对话：你和总控的来回，这个 epic 里 session 的汇报按时间穿插在里面。**状态** 里是跨 epic 里所有 ticket 的汇总，写着卡在哪里、下一步做什么；epic 有规划时还有它的 **规划**。汇总由晚间任务为有新动静的 epic 生成，或者在总控里输入 `/handoff`，或者点 **立即更新**。它从不显示完成百分比。

**全部 ticket** 每个 ticket 一行：谁该动（你、agent，或者外面的人和事，比如 CI 或点了名的 reviewer），**现在怎么样**（这一轮的那句话，比如"agent 在修 CI"或"在等某某 review"），以及它的 PR。每行显示这个 ticket 的轮次（见 [PR 进度](#pr-进度)），ticket 还有别的开着的 PR 时后面跟着"· 另有 N 个 PR"。epic 有 feature 时，每个 feature 有一行标题，写着名字和它的 ticket 合了几个。点一行打开这个 ticket。

侧栏里每个 epic 是一行，可以收起，下面是它的 ticket，排在不属于任何 epic 的 ticket 上面。每个 ticket 和 epic 都有一个按轮到谁上色的圆点和等你处理的数量；从 ticket 往 epic 累加，epic 收起时也看得到。

### 卡住的 session

没有固定的超时，所以一个还在干活的慢 pre-push hook 不会被打扰。Shipherd 每 3 分钟看一次它开的每个运行中的 session，总控和不在 epic 里的 ticket 也算。如果 transcript、命令输出和 session 子进程的 CPU 占用连续两次都没变化，Shipherd 会用你自己的 `claude`（不带任何工具）问一次：这个 session 是不是真卡住了。它会发送当前动态、最后一条命令的输出和终端末尾的内容。如果答案是"是"，**轮到你** 页和它所在 epic 的 **这个范围里轮到你的** 里会出现一张 **卡住了** 卡片，侧栏里这个 ticket 和它的 epic 也会显示卡住的圆点。不会弹系统通知。卡片写着哪里不对，有建议时也写上建议怎么做，按钮有：

- **去看看** 打开 ticket 页，落在卡住的 session 的终端上。
- **开修复 session** 在 epic 的工作区里开一个新 session，把详情交给它。卡住的 session 保持运行，两者共用它的 worktree，所以新 session 的任务里写明：切分支或停进程前先告诉卡住的 session，杀任何东西前先问你，问题解决后告诉总控。
- **没事，忽略** 拿掉这张卡片。只有当这个 session 再动起来、然后又卡住时，卡片才会回来。只有因为"很久没输出"判成卡住时才有这个按钮，因为只有这种可能是误判（比如在跑很长的测试）。

session 有新动态时卡片也会自己消失。不经你点击，什么都不会去修；卡住标记只存在内存里，所以 Shipherd 重启后会重新检查。修复 session、复盘分析的 session，以及已归档的 ticket 或 epic 里的 session 不检查。

### 从 Jira 来

[自动接活](configuration.zh-CN.md#自动接活) 从你的 tracker 拉 ticket 时，每个 ticket 的上级 epic 决定它去哪里。在某个 Jira epic 下的 ticket 会进对应这个 Jira epic 的 Shipherd epic；还没有（或者只有已归档的）时，Shipherd 会用 Jira epic 的 key 和标题新建一个。之后由 epic 总控把新 ticket 分进 feature。没有 Jira epic 的 ticket 照样单独放。

### 从旧的 epic 层升级

以前的版本在 feature 上面还有一层 epic，有自己的规划 session，每个 ticket 也可以有自己的总控。这两样都去掉了。升级后第一次启动时：

- 每个旧 feature 变成一个独立的 epic，工作区、worktree、总控和记忆都留在原处；
- 旧 epic 的计划加进它原来每个 feature 的 **规划**，它的规划 session 记在记忆里的内容也复制进每个新 epic 的记忆，放在 **以前的约定** 下（见 [StateCore 记忆](#statecore-记忆)）；
- 旧 epic 被归档，工作区留在磁盘上；
- 旧 epic 的规划 session 和每个 ticket 自己的总控被隐藏，留在 **已隐藏** 里；从那里重新打开的这类总控会作为普通的 ticket session 接着跑；
- 这些 session 还没送出的汇报、这些 epic（原来的 feature）的总控还没送给旧 epic 规划 session 的汇报被丢掉；ticket session 的汇报照样送给它的 epic 总控。规划 session 还没回答的问题也收掉，因为再没有终端能收到回答；ticket 总控的问题留着等你回答。

## 提问和汇报

Shipherd 开的每个 session 都有两个工具，`ask_user` 和 `report`，所以你不用再在终端里翻找正在等你的那个问题。

- `ask_user` 记下一件要你拍板的事，可以带选项和背景，然后这一轮结束。
- `report` 把进展交给 session 上面的总控和你。类型是 `progress`（进展）、`done`（完成）、`blocked`（卡住）或 `choice`（有一个明显该推荐的选项时，session 替你做的选择）。epic 里 ticket 的 session 和修复 session 发的 `done`、`blocked` 汇报，放进 epic 总控的信箱（见[信箱](#信箱)）。单独的 ticket、epic 总控和全局总控发的汇报只存不送，并告诉 session 没有管它的总控；全局总控用 `list_inbox` 看得到它们。`progress` 和 `choice` 只存不送。
- epic 的 **总控** tab 右边，它的 session 的汇报按时间穿插在和总控的对话里，标明是谁、什么时候（还没有总控 session 时只列汇报）；**全局总控** 页也一样，带上所有地方最近的 30 条汇报。未决的 `ask_user` 问题在 **轮到你** 页和它所在 epic 的 **这个范围里轮到你的** 下是一张卡片，显示问题、最多两个选项按钮和 **去看看**（打开那个 session 的终端）。在 ticket 的 **概况** tab 里，还开着的 session 问的问题就是这个 ticket 的轮次，占最上面一行，只有一个 **去回答** 按钮，点了切到 **终端** tab。别的提问（同一个 session 后来又问的，或者发问的 session 已经结束了的）在下面各占一行，带最多两个选项按钮和 **去看看**；这里的 **去看看** 只切到 **终端** tab，不会换到发问的那个 session。没有回答框：第三个及以后的选项，或者想用自己的话回答，都在终端里答。
- 点按钮的回答放进 session 的信箱，送的时候是"你问的『…』，用户的回答：…"：在干活的 session 下一次调用工具时收到，停着的直接输入进去。点完以后，卡片或那一行会写明正在送。ticket **概况** 里的提问行切到别的 tab 再回来，这个状态还在；送进去之前离开这个 ticket 再回来，问题会重新出现，再答一次会换掉之前的回答。如果你先在终端里回答了，卡片自己消失。
- session 这边，只有真要你拍板的事才有卡片：屏幕上的权限确认、提问或退出计划模式的确认，未决的 `ask_user`，真的卡住的 session，以及确实在请你决定的回复。"要我继续吗？""还有别的吗？"这类回复不算，总控也不会为子 session 已经提过的事再出现一张。PR 也会出卡片（**可以合并**、**要你 review**，以及 **没人推进**，比如 CI 挂了没有 session 在修），需要你的 Shipherd 提醒也是（**Shipherd 要你点一下**，见[「轮到你」页](#轮到你页)）。侧栏 **轮到你** 旁边的数字是所有这些卡片的个数。
- 这两个工具在 Shipherd 给 session 写的设置里是放行的，第一次用不会弹权限确认；同一个 server 的其他工具照样要确认。

## 「轮到你」页

![「轮到你」页，每件等你的事一张卡片](media/your-turn.zh-CN.png)

**轮到你** 页是侧栏的第一项，入口会显示有几件事等你。每件要你处理的事在最上面有一张卡片：等一个确认、一个未决的提问、一条请你决定的回复或真的卡住了的 session，可以合并的 PR、请你 review 的 PR、没人推进的 PR，以及需要你的 Shipherd 提醒（暂停的花费上限，带 **继续并提高上限**；Claude 限额；30 分钟找不到收件 session 的 CI 结果；等你分类的评审评论；栈冲突；要你决定的自动接活）。下面是折叠的 **进行中** 列表，列出每个在跑的 session 在做什么、它的 PR 和 CI，以及已经做了多久；点一行打开它的终端。最下面折叠的 **运行情况** 里有 **Shipherd 的其他提醒**（只告诉你一声的提醒）、内存卡片、最近合并、最近 24 小时的自动接活记录、用量一行和 **实况**。**实况** 把正在干活的 session 画成 Shipherd 卡片四周的小终端卡片：每张卡片有 ticket 号、仓库、状态药丸和最近 3 次工具调用，session 写记忆时一个蓝色光点沿虚线流向 Shipherd，读记忆时一个绿色光点从 Shipherd 流回 session。在等你的卡片边框变黄并写着 **需要你**。最多画 8 张卡片，没人在干活时会这样写。页面和分组里的"在干活"数字只算真在干活的 session（思考中、跑工具、后台命令）；停下来但开着 PR 的 session 算空闲。动画遵循系统的"减少动态效果"设置；窗口在后台、或者 **实况** 滚出视野时动画暂停。同一个折叠里有一行显示最近 7 天的 token 用量：总量、缓存读取的占比，以及上下文达到 20 万 token 以上的轮次占比。它统计 Shipherd 开的 session、它们的子 agent，以及 Shipherd 在后台启动的 `claude` 运行（handoff、epic 汇总、卡住检测），数据读自你本机上 Claude Code 的 transcript。点这一行能看到按类别（**ticket session**、**总控**、**子 agent**、**后台任务**）和按模型的拆分。占比按相对价格加权，只用于比较；Shipherd 不会换算成钱。

## PR 进度

每个 ticket 有一个轮次：在它开着的 PR 的轮次和它的 session 的轮次里取最急的那个，轮到你、agent 还是别人（点名）。有 PR 开着时，停下来或空闲的 session 不算，ticket 跟着 PR 走；但 session 提的问题还是排最前。这个轮次显示在 **轮到你** 页，以及 epic 的 **概况**、**进行中** 和 **全部 ticket** tab 里。ticket 以一行出现的地方（**进行中**、**全部 ticket**、**全部工作** 的表格，以及 ticket 自己 **概况** 的最上面一行），它还有别的开着的 PR 时后面跟着"· 另有 N 个 PR"；卡片上不带。其余的都在 ticket 的 **PR 详情** tab 里，按 PR 一个个列：阶段（见 [PR 阶段](#pr-阶段)）、CI、review、风险和就绪，以及未处理的评论。每个仓库里叠放的 PR、接活队列和等你 review 的 PR 在 **全部工作** 页底部的 **栈、自动接活和待 review** 折叠里。

### PR 阶段

阶段在 ticket 的 **PR 详情** tab 最上面的 **阶段** 一节里，默认收起，点开以后按 ticket 记在这台电脑上；ticket 的 **概况** tab 只写最新那个 PR 走完了几个阶段，和上下文大小一起放在默认收起的 **细节** 里。ticket 的每个仓库一条，分六步：设计、开发、自我 review、CI、peer review、合并。做完的是绿色，当前这一步是蓝色，失败或被打回的是红色，还没到的是灰色。每一步都由 Shipherd 自己判断：这个 ticket 的 session 调用了设计类 skill（比如 brainstorming、writing-plans）时设计开始，分支上出现第一个 commit 时结束，没调用过就显示 **跳过**（之前在 epic 总控里做过设计的算已完成）；开发从第一个 commit 开始；session 调用了 review 类 skill（比如 code-review、simplify）时自我 review 开始，下一次 push 或开了 PR 时结束，没调用过就显示 **跳过**；开了 PR 以后开始 CI，CI 失败会回到开发；CI 通过后开始 peer review，有一个人（不是 PR 作者、不是 bot、也不是 Copilot）批准时结束，有人要求修改就回到开发，下一轮记作第 2 轮，没有人批准就合并了显示 **跳过**；PR 合并时合并这一步结束，关闭但没合并会标成 **已关闭**。Shipherd 看的是 PR 拉回来的 review 列表，不是 `reviewDecision`，所以没开“必须 review”的仓库也能判断。hook 程序不是当前版本时，设计和自我 review 显示 **未知**，不显示 **跳过**。升级前就开始的 session 和更早的 ticket，即使做过设计或 review，也可能显示 **跳过**，因为那些 session 没有被记录：skill 记录只对升级后启动的 session 生效（Skill hook 在 session 启动时才加进它的设置）。人的批准后来被撤销（dismiss）的，不再算 peer review。步骤下面是时间线：skill 调用、第一个 commit、CI 结果、Copilot 和 peer review 的评论，以及这个 ticket 的 session 发的 `report`，比如自我 review 之后的那一句说明。**收起时间线** 能把它收起来，每一条各自记在这台电脑上。

## 全局总控

一个在所有 epic 之上的全局 session，从侧栏的 **全局总控** 打开。它的工作目录是 `~/.shipherd/workspaces/_shipherd`，用的是 workspace 记忆。同一时间只有一个：已经开着时，点按钮会切到它，想换另一段对话要先在终端里退出。它的页面 **全局总控** 没有 tab：左边是这个 session 和它的终端，右边是对话，所有 epic 和 ticket 的汇报按时间穿插在里面，下面是折叠的 **消息（N）**。

- **它能看**所有 epic、epic 里的 feature 和每个 ticket，每个 PR 的 review 和 CI 状态，每个开着的 session 在做什么、是不是需要你，以及未决的提问和最近的汇报（`list_epics`、`list_features`、`list_tickets`、`list_prs`、`list_sessions`、`session_activity`、`list_inbox`）。`list_epics` 给出每个 epic 的状态、Jira epic、总控 session、汇总和卡点，按顺序列出它的 feature 和各自的 ticket 合了几个，还标明汇总是不是过时了。`list_prs` 还带着每个 PR 的 base 和 head 分支、是不是草稿、请了谁 review、谁 review 过、能不能合并和 label。`progress_overview` 一次返回整个进度总览：各格数字、每个开着的 PR 轮到谁、等了多久、PR 叠放、PR 表和每个 epic 的一句进度。`metrics_overview` 返回 **效果与花费** 页：每个 Shipherd PR 的周期、评论、人介入和花费，和你在 Shipherd 之前自己合并的 PR 比；session 停下来等你的原因；钱花在哪。
- **它能做的**只有说话：`send_message` 给 epic 总控带一句话，用 epic 或 session id 指定。ticket 的 session 和修复 session 不能发。总控的终端关着（闲置时被自动关掉了，或者 Shipherd 重启过）时，Shipherd 接着它最近的对话打开（epic 从没开过总控就新开一个），再把话交进去。开着的走它的信箱：在干活就在下一次调用工具时收到，停着就在你没在打字时输入进去。带 `interrupt` 时 Shipherd 先按 Esc。每条消息有一个 `requestId`；对方这一轮做完时，它最后一段回复会以 **【回复】** 开头、写明 `requestId`，输入回全局总控，总控页面上的 **消息（N）** 列出最近 30 条消息（新的在前），每条是 **已排队**、**已送达** 或 **已回复**。`refresh_epic_summary` 在后台重写一份 epic 汇总，和 **立即更新** 一样。`refresh_session` 给某个 session 换新。`ask_user` 和 `report` 和别的 session 一样；它自己的汇报只存着。
- **它不能**建、删或结束任何东西（[栈](configuration.zh-CN.md#栈) 除外），也不能为别的事开 session。这些留给 epic 总控。
- 只读的工具在 Shipherd 给它写的设置里是放行的，巡检时不会每个工具都停下来等确认；`send_message`、`refresh_session` 和 `refresh_epic_summary` 照样要确认。
- **每天巡检。** 设置 **每天几点让全局总控巡检一次**（`shipherdPatrolTime`，默认关），到点时 Shipherd 打开（或接着用）全局总控，让它看一遍 PR、CI 和未决的提问，需要的话提醒 epic 总控，并用 `ask_user` 列出要你亲自做的事。全局总控正忙就排进它的信箱，它下一次调用工具时读到。因为电脑睡眠或 Shipherd 没开而错过的巡检，当天下一次醒来、解锁或启动时补一次。它每天最多开一次 session。详见[配置 Shipherd](configuration.zh-CN.md#定时与状态)。
- 全局总控开着时只在 **轮到你** 页的 **运行情况** 里有自己的实况卡片，不在 **进行中** 里占一行。它停下来等你回话时在该页有一张卡片：这时巡检等着送给它。
- 全局总控不会被自动换新，也不会因为闲置被自动关闭。

## 合并总控

同一个仓库里的两个 ticket 快要撞车时，Shipherd 会在合并前介入。它盯着自己开的 session，不管属于哪个 epic 或 ticket，只检查合并进目标分支，以及在共用文件夹里切分支这两类操作。它用 git 判断分支是否冲突。先到先合：先合的那个放行，另一个 ticket 会被告知之后要 rebase；和一个正在进行的合并冲突时，要等那个合完。详见[配置 Shipherd](configuration.zh-CN.md#合并总控)。

## session 的收尾和换新

- **关掉已完成的 session。** epic 总控可以用 `end_session` 关掉一个已经停下、在等输入的 session。正在工作的、在等你回答的，以及它自己，它都会拒绝。
- **清理 session。** 开着不用的终端每个要占几百 MB。session 闲置超过 `idleCloseMinutes`（默认 180 分钟，`0` 关掉，最短 10）后，Shipherd 会让它先写 handoff，再结束终端。session 仍留在列表里，可以恢复。有要你决定的事、有后台任务、在等合并或 CI 结果，或者（总控）它管的子 session 还在干活时都不会关。电脑睡着的时间不算闲置。隐藏超过 14 天的 session 会从 Shipherd 里删掉，对话记录文件留着。session 栏的 **清理闲置** 会立刻关掉闲置 5 分钟以上的 session，**已隐藏** 列表里有 **全部删除**。详见[配置 Shipherd](configuration.zh-CN.md#记忆statecore)。
- **有消息时恢复关着的 session。** 总控给它开的、关着的 session 发消息（比如重启后），Shipherd 先看内存再在后台恢复它并送到；你点 × 结束的不恢复。打开 **设置 → 基本 → 重启后自动恢复之前在工作的 session**（默认关），Shipherd 重启后会恢复上次在工作的 session；见[配置 Shipherd](configuration.zh-CN.md)。
- **换新不丢对话。** session 换新时（↻ 按钮、总控的 `refresh_session`，或者上下文太长时自动换新），Shipherd 先让它写 handoff，等记忆真的存好，同时把最近几轮对话存到 `~/.shipherd/refresh/<session>.md`，不调用模型。`/clear` 之后 session 会 recall 那份 handoff、读这个文件，然后接着做换新前在做的事；如果当时在等什么，就说一句在等什么并继续等。不会再停住等你的下一条指令。
- **合并后清理 worktree。** 一旦 handoff 报告某个 ticket 的 PR 已合并，Shipherd 就用 `git worktree remove` 删掉这个 ticket 的 worktree。分支保留，在那里再开 session 时会重建 worktree。有未提交改动或未跟踪文件的 worktree，或者自己的 session 还在终端里运行的，Shipherd 不会删。这时 ticket 页会说明原因，并给一个 **重新检查** 按钮，那个终端退出时 Shipherd 也会再试一次。被 `.gitignore` 忽略的文件（`node_modules`、本地的 `.env`）会随 worktree 一起删掉。
- **防止休眠。** 想在你离开、盖子开着的时候让 session 继续跑，就勾上侧栏底部或托盘菜单里的 **防止休眠**。开着时电脑空闲也不会睡眠，屏幕保持亮着。取消勾选、电脑睡眠（合上盖子）或 Shipherd 退出时它会关掉，Shipherd 每次启动时它都是关的。合上盖子照样会让 Mac 睡眠；Windows 上取决于你的合盖设置。

## 复盘与规矩

Shipherd 会读你已合并 PR 上的 review 评论（经 `gh` 和你自己的 `claude`），为每个仓库提炼出规矩，比如“改 schema 要加迁移”。在侧栏打开 **复盘与规矩** 查看：页面上只有 **待确认** 列表，跨所有仓库和产品，每条写着属于哪里、为什么和出处 PR，等你确认、编辑后确认或驳回，侧栏上的数字是待确认的条数。其余的都在默认收起的 **高级** 里：按仓库和产品看全部规矩、筛选和批量、批次和撤销、准入策略、产品、导入导出、向导、校准、检查和回测。在某个仓库上点 **分析历史**，会回头分析它过去的 PR，之后新合并的 PR 会自动接着分析。相关的仓库可以归成一个产品，产品的规矩对它的所有仓库都生效。只有你确认过的规矩才会送出去，而且只送给 Shipherd 开的 ticket session 和修复 session，放在 session 说明里（每个 session 最多 30 条，出现次数多的优先）。规矩改了以后，下一次打开或恢复 session 时才生效，已经开着的 session 不受影响。规矩只存在 Shipherd 里，不会写进你的仓库（不写 `CLAUDE.md`，也不写 `.github/copilot-instructions.md`）。

## 状态和晚间交接

在你选定的时间，Shipherd 让你自己登录好的 `claude` 为每个有动静的 ticket 写一份结构化的 handoff。最新的一份就是这个 ticket 的 **状态**，在它 **概况** tab 里：完成了什么、下一步、阻塞和待确认，旁边的 **更新状态** 按钮马上写一份新的。**记录** tab 里留着 **状态记录**。

- `Edit`、`Write` 和 `NotebookEdit` 一律禁止。
- Shipherd 允许读文件、`gh pr view`、`gh pr checks`、`git log`、`git status`，以及你选定的 tracker MCP 工具。
- 其他权限都来自你自己的 Claude Code 设置：用户级的 allow 规则（这些运行使用 `--setting-sources user`）和托管的策略设置。
- 这些运行并不是严格只读的。如果你的设置允许了比如 `Bash(npm:*)` 或一个能写的 MCP 工具，它们也能用。

在 session 里你也可以输入 `/handoff`。在 epic 的总控里，`/handoff` 写的是 epic 的汇总而不是 ticket handoff，之后 Shipherd 会在后台为这个 epic 里自上次 handoff 以来有动静的 ticket 补写 handoff。

## StateCore 记忆

进展、决定、未完成的跟进和跨 ticket 的经验都存进本地的 [StateCore](https://github.com/yul761/StateCore)。Shipherd 开的每个 session 都能 `recall` 它们。ticket 页的 **记录** tab 里有一节 **记忆**，能看到每条记录的历史。

Shipherd 内置了 StateCore。Shipherd 启动的每个 session 都有两个不需要 key 的 MCP server：`shipherd-memory` 存这个 ticket 的记忆，`shipherd-workspace` 存跨 ticket 共享的经验。epic 里 ticket 的 session 还有 `shipherd-feature`，即 epic 的记忆（scope 为 `feature:<id>`），epic 的总控也有它，外加 `shipherd-workspace`。epic 里的 feature 没有自己的记忆。

epic 的记忆用来放它各个 ticket 共用的约定，比如 API 约定或命名规则，能放大约 60 条。session 用 `remember` 存一条。scope 里的笔记计入 StateCore 的 30 条上限；scope 到 26 条时，Shipherd 把 Claude 写的最旧的笔记移进 epic 的存档，直到剩 20 条（epic 里每个 session 停下时，以及启动时，各查一次）。移走的笔记 StateCore 留在审计链上，存档保留最新的 40 条。Shipherd 写进这个 scope 的 handoff 先是 epic 的汇总，然后是 **规划**（epic 有规划时）、**约定**（epic 汇总里的决定）和 **以前的约定**（存档），最后是下一步和待解决的问题。要改一条以前的约定，记一条新版本就行。两次停下之间新记超过 4 条时，最旧的仍可能被挤掉。ticket 的 scope 不变。

**不要再另外安装 StateCore 自己的 Claude Code 采集插件。** Shipherd 已经在它启动的 session 里提供了 StateCore 记忆，两个都装的话记忆会记两遍。设置页发现这个插件时会提醒你。

- **不调用模型，也不联网。** StateCore 只在本机运行，不调用任何模型。Claude Code 启动的记忆 server 不会得到模型 API key：Shipherd 会从它们的环境变量里去掉模型相关的变量，并关掉 StateCore 的后台摘要。Shipherd 自己写入的内容（handoff、决定、跟进事项、经验）是确定性的，不需要模型。
- **长内容原样保留。** Claude 用 `remember(consolidate: true)` 存下的内容（最多 2000 个字符）作为一条事件原样留着，不会被蒸馏成事实；`recall` 把它和笔记一起，作为最近的事件返回。
- **每个 ticket 最多 30 条有效笔记。** StateCore 每个 scope（每个 ticket 一个 scope）最多保留 30 条笔记。从 statecore-mcp 1.1 起，完成的跟进和被替换的决定会让出位置。但如果同时有超过 30 条未完成的跟进和决定（Shipherd 自己最多保留 24 条），或者 Claude 自己写了很多笔记，一个 ticket 仍然可能写满。见 [docs/configuration.zh-CN.md](configuration.zh-CN.md#记忆是怎么工作的)。

## 界面语言

界面有中文和英文两种。首次启动时跟随系统语言（中文系统用中文，其他用英文），之后可以在 **设置 → 基本 → 语言 / Language** 或首次运行向导里改。语言也会切换 Shipherd 发给 `claude` 的默认提示词，所以 handoff 和记忆会用这种语言来写；你自己改过的提示词不变。从 1.2.0 或更早版本升级上来的安装保持中文，直到你手动改。切换之后，在 **设置 → 健康检查** 里点一次 **安装 / 修复**，`/handoff` 命令就会换成新语言。这些文档引用的是中文界面的标签；[英文版](how-it-works.md)引用的是英文界面的标签。

## Shipherd 不会碰的东西

- **你的 Claude Code 配置。** 只有当你点安装 hook 时 Shipherd 才会改它，要么在首次运行向导里，要么在 **设置 → 健康检查 → 安装 / 修复**。这会往你用户级的 `settings.json` 里加四个 hook（`SessionStart`、`Stop`、`UserPromptSubmit`、`SessionEnd`），并写入 `commands/handoff.md`。你的其他 hook 和命令都会保留，第一次还会把原文件备份为 `settings.json.shipherd-backup`。Shipherd 开的 session 还会通过它们自己设置里的 hook 记录 Skill 调用（只记 skill 名），用来判断设计和自我 review 有没有做。记忆从不通过 `claude mcp add` 注册，而是在 Shipherd 启动每个 session 时通过命令行参数 `--mcp-config` 传入。
- **你的 tracker 和代码托管平台。** Shipherd 自己没有 Jira、GitHub 或 Claude 登录。Jira、Linear、GitLab 或其他 tracker 只由你公司的 Claude Code 通过它自己的 MCP server 读取。PR 由 `claude` 用你的 `gh` 读取。
- **网络。** Shipherd 自己没有网络代码，只有通知 webhook 的发送和共享 MCP 在 127.0.0.1 上的监听。有一条 lint 规则强制保证这一点；见[隐私模型](#隐私模型)。

## 数据存放位置

| 路径 | 内容 |
|------|------|
| `~/.shipherd/app.db` | ticket、session、handoff、跟进事项、设置、对外动作的审计、review 经验（只存在这里，不会写进你的仓库）和加密后的通知 webhook 地址（SQLite）。旧版本留下的表（早间简报、LLM 调用日志、敏感词列表）还在，但已清空或不再使用。 |
| `~/.shipherd/statecore/statecore.db` | StateCore 记忆 |
| `~/.shipherd/inbox/` | 等待处理的 hook 报告（读不了的放在 `inbox/bad/`） |
| `~/.shipherd/bin/shipherd-hook` | Claude Code 运行的 hook 程序（Windows 上是 `shipherd-hook.exe`） |
| `~/.shipherd/mcp/tickets/<ticket>.json` | 记忆用的 `--mcp-config` 文件，每次为这个 ticket 打开 session 时重写 |
| `~/.shipherd/mcp/features/<id>.json` | epic 总控的 `--mcp-config` 文件 |
| `~/.shipherd/workspaces/<ticket>/` | 没有仓库的 ticket 跑后台任务用的空文件夹；升级前每个 ticket 自己的总控也在这里接着跑 |
| `~/.shipherd/workspaces/_shipherd/` | 全局总控的工作目录 |
| `~/.shipherd/mcp/shipherd.json` | 全局总控的 `--mcp-config` 文件 |
| `~/.shipherd/refresh/<session>.md` | 换新前存下的最近几轮对话，换新后读回；随 session 一起删除 |
| `~/.shipherd/mcp/project-*.json`、`local-*.json` | 给无人值守运行用的 MCP server 配置副本。只有开启 **后台的状态更新也加载本地级的 MCP…**（`headlessProjectMcp`）时才会写。因为可能含有 token，这些是私有文件。 |
| `~/.shipherd/logs/main.log` | 日志。**设置 → 健康检查 → 导出诊断** 会把它的最后几行和性能计数一起存下来，反馈「Shipherd 卡」时附上（见[配置说明](configuration.zh-CN.md#导出诊断)）。 |

epic 的工作区不在 `~/.shipherd` 下：它在你的仓库旁边（见 [Epic](#epic)），放着这个 epic 的 worktree。升级时被归档的旧 epic，工作区留在原处。

Windows 上 `~` 是 `%USERPROFILE%`。设置 `SHIPHERD_HOME` 可以换一个文件夹。Shipherd 读取的 Claude Code 配置和它安装的 hook 也遵循 `CLAUDE_CONFIG_DIR`。

除了安装 hook，Shipherd 对 Claude Code 的文件只读不写：

- `settings.json`：hook 状态、插件检查、MCP 批准情况
- `commands/handoff.md`：是不是 Shipherd 自己写的
- `~/.claude.json`：你的 MCP server 和批准情况
- `~/.claude/projects` 下的 session transcript：未认领 session（只在 **显示 Shipherd 之外开的 session** 打开时扫描）、`/handoff` 的输出和 epic 页的实时状态
- Claude Code 在系统临时目录（macOS 上是 `/private/tmp`）下 `claude-<uid>/<project>/<session>/tasks/` 里写的命令输出文件：实时状态和卡住检测
- `~/.claude/sessions/` 里的 session 登记文件：运行中 session 的名字，这样修复 session 才能给它发消息
- 开启 **后台的状态更新也加载本地级的 MCP…**（`headlessProjectMcp`）时，仓库的 `.mcp.json` 和 `.claude/settings.local.json`，用来找到你批准过的 server

transcript、输出文件和登记文件都是 Claude Code 的内部文件，更新可能会改变它们。Shipherd 读不了时，实时状态会退回到只显示命令和它跑了多久。

通知 webhook 的地址用系统钥匙串加密（macOS 钥匙串 / Windows DPAPI），界面上只显示它的主机名。Shipherd 只在你保存 webhook 地址、发送通知，以及打开高级设置里的 **打断与通知**（那里显示 webhook 的主机名）时才会用到钥匙串。如果你从没设置过 webhook，Shipherd 从不碰钥匙串。

在 macOS 上，可能会弹框问 Shipherd 能否使用钥匙串里的"shipherd Safe Storage"（Electron 用 app 的内部名 `shipherd` 来命名这一项）。点 **始终允许**。从 4.1.2 起发布的版本用 Developer ID 签名，升级后 macOS 会保留这个授权；从 4.1.1 及以前的版本第一次升上来时会再问一次。那些旧版本、以及没有签名 secret 时打的包只有 ad-hoc 签名，macOS 把它们的每个新版本都当作不同的 app，每次升级后都会再问一次。如果点了 **拒绝**，Shipherd 读不了已保存的地址；重新输入一次即可。

从 3.x 升级时，`app.db` 里的个人 API key、它的设置、敏感词列表和 LLM 调用日志会被删掉。Shipherd 已经没有地方显示或清除它们了。

Electron 还有自己的配置文件夹，里面是 Chromium 的缓存和单实例锁：macOS 上是 `~/Library/Application Support/shipherd`，Windows 上是 `%APPDATA%\shipherd`。设置了 `SHIPHERD_HOME` 时，Shipherd 改用 `<SHIPHERD_HOME>/electron`。在 Windows 上，这个文件夹还存着保护已保存 webhook 地址的 DPAPI 加密密钥，所以删掉它之后要重新输入地址。

## 隐私模型

Shipherd 的数据都存在本地的 SQLite 文件里，自己不调用任何模型。数据只会经由你自己的 `claude` 离开你的电脑，加上每天一次经你的 `gh` 做的更新检查，另外还有两条由你自己打开的路：通过你的 `gh` 往 GitHub 写东西（对外动作），以及通知用的 webhook。每一次对外动作和更新检查都记在 **审计** 页上。

Shipherd 自己不调用任何模型，也没有 API key。所有要用模型的事，包括 handoff、记忆笔记和 review 经验的分析，都交给你自己的 `claude`，用的是你公司的登录和设置。数据只会经由四条路离开你的电脑：

- **你的 `claude`。** Shipherd 启动的 session 和后台任务（handoff、汇总、检查）都是你自己的 Claude Code。它发出什么，由 Claude Code 和你公司的配置决定。
- **经你的 `gh` 做的对外动作。** 回复 PR 评论、推分支、改 PR 等。每一种都有自己的开关，在 **设置 → 对外动作** 里，默认全部关闭；每一次做了、失败或跳过的动作都列在 **审计** 页上。
- **经你的 `gh` 做的更新检查。** Shipherd 每天经你自己的 `gh` 查一次新版本，只提示，不下载不安装，自己不发 HTTP 请求，没有 `gh` 就静默跳过；**设置 → 基本** 可以关，每次查询都记在 **审计** 页。
- **通知 webhook。** 默认关闭（**推送通知**）。默认情况下一条消息只说是哪类事件、有几件；见 [docs/configuration.zh-CN.md](configuration.zh-CN.md#通知)。

有一条 lint 规则保证这一点：任何源文件都不能用网络，只有 webhook 的发送（Electron 的 `net`）、共享 MCP 的监听（只接收，在 127.0.0.1 上）和一个只给测试用的记录器例外。记忆 server 拿不到模型 key。

## 代码签名

**现状：** 从 4.1.2 起，macOS 安装包按下面说的用 Developer ID 签名并通过 Apple 公证，打开时 Gatekeeper 不会拦（4.1.1 及以前的版本、以及没有签名 secret 时打的包只有 ad-hoc 签名，打开时要在 **系统设置 → 隐私与安全性** 里点 **仍要打开**）。Windows 安装包还没有签名，所以第一次打开时 SmartScreen 会拦（怎么放行见 [README](../README.zh-CN.md#安装)）。Shipherd 也没有自动更新，只在有新版本时提示你。

签名只在 GitHub Actions 上由 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 来做。下面五个签名 secret 是受保护的 GitHub 环境 `release` 的环境 secret，这个环境的部署策略只放行 `main` 分支和 `v*` tag；也只有这些 ref 上的 macOS 构建会用这个环境。有这些 secret 时，macOS 安装包用 Developer ID Application 证书签名（打开 hardened runtime），交给 Apple 公证并 staple，dmg 和 zip 打开时 Gatekeeper 都不会拦。没有时（没设 secret 的 fork、pull request、在其他分支上手动运行、在自己机器上打包），macOS 的 app 只有 ad-hoc 签名。Windows 安装包两种情况下都不签名，它的构建也从不用这个环境。Shipherd 官方的安装包都是从这个公开仓库的版本 tag 构建的。

### 给 fork 的 macOS 安装包签名

你需要付费的 Apple Developer Program 会员。这五个 secret 有两种设法。五个要么都设，要么都不设：只设了一部分时，发版构建会停下，并列出缺了哪几个。

- **设在名为 `release` 的环境里**（推荐，和这个仓库一样）：在 **Settings → Environments** 里建这个环境，把部署分支和 tag 限定为 `main` 和 `v*`，再把 secret 设在上面（`gh secret set 名字 --env release -R owner/repo`）。
- **设成仓库级 secret**（**Settings → Secrets and variables → Actions**，或者 `gh secret set 名字 -R owner/repo`）。fork 里没有 `release` 环境时，`main` 或 tag 上的运行第一次用到它，GitHub 会自动建一个空的；仓库级 secret 在里面照样能用。

| Secret | 是什么 |
|---|---|
| `CSC_LINK` | 你的 **Developer ID Application** 证书连同私钥，从「钥匙串访问」导出成 `.p12`，再做 base64：`base64 -i cert.p12 \| pbcopy`。 |
| `CSC_KEY_PASSWORD` | 导出 `.p12` 时设的密码。 |
| `APPLE_API_KEY_P8` | App Store Connect API 密钥的全文（`.p8` 文件，包括 `-----BEGIN PRIVATE KEY-----` 那行）。在 **用户和访问 → 集成 → App Store Connect API** 里创建；公证用 **Developer** 角色就够了。Apple 只让你下载一次。 |
| `APPLE_API_KEY_ID` | 这个密钥的 Key ID（10 个字符）。 |
| `APPLE_API_ISSUER` | 密钥列表上方的 Issuer ID（一个 UUID）。 |

然后不用发版就能试：在 `main` 上手动跑一次这个 workflow，`gh workflow run release.yml --ref main`（或者 **Actions → Release → Run workflow**）。手动运行会构建、签名、公证、检查结果，并把安装包上传成 artifact，默认不建 release。只有推送 `v*` tag、而且 tag 指向的那个 commit 在 `main` 上的 CI 全绿（两个平台）时，才会建 release 草稿：**ci-gate** 这个 job 会等那次 CI 跑完，没通过就什么都不建。唯一的例外是在 `v*` tag 上手动运行并勾上 **skip_ci_check**：不看 CI 直接建草稿，运行日志里留一条写明是谁跑的警告，release 说明里也加一行注明这件事。**require_signing** 开着时（默认），缺 secret 会直接失败，而不是退回 ad-hoc；在 `main` 和 `v*` tag 以外的 ref 上会一开始就失败，因为签名只在这两处可用。关掉它时，在其他分支上运行，macOS 走 ad-hoc。不管 secret 设在哪一级，都只有 `main` 和 `v*` tag 上的运行会签名：在别的 ref 上，workflow 把这些 secret 都当作没设，仓库级的也一样。**Verify the macOS signature and run the packaged app** 这一步会检查：包里每个可执行文件和原生模块都用你的 Team ID 签了名、打开了 hardened runtime；app 和 dmg 都 staple 了公证票据；Gatekeeper 认它们；打出来的 app 能启动。

App Store Connect 密钥只在签名那几步写成 runner 上的一个私有临时文件，用完就删；证书导入一个临时钥匙串，electron-builder 结束时会删掉。两者都不会打进日志。hardened runtime 的 entitlements 在 [`build-resources/entitlements.mac.plist`](../build-resources/entitlements.mac.plist)，每一项为什么要都写在里面。

团队角色：

- **提交者和审阅者：** [@yul761](https://github.com/yul761)
- **审批者：** [@yul761](https://github.com/yul761)

### 隐私政策

除非用户或安装、运行本程序的人明确要求，本程序不会向其他联网系统传输任何信息。

- **网络。** Shipherd 不发送遥测数据，没有账号或许可证检查。它每天经你自己的 `gh` 向 GitHub 查一次最新版本，只提示，不下载不安装（见[隐私模型](#隐私模型)）。
- **Claude Code。** Shipherd 启动的是你自己的 `claude` CLI。这个 CLI 以你的登录和设置连接 Anthropic，或者你公司配置的地址。
- **对外动作和通知。** 只有你打开了的那几类，Shipherd 才会经你的 `gh` 往 GitHub 写东西，或者往通知 webhook 发消息，每一次都记在审计页上（见[隐私模型](#隐私模型)）。Shipherd 没有自己的 LLM API。
- **本地数据。** Shipherd 存的所有东西都留在你的电脑上（见[数据存放位置](#数据存放位置)）。

## 已知问题

- Windows 安装包没有签名（见[代码签名](#代码签名)）。macOS 版只支持 Apple silicon。
- 没有自动更新。
- 从 ad-hoc 签名的版本（4.1.1 及以前）第一次升到签了名的版本时，macOS 会再问一次能否访问钥匙串里已保存的 webhook 地址；之后升级不再问。没保存 webhook 就不会弹。
- **实时状态的局限。** 管道接到 `| tail` 的命令在结束前什么都不输出，所以状态里看不到它的输出。在 Windows 上，Shipherd 不检查子进程的 CPU，也可能找不到命令的输出，所以状态可能只显示命令和它跑了多久。
- **Windows 上用 npm 安装的 Claude Code。** Shipherd 不经过 `cmd.exe`，直接启动 npm/pnpm 的 `claude.cmd` shim 指向的目标，可能是原生的 `claude.exe`，也可能是 `node <script>`。
  - 如果 Claude Code 是用 `--ignore-scripts` 安装的，或者缺了原生的可选包，`bin\claude.exe` 只是一个小小的占位文件。
  - 这时 session 会启动失败，而且看不到 npm 那句"native binary not installed"的提示。
  - 解决办法是不带 `--ignore-scripts` 重新安装 Claude Code。
