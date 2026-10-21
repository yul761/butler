# Butler 设计文档

- 日期：2026-10-19
- 状态：待评审
- 形态：跨平台（Windows + macOS）Electron 桌面应用，MIT 开源

## 1. 背景与目标

### 1.1 问题

日常用公司账号的 Claude Code 工作时：

- 同时开多个 Claude Code session，每个对应一个 ticket。
- 很多 ticket 当天做不完（等 PR review 等），session 常常开着过夜，第二天继续。
- 部分 ticket 在 PR 合并后还有收尾工作（config 变更、feature flag、部署等）。虽然 Jira 上有记录，但容易遗忘。
- 没有一个地方能一眼看清：每个 ticket 卡在哪、PR 什么状态、合并后还欠什么。

### 1.2 目标

一个“电脑大管家”式的集成应用。早上开电脑打开它：

1. 看到早间简报：上个工作日做了什么、今天该做什么、哪些合并后任务还没做。
2. 每一条都能点一下，直接回到对应 ticket 的 Claude Code session 继续干活。
3. 每晚自动总结所有 ticket 的进度。
4. 记忆由 StateCore 管理：是提炼过、可追溯的状态，不是堆积的长上下文。

### 1.3 硬约束

| 约束 | 含义 |
|------|------|
| 实际工作只用公司 Claude Code | 写代码、读 Jira（经公司 Claude Code 已配置的 MCP）、生成 handoff 摘要，都通过本机已登录的 `claude` 命令完成 |
| 个人 API 自费，且不能泄密 | 个人 LLM API 只用于跨 ticket 汇总润色，只接收脱敏后的结构化数据，并且可以完全关闭 |
| 数据存在本地 | 所有数据库都是本地 SQLite 文件 |
| 一个集成 app | 不靠一堆插件拼凑。app 自动安装的 hook 和命令属于 app 的一部分，可以一键卸载 |
| Windows + macOS | 两个平台功能一致，CI 双平台测试 |
| 开源 | 别人可以接入自己公司的 Claude Code 和 tracker（Jira/Linear/GitLab……） |

### 1.4 成功标准

- 早上打开 app 不超过 10 秒就看到简报，一屏看清所有进行中 ticket 的状态。
- 所有“已合并但还有合并后任务”的 ticket 都出现在简报的“先做”区，不会漏。
- 从简报的任意一条，一次点击就能恢复对应 session，提示已预填在输入框。
- 个人 API 出站内容里不出现任何原始 ticket 号、repo 名、人名或代码内容（由自动化测试保证）。
- 个人 API 完全不配置时，除了“今日重点”润色段以外，所有功能照常可用。

### 1.5 非目标

- 不做团队共享和云同步，只服务单个用户。
- app 不直接持有 Jira、GitHub 或 Claude 的凭证。
- 不替代 Claude Code 本身，也不内置编辑器。
- 不做移动端。

## 2. 总体架构

### 2.1 技术栈

- **Electron**：要求内置 Node ≥ 22.13，因为 StateCore 嵌入式存储依赖 `node:sqlite`。
- **终端**：主进程用 `node-pty` 创建 PTY（Windows 走 ConPTY），渲染进程用 `xterm.js` 显示。
- **UI**：React + TypeScript。
- **本地存储**：`node:sqlite`（`app.db`）+ `statecore-mcp/lib`（嵌入式 StateCore）。
- **打包**：electron-builder，产出 `.dmg` 和 NSIS `.exe`，通过 GitHub Releases 自动更新。

### 2.2 进程与模块

```
┌─ Electron 主进程 ──────────────────────────────────────────┐
│ SessionManager    node-pty 启动 / 续接 claude，管理终端生命周期  │
│ SessionDiscovery  扫描 Claude Code 项目目录，认领外部 session    │
│ HookInbox         监听 ~/.butler/inbox，处理 hook 上报          │
│ HandoffRunner     headless claude 生成 / 刷新 handoff          │
│ Scheduler         晚间 handoff、早间简报、错过补跑               │
│ BriefEngine       规则引擎 →（可选）LLM 润色                    │
│ PrivacyGateway    个人 LLM API 的唯一出口                       │
│ MemoryAdapter     嵌入式 StateCore 读写                        │
│ Store             app.db 数据访问层                            │
│ Installer         安装 / 修复 / 卸载 hook、命令、MCP 配置          │
│ HealthCheck       claude 可用性、版本与能力探测、hook 完整性        │
└──────────────┬────────────────────────────────────────────┘
               │ 类型化 IPC（contextBridge，渲染进程无 Node 权限）
┌─ 渲染进程 (React) ─────────────────────────────────────────┐
│ 简报页 │ Ticket 侧栏/详情 │ 终端标签页 │ 记忆页 │ 设置 │ 审计页 │
└────────────────────────────────────────────────────────────┘
  + 系统托盘常驻；关窗口 = 缩到托盘；开机自启（setLoginItemSettings）
```

每个模块只通过明确的接口和其他模块交互。规则引擎和隐私管道都是纯函数，不依赖 Electron，可以独立测试。

### 2.3 本地目录

```
~/.butler/                       （Windows: %USERPROFILE%\.butler\）
  app.db                         运营数据
  statecore/statecore.db         StateCore 嵌入式存储
  inbox/                         hook 上报的 JSON 文件
  bin/butler-hook[.exe]          hook 可执行文件
  mcp/<ticket>.json              每个 ticket 的 --mcp-config 文件
  logs/
```

Claude Code 的配置目录优先读取 `CLAUDE_CONFIG_DIR` 环境变量，否则用 `~/.claude/`。

## 3. 核心概念与数据模型

### 3.1 Ticket 是一等对象

ticket 下面挂着工作目录、一个或多个 session、PR、合并后任务和 handoff 历史。UI 以 ticket 为主体，session 只是 ticket 的属性。

ticket 状态机：

```
active → in_review → merged_pending_followup → done
           ↘ blocked ↗
```

- 状态由最新一次 handoff 和刷新结果自动推导。
- 用户可以手动改状态。手动值一直生效，直到用户点“恢复自动”。

### 3.2 app.db 表结构

| 表 | 主要字段 |
|----|---------|
| `tickets` | `key`(PK)、`title`、`repo_path`、`work_mode`(worktree\|branch)、`worktree_path`、`branch`、`status`、`status_manual`(nullable)、`created_at`、`archived_at` |
| `sessions` | `id`(Claude session UUID, PK)、`ticket_key`(nullable)、`cwd`、`origin`(butler\|discovered)、`git_branch`、`last_activity_at`、`waiting_for_input`、`replaced_by`(nullable，/clear 或 compact 后指向新 id) |
| `handoffs` | `id`、`ticket_key`、`session_id`、`trigger`(nightly\|manual\|command\|refresh)、`created_at`、`payload`(JSON)、`degraded`、`raw_text` |
| `followups` | `id`、`ticket_key`、`kind`(config\|flag\|deploy\|doc\|other)、`description`、`trigger`(after_merge\|after_deploy\|on_date\|none)、`due_date`、`status`(open\|done\|snoozed\|ignored)、`snoozed_until`、`source`(jira\|session\|manual)、`created_at`、`done_at` |
| `briefs` | `id`、`kind`(morning\|evening)、`date`、`items`(JSON)、`narrative`、`narrative_status`(ok\|off\|failed\|blocked\|budget) |
| `jobs` | `name`(PK)、`last_run_at`、`last_status`、`last_error` |
| `llm_audit` | `id`、`ts`、`provider`、`model`、`level`、`payload_sent`、`response`、`tokens_in`、`tokens_out`、`cost_usd`、`blocked_reason` |
| `sensitive_terms` | `term`、`category` |
| `settings` | key-value |

`handoffs` 只追加不覆盖。数据库迁移用版本号脚本，启动时自动执行。

## 4. Session 管理

### 4.1 新建 ticket

输入 ticket 号，选择 repo 目录，再选工作模式：

- **worktree 模式**：在 `<repo>/../<repo>-worktrees/<ticket>` 新建 worktree 和分支 `feature/<ticket>`。分支名模板可配置。
- **branch 模式**：在原目录里建分支，或者使用已有分支。

### 4.2 启动与续接

- **新 session**：在 ticket 目录里启动
  `claude --session-id <Butler生成的UUID> --mcp-config ~/.butler/mcp/<ticket>.json`，
  并注入环境变量 `BUTLER_TICKET=<ticket>`。
- **续接**：`claude --resume <session-id> --mcp-config ...`。app 重启、电脑重启之后都靠这一步恢复。
- **branch 模式的分支检查**：续接前检查目录当前的分支。如果和 ticket 的分支不一致，先提示“当前在 X 上，要切到 Y 吗？”；工作区有未提交改动时不自动切换。
- **Shell**：Windows 用 PowerShell，macOS 用用户默认 shell。`claude` 的路径由 HealthCheck 解析并缓存。
- **生命周期**：app 运行期间，关窗口只是缩到托盘，PTY 继续存活；真正退出 app 时 PTY 结束，下次用续接恢复。
- **预填提示**：等 PTY 输出稳定（Claude 的输入框就绪）后，把文本写入 PTY，但不发送回车。

### 4.3 Butler 安装的 Claude Code hook

由 Installer 写入 Claude Code 的用户级 `settings.json`，并且是合并写入，不覆盖用户已有的 hook。

| Hook | 行为 |
|------|------|
| `SessionStart` | 上报 `session_id`、`cwd`、`source`、`BUTLER_TICKET`。如果 source 是 clear 或 compact，app 把 ticket 关联到新的 session id，旧 session 记 `replaced_by` |
| `Stop` | 上报 `transcript_path`，app 把这个 session 标为“等你输入”；同时用于解析 `/handoff` 的输出（见 5.2） |
| `UserPromptSubmit` | 清除“等你输入”标记 |
| `SessionEnd` | 记录最后活动时间 |

- hook 命令统一调用 `~/.butler/bin/butler-hook`。这是一个独立的单文件可执行程序（用 Node SEA 打包，macOS 和 Windows 各一份），只做一件事：读 stdin JSON 和环境变量，原子写入 `~/.butler/inbox/<ts>-<rand>.json`。
- 不联网，不依赖 app 是否在运行，任何异常都以退出码 0 静默结束，绝不阻塞 Claude Code。
- app 外启动的 session 也会触发 hook（没有 `BUTLER_TICKET`），上报的信息用于发现 session。

### 4.4 认领外部 session

- SessionDiscovery 每 5 分钟扫描一次，并且收到 hook 上报时立即扫描。扫描对象是 `<claude配置目录>/projects/*/*.jsonl`。
- 没有关联 ticket 的 session 放进“未认领”区，显示 cwd、git 分支、第一条用户消息和最后活动时间。
- 分支名或第一条消息里匹配到 ticket 号（正则可配置，默认 `[A-Z][A-Z0-9]+-\d+`）时，自动建议对应 ticket，用户一键确认。

## 5. Handoff 采集

handoff 是整个系统的数据源，由公司 Claude Code 生成，只存在本地。

### 5.1 晚间批量与手动触发

- **候选**：所有未归档的 ticket 中，关联 session 的 `.jsonl` 修改时间晚于上次 handoff 的。没有活动的跳过，节省公司额度。
- **命令**：
  ```
  claude -p --resume <session-id> --fork-session --output-format json \
         --mcp-config ~/.butler/mcp/<ticket>.json \
         --allowedTools "<配置的 tracker MCP 只读工具>,Bash(gh pr view:*),Bash(gh pr checks:*),Bash(git log:*),Bash(git status)" \
         "<handoff prompt>"
  ```
  - `--fork-session`：不往正在用的 session 里写内容，白天开着的 session 也不会冲突。
  - 只授予只读工具，不能改文件、提交或推送。
  - 并发上限 2，单个超时 5 分钟。
- **prompt 模板**（可配置）包含：ticket 号、上一次 handoff 的 JSON、现有的 open 状态 followups（带 id）、输出 schema 和示例，并要求 Claude 用 tracker MCP 读取 ticket 的描述、评论和子任务，用 `gh` 读取 PR 状态。
- **手动触发**：ticket 详情页的“立即 handoff”按钮，走同样的流程。

### 5.2 会话内 `/handoff` 命令

- Installer 把 `handoff.md` 写入 Claude Code 的用户级 commands 目录。
- 命令让 Claude 在当前 session 里按 schema 生成 handoff，输出到一个用 ` ```butler-handoff ` 标记的代码块中。
- 随后的 `Stop` hook 会上报 `transcript_path`，app 从最后一条 assistant 消息里提取这个代码块并入库，`trigger=command`。
- 不需要额外的工具或权限。由于用的是完整的实时上下文，这种方式得到的信息最丰富。

### 5.3 Handoff schema

```ts
{
  ticket: string,
  status: "active" | "in_review" | "blocked" | "merged_pending_followup" | "done",
  done_today: string[],
  next_steps: string[],
  blockers: string[],
  pr: null | {
    number: number, url: string,
    state: "open" | "merged" | "closed",
    review: "pending" | "changes_requested" | "approved" | null
  },
  jira: null | { status: string, subtasks: { key: string, status: string }[] },
  followups: {
    id: string | null,            // 已有项填 id；新项为 null，由 app 分配
    kind: "config" | "flag" | "deploy" | "doc" | "other",
    description: string,
    trigger: "after_merge" | "after_deploy" | "on_date" | "none",
    due_date: string | null,      // ISO 日期，仅 on_date
    done: boolean
  }[],
  decisions: { key: string, statement: string }[],
  learnings: string[],            // 可跨 ticket 复用的经验
  open_questions: string[]
}
```

### 5.4 处理与容错

- 用 zod 校验。失败时把校验错误附在 prompt 里重试一次；还是失败就存为 `degraded=true`，保留 `raw_text`，简报里标出“handoff 不完整”。
- `jira: null` 表示 tracker MCP 不可用，照常入库，简报里提示。
- followup 合并：有 id 的更新对应记录；`done=true` 的置为 done；id 为 null 的新建。用户手动 ignore 的项不会被 handoff 复活。
- 入库后同步写入 StateCore（第 8 节），并重新推导 ticket 状态（手动值优先）。

## 6. 简报引擎与调度

### 6.1 晚间小结

晚间 handoff 批次完成后生成，内容按 ticket 列出今天做了什么、阻塞项和明天第一步，并弹系统通知。

### 6.2 早间简报

触发条件：当天第一次 `unlock-screen`、`resume` 或 app 启动（Electron `powerMonitor`）。生成分三步：

1. **快速刷新**：对 `in_review` 和 `merged_pending_followup` 状态的 ticket 并发执行轻量的 `claude -p`（不 resume，prompt 只要求查询 PR 和 tracker 状态，输出 schema 的子集），`trigger=refresh`。
2. **规则引擎**：从 `app.db` 计算简报条目（纯函数）。
3. **LLM 润色**（可选）：通过 PrivacyGateway 生成“今日重点”段落。

刷新期间先显示旧数据和“刷新中”标记，完成后原地更新。

### 6.3 规则

| 区块 | 条件 |
|------|------|
| 🔴 先做 | PR `approved` 但未合并；PR `changes_requested`；ticket 处于 `merged_pending_followup` 且有 trigger=after_merge 的 open followup；`on_date` followup 到期或逾期 |
| 🟡 今天 | `active` ticket 的 `next_steps` 第一条；`blocked` 超过 N 天（默认 2） |
| ⚪ 留意 | `in_review` 且 review 等待超过 2 天；超过 5 天无活动的未归档 ticket；未认领的 session |
| 上个工作日 | 上一个工作日所有 handoff 的 `done_today` 汇总（周一显示周五） |

所有阈值和工作日都可以配置。

### 6.4 条目操作

- **打开**：恢复对应 session，并预填提示，例如“继续 follow-up：改 staging config（来自 PROJ-56）”。
- **完成**、**推迟到明天**、**忽略**：作用于对应的 followup 或 ticket。

### 6.5 调度

- 任务：`nightly_handoff`（默认 16:00）、`evening_brief`（handoff 完成后）、`morning_brief`（事件触发）、`discovery_scan`（5 分钟）。
- 调度器在主进程里运行，`jobs` 表记录每个任务的上次运行时间。在 `resume`、`unlock-screen` 和启动时检查错过的任务并补跑；晚间 handoff 如果错过，就在早间简报前执行。
- 周末和非工作日默认不跑晚间 handoff。

## 7. 隐私层（PrivacyGateway）

### 7.1 唯一出口

- 所有个人 LLM API 调用都只能经过 `PrivacyGateway`。
- ESLint `no-restricted-imports` 禁止除 gateway 之外的任何模块 import LLM SDK 或通用 HTTP 客户端，CI 强制检查。
- 公司 Claude Code 的调用不经过 gateway：它们是对本地 `claude` 进程的调用，数据本来就在公司授权的通道内。

### 7.2 管道

```
结构化输入 → 字段白名单投影(按档位) → 假名化 → 敏感信息扫描 → 写审计 → [发送前确认] → 发送
                                                                         ↓
                              渲染 ← schema 校验 ← 还原真名 ← 响应 → 写审计
```

### 7.3 隐私档位（默认 `metadata`）

| 档位 | 可发送内容 |
|------|-----------|
| `off` | 不调用 |
| `metadata` | 占位符 id、状态枚举、PR 状态与 review 枚举、followup 的 kind/trigger 枚举、计数和天数 |
| `redacted` | 在 metadata 基础上，加入经过假名化的 `next_steps`、`blockers`、followup `description` 短文本（每条有长度上限） |
| `full` | 不做假名化，但敏感信息扫描仍然生效 |

### 7.4 假名化

- 对 ticket 号、repo 名、分支名、人名（来自 PR 和 tracker 字段）以及 `sensitive_terms` 词表中的词做替换。
- 映射表**每次请求随机生成**，只在内存里，用完即弃，所以服务商无法跨请求关联。
- 响应里的占位符在本地还原；响应中出现未知占位符时丢弃该句。
- 人名只来自 `sensitive_terms` 词表：Butler 不存人名字段，词表之外的人名在 `redacted` 档位会原样发送（UI 在档位选择器旁提示）。

### 7.5 敏感信息扫描

- 用正则检测：API key 和 token 形态、URL、内网域名、IP、邮箱、文件路径、未被替换的 ticket 号格式。
- 一旦命中，**整次调用拒发**（不尝试替换后再发），在 `llm_audit` 里记录 `blocked_reason`，当次简报 `narrative_status=blocked`。

### 7.6 服务商、密钥与预算

- 统一使用 OpenAI 兼容接口（OpenAI、Anthropic 兼容端点、DeepSeek、OpenRouter、Ollama 等），在设置里填 base URL 和模型名。
- API key 用 Electron `safeStorage` 加密（macOS 钥匙串 / Windows DPAPI）。
- 月度预算上限，超出后自动视为 `off`，`narrative_status=budget`。
- 可选“发送前确认”：弹窗展示完整的出站内容，同意后才发送。

### 7.7 审计页

列出每次调用的时间、服务商、模型、档位、原样发出的内容、响应、token 数、费用和拒发原因。保留期可配置，默认 90 天。

## 8. 记忆层（StateCore）

### 8.1 分工

- `app.db`：运营状态，规则引擎的数据源。
- StateCore：可追溯的记忆（进度历史、决策、经验），供 Claude Code session 和用户查询。

### 8.2 Scope

- 每个 ticket 一个 scope：`ticket:<KEY>`。
- 全局 scope：`workspace`。

### 8.3 写入（全部是确定性路径，不调用 LLM）

| 来源 | 写入 |
|------|------|
| 每次 handoff | 在 ticket scope 写 `handoff`（summary=done_today，next_steps，open_questions），由 StateCore 的版本链保留历史 |
| `decisions[]` | 在 ticket scope 写 `remember(key=decision:<key>)`，同 key 的新值会取代旧值 |
| followups | 新建或更新时写 `remember(key=followup:<id>)`，完成或忽略时 `forget` |
| `learnings[]` | 在 `workspace` scope 写 `remember` |

### 8.4 读取

- Butler 启动的每个 Claude Code session 都通过 `--mcp-config` 挂载 `statecore-mcp`，`STATECORE_SCOPE=ticket:<KEY>`，数据目录指向 `~/.butler/statecore`。同一 ticket 的新 session，或 `/clear` 之后，Claude 都能 `recall` 到进度、决策和未完成的 followup。
- `workspace` scope 的经验通过同一个 MCP 的第二个实例（`STATECORE_SCOPE=workspace`，以不同的 server 名挂载）提供。
- ticket 详情页的“记忆”标签列出这个 scope 当前的所有记忆条目，每条都可以查看 `why` 链。

### 8.5 隐私约束

- StateCore 的 `consolidate` 和自动蒸馏会把原始事件发给 `MODEL_API_KEY` 对应的服务商。因此 Butler 只有在隐私档位为 `full` 时才会给 StateCore 设置 `FEATURE_LLM=true`；其他档位下不传任何 key。
- 设置页和 README 中提醒用户：不要另外安装 StateCore 的 Claude Code 捕获插件，Butler 已覆盖它的功能。

## 9. UI

- **左侧栏**：ticket 按状态分组，显示“等你输入”标记和 PR 状态小图标；底部是“未认领 session”入口。
- **简报页**（默认首页）：今日重点（如果有）→ 先做 → 今天 → 留意 → 上个工作日；每条带操作按钮。
- **ticket 详情页**：概览（状态、PR、followups）、终端标签页（可以有多个 session）、handoff 历史、记忆。
- **设置**：Claude Code 路径与自检、hook 安装/修复/卸载、tracker MCP 工具名、prompt 模板、调度时间与工作日、隐私档位、敏感词表、LLM 服务商与预算。
- **审计页**：见 7.7。
- **首次启动向导**：自检 `claude` → 安装 hook 和 `/handoff` → 配置 tracker MCP 工具名（尝试从 Claude Code 配置里自动检测）→ 选择隐私档位 → 可选配置个人 API。

## 10. 错误处理

| 情况 | 处理 |
|------|------|
| 找不到 `claude` 或未登录 | 向导和自检页阻止进入相关功能，并给出修复指引 |
| Claude Code 版本变化 | 启动时检查 `claude --version`；版本变化时探测 `--session-id`、`--fork-session`、`--mcp-config`、`--output-format json` 是否可用，缺失的话在顶部持续告警，相关功能降级 |
| 公司额度用完或被限流 | 当前 ticket 标为 skipped，进入早间补跑队列，不重试轰炸 |
| tracker MCP 不可用 | handoff 照常入库，`jira: null`，简报提示 |
| handoff 解析失败 | 见 5.4 |
| hook 被删除或改坏 | HealthCheck 检测，设置页一键修复 |
| inbox 文件损坏 | 移到 `inbox/bad/`，不阻塞其他文件 |
| PTY 意外退出 | 标签页显示退出码，提供“续接”按钮 |
| 个人 API 失败、超时、拒发或超预算 | 简报照常显示，只是没有润色段，`narrative_status` 标明原因 |

## 11. 测试

- **单元测试**：规则引擎（fixture 驱动，覆盖每条规则和边界，如周一回看周五）、handoff schema 与 followup 合并、状态推导（手动优先）、ticket 号匹配。
- **隐私不变量测试**（发布阻断项）：
  - 随机生成 ticket 号、repo 名、人名和敏感词，跑完整管道，断言出站内容里不出现任何一个原始值。
  - 敏感信息扫描器的样本回归测试（应拒发 / 不应误伤）。
  - ESLint 出口规则在 CI 中强制执行。
- **集成测试**：用一个假的 `claude` 可执行文件输出预设 JSON、非法 JSON 或超时，测试 HandoffRunner 的重试、degraded 和并发上限；调度器用假时钟测试错过补跑；`butler-hook` 端到端写 inbox；StateCore 写入与 `why` 链。
- **E2E 测试**：Playwright for Electron，GitHub Actions 上 macOS + Windows 双平台运行。覆盖新建 ticket → 启动假 claude → hook 上报 → handoff → 早间简报 → 点击打开。

## 12. 开源与分发

- MIT 协议。
- 可配置项：tracker MCP 工具名（Jira/Linear/GitLab 等）、handoff 与刷新的 prompt 模板、ticket 号正则、分支名模板、调度、隐私档位与词表、LLM 服务商。
- 首版不做代码签名，README 说明如何绕过 Gatekeeper 和 SmartScreen；后续可以接入签名。

## 13. 实现前需验证的假设

以下依赖 Claude Code 和外部组件的具体行为，在实现计划的早期用小实验验证；如果不成立，就按备选方案调整：

| 假设 | 备选 |
|------|------|
| `claude --session-id <uuid>` 能指定新 session 的 id | 改为用 `SessionStart` hook 上报的 id 绑定 ticket（依赖 `BUTLER_TICKET` 环境变量） |
| `claude -p --resume <id> --fork-session` 不修改原 session 的 transcript | 改为读取原 transcript，在新的 `claude -p` 中附带摘要上下文 |
| `--mcp-config` 能和用户已有的 MCP 配置叠加 | 改为在项目级 `.mcp.json` 写入（worktree 内） |
| Windows 上 Claude Code 执行 hook 时能运行 `butler-hook.exe` | 根据实际的 hook 执行 shell 调整命令格式 |
| Electron 内置的 Node 能使用 `node:sqlite` 和 `statecore-mcp/lib` | 让 StateCore 作为 `statecore-mcp` 子进程运行，通过 MCP 客户端访问 |
| `statecore-mcp/lib` 暴露了按 scope 的 remember/forget/handoff/recall/why API | 以 MCP 客户端方式调用同样的工具 |

### 13.1 验证结果（2026-10-19，Claude Code 2.1.304）

| 假设 | 结果 | 对设计的影响 |
|------|------|-------------|
| `--session-id <uuid>` | ✅ 存在 | 按 4.2 实现 |
| `--fork-session` | ✅ 存在（"When resuming, create a new session ID"） | 按 5.1 实现；fork 出的 session 会出现在 Claude Code 项目目录里，SessionDiscovery 必须识别并隐藏它们（计划 2 处理） |
| `--mcp-config` 叠加 | ✅ 默认叠加，`--strict-mcp-config` 才排他 | 按 4.2 / 8.4 实现 |
| 结构化输出 | ✅ 额外发现 `--json-schema`（仅 `--print`） | handoff 和刷新直接用 `--json-schema` 约束输出，zod 校验作为第二道保险 |
| `statecore-mcp/lib` | ✅ 导出 `createEmbeddedBackend({dataDir, scopeName, env})`，接口含 remember/recall/facts/why/forget/handoff | 可以嵌入。**但 `remember` 没有 key 参数**：note 的“取代”靠文本相似度（`isNoteRevision`），并且 notes 有数量上限，超出会淘汰最旧的一条。第 8.3 节“按 key 取代”需要在计划 4 里改为：写入前用 `facts()` 找到旧条目的 `factKey` 并 `forget`，再 `remember` 新文本；文本统一用 `[followup:<id>] ...` 这样的稳定前缀 |
| Windows 上 hook 的执行 shell | ⏳ 只能在 Windows 机器上验证 | `butler-hook` 用正斜杠的绝对路径并加引号，cmd、PowerShell、Git Bash 都能执行；CI 的 Windows E2E 负责兜底验证 |
| Electron 内置 Node 能用 `node:sqlite` | ⏳ 计划 1 的任务 1 用冒烟测试验证 | 如果不可用，改用 better-sqlite3 |

**其他实现层面的调整：**
- 4.2 节原本写的是“在 shell 里跑 claude”，改为**直接用 PTY 启动 `claude`**，环境变量 `PATH` 用登录 shell 读出来的值（macOS 从 Finder 启动的 GUI 应用拿不到用户的 PATH）。这样 claude 退出时标签页能直接显示退出码，不会残留一个空 shell。
- “未认领 session”只显示最近 7 天有活动的，并且可以“忽略”；否则历史上所有 session 都会被列出来。
