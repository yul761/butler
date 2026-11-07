# 「现在」页和省 token（设计）

来源：2026-11-06 用户（BTL-170）提出的 6 点，要在同一版里一起发：

1. 记录 token 用量。
2. 定期压缩上下文，让 Butler 的记忆引擎承担记忆，子 session 从记忆里拿需要的信息。
3. 按任务难易选模型。
4. 能用代码自动化的操作放到 Butler 后台跑（比如查 PR 状态），少花 token。
5. 简报信息太杂，用户其实不看，要换成一个简单的状态面板。
6. 要能方便地看到每个 epic、feature 下正在进行什么工作（等 CI、rebase 还是在干别的），用户每天都要问很多次。

## 为什么

- **用户一天要问很多次"现在怎么样了"**。用户主要在 epic 或 feature 总控里下命令，子 session 的回复和"需要你做的事"都回到总控这一条对话里，往上滚。用户怕错过要处理的事，结果确实有 session 因为没人看到它在等而一直卡着。简报每天一份，信息太多，一眼找不到重点，所以用户不看。
- **API 花费高**。用户自己分析过，原因是上下文太长。2026-11-06 用用户个人电脑上最近 30 天的记录（16 个主 session、304 个子代理文件）算过一次，各部分占比按 Opus 的价格比例折算：
  - 缓存读取占花费的 66%，缓存写入占 25%，输出占 10%；
  - 上下文超过 20 万 token 的轮次占花费的 63%，超过 40 万的占 36%；
  - 一个跑了 1614 轮、上下文涨到 96.6 万的 session，一个就占了 28%；
  - 子代理占 42%，其中 78% 用的是 Opus；
  - 查 CI、`sleep` 等待这类机械轮询只占约 5%，大头是读代码、搜代码、跑测试，而这些轮次贵是因为当时上下文长；
  - 如果把上下文压在 15 万以内，花费大约会降到现在的 70%，这是不算压缩本身开销的上限。
  
  用户的工作电脑上没有这份数据，但用户确认过规律相同：session 一直开着，多半只是没人去关。
- 用户习惯能用最好的模型就用最好的。现在 Butler 让开发进度快了很多，同时开的 session 多了，才开始考虑成本。

## 用户确认的决定

### 「现在」页（第 5、6 点）

- **首页的简报页换成「现在」**：一个全局总览，列出 Butler 里所有正在进行的工作，不按单个 epic 分页。
- 按 epic、feature、ticket 三层排，**每一层都能展开和收起**。收起时，标题后面显示汇总，比如"3 个进行中 · 1 卡住"。空闲和已结束的默认折叠。
- **每个 ticket 一行**：它此刻在做什么（改代码、跑测试、等 CI、rebase、合并排队、停下等你、卡住）、PR 和 CI 状态，以及这个状态持续了多久。
- **最上面固定一栏「需要你」**：所有停下等用户回复或卡住的 session，没有时不显示。
- **点击就跳转**：「需要你」里的一条，直接打开那个 session 的终端；ticket 那一行，跳到它正在跑的 session。
- **配色跟着 Butler 的浅色和深色主题走**。样稿第一版在深色背景上用了深色字，用户看不清，这一点必须注意。
- 侧边栏里「现在」的入口上加红点和数字，现有的 epic、feature 红点保留。
- 用户选了列表，没选看板，因为看板太占地方。参考样稿在 `.superpowers/brainstorm/45777-1793984679/content/overview-v2.html`，这个目录 git 不跟踪。

### 简报和通知

- **去掉简报页**。每晚的 ticket handoff 照常跑，记忆要靠它提供数据。
- **ticket 页里的 handoff 历史和 followup 暂时原样保留**。用户觉得用处也不大，但还没想好怎么处理。
- **去掉 Butler 所有的系统通知**，包括晚间简报、session 卡住、合并总控。用户只在工作时用 Butler，而且经常看，界面里的红点就够了。
- 不把简报喂给记忆引擎。简报是从 handoff 拼出来的，而 handoff 已经写进记忆，再写一遍只是重复。用户想要的长期产品记忆见第 2 点的"长期记忆"。

### token 用量（第 1 点）

- 用户不需要看花费报告，要的是**把数据记下来**，用来分析钱花在哪、指导省钱。
- 界面上找个不显眼的位置显示几个数字就行。

### 上下文换新（第 2 点）

- **自动进行，用户不用操作，不弹任何提示。** 用户主要在总控里下命令，所以总控也要自动换新。
- 同时满足这几条时，Butler 就自动换新：
  - 上下文超过阈值，默认 15 万 token，可在设置里改；
  - session 停下来等输入，没有后台任务，屏幕上也没有待确认的东西；
  - 用户 30 秒内没在这个终端里打字。
- **怎么换**：Butler 自己往终端里依次输入 `/handoff`、`/clear`，再输入一句接着做的话（见"我的决定"）。handoff 没写成功就不清空。
- **另外两种触发方式**：
  - 总控可以给它管的子 session 换新（`butler-sessions` 里新增一个操作）；
  - 界面上有一个"换新"按钮。
- 总控派活时只发任务本身，背景信息由子 session 自己从 feature 记忆里调。
- **长期记忆**：在 feature 归档时，加上每周一次，把一个 epic 里做成了什么、做了哪些决定、为什么这么定，整理成一条写进 epic 的记忆，以后开新 feature 时用得上。

### 选模型（第 3 点）

用户让我参考社区的反馈来定。结论是：Sonnet 5.5 做范围明确的日常编码已经够用，花费大约是 Opus 的一半；Opus 5.5 在需要判断的活上更强，比如原因不明的 bug、架构、大的迁移和代码审查；Haiku 只适合做简单判断。用户同意下面的做法：

- Butler 开的 session 默认让子代理用 Sonnet（`CLAUDE_CODE_SUBAGENT_MODEL=sonnet`），但不强制：某次调用或某个代理定义里明确写了模型的，照样用它写的。
- 总控开子 session 时可以指定用 Opus 还是 Sonnet，并附一份判断准则：
  - 范围小、目标明确的用 Sonnet，比如修 CI、处理 rebase 冲突、补测试、照着明确的方案实现；
  - 需要判断的用 Opus，比如查原因不明的 bug、做架构、跨模块的改动、代码审查；
  - 拿不准就用 Opus。
- 总控自己，以及用户手动开的 session，照旧用最好的模型。
- Butler 自己的后台任务：
  - 接着原 session 跑的（ticket handoff、feature 总结）沿用原 session 的模型，因为换模型会让缓存失效，几十万 token 得重新按全价写一遍；
  - 卡住判定用 Haiku。
- Butler 开的 session 设 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 在 25 万左右，作为兜底：一直忙、总等不到空闲来换新的 session，到这个长度会用 Claude Code 自己的压缩。

### 后台自动化（第 4 点）

- Butler 根据每个 session 的 repo 和分支，用 `gh` 定时查 PR 和 CI 的状态，全部是代码，不调模型。「现在」页的 PR 和 CI 状态就从这里来。
- session 不再自己轮询 CI。给 session 的说明里写明：push 以后结束这一轮，不要循环去查 CI，Butler 会在 CI 跑完时告诉你结果。
- CI 跑完以后，Butler 等 session 停下来、用户也没在打字时，把结果递进去：失败的附上失败的 job 名和日志的最后几十行，通过的告诉它可以继续下一步。
- 早上刷新 PR 状态改用这份数据，不再调 headless claude 去查。
- PR 合并以后，Butler 自动更新 ticket 的状态。
- rebase 和解决冲突不做自动化，这些要判断，合并总控已经在管了。

## 我的决定（用户没有逐条确认）

### 「现在」页

- **哪些算"进行中"**：ticket 有开着的终端 session，或者有还没合并、没关的 PR（session 关了，但在等 CI 或 review 的也算）。都没有的不显示。不属于任何 epic 的 ticket 单独放一组；属于 feature、但 feature 不属于 epic 的，放在"无 epic"这一组里，按 feature 分。
- **总控也显示**：epic、feature 总控的 session 显示在各自那一组的第一行，标明"总控"。总控是最常需要用户回复的地方。
- **一个 ticket 开了几个 repo 的 session**，就显示几行，每行标上 repo 名。
- 每 10 秒刷新一次，跟着现有的 ActivityMonitor。
- **「需要你」收这三种**：
  1. 屏幕上停着权限确认、`AskUserQuestion` 或 `ExitPlanMode`，也就是现在的 `approval`；
  2. 被判定为卡住；
  3. 停下来在等输入，并且最后一条回复是在向用户要东西，比如问问题、要用户决定或者让用户去操作。
  
  第 3 种光看状态分不出来：现在每个回合结束的 session 都是 `waiting`，做完了在等下一条指令的也是。**这里用 Haiku 看一眼最后一条回复**（`last_reply`，最多 1500 字，不带别的上下文），回答"要不要用户处理"，并给一句理由，理由显示在「需要你」那一行里，比如"问你：要不要把 X 拆成两个 PR"。每条回复只判断一次，按 session 和最后一条消息的 id 缓存。这是这个页面里唯一一处调模型的地方。我这么定的理由：用户最初的痛点，正是总控转述"需要你做"的那句话被后面的消息顶上去；这句话是自然语言，靠规则识别不准，而 Haiku 判断一段短文本的花费可以忽略。判断失败或者 Haiku 不可用时，退回规则：回复以问号结尾就算。
- **卡住检测的范围扩大**到 Butler 开的所有 session，包括总控和不属于 feature 的 ticket。现在只检测未归档 feature 下的 ticket（`activity-monitor.ts` 里的 `StuckScope`）。
- **页面最下面**：
  - "最近合并"，默认收起，放原来简报页上的合并总控记录（`merge-events-view.ts`）。合并总控原本"事后告诉用户"靠的是系统通知加简报页，这两样都去掉了，所以挪到这里；
  - 一行用量小字，见第 1 点。
- 新加的文字都要有中文和英文两个版本（`strings.ts`、`strings-en.ts`）。

### 去掉简报和通知

- 删除 `BriefPage`、早晚简报的生成（`brief-service.ts`、`engine.ts`），还有只给简报用的"今日重点"模型调用（`narrate.ts` 和 gateway 的 narrate）。gateway 本身保留，StateCore 的提炼要用它。和这些相关的设置项一并删掉。
- `briefs` 表里的历史数据不用迁移，不再读就行。
- 删除 `index.ts` 里的三种系统通知（`showEveningNotification`、`showStuckNotification`、`showGateNotification`），连同相关的设置项。卡住和合并冲突改为在「现在」页里显示。
- 每晚的任务保留 ticket handoff、feature 总结和记忆提炼，去掉晚间简报和通知。
- 早上的任务去掉简报，PR 部分改读第 4 点的数据。tracker（Jira 等）状态的刷新暂时保留，因为它不接着某个 session 跑，没有缓存可言，所以改用 Sonnet。

### token 用量

- **记录什么**：每一轮记一行，内容有 session id、消息 id、时间、模型、输入、5 分钟缓存写入、1 小时缓存写入、缓存读取、输出、这一轮的上下文长度（输入加上全部缓存读写），以及是否子代理和子代理的 id。
- **去重**：同一个 API 回复在 transcript 里会拆成好几行（每个 content block 一行，`usage` 都一样），要按 `message.id` 去重。
- **数据从哪来**：
  - Butler 开的 session 的 transcript（`<projects>/*/<id>.jsonl`）；
  - 它们的子代理文件（`<projects>/*/<id>/subagents/*.jsonl`），记在发起它的 session 名下；
  - 沿 `replaced_by` 链（`/clear`、压缩、恢复都会换 id）挂到同一个 ticket 下；
  - headless 调用的 JSON 结果里也有 `usage`，同样记下来，标明是哪种后台任务（`parseResult` 现在只读了 `total_cost_usd`，而且没人用）。
- **增量读取**：记住每个文件读到了哪个位置，只读新增的部分。ActivityMonitor 已经在读开着的 transcript 的尾部，尽量复用。session 关掉以后，补读到文件末尾为止。
- **界面**：「现在」页最下面一行小字，写近 7 天的总 token、缓存读取的占比、上下文超过 20 万的轮次占的比例。点开后，按 session 类型（ticket、总控、子代理、后台任务）和模型分开列。只显示 token，不换算成钱，因为用户说过不需要花费报告。
- 换新功能要用到的"当前上下文长度"，就从这里取每个 session 最新一轮的数字。

### 上下文换新

- **步骤**：
  1. 输入 `/handoff`；
  2. 等这个 session 新写的 handoff 被 Butler 收进来（Stop hook 读 transcript，见 `capture.ts`，再 ingest 成功），最多等 10 分钟；
  3. 输入 `/clear`；
  4. 等 SessionStart 的 clear 事件把新 id 接上 `replaced_by`；
  5. 输入接着做的话。
  
  任何一步超时或者失败都停下，不再往下走，这个 session 30 分钟内不重试。已经写进去的 handoff 留着，没坏处。
- **接着做的那句话：只把进度调回来，然后停下等用户，不自己开始新的工作。** 内容大意是："上下文已由 Butler 换新。先用 recall 调出这个 ticket 最新的 handoff，用一两句话说明做到哪了，然后等用户的下一条指令。"理由：触发条件是 session 已经停下来在等用户，它原本就没有在做的事，换新不应该让它自己动起来。在等 CI 的 session，会由第 4 点的结果把它叫醒。总控用的这句话里，把 ticket 换成它的 feature 或 epic。
- **在「需要你」里的 session 不自动换新**，用户可能正要回它的话。手动按钮和总控触发的不受这条限制。
- **总控换新以后从记忆里接上**：feature 总控的 `/handoff` 写的是 feature 的 handoff（`feature-ingest.ts`）。
- **换新时 feature 总控的 `/handoff` 不往下带动 ticket**：平时 feature 总控执行 `/handoff`，会让它下面每个进行中的 ticket 都跑一次 handoff，没有总结块时还会 fork 总控本身（`FeatureSummaryRunner.afterCommand` → `runChildren`、`runFromCommand`）。每一次都是对长 session 的 headless fork，要整段重写缓存。总控一天可能换新好几次，所以换新触发的 `/handoff` 要带一个标记一路传过 capture 和 ingest，跳过这一连串操作，只收总控自己的总结。ticket 的 handoff 由它们自己换新或者每晚的任务来做。
- **这一版修掉 epic 规划被冲掉的问题**：现在 epic 规划和 epic 总控的 handoff 共用一个位置（`carriedEpicPlan`、`syncEpicNow`）。Butler 没写过的 handoff 会被当成整份新规划，所以 epic 总控写一份进度 handoff，规划就没了。修法是让规划单独存放：
  - `epics` 表加一个规划字段；
  - epic 总控在规划定下来或者改动时，调用 `butler-sessions` 新增的操作 `set_epic_plan` 来写规划；
  - 它自己的 `handoff` 只当作进度；
  - Butler 渲染 epic 作用域的 handoff 时，把规划、进度和各 feature 的情况拼在一起，规划部分的长度上限沿用 `EPIC_PLAN_MAX_CHARS`。
  
  老数据的迁移：现在 handoff 里分隔符包着的那段，或者整份由 epic session 写的内容，迁到规划字段。epic 总控的说明要相应改，`epic-brief.ts` 改从规划字段取。修好之后，epic 总控才能开启自动换新。
- **输入框里有没发出去的草稿就不动**：`deliver` 是粘贴之后按回车，如果用户之前打了字没发，就会把草稿连同 `/handoff` 或 CI 消息一起发出去。用户的输入都经过 Butler 的 PTY，所以 Butler 自己记录：用户最后一次按回车之后，有没有再输入过可见的字符。有的话就当作有草稿，换新和递 CI 结果都等着，直到草稿发出去或者被清空。如果在真实的 Claude Code 上能从屏幕读出输入框是空的，就用屏幕作为补充校验，但不能只靠屏幕。这条规则和"30 秒内打过字就不动"同时生效，所有自动输入都适用，包括合并总控现在递的消息。
- **往终端里输入命令**用 `PtyManager.deliver`（bracketed paste 加回车），和合并总控递消息走同一条路，同样遵守"用户 30 秒内打过字就不递"。斜杠命令通过 bracketed paste 输入后能不能被 Claude Code 当成命令执行，要在真实的 Claude Code 2.1.x（全屏模式）里验证。不行的话就按键逐个输入。
- **总控的操作**：`refresh_session`，范围、权限和 `end_session` 一样，只能换新它自己管的、已经停下来的 session，不能换新自己。
- **按钮**：放在终端区域每个 session 的标题栏上，和结束按钮放在一起。
- **派活只发任务**：修改总控用的说明（`control.ts`、feature 和 epic 的模板），告诉总控：任务文字里只写要做什么，背景信息和约定已经在 feature 记忆里，子 session 会自己 recall。子 session 收到的任务前缀（"Task from the coordinator session"）后面也加一句：先 recall feature 记忆。
- **长期记忆**：
  - 输入是 Butler 数据库里已有的东西，也就是这个 epic 下各 feature 的总结和 ticket handoff 里的决定、学到的东西。不 fork 任何 session，用 Sonnet；
  - **全文存在 Butler 的数据库里**，新加一张 epic 历史表，每次整理追加一条，不覆盖旧的。StateCore 的 note 正文最多 360 字、每个作用域最多 30 条（`NOTE_BODY_LIMIT`、`NOTES_CAP`），装不下全文，也不应该挤占 epic session 自己的 note；
  - 全文的用法有两个：拼进新 feature 总控收到的第一条消息（`epic-brief.ts`）的"以往的决定"部分，以及通过 `epic_context` 操作返回给总控。拼进去的部分有长度上限，超出时从最旧的开始截掉；
  - 另外在 epic 作用域里维护**一条**滚动 note（每次覆盖它自己），写最重要的几条决定，不超过 360 字，让 ticket session 的 recall 也能看到；
  - 每周第一个工作日跟着每晚的任务跑一次，只处理上周有新活动的 epic；feature 归档时，对它所在的 epic 立刻跑一次；
  - 不属于 epic 的 feature 归档时也写进这张表，挂在 workspace 名下，不写 workspace note。

### 选模型

- `start_session` 加一个可选参数 `model`，取值是 `opus` 或 `sonnet`，Butler 把它转成 `--model` 传给 Claude Code。
- 模型存进 `sessions` 表。`--resume` 恢复时、以及 fork 跑 handoff 或 feature 总结时，都带上同一个模型，避免缓存失效。没存的（老 session、用户手动开的）就不传，由 Claude Code 用它自己的默认值。
- Butler 修 CI 的 fix session（`fix-task.ts`）用 Sonnet。
- `CLAUDE_CODE_SUBAGENT_MODEL` 和 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`：用户自己的环境里已经设了的，不覆盖。
- **"Butler 开的 session"指 Butler 在终端里开的所有 session**（`origin='butler'`），包括总控和用户手动开的。子代理占了 42% 的花费，这一项不分来源一律生效。审查和需要判断的子代理不能因此降到 Sonnet：模型准则里写明，派子代理做代码审查、查原因不明的问题或者架构判断时，调用时要传 `model: opus`。这条准则写进 Butler 给每个 session 的说明里，不只写给总控。
- 卡住判定（`stuck-judge.ts`）和「需要你」的判断加 `--model haiku`。
- 模型准则写进总控的说明，内容就是上面"用户确认的决定"里那三条。

### PR 和 CI

- **查谁**：
  - 开着的 session 所在的 repo 和分支（有 PR 时用 `gh pr view <branch> --json ...`）；
  - 关了 session 但 ticket 记录里还有没合并、没关的 PR 的。
  
  跟踪数量有上限，能防止 gh 被调用太多次。
- **还没有 PR 的分支也要查**：session 开着、分支已经 push、但还没开 PR 时，用 `gh run list --branch <branch>` 查这个分支最近一次提交的 workflow run。仓库的 CI 由 push 触发时，这样也能把结果递回去。"push 以后结束这一轮"的说明不区分有没有 PR。
- **字段**：编号、状态、是否草稿、`mergeStateStatus`、`reviewDecision`、`statusCheckRollup`、自动合并、url。
- **频率**：有检查在跑、并且 session 开着的 PR，每 1 分钟查一次；其余每 5 分钟查一次；已合并、已关闭的不再查。合并总控现有的 `HoldWatcher` 查的是同样的字段，合并成一个监视器，免得重复查。
- `gh` 没装、没登录或者没网时，界面上显示"PR 状态不可用"，不报错，也不影响别的功能。
- **把 CI 结果递给 session**：
  - 一个 PR 所有检查都结束、结论和上次递过的不一样时，递一条进去；
  - 失败时用 `gh run view <id> --log-failed` 取最后 60 行，再加上失败的 job 名；
  - session 正忙就排队，等它停下再递；
  - session 在「需要你」里（在等用户回答或确认）时也排队，等用户回过它、它再停下时才递，免得它没等用户回答就自己往下走；
  - session 关了就不递，只在页面上显示；
  - session 换过新的，递给 `replaced_by` 链上最新的那个。
- **给 session 的说明**（"push 以后结束这一轮"）放在 Butler 本来就会给 session 的说明里，具体放哪里由构建者定，候选有记忆 MCP 的说明和 `--settings`。
- 根据 PR 更新 ticket 状态，沿用 `handoff/status.ts` 现有的规则：合并以后有 followup 的，变成"合并后待跟进"，没有的变成"已完成"。

## 约束

- 支持 macOS 和 Windows，`gh`、路径、终端输入都要在两边都能用。
- 依赖真实 Claude Code 行为的部分，用真文件、真程序验证，不能只靠假的 claude 和 fixture。这些部分包括 transcript 里 `usage` 的格式、斜杠命令的输入、`/clear` 后的 SessionStart、子代理文件的位置和环境变量。以前有 bug 是 fixture 全部通过、真机却坏了。
- e2e 测试不能抢焦点（窗口在后台打开）。
- 所有自动往终端里输入的动作（换新、递 CI 结果），都要遵守"用户 30 秒内打过字就不动"，并且失败时什么都不做，不能把 session 弄坏。
- 版本号：这一版发布前要再问用户一次（已经同意过的只到 1.6.1）。

## 留给构建者

- 「现在」页的具体样式、组件拆分，以及数据从主进程推到渲染进程的方式（沿用现有的 notify 和 IPC）。
- 用量表的结构和索引，以及增量读取的实现。
- 换新的各个等待步骤怎么检测（复用现有 hook 事件）。
- PR 监视器和 `HoldWatcher` 怎么合并。
- 给 session 的那些说明的具体措辞（中文和英文）。
