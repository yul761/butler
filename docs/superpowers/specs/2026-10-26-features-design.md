# Feature：一组 ticket 加一个工作区（设计）

来源：2026-10-26 用户反馈。用户做的往往不是单个 ticket，而是一个 feature：它有自己的名字，下面挂着前端、后端各几个 ticket（每个 ticket 有 Jira 号，例如 DMS-1234），希望一起做、用 subagent / 子 session 同时推进前后端。现在的问题：

1. 新建只能建 ticket，必须填符合格式的 ticket 号，没法表达"feature"这一层。
2. 选的目录必须是 git 仓库。用户习惯在前后端仓库的上一层目录打开 claude，好同时看到两边，Butler 不支持。
3. worktree 合并后一直留在磁盘上，时间久了很乱。

## 用户确认的决定

- 新加一层 **feature**：有名字，下面挂多个 ticket。ticket 仍然是现在的 ticket（有 ticket 号、仓库、分支）。
- **每个 ticket 各开一个分支**，同一个仓库里的几个 ticket 会同时开工 → 用 worktree。
- 分支名格式：`dms-1234-<ticket 自己的标题>`（小写 ticket 号 + 标题的 slug）。
- **feature 工作区**：一个目录，feature 下所有 ticket 的 worktree 都放在里面；feature 的总控 session 在这个目录里打开，能看到所有改动。工作区放在仓库外面、仓库的上一层旁边：

  ```
  ~/Code/
  ├── shop/                         原仓库，不动
  │   ├── frontend/
  │   └── backend/
  └── shop-features/
      └── checkout-redesign/        feature 工作区，总控在这里打开
          ├── frontend-dms-1234/    worktree，分支 dms-1234-...
          ├── frontend-dms-1235/
          └── backend-dms-1240/
  ```

- 选目录时，选的不是 git 仓库就往下找一层，列出里面的仓库让用户勾选，而不是报错。
- **PR 合并后自动清理 worktree**；不安全的情况不删，在 ticket 页提示用户。

## 我的决定（用户没有逐条确认）

- feature 是单独的表，不是一种特殊的 ticket（ticket 在简报、handoff、状态推导里到处被遍历，混进去要处处过滤）。
- feature 下的 ticket 在侧边栏里显示在 feature 下面，不再出现在按状态分组的列表里。
- 现有的单个 ticket、ticket 级的总控、`<仓库>-worktrees/<KEY>` 的放法都不变。
- 把已有的 ticket 移进 feature：这一版不做（它的 worktree 在别处，要搬家）。总控对工作区外面的目录照样用 `--add-dir`，以后要做的时候不需要改总控。
- 清理只把"会丢东西"的情况当成不安全：未提交的改动、未跟踪的文件（被 .gitignore 忽略的不算）、游离 HEAD 上不属于任何分支的提交、这个仓库自己的 session 有终端在跑。**没 push 的提交不拦**：本地分支保留，提交不会丢；而且 squash merge 加"合并后删远端分支"很常见，按"不在任何远端分支上"判断几乎每次都会误报。
- 清理过的 worktree 再开 session（新开或恢复）时，从保留的本地分支自动重建，用户不用管。

## 数据（迁移 6）

```sql
CREATE TABLE features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  workspace_dir TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE TABLE feature_repos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id INTEGER NOT NULL REFERENCES features(id),
  repo_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (feature_id, repo_path)
);
ALTER TABLE tickets ADD COLUMN feature_id INTEGER REFERENCES features(id);
ALTER TABLE sessions ADD COLUMN feature_id INTEGER REFERENCES features(id);
ALTER TABLE ticket_repos ADD COLUMN worktree_removed_at INTEGER;
ALTER TABLE ticket_repos ADD COLUMN cleanup_blocked TEXT;
```

- `feature_repos`：这个 feature 涉及的源仓库（建 ticket 时从这里选）。
- `sessions.feature_id`：feature 总控 session（`ticket_key` 为 NULL、`coordinator = 1`）。"未认领"列表排除 `feature_id` 不为空的行。
- `ticket_repos.worktree_removed_at`：worktree 已被自动清理；`cleanup_blocked`：上次没能清理的原因（给用户看），清理成功或不再满足条件时清空。

类型：`Feature { id, name, workspaceDir, repos: FeatureRepo[], createdAt, archivedAt }`；`Ticket` 加 `featureId: number | null`；`TicketRepo` 加 `worktreeRemovedAt`、`cleanupBlocked`；`Session` 加 `featureId`。

## 行为

### 选目录（新建 ticket、添加仓库、新建 feature 都用）

- 选的目录是 git 仓库：和现在一样。
- 不是：列出它下一层里的 git 仓库（只找一层，不进隐藏目录），默认全选，用户可以取消。一个都没有时报"这个目录不是 git 仓库，下一层也没有"。
- 新建 ticket 时选了上一层目录：勾选的每个仓库都加到这个 ticket（同样的工作方式和分支名）。

### 新建 feature

- 填名字、选仓库（上面的规则，可以选好几次）、工作区目录。
- 工作区默认：`<仓库的上一层的上一层>/<上一层的名字>-features/<feature 名>`，即仓库在 `~/Code/shop/frontend` 时是 `~/Code/shop-features/<feature 名>`。feature 名里不能做目录名的字符换掉（同 ticketFileStem 的规则，但允许中文等非 ASCII 字母）。用户可以改。仓库不在同一个上一层时，用第一个仓库的。
- 工作区目录已存在且非空、又不是另一个 feature 的工作区时，允许（用户可能想复用），已被另一个 feature 用了时拒绝。
- feature 页可以继续"+ 添加仓库"、移除仓库（只影响以后建 ticket 时的选项）、改名字（不改工作区目录）。

### feature 下新建 ticket

- 在 feature 页点"+ 新建 ticket"：ticket 号、标题、从 feature 的仓库里勾选（可多选，默认选第一个）、分支名（按模板预填，可改）。
- 工作方式默认 worktree，worktree 放在 `<工作区>/<仓库名>-<小写 ticket 号>`。选了分支模式也允许（总控用 `--add-dir` 看到它）。
- ticket 的其余行为（session、handoff、记忆、编辑仓库、归档）和普通 ticket 一样；改工作方式时 worktree 也用上面的路径。

### 分支名模板

- 模板新增两个占位符：`{key_lower}`（小写 ticket 号）、`{title}`（标题的 slug：小写，非 `a-z0-9` 换成 `-`，合并、去掉首尾的 `-`，最长 50）。`{key}` 不变。
- 标题为空或 slug 为空（例如全是中文）时 `{title}` 为空，代入后去掉多出来的 `-` / `/`（`dms-1234-` → `dms-1234`）。
- 默认模板仍是 `feature/{key}`；用户在设置里改成 `{key_lower}-{title}` 就是 `dms-1234-add-payment-api`。设置页的提示和校验（checkBranchTemplateFits）覆盖新占位符。
- 新建对话框里的分支名输入框显示按模板算出的预览作为 placeholder，随 ticket 号和标题变化。

### feature 总控 session

- 工作目录是 feature 工作区（不存在就建）。ticket 仓库的工作目录不在工作区里面的（分支模式、别处的 worktree），每个加一个 `--add-dir`。
- MCP：`butler-sessions` 换成 feature 模式（环境变量 `BUTLER_FEATURE=<id>`，不设 `BUTLER_TICKET`），工具：
  - `list_tickets()`：feature 下未归档的 ticket：ticket 号、标题、状态、仓库（名字、工作目录、分支）。
  - `start_session({ ticket, repo?, task })`：在这个 ticket 的仓库里开子 session；ticket 只有一个仓库时 `repo` 可以省略。子 session 是这个 ticket 的普通 session，`spawned_by` 记总控。
  - `list_sessions()`：feature 下所有 ticket 的 session（多一个 `ticket` 字段）和 feature 的总控。
  - 请求里的 feature id 来自配置；ticket 必须属于这个 feature 且未归档。
- 运行中的终端上限：一个 feature（它所有 ticket 的终端 + feature 总控）最多 8 个；单个 ticket 仍是 6 个。
- 记忆：新 scope `feature:<id>`，挂成 `butler-feature` server。feature 总控挂 `butler-feature` + `butler-workspace`；feature 下 ticket 的所有 session 在原来的基础上多挂 `butler-feature`，前后端靠它共享接口约定等。
- 认领：hook 报上来的 session，cwd 恰好是某个未归档 feature 的工作区 → 记成这个 feature 的总控（`feature_id`、`coordinator = 1`）。`/clear` 之后的新 id 沿用上一个 head 的 `feature_id`。用户自己在工作区里打开 claude 也会被认成总控。
- 终端环境：`BUTLER_SESSION` 照常设，`BUTLER_TICKET` 不设。hook 二进制不用改。

### 合并后自动清理 worktree

- 触发：每次写入 handoff / 刷新后，这个 ticket 最新的 PR 合并状态（`combinedPr(...).state === "merged"`）。启动时也对已经合并的 ticket 跑一遍（覆盖升级前就合并的）。
- 对象：这个 ticket 所有 worktree 模式、`worktree_removed_at` 为空、目录还在的仓库（feature 和普通 ticket 都算）。
- 不安全（不删，写 `cleanup_blocked`）：这个仓库的 session 有终端在跑（总控不算：它的东西都已提交）；`git status --porcelain` 非空；游离 HEAD 上有不属于任何分支的提交；`git worktree remove`（不加 `--force`）失败（把 git 的原因写进去）。
- 安全：`git worktree remove <路径>`，记 `worktree_removed_at`，清空 `cleanup_blocked`。本地分支保留。
- 在这个 ticket 正在修改仓库时（`exclusive`）跳过，下次再试。
- ticket 页：仓库一行显示"worktree 已清理"；有 `cleanup_blocked` 时显示提示条（原因 + "重新检查"按钮，点了按同样的规则再试一次）。
- 重建：给 `worktree_removed_at` 不为空的仓库开 session（新开，或恢复 cwd 是那个 worktree 的旧 session）前，`git worktree add <路径> <分支>` 重建，清空 `worktree_removed_at`。分支不在了就新建（从仓库当前 HEAD）。
- 编辑仓库（改工作方式、分支）遇到已清理的 worktree：当作"目录不见了"处理（现有逻辑已经覆盖），完成后清空 `worktree_removed_at`。

### 界面

- 侧边栏："+ 新建 feature" 在 "+ 新建 ticket" 旁边。feature 列在最上面，每个 feature 下面缩进列出它的 ticket（ticket 号、标题、状态、等待输入的点）；普通 ticket 照旧按状态分组。
- feature 页：名字（可编辑）、工作区路径、仓库列表（添加 / 移除）、ticket 列表（点进 ticket 页、"+ 新建 ticket"）、总控 session（"新开总控"、已有总控 session 的列表，可以恢复、隐藏）、终端区复用 ticket 页的。
- ticket 页：属于 feature 时标题下面显示 feature 名，点了回到 feature 页。
- 归档 feature：没有终端在跑时可以归档，连同它下面未归档的 ticket 一起归档（同一个时间戳）。"已归档"页能恢复 feature，恢复时把同一时间戳归档的 ticket 一起恢复。

## 非目标

- 把已有 ticket 移进 / 移出 feature。
- feature 级别的简报、handoff、状态。
- 删除本地分支、删除远端分支。
- 总控在 Butler 里新建 ticket。

## 测试

- 单测：迁移 6；扫描子仓库；分支模板占位符和 slug；FeatureService（建、加仓库、工作区默认路径、重名）；feature 下建 ticket 的 worktree 路径；feature 总控的 cwd、`--add-dir`、MCP 配置、终端上限；control handler 的 feature 模式（ticket 不属于 feature、省略 repo）；hook 认领 feature 总控、`/clear` 链；清理规则（各种不安全情况、成功、重建）。
- E2E：建 feature（选上一层目录，勾两个仓库）→ 在 feature 下建两个 ticket → worktree 出现在工作区 → 开 feature 总控（cwd 是工作区）→ sessions MCP 的 `start_session` 在 ticket 里开子 session → 模拟合并后 worktree 被删掉。
