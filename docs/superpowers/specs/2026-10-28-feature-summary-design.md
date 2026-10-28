# Feature 汇总：feature 级的整体进度（设计）

来源：2026-10-28 用户反馈。用户建了一个 feature，下面挂几个 ticket，在 feature 的总控 session 里下命令，让总控去指挥各个子 session 干活。想知道"这个 feature 整体到哪了"时，用户是直接问总控。问题：

1. 总控的回答没有地方存。总控 session 关了、`/clear` 了，或者第二天早上，就只能再问一遍。
2. 在总控里跑 `/handoff`，结果会被丢掉：总控 session 不属于任何 ticket，`captureCommandHandoff` 返回 `no_ticket`（`src/main/handoff/capture.ts`）。
3. 晚间 handoff 只遍历 ticket 的 session，总控里的工作完全没被记录。用户收工时一般直接关掉，不会手动跑 `/handoff`。

features 设计（2026-10-26）把"feature 级别的简报、handoff、状态"列为非目标，这份设计补上其中的 handoff 和页面展示。

## 用户确认的决定

- **两层都要**：ticket 的 handoff 不变，仍然是状态、PR、followups 的数据来源；feature 上加一层汇总，只写跨 ticket 的整体情况。
- 用户最想看的是**整体进度**和**每个 ticket 的 PR 状态**。每个 ticket 的细节不放在 feature 页，要看就点进 ticket。
- **feature 页顶部（草图 A）**：最上面是一段话，说整体进度、卡在哪、下一步做什么；下面每个 ticket 一行，显示 PR 状态。**原来的 ticket 列表和 PR 表合成一个。**
- **晚间自动生成是主要来源**：用户收工时直接关掉，不会跑 `/handoff`。
- 在总控里跑 `/handoff` 时，**同时给子 ticket 也各跑一次 handoff**（会多花公司额度，用户同意）。
- feature 页上有一个手动"立即更新"按钮。
- 汇总同时写进 feature 的共享记忆，下次开总控时能直接接上。
- 用户早上一般直接打开 feature 页，不太看简报（目前只有一个 feature）。

## 我的决定（用户没有逐条确认）

- **不显示完成百分比**：模型估出来的数不靠谱，进度看 PR 表就够了。
- **PR 表不靠汇总生成**：每一行直接取那个 ticket 最新一份有效的 handoff 或刷新结果里的 `prs`，和 ticket 页、简报用同一份数据。所以 PR 表比汇总那段话更新得勤，两者各自显示自己的时间。
- 汇总只写跨 ticket 的内容，提到 ticket 时只写 ticket 号，不重复 ticket 里的细节。
- 在总控里跑 `/handoff`：总控在这一轮里**直接**写出 feature 汇总（它指挥了子 session，知道情况），Butler 当场存下；子 ticket 的 handoff 在后台跑，跑完以后 PR 表跟着更新。不等子 ticket 跑完再生成汇总。
- **简报只做小改动**：早间和晚间简报里，属于同一个 feature 的 ticket 归到一起，上面放这个 feature 最新汇总的第一句话。个人 API 的 LLM 润色这一版**不**接收汇总的文字（避免改隐私投影）。
- feature 页这一版只显示最新一份汇总；历史记录都存在库里，先不做历史界面。
- feature 没有自己的状态：不推导"进行中 / 卡住"之类的状态，状态仍然只在 ticket 上。

## 数据（迁移 8）

新表，和 `handoffs` 一样只追加：

```sql
CREATE TABLE feature_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id INTEGER NOT NULL REFERENCES features(id),
  session_id TEXT,              -- 来源的总控 session；没有总控 session 时为 NULL
  trigger TEXT NOT NULL,        -- nightly | manual | command
  created_at INTEGER NOT NULL,
  payload TEXT,                 -- JSON，校验失败时为 NULL
  degraded INTEGER NOT NULL DEFAULT 0,
  raw_text TEXT,
  source_ref TEXT UNIQUE        -- /handoff 去重，同 handoffs
);
```

汇总的 schema（zod，`src/shared/` 下，和 `HandoffSchema` 并列）：

```ts
FeatureHandoffSchema = z.object({
  summary: z.string().min(1),          // 一段话：整体到哪了
  blockers: z.array(z.string()),       // 卡在哪；提到 ticket 时写 ticket 号
  next_steps: z.array(z.object({ ticket: z.string().nullable(), text: z.string() })),
  decisions: z.array(z.object({ key: z.string(), statement: z.string() })), // 跨 ticket 的约定，例如接口、错误码
  open_questions: z.array(z.string()),
});
```

`next_steps[].ticket` 必须是这个 feature 下的 ticket 号或 null；写了不存在的号时，保留文字，把 ticket 当成 null。

## 行为

### 晚间自动生成

- 放在晚间 handoff 批次的末尾：所有 ticket 的 handoff 都跑完（包括失败、跳过的）之后，再逐个跑 feature。
- **候选**：未归档的 feature，满足以下任一条件：
  - 它的总控 session 的 transcript 修改时间晚于这个 feature 上一次汇总；
  - 它下面有 ticket 在上一次汇总之后有了新的 handoff（包括这一轮刚生成的）。

  两条都不满足就跳过，节省公司额度。（我的决定）"新的 handoff"的口径：
  - 只算捕获到的有效 handoff，和 ticket 的 `lastCapturedAt` 一样不算 `refresh` 和 degraded。早间的 PR 刷新不触发重写；PR 从 open 变成 merged，PR 表自己会更新，汇总那段话不用跟着重写。
  - 总控的 `/handoff` 或"立即更新"顺带触发的子 ticket handoff，算在那一份汇总里面，不触发当晚再生成一次（否则每次 `/handoff` 都会多付一次钱）。具体怎么记这种关联留给实现者，例如给这些 handoff 打上来源 feature 汇总的 id，或者在汇总记录上记"子 ticket 跑完的时间"，候选规则拿它比较。
- **怎么跑**：和 ticket 一样用 headless claude 的 `--resume <总控 session> --fork-session`，选最近活动的、没被替换、没隐藏、有 transcript 的总控 session，cwd 是 feature 工作区，工作区外面的仓库目录加 `--add-dir`。没有可用的总控 session 时，不 resume，在工作区里直接跑，只依据 ticket 的 handoff 来写。
- **prompt** 包含：feature 名，上一次汇总的 JSON，每个未归档 ticket 的号、标题、状态、PR 状态和最新 handoff 里的 `done_today` / `next_steps` / `blockers`，输出 schema 和示例。按当前语言出中文或英文版（同 i18n 设计）。用 `--json-schema` 约束输出，zod 再校验一遍。校验失败就带着错误重试一次，还失败就存成 `degraded`。
- 公司额度用完或被限流时，和 ticket 批次一样不再发起，剩下的留到早间补跑。

### 手动"立即更新"

- feature 页上的按钮。先给这个 feature 下有活动的 ticket 跑 handoff（有活动的判断和晚间批次一样：session 的 transcript 修改时间晚于上一次 handoff），再按上面的方法生成汇总，trigger 记为 `manual`。
- 运行中按钮显示进度并禁用。同一个 feature 同时只跑一个，手动和晚间撞上时共用同一次运行（同 ticket 的 `once`）。

### 总控里的 `/handoff`

- `/handoff` 命令要让总控知道自己是 feature 总控，并输出 feature 汇总的代码块（和 ticket 的 `butler-handoff` 区分开，例如用 ` ```butler-feature-handoff `）。怎么判断留给实现者（见下文）。
- **以 Butler 的记录为准**：Stop 事件的 session 在库里是某个 feature 的总控（`sessions.feature_id` 不为空）时，按 feature 汇总处理；代码块的类型对不上时，当作没有输出（记日志），但下面"给子 ticket 跑 handoff"照样触发。
- 存进 `feature_handoffs`，trigger 记为 `command`，同一个代码块不重复入库（`source_ref`，同 ticket）。
- 然后在后台给这个 feature 下有活动的 ticket 各跑一次 handoff（规则同上）。这些 handoff 的 trigger 照 ticket 现有的手动触发记。
- 普通 ticket session 里的 `/handoff` 行为不变。

### 记忆

- 每存一份有效的汇总，就往 `feature:<id>` scope 写一次 StateCore `handoff`（summary、next_steps、open_questions），`decisions` 写成 note，按 key 取代，做法和 ticket 的记忆同步一样（`memory-service.ts`）。
- feature 归档时它的记忆照现在的规则处理，不另外动。

### feature 页

页面从上到下：

1. 标题、工作区路径（不变）。
2. **整体进度**（新）：
   - 汇总那段话；下面是"卡住"（醒目颜色），然后是"下一步"的列表，带 ticket 号的点了跳到那个 ticket；
   - 一行小字：生成时间和来源（晚间自动 / 总控 /handoff / 手动更新），以及"立即更新"按钮；
   - 还没有汇总时：提示"晚上会自动生成，也可以点'立即更新'"；
   - 最新一份是 degraded：显示原文，加"汇总不完整"的提示。
3. **ticket 表**（原 ticket 列表和 PR 状态合并）：每行是 ticket 号、标题、状态、每个 PR 一个标签（仓库名 #号，已合并 / 待 review / 要改 / 已关闭）、等待输入的点。没有 PR 时显示"还没有 PR"。点一行进 ticket 页。"+ 新建 ticket"留在这里。
4. 仓库、总控 session、终端（不变，往下挪）。

中英文文案都要有。

### 简报

（我的决定：用户很少看简报，改动从小。）

- **早间简报的优先级分区（先做 / 今天 / 留意）不变**，条目仍按分区和规则排序；属于 feature 的 ticket 条目前面加一个 feature 名的小标签。不在分区里按 feature 再分组，以免 feature 标题在每个分区重复。
- **"上个工作日"和晚间简报**（本来就是按 ticket 平铺的列表）：属于同一个 feature 的 ticket 归在一个 feature 标题下面，标题旁边放最新汇总的第一句话（没有汇总时只有 feature 名）。不属于 feature 的 ticket 照旧。
- 简报规则（什么时候出哪一条）不变。分组和标签只是展示，由渲染端按 ticket 的 `featureId` 算出来，还是写进 `BriefContent`，留给实现者；已经存下来的旧简报要能照常显示。

## 非目标

- feature 自己的状态，或完成百分比。
- feature 汇总的历史界面。
- 个人 API 的 LLM 润色使用汇总的文字。
- 把汇总推回 Jira 等 tracker。
- 改变 ticket handoff 的 schema 或内容。

## 留给实现者

- `/handoff` 怎么让总控知道自己是 feature 总控：一个命令文件里分两种情况写，用 feature 模式的 `butler-sessions` 才有的 `list_tickets` 工具当信号，或者给总控终端加一个环境变量再用别的方式读出来，选可靠的那种。改了命令正文就要更新命令版本，让"过期"检测提示用户更新。
- 迁移的具体写法、repo 和 IPC 的形状、feature 页的样式细节（照现有 ticket 页的风格）。
- 子 ticket handoff 和 feature 汇总的并发（在现有并发上限内）。

## 测试

- 单测：迁移 8；`FeatureHandoffSchema` 和 degraded；候选规则（总控有活动、只有子 ticket 有新 handoff、都没有就跳过）；晚间批次的顺序（ticket 先跑完再跑 feature）；没有总控 session 时不 resume；`/handoff` 的归属（总控 session 存成 feature 汇总，代码块类型对不上时不存、但触发子 ticket handoff；普通 session 不变）；`next_steps` 里不存在的 ticket 号；记忆写入；简报按 feature 分组。
- E2E：建 feature 和两个 ticket → 开总控 → 假 claude 在总控里输出 `/handoff` 的 feature 代码块 → feature 页显示汇总，ticket 表显示 PR 状态 → 子 ticket 的 handoff 被触发；"立即更新"按钮走通。
