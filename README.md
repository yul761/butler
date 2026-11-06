# Butler

A desktop "work butler" for people who run several [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions at once, one per ticket.
macOS (Apple silicon) and Windows (x64). MIT licensed.

**Local-first.** Butler keeps its data in local SQLite files. Data leaves your machine only through your own `claude` and, if you configure one, a personal LLM API. That API is called only at the full privacy level, for memory distillation, and every call it receives is logged on an audit page.

> 中文简介：Butler 用一个桌面应用管理“每个 ticket 一个 Claude Code session”的工作方式：每晚自动为有进展的 ticket 生成交接（handoff），点一下就回到对应的 session；记忆由本地的 StateCore 管理。界面有中文和英文两种，默认跟系统语言，可以在设置里改。

The UI comes in Chinese and English. It follows your system language at first (Chinese for any Chinese locale, English otherwise); change it under **设置 → 常规 → 语言 / Language (Settings → General → Language)** or on the first-run wizard. The language also switches the default prompts Butler sends to `claude`, so handoffs and memory notes are written in that language; prompts you edited yourself are kept. Installs upgraded from 1.2.0 or earlier stay in Chinese until you change it. After switching, click **安装 / 修复 (Install / repair)** in the environment check once so the `/handoff` command is rewritten in the new language. This README quotes UI labels as they appear in the Chinese UI, with the English label, for example **设置 (Settings)**.

## What it does

- **Tickets first.** Each ticket has its worktree or branch, its Claude Code sessions (embedded terminals), its PR state and its after-merge follow-ups. Sessions you started outside Butler in the last 7 days show up under **未认领 session (unclaimed sessions)**, so you can attach them to a ticket. A ticket can span several repos (say, a frontend and a backend): create it with or without a repo, then add more on the ticket page. Each repo has its own work mode and branch, and **编辑 (Edit)** changes them later. A new session asks which repo to work in. A running session, including one a coordinator started, has an × next to its button: click it twice to end that session. Its conversation is kept, and clicking the button opens it again. A session that is not running can be hidden with the same ×. It only leaves the list (its conversation is kept), and **已隐藏 (hidden)** brings it back. Sessions that Butler opens do not stop at Claude Code's question about which servers from a repo's `.mcp.json` to enable: Butler enables them, except the ones you turned off in that repo before. A **总控 (coordinator)** session runs in the ticket's workspace folder (`~/.butler/workspaces/<ticket>`) and sees every repo through `--add-dir`. All sessions of a ticket share its memory. The coordinator also gets a `butler-sessions` MCP server with five tools:
- `list_repos` lists the ticket's repos.
- `start_session` opens a new session in one repo and sends it a task as its first message. The new session appears under the same ticket, where you can watch it, take over and answer its permission prompts.
- `list_sessions` shows what each session is doing.
- `session_activity` shows one session's activity plus its last command output (up to 4 KB).
- `end_session` closes a session of the ticket that is done, the same as clicking its ×. It refuses a session that is still working, one showing a prompt that waits for you, one that isn't running, and the caller itself.

There are deliberate limits:
- **Communication:** the coordinator cannot type into other sessions. Sessions coordinate through the shared ticket memory.
- **Session cap:** at most 6 terminals per ticket run at once. Archived tickets are listed under **已归档 (Archived)**, where you can restore them. In the terminal on Windows, Ctrl+V and right-click paste, and Ctrl+C copies when text is selected.
- **Features: several tickets, one workspace.** A feature has a name and groups tickets, say two frontend and two backend tickets, each with its own Jira id and branch. Create it with **+ 新建 feature (new feature)**. When asked for a repo you can pick the folder that holds your repos, such as `~/Code/shop` with `frontend/` and `backend/` inside. Butler lists the repos one level down and you tick the ones you want. Picking a parent folder works the same way when you create a ticket or add a repo. Every ticket in a feature gets its worktrees inside the feature's workspace, `<parent>-features/<feature name>` next to the parent folder by default, for example `~/Code/shop-features/checkout/frontend-dms-1234`. That way several tickets in one repo can be worked on at the same time. A feature's **总控 (coordinator)** session runs in the workspace and sees every ticket's worktree. Its `butler-sessions` server offers:
  - `list_tickets`, which lists the feature's tickets and their repos;
  - `list_repos`, which lists the feature's repos;
  - `create_ticket`, which creates a ticket in the feature (its id, an optional title, the repos it uses and an optional branch), with its worktrees in the workspace. The ticket shows up in Butler right away. So you can talk the feature through with the coordinator, let it create the tickets, and then let it start a session in each one;
  - `start_session`, which opens a session in a ticket (naming the repo only when the ticket has several) and sends it a task;
  - `list_sessions`, which shows the sessions of the coordinator and of every ticket, with what each is doing;
  - `session_activity`, which shows one session's activity plus its last command output (up to 4 KB);
  - `end_session`, which closes a finished session of a ticket in the feature, or one of the feature's fix sessions (not the coordinator itself). It refuses under the same rules as the ticket coordinator's.

  A feature runs at most 8 terminals at once. All its sessions also share a feature memory, `butler-feature`, for things like the API contract between frontend and backend. A `claude` you open yourself in the workspace folder counts as the feature's coordinator. Archiving a feature archives its tickets too; restoring it brings back the tickets archived with it.

  The feature page starts with **整体进度 (Overall progress)**: a summary across the feature's tickets, with what is in the way and what comes next, followed by a table of the tickets and their PRs. The summary is written by the nightly run for features with new activity, by `/handoff` in the coordinator, or when you click **立即更新 (Update now)**. It never shows a completion percentage. Overall progress and the ticket table both collapse with the triangle in front of their titles; collapsed, the progress shows only the start of the summary and how many things are in the way. However much is above it, the terminal keeps at least half of the window's height.

  The ticket table's status column shows what each ticket's running session is doing right now, refreshed every 10 seconds: writing code (and which file), reading code, running `git push` with its pre-push hook, watching CI, running tests or another command (with how long it has been running), thinking, waiting for your approval, or waiting for your reply. A command still running after the turn ended is marked **后台 (Background)**. A ticket with no running session shows its usual status, and a ticket with several shows the session that needs you most. Tickets outside a feature don't have this column yet.

  **Stuck sessions.** There is no fixed time limit, so a slow pre-push hook that is still working is left alone. Every 3 minutes Butler looks at each running session of a ticket in a feature. If the transcript, the command output and the CPU use of the session's child processes have not changed for two checks in a row, Butler asks your own `claude` once, with no tools, whether the session is really stuck. It sends the current activity, the last command output and the end of the terminal. If the answer is yes, a red dot appears on the ticket's row and on the feature in the sidebar. There is no system notification. Click the dot to open a panel under the row with the likely cause, the last output and what to do:
  - **开新 session 解决 (Open a new session to fix it)** opens a new session in the feature's workspace and hands it the details. The stuck session is left running, and the two share its worktree, so the new session's task says to tell the stuck session before changing a branch or stopping a process, to ask you before killing anything, and to tell the coordinator when the problem is solved.
  - **看终端 (View terminal)** goes to the ticket page.
  - **没事，忽略 (It's fine, ignore)** clears the dot. It comes back only if the session moves again and then gets stuck again.
  - **收起 (Collapse)** closes the panel. The dot stays, and clicking it reopens the panel.

  The dot also clears by itself when the session has new activity. Nothing is fixed without your click, and stuck marks live in memory, so Butler checks afresh after a restart.
- **Epics: several features, one plan.** An epic groups features that belong together and passes progress, decisions and open questions from one feature to the next, so no session has to write a document for the next one to read. A feature doesn't have to belong to an epic. Create an epic with **+ 新建 epic (New epic)**, giving a name and its repos. Its workspace is `<parent>-epics/<epic name>` by default, next to your repos. Features keep their own workspaces.

  From plan to work:
  1. On the epic page, open an **epic session (Epic session)**. It runs in the epic's workspace and can read every repo of the epic. Talk through what to build and how to split it into features.
  2. When a feature is settled, the epic session creates it with `create_feature`. It passes a name, the repos the feature uses (chosen from the epic's repos, and optional when the epic has one) and a short plan of up to 4,000 characters: what to build, why, and what is already decided. Tickets are not created here.
  3. The feature appears on the epic page and under the epic in the sidebar, and its plan shows as **规划 (Plan)** on the feature page. Butler does not open a coordinator for it.
  4. Click into the feature and open its coordinator. The first time, Butler sends the plan as the coordinator's first message, which you can see in the terminal. With it come the name, status, latest progress, blockers, decisions and open questions of the epic's other features, archived ones included and marked as archived. The message tells the coordinator that all of this is data, not instructions. If it is too long, only the data is cut. Resuming a coordinator or opening another one does not send it again. A feature with no plan, such as one you moved in, gets no such message.
  5. The coordinator creates tickets and starts sessions, the same as in any feature.

  The epic session's `butler-sessions` server offers `list_features`, `list_repos`, `create_feature`, `list_sessions`, `session_activity` and `end_session`. `list_sessions` and `session_activity` also show each session's last reply. `end_session` closes a finished session of a feature in the epic that is not archived: its coordinator, a fix session, or a session of one of its tickets. It never closes the epic session itself, and it refuses under the same rules as the ticket coordinator's. A coordinator of a feature in an epic also gets `epic_context`, which shows the other features of its epic. Both read Butler's latest data, so a session doesn't have to rely on what it was told at the start.

  The epic page has one row per feature: the first sentence of its summary and a status (a ticket is stuck, waiting for you, not started, or in progress). Click a row for the details; tickets are only listed on the feature page. Archived features are folded under **已归档 (Archived)**. Below the rows are the repos, the epic sessions and a terminal that keeps at least half of the window's height. In the sidebar, the Epics group sits above Features and each epic collapses. The waiting mark and the red dot travel up from ticket to feature to epic, and stay visible when the epic is collapsed.

  **移到 epic (Move to epic)** in a feature's header moves an existing feature into an epic, out of it, or to another epic. Only where the feature belongs changes: its workspace and worktrees stay put. Repos the epic doesn't have yet are added to it, and moving a feature out removes none. A session already running sees the epic's memory after you reopen it.

  Archiving an epic archives its features and their tickets. Butler refuses while a terminal of the epic, its features or their tickets is running, and then nothing changes. Restoring the epic brings back what was archived with it. A feature you archived separately stays archived, but still counts: the next feature's coordinator reads about it.

  An epic has no summary of its own: no nightly run, no completion percentage, and `/handoff` in an epic session stores nothing. Keep planning decisions in the epic's memory (see [StateCore memory](#statecore-memory)). Stuck checks don't watch epic sessions. A `claude` you open yourself in the epic's workspace counts as an epic session.

  **Epics use more of your Claude quota.** So that the next feature reads fresh progress, Butler runs your own `claude` in the background at two more moments, on top of the nightly run:
  - **When you archive an epic, or a feature in one.** Each feature with activity since its last summary first gets a new summary, and its tickets with activity get a handoff. The archive button says so while this runs. All of it shares a limit of 2 minutes, and if a summary fails or runs out of time, the archive goes ahead anyway and Butler logs it.
  - **When an epic session calls `create_feature`.** The other features of the epic that are not archived get the same refresh in the background. `create_feature` doesn't wait for it.

  The first message to a coordinator also starts a turn as soon as the coordinator opens.
- **Merge coordinator.** When two tickets in the same repo are about to collide, Butler steps in before the merge. It watches the sessions it opens, whichever epic, feature or ticket they belong to, and checks only merges into a target branch and branch switches in a shared folder. It uses git to tell whether the branches conflict and holds a merge back until the conflicting one has landed. Details are in [Configuring Butler](docs/configuration.md#merge-coordinator).
- **Ending finished sessions.** A coordinator or epic session can close a session that has stopped and waits for input, using `end_session`. It refuses a session that is working, one waiting for your answer, and itself.
- **Worktree cleanup after merge.** Once a handoff reports that a ticket's PR is merged, Butler removes that ticket's worktrees with `git worktree remove`. The branch is kept, and opening a session there again rebuilds the worktree. Butler does not remove a worktree that has uncommitted changes or untracked files, or one whose own session is still running in a terminal. In that case the ticket page shows why, with a **重新检查 (check again)** button, and Butler tries again when that terminal exits. Files ignored by `.gitignore` (`node_modules`, a local `.env`) are removed with the worktree.
- **Nightly handoffs.** At a time you choose, Butler asks your own logged-in `claude` to write a structured handoff for every ticket that had activity.
  - `Edit`, `Write` and `NotebookEdit` are always denied.
  - Butler allows file reads, `gh pr view`, `gh pr checks`, `git log`, `git status` and the tracker MCP tools you picked.
  - Any other permission comes from your own Claude Code settings: the user-level allow rules (the runs use `--setting-sources user`) and any managed policy settings.
  - These runs are not strictly read-only. If your settings allow, say, `Bash(npm:*)` or a write-capable MCP tool, the runs can use it too.

  Inside a session you can also type `/handoff`. In a feature's coordinator, `/handoff` writes the feature's summary instead of a ticket handoff, and Butler then runs handoffs in the background for the feature's tickets that had activity since their last one.
- **Home page.** The **现在 (Now)** page lists every session Butler opened, grouped by epic, feature and ticket, with what each one is doing, its PR and CI, and how long it has been at it. Sessions waiting on you (a question, a confirmation, or stuck) are pinned at the top under **需要你 (Needs you)**, and the sidebar entry shows how many there are. Click a row to open its terminal.
- **Keep awake.** When sessions should keep running while you're away with the lid open, tick **防止休眠 (Keep awake)** at the bottom of the sidebar or in the tray menu. While it's on, the computer doesn't sleep when idle and the screen stays on. It turns off when you untick it, when the computer goes to sleep (closing the lid), and when Butler quits, and Butler always starts with it off. Closing the lid still puts a Mac to sleep; on Windows that depends on your lid setting.
- **Memory.** Progress, decisions, open follow-ups and cross-ticket learnings go into a local [StateCore](https://github.com/yul761/StateCore) store. Every session Butler starts can `recall` them. The ticket page has a **记忆 (Memory)** tab that shows each entry's history.
- **Optional personal LLM API.** At the 完整 (full) privacy level, Butler uses an OpenAI-compatible API that you pay for to distil StateCore memory after each nightly run. Every call goes through a privacy gateway with an audit page and a monthly budget. Nothing is sent until you configure a provider and choose the full level; see [Privacy model](#privacy-model).

## What Butler does not touch

- **Your Claude Code configuration.** Butler changes it only when you click the hook install, either in the first-run wizard or with **设置 → 环境检查 → 安装 / 修复 (Settings → Environment check → Install / repair)**. That adds four hooks to your user-level `settings.json` and a `/handoff` command. Your other hooks and commands are kept. Memory is never registered with `claude mcp add`. Instead, Butler passes `--mcp-config` on the command line of each session it starts.
- **Your tracker and code host.** Butler has no Jira, GitHub or Claude login of its own. Jira, Linear, GitLab or any other tracker is read only by your company's Claude Code, through its own MCP servers. PRs are read by `claude` with your `gh`.
- **The network.** The only network code in Butler is the privacy gateway for the optional personal API. A lint rule enforces this.

## Requirements

- macOS on Apple silicon, or Windows 10/11 x64. Intel Macs can [build from source](CONTRIBUTING.md).
- Claude Code installed and logged in. `claude --version` must work in a terminal.
- Git on `PATH`. On Windows, install **Git for Windows**: Claude Code runs hooks through Git Bash, and Butler won't run git at all if it can't find `git.exe` on `PATH`.
- Optional: a tracker MCP server (Jira, Linear, GitLab, …) set up in Claude Code, so handoffs can read ticket status.

## Install

Download the latest release from this repository's Releases page:

- macOS: `Butler-x.y.z-arm64.dmg` (or `Butler-x.y.z-arm64-mac.zip`)
- Windows: `Butler-Setup-x.y.z.exe`

Sizes, measured on a local macOS 1.0.0 build (the Windows installer has not been measured):

- **The dmg** is about 175 MB.
- **The installed app** is about 457 MB. About 288 MB is Electron's frameworks. About 143 MB is `butler-hook`, the program Claude Code runs for each hook. It is a Node single executable with Node 26.3.0 built in.
- **Installing the hooks** copies `butler-hook` to `~/.butler/bin`.

The builds are **not code-signed**, so your browser and OS will warn you.

### macOS (Gatekeeper)

The app is ad-hoc signed but not notarized, and macOS builds are arm64 only.

1. Open the `.dmg` and drag Butler into Applications.
2. Open Butler. macOS refuses: it says Apple cannot verify the app, or that the developer cannot be verified.
3. Allow it with either option:
   - **Option A: Open Anyway.** Open **System Settings → Privacy & Security**, scroll down to the message about Butler, click **Open Anyway** and confirm. On macOS 14 and earlier, you can instead right-click (Control-click) Butler in Applications, choose **Open**, then **Open** again.
   - **Option B: Terminal.** Remove the quarantine flag from the app and everything inside it, then open Butler normally:

     ```sh
     xattr -dr com.apple.quarantine /Applications/Butler.app
     ```

If macOS says Butler "is damaged and can't be opened", there is no **Open Anyway** button. Use option B.

Repeat this after every new download.

### Windows (SmartScreen)

The NSIS installer is unsigned for now (see [Code signing policy](#code-signing-policy)).

1. Your browser may warn about the download. In Edge, open the download's **…** menu and choose **Keep**.
2. Run `Butler-Setup-x.y.z.exe`.
3. SmartScreen says "Windows protected your PC". Click **More info → Run anyway**.
4. Pick "only for me" (no admin rights needed) and an install folder.

If Windows 11 **Smart App Control** is on, it blocks unsigned apps and offers no "run anyway" option. Butler can't be installed while it is on. Check Microsoft's documentation before you turn it off.

There is no auto-update. To upgrade, download the new version and install it over the old one. Your data in `~/.butler` is kept.

## First run

A short wizard, **欢迎使用 Butler (Welcome to Butler)**, walks you through these steps:

1. **检查 Claude Code (Check Claude Code).** Butler finds `claude` on your login shell's `PATH`, or you give it the absolute path. It also checks that `claude --help` lists the flags Butler relies on. You can't continue without a working `claude`.
2. **安装 hook 和 /handoff 命令 (Install hooks and the /handoff command).** Butler merges four hooks (`SessionStart`, `Stop`, `UserPromptSubmit`, `SessionEnd`) into your user-level Claude Code `settings.json`, keeping your existing hooks.
   - The first time, it saves a copy of the file as `settings.json.butler-backup`.
   - It also writes `commands/handoff.md`.
   - The hooks only drop small JSON files into `~/.butler/inbox`. They never touch the network and always exit 0.
   - To remove them, use **设置 → 环境检查 → 卸载 (Settings → Environment check → Uninstall)**.
3. **tracker 的 MCP 工具 (Tracker MCP tools).** Butler lists the MCP tools your Claude Code exposes, and you pick the read-only ones handoffs may call.
4. **隐私档位与个人 API (Privacy level and personal API).** Optional.

You can run the wizard again from Settings. [docs/configuration.md](docs/configuration.md) covers every setting, including how to adapt Butler to another company's tracker and conventions.

## Where your data lives

| Path | What |
|------|------|
| `~/.butler/app.db` | Tickets, sessions, handoffs, follow-ups, settings, the LLM audit log, and the encrypted API key (SQLite). Rows left by older versions (morning briefs, the sensitive-terms list) stay but are no longer used. |
| `~/.butler/statecore/statecore.db` | StateCore memory |
| `~/.butler/inbox/` | Hook reports waiting to be processed (`inbox/bad/` keeps unreadable ones) |
| `~/.butler/bin/butler-hook` | The hook program Claude Code runs (`butler-hook.exe` on Windows) |
| `~/.butler/mcp/tickets/<ticket>.json` | The memory `--mcp-config` file, rewritten each time a session for that ticket is opened |
| `~/.butler/mcp/features/<id>.json` | The `--mcp-config` file of a feature's coordinator |
| `~/.butler/mcp/epics/<id>.json` | The `--mcp-config` file of an epic's sessions, removed when the epic is archived |
| `~/.butler/workspaces/<ticket>/` | The empty folder a ticket's coordinator runs in |
| `~/.butler/mcp/project-*.json`, `local-*.json` | Copies of your MCP server entries for unattended runs. Written only when **后台 handoff 也加载本地级的 MCP…** (`headlessProjectMcp`) is on. These are private files because they can contain tokens. |
| `~/.butler/logs/main.log` | Logs |

A feature's workspace is not under `~/.butler`: it sits next to your repos (see [What it does](#what-it-does)), and holds that feature's worktrees. An epic's workspace sits next to your repos too.

On Windows `~` is `%USERPROFILE%`. Set `BUTLER_HOME` to use another folder. Butler also honours `CLAUDE_CONFIG_DIR` for the Claude Code configuration it reads and the hooks it installs.

Apart from the hook install, Butler only reads Claude Code's files:

- `settings.json`: hook status, plugin check, MCP approvals
- `commands/handoff.md`: whether it is Butler's own
- `~/.claude.json`: your MCP servers and approvals
- the session transcripts under `~/.claude/projects`: unclaimed sessions, `/handoff` output and the feature page's live status
- the command output files Claude Code writes under `claude-<uid>/<project>/<session>/tasks/` in the system temp directory (on macOS `/private/tmp`): the live status and stuck checks
- the session registry files in `~/.claude/sessions/`: a running session's name, so a fix session can message it
- with **后台 handoff 也加载本地级的 MCP…** (`headlessProjectMcp`) on, a repository's `.mcp.json` and `.claude/settings.local.json`, to find the servers you approved

The transcripts, output files and registry files are Claude Code's internal files, and an update can change them. If Butler can't read them, the live status falls back to the command and how long it has run.

Your personal API key is encrypted with the OS keychain (macOS Keychain / Windows DPAPI). After you save it, the UI shows at most its last 4 characters. A key shorter than 12 characters is shown only as `••••`.

Butler uses the keychain only when you save a key, and later when it needs that key to show its last 4 characters or to call your API. If you never save a key, Butler never touches the keychain.

On macOS, a dialog may ask whether Butler may use "butler Safe Storage" in your keychain (Electron names the item after the app's internal name, `butler`). Click **Always Allow**. The builds are ad-hoc signed, not signed with a Developer ID, so macOS treats every new version as a different app and asks again once after each upgrade. This can happen right at startup if a scheduled memory distillation needs the key. Butler's window does not respond until you answer. If you click **Deny**, Butler can't read the saved key, and Settings shows it as unreadable; enter it again.

Electron also keeps its own profile folder, with Chromium's caches and the single-instance lock: `~/Library/Application Support/butler` on macOS and `%APPDATA%\butler` on Windows. When `BUTLER_HOME` is set, Butler uses `<BUTLER_HOME>/electron` instead. On Windows this folder also holds the DPAPI-protected encryption key for the saved API key, so if you delete it, enter the API key again.

## StateCore memory

Butler embeds StateCore. Each session Butler starts gets two keyless MCP servers. `butler-memory` holds this ticket's memory and `butler-workspace` holds learnings shared across tickets. Sessions of a ticket in a feature also get `butler-feature`, the feature's memory (scope `feature:<id>`), which a feature's coordinator gets together with `butler-workspace`.

Everything under an epic also gets `butler-epic`, the epic's memory (scope `epic:<id>`): the epic's sessions, the coordinators of its features and all sessions of their tickets. It has two parts that don't compete for room. Planning notes are what the epic session saves with `remember`, and they count toward the scope's 30 notes. The state of the features is a single handoff that Butler writes to the scope and rewrites when a feature gets a new summary or moves in or out. It covers the 10 most recent features, archived ones included and marked, in at most 8,000 characters. The oldest feature is dropped first.

**Do not also install StateCore's own Claude Code capture plugin.** Butler already provides StateCore memory in the sessions it starts, and with both installed memory is recorded twice. Settings warns you if it finds the plugin.

- **No model key reaches StateCore.** The memory servers that Claude Code starts get no model API key: Butler strips model variables from their environment. Butler's own writes (handoffs, decisions, follow-ups, learnings) are deterministic and need no model.
- **Distillation, at 完整 (full) only.** When the privacy level is 完整 (full) and confirm-before-send is off, Butler runs StateCore's distillation through your personal API. Butler's main process makes the calls, and the key stays inside the privacy gateway. Distillation runs in the background after every nightly handoff run, including catch-up runs and **立即运行晚间 handoff (run the nightly handoff now)**. For each scope with pending events, the calls send:
  - the scope name, which for a ticket is the real ticket id (`ticket:<KEY>`)
  - the scope's recent raw events, including what Claude saved with `remember(consolidate: true)`
  - the scope's existing memory as JSON: Butler's follow-up and decision notes, Claude's own notes, and the previous summary with its next steps
  - the text of notes forgotten in that scope, so the model won't bring them back

  In the `workspace` scope, each learning is tagged with the id of the ticket it came from. **None of this is pseudonymized or scanned.** Each sent call is recorded on the audit page as **StateCore 记忆蒸馏 (StateCore distillation)** and counts against your monthly budget.
- **Memory holds 30 live notes per ticket.** StateCore keeps at most 30 notes per scope (one scope per ticket). Since statecore-mcp 1.1, finished follow-ups and replaced decisions free their slots, and distillation never pushes Butler's notes out. A ticket can still fill up if it has more than 30 open follow-ups and decisions at once (Butler keeps at most 24 of its own), or if Claude writes many notes itself. See [docs/configuration.md](docs/configuration.md#how-memory-works).

## Privacy model

Company work goes only through your company's `claude`. The optional personal API is used for one thing only: StateCore memory distillation at the **完整 (full)** **隐私档位 (privacy level)**. It sends real ticket ids, raw conversation excerpts and existing memory, unscanned (see [StateCore memory](#statecore-memory)). At **关闭 (off)**, **仅元数据 (metadata, the default)** and **脱敏文本 (redacted)**, the personal API is never called.

The **审计 (Audit)** page lists every call that was sent or refused over budget. Some refusals are only written to the log, for example a distillation call refused because the level changed, or a saved key that can no longer be decrypted.

## Code signing policy

**Status:** current Windows installers are unsigned. Butler has applied for the [SignPath Foundation](https://signpath.org) program, which offers free code signing to open-source projects. This section will change once the application is approved.

**Once approved:**
- **What is signed.** Only `Butler-Setup-<version>.exe` is signed. It must be built by [`.github/workflows/release.yml`](.github/workflows/release.yml) on GitHub Actions, from a version tag on this public repository. A build made on anyone's own machine is never signed.
- **Who signs.** The installers will carry the line: free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org). The certificate belongs to SignPath Foundation, so it is their name that Windows shows as the publisher.
- **Approval.** Each release's signing request is approved by hand.

Team roles:

- **Committers and reviewers:** [@yul761](https://github.com/yul761)
- **Approvers:** [@yul761](https://github.com/yul761)

### Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

- **Network.** Butler sends no telemetry, has no accounts or license checks, and does not check for updates.
- **Claude Code.** Butler starts your own `claude` CLI. That CLI connects to Anthropic, or to whatever endpoint your company configured, under your login and settings.
- **Personal API.** Butler calls the personal LLM API only if you configure one, and sends only what your chosen privacy level allows (see [Privacy model](#privacy-model)).
- **Local data.** Everything Butler stores stays on your machine (see [Where your data lives](#where-your-data-lives)).

## Known issues

- Unsigned builds (see above). macOS builds are Apple silicon only.
- No auto-update.
- macOS asks again for keychain access to the saved API key after every upgrade (builds are ad-hoc signed). With no key saved, there is no prompt.
- **Live status limits.** A command piped into `| tail` prints nothing until it ends, so the status shows no output for it. On Windows, Butler doesn't check child-process CPU and may not find a command's output, so the status can show only the command and how long it has run.
- **Windows, npm-installed Claude Code.** Butler starts the npm/pnpm `claude.cmd` shim's target directly, without `cmd.exe`. The target is either the native `claude.exe` or `node <script>`.
  - If Claude Code was installed with `--ignore-scripts`, or its native optional package is missing, `bin\claude.exe` is only a small placeholder file.
  - Sessions then fail to start, and npm's "native binary not installed" message never appears.
  - To fix it, reinstall Claude Code without `--ignore-scripts`.

## Uninstall

1. **设置 → 环境检查 → 卸载 (Settings → Environment check → Uninstall)** removes Butler's hooks and `/handoff` command from Claude Code.
2. Delete the app. On macOS, drag Butler out of Applications. On Windows, go to Settings → Apps → Butler → Uninstall.
3. To also remove your data, delete `~/.butler`. Neither step removes Electron's profile folder, `~/Library/Application Support/butler` on macOS or `%APPDATA%\butler` on Windows; delete it too for a clean uninstall. On macOS, if you saved an API key, you can also delete the "butler Safe Storage" item in Keychain Access.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
