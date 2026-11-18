# Workstream A: model routing and limit fallback (design addendum)

Date: 2026-11-17. Base: `main` at 2.1.0. Master design: `2026-11-17-butler-3-design.md` (contract 4.1, rules 4.9). Source: part 6 of the maintainer's local improvement plan, stages A to E, all of it.

## 1. What this adds

Every background model call names a **task** (`TaskId`). A router turns the task into an ordered list of models (its tier's chain, then lower tiers down to the task's minimum), skips models that are limited, unavailable or over a soft quota threshold, and runs the call. When a call fails with something that looks like a limit, the model is marked, and the task either falls back to the next model, waits, or (interactive) escalates to the user. Limit recognition is data (rules the user can add to, and learn from unknown errors), not hard-coded regexes. A new settings tab, **Model routing**, shows and edits all of it.

**A user who configures nothing gets 2.1.0 behaviour.** "Configured" means: at least one enabled model in the model registry. Until then each call site uses the model it uses today (`haiku` for the judges, `sonnet` for refresh and the epic digest, the session's own model for handoffs and feature summaries, the user's default for lessons), there is no fallback, nothing is skipped before it runs, and `ClaudeAvailability` (the account-wide state with the lessons pause) behaves exactly as before.

## 2. Code layout

| Place | What |
|---|---|
| `src/shared/model-routing.ts` | `Tier`, `LimitPolicy`, `TaskId`, the task registry (`TASKS`), config and view types shared with the renderer. |
| `src/main/routing/rules.ts` | Limit rule engine: built-in rules (today's `classifyLimit` regexes as data), user / learned rules, reset-time parsers, generic signals. |
| `src/main/routing/health.ts` | `ModelHealth`: per-model state with the back-off and recovery logic of `ClaudeAvailability`, plus account-level marking and probing. |
| `src/main/routing/router.ts` | Pure planning: task + config + health + spend → candidates (or "wait until"). No I/O. |
| `src/main/routing/spend.ts` | Period start, spend per model / tier / task from `session_usage`, threshold levels. |
| `src/main/routing/discovery.ts` | Model discovery: candidate names from env, Claude Code settings and `--help`; probe calls. |
| `src/main/routing/learning.ts` | Unrecognised errors, "same model keeps failing while others succeed", turning an error into a rule. |
| `src/main/routing/routing-service.ts` | Glue: repos + health + router + learning, used by `execHeadlessJson`, sessions, IPC and the UI. |
| `src/main/routing/config-section.ts` | The `models` export / import section (contract 4.3). |
| `src/main/db/routing-repo.ts` | Tables below. |
| `src/main/handoff/headless-exec.ts` | Runs a call through the router: picks the model, adds `--model`, falls back and retries, records what happened. |

`src/main/claude/limits.ts` keeps `classifyLimit` and `resolveReset` as thin wrappers over the rule engine with the active rule set, so every existing caller (headless runs, the session activity parser) uses the same data-driven rules.

## 3. Task registry

All task ids from the master design table are registered now, including ones whose callers come later (D, E1, E2, F, G, I, J, N). Each has `tier` (`high` / `mid` / `low` or `session`), `minTier`, `policy`, `critical`, and `legacy` (today's model: a model alias, `null` for "the user's default", or `session`). `lesson_sample_review` also has `differentFromProducer: true` and `tierAtLeastProducer: true`: callers pass the producer's model and tier and the router removes that model from the candidates and raises the start tier (when another model is configured; otherwise it runs anyway and the run is flagged `same_model_review`).

Per-task overrides live in `task_routes` (tier, min tier, policy, critical). The effective route is registry defaults overlaid by the override.

Legacy mapping for callers that exist today: `needs_you`, `stuck_judge` → `haiku`; `handoff_refresh`, `epic_digest` → `sonnet`; `lesson_analyze` → default; `handoff`, `feature_summary` → session model; `model_probe` → the model being probed. New tasks have `legacy: null` (the user's default model), which is what a new call site would do in 2.1.0.

## 4. Chains and tiers

- `model_registry`: name, tier, enabled, account (a free label, default `default`; models behind one subscription or gateway share a label), optional price per million input / output tokens (for money quotas), note, position.
- `model_chains`: per tier an explicit ordered list of model names. With no rows for a tier, its chain is the enabled registry models of that tier in registry order. A chain may name a model registered in another tier or any name a gateway accepts (another provider's model through the same `claude` endpoint).
- Candidates for a task: chain(start tier), then chain(next lower tier), … down to `minTier`, de-duplicated. A tier with no models is skipped; if the start tier and everything above `minTier` is empty, the router walks **up** from the start tier (a stronger model is always acceptable), and if nothing is configured at all it uses the legacy choice.
- End of chain: the call is not lost. It returns `rate_limited` with `waitUntil` = the earliest recovery among the candidates; queue-based callers (lessons) defer to that time, others keep their 2.1.0 handling of `rate_limited`.

## 5. Limit recognition

**Rules are data.** `limit_rules` rows: `kind` (`regex` | `status` | `field` | `reset`), `pattern`, `category` (`usage_limit` | `rate_limit` | `overloaded` | `model_unavailable`; null for reset rules), `account_level`, `source` (`builtin` | `user` | `learned`), `enabled`, `position`. Built-ins live in code with stable ids (`builtin:usage`, …), so a later version can improve them without a migration; the table stores user and learned rules and an enabled override for a built-in. Built-in order and semantics are exactly today's `PATTERNS`, `statusKind` and the `not_found_error` + `model` rule, so classification is unchanged (the existing sample fixtures run against the engine).

- `field` rules (`error.type=rate_limit_error`) match a JSON key / value anywhere in the output.
- `reset` rules are regexes with named groups (`epoch`, `iso`, `in_s` / `in_m` / `in_h`, or `month day hour minute ampm tz`); built-ins are today's epoch and "resets …" parsers; no match → back-off.
- **Generic signals** (used only when routing is configured; otherwise only recorded): HTTP 429 → `rate_limit`, 529 → `overloaded`, 402 → `usage_limit`; a failed run whose output contains `quota` / `billing` / `credit` → `usage_limit`, or `limit` → `rate_limit`; the same model failing 3 times in a row while another model succeeded since that streak began → suspected `usage_limit`.
- **Attribution:** a rule marked `account_level`, or an error that names no model, marks the account: every enabled model with the same account label whose tier is at least the failing model's tier (conservative, a cheaper tier may still work). Otherwise only the model that was called. Built-in usage-limit texts are account level; rate limit, overloaded and model-unavailable are per model.
- **Unrecognised errors:** every limit-like failure that no rule recognised (generic or correlated signal) goes to `unrecognized_errors` (fingerprint = first lines with digits normalised; count, models, first / last seen, status `open` / `confirmed` / `dismissed`). The page asks "Is this a limit?": **Yes** turns it into a `learned` regex rule (the distinctive line escaped, digits generalised) with the chosen category and account scope; **No** dismisses it, clears suspicion it caused and stops the correlated signal for that fingerprint.

## 6. Health and recovery

`model_health` per model: `state` (`ok` | `limited` | `unavailable` | `probing`), `kind`, `until`, `reset_known`, `backoff_step`, `consecutive_failures`, `failure_streak_since`, `last_success_at`, `last_failure_at`, `last_failure_text`, `suspected`. The back-off is `ClaudeAvailability`'s (reset time + 1 minute; else 10/20/40/80/120 minutes; model unavailable 1 hour; hits within a minute de-duplicated). When the reset time was known, the model is usable again at `until`. When it was not, the model enters `probing` at `until` and the service sends one `model_probe` call (smallest prompt, no tools, the low-effort flag when supported) to that model; success → `ok`, a limit → next back-off step. A success of any real call clears the model's state (unless it started before the hit, as today).

`ClaudeAvailability` stays as the account / default-model state and the lessons manual pause. Calls made without `--model` (legacy mode, session tasks with no stored model) keep reporting to it exactly as before. When routing is configured, the lessons gate is "manual pause, or the router can run `lesson_analyze` nowhere right now" (until = earliest recovery).

## 7. Headless execution

`execHeadlessJson(d, { task, label, args, prompt, cwd, resumedId?, sessionModel?, producer? })`. Call sites stop putting `--model` into `args` (`headlessArgs` keeps the option for probes). The exec layer:

1. asks the router for a plan; a plan that says "wait" returns `rate_limited` without spawning (configured mode only);
2. per candidate: inserts `--model <name>` (and `--effort <level>` when configured and `claude --help` shows it) and runs; honours the per-tier concurrency cap;
3. on a limit: reports health (model or account), logs a `route_events` row, and if the policy is `fallback` and a next candidate exists, retries the same prompt with it; otherwise returns `rate_limited` / `model_unavailable` with `waitUntil`;
4. on any other failure: no retry (it is not a limit); the failure feeds the correlated signal;
5. records `task`, `requested_tier`, `actual_model`, `fallback_from` (the first model it tried, when the result came from another) on the usage row, returns the same on the result so run records (lessons) store them.

Session tasks (`handoff`, `feature_summary`) never change model (a fork with another model loses the whole prompt cache) and never fall back; when their model is known to be limited they wait.

Claude Code's own `--fallback-model` is not used: it switches silently, only on overload, and not every version / gateway has it. The router's own fallback works everywhere.

## 8. Interactive sessions

- `start_session`'s `model` accepts `high` / `mid` / `low`, a registry model name, or the old `opus` / `sonnet` (and `haiku`). Unconfigured: tiers map to `opus` / `sonnet` / `haiku`, names pass through as today. Configured: a tier resolves to the first healthy model of its chain; a model name that is limited resolves to the next healthy model in its tier's chain. Anything else is refused with the list of valid values. The result carries `model` (what the session got) and `requested`.
- `SessionModel` becomes a validated string (letters, digits and `._-:/@[]`, at most 100 chars).
- When `claude --help` does not list `--model`, Butler does not pass it (and the start result says so).
- Mid-session limit: the activity monitor already sees API / limit errors. The session's model is marked (configured mode), and the session row (ticket, feature, epic and Butler pages) shows a limit pill with **Switch to <next model> and continue**. Butler ends the terminal, waits for it to exit (at most 15 s, otherwise it refuses with "still running"), records the new model on the session (`sessions.setModel`) and reopens it the usual way for its kind, which passes `--resume <id> --model <next>`. It does not type anything into the resumed session: the user decides what to say. The next model is the one after the session's model in its tier's chain, then lower tiers; unconfigured it is `opus` → `sonnet` → `haiku` (and `sonnet` when the session had no model). With `routingAutoSwitch` on (default off) Butler switches on the hit without the click. A hint with no known reset time expires after 6 hours; × dismisses it.

## 9. Spending control

Settings (all default empty / off): `routingQuotas` (JSON list of `{ target: "tier:high" | "model:<name>", unit: "usd" | "tokens", monthly }`), `routingThresholds` (`70,90`), `routingPeriodStartDay` (1–28, default 1, local time), `routingEffort` (JSON map from task id or tier to an effort level), `routingMaxConcurrent` (JSON map tier → max concurrent background calls), `routingAutoSwitch`.

Spend for the current period comes from `session_usage` (all sources): tokens, and money from the recorded `cost_usd` of headless runs (new column) or, for rows without it, tokens × the registry price when set. Levels per model: `ok` below the first threshold; `soft` (≥ first): non-critical `fallback` tasks skip the model; `hard` (≥ second, including over 100 %): every non-critical task skips it, so `fallback` tasks degrade and `wait` tasks wait until the period ends. Critical tasks always may use it (quotas are soft: Butler only sees its own usage). Passive detection after a real limit stays the main path.

## 10. Re-runs of degraded results

`lesson_runs` gains `requested_tier`, `actual_model`, `fallback_from`, and `lesson_queue` gains `upgrade_pending`. A lessons analysis that finished on a model of a lower tier than requested sets `upgrade_pending`. When the requested tier's first model is healthy and not over a threshold (checked on health changes and hourly), those rows go back to the queue at low priority with `upgrade_pending` cleared; re-analysis is idempotent per comment URL (`addSource`), and the prompt includes the existing lessons so the model links them with `same_as`. The lessons page shows "waiting for an upgrade re-run" on such PRs. D reads `lesson_runs.fallback_from` (via `lesson_sources.run_id`) to be stricter with degraded items: `LessonRunsRepo.degradedRunIds()`.

## 11. Visibility

Settings get two tabs, **General** (everything as today) and **Model routing**: discovery and registry (tier, enabled, account, price), chains, task → tier table (with overrides and policy / critical), health per model (state, until, last error, Probe now / Clear), spend by model and by task for the period with quotas, the fallback / wait event log, unrecognised errors with Yes / No, and the limit rules (built-ins can be turned off, user rules added and removed). The "Now" page shows a `routing` notice (configured mode only) when a registered model is limited or unavailable, or something fell back in the last hour, with a button to the Model routing tab; session rows show the limit pill and switch action.

## 12. Export / import

`models` section (`routing/config-section.ts`, `ModelsConfigSection`): `registry` (without `enabled`), `chains`, `taskRoutes`, `rules` (user and learned; kind, pattern, category, account scope, source). Not exported: health, events, spend, unrecognised errors, built-in enabled overrides (machine-local tuning), and rule notes (a learned rule's note is a line of raw error text that can hold a path or a name).

- `preview(incoming)`: per item `added` (no local item), `changed` (local is the default: a task with no override), `conflicting` (both sides have their own and they differ), `unchanged`, plus `invalid` entries (bad name, unknown tier / task / policy, a rule that does not compile, duplicates, a newer section version). One bad entry never fails the section.
- `apply(incoming, "merge")`: writes added and changed, keeps local on conflicts. `apply(incoming, "replace")`: incoming wins every conflict and local models, chains, task overrides and user / learned rules that are not in the file are removed (the framework writes the backup first, per 4.3).
- **Imported models and rules arrive disabled** (the 4.3 "pending" state): an import never changes routing behaviour by itself, and a machine with no routing stays on 2.1.0 behaviour until the user enables a model. A model that is already registered keeps its local enabled state. Imported rules get a stable id from kind + pattern (`imported:<hash>`), so importing the same file twice does not duplicate them.
- Written against the 4.3 interface; C's framework is not on `main` yet, so the file carries a local copy of the interface (`ConfigSection`) and is not registered anywhere. Whichever of A and C merges second constructs `new ModelsConfigSection({ repo: routingRepo, now, onApplied: () => routing.reloadConfig() })` and registers it.

## 13. Verified during development

- Claude Code 2.1.327 `--help`: `--model <model>` (aliases such as `opus`, `sonnet`, or a full name), `--effort <level>` (`low` … `max`), `--fallback-model` (silent, overload only; not used). `--resume <id> --model <m>` resumes with another model. The capability probe now records `--model` and `--effort` as optional flags; missing ones are left out, not reported as errors.
- Discovery candidates, in this order and de-duplicated: models already in the registry, `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, the `model` of Claude Code's user `settings.json` (read only), models seen in Butler's own usage records of the last 30 days, and the CLI aliases `opus`, `sonnet`, `haiku`. Each is probed with a tiny `model_probe` call (60 s timeout, no tools); a name that does not exist comes back `model_unavailable` and is shown as unavailable, never assigned. Discovery only suggests: the user adds a model with one click and a suggested tier.
- The existing limit samples (`claude/__fixtures__/limit-samples.ts`) classify identically through the rule engine.

## 14. Acceptance (from the plan)

1. A model marked limited (simulated) is skipped; background tasks fall back or wait by policy; the run record shows `fallback_from`. (router + exec tests, lessons runner test)
2. A made-up error no rule knows: suspected limit → unrecognised list → user confirms → becomes a rule that recognises it next time. (learning + service tests)
3. No routing configured: every call site uses today's model, lessons use the default, nothing is skipped. (exec + call-site tests)
4. Spend at the soft threshold: low-value tasks drop a tier; at the limit, quality-sensitive tasks wait instead of degrading. (router + spend tests)

## 15. Decisions made while building

- **Policies in the exec layer.** `fallback` and `wait` both try the planned candidates in order; the difference is the task's range (`wait` tasks have `minTier` = their tier, so they only move within the tier, then wait). `escalate` stops after the first limit and hands the result back (interactive use). Non-limit failures are never retried.
- **Configured but no model in range** (`no_models`): the call uses its legacy model, so a half-configured registry (say, only a `high` model) does not break low-tier tasks.
- **`preferred`** in a routed plan is the first model of the range before health / quota skips; `fallback_from` on the usage and run rows is that model whenever the result came from another one, so "degraded" is visible even when the skip happened before the call.
- **Spend matching** counts usage rows by exact model name and by the name embedded in a full id (`claude-…-<name>-…`), so a registry alias still gets its usage.
- **Lessons gate.** `RoutedLessonsGate` wraps `ClaudeAvailability` for the lessons runner and service: unconfigured it is the availability itself; configured it is "manual pause, or `lesson_analyze` can run nowhere" (`routing.lessonsBlockedUntil()`).
- **Upgrade re-runs withdraw before re-running.** When degraded rows go back to the queue, lessons that the degraded run created, that are still `pending` and whose every source came from that run are deleted first, so the re-run does not create a duplicate; lessons the degraded run only added a source to stay. The runner is pumped right after requeueing.
- **Routing settings are global only** (models, accounts and quotas belong to the account, not to a repository or a product); they are not layered per 4.2.
- **`--model` and `--effort` are optional flags** in the capability probe: missing ones are left out silently and the routing page says so; `start_session` then returns `model: null`.
- **`start_session` validation is split.** The MCP server checks the shape (a tier or a valid model name, no enum, so registry names pass); main checks existence (configured: tier, registry name or old alias; otherwise refused with the valid values before any terminal opens).
- **Session switch events** go into `route_events` (`session_switch`, from → to), so the event log shows them next to fallbacks.
