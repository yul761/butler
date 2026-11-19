# Workstream R: integration and release 3.0.0

Addendum to the [Butler 3 master design](2026-11-17-butler-3-design.md). R checks every workstream's acceptance on `main`, closes the leftovers, confirms that a user who configures nothing gets 2.1.0 behaviour, keeps the docs pairs in sync and prepares 3.0.0.

Verdicts: **pass** means a test proves it, and the test is named. **Reading only** means the behaviour was confirmed by reading the code, with the place given. **Fail** means it did not hold on `main` when R started. Every failure below was fixed in R unless the row says otherwise.

## 1. Acceptance checklist

### A: model routing

| Item | Verdict | Evidence |
|---|---|---|
| A1 a limited model is skipped, the record shows `fallback_from` | pass | `headless-exec.test` "a model marked limited is skipped and the record shows fallback_from (acceptance 1)"; `router.test`; e2e `routing.spec` |
| A2 an unknown error goes suspected → confirmed → rule | pass | `routing-service.test` "(acceptance 2)" |
| A3 nothing configured uses today's model | pass | `headless-exec.test` "(acceptance 3)"; `router.test` "unconfigured" |
| A4 soft and hard thresholds | pass | `router.test` "(acceptance 4)"; `spend.test` |

### B: coordinator gaps, Progress page, outward-action switches

| Item | Verdict | Evidence |
|---|---|---|
| B1 `list_prs` fields | pass | `control-butler.test` "list_prs adds the stack, review and merge fields…"; `pr-watcher.test` |
| B2 replies flow back | pass | `control-butler.test` "returns a requestId and sends the target's next reply back"; `butler-messages.test` |
| B3 `refresh_feature_summary` | pass | `control-butler.test` |
| B4 freshness considers PR state | pass | `feature-runner.test` "a PR status change after the summary read PRs makes the feature stale" |
| B5 Progress page | pass | `progress-view.test`; e2e `progress.spec` |
| B6 one switch per kind, off by default | pass | `external/actions.test` "has one editable flag per kind, off by default"; `settings-defaults-3.test` |
| B7 allowed / attempt / audit | pass | `external/actions.test` |
| B8 every outward action goes through the registry | reading only | `comment-loop.ts`, `ci-triage.ts`, `exporter.ts`, `brief-service.ts`, `stack-service.ts` (force push, PR operations, overview issue), `intake-service.ts`, `notifier` (webhook through the gateway). No `gh pr merge`, `gh pr review` or issue comment anywhere. The manual **Post to PR** button is user-initiated and audited but not switch-gated, as documented. e2e `defaults.spec` proves a fresh install makes no GitHub write. |

### C: lessons foundation

| Item | Verdict | Evidence |
|---|---|---|
| C1 bulk by filter, undo | pass | `lesson-batches.test` "confirms hundreds of pending lessons by filter in one batch…"; e2e `lessons-bulk.spec` |
| C2 import with diff preview, undoable | pass | `config-io.test`; e2e `config-io.spec` |
| C3 replace backs up first | pass | `config-io.test` |
| C4 imported checks start in shadow | pass | `checks-section.test` |
| C5 no paths, URLs or scores by default | pass | `config-io.test` |
| C6 no comment text in exports | reading only | `config/sections.ts` (the lesson section never reads excerpts) |
| C7 2.1.0 data kept, `decided` → manual | pass | `lessons-foundation-migration.test` |
| C8 "uncalibrated" label | pass | e2e `config-io.spec` |

### D: lesson quality and admission

| Item | Verdict | Evidence |
|---|---|---|
| D1 summary admitted / merged / shelved | pass | `wizard.test` "runs the stages, waits for the queue, summarises and accepts in one undoable batch" |
| D2 accept as one undoable batch | pass | same; e2e `lessons-admission.spec` |
| D3 calibration | pass | `calibration.test`; e2e |
| D4 the reviewer uses another model | pass | `router.test` "reviewers avoid the producer's model" |
| D5 migration | pass | `lessons-foundation-migration.test` |

### E1: checks engine

| Item | Verdict | Evidence |
|---|---|---|
| E1-1 block, message, `check_hits` | pass | `hook/check.test` "blocks an enforced violation the edit introduced and logs the hit"; `hit-ingest.test`; e2e `checks.spec` |
| E1-2 built-ins run in process | reading only | `hook/check.ts` `evaluateBuiltin`, regex worker |
| E1-3 `run_command` past the budget: allow and log | pass | `hook/check.test` "kills a run_command that runs past the budget…" |
| E1-4 internal error: allow and log | **fail → fixed** | Errors outside the per-check loop on edit, and any error running a push check, were allowed without a record. Now each unrecorded check gets an `error` hit. `hook/check.test` "lets the edit through and logs an error for each check when reading the file throws" and "lets the push through and logs an error when running a check throws, and still runs the others" |
| E1-5 "no checks" event | pass (record), reading only (display) | `session-service.test`; `NoChecksMark.tsx` has no test |
| E1-6 push checks | pass | `hook/check.test`; `project-mcp.test`; e2e `checks.spec` |
| E1-7 `comment_policy` seeded off | pass | `checks-service.test` "seeds the builtin comment check, off" |
| E1-8 the hook never opens SQLite | reading only | no sqlite import under `hook/` |

### E2: repo baseline

| Item | Verdict | Evidence |
|---|---|---|
| E2-1 stage 1 without a model | pass | `baselines-service.test`, `scan.test` |
| E2-2 profile in the guide, size-limited | pass | e2e `baselines.spec` step 4 |
| E2-3 stale profiles | pass | `baselines-service.test` |
| E2-4 legacy scan | pass | e2e `baselines.spec` step 5 |
| E2-5 lint export stops at a local branch | pass | `exporter.test`; e2e `baselines.spec` step 6 |

### F: backtests, promotion, demotion

| Item | Verdict | Evidence |
|---|---|---|
| F-a recall and false-positive rate | pass | `backtest/service.test` |
| F-b automatic promotion, undoable | pass | `lifecycle.test`; e2e `backtest.spec` |
| F-c score direction | pass (weak) | `scores.test`, partly circular by construction |
| F-d demotion from bypasses | pass | `lifecycle.test`; `hook/check.test` bypass detection |

### G: pre-review, readiness, risk

| Item | Verdict | Evidence |
|---|---|---|
| G1 ready plus brief | pass | `assessment-service.test` acceptance 1; e2e `prereview.spec` |
| G2 a migration is always high risk | pass | `risk.test` R1 |
| G3 missing evidence is not ready | pass | e2e `prereview.spec` |
| G4 no tests is never low risk | pass | `risk.test` |
| G5 deterministic | reading only | pure functions in `assess/` with tests |
| G6 the brief quotes only verified evidence | pass | `assessment-service.test` "renders the six sections from verified evidence only" |
| G7 avoidable-comment trend | pass, with a note | The trend compares Butler PRs with other PRs, not with a pre-Butler baseline: the baseline only stores cycle time and comment counts. Recorded as "vs other PRs". |
| G8 pre-review through the router | pass | `prereview/model.test` |
| G9 posting the brief is off by default | pass | `external/actions.test` |

### H: metrics and the Effect page

| Item | Verdict | Evidence |
|---|---|---|
| H1 30-day averages vs a baseline | pass, by design limited | Only cycle time and comments have pre-Butler data (H addendum §8). `overview.test` |
| H2–H7 events, daily rollup, Butler-made tag, interventions and waits, baseline backfill, page | pass | `events.test`, `rollup.test`, `interventions.test`, `wait-tracker.test`, `gh-job.test`; e2e `effect.spec` |

### I: comment loop and CI triage

| Item | Verdict | Evidence |
|---|---|---|
| I1 a Copilot comment delivered, replied, resolved | pass | `comment-loop.test` "delivers a Copilot comment, checks the place after the push, then replies and resolves"; e2e `comment-loop.spec` |
| I2 a network timeout is rerun | pass | `loop.integration.test`; e2e `ci-triage.spec` |
| I3 rerun cap then "may be flaky" | pass | `ci-triage.test` |
| I4 flaky statistics | pass (data), reading only (render) | `stats.test`; `EffectPage` |
| I5 own switches, off | pass | `external/actions.test`; `comment-loop.test` "records skipped replies when the outward switch is off" |
| I6 nothing configured = 2.1.0 | pass | `ci-triage.test` "delivers as is when the policy is off"; `comment-loop.test` "does nothing while the policy is off"; e2e `defaults.spec` |

Note: the I addendum §6 says `loop.integration.test` covers the comment loop too; it only has CI cases. The comment loop is covered by `comment-loop.test` and e2e `comment-loop.spec`.

### W-ci: CI delivery to the owning session

W1–W7 pass: `ci-delivery.test`, `notices.test`, `branch-owners.test`, `butler-hook.test`, `pr-watcher.test`; e2e `ci-delivery.spec`.

### J: fewer interruptions, notifications

| Item | Verdict | Evidence |
|---|---|---|
| J1 stop reasons classified | pass | `metrics/interrupts.test` |
| J2 shares on the Effect page | pass | `overview.test` |
| J3 safety boundary | pass | `permissions/classify.test` (about 200 write commands refused) |
| J4 per-repo profile into `--settings` | pass | `profile-service.test`, `project-mcp.test`; e2e `interrupts.spec` |
| J5 choice rule | pass | `guide.test`, `inbox-service.test` |
| J6–J9 webhook through the gateway, own audit and default off, kind and count only, quiet hours | pass | `webhook.test`, `notifier.test` |

### K: stacks

| Item | Verdict | Evidence |
|---|---|---|
| K1 four layers, bottom merged, rebase and ready PR | pass | `stack-service.test` (real git); e2e `stacks.spec` |
| K2–K7 daily rebase, squash and merge, managed worktrees only, backup refs, rollback, switches | pass | `stack-service.test`, `apply.test` |
| K8 no depth limit | **fail → fixed** | `MAX_STACK_LAYERS` was 30 and detection stopped a chain at 50. The MCP bound is now 1000 branches (a request size limit, documented as such) and detection follows a chain to its end with a cycle guard. `stack-service.test` "has no layer limit: a 40-layer stack is defined, and after the bottom merges every layer above is rebased" |

### L: spend caps and background work

| Item | Verdict | Evidence |
|---|---|---|
| L1–L4 caps pause and notify, continue raises, three layers, downgrade before pause | pass | `cost-breaker.test`, `notices.test`, `cost-policy.test`; e2e `cost-breaker.spec` |
| L5 background priority, windows, yield | **fail → fixed** | Two kinds in the table had no consumer. Automatic admission and the daily principles regroup now wait for the `lesson_admission` gate (`service.test` "automatic admission waits while its background gate is closed…"). The repo scan only runs when the user starts it, so its row is no longer listed (`scheduler.test` "does not list the repo scan…"). |
| L6 defaults = 2.1.0 | pass | `cost-breaker.test` "does nothing at all when no cap is set, like 2.1.0" |

### M: memory and responsiveness

| Item | Verdict | Evidence |
|---|---|---|
| M1, M2 hibernation and wake | pass | `hibernator.test`; e2e `hibernate.spec` |
| M3 no lag | reading only | priority and visibility tests |
| M4 memory per process tree on Now | pass | `memory-monitor.test`; e2e `terminal-memory.spec` |
| M5 pressure | pass | `hibernator.test` "stays under pressure until 5 points above the line"; `system-memory.test` |
| M6 the renderer keeps only visible terminals | reading only | `TerminalPane.tsx`; e2e `terminal-memory.spec` |
| M7–M11 priority, orphans, refresh by memory, shared MCP, pin | pass | `priority.test`, `orphans.test`, `memory-refresh.test`, hub tests; e2e `shared-mcp.spec` |
| M12 the new switches default off | pass | `settings-defaults-3.test` |

Gaps that stay: no test on a real Windows EcoQoS process, no `TerminalPane` unit test.

### N: work intake

| Item | Verdict | Evidence |
|---|---|---|
| N-a master switch off: nothing happens | pass (unit) / **e2e gap → fixed** | `intake-service.test` "off: never fetches and records nothing". The e2e enabled the policy before setting the source; `intake.spec` now configures the source first and checks that no queue appears and no session starts while the switch is off. |
| N-b … N-j | pass | `intake-service.test`, `policy.test`; e2e `intake.spec` |
| N-k the cap counts only auto-started sessions | reading only | `runningAuto` in `intake-service.ts` |

### W: memory admission replaces the session caps

W1–W8 pass: `control-handler.test`, `memory-admission.test`, `queue.test`; e2e `features.spec`.

### X: the wizard re-judges late material

| Item | Verdict | Evidence |
|---|---|---|
| X material while judging → one more pass | pass | `wizard.test` "judges again when the material arrives while the run is still judging" |
| X1 material after `stop()`, or quit before the pass | **fail → fixed** | see §3 |

### G (cross-platform e2e)

The full e2e suite ran on macOS locally (see §6); CI runs it on macOS and Windows. Specs that use the fake `gh` (an `sh` wrapper) skip on Windows, as before.

## 2. Nothing configured behaves like 2.1.0

Every new master switch and outward action defaults off. `src/main/db/settings-defaults-3.test.ts` asserts:

- every `external*` switch is `0`;
- `routingAutoSwitch`, `backgroundPriority`, `hibernateEnabled`, `memoryPressureEnabled`, `sharedMcp`, `refreshMemoryMb`, `preReviewEnabled`, `lessonsAutoAdmit`, `lessonsPrinciples`, `lessonsCoreGuide`, `interruptChoiceRule`, `interruptChoiceDefaults`, `interruptSelfServe`, `notifyDetails`, `configBackupIntervalDays` and `sessionMaxRunning` are `0`;
- `routingQuotas` is empty, `intakeSource` is `none`, `bgWindow` is `anytime`;
- the comment loop, CI triage, stack auto-rebase and intake policies are off;
- `shadow.autoPromote`, `admission.autoConfirm` and `conflict.autoPickHigherHits` are off;
- there are no spend caps.

`e2e/defaults.spec.ts` starts a fresh install, changes nothing, opens a session on a ticket whose PR has a review comment and failing CI, and checks that the comment does not reach the terminal, that Butler makes no `gh` write and no unsupported `gh` call, and that the Audit page has no outward action.

Defaults reviewed and kept:

- **`refreshMemoryMb`** was `2048`, which restarted any session over 2 GB even with hibernation off. That is new behaviour, so it is now `0` (off); the docs suggest 2048.
- **`orphanCleanup` stays on.** It only ends processes Butler itself recorded for sessions that have closed.
- **Memory admission replacing the 6 / 8 / 4 caps stays.** That was the user's decision (W addendum §1). README's overview names it as one of the two differences from 2.1.0.
- **`checksEnabled` and `permissionProfiles` stay on.** They do nothing until a check is enabled or a permission rule is confirmed; the only seeded check is off.
- **`configExportReminderDays` stays at 30.** It is a reminder line, nothing acts.
- **`memoryMonitor` stays on.** It only reads the process table.

## 3. Leftovers

| Id | Outcome |
|---|---|
| F1 the Checks page's false-positive rate ignored cached `backtest_judge` verdicts | **Fixed.** `cachedJudgments` reads only the cache (never calls a model). `Lifecycle.assessForView` uses it on the Checks page when the review has not computed a rate, if at least one hit in the sample was judged. `judge.test` "cachedJudgments"; `lifecycle.test` "the Checks page uses the model's cached verdicts…" |
| F2 push-only checks have no adoption rate, so they never auto-promote | **Not fixed.** It needs a "resolved" record for push checks in the hook's state (a push that passes after one that failed, per check and branch), and a product decision on whether a `run_command` check, which is never backtested, may be promoted without a backtest. Both are larger than R. The behaviour is documented (configuration, "Automatic promotion": adoption only counts edit hits). Reported to the coordinator. |
| F3 cancelling the review job needed a restart | **Fixed.** `keepReviewing()` enqueues the review now and every hour (deduplicated), so a cancelled or failed review is back within the hour. `stack.test` "keeps the review queued…" |
| X1 material after `stop()`, or a quit before the re-judge, left a verdict "unfinished" | **Fixed.** On resume, an `awaiting_accept` run with unfinished verdicts and no failed items gets its pass again; runs with a failed item that will still be retried keep the 1 / 5 / 15 minute backoff; a failure that used up its retries no longer holds the pass back. `wizard.test` "judges again after a restart even when the run has a failure that used up its retries" `wizard.test` "judges again after a restart when the material came after stop()…" |
| N1 users with a saved `notifyEvents` don't get `intake_decision` | **Fixed** with an append-only migration that adds it to a saved list. `notifyEvents` did not exist in 2.1.0, so only pre-release users were affected. |
| N2 the `activeInRepo` wiring has no unit test | **Fixed.** Extracted to `intake/conflicts.ts` with tests. |
| K8 follow-up: deep stacks and rerere | One `--update-refs` rebase over many layers could stop more than 50 times; the automatic `--continue` now stops only when a step makes no progress (`rebase-engine.ts`). |
| G full e2e on both platforms | macOS locally (66 specs); CI runs both. |
| macOS terminal-memory flake | **Fixed at the cause.** The monitor sampled 5 s after start, which could land between the two sessions opening, and the next sample was 60 s later. A terminal opening or exiting now schedules one extra sample 3 s later (`soon()`). No retries were added. |

## 4. Docs

- Every key in the settings table, and every key of the layered policies (admission, cost, intake, comments and CI, PR readiness, stacks), is named in both `docs/configuration.md` and `docs/configuration.zh-CN.md`. A one-off script checked this; the internal timestamp keys (`metricsSince`, `metricsBaselineCutoff`, `skillTrackingSince`, `interruptReductionSince`, `configLastExportAt`, `admissionPolicyVersion`) are described as not edited directly.
- `externalPrOpen` now says it also covers a stack's retarget, ready-for-review and closing a draft.
- README and README.zh-CN have a "New in 3.0.0" section, in the same heading position.
- CONTRIBUTING and its twin have the "new behaviour is off until turned on" rule and point at the registry and the two tests that enforce it.

## 5. Version and release

`package.json` goes to 3.0.0 in a commit titled "3.0.0: …", like 2.1.0. After it merges and CI on `main` is green on macOS and Windows (packages included), the coordinator's updated instruction applies. It replaces item 6 of the brief: tag `v3.0.0` (annotated) on that commit and push it so `release.yml` runs. Then check that both installers are on the release, set the notes in both languages in the 2.1.0 format, and publish the draft the same way 2.1.0 was published.

## 6. Local checks

`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` on macOS before each PR.
