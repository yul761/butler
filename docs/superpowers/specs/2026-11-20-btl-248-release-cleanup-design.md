# BTL-248：4.0 发版前的收尾（design addendum）

日期：2026-11-20。上游设计：Shipherd 4.0「做减法、收概念」的 W5（信箱）和 W6（层级 A′）。前置：BTL-245（#73）和 BTL-246（#74）留下的遗留问题。

## 1. 剩下的送达路径改走信箱

BTL-245 之后还有几条路径在用「等它停下再送」：先过 `DeliveryGuard.check`，不通过就返回 false，等下一次再试。用户的要求是消息一律排队、实时送达。逐条处理如下：

| 路径 | 以前 | 现在 | 种类（`MessageKind`） |
|---|---|---|---|
| CI 结论（`CiDelivery`） | guard 不过就留在内存，等下一轮 flush 重试 | 选好收件人以后 `mailbox.send`，ref `ci:pr:<id>` 或 `ci:branch:<repoId>`。送达回调里按 meta 记的 key 调 `setDelivered`；结论变了（又在跑、合并了）就撤回 | `ci` |
| 合并占位的通知（`HoldWatcher`） | 等待者开着、停着才贴，否则等下一轮，最多 24 小时 | 一到就排进等待者的信箱，ref `merge:<waiterId>`，同时 `markNotified`。关着的下次打开时第一件事读到。24 小时的上限只剩给升级前留下、或 Shipherd 关了很久才查到的通知：释放超过 24 小时还没排进去的就不发了 | `merge` |
| 栈冲突（`StackService.deliver`） | guard 不过就当没送，以后也不会再送 | 排进那一层 session 的信箱，ref `stack:<ticket>:<branch>`：同一层新的冲突换掉还没送的旧冲突 | `stack` |
| 每日巡检（`ShipherdPatrol`） | 开着的过 guard，忙就等下一次 check | 开着的直接排进信箱，当天记 ok；没开的先排进要接着用的那个 session 的信箱（`hold`），再打开，用 `mailbox.opened` 当第一条输入交进去 | `patrol` |
| 花费提醒（`CostBreaker.nudge`） | guard 不过就留在内存，等 Stop | 排进信箱，ref `cost:<root>`：新的一句换掉旧的。暂停中的 session 信箱照样不送（`DeliveryGuard` 的 `cost_paused`），也不为它叫醒 | `cost` |
| 对话 tab 发给开发 session、分叉的结论（`DevSender`） | guard 不过就返回「正忙 / 在打字……」，让用户稍后再发 | 一律排进信箱，返回 `{ ok, at, state }`。在忙的时候界面提示「已排队，下一次调用工具时送到」，关着的提示「打开后送到」 | `user` |
| 接活交给全局总控（`toCoordinator`） | guard 不过就返回 false，退回成通知 | 全局总控开着就排进它的信箱，返回 true；没开照旧返回 false | `shipherd` |

### `user` 种类

用户自己的话，在对话时间线里要照旧显示成「你：」。所以 `Mailbox.batch` 遇到一批消息全是 `user` 的，就原样输入：不加信箱开头，也不加前缀。经 hook 送进在忙的 session 时，加一行「用户在 Shipherd 的对话 tab 里对你说：」再接正文，让 Claude 知道这是用户说的，不是别的 session 的汇报。

经 hook 送进去的那条在 transcript 里是工具结果的附加上下文，不是用户输入，所以对话时间线里不会出现「你：」那一行；它在 session 的消息列表里显示为「你发的」，送达时间照记。用户发的和别的消息不合成一段：一批里遇到种类变了就停，下一批再送。

用户发的话不看「需要你」：以前对话 tab 用的是不看「需要你」的 `answerGuard`，因为 session 停下来问问题、或者有没答的 `ask_user` 时，用户说的往往就是回答。所以 `flush` 被「需要你」挡住时，把排着的 `user` 消息单独挑出来送，Shipherd 的别的消息接着等。这一段也不算 Shipherd 输入的（不调 `typing`），它触发的 `UserPromptSubmit` 照旧算用户在终端里回答了。

信箱的消息没写 epic（CI、合并通知、栈、花费、对话 tab）时，按收件 session 所在的 epic 记（ticket 的 session 从 ticket 往上找），epic 的消息列表里能看到它们排着还是送到了。

### 每日巡检的细节

- 开着的全局总控：排进信箱就记当天 ok，不再等它停下。
- 没开：有要接着用的那个，先排进它的信箱（`hold`，不让信箱自己去叫醒），再打开；没有就先开新的，开好以后再排。然后 `mailbox.opened` 把排着的当第一条输入交进去。交不进去也还在信箱里，在忙的 hook 送、停下来时信箱送，当天照样记 ok。
- 打开时发现别处已经先开了（`alreadyOpen`）：不直接输入，照常排队。
- 打不开：撤回排着的那条，当天记失败。

### 迁移

`session_messages.kind` 有 CHECK 约束。追加一条迁移重建这张表，把 kind 放宽到加上 `ci, merge, stack, patrol, cost, refresh, user`，数据原样拷过去，索引也重建。迁移只追加。

### 哪些还要等对方空闲：换新（`SessionRefresher`）

换新是一串动作：先输入 `/handoff`，等它收进来，再 `/clear`，等新 id 接上，最后让新 session 接着做。`/handoff` 和 `/clear` 是斜杠命令，不是消息：放进 `additionalContext` 不会执行，只能在 session 停着的时候直接输入，所以这两步继续过 guard，等对方空闲。这一点不改。

为了让它的消息也进信箱，改了两处：

1. **换新期间不往 hook 投影。** 以前换新进行到 `/handoff` 那一轮时，hook 会把信箱里的消息送进这一轮的上下文，紧接着 `/clear` 就把它清掉了，消息算送达，其实丢了。现在 `Mailbox` 多一个 `held(head)`：正在换新的 session 不写投影，直接输入本来就被 guard 的 `refreshing` 挡着。换新一结束（不管成没成）就重新同步并 flush，排着的消息送进新的上下文。
2. **最后一步「接着做」改走信箱**（种类 `refresh`）。`/clear` 完成以后换新就算结束，「接着做」排进新 head 的信箱。它排在这个 head 所有消息的最前面，单独原样输入，不加信箱开头：它是新上下文的第一句话（session 的名字也从它来），新 session 先 recall，再收换新期间排着的。它和 ask_user 的回答一样不看「需要你」，跟以前手动换新用 `guardIgnoringNeedsYou` 一致。以前这一步过不了 guard（用户刚好在打字）就算换新失败，新 session 空着；现在会排队，等能送的时候再送。

还剩一个很小的窗口：hook 在换新开始前的一瞬间刚拿走一份投影（`.taken`），它会进 `/handoff` 那一轮，然后被 `/clear` 清掉，却记成送达。窗口只有一次工具调用那么长，不另外处理。

### `DeliveryGuard` 留下

信箱停着时的直接输入（「先看屏幕，送完确认」）和换新这一串动作都还要用它。它现在只有这两个使用方：`Mailbox` 的 `check/recheckAfter`，以及 `SessionRefresher`。别的模块不再 import 它。`index.ts` 里只给 CI、评论、栈用的 `loopDeliver` 和 `deliveringTo` 删掉：信箱自己保证同一个终端同时只送一段。

### CI「未能送达」的提醒

排着的结论不是一直等原来的收件人：每次 flush 都按现在的归属重挑一次，挑出来的不是排着的那个（原来的关了、分支上换了 session）就改投，同一个 ref 换掉旧的那条。

guard 带来的原因（`guard:*`、`deliver:*`、`busy_delivering`）都没有了。排进信箱就算交出去了，等着的状态在消息列表里能看到。「现在」页的提醒只剩认不出收件人的情况：`no_session`、`owner_closed`、`unowned`。

`CiTriage` 的 `onSent` 是一个闭包，不能存进库里。做法是按 ref 留在内存里，送达回调时调用。Shipherd 在排队和送达之间重启过，这次就不调了：只影响 triage 行的统计状态，不影响送达。

## 2. 空 epic

Jira 接活建 ticket 时，先 `ensureJiraEpic`，再建 ticket。ticket 建失败（worktree 建不出来、号码不合法……），就留下一个空 epic。

改法：新增 `FeatureService.withJiraEpic(epic, repoPath, fn)`。它记下 epic 是不是这次新建的，`fn` 抛出时，这次新建的 epic 如果还是空的（没有 ticket、没有 session、没有 feature 块、没有信箱消息），就把它和它的仓库行一起删掉，再把错误抛出去。用的是已经有的 epic 时什么都不删。磁盘上什么都不动：`ensureJiraEpic` 本来就不建目录。

「空」按 `FEATURE_REFS` 判断：所有带 `feature_id` 的表（`feature_repos` 除外，它跟着一起删）都没有行指着它。测试会拿 schema 对一遍，以后加了带 `feature_id` 的表就得加进去。

同一个 epic 可能有好几个 intake 同时在建 ticket（e2e 里就碰到过：同一个 ticket 被 organize 了两次，第二次因为分支已经在了而失败，把第一次正在用的 epic 删了，第一次插 ticket 时撞上外键）。所以 `withJiraEpic` 按 epic key 计数：还有别的调用在做就不删，最后一个失败退出、而且其中有一个开始时 epic 还不存在，才删（还空着的话）。

semi 档里 `toEpicCoordinator` 会在 ticket 开工之前就建 epic、打开总控，那个 epic 有总控 session，不算空壳，不在这次处理的范围里。

## 3. `briefSentAt`

`features.brief_sent_at` 是旧 epic 层把计划交给 feature 时用的（handOver），BTL-246 删掉那条路以后就没人写了。`brief` 本身还在用（迁移进来的规划笔记，进 epic 记忆的 handoff 摘要），保留。

决定删掉：从 `Feature` 类型和 `FeaturesRepo` 里去掉，再追加一条迁移 `ALTER TABLE features DROP COLUMN brief_sent_at`。没有索引、触发器或视图引用这一列。node:sqlite 自带的 SQLite 版本支持 DROP COLUMN。

## 4. 一致性

这次改的：

- 「还没有关联仓库」和打开仓库失败的提示里，去掉「或者开总控 session」：ticket 自己的总控已经没有了。
- epic 页上的说明和「按顺序推进」的提示，「总控」改成「epic 总控」。
- README 讲升级的那段，「feature 总控」改成「这些 epic（原来的 feature）的总控」。

不改的：给 session 的消息前缀，例如「Shipherd 总控发来的消息」/ "Message from Shipherd control"。BTL-246 定过：`conv-parse` 和回复匹配按这些原样的前缀认出旧的对话，改了以后旧对话就认不出来了。「Shipherd 总控」指的就是全局总控，不是旧概念。


用户看得到的文字、给 Claude 的提示词和 MCP 工具说明，中英两份都扫一遍。要去掉的残留有：

- 旧 epic 层；
- ticket 总控；
- 个人 API；
- 隐私档位；
- 蒸馏。

「feature」只在指 epic 里的一块时使用。内部名字不改：`features` 表、`featureId`、`feature:<id>` 记忆范围、`shipherd-feature` server。

## 5. 和 BTL-242 的约定

- BTL-242 不碰 `index.ts` 的送达部分。
- BTL-242 没有新迁移，这次的两条直接追加在最后。
- 新加的会写东西的 IPC 不放进 `read-channels.ts`。这次没加新 IPC，`conv:send` 的返回值多了 `state`。
- 两边都改了的字符串文件，合并时两边的都留下。
