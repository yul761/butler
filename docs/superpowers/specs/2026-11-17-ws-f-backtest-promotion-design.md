# Workstream F: backtest, automatic promotion out of shadow mode, automatic demotion (design addendum)

Date: 2026-11-18. Master design: `2026-11-17-butler-3-design.md` (uses contracts 4.1, 4.2, 4.3, 4.4, 4.5, 4.7). Base: `main` after C (#35), D (#41–#43), E1, H (#46, #47), L (#45), I (#48); E2 (#44) is read from its branch and wired after it merges. G (pre-review and per-lesson comment stats) is developed at the same time; the interface between F and G is fixed in section 9.

Scope: admission gates 5, 6 and 7 of the source plan (backtest, shadow mode, undo and automatic demotion); the verifiability and post-launch performance score parts; batch coverage and overall backtest; calibration samples for checks and the periodic threshold review on D's calibration tab; wizard stage 3 ("generate checks and backtest"); the new policy keys. Out of scope: the check engine itself (E1), the repo baseline and legacy scan (E2, reused), pre-review and the comment trend data (G, read only).

## 1. What was verified in the code

- **Drafts are produced in D's judging stage, not in wizard stage 3.** `AdmissionPipeline.judge` scores, then calls `runDrafts` for admitted checkable lessons, then `readDraft`. `WizardService.generate` (stage 3) only calls `BacktestRunner.run(scope, onCall)` and stores `backtested`. So gate 5 runs inside judging, right after a draft exists, and stage 3 prefetches the backtest material so judging never waits on `gh`.
- **The score cap is informational in D.** `scoreLesson` adds a `cap` part (`min(score, score.untestedCap)`) to checkable lessons without verifiability but decides the outcome from the uncapped score. The source plan's meaning ("cannot be admitted *as blocking* on the other parts alone") is applied by F at promotion time (section 6.2).
- **Accept writes the draft as a shadow check** (`acceptPlan`: `checks.saveIn(ctx, scope, null, {...draft, mode: "shadow"}, {lessonId})`) in the atomic `accept_recommended` batch. So a backtest computed on the draft must be found again from the saved check: results are keyed by a definition hash (section 3.4), not by check id.
- **Hit log (E1).** `check_hits.outcome` is `fail | resolved | timeout | unavailable | error`; `blocked` is set when an enforce + block check failed. `resolved` is written when a fingerprint reported earlier disappears from the file. The hook's PostToolUse `decision: "block"` does not undo the edit: an agent that ignores the block leaves the violation in place, and the debounce (`state.reported`) means it is not reported again. Nothing records suppression comments, `--no-verify` or tampering with Butler's files. F adds that (section 7.1).
- **Comment positions.** `lesson_sources` has `pr_number, repo_slug, reviewer, path, line` (D's enrichment). `line` is GitHub's `line` (the current side). The code the reviewer saw is at `original_commit_id` / `original_line` of the REST review comment; the merged diff usually no longer contains the problem because the comment got it fixed. Recall therefore cannot be measured on the merged diff; it is measured on the file at the commit the reviewer commented on (section 3.2). `gh.ts` already has `mergedPrs`, `prLessonDataDetail`, `compareFiles`, `reviewComments` (without commit ids); F adds `prDiff`, `reviewCommentCommits` and `fileAt`.
- **Background queue (L).** Kind `backtest` is registered for F (low priority, interruptible, resumable, task `backtest_judge`). Handlers get `signal`, `checkpoint`, `save()`; `enqueue` dedupes by `dedupeKey` among queued and running jobs. F starts no timers: the periodic review re-enqueues itself with `notBefore` (section 6.1).
- **Batches (4.4).** `ChecksService.bulk(ids, op, {origin})` writes a batch `check_<op>`; `LessonBatchService.undo` restores rows and already records calibration samples for lessons in automatic batches. F adds a listener for undone check batches (section 8).
- **Notices.** `NowNotice` is a union rendered by `noticeText` / `Notice` in the renderer; I's `comments_waiting` is the pattern. F adds `check_promoted` and `check_demoted` notices with an undo button.
- **Metrics (H).** `recordEvent(kind, refs)` accepts any `snake.case` kind; `METRIC_KINDS` classifies the known ones. H has only per-PR comment totals, so the per-lesson trend comes from G.
- **E2 (on its branch).** `listRepoFiles(root)`, `legacyFiles`, `legacyEvaluate(check, path, content, ticketPattern)` (pure) and `LegacyScanService.run(checkId, slug)` (worker, awaitable), `latest(checkKey, slug)`. Repo path: `lesson_repos.local_path`, else `ticket_repos.repo_path` matched through `RepoIdentity.slugOf`. F uses `LegacyScanService.run` for the "existing violations" number once a check exists, and E2's `CoverageProvider` for "already covered by lint" (D's gate 4 already asks it).
- **Policy keys.** `ADMISSION_POLICY_KEYS` already holds the backtest / shadow / demote / score keys C defined; the `policies` config-io section and the policy page iterate that array, so new keys only need the definition, strings and docs.

## 2. Data model (one appended migration)

### `backtest_prs` — material: merged PRs and their diffs

| Column | Meaning |
|---|---|
| `repo_slug`, `pr_number` | primary key |
| `merged_at` | ms |
| `status` | `ok` / `failed` / `too_large` |
| `diff` | unified diff from `gh pr diff` (null unless `ok`; capped at 2 MB, larger is `too_large`) |
| `fetched_at` | ms |

### `backtest_comments` — material: where each inline review comment pointed

| Column | Meaning |
|---|---|
| `repo_slug`, `pr_number`, `comment_id` | primary key |
| `author`, `path`, `line`, `original_line`, `original_commit` | from the REST comment |
| `fetched_at` | |

### `backtest_files` — material: a file at a commit

| Column | Meaning |
|---|---|
| `repo_slug`, `sha`, `path` | primary key |
| `status` | `ok` / `missing` / `too_large` / `binary` / `failed` |
| `content` | text (capped at 1 MB) |

### `check_backtests` — results

| Column | Meaning |
|---|---|
| `id` | |
| `def_hash` | hash of `{type, params, globs, excludeGlobs}` (section 3.4) |
| `sources_hash` | hash of the lesson's source ids (recall depends on them); empty without a lesson |
| `lesson_id` | → `lessons.id` ON DELETE SET NULL |
| `check_key` | set once a check with this definition exists |
| `repo_slug` | one row per repo (a product check has one per repo) |
| `status` | `done` / `skipped` / `failed` |
| `skip_reason` | `not_cloned` / `no_gh` / `run_command` / `no_material` (only `skipped`) |
| `prs` | merged PRs scanned |
| `hits` | violations on added lines of those diffs |
| `matched_hits` | of them, within tolerance of any review comment in that PR |
| `judged`, `judged_fp` | unmatched hits sent to `backtest_judge`, and how many it called false positives |
| `false_positives` | estimated false positives (REAL, section 3.3) |
| `fp_rate` | `false_positives / hits` (null when `hits = 0`) |
| `comments` | lesson source comments that could be tested (path known, PR material available) |
| `comments_matched` | of them, caught by the check |
| `recall` | `comments_matched / comments` (null when `comments = 0`) |
| `legacy` | existing violations in the current code (E2's legacy scan; null until run) |
| `legacy_scan_id` | E2's scan id |
| `samples` | JSON: up to 10 false-positive examples `{pr, path, line, text, verdict}` and up to 5 caught comments |
| `created_at` | |

Index on `(def_hash, repo_slug, created_at)`.

### `check_bypasses` — bypass events from the hook

| Column | Meaning |
|---|---|
| `id`, `check_id` (→ checks ON DELETE SET NULL), `check_key`, `repo_slug`, `file`, `line` | |
| `how` | `suppress` (a suppression marker added at a blocked line) / `no_verify` / `hooks_off` / `tamper` |
| `detail` | the marker or a short command excerpt (no full command text) |
| `session_id`, `at`, `ingest_key` (unique, like `check_hits`) | |

A separate table instead of a new `check_hits.outcome` value: rebuilding `check_hits` to widen its CHECK constraint while other workstreams also migrate would be fragile, and bypasses are attributed to a check rather than measured on a file.

### `check_scores` — composite score of a check

`check_id` PK (→ checks ON DELETE CASCADE), `score`, `score_parts` (JSON: `verifiability`, `performance`, `composite`, optional `cap`), `scored_at`, `policy_version`. A separate table, not columns on `checks`: scores are recomputed on every review tick, and changing `checks` rows would make every promotion batch look "changed since" and become impossible to undo.

### `check_lifecycle` — F's state per check row

`check_id` PK (→ checks ON DELETE CASCADE), `needs_review` (0/1), `reason` (code), `reason_data` (JSON for the page), `last_batch_id`, `last_action` (`promote` / `demote` / `flag`), `updated_at`. It holds what is not in `checks`: the "needs review" flag and the reason shown on the page.

### `threshold_reviews` — periodic threshold suggestions

`id`, `at`, `scope` (JSON, global for now), `key` (policy key), `current`, `suggested`, `basis` (JSON: sample counts, rates), `status` (`open` / `applied` / `dismissed`), `batch_id` (the policy batch when applied).

### `score_calibration`

Unchanged. F writes `entity = 'check'`, `entity_id = check id`, `lesson_id = the check's lesson`, `auto_verdict` `promote` / `demote`, `human_verdict` `shadow` / `enforce`, `source = 'override'`. D's lesson statistics filter on `entity = 'lesson'`, so they are not affected.

## 3. Backtest

### 3.1 Material (background job `backtest`, op `prefetch`)

For a repo slug:
1. Local clone: `lesson_repos.local_path`, else a `ticket_repos.repo_path` whose slug matches (the same lookup E2 uses). None → every backtest for that repo is `skipped: not_cloned`. `gh` unavailable → `skipped: no_gh`.
2. `mergedPrs(cwd, null, backtest.recentPrs)` → upsert `backtest_prs` rows; for each without a diff, `gh pr diff <n>` (one call per PR, checkpointed after each, interruptible). PRs older than the newest `recentPrs` are deleted from the cache.
3. The PRs that the in-scope lessons' sources come from (they may be older than the recent window) get `reviewCommentCommits` (REST comments with `original_commit_id`, `original_line`) and, for each comment matching a source (same path; author equals the source's reviewer when known; line equal to `line` or `original_line` when known), `fileAt(original_commit, path)`.
4. Each gh call goes through `runGh` with a timeout; a failing PR is `failed` and retried on the next prefetch (at most 3 attempts per PR, counted in the row). The job saves `{slug, done: [pr...]}` as its checkpoint, so a yield or restart continues.

Wizard stage 3 (`BacktestRunner.run(scope, onCall)`) enqueues a prefetch per repo in the scope with the wizard's ticket key and waits for those jobs (polling the job rows, honouring cancellation). It returns `backtested: true` when every repo in scope has material, false when any was skipped. When the pipeline runs outside the wizard (auto-admit), missing material makes gate 5 answer `pending`: the lesson is `unfinished` this round, a prefetch job is enqueued, and when that job finishes F calls `lessonAdmission.scheduleAuto(slug)`.

### 3.2 Recall

For each lesson source with a path in a PR whose comment material exists: evaluate the check on the file content at `original_commit` (`evaluateBuiltin` with the same `RuleContext` as the hook, `inScope` for globs). The comment is caught when any violation lies within `backtest.lineTolerance` lines (new key, default 3) of `original_line` (or `line` when the original is unknown). `recall = caught / testable`. A lesson with no testable source comments has `recall = null`; gate 5 then treats recall as unknown (section 4).

### 3.3 False positives

For each cached merged PR diff: parse the unified diff into files and hunks; rebuild each file's new side as text with the hunk lines at their new line numbers (gaps are empty lines, so line numbers are right); evaluate the check; keep violations on added lines (`newViolations` semantics: only what this PR added). Each kept violation is a hit. A hit within tolerance of any review comment on that PR (any reviewer, from the cached comments; PRs without fetched comments count as unmatched) is `matched` (someone did point at it). Unmatched hits are false-positive candidates: code that was merged after review without anyone objecting.

Up to `backtest.judgeSample` (new key, default 20; 0 = off) unmatched hits, chosen by a seeded sample, go to `backtest_judge` (router task, mid tier, fallback) in one call per check: the lesson text, the check's message and for each hit the path, line and ±5 lines of context. The model answers per hit `violation` (a real instance the reviewers missed) or `false_positive`, with a short reason. Answers are cached in `lesson_judgments` (new kind `backtest_fp`, key `def_hash`, input hash of the sampled hits), so recomputation is free.

`false_positives = unmatched × (judged_fp / judged)` when something was judged, else `unmatched` (conservative: judging off or failed means every unmatched hit counts). `fp_rate = false_positives / hits`. A check with `hits = 0` has `fp_rate = null` (no evidence of noise).

### 3.4 Identity and reuse

`def_hash = sha256(canonical({type, params, globs, excludeGlobs}))`. A result is reused while `def_hash`, `sources_hash` and the newest material PR are unchanged. Editing a check changes the hash; the review tick (section 6.1) enqueues a fresh backtest for enabled checks without a current result, so checks created by hand, imported or accepted get backtested too.

### 3.5 run_command checks and existing violations

`run_command` checks are not replayed on history (running arbitrary commands at old commits is unsafe and slow): `skipped: run_command`, i.e. untested. Existing violations: once a check row exists (after accept or for any check on the review tick), F calls E2's `LegacyScanService.run(checkId, slug)` from the backtest job and stores the count and scan id on the result row. Drafts during judging do not need it (it is not an admission criterion; the wizard summary shows it after accept).

## 4. Gate 5 in D's pipeline

`PipelineDeps.backtest?: BacktestGate` (optional; D's tests keep working without it). After `runDrafts`, for each admitted checkable lesson with a `draft` result: `assess({lessonId, draft, scope, sources})` →

- `tested {recall, fpRate, ...}`: verifiability part `v = 0.5 · R + 0.5 · N` where `R = min(1, recall / 0.5)` (full at 50 % recall; 0.5 when recall is unknown) and `N = max(0, 1 − 0.5 · fpRate / max(maxFalsePositiveRate, 0.01))` (1 without false positives, 0.5 at the threshold, 0 at twice the threshold; 1 when `hits = 0`). Then:
  - `recall !== null && recall < backtest.minRecall` → shelve `backtest_recall` (new reason).
  - `recall === null && hits === 0` → no evidence either way: untested (below).
  - `fpRate !== null && fpRate > backtest.maxFalsePositiveRate` → shelve `backtest_fp`.
  - otherwise rescore with `verifiability` and use the outcome (it can still be `low_score`).
- `untested {reason}` (no clone, no gh, run_command, no testable material): `backtest.allowUntestedShadow` false → shelve `untested` (new reason); true → admit as shadow without verifiability (D's `cap` part shows it).
- `pending`: unfinished this round (section 3.1).

The verdict note says which number decided ("recall 0 % on 12 comments", "false positives 34 % > 20 %"). The source plan's admission condition (recall > 0 and false-positive rate under the threshold) is exactly the two shelve rules with `minRecall = 0.01`.

## 5. Scores

- **Verifiability** (section 4) is stored in the lesson's `score_parts.verifiability` by the judging batch (D's `stamp`). Lesson filters gain `minVerifiability` / `maxVerifiability` and `untested` (the source plan's "filter by backtest score").
- **Performance** (after launch) is computed per check on the review tick and stored in `check_scores`, never in `lessons` (it changes all the time and would break undo of the accept batch). Inputs, each 0..1 and present only with enough data (`shadow.minHits` fails): adoption `resolved / fails` (capped at 1); precision `1 − falsePositives / fails` using human verdicts on hits; bypass `1 − bypassRate` (enforce only); comment trend from G: `clamp(0.5 + (before.perPr − after.perPr) / before.perPr)`, so `1` when the per-PR rate halved or better, `0.5` when it did not change and `0` when it rose by half (with `before.perPr = 0`: `0.5` when it stayed at zero, else `0`) (only with `after.prs ≥ demote.noReductionPrs` and `before.prs > 0`). Performance = mean of the present inputs; the reason lists them.
- **Composite of a check** = `compositeOf({...lesson parts, verifiability, performance})` with the policy weights (`score.weight.performance` is 0 by default in C; F sets it to 0.2 and scales the other four weights by 0.8 (0.24 / 0.16 / 0.16 / 0.24): the weights still sum to 1 and, because `compositeOf` renormalises over present parts, every lesson score without a performance part is unchanged). Checks without a backtest get the cap `min(score, score.untestedCap)`.
- **Direction test** (acceptance): a test builds checks with high and low composite scores from realistic hit data and asserts high-score checks have higher adoption and lower false-positive rate; plus a property-style test that the composite is monotone in each input.

## 6. Promotion (gate 6)

### 6.1 Review tick

Background job `backtest` with op `review` (dedupe key `review`). On startup F enqueues one if none is queued; when it finishes it enqueues the next with `notBefore = now + 1 h`. Hit ingest also enqueues one (deduped). The tick: enqueue backtests for checks without a current result (3.4), recompute `check_scores`, evaluate promotion and demotion, write the notices, and run the threshold review when due (8.2). Deterministic work only, except the backtest jobs it enqueues.

### 6.2 Conditions

A check row is promoted to `enforce` when all hold (policy resolved at the check's layer):
- `shadow.autoPromote` on; check enabled, mode `shadow`, severity `block` (a `warn` check never blocks, so "enforce" changes nothing);
- a `done` backtest for every repo it applies to that has a clone, none `skipped` (untested checks are never promoted), and the capped composite ≥ `score.admitLine`;
- time in shadow: `distinct PRs touched since modeSince ≥ shadow.minPrs` **or** `days since modeSince ≥ shadow.minDays` (source plan: "≥ N PRs or ≥ N days"). PRs touched = distinct `ticket_prs` of the sessions that produced hits, plus sessions without a PR counted as one each. `modeSince` = time of the latest batch item that changed this check's `mode`, else `checks.created_at`;
- `fails ≥ shadow.minHits` (new key, default 3) since `modeSince`;
- false-positive rate since `modeSince` ≤ `shadow.maxFalsePositiveRate`: human verdicts first; unjudged unresolved fails are sampled to `backtest_judge` like 3.3 (cached per hit id);
- adoption since `modeSince` ≥ `shadow.minAdoption`;
- not flagged `needs_review`.

All checks promoted in one tick form one batch: `recorder.run({kind: "check_promote", origin: "auto", entity: "check", summary: {checks: [...], reasons}})`, which `ChecksService` exposes as `promote(ids, summary)` so the snapshot is rewritten. A `check_promoted` notice (`{batchId, count, names}`) appears on Now with **Undo** and **Open checks**; it stays until undone or dismissed (dismissals are stored in `check_lifecycle`/a setting, not in localStorage). H gets `check.promote`.

## 7. Demotion (gate 7)

### 7.1 Bypass signals (hook)

- **Ignored block:** a `fail` with `blocked = 1` that has no later `resolved` for the same check, file and session by the time the session ended or 24 h passed. Computed in main from `check_hits`; no hook change.
- **Suppression marker** (`how = suppress`): in `runCheck`, for an enforce check whose fingerprint on this file was reported as blocked earlier in this session, if the edit adds a line containing a suppression marker within 2 lines of the violation (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `noqa`, `nolint`, `#[allow(`, `@SuppressWarnings`, `pylint: disable`, `rubocop:disable`, `NOSONAR`, `butler-ignore`), a `bypass` record is written. Checks do not honour these markers; the agent tried to silence instead of fixing.
- **Bash** (`how = no_verify | hooks_off | tamper`): `runPushCheck` already sees every Bash call; a new pure classifier `classifyBypass(command)` in `shared/gate-command.ts` recognises `git commit/push … --no-verify` (and `commit -n`), `core.hooksPath=` overrides, `HUSKY=0`, `SKIP=…`, and commands that write to Butler's checks files or the Claude settings hooks. Such a command is attributed to every check that blocked in this session in the last 30 minutes (the hook state gains `blocked: {checkKey: at}`), one record per check.

Records go to the existing hits JSONL as `{kind: "bypass", …}`; `HitIngest` inserts them into `check_bypasses`. `CheckStats` gains `bypassed` and `ignored`.

### 7.2 Conditions

For an enabled enforce check (policy at its layer, `demote.enabled` on):
- **Bypassed:** `(bypass events + ignored blocks) / blocked fails ≥ demote.maxBypassRate` with at least `demote.minEvents` (new key, default 5) blocked fails since `modeSince`;
- **No reduction:** G's trend for the check's lesson with `after.prs ≥ demote.noReductionPrs`, `before.prs > 0` and `after.perPr ≥ before.perPr`.

Action: `demote.to = shadow` and the check was promoted automatically (its last mode change came from an `origin: auto` batch) → one `check_demote` batch (origin auto) setting `shadow`, plus `check_lifecycle.reason`. A check a person set to enforce, or `demote.to = review` → only `needs_review = 1` with the reason (no mode change; Butler does not override a human's explicit decision). Both write a `check_demoted` notice. The checks page shows the reason under the check ("Demoted to shadow: bypassed 4 of 9 blocks (44 % ≥ 30 %): 3 × --no-verify, 1 × eslint-disable" / "Needs review: similar comments did not drop: 0.8 → 0.9 per PR over 12 PRs") and a **Clear** button for `needs_review`. H gets `check.demote`.

## 8. Calibration and threshold review

### 8.1 Samples

`LessonBatchService.undo` gets an `onUndone(original, restored)` listener. When the undone batch is `check_promote` or `check_demote` (origin auto), F writes one `score_calibration` row per restored check (`entity 'check'`, auto `promote`/`demote`, human `shadow`/`enforce`, the check's score and parts) and clears the lifecycle reason; the notice disappears. A person manually setting a promoted check back to shadow or a demoted one back to enforce within 14 days (via `bulk`) also records a sample (`ChecksService` bulk gets an `onBulk` listener). Lessons: D/C already record samples when a person pulls back a shelved lesson or undoes an admission; F adds the reasons `backtest_fp`, `backtest_recall`, `untested` to what those samples carry (they come from `score_parts`, nothing new to do).

### 8.2 Threshold review

Every `review.intervalDays` (new key, default 7) days, when at least `review.minSamples` (new key, default 10) new samples exist, the tick computes suggestions:
- `score.admitLine`: the line that maximises agreement with human lesson verdicts (D's samples), moved at most 0.05 per review;
- `backtest.maxFalsePositiveRate`: from shelved `backtest_fp` lessons people pulled back (too strict) versus admitted checks later demoted for noise;
- `shadow.minAdoption` / `shadow.maxFalsePositiveRate`: from undone promotions (too loose) and checks people promoted by hand that the rule would have held back (too strict);
- `demote.maxBypassRate`: from undone demotions.

Each suggestion is a `threshold_reviews` row; D's calibration tab gets a "Threshold review" block listing them with **Apply** (writes the global policy layer through `AdmissionPolicyService` in a policy batch, undoable like any policy change) and **Dismiss**. A check calibration block shows agreement for promotions and demotions.

## 9. Interface with G

Agreed with G (stored in memory):

```ts
// src/main/review-effect/stats.ts (G writes, F reads)
lessonCommentTrend(db, q: { lessonId?: number; checkId?: number; since: number; repo?: string; window?: number }): LessonCommentTrend | null
type LessonCommentTrend = { lessonId: number; before: TrendSide; after: TrendSide }
type TrendSide = { prs: number; comments: number; perPr: number | null; byWho: { human: number; copilot: number } }
```

Until G merges, F ships a stub with the same signature returning `null`; whichever merges second aligns.

## 10. Batch metrics (D's `BatchMetricsProvider`)

- **Coverage** = avoidable findings in scope (source comments of lessons in the batch scope that D's analysis marked avoidable) covered by an admitted lesson in this batch or by an existing enabled check / E2 strong coverage, divided by all of them.
- **Overall backtest** = over all drafts admitted in the batch: `sum(comments_matched) / sum(comments)`, total `false_positives`, and `sum(false_positives) / sum(hits)`.
D's batch review compares them with `batch.minCoverage`, `batch.minBacktestRecall`, `batch.maxBacktestFalsePositiveRate` and hides "Accept all" when they are short.

## 11. New policy keys

| Key | Default | Meaning |
|---|---|---|
| `backtest.lineTolerance` | 3 (0–50) | lines between a hit and a comment that still count as the same place |
| `backtest.judgeSample` | 20 (0–200) | unmatched hits sent to `backtest_judge` per check; 0 = off (all unmatched count as false positives) |
| `shadow.minHits` | 3 (0–1000) | fails needed in shadow before promotion is considered |
| `demote.minEvents` | 5 (1–1000) | blocked fails needed before the bypass rate counts |
| `review.intervalDays` | 7 (1–365) | how often thresholds are reviewed |
| `review.minSamples` | 10 (1–1000) | new calibration samples needed for a review |

Plus `score.weight.performance` 0 → 0.2 with the other weights scaled by 0.8 (section 5). New group `review`. All go through the three layers (4.2), the `policies` config-io section and both configuration docs.

## 12. UI

- **Checks page:** per check a backtest line (recall, false positives with an expandable sample list, existing violations, "not backtested: reason"), the composite score with parts, time in shadow and the promotion progress ("3/5 PRs · 2/7 days · adoption 80 % ≥ 60 %"), the demotion / needs-review reason with **Clear**, a **Backtest again** button.
- **Lessons:** verifiability shown with the other parts (D already renders `score_parts`), filters for backtest score.
- **Now:** `check_promoted` / `check_demoted` notices with **Undo** / **Open checks**.
- **Calibration tab:** threshold review and check calibration blocks.
- Every string in English and Chinese.

## 13. Decisions

1. Recall is measured on the file at the reviewed commit, false positives on the merged diff (section 1).
2. Unjudged false-positive candidates count as false positives.
3. `run_command` checks are never replayed on history: untested.
4. Promotion only for `block` checks; `warn` checks stay in shadow (enforce would not change anything).
5. Checks a person put in enforce are flagged, never demoted automatically.
6. Bypass events get their own table.
7. Performance and check composites live in `check_scores`, not on `checks` or `lessons`.
8. No timers: the review tick is a self-rescheduling background job.
9. `score.weight.performance` default 0.2, other weights × 0.8 (same ratios, lesson scores unchanged).

## 14. Windows and macOS

All paths are repo-relative with `/` (diff paths, `normalizePath`); diffs are split on `\r?\n`; `gh` is the resolved binary (`ghBinary()`); nothing spawns a shell. The hook's suppression and Bash classifiers are pure string code. File content from `gh api …/contents` is fetched with `Accept: application/vnd.github.raw` and treated as text (NUL in the first 8 KB → `binary`).

## 15. Tests

Unit: diff parsing and line mapping (CRLF, renames, deleted files, binary); recall and false-positive arithmetic; judge sampling and caching; gate 5 outcomes for every switch (`allowUntestedShadow` on/off, `minRecall`, `maxFalsePositiveRate`, `judgeSample` 0); promotion for every condition and switch (`autoPromote`, `minPrs` or `minDays`, `minHits`, `maxFalsePositiveRate`, `minAdoption`, untested never, warn never); demotion (`demote.enabled`, `maxBypassRate`, `minEvents`, `noReductionPrs`, `demote.to` shadow/review, manual enforce only flagged); undo → calibration sample; threshold review suggestions; hook bypass detection; `classifyBypass`; score direction. E2E: "backtest → shadow → promotion → undo" with fake gh material and fake claude judging.
