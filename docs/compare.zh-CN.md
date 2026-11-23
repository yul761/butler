# 和并排开几个 session 有什么不同

[English](compare.md) | **简体中文**

同时开好几个 Claude Code session、每个跑在自己的 git worktree 里，现在已经很常见：Claude Code 官方桌面版能做，Conductor、Claude Squad 这类工具也能做。Shipherd 也这样跑 session。区别在于它管的是什么：这些工具管的是 session，Shipherd 管的是活。

## Claude Code 桌面版也能并行开 session，Shipherd 多了什么？

只有并行的 session 时，总控就是你自己：你来拆活，给每个 session 写提示词，盯着每个终端看有没有在问你，把一个 session 里定下的事带给下一个，还要想清楚哪个 PR 先合。Shipherd 把这些活接过去：

- **它来拆活。** 你把一个 epic 讲给它的总控听。总控是一个能看到这个 epic 所有 ticket 的 Claude Code session。它建好 ticket，分进 feature 按顺序推进，在每个 ticket 里开一个 session，每个 session 有自己的 worktree，再把任务派下去。
- **合并不撞车。** 总控按要求一次推一个 feature，互不依赖的 feature 同时推。Shipherd 开的 session 要合并时（`gh pr merge`、`git merge` 或推到目标分支），Shipherd 用 git 检查它和同一个仓库里别的 ticket 的分支冲不冲突：先合的放行，另一个 ticket 会被告知要 rebase；和一个正在进行的合并冲突时，要等那个合完。你在 GitHub 网页上点的合并、在自己开的终端里跑的合并，都不经过这道检查。叠在一起的分支按栈来管。
- **session 共享记忆。** 一个 session 记下的约定，比如前后端之间的 API 约定，存进 epic 的记忆，这个 epic 里其他正在跑的 session 会在信箱里收到。session 的上下文太长时，Shipherd 让它先写交接、清空，再从记忆里接着做。
- **轮到你才叫你。** 用 `ask_user` 问你的问题、权限确认、可以合并的 PR、请你 review 的 PR、真的卡住了的 session：每一件都是 **轮到你** 页上的一张卡片。"要我继续吗？"这种回复不算。
- **它替你记着进度。** 每个 ticket 都显示现在轮到谁（你、agent，还是 CI 或某位 reviewer）、它的 PR 走到了哪个阶段，以及你自己的 `claude` 每个工作日写的一份状态。

## 对照

| | 并排开几个 session | Shipherd |
|---|---|---|
| 你交出去的是 | 每个 session 一条提示词 | 一个 epic，由总控拆成 ticket |
| 谁来开 session | 你 | epic 总控，或者你 |
| session 之间定下的事 | 你自己抄过去 | 存进 epic 记忆，送到正在跑的 session |
| 问题在哪儿等你 | 各个终端里 | **轮到你** 页上 |
| 合并顺序和冲突 | 你自己理 | feature 按顺序推；先合的放行，另一个被告知要 rebase |
| 跑太久的 session | 开个新的，从头再讲一遍 | 写交接、清空，从记忆里接着做 |
| 想知道进展 | 一个个看终端 | 轮到谁、PR 阶段、每个工作日一份状态 |

每个 session 仍然是一个真正的 Claude Code 终端，你随时可以看、可以打字、可以接手。

## 以 issue 或看板为中心的工具

也有工具和 Shipherd 一样，从活出发，而不是从 session 出发：

- **[CCPM](https://github.com/automazeio/ccpm)**（MIT）是一组 Agent Skills，跑在 Claude Code 或别的 agent 环境里。它把 PRD 变成 epic、任务和 GitHub issue，以 GitHub Issues 为准，一个 epic 在自己的 git worktree 里由几个并行的 agent 来做，每个 agent 只管自己的文件。计划存在你的 GitHub 仓库里，你在 agent 的对话里推动它。Shipherd 的计划在 epic 总控和本地记忆里，每个 ticket 有自己的 session 和 worktree，另外还有 **轮到你** 页和合并检查。
- **[Vibe Kanban](https://github.com/BloopAI/vibe-kanban)**（Apache-2.0）是一个规划工作的看板：准备好了，你从看板上建 workspace，每个 workspace 有自己的分支，在里面跑一个编程 agent（Claude Code、Codex、Gemini CLI 等）。它背后的公司 bloop 已于 2026 年 4 月关闭，项目以开源形式继续，由社区维护。在 Shipherd 里，你和总控把计划商量好，由它建 ticket、开 session。

## 它自己做多少

**设置 › 自动化** 里有档位。**手动** 是默认的，不替你往外做任何事。**半自动** 会把 PR 评论转给 session、不稳定的 CI 失败重跑一次、栈自动 rebase 并推送、开 PR 前预审、自动接活直接开工。epic 可以在自己页面的标题旁边另选一档。具体的开关在 **设置 › 高级 › 对外动作** 里。Shipherd 从不自己合并，对外动作都记在 **审计** 页上。详见[自动化档位](configuration.zh-CN.md#自动化档位)。

## Shipherd 不做的事

- 只支持 Claude Code。
- 自己没有模型。所有模型调用，包括 Shipherd 后台的检查和 handoff，都是你自己的 `claude`，用你的登录和设置。
- 从不自己合并。合并要么是你在 GitHub 上点，要么是 session 要跑 `gh pr merge` 时你点了同意。
- 支持 macOS（Apple silicon）和 Windows，还没有 Linux 版。

各部分的细节见 [Shipherd 是怎么工作的](how-it-works.zh-CN.md)。
