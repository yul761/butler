# BTL-255：新 ticket 的分支从远端默认分支开（design addendum）

日期：2026-11-21。类型：bug。

## 现象

共享 checkout 停在一个旧的 feature 分支上、本地 `main` 也落后时，`create_ticket` 建出来的 worktree 开在共享 checkout 的 HEAD 上，不在 `origin/main` 上。原因：`TicketService.prepareRepo` 没有起点时，`git worktree add -b <branch> <path>` / `git branch <branch>` 都不带 start，git 就用当前 HEAD。

## 所有入口

新建 ticket 分支的入口都走 `TicketService.prepareRepo`：

| 入口 | 调用 | 起点 |
|---|---|---|
| `create_ticket` MCP（epic 总控、全局总控） | `control-handler` → `TicketService.create` | 没有 `stack_on` 时没给；有 `stack_on` 时是下层 ticket 的分支 |
| 界面新建 ticket | IPC `tickets:create` → `create` | 没给 |
| Jira 导入、自动接活 | `intake` → `index.ts` 里的 `createTicket` → `create` | 没给；Jira 里的阻塞关系接成栈时是被阻塞的那个分支 |
| 给 ticket 加仓库 | IPC `tickets:addRepo` → `addRepo` | 没给 |

另外有两处也会从 HEAD 新建分支：

- `ensureWorktree`：合并后被清理的 worktree 要重建，分支已经不在了。
- `moveWork`：改分支名，旧分支也不在了。

## 决定

1. 新函数 `newBranchBase(repo)`（`src/main/tickets/git.ts`）。只在要**新建**分支、调用方又没给起点时调用；分支已存在就不联网。
   - 有 `origin`：先在本地看默认分支叫什么：`origin/HEAD` 指向的、而且那个 ref 还在（远端改名后 `fetch.prune` 会留下悬空的 `origin/HEAD`），否则 `origin/main`、`origin/master`。本地看不出来（单分支或浅克隆）就 `git ls-remote --symref origin HEAD` 问远端。然后用明确的 refspec 只 fetch 这一个分支（`+refs/heads/<name>:refs/remotes/origin/<name>`，`--no-tags`，20 秒为限，不弹凭据提示），不受自定义的 `remote.origin.fetch` 限制。起点是 `origin/<name>`。
   - fetch 失败或超时：照样用本地的 `origin/<name>`，日志里写明「fetch 失败，用本地的 origin/<name>，可能不是最新」。
   - 没有 `origin`，或远端上找不到默认分支：用本地默认分支（`init.defaultBranch`、`main`、`master` 中第一个存在的）。都没有才用 HEAD，并写日志。
   - 不读共享 checkout 停在哪个分支，也不改它的工作区和 HEAD。fetch 只更新 `refs/remotes/origin/*`。
2. **仓库设置里的 trunk**：Shipherd 现在没有按仓库设的 trunk。栈的 `trunkOf` 和这里用的是同一套顺序（`origin/HEAD` → main / master），所以不另加设置。
3. 只认 `origin`，和 `defaultBranch`、`upstreamRef`、`firstCommitAt` 一致。
4. 从远端分支开的新分支加 `--no-track`：不然 git 会把上游设成 `origin/main`，session 里 `git push` 会推错地方或者被 `push.default=simple` 拒绝。以前从本地 HEAD 开也不设上游，行为不变。
5. `stack_on` 和 intake 接栈给了起点，原样使用，不 fetch。改名时旧分支还在，仍从旧分支开。
6. 同一个仓库接连或同时建好几个 ticket（总控一次建 5 个，control inbox 是一个一个处理的）：同一个仓库正在算的、或 60 秒内算好的起点直接用，只 fetch 一次。并发 fetch 不会抢 ref 锁，离线时也不用每个 ticket 都等一次 20 秒的超时。
7. 基线导出（`exporter.ts`）已经有自己的一份「从远端默认分支开」，这次不动它。
8. 已知的限制：
   - ssh 远端要密码短语或确认主机指纹时，`GIT_TERMINAL_PROMPT=0` 拦不住。Shipherd 是 GUI 启动的，没有终端，ssh 会直接失败。
   - 给已有 ticket 加仓库时，fetch 在这个 ticket 的锁里做，最多 20 秒内不能打开它的 session。

## 测试

- `git.test.ts`：`newBranchBase` 在 fetch 之后拿到远端的新提交；fetch 失败时退回本地的 `origin/main` 并写日志；单分支克隆、自定义 fetch refspec 时问远端；悬空的 `origin/HEAD` 跳过；没有远端时用本地 `main`，哪怕 checkout 停在别的分支。
- `ticket-service.test.ts` 复现：共享 checkout 停在旧分支、本地 `main` 落后 `origin/main`，新 ticket 的 worktree 开在 `origin/main` 上，没有上游；共享 checkout 的分支和 HEAD 不变。分支模式、后加的仓库同样。给了起点（stack_on）时照用起点。离线时接连建两个只等一次 fetch。改分支名而旧分支已经没了时，从 `origin/main` 开。
- 全部用真的 git 仓库和本地 bare 远端，Windows 和 macOS 都跑。

## 文档

`docs/configuration.md` 和 `.zh-CN.md` 的「分支名模板」一行补一句新分支从哪里开。README 那句由 BTL-252 收（epic 记忆 `[readme:255]`）。
