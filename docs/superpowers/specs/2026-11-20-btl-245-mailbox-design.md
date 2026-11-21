# BTL-245 信箱：session 之间排队、实时送达（design addendum）

日期：2026-11-20。上位设计：Butler 4.0「做减法、收概念」的 W5。本文只写实现时定下的细节。

## 1. Claude Code 的 PostToolUse additionalContext（核实结论）

来源：官方 hooks 参考 <https://code.claude.com/docs/en/hooks>，以及本机实测。

- 输出格式：hook 往 stdout 写 `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"…"}}`，退出码 0。
- Claude Code 把这段字符串包成 system reminder，插在触发 hook 的工具结果之后，模型在下一次请求时读到；它不作为聊天消息显示给用户。
- 每个字符串上限 10,000 字符。超过时 Claude Code 把全文存进文件，只给模型路径和前 2,000 字符的预览，所以 Butler 每次送出的总长控制在 9,000 字符以内，剩下的留给下一次工具调用。
- matcher 省略、为 `""` 或 `"*"` 时匹配所有工具，MCP 工具（`mcp__<server>__<tool>`）也算。PostToolUseFailure 同样支持 additionalContext。
- 命令 hook 的执行方式：macOS/Linux 用 `sh -c`，Windows 用 Git Bash（没装时退回 PowerShell）。Butler 本来就要求 Windows 装 Git Bash（CONTRIBUTING），所以命令按 POSIX sh 写。
- 同一事件匹配上的几个 hook 并行运行，几段 additionalContext 都会送给模型。
- 版本：官方 changelog 网页只能翻到最近几个版本，查不到这个功能最早出现在哪一版。所以用本机的 Claude Code 2.1.330 实测：`claude -p --settings <带 PostToolUse hook 的文件>`，让模型跑 `echo hi`。标记目录存在时，模型原样复述了 hook 送进去的暗号；目录不存在时，模型回答没有收到。结论：**2.1.330 可用**，更早的版本没有验证。更早的版本如果不认 additionalContext，hook 写出的内容会被忽略，而 Butler 已经把消息记成了送达（见第 10 节）。
- 社区报告过 Agent / Task 工具调用后的 additionalContext 会被丢掉（官方没确认）。所以 `butler-hook mailbox` 遇到 `tool_name` 是 Agent 或 Task 时什么都不送，留给下一次工具调用。

## 2. 数据

新表 `session_messages`，迁移只追加：

| 列 | 说明 |
|----|------|
| `id` TEXT PK | uuid |
| `kind` | `instruction`（总控指令）、`report`（汇报）、`answer`（ask_user 的回答）、`butler`（Butler 总控的 send_message）、`reply`（对方的回复，送回发消息的人）、`review`（预审结果）、`comments`（评论闭环）、`convention`（约定广播） |
| `from_session` | 发送方 session 的 head id；Butler 自己发的（回答、预审、评论）为 null |
| `to_session` | 接收方 session 在排队那一刻的 head id。送的时候按 head 链找最新的那个 |
| `feature_id` | 归哪个 feature（4.0 里叫 epic）：界面按它筛 |
| `body` | 已经渲染好的正文（各来源原来那段文字） |
| `interrupt` | 1：先按 Esc 打断再送。只有总控发的 `instruction` 和 `butler` 能带 |
| `ref` | 来源键，比如 `report:12`、`answer:7`、`prereview:3`、`comments:5`。部分唯一索引：同一个 ref 同时只有一条在排队，再排一次就替换正文（回答改了、评论多了一条） |
| `meta` | JSON：来源要的额外信息（评论项的 id 列表等） |
| `status` | `queued` / `delivered` / `replied` |
| `via` | `hook`（工具调用间隙）或 `input`（直接输入） |
| `expects_reply` | `instruction`、`butler` 为 1 |
| `base_reply_id`、`reply_text`、`queued_at`、`delivered_at`、`replied_at` | |

只有三个状态，消息不会「失败」或「过期」。等回复最多等 24 小时，过了就不再等，状态停在已送达。已送达、已回复的 30 天后删掉；还在排队的同样 30 天后删掉（目标 session 一直没再打开）。

旧表 `butler_messages` 留着不用（迁移只追加），旧记录不搬。`ButlerMessages`、`ButlerMessagesRepo` 删掉。

## 3. 送达

DB 是唯一的真相。另外为每个开着的终端在磁盘上放一份「投影」：

```
<BUTLER_HOME>/mailbox/<BUTLER_SESSION>/<queuedAt>-<id>.json   { id, text }
```

`BUTLER_SESSION` 就是终端 id（Butler 打开终端时设的环境变量）。只有还在排队、不带 interrupt 的消息才放进去；信箱空了就把整个目录删掉。

### 3.1 session 在干活：PostToolUse hook

Butler 给自己打开的交互 session 生成 `--settings` 文件（`projectMcpApprovalSettings`）。其中 PostToolUse 和 PostToolUseFailure 都加一组 matcher 为 `""` 的 hook：

```sh
[ ! -d "<mailbox>/$BUTLER_SESSION" ] || exec "<butler-hook>" mailbox
```

- **便宜的判断**：信箱为空时目录不存在，只跑一次 shell 内置的 `test` 就退出 0，不启动 143 MB 的 butler-hook。实测数字写在 PR 里。
- `butler-hook mailbox` 的流程：
  1. 列出目录里的 `*.json`，按名字排序。
  2. 逐个 rename 成 `.taken-<pid>` 来认领：rename 是原子的，抢不到就跳过那一条。
  3. 把正文合成一段，开头一行「Butler 信箱送来 N 条消息」，总长不超过 9,000 字符，放不下的放回去，留给下一次。
  4. 写 additionalContext；stdout 写完以后，把认领的文件 rename 成 `.done`，再往 hook 收件箱写一个 `ButlerMailbox` 信封通知主进程。
- 主进程收到信封、或者定时清扫时，看到 `.done` 文件就把消息记成已送达（via hook），然后删掉文件。`.done` 文件本身就是回执，信封丢了也不要紧。
- 认领以后 hook 崩了（只有 `.taken` 没有 `.done`）：60 秒后主进程把它改回 `.json`，下一次工具调用再送。这种情况可能重复送一次，但不会丢。
- 主进程重建投影时，同一个 id 的 `.json`、`.taken`、`.done` 文件只要有一个就算已经在了，不会把已经送出去、还没记账的消息再写一遍。

### 3.2 session 停着：直接输入

触发时机：排队时、session 停下来时（`sessionStopped`，包括打开、resume 之后停在输入框）、每个调度 tick。

1. 先过现有的 `DeliveryGuard`（终端开着、停着等输入、屏幕上没有对话框、不在「需要你」里、用户没在打字、没有草稿）。回答用的 guard 不看「需要你」，和原来一样。
2. guard 过了，主进程把这个终端目录里的 `.json` 都 rename 成 `.main`。抢不到的说明 hook 正在送，跳过。
3. 剩下的合成一条，用 `pty.deliver` 送进去。
4. 送到了就记成已送达（via input）并删掉文件；没送到就 rename 回 `.json`，等下一次。

guard 不让送时消息就留在排队里。**不会因为对方在忙就拒绝**：在忙的 session 下一次调用工具时 hook 会把消息带进去，停下来时走直接输入。

### 3.3 session 关着

消息只在 DB 里。终端打开（SessionStart）时重建投影：resume 或全新启动后停在输入框，就走 3.2，这是它打开后读到的第一件事。换新（/handoff → /clear → 接着做）期间 guard 当它在忙，换新做完停下来再送。

### 3.4 叫停（interrupt）

只有总控能发：feature 总控的 `send_message`，或者 Butler 总控的 `send_message`，带上 `interrupt: true`。处理方式：

- 目标在忙（`waitingForInput === false`）、屏幕上没有要用户回答的对话框、用户 30 秒内没打字、没有草稿时：`pty.interrupt`（只发一个 Esc，不经过用户输入的那条路），再用 `pty.deliver` 等输入框就绪（最多 60 秒），把这条 interrupt 消息连同其他排队的消息一起送进去。粘贴前再复查一次，用户打过字就不送。
- 有对话框、用户在打字时不打断，按普通消息排队，因为按 Esc 会替用户拒掉权限确认。
- 目标停着：直接送，不发 Esc。

### 3.5 和 ask_user 的「终端里答了」

Butler 直接输入任何信箱消息之后，UserPromptSubmit 都不算用户在终端里回答了未决的提问（原来只对回答有这个保护，汇报送进总控时会误把总控自己的提问当成已回答）。`InboxService` 的 answering 窗口改由信箱的直接输入来设。

## 4. 回复（已回复）

`instruction` 和 `butler` 两种消息等回复。送达时记下目标当时最后一条回复的 id（`base_reply_id`）。之后目标停下来，如果最后一条回复是新的（id 不同，时间不早于送达时间），就记成已回复，同时往发送方的信箱里排一条 `reply`，正文是「【回复】…」（原来 Butler 总控的格式）。这条 reply 也走信箱，发送方在忙就等下一次工具调用。

## 5. 改走信箱的路径（旧代码删掉）

| 来源 | 原来 | 现在 |
|------|------|------|
| report（done/blocked） | `InboxService.flushReports` 等开着的总控停下来再贴 | 找到总控（开着的优先，其次是最近一个没隐藏的总控 session）就排一条 `report`（ref `report:<id>`），送达后把汇报标成 answered。一个总控都没有时，汇报留在待送里，等有了再排；6 小时的过期只对这种还没排进信箱的汇报生效 |
| ask_user 的回答 | `flushAnswers` 等提问的 session 停下来再贴 | 卡片上一答就排一条 `answer`（ref `answer:<id>`），改答案就替换正文；送达后 resolve |
| Butler 总控的 `send_message` | guard 不过就回「送不进去，稍后再试」；`ButlerMessages` 管回复 | 一律排队。终端关着照旧先打开（接着最近的对话）再排队；回复走第 4 节 |
| 预审结果 | `PreReviewService.deliver` 过 guard、失败计次 | 排一条 `review`（ref `prereview:<id>`），送达后写 `deliveredAt` |
| 评论闭环 | `CommentLoop.deliverPr` 过 guard | 排一条 `comments`（ref `comments:<prId>`，meta 里记评论项的 id）；送达后把这些评论项标成 delivered |

CI 结论、合并通知、栈冲突、换新、巡检、熔断后的「接着做」这几条不在这一单的范围里，照旧走 guard。它们要么本来就只在停下来时才有意义，要么有自己的时机。之后如果要并进信箱，接口已经留好了（`enqueue` + `ref`）。

## 6. 新工具：feature 总控的 send_message

- 参数 `session`（list_sessions 里的 id）、`text`（最长 `MESSAGE_LIMIT`）、`interrupt`（可选）。
- 目标只能是这个 feature 的 ticket session 或修复 session，不能是总控自己。
- 返回 `requestId` 和目标当前的状态：在忙（下一次工具调用时送）、停着（马上送）、关着（下次打开时第一件事读）。对方这一轮的回复会以「【回复】」开头自动送回来。
- Butler 总控的 `send_message` 也接受 `interrupt`。
- `list_inbox` 的 `messages` 改成信箱里 Butler 总控发出或收到的最近 30 条，状态只有 queued / delivered / replied 三种。

## 7. 约定广播

- `--settings` 里加一组 PostToolUse hook，matcher 为 `mcp__butler-feature__remember`，命令是不带参数的 `butler-hook`，也就是写信封的那条路。hook 把载荷裁成 `tool_name`、`tool_input.text`、`tool_input.consolidate`。
- 主进程收到信封：作者 session 的 head → 它的 feature（ticket session 看 ticket 的 feature，总控和修复 session 看自己的 `featureId`）。然后给同一个 feature 里终端开着的其他 session 各排一条 `convention`，作者自己不排。正文写明谁（ticket 号或「feature 总控」）、内容是什么。
- `consolidate: true` 存的长对话上下文不是约定，不广播。
- 按 `featureId` 算。4.0 里 W6 把 feature 改叫 epic，内部 key 不变，所以广播就是 epic 范围。

## 8. 界面

- IPC `butler:messages` 换成 `messages:list`，参数 `{ butler: true }` 或 `{ featureId }`，返回 `MessageView[]`：谁发给谁、种类、状态、时间、正文、回复。
- Butler 总控页对话下面折起的「总控发出的消息」改成「消息（N）」，列出 Butler 总控发出和收到的消息。feature 页「总控」tab 的对话下面加同样一块，列出这个 feature 的消息。
- 状态标签：已排队、已送达、已回复，中英两份。
- 刷新：BTL-242 给 `notify` 加了 scope，信箱用 `notify('messages')`。在那之前用普通的 `notify()`。

## 9. 性能

- 信箱为空：每次工具调用多跑一次 `sh -c '[ ! -d … ] || …'`。shell 本来就要启动（任何命令 hook 都一样），多出来的只是一次 `stat`。
- 信箱不空：才启动 butler-hook。
- 主进程：重建投影只在排队、送达、终端开关时做，清扫跟着现有的调度 tick 走。不新开定时器，也不用 fs.watch。
- Windows：Git Bash 启动比 macOS 的 sh 慢。没有 Windows 机器实测，PR 里写 macOS 的数字，同时说明 Windows 上的开销是一次 Git Bash 启动。

## 10. 已知限制

- Butler 的 hook 没装（`hookInstalled()` 为假）时，session 的 `--settings` 里没有 hook，消息只能在 session 停下来时直接输入。
- 外部终端里开的 session（不是 Butler 打开的）没有 `BUTLER_SESSION`，也没有 `--settings`，收不到 hook 送的消息。
- hook 只知道 stdout 写成功了。Claude Code 收下以后没交给模型（版本太旧、客户端的 bug）的情况 Butler 看不到，消息仍记成已送达。
