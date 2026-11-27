# 工作流 K：栈式 PR、整栈自动 rebase 与 draft 管理（设计 addendum）

总设计：`2026-11-17-shipherd-3-design.md`。本文只写 K 自己的决定；契约（4.2 三层作用域、4.3 导入导出、4.7 事件、4.8 外部动作、4.9 通用规则）按总设计。

范围：源计划 7.7（栈式 PR 的自动 rebase）和 7.13（深栈与 draft 管理）全部。总设计第 6 节已定：上层默认只推分支、不开 PR；只有用户要 PR CI 的层开 draft；squash 和 merge commit 两种流程都支持，按仓库检测，可以覆盖。

## 0. 核实过的现状（源计划「开发时要核实」）

| 项 | 结论 | 用法 |
|---|---|---|
| 本机 git 版本 | 2.54.0。`--update-refs` 从 2.38 起有 | 每次 run 前读 `git --version`（进程内缓存），低于 2.38 退回逐层 rebase（第 3.3 节） |
| `--update-refs` 和别的 worktree | 被别的 worktree 检出的分支，git 不会更新（只在 todo 里留注释）；另外它会更新**所有**指向被 rebase 提交的本地分支，包括不归 Shipherd 的 | rebase 不在真分支上做：在 Shipherd 自己的临时 detached worktree 里，用指向各层顶端的临时分支做；todo 里的 `update-ref` 只留临时分支（第 3.2 节）。真分支由 K 自己用 CAS 更新 |
| 仓库的合并方式 | 合并事件里能直接看出来：旧栈底顶端是 trunk 的祖先就是 merge commit（或 fast-forward），否则是 squash / rebase merge | 按每次合并检测，记在栈上；`stacks.mergeMethod` 可以覆盖（第 4 节） |
| `gh` 能否改 PR base | `gh pr edit <n> --base <b>` 可以；`gh pr ready <n>` 把 draft 标成 ready；GitHub 删掉已合并的 base 分支时会自动把子 PR 改指它的 base | 新栈底的 PR 已经指向 trunk 就不再改；没指向才 `gh pr edit --base` |
| 合并闸占位 | `merge_holds`：某个分支拿到合并进某目标的许可、还没合完 | 要改写的层有活动占位，或者同仓库有分支正占着 trunk（有合并在途），这次 run 推迟（第 3.5 节） |
| 分支归属 | `ticket_repos.branch` 和 `branch_owners`（ticket、仓库、分支 → session） | 只动这两处登记的分支（第 2.3 节） |
| PR 字段 | `ticket_prs.baseBranch`、`isDraft`、`headSha`、`mergedAt` 已有；B 的进度页已经按 base→head 画 PR 叠放树 | K 的栈是本地维护的（上层多数没有 PR），在进度页另加一块（第 7 节） |
| 合并回调 | `PrWatcher.onMerged(pr, repoPath)` 每个合并过的 PR 只成功调用一次，抛错下一轮重试；现在给了 lessons | index.ts 里在同一个 lambda 里接上 K（先 lessons，K 失败不影响 lessons） |
| 对外动作 | B 的 `ExternalActions.attempt`；E2 加 `branch_push`（`externalBranchPush`） | 第 6 节；K 不新增动作种类（已和 I、J 对齐） |
| 评论闭环 | I（未合）提供 `CommentLoopDeps.stackNote?(row)` 和 `CommentLoop.awaitingCheck(prId)` | 第 5 节 |
| G 的简报 | G 还没开 | 栈底 PR 描述留 `briefProvider?(layer)` 注入点，K 不算就绪度和风险 |
| 模型调用 | K 不调模型 | 不新增路由任务 id |

## 1. 默认值

- 本地写操作（rebase、改分支指向、打开 rerere）由三层策略 `stacks.autoRebase` 控制，**默认关**。关着时 K 只维护栈表、画栈图、出提醒，不碰 git 的引用。
- 对外动作（force push、推分支、开 PR、改标题 / label / 描述、贴 tracking issue）各自受 B 的开关控制，**都默认关**。开关关着时本地照做，审计记 `skipped`，栈图上标「本地已 rebase、未推送」。
- epic 总览 `stacks.overview` 默认 `off`。

## 2. 数据

### 2.1 表（迁移只追加）

- `stacks`：`id`、`repo_path`（主仓库根）、`repo_slug`、`trunk`（目标分支，默认 `defaultBranch`）、`remote`（`branch.<trunk>.remote`，没有就 `origin`）、`name`、`epic_id`、`feature_id`、`source`（`mcp` / `ticket` / `detected`）、`merge_method`（上次检测到的 `squash` / `merge`，可空）、`trunk_sha`（上次看到的远端 trunk）、`overview_number`、`overview_url`、`overview_hash`、`last_daily_at`、`created_at`、`updated_at`、`removed_at`。
- `stack_layers`：`id`、`stack_id`、`position`（0 离 trunk 最近；合并过的层保留，按 position 排）、`branch`、`ticket_key`、`ticket_repo_id`、`mode`（用户要的：`branch` / `draft`）、`state`（`branch_only` / `draft` / `ready` / `merged`）、`pr_number`、`pr_url`、`base_sha`（这一层上次同步时它的父层顶端，也就是它自己那段提交的起点）、`tip_sha`（上次同步时的顶端）、`remote_ok_sha`（远端上已知可以被覆盖的那个提交，第 3.4 节）、`draft_since`、`merged_at`、`last_rebase_at`、`created_at`。`UNIQUE(stack_id, branch)`。
- `stack_runs`：`id`、`stack_id`、`trigger`（`main_updated` / `bottom_merged` / `layer_commits` / `daily` / `manual` / `autosquash` / `restore`）、`mode`（`update_refs` / `per_layer`）、`outcome`（`rebased` / `noop` / `conflict` / `deferred` / `failed` / `rolled_back` / `restored`）、`reason`、`detail`（JSON：每层旧顶端、新顶端、备份引用、冲突层和文件、合并方式、推送结果）、`started_at`、`finished_at`。
- `stack_policies`：三层覆盖（`scope_kind`、`product_id`、`repo_slug`、`overrides` JSON、`updated_at`），和 L 的 `cost_caps` 一样的写法。

### 2.2 栈从哪来

1. **feature 总控 `create_ticket` 加可选参数 `stack_on`**（同一 feature 里另一个 ticket 的 key）：新 ticket 的 worktree 从那个 ticket 的分支开出来（`attachWorktree` 的 `start` 参数），并把新分支接到那个栈的顶上（没有栈就新建，`source: ticket`）。只允许接在栈顶：从中间开新层会变成树，K 只维护线性的栈。
2. **MCP 工具 `stack_define`**（feature 总控、Shipherd 总控）：给出同一仓库里按从下到上排好的分支（或 ticket key），建一个栈或者整个替换已有栈的层次（`source: mcp`）。
3. **自动检测**：每一轮同步时，看 Shipherd 的开着的 PR：base 是另一个 Shipherd PR 的 head（同仓库）的连成一条链，链里有两层以上、而且还没有哪一层属于某个栈的，建一个栈（`source: detected`），各层有 PR 的记成 `draft` / `ready`。

另外有 `list_stacks`、`stack_rebase`、`stack_layer_mode`（把某层开成 draft 或降级成纯分支）三个 MCP 工具，界面上有同样的按钮。一个分支同一时间只能在一个栈里。

### 2.3 什么算「Shipherd 自己的分支」和「Shipherd 管理的 worktree」

- 分支：这个仓库里某个未归档 ticket 的 `ticket_repos.branch`，或者 `branch_owners` 里登记过的。`stack_define` 给的分支不满足就拒绝。
- worktree：ticket 的 `workMode` 为 `worktree`、没被清理、目录存在的那个，加上 K 自己的临时 worktree。
- 某层分支检出在别的目录（用户的主检出、`branch` 方式的 ticket、别处的 worktree）：这次 run 不动整个栈，`deferred`，原因写明是哪个分支、检出在哪。

## 3. 整栈 rebase

### 3.1 需不需要动

先 `git fetch --prune <remote>`（超时 60 秒；失败就用本地已有的，并记原因）。父层的目标：第 0 个没合并的层的父是 `<remote>/<trunk>`，其余是下一层 rebase 后的顶端。某层「不在父层顶端之上」（父层顶端不是它的祖先）就要动；从最低的这一层开始，往上全部重放。

每层那段提交的起点（upstream）：在「旧父层顶端」和「记录的 `base_sha`」里取是本层顶端祖先、而且更新的那个；都不是就取本层顶端和旧父层顶端的 merge-base。这样父层被 autosquash / 别人改写过、或者父层后来又加了提交，都能找对起点；找不到就 `failed`，不猜。

### 3.2 在临时 worktree 里 rebase

- 在 `<SHIPHERD_HOME>/stack-work/<stackId>-<runId>` 用 `git worktree add --detach` 建临时 worktree；给每层建临时分支 `refs/heads/shipherd-stack/<runId>/<position>` 指向它现在的顶端。`finally` 里删临时分支、`worktree remove --force`、`worktree prune`。
- 用户的 git hook 不在这里跑（`-c core.hooksPath=<空目录>`）：这是机械的重放，内容已经过了 session 那边的检查；husky 这类 post-checkout hook 在临时目录里装依赖只会拖慢。
- git ≥2.38：一段线性的层（下一层顶端是上一层顶端的祖先）用一条命令：
  `git -c rerere.enabled=false rebase -i --update-refs --empty=drop --no-autosquash --onto <新父> <起点> shipherd-stack/<runId>/<最高层>`。
  `-i` 只是为了过一道 sequence editor：Shipherd 自己的小脚本（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`，和 MCP 服务一样的跑法，两个平台都行）把 todo 里不是临时分支的 `update-ref` 行删掉，其他原样保留（git 自己的 pick 顺序、跳过已在上游的提交都不变）。中间某层不在下一层顶端之上（链断了）就分成几段，每段一条命令，下一段的新父是上一段 rebase 后的对应层。
- git <2.38：每层一条 `git rebase --onto <新父> <起点> shipherd-stack/<runId>/<position>`。
- 停下来就是冲突（BTL-278 起不再靠 rerere 自动 continue）：记下 `REBASE_HEAD` 属于哪一层、冲突文件，`rebase --abort`，真分支一个都没动。
- 合并方式（第 4 节）只决定新栈底的起点：merge commit 走普通 rebase（`git rebase <trunk>` 的语义，起点是 merge-base）；squash 走 `--onto <trunk> <旧栈底顶端>`。

### 3.3 版本检测

`git --version` 解析出主次版本，≥2.38 用 `update_refs`，否则 `per_layer`，写进 run 的 `mode`。测试里可以强制 `per_layer`，两种都测。

### 3.4 更新真分支和推送

先全部预检，任何一层不过就整次 `deferred`，什么都不改：
- 要改的层：检出在 Shipherd 管理的 worktree 里的，工作区不能有已跟踪文件的改动，`HEAD` 等于旧顶端，那个 session 不在忙（活动不是 idle / waiting 就算忙）；没检出的直接改引用。
- 远端：远端分支是本地旧顶端的祖先（或相等），或者等于 `remote_ok_sha`（上次 K 改写之前远端那个提交，开关关着没推出去时会这样）才可以覆盖；远端有本地没有的提交（有人从别处推过）就不动。

然后：
1. 每个要改的层写备份引用 `refs/shipherd/stack-backup/<stackId>/<runId>/<position>` 指向旧顶端（用 position 而不是分支名，避免 `a` 和 `a/b` 的目录冲突；分支名记在 run 的 detail 里）。
2. 逐层 CAS 更新：没检出的 `git update-ref refs/heads/<b> <新> <旧>`；检出在 ticket worktree 里的在那个目录 `git reset --keep <新>`（先确认 `HEAD` 还是旧顶端）。中途任何一步失败，已改的全部改回（`update-ref <b> <旧> <新>` / `reset --keep <旧>`），run 记 `rolled_back`，备份引用留着。
3. 更新 `base_sha`、`tip_sha`、`last_rebase_at`。
4. 推送（远端有这个分支的才推，从没推过的上层分支留给 session 自己推）：`force_push` 开关，`git push --force-with-lease=refs/heads/<b>:<预检时看到的远端提交> <remote> <b>`。成功后 `remote_ok_sha` 设成新顶端；开关关着记 `skipped`，`remote_ok_sha` 保持旧的远端提交（下次还认得它）。
5. 备份引用保留 30 天（每日任务清理），界面上可以「从备份恢复」：把各层 CAS 改回备份的提交（各层现在必须还是那次 run 的新顶端），能推的照样 force push。

### 3.5 什么时候推迟

- 要改写的某层 PR 在 I 的评论闭环里 `awaitingCheck(prId)` 为 true（I 要用 `deliveredSha...新 head` 核对，force push 会让它卡住）。
- 要改写的某层有合并闸的活动占位，或者同仓库有分支正占着这个 trunk（有合并在途，等它合完再一起 rebase）。
- 第 3.4 节的预检不过。
推迟的 run 记原因，下一次触发再试；同一原因连续推迟不重复记 run（只更新最近一条的时间）。

### 3.6 触发

- **main 有更新**（`stacks.rebaseOnMainUpdate`，默认开）：每 5 分钟每个仓库 fetch 一次，远端 trunk 变了就跑这个仓库的栈。
- **栈底合并**：`onMerged` 里 PR 属于某个栈的层，标成 `merged`，立即跑（`bottom_merged`），然后提升新栈底（第 4 节）。
- **栈中某层有新提交**：每分钟比较各层本地顶端和 `tip_sha`；session 停下来时（`sessionStopped`）也看一下它的 ticket 所在的栈。
- **每天一次**（`stacks.dailyRebase`，默认开）：每个栈每个自然日跑一次，哪怕没检测到变化（保证每次都是小 rebase）。
- **手动**：界面按钮、`stack_rebase`。手动的不看 `rebaseOnMainUpdate` / `dailyRebase`，但仍然要 `autoRebase` 开着（它是「允许 Shipherd 改本地分支」的总开关）。
- 同一个栈同一时间只跑一个 run（进程内锁），每个仓库的 fetch 也串行。

### 3.7 rerere

（BTL-278 改了）K 不再替仓库打开 rerere，自己的命令总带 `-c rerere.enabled=false`，停下来就是冲突，不自动 continue。rr-cache 在共用的 git 目录里，所有 worktree 共用一份；session 解过又放弃的解法也在里面，不经人看就套用、force push 出去，就出了 BTL-278 那次事故。用户自己开的 rerere 不动，session 在自己的 worktree 里照样能用。

推送前还要过几道（BTL-278）：结果里新多出冲突标记就算失败；自动触发的 run 要改写开着、可以 review 的 PR，或者冲突已经交给 session 的层，结果记成 `needs_confirm`，本地和远端都不动，等人点「马上 rebase」。冲突落在 ready 层上，或者它下面这次真要改写的层里有 ready 的，自动 run 同样记 `needs_confirm`，不交给 session；下面没动的 ready 层不算（引擎在冲突结果里带回下面各层的新顶端）。失败的 run 过一阵再试：第一次等 1 小时，同样的输入、同样的原因连着失败，每次翻倍，最多一天。

### 3.8 冲突

- 冲突发生在哪一层就送给那一层的 session（`stacks.conflictToSession`，默认开）：过 DeliveryGuard，用 `pty.deliver`。正文写清楚分支、冲突文件、要在自己 worktree 里执行的那条 `git rebase --onto <新父> <起点>`，解完 push；K 下一轮接着处理上面的层。冲突交出去以后，session 自己动这一层（和它上面的层）不算「有新提交」，自动 run 也不改写它们；直到这一层的顶端包含了新父，或者 trunk、父层真的变了。
- session 没开、递不进去（过了 30 分钟还没递出去），或者 `conflictToSession` 关着：「现在」页出一条栈冲突提醒，可以打开对应 ticket。
- 同一个冲突（同一层、同一组新父和起点、同样的冲突文件和新父里这些文件的内容）只送一次，也不再每分钟重跑；trunk 或父层真的变了才重试。
- 补递的冲突所属的 run 已经被新的 run 取代：不送；送的过程中被取代就撤回刚排进去的那条。新的那次也是这一层的冲突、已经送过，按它重送（同一个 ref 的消息刚被撤掉）。

## 4. 栈底合并

1. `onMerged` 收到某层的 PR 合并：这层 `state = merged`，`merged_at`，记下合并时的 PR head（`ticket_prs.headSha`，没有就用 `tip_sha`）。
2. 合并方式：`stacks.mergeMethod` 为 `squash` / `merge` 就按它；`auto` 时看旧栈底顶端是不是远端 trunk 的祖先：是就是 merge commit，不是就是 squash（rebase merge 也走这条，`--onto` 同样对）。记到 `stacks.merge_method`。
3. 跑整栈 rebase（第 3 节）。merge commit 的新栈底起点用 merge-base（普通 rebase）；squash 用旧栈底顶端（所以每层都要存 `tip_sha` 和 `base_sha`）。
4. 提升新栈底（`stacks.autoOpenBottomPr`，默认开）：
   - 已经有 PR（draft 层）：PR 的 base 不是 trunk 才 `gh pr edit --base <trunk>`（GitHub 删掉旧 base 分支时会自己改，不重复改）；`gh pr ready`；标题去掉 `[stack k/n · …]` 前缀；去掉 `stacked` label；描述重写成栈底的描述。
   - 没有 PR：分支没推过先推（`branch_push`），然后 `gh pr create --base <trunk> --head <b>`（ready）。标题：ticket 的 `KEY 标题`，没有 ticket 用第一个提交的标题。
   - 描述（K 写，中英按 Shipherd 的语言）：这一层的提交列表、栈里的位置和上面还有哪些层、这一层是栈底可以 review；`briefProvider?(layer)` 返回非空时插在提交列表前面（G 的 review 简报接这里）。
   - 都用对应的外部动作开关（第 6 节），关着的那一步记 `skipped`，栈图上这层显示「待开 PR」，开关打开后的下一轮补做。
5. 上面的 draft 层同步：标题的 `k/n`、描述第一行的「依赖 #N」按新的顺序改（只在变了时改）。

## 5. draft 层、提醒、评论回灌

### 5.1 draft 层

- 用户要某层有 PR CI 时（`stack_layer_mode draft` 或界面按钮）：父层分支没推过先推；`gh pr create --draft --base <父层分支>`，标题 `[stack 3/6 · 勿 review] <标题>`（英文界面 `[stack 3/6 · do not review]`），描述第一行「依赖 #123，暂不需要 review」（父层没有 PR 时写「依赖分支 `<b>`，暂不需要 review」），打 `stacked` label（`stacks.draftLabel` 可改；label 不存在先 `gh label create`，算 `pr_label`）。
- 降级成纯分支：`gh pr close <n>`（不删分支），层的 `mode = branch`、`state = branch_only`。关 PR 归到 `pr_open` 开关（PR 的开 / 关 / 改 base / 标 ready 都是 PR 生命周期，用同一个开关；开关说明里写明）。

### 5.2 提醒（「现在」页）

一个新的提醒种类 `stack`，带 `reason`：
- `conflict`：第 3.8 节。
- `draft_stale`：draft 超过 `stacks.draftDemoteDays`（默认 14）天，提醒降级成纯分支（按钮在进度页的栈区块）。
- `behind`：栈底落后远端 trunk 超过 `stacks.behindCommits`（默认 20）个提交，或者最早没合进来的那个 trunk 提交已经超过 `stacks.behindDays`（默认 3）天。`autoRebase` 开着时通常不会出现，出现说明 rebase 一直推迟或失败。
- `stuck`：连续推迟 / 失败超过 24 小时，带最近一次的原因。

### 5.3 review 评论回灌（和 I 对齐的接口）

- I 在 `CommentLoopDeps` 里加可选依赖 `stackNote?(row: TicketPr): string | null`，非 null 时以 `"\n\n" + note` 接在评论递送正文后。K 返回：这个 PR 是第 k/n 层、上面还有哪些分支；改动用 `git commit --fixup=<被改的提交>` 提交在这一层、照常 push；不要自己 rebase 上面的层，Shipherd 会接着做。
- I 公开 `CommentLoop.awaitingCheck(prId): boolean`。
- 流程：session 在栈底出 fixup 提交并 push → K 的「某层有新提交」触发把上面几层 rebase 到新栈底 → 等 `awaitingCheck` 变成 false，且 `stacks.autosquash`（默认开）开着：在临时 worktree 里 `rebase -i --autosquash --update-refs`，核对每一层新顶端的 tree 和旧顶端的 tree 一样（autosquash 只合并提交，不改内容），不一样就整次回滚；一样就按第 3.4 节更新、force push（`trigger: autosquash`）。
- I 还没合时，index.ts 里两处都按可选接：没有 `awaitingCheck` 当作 false。

## 6. 对外动作

| 动作 | 用在 |
|---|---|
| `force_push` | rebase / autosquash / 恢复备份之后推已有的远端分支 |
| `branch_push`（E2 加） | 推从没推过的分支（开新栈底 PR 或开 draft 之前） |
| `pr_open` | 开新栈底 ready PR、开 draft、`gh pr edit --base`、`gh pr ready`、关降级的 draft |
| `pr_title_edit` | draft 标题前缀、去前缀、改 k/n |
| `pr_label` | 建和加 / 去 `stacked` label |
| `pr_description_edit` | draft 描述第一行、新栈底描述 |
| `issue_post` | epic 总览的 tracking issue（建和改） |

全部走 `ExternalActions.attempt`，`scope` 是仓库路径，`target` 是分支或 PR，`summary` 一句话。用户在界面上点的按钮也走 `attempt`（开关关着就不做，界面提示去开开关）。E2 #44 合进 main 前，K 的分支里在 `external.ts` 的 `pr_open` 后面加和 E2 一字不差的 `branch_push` 两行，rebase 时以 main 为准。

## 7. 界面

- **进度页**：B 的「PR 叠放树」后面加「栈」区块（受页面的 epic / feature 筛选）：每个栈一张卡片，从栈底到栈顶列出各层（分支、ticket、状态、PR 链接、落后 trunk 多少、上次 rebase），栈的合并方式、上次 run 的结果和原因；按钮：立即 rebase、开 draft / 降级成分支（每层）、从备份恢复（最近一次有备份的 run）、不再跟踪这个栈。选进度页而不是 ticket 页：栈跨好几个 ticket，进度页本来就是「整体情况」，ticket 页只看自己那一层。ticket 页不加。
- **设置**：新的「栈」标签页，三层策略（全局 / 产品 / 仓库），写法和 L 的「花费与后台」一样；页面上方提示对外动作开关在「通用」里。
- **「现在」页**：第 5.2 节的提醒。

## 8. 三层策略和 config-io

`stack_policies` 经 `LayeredResolver` 解析，键：

| 键 | 类型 | 默认 |
|---|---|---|
| `autoRebase` | bool | false |
| `mergeMethod` | `auto` / `squash` / `merge` | `auto` |
| `rebaseOnMainUpdate` | bool | true |
| `dailyRebase` | bool | true |
| `autosquash` | bool | true |
| `autoOpenBottomPr` | bool | true |
| `conflictToSession` | bool | true |
| `draftDemoteDays` | int 1–365 | 14 |
| `behindCommits` | int 1–10000 | 20 |
| `behindDays` | int 1–365 | 3 |
| `overview` | `off` / `issue` | `off` |
| `draftLabel` | 字符串，1–50 个字符，不含逗号 | `stacked` |

config-io 注册 `stacks` 节（`content: "config"`，order 70，不在起步包里）：导出各层覆盖（全部导出时所有层；按产品导出时那个产品和它的仓库；按仓库导出时那个仓库），导入按层的指纹比较，merge / replace 两种模式。不导出栈表本身（是本机状态，含本地路径）。

## 9. epic 总览

`stacks.overview = issue` 且 `issue_post` 开关开着时，每个栈在它的仓库里有一个 tracking issue（标题 `[stack] <栈名>`，栈属于 epic 时带 epic 名）：按 review 顺序列出各层、状态、PR 链接，标出现在该看哪个。栈变化后（run、PR 状态变）正文变了才改（存正文的 hash）。新栈底 PR 的描述里也有同样的栈图（相当于「置顶 PR」），所以总览关着时同事看栈底 PR 也知道顺序。

## 10. 度量

经 H 的 `recordEvent`：`stack.rebase`（trigger、mode、层数、合并方式）、`stack.conflict`、`stack.rollback`、`stack.pr_open`、`stack.autosquash`、`stack.deferred`（去重键：栈 + 原因 + 小时）。加进 `METRIC_KINDS`，归 `other`。界面上的按钮是 IPC 调用，按 H 的规则归 `MANUAL_TRIGGERS`（记 `manual_trigger`），读的和改策略的归 `NOT_TRIGGERS`。这样「栈底合并后无冲突时不需要人」可以从 `manual_trigger` 为 0 看出来。

## 11. 双平台

- 只用 `git` / `gh` 子进程，参数数组，不经 shell。sequence editor 是 node 脚本（`process.execPath`，`ELECTRON_RUN_AS_NODE=1`），路径给 git 前换成正斜杠（Windows 上 git 用自带的 sh 跑 editor 命令）。
- 临时 worktree 放在 `SHIPHERD_HOME` 下，路径短；删除用 `worktree remove --force`，删不掉再 `rm -rf` 加 `worktree prune`（Windows 上文件被占用时下次再清）。
- 所有 git 命令带 `GIT_TERMINAL_PROMPT=0`、超时（fetch / push 60 秒，rebase 120 秒）。签名提交（`commit.gpgSign`）不关：重放时照常签。
