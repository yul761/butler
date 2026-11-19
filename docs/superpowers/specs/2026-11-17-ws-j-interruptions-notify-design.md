# Workstream J: fewer interruptions that need no human, and outside notifications (design addendum)

Part of Butler 3.0.0. The master design is `2026-11-17-butler-3-design.md`. This addendum covers source plan 7.4 (everything except "measure first", which H did) and 7.12. It records the calls that were open and how they were settled. Contracts used: 4.1 router, 4.2 layered settings, 4.3 export/import, 4.7 metrics events, 4.8 external actions.

## 1. What the numbers said (measuring before building)

H's tables only started filling with 3.0.0, so the local history was read directly. Aggregate numbers only, no content:

- Butler's inbox: 4 `ask_user` decisions, all with options (category `choice`), 0 missing-information questions.
- Claude Code transcripts from the last 60 days: 5 `AskUserQuestion` calls with 9 questions. 8 of the 9 marked a recommended option, and the user picked it 8 times out of 8.
- Only 2 rejected permission prompts in the same period. Approved prompts leave no trace in transcripts, so the prompt count itself can't be read back. The commands that ran are the evidence.

Conclusions:

- **Choice.** Picking the recommended option is almost always what the user does, so a default rule pays off. It must leave a record so the user can check it afterwards.
- **Missing information.** Too rare to justify routing it inside Butler. The fix is a rule in the session guide: look first, ask last. Measurement continues through H's `missing_info` category, so the decision can be revisited.
- **Permission.** Build the profile from commands that actually ran, not from prompts.
- **Stuck.** Keep the existing fix session and wire it into the statistics.

## 2. Permission profiles

### 2.1 Where the candidates come from

`src/main/permissions/scan.ts` reads `<claude config>/projects/*/*.jsonl`:

- Files changed in the last 30 days, at most 400 files, at most 20 MB per file, read as a line stream.
- Every assistant `tool_use` whose transcript `cwd` maps to a repository slug (`RepoIdentity.slugOf`, so worktrees share their repository's profile).
- A tool use counts only when its `tool_result` exists and is not an error. If any use of a rule was rejected ("doesn't want to proceed"), the rule is excluded for that repository.

A command becomes a candidate rule when **the deterministic classifier** (2.2) turns it into a rule, and that rule ran at least 3 times across at least 2 sessions in that repository. Candidates are computed on demand and not stored. Only the user's answers are stored.

### 2.2 The safety boundary (deterministic, one choke point)

`src/main/permissions/classify.ts`:

- `ruleForCommand(command)` turns a Bash command into a rule, or returns null.
- `ruleForTool(name)` does the same for an MCP tool.
- `isSafeRule(rule)` re-checks a rule string.

Every rule passes through `isSafeRule` at three points: when it is stored, when it is imported, and when it is written into a session's `--settings`. A rule that fails is dropped, even if the user confirmed it or a file imported it.

Commands are refused outright when they contain any of:

- shell metacharacters `; & | < > $ \` ( ) { }`, newlines or backslashes;
- glob characters `* ? [` (a `*` turns an exact rule into a wildcard pattern in Claude Code);
- a leading variable assignment;
- a program given as a path;
- `sudo`, `env`, `xargs` or any other command that runs another command.

Only programs and subcommands in a curated table can produce a rule:

| Kind | Examples | Rule form |
|---|---|---|
| Any arguments are read-only | `gh pr view/list/diff/checks/status`, `gh issue view/list`, `gh run view/list`, `gh repo view`, `git status/rev-parse/ls-files/blame/merge-base/ls-tree`, `jq` | `Bash(<prog> <sub>:*)` |
| Read-only unless a flag says otherwise | `git log/diff/show/shortlog/rev-list/reflog show/stash list/stash show` (no `--output`, `--ext-diff`, `--textconv`), `git cat-file` (no `--textconv`, `--filters`), `git describe` (no `--dirty`, `--broken`), `git grep` (no `-O`), `git branch` (only listing flags), `git tag` (only with `-l`/`--list`), `git remote` (`-v`, `get-url`), `git config` (`--get`, `--get-all`, `--list`, `-l` only), `git worktree list`, `gh api` (no `-X`, `--method`, `-f`, `-F`, `--field`, `--raw-field`, `--input`), `rg` (no `--pre`, `--pre-glob`), `fd` (no `-x`, `-X`, `--exec`, `--exec-batch`), `tree` (no `-o`, `--fromfile`), `sort` (only `-r -n -u -f -b -h -V -s -k -t` and their long forms), `pnpm/npm ls/list/why/view`, `docker ps/images/logs/inspect` (no `-H`, `--host`, `--context`) | exact `Bash(<command>)` |

A forbidden long option is also refused in any abbreviated form (`--out=x` for `--output`), because git and getopt accept unique prefixes. `git ls-remote` and `git remote show` are left out: they reach the network and `--upload-pack` runs a command. `kubectl` is left out: `--kubeconfig` can name a file whose exec plugin runs code.

`git` with a global option before the subcommand (`-c`, `-C`, `--git-dir` and so on) is refused, because `-c` can set a pager or alias that runs code.

Some commands produce no rule:

- Commands that run the repository's own code: package scripts, `make`, test runners. A test script can write anything, so these never qualify.
- Commands Claude Code already lets through without asking (`ls`, `cat`, `grep`, `find`, `head` and so on). A rule for them would only add noise.

MCP tools qualify when all of these hold:

- the server isn't one of Butler's own;
- the tool part starts with a read verb (`get`, `list`, `search`, `read`, `view`, `fetch`, `describe`, `show`, `find`);
- no part of the tool name is a write verb (`create`, `update`, `delete`, `remove`, `add`, `set`, `post`, `send`, `write`, `edit`, `move`, `merge`, `close`, `transition`, `assign`, `comment`, `upload`, `run`, `execute`, `trigger`, `approve`, `reject`, `push`, `publish`, `deploy`, `cancel`, `archive`, `link`, `submit`, `replace`, `generate`, `reset`, `install`, `access`, `invoke`, `call`, `request`, `token`, `dialog`, `prompt`, `notify` and more; the full list is `WRITE_VERBS`).

MCP candidates are shown but not ticked by default in the wizard and Settings, since a name is all the check has to go on.

A unit test feeds a corpus of write commands (`git push`, `git commit`, `git branch -D`, `git tag v1`, `git config user.name x`, `rm`, `mv`, `sed -i`, `gh pr merge`, `gh api -X POST`, `find -delete`, `sort -o`, `rg --pre`, redirections, chains and so on) and a list of hostile rule strings (`Bash(*)`, `Bash`, `Bash(git:*)`, `Bash(git push:*)`, `Edit`, `Write(*)`, `WebFetch`, write MCP tools). Each one must be refused by both `ruleForCommand` and `isSafeRule`.

### 2.3 The model's part (router task `permission_profile`)

On request, the low-tier model (task `permission_profile`, contract 4.1) writes a one-line explanation of each candidate and may mark one as `caution`. A `caution` candidate starts unticked. The model can't add or rewrite rules: returned rules that aren't in the candidate set are discarded. If the call fails, the candidates are shown without explanations.

### 2.4 Storage, confirmation, use

- Table `permission_profiles(slug, rule, status, source, hits, sessions, decided_at)`, with `status` one of `confirmed`, `dismissed`, `pending`. `pending` only arrives through import, and the user confirms it like a fresh candidate.
- The user confirms once, from the wizard step 「权限档案」 or from Settings → 「打断与通知」. Unticked candidates are stored as `dismissed`, so they don't come back.
- `projectMcpApprovalSettings` gains `profileRules`. `index.ts` passes the union of confirmed rules for the slugs of the session's directories (the cwd plus the ticket's repositories). Each rule is re-checked with `isSafeRule` and added to `permissions.allow` after `SESSIONS_AUTO_ALLOW`.
- Global switch `permissionProfiles` (default `1`). With no confirmed rule the settings file is the same as in 2.1.0, so the anti-goal holds without making the user switch something on twice.
- Profiles are per repository only, not layered. The brief scopes them per repository, and a product-wide allow list would widen the boundary silently.

### 2.5 Measurement

When Butler starts or resumes a session, it records which profile rules went into that session's `--settings` and when. When the session stops, `ProfileHitCounter` reads the part of its transcript written since the last stop (at most 4 MB, up to the last complete line). For every `tool_use` that matches one of those rules, is timestamped after the start, and that `SESSIONS_AUTO_ALLOW` wouldn't already allow, it records `interrupt_auto_resolved` with `{category: "permission", via: "profile"}`, deduplicated by `profile:<session>:<tool-use id>`. Sessions Butler didn't start in this run, rules confirmed after the start and entries without a timestamp count nothing. A 4 MB stretch with no newline is skipped rather than read again on every stop.

- This replaces the `onTool` plan. The hook only sends Bash envelopes for push and PR creation, so most profile-allowed calls never reach `activity-monitor`.
- The count is an upper bound: Claude Code might not have asked for some of these calls (for example, when the user's own settings already allow them). The Effect page labels it "auto-resolved", not "prompts avoided".

## 3. Choices

- **Rule (setting `interruptChoiceRule`, default `0`).** The guide for ticket sessions and coordinators gets a paragraph: when there are options and one is clearly recommended, and nothing special applies, pick it, carry on, and record it with `report(kind: "choice")`, stating the question, the options, the pick and why. "Something special" means irreversible or outward-visible actions, cost, scope beyond the ticket, or a preference the user stated. In those cases keep using `ask_user`.
- `ReportKind` gains `choice`. The inbox stores these in `auto_choices` (source `rule`) instead of the report list: they aren't delivered to the coordinator. Each one records `interrupt_auto_resolved {category: "choice", via: "rule"}`.
- **Default answers (setting `interruptChoiceDefaults`, default `0`).** Table `choice_defaults(id, pattern, answer, enabled)`:
  - `pattern` is a set of `|`-separated keywords, matched case-insensitively against the question.
  - `answer` is either literal text or empty, meaning "the recommended option".
  - `ask_user` gains an optional `recommended` (index into `options`).
  - Only questions with at least two options (category `choice`) are answered automatically.
  - When a default matches, the decision is answered immediately, with a short prefix telling the session the answer came from the user's default. It goes into `auto_choices` (source `default`) and records `interrupt_auto_resolved {category: "choice", via: "default"}`. It does not count as a human intervention.
- **Review.** Settings → 「打断与通知」 lists auto choices, newest first, and marks them reviewed one by one or all at once. A choice the user disagrees with is fixed by answering the session directly; Butler doesn't try to undo it.

## 4. Missing information

Setting `interruptSelfServe` (default `0`). The guide for ticket sessions and coordinators gets a paragraph: before asking the user for a fact, look for it in this order:

1. the ticket through the tracker MCP;
2. the code, docs and git history;
3. memory `recall`;
4. for a ticket session under a coordinator, `report(kind: "blocked")` to the coordinator.

Ask the user only when none of these can supply it, and say what was already checked. No routing inside Butler (section 1).

## 5. Stuck

The fix session stays as it is. `openFix` records `stuck_fix_opened` (kind registered in `METRIC_KINDS`, group `other`). The Effect page shows stuck interrupts and fix sessions opened side by side, in the before/after table.

## 6. Effect page: before and after

- `interruptReductionSince`, an internal setting not editable from the renderer, holds the first time any of the J features came into effect: a profile rule confirmed, or the choice rule, default answers or self-serve switched on.
- The overview gains `interruptCompare`, with equal windows of up to 30 full days on each side of that time. The activation day itself is left out of both sides, since it is partly before and partly after; on that day both sides are null and the page says the comparison starts the next day. Each side has:
  - days;
  - Butler PRs merged;
  - human interventions per PR;
  - waiting-for-human time per PR;
  - interrupts per day by category;
  - auto-resolved interrupts;
  - stuck fix sessions.
- Before the cutoff exists, the panel says the comparison starts when the first feature is switched on.

## 7. Outside notifications (7.12)

- **Switch.** The existing 4.8 action `push_notification` (setting `externalPushNotification`, default off). J adds no action kinds. While it is off, the notifier does nothing and writes nothing.
- **Destination.**
  - A single HTTPS URL, stored encrypted under the secret `notify_webhook_url` (SecretBox, like the API key).
  - The renderer only ever sees the host.
  - It is never exported, and `http:` is refused except for loopback addresses (for tests).
  - Format `notifyFormat`:
    - `json` (default): `POST {"text", "content", "title", "event", "count"}`, which works with Slack-compatible and Discord-style chat webhooks;
    - `ntfy`: plain-text body with a `Title` header.
- **Network.** `PrivacyGateway.postWebhook` in `src/main/gateway` is the only code that sends. It enforces HTTPS, times out after 10 seconds, and sends no cookies or credentials. The notifier in `src/main/notify` builds the message and goes through `ExternalActions.attempt("push_notification", {target: host, ...})`.
- **Log.** Every decision the notifier makes is recorded in its own table, `notification_log(ts, event, count, status, host, payload, error)`, shown in Settings and pruned with the audit retention. `status` is one of `sent`, `failed`, `quiet`, `filtered`.
- **Events** (`notifyEvents`, default all five):

  | Event | Source |
  |---|---|
  | `decision_needed` | a new `ask_user` that wasn't answered automatically |
  | `pr_high_risk` | metrics event `pr_risk_high` (G, 4.6) |
  | `pr_ready` | metrics event `pr_ready` (G, 4.6) |
  | `cost_breaker` | metrics events `cost.pause` and `cost.stop` (L) |
  | `review_comment` | the PR watcher saw a new comment or review from a human other than the PR author |

  - Nothing else is pushed.
  - G isn't merged. J registers `pr_risk_high` and `pr_ready` in `METRIC_KINDS` as the contract G records to. The notifier listens by wrapping `recordEvent`, so neither G nor L needs code for this.
  - Agreed with G: `recordEvent("pr_risk_high", {ticketKey, prId, repoSlug, dedupeKey: "risk_high:<prId>:<headSha>", data: {prNumber, level: "high"}})` and `recordEvent("pr_ready", {…, dedupeKey: "ready:<prId>:<headSha>", data: {prNumber}})`. The notifier reads only `data.prNumber` (a positive integer) and the ticket key. It notifies only when the event was recorded, not when it was deduplicated.
  - `review_comment` counts new `comment` and `review` observations whose `who` is `human`, so the PR author and bots are excluded. The watcher's first read of a PR is history, and nothing is sent for it.
- **Content.**
  - Events of the same kind are gathered for 60 seconds and sent as one message with a count.
  - By default the message says only the kind and the count, for example "Butler: 2 decisions need you".
  - `notifyDetails=1` adds the ticket key and PR number. Question text, comment text, paths and repository names are never sent.
- **Test.** Settings has "Send a test". With the switch off, no request goes out: `attempt` records a `skipped` row in the outward-action audit, and the page says the switch is off.
- **Quiet hours.** `notifyQuietHours` takes the form `HH:MM-HH:MM` in local time and may wrap past midnight. Events inside the window are dropped and logged as `quiet`, not held back. When a 60-second batch is sent, the switch, the chosen events and quiet hours are checked again, so a batch that crosses into quiet hours or whose event was unticked is logged as `quiet` or `filtered` instead.

## 8. Export / import (4.3)

- Section `permissions`, order 70, content `config`. A's `models` section took 60.
- Items `{repo: slug, rule, status}`; the schema refines with `isSafeRule`, so a file containing a write rule fails validation for that item.
- Imported rules land as `pending` unless the local row is already `confirmed`: the user confirms them in Settings.
- Neither local paths nor the webhook are exported.

## 9. Settings added

| Key | Default | Meaning |
|---|---|---|
| `permissionProfiles` | `1` | Write confirmed profile rules into sessions. |
| `interruptChoiceRule` | `0` | Guide rule: pick the recommended option and record it. |
| `interruptChoiceDefaults` | `0` | Answer matching choice questions with the user's defaults. |
| `interruptSelfServe` | `0` | Guide rule: look for missing information before asking. |
| `notifyFormat` | `json` | `json` or `ntfy`. |
| `notifyEvents` | all five | Which events are pushed. |
| `notifyDetails` | `0` | Add the ticket key and PR number. |
| `notifyQuietHours` | empty | `HH:MM-HH:MM`, local time. |

New IPC channels are all configuration or reading, so they go into `NOT_TRIGGERS` in `interventions.ts`.

## 10. Checks made while developing

- **Claude Code rule syntax.** Checked against the current permissions docs: `Bash(x:*)` equals `Bash(x *)`; compound commands are split, and every part must be allowed; redirection targets are checked separately; a `*` in a rule makes it a wildcard. This is why exact rules never contain `*`.
- **Transcript shape.** Checked on this machine's transcripts: `cwd` on each entry, `tool_use.id` matched to `tool_result.tool_use_id`, rejections carry `is_error` and the "doesn't want to proceed" text.
- **The settings file a session already gets.** `projectMcpApprovalSettings` already writes `permissions.allow`, so profile rules join that list and Butler never touches the user's own Claude Code settings.
- **D's #43 wizard.** It is the lessons admission panel, not the first-run wizard, so the 「权限档案」 step goes into the first-run wizard between `privacy` and `done`.
