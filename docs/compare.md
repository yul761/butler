# Compared with running sessions side by side

**English** | [简体中文](compare.zh-CN.md)

Running several Claude Code sessions side by side, each in its own git worktree, is common now. Claude Code's own desktop app does it, and so do tools such as Conductor and Claude Squad. Butler runs sessions that way too. The difference is what it looks after: those tools manage sessions, and Butler manages the work.

## Claude Code's desktop app already runs sessions in parallel. What does Butler add?

With parallel sessions alone, you are the coordinator. You split the work, write a prompt for each session, watch every terminal for a question, carry decisions from one session to the next, and work out which PR should merge first. Butler takes those jobs over:

- **It splits the work.** You describe an epic to its coordinator, a Claude Code session that sees every ticket of the epic. The coordinator creates the tickets, sorts them into features that are worked on in order, opens a session in each ticket, each in its own worktree, and hands it its task.
- **It lands the PRs in order.** Features go one at a time, and features that don't depend on each other run at the same time. The merge coordinator holds back a merge that would conflict with another ticket's branch in the same repo, and stacked branches are tracked as a stack.
- **Sessions share memory.** A convention one session saves, such as the API contract between frontend and backend, goes into the epic's memory, and the other running sessions of the epic get it in their mailbox. When a session's context grows too long, Butler has it write a handoff, clears it and lets it carry on from memory.
- **It calls you only when it's your turn.** A question asked with `ask_user`, a permission prompt, a PR ready to merge, a review requested from you, a session that is really stuck: each one becomes a card on the **Your turn** page. A reply such as "Shall I continue?" doesn't.
- **It keeps track for you.** Each ticket shows whose turn it is (yours, an agent's, or CI's or a reviewer's), the stages of its PRs, and a status your own `claude` writes each night.

## Side by side

| | Sessions side by side | Butler |
|---|---|---|
| What you hand over | A prompt per session | An epic, which the coordinator splits into tickets |
| Who opens the sessions | You | The epic coordinator, or you |
| Decisions shared between sessions | You copy them across | Epic memory, delivered to the running sessions |
| Where questions wait | In each terminal | On the **Your turn** page |
| Merge order and conflicts | You work them out | Features in order; the merge coordinator holds back collisions |
| A session that ran too long | You start a new one and explain again | Handed off, cleared and resumed from memory |
| Knowing where things stand | Read the terminals | Whose turn, PR stages, nightly status |

Every session is still a real Claude Code terminal. You can watch it, type into it and take it over at any time.

## How much it does on its own

**Settings › Automation** has a level. **Manual**, the default, does nothing outside on your behalf. **Semi-automatic** passes PR comments to the session, reruns a flaky CI failure once, rebases and pushes stacks, pre-reviews PRs and starts intake work on its own. An epic can pick its own level in its page header. Merging always needs your click, and every outward action is recorded on the **Audit** page. See [Automation level](configuration.md#automation-level).

## What Butler doesn't do

- It works with Claude Code only.
- It calls no model of its own. Every model call is your own `claude`, under your login and settings.
- It doesn't merge for you. Merging is always your click.
- It runs on macOS (Apple silicon) and Windows. There is no Linux build yet.

More on each part in [How Butler works](how-it-works.md).
