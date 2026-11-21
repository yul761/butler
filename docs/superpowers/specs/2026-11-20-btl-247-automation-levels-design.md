# BTL-247 自动化档位（Butler 4.0 W7）设计补充

日期：2026-11-20。上位设计：Butler 4.0「做减法、收概念」的 W7。这里只写实现时自己定的事。

## 1. 用户看到的模型

- **全局档位**：设置 › 「自动化」（原来的「功能」tab，tab id 还是 `features`，旧链接照常落到这里）。三个选项：
  - 手动（默认）；
  - 半自动；
  - 全自动（以后）：显示，但不能选。
  - 第四种状态「自定义」只是显示出来的，不能选：全局档位管的那些开关里，有一个和当前档位的预设不一样，就显示「自定义」。
- **epic 档位**：epic 页（代码里仍是 `FeaturePage`）标题右侧的下拉：跟随全局（并写出全局现在是什么）/ 手动 / 半自动 / 全自动（以后，不能选）。
- 原来「功能」页上的一行行单项开关，原样收进同一页下面的「高级」折叠，默认收起。三层策略（全局 / 产品 / 仓库）的编辑本来就在设置 › 「高级」tab 的各个分组里，默认收起，行为不变；「自动化」页上写一句话指过去。

## 2. 档位管哪些开关（「受管开关」）

| 行为 | 开关 | 手动（= 默认值） | 半自动 |
|------|------|------------------|--------|
| 评论送回 session | 循环策略 `comments.enabled` | 关 | 开 |
| 不在 GitHub 上回复、不 resolve | `comments.reply`、`comments.resolve`；`externalCommentReply`、`externalCommentResolve` | 默认（策略开、对外关） | 策略关、对外关 |
| CI 失败分类 | `ci.enabled` | 关 | 开 |
| 偶发失败重跑一次 | `ci.maxReruns`；`externalCiRerun` | 2；关 | 1；开 |
| 栈自动 rebase | 栈策略 `autoRebase` | 关 | 开 |
| 栈的推送、强推、开 PR | `externalBranchPush`、`externalForcePush`、`externalPrOpen` | 关 | 开 |
| 预审 | `preReviewEnabled` | 关 | 开 |
| 自动接活自动开工 | 接活策略 `enabled`（`autoStart` 默认就是开） | 关 | 开 |

- 合并不在里面：Butler 没有替你合并的动作，两档都一样。
- 「用户动过任何一个就显示自定义」只看受管开关。休眠、路由切换、内存缓解、共享 MCP、规矩自动准入、少打断这几行和档位无关，动它们不会变成「自定义」；它们照样收进「高级」。
- 自动接活要配了来源才会动；半自动档下没配来源，「自动化」页提示一句去配。

## 3. 存在哪里、怎么生效

- **全局档位** = 设置 `automationLevel`（`manual` | `semi`，默认 `manual`）。选一个档位时主进程把受管开关**写成那一档的预设**：设置项直接写；三族策略只改全局那一层的受管键（`manual` 是把这些键的覆盖删掉，回到默认值），同层别的覆盖不动；预设里的设置照常触发 `settingChanged`（预审重算、接活马上拉一次）。之后运行时完全走原来的开关和三层策略，没有新的判断。
  - 所以手动档 = 现在的默认；老用户什么都不动，看到的和以前一样。原来开过受管开关的老用户会看到「自定义」，开关不变。
  - 「自定义」的判断：受管键的全局值不等于存的档位的预设，或者产品 / 仓库层有受管键的覆盖且值和预设不同。
  - `settings:set("automationLevel", …)` 也走同一条路（配置导入、设置重置都一样）。
- **epic 档位** 存在 `features.automation_level`（`NULL` = 跟随全局，`manual` | `semi`），迁移追加在最后。内部表名仍是 `features`（和 BTL-246 对齐：用户看到的叫 epic）。
  - epic 设了档位时，它的 ticket 的受管行为**按那一档的预设，盖过**全局、产品、仓库三层的值（epic 选「手动」就是这个 epic 里都不自动做，哪怕全局是半自动或自定义）。没设就完全按全局。
  - 没有 epic 的 ticket 按全局。
- 覆盖在主进程一个地方算：`src/main/automation/`。
  - `levelForFeature(id | null)`：epic 设了就是它，否则全局；`null` 返回全局。
  - `overrideForFeature(id | null)`：只有 epic 自己设了才返回档位，否则 `null`（还没建的 epic 传 `null`）。
  - `levelForTicket(key)`。
  - `overrideForTicket(key)`：只有 epic 自己设了才返回档位，否则 `null`。
  - 循环策略：`loopPolicyFor(slug, ticketKey)` 在原来的三层结果上盖 epic 的预设。评论闭环、CI 分类都按 PR 的 ticket 调。
  - 对外动作：注入 `ExternalActions` 的 `layered(key, scope)`：scope 里的 ticket 有 epic 档位、key 是受管的对外开关时返回预设值。动作照样一条条记进审计（`attempt` 不变）。
  - 预审：`preReviewActive(ticketKey?)`：有 ticket 时按 epic 覆盖，没有按全局。预审排队、交证据、就绪条件、session 说明里的预审一段都按 ticket 调。
  - 栈：一个栈跨几层、几个 ticket。规则：任何一层的 ticket 所在 epic 选了「手动」→ 按手动；每一层都在选了「半自动」的 epic 里 → 按半自动；其他情况按仓库原来的策略。自动检测栈：仓库的策略开着，或者有选了「半自动」的 epic 的 ticket 在这个仓库里，就检测。
  - 自动接活（接 BTL-246 §7 的手动 / 半自动）：Jira ticket 的父 epic 在 Butler 里已经有、而且自己设了档位时，按 `features.byJiraEpic` 找到它，用 `overrideForFeature` 盖接活策略（`overlayIntake`），只盖开不开工，接活本身开没开（`enabled`、来源、拉取）仍按三层，一个 epic 不能替全局把接活打开：半自动 = 自动开工，预审按半自动；手动 = 不开工，要澄清时只提醒、不自动开 session，仓库接活开着时照样建进 epic 整理（不用手动档的预设，否则连整理都不做）。排着的项开工前再看一次，epic 改成手动就回到搁着；改 epic 档位后搁着的项马上重新决定，这回放行的和新拉进来的一样告诉 epic 总控。父 epic 还没建、跟随全局、没有父 epic 的按接活策略原来的三层（也就是全局档位写下的开关）。
  - 非 ticket 的 session（总控）的说明只看全局。
- 档位不是新的权限：半自动只是替你打开这些开关。所有对外动作仍然经 `ExternalActions.attempt`，开关、审计都和手动打开一样。

## 4. IPC

- `automation:state`（读；BTL-242 的读白名单合进来以后加进去）：`{ level, display: "manual" | "semi" | "custom", differs: string[], intakeSourceSet: boolean }`，`differs` 是和预设不同的受管开关（给「自定义」旁边的说明用）。
- 全局档位写走现有的 `settings:set`。
- `features:setAutomationLevel`（写）：`{ featureId, level: "manual" | "semi" | null }`。
- `Feature` 加 `automationLevel: "manual" | "semi" | null`。

## 5. 设置页收尾

- 「定时与 handoff」分组改叫「定时与状态」/ "Schedule & status"。里面的文案不把 handoff 当概念说：晚间 handoff → 晚间状态更新；handoff prompt 模板 → 状态更新的提示词模板；后台 handoff → 后台的状态更新。`/handoff` 是命令名，提到命令时照旧写。
- 基本页和 Session 与内存里的帮助文字：记忆开关、换新、空闲关闭、内存换新里的「写 handoff」都改成「先把进度存好」这类说法。
- 首次运行向导里「3.0 的各个功能在 设置 › 功能 里」改成「设置 › 自动化」；「生成 handoff」改成「更新状态」。
- BTL-243 已删的隐私、个人 API 几节：查过，设置页、文案、文档里都没有残留。
- 文档：`docs/configuration*.md` 加「自动化档位」一节，「Schedule and handoffs」一节改名；README 两份提到「设置 › 功能」的地方改成「设置 › 自动化」，并加一段档位说明。
