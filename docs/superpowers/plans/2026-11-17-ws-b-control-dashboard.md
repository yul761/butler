# Workstream B 实施计划

设计：`docs/superpowers/specs/2026-11-17-ws-b-control-dashboard-design.md`。每一步先写测试。

1. **PR 字段**
   - `gh.ts`：`PR_FIELDS` 加 `baseRefName,title,labels,reviewRequests,mergeable,mergeStateStatus`；`PrStatus` 加对应字段；`latestReviewers(reviews, author)`。
   - migration：`ticket_prs` 加列；`feature_handoffs.pr_status_at`；`shipherd_messages`；`external_action_audit`。
   - `ticket-prs-repo.ts`：新列读写。`pr-watcher.ts` `apply()` 写新列、算 `status_changed_at`；`statusOf` 带出。
   - `src/shared/types.ts` `WatchedPr` 加字段。
2. **卡在谁 / 进度聚合**
   - `src/shared/progress.ts`：类型、`waitingOnOf`、`titlePrefix`。
   - `src/main/progress/progress-view.ts`：`buildProgress`。
3. **控制操作**
   - `src/shared/control.ts`：`refresh_feature_summary`、`progress_overview` 两个 op。
   - `shipherd-control.ts`：`list_prs` 新字段；`send_message` 返回 `requestId`；两个新 op。
   - `sessions-server.ts`：工具定义（中英）、`shipherdRequest` 分支。
4. **回复回流**
   - `activity-parse.ts` / `activity-monitor.ts`：`lastReplyAt`。
   - `src/main/db/shipherd-messages-repo.ts`、`src/main/control/shipherd-messages.ts`（`ShipherdMessages`）。
   - `index.ts`：`sessionStopped` 里调 `targetStopped`，tick 里 `flush`；`list_inbox` 带 `messages`；Shipherd 页的"回复"tab。
5. **汇总新鲜度**
   - `feature-runner.ts`：`hasNewActivity` 第三条；prompt 用实时 PR；`pr_status_at`。
   - `feature-templates.ts`：PR 行带实时状态和"截至"。
   - `list_features` / feature 页：`prStatusAt`、`stale`。
6. **进度页**
   - IPC `progress:get`；`ProgressPage.tsx`；Sidebar 入口；`Route` 加 `progress`。
   - feature / epic 的「PR 进度」tab 上方加"卡在谁手上"。
7. **对外动作**
   - `src/main/external/actions.ts`；`audit-repo.ts` 加 `ExternalActionAuditRepo`；设置十个开关；`ExternalActionsSettings.tsx`；审计页一块。
   - `docs/configuration.md` / `.zh-CN.md`。
8. 中英文字符串；`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`；Opus 独立 review；PR。
