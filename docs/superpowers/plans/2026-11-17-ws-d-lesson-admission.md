# Workstream D: lesson admission — implementation plan

Design: `docs/superpowers/specs/2026-11-17-ws-d-lesson-admission-design.md`. Test first for every task; `pnpm typecheck && pnpm lint && pnpm test` after each, `pnpm e2e` after UI / IPC tasks. Every new string in `strings.ts`, `strings-en.ts` (and `main/strings.ts` for main-process text); every setting in both configuration docs.

## Part 1: extraction and fields

1. **Migration.** Append one migration: `lesson_sources` reviewer / path / line / excerpt; `lessons` enriched_at / checkability_reason / shelved_note / principle_id / confirmed_at (backfill confirmed_at for confirmed rows); `lesson_judgments`; `lesson_wizard_runs`; `lesson_wizard_items`; `lesson_wizard_verdicts`; `lesson_principles`; `score_calibration.source`. Test: the migration runs on a 2.x database with lessons and keeps the old rows.
2. **Repo.** `LessonsRepo`: the new fields in `Lesson` / `LessonSource` / `LessonFieldsPatch` (`enrichedAt`, `checkabilityReason`, `shelvedNote`, `principleId`); sources with reviewer / path / line / excerpt in `addSource` / `hit`; `fillSource(id, ...)`; `setScope(id, scope)`; `merge` keeps the earlier `created_at`; `setStatus` stamps `confirmed_at`. Batch adapter for `principle`.
3. **Prompt and schema.** `AnalysisSchema.rule` gets globs / lang / layer / strength / checkability / checkability_reason; prompt text in both languages; `applyAnalysis` writes them (new lessons) or fills empty fields (hits), fills source reviewer / path / line / excerpt from the review items, and marks degraded runs. Runner passes items and route.
4. **Enrichment backfill.** `lessons/enrich.ts`: select lessons needing enrichment, fill sources from `gh` or findings, chunk into `lesson_enrich` calls, validate, write only empty fields, cache in `lesson_judgments`. Unit tests with a fake exec.

## Part 2: gates, scoring, accept

5. **Pure helpers** (`lessons/admission/similarity.ts`, `globs.ts`, `score.ts`): token Jaccard with CJK bigrams, union-find grouping, glob overlap, evidence score, composite, verdict lines. Table tests.
6. **Judgment cache** (`lessons/admission/judgments.ts`): get / put by kind + key + input hash.
7. **Model steps** (`lessons/admission/model-steps.ts`): cluster, conflict, clarity, classify, sample review: prompts (zh / en), zod schemas, batching, cache use, call counting; each returns per-item results or a failure with retry hint.
8. **Pipeline** (`lessons/admission/pipeline.ts`): candidates, buckets, gates 1 to 4, scores, verdicts; `judge()` writes the plan batch and verdict rows; `rejudge(ids)`; `CoverageProvider`, `BatchMetricsProvider` stubs.
9. **Batch review** (`lessons/admission/batch-review.ts`): sample, `batch_reviews` row, shelved shares, floors and weakest metric.
10. **Accept** (`lessons/admission/accept.ts`): promotion, merges, confirm, `ChecksService.saveIn` for drafts; lessons service routes `acceptRecommended` here; undo test.
11. **Policy keys** in `shared/admission-policy.ts` (+ strings + configuration docs); `calibrated` wired to `admissionCalibratedAt`.
12. **Re-judge on category change**: hook from E1's classify action; calibration sample when it overturns the pipeline's category.
13. **Import conflict detector** wired to `lesson_conflict`.
14. **Automatic judging** (`lessonsAutoAdmit`) after analysis runs, debounced per scope.

## Part 3: wizard, calibration, principles, guide

15. **Wizard service** (`lessons/wizard.ts`): estimate, start, state machine, work items with attempts / backoff / waitUntil, resume on start, cancel, recalculate, retry unfinished, call counting, summary. Integration test: start, stop mid-run, new service on the same database resumes and finishes.
16. **IPC**: `lessons:wizard` (estimate, start, state, act), `lessons:calibration` (sample, mark, stats, markCalibrated), `lessons:principles` (regroup). Validation in the IPC whitelist.
17. **UI**: wizard panel (scope, estimate, progress, summary, groups, accept / recalculate / retry); lesson detail with score parts and shelved reason; calibration tab; principles button; settings toggles.
18. **Principles** (`lessons/principles.ts`) and the guide: principle lines, cases file, core guide (≤ 10 most violated), pre-review line behind `preReviewActive()`.
19. **Docs**: configuration docs (settings and policy keys) in both languages.
20. **e2e**: wizard on seeded lessons with the fake claude (summary counts, accept, undo), score parts expand, calibration marks a sample, restart resumes.

Stacked PRs: part 1 → part 2 → part 3.
