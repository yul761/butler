# BTL-244 界面减法（Shipherd 4.0 W4）设计补充

日期：2026-11-20。上位设计：Shipherd 4.0「做减法、收概念」的 W4。这里只写实现时自己定的事。

## 1. 未认领 session

- 新设置 `showOutsideSessions`（「显示 Shipherd 之外开的 session」），默认 `"0"`，放在 **设置 → 基本**。
- 关着时：
  - 主进程的 `runDiscovery()`（启动时一次、每 5 分钟一次、hook 触发的补全）直接返回，**不读 `~/.claude/projects`**。
  - `sessionService.unclaimed()` 返回空数组。
  - 「全部工作」上的「未认领 session」入口不出；直接进那一页（旧的路由）时，只说一句「已关闭，可以在设置 → 基本里打开」。
- 打开时：`settingChanged` 马上跑一次发现，之后照旧。
- 不受影响：Shipherd 自己的 session 照常用 `findTranscript` / `transcriptState`（这两个函数归 BTL-242 做缓存）。hook 事件照常记行。Shipherd 外开的 session 的事件也照常记进数据库，只是不显示。
- 以前 `gitBranch` 只靠扫描补，所有 Shipherd 自己的 session 都是（CI 结论按分支挑接收者、PR 阶段事件、度量都用它）。扫描默认关以后，改成 hook 事件到来时对 Shipherd 自己的 session（`origin = shipherd`）在它的目录里跑一次 `git rev-parse --abbrev-ref HEAD` 补上（`fillBranchFromCwd`，每个 session 每次运行最多一次；游离 HEAD 和不是仓库的目录不记）。补 `firstPrompt` 本来就走 `UserPromptSubmit` 的 hook，删空 session 前也会先确认 transcript 不存在，所以不会误删。
- 关着时 hook 也不再往等待扫描的集合里加 session。
- 和 BTL-242 的约定：BTL-244 不改 `discovery.ts`，也不改 `App.tsx` 的 `state:changed` 重取那一块。「全部工作」入口是否显示，由 `AllWorkPage` 自己读设置决定。

## 2. 「状态」

- epic / feature 页：「AI 总结」页签改名「状态」（中英：「状态」/ "Status"）。页签 id 仍是 `summary`，所以记住的页签不受影响。相关文案里的「汇总」改说「状态」。
- ticket 页：
  - 「概况」页签里加一节「状态」，显示最新一份 handoff：时间、来源、完成、下一步、阻塞、待确认，带一个「更新状态」按钮（就是原来的「立即 handoff」）。
  - 「记录」页签里原来的「交接记录」改叫「状态记录」，列出全部历史，不再放按钮。
  - 界面文案里 handoff 作为概念的说法，都改成「状态」。涉及：ticket 页、记忆面板、换新、清理闲置、对话 tab 里的换新分隔线。
  - `/handoff` 命令照旧，文案里提到命令本身时仍写 `/handoff`。
  - 设置页「定时与 handoff」分组的文案这次不动：BTL-243 在改设置页，BTL-247 会重排设置，到时一起改。
- 晚间任务、每日巡检的行为不变。效果页不动。

## 3. 折叠

- 实况（Live）、用量一行：已经在首页「运行情况」折叠里，默认收起。不动。
- PR 的 6 步阶段：
  - ticket 页「PR 详情」里的「阶段」一节，改成默认收起的折叠。按 ticket 记住开合，key 是 `ticket-pr-stages:<key>`。
  - 「概况」的「这个 ticket」里，「PR 阶段 x/6」和「上下文 token」两行收进一个默认收起的「细节」折叠，按 ticket 记住开合。分支和 PR 号仍然直接显示。
- 用的是现有的 `useCollapsed`：它的 key 存在 localStorage 里，读写都包了 try/catch。

## 4. 复盘规矩页

- 默认视图：标题、一句说明，然后是**待确认列表**。列表跨所有仓库和产品，每条显示它属于哪个仓库或产品、为什么、来源。每条有三个按钮：确认、编辑（编辑后确认）、驳回，走的仍然是原来的 `lessonsAct`。
  - testid 用 `pending-lesson-*`，和「高级」里按仓库列的 `lesson-*` 不冲突。
- 「高级」：一个默认收起的折叠，key 是 `lessons:advanced`。原来的整页都原样搬进去：页签、队列条、仓库和产品树、新建产品、批量条、详情（按范围的待确认和已确认、合并、停用、做成检查），以及向导、校准、检查、基线、批次、导入导出。
- 原来顶上的「有 N 条待确认 · 逐条看」提示卡去掉，因为默认视图本身就是这张列表。导出提醒留着，点了展开「高级」并切到导入导出页签。
- 带着 `tab: "checks"` 进来（从别处跳到检查）时，自动展开「高级」。
- 行为不改：数据、操作、批次和撤销都和原来一样。

## 5. 测试

- 单元测试：`showOutsideSessions` 默认是 `"0"`，并且登记了位置；`unclaimed()` 关着时返回 `[]`；发现逻辑的开关判断；待确认列表的选取和范围标签；各个折叠的渲染（默认收起）。
- e2e：
  - 「全部工作」默认没有「未认领」入口；
  - 复盘规矩相关的 spec 先展开「高级」（fixtures 里加一个 helper）；
  - 默认视图里能确认、驳回；
  - ticket 概况能看到「状态」。
