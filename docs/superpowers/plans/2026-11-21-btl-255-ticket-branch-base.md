# BTL-255 plan：新 ticket 的分支从远端默认分支开

设计见 `docs/superpowers/specs/2026-11-21-btl-255-ticket-branch-base-design.md`。每一步先写测试再实现。

1. **`newBranchBase`**（`src/main/tickets/git.ts`）
   - 测试：fetch 后拿到远端新提交；fetch 失败退回本地 `origin/main` 并写日志；没有远端用本地 `main`。
   - 实现：按设计第 1 条。
2. **起点带 `--no-track`**：`addWorktree`、`createBranch`、`switchTo` 有起点时加 `--no-track`。
3. **TicketService 用上它**
   - 测试（复现）：共享 checkout 停在旧分支、本地 `main` 落后，worktree 和分支模式的新分支都开在 `origin/main`，没有上游，共享 checkout 不变；给了起点时照用。
   - 实现：`prepareRepo`、`ensureWorktree`、`moveWork` 在新建分支且没起点时调 `baseFor(root)`；同一仓库并发共用一次；`TicketServiceDeps.log` 可选，`index.ts` 传 `logger`。
4. **文档**：两份 `docs/configuration.md` 的「分支名模板」。README 的一句写进 epic 记忆 `[readme:255]`。
5. 本地检查：`pnpm typecheck && pnpm lint && pnpm test`。
