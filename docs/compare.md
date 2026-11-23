# Compared with running sessions side by side

**English** | [简体中文](compare.zh-CN.md)

Running several Claude Code sessions side by side, each in its own git worktree, is common now. Claude Code's own desktop app does it, and so do tools such as Conductor and Claude Squad. Shipherd runs sessions that way too. The difference is what it looks after: those tools manage sessions, and Shipherd manages the work.

## Claude Code's desktop app already runs sessions in parallel. What does Shipherd add?

With parallel sessions alone, you are the coordinator. You split the work, write a prompt for each session, watch every terminal for a question, carry decisions from one session to the next, and work out which PR should merge first. Shipherd takes those jobs over:

- **It splits the work.** You describe an epic to its coordinator, a Claude Code session that sees every ticket of the epic. The coordinator creates the tickets, sorts them into features it works through in order, opens a session in each ticket, each in its own worktree, and hands it its task.
- **It keeps merges from colliding.** The coordinator is told to push the features forward one at a time, running features that don't depend on each other at the same time. When a session Shipherd opened is about to merge (`gh pr merge`, `git merge` or a push to the target branch), Shipherd checks with git whether it conflicts with another ticket's branch in the same repo: the first merge goes ahead and the other ticket is told to rebase, and a merge that conflicts with one already under way waits for it. Merges you click on GitHub or run in your own terminal aren't checked. Stacked branches are tracked as a stack.
- **Sessions share memory.** A convention one session saves, such as the API contract between frontend and backend, goes into the epic's memory, and the other running sessions of the epic get it in their mailbox. When a session's context grows too long, Shipherd has it write a handoff, clears it and lets it carry on from memory.
- **It calls you only when it's your turn.** A question asked with `ask_user`, a permission prompt, a PR ready to merge, a review requested from you, a session that is really stuck: each one becomes a card on the **Your turn** page. A reply such as "Shall I continue?" doesn't.
- **It keeps track for you.** Each ticket shows whose turn it is (yours, an agent's, or CI's or a reviewer's), the stages of its PRs, and a status your own `claude` writes each working day.

## Side by side

| | Sessions side by side | Shipherd |
|---|---|---|
| What you hand over | A prompt per session | An epic, which the coordinator splits into tickets |
| Who opens the sessions | You | The epic coordinator, or you |
| Decisions shared between sessions | You copy them across | Epic memory, delivered to the running sessions |
| Where questions wait | In each terminal | On the **Your turn** page |
| Merge order and conflicts | You work them out | Features in order; the first merge goes ahead, the other is told to rebase |
| A session that ran too long | You start a new one and explain again | Handed off, cleared and resumed from memory |
| Knowing where things stand | Read the terminals | Whose turn, PR stages, a status each working day |

Every session is still a real Claude Code terminal. You can watch it, type into it and take it over at any time.

## Tools built around issues or a board

Some tools start from the work rather than the sessions, as Shipherd does:

- **[CCPM](https://github.com/automazeio/ccpm)** (MIT) is a set of Agent Skills that runs inside Claude Code or another agent harness. It turns a PRD into an epic, tasks and GitHub issues, keeps GitHub Issues as the source of truth, and works an epic in its own git worktree with parallel agents, each scoped to its own files. The plan lives in your GitHub repo and you drive it from the agent's chat. Shipherd keeps the plan in the epic coordinator and its local memory, gives every ticket its own session and worktree, and adds the **Your turn** page and the merge check.
- **[Vibe Kanban](https://github.com/BloopAI/vibe-kanban)** (Apache-2.0) is a kanban board for planning work: when you are ready, you create workspaces from it, each with its own branch, where a coding agent runs (Claude Code, Codex, Gemini CLI and others). bloop, the company behind it, shut down in April 2026; the project continues as open source, maintained by its community. In Shipherd you talk the plan through with a coordinator, which creates the tickets and opens the sessions.

## How much it does on its own

**Settings › Automation** has a level. **Manual**, the default, does nothing outside on your behalf. **Semi-automatic** passes PR comments to the session, reruns a flaky CI failure once, rebases and pushes stacks, pre-reviews PRs and starts intake work on its own. An epic can pick its own level in its page header. The individual switches are under **Settings › Advanced › Outward actions**. Shipherd never merges on its own, and every outward action is recorded on the **Audit** page. See [Automation level](configuration.md#automation-level).

## What Shipherd doesn't do

- It works with Claude Code only.
- It has no model of its own. Every model call, including Shipherd's background checks and handoffs, is your own `claude`, under your login and settings.
- It never merges on its own. A merge is your click on GitHub, or your yes when a session asks to run `gh pr merge`.
- It runs on macOS (Apple silicon) and Windows. There is no Linux build yet.

More on each part in [How Shipherd works](how-it-works.md).
