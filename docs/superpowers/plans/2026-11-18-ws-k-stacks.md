# 工作流 K 实现计划：栈式 PR、整栈自动 rebase 与 draft 管理

设计：`docs/superpowers/specs/2026-11-17-ws-k-stacks-design.md`。每个任务先写测试再实现；每个任务结束跑相关单测，最后跑 `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`。

## Task 1：策略和类型
- `src/shared/stacks.ts`：`STACK_POLICY_DEFAULTS`、`STACK_POLICY_KEYS`、`parseStackOverrides` / `sanitizeStackOverrides`、`StackPolicyError`；`StackLayerState`、`StackView`、`StackLayerView`、`StackRunView`、`StacksView`、`StackPolicyView`。
- 测试：默认值全关 / 默认、每个键的合法与非法值、未知键。

## Task 2：迁移和仓库
- `migrations.ts` 追加 `stacks`、`stack_layers`、`stack_runs`、`stack_policies`。
- `src/main/db/stacks-repo.ts`：建栈、替换层、加层、按分支 / PR 找层、更新层、记 run（含连续推迟合并）、列出。
- `src/main/stacks/stack-policy.ts`：`StackPolicyService`（LayeredResolver，`forRepo`、`forPath`、`setLayer`、`view`、`layers`）。
- 测试：repo 的增删改、UNIQUE、策略三层合并。

## Task 3：git 底层
- `src/main/stacks/git-stack.ts`：带环境和超时的 git 调用、版本检测、rev-parse / is-ancestor / merge-base、worktree list（分支 → 目录）、未合并文件、update-ref CAS、reset --keep、push --force-with-lease、rev-list 计数、tree 比较、提交标题列表、remote 名。
- `src/main/stacks/seq-editor.ts`：生成 sequence editor 脚本（过滤 update-ref 行）。
- 测试：真 git 临时仓库。

## Task 4：rebase 引擎
- `src/main/stacks/rebase-engine.ts`：起点选择、分段、临时 worktree、`update_refs` 和 `per_layer` 两种模式、rerere 自动继续、冲突定位、autosquash + tree 核对、清理。
- 测试（真 git，bare origin）：4 层栈 squash / merge commit 两种栈底合并；main 更新；中间层新提交；链断开分段；冲突时真分支不动、能定位层和文件；rerere 记过的冲突自动解；autosquash tree 不变 / 变了回滚；两种模式都跑。

## Task 5：应用和推送
- `src/main/stacks/apply.ts`：预检（检出位置、管理的 worktree、干净、HEAD、session 忙、远端有外来提交）、备份引用、CAS 更新、回滚、推送（force_push 经 attempt）、恢复备份、清理过期备份。
- 测试：未检出 / 检出在 ticket worktree / 检出在不归 Butler 的目录；中途失败回滚、备份还在；开关关着记 skipped、`remote_ok_sha` 下次认得；远端有外来提交不推；恢复。

## Task 6：gh 和 PR 文本
- `src/main/stacks/gh-stack.ts`：pr create（ready / draft、label）、pr edit（base / title / body / label）、pr ready、pr close、label create、issue create / edit。
- `src/main/stacks/pr-text.ts`：draft 标题和第一行、去前缀、栈底描述（简报注入点）、总览正文，中英。
- 测试：参数、文本。

## Task 7：栈服务
- `src/main/stacks/stack-service.ts`：define / 从 ticket 接层 / 检测；触发（tick、fetch 节流、onMerged、sessionStopped、daily、manual）；run 锁；推迟条件（awaitingCheck、占位、策略）；合并方式检测；提升新栈底；draft 开 / 降级；draft 编号同步；冲突送达和提醒；总览 issue；`commentNote`；视图；度量事件。
- `src/main/stacks/notices.ts`：`stack` 提醒。
- 测试：验收场景（4 层栈 squash / merge commit，栈底合并后上 3 层自动 rebase、新栈底开 ready PR、不需要人）；每日 rebase；开关默认关时什么都不推、不开；每个策略键的效果。

## Task 8：config-io、设置、度量、jobs
- `src/main/config-io/stacks-section.ts` 注册；`backup-job.test.ts` 的 id 列表。
- `METRIC_KINDS` 加 stack.*；`JobsRepo` 加 `JOB_STACKS_DAILY`。
- 测试：导出 / diff / apply。

## Task 9：IPC、MCP、session 说明
- IPC：`stacks:list`、`stacks:rebase`、`stacks:layerMode`、`stacks:restore`、`stacks:remove`、`stacks:policyGet`、`stacks:policySet`、`stacks:policyLayers`；validate；interventions 归类。
- MCP：`create_ticket.stack_on`；`stack_define`、`list_stacks`、`stack_rebase`、`stack_layer_mode`（feature 总控、Butler 总控；epic 只有 `list_stacks`）；`control.ts` 解析；handler；`SESSIONS_AUTO_ALLOW` 加 `list_stacks`；`session-guide.ts`。
- 测试：解析、handler、guide。

## Task 10：界面和装配
- 进度页「栈」区块、设置「栈」标签页、「现在」页提醒文案和动作；中英文案。
- `index.ts`：StackService 装配（onMerged、sessionStopped、checkSchedule、notices、IPC、control）；I 的 `stackNote` / `awaitingCheck` 按可选接。
- docs：`configuration.md` 和 `.zh-CN.md` 的「栈」一节；外部动作说明。

## Task 11：e2e
- fake gh 支持 `pr create`（按 head 返回 URL）、`pr edit`、`pr ready`、`pr close`、`label create`、`issue create/edit`。
- `e2e/stacks.spec.ts`：真 git + 本地 bare 远端（`branch.main.remote`），两层栈，开 autoRebase 和开关，栈底 PR 合并（squash）→ 整栈 rebase → 远端分支在新 main 上 → `gh pr create --base main --head <第二层>`；进度页栈区块显示。

## Task 12：收尾
- 全部检查、Opus review、处理、report、按 common.md 第 8 条合并。
