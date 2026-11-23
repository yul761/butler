# BTL-244 界面减法：实现计划

设计：`docs/superpowers/specs/2026-11-20-btl-244-ui-subtraction-design.md`。每一步先写测试，再写实现。

1. **设置 `showOutsideSessions`**
   - `src/shared/settings.ts`：把它加进 `EDITABLE_SETTINGS` 末尾。
   - `settings-repo.ts`：默认值 `"0"`。
   - `settings-layout.ts`：放进 basic 组。
   - 测试：默认值，以及 3.0 默认值测试里加上这一项。
2. **主进程开关**
   - `discovery.ts` 外面加一个小纯函数 `discoveryEnabled(settings)`，放在 `src/main/sessions/outside-sessions.ts`，并写测试。
   - `index.ts`：`runDiscovery` 和 `scheduleDiscovery` 先看这个开关。
   - `settingChanged` 里：打开时跑一次发现。
   - `sessionService.unclaimed()` 关着时返回 `[]`，并写测试。
3. **界面开关**
   - `BasicSettings` 加一个 checkbox。
   - `AllWorkPage` 读设置，关着时不显示入口。
   - `UnclaimedPage` 关着时只说一句。
   - 文案中英两份；渲染测试。
4. **「状态」**
   - 文案：tabSummary 改成「状态」，handoff 的相关说法改成「状态」。
   - `TicketHome` 加「状态」一节：取最新 handoff，带「更新状态」按钮。
   - `TicketLogTab` 改叫「状态记录」，去掉按钮。
   - 渲染测试。
5. **折叠**
   - `TicketPrBody` 的「阶段」改成默认收起。
   - `TicketHome` 的 PR 阶段和上下文两行收进「细节」。
   - 渲染测试。
6. **复盘规矩页**
   - `lessons-view.ts`：加 `allPending(s)` 和 `scopeLabel(l, s)`，并写测试。
   - `LessonsPage`：默认的待确认列表加「高级」折叠。
   - `shipherd-self-render` 测试相应调整。
7. **e2e**
   - `fixtures.ts` 加 `openLessonsAdvanced`，各个 lessons、checks、baselines、config-io、backtest spec 调用它。
   - `home.spec` 改成默认没有未认领入口。
   - 新加一个 spec：默认视图下确认或驳回规矩，以及 ticket 概况里的「状态」。
8. **文档**：`README` 两份、`docs/configuration` 两份。
9. **本地检查**：`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`；Opus 子代理 review；开 PR。
