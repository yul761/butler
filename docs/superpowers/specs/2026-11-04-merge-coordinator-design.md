# 合并总控（设计）

来源：2026-11-04 用户反馈。用户同时在做一个 epic（下面几个 feature）和一个不在这个 epic 里的 feature，两边都在同一对前后端仓库里改代码。epic 里面的记忆互通，但 epic 和这个独立 feature 之间不通，谁也不知道对方在做什么。用户担心两边合并时撞车、造成代码混乱。现在只能自己去告诉每个 session“另外还有谁在做什么”，这部分沟通应该由 Butler 来做。

用户还没真的撞上过，这是提前防。

## 用户确认的决定

- **只管会互相影响的动作**。各自在独立的 worktree、branch 上写代码、commit、跑测试、push，总控都不管，这个阶段 session 不给总控发任何消息。
- **到了那个动作的时刻才发请求**，比如 session 要 merge 了。总控审核后回复，决定 session 能不能继续。
- **只管 git 看得见的撞车**：合并冲突（两边改了同一个文件的同几行），以及同一个目录、同一个 branch 被两边抢。合并后能编译、行为对不对（比如一边改了接口字段名，另一边新代码还在用旧名字）不归总控管，交给 CI。CI 报了问题，用户自己去对应的 feature 或 epic 里解决。
- **总控自己定顺序，事后告诉用户**。用户需要特定顺序时会明确说。
- **被要求等的 session 照常写代码**，只把合并那一步压着，等前面的合完再合。
- 范围是所有 Butler 打开的 session：epic、feature 总控、ticket 的各个 session，不管属不属于同一个 epic 或 feature。

## 我的决定（用户没有逐条确认）

### 总控是谁

- **总控是 Butler 主进程，不是一个 Claude session，也不经过记忆。** 用户说的是“往 Butler 最中央的记忆发消息，由最高级总控协调”。我的理解是用户要的是“一个看得到所有 session 的地方来裁决”。会不会冲突，git 自己能准确算出来（`git merge-tree --write-tree`，不动工作区），不用让模型猜。Butler 的数据库里有每个 ticket 用的仓库、branch、工作方式和 worktree，同一个仓库的所有 worktree 共用一套 ref，所以主进程手里已经有裁决需要的全部信息。这样回复快（秒级）、结果确定、不花额度，Butler 没开着时也不会把 session 卡死（见下面的“失败时放行”）。
- 记忆（`butler-workspace` 等）这一版不动。

### 什么时候发请求

- **请求由 hook 发，不靠 Claude 记得去问。** Butler 给自己打开的每个交互 session 写一份 `--settings` 文件（`src/main/claude/project-mcp.ts`、`session-service.ts`），在里面加一个 `PreToolUse` hook，只匹配 Bash 工具。用户全局的 `~/.claude/settings.json` 不加这一条，Butler 之外的 claude 不受影响。
- hook 只在命令属于下面的“要审核的动作”时才去问总控，其余命令立刻放行，不发任何东西。
- **要审核的动作**：
  1. **合并进目标分支**：`gh pr merge`（包括 `--auto`，目标是这个 PR 的 base 分支，不一定是默认分支，比如 `develop`）；在目标分支上执行的 `git merge`（目标就是当前分支）；`git push` 直接推到默认分支或别的 ticket 的 PR 正在指向的分支（这也等于合并进去了。只推自己的 branch 不算）。下文的“目标分支”都指这一次合并要进的那个分支。
  2. **在共用目录里切换或新建 branch**：ticket 的工作方式是“branch”（不走 worktree，直接在仓库原来的目录里切），并且同一个仓库目录正被另一个还开着 session 的 ticket 占着。这时的 `git checkout`、`git switch` 要审核。在自己的 worktree 里切换、新建 branch 不审核。
- Butler 自己在共用目录里切 branch 只有一处：打开“branch”工作方式的 session 时，如果目录当前不在这个 ticket 的 branch 上，会弹“要不要切换 branch”（`session-service.ts` 调 `ticketService.checkBranch`，确认后 `TicketPage.tsx` 调 `switchBranch`）。`prepareRepo`、`moveWork` 只建 branch 或摘 worktree，不切共用目录，不用管。这一处是用户自己点的，所以**不拦，只提醒**：目录正被另一个开着 session 的 ticket 用着时，切换提示里写明“这个目录正被 X 用着（branch Y），切过去会影响它”，用户仍然可以确认切换。判断规则和 session 的审核共用同一份代码。
- 命令的识别交给构建者，但要满足：常见写法都能认出来（带 `cd … &&` 前缀、`gh pr merge 12 --squash`、`git -C <dir> merge` 等）；认不准的宁可放行，不能误拦普通命令。

### 怎么裁决

- **合并**：先看要合并的 branch 和最新的目标分支本身合不合得进去（`git merge-tree`）。合不进去（通常是另一边已经先合了），**不放行**，回复“先 rebase 到最新的目标分支、解决冲突再合”，并附上下面“给 session 的话”里的提醒。合得进去，再拿它和同一个仓库里其他所有还在进行中、目标分支相同的 ticket 的 branch 逐个做 `git merge-tree`。“进行中”指 ticket 没归档、它的 branch 还没合并进目标分支，跨 epic、feature、独立 ticket 都算。
  - 和谁都不冲突：放行。
  - 和某个 branch 冲突，但那一边还在写代码，没有走到合并：**放行，先到先得**。准备好的一方先合，不让它等一个还没写完的。Butler 记下“另一边之后要 rebase”，等那一边来合并时在回复里告诉它（见下面的“给 session 的话”）。
  - 和某个 branch 冲突，而那一边已经拿到了合并许可、还没合完（**合并占位**）：**这次不放行**，回复“先等 X 合完”。
  - **占位跟着真正的合并走**，不按固定时间：
    - 本地 `git merge`、直接 push：命令执行完就结束（用 `PostToolUse` hook 得知）。成功就算合完；失败就直接释放占位，不发“X 已经合完”。
    - `gh pr merge`：合并发生在 GitHub 上，可能是 `--auto`、合并队列或者要等检查跑完，几分钟到几小时以后才真的合进去。占位一直保持到 Butler 看到这个 PR 已经合并（之后释放并通知等待的一方），或者 PR 被关掉、自动合并被取消（释放，不发“已经合完”）。Butler 用 `gh pr view` 定期查这些占位中的 PR，只查占位中的，不查别的。
    - 兜底：`gh` 查不了（没装、没登录、没网）时，占位最多保留 2 小时，到时作废，防止一边被永远卡住。
  - 合并前先 `git fetch` 目标分支，用最新的结果来算。fetch 失败（没网）就用本地已有的，不因为 fetch 失败拦人。
- **共用目录**：目录正被另一个开着 session 的 ticket 占着时，不放行，回复“这个目录正被 X 用着（branch Y）”。目录没人占，或者占着的 ticket 已经没有开着的 session 了，就放行。

### 回复和之后的事

- hook 用 Claude Code 的 `PreToolUse` 决定：放行时什么都不说；不放行时用 `deny` 加原因。原因写给 Claude 看，让它知道怎么做（下一节）。
- **等待中的 session 不用一直重试**：前面那一边真的合完以后（见上面“占位跟着真正的合并走”），Butler 用现有的 `PtyManager.deliver` 往等待的 session 里发一条消息：“X 已经合完，现在可以 rebase 后再合并”。session 正在忙（没有停在等输入）时，等它停下来再发，不打断它手上的事。
- **失败时放行**：Butler 没开着、请求超时（5 秒内没有回复）、hook 自己出错，一律放行，并在 Butler 日志里记一笔（Butler 开着的话）。总控是防混乱的辅助，不能变成 session 合不了代码的原因。这和现有 hook “绝不阻塞 Claude Code”的原则一致（`hook/entry.ts`）。

### 给 session 的话

- 不放行时说清楚：和谁撞了（ticket 号、它属于哪个 feature 或 epic）、撞在哪些文件、现在怎么做（先继续写别的，不要合并，等 Butler 通知）。
- 放行时什么都不说。先合的那一边不知道、也不用知道后面还有人要 rebase。
- 后合的那一边来合并、和目标分支合不进去时（上面的“先 rebase”），回复里写明冲突来自哪个 ticket 已经合进去的改动（ticket 号、属于哪个 feature 或 epic、哪些文件），提醒它解决冲突时两边的意图都要保留，不要直接用自己的版本覆盖掉对方的。

### 告诉用户

- 每次判断出冲突（不放行，或者放行了但另一边之后要 rebase），都发一条系统通知，并在首页（brief 页）留一条记录：哪个仓库、谁和谁、定的顺序。点通知进对应的 ticket 页。
- 放行、不冲突的请求不通知、不记首页，只记日志。
- 记录要存进数据库，Butler 重启后还在，占位和“之后要 rebase”的状态也要能在重启后接上。

### 界面

- 这一版不加新页面。只有通知和首页记录。

## 不做的事

- 不检查合并后代码能不能编译、行为对不对，那是 CI 的事。
- 不在写代码的阶段做任何协调，也不往别的 session 里推“对方在做什么”。
- 不管 Butler 之外打开的 claude 或者用户自己在终端里的 git 操作。
- 不让模型判断冲突。
- 不自动帮 session 解决冲突、不自动 rebase。

## 留给构建者

- `PreToolUse` hook 是复用现有的 `butler-hook` 程序（加一个同步的问答模式），还是单独打一个小程序。两种都要满足失败时放行、不拖慢普通命令（不需要审核的命令不能有可感知的延迟）。
- hook 和主进程之间的问答通道：可以复用 `src/main/control/control-inbox.ts` 的“请求文件 → 同名结果文件”机制，也可以换别的，只要 Butler 不开着时能立刻判断出来并放行。
- 命令识别的具体规则和测试用例。
- “分支进了目标分支”的判断方式（`git branch --merged`、对比 merge-base、`gh pr view` 的状态等），以及占位中的 PR 多久查一次。
- 合并命令里目标分支怎么得到（`gh pr view --json baseRefName`、当前分支等）。
- 首页记录的样式，跟现有的 brief 页保持一致；中英文文案两套都要有（`strings.ts`、`strings-en.ts`）。
- e2e 用假 claude 模拟：两个 ticket 在同一个仓库里改了同一行，一个先拿到合并许可，另一个被拦住，前一个合完后另一个收到通知。
