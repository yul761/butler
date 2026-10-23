# 多仓库 ticket 和总控 session（设计）

来源：2026-10-23 Windows 真机反馈第 4 条。用户确认两步都做（第一步：多仓库 ticket；第二步：总控 session 自己开子 session）。

## 目标

一个 ticket 可能同时涉及前端、后端等几个仓库。用户希望：

1. 建 ticket 时可以不指定仓库，之后再按需添加；每个仓库各自用 worktree 或分支。
2. 新开 session 时选在哪个仓库里工作；同一个 ticket 的 session 共享记忆（已有：每个 ticket 一个 StateCore scope，挂给这个 ticket 的所有 session）。
3. 可以开一个"总控" session，它能看到这个 ticket 的所有仓库，并且能自己在指定仓库里开子 session，子 session 出现在同一个 ticket 下面。

## 第一步：多仓库 ticket

### 数据

- 新表 `ticket_repos(id, ticket_key, repo_path, work_mode, worktree_path, branch, created_at)`，`(ticket_key, repo_path)` 唯一。
- 迁移 5 把每个现有 ticket 的仓库（`tickets.repo_path / work_mode / worktree_path / branch`）复制进去。`tickets` 上这四列保留（SQLite 改列约束要重建表，而别的表有外键指向它），之后不再读；新 ticket 写入空值（`repo_path=''`、`work_mode='branch'`、`worktree_path=NULL`、`branch=''`）。
- `sessions` 加两列：`repo_id`（这个 session 是为哪个 ticket 仓库开的；`NULL` = 总控或者认不出来）和 `coordinator`（0/1）。迁移时，旧 session 归到它 ticket 唯一的那个仓库。
- `Ticket` 类型去掉 `repoPath / workMode / worktreePath / branch`，换成 `repos: TicketRepo[]`（按添加顺序）。

### 行为

- **新建 ticket**：仓库可以不填；填了就和以前一样建 worktree / 分支。
- **添加仓库**：ticket 页“+ 添加仓库”，选目录、工作方式、分支，校验规则和新建 ticket 一样；同一个仓库不能加两次。worktree 路径仍是 `<仓库>-worktrees/<ticket 号>`。
- **编辑仓库**：1.0.1 的“编辑”按钮拆成两部分：标题在 ticket 上编辑；工作方式和分支按仓库编辑（规则不变：终端在跑、有未提交改动、会丢提交时拒绝）。“终端在跑”只看这个仓库的 session 和总控 session。
- **移除仓库**：只解除关联，磁盘上的 worktree 和分支不动；这个仓库有终端在跑时拒绝。已有的 session 保留，仍在原来的目录里恢复。
- **新 session**：按钮旁边选仓库。ticket 只有一个仓库时和以前完全一样；没有仓库时只能开总控。
- **总控 session**：工作目录是 `~/.butler/workspaces/<ticket>`（Butler 建的空目录），启动参数为 ticket 的每个仓库加一个 `--add-dir <工作目录>`。恢复时按当时的仓库列表重新加。`--add-dir` 加进 `REQUIRED_FLAGS`。
- **分支检查**：按 session 的仓库检查；总控不检查。旧 session 的目录不在仓库当前分支上时，提示规则和 1.0.1 一样。
- **认领**：按 session 的目录匹配 ticket 的仓库（在某个仓库的工作目录里面），匹配到就记 `repo_id`。
- **handoff / 刷新**：仍然 fork 最近的一个 session。prompt 的 `{{branch}}` 换成全部仓库的 `仓库名@分支`（单仓库 ticket 的结果不变）。刷新在第一个仓库的目录里跑，其余仓库用 `--add-dir`；没有仓库就在工作区目录里跑。
- **已知限制**：handoff 的 schema 只有一个 `pr`。多仓库 ticket 的 prompt 要求填“最需要关注的那个”（还没合并的优先）；多 PR 支持记进 follow-up。

## 第二步：总控开子 session

### 工具

给总控 session 多挂一个 MCP server `butler-sessions`（只挂给总控，普通 session 不挂），它提供三个工具：

- `list_repos()`：这个 ticket 的仓库：名字、工作目录、分支。
- `start_session({ repo, task })`：在这个仓库里为本 ticket 开一个新 session，Butler 把 `task` 输进去并回车，返回 session id。`repo` 可以是仓库名或工作目录。
- `list_sessions()`：这个 ticket 的 session：id、仓库、第一句话、是否在运行、是否在等用户输入、最近活动时间、是否由总控开启。

不提供“给子 session 发消息”：子 session 可能停在权限确认上，总控往里打字等于替用户批准权限。子 session 之间靠共享的 ticket 记忆交流。

### 通信

和 hook 一样走文件，不开端口：

- MCP server 把请求写到 `~/.butler/control/requests/<uuid>.json`（临时文件 + rename）。ticket 号来自 mcp 配置里写死的环境变量，不来自模型。
- Butler 用 `fs.watch` + 轮询处理请求，结果写到 `~/.butler/control/results/<uuid>.json`。MCP server 最多等 60 秒。
- 请求和结果都按 schema 严格校验；ticket 不存在或已归档、仓库不属于这个 ticket 时返回错误。

### 限制

- 一个 ticket 同时最多 6 个运行中的终端（含总控）。到上限时 `start_session` 返回错误。
- 子 session 是普通的交互终端：用户在 ticket 页能看到、能接手，权限确认照常由用户处理。
- `task` 用 bracketed paste 写入（多行不会被逐行提交），然后回车。task 最长 8000 字。prompt 永远不进 argv。
- 子 session 在 ticket 页的 session 按钮上标“总控开启”。

### 打包

`butler-sessions-mcp.cjs` 由 `build-memory-mcp.mjs` 一起打包，放在 `memory-mcp/` 资源目录下，`verify-package` 检查它存在。和记忆 MCP 一样用 Butler 自己的 Electron（`ELECTRON_RUN_AS_NODE=1`）运行；它也清掉环境变量里的模型 key。

## 测试

- 单测：迁移 5（旧数据搬过去、session 归属）、TicketService 的增删改仓库、按仓库的分支检查、总控的 `--add-dir`、认领时匹配仓库、prompt 渲染、控制请求的校验和处理（上限、归档、仓库不属于本 ticket）、MCP server 的 JSON-RPC（initialize / tools/list / tools/call）。
- E2E：没有仓库的 ticket → 添加两个仓库 → 在各自仓库开 session（cwd 正确）→ 开总控（参数里有两个 `--add-dir`）→ 直接启动打包好的 sessions MCP server，调用 `start_session` → 子 session 出现在 ticket 页、task 被输入。
