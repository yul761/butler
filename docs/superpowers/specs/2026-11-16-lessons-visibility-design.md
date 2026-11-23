# Review lessons: run visibility and Claude availability (design addendum)

Date: 2026-11-16. Branch `fix/pr-status`. This addendum ships in the same release as `docs/superpowers/specs/2026-11-16-pr-status-fixes-design.md`, and its plan runs after that plan's Task 19.

Evidence, with file:line references, is in `.superpowers/sdd/2026-11-16-pr-status-fixes/lessons-ux-investigation.md` (sections 1 to 5). This document records only the decisions.

## Problem

Review-lessons analysis works, but the user cannot see it working:

- When a run fails, only a count appears. The reason code is stored but never shown. The message, stderr, gh stderr, prompt, raw output and findings are thrown away (investigation §2).
- Skipped PRs (no review comments) are invisible.
- The apply result (`{created, hit, dropped}`) is discarded, so a run cannot be linked to the lessons it produced.
- Usage limits, rate limits and overload put the queue into an in-memory 10-minute loop that nothing shows and that a restart forgets.
- Model-unavailable errors become a permanent `claude_error`.
- Interactive Shipherd sessions that hit a limit look idle.

## Decisions

### 1. The engine stays headless; every attempt is recorded

The queue keeps running `claude -p` with `--json-schema`. A visible session would lose schema enforcement, open start dialogs, clutter the terminal, add judge costs, and break backfills of 100 PRs (investigation §4).

Every attempt writes one row in a new `lesson_runs` table (migration 24).

| Field group | Columns |
|---|---|
| Identity | `queue_id`, `repo_slug`, `pr_number`, `origin`, `pr_title`, `pr_url` |
| Result | `status` (running / done / skipped / failed / limited / aborted / cancelled), `reason` code, full `message` |
| Logs | `stderr_tail`, `gh_stderr` |
| Material and output | the prompt sent (`material`), `raw_output`, `findings_json` (`trimmed` = 1 once material and raw output are removed) |
| Counts | `created`, `hit`, `dropped` |
| Cost and timing | `model`, `cost_usd`, `input_tokens`, `output_tokens`, `duration_ms`, `started_at`, `finished_at` |

Related changes:

- `lesson_sources` gains `repo_slug` and `run_id`, so a product lesson's "#123" names its repo and a run lists its lessons.
- `lesson_queue` gains:
  - `attempts`, `last_run_id`, `error_message`;
  - `priority`, so a retried PR goes first.

**Size caps** (in characters, cut on a code-point boundary):

| Field | Cap |
|---|---|
| message | 4 000 |
| stderr tail | 8 192 |
| gh stderr | 4 096 |
| material | 65 536 |
| raw output | 65 536 |
| findings JSON | 65 536 |

**Retention.** Pruning runs at runner start and after each daily pull:

- keep at most 3 runs per PR (the newest);
- delete runs older than 90 days;
- keep `material` and `raw_output` only on the newest 200 runs, and set them to NULL with `trimmed = 1` on older ones.

**Cancelled state.** A cancelled queue row is stored as `status = 'skipped'` with `error = 'cancelled'`. This avoids rebuilding `lesson_queue` to widen its CHECK constraint, and the view maps it to `cancelled`. Backfill and daily pulls do not re-queue cancelled or skipped rows. Only an explicit retry does.

### 2. One shared `ClaudeAvailability` service in the main process

**The classifier.** `classifyLimit({ text, apiStatus, now, timeZone })` returns `{ kind, resetsAt, message }` or null.

- **Kinds:** `usage_limit`, `rate_limit`, `overloaded`, `model_unavailable`.
- **Patterns:** it is pattern-based, with fixtures in `src/main/claude/__fixtures__/limit-samples.ts`. It covers:
  - `Claude AI usage limit reached|<epoch seconds>`;
  - "5-hour / Weekly limit reached ∙ resets 3pm", "You've hit your limit · resets 3pm (Asia/Shanghai)", "resets Nov 20, 5am";
  - "credit balance too low", "You're out of extra usage", "usage credit limit reached", `billing_error` and "spend limit reached · resets Aug 8" (a date with no time);
  - `API Error: 429/529`, `rate_limit_error`, `overloaded_error`, "Repeated 529 Overloaded errors";
  - Bedrock "ThrottlingException / Too many tokens";
  - "There's an issue with the selected model", and `404 not_found_error … model`;
  - JSON `is_error` results, through `parseClaudeJson`.
- **Status codes** are read only from `api_error_status` or the `API Error: NNN` text, so a "429" in stderr (a line number, a port) is not a limit.
- **Reset times:**
  - `|<epoch>` takes 10 digits as seconds and 13 digits as milliseconds.
  - A wall-clock time is resolved in the stated zone, or else the local zone. With no date, a time already past rolls to the next day. A date with no time means 00:00 that day.
  - A result more than 1 minute in the past or more than 8 days ahead is discarded.
- **Fixtures are synthetic.** They are built from known CLI formats and from message strings in the installed CLI 2.1.326 binary. Real failing output was not captured on this machine (same caveat as investigation §2).

**Headless plumbing.**

- `runHeadless` returns `limit` and a `stderr` tail on every failure. Usage, rate and overload limits keep the reason `rate_limited`, so the handoff, feature, epic and nightly callers are unchanged.
- Model-unavailable gets its own reason, `model_unavailable`. It is no longer `claude_error`.
- `execHeadlessJson` calls `onLimit(hit)` and `onSuccess(at)`. Every headless deps object in `index.ts` wires these to the service.

**Interactive sessions.**

- `activity-parse` keeps the synthetic error text (it already sets `apiError`).
- `ActivityMonitor` classifies the text into `SessionActivity.limit` and reports each live, hookless limit end once (`source: "session"`).

**State.** The state is persisted in a one-row table, `claude_availability` (JSON). It holds:

- `current`: the hit still in force;
- `lastHit`: the newest hit ever;
- the backoff step;
- `lessonsPause`, with reason `limit`, `model` or `manual`.

**When the lessons queue pauses.**

| Trigger | Paused until |
|---|---|
| Usage, rate or overload limit from any source (same account), with a reset time | `resetsAt + 60 s` |
| Same, without a reset time | backoff of 10, 20, 40, 80, then 120 min (capped); two hits within 60 s count once |
| Model unavailable, only from the `lessons` job (judges use haiku; sessions pick their own model) | retried automatically after 60 min, with a manual retry button meanwhile |
| Manual pause | until the user resumes |

- A timer resumes the queue automatically.
- A success clears `current` and resets the backoff step, but it never clears a manual pause.
- Manual resume clears everything. If the limit is still real, the next attempt costs one spawn and pauses again.
- Other jobs (nightly handoff, feature summary, epic digest) keep their own reactions. They only report to the service.

### 3. "Open in Claude" for one run

This is opt-in, per run. It starts a visible Shipherd session the same way `openFix` and the patrol do: a short submitted task message, with the bulk in a file.

- **The file.** `~/.shipherd/workspaces/_lessons/run-<id>.md` holds the run's metadata, error, stderr, gh stderr, material, raw output and findings, all marked as data, not instructions.
- **The session.**
  - cwd is `_lessons`, so `Read` of the file needs no prompt.
  - It has `--add-dir` to the repo's local path and guide kind `shipherd`. It loads no Shipherd MCP and keeps the user's default model.
  - Its sessions row has the new `lesson_run_id`.
- **Where it shows.** It appears on the Shipherd page under its own heading.
- **What it skips.** It is excluded from stuck and needs-you judging, auto-refresh and the Now page rows.
- **Re-opening.** Opening the same run again returns the open terminal, or resumes the closed one without re-sending the task.

### 4. UI

- **Lessons page.**
  - A queue bar shows how many runs are going (and on which PR), how many are queued, and the pause state ("paused until HH:MM — <message>"). Its buttons are pause / resume and run now.
  - Selecting a repo shows two tabs, Lessons and Runs. The Runs tab lists the queue rows with:
    - PR number and title;
    - origin;
    - a status pill (running with elapsed time, queued, waiting, done, skipped, failed, cancelled, limited);
    - the reason text;
    - the time;
    - "new N · seen again N · dropped N".
  - Run actions are retry, cancel and open in Claude, plus "retry all failed" for the repo.
  - **Run detail panel:**
    - the reason and full message;
    - stderr and gh stderr;
    - model, cost and duration;
    - the lessons created or hit (with text and status) and the dropped count;
    - each finding (avoidable, why missed, rule);
    - collapsible material and raw output;
    - earlier attempts;
    - an open-PR link.
  - Product lessons show `slug#PR` on their source buttons.
- **Now page.** A new `NowView.notices` list appears at the top, even when nothing else needs the user.

  | Notice | Actions |
  |---|---|
  | Claude limited until HH:MM, lessons paused | resume, Health |
  | Model unavailable | retry, Health |
  | Lessons queue paused by the user | resume |
  | 3 or more consecutive failed runs | open Lessons |
  | A live session that hit a limit | open the session |

  That session's row reads "Claude limit reached" in the danger tone and is not folded into idle.
- **Settings → Health.** A "Claude 可用性 / Claude availability" block shows:
  - the state;
  - the current hit (kind, message, source, job, time);
  - when Shipherd retries;
  - the last hit;
  - the lessons pause;
  - Resume and Pause buttons.
- **Refresh.** Every run finish, state change and availability change sends `stateChanged`.
- **Strings and colours.** Every new string goes in both renderer string tables, or in both main tables. Only existing colour tokens are used (`--danger`, `--ok`, `--muted`, `--pill-*`), so light and dark contrast stays where it is today.

### 5. Verification

e2e uses the existing fake-claude, with:

- a lessons mode file (`fail`, `limit:<epoch>`);
- an interactive `/fake-limit <text>` command;
- the fake gh from the other plan's Task 19, extended with `pr view <number>`.

It covers three cases:

1. A failed run shows its reason, message, stderr and cost, and a retry succeeds.
2. A usage-limit run pauses the queue, starts nothing more, and shows the Now notice. Resume then drains the queue.
3. A session that hits a limit shows the badge, the Now notice and the Health entry.

## Out of scope

- A lessons model setting.
- OS notifications.
- A sidebar marker on the lessons entry.
- Pausing jobs other than lessons on a limit.
- Capturing real CLI limit output. This is a manual follow-up: replace the fixtures when a real sample is seen.
