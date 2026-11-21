# BTL-247 自动化档位：实现计划

设计：`docs/superpowers/specs/2026-11-20-btl-247-automation-levels-design.md`。每一步先写测试，再写实现。

1. **共享定义** `src/shared/automation.ts`
   - `AUTOMATION_LEVELS`、`AutomationLevel`、`AutomationDisplay`、`isAutomationLevel`。
   - 预设 `AUTOMATION_PRESETS`：设置项、loop / stacks / intake 三族的受管键和值。
   - 纯函数：`automationDisplay(level, current)`（受管值 → manual / semi / custom 和 differs）、`overlayLoop`、`overlayStack`、`overlayIntake`、`externalOverride(level, key)`、`stackLevel(levels[])`。
   - 测试：预设覆盖了 W7 清单；manual 预设等于默认值；显示规则；栈的规则。
2. **设置**
   - `automationLevel` 加进 `EDITABLE_SETTINGS` 末尾，默认 `manual`，`normalizeSetting` 只认两个值；布局里放进 `features` tab。
   - `settings-handlers`：`automationLevel` 写之后调 `applyAutomationLevel`。
   - 测试：默认值测试、非法值拒绝、写档位会写预设。
3. **主进程** `src/main/automation/levels.ts`
   - `AutomationLevels`：读全局、epic、ticket 的档位；`apply(level)` 写预设（设置 + 三族全局层）；`state()` 读当前受管值（含产品 / 仓库覆盖）算显示。
   - 测试用内存数据库和假的策略服务。
4. **epic 档位存储**
   - 迁移：`ALTER TABLE features ADD COLUMN automation_level TEXT`。
   - `FeaturesRepo` 读写；`Feature.automationLevel`。
   - IPC `features:setAutomationLevel`（校验）、`automation:state`（读白名单）。
5. **接到各个行为上**（index.ts 装配）
   - `loopPolicyFor(slug, ticketKey)`，`CommentLoop` / `CiTriage` / 评估里按 PR 的 ticket 调。
   - `ExternalActions.layered`。
   - `preReviewActive(ticketKey?)`：预审服务、评估、session 说明。
   - 栈：`StackService` 的策略按栈的各层 ticket 盖；自动检测看半自动 epic。
   - 测试：各服务的单测里加按 ticket 的用例。
6. **界面**
   - 设置 › 自动化：档位单选（全自动禁用、自定义只显示）+ 默认收起的「高级」里放原来的单项开关。
   - epic 页标题旁的下拉。
   - 中英文案；渲染测试。
7. **设置页收尾**：handoff 用词、分组名、向导文案；文档、README 两份。
8. **e2e**：默认是手动；选半自动以后功能行跟着打开；动一个开关显示自定义；epic 下拉能存。
