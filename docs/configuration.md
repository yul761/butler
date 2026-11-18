# Configuring Butler

**English** | [简体中文](configuration.zh-CN.md)

Butler has no config files. Everything is set on the **Settings** page and stored in `~/.butler/app.db`. This page lists every setting, what it does and which values it accepts. It also explains how to adapt Butler to another company's tracker and conventions.

The UI comes in English and Chinese (see `language` below). This page quotes the labels of the English UI; the [Chinese version](configuration.zh-CN.md) quotes the Chinese ones. The names in `code` are the internal keys, which help when you read logs or the database.

The Settings page has these sections, in order:

1. **Environment check**
2. **General**
3. **Memory (StateCore)**
4. **Schedule and handoffs**
5. **Privacy and personal API**
6. **Lessons** (automatic backups, the export reminder and the admission policy; see [Lessons: bulk actions, admission policy and import / export](#lessons-bulk-actions-admission-policy-and-import--export))

The merge coordinator and the `end_session` tool for coordinators are described under [Merge coordinator](#merge-coordinator) and in the [README](../README.md); neither has a setting.

The audit log has its own page, **Audit**, in the sidebar.

## Environment check

This section shows:

- the `claude` Butler found, its version, and any required flags its `--help` is missing
- the hook status and the `/handoff` command status
- the Butler data folder and the Claude Code `settings.json` that Butler would edit

The section has three buttons:

- **Check again**
- **Install / repair.** Copies `butler-hook` to `~/.butler/bin`, merges the four hooks into `settings.json` and writes `commands/handoff.md`. The first time, it saves a backup copy as `settings.json.butler-backup`. If `settings.json` is not valid JSON, Butler refuses to touch it. It never overwrites a `handoff.md` that it didn't write.
- **Uninstall.** Removes only Butler's own hook entries and its own `handoff.md`.

These buttons, and the same step in the first-run wizard, are the only way Butler ever writes to your Claude Code configuration.

## General

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| claude path | `claudePath` | empty | Empty means Butler searches your login shell's `PATH`. Otherwise, the absolute path to your company's `claude`, as printed by `which claude` (or `where claude` on Windows). Saving it runs the environment check again. |
| Branch template | `branchTemplate` | `feature/{key}` | Used when Butler creates a ticket's branch and you leave the branch name empty. `{key}` is replaced with the ticket id, `{key_lower}` with the ticket id in lower case, and `{title}` with the ticket's title turned into lower-case letters, digits and `-` (at most 50 characters). When the title has no such characters, `{title}` and the `-` or `/` next to it are left out. The template must contain `{key}` or `{key_lower}`, be at most 100 characters, and use only letters, digits and `. _ / -`. It can't start with `-` or `/`, can't contain `..`, `//` or `/.`, and can't end with `/`, `.` or `.lock`. Examples: `users/alice/{key}`, `{key}`, `{key_lower}-{title}` (gives `dms-1234-add-payment-api`). |
| Ticket id pattern | `ticketPattern` | `[A-Z][A-Z0-9]+-\d+` | A JavaScript regular expression for ticket ids. See [Ticket pattern](#ticket-pattern) below. |
| 语言 / Language | `language` | `auto` | `auto`, `zh` or `en`. `auto` follows the system's preferred language: Chinese for any `zh` locale, English for everything else. The interface, Butler's messages and the default prompts sent to `claude` (handoffs, refreshes, memory notes) all switch; prompts you edited yourself are kept as they are. Content generated earlier is not translated. Installs upgraded from 1.2.0 or earlier start on `zh`. After a switch, **Environment check** shows the `/handoff` command as needing an update; click **Install / repair** so `/handoff` in your sessions uses the new language too. The environment variable `BUTLER_LANG=zh` or `BUTLER_LANG=en` overrides the setting. |
| Start Butler at login | — | off | Only available in an installed Butler, not in development mode. |
| Run the first-run wizard again | `onboardingDone` | `0` for new installs | A button, not a field. The wizard sets this to `1` when you finish or skip it, and the button sets it back to `0`. Existing installs that already have tickets were migrated to `1`. |

### Ticket pattern

Butler uses the pattern in two places:

- to check the id when you create a ticket
- to suggest a ticket for unclaimed sessions

Ticket ids are upper-cased before they are checked, so write the pattern for upper case. When Butler looks for ids inside text, it matches case-insensitively, and the id must not directly follow a letter or digit, or be directly followed by a digit.

The default pattern covers Jira and Linear style ids such as `PROJ-123` or `ENG-42`.

GitHub issue numbers such as `#123` **cannot** be used as ticket ids. `#` is not allowed in branch names, so Butler rejects a pattern like `#\d+` together with any branch template. Use a prefixed id such as `GH-123` instead, which the default pattern already accepts.

Before saving, Butler rejects a pattern that:

- is empty or longer than 100 characters
- does not compile
- uses back-references (`\1`, `\k<name>`)
- matches the empty string
- **backtracks badly.** The pattern is run in an isolated `vm` context against a set of adversarial inputs of about 5,000 characters, with a hard timeout of about 250 ms per input. If any run times out, the pattern is rejected. Nested or repeated quantifiers such as `(a+)+` are the usual cause.

Butler also checks the pattern and the branch template together. Changing either one is refused if a sample id that the pattern accepts (for example `-1`, `#1` or `..-1`) would produce an invalid branch name.

## Parallel sessions

How many sessions can run at once depends on this computer's memory, not on a fixed number. Before Butler opens a new terminal for `start_session`, `start_feature`, or a message from the Butler coordinator to a closed coordinator, it takes the memory available now, subtracts what a new session is expected to use, and opens it only if at least the reserve below is left. Sessions it opened in the last two minutes have not grown yet, so each of them is subtracted at the expected size too. While macOS reports memory pressure as critical, nothing new opens. When a session is refused, the coordinator is told how much is available, how much another one needs and how much stays free; the result of `start_session`, `start_feature` and `list_sessions` adds a line saying how many more can start now. If memory cannot be read, Butler opens the session anyway (only the optional cap applies) and logs it.

Available memory on macOS is worked out from `vm_stat` the way Activity Monitor does: total minus wired, compressed and anonymous (minus purgeable) memory, so file cache counts as available. `os.freemem()` is not used there, because it counts only free pages and is often a few GB on a machine with tens of GB to spare. If `vm_stat` fails, Butler uses the free percentage from `memory_pressure -Q`, then `os.freemem()`. On Windows `os.freemem()` is the available physical memory (free plus standby), and on Linux it is `MemAvailable`, so it is used as is.

The log (`logs/main.log` in Butler's data folder) records the reading at startup, next to macOS's own free percentage and `os.freemem()`, and records every decision with the numbers it used. If sessions are refused when the machine seems to have room, those lines show why.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Memory to keep free after opening a session (MB) | `sessionMemoryReserveMb` | empty (automatic) | Empty means automatic: 10% of physical memory, at least 512 MB and at most 2048 MB (819 MB on an 8 GB machine, 1638 MB on 16 GB, 2048 MB from 20 GB up). Or a whole number of MB from `0` to `1048576`. A session opens only if available memory minus the expected size of a new session is at least this much. |
| Memory a new session is expected to use (MB) | `sessionMemoryEstimateMb` | `1024` | A whole number of MB from `64` to `1048576`: Claude plus its MCP servers and child processes. Butler uses this number for now; once per-session memory measurement is connected, the measured average of the open sessions will be used when there is one. |
| Most terminals open at once (0 = no limit) | `sessionMaxRunning` | `0` (no limit) | A whole number from `0` to `999`. Off by default and only a safety net: when set, no new terminal opens while Butler already has this many open, however much memory is free. |

## Memory (StateCore)

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Write handoff progress, decisions, follow-ups and learnings to StateCore, and give the sessions Butler opens their memory | `memoryEnabled` | `1` (on) | `1` or `0`. When off, Butler writes nothing to StateCore and starts sessions without the memory MCP servers. Existing memory is kept. When you turn it back on, Butler catches up on the tickets it missed. |
| Refresh automatically when the context passes this many tokens (0 = off) | `refreshThresholdTokens` | `150000` | `0` turns automatic refresh off, otherwise a whole number of tokens (at most 7 digits). When a Butler session has stopped, is not waiting on you and its last turn's context is at least this long, Butler types `/handoff`, waits until memory has stored the handoff, saves the last few turns of the conversation to `~/.butler/refresh/<session>.md` (no model is called), types `/clear`, then has the session recall the handoff, read that file and carry on with what it was doing (if it was waiting for you, CI or a child session, it says what for and keeps waiting). Needs memory on. The ↻ button next to a running session and a coordinator's `refresh_session` do the same on demand and do not depend on this setting. |
| Close a session automatically after it has been idle this many minutes (0 = off) | `idleCloseMinutes` | `180` | `0` turns automatic closing off, otherwise a whole number of minutes from 10 up (at most 5 digits). When a Butler session's terminal is open but it has stopped for longer than this (time the computer was asleep doesn't count), with nothing waiting on you, no background task, no merge queue or CI run it is waiting on, not in the middle of a refresh and (for a coordinator) no child session at work, Butler has it write a handoff (`/handoff`, or the handoff tool in an epic session), waits for memory to be written, then ends the terminal like `end_session`. You can resume it later. With memory off, ticket and feature sessions still write `/handoff` (Butler keeps it for the daily brief). Sessions you have hidden are deleted from Butler after 14 days; their transcripts stay on disk. **Clean up idle** in a session bar does the same at once for sessions there that have stopped for at least 5 minutes, whatever this setting is. |

This section also shows:

- the StateCore data folder (`~/.butler/statecore`)
- whether the memory MCP bundle was found
- a warning if StateCore's own Claude Code capture plugin is installed. Don't run that plugin alongside Butler: memory would be recorded twice.
- the **Run the first-run wizard again** button

### How memory works

- **Scopes.** Each ticket has its own StateCore scope (`ticket:<KEY>`). Learnings shared across tickets go to a `workspace` scope.
- **Mounting.** Each time you open a session for a ticket, Butler rewrites `~/.butler/mcp/tickets/<ticket>.json` and starts `claude` with `--mcp-config` pointing at it. The file mounts two servers: `butler-memory` (the ticket scope) and `butler-workspace`. Both run with Butler's own Electron in Node mode, with no model key in their environment. Nothing is registered in Claude Code's own MCP configuration.
- **What Butler writes.** After every complete handoff (morning refreshes and incomplete handoffs don't count), Butler writes:
  - a new handoff version: status, what was done, next steps and open questions
  - the ticket's open follow-ups and its latest decisions, as notes. Butler keeps at most 24 of its own notes per ticket, which leaves room for Claude's own `remember` calls.
  - the handoff's learnings, to the `workspace` scope

  Butler also syncs a ticket at startup and when you open a session for it. It syncs again when you complete, ignore or reopen one of the ticket's follow-ups.
- **The 30-note cap.** StateCore keeps at most 30 live notes per scope. Since statecore-mcp 1.1, a forgotten note (a finished follow-up, a replaced decision) frees its slot, and notes the distillation extracts never push out notes written by Butler or by Claude's `remember`. Before each write, Butler counts the free slots. If none is left, it skips the write rather than let StateCore evict the oldest entry, so Butler never evicts its own notes. When slots are short, open follow-ups go first, then decisions. The skipped entries are still in Butler's own database and on the ticket page, and are written as soon as a slot frees up. In the `workspace` scope, StateCore evicts the oldest learnings once it holds 30 notes.
- **The Memory tab** on a ticket page shows the latest handoff, decisions, open follow-ups and other notes. Click **History** on an entry to see its version chain. The tab refreshes after each Butler sync. It does not update live while Claude writes to memory inside a session.
- **Distillation.** This happens only at the **Full** privacy level with **Confirm before sending** off. It runs in the background after every nightly handoff run, including catch-up runs and **Run the nightly handoff now**. For each scope with pending events, StateCore makes one or more calls to your personal API and turns the events into notes. Together the calls send:
  - the scope name, which for a ticket is the real ticket id (`ticket:<KEY>`)
  - the scope's recent raw events, including what Claude stored with `remember(consolidate: true)`
  - the scope's existing memory as JSON: Butler's follow-up and decision notes, Claude's own notes, and the previous summary with its next steps
  - the text of notes forgotten in that scope, so that the model won't bring them back

  In the `workspace` scope, each learning is tagged with the id of the ticket it came from.

  **None of this is pseudonymized or scanned.** Each call is checked against the monthly budget and refused if it would exceed it. Every sent or over-budget call is audited, and shows as **StateCore memory distillation** on the Audit page. A call refused for any other reason, such as the level changing or no usable key, is only written to the log.

  A run that could not process every event is reported as partial and its ticket is resynced; a run that distilled nothing leaves the events for the next night. The calls are made by Butler's main process, inside the privacy gateway, and no StateCore process ever receives the API key.

## Memory and performance

These settings are in **Settings → General → Memory and performance**. None of them limits how many sessions run at once.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Record how much memory each session uses | `memoryMonitor` | `1` (on) | `1` or `0`. Once a minute Butler reads the process table (`ps` on macOS, `Get-CimInstance Win32_Process` on Windows; no model is called). It adds up each open session's whole process tree (claude, its MCP servers, shells, watchers, dev servers) and Butler's own processes, and reads how much memory the system has free. The **Now** page shows the latest reading on each row (hover for the breakdown) and a **Memory** line at the top: Butler, sessions, free memory, Butler's MCP servers, and a 24-hour curve when you open it. Every five minutes a point is stored in Butler's database. Points are kept for 14 days. Reading only; it never changes a process. |
| Lower the priority of sessions you can't see that have stopped | `backgroundPriority` | `0` (off) | `1` or `0`. On macOS, the whole tree of a session that is not on screen and has stopped is put in the background (`taskpolicy -b`). On Windows, a session you can't see gets `BelowNormal`, and one that has also stopped gets EcoQoS too. Showing the terminal, typing into it, or the session starting to work again restores normal priority at once; quitting Butler restores everything. Sessions that are working are never lowered on macOS, because background priority makes builds and tests very slow. |
| Clean up orphan processes a session leaves behind | `orphanCleanup` | `1` (on) | `1` or `0`. Butler remembers which processes it has seen under each session (`~/.butler/procs/owned.json`, with each one's start time and command line). Five seconds after a session's terminal ends, any of them still running, and no longer under a live session, is ended: first politely, then by force five seconds later (on Windows `taskkill`, then `taskkill /F`; each process is checked and ended on its own, never with `/T`). At startup it does the same for processes left over when Butler last quit unexpectedly. A process whose start time or command line no longer matches, such as a reused pid, is never touched. Every process ended is written to the log. |
| Refresh a session whose claude process uses more than this many MB (0 = off) | `refreshMemoryMb` | `2048` | `0` turns it off, otherwise a whole number of MB from 256 up (at most 6 digits). Only the claude process itself counts, not its MCP servers or other children. When it is over the limit, Butler refreshes the session at its next idle point, with the same checks and steps as `refreshThresholdTokens` (so memory must be on). If claude is still above 80% of the limit afterwards, Butler logs it; it tries again after six hours. |
| Hibernate stopped sessions | `hibernateEnabled` | `0` (off) | `1` or `0`. Once a session Butler opened has been stopped for the minutes below, Butler ends its whole process tree (claude, MCP servers, shells, and watchers unless `hibernateEndWatchers` is off) and keeps only the transcript; the session shows **Hibernated**. It wakes up with `claude --resume`, with the whole conversation, when something has to reach it: a CI result, a merge notice, a report for a coordinator, or your answer to an `ask_user`. Opening it, or switching to its terminal, wakes it too. A session is never hibernated while it is working or has background commands, has a permission prompt or dialog on screen, has a draft in its input, was typed into in the last 30 seconds, is being refreshed or sent something, is the terminal you are looking at, is a coordinator whose child sessions are working, was opened in the last 2 minutes or woken in the last 10, has no transcript, or is pinned (📌 on its button). Fix sessions and lesson sessions are never hibernated. A hibernated session still counts towards the per-ticket and per-feature limits, still shows on the **Now** page and still counts as waiting for you. If a wake fails, the session gets a **!** on its button (the reason is in its tooltip) and stays on the **Now** page until you open or hide it. A failure that can pass (the ticket is busy, claude can't be found, a repo is on another branch) keeps the session hibernated, and automatic wakes retry after 10 minutes. Any other failure (claude exits before it starts, or does not start within 60 seconds) turns it into an ordinary closed session. Opening it yourself always tries again. This never limits how many sessions run at once. |
| Hibernate a session waiting for you after (minutes) | `hibernateYouMinutes` | `30` | `0` (never) or a whole number from `5` up (at most 5 digits). "Waiting for you" means the **Now** page says it needs you, or it has an unanswered `ask_user`. |
| Hibernate a session waiting for CI after (minutes) | `hibernateCiMinutes` | `20` | Same values. Waiting for CI: its PR's (or branch's) CI is running, or it is queued in the merge gate. |
| Hibernate a session waiting for review after (minutes) | `hibernateReviewMinutes` | `30` | Same values. Its PR is open, CI is done and the review is not approved yet. |
| Hibernate an idle session after (minutes) | `hibernateIdleMinutes` | `60` | Same values. Anything else that has stopped. |
| Also end watchers and dev servers when hibernating | `hibernateEndWatchers` | `1` (on) | `1` or `0`. When off, watchers (`tsc --watch`, `vite` and the like) and dev servers keep running while the session hibernates; they are ended when it wakes, is hidden or Butler restarts. |
| Hibernate the longest-idle session when memory is low | `memoryPressureEnabled` | `0` (off) | `1` or `0`. While free system memory is below `memoryPressureFreePercent`, Butler hibernates one session per sample (once a minute): the one idle the longest, idle at least 5 minutes, that passes every rule above. It stops once free memory is back 5 points above the line. Works even with `hibernateEnabled` off. |
| Free memory below this percentage counts as low | `memoryPressureFreePercent` | `10` | A whole number from `1` to `50`. |
| Shared MCP | `sharedMcp` | `0` (off) | `1` or `0`. When on, one background process (the MCP hub) serves Butler's memory servers and `butler-sessions` to every session over local loopback HTTP (`127.0.0.1` only, a random token per session and server), instead of a set of processes per session. The more sessions are open, the more memory this saves; when it is off, the **Now** page's memory card estimates the saving. It affects sessions opened afterwards. While the hub is starting or cannot start, new sessions get their own processes as before, and the **Now** page shows a notice if it keeps failing. After you turn it off, sessions already using the hub keep it until they exit. MCP servers from your own Claude config are not affected. |

### Tips Butler can't apply for you

- **Windows:** in Windows Security, add Defender exclusions for the folder that holds your worktrees, `node_modules`, `.git` and `%USERPROFILE%\.butler`. Real-time scanning costs a lot when many node and git processes run at once. Make sure the page file is large enough: leave it **System managed**, or at least 1.5 times your RAM.
- **macOS:** add the folder that holds your worktrees to Spotlight's privacy list (System Settings → Siri & Spotlight → Spotlight Privacy) so every `pnpm install` isn't indexed again. If you run third-party antivirus, exclude the same folders. macOS manages swap itself: keep at least 15–20% of the disk free so it has room.
- **Both:** every MCP server in your own Claude configuration starts once per session. The **Memory** line on the **Now** page names the ones of yours that use the most. Remove the ones you rarely use from your Claude configuration; Butler never changes it for you.

## Schedule and handoffs

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Nightly handoff time | `nightlyTime` | `16:00` | `HH:MM`, local time. If Butler was closed, asleep or locked at that time, the run catches up at the next launch, wake or unlock, before the morning refresh. |
| Daily Butler control patrol at | `butlerPatrolTime` | empty (off) | `HH:MM`, local time; empty means off. At this time Butler opens (or reuses the latest) Butler control and has it go over PRs, CI and pending decisions, listing what you need to do yourself with `ask_user`. If Butler control is busy, Butler waits until it stops. If the computer was asleep or Butler was closed at that time, the patrol runs once at the next wake, unlock or launch on the same day; it is not made up after midnight. If you turn the setting on after that day's time has passed, the first patrol runs right away. A patrol opens a session at most once a day. While a decision listed by the previous patrol is still pending, the next one waits for you to deal with it. Butler control is not refreshed or closed for being idle automatically. |
| Working days | `workingDays` | `1,2,3,4,5` (Mon–Fri) | Checkboxes in the UI. The stored value is a comma-separated list of `0`–`6`, where `0` is Sunday. Nightly handoffs and morning refreshes run only on these days. |
| Tracker MCP tools | `trackerTools` | empty | One MCP tool name per line, in the form `mcp__<server>__<tool>`. `mcp__<server>` alone allows every tool of that server, so avoid it unless the server is read-only. Anything else, such as `Bash(...)` rules or flags, is rejected. Handoffs and refreshes may call these tools, plus `Read`, `Grep`, `Glob`, `gh pr view`, `gh pr checks`, `git log` and `git status`, plus anything your user-level or managed (policy) Claude Code settings allow (see below). |
| Background handoffs also load local-scope MCP servers… | `headlessProjectMcp` | `0` (off) | `1` or `0`. See [Plugging in your tracker](#plugging-in-your-tracker). |
| Handoff prompt template | `handoffPrompt` | built in | The instructions sent to `claude` for a handoff. It can't be empty and is limited to 20,000 characters. See [Adapting the prompts](#adapting-the-prompts). |
| Morning refresh prompt template | `refreshPrompt` | built in | The quick morning check of PR and tracker status. It doesn't summarise the conversation. Same limits as above. |

The section also has **Run the nightly handoff now**.

After the tickets, the nightly run also writes a summary for every feature whose coordinator session or tickets had new activity since its last summary. It forks the coordinator session when there is one and uses the same read-only flags as a handoff. If the ticket run was rate limited, no feature summaries are written that night and the morning catch-up does them. A feature's page also has **Update now**, which first runs handoffs for the feature's tickets that had activity and then writes the summary. A change in a PR's state, CI, review or mergeability since the last summary also counts as new activity, so the summary is marked out of date even when nobody typed anything. Each summary shows "PR status as of" the time it read the PRs. `/handoff` in a coordinator writes the summary from the conversation itself.

Handoffs and refreshes start `claude` with these flags:

- `--permission-mode dontAsk`: any tool that is not allowed is refused, so there is never a prompt.
- `--disallowedTools Edit Write NotebookEdit`: these are always denied.
- `--setting-sources user`: your user-level Claude Code settings apply, and so do managed (policy) settings, which Claude Code always loads. Allow rules and hooks in the repository's own settings do not.

The allowed tools are the list above plus the allow rules in your user-level `settings.json` and in any managed settings. These runs are not strictly read-only. If those settings allow, say, `Bash(npm:*)` or a write-capable MCP tool, unattended runs can use it too. Only `Edit`, `Write` and `NotebookEdit` are always blocked.

### Plugging in your tracker

Butler never talks to your tracker itself. Handoffs read it through the MCP servers configured in your company's Claude Code. Pick **read-only** tools only:

1. Configure the tracker's MCP server in Claude Code as you normally would. User scope is simplest.
2. In Settings, click **Detect from Claude Code**. Butler lists every MCP tool your Claude Code exposes. Tools whose names look like reads (get, list, search, read, view, fetch, query, find, …) are pre-ticked. Untick anything that writes, then click **Add the ticked tools and save**.
3. Tool names are `mcp__<server>__<tool>`, where `<server>` is the name you gave the server in Claude Code. For the Atlassian (Jira) server named `atlassian`, this could be `mcp__atlassian__getJiraIssue`. For other trackers (Linear, GitLab, …), use the names that the detection shows.
4. If the tracker's MCP server is configured in local scope or in a repository's `.mcp.json`, turn on `headlessProjectMcp`. Unattended runs read only your user-level settings, so they don't see those servers by default. With the setting on, Butler reads the repository's `.mcp.json` and `.claude/settings.local.json`, plus your `~/.claude.json` and `settings.json`, to find the servers you approved. It then copies your local-scope servers into private files under `~/.butler/mcp/`, along with the repository servers you have already approved in Claude Code. Those files can contain tokens. Disabled or unapproved servers are never loaded.

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

Keep `{{schema}}` and the output instructions. Butler also passes the JSON schema to `claude --json-schema` and validates the result. If the output fails validation, Butler retries once with the errors, and if it still fails it stores an incomplete handoff, marked **Incomplete**. The tracker status field is called `jira` in the schema whatever tracker you use.

## Merge coordinator

When several tickets change the same repo, the merge coordinator keeps their merges from colliding. It is part of Butler and has no setting. It does not ask a model: git itself decides whether two branches conflict.

**What it reviews.** Only two kinds of command, run by a session that Butler opened (an epic, a feature coordinator or any ticket session, whichever epic or feature it belongs to):

- A merge into a target branch: `gh pr merge` (including `--auto`; the target is the PR's base branch), `git merge` on the target branch, and `git push` to the target branch. For a push with an explicit `src:dst` refspec, the branch checked is `src` (`HEAD` means the current branch). A bare `git push origin main` pushes the local `main`, whichever branch you are on, so it counts as pushing the target branch itself and is not reviewed. Pushing your own branch is not reviewed either. Directories in `cd` and `git -C` may be written as Windows paths (`"C:\Users\me\repo"`), Git Bash paths (`/c/Users/me/repo`) or with `~`.
- A branch switch (`git checkout`, `git switch`) in a shared folder, that is, a repo folder in "branch" work mode that another ticket with an open session is using. Switching inside your own worktree is not reviewed.

Writing code, committing, testing and pushing your own branch never reach the coordinator. A command it can't recognize is let through.

**Only in sessions Butler opens.** The review is a `PreToolUse` hook for the Bash tool in the `--settings` file Butler writes for each session, with `PostToolUse` and `PostToolUseFailure` hooks that tell Butler when the command has ended. Your global `settings.json` is not changed, so a `claude` you start yourself is not affected. The hooks run the `butler-hook` program that **Install / repair** copies to `~/.butler/bin`. When that copy differs from the one in the app (after an upgrade), Butler replaces it at startup; if it can't, merges are not checked and the log says why.

**How it decides.**

- First come, first served. A merge that conflicts with another ticket's branch that is still being written is allowed, and Butler remembers that the other ticket will have to rebase.
- If the branch no longer merges into the latest target branch, the session is told to rebase first, with which ticket's changes it conflicts with and in which files. It is reminded to keep both sides' intent.
- If it conflicts with a branch whose merge was already allowed and has not finished, it is told to wait. A session whose own merge was already allowed can try again without waiting. The merge hold follows the real merge:
  - A local `git merge` or push holds until the command ends, whether it succeeds or fails. If Butler never hears that it ended, for example because you rejected the permission prompt, the hold expires after 10 minutes.
  - `gh pr merge` holds until Butler sees the PR merged (checked with `gh pr view`, only for held PRs) or closed. If the PR is still open 30 seconds after the merge was allowed and auto-merge is off, Butler takes it that the merge failed or `--auto` was cancelled, and releases the hold. If `gh` can't check, the hold expires after 2 hours. A `gh pr merge` of a branch that still holds a local merge (say, after a rejected push) turns that hold into a PR hold.
- When the held merge lands, the waiting session gets the message that it **can merge now** (after rebasing). If it doesn't land (the merge failed, the PR was closed or the hold expired), the session is told it can try the merge again. The message is typed into the session once it is waiting for input and you haven't typed in its terminal for 30 seconds. If the session's terminal is closed, the message is kept for up to 24 hours and delivered when you open the session again.
- A branch switch in a shared folder is refused while the folder is in use, naming the ticket and branch. When you click to switch a branch yourself, Butler only warns you; you can still confirm.

**Fail-open.** If Butler isn't running, doesn't answer within 5 seconds, or the hook itself fails, the command goes ahead. The coordinator is a safety net and is never a reason a session can't merge.

**What you see.** Each conflict it finds (a refusal, or an allowance with a later rebase) adds an entry to **Recent merges** on the **Now** page (the repo, which tickets, the order it chose). There are no system notifications. A merge with no conflict adds no entry; Butler only holds it until it lands. The entries, holds and pending rebases survive a restart.

**Requirements.** git 2.38 or newer (for `git merge-tree --write-tree`). `gh` is optional and used only for PR merges.

**What it doesn't do.** It only judges conflicts that git can see. Whether the merged code compiles or behaves correctly, such as one side renaming a field the other still uses, is left to CI. It doesn't rebase or resolve conflicts for you, and it ignores git you run in your own terminal.

## Model routing

Butler runs some work in the background with `claude -p`: needs-you and stuck checks, handoffs, feature summaries, epic digests and the lessons analysis. **Settings → Model routing** decides which model each of those calls uses, and what happens when a model hits a limit.

**With nothing registered, nothing changes.** Until you register at least one enabled model, every call uses the same model as Butler 2.1.0 (haiku for the needs-you and stuck checks, sonnet for the handoff refresh and epic digests, your default model for the rest). Limits are handled as before: the whole account pauses. Generic signals (below) are only recorded on the page.

**Tiers and chains.** Each model you register has a tier: `high`, `mid` or `low`. A model name can be an alias (`opus`), a full name (`claude-opus-5-5`) or a name your gateway knows; Butler passes it to `--model` as it is. Each tier has a chain, the order to try its models in. By default the chain is the tier's models in the order you registered them. Models with the same **account** label share a subscription or gateway: an account-wide limit on one marks the others of the same or a higher tier too.

**First-time setup.** **Discover models** collects candidate names from `ANTHROPIC_MODEL` and related variables, the `model` in Claude Code's `settings.json`, models seen in recent usage and the CLI aliases, then sends each one a tiny test call. Only the ones that answer are offered, each with a suggested tier. Butler never assumes that opus, sonnet or haiku exist. A registered model that doesn't exist is marked unavailable and skipped.

### Tasks and limits

Every background call names its task. The table on the page shows each task's tier, its lowest allowed tier, what it does at a limit and whether it is critical. You can change any of these per task.

- **fallback**: try the next model in the chain, then the tiers below, down to the lowest allowed tier.
- **wait**: try the other models of the same tier, then wait until one recovers. Nothing is dropped.
- **escalate**: stop after the first limit and report it.

Handoffs and feature summaries keep the session's own model (switching would throw away the prompt cache).

A result from a lower tier than the task asked for is marked as a fallback in usage, in the lesson run details and in the event log. A lessons analysis that ran on a lower tier is queued to run again on its own tier once that tier is healthy again. **Re-run now** on the page does that immediately.

**Recognising limits.** Limits are recognised by rules: the built-in ones, rules you add (a regex, an HTTP status or a reset-time pattern) and rules learned from your confirmations. On top of those, Butler treats as a *suspected* limit an HTTP 429, 529 or 402, an error mentioning limit, quota, billing or credit, and a model that failed three times in a row while another model succeeded. A suspected limit is attributed to that model (or to the account, if the rule says so). If no reset time is known, Butler backs off and then probes the model with a tiny call. Errors it couldn't classify are listed under **Unrecognised errors**. **Is this a limit?** turns one into a learned rule, so the same error is recognised next time. **Not a limit** clears the suspicion.

### Interactive sessions

A coordinator's `start_session` takes a tier (`high`, `mid`, `low`) or a model name, and the old `opus` and `sonnet` still work. Butler picks a healthy model of that tier and returns the model it actually used. An unknown name is refused before any terminal opens. If your `claude` doesn't support `--model`, sessions open without it.

When a session hits a limit, its row shows the limit and a **Switch to next tier and continue** button. The button ends the terminal and resumes the same conversation with `--resume` and the next model's `--model`. With `routingAutoSwitch` on, Butler switches right away.

### Spending

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Monthly quotas | `routingQuotas` | empty | A JSON list of `{"target": "tier:high" or "model:<name>", "unit": "usd" or "tokens", "monthly": <number>}`. Money comes from the cost Claude Code reports, or tokens × the model's registered prices. Empty means no quotas. |
| Soft thresholds (%) | `routingThresholds` | `70,90` | Two whole numbers, the first lower than the second. Past the first threshold, tasks whose policy is fallback skip the model and drop to a lower tier. Past the second, only critical tasks still use it. Quotas never block a critical task. |
| Period start day | `routingPeriodStartDay` | `1` | 1 to 28, the day of the month a quota period begins (local time). |
| Effort | `routingEffort` | empty | A JSON object from a task id or a tier to `low`, `medium`, `high`, `xhigh` or `max`, passed as `--effort` when your `claude` supports it. A task entry wins over its tier's. |
| Concurrency caps | `routingMaxConcurrent` | empty | A JSON object from a tier to a whole number of background calls that may run on it at once, for example `{"high": 1}`. |
| Auto-switch sessions | `routingAutoSwitch` | `0` (off) | `1` or `0`. When on, a session that hits a limit switches to the next tier at once instead of showing the button. |

Spend by model and by task, health per model and the fallback event log are on the same page. The **Now** page shows a model limit or a fallback while it lasts.

## Privacy and personal API

The personal API is optional. It is used only at the **Full** level, to distil StateCore memory. Everything else works without it.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Privacy level | `llmLevel` | `metadata` | **`off` Off**, **`metadata` Metadata only** and **`redacted` Redacted text**: the personal API is not called. **`full` Full**: enables StateCore distillation, which sends memory contents unscanned (see [How memory works](#how-memory-works)). |
| Service URL (base URL of an OpenAI-compatible API) | `llmBaseUrl` | empty | For example `https://api.openai.com/v1`, `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`, or `http://localhost:11434/v1` for Ollama. It must be `https://`, except for `localhost`, `127.0.0.1` and `[::1]`. It can't include a user name, password, `?query` or `#fragment`. A trailing `/chat/completions` is removed. Empty means not configured, which works the same as `off`. |
| Model | `llmModel` | empty | No spaces, at most 200 characters, for example `deepseek-chat`. |
| API key | — | — | Encrypted with the OS keychain (macOS Keychain / Windows DPAPI) and stored in `app.db`. After saving, at most the last 4 characters are shown, and a key shorter than 12 characters is shown only as `••••`. If OS encryption is unavailable, Butler refuses to save the key. Not needed for a local server. |
| Monthly budget (USD) | `llmMonthlyBudgetUsd` | `1` | Up to two decimals. Before each call, Butler estimates the cost (input plus the maximum output). If this month's spend plus the estimate would exceed the budget, the call is refused and logged. With a budget of `0`, only a model priced at zero can be called. |
| Price table (USD per million tokens) | `llmPrices` | `* 15 75` | One rule per line: `model-pattern input-price output-price`. `*` is a wildcard and matching ignores case. The first matching rule wins. Empty lines and lines starting with `#` are ignored. The default is deliberately expensive, so set your provider's real prices, for example `deepseek-chat 0.27 1.1`, or `* 0 0` for a local model. A model with no matching rule is never called. |
| Confirm before sending | `llmConfirm` | `0` (off) | `1` or `0`. While it is on, StateCore distillation does not run. |
| Keep audit records (days) | `auditRetentionDays` | `90` | 1 to 3650. The current month is always kept, because the budget check needs it. |

A saved key that can no longer be decrypted, for example after the keychain was reset, is only written to the log. It is not audited.

The personal API is called through Electron's network stack, so it follows your system proxy settings (including PAC scripts).

## Lessons: bulk actions, admission policy and import / export

### Bulk actions and batches

On the **Lessons** page you can filter the list (repository or product, status, admission, checkability, shelved reason, minimum hits, score range, batch, text, only output of a fallback model) and then act on **every lesson that matches** in one step: **Confirm all N**, **Reject all N**, **Disable all N**, **Enable all N** or **Delete all N**. You can also tick single pending lessons and act on just those. **Accept all recommended (M)** confirms the lessons the admission pipeline recommended (admission `auto`) and leaves the rest alone.

Every bulk action, every single confirm / reject / edit / disable / delete / merge, deleting a product (with its lessons and policy layer), every policy change and every import is recorded as a **batch** with a snapshot of each row before and after. The **Batches** tab lists them; **Undo** puts every row of a batch back as it was. A row that has changed again since that batch is left alone and counted as skipped; so is a product or lesson the batch created that something added later now depends on. A merge is undone as a whole or not at all. A batch counts as undone once at least one row was put back; undoing is itself recorded and cannot be undone again. Deleting a lesson also deletes the lessons merged into it, and undo brings them back merged. If the list changed after the page counted (for example a background analysis added matching lessons), a bulk action only touches the lessons the page had shown, and does nothing if it would change more than the number on the button. Merging no longer deletes the merged lesson: it is kept, hidden, pointing at the lesson it was merged into, so the merge can be undone.

Old lessons that you had already confirmed, disabled or rejected keep their status and get admission `manual`.

### Backup and export settings

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| Back up all configuration automatically every this many days (0 = off) | `configBackupIntervalDays` | `0` | A whole number from `0` (off) to `365`. Butler writes a full export to `<BUTLER_HOME>/backups/auto-<time>.json` once per interval (job `config_backup`; a failure is retried after an hour). Backups never contain secrets or local paths. |
| Automatic backups to keep | `configBackupKeep` | `10` | A whole number from `1` to `999`. Only the newest automatic backups are kept; backups written before a replace import and backups you start with **Back up now** are never removed. |
| Remind me to export after this many days (0 = off) | `configExportReminderDays` | `30` | A whole number from `0` (off) to `365`. When you have confirmed lessons and neither an export nor a backup has happened in this many days (counted from your first confirmed lesson if there has never been one), the Import / export tab and the Lessons tab say so. |

### Admission policy

The admission policy decides how the lesson pipeline scores, shelves, backtests, shadows and demotes rules. Every key can be set on three layers: **global**, **product** and **repository**. A repository uses its own value for a key, else the value of a product it belongs to, else the global value, else the default; the layers are merged key by key. When a repository belongs to several products that set the same key differently, the product whose name sorts last wins and **Settings → Lessons → Admission policy** shows a warning. Each change is an undoable batch and raises the policy version (scores record the version they were computed with). The defaults have not been calibrated yet; the page says so.

| Key | Default | Values | What it does |
|-----|---------|--------|--------------|
| `score.weight.evidence` | `0.3` | 0–1 | Weight of evidence (hits, PRs, reviewers) in the score |
| `score.weight.clarity` | `0.2` | 0–1 | Weight of clarity |
| `score.weight.consistency` | `0.2` | 0–1 | Weight of consistency with the existing rules |
| `score.weight.verifiability` | `0.3` | 0–1 | Weight of verifiability (can it become a check) |
| `score.weight.performance` | `0` | 0–1 | Weight of measured performance in shadow mode |
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
| `shadow.minPrs` | `5` | whole number 0–1000 | PRs a rule must run on in shadow mode before promotion |
| `shadow.minDays` | `7` | whole number 0–365 | Days in shadow mode before promotion |
| `shadow.maxFalsePositiveRate` | `0.2` | 0–1 | Highest false-positive rate in shadow mode |
| `shadow.minAdoption` | `0.6` | 0–1 | Lowest share of findings that were acted on |
| `shadow.autoPromote` | `false` | `true` / `false` | Promote out of shadow mode automatically when the bars are met |
| `conflict.autoPickHigherHits` | `false` | `true` / `false` | Settle conflicting rules by keeping the one with more hits |
| `demote.enabled` | `true` | `true` / `false` | Demote admitted rules that stop paying off |
| `demote.maxBypassRate` | `0.3` | 0–1 | Demote when a rule is bypassed more often than this |
| `demote.noReductionPrs` | `10` | whole number 1–1000 | Demote after this many PRs without fewer repeat comments |
| `demote.to` | `shadow` | `shadow` / `review` | Where a demoted rule goes: shadow (shadow mode) or review (back to the queue) |
| `admission.autoConfirm` | `false` | `true` / `false` | Confirm rules that pass admission without asking |

### Export file

**Import / export** on the Lessons page exports everything, one product or one repository, and either all content, lessons only (with products) or checks only (once checks exist). The file is JSON:

```json
{
  "format": "butler-config",
  "formatVersion": 1,
  "exportedAt": 1763337600000,
  "butlerVersion": "3.0.0",
  "scope": { "kind": "all" },
  "options": { "content": "all", "includeSourceUrls": false },
  "sections": { "products": [], "policies": [], "lessons": [] }
}
```

- **No secrets, no local paths, no comment text, no scores.** Lessons carry their text, reason, owner (repository slug or product name), status, admission, scope fields, hits and how many sources and distinct PRs they came from. Source PR links are included only when you tick **Include source links**.
- A file from a newer Butler (higher `formatVersion`) is refused; an older one is upgraded first. Sections this Butler does not know are skipped and listed.
- Every item has a stable **fingerprint** built from what it is, not from local ids: a lesson's normalised text (trimmed, spaces collapsed, lower case) plus its owner and path globs; a product's name; a policy layer's global / product name / repository slug.
- **Preview** shows each item as added, changed, conflicting (a decision differs: a lesson's status, strength or checkability, a product's repositories or a policy value), unchanged, or removed (replace only).
- **Merge** adds new items and keeps your local version of changed and conflicting ones by default; local items the file lacks stay. **Replace** first writes `<BUTLER_HOME>/backups/before-replace-<time>.json` (if that fails nothing changes), takes the imported version by default and removes local items in the file's scope that the file lacks. Either way you can switch every row to **all imported** or **all local**, or pick row by row.
- Imported lessons arrive **pending** (lessons the file had rejected stay rejected), in one batch you can undo from the Batches tab. Repositories this machine has not cloned are added without a local path and marked **not cloned on this machine**; their history cannot be analysed until Butler sees a clone. When a status conflict would confirm a lesson that is not confirmed here, the row says so.
- A **starter pack** exports your confirmed lessons without owner, status, hits or sources. Importing one asks which repository or product to add them to.
- **Model routing** (section `models`) is only in a full export of everything: registered models (name, tier, account, prices, note), each tier's chain, task overrides and your own and learned limit rules. Health, spend, events, unrecognised errors and rule notes stay on this machine. Imported models and rules arrive **disabled**, so an import never changes which model runs until you enable them on **Settings → Model routing**; ones you already have keep their on/off state. A different tier, account, price, chain order or task setting is a conflict. The routing tables are not part of batch undo: remove what you do not want on the routing page, or restore the backup a replace import writes first.

## Checks: deterministic rules on every edit

A check is a rule Butler can test without a model: a forbidden pattern, an import boundary, a comment policy, or a command to run. Checks live on the **Checks** tab of the Lessons page, in the same three layers as admission policy (global, product, repository; the nearest layer wins, a repository can switch off or override an inherited check by its key). You can write one by hand, or press **Make a check** on a lesson: Butler drafts one from the lesson text with a model, and you review it before saving. A lesson can also be marked **text only** when it cannot be checked mechanically.

- Butler writes the enabled checks to `<BUTLER_HOME>/checks/snapshot.json`. The `butler-hook check` hook reads only that file (never the database) after every `Edit`, `Write` or `MultiEdit` in a Butler session, and `butler-hook check-push` runs the push-stage checks when the agent runs `git push`. Sessions outside Butler are not affected; your own Claude Code settings are never changed.
- The hook finds the repository from the file's folder (its `origin` remote). A folder without a remote, an unreadable snapshot or a snapshot from another Butler version is let through and noted as **checks absent** on the session.
- Path globs (`globs`, `excludeGlobs`) match the path relative to the repository root, with `/` or `\` alike.
- **Types.** `forbidden_pattern`: a regular expression (or literal text) that must not appear in new lines. `import_boundary`: imports matching `forbid` (repository path globs or package names such as `electron`) are not allowed unless they match `allow`. `comment_policy`: a comment that says the code is temporary (built-in keywords in English and Chinese, such as *temporary*, *workaround*, *TODO*, 临时, 先这样) must carry a ticket id matching the ticket pattern; this built-in check exists from the start but is **off**. `run_command`: a shell command (`/bin/sh` on macOS and Linux, Git Bash on Windows); `{file}` is replaced by the changed file, passed as an argument, never pasted into the command; the file is also in the `BUTLER_CHECK_FILE` environment variable. An edit-stage command without `{file}` gets the file appended only when it is a single simple command (`eslint --max-warnings 0`); a compound command (with `;`, `&&`, `|`, redirection or a subshell) runs as written. Edit-stage commands run on the changed file only; push-stage commands run once before the push.
- **Modes.** A new check, and every imported one, starts in **shadow** mode: hits are only recorded. Switch it to **enforce** once its hit list looks right. An enforced `block` check sends the failure back to the agent as a hook block (the edit stays, the agent is told to fix the root cause); an enforced `warn` check and every shadow hit only add a note. Only violations that the edit introduced are reported, and each one once.
- A command that runs out of time is killed with its whole process tree and recorded as **could not check**; the edit is let through. Regular expressions (forbidden patterns, ticket patterns) get at most two seconds per edit; one that takes longer (for example a nested quantifier such as `(\w+\s?)+$`) is stopped and also recorded as **could not check**. A session started before you raise a time limit keeps the limit it started with. A failing push-stage check stops the `git push` with the reason. The merge gate is unchanged.
- The Checks tab shows, per check, its hits, how many were fixed by the agent afterwards (adoption) and how many you marked as false positives. Hits older than a year are removed.

| Setting | Key | Default | Notes |
| --- | --- | --- | --- |
| Run checks in sessions | `checksEnabled` | `1` | `1` or `0`. Off: the hooks are not registered for new sessions and running sessions are let through. |
| Time for checks after each edit (seconds) | `checksEditTimeoutSec` | `8` | A whole number from `1` to `30`. Shared by all edit-stage checks for one edit. |
| Time for checks before a push (seconds) | `checksPushTimeoutSec` | `600` | A whole number from `10` to `3600`. Shared by all push-stage checks. |

Checks are exported and imported with the other configuration (**Checks only** or **All**). They are matched by key and layer; a change in behaviour (type, parameters, globs, severity, on/off) is a conflict and, if imported, goes back to shadow mode; a change of name or message alone keeps your mode. A `run_command` check that is new or whose command changed arrives **switched off**, because even shadow mode runs the command: the preview shows each command, and you switch it on after reading it. A checks-only file never removes your products, even in replace mode. Replace never removes the built-in checks.

## Outward actions

Some later features will let Butler leave something outside your machine on your behalf, such as a reply under a PR comment. Each kind of action has its own switch under **Settings → Outward actions**, and all of them are off by default. While a switch is off Butler doesn't take that action; it only records a skipped entry. Every action taken, failed or skipped is listed under **Outward actions** on the **Audit** page, with the repo, ticket, target and what was sent, and is kept as long as `auditRetentionDays`. No feature uses these switches yet.

| Setting | Key | Default | What it allows |
|---------|-----|---------|----------------|
| Reply to review comments | `externalCommentReply` | `0` (off) | Replying under PR comments as you. |
| Resolve comments | `externalCommentResolve` | `0` (off) | Marking review threads on a PR as resolved. |
| Edit PR descriptions | `externalPrDescriptionEdit` | `0` (off) | Rewriting a PR's body. |
| Add or remove PR labels | `externalPrLabel` | `0` (off) | Adding labels to a PR or removing them. |
| Open PRs | `externalPrOpen` | `0` (off) | Opening a new PR with `gh`. |
| Edit PR titles | `externalPrTitleEdit` | `0` (off) | Changing a PR's title. |
| Force push | `externalForcePush` | `0` (off) | Rewriting a remote branch's history. |
| Rerun CI | `externalCiRerun` | `0` (off) | Starting failed CI runs again. |
| Post issues | `externalIssuePost` | `0` (off) | Creating issues or comments in your tracker or on GitHub. |
| Push notifications | `externalPushNotification` | `0` (off) | Sending notifications to an outside service, such as phone push or chat. |

Each switch is `1` or `0`.

## Several companies or profiles

Start Butler with a different `BUTLER_HOME`. If each company has its own Claude Code login, also set a different `CLAUDE_CONFIG_DIR`. Each `BUTLER_HOME` is a separate Butler with its own database, memory, hook binary, logs and settings, and its own Electron profile (`$BUTLER_HOME/electron`). Butler passes both variables on to the `claude` sessions it starts, so their hooks report to the right inbox.

Two Butler profiles that share one Claude Code configuration folder would install their hooks over each other. Give each profile its own `CLAUDE_CONFIG_DIR`.
