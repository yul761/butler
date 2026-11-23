# Workstream G 实现计划：预审、证据、就绪度、风险、简报、review 效果

设计：`docs/superpowers/specs/2026-11-17-ws-g-prereview-readiness-design.md`（下面的「§」指它的节）。每个任务先写测试（TDD），任务结束跑 `pnpm typecheck && pnpm test -- <相关文件>`；碰 UI / IPC / session 的任务结束跑 `pnpm e2e`。

## T1 数据层
- `src/main/db/migrations.ts` 追加一条：`pre_reviews`、`pr_evidence`、`pr_readiness`、`pr_risk`、`pr_briefs`、`pr_policies`、`review_effect_prs`、`review_effect_comments`（§2）。
- `src/main/db/prereview-repo.ts`（预审 + 证据）、`assess-repo.ts`（就绪、风险、简报）、`review-effect-repo.ts`。各自的 `.test.ts`：插入、按 `(slug, branch, sha)` 取最新、补 `pr_id`、级联删除。
- `src/shared/prereview.ts`：类型（`PreReviewRow`、`EvidenceItem`、`Violation`、`ReadinessCondition`、`RiskReason`、`PrAssessmentView`…）和 zod 校验（`submit_evidence` 的参数）。

## T2 策略（§6）
- `src/shared/pr-policy.ts`：键、默认值、`parsePrOverrides` / `sanitizePrOverrides`；列表键的追加语义（`replace`）。
- `src/main/assess/policies.ts`：`PrPolicies`（照 `loop/policies.ts`）。R1 迁移路径只能追加、「低风险要测试证据」不能关。
- config-io 区块 `prPolicies`。单测：三层合并、追加 / 替换、迁移路径不可删、导出导入往返。

## T3 diff 与规矩筛选（§0、§4.3）
- `src/main/prereview/diff.ts`：`prDiff(cwd, sha, base)` → `{ files: {path, added, deleted, binary}[], patches: Map }`，`-z` 解析；worktree 不可用时 `compareFiles` 兜底。单测用临时 git 仓库（`git init`，两个提交）。
- `src/main/prereview/lessons.ts`：`relevantLessons(repo, slugs, files)`（`inScope`、`scopeLang` 按扩展名、去掉 `converted`、上限 300）。

## T4 风险和就绪（§5、§7）
- `src/main/assess/risk.ts`：`computeRisk`，`RISK_RULES_VERSION = 1`；每条规则一个单测，外加验收 2、4。
- `src/main/assess/readiness.ts`：六个条件；`description` 的关键词判断；`off` / `unknown` 的处理。单测覆盖每个开关。
- `src/main/assess/ticket-type.ts`：label → 分支前缀 → unknown。

## T5 证据（§3）
- `src/main/prereview/evidence.ts`：`requiredEvidence(profile, files, policy)`、`evidenceStatus(items, required)`（有效 / 缺失 / 不实）。
- `src/main/prereview/rerun.ts`：按档案选命令（`all` / `fast` / `off`），worktree 干净且 HEAD = sha 才跑，跑完再核对；复用 hook 的 `runCommand` / `killTree`（必要时把它们挪到 `src/shared` 或 `src/main/util`，hook 侧改成 import）。单测用假 runner。

## T6 模型调用（§3.4、§4.4、§8.1）
- `src/main/prereview/model.ts`：`preReviewByModel`（`pre_review`，Read/Grep/Glob，zod 输出，丢掉不认识的 lesson id 和不在改动里的文件）、`verifyEvidenceByModel`（`evidence_verify`，不给工具）、`briefSummaryByModel`（`pr_brief`）。提示词中英两份放 `src/main/strings.ts`。
- `src/shared/model-routing.ts`：`pre_review`、`evidence_verify` 加 `reviewer: true`；`src/shared/background.ts`：`pre_review` 改 high、`idleEligible: false`。
- 单测用假 `HeadlessExecDeps`。

## T7 预审 runner 和递送（§4）
- `src/main/prereview/runner.ts`：后台处理函数（检查点、可打断）；写 `pre_reviews`、证据核实结果；调用 T4 和 T8；递送（`deliveryGuard` + `deliver`，未送到的在 `roundDone` 重试，24 小时为止）。
- `src/main/prereview/service.ts`：`PreReviewService`：`submitEvidence(sessionId, args)`、`onPrSeen(rows, pr, where)`、`manual(prId | {slug, branch})`、`latestForSession(sessionId)`、`flush()`。
- 单测：clean → 递送一行通过；有违规 → 递送清单不含规矩全文；session 忙 → 延后；关着开关 → 不排；去重。

## T8 评估服务和简报（§7.1、§8、§9）
- `src/main/assess/assessment-service.ts`：`assess(prId)`（读数据、写表、内容不变不写），事件 `pr_risk_high`、`pr_ready`（H 的 `recordEvent`）。
- `src/main/assess/brief.ts`：渲染六段（只用核实过的证据），标记块；`upsertBriefBlock(body, block)`。
- `src/main/assess/brief-service.ts`：`generate(target)`、`post(prId, manual)`（`ExternalActions` 的 `pr_brief_post`：手动 `record`，自动 `attempt`）、`briefProvider(layer)`（K 的签名）。
- `src/shared/external.ts`：新 kind `pr_brief_post` / `externalPrBriefPost`。
- 单测：验收 1、3；贴到 PR 时块替换不动其余描述；开关关着 `briefProvider` 返回 null。

## T9 MCP 工具和总控（§3.1、§10）
- `memory-mcp/sessions-server.ts`：`submit_evidence`、`pre_review_result`（ticket 范围，中英描述）；shipherd 范围 `pr_assessment`；`list_prs` 加 `risk` / `ready` / `missing`。
- `src/shared/control.ts`、`control-handler.ts`、`shipherd-control.ts`；`SESSIONS_AUTO_ALLOW` 加 `pre_review_result`、`submit_evidence`、`pr_assessment`。
- 更新列出工具名的测试。

## T10 说明文件（§3.2）
- `index.ts`：`preReview: preReviewActive()`；`extra` 里加证据要求那一段（按仓库档案，`src/main/prereview/guide-lines.ts`）。
- 单测：开关关着时说明文件和现在完全一样；开着时有那两段、命令来自档案。

## T11 效果统计（§11）
- `src/main/review-effect/collector.ts`（合并后、复盘完成后、启动补跑）、`stats.ts`（`lessonCommentTrend` 按 F 的签名；`reviewEffect(days)` 给页面）。
- 单测：轮次、首个 review 等待、归到规矩（含 `merged_into`）、F 的前后窗口。

## T12 IPC 和页面（§10、§11.3、§12）
- IPC：`prAssessment(ticketKey)`、`preReviewRun`、`briefRegenerate`、`briefPost`、`prPolicyGet` / `prPolicySet`、`reviewEffect(days)`、`reviewQueue()`。
- ticket 页「Review」tab；「进度」页徽标和「待 review」视图；设置页「预审和就绪」tab；「效果」页「Review 效果」区块。
- 字符串中英两份。

## T13 设置和文档
- `preReviewEnabled`：`SETTING_DEFAULTS`、`EDITABLE_SETTINGS`、`normalizeSetting`；`externalPrBriefPost` 跟着 B 的列表。
- `docs/configuration.md` 和 `.zh-CN.md`：两个设置、策略键表。

## T14 接线（index.ts）
- 建 repos / services；`queue.register("pre_review", …)`；`onPrRead` / `onMerged` / `roundDone` / `linkCreatedPr` 链上 G；策略变更 → 重算；K 的 `briefProvider`（K 还没合就留一个 `stackBriefProvider` 导出，后合的一方接）。

## T15 e2e
- `e2e/prereview.spec.ts`：假 claude 回固定的预审、核实、简报 JSON；一个 ticket session 调 `submit_evidence` → 预审完成 → Review tab 显示「就绪」、风险、简报；另一个缺测试证据 → 「未就绪：缺测试输出」；「效果」页有 Review 效果区块。

## T16 收尾
- 全量 `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`。
- Opus 独立 review → 处理。
- common.md 第 8 条合并；合完 report done。
