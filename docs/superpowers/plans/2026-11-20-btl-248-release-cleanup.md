# BTL-248 plan：4.0 收尾

设计见 `docs/superpowers/specs/2026-11-20-btl-248-release-cleanup-design.md`。每一步都先写测试再实现（TDD）。

1. **信箱种类和迁移**
   - `MessageKind` 加 `ci, merge, stack, patrol, cost, refresh, user`；
   - 追加迁移，重建 `session_messages`；
   - 加中英标签；
   - 测试：repo 能存新的种类，迁移后旧数据还在。
2. **Mailbox**
   - 加 `held(head)` 依赖：held 的不投影；
   - 全是 `user` 的一批原样输入，hook 投影里的 `user` 消息加前缀；
   - 测试写在 `mailbox.test.ts`。
3. **CiDelivery 改走信箱**
   - 去掉 guard、deliver、busy，换成 `mailbox` 和 `epicOf`；
   - 送达回调 `ci` 里记 delivered，结论变了就撤回；
   - 更新 `ci-delivery.test.ts`。
4. **HoldWatcher 改走信箱**：排队就 `markNotified`，更新测试。
5. **ButlerPatrol 改走信箱**：开着的直接排队；没开的 hold、open、opened。更新测试。
6. **DevSender 改走信箱**
   - `DevSendResult` 加 `state`，去掉 guard 带来的原因；
   - 改 ConversationTab 的提示和中英文字；
   - 更新测试。
7. **SessionRefresher**
   - 「接着做」改由 `queueResume` 排进信箱；
   - 开始和结束时调 `mailboxSync`；
   - 更新测试。
8. **index.ts 装配**
   - cost 的 nudge、栈的 deliver、`toCoordinator` 改走信箱；
   - 删掉 `loopDeliver` 和 `deliveringTo`；
   - guard 只留给 Mailbox 和 refresher。
9. **空 epic**：加 `FeatureService.withJiraEpic` 和 `FeaturesRepo.deleteIfEmpty`，intake 的 createTicket 改用它。测试写在 `feature-service.test.ts`。
10. **briefSentAt**：从类型和 repo 删掉，追加 DROP COLUMN 迁移，更新测试。
11. **一致性扫描**：按扫描结果改中英文字、提示词和工具说明。
12. **收尾**
    - `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`；
    - Opus review；
    - 开 PR。
