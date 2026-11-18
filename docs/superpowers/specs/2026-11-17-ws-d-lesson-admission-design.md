# Workstream D: lesson quality and automatic admission (design addendum)

Date: 2026-11-17. Master design: `2026-11-17-butler-3-design.md` (uses contracts 4.1, 4.2, 4.3, 4.4, 4.5). Base: `main` after workstreams C (lessons foundation), A (model routing) and E1 (checks engine).

Scope: richer extraction (scope, strength, checkability) and a backfill for existing lessons; admission gates 1 to 4 (dedupe and merge, conflicts, generality, checkability); per-lesson scoring (evidence, clarity, consistency) and batch scoring (sample-review pass rate, shelved-reason shares); the admission policy keys for those; initialization wizard stages 2 and 4 with its state machine, resume and retries; the calibration page and calibration samples; principles with cases (source plan part 1 item 5); the core session guide (part 1 item 6). Out of scope, with interfaces left in place: the repo scan and wizard stage 1 (E2), backtests, verifiability and post-launch scores, batch coverage and overall backtest, shadow promotion (F), pre-review itself (G).

Nothing here changes what a user who never opens the wizard sees: automatic judging after each analysis, principles in the guide and the core guide are all settings that default to off. The extended analysis prompt only fills extra fields.

## 1. What was verified in the code

- **Headless calls support batching and concurrency** (source plan "verify before starting"). `execHeadlessJson` takes one prompt and returns one structured value, so batching is a prompt-level concern: D sends up to 20 to 40 lessons per call and asks for per-item answers. Concurrency: A's router limits concurrent calls per tier (`routing.acquire(tier)`, setting `routingMaxConcurrent`); without routing there is no limit, so D's own work queue runs at most `ADMISSION_CONCURRENCY = 2` calls at once (the same as `LESSON_CONCURRENCY`).
- **Worktree path to repo slug:** `RepoIdentity.slugOf(path)` exists (`lessons/repo-identity.ts`) and is what D uses.
- **The task ids D uses are already registered** (`shared/model-routing.ts`): `lesson_enrich`, `lesson_cluster`, `lesson_conflict`, `lesson_clarity`, `lesson_sample_review` (reviewer: `producer` excludes the producing model and raises the tier; without a second model it flags `sameModelReview`), `lesson_classify`. Check drafts reuse E1's `CheckDrafter` (task `check_draft`).
- **Data C already created:** every `lessons` field D needs (`scope_globs`, `scope_lang`, `scope_layer`, `strength`, `checkability`, `admission`, `shelved_reason`, `shelved_ref`, `batch_id`, `merged_into`, `score`, `score_parts`, `scored_at`, `score_policy_version`, `degraded`, `degraded_from`), `admission_batches` / items, `admission_policies`, `batch_reviews`, `score_calibration`. C already records calibration samples when a human overrides the pipeline (confirming a shelved lesson, rejecting / disabling / deleting an `auto` one, undoing an `auto` batch).
- **Gaps D fills with one appended migration:** sources have no reviewer, file path, line or comment text, so reviewer counts and "the source comments and their paths" are unavailable for old lessons; there is no judgment cache, no wizard state, no principles, and no record of when a lesson was confirmed.
- **Stored material cannot be mapped back to comments**: `lesson_runs.material` shows author and path per comment but not the URL; `lesson_runs.findings_json` has `comment_url` and a summary. The enrichment backfill therefore refetches review data with `gh` (`prLessonDataDetail`, no model call, not a re-analysis) and falls back to the stored findings when `gh` or the clone is missing.
- **`LessonsRepo.merge` keeps the keeper's `created_at`**; D's merge path also takes the earlier `created_at` so "earliest and latest times" both survive.
- **The lessons export never carries source comment text**: the `lessons` section maps source fields explicitly (`prNumber`, `url`, `repo`, `at`), so the new local-only columns stay out of exports (contract 4.3).
- **E1's `ChecksService.save` opens its own batch.** D needs check drafts saved in the same batch as the acceptance, so `ChecksService` gains `saveIn(ctx, ...)` that writes inside a batch the caller already opened; `save` calls it.
- **E1 decision 8** ("a draft is saved only when the user presses save") is about the checks tab. In D a draft is generated during the wizard but written only when the user accepts the summary; the user's accept is the save. Every check written this way is `mode = shadow`.

## 2. Data model (one appended migration)

`lesson_sources` gains `reviewer TEXT`, `path TEXT`, `line INTEGER`, `excerpt TEXT` (the comment text, at most 2,000 characters, local only and never exported). New analyses fill them from the review items by URL; the backfill fills old rows.

`lessons` gains:

| Column | Meaning |
|---|---|
| `enriched_at` | when scope / strength / checkability were last filled (null = never; the backfill picks these) |
| `checkability_reason` | one sentence from the classifier or the drafter |
| `shelved_note` | one sentence on why it is shelved (the conflict reason, the generality numbers, the weakest score part) |
| `principle_id` | → `lesson_principles.id` ON DELETE SET NULL |
| `confirmed_at` | first time it became confirmed (old confirmed rows get `updated_at`) |

New tables:

- `lesson_judgments (kind, key, input_hash, result, model, degraded, at, PRIMARY KEY (kind, key))`: the cache of every model judgment. `kind` is `enrich`, `same` (a pair judged by the cluster call), `canon` (canonical text of a group), `conflict` (a pair), `clarity`, `classify`, `draft`, `sample`. `input_hash` covers whatever the judgment read (texts, globs, category), so an edit invalidates it and a threshold change does not. "Recalculate" reads this cache and calls a model only on a miss.
- `lesson_wizard_runs`: one row per wizard run: scope (`repo` / `product` / `all`), `state`, `detail` (JSON: progress counters, per-stage notes), `policy_version`, `plan_batch`, `accept_batch`, `review_id`, `calls` (background calls this run made, every attempt counted), `created_at`, `updated_at`, `finished_at`, `error`.
- `lesson_wizard_items (run_id, kind, key, status, attempts, not_before, error, PRIMARY KEY (run_id, kind, key))`: resumable work units (`pr`, `enrich`, `cluster`, `conflict`, `clarity`, `classify`, `draft`, `sample`). `running` items return to `queued` on start.
- `lesson_wizard_verdicts (run_id, lesson_id, verdict, reason, ref, score, PRIMARY KEY (run_id, lesson_id))`: the per-lesson conclusion of the latest judging pass (`admit`, `merged`, `shelved`, `covered`, `unfinished`).
- `lesson_principles (id, scope_kind, repo_slug, product_id, text, why, created_at, updated_at, batch_id)` with a batch adapter, so regrouping is undoable.

`score_calibration` gains `source TEXT NOT NULL DEFAULT 'override'` (`override` = a human overturned the pipeline, `review` = judged on the calibration page). The calibration state ("calibrated") is the setting `admissionCalibratedAt`.

## 3. Extraction (source plan part 1 item 2, part 4 stage 2)

- `AnalysisSchema.rule` gains `globs: string[]`, `lang: string | null`, `layer: string | null`, `strength: "must" | "should"`, `checkability: "checkable" | "prose"`, `checkability_reason`. The prompt (both languages) explains each: globs from the commented `path`s, generalised to the directory or file pattern the rule is about (empty = the whole repo); `must` for correctness, security and data-loss issues, `should` for conventions; `checkable` when a deterministic check (forbidden pattern, import boundary, comment policy, command) could catch a violation from the diff alone.
- `applyAnalysis` writes these on new lessons, sets `enriched_at`, and fills only empty fields of an existing lesson on a hit (it never overwrites what a user set). Sources get reviewer, path, line and excerpt from the review item with the same URL. A run produced by a lower tier (`route.degraded`) marks the lessons it created `degraded = 1, degraded_from = route.fallbackFrom`.
- **Backfill (`lesson_enrich`)**: lessons with `enriched_at IS NULL` that are not merged or rejected, 10 per call. Input per lesson: text, why, scope, and up to 5 source comments with reviewer, path and excerpt. Output per lesson: the same fields as above. Before the call, sources missing their comment are filled from `gh` (one `prLessonDataDetail` per distinct PR, cached for the run) or from the stored findings. Confirmed lessons are enriched too, but only empty fields are written: scope metadata is what pre-review (G) filters on, and filling it does not change admission or status.

## 4. The admission pipeline

`AdmissionService.judge(scope, opts)` runs the gates over the **candidates** of a scope: lessons with `status = pending` and `admission ∈ {pending, auto, shelved}`. `admission = manual` rows are never candidates and are never changed, apart from receiving merged sources (section 4.1). Confirmed lessons take part as references for dedupe and conflicts.

Judging does not mutate structure. It writes one **plan batch** (`kind = admission_plan`, `origin = auto`) that sets, per candidate, `admission` (`auto` = recommended, `shelved`, or back to `pending` when unfinished), `shelved_reason`, `shelved_ref`, `shelved_note`, `score`, `score_parts`, `scored_at`, `score_policy_version`. Each row is independent, so undoing the plan batch (or part of it) is always safe. Merges and scope promotion happen in the **accept batch** (section 6), which is atomic. With `admission.autoConfirm` on, the accept runs right after the plan, as `origin = auto`.

### 4.1 Gate 1: dedupe and merge

- **Buckets:** same scope (repo, or product), and for a product scope also every member repo's lessons, so repeated lessons across repos can be found. Inside a bucket two lessons are compared only if their globs overlap (`globsOverlap`: an empty list overlaps everything; otherwise the literal prefixes before the first wildcard must nest and the extensions must agree).
- **Cheap pass:** token Jaccard similarity (`textSimilarity`: lower-cased Latin words and digits plus CJK character bigrams, so Chinese works without word splitting). Pairs at or above `dedupe.minSimilarity` are joined with union-find into candidate groups. Pairs already judged by a model (`same:<a>:<b>` in the cache) skip the threshold either way.
- **Model pass (`lesson_cluster`):** each candidate group (at most `dedupe.maxGroup` lessons per call) is sent with texts and scopes; the model returns the groups that mean the same thing and a canonical wording for each. Every pair in the call is cached as same / different; the canonical text is cached per group.
- **Verdict:** in each confirmed group the keeper is the confirmed member if there is one (its text is kept), otherwise the member with most hits, then the earliest. The others get `verdict = merged` with `shelved_reason = duplicate`, `shelved_ref = keeper` in the plan batch. Gates 2 to 4 judge the keeper **as if merged** (hits summed, sources united, earliest created and latest seen).
- **Product promotion:** when the scope is a product and a group spans two or more repos, the keeper is promoted to the product layer at accept. The summary says "merged into #X (moved to product P)".
- **Accept** performs the merges (`LessonsRepo.merge` plus `created_at = MIN`), in the same atomic batch, so undoing the accept restores both rows, the hits and the sources. Nothing is deleted.

### 4.2 Gate 2: conflicts

- Per bucket, keepers and the confirmed lessons of the same scope go to `lesson_conflict` in chunks of at most `dedupe.maxGroup`. The model returns pairs that are `conflict` or `conditional` with a reason (compatible pairs are omitted, and every pair in the call is cached as compatible unless returned). Pairs whose globs do not overlap are not sent.
- `conflict`: both candidates are shelved with `shelved_reason = conflict`, `shelved_ref` pointing at each other, and the reason in `shelved_note`. A conflict with a confirmed lesson shelves only the candidate; the confirmed one is not touched. With `conflict.autoPickHigherHits` on (default off) the side with more hits is not shelved and the other one is (ties shelve both).
- `conditional` (the two only clash in some situations): not shelved; the consistency score drops to 0.5 with the reason (decision: shelving every conditional clash would hide most rules about the same code; the score and the sample review still see it).
- Consistency score: 1 when nothing was found, 0.5 for a conditional conflict, 0 for a conflict.

### 4.3 Gate 3: generality

- Passes when `hits ≥ generality.minHits` **and** distinct PRs `≥ generality.minPrs` **and** distinct reviewers `≥ generality.minReviewers` (default 0). Reviewers count as a bonus in the evidence score, not as a gate, by default.
- A team habit is one person raising the same thing in several PRs. It passes when `generality.allowSingleReviewer` is on (the default); with it off, a lesson whose sources all come from one reviewer needs two reviewers.
- Fails are shelved with `shelved_reason = generality` and a note with the numbers ("seen 1 time in 1 PR"). They stay pending; as soon as `hits` grows the next judging pass (wizard, recalculate, or automatic judging) re-evaluates them.
- Reviewer and PR counts come from the sources of the as-if-merged lesson. A source without a reviewer (an old one the backfill could not fill) counts as an unknown reviewer: it adds to PRs but not to reviewers.

### 4.4 Gate 4: checkability

- A lesson's category is the one already stored (analysis, backfill or the user); a candidate that passed gates 1 to 3 and still has none is classified by `lesson_classify` (20 per call), which returns the category and a reason.
- `covered` (set by E2's repo scan, or an enabled check already carries this lesson's id): `verdict = covered`, shelved with `shelved_reason = covered`, no draft. The `CoverageProvider` interface (`covered(lesson) → { rule } | null`) is where E2 plugs in "an existing lint rule already catches this"; D's default only looks at checks.
- `checkable`: after scoring, a recommended checkable lesson gets a draft from E1's `CheckDrafter` (cached as `draft:<id>`). If the drafter answers prose, the lesson becomes prose with the drafter's reason and is re-scored against the prose line. Drafts are written at accept as shadow checks linked to the lesson (`checkability = converted`).
- When the user changes the category on the lesson (E1's classify action), `AdmissionService.rejudge([id])` runs gates 3 and 4 and the score again for that lesson under the new category, as a one-lesson plan batch. Gates 1 and 2 do not depend on the category and are not repeated.

## 5. Scoring

### 5.1 Per lesson (layer 1)

All parts are in [0, 1] and carry one sentence of reason (`score_parts.<part> = { value, reason }`), shown expandable on the lesson and in the summary.

- **Evidence:** `(0.6 · min(1, hits / score.evidenceFullHits) + 0.4 · min(1, prs / score.evidenceFullPrs)) · 0.5^(daysSinceLastSeen / score.recencyHalfLifeDays) + min(score.reviewerBonus · (reviewers − 1), 2 · score.reviewerBonus)`, minus `score.degradedPenalty` when a lower tier produced the lesson. Clamped to [0, 1].
- **Clarity (`lesson_clarity`, a separate call, 20 lessons per call):** "following this rule, can you tell whether a piece of code is right or wrong?" → `yes` 1, `partly` 0.5, `no` 0.1, minus 0.2 when the scope is unclear. Lessons produced by a lower tier lose `score.degradedPenalty` more (the source plan asks for stricter clarity on degraded output). A clarity below `score.minClarity` shelves with `shelved_reason = clarity`.
- **Consistency:** section 4.2. A conflict never reaches scoring (it is shelved).
- **Verifiability, post-launch:** empty (F fills them). When present, their weights take part.
- **Composite:** the weighted mean over the parts that have a value (`score.weight.*`, renormalised over those parts). For a checkable lesson with no verifiability the composite stored for the check is capped at `score.untestedCap` and the part `verifiability` says "not backtested: the check stays in shadow mode and cannot be made blocking automatically". The lesson itself is judged on its uncapped composite.
- **Lines:** admit when the composite is at least `score.admitLine` (checkable) or `score.proseAdmitLine` (prose, stricter); between the drop line and the admit line it is shelved with `shelved_reason = low_score` and the weakest part named; below `score.dropLine` it is shelved with `shelved_reason = below_drop` (kept, not rejected, so new hits bring it back).
- Every write stores `scored_at` and `score_policy_version` (the setting `admissionPolicyVersion`). A policy change marks scores stale in the UI; the next judging pass rescores.

### 5.2 Per batch (layer 2)

After a plan batch, a `batch_reviews` row (linked to the plan batch):

- **Sample review (`lesson_sample_review`):** `batch.sampleSize` recommended lessons drawn at random (deterministic seed per run so a resume draws the same sample), 10 per call, routed with `producer` = the model that analysed most of their sources (from `lesson_runs.actual_model`; the router then picks a different model or raises the tier). Per lesson: is it reasonable, does it follow from its source comments, is the scope right; pass = all three. `pass_rate` = passed / reviewed. When the router reports `sameModelReview` the summary says the review was done by the same model.
- **Shelved shares:** shelved / candidates, and the share of each reason.
- **Coverage, overall backtest:** null ("not backtested") until F supplies them through `BatchMetricsProvider`.
- **Floors:** `batch.minSamplePassRate`, `batch.maxShelvedShare`, and (when present) `batch.minCoverage`, `batch.minBacktestRecall`, `batch.maxBacktestFalsePositiveRate`. If any present metric is past its floor, the summary hides "Accept all", says the quality is not good enough to accept as a whole, names the weakest metric (largest relative distance past its floor) and suggests changing the policy or narrowing the scope. Single lessons can still be accepted one by one.

## 6. Accept

`AdmissionService.accept(target)` is what both the wizard's "Accept all" and the lessons page's "Accept all recommended" call (the lessons service routes `acceptRecommended` here). One atomic `accept_recommended` batch (`origin = manual`, or `auto` under `admission.autoConfirm`):

1. promote keepers whose group spans repos to the product layer;
2. merge every `duplicate` lesson into its keeper (canonical text unless the keeper is confirmed);
3. confirm the recommended lessons (admission stays `auto`, as C defined);
4. write the cached check drafts of recommended checkable lessons as shadow checks (`ChecksService.saveIn`), and rewrite the checks snapshot after the batch.

Undoing it restores everything in one go (rows, hits, sources, scopes; the created checks are deleted). Pulling a shelved lesson back is C's single confirm (it records a calibration sample).

## 7. Admission policy keys added

All in `shared/admission-policy.ts` (so they appear in the policy editor, export and import with no extra code), labelled "uncalibrated defaults" until calibration:

| Key | Default | Meaning |
|---|---|---|
| `dedupe.minSimilarity` | 0.35 | text similarity at which two lessons go to the model as possible duplicates |
| `dedupe.maxGroup` | 30 | lessons per cluster or conflict call |
| `generality.allowSingleReviewer` | true | one reviewer raising the same thing in several PRs counts as a team habit |
| `score.evidenceFullHits` | 5 | hits that give full marks for the hit count |
| `score.evidenceFullPrs` | 3 | distinct PRs that give full marks for spread |
| `score.minClarity` | 0.4 | below this the lesson is shelved for clarity |

New group `dedupe`. Existing keys D now reads: `score.*`, `batch.sampleSize`, `batch.min*` / `max*`, `generality.*`, `conflict.autoPickHigherHits`, `admission.autoConfirm`. `AdmissionPolicyView.calibrated` is wired to `admissionCalibratedAt`.

## 8. The wizard (stages 2 and 4, state and errors)

Entry: an "Initialize" button at the top of the lessons page (and a hint when some known repo has never been initialized). Scope: one repo, one product (all its repos) or all known repos. Before it starts the user sees an estimate: merged PRs found (`gh`, at most `BACKFILL_LIMIT` per repo), how many are already analysed, pending lessons, and the expected number of background calls and time (average duration of earlier runs).

States: `scanning` → `extracting` → `generating` → `judging` → `awaiting_accept` → `accepted`; also `cancelled` and `failed` (only for an internal error; model failures never fail the run).

- `scanning` (stage 1, E2): calls `BaselineScanner.scan(slug)` when one is registered; D's default records "repo scan not available yet" and continues.
- `extracting` (stage 2): enqueues the scope's repos through the existing `LessonRunner.backfill` (already analysed PRs are not enqueued again; failed ones are retried, as today), records the queue ids as `pr` items and waits until they are done, skipped or failed (shown as "n/m PRs"). Uncloned repos are skipped with a note. Then the enrichment backfill for the scope's lessons (`enrich` items).
- `generating` (stage 3, F): `BacktestRunner` when registered, otherwise "not backtested". Check drafts are made in `judging`, after scoring, so they are only made for lessons that will be recommended.
- `judging` (stage 4): gates 1 to 4, scores, drafts, plan batch, sample review. Writes verdicts and the summary.
- `awaiting_accept`: the summary. "Accept all" (section 6), shelved groups by reason (expandable, pull back one or a whole group, reject a group), "Recalculate" after changing thresholds (re-judges from the cache, re-analyses nothing), and a list of unfinished items with "retry".
- `accepted`: the accept batch id; the run can still be reopened to look at the summary.

Resume: state and items are in the database. On start `WizardService.resume()` turns `running` items back to `queued` and continues every run that is not `awaiting_accept`, `accepted`, `cancelled` or `failed`. A run waiting on the lessons queue simply waits again (the queue itself resumes, C/A behaviour).

Errors: a failed call marks its item failed and retries it after 1, 5 and 15 minutes (`WIZARD_MAX_ATTEMPTS = 3`). A limit (`wait` policy, `waitUntil`) defers the item without using an attempt. Items still failed after the last attempt make their lessons `unfinished` (left pending, not shelved) and the summary says "K items unfinished" with a retry button. One run per scope at a time; starting a scope that has a live run reopens it. Incremental runs: re-running a scope only analyses new PRs (the queue deduplicates) and, thanks to the cache, only calls models for new or edited lessons.

The summary (stored in `detail.summary`, recomputed on recalculate): PRs analysed, candidate lessons; admitted prose lessons and checks (shadow); merged, shelved by each reason, covered, unfinished; sample-review pass rate; backtest "not backtested"; legacy violations and "no lint" hints from E2 when present; background calls this run made.

## 9. Calibration

A **Calibration** tab on the lessons page:

- Draws a sample of scored lessons: 5 high (≥ admit line), 5 middle, 5 low (≤ drop line), at random, from the selected scope. Each shows its score with expandable parts, its sources and the judgment the pipeline would make. The user marks good / bad / skip; each mark is a `score_calibration` row with `source = review`, `auto_verdict` from the score and the lines, `human_verdict` (`admit` for good, `reject` for bad).
- A comparison table per band (how many marked good) and the agreement rate (good above the admit line, bad below it), over the latest sample and over all samples including the automatic override samples.
- An inline editor for the score weights and lines at the global layer (through `AdmissionPolicyService.setLayer`, so it is an undoable policy batch), and "Mark calibrated", which sets `admissionCalibratedAt`; the policy editor then stops saying "uncalibrated defaults".
- Every later human override is already a sample (C). D adds one more source: changing a lesson's category after the pipeline classified it.

## 10. Principles and the core guide (part 1 items 5 and 6)

- **Principles:** `PrinciplesService.regroup(scope)` sends the confirmed lessons of each scope (repo, product) to `lesson_cluster` in principle mode: groups of at least 3 lessons that share one principle, with the principle's text and why. It runs from a button on the lessons page and, when the setting `lessonsPrinciples` is on, daily from the lessons scheduler job. The result is one undoable batch (principle rows created or updated, `principle_id` set).
- **Guide:** with `lessonsPrinciples` on, lessons that belong to a principle are replaced in the session guide by the principle line ("- [scope] principle (N cases)"); the cases go to a sibling file `lessons-cases-<hash>.md` next to the guide, and the guide tells the session to read it when one of those principles is relevant. "Cases looked up on demand" therefore needs no new tool and works the same on both platforms.
- **Core guide:** with `lessonsCoreGuide` on, the guide keeps at most 10 core lessons: the most violated first (sources that arrived after the lesson was confirmed, plus `fail` hits of checks made from it), then hits. When a pre-review provider reports it is active (G wires `preReviewActive()`; until then it returns false) the guide adds "a pre-review runs automatically before a PR is opened". Without pre-review the line is not written, because it would be false.

## 11. Settings

| Setting | Default | Meaning |
|---|---|---|
| `lessonsAutoAdmit` | off | after each analysis that adds or hits lessons, judge that scope automatically (plan batch, `origin = auto`; recommendations only, unless `admission.autoConfirm`) |
| `lessonsPrinciples` | off | group confirmed lessons into principles daily and put principles into the session guide |
| `lessonsCoreGuide` | off | the session guide keeps at most 10 core lessons |
| `admissionCalibratedAt` | empty | set by "Mark calibrated" (not edited directly) |

## 12. Export and import

The policy keys travel with the `policies` section unchanged. Principles are derived data and are not exported. D wires C's `setLessonConflictDetector`: during an import preview, incoming lessons and local lessons of the same scope go to `lesson_conflict` (one call per scope, cached), and conflicts appear in the preview. A failed call means no semantic conflicts are shown, with a note.

## 13. Acceptance

- On seeded pending lessons (tests, fake model), the summary counts admitted, merged, shelved and each reason; numbers match the verdicts.
- One-click accept is one batch; undoing it restores lessons, merges, scopes and removes created checks.
- Score parts are stored with a reason and can be expanded in the UI (e2e).
- The calibration page records samples (e2e).
- After a restart the wizard resumes where it was (integration test with a fresh service over the same database, and e2e).
- Every model call goes through `execHeadlessJson` with a D task id; no model names in code.

## 14. Decisions made while building

- **Buckets for "all":** products in id order each claim their member repos that no earlier product claimed; repos in no product get their own bucket. A repo is judged in exactly one bucket, so a lesson never gets two verdicts in one pass. A repo-scoped pass also sees the confirmed lessons of its products (as references only).
- **Dedupe inside a product bucket compares across repos** (that is how cross-repo duplicates are found); whether a candidate may merge into a confirmed lesson is checked afterwards: only into a confirmed lesson that applies to all of the candidate's repos. Candidates of a group that cannot merge into a confirmed member form their own group (keeper: a product-layer member first, then most hits, earliest, lowest id).
- **Conflict prefilter:** a pair goes to `lesson_conflict` only when at least one side is a candidate, the globs overlap, the two apply to a common repo, and the texts share at least one token (two rules with no word in common cannot plausibly contradict each other in a way the model could tell from the text alone). Pairs are packed into blocks of `dedupe.maxGroup / 2` lessons; each pair goes to the call for the (block of a, block of b) pair, so every pair is asked exactly once and no call exceeds `dedupe.maxGroup` lessons.
- **autoPickHigherHits:** the surviving side scores consistency 0.5 with the conflict's reason (it did conflict with something), not 1.
- **Coverage interface** matches E2's `BaselineService.coveredBy({ scope, text, scopeGlobs })` (only `strong` coverage shelves; `weak` is ignored) plus an optional `describeForPrompt(slugs, maxChars)` that is passed to `lesson_classify` as "existing checks in this repo". D's own default: an enabled check that carries the lesson id covers it.
- **A lesson stored as `converted` whose check is no longer enabled** is judged as checkable (a new draft is made only if it is recommended).
- **Drafts for recommended lessons use the lesson as stored** (the drafter reads the lesson from the database), so their cache fingerprint is the stored text, not the canonical text of its group.
- **Unfinished:** a lesson whose group, pair block or per-lesson call failed (or was left out of an answer) gets `admission = pending` with the shelved fields cleared in the plan batch, and the verdict `unfinished`; its duplicates keep their `duplicate` verdict only when the cluster call for their group succeeded.
- **Plan rows that would not change anything are skipped** (a second pass over an unchanged cache writes no batch); `scored_at` alone does not count as a change.
- **The accept batch is atomic** (summary `atomic: true`), like C's merge: undo restores all of it or, if something changed since, none of it.
- **Category change by hand:** C/E1's `classifyLesson` notifies D; when the old category came from a classifier (it has a reason), a `score_calibration` row with `entity = 'checkability'`, `auto_verdict` = old category, `human_verdict` = new category is written; a candidate is then re-judged (gates 3, 4, score, draft) as a one-lesson batch `admission_rejudge`.
- **Automatic admission** is debounced per repo (`AUTO_ADMIT_DEBOUNCE_MS = 60 s` after the last analysis that added or hit lessons) and runs one pass per repo at a time. Auto-confirm accepts only that pass's recommendations, and only when the batch review is not past a floor.
- **Import conflicts:** incoming lessons get temporary negative ids in the prompt; the cached judgment's fingerprint includes both texts, so a different file never reads a stale answer. A failed call adds a "semantic conflicts not fully checked" note to the import preview (`ImportPreview.semanticFailed`).
- **Batch review:** shelved shares are over judged candidates (recommended + shelved + covered; merged and unfinished do not count). Floors are evaluated when the review is shown, with the policy in force then, so changing a floor does not need a new sample.
- **Wizard waits for you after the first pass.** It moves to `awaiting_accept` as soon as judging has run once, even with failed items; retries (1, 5, 15 minutes, then manual) run in the background and judge again, updating the summary. The user is not held for up to 21 minutes by one stubborn call. `WIZARD_MAX_ATTEMPTS = 3` retries, so an item is called at most four times automatically; a model limit sets `not_before` to the limit's end without spending an attempt.
- **Enrich failures do not block later stages**: the lessons they left are judged with what they have and the failed items are retried with the rest.
- **Call count:** PRs that were already analysed when the wizard started are counted as finished and cost no calls; a PR analysed during the run counts `max(1, queue attempts)` calls; every other call is counted through the router's `onCall`.
- **Estimate:** merged PRs come from `gh` (`mergedPrs` with the backfill limit; `null` when gh is missing, the repo is not cloned or gh failed); the expected time is the average duration of the last 50 finished analyses times the expected calls (`null` when there are none).
- **A pass that changes nothing writes no plan batch**; its sample review then hangs off the run's previous plan batch (`reviewBatch`), so the summary always has a review.
- **Recalculate** only works while waiting for accept and replays the cached judgments with the current policy: no cluster, conflict, clarity or classify calls (drafts for newly recommended lessons may still be generated).
- **Pull back** confirms shelved lessons through `LessonBatchService.bulk("confirm")`, which records a calibration sample (`auto = shelve`, `human = admit`) for each; **reject group** goes through `bulk("reject")`. Both are their own batches, so undoing the wizard's accept does not undo them.
- **Calibration bands** follow the lesson's own line (prose uses `score.proseAdmitLine`): high is at or above it, low is below `score.dropLine`, the middle band is between. Agreement counts a "should accept" mark on a lesson at or above its line, or a "shouldn't" below it; skips are not counted. Marking a lesson again in the same draw replaces the earlier mark (the draw time is the boundary); "skip" only removes an earlier mark and records nothing. Each draw is seeded with its time (tests pass a fixed seed).
- **Principles:** one cached `lesson_cluster` call (principle mode) per layer (each repo, each product) with at least three confirmed lessons. A principle whose member set is unchanged keeps its row (its text is updated if the model reworded it); groups under three lessons or overlapping an earlier group are dropped; a layer whose call failed keeps its current principles. Nothing changed → no batch.
- **Guide:** a principle line sits where its best-ranked member would have been, and the guide limit is applied after collapsing, so principles free up room. The cases file `lessons-cases-<sha12>.md` lives next to the guide and is pruned with the guides. The core guide ranks by violations after confirmation (sources that arrived after `confirmed_at` plus `fail` hits of checks made from the lesson), then by the normal rank. The pre-review sentence is written only when pre-review is active; G is not merged yet, so it is passed as false.
