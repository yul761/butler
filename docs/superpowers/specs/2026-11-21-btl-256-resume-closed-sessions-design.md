# BTL-256：给关着的 session 发消息时在后台恢复它，重启后可选自动恢复

日期：2026-11-21。总设计见 `specs/2026-11-20-shipherd-4-simplify-design.md`，信箱见 `2026-11-20-btl-245-mailbox-design.md`、`2026-11-20-btl-248-release-cleanup-design.md`。

## 问题

Shipherd 重启以后所有 session 的终端都关了。总控 `send_message` 给 BTL-249 回复，结果 `state: closed`，消息一直排在信箱里，直到用户手动点开那个 session 才送到。
信箱以前只会叫醒**休眠**的 session（Hibernator），真关了的什么都不做；总控手里也没有能打开已关闭 session 的工具。

## 决定

### 1. 谁会被自动恢复（`resumable`，`src/main/sessions/resumer.ts`）

Shipherd 开的（`origin = shipherd`），不是 Shipherd 总控，也不是复盘分析 session，并且属于一个 epic 或 ticket：

- ticket 的 session，而且是总控开的（`spawnedBy` 不为空）。用户自己点开的 ticket session 不自动恢复。
- epic 级 session：epic 总控和修复 session（`featureId` 不为空、`ticketKey` 为空）。
  epic 总控本来就由 Shipherd 总控的 `send_message` 接着打开，这里把它也算进来：重启以后 ticket 的 `report(done)` 送到关着的总控时，总控也能被叫起来。

另外要求：没被隐藏（`dismissed`），没被替换（是 head），ticket 和 epic 没归档。

**用户结束**：用户在界面上点 × 时（`pty:kill` IPC）记 `sessions.user_ended_at`；这个 session 任何一次再打开时清掉。
总控 `end_session`、闲置自动关闭、休眠、Shipherd 退出都**不**算用户结束，之后照样能自动恢复。

### 2. 什么时候恢复

信箱已经有入口：`flush` 发现目标没开终端、排着的不只是约定广播时调 `wake(head)`。index.ts 里的 `wake` 原来只叫醒休眠的，现在：

1. 休眠着 → 照旧 `hibernator.wake`；
2. 否则，排着的消息里有**别的 session 发来的**（总控的指示、Shipherd 总控的消息、ticket 的汇报……）→ `resumer.request(head, "mail")`。

`send`、每个调度 tick 的 `flush`、`stopped` 都会走到这里。CI 结论、合并通知这类 Shipherd 自己发的（发送方为空）不叫起真关了的 session，排着等它下次打开：
总控刚 `end_session` 的 session 不会被下一条 CI 通知又拉起来；回执（发送方为 Shipherd）也不会把关着的总控拉起来。约定广播照旧不叫醒任何人。
Shipherd 退出时（`quitState.quitting`、`resumer.stop()`）不再恢复，正在等的也不记失败。
Shipherd 总控打开 epic 总控时用的 `hold` 照旧：那条路自己打开，信箱不再去叫醒一次。

### 3. 恢复流程（`Resumer`）

- **一次只恢复一次**：`request` 按 head 幂等，进行中的再调拿到同一个 promise。同时来几条消息、`send` 和 tick 同时触发，都只开一次。
- **内存准入**：和 `start_session` 一样走 `admitOrRefuse`。不够时消息继续排着，60 秒内不再问内存（tick 每次都调 `wake`，不能每次都读一遍内存）；之后的 tick 再试，内存腾出来就会恢复。
- **对话文件丢了**（`transcriptLocator.state = absent`）：说过话的（`firstPrompt` 不为空）接不上原来的对话，不试，直接算永久失败；
  一句话都没说过的（start_session 刚开就重启了）照常打开，消息就是它的第一句输入。
- **打开**：按种类 `--resume`（和唤醒休眠用同一个 `openHibernated` 的分派：ticket、epic 总控/修复 session），然后等 claude 的 SessionStart（最多 60 秒）。
  claude 起来以后 SessionStart(resume) 照常调 `sessionStopped` → `mailbox.stopped` → `flush`，消息按「停着的 session」的方式送：先看屏幕、等信任框和启动对话框过去、guard 照旧。
- **失败不无限重试**：失败记在 session 的 `wake_error` 上（「现在」页已有的提醒）。永久失败（对话文件丢了、ticket/session 没了、目录不对）之后不再自动试；
  一时的失败（ticket 正忙、找不到 claude、分支不对、抛错、claude 起来之前就退出）10 分钟后再试，一次 Shipherd 运行里最多试 3 次。
  60 秒还没起来但终端开着（比如停在启动对话框上）不算失败：起来以后照常送。起来之前用户点了 × 也不算失败。
  用户或别的路径打开了它就清掉这些记录；这里自己打开时（`sessionService.opened` 也会调到）不清，失败次数接着数。

### 4. 总控看到什么

`send_message` 的返回值多一个 `wake` 字段（只在 `state` 是 `closed` 时有）：

| wake | 意思 |
|---|---|
| `resuming` | 终端关着，Shipherd 正在后台恢复（接着原来的对话），恢复好了送进去 |
| `waiting_memory` | 内存不够，没恢复；消息排着，内存够了 Shipherd 会再试。附 `wakeError`：可用多少、要多少 |
| `ended_by_user` | 用户自己结束了它，Shipherd 不自动恢复；用户打开时送到 |
| `resume_failed` | 之前恢复失败过、暂时不再试；附原因 |
| `not_managed` | 不是总控管的（比如用户自己开的），下次打开时送到 |

`send_message` 会等这次请求过了内存准入、开始打开以后再返回（几百毫秒到两秒），所以 `resuming` 和 `waiting_memory` 是确定的。

**回执**（信箱里 Shipherd 发给总控的一条 `reply`，开头「【回执】」）：只在异步的结果出来时发，只发给排着的 `instruction` / `shipherd` 消息的发送方：

- 恢复成功、消息送到：「已在后台恢复 X 并送到」（带 requestId）。恢复时有总控的消息在等才发，只看恢复以后的第一批送达（那一批里没有总控的消息就不发）。
- 恢复失败：原因，以及「消息还排着，用户打开它时会送到」。每次失败发一次（最多 3 次）。

`waiting_memory`、`ended_by_user` 已经在返回值里，不另发回执。

epic 总控的 `list_sessions` 每行多一个 `wake`：`running`、`hibernated`、`resumes`（关着，有消息时会在后台恢复）、`resuming`、`waiting_memory`、`resume_failed`、`ended_by_user`、`not_managed`。
Shipherd 总控的 `send_message` 打开 epic 总控时也看用户结束：用户点 × 结束的 epic 总控，消息只排队，返回 `wake: ended_by_user`；内存不够时返回 `wake: waiting_memory`（原来就带 `openError`）。

### 5. 重启后自动恢复（设置 `autoResumeAfterRestart`，「通用」，默认关）

- 记录：`sessions.term_open_at`。终端打开时写上；终端在 Shipherd 运行时退出时清掉；Shipherd 退出（`quitState.quitting`）时不清。
  所以下次启动时还带着它的，就是上次退出（或崩溃）时开着终端的 session，也就是在工作或在 `waitingForInput` 的。启动时读一遍，然后全部清掉。
- 设置打开时，在启动完成后（hook 状态确认之后）把这些里面 `resumable` 的、没休眠的、没被用户结束的按优先级恢复：
  1. 有未读信箱消息（排着的、不是约定广播）的；
  2. ticket 有开着的 PR 的；
  3. 其余按最近活动排。
- 一个一个来，每个都走内存准入；第一次内存不够就停下，剩下的保持关着（之后有消息来照样会按第 3 节恢复）。
- 设置关着时只清掉记录，什么都不开。

### 6. 存储

一条追加迁移：`sessions.user_ended_at INTEGER`、`sessions.term_open_at INTEGER`。不加新的消息 kind（回执用 `reply`，发送方为 Shipherd），不用重建 `session_messages`。

### 7. 不做的

- Shipherd 总控（全局那一个）不自动恢复：它是用户的。
- 不改 README（BTL-252 在重写），要进 README 的一句写进 epic 记忆 `[readme:256]`。
- 已知：Shipherd 总控 `send_message` 正在打开关着的 epic 总控时，调度 tick 可能同时叫 `resumer.request` 同一个 head；`resumeOrStart` 保证只开一个终端，
  但两边会各问一次内存，内存刚好卡在线上时其中一边可能报 `waiting_memory`。窗口只有打开的那几百毫秒，先不处理。
