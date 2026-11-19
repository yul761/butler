# 工作流 N：开工入口自动化（自动接活）设计补充

日期：2026-11-19。基础：`main` 的 `b02eee1`（A、B、C、G、H、J、K、L、W 都已合入）。对应源计划 7.9 和总设计第 3 节 N 那一行。

## 0. 现状核实（先做）

读了 `src/main/tickets/ticket-service.ts`、`feature-service.ts`、`db/tickets-repo.ts`、spec `2026-10-23-multi-repo-tickets-design.md`，以及全仓库所有和 Jira / tracker 有关的代码。结论：

| 问题 | 现状 |
|---|---|
| 从 Jira 自动拉取 ticket | **没有**。Butler 里没有 Jira 客户端，也不能有（网络只能走 `src/main/gateway`）。ticket 全靠人建：界面上的「+ 新 ticket」（IPC `tickets:create` → `TicketService.create`），或 feature 总控的 `create_ticket`（只能建在 feature 下，可带 K 的 `stack_on`）。 |
| Jira 走什么方式 | **用户自己在 Claude Code 里配的项目级 tracker MCP**。设置 `trackerTools` 列出只读的查询工具（`TRACKER_TOOL_RE` 过滤掉写操作），handoff、刷新、早间刷新这几个后台 `claude -p` 在 ticket 第一个仓库的工作目录里跑（项目级 MCP 在那里能找到），用 `--allowedTools` 只放这些工具，读 ticket 的描述、状态、子任务，读不到就填 `jira: null`。session 的说明文件（J）让 session 遇到问题先查 tracker。没有任何写 Jira 的路径。 |
| 自动开工 | **没有**。session 只在人点「+ 新 session」或总控调 `start_session`（task + 档位）时开。开之前过 W 的内存准入（`admitOrRefuse`），档位经 A 的 `routing.sessionModel` 变成 `--model`。 |
| 已经预留给 N 的 | A 登记了路由任务 `intake_classify`（mid、fallback）；L 登记了后台任务种类 `intake`（high、不看时段、不可打断、开 session、路由任务 `intake_classify`），界面文案「新需求分拣 / Intake triage」已有，但没有处理函数。 |

所以 N 不重做 ticket 和 session 的建法，而是在前面加一条链：**来源 → 接活记录 → 分类 → 选档位 → 进 L 的队列 → 由队列按条件调 `TicketService.create` + `SessionService.open`（和 `start_session` 同一套步骤）→ 只在需要人决定时提醒**。

## 1. 总开关和「什么都不配时不变」

- 三层配置（契约 4.2）的 `enabled`，默认 `false`。新表 `intake_policies`，和 L 的 `cost_caps`、G 的 `pr_policies` 同一种写法（每层一行 JSON 覆盖值，`LayeredResolver` 解析）。
- 来源是全局的（设置 `intakeSource`，默认 `none`）。**只有来源不是 `none`、并且至少一层把 `enabled` 打开时才会去拉**。拉到的 ticket 映射到仓库以后，按那个仓库解析出的策略看 `enabled`，没打开的直接丢掉、不记录。
- 没配的时候：不拉、不建表行、不开 session、不发通知、界面上的「接活队列」只显示一句说明。和 2.1.0 / 现在的 main 行为完全一样（e2e 和单测都覆盖）。

## 2. 来源

接口 `IntakeSource { kind; fetch(signal): Promise<IncomingTicket[]> }`。`IncomingTicket`：`key, title, description, type?, labels[], priority?, url?, storyPoints?, components[], subtasks[{key,title}], repo?`。

| `intakeSource` | 做法 |
|---|---|
| `none`（默认） | 不拉。 |
| `tracker` | 真实 Jira（以及 Linear、GitLab 等任何有 MCP 的 tracker）：沿用第 0 节的现有方式。后台 `claude -p` 经路由器（新任务 id `intake_fetch`，low、fallback，见第 9 节）在 `intakeTrackerDir`（不填就用仓库映射里第一个仓库）里跑，`--allowedTools` 只放 `trackerTools` 里的只读工具，按用户写的 `intakeTrackerQuery`（可以是 JQL，也可以是一句话，比如「分给我的、状态是待办的」）列出 ticket，按 JSON schema 输出。工具不可用或失败就当这次没拉到，下次再拉。Butler 自己不连 Jira。 |
| `file` | 读一个 JSON 文件（`intakeFilePath`，`{"tickets":[...]}` 或数组）。这是 e2e 用的 fake 来源，也能给用户自己的脚本（比如定时导出）用。 |

- 拉取的时机：每 `intakePollMinutes`（默认 15）一次，加上界面上的「现在拉取」。拉之前问 L 的 `scheduler.gate("intake")`，被手动停了、额度 hard、熔断时不拉。
- ticket 号不符合 `ticketPattern`：记成 `skipped`（原因「ticket 号格式不对」），不提醒。
- 已经是 Butler ticket 的号（包括归档的）：记成 `exists`，不动，人已经在管它。
- 同一个号再拉到时：内容（标题、描述、类型、标签、故事点、子任务）的 hash 没变就什么都不做；变了且还没开工（`needs_clarification`、`needs_decision`、`held`、`needs_repo`）就重新分类。用户手改过的维度保留用户的值。
- 测试里只用 `PROJ-1` 这类假号、`acme/app` 这类假仓库，不出现真实地址、项目和人名。

### 2.1 仓库映射

设置 `intakeRepoMap`，一行一条 `匹配 => 仓库路径`，从上到下第一条命中的算：`PROJ-`（号的前缀）、`label:xxx`、`component:xxx`、`*`。来源里带了 `repo`（file 来源可以写路径）就直接用。都对不上：`needs_repo`，算「需要你决定」（第 6 节），用户在队列里选仓库。仓库 slug 用 `RepoIdentity.slugOf`，策略、风险路径都按 slug 解析。

## 3. 分类（规则优先，规则判不了才调模型）

规则版本 `INTAKE_RULES_VERSION = 1`，三个维度各自要么由规则「判定」，要么「判不了」。每条命中都记进 `reasons`（`{dim, rule, detail}`）。

**要不要先澄清**（总是由规则判定）：

- 描述去掉空白不到 40 个字符：缺「描述」。
- bug 类（类型是 bug / defect / incident / 缺陷，或 G 的 `inferTicketType` 从标签推出 `bug`）且找不到复现步骤（「steps to reproduce」「repro」「复现」「重现」「步骤」或编号列表）：缺「复现步骤」。
- 其余要做功能的类型（不是 bug、docs、chore）找不到验收标准（「acceptance criteria」「AC:」「验收」「given … when … then」「done when」「- [ ]」）：缺「验收标准」。
- 有缺的就要澄清；问题按缺的项用固定模板生成（中英两份），模型被调用时可以补更具体的问题。

**大小**：故事点 ≤2 小、≤5 中、>5 大；子任务 ≥3 个大；标签 trivial / typo / small / good-first-issue 小，epic / large 大；类型 docs / chore 小。都没有：判不了。

**风险**（开工前的预估，规则参考 G，但不写 G 的表）：

- 从标题和描述里提取像路径的词（含 `/` 的、带常见扩展名的文件名）当「预计要改的路径」，按 G 为这个仓库解析出的风险路径（`prPolicies.forSlug(slug).risk.paths`）匹配：迁移、鉴权、公共 API、配置、CI 任何一类命中就是高。
- 关键词（migration、schema、auth、permission、security、payment、billing、credential、迁移、权限、安全、支付）高。
- G 的 ticket 类型下限（`types.floors`：hotfix、security 高，bug 中）；优先级 highest / blocker / critical / P0 / P1 至少中。
- 类型 docs / chore，或预计路径全部落在 G 的 `lowRisk` 类里：低。
- 上面都没有：判不了（有下限时按下限判定）。

**模型**：任何一个维度判不了才调 `intake_classify`（经路由器，A 的限额降级照常），输入 ticket 的文字和规则已经判定的部分，输出 `size、risk、confidence(0–1)、reasons、expectedPaths、questions`。规则判定的维度不被模型覆盖。结果记 `class_source`（`rules` / `model` / `mixed` / `user`）、模型名、`rules_version`。

**拿不准**：模型调用失败，或 `confidence` 低于策略 `uncertainBelow`（默认 0.6）：`needs_decision`。

**用户改分类**：队列里每一维都能改，改了写 `intake_overrides`（item、维度、旧值、新值、当时的规则版本和来源、时间），记 `recordEvent("intake.overridden")`，`class_source` 变成 `user`，按新分类重新走第 5 节。「效果」页显示被改掉的比例（第 8 节），用来校准规则。

## 4. 选模型档位

三层策略里的映射：`tierSmall = mid`、`tierMedium = mid`、`tierLarge = high`、`tierMediumRisk = mid`、`tierHighRisk = high`（低风险不抬档）。最终档位 = 大小档位和风险档位里高的那个。默认不把小 ticket 放到 low，因为没配路由时 low 对应 haiku；用户想省可以把 `tierSmall` 改成 `low`。档位交给 A 的 `routing.sessionModel(tier)`：A 负责映射到模型、按健康度和限额换下一档；不写死模型名。

## 5. 开工或进队列

分类完的接活项：

1. 要澄清 → `needs_clarification`（第 6 节），不开工。
2. 拿不准 → `needs_decision`，不开工。
3. 策略 `autoStart` 关着，或大小 / 风险超过 `maxSize`（默认 large）/ `maxRisk`（默认 high），或 G 的预审没开（`preReviewEnabled` 不是 1，源计划要求「有了就绪度和证据之后才自动开工」）→ `held`，原因写清楚，不提醒，用户可以在队列里手动「开工」。
4. 大 ticket、来源里有 ≥2 个子任务、策略 `stackSubtasks`（默认开）：拆成 K 的栈（第 5.2 节）。
5. 其余 → `queued`，排进 L 的通用队列（种类 `intake`，`dedupeKey = intake:<号>`）。

### 5.1 队列里的开工条件

`intake` 的处理函数每次被取到时按顺序检查，不满足就 `defer`（L 的队列到点重试；有 session 结束时 N 主动 `pump` 一次，名额空出来马上开），原因写进接活项的 `wait_reason`：

1. **花费上限、熔断、额度**：L 的 `scheduler.gate` 已经替队列看过（`manual`、`cost`、`quota`），被拦时根本不会取到。熔断按 ticket，这时还没 ticket，所以另外问一次 `costBreaker.allowBackground(<号>)`（ticket 号就是 Jira 号，以前同号的花费照算）。
2. **并行度上限**：策略 `maxParallel`（默认 2）。只数**由接活自动开的、session 还开着的** ticket，用户自己开的不算、也不受限（总设计的非目标是「不限制 session 数」，这个上限只管自动开的数量，不是给 session 设硬上限）。
3. **同仓库冲突预判**：同一个仓库里「在跑的」ticket = 没归档、有打开的终端，或在合并闸里有活动的 hold（`MergeGateRepo.activeHolds()`，只读，不改合并闸）。每个在跑的 ticket 的路径 = 分支相对默认分支改过的文件（`git diff --name-only <merge-base>..<分支>`）+ worktree 里没提交的改动 + 它是接活开的话它的预计路径。和这一项的预计路径比：同一个文件，或一个是另一个的目录前缀，就算冲突。这一项没有预计路径时没法预判，不拦（理由里写明）。冲突且策略 `conflictAction = serialize`（默认）且用户没点过「允许并行」→ `waiting`（原因 conflict），并提醒一次（第 6 节：用户可能想并行）。`parallel` 时只在理由里记一笔。
4. **内存**：`ctx.admitSession(...)`（W 的 MemoryAdmission），不放行就延后。
5. 都过了：`TicketService.create({ key, title, repoPaths: [仓库], workMode: "worktree" })`（分支按 `branchTemplate`），`routing.sessionModel(档位)`，`SessionService.open`，成功后 `opened()`，经 `submitTask` 递任务说明（`taskMessage(sanitizeTask(...))`，和 `start_session` 一样）。任务说明里有 ticket 的标题、链接、描述（截断）、分类和理由，并提醒按说明文件里的证据和预审步骤提交（G 的流程：预审开着时说明文件本来就有这些行）。B 的开关 `intake_tracker_status` 开着时再加一句「开始时用 tracker 工具把 ticket 改成进行中」，并记审计；关着记 `skipped`。
6. 建 ticket 失败（目录脏、分支问题等）：`failed`，错误原样显示，算需要你看（第 6 节）。开 session 失败：ticket 留着，项回到 `queued` 重试，三次后 `failed`。

开工后项是 `started`，记 ticket 号、档位和实际模型；PR 出来以后，队列里这一行直接显示 G 的 `pr_risk.level` 和 `pr_readiness.ready`（只读 G 的表）。

### 5.2 大 ticket 拆成栈（K）

父项变成 `split`（不建 ticket），每个子任务一项（`parent_key`、`layer` 1…n，分类继承父项、大小按子任务重新判）。第 1 层照常开；第 k 层要等第 k−1 层「好了」（有 PR，或开过的 session 已经全部结束）才开，等的时候原因是 `stack`。第 k 层建 ticket 时用 K 的接口：`StackService.canStackOn(仓库, 上一层分支)` 通过后，`startPoints` 设成上一层的分支，建好后 `StackService.stackOn({ repoPath, parentBranch, branch, featureId: null, epicId: null })` 接到栈顶。子任务号不合格式时不拆，整体按大 ticket 走。

## 6. 只在需要你决定时提醒

需要人的只有这几种：`needs_decision`（拿不准）、`needs_clarification`（缺信息）、冲突要串行（你可能想并行）、`needs_repo`（不知道放哪个仓库）、`failed`（建 ticket 失败）。每一项每进入一次这种状态提醒一次（`alerted_at`）：

- 「现在」页加一种提醒 `intake`（`NowNotice`）：几项需要你、各是什么原因，按钮跳到「进度」页的接活队列。
- J 的外部通知：新事件 `intake_decision`（加进 `NOTIFY_EVENTS`，默认勾选；推送本身仍由 `externalPushNotification` 管，默认关；免打扰时段照常）。正文只说几项需要你，细节按 `notifyDetails`。
- 其余（自动开工、进队列、等名额、等内存、拆栈、被 held）都不打断人，只在「现在」页的「自动接活」记录里留一行（最近 24 小时自动做了什么），在「进度」页队列里能看到状态和原因。

### 6.1 缺信息时谁去问

策略 `clarifyMode`：

- `notify`（默认）：只提醒你。
- `session`：建 ticket、开一个 session（档位按 `tierSmall`），任务是「用 tracker 工具把这些问题回到 ticket 上，然后停下，不要开始实现」。
- `coordinator`：Butler 总控 session 开着时把问题递给它，让它去回；没开着就退回 `notify`。

`session` 和 `coordinator` 都是对外动作 `intake_tracker_comment`（B 的开关，默认关）：开关关着时退回 `notify` 并记 `skipped`；开着时记审计（问题文本截断进 payload）。之后再拉到内容变了就重新分类；你也可以在队列里点「已补全」或「仍然开工」。

## 7. 数据

迁移（追加一条）：

- `intake_items`：`key` 主键、`source`、`title`、`url`、`content_hash`、`payload`（来源原文 JSON，限长）、`repo_path`、`repo_slug`、`state`（`needs_repo / needs_clarification / needs_decision / held / queued / waiting / started / split / skipped / exists / failed`）、`wait_reason`、`detail`、`size`、`risk`、`clarify`、`missing`、`questions`、`expected_paths`、`reasons`（JSON）、`class_source`、`rules_version`、`confidence`、`classify_model`、`user_dims`（用户改过的维度）、`tier`、`model`、`allow_parallel`、`force_start`、`parent_key`、`layer`、`ticket_key`、`attempts`、`alerted_at`、`first_seen_at`、`updated_at`、`started_at`。
- `intake_overrides`：`id, item_key, dim, from_value, to_value, rules_version, class_source, at`。
- `intake_policies`：同 `cost_caps` 的分层表。

## 8. 度量（H）

`recordEvent`：`intake.classified`（`data.via` = rules / model / mixed，加 size、risk、clarify）、`intake.started`（`data.mode` = auto / manual，档位）、`intake.queued`（`data.via` = 等的原因）、`intake.clarify`（`data.mode` = notify / session / coordinator）、`intake.decision`（`data.via` = 原因）、`intake.overridden`（`data.via` = 维度）。都登记成 `other` 组，「效果」页的「其他事件」自动出现；另外加一张「自动接活」卡片：分类数、自动开工数、手动开工数、要澄清数、被你改分类的项数和比例（改过的项 / 分类过的项）、各维度被改的次数。

## 9. 其他决定

- **新路由任务 `intake_fetch`**（low、fallback）：总设计表里只有 `intake_classify`；拉取和分类是两种调用，分开记用量和档位更清楚。契约允许 addendum 扩展。
- **B 的两个新动作种类**：`intake_tracker_comment`（`externalIntakeTrackerComment`）、`intake_tracker_status`（`externalIntakeTrackerStatus`），默认关。真正写 tracker 的是 session 或总控（用户自己的 MCP），Butler 只决定要不要让它去做，并记审计。
- **设置**：普通设置 `intakeSource`、`intakeTrackerQuery`、`intakeTrackerDir`、`intakeFilePath`、`intakePollMinutes`、`intakeRepoMap`（来源是全局的）；三层策略 `enabled`、`autoStart`、`maxSize`、`maxRisk`、`maxParallel`、`conflictAction`、`clarifyMode`、`uncertainBelow`、`stackSubtasks`、五个档位映射。都写进 `docs/configuration.md` 和 `.zh-CN.md` 的「自动接活」一节。
- **界面**：设置页新标签「自动接活」（来源、仓库映射、分层策略编辑器，预审没开时给警告）；「进度」页加「接活队列」区块（号、标题、仓库、大小 / 风险 / 澄清、理由、状态和原因、档位、PR 的风险和就绪；可改分类、选仓库、开工、允许并行、已补全、跳过、重试）；「现在」页加 `intake` 提醒和「自动接活」记录；「效果」页加卡片。
- **IPC**：`intake:view`、`intake:effect`、`intake:policyView` 只读（`NOT_TRIGGERS`）；`intake:poll`、`intake:act`（开工、跳过等）是人推动的工作（`MANUAL_TRIGGERS`）；`intake:classify`（改分类）、`intake:policySet` 是配置（`NOT_TRIGGERS`，改分类另由 `intake.overridden` 计数）。
- **双平台**：只用 git、`claude -p`、文件读写；路径比较统一换成 `/`、Windows 不分大小写；文本按 `\r?\n` 切。

## 10. 验收

- 总开关关着：不拉、不写、不开、不提醒（单测 + e2e）。
- 打开后：小、低风险、信息完整的 ticket 自动开 session，档位按映射（e2e 里看 fake claude 收到的 `--model`）。
- 缺验收标准的 ticket 不开工，只提醒（「现在」页的提醒）。
- 超过并行度上限的进队列，名额空出来后自动开工（单测；e2e 关掉第一个终端后第二个开起来）。
- 同仓库改同一批路径的两个 ticket 不会同时开工（单测）。
- 用户改分类有记录，「效果」页能看到（单测 + e2e）。
- 每个新开关有单测；e2e 走完「来源 → 分类 → 开工或进队列 → 提醒」。
