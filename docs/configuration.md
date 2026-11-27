# Configuring Shipherd

**English** | [简体中文](configuration.zh-CN.md)

Shipherd has no config files. Everything is set on the **Settings** page and stored in `~/.shipherd/app.db`. This page lists every setting, what it does and which values it accepts. It also explains how to adapt Shipherd to another company's tracker and conventions.

The UI comes in English and Chinese (see `language` below). This page quotes the labels of the English UI; the [Chinese version](configuration.zh-CN.md) quotes the Chinese ones. The names in `code` are the internal keys, which help when you read logs or the database.

The Settings page has these sections, in order:

1. **Environment check**
2. **General**
3. **Memory (StateCore)**
4. **Schedule and status**
5. **Lessons** (automatic backups, the export reminder and the admission policy; see [Lessons: bulk actions, admission policy and import / export](#lessons-bulk-actions-admission-policy-and-import--export))

The **Automation** tab is described under [Automation level](#automation-level). Four more tabs sit at the top of the Settings page: **Model routing** (see [Model routing](#model-routing)), **Comments & CI** (see [Comments and CI](#comments-and-ci)), **Interruptions & notifications** (see [Interruptions and notifications](#interruptions-and-notifications)) and **Stacks** (see [Stacks](#stacks)).

The merge coordinator and the `end_session` tool for epic coordinators are described under [Merge coordinator](#merge-coordinator) and in [How Shipherd works](how-it-works.md#merge-coordinator); neither has a setting.

The audit log has its own page, **Audit**, in the sidebar. The **Effect** page has no setting either; see [Effect page](#effect-page).

## Automation level

The **Automation** tab at the top of the Settings page chooses how much Shipherd does on its own.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Automation level | `automationLevel` | `manual` | `manual` or `semi`. **Fully automatic (later)** is shown but can't be picked yet. Picking a level writes its preset into the switches it manages, listed below; nothing else changes. Picking the same level again puts those switches back to the preset. |

- **Manual.** Every managed switch is off: comments, CI, stacks and intake wait for you.
- **Semi-automatic.** PR comments go to the session, without replies and without resolving threads (`comments.enabled` on, `comments.reply` and `comments.resolve` off). A CI failure that looks flaky is rerun once (`ci.enabled` on, `ci.maxReruns` 1, `externalCiRerun` on). Stacks rebase on their own, and Shipherd pushes, force-pushes and opens their PRs (`autoRebase` on, `externalBranchPush`, `externalForcePush` and `externalPrOpen` on). PRs get a pre-review (`preReviewEnabled` on). Automatic intake starts work on its own once a source is set (`enabled` and `autoStart` on; with `intakeSource` still `none`, the tab says so and that part does nothing).
- **Merging always needs your click** at every level, and every outward action is still recorded in the [audit](#outward-actions).

The individual switches sit under **Advanced: switch by switch**, collapsed by default; they are the same settings as on the **Advanced** tab. When any managed switch no longer matches the saved level, in the global layer or in a product or repo layer of [Comments and CI](#comments-and-ci), [Stacks](#stacks) or [Automatic intake](#automatic-intake), the level shows **Custom** with how many switches differ. Picking a level rewrites only the global layer, so the tab lists the products and repos whose own settings differ; those are still edited on the **Advanced** tab, as before.

**Epic level.** The header of an epic's page has an **Epic level** menu: **Follow global** (the default), **Manual** or **Semi-automatic**. An epic's own level applies only to its tickets and overrides the global, product and repo settings of the managed switches for them. It is stored with the epic, not as a setting. A stack follows an epic level only when every ticket in it is in an epic with that same level of its own; a stack that mixes levels keeps the normal switches. For tickets that intake brings in from Jira, the epic's own level also decides whether they start once that epic exists in Shipherd; whether intake runs for their repo at all still follows the intake settings. **Semi-automatic** starts them (and pre-reviews them) even if the repo's intake doesn't start work on its own, and tells the epic coordinator about them. **Manual** only creates them in the epic without starting them, a ticket that needs clarifying only gets a notice (no session is opened), and a queued ticket goes back to held when its epic is switched to manual. Held tickets are decided again right after you change an epic's level. The intake source and its schedule stay global.

## Environment check

This section shows:

- the `claude` Shipherd found, its version, and any required flags its `--help` is missing
- the hook status and the `/handoff` command status
- the Shipherd data folder and the Claude Code `settings.json` that Shipherd would edit

The section has three buttons:

- **Check again**
- **Install / repair.** Copies `shipherd-hook` to `~/.shipherd/bin`, merges the four hooks into `settings.json` and writes `commands/handoff.md`. The first time, it saves a backup copy as `settings.json.shipherd-backup`. If `settings.json` is not valid JSON, Shipherd refuses to touch it. It never overwrites a `handoff.md` that it didn't write.
- **Uninstall.** Removes only Shipherd's own hook entries and its own `handoff.md`.

These buttons, and the same step in the first-run wizard, are the only way Shipherd ever writes to your Claude Code configuration.

### Export diagnostics

**Export diagnostics** at the bottom of the section saves a JSON file you can attach to a bug report about Shipherd being slow. It holds:

- the Shipherd, Electron and OS versions, the CPU and memory, and each Shipherd process's CPU and memory
- the last hour of one-minute performance windows: the main process's event-loop delay (p50 / p99), how many events of each kind went to the window, the IPC calls, the heavy jobs that took longer than 50 ms, the window's long tasks, and whether the terminals draw with WebGL or fell back to the DOM
- the last 1000 lines of `main.log`

It never contains transcript content, prompts or memory. The counters are always on and cost almost nothing; a minute with nothing notable writes nothing to the log. Set the environment variable `SHIPHERD_PERF_DIAG=off` to turn them off, or `SHIPHERD_PERF_DIAG=verbose` to log every minute.

### Send feedback

**Help → Send Feedback…** in the menu bar, and the same button under **Settings → About**, open a short form: what kind of feedback it is (bug, idea, or a problem during first-run setup), an optional title and a description. **Open on GitHub** opens a new issue on github.com/yul761/shipherd in your browser with the matching template, your text, and the Shipherd version, OS and version, architecture and Claude Code version filled in (`unknown` when Shipherd can't tell). Nothing is sent by Shipherd: you read the issue and click **Submit** yourself. When the text doesn't fit in a link, the description is cut and the full text is copied to your clipboard so you can paste it.

In the first-run wizard, when a step can't get through (no working `claude`, the hooks won't install, or the check itself fails), a **Stuck? Tell us** link opens the same form with *first-run setup* chosen and the step filled in.

**Attach diagnostics** is off by default. Turn it on and Shipherd builds the same file as **Export diagnostics**, with the home folder, every absolute path, repository names, ticket keys and titles, epic names, branch names, web addresses, emails and company host names replaced by placeholders such as `<path>` and `<repo>`; quoted or non-English text in the log becomes `<text>`. You see the whole file first; only when you click **Save to Downloads and open GitHub** is it saved to your Downloads folder as `shipherd-diagnostics-redacted-<time>.json` and selected in Finder or Explorer. Drag it into the issue's **Diagnostics** box. Questions and open-ended discussion go to [Discussions](https://github.com/yul761/shipherd/discussions) instead.

## General

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| claude path | `claudePath` | empty | Empty means Shipherd searches your login shell's `PATH`. Otherwise, the absolute path to your company's `claude`, as printed by `which claude` (or `where claude` on Windows). Saving it runs the environment check again. |
| Branch template | `branchTemplate` | `feature/{key}` | Used when Shipherd creates a ticket's branch and you leave the branch name empty. `{key}` is replaced with the ticket id, `{key_lower}` with the ticket id in lower case, and `{title}` with the ticket's title turned into lower-case letters, digits and `-` (at most 50 characters). When the title has no such characters, `{title}` and the `-` or `/` next to it are left out. The template must contain `{key}` or `{key_lower}`, be at most 100 characters, and use only letters, digits and `. _ / -`. It can't start with `-` or `/`, can't contain `..`, `//` or `/.`, and can't end with `/`, `.` or `.lock`. Examples: `users/alice/{key}`, `{key}`, `{key_lower}-{title}` (gives `dms-1234-add-payment-api`). A new branch starts from the remote's default branch: Shipherd first fetches it from `origin` (the branch `origin/HEAD` points to, or else `main` / `master`) and branches off `origin/<default>`, whatever branch your own checkout is on; your checkout is not touched. If the fetch fails or you're offline, it uses the last fetched `origin/<default>` and says so in `main.log`. A repo without `origin` uses its local `main` (or `master`). The new branch has no upstream. A ticket made with `stack_on` starts from the ticket below it instead. |
| Ticket id pattern | `ticketPattern` | `[A-Z][A-Z0-9]+-\d+` | A JavaScript regular expression for ticket ids. See [Ticket pattern](#ticket-pattern) below. |
| 语言 / Language | `language` | `auto` | `auto`, `zh` or `en`. `auto` follows the system's preferred language: Chinese for any `zh` locale, English for everything else. The interface, Shipherd's messages and the default prompts sent to `claude` (handoffs, refreshes, memory notes) all switch; prompts you edited yourself are kept as they are. Content generated earlier is not translated. Installs upgraded from 1.2.0 or earlier start on `zh`. After a switch, **Environment check** shows the `/handoff` command as needing an update; click **Install / repair** so `/handoff` in your sessions uses the new language too. The environment variable `SHIPHERD_LANG=zh` or `SHIPHERD_LANG=en` overrides the setting. |
| Review requests / 请你 review | `reviewRequestScope` | `all` | Which pull requests asking for your review show up on the home page. `all`: every repository your `gh` account can see. `registered`: only repositories Shipherd knows (a ticket repository, or a repository that has a ticket PR). Shipherd runs one `gh search prs --review-requested=@me --state=open` every 5 minutes (every 15 minutes while the computer is idle or locked, and again when you bring the window forward or open the home page if the last query is over a minute old). The search only covers `gh`'s default host, so review requests on a GitHub Enterprise host are not found. |
| Start Shipherd at login | — | off | Only available in an installed Shipherd, not in development mode. |
| Check for updates | `updateCheckEnabled` | `1` (on) | `1` or `0`. Once a day, Shipherd uses your own `gh` to ask GitHub for Shipherd's latest release (the same as `gh api repos/<Shipherd's repo>/releases/latest`); Shipherd itself sends no HTTP requests. When a newer version is out, a bar at the top shows "X.Y.Z is available" with the release notes (collapsed), **Download** (opens the release page in your browser), **Skip this version** and a close button. Shipherd only tells you; it never downloads or installs anything. Drafts and pre-releases are never offered. The first check runs shortly after startup, then at most once every 24 hours, including after a failed check. Without `gh`, or when `gh` is not logged in, offline or rate-limited, Shipherd skips quietly; nothing pops up. Every check that ran is recorded as **Update check** under **Outward actions** on the **Audit** page. **Skip this version** hides that version until a newer one comes out; the close button hides it until Shipherd restarts. When off, Shipherd doesn't check on its own and hides the bar. **Help → Check for Updates…** in the menu bar and the button under **Settings → About** always check right away, whether this is on or off, and say what came out: up to date, a new version, or why the check didn't work. This is the one switch that is on by default: it only reads, and leaves nothing on GitHub. |
| Show sessions started outside Shipherd | `showOutsideSessions` | `0` | `1` or `0`. When on, Shipherd looks through `~/.claude/projects` at startup and every 5 minutes, and lists the Claude Code sessions you started outside Shipherd in the last 7 days under **All work › Unclaimed sessions**, where you can claim one for a ticket. When off (the default), Shipherd doesn't scan `~/.claude/projects` to find them and the entry is hidden. Sessions Shipherd opens itself are not affected. Turning it on scans once right away. |
| Resume the sessions that were working after a restart | `autoResumeAfterRestart` | `0` | `1` or `0`. When on, Shipherd resumes, at startup, the coordinator-managed sessions whose terminals were still open when it last quit or crashed (working or waiting for a reply), each on its own conversation in the background: ones with unread mailbox messages first, then ones whose ticket has a PR waiting, then the most recently active. Each goes through the same memory check as `start_session`; at the first refusal Shipherd stops and leaves the rest closed. Sessions you ended with × are never resumed. Whatever this says, when a coordinator sends a message to a closed session it started, Shipherd resumes that session in the background (unless you ended it) and delivers the message; the coordinator is told whether it was resumed, is waiting for memory, or was ended by you. |
| Run the first-run wizard again | `onboardingDone` | `0` for new installs | A button, not a field. The wizard sets this to `1` when you finish or skip it, and the button sets it back to `0`. Existing installs that already have tickets were migrated to `1`. |

### Ticket pattern

Shipherd uses the pattern in two places:

- to check the id when you create a ticket
- to suggest a ticket for unclaimed sessions

Ticket ids are upper-cased before they are checked, so write the pattern for upper case. When Shipherd looks for ids inside text, it matches case-insensitively, and the id must not directly follow a letter or digit, or be directly followed by a digit.

The default pattern covers Jira and Linear style ids such as `PROJ-123` or `ENG-42`.

GitHub issue numbers such as `#123` **cannot** be used as ticket ids. `#` is not allowed in branch names, so Shipherd rejects a pattern like `#\d+` together with any branch template. Use a prefixed id such as `GH-123` instead, which the default pattern already accepts.

Before saving, Shipherd rejects a pattern that:

- is empty or longer than 100 characters
- does not compile
- uses back-references (`\1`, `\k<name>`)
- matches the empty string
- **backtracks badly.** The pattern is run in an isolated `vm` context against a set of adversarial inputs of about 5,000 characters, with a hard timeout of about 250 ms per input. If any run times out, the pattern is rejected. Nested or repeated quantifiers such as `(a+)+` are the usual cause.

Shipherd also checks the pattern and the branch template together. Changing either one is refused if a sample id that the pattern accepts (for example `-1`, `#1` or `..-1`) would produce an invalid branch name.

## Parallel sessions

How many sessions can run at once depends on this computer's memory, not on a fixed number. Before Shipherd opens a new terminal for `start_session`, a message from the global control to a closed epic coordinator, or new Jira tickets that intake hands to a closed epic coordinator, it takes the memory available now, subtracts what a new session is expected to use, and opens it only if at least the reserve below is left. Sessions it opened in the last two minutes have not grown yet, so each of them is subtracted at the expected size too. While macOS reports memory pressure as critical, nothing new opens. When a session is refused, the coordinator is told how much is available, how much another one needs and how much stays free; the result of `start_session` and `list_sessions` adds a line saying how many more can start now. If memory cannot be read, Shipherd opens the session anyway (only the optional cap applies) and logs it.

Available memory on macOS is worked out from `vm_stat` the way Activity Monitor does: total minus wired, compressed and anonymous (minus purgeable) memory, so file cache counts as available. `os.freemem()` is not used there, because it counts only free pages and is often a few GB on a machine with tens of GB to spare. If `vm_stat` fails, Shipherd uses the free percentage from `memory_pressure -Q`, then `os.freemem()`. On Windows `os.freemem()` is the available physical memory (free plus standby), and on Linux it is `MemAvailable`, so it is used as is.

The log (`logs/main.log` in Shipherd's data folder) records the reading at startup, next to macOS's own free percentage and `os.freemem()`, and records every decision with the numbers it used. If sessions are refused when the machine seems to have room, those lines show why.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Memory to keep free after opening a session (MB) | `sessionMemoryReserveMb` | empty (automatic) | Empty means automatic: 10% of physical memory, at least 512 MB and at most 2048 MB (819 MB on an 8 GB machine, 1638 MB on 16 GB, 2048 MB from 20 GB up). Or a whole number of MB from `0` to `1048576`. A session opens only if available memory minus the expected size of a new session is at least this much. |
| Memory a new session is expected to use (MB) | `sessionMemoryEstimateMb` | `1024` | A whole number of MB from `64` to `1048576`: Claude plus its MCP servers and child processes. Shipherd uses this number for now; once per-session memory measurement is connected, the measured average of the open sessions will be used when there is one. |
| Most terminals open at once (0 = no limit) | `sessionMaxRunning` | `0` (no limit) | A whole number from `0` to `999`. Off by default and only a safety net: when set, no new terminal opens while Shipherd already has this many open, however much memory is free. |

## Memory (StateCore)

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Write the progress, decisions, follow-ups and learnings to StateCore, and give the sessions Shipherd opens their memory | `memoryEnabled` | `1` (on) | `1` or `0`. When off, Shipherd writes nothing to StateCore and starts sessions without the memory MCP servers. Existing memory is kept. When you turn it back on, Shipherd catches up on the tickets it missed. |
| Refresh automatically when the context passes this many tokens (0 = off) | `refreshThresholdTokens` | `150000` | `0` turns automatic refresh off, otherwise a whole number of tokens (at most 7 digits). When a Shipherd session has stopped, is not waiting on you and its last turn's context is at least this long, Shipherd types `/handoff`, waits until memory has stored the handoff, saves the last few turns of the conversation to `~/.shipherd/refresh/<session>.md` (no model is called), types `/clear`, then has the session recall the handoff, read that file and carry on with what it was doing (if it was waiting for you, CI or a child session, it says what for and keeps waiting). Needs memory on. The ↻ button next to a running session and a coordinator's `refresh_session` do the same on demand and do not depend on this setting. |
| Close a session automatically after it has been idle this many minutes (0 = off) | `idleCloseMinutes` | `180` | `0` turns automatic closing off, otherwise a whole number of minutes from 10 up (at most 5 digits). When a Shipherd session's terminal is open but it has stopped for longer than this (time the computer was asleep doesn't count), with nothing waiting on you, no background task, no merge queue or CI run it is waiting on, not in the middle of a refresh and (for a coordinator) no child session at work, Shipherd has it write a handoff (`/handoff`), waits for memory to be written, then ends the terminal like `end_session`. You can resume it later. With memory off, ticket sessions and epic coordinators still write `/handoff` (Shipherd keeps it for the daily brief). Sessions you have hidden are deleted from Shipherd after 14 days; their transcripts stay on disk. **Clean up idle** in a session bar does the same at once for sessions there that have stopped for at least 5 minutes, whatever this setting is. |

This section also shows:

- the StateCore data folder (`~/.shipherd/statecore`)
- whether the memory MCP bundle was found
- a warning if StateCore's own Claude Code capture plugin is installed. Don't run that plugin alongside Shipherd: memory would be recorded twice.
- the **Run the first-run wizard again** button

### How memory works

- **Scopes.** Each ticket has its own StateCore scope (`ticket:<KEY>`). Learnings shared across tickets go to a `workspace` scope.
- **Mounting.** Each time you open a session for a ticket, Shipherd rewrites `~/.shipherd/mcp/tickets/<ticket>.json` and starts `claude` with `--mcp-config` pointing at it. The file mounts two servers: `shipherd-memory` (the ticket scope) and `shipherd-workspace`. Both run with Shipherd's own Electron in Node mode, with no model key in their environment. Nothing is registered in Claude Code's own MCP configuration.
- **What Shipherd writes.** After every complete handoff (morning refreshes and incomplete handoffs don't count), Shipherd writes:
  - a new handoff version: status, what was done, next steps and open questions
  - the ticket's open follow-ups and its latest decisions, as notes. Shipherd keeps at most 24 of its own notes per ticket, which leaves room for Claude's own `remember` calls.
  - the handoff's learnings, to the `workspace` scope

  Shipherd also syncs a ticket at startup and when you open a session for it. It syncs again when you complete, ignore or reopen one of the ticket's follow-ups.
- **The 30-note cap.** StateCore keeps at most 30 live notes per scope. Since statecore-mcp 1.1, a forgotten note (a finished follow-up, a replaced decision) frees its slot, and nothing else pushes out notes written by Shipherd or by Claude's `remember`. Before each write, Shipherd counts the free slots. If none is left, it skips the write rather than let StateCore evict the oldest entry, so Shipherd never evicts its own notes. When slots are short, open follow-ups go first, then decisions. The skipped entries are still in Shipherd's own database and on the ticket page, and are written as soon as a slot frees up. In the `workspace` scope, StateCore evicts the oldest learnings once it holds 30 notes.
- **The Memory section** of a ticket page's **Log** tab shows the latest handoff, decisions, open follow-ups and other notes. Click **History** on an entry to see its version chain. The section refreshes after each Shipherd sync. It does not update live while Claude writes to memory inside a session.
- **Long entries.** When Claude calls `remember` with `consolidate: true`, StateCore keeps the text (up to 2,000 characters) word for word as an event, not a note, so it doesn't count toward the 30 notes. Shipherd calls no model, so nothing distils events into notes: `recall` returns the most recent events (or, with a query, the most relevant ones) in full next to the notes, within its character budget. The memory tools' descriptions say so, and `remember` answers `{"ok": true, "mode": "event"}`. Events left waiting for distillation by an older version stay events and keep showing up in `recall`.

## Memory and performance

These settings are in **Settings → General → Memory and performance**. None of them limits how many sessions run at once.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Record how much memory each session uses | `memoryMonitor` | `1` (on) | `1` or `0`. Once a minute Shipherd reads the process table (`ps` on macOS, `Get-CimInstance Win32_Process` on Windows; no model is called). It adds up each open session's whole process tree (claude, its MCP servers, shells, watchers, dev servers) and Shipherd's own processes, and reads how much memory the system has free. The **Your turn** page shows a **Memory** card under **How it is running**: Shipherd, sessions, free memory, Shipherd's MCP servers, and a 24-hour curve when you open it. Every five minutes a point is stored in Shipherd's database. Points are kept for 14 days. Reading only; it never changes a process. |
| Lower the priority of sessions you can't see that have stopped | `backgroundPriority` | `0` (off) | `1` or `0`. On macOS, the whole tree of a session that is not on screen and has stopped is put in the background (`taskpolicy -b`). On Windows, a session you can't see gets `BelowNormal`, and one that has also stopped gets EcoQoS too. Showing the terminal, typing into it, or the session starting to work again restores normal priority at once; quitting Shipherd restores everything. Sessions that are working are never lowered on macOS, because background priority makes builds and tests very slow. |
| Clean up orphan processes a session leaves behind | `orphanCleanup` | `1` (on) | `1` or `0`. Shipherd remembers which processes it has seen under each session (`~/.shipherd/procs/owned.json`, with each one's start time and command line). Five seconds after a session's terminal ends, any of them still running, and no longer under a live session, is ended: first politely, then by force five seconds later (on Windows `taskkill`, then `taskkill /F`; each process is checked and ended on its own, never with `/T`). At startup it does the same for processes left over when Shipherd last quit unexpectedly. A process whose start time or command line no longer matches, such as a reused pid, is never touched. Every process ended is written to the log. |
| Refresh a session whose claude process uses more than this many MB (0 = off) | `refreshMemoryMb` | `0` | Off by default, so a session is refreshed only by `refreshThresholdTokens`, as in 2.1.0; `2048` is a reasonable value to turn it on. `0` turns it off, otherwise a whole number of MB from 256 up (at most 6 digits). Only the claude process itself counts, not its MCP servers or other children. When it is over the limit, Shipherd refreshes the session at its next idle point, with the same checks and steps as `refreshThresholdTokens` (so memory must be on). If claude is still above 80% of the limit afterwards, Shipherd logs it; it tries again after six hours. |
| Hibernate stopped sessions | `hibernateEnabled` | `0` (off) | `1` or `0`. Once a session Shipherd opened has been stopped for the minutes below, Shipherd ends its whole process tree (claude, MCP servers, shells, and watchers unless `hibernateEndWatchers` is off) and keeps only the transcript; the session shows **Hibernated**. It wakes up with `claude --resume`, with the whole conversation, when something has to reach it: a CI result, a merge notice, a report for a coordinator, or your answer to an `ask_user`. Opening it, or switching to its terminal, wakes it too. A session is never hibernated while it is working or has background commands, has a permission prompt or dialog on screen, has a draft in its input, was typed into in the last 30 seconds, is being refreshed or sent something, is the terminal you are looking at, is a coordinator whose child sessions are working, was opened in the last 2 minutes or woken in the last 10, has no transcript, or is pinned (📌 on its button). Fix sessions and lesson sessions are never hibernated. A hibernated session still shows on the **Your turn** page and still counts as waiting for you. If a wake fails, the session gets a **!** on its button (the reason is in its tooltip) and stays on the **Your turn** page until you open or hide it. A failure that can pass (the ticket is busy, claude can't be found, a repo is on another branch) keeps the session hibernated, and automatic wakes retry after 10 minutes. Any other failure (claude exits before it starts, or does not start within 60 seconds) turns it into an ordinary closed session. Opening it yourself always tries again. This never limits how many sessions run at once. |
| Hibernate a session waiting for you after (minutes) | `hibernateYouMinutes` | `30` | `0` (never) or a whole number from `5` up (at most 5 digits). "Waiting for you" means the **Your turn** page says it needs you, or it has an unanswered `ask_user`. |
| Hibernate a session waiting for CI after (minutes) | `hibernateCiMinutes` | `20` | Same values. Waiting for CI: its PR's (or branch's) CI is running, or it is queued in the merge gate. |
| Hibernate a session waiting for review after (minutes) | `hibernateReviewMinutes` | `30` | Same values. Its PR is open, CI is done and the review is not approved yet. |
| Hibernate an idle session after (minutes) | `hibernateIdleMinutes` | `60` | Same values. Anything else that has stopped. |
| Also end watchers and dev servers when hibernating | `hibernateEndWatchers` | `1` (on) | `1` or `0`. When off, watchers (`tsc --watch`, `vite` and the like) and dev servers keep running while the session hibernates; they are ended when it wakes, is hidden or Shipherd restarts. |
| Hibernate the longest-idle session when memory is low | `memoryPressureEnabled` | `0` (off) | `1` or `0`. While free system memory is below `memoryPressureFreePercent`, Shipherd hibernates one session per sample (once a minute): the one idle the longest, idle at least 5 minutes, that passes every rule above. It stops once free memory is back 5 points above the line. Works even with `hibernateEnabled` off. |
| Free memory below this percentage counts as low | `memoryPressureFreePercent` | `10` | A whole number from `1` to `50`. |
| Shared MCP | `sharedMcp` | `0` (off) | `1` or `0`. When on, one background process (the MCP hub) serves Shipherd's memory servers and `shipherd-sessions` to every session over local loopback HTTP (`127.0.0.1` only, a random token per session and server), instead of a set of processes per session. The more sessions are open, the more memory this saves; when it is off, the memory card under **How it is running** on the **Your turn** page estimates the saving. It affects sessions opened afterwards. While the hub is starting or cannot start, new sessions get their own processes as before, and **Other notes from Shipherd** (under **How it is running** on the **Your turn** page) shows a note if it keeps failing. After you turn it off, sessions already using the hub keep it until they exit. MCP servers from your own Claude config are not affected. |

### Tips Shipherd can't apply for you

- **Windows:** in Windows Security, add Defender exclusions for the folder that holds your worktrees, `node_modules`, `.git` and `%USERPROFILE%\.shipherd`. Real-time scanning costs a lot when many node and git processes run at once. Make sure the page file is large enough: leave it **System managed**, or at least 1.5 times your RAM.
- **macOS:** add the folder that holds your worktrees to Spotlight's privacy list (System Settings → Siri & Spotlight → Spotlight Privacy) so every `pnpm install` isn't indexed again. If you run third-party antivirus, exclude the same folders. macOS manages swap itself: keep at least 15–20% of the disk free so it has room.
- **Both:** every MCP server in your own Claude configuration starts once per session. The **Memory** card under **How it is running** on the **Your turn** page names the ones of yours that use the most. Remove the ones you rarely use from your Claude configuration; Shipherd never changes it for you.

## Schedule and status

Shipherd calls the status it writes for a ticket a handoff internally; the `/handoff` command keeps that name.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Nightly status update time | `nightlyTime` | `16:00` | `HH:MM`, local time. If Shipherd was closed, asleep or locked at that time, the run catches up at the next launch, wake or unlock, before the morning refresh. |
| Daily global control patrol at | `shipherdPatrolTime` | empty (off) | `HH:MM`, local time; empty means off. At this time Shipherd opens (or reuses the latest) global control and has it go over PRs, CI and pending questions, nudging the epic coordinators that should follow up with `send_message` and listing what you need to do yourself with `ask_user`. If the global control is busy, the patrol goes into its mailbox and it reads it at its next tool call. If the computer was asleep or Shipherd was closed at that time, the patrol runs once at the next wake, unlock or launch on the same day; it is not made up after midnight. If you turn the setting on after that day's time has passed, the first patrol runs right away. A patrol opens a session at most once a day. While a question listed by the previous patrol is still pending, the next one waits for you to deal with it. The global control is not refreshed or closed for being idle automatically. |
| Working days (the nightly status update runs only on these) | `workingDays` | `1,2,3,4,5` (Mon–Fri) | Checkboxes in the UI. The stored value is a comma-separated list of `0`–`6`, where `0` is Sunday. Nightly handoffs and morning refreshes run only on these days. |
| Tracker MCP tools (status updates may call only these; one per line) | `trackerTools` | empty | One MCP tool name per line, in the form `mcp__<server>__<tool>`. `mcp__<server>` alone allows every tool of that server, so avoid it unless the server is read-only. Anything else, such as `Bash(...)` rules or flags, is rejected. Handoffs and refreshes may call these tools, plus `Read`, `Grep`, `Glob`, `gh pr view`, `gh pr checks`, `git log` and `git status`, plus anything your user-level or managed (policy) Claude Code settings allow (see below). |
| Background status updates also load local-scope MCP servers… | `headlessProjectMcp` | `0` (off) | `1` or `0`. See [Plugging in your tracker](#plugging-in-your-tracker). |
| Status update prompt template | `handoffPrompt` | built in | The instructions sent to `claude` for a handoff. It can't be empty and is limited to 20,000 characters. See [Adapting the prompts](#adapting-the-prompts). |
| Morning refresh prompt template | `refreshPrompt` | built in | The quick morning check of PR and tracker status. It doesn't summarise the conversation. Same limits as above. |

The section also has **Run the nightly status update now**.

After the tickets, the nightly run also writes a summary for every epic whose coordinator session or tickets had new activity since its last summary. It forks the coordinator session when there is one and uses the same read-only flags as a handoff. If the ticket run was rate limited, no epic summaries are written that night and the morning catch-up does them. An epic's page also has **Update now**, which first runs handoffs for the epic's tickets that had activity and then writes the summary. A change in a PR's state, CI, review or mergeability since the last summary also counts as new activity, so the summary is marked out of date even when nobody typed anything. Each summary shows "PR status as of" the time it read the PRs. `/handoff` in a coordinator writes the summary from the conversation itself.

Handoffs and refreshes start `claude` with these flags:

- `--permission-mode dontAsk`: any tool that is not allowed is refused, so there is never a prompt.
- `--disallowedTools Edit Write NotebookEdit`: these are always denied.
- `--setting-sources user`: your user-level Claude Code settings apply, and so do managed (policy) settings, which Claude Code always loads. Allow rules and hooks in the repository's own settings do not.

The allowed tools are the list above plus the allow rules in your user-level `settings.json` and in any managed settings. These runs are not strictly read-only. If those settings allow, say, `Bash(npm:*)` or a write-capable MCP tool, unattended runs can use it too. Only `Edit`, `Write` and `NotebookEdit` are always blocked.

### Plugging in your tracker

Shipherd never talks to your tracker itself. Handoffs read it through the MCP servers configured in your company's Claude Code. Pick **read-only** tools only:

1. Configure the tracker's MCP server in Claude Code as you normally would. User scope is simplest.
2. In Settings, click **Detect from Claude Code**. Shipherd lists every MCP tool your Claude Code exposes. Tools whose names look like reads (get, list, search, read, view, fetch, query, find, …) are pre-ticked. Untick anything that writes, then click **Add the ticked tools and save**.
3. Tool names are `mcp__<server>__<tool>`, where `<server>` is the name you gave the server in Claude Code. For the Atlassian (Jira) server named `atlassian`, this could be `mcp__atlassian__getJiraIssue`. For other trackers (Linear, GitLab, …), use the names that the detection shows.
4. If the tracker's MCP server is configured in local scope or in a repository's `.mcp.json`, turn on `headlessProjectMcp`. Unattended runs read only your user-level settings, so they don't see those servers by default. With the setting on, Shipherd reads the repository's `.mcp.json` and `.claude/settings.local.json`, plus your `~/.claude.json` and `settings.json`, to find the servers you approved. It then copies your local-scope servers into private files under `~/.shipherd/mcp/`, along with the repository servers you have already approved in Claude Code. Those files can contain tokens. Disabled or unapproved servers are never loaded.

### Adapting the prompts

The default prompts are written for Jira-like trackers and GitHub PRs (`gh pr view`, `gh pr checks`). If you use GitLab or another tracker, rewrite the instructions in `handoffPrompt` and `refreshPrompt`, keeping the read-only rules.

Placeholders are written as `{{name}}`. Unknown placeholders are left as they are.

| Placeholder | Replaced with |
|-------------|---------------|
| `{{ticket}}` | the ticket id |
| `{{title}}` | the ticket title |
| `{{branch}}` | the branch name |
| `{{tracker_tools}}` | the tools from `trackerTools` |
| `{{previous_handoff}}` | the previous handoff as JSON |
| `{{open_followups}}` | the open follow-ups as JSON |
| `{{current_status}}` | the current ticket status (useful in the refresh prompt) |
| `{{schema}}` | the field description |
| `{{example}}` | a worked example |

Keep `{{schema}}` and the output instructions. Shipherd also passes the JSON schema to `claude --json-schema` and validates the result. If the output fails validation, Shipherd retries once with the errors, and if it still fails it stores an incomplete handoff, marked **Incomplete**. The tracker status field is called `jira` in the schema whatever tracker you use.

## Merge coordinator

When several tickets change the same repo, the merge coordinator keeps their merges from colliding. It is part of Shipherd and has no setting. It does not ask a model: git itself decides whether two branches conflict.

**What it reviews.** Only two kinds of command, run by a session that Shipherd opened (an epic coordinator or any ticket session, whichever epic it belongs to):

- A merge into a target branch: `gh pr merge` (including `--auto`; the target is the PR's base branch), `git merge` on the target branch, and `git push` to the target branch. For a push with an explicit `src:dst` refspec, the branch checked is `src` (`HEAD` means the current branch). A bare `git push origin main` pushes the local `main`, whichever branch you are on, so it counts as pushing the target branch itself and is not reviewed. Pushing your own branch is not reviewed either. Directories in `cd` and `git -C` may be written as Windows paths (`"C:\Users\me\repo"`), Git Bash paths (`/c/Users/me/repo`) or with `~`.
- A branch switch (`git checkout`, `git switch`) in a shared folder, that is, a repo folder in "branch" work mode that another ticket with an open session is using. Switching inside your own worktree is not reviewed.

Writing code, committing, testing and pushing your own branch never reach the coordinator. A command it can't recognize is let through.

**Only in sessions Shipherd opens.** The review is a `PreToolUse` hook for the Bash tool in the `--settings` file Shipherd writes for each session, with `PostToolUse` and `PostToolUseFailure` hooks that tell Shipherd when the command has ended. Your global `settings.json` is not changed, so a `claude` you start yourself is not affected. The hooks run the `shipherd-hook` program that **Install / repair** copies to `~/.shipherd/bin`. When that copy differs from the one in the app (after an upgrade), Shipherd replaces it at startup; if it can't, merges are not checked and the log says why.

**How it decides.**

- First come, first served. A merge that conflicts with another ticket's branch that is still being written is allowed, and Shipherd remembers that the other ticket will have to rebase.
- If the branch no longer merges into the latest target branch, the session is told to rebase first, with which ticket's changes it conflicts with and in which files. It is reminded to keep both sides' intent.
- If it conflicts with a branch whose merge was already allowed and has not finished, it is told to wait. A session whose own merge was already allowed can try again without waiting. The merge hold follows the real merge:
  - A local `git merge` or push holds until the command ends, whether it succeeds or fails. If Shipherd never hears that it ended, for example because you rejected the permission prompt, the hold expires after 10 minutes.
  - `gh pr merge` holds until Shipherd sees the PR merged (checked with `gh pr view`, only for held PRs) or closed. If the PR is still open 30 seconds after the merge was allowed and auto-merge is off, Shipherd takes it that the merge failed or `--auto` was cancelled, and releases the hold. If `gh` can't check, the hold expires after 2 hours. A `gh pr merge` of a branch that still holds a local merge (say, after a rejected push) turns that hold into a PR hold.
- When the held merge lands, the waiting session gets the message that it **can merge now** (after rebasing). If it doesn't land (the merge failed, the PR was closed or the hold expired), the session is told it can try the merge again. The message goes into the session's mailbox: a working session reads it at its next tool call, a stopped one has it typed in once you haven't typed in its terminal for 30 seconds, and a closed one gets it when you open the session again.
- A branch switch in a shared folder is refused while the folder is in use, naming the ticket and branch. When you click to switch a branch yourself, Shipherd only warns you; you can still confirm.

**Fail-open.** If Shipherd isn't running, doesn't answer within 5 seconds, or the hook itself fails, the command goes ahead. The coordinator is a safety net and is never a reason a session can't merge.

**What you see.** Each conflict it finds (a refusal, or an allowance with a later rebase) adds an entry to **Recent merges** under **How it is running** on the **Your turn** page (the repo, which tickets, the order it chose). There are no system notifications. A merge with no conflict adds no entry; Shipherd only holds it until it lands. The entries, holds and pending rebases survive a restart.

**Requirements.** git 2.38 or newer (for `git merge-tree --write-tree`). `gh` is optional and used only for PR merges.

**What it doesn't do.** It only judges conflicts that git can see. Whether the merged code compiles or behaves correctly, such as one side renaming a field the other still uses, is left to CI. It doesn't rebase or resolve conflicts for you, and it ignores git you run in your own terminal.

## Model routing

Shipherd runs some work in the background with `claude -p`: needs-you and stuck checks, handoffs, epic summaries and the lessons analysis. **Settings → Model routing** decides which model each of those calls uses, and what happens when a model hits a limit.

**With nothing registered, nothing changes.** Until you register at least one enabled model, every call uses the same model as Shipherd 2.1.0 (haiku for the needs-you and stuck checks, sonnet for the handoff refresh, your default model for the rest). Limits are handled as before: the whole account pauses. Generic signals (below) are only recorded on the page.

**Tiers and chains.** Each model you register has a tier: `high`, `mid` or `low`. A model name can be an alias (`opus`), a full name (`claude-opus-5-5`) or a name your gateway knows; Shipherd passes it to `--model` as it is. Each tier has a chain, the order to try its models in. By default the chain is the tier's models in the order you registered them. Models with the same **account** label share a subscription or gateway: an account-wide limit on one marks the others of the same or a higher tier too.

**First-time setup.** **Discover models** collects candidate names from `ANTHROPIC_MODEL` and related variables, the `model` in Claude Code's `settings.json`, models seen in recent usage and the CLI aliases, then sends each one a tiny test call. Only the ones that answer are offered, each with a suggested tier. Shipherd never assumes that opus, sonnet or haiku exist. A registered model that doesn't exist is marked unavailable and skipped.

### Tasks and limits

Every background call names its task. The table on the page shows each task's tier, its lowest allowed tier, what it does at a limit and whether it is critical. You can change any of these per task.

- **fallback**: try the next model in the chain, then the tiers below, down to the lowest allowed tier.
- **wait**: try the other models of the same tier, then wait until one recovers. Nothing is dropped.
- **escalate**: stop after the first limit and report it.

Handoffs and epic summaries keep the session's own model (switching would throw away the prompt cache).

A result from a lower tier than the task asked for is marked as a fallback in usage, in the lesson run details and in the event log. A lessons analysis that ran on a lower tier is queued to run again on its own tier once that tier is healthy again. **Re-run now** on the page does that immediately.

**Recognising limits.** Limits are recognised by rules: the built-in ones, rules you add (a regex, an HTTP status or a reset-time pattern) and rules learned from your confirmations. On top of those, Shipherd treats as a *suspected* limit an HTTP 429, 529 or 402, an error mentioning limit, quota, billing or credit, and a model that failed three times in a row while another model succeeded. A suspected limit is attributed to that model (or to the account, if the rule says so). If no reset time is known, Shipherd backs off and then probes the model with a tiny call. Errors it couldn't classify are listed under **Unrecognised errors**. **Is this a limit?** turns one into a learned rule, so the same error is recognised next time. **Not a limit** clears the suspicion.

### Interactive sessions

A coordinator's `start_session` takes a tier (`high`, `mid`, `low`) or a model name, and the old `opus` and `sonnet` still work. Shipherd picks a healthy model of that tier and returns the model it actually used. An unknown name is refused before any terminal opens. If your `claude` doesn't support `--model`, sessions open without it.

When a session hits a limit, its row shows the limit and a **Switch to next tier and continue** button. The button ends the terminal and resumes the same conversation with `--resume` and the next model's `--model`. With `routingAutoSwitch` on, Shipherd switches right away.

### Spending

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Monthly quotas | `routingQuotas` | empty | A JSON list of `{"target": "tier:high" or "model:<name>", "unit": "usd" or "tokens", "monthly": <number>}`. Money comes from the cost Claude Code reports, or tokens × the model's registered prices. Empty means no quotas. |
| Soft thresholds (%) | `routingThresholds` | `70,90` | Two whole numbers, the first lower than the second. Past the first threshold, tasks whose policy is fallback skip the model and drop to a lower tier. Past the second, only critical tasks still use it. Quotas never block a critical task. |
| Period start day | `routingPeriodStartDay` | `1` | 1 to 28, the day of the month a quota period begins (local time). |
| Effort | `routingEffort` | empty | A JSON object from a task id or a tier to `low`, `medium`, `high`, `xhigh` or `max`, passed as `--effort` when your `claude` supports it. A task entry wins over its tier's. |
| Concurrency caps | `routingMaxConcurrent` | empty | A JSON object from a tier to a whole number of background calls that may run on it at once, for example `{"high": 1}`. |
| Auto-switch sessions | `routingAutoSwitch` | `0` (off) | `1` or `0`. When on, a session that hits a limit switches to the next tier at once instead of showing the button. |

Spend by model and by task, health per model and the fallback event log are on the same page. The **Your turn** page shows a model limit or a fallback while it lasts.

## Effect page

The **Effect** page (in the **Shipherd itself** group of the sidebar, below **Retros and rules**) shows what Shipherd's PRs cost you and how they compare with before. The global control's `metrics_overview` returns the same data, for 1 to 365 days (30 by default). There is nothing to set.

- **Four cards**: per merged Shipherd PR, the average cycle time (PR opened → merged, and ticket started → merged), comments (human and Copilot, plus how many the lesson run marked avoidable), human interventions (and how long sessions waited on you) and cost in weighted tokens (and in dollars, from what Claude Code reports or estimated from the model's registered prices). Cycle time and comments are compared with a baseline; the other two show "before —" because there is nothing to compare them with.
- **Baseline**: once a day Shipherd reads from GitHub the PRs you opened yourself and that were merged in the 180 days before your first Shipherd session (up to 100 per repo, skipping PRs linked to a ticket), and stores their cycle time and comment counts. Comments from bots are left out, the same way as for Shipherd's PRs. "Ticket started" for these PRs is approximated by the first commit. The cutoff is fixed when the first Shipherd session appears and does not move afterwards. Until a read finds such PRs (for example while gh is not available), the page says there is no baseline yet.
- **Why sessions stopped for you**: how often each kind of stop happened (permission, choice, missing info, real question, stuck), how long each kept you waiting, and how many were resolved automatically. Idle time while a session is stopped but not waiting on you is counted separately.
- **Comments and CI**: what the [comment loop and CI triage](#comments-and-ci) did in the chosen range: comments handled automatically (Copilot and people, replied, resolved, still waiting for you), how often a CI failure passed after an automatic rerun (flaky), the time those flaky runs cost from the first failure, and the checks and tests that were flaky most often.
- **Trend** by week or by month (the last 12), **human interventions** by kind, **groups** (Shipherd PRs against other PRs linked to a ticket; by repo, product and risk level, where PRs without a level are "Unrated"), **where the cost goes** by model and by task, and **rework**: CI failures, reopened PRs and PRs reverted after merging. The same daily GitHub read finds reopens and reverts (a merged PR whose title is `Revert "<title>"` or whose body says `Reverts #N`).

Numbers are rolled up from local events once an hour; opening the page rolls up again if the last run is more than 10 minutes old. Time a session spent while the computer slept is not counted as waiting.

Three internal keys hold the dates these comparisons start from; none is edited directly. `metricsSince` is when Shipherd started recording metrics, `metricsBaselineCutoff` is the fixed baseline cutoff (your first Shipherd session), and `skillTrackingSince` is when the hook started recording review and design skill use, so PRs from before then are not counted as skipping them.

## Spend caps and background work

**Settings → Spend & background** has two parts: spend caps for sessions and tickets, and when background work may run. With nothing changed, Shipherd behaves as 2.1.0 did: no caps, and background work runs at any time.

### Spend caps

A cap limits how much one **session** may spend (the whole chain, including the sessions `/clear` continues) or one **ticket** (all its sessions plus the background calls charged to it, such as its needs-you and stuck checks and its lessons analysis). Spending comes from the same usage Shipherd already meters. In dollars it uses the cost Claude Code reports, or tokens × the registered prices. In tokens it uses the same weights as the quotas under [Spending](#spending).

Caps are set in layers, like the admission policy: **global**, then **product**, then **repo**. A repo's value beats its product's, which beats the global one. Leave a field empty to inherit; type `none` in a cap to make that layer explicitly unlimited. A ticket or session that spans several repos uses the strictest cap among them.

| Field | Key | Default | Accepted values and notes |
|-------|-----|---------|---------------------------|
| Cap per session | `sessionCap` | none | A positive number in the unit below, or `none`. |
| Cap per ticket | `ticketCap` | none | A positive number in the unit below, or `none`. |
| Unit | `unit` | `usd` | `usd` or `tokens`. |
| At the cap | `action` | `downgrade_then_pause` | `downgrade_then_pause`: switch to the next lower model through model routing, and pause if spending still passes the cap by the overshoot below. `pause`: pause right away. With no lower model, Shipherd pauses. |
| What to pause | `pauseScope` | `session` | `session`: Shipherd interrupts the turn the session is running (as if you pressed Esc), sends it no more messages, and stops its background calls. `background`: only its background calls stop; the terminal keeps going. |
| Overshoot after downgrading before pausing (%) | `graceAfterDowngradePercent` | `20` | 0 to 1000. |
| How much "Continue and raise the cap" adds (%) | `raisePercent` | `50` | 1 to 1000. The new cap is what was already spent plus this share of the cap. |

**What you see.** Past the first soft threshold of `routingThresholds` (70% by default) **Other notes from Shipherd** (under **How it is running** on the **Your turn** page) warns. At the cap, the **Your turn** page, the session's row and the tray tooltip say what happened. **Continue and raise the cap** clears the pause and raises the cap for that session or ticket only; changing the cap in settings resets that raise. A paused session that is still running 90 seconds after the pause, and has spent more since, has its terminal ended unless you typed in it; if you type in it yourself, Shipherd leaves it to you. A paused session is never woken from hibernation. Every warning, downgrade, pause, stop and resume is listed under **Recent events** on the same page.

The spend caps don't replace the stuck judge: the stuck check and the needs-you check still run while a session or ticket is over its cap, and a stuck session is still reported even when it is within budget.

### Background work

Background work (lessons analysis and backfills, lesson admission, and the kinds later features add) comes after the sessions you are using. Each kind has a priority (`high`, `normal`, `low`) and may be limited to certain times. When it has to yield, nothing is lost: an interrupted item goes back to the queue and runs again later (kinds that save a checkpoint continue from it), also after a restart. Background work never wakes a hibernated session.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| When to run | `bgWindow` | `anytime` | `anytime`, `idle` ("Only while I'm idle"), `hours` ("Only in these hours") or `idle_or_hours`. `high` priority kinds ignore this. |
| These hours | `bgHours` | `22:00-07:00` | Comma-separated `HH:MM-HH:MM` ranges in local time; a range may cross midnight. |
| Idle after (minutes) | `bgIdleMinutes` | `10` | 1 to 240. Minutes without keyboard or mouse input on macOS or Windows before you count as idle. A locked screen counts as idle at once. |
| When it has to yield | `bgYield` | `finish` | `finish`: work already running finishes, nothing new starts. `interrupt`: work that can be stopped stops now and is requeued. |
| When quota is tight | `bgQuotaOrder` | `pause_first` | `pause_first`: past the first soft threshold low-priority background work pauses, and past the second normal-priority work pauses too. `downgrade_first`: background work keeps running on the lower tier model routing picks, and only low-priority work pauses, past the second threshold. `high` priority keeps running either way. Model routing still moves fallback tasks to a lower tier past the first threshold. |
| Plentiful quota (%) | `bgPlentifulPercent` | empty | 1 to 99. While every quota is below this share, background work runs outside its hours and while you are active too. Empty turns it off. |
| Per-kind changes | `bgKinds` | empty | A JSON object from a kind to `{"priority": ..., "window": ..., "paused": true}`. The table on the page writes it for you. |

The table on the page shows each kind, whether it may run now and why not (paused by you, spend breaker, quota, yielding to you, outside the hours), and how many items are queued and running. A kind that opens a session also asks the memory admission check first and waits while it refuses. **Pause** stops one kind until you resume it. Lesson admission covers both automatic admission (`lessonsAutoAdmit`) and the daily principles regroup (`lessonsPrinciples`): while its row may not run, they wait and try again later. A repository scan runs only when you start one (or during setup), so it is not in the table and these settings don't hold it.

## Lessons: bulk actions, admission policy and import / export

### Bulk actions and batches

On the **Lessons** page you can filter the list (repository or product, status, admission, checkability, shelved reason, minimum hits, score range, batch, text, only output of a fallback model) and then act on **every lesson that matches** in one step: **Confirm all N**, **Reject all N**, **Disable all N**, **Enable all N** or **Delete all N**. You can also tick single pending lessons and act on just those. **Accept all recommended (M)** confirms the lessons the admission pipeline recommended (admission `auto`) and leaves the rest alone.

Every bulk action, every single confirm / reject / edit / disable / delete / merge, deleting a product (with its lessons and policy layer), every policy change and every import is recorded as a **batch** with a snapshot of each row before and after. The **Batches** tab lists them; **Undo** puts every row of a batch back as it was. A row that has changed again since that batch is left alone and counted as skipped; so is a product or lesson the batch created that something added later now depends on. A merge is undone as a whole or not at all. A batch counts as undone once at least one row was put back; undoing is itself recorded and cannot be undone again. Deleting a lesson also deletes the lessons merged into it, and undo brings them back merged. If the list changed after the page counted (for example a background analysis added matching lessons), a bulk action only touches the lessons the page had shown, and does nothing if it would change more than the number on the button. Merging no longer deletes the merged lesson: it is kept, hidden, pointing at the lesson it was merged into, so the merge can be undone.

Old lessons that you had already confirmed, disabled or rejected keep their status and get admission `manual`.

### Backup and export settings

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Back up all configuration automatically every this many days (0 = off) | `configBackupIntervalDays` | `0` | A whole number from `0` (off) to `365`. Shipherd writes a full export to `<SHIPHERD_HOME>/backups/auto-<time>.json` once per interval (job `config_backup`; a failure is retried after an hour). Backups never contain secrets or local paths. |
| Automatic backups to keep | `configBackupKeep` | `10` | A whole number from `1` to `999`. Only the newest automatic backups are kept; backups written before a replace import and backups you start with **Back up now** are never removed. |
| Remind me to export after this many days (0 = off) | `configExportReminderDays` | `30` | A whole number from `0` (off) to `365`. When you have confirmed lessons and neither an export nor a backup has happened in this many days (counted from your first confirmed lesson if there has never been one), the Import / export tab and the Lessons tab say so. |

`configLastExportAt` records when you last exported, for that reminder; it is not edited directly.

### Admission policy

The admission policy decides how the lesson pipeline scores, shelves, backtests, shadows and demotes rules. Every key can be set on three layers: **global**, **product** and **repository**. A repository uses its own value for a key, else the value of a product it belongs to, else the global value, else the default; the layers are merged key by key. When a repository belongs to several products that set the same key differently, the product whose name sorts last wins and **Settings → Lessons → Admission policy** shows a warning. Each change is an undoable batch and raises the policy version (scores record the version they were computed with; the current version is kept in `admissionPolicyVersion`, which is not edited directly). The defaults have not been calibrated yet; the page says so.

| Key | Default | Values | What it does |
|-----|---------|--------|--------------|
| `score.weight.evidence` | `0.24` | 0–1 | Weight of evidence (hits, PRs, reviewers) in the score |
| `score.weight.clarity` | `0.16` | 0–1 | Weight of clarity |
| `score.weight.consistency` | `0.16` | 0–1 | Weight of consistency with the existing rules |
| `score.weight.verifiability` | `0.24` | 0–1 | Weight of verifiability (can it become a check) |
| `score.weight.performance` | `0.2` | 0–1 | Weight of measured performance in shadow mode |
| `score.admitLine` | `0.7` | 0–1 | A checkable rule scoring at least this is admitted |
| `score.dropLine` | `0.3` | 0–1 | A rule scoring below this is shelved |
| `score.proseAdmitLine` | `0.8` | 0–1 | Admission line for rules that can only stay as prose |
| `score.untestedCap` | `0.69` | 0–1 | Highest score for a rule that has not been backtested |
| `score.reviewerBonus` | `0.05` | 0–1 | Bonus when a human reviewer raised the rule |
| `score.recencyHalfLifeDays` | `180` | whole number 1–3650 | Half-life in days for old evidence |
| `score.degradedPenalty` | `0.1` | 0–1 | Penalty when the analysis ran on a fallback model |
| `score.evidenceFullHits` | `5` | whole number 1–1000 | Hits that give full marks for how often a rule came up |
| `score.evidenceFullPrs` | `3` | whole number 1–1000 | Distinct PRs that give full marks for how widely it came up |
| `score.minClarity` | `0.4` | 0–1 | A rule whose clarity is below this is shelved |
| `batch.sampleSize` | `20` | whole number 1–1000 | How many items of an automatic batch are sampled for review |
| `batch.minSamplePassRate` | `0.8` | 0–1 | Lowest share of the sample that must pass |
| `batch.minCoverage` | `0.3` | 0–1 | Lowest share of the batch that must get a verdict |
| `batch.maxShelvedShare` | `0.7` | 0–1 | Highest share of a batch that may be shelved |
| `batch.minBacktestRecall` | `0.01` | 0–1 | Lowest backtest recall for the batch as a whole |
| `batch.maxBacktestFalsePositiveRate` | `0.2` | 0–1 | Highest backtest false-positive rate for the batch |
| `dedupe.minSimilarity` | `0.35` | 0–1 | Text similarity at which two rules are sent to the model as possible duplicates |
| `dedupe.maxGroup` | `30` | whole number 2–100 | Rules per duplicate or conflict check call |
| `generality.minHits` | `2` | whole number 0–1000 | Times a rule must have come up |
| `generality.minPrs` | `2` | whole number 0–1000 | Distinct PRs it must have come up in |
| `generality.minReviewers` | `0` | whole number 0–100 | Distinct reviewers who must have raised it |
| `generality.allowSingleReviewer` | `true` | `true` / `false` | One reviewer raising the same thing in several PRs counts as a team habit |
| `backtest.recentPrs` | `50` | whole number 1–1000 | How many recent merged PRs a check is backtested on |
| `backtest.minRecall` | `0.01` | 0–1 | Lowest recall in the backtest |
| `backtest.maxFalsePositiveRate` | `0.2` | 0–1 | Highest false-positive rate in the backtest |
| `backtest.allowUntestedShadow` | `true` | `true` / `false` | Rules that cannot be backtested may still run in shadow mode |
| `backtest.lineTolerance` | `3` | whole number 0–50 | Lines between a backtest hit and a review comment that still count as the same place |
| `backtest.judgeSample` | `20` | whole number 0–200 | Unmatched backtest hits a model checks per rule (0: every unmatched hit counts as a false positive) |
| `shadow.minPrs` | `5` | whole number 0–1000 | PRs a rule must run on in shadow mode before promotion |
| `shadow.minDays` | `7` | whole number 0–365 | Days in shadow mode before promotion |
| `shadow.maxFalsePositiveRate` | `0.2` | 0–1 | Highest false-positive rate in shadow mode |
| `shadow.minAdoption` | `0.6` | 0–1 | Lowest share of findings that were acted on |
| `shadow.autoPromote` | `false` | `true` / `false` | Promote out of shadow mode automatically when the bars are met |
| `shadow.minHits` | `3` | whole number 0–1000 | Findings a rule must have in shadow mode before promotion is considered |
| `conflict.autoPickHigherHits` | `false` | `true` / `false` | Settle conflicting rules by keeping the one with more hits |
| `demote.enabled` | `true` | `true` / `false` | Demote admitted rules that stop paying off |
| `demote.maxBypassRate` | `0.3` | 0–1 | Demote when a rule is bypassed more often than this |
| `demote.noReductionPrs` | `10` | whole number 1–1000 | Demote after this many PRs without fewer repeat comments |
| `demote.to` | `shadow` | `shadow` / `review` | Where a demoted rule goes: shadow (shadow mode) or review (back to the queue) |
| `demote.minEvents` | `5` | whole number 1–1000 | Blocks a rule must have before its bypass rate counts |
| `review.intervalDays` | `7` | whole number 1–365 | Days between threshold reviews |
| `review.minSamples` | `10` | whole number 1–1000 | New calibration samples needed before thresholds are reviewed |
| `admission.autoConfirm` | `false` | `true` / `false` | Confirm rules that pass admission without asking |

### Automatic admission

Shipherd can judge pending lessons for you. Judging runs four gates on the candidates of a repository, a product (with all its repositories) or everything, then scores what is left:

1. **Duplicates.** Lessons whose text is similar enough (`dedupe.minSimilarity`) and whose file patterns overlap go to the model, which says which ones say the same thing. The one with the most hits stays; the others are shelved as `duplicate` pointing at it. When the group spans several repositories of one product, the lesson that stays is moved up to the product when you accept. A lesson you had already confirmed always stays as it is.
2. **Conflicts.** Lessons that could contradict each other go to the model. Both sides of a conflict are shelved as `conflict` and point at each other, unless `conflict.autoPickHigherHits` is on (then the one with more hits stays). A confirmed lesson is never shelved; only the candidate that contradicts it is.
3. **Generality.** A lesson must have come up at least `generality.minHits` times in `generality.minPrs` distinct PRs. One reviewer raising the same thing in several PRs counts as a team habit unless `generality.allowSingleReviewer` is off. Lessons that came up only once are shelved as `generality`, not dropped: a new hit brings them back.
4. **Checkability.** The model sorts each lesson into checkable or prose and says when an existing check or lint already covers it (shelved as `covered`). Changing the category by hand re-judges the lesson and is recorded as a calibration sample.

The score combines evidence (hits, PRs, reviewers, how recent), clarity (can you tell right code from wrong code with it; lessons from a fallback model lose `score.degradedPenalty`) and consistency (1, or 0.5 when another lesson limits it). Expand a lesson's score on the Lessons page to see each part and why. A lesson at or above the admit line (`score.admitLine`, or the stricter `score.proseAdmitLine` for prose) is **recommended**; between the lines it is shelved as `low_score` with its weakest part named; below `score.dropLine` it is shelved as `below_drop`. A checkable lesson that is recommended gets a check draft in shadow mode; its score is capped at `score.untestedCap` until it has been backtested.

Judging only sets fields (admission, shelved reason, score); it is recorded as an undoable batch. A sample of `batch.sampleSize` recommended lessons is then reviewed by a different model. If not every sampled lesson could be reviewed (for example the review call failed), the sample pass rate is below `batch.minSamplePassRate`, or more than `batch.maxShelvedShare` of the judged lessons were shelved, "Accept all" is hidden and the weakest metric is named; single lessons can still be confirmed one by one. **Accept all recommended** merges the duplicates, moves cross-repository lessons up to their product, confirms the recommended lessons and writes their check drafts as shadow checks, all in one batch that one **Undo** reverses. Model answers are cached, so judging again only asks about new or edited lessons. When a model call fails, the lesson is left pending and counted as unfinished. A lesson you confirm, reject or edit while a pass is running keeps your decision; the pass does not overwrite it.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Judge new lessons automatically | `lessonsAutoAdmit` | `0` | `1` or `0`. When on, after an analysis adds or hits lessons, that repository is judged in the background (recommendations only; they are confirmed automatically only when `admission.autoConfirm` is on and the sample review passes). |
| Group lessons into principles | `lessonsPrinciples` | `0` | `1` or `0`. When on, confirmed lessons that share one principle are grouped once a day, and the session guide shows the principle with a pointer to its cases. |
| Short core guide | `lessonsCoreGuide` | `0` | `1` or `0`. When on, the session guide keeps at most 10 core lessons (the most often broken first). |

`admissionCalibratedAt` records when you marked the score lines calibrated on the **Calibration** tab; it is not edited directly. `lessonsPrinciplesRegroupedAt` records the last daily principles grouping, so a restart does not group again the same day; it is not edited directly either.

### Setup wizard

The **Setup wizard** tab on the Lessons page does the first pass for a repository, a product or everything. Before you start it shows, per repository, how many merged PRs there are and how many are already analysed, plus the expected number of model calls and an estimated time (from how long past analyses took). A repository that an accepted wizard already covered is marked **set up**. The list of merged PRs is fetched from GitHub at most once every 10 minutes. It then:

1. scans the existing code (repositories without a local clone are skipped; the summary notes repositories that have no lint);
2. analyses the merged PRs that are not analysed yet and fills in missing fields of older lessons;
3. backtests every repository in scope (see below; a repository without a local clone or `gh` makes the summary say **not backtested**, and scores of checkable lessons stay capped);
4. judges every candidate as described above and waits for you.

The wizard survives a restart: it picks up at the stage it was in, and items already done are not asked again. A call that fails is retried automatically after 1, 5 and 15 minutes; after that it waits for **Retry now**. A model limit only delays an item and does not use up an attempt. An item that a later pass no longer needs (its group changed, or the lesson is no longer a candidate) is dropped instead of retried. Failed PR analyses are retried from the analysis queue on the **Runs** tab, not here. **Cancel** is final: a pass that is still running writes nothing afterwards. You do not have to wait for the retries: the summary is ready after the first pass and counts the unfinished items, and it is updated when a retry succeeds.

The summary shows PRs analysed, failed and skipped, candidates, lessons recommended (as text or as checks), merged, shelved per reason and covered, the sample pass rate (and whether the review had to use the same model), and how many model calls the wizard made. **Accept all** confirms the recommended lessons in one batch that one **Undo** reverses; it is hidden, with the weakest metric named, when the sample review is past its floor. Shelved lessons are grouped by reason: pull one back or a whole group (each one becomes a calibration sample), or reject a group. After changing the lines in the admission policy, **Recalculate** re-scores and re-decides without analysing again; cached answers are reused, so the model is asked only about lessons that were not judged before (for example ones the new lines now let through), and failed items are not retried (that is what **Retry now** does). Shelved lessons that you have since pulled back, rejected or confirmed elsewhere are no longer listed.

### Calibration

The **Calibration** tab draws up to five scored lessons from each band (at or above the admit line, between the lines, below the drop line) and asks whether each should be accepted; each lesson shows its score parts. A lesson exactly on the drop line counts as between the lines, and a high-scoring lesson whose clarity is below `score.minClarity` counts as shelved by the pipeline. Only lessons of the current draw can be marked. Every mark is recorded as a calibration sample next to the ones recorded when you override the pipeline; marking a lesson again in the same draw replaces your earlier mark. The page shows, per band, how many you marked and how many you would accept, the agreement with the pipeline for this draw and for all samples, and the score weights and lines, which you can edit in place. **Mark as calibrated** records the time in `admissionCalibratedAt` and removes the "not calibrated yet" note from the policy editor.

### Backtests, promotion and demotion

Before a checkable lesson is admitted, Shipherd backtests its draft check on the last `backtest.recentPrs` merged PRs of each repository in its scope. It fetches the diffs and inline review comments with `gh` from the local clone, keeps them in the database (a restart or a yield continues where it stopped) and runs the check on the lines each PR added. Nothing is run on the history: `run_command` checks are not backtested.

- **Recall** is the share of the review comments the lesson came from that the check would have caught: the check runs on the file as the reviewer saw it, and a violation within `backtest.lineTolerance` lines of the comment counts as caught.
- **False positives** are hits on lines a PR added that no inline review comment of that PR is near. Up to `backtest.judgeSample` of them per lesson go to the model (task `backtest_judge`), which says whether each is a real violation; with `0`, every unmatched hit counts as a false positive.
- A lesson whose recall is below `backtest.minRecall` is shelved as `backtest_recall`; one whose false-positive rate is above `backtest.maxFalsePositiveRate` is shelved as `backtest_fp`. Otherwise both numbers become the **verifiability** part of the score.
- A repository without a local clone, without `gh` (not installed: at once; failing: after three tries) or without usable PRs is not backtested. Only the repositories in a check's scope count toward its backtest. With `backtest.allowUntestedShadow` on, the lesson is still scored (verifiability left out, score capped); with it off, it is shelved as `untested`.

The **Checks** tab shows, for each check, the backtest (PRs, hits, recall, false-positive rate and the existing violations in the current code), its score, how often it was bypassed or ignored, and **Backtest again**. The hourly review also queues a backtest for every enabled check that has no result for its current definition (hand-written, imported or edited checks). The setup wizard backtests every repository in its scope after the analysis step, and the batch review uses the coverage and overall backtest numbers of the batch.

**Promotion.** With `shadow.autoPromote` on, Shipherd reviews the checks once an hour. A shadow check is promoted to enforce when it is enabled, blocks (not just warns), passed its backtest, scores at least `score.admitLine`, ran for at least `shadow.minPrs` PRs or `shadow.minDays` days, failed at least `shadow.minHits` times, at least `shadow.minAdoption` of its findings were fixed and at most `shadow.maxFalsePositiveRate` of them were false positives (your verdicts on the hits, plus the model's on a sample; with `backtest.judgeSample` at `0`, hits nobody marked count as false positives). Adoption only counts edit-time hits: a check that runs before push has no record of being fixed, so it is not promoted automatically. The Checks tab shows how far each shadow check is and what is still missing. All checks promoted in one review form one batch with its reasons; **Other notes from Shipherd** on the **Your turn** page shows it with **Undo**. If every check in the batch changed since, Undo restores nothing and the notice stays. A check whose promotion you undid, or that you set back to shadow by hand, is not promoted again until you clear its review flag.

**Demotion.** With `demote.enabled` on, an enforced blocking check is demoted when, after at least `demote.minEvents` blocks, it was bypassed (suppression comments, `--no-verify`, hooks turned off, the snapshot changed) or ignored (only edit-time blocks can be ignored) at a rate of `demote.maxBypassRate` or more. A second reason, similar review comments not dropping over `demote.noReductionPrs` PRs after the check was enforced, needs review-comment trends that Shipherd does not record yet, so it does not fire for now. With `demote.to` set to `shadow`, a check that Shipherd promoted goes back to shadow mode in one undoable batch; any other check, or with `demote.to` set to `review`, is only flagged **Needs review** on the Checks tab. **Clear review flag** removes it, and Shipherd counts blocks, bypasses and fixes again from that moment. Notices stay under **Other notes from Shipherd** for 14 days.

**Threshold review.** Undoing an automatic promotion or demotion, or changing a check's mode by hand within 14 days of one, is recorded as a calibration sample, and so is enforcing a shadow check by hand. Every `review.intervalDays` days, once there are `review.minSamples` new samples, Shipherd checks whether `score.admitLine`, `backtest.maxFalsePositiveRate`, `shadow.minAdoption`, `shadow.maxFalsePositiveRate` and `demote.maxBypassRate` would have agreed with you more often at a slightly different value (at most 0.05 away). Suggestions appear on the **Calibration** tab; **Apply** writes the global admission policy as an undoable batch. `backtestThresholdReviewAt` records the last review; it is not edited directly.

### Principles and the core guide

With `lessonsPrinciples` on, Shipherd asks the model once a day (or when you press **Group now** in Settings) which confirmed lessons of one repository or product share a principle; a principle needs at least three lessons. The grouping is one undoable batch, and it is recorded apart from the lessons themselves: undoing an older batch of lessons keeps the grouping, and the daily grouping never stops you undoing one. A principle whose lessons have not changed keeps its id, and answers are cached, so an unchanged set of lessons costs no call. In the session guide a principle replaces its lessons with one line, "principle (N cases)", and its cases go to a file next to the guide that the session reads when the principle is relevant. A principle with fewer than three cases left in the guide (some were disabled or rejected since) is not shown; its lessons appear one by one. With `lessonsCoreGuide` on, the guide keeps at most 10 lessons, the ones broken most often since they were confirmed first.

### Export file

**Import / export** on the Lessons page exports everything, one product or one repository, and either all content, lessons only (with products) or checks only (once checks exist). The file is JSON:

```json
{
  "format": "shipherd-config",
  "formatVersion": 1,
  "exportedAt": 1763337600000,
  "shipherdVersion": "3.0.0",
  "scope": { "kind": "all" },
  "options": { "content": "all", "includeSourceUrls": false },
  "sections": { "products": [], "policies": [], "lessons": [] }
}
```

- **No secrets, no local paths, no comment text, no scores.** Lessons carry their text, reason, owner (repository slug or product name), status, admission, scope fields, hits and how many sources and distinct PRs they came from. Source PR links are included only when you tick **Include source links**.
- A file from a newer Shipherd (higher `formatVersion`) is refused; an older one is upgraded first. Sections this Shipherd does not know are skipped and listed.
- Every item has a stable **fingerprint** built from what it is, not from local ids: a lesson's normalised text (trimmed, spaces collapsed, lower case) plus its owner and path globs; a product's name; a policy layer's global / product name / repository slug.
- **Preview** shows each item as added, changed, conflicting (a decision differs: a lesson's status, strength or checkability, a product's repositories or a policy value), unchanged, or removed (replace only).
- **Merge** adds new items and keeps your local version of changed and conflicting ones by default; local items the file lacks stay. **Replace** first writes `<SHIPHERD_HOME>/backups/before-replace-<time>.json` (if that fails nothing changes), takes the imported version by default and removes local items in the file's scope that the file lacks. Either way you can switch every row to **all imported** or **all local**, or pick row by row.
- Imported lessons arrive **pending** (lessons the file had rejected stay rejected), in one batch you can undo from the Batches tab. Repositories this machine has not cloned are added without a local path and marked **not cloned on this machine**; their history cannot be analysed until Shipherd sees a clone. When a status conflict would confirm a lesson that is not confirmed here, the row says so.
- A **starter pack** exports your confirmed lessons without owner, status, hits or sources. Importing one asks which repository or product to add them to.
- **Model routing** (section `models`) is only in a full export of everything: registered models (name, tier, account, prices, note), each tier's chain, task overrides and your own and learned limit rules. Health, spend, events, unrecognised errors and rule notes stay on this machine. Imported models and rules arrive **disabled**, so an import never changes which model runs until you enable them on **Settings → Model routing**; ones you already have keep their on/off state. A different tier, account, price, chain order or task setting is a conflict. The routing tables are not part of batch undo: remove what you do not want on the routing page, or restore the backup a replace import writes first.
- **Permission profiles** (section `permissions`): each repository's confirmed and dismissed rules, by repository name. Rules still waiting for you are not exported. Every rule is checked again on import, and a rule that isn't read-only is refused. An imported confirmation waits on **Settings → Interruptions & notifications** until you confirm it on this machine; an imported dismissal applies right away. A different status for the same rule is a conflict.

## Checks: deterministic rules on every edit

A check is a rule Shipherd can test without a model: a forbidden pattern, an import boundary, a comment policy, or a command to run. Checks live on the **Checks** tab of the Lessons page, in the same three layers as admission policy (global, product, repository; the nearest layer wins, a repository can switch off or override an inherited check by its key). You can write one by hand, or press **Make a check** on a lesson: Shipherd drafts one from the lesson text with a model, and you review it before saving. A lesson can also be marked **text only** when it cannot be checked mechanically.

- Shipherd writes the enabled checks to `<SHIPHERD_HOME>/checks/snapshot.json`. The `shipherd-hook check` hook reads only that file (never the database) after every `Edit`, `Write` or `MultiEdit` in a Shipherd session, and `shipherd-hook check-push` runs the push-stage checks when the agent runs `git push`. Sessions outside Shipherd are not affected; your own Claude Code settings are never changed.
- The hook finds the repository from the file's folder (its `origin` remote). A folder without a remote, an unreadable snapshot or a snapshot from another Shipherd version is let through and noted as **checks absent** on the session.
- Path globs (`globs`, `excludeGlobs`) match the path relative to the repository root, with `/` or `\` alike.
- **Types.** `forbidden_pattern`: a regular expression (or literal text) that must not appear in new lines. `import_boundary`: imports matching `forbid` (repository path globs or package names such as `electron`) are not allowed unless they match `allow`. `comment_policy`: a comment that says the code is temporary (built-in keywords in English and Chinese, such as *temporary*, *workaround*, *TODO*, 临时, 先这样) must carry a ticket id matching the ticket pattern; this built-in check exists from the start but is **off**. `run_command`: a shell command (`/bin/sh` on macOS and Linux, Git Bash on Windows); `{file}` is replaced by the changed file, passed as an argument, never pasted into the command; the file is also in the `SHIPHERD_CHECK_FILE` environment variable. An edit-stage command without `{file}` gets the file appended only when it is a single simple command (`eslint --max-warnings 0`); a compound command (with `;`, `&&`, `|`, redirection or a subshell) runs as written. Edit-stage commands run on the changed file only; push-stage commands run once before the push.
- **Modes.** A new check, and every imported one, starts in **shadow** mode: hits are only recorded. Switch it to **enforce** once its hit list looks right. An enforced `block` check sends the failure back to the agent as a hook block (the edit stays, the agent is told to fix the root cause); an enforced `warn` check and every shadow hit only add a note. Only violations that the edit introduced are reported, and each one once.
- A command that runs out of time is killed with its whole process tree and recorded as **could not check**; the edit is let through. Regular expressions (forbidden patterns, ticket patterns) get at most two seconds per edit; one that takes longer (for example a nested quantifier such as `(\w+\s?)+$`) is stopped and also recorded as **could not check**. A session started before you raise a time limit keeps the limit it started with. A failing push-stage check stops the `git push` with the reason. The merge gate is unchanged.
- The Checks tab shows, per check, its hits, how many were fixed by the agent afterwards (adoption) and how many you marked as false positives. Hits older than a year are removed.

| Setting | Key | Default | Notes |
| --- | --- | --- | --- |
| Run checks in sessions | `checksEnabled` | `1` | `1` or `0`. Off: the hooks are not registered for new sessions and running sessions are let through. |
| Time for checks after each edit (seconds) | `checksEditTimeoutSec` | `8` | A whole number from `1` to `30`. Shared by all edit-stage checks for one edit. |
| Time for checks before a push (seconds) | `checksPushTimeoutSec` | `600` | A whole number from `10` to `3600`. Shared by all push-stage checks. |

Checks are exported and imported with the other configuration (**Checks only** or **All**). They are matched by key and layer; a change in behaviour (type, parameters, globs, severity, on/off) is a conflict and, if imported, goes back to shadow mode; a change of name or message alone keeps your mode. A `run_command` check that is new or whose command changed arrives **switched off**, because even shadow mode runs the command: the preview shows each command, and you switch it on after reading it. A checks-only file never removes your products, even in replace mode. Replace never removes the built-in checks.

## Pre-review, readiness and risk

Shipherd can check a change before you review it. Everything here is off or read-only by default: with nothing configured, you only see each PR's readiness and risk on the ticket page and on the epic pages.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Pre-review | `preReviewEnabled` | `0` (off) | `1` or `0`. When on: the dev session's guide asks it to hand in completion evidence (`submit_evidence`: checks with commands and output, how each acceptance criterion is met, screenshots for UI changes, checks not run and why) and says a pre-review runs before the PR; Shipherd reruns the repo profile's commands at that commit, cross-checks the evidence, compares the diff with the repo's confirmed lessons and check results, and sends the violations back into the session; new PRs and new commits on Shipherd PRs get a pre-review too; a review brief is written after each pre-review. |

Each PR gets a **readiness** (six conditions: CI and blocking checks, pre-review clean, evidence complete, no open review comments, mergeable, a description that says what, why and how it was verified) and a **risk level** (low, medium, high, with the reasons: migrations, auth, public API, config, CI config, large diffs, several repos, check warnings, missing evidence, ticket type). Both are computed without a model and never act on GitHub: they only explain and sort the "Needs review" list. When pre-review is off, the pre-review and evidence conditions show as off and do not count.

The **review brief** is one page (what changed and why, risk, verified evidence, pre-review findings, files worth a close look, trade-offs). It stays in Shipherd; **Post to PR** writes it into the PR description inside a `<!-- shipherd:brief -->` block (the rest of the description is left alone) and is recorded in the audit log. Posting it automatically after each pre-review is the outward action `externalPrBriefPost` (below).

Readiness conditions, evidence requirements and risk rules are a three-layer policy (global, product, repository) edited on the **Pre-review and readiness** settings tab and exported with the configuration: `readiness.<condition>.enabled`, `readiness.descriptionMinChars` (80), `readiness.shouldBlocks` (`false`; when on, "should" findings from a clean pre-review also fail the pre-review condition), `readiness.whatWords`, `readiness.whyWords` and `readiness.verifyWords` (extra words that count as saying what, why and how it was verified, added to the built-in ones), `evidence.require.<test|lint|typecheck|build>` (`auto` follows the repo profile), `evidence.rerun` (`all`, `fast` or `off`), `evidence.rerunTimeoutSec` (600), `risk.paths.<class>` (extra globs, added to the built-in list across layers; `risk.paths.<class>.builtin = false` drops the built-in list, except for migrations), `risk.size.*` and `risk.types.*` (`label=type`, `prefix=type`, `type=level`).

## Outward actions

Some features let Shipherd leave something outside your machine on your behalf, such as a reply under a PR comment. Today the repo rule export uses **Push branches** and **Open PRs**, and [Comments and CI](#comments-and-ci) uses **Reply to review comments**, **Resolve comments** and **Rerun CI**, and [Stacks](#stacks) use **Force push**, **Push branches**, **Open PRs**, **Edit PR titles**, **Edit PR descriptions**, **Add or remove PR labels** and **Post issues**; the other switches take effect as later features start using them. Each kind of action has its own switch under **Settings → Outward actions**, and all of them are off by default. While a switch is off Shipherd doesn't take that action; it only records a skipped entry. Every action taken, failed or skipped is listed under **Outward actions** on the **Audit** page (along with the read-only [update checks](#general)), with the repo, ticket, target and what was sent, and is kept as long as **Keep audit records (days)** (`auditRetentionDays`, below). **Push notifications** is used by [notifications](#notifications).

| Setting | Key | Default | What it allows |
|---------|-----|---------|----------------|
| Reply to review comments | `externalCommentReply` | `0` (off) | Replying under PR comments as you. |
| Resolve comments | `externalCommentResolve` | `0` (off) | Marking review threads on a PR as resolved. |
| Edit PR descriptions | `externalPrDescriptionEdit` | `0` (off) | Rewriting a PR's body. |
| Add or remove PR labels | `externalPrLabel` | `0` (off) | Adding labels to a PR or removing them. |
| Open PRs | `externalPrOpen` | `0` (off) | Opening a new PR with `gh`. In a stack it also covers moving a PR's base to the trunk, marking a PR ready for review and closing a draft that goes back to a plain branch. |
| Push branches | `externalBranchPush` | `0` (off) | Pushing a branch Shipherd made, such as a repo rule export, to the remote. |
| Edit PR titles | `externalPrTitleEdit` | `0` (off) | Changing a PR's title. |
| Force push | `externalForcePush` | `0` (off) | Rewriting a remote branch's history. |
| Rerun CI | `externalCiRerun` | `0` (off) | Starting failed CI runs again. |
| Post issues | `externalIssuePost` | `0` (off) | Creating issues or comments in your tracker or on GitHub. |
| Push notifications | `externalPushNotification` | `0` (off) | Sending notifications to an outside service, such as phone push or chat. |
| Post review briefs | `externalPrBriefPost` | `0` (off) | Writing the review brief into the PR description after each pre-review. The "Post to PR" button works either way and is recorded in the audit log. |
| Intake: ask on the tracker | `externalIntakeTrackerComment` | `0` (off) | Letting a session or the global control ask for missing information on the tracker ticket when [automatic intake](#automatic-intake) finds it incomplete. |
| Intake: change ticket status | `externalIntakeTrackerStatus` | `0` (off) | Telling a session that automatic intake started to move its tracker ticket to In Progress first. |
| Ask a bot to review | `externalPrReviewRequest` | `0` (off) | When a workflow reaches bot review, Shipherd asks Copilot to review or comments `@codex review` on the PR. When off, the session is reminded to ask itself. |

Each switch is `1` or `0`.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Keep audit records (days) | `auditRetentionDays` | `90` | 1 to 3650. How long the outward-action records on the Audit page and the [notification log](#notifications) are kept. Older records are cleared at startup and as new records come in. |

## Repo baseline: what each repository already checks

The **Repo baseline** tab of the Lessons page reads what a repository already checks on its own (lint, type checks, tests, builds, security and format tools) and where each one runs: at commit, at push or in CI. Nothing happens until you press **Scan** or **Scan all**. **Scan all** scans three repositories at a time and queues the rest. A scan only reads the repository; it never changes a file, runs a command or touches a branch. A symbolic link that points outside the repository is not read.

- **How it reads a repository.** First the marker files (for example `package.json`, `pyproject.toml`, `go.mod`, `.pre-commit-config.yaml`, ESLint and TypeScript configs), then the commands in the CI configuration (GitHub Actions, GitLab CI and similar), matched by keyword. When those are not enough and **Fill in unknown repos with the model** is on, Shipherd asks a model to read the repository (read-only tools, through model routing task `repo_scan_infer`). What the model adds is marked **model inference** with **low** confidence.
- **Monorepos.** Each project directory (each `package.json`, `pyproject.toml`, `go.mod`… below the root) is listed separately, and every check belongs to its directory.
- **Confidence.** A command in CI or an explicit script is **high**; a tool that is only configured is **medium**; a model guess is **low**. Low-confidence results never become checks by themselves.
- A repository without a local copy, one that cannot be read or one that is not a git repository is **skipped**, with the reason shown.
- **Add basic checks first.** A project without lint, a type check or tests (where the language has one) is listed under this advice.
- **Checks ready to use.** Each command the repository already runs can become a `run_command` check that reuses the command, so Shipherd sessions run what the repository's CI would run. Pick them and press **Create**; they start in shadow mode. A low-confidence one must be ticked **I checked this command** before it is created. **Make a check** on a lesson also gets the baseline, so the draft reuses the repository's commands.
- **Repo profile in the session guide.** Ticket and fix sessions get a short profile of their own repositories in the session guide: how to install, build, run all tests, run one test, lint and type check, the directory conventions and the CI steps, at most **Characters per repo in the session guide** per repository. Other repositories are never included. A profile whose config files changed since the scan is marked as possibly out of date, and with **Rescan in the background** on Shipherd rescans it after the launch (without the model).
- **Marker table.** Which file means which tool is data, not code: the built-in rules are the defaults, and at the global, product or repository layer you can change a rule's fields, turn it off or add a new one (JSON). The nearest layer wins.

### Existing code and export as a repo rule

On the **Checks** tab, **Existing code / export** under a check shows two actions for one repository:

- **Scan existing code** runs the check over every tracked file of the repository and shows **N existing** with the list of places (200 at a time). It runs in the background and can be stopped; it reads at most **Most files a legacy scan reads** files. A `run_command` check is only scanned when you press the button, since that runs the command on each file.
- **Export as a repo rule** turns the check into the repository's own rule, so it runs for everyone, not only in Shipherd sessions. Shipherd picks the target from the baseline: a `pre-commit` hook (`pygrep` for patterns), ESLint `no-restricted-imports` for package import boundaries, a lint-staged entry or a husky hook for commands, or else a small checker script in the repository's own runtime (`scripts/shipherd-checks/<name>.mjs`, `scripts/shipherd_checks/<name>.py` or `scripts/shipherd-checks/<name>.sh`) wired into whichever of those exist plus a `package.json` script or Makefile target. It is written into a new branch `shipherd/check-<name>-<key>` off the remote's default branch, in a worktree under `<SHIPHERD_HOME>/exports/<id>`, and committed locally (left staged when git has no `user.name` / `user.email`). Your own checkout is never touched, and the repository's own git hooks do not run while Shipherd commits there. A generated `.sh` file and a husky hook are listed in `.gitattributes` as `text eol=lf`, so a Windows checkout with `core.autocrlf` does not break them; on Windows they run through the `sh` that comes with Git for Windows, which git hooks always use. Then it stops: you see the branch, the files and the diff. If Shipherd quits in the middle of an export, the half-made worktree and branch are cleaned up at the next start.
- **Push branch** and **Open PR** are separate buttons and go through the outward-action switches, which are **off by default**; every attempt is logged. **Discard** removes the worktree and the local branch.
- When a check cannot be exported, Shipherd says why and creates nothing: the repository has no local copy or no baseline yet, the check needs Node or Python and the repository has neither, the regular expression uses syntax the target cannot express (for example `\p{…}`), a command has no hook manager to go into, or the repository's CI already runs that command.

| Setting | Key | Default | Notes |
| --- | --- | --- | --- |
| Fill in unknown repos with the model | `baselineInfer` | `auto` | `auto` or `off`. `auto`: when the marker files and CI are not enough, a scan you start asks the model (read-only). Background rescans never call the model. |
| Rescan in the background when config files change | `baselineAutoRescan` | `1` | `1` or `0`. Only for repositories already scanned. |
| Characters per repo in the session guide | `baselineGuideChars` | `1200` | A whole number from `200` to `4000`. |
| Most files a legacy scan reads | `legacyScanMaxFiles` | `50000` | A whole number from `100` to `500000`. |

**Import / export:** the marker table (section `baseline_rules`) travels with **All** and **Checks only**; products by name, invalid rules skipped. Repository baselines (section `baselines`) are only exported when you tick **Include each repo's baseline scan**, never with local paths, file hashes or lesson text. An imported baseline is kept only when it is newer than the local one (a date in the future counts as now), is marked as imported and out of date, and is replaced by the first local scan. Until then it stays out of the session guide, and every check drafted from it must be ticked **I checked this command** before it is created, because its commands came from another machine. A marker rule whose commands are new or changed is imported turned off, so you read its commands before it is used; a command with a line break is rejected. An import never removes a local baseline, even in replace mode.

## Comments and CI

**Settings → Comments & CI** controls two loops that keep a PR moving without you relaying messages. Both are off by default; with them off Shipherd behaves as before. Each key can be set on the global, product and repository layers, merged key by key in the same way as the [admission policy](#admission-policy) (a repository's own value, else a product's, else global, else the default; when products disagree, the one whose name sorts last wins and the page warns).

### Comment loop

Each time the PR watcher reads an open PR of a repo where `comments.enabled` is on, Shipherd reads its review threads, review bodies and PR comments and puts each new comment in one of four categories:

- **fix**: a change is asked for;
- **question**: the reviewer asks something;
- **ignore**: thanks, agreement, an outdated position, a comment you already answered, Copilot's overview, or a match in `comments.ignorePatterns`;
- **human**: someone needs to judge it.

Rules run first: resolved threads, your own comments and other bots are skipped, a ```` ```suggestion ```` block means fix, and the cases above mean ignore. Whatever the rules can't place goes to a model through the `comment_classify` routing task when `comments.useModel` is on; a comment the model can't place, or every unplaced comment when the model is off, is marked human.

Copilot and people have separate policies (`comments.copilot`, `comments.human`). With `auto`, fixes (and questions when `comments.questions` is `session`) are sent to the session that owns the PR's branch, the same session CI results go to. They go into that session's mailbox and never interrupt it: a working session reads them at its next tool call, a stopped one has them typed in. Each delivery carries at most `comments.maxPerDelivery` comments, with file, line and text. With `review` (the default for people) the comment waits for you on the ticket's **Comments** tab, and the **Your turn** page shows a card. A comment that should have been sent but has waited 30 minutes also shows a card. With `off` the comments are left alone.

After a push Shipherd checks each sent comment at the new head: an inline comment counts as addressed when its thread was resolved elsewhere, its position is outdated or gone, or the pushed diff touches its lines (within three lines); a review body or PR comment counts as addressed after any new commit. A comment that is still unchanged after two pushes goes back to you. For an addressed comment, Shipherd replies "Addressed in <commit>." (marked as an automated reply from Shipherd) when `comments.reply` is on, and resolves the thread when `comments.resolve` is on. Each of these also needs its switch under [Outward actions](#outward-actions) (`externalCommentReply`, `externalCommentResolve`), and every attempt is listed on the Audit page.

On the ticket's **Comments** tab you can send a comment to the session, change its category, dismiss it, or reply again.

| Key | Default | Values | What it does |
|-----|---------|--------|--------------|
| `comments.enabled` | `false` | `true` / `false` | Turn the comment loop on |
| `comments.copilot` | `auto` | `auto` / `review` / `off` | What happens to Copilot's comments: send to the session, show you first, or leave alone |
| `comments.human` | `review` | `auto` / `review` / `off` | The same for comments from people |
| `comments.questions` | `user` | `user` / `session` | Whether questions wait for you or go to the session |
| `comments.useModel` | `true` | `true` / `false` | Ask a model when the rules can't decide |
| `comments.ignorePatterns` | none | list | Comments matching any of these are ignored |
| `comments.maxPerDelivery` | `10` | whole number 1–50 | Most comments sent to the session at once |
| `comments.reply` | `true` | `true` / `false` | Reply after a comment is addressed (also needs `externalCommentReply`) |
| `comments.resolve` | `true` | `true` / `false` | Resolve the thread after it is addressed (also needs `externalCommentResolve`) |
| `comments.replyLanguage` | `en` | `en` / `zh` | Language of the reply |

### CI triage

When `ci.enabled` is on for a repo, Shipherd classifies a failed CI result before telling the session. Failed checks are grouped by workflow run; checks that don't come from a GitHub Actions run are delivered as before. Rules run first:

- **env**: the run never got a runner or failed while setting up the job; the log matches a built-in environment keyword (network timeouts, DNS errors, registry or rate-limit errors, a runner shutdown, a full disk) or `ci.envPatterns`; or the failed step installs, checks out or downloads something and the log looks like a network problem;
- **code**: the log matches a built-in code keyword (type errors, assertions, failed tests, lint or compile errors) or `ci.codePatterns`. Code keywords win over environment keywords;
- **flaky**: a failed check or test is on the flaky list (`ci.flakyTests` plus the names Shipherd listed itself).

A failure the rules can't place goes to a model through the `ci_classify` routing task when `ci.useModel` is on, otherwise it counts as code.

Code failures are delivered as before. Environment and flaky failures are rerun with `gh run rerun <run> --failed`, at most `ci.maxReruns` times, without telling the session; this needs the `externalCiRerun` switch under [Outward actions](#outward-actions), and while it is off the failure is delivered with a note saying so. If the rerun passes, the session gets the usual "CI passed" message. If it fails the same way again, it is delivered as a code failure; if it keeps failing past the limit, it is delivered marked "possibly flaky". A rerun with no result after six hours is delivered too.

Every pass after a rerun is recorded per check and test name, with the time it cost from the first failure. A name that passes after a rerun `ci.autoListThreshold` times within `ci.autoListDays` days is put on the flaky list automatically. The **Flaky list** on the same page shows the counts and wasted time, and lets you list or unlist a name by hand. Below it, a summary shows what both loops did in the last 30 days.

Lists take one entry per line in the editor. An entry wrapped in `/…/` is a regular expression; anything else matches as a substring. Both ignore case.

| Key | Default | Values | What it does |
|-----|---------|--------|--------------|
| `ci.enabled` | `false` | `true` / `false` | Turn CI triage on |
| `ci.maxReruns` | `2` | whole number 0–5 | Most automatic reruns of one failure |
| `ci.useModel` | `true` | `true` / `false` | Ask a model when the rules can't decide |
| `ci.envPatterns` | none | list | Extra log patterns that mean an environment problem |
| `ci.codePatterns` | none | list | Extra log patterns that mean a code problem |
| `ci.flakyTests` | none | list | Checks or tests known to be flaky |
| `ci.autoListThreshold` | `3` | whole number 1–100 | Passes after a rerun before a name is listed as flaky |
| `ci.autoListDays` | `30` | whole number 1–365 | Days counted for flaky stats and auto-listing |

## Interruptions and notifications

**Settings → Interruptions & notifications** collects what lets sessions stop for you less often, and what tells you when one really needs you. Everything here is off, or has no effect, until you set it up.

### Permission profile

Shipherd reads the Claude Code transcripts of the last 30 days on this machine (they never leave it). It counts, per repository, the commands and MCP tools that ran successfully, and offers those that ran at least 3 times in at least 2 sessions as candidates. A rule you confirm goes into the `--settings` file of every Shipherd session in that repository, next to Shipherd's own tools, so the session doesn't stop to ask. Your own Claude Code settings are not changed.

Only read-only commands qualify. The check is fixed and runs again before every session starts:

- Allowed: `gh pr view` and similar read-only subcommands, `git log` without `--output`, and `gh api` without a method or fields.
- Never: anything that writes, deletes, pushes or runs other programs, chains with `&&`, `|` or `;`, or uses redirects, `$`, backticks or globs, or runs the repository's own scripts.

A command you rejected once in a repository is never offered there. **Explain** asks the low-tier model (task `permission_profile`) for a one-line note per candidate. It can't add rules; candidates it marks as risky start unticked, and so do MCP tools, since only their names can be checked. This lives only here: the first-run wizard no longer has a permission step. Rules can be removed at any time. Imported rules wait for you to confirm them.

| Setting | Key | Default | What it does |
|---------|-----|---------|--------------|
| Use permission profiles | `permissionProfiles` | `1` (on) | Write confirmed rules into sessions. With no confirmed rule, nothing changes. |

### Choices and missing information

| Setting | Key | Default | What it does |
|---------|-----|---------|--------------|
| Pick the recommended option | `interruptChoiceRule` | `0` (off) | Ticket sessions and coordinators are told: when one option is recommended and nothing special applies (irreversible or outward actions, cost, going beyond the ticket, a preference you stated), pick it, carry on, and record it with `report(kind: "choice")`. |
| Default answers | `interruptChoiceDefaults` | `0` (off) | A question with options that contains one of your keywords is answered right away with your answer, or with the option the session recommended. The session is told the answer came from your default. |
| Look before asking | `interruptSelfServe` | `0` (off) | Before asking you for a fact, sessions check the ticket through the tracker, the code and docs, memory, and (ticket sessions in an epic) the epic coordinator. |

Every choice made this way is listed under **Choices made for you**, newest first, until you mark it as reviewed. It does not count as a human intervention on the **Effect** page; it counts as an automatically resolved stop.

### Notifications

Shipherd can push to one HTTPS webhook when something needs you: `ntfy`-style topics or a chat tool's incoming webhook. The switch is **Push notifications** (`externalPushNotification`) under outward actions. While it is off, nothing is sent and the notification log stays empty.

- **The address** is stored encrypted with the OS keychain (macOS Keychain / Windows DPAPI). Only its host is shown, and it is never exported. If OS encryption is unavailable, Shipherd refuses to save it.
- **What is sent.** By default a message names only the kind of event and how many there were, for example "2 things need your decision". Events of the same kind within a minute are sent together. Question text, comment text, paths and repository names are never sent.
- **Log.** Every message sent, failed, held back by quiet hours or left out is listed under **Notification log** and kept as long as `auditRetentionDays`.

| Setting | Key | Default | What it does |
|---------|-----|---------|--------------|
| Format | `notifyFormat` | `json` | `json` posts `{"text", "content", "title", "event", "count"}`, which chat webhooks accept. `ntfy` posts plain text with a `Title` header. |
| Events | `notifyEvents` | all six | Comma-separated: `decision_needed` (a session asked you something), `pr_high_risk` (a high-risk PR waits for your review), `pr_ready` (a PR is ready to submit), `cost_breaker` (the cost breaker paused or stopped work), `review_comment` (a colleague commented on a PR), `intake_decision` ([automatic intake](#automatic-intake) needs you to decide about a ticket). |
| Include references | `notifyDetails` | `0` (off) | Add the ticket key and PR number to the message. |
| Quiet hours | `notifyQuietHours` | empty | `HH:MM-HH:MM` in local time, may cross midnight, for example `22:00-08:00`. Events in this window are not pushed. |

**Send a test** sends one message to the saved address. While the switch is off it sends nothing, says so, and the outward-action audit records it as skipped.

Where the events come from: `decision_needed` is a new question that wasn't answered by a default; `pr_high_risk` and `pr_ready` come from the PR risk and stage checks; `cost_breaker` from the cost breaker pausing or stopping work; `review_comment` from the PR watcher seeing a new comment or review from someone other than the PR's author or a bot. Comments already on a PR when Shipherd first reads it are not pushed.

### Before and after on the Effect page

The **Effect** page compares equal windows of full days (up to 30 days each) before and after the first time one of these features took effect, leaving out that day itself because it is partly before and partly after: a permission rule confirmed, or the choice rule, default answers or "look before asking" switched on. Each side shows Shipherd PRs merged, human interventions and waiting time per PR, interrupts per day by kind, stops resolved automatically, and fix sessions opened for stuck sessions. Until one of them is on, the panel says the comparison starts then. That first time is stored once in `interruptReductionSince` (not edited directly). Stops resolved by a permission profile are counted from the session's transcript when it stops, so the number is an upper bound: Claude Code might not have asked for every one of them.

## Stacks

A stack is a chain of Shipherd branches in one repository where each builds on the one below: the bottom branch is based on trunk, the next on the bottom, and so on. Only the bottom has a PR for people to review. The layers above stay plain branches until they reach the bottom, so reviewers see one small PR at a time.

Stacks are made by epic coordinators. An epic coordinator passes `stack_on` to `create_ticket` to start the new ticket's branch from another ticket's branch and put it on top of that ticket's stack (a new stack if it has none). It can also call `stack_define` to turn existing branches into a stack. `list_stacks` shows the stacks, `stack_rebase` rebases one now, and `stack_layer_mode` opens a layer above the bottom as a draft PR when it needs CI, or closes that draft again. An epic coordinator sees a stack when one of its layers is the epic's ticket, but can only change stacks that belong to its epic or whose open layers are all its tickets. The global control has the same tools and can only change stacks from its own open terminal.

When the bottom PR merges, or trunk moves, Shipherd rebases the whole stack onto the new base. It uses `git rebase --update-refs` (git 2.38 or later), or one layer at a time on an older git. The work happens in a separate worktree under `~/.shipherd/stack-work`, so open sessions are never disturbed. Shipherd only moves a branch when it is not checked out with uncommitted changes (or untracked files the new tip would overwrite), its session is not busy, and nobody pushed to it in the meantime; otherwise it tries again later. Before moving any branch it saves the old tips under `refs/shipherd/stack-backup/…`, and **Restore from backup** puts them back. On a conflict Shipherd stops, leaves everything as it was, and puts the conflicting files and the `git rebase --onto` command to run in the mailbox of the session of that layer's ticket (a newer conflict on the same layer replaces one not delivered yet); the session is told to push its result only when **Force push** is on. The next rebase carries on from the session's resolution. A conflict nobody received for 30 minutes, or a rebase stuck or rolled back for a day, shows on the **Your turn** page.

After the bottom merges, the next layer becomes the bottom: Shipherd retargets it to trunk and, when `autoOpenBottomPr` is on, opens it as a ready PR. Draft layers carry the `draftLabel` label and a title that says not to review them.

The **Stacks and auto-intake** fold at the bottom of the **All work** page shows the managed stacks: every layer from top to bottom with its state, PR, commits behind trunk and whether it was rewritten but not pushed, plus the latest rebase and buttons to rebase now, restore, open or close drafts, and stop managing the stack (branches and PRs stay as they are, and automatic detection does not bring it back).

**Settings → Stacks** holds the policy, on the same global, product and repository layers as [Comments and CI](#comments-and-ci). `autoRebase` is the master switch and is off by default; with it off Shipherd only watches. Pushing rebased branches (with `--force-with-lease`) needs `externalForcePush`, pushing a layer for the first time needs `externalBranchPush`, opening PRs and drafts needs `externalPrOpen`, writing the stack position into PR titles and the depends line into descriptions needs `externalPrTitleEdit` and `externalPrDescriptionEdit`, the draft label needs `externalPrLabel`, and the overview issue needs `externalIssuePost`, all under [Outward actions](#outward-actions). With those off Shipherd changes only the local branches and marks the layers it did not push.

| Key | Default | Values | What it does |
|-----|---------|--------|--------------|
| `autoRebase` | `false` | `true` / `false` | Let Shipherd rewrite the local branches of stacks in this repo |
| `mergeMethod` | `auto` | `auto` / `squash` / `merge` | How the bottom PR is merged; `auto` detects it from the merge |
| `rebaseOnMainUpdate` | `true` | `true` / `false` | Rebase when trunk moves |
| `dailyRebase` | `true` | `true` / `false` | Rebase each stack once a day |
| `autosquash` | `true` | `true` / `false` | Fold `fixup!` commits once a layer's review comments are handled |
| `autoOpenBottomPr` | `true` | `true` / `false` | Open the new bottom as a ready PR after the old one merges |
| `conflictToSession` | `true` | `true` / `false` | Send conflicts to the layer's session; off, they only show on the **Your turn** page |
| `draftDemoteDays` | `14` | whole number 1–365 | Days a layer may stay a draft before **Other notes from Shipherd** suggests closing it |
| `behindCommits` | `20` | whole number 1–10000 | Commits the bottom may fall behind trunk before a reminder |
| `behindDays` | `3` | whole number 1–365 | Days the bottom may fall behind trunk before a reminder |
| `overview` | `off` | `off` / `issue` | Keep an overview of an epic's stacks in one GitHub issue |
| `draftLabel` | `stacked` | 1–50 characters, no commas | Label put on draft layers |

The stack policy is part of [Backup and export settings](#backup-and-export-settings), like the other policies.

## Automatic intake

Automatic intake pulls new tickets from your tracker or a JSON file, sorts each one by size, risk and whether it has enough information, picks a model tier, and opens a session for it when the conditions below are met. It only calls you when it can't decide for you. It is off by default: nothing is pulled, stored or started until a source is set **and** a policy layer turns `enabled` on.

Anyone who can write a ticket in the source can shape what an automatic session is asked to do. Shipherd hands the ticket text to the session fenced off as a description, not as instructions, and every PR still goes through pre-review, but turn intake on only for sources whose authors you trust, and keep `maxRisk` low where that is not certain.

### Source

**Settings → Automatic intake** holds the source settings. They are global.

| Setting | Key | Default | What it does |
|---------|-----|---------|--------------|
| Pull from | `intakeSource` | `none` | `none`, `tracker` or `file`. |
| Tracker query | `intakeTrackerQuery` | empty | With `tracker`, required (nothing is pulled while it is empty): what to list, in your words or the tracker's query language, for example "tickets assigned to me in To Do". Shipherd runs a background `claude -p` that may only use the read-only tools in `trackerTools`; Shipherd itself never talks to the tracker. |
| Repository to query from | `intakeTrackerDir` | empty | With `tracker`: the absolute path the query runs in, so your project-level tracker MCP is found. Empty uses the first path in the repo map. |
| JSON file | `intakeFilePath` | empty | With `file`: an absolute path to `{"tickets": [...]}` or a bare array. Each ticket needs `key` and `title`, and may have `description`, `type`, `labels`, `priority`, `url`, `storyPoints`, `components`, `subtasks` (`[{key, title}]`), `repo` (an absolute path) and `epic`, the parent Jira epic (`{key, title}`, or just the key). Useful for your own export scripts. |
| Pull every | `intakePollMinutes` | `15` | Minutes between pulls, 5–1440. **Pull now** on the queue pulls at once. Pulls wait while background work is paused. |
| Repo map | `intakeRepoMap` | empty | One rule per line, `match => /absolute/path`, first match wins: `PROJ` (key prefix), `label:frontend`, `component:Docs`, or `*`. A ticket's own `repo` wins over the map. A ticket that maps nowhere waits for you to pick a repository. |

Keys that don't fit `ticketPattern` are skipped. Keys that are already Shipherd tickets, archived ones included, are left alone. A ticket pulled again is only sorted again when its content changed and it hasn't started; the dimensions you changed keep your value.

### Sorting

Rules come first; the model (routing task `intake_classify`) is asked only for what the rules can't decide.

- **Missing information.** A description under 40 characters, a bug with no steps to reproduce, or a feature with no acceptance criteria.
- **Size.** Story points (≤2 small, ≤5 medium, more large), three or more subtasks (large), labels such as `small`, `typo` or `epic`, docs and chore types (small).
- **Risk.** Paths mentioned in the ticket are matched against the repository's [pre-review](#pre-review-readiness-and-risk) risk paths; keywords such as migration, auth or payment and the ticket type floors raise it; docs and chore types, or paths that are all low-risk, lower it.
- **Uncertain.** The model failed, or its confidence is below `uncertainBelow`.

Every decision lists its reasons in the queue. You can change size, risk and missing information there; each change is recorded with the rules version and counted on the Effect page, so the rules can be tuned.

### Starting and queueing

A ticket that is complete and within the limits is queued as background work of kind `intake`. When it comes up, Shipherd checks in order: the cost breaker, the parallel limit (only tickets intake started and whose session is still open count; your own sessions never do), paths shared with work in progress in the same repository, and memory. When all pass it creates the ticket in a worktree, opens a session with the model the tier maps to through [model routing](#model-routing), and sends the task. When a session ends, waiting tickets are tried again at once. Held tickets are decided again when you change the policy, the intake settings or pre-review.

A large ticket with two or more subtasks becomes a [stack](#stacks) when `stackSubtasks` is on: one layer per subtask, each started on the branch of the one below once that one has a PR or its session ended. A ticket is split only when every subtask key is valid and new to Shipherd. If a lower layer is skipped or can't start, the layer above asks you; starting it by hand starts it from the default branch.

Starting automatically also needs pre-review on (`preReviewEnabled`). With it off, tickets are sorted and held, and you can start them from the queue.

**Grouping by Jira epic.** With `tracker`, Shipherd also asks for each ticket's parent epic (its key and title); with `file`, it reads the ticket's `epic`. A ticket with a parent epic goes into the Shipherd epic linked to that Jira epic. If no unarchived epic has it, Shipherd creates one named after the Jira epic's key and title, with its workspace in the default place (`-2`, `-3` and so on when the folder is taken) and the ticket's repository added; an archived epic is never reused. A repository the epic doesn't have yet is added to it. Tickets without a parent epic stay standalone. Layers of a stack go into the epic of the ticket they were split from. What happens next depends on `autoStart`:

- **Off.** Each ticket with an epic is created in that epic right away, with no session, and stays held in the queue. Nothing is sent to the epic coordinator: ask it to sort the tickets into features when you are ready. Tickets that are already in Shipherd, stack layers and tickets with no repository are not created.
- **On.** The tickets start as usual, inside their epic. After each pull Shipherd sends each epic's coordinator one message listing the new tickets that are queued, waiting or started, and asks it to group them into features with `create_feature` and `set_ticket_feature`, order them with `reorder_features` and push them forward. The message goes into the coordinator's mailbox: a running coordinator reads it at its next tool call, or has it typed in when it is stopped. If it isn't running, Shipherd opens it (resuming its latest conversation) once memory allows and hands the message over as the first input; if memory is short, the message stays in the mailbox for the next time it opens. If the epic never had a coordinator and memory is short, it is skipped and logged, and the next pull that adds tickets to the epic tries again.

### When it calls you

Only for these, once each time a ticket reaches the state: the classification is uncertain, information is missing, no repository is known, the ticket could not be created, or it waits because it touches the same paths as other work. They show as a card on the **Your turn** page and, when notifications are on, as the `intake_decision` event. Everything else, started, queued, waiting for a slot or memory, held or split, is listed quietly under **Automatic intake** in **How it is running** on the **Your turn** page for 24 hours and in the queue under **Stacks and auto-intake** on the **All work** page.

With `clarifyMode` set to `session` or `coordinator`, Shipherd asks for the missing information on the tracker through a small session or the running global control, which needs **Intake: ask on the tracker** under [Outward actions](#outward-actions); with that off it only tells you.

### Policy

The policy has global, product and repository layers, like the other policies.

| Key | Default | Values | What it does |
|-----|---------|--------|--------------|
| `enabled` | `false` | `true` / `false` | Master switch for tickets that map to this layer |
| `autoStart` | `true` | `true` / `false` | Start automatically; off, tickets are sorted and held for you (tickets in a Jira epic are created in their Shipherd epic first, see **Grouping by Jira epic**) |
| `maxSize` | `large` | `small` / `medium` / `large` | Largest size started automatically |
| `maxRisk` | `high` | `low` / `medium` / `high` | Highest risk started automatically |
| `maxParallel` | `2` | whole number 1–50 | Tickets intake started with a session still open |
| `conflictAction` | `serialize` | `serialize` / `parallel` | Same repository and paths: queue one after another, or run in parallel and only note it |
| `clarifyMode` | `notify` | `notify` / `session` / `coordinator` | Who asks for missing information |
| `uncertainBelow` | `0.6` | 0–1 | Model confidence under this is uncertain |
| `stackSubtasks` | `true` | `true` / `false` | Split large tickets with subtasks into a stack |
| `tierSmall` | `mid` | `high` / `mid` / `low` | Tier for small tickets |
| `tierMedium` | `mid` | `high` / `mid` / `low` | Tier for medium tickets |
| `tierLarge` | `high` | `high` / `mid` / `low` | Tier for large tickets |
| `tierMediumRisk` | `mid` | `high` / `mid` / `low` | Lowest tier for medium risk |
| `tierHighRisk` | `high` | `high` / `mid` / `low` | Lowest tier for high risk |

The tier used is the higher of the size tier and the risk tier. The **Effect** page has an **Automatic intake** card: tickets sorted, started automatically and by you, how often you were called, and the share of tickets whose classification you changed.

## Several companies or profiles

Start Shipherd with a different `SHIPHERD_HOME`. If each company has its own Claude Code login, also set a different `CLAUDE_CONFIG_DIR`. Each `SHIPHERD_HOME` is a separate Shipherd with its own database, memory, hook binary, logs and settings, and its own Electron profile (`$SHIPHERD_HOME/electron`). Shipherd passes both variables on to the `claude` sessions it starts, so their hooks report to the right inbox.

A profile started with `BUTLER_HOME` (the variable's name before the rename to Shipherd) keeps working: when `SHIPHERD_HOME` isn't set, Shipherd reads `BUTLER_HOME` and uses that folder as it is, without moving it. Switch to `SHIPHERD_HOME`; the old name will be dropped in a later major version.

Two Shipherd profiles that share one Claude Code configuration folder would install their hooks over each other. Give each profile its own `CLAUDE_CONFIG_DIR`.
