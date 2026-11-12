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

After the tickets, the nightly run also writes a summary for every feature whose coordinator session or tickets had new activity since its last summary. It forks the coordinator session when there is one and uses the same read-only flags as a handoff. If the ticket run was rate limited, no feature summaries are written that night and the morning catch-up does them. A feature's page also has **Update now**, which first runs handoffs for the feature's tickets that had activity and then writes the summary. `/handoff` in a coordinator writes the summary from the conversation itself.

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

## Several companies or profiles

Start Butler with a different `BUTLER_HOME`. If each company has its own Claude Code login, also set a different `CLAUDE_CONFIG_DIR`. Each `BUTLER_HOME` is a separate Butler with its own database, memory, hook binary, logs and settings, and its own Electron profile (`$BUTLER_HOME/electron`). Butler passes both variables on to the `claude` sessions it starts, so their hooks report to the right inbox.

Two Butler profiles that share one Claude Code configuration folder would install their hooks over each other. Give each profile its own `CLAUDE_CONFIG_DIR`.
