# Workstream G：PR 前预审、完成证据、就绪度、风险、review 简报、review 效果统计（设计补充）

上级文档：`2026-11-17-butler-3-design.md`（第 3 节 G、第 4.1 / 4.2 / 4.5 / 4.6 / 4.7 / 4.8 / 4.9 节、第 5 节）。
源计划第一部分 1.1、1.3、1.6（预审那句话），第三部分第 7 条，7.3，7.5，第五部分阶段 4。这里只记 G 自己做的决定；契约以上级文档为准，这里只扩展不修改。

## 0. 开工前核实过的点

- **自我 review 这一步在哪。** Butler 没有「自我 review」的钩子：session 自己决定什么时候跑 code-review skill、什么时候 `gh pr create`。能确定抓到的时刻只有两个：session 主动调 MCP 工具（新加 `submit_evidence`，第 3 节），和 Butler 看到 PR（`PrLinker.linkCreatedPr`，以及 `PrWatcher.onPrRead` 里出现新的 head sha）。G 两个都接：前者是主路径（证据 + 预审一起做），后者兜底（没交证据的 PR 也会被预审，证据记为缺失）。
- **diff 从哪来。** 仓库里没有现成的 diff 统计函数（`gh.ts` 只有 `compareFiles`，走 GitHub API）。G 新加 `src/main/prereview/diff.ts`：在 session 的 worktree 里 `git merge-base <sha> origin/<base>`，`git diff --numstat -z` 和 `git diff --unified=3` 取「这次 PR 的改动」；worktree 不可用时退回 `compareFiles`。全部 `execFile` 加参数数组，路径统一成 `/`，Windows 和 macOS 一样。
- **规矩按路径筛。** D 的 `scopeGlobs`、`scopeLang`、`strength`、`checkability` 都在 `lessons` 上；`src/shared/glob.ts` 的 `inScope(path, globs)` 是 hook 也在用的同一个匹配。预审取「这些仓库的已确认规矩 + 所属产品的已确认规矩」（和 `lessons/select.ts` 的 `confirmedFor` 同一口径，不受 30 条限制），再留下 `scopeGlobs` 为空或匹配任一改动文件的；`scopeLang` 有值时要求改动里有这种语言的文件（按扩展名）。`checkability = converted` 的已经由检查管，不再送进预审（检查结果另有输入）。
- **检查结果。** E1 已经给 G 留了接口：`ChecksService.sessionCoverage(ids)`（`checks_absent`，契约 4.5 的「没挂上检查」）和 `hitsForSessions(ids)`（`check_hits`）。CI 结论来自 `ticket_prs.ci` 和 `PrStatus.checks`。
- **仓库档案。** E2（#44）的 `BaselineService.latest(slug)?.profile` 是 `RepoProfile = { projects: { dir, langs, install, build, testAll, testOne, fastest, lint, typecheck }[], ci, … }`。G 用它决定要哪些证据、复跑哪些命令。E2 没合进来之前，G 用一个 `ProfileSource = (slug) => RepoProfile | null` 依赖（单测里注入），rebase 以后接到 `BaselineService`。
- **评论数据。** I 的 `pr_comment_items` 只在 `comments.enabled` 打开时才有数据（默认关）。所以「没有未处理的评论」在评论闭环关着时退回读 `PrStatus`：有人（非作者、非 bot）的 `CHANGES_REQUESTED` review 还没被后来的 `APPROVED` 盖掉，就算有未处理的评论；评论闭环开着时读 `pr_comment_items` 的 `pending / review / queued / delivered`（和 `closePr` 认定「还开着」的同一组）。
- **合并闸门。** `MergeGate` 没有读状态的接口；状态在 `MergeGateRepo`：`activeHold(repoPath, branch)`、`waitersOf(holdId)`、`waitingSessionIds()`。「合并总控在等别人」= 这个 PR 的分支或它的 session 有一条 `merge_waiters`，所等的占位还没释放。只读，不改闸门。
- **冲突。** `PrStatus.mergeable`（`MERGEABLE / CONFLICTING / UNKNOWN`）和 `mergeState` 已经在读。`CONFLICTING` 算冲突，`UNKNOWN` 算「还不知道」。
- **ticket 类型。** `tickets` 没有类型字段，也没存 Jira 的 issue type。风险规则里的「ticket 类型」按确定的来源推出来：PR 的 labels，再看分支名前缀（`hotfix/`、`fix/`、`docs/`、`chore/` …）。推不出来记 `unknown`，不影响等级。映射是策略数据（第 6 节），可按仓库改。
- **H 已经统计了什么。** H 的 `MetricAverages` 已经有每个 PR 的人 / Copilot / 可避免评论数、开 PR → 合并、ticket 开始 → 合并、按风险分组（读 G 的 `pr_risk.level`）。G 不重复这些，只补 H 没有的：**review 来回轮次**、**首个人工 review 等了多久**、**按规矩的上线前后对比**、**可避免评论的周趋势**、**带简报和不带简报的 PR 对比**。
- **路由。** `pre_review`（high, wait）、`evidence_verify`（high, wait）、`pr_brief`（mid, fallback）已经在 `TASKS` 里。G 给前两个加 `reviewer: true`，调用时把开发 session 的模型作为 `producer` 传进去：配了多个模型时，审查方优先用和开发 session 不同的模型（路由器 `router.ts:110-122` 已经支持）。
- **后台队列。** `pre_review` 已经在 `BACKGROUND_KINDS`（normal、可按时段调度）。开发 session 提交证据后在等结果，按时段推迟会让它空等，所以 G 把它改成 `high`、`idleEligible: false`（只在额度 hard 和熔断时让路），用户仍可在 `bgKinds` 里改。
- **对外动作。** B 的 `EXTERNAL_ACTIONS` 里没有「贴简报」。G 加一种 `pr_brief_post`（设置 `externalPrBriefPost`，默认关），和 K 约定的一样（第 8 节）。

## 1. 默认行为和开关

上级文档的反目标：什么都不配置的用户看到的和 2.1.0 一样，外加能看到可以打开什么。

| 东西 | 默认 | 说明 |
|---|---|---|
| 预审 `preReviewEnabled` | 关 | 开了以后才：说明文件写「完成前交证据」和「提 PR 前会自动预审」、`submit_evidence` 排预审、看到新 PR / 新 sha 时补预审、预审后生成简报 |
| 就绪度和风险 | 开 | 确定性计算，不调模型、不对外；关着预审时，「预审无违规」「证据齐全」两条显示为「没开预审」，不算缺失 |
| 自动贴简报 `externalPrBriefPost`（B 的开关） | 关 | 只管「自动写进 PR 描述」；手动「贴到 PR」按钮是用户亲手点的，照样记审计 |

就绪条件、风险阈值、路径类别、复跑方式都是三层策略（4.2，第 6 节），不是全局设置。

## 2. 数据（契约 4.6，迁移只追加）

一条迁移，全部新表：

### `pre_reviews`：一次预审

`id, ticket_key, session_id, repo_slug, cwd, branch, base, head_sha, pr_id → ticket_prs ON DELETE SET NULL, trigger ('evidence' / 'pr' / 'manual'), status ('queued' / 'running' / 'done' / 'failed' / 'skipped'), job_id, files (JSON：路径、增删行数，最多 1000 个), lessons (JSON：参与的规矩 id), checks (JSON：检查结果摘要，第 4.3 节), violations (JSON，第 4.4 节), verdict ('clean' / 'violations' / 'error' / null), detail, model, delivered_at, created_at, finished_at`。索引 `(repo_slug, branch, head_sha)`、`(pr_id)`、`(session_id)`。同一个 `(slug, branch, sha)` 可以有多次（手动重跑），最新一次 `done` 的算数。

### `pr_evidence`：证据条目

`id, pre_review_id → pre_reviews ON DELETE CASCADE, pr_id → ticket_prs ON DELETE SET NULL, ticket_key, session_id, repo_slug, branch, head_sha, kind ('check' / 'acceptance' / 'ui' / 'not_run'), category (检查的类别：'test' / 'lint' / 'typecheck' / 'build' / 'other'，其他 kind 为 null), name, command, claimed ('pass' / 'fail' / null), summary (≤ 2000 字), verified ('pending' / 'rerun_pass' / 'rerun_fail' / 'consistent' / 'mismatch' / 'unverifiable'), verify_detail, rerun_output (尾部 ≤ 4000 字), created_at, verified_at`。

契约说以 `ticket_prs.id` 为键；证据和简报常常在 PR 还不存在时就有了（栈的上层只 push 分支，见 K），所以 `pr_id` 可空，另带 `(repo_slug, branch, head_sha)`。PR 行出现（`linkCreatedPr`、`onPrRead`）时按这三项补上 `pr_id`。这是对契约的扩展，读的一方照样按 `pr_id` 查。

### `pr_readiness`、`pr_risk`：每个 PR 一行（`pr_id` 主键）

- `pr_readiness(pr_id PRIMARY KEY → ticket_prs ON DELETE CASCADE, head_sha, ready INTEGER, conditions TEXT JSON, missing TEXT JSON, computed_at)`。`conditions` 是 `{ key, state: 'pass' / 'fail' / 'unknown' / 'off', detail }[]`，`missing` 是不满足的那几条的 key 和一句话。
- `pr_risk(pr_id PRIMARY KEY → ticket_prs ON DELETE CASCADE, head_sha, level TEXT ('low' / 'medium' / 'high'), reasons TEXT JSON, inputs TEXT JSON, rules_version INTEGER, computed_at)`。H 读 `pr_id` 和 `level`（H 的 `readRisk` 先找 `level` 列）。

### `pr_briefs`：简报

`id, pr_id → ticket_prs ON DELETE SET NULL, pre_review_id → pre_reviews ON DELETE SET NULL, repo_slug, branch, head_sha, markdown, summary_ok (模型那一段写成了没有), created_at, posted_at, posted_url, audit_id`。同一个 PR 可以有多份（新 sha、重新生成），最新一份算数；历史留着（贴过的那份能查到）。

### `pr_policies`：就绪和风险的三层策略

和 `loop_policies` 同形：`id, scope_kind ('global' / 'product' / 'repo'), product_id, repo_slug, overrides TEXT JSON DEFAULT '{}', updated_at`，唯一索引 `(scope_kind, COALESCE(product_id,0), COALESCE(repo_slug,''))`。

### `review_effect_prs`、`review_effect_comments`：效果统计（F 只读）

- `review_effect_prs(pr_id PRIMARY KEY → ticket_prs ON DELETE CASCADE, repo_slug, number, butler INTEGER, opened_at, merged_at, files TEXT JSON (改动路径，最多 1000 个), comments_human, comments_copilot, avoidable, rounds, first_review_ms, submit_to_merge_ms, brief_posted INTEGER, retro_done INTEGER, computed_at)`。
- `review_effect_comments(id, pr_id → review_effect_prs ON DELETE CASCADE, source_id (lesson_sources.id), lesson_id (归到的规矩，跟着 merged_into 走到最终那条), who ('human' / 'copilot'), path, lesson_confirmed_before INTEGER (这条规矩在这个 PR 开之前已经确认 = 「规矩在却没遵守或写得不清楚」), created_at)`，唯一 `(pr_id, source_id)`。

## 3. 完成证据（7.5）

### 3.1 session 怎么交

butler-sessions 新加两个工具（ticket 和 fix session 有，成员 session 的 inbox 不加）：

- `submit_evidence`：`{ checks: { name, category, command, result: 'pass' | 'fail', output }[], acceptance: { criterion, how }[], ui?: { path, note }[], notRun?: { name, reason }[], notes? }`。Butler 按 session 的 worktree 读出当前 `HEAD`、分支、slug，存成一组 `pr_evidence`，排一次预审（`trigger = 'evidence'`，去重键 `session:sha`），返回「已收到，预审结果会送进来；在那之前不要改 worktree」。worktree 有未提交的改动时拒收，告诉 session 先提交（证据要对应一个确定的 sha）。字段长度在 MCP 和主进程各验一次（`output` 截到 2000 字，最多 30 条检查、50 条验收）。
- `pre_review_result`：只读，返回这个 session 最近一次预审的结论、违规清单、证据核实结果和缺的证据。递送失败时 session 自己能取。加进 `SESSIONS_AUTO_ALLOW`。

### 3.2 说明文件里写什么

`preReviewEnabled` 打开时，ticket 和 fix session 的说明文件：

- D 留的那句「提 PR 前会自动预审」打开（`index.ts` 里 `preReview: false` 换成 `preReviewActive()`）。D 只在有规矩时写这一句；没有规矩的仓库也要预审（证据、检查），所以 G 在 `extra` 里另加一段，不依赖规矩段。
- 「完成前必须交证据」一段（`extra` 行）：调 `submit_evidence`，写明跑了什么、命令、输出摘要；每条验收条件怎么满足；UI 改动附截图路径（有条件时）；没跑的检查写原因。**要哪些检查按仓库档案**：每个仓库一行，列出档案里有的 `testAll` / `testOne`、`lint`、`typecheck`、`build` 命令；仓库没有档案时写通用的「测试、lint、类型检查」。交完结束这一轮，等预审结果。
- 规矩本身不进这一段：预审在后台对照，开发 session 只拿违规清单（1.1）。

### 3.3 要哪些证据（required）

按 `(slug, 改动的文件)` 确定性地算：

- 档案里这个改动涉及的项目（`projects[].dir` 是改动路径的前缀）有 `testAll` 或 `testOne` → 要 `test`；有 `lint` → 要 `lint`；有 `typecheck` → 要 `typecheck`。没有档案 → 要 `test`。策略 `evidence.require`（第 6 节）可以加减类别。
- 验收条件对照：总是要（至少一条 `acceptance`）。
- UI 证据：改动命中 `paths.ui`（默认 `**/*.{tsx,jsx,vue,svelte,css,scss,html}`、`**/components/**`）时「建议」，缺了只在简报里写「没有截图」，不算缺失（源计划写的是「有条件时」）。
- 一条要的类别，交了 `notRun` 并写了原因 → 算「已说明」，不算缺失，但风险规则照样把它当「没有这项输出」（3.5）。

### 3.4 核实（预审的一部分）

1. **复跑**（确定性，Butler 自己跑，不让模型跑命令）：只跑**档案里的命令**，不跑 session 自己写的命令（防止证据里的命令被改成 `echo ok`）。默认复跑 `typecheck`、`lint`、`test`（`testAll`），策略 `evidence.rerun = 'all' | 'fast' | 'off'`（`fast` = 只跑 `fastest` 和 `typecheck`）。条件：session 的 worktree 干净、`HEAD` 等于这次的 sha；跑完再看一次，`HEAD` 变了或 worktree 变脏就把结果作废（`unverifiable`）。每条命令有超时（策略 `evidence.rerunTimeoutSec`，默认 600）。进程树用 hook 里现成的 `killTree`（Windows `taskkill /T`，macOS 进程组）。输出只留尾部 4000 字。
   - session 声称 pass、复跑也 pass → `rerun_pass`；复跑 fail → `rerun_fail`（声称和实际不符，比没交更糟）。
2. **交叉核对**（`evidence_verify`，独立后台 claude，reviewer 任务）：输入是证据条目、复跑结果、diff 的文件清单和统计、ticket 标题。对没复跑的条目判断「输出能不能对上」（比如声称跑了 120 个测试全过、但输出里是 0 个；声称加了测试、但 diff 里没有测试文件），给每条 `consistent` / `mismatch` / `unverifiable` 和一句理由。不给工具，只看给它的东西。模型调用失败：没复跑的条目记 `unverifiable`。
3. **结论**：一条要的类别「有效」= 有一条该类别的 `check` 证据，而且核实结果是 `rerun_pass` 或 `consistent`。`rerun_fail`、`mismatch` 算「证据不实」，比缺失多一句说明。

### 3.5 缺证据的后果

- 风险等级升一档（第 5 节规则 R9）。
- 就绪条件「证据齐全」不满足，`missing` 写明缺哪项（「缺测试输出」「类型检查结果对不上：…」）。
- 简报的证据段写「缺少：…」。

## 4. 预审（1.1）

### 4.1 什么时候跑

- `submit_evidence` → 立刻排（`trigger = 'evidence'`）。
- Butler 看到一个 Butler session 的 PR 有新的 head sha（`linkCreatedPr`、`onPrRead`），而这个 `(slug, branch, sha)` 还没有预审 → 排一次（`trigger = 'pr'`），没有证据。草稿和已合并、已关闭的不排。去重键 `pr:<slug>:<branch>:<sha>`。
- 页面和总控的「重新预审」（`trigger = 'manual'`）。
- `preReviewEnabled` 关着时前两种都不排；手动的照样能跑（用户亲手点的）。

### 4.2 后台任务（`pre_review`，L 的队列）

处理函数在 `src/main/prereview/runner.ts`：取 diff → 选规矩 → 收检查结果 → 复跑 → 两次模型调用（`pre_review`、`evidence_verify`，互不依赖，并行）→ 写结果 → 算就绪和风险 → 生成简报 → 递送。可打断：检查点存「复跑做到第几条」和已经拿到的模型结果。花费记到 ticket 名下（`ticketKey`），L 的熔断照常生效。

### 4.3 输入

- **diff**：文件清单和增删行数全部给；patch 正文按文件给，总量上限 `PRE_REVIEW_DIFF_CHARS`（150 000 字），超出的文件只给路径和行数并注明「正文没给」。锁文件、生成文件（`paths.generated`，默认 `**/*.lock`、`pnpm-lock.yaml`、`package-lock.json`、`**/dist/**`、`**/*.min.*`、`**/*.snap`）只给统计。
- **规矩**：第 0 节的筛法，全部给（上限 300 条，按出现次数排；超出时把数字写进结论）。每条带 id、强度（`must` / `should`）、适用路径。
- **检查结果**：这个 session 的 `check_hits` 里还没 `resolved` 的 `fail`（按检查 key、文件汇总），`checks_absent` 的原因，PR 的 CI 结论（有 PR 时），复跑结果。
- **证据**：session 交的原文（截断后）。
- 模型可以用 `Read`、`Grep`、`Glob` 读 worktree（只读；看上下文用），不给 Bash、Edit。

### 4.4 输出：违规清单

`violations: { lessonId | null, checkKey | null, file, line | null, severity: 'must' | 'should', what, fix }[]` 加 `summary`。`lessonId` 必须是给它的规矩之一（不认识的丢掉），`file` 必须在改动里（不在的丢掉）。`lessonId` 为空的只允许来自检查结果（`checkKey` 非空）：预审不凭空造规矩。

**结论**：没有 `must` 违规、没有未解决的 `block` 级检查失败 → `clean`；否则 `violations`。`should` 违规是否也算「有违规」看策略 `readiness.shouldBlocks`（默认否：照样送给 session、写进简报，但不让 PR 变成未就绪）。

### 4.5 递送给开发 session

沿用 I 的做法：`deliveryGuard.check` → `deliver(termId, text, recheck)`，只在 session 停下来时送，休眠的由 M 叫醒，送不到就留在页面上（`delivered_at` 为空，下一轮 `roundDone` 再试，最多 24 小时）。正文只有违规清单（文件:行、哪里不对、怎么改）、证据核实里不实或缺失的项，以及「改完再调 `submit_evidence`」。**不附规矩全文**，只附违规那条的一句话。`clean` 时只送一行「预审通过」。

## 5. 风险等级（7.3，规则版本 1）

`src/main/assess/risk.ts`，纯函数 `computeRisk(input, policy): { level, reasons }`，`RISK_RULES_VERSION = 1`。输入全是确定的数据：改动文件和行数、检查结果（CI、session 的检查命中、`checks_absent`）、预审结论、证据结论、ticket 类型、同一 ticket 还开着的 PR 涉及几个仓库。不调模型。

按顺序判断，每条命中的都记进 `reasons`（`{ rule, level, files?, detail }`）：

| 规则 | 条件 | 至少 |
|---|---|---|
| R1 迁移 | 改动命中 `paths.migration`（默认 `**/migrations/**`、`**/migrate/**`、`**/*migration*`、`**/*.sql`、`**/schema.prisma`、`**/alembic/**`、`**/db/schema*`） | high（**不能被任何策略降下来**：迁移这条只能加路径，不能关） |
| R2 鉴权和权限 | `paths.auth`（`**/auth/**`、`**/*auth*`、`**/*permission*`、`**/*acl*`、`**/*rbac*`、`**/security/**`） | high |
| R3 公共 API | `paths.publicApi`（`**/api/**`、`**/*.proto`、`**/openapi*`、`**/swagger*`、`**/*.graphql`、`**/public/**/*.d.ts`） | high |
| R4 配置和密钥 | `paths.config`（`**/.env*`、`**/*secret*`、`**/*credential*`、`**/*.pem`、`**/*.key`、`**/config/**`、`**/settings.*`） | high |
| R5 CI 配置 | `paths.ci`（`.github/workflows/**`、`.gitlab-ci.yml`、`.circleci/**`、`azure-pipelines*.yml`、`Jenkinsfile`、`.buildkite/**`） | high |
| R6 大 diff | 改动行数 > `size.largeLines`（800）或文件数 > `size.largeFiles`（40），生成文件不算 | high |
| R7 跨仓库 | 同一 ticket 还开着的 PR 涉及 ≥ 2 个仓库 | high |
| R8 检查有警告 | CI 失败；或 session 有未解决的检查命中（任何级别、包括影子模式的 fail）；或 `checks_absent` 非空；或预审有 `must` 违规 | high |
| R9 缺证据 | 要的证据不全或不实 | 在其他规则得出的等级上升一档 |
| R10 ticket 类型 | 类型映射 `ticketTypes`（默认 `hotfix`、`security` → high；`bug` → medium；`docs`、`chore` → 不设下限） | 映射的等级 |
| 低风险 | 以上都没命中，**并且**：改动行数 ≤ `size.smallLines`（100）、文件数 ≤ `size.smallFiles`（8），全部文件都在 `paths.lowRisk`（测试、文档：`**/*.test.*`、`**/*.spec.*`、`**/test/**`、`**/tests/**`、`**/__tests__/**`、`**/*.md`、`docs/**`）或者改动总行数 ≤ 20；CI 通过（没有 PR 时看复跑全过）；**有一条核实过的测试证据**（`rerun_pass` 或 `consistent`） | low |
| 其余 | | medium |

- 「没有测试输出的 PR 不会被判为低风险」由「低风险」那行的最后一个条件保证；预审关着时没有证据，所以也到不了 low（显示 medium，理由里写「没有核实过的测试输出」）。
- R9 在 high 上不再升（已经最高）。
- 策略能改路径、阈值、类型映射，不能关 R1、不能关「低风险必须有测试证据」。

## 6. 三层策略（4.2）

`src/shared/pr-policy.ts` 定义键和默认值，`src/main/assess/policies.ts` 的 `PrPolicies`（照 `LoopPolicies` 的写法：`forSlug`、`overrides`、`setLayer`、`view`）。键：

- `readiness.<条件>.enabled`：六个条件各一个开关（默认全开）。`readiness.shouldBlocks`（否）。`readiness.descriptionMinChars`（80）、`readiness.descriptionSections`（三组关键词，见第 7 节）。
- `evidence.require.<类别>`（`auto` / `on` / `off`，默认 `auto` = 按档案）、`evidence.rerun`（`all`）、`evidence.rerunTimeoutSec`（600）。
- `paths.migration`、`paths.auth`、`paths.publicApi`、`paths.config`、`paths.ci`、`paths.lowRisk`、`paths.generated`、`paths.ui`：glob 列表。窄层**追加**到宽层（列表按并集；给 `paths.<类>.replace = true` 才整份替换），因为风险路径往往是「这个仓库还多一个目录」。`paths.migration` 只能追加。
- `size.smallLines`、`size.smallFiles`、`size.largeLines`、`size.largeFiles`。
- `ticketTypes`：`{ labels: Record<label, type>, branchPrefixes: Record<prefix, type>, floors: Record<type, level> }`。

页面：设置页新 tab「预审和就绪」，范围选择（全局 / 产品 / 仓库）+ 每一层的覆盖编辑，显示生效值和来源（和 I 的 `LoopPolicyEditor` 同一个交互）。导出导入：注册 config-io 的 `prPolicies` 区块（4.3），和 I 的 `loopPolicies` 一样。

## 7. 就绪度（7.3）

`src/main/assess/readiness.ts`，纯函数。六个条件，每个 `pass` / `fail` / `unknown` / `off`：

1. `checks`：CI 通过（`ticket_prs.ci = passing`），而且 session 没有未解决的 `block` 级检查失败。CI 还在跑 = `unknown`（不算就绪）。
2. `pre_review`：最新 sha 有一次 `done` 的预审，结论 `clean`。没开预审 = `off`；有预审但不是当前 sha = `fail`（「预审对应的是旧提交」）。
3. `evidence`：第 3.3 节要的证据都有效。没开预审 = `off`。
4. `comments`：第 0 节「评论数据」的口径，没有未处理的评论。
5. `mergeable`：`mergeable != CONFLICTING`，而且合并总控没有在让它等别人。`UNKNOWN` = `unknown`。
6. `description`：PR 描述去掉 Butler 自己的块（`<!-- butler:… -->`）后 ≥ `descriptionMinChars` 字，并且三组关键词（「改了什么」：`what` / `changes` / `summary` / `改了` / `改动` / `做了什么`；「为什么」：`why` / `motivation` / `context` / `为什么` / `原因` / `背景`；「怎么验证」：`test` / `verif` / `how to` / `验证` / `测试`）每组至少命中一个（标题行或正文，大小写不敏感）。描述原文不出主进程。

`ready` = 所有启用的条件都是 `pass` 或 `off`。`unknown` 不算就绪，但 `missing` 里写「还不知道」而不是「缺」。**只提示、只排序，不当闸门**：Butler 不因为未就绪拦任何动作。

### 7.1 什么时候算

`AssessmentService.assess(prId)`：读 PR 行、最新预审和证据、检查、评论、闸门、策略 → 算就绪和风险 → 写 `pr_readiness`、`pr_risk`（内容没变不写，`computed_at` 不刷）→ 判定变化时发 H 的事件（第 9 节）。触发：`onPrRead` 之后（每次读 PR）、预审完成、证据核实完成、策略改了（全部开着的 PR）、评论状态变了（I 的 `onChange`）。只对 open 的 PR 算；合并、关闭后保留最后一次的结果（H 按合并日统计时要读）。

## 8. review 简报（7.3）

### 8.1 内容

`src/main/assess/brief.ts`。一页 Markdown，用 `<!-- butler:brief -->` … `<!-- /butler:brief -->` 包住（和 K 约定）。各段：

1. **改了什么、为什么**：唯一由模型写的段（`pr_brief`，mid，fallback）。输入是 ticket 标题、PR 标题和描述（截断）、改动文件统计、证据里的验收条件对照。模型失败 → 用 ticket 标题 + PR 标题 + 文件统计拼一句（`summary_ok = 0`）。
2. **风险**：等级和每条理由（哪类、哪些文件），直接从 `pr_risk.reasons` 渲染。
3. **证据**：**只列核实过的**（`rerun_pass` 写「Butler 复跑通过」并附命令，`consistent` 写「已核对输出」），不实的写「对不上：…」，缺的写「缺少：…」。session 的自述不原样进简报。
4. **预审结论**：clean，或违规条数和每条的文件:行和一句话。
5. **建议重点看**：确定性挑出：命中风险路径的文件、改动行数最多的前 5 个文件（生成文件除外）。
6. **已知取舍和没做的事**：证据的 `notRun`（带原因）和 `notes`。

### 8.2 什么时候生成、放哪

- 每次预审完成后生成一份（预审开着时）；页面上有「重新生成」。
- 默认**只在 Butler 里看**：ticket 页的「Review」tab 显示、可复制。
- 「贴到 PR」按钮：把简报块写进 PR 描述（已有块就整块替换，没有就追加在末尾），`gh pr edit --body-file`。用户亲手点的，走 `ExternalActions.record('pr_brief_post', …)` 记审计。
- 自动贴：`externalPrBriefPost` 打开时，PR 是 open、非草稿、简报对应当前 sha → 自动做上面那一步，走 `ExternalActions.attempt`。
- **K 的注入点**（记忆里的约定）：`briefProvider(layer: { repoSlug, branch, headSha | null, ticketKey | null, prNumber | null }) => { markdown, posted(prUrl) } | null`，同步。G 按 `(repoSlug, branch, headSha)` 找最近的简报（`headSha` 为空取这个分支最新的）；`pr_brief_post` 的开关关着或没有简报返回 null。K 把 markdown 原样插进栈底描述，`gh` 成功后调 `posted(prUrl)`：G 记审计、填 `posted_at`。`index.ts` 里谁后合并谁接线。

## 9. 给 J 和 H 的事件（记忆里的约定）

`AssessmentService` 判定变化时调 H 的 `recordEvent`：

- `pr_risk_high`：等级变成 high、之前不是 high、PR open 且非草稿。`dedupeKey = risk_high:<prId>:<headSha>`，`data = { prNumber, level: 'high' }`。
- `pr_ready`：`ready` 从 false / 没有 变成 true。`dedupeKey = ready:<prId>:<headSha>`，`data = { prNumber }`。

`data` 里不放标题、链接、理由这些原文。J 已经登记了这两个 kind。

## 10. 你自己的 review 分档（7.3）

只改排序，不改「该不该看」：

- 「进度」页的 PR 列表和 ticket 页 PR 列表：每行加风险徽标（低 / 中 / 高）和就绪徽标（就绪 / 未就绪：缺 N 项，悬停看缺什么）。
- 「进度」页加「待 review」视图：开着、非草稿的 PR，排序键 = (未就绪在前) → (风险高在前) → (等得久在前)。和计划一致：高风险或未就绪的排前面，低风险且就绪的可以快速过。
- 总控的 `list_prs` 每个 PR 加 `risk`、`ready`、`missing`（只是读表），另加只读工具 `pr_assessment(prId | url)` 返回就绪条件、风险理由和简报正文。

## 11. 效果统计（1.3、阶段 4、7.3 的度量）

### 11.1 采集

`src/main/review-effect/collector.ts`：PR 合并（`onMerged`）后、以及复盘完成（`lesson_runs` 变 `done`）后，对这个 PR 写 `review_effect_prs` 和 `review_effect_comments`。启动时补一次：`metricsSince` 之后合并、还没有行或 `retro_done = 0` 的 PR（每次最多 200 个）。

- 改动文件：合并时取一次（worktree 里 `git diff --name-only <merge-base>..<head>`，不行就 `compareFiles`），存进 `files`。
- 人 / Copilot 评论数：读 `pr_stage_events` 的 `comment` 和带正文的 `review` 事件（和 H 同口径，按 `who`）。
- 可避免：`lesson_runs.findings_json` 最新一次 `done` 里 `avoidable = true` 的条数（和 H 的 `readAvoidable` 同口径）。
- 轮次：人的 review（非作者、非 bot）按时间排，中间隔着一次 `push` 事件的算新的一轮；只有一次 review 就是 1 轮，没有人 review 是 0。
- 首个人工 review 等了多久：开 PR（不是草稿的时刻；拿不到时用 `opened_at`）到第一条人的 review 或评论。
- 提交到合并：同一个起点到 `merged_at`。
- 带简报：`pr_briefs` 里这个 PR 有 `posted_at`。
- 评论归到规矩：`lesson_sources` 里 `(repo_slug, pr_number)` 等于这个 PR 的每一条 → 一行 `review_effect_comments`，`lesson_id` 沿 `merged_into` 走到最终的规矩；`who` 用 `lesson_sources.reviewer` 判（现有的 Copilot 判定函数）；`lesson_confirmed_before` = 规矩的 `confirmed_at` 早于 PR 的 `opened_at`。

### 11.2 给 F 的函数（记忆里的最终签名）

`src/main/review-effect/stats.ts`：

```ts
export function lessonCommentTrend(db: Db, q: { lessonId?: number; checkId?: number; since: number; repo?: string; window?: number }): LessonCommentTrend | null;
export interface LessonCommentTrend { lessonId: number; before: TrendSide; after: TrendSide }
export interface TrendSide { prs: number; comments: number; perPr: number | null; byWho: { human: number; copilot: number } }
```

`checkId` → 检查的 `lesson_id`。`prs` = 规矩适用的仓库（仓库规矩就是那个仓库；产品规矩是产品里的仓库）里已合并、`retro_done = 1`、改动命中规矩 `scopeGlobs` 的 PR，`since` 前后各取离它最近的 `window`（默认 20）个；`comments` = 这些 PR 上归到这条规矩的评论数。找不到规矩返回 null。同步、只读。

### 11.3 「效果」页的区块

在 I 的「评论和 CI」区块后面加「Review 效果」区块（单独的 IPC `reviewEffect(days)`，和 `loopEffect` 一样，不塞进 H 的 `MetricsOverview`）：

- **可避免评论的趋势**：Butler 的 PR，最近 12 周每周的「平均每 PR 可避免评论数」（SVG 折线，和 H 的趋势图同一个组件）。这是阶段 4 的验收。
- **同事 review**：Butler 的 PR 和其他 PR 各一组：平均人评论数、平均轮次、首个 review 等待、提交到合并。另一行「带简报 / 不带简报」对比同样四个数（样本 < 5 时显示「样本太少」）。
- **规矩上线前后**：最近确认的规矩里，`after.prs ≥ 3` 的按变化排序列出（规矩一句话、前 / 后每 PR 评论数、PR 数），点开跳到规矩页。
- **评论落点**：窗口内合并的 PR 上的评论，归到「上线前就有的规矩」（没遵守或写得不清楚）/「当时还没有的规矩」/「没归到规矩」（可能是新规矩）三类的数量。

## 12. 页面

- **ticket 页新 tab「Review」**：每个 PR 一块：就绪清单（六条，状态和一句话）、风险等级和理由、最近一次预审（时间、sha、结论、违规清单）、证据和核实结果、简报（渲染后的 Markdown、复制、贴到 PR、重新生成）、「重新预审」。没有 PR、只有分支的（栈的上层）也显示这个分支最近的预审和简报。
- **「进度」页**：第 10 节的徽标和「待 review」视图。
- **设置页**：「预审和就绪」tab：`preReviewEnabled` 开关、策略编辑器；`externalPrBriefPost` 在 B 的对外动作列表里（B 的页面自动列出新 kind）。
- 所有新文字中英两份。

## 13. 双平台

- 复跑命令用档案里的命令字符串，按平台起 shell：Windows `cmd.exe /d /s /c`，macOS `/bin/sh -c`（和 E1 hook 的 `run_command` 同一个 `runCommand`）；超时杀进程树用同一个 `killTree`。
- 路径一律转成 `/` 再匹配 glob；`git diff -z` 读 NUL 分隔，不受文件名里的空格和换行影响。
- `gh pr edit --body-file` 写临时文件（`os.tmpdir()` 下，用完删），不在命令行上传长正文（Windows 的命令行长度限制）。

## 14. 验收（从源计划的「验收」来）

1. 一个检查全过、有证据、预审无违规的 PR 显示为「就绪」并带简报（单测 + e2e）。
2. 动迁移的 PR 一定判为高风险，任何策略都改不了（单测，含策略试图关掉的情况）。
3. 缺证据的 PR 显示为「未就绪」并写明缺什么（单测 + e2e）。
4. 没有测试输出的 PR 不会被判为低风险（单测：小改动、只动测试文件、CI 通过、但没有核实过的测试证据 → medium）。
5. 「效果」页能看到 Butler 做的 PR 上可避免评论数的趋势（单测 + e2e 看到区块）。
6. 每个新开关（`preReviewEnabled`、`externalPrBriefPost`、每个就绪条件的 enabled、`evidence.rerun`）都有单测。
7. 一个 e2e 走完「`submit_evidence` → 预审（假 claude）→ 证据核实 → 就绪度和风险 → 简报」。

## 15. 已知限制

- 复跑在 session 的 worktree 里做：session 不听话、在预审期间改了文件，复跑结果作废（记 `unverifiable`），不会误判为通过。不另开临时 worktree（要重新装依赖，慢且占空间）。
- 「描述完整」是关键词判断，写得好但没用这些词的描述会被判缺；关键词可在策略里改。
- ticket 类型靠 label 和分支前缀推，推不出来不影响等级。
- 评论闭环关着时，「没有未处理的评论」只看 review 状态，不看行内评论有没有回复。
