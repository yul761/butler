# Configuring Butler

Butler has no config files. Everything is set on the **设置 (Settings)** page and stored in `~/.butler/app.db`. This page lists every setting, what it does and which values it accepts. It also explains how to adapt Butler to another company's tracker and conventions.

The UI is in Chinese. Labels are quoted exactly as they appear in the app, followed by an English gloss. The names in `code` are the internal keys, which help when you read logs or the database.

The Settings page has these sections, in order:

1. **环境检查 (Environment check)**
2. **常规 (General)**
3. **记忆（StateCore）(Memory)**
4. **调度与 handoff (Schedule and handoffs)**
5. **隐私与个人 API (Privacy and personal API)**

The audit log has its own page, **审计 (Audit)**, in the sidebar.

## 环境检查 (Environment check)

This section shows:

- the `claude` Butler found, its version, and any required flags its `--help` is missing
- the hook status and the `/handoff` command status
- the Butler data folder and the Claude Code `settings.json` that Butler would edit

The section has three buttons:

- **重新检测 (Check again)**
- **安装 / 修复 (Install / repair).** Copies `butler-hook` to `~/.butler/bin`, merges the four hooks into `settings.json` and writes `commands/handoff.md`. The first time, it saves a backup copy as `settings.json.butler-backup`. If `settings.json` is not valid JSON, Butler refuses to touch it. It never overwrites a `handoff.md` that it didn't write.
- **卸载 (Uninstall).** Removes only Butler's own hook entries and its own `handoff.md`.

These buttons, and the same step in the first-run wizard, are the only way Butler ever writes to your Claude Code configuration.

## 常规 (General)

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| claude 路径 (claude path) | `claudePath` | empty | Empty means Butler searches your login shell's `PATH`. Otherwise, the absolute path to your company's `claude`, as printed by `which claude` (or `where claude` on Windows). Saving it runs the environment check again. |
| 分支名模板 (branch template) | `branchTemplate` | `feature/{key}` | Used when Butler creates a ticket's branch and you leave the branch name empty. `{key}` is replaced with the ticket id. It must contain `{key}`, be at most 100 characters, and use only letters, digits and `. _ / -`. It can't start with `-` or `/`, can't contain `..`, `//` or `/.`, and can't end with `/`, `.` or `.lock`. Examples: `users/alice/{key}`, `{key}`. |
| ticket 号正则 (ticket pattern) | `ticketPattern` | `[A-Z][A-Z0-9]+-\d+` | A JavaScript regular expression for ticket ids. See [Ticket pattern](#ticket-pattern) below. |
| 开机时自动启动 Butler (start at login) | — | off | Only available in an installed Butler, not in development mode. |
| 重新运行首次启动向导 (rerun the first-run wizard) | `onboardingDone` | `0` for new installs | A button, not a field. The wizard sets this to `1` when you finish or skip it, and the button sets it back to `0`. Existing installs that already have tickets were migrated to `1`. |

### Ticket pattern

Butler uses the pattern in three places:

- to check the id when you create a ticket
- to suggest a ticket for unclaimed sessions
- at the 元数据 (metadata) and 脱敏文本 (redacted) privacy levels, to catch a ticket id that slipped through without a placeholder

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

## 记忆（StateCore）(Memory)

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| 把 handoff 的进度、决策、follow-up 和经验写进 StateCore… (write progress, decisions, follow-ups and learnings to StateCore, and mount memory in Butler's sessions) | `memoryEnabled` | `1` (on) | `1` or `0`. When off, Butler writes nothing to StateCore and starts sessions without the memory MCP servers. Existing memory is kept. When you turn it back on, Butler catches up on the tickets it missed. |

This section also shows:

- the StateCore data folder (`~/.butler/statecore`)
- whether the memory MCP bundle was found
- a warning if StateCore's own Claude Code capture plugin is installed. Don't run that plugin alongside Butler: memory would be recorded twice.
- the **重新运行首次启动向导 (rerun the first-run wizard)** button

### How memory works

- **Scopes.** Each ticket has its own StateCore scope (`ticket:<KEY>`). Learnings shared across tickets go to a `workspace` scope.
- **Mounting.** Each time you open a session for a ticket, Butler rewrites `~/.butler/mcp/tickets/<ticket>.json` and starts `claude` with `--mcp-config` pointing at it. The file mounts two servers: `butler-memory` (the ticket scope) and `butler-workspace`. Both run with Butler's own Electron in Node mode, with no model key in their environment. Nothing is registered in Claude Code's own MCP configuration.
- **What Butler writes.** After every complete handoff (morning refreshes and incomplete handoffs don't count), Butler writes:
  - a new handoff version: status, what was done, next steps and open questions
  - the ticket's open follow-ups and its latest decisions, as notes. Butler keeps at most 24 of its own notes per ticket, which leaves room for Claude's own `remember` calls.
  - the handoff's learnings, to the `workspace` scope

  Butler also syncs a ticket at startup and when you open a session for it. It syncs again when you complete, ignore or reopen one of the ticket's follow-ups.
- **The 30-note cap.** StateCore keeps at most 30 notes per scope, and a forgotten note keeps its slot. Before each write, Butler counts the free slots. If none is left, it skips the write rather than let StateCore evict the oldest entry, so Butler never evicts its own notes. When slots are short, open follow-ups go first, then decisions. As a result, **a long-lived ticket stops gaining new memory entries once its scope is full, even at the 完整 (full) level**. Distillation does not free those slots. The skipped entries are still in Butler's own database and on the ticket page. In the `workspace` scope, StateCore evicts the oldest learnings once it holds 30 notes.
- **The 记忆 (Memory) tab** on a ticket page shows the latest handoff, decisions, open follow-ups and other notes. Click **来历 (history)** on an entry to see its version chain. The tab refreshes after each Butler sync. It does not update live while Claude writes to memory inside a session.
- **Distillation.** This happens only at the 完整 (full) privacy level with **发送前确认 (confirm before send)** off. It runs in the background after every nightly handoff run, including catch-up runs and **立即运行晚间 handoff (run the nightly handoff now)**. For each scope with pending events, StateCore makes one or more calls to your personal API and turns the events into notes. Together the calls send:
  - the scope name, which for a ticket is the real ticket id (`ticket:<KEY>`)
  - the scope's recent raw events, including what Claude stored with `remember(consolidate: true)`
  - the scope's existing memory as JSON: Butler's follow-up and decision notes, Claude's own notes, and the previous summary with its next steps
  - the text of notes forgotten in that scope, so that the model won't bring them back

  In the `workspace` scope, each learning is tagged with the id of the ticket it came from.

  **None of this is pseudonymized or scanned.** The scanner covers only the 今日重点 (today's focus) path. Each call is checked against the monthly budget and refused if it would exceed it. Every sent or over-budget call is audited, and shows as **StateCore 记忆蒸馏 (StateCore distillation)** on the Audit page. A call refused for any other reason, such as the level changing or no usable key, is only written to the log.

  Butler skips ticket scopes with fewer than 6 free note slots and leaves their events for later. The calls are made by Butler's main process, inside the privacy gateway, and no StateCore process ever receives the API key.

## 调度与 handoff (Schedule and handoffs)

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| 晚间 handoff 时间 (nightly handoff time) | `nightlyTime` | `16:00` | `HH:MM`, local time. If Butler was closed, asleep or locked at that time, the run catches up at the next launch, wake or unlock, before the morning brief. |
| 工作日 (working days) | `workingDays` | `1,2,3,4,5` (Mon–Fri) | Checkboxes in the UI. The stored value is a comma-separated list of `0`–`6`, where `0` is Sunday. Nightly handoffs and morning refreshes run only on these days. "Previous working day" in the brief skips the other days, so Monday's brief looks back to Friday. |
| 简报阈值（天）(brief thresholds, days): 阻塞超过 (blocked longer than) / 等 review 超过 (waiting for review longer than) / 无活动超过 (idle longer than) | `blockedDays`, `reviewWaitDays`, `staleDays` | `2`, `2`, `5` | Whole numbers from 0 to 999. A blocked ticket shows up under 🟡 今天 (today). A PR waiting for review or an idle ticket shows up under ⚪ 留意 (watch). |
| tracker MCP 工具 (tracker MCP tools) | `trackerTools` | empty | One MCP tool name per line, in the form `mcp__<server>__<tool>`. `mcp__<server>` alone allows every tool of that server, so avoid it unless the server is read-only. Anything else, such as `Bash(...)` rules or flags, is rejected. Handoffs and refreshes may call these tools, plus `Read`, `Grep`, `Glob`, `gh pr view`, `gh pr checks`, `git log` and `git status`, plus anything your user-level or managed (policy) Claude Code settings allow (see below). |
| 后台 handoff 也加载本地级的 MCP… (unattended runs also load local-scope and approved project MCP servers) | `headlessProjectMcp` | `0` (off) | `1` or `0`. See [Plugging in your tracker](#plugging-in-your-tracker). |
| handoff prompt 模板 (handoff prompt) | `handoffPrompt` | built in | The instructions sent to `claude` for a handoff. It can't be empty and is limited to 20,000 characters. See [Adapting the prompts](#adapting-the-prompts). |
| 早间刷新 prompt 模板 (morning refresh prompt) | `refreshPrompt` | built in | The quick morning check of PR and tracker status. It doesn't summarise the conversation. Same limits as above. |

The section also has **立即运行晚间 handoff (run the nightly handoff now)**.

Handoffs and refreshes start `claude` with these flags:

- `--permission-mode dontAsk`: any tool that is not allowed is refused, so there is never a prompt.
- `--disallowedTools Edit Write NotebookEdit`: these are always denied.
- `--setting-sources user`: your user-level Claude Code settings apply, and so do managed (policy) settings, which Claude Code always loads. Allow rules and hooks in the repository's own settings do not.

The allowed tools are the list above plus the allow rules in your user-level `settings.json` and in any managed settings. These runs are not strictly read-only. If those settings allow, say, `Bash(npm:*)` or a write-capable MCP tool, unattended runs can use it too. Only `Edit`, `Write` and `NotebookEdit` are always blocked.

### Plugging in your tracker

Butler never talks to your tracker itself. Handoffs read it through the MCP servers configured in your company's Claude Code. Pick **read-only** tools only:

1. Configure the tracker's MCP server in Claude Code as you normally would. User scope is simplest.
2. In Settings, click **从 Claude Code 检测 (Detect from Claude Code)**. Butler lists every MCP tool your Claude Code exposes. Tools whose names look like reads (get, list, search, read, view, fetch, query, find, …) are pre-ticked. Untick anything that writes, then click **加入选中的工具并保存 (add the selected tools and save)**.
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

Keep `{{schema}}` and the output instructions. Butler also passes the JSON schema to `claude --json-schema` and validates the result. If the output fails validation, Butler retries once with the errors, and if it still fails it stores an incomplete handoff, marked **不完整 (incomplete)**. The tracker status field is called `jira` in the schema whatever tracker you use.

## 隐私与个人 API (Privacy and personal API)

The personal API is optional. It writes the brief's 今日重点 (today's focus) and, only at the 完整 (full) level, distils StateCore memory. Everything else works without it.

| Setting | Key | Default | Accepted values and notes |
|---------|-----|---------|---------------------------|
| 隐私档位 (privacy level) | `llmLevel` | `metadata` | **`off` 关闭**: never call the personal API. **`metadata` 仅元数据**: placeholders, status and PR enums, follow-up kinds and triggers, counts and day numbers, with no free text. **`redacted` 脱敏文本**: adds short next steps, blockers and follow-up descriptions, with known identifiers and your sensitive terms replaced by placeholders. **`full` 完整**: real ticket ids and text with no placeholders, so sensitive terms are sent verbatim. It also enables StateCore distillation, which sends memory contents unscanned. See [Privacy levels](#privacy-levels). |
| 服务地址 (base URL of an OpenAI-compatible API) | `llmBaseUrl` | empty | For example `https://api.openai.com/v1`, `https://api.deepseek.com/v1`, `https://openrouter.ai/api/v1`, or `http://localhost:11434/v1` for Ollama. It must be `https://`, except for `localhost`, `127.0.0.1` and `[::1]`. It can't include a user name, password, `?query` or `#fragment`. A trailing `/chat/completions` is removed. Empty means not configured, which works the same as `off`. |
| 模型 (model) | `llmModel` | empty | No spaces, at most 200 characters, for example `deepseek-chat`. |
| API key | — | — | Encrypted with the OS keychain (macOS Keychain / Windows DPAPI) and stored in `app.db`. After saving, at most the last 4 characters are shown, and a key shorter than 12 characters is shown only as `••••`. If OS encryption is unavailable, Butler refuses to save the key. Not needed for a local server. |
| 每月预算（美元）(monthly budget, USD) | `llmMonthlyBudgetUsd` | `1` | Up to two decimals. Before each call, Butler estimates the cost (input plus the maximum output). If this month's spend plus the estimate would exceed the budget, the call is refused and logged. With a budget of `0`, only a model priced at zero can be called. |
| 价格表（美元 / 百万 token）(price table, USD per million tokens) | `llmPrices` | `* 15 75` | One rule per line: `model-pattern input-price output-price`. `*` is a wildcard and matching ignores case. The first matching rule wins. Empty lines and lines starting with `#` are ignored. The default is deliberately expensive, so set your provider's real prices, for example `deepseek-chat 0.27 1.1`, or `* 0 0` for a local model. A model with no matching rule is never called. |
| 每次发送前弹窗确认 (confirm before every send) | `llmConfirm` | `0` (off) | `1` or `0`. Shows the exact outbound request before every 今日重点 (today's focus) call. While it is on, StateCore distillation does not run. |
| 审计保留天数 (audit retention, days) | `auditRetentionDays` | `90` | 1 to 3650. The current month is always kept, because the budget check needs it. |
| 敏感词表 (sensitive terms): 人名 (people) / 其他敏感词 (other terms) | — | empty | One per line, each at least 2 characters (at most 100), up to 500 in total. Below 完整 (full), these are replaced by placeholders before sending and restored in the reply. At 完整 (full) they are sent as they are. Some identifiers are handled automatically and don't need to be listed: ticket ids (including Jira subtask ids), repo and worktree folder names, branch names, the owner and repo names in PR links, and ticket titles. |

### Privacy levels

What each level sends for 今日重点 (today's focus):

- **关闭 (off):** nothing.
- **仅元数据 (metadata):** placeholders for tickets, status and PR enums, follow-up kinds and triggers, counts and day numbers. No free text.
- **脱敏文本 (redacted):** the above, plus up to 3 next steps, blockers and follow-up descriptions per ticket, each at most 120 characters. Before sending, Butler replaces the following with placeholders that are new for every request:
  - ticket ids, including Jira subtask ids
  - repo and worktree folder names
  - branch names
  - the owner and repo names in PR links
  - ticket titles
  - your sensitive terms

  A colleague's name that is not in the sensitive-terms list is sent as is.
- **完整 (full):** the same fields as redacted, but nothing is replaced. Real ticket ids, names and your sensitive terms are sent verbatim. This level also enables StateCore distillation, which sends memory contents without any scan (see [How memory works](#how-memory-works)).

Every 今日重点 request goes through these steps:

1. **Field allow-listing.** Butler picks the fields the level allows. Below full, identifiers are replaced with placeholders.
2. **Budget.** If the call would exceed the monthly budget, it is refused and audited with no body.
3. **Scan.** At every level, the request is checked for anything that looks like a secret or token, a URL, an IP address, an email address, a file path or a domain name. A domain name here means a public top-level domain from a fixed list, or an internal suffix such as `.corp`, `.internal` or `.lan`. Bare host names like `jenkins01`, and domains under other TLDs, are not caught. Below full, the request is also checked for ticket ids and original values that should have been replaced. Any hit blocks the whole request: it is audited with the reason and no body, and nothing is sent. The scanner does not recognise names.
4. **Audit.** An audit row is written with the exact request body.
5. **Confirmation.** If **发送前确认 (confirm before send)** is on, Butler shows you the request. If you decline, the row is marked as declined.

Add the people you work with to **人名 (people)**. That protects them at the redacted level, but not at full.

A saved key that can no longer be decrypted, for example after the keychain was reset, is only written to the log. It is not audited.

The personal API is called with Node's `fetch`, which does not use your system proxy settings.

## Several companies or profiles

Start Butler with a different `BUTLER_HOME`. If each company has its own Claude Code login, also set a different `CLAUDE_CONFIG_DIR`. Each `BUTLER_HOME` is a separate Butler with its own database, memory, hook binary, logs and settings, and its own Electron profile (`$BUTLER_HOME/electron`). Butler passes both variables on to the `claude` sessions it starts, so their hooks report to the right inbox.

Two Butler profiles that share one Claude Code configuration folder would install their hooks over each other. Give each profile its own `CLAUDE_CONFIG_DIR`.
