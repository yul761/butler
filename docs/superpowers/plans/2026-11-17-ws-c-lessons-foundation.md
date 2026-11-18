# Workstream C: lessons foundation (implementation plan)

Design: `docs/superpowers/specs/2026-11-17-ws-c-lessons-foundation-design.md`. Every task is test-first: write the failing test, make it pass, then `pnpm typecheck && pnpm lint && pnpm test`.

## Task 1: migration and lesson fields
- Append one migration: new `lessons` columns, `admission_batches`, `admission_batch_items`, `admission_policies`, `batch_reviews`, `score_calibration`; `admission = 'manual'` for decided rows.
- Test (`db/lessons-foundation-migration.test.ts`): a database at the previous version with pending / confirmed / disabled / rejected rows migrates with statuses unchanged, admission `pending` / `manual`, defaults on the new columns; FK and CHECK constraints hold.
- `Lesson` gains the new fields (`scopeGlobs`, `scopeLang`, `scopeLayer`, `strength`, `checkability`, `admission`, `shelvedReason`, `shelvedRef`, `batchId`, `mergedInto`, `score`, `scoreParts`, `scoredAt`, `scorePolicyVersion`, `degraded`, `degradedFrom`); `LessonsRepo` reads them and gets `setAdmission`, `setFields`, `lessons({ includeMerged })`, `resolveMerged`.

## Task 2: lesson filter (shared)
- `src/shared/lesson-filter.ts`: `LessonFilter`, `matchesLessonFilter`, `normalizeLessonFilter`. Tests for each criterion and their combination.

## Task 3: batch recorder and lesson adapter
- `src/main/batches/batch-recorder.ts` (+ `batches-repo.ts`): `run`, `undo`, `list`, `get`; entity adapters.
- Lesson adapter (snapshot row + sources; restore update / insert / delete), product and policy adapters.
- Tests: affected counts only changed rows; zero-change batches are not written; undo restores; undo skips rows changed since; undo twice refused; delete → undo re-inserts with sources; nested in an outer transaction.

## Task 4: bulk lesson actions and single-op reuse
- `src/main/lessons/lesson-batches.ts`: `confirmMany`, `rejectMany`, `disableMany`, `enableMany`, `deleteMany`, `acceptRecommended`, `undoBatch`, `merge`, `edit`; calibration samples.
- `LessonAction` gains `bulk`, `acceptRecommended`, `undoBatch`; `LessonsService` routes the old single ops through it with the same results; `validate.ts` validates the new ops.
- Merge keeps the dropped row (`merged_into`); `select.ts`, `lesson-runner.ts`, `applyAnalysis` ignore / follow merged rows.
- Tests: the existing `lessons-service.test.ts` keeps passing; 581 pending confirmed by filter in one batch and undone; validation of every new op.

## Task 5: layered resolver and admission policies
- `src/main/scope/layered.ts` with tests (key-by-key override, nested objects, arrays replaced, product order, origin map, `forPath`).
- `src/shared/admission-policy.ts` (key table, defaults, validation) and `src/main/lessons/admission-policies.ts` (repo + service, version bump). Tests.
- IPC `policies:get` / `policies:set`; Settings → Admission policy editor.

## Task 6: export / import framework
- `src/main/config-io/format.ts`, `fingerprint.ts`, `registry.ts`, `service.ts`; sections `products`, `lessons`, `policies`; starter packs.
- Tests: version refusal and migration; fingerprints stable; export scopes and contents; no local paths / URLs by default; preview added / changed / conflicting / removed; merge vs replace (backup first, backup failure aborts); resolutions per row and in bulk; imported lessons pending under one undoable batch; unknown sections skipped; detector hook; **integration test: export from one database, import into another, preview, apply, undo**.

## Task 7: backups and reminders
- Settings `configBackupIntervalDays`, `configBackupKeep`, `configExportReminderDays` (normalisers, docs); scheduler tick hook; pruning; status for the page. Tests.

## Task 8: IPC, wiring and UI
- Channels in `shared/ipc.ts`, handlers in `ipc/register.ts`, api in renderer, wiring in `index.ts`.
- Lessons page tabs (Lessons / Batches / Import / export), filter bar, bulk buttons, selection, undo notice, tags; Batches tab; Import / export tab (scope, content, source URLs, starter pack, preview table with per-row and bulk resolution, merge / replace, backups).
- Strings in `strings.ts`, `strings-en.ts`, `src/main/strings.ts`. View-model tests (`lessons-view.test.ts`, new `config-io-view.test.ts`, `policy-view.test.ts`).

## Task 9: docs
- `docs/configuration.md` / `.zh-CN.md`: new settings, admission policy keys, the export file and what it never contains. Same heading outline.

## Task 10: e2e
- `e2e/lessons-bulk.spec.ts`: seed pending lessons, confirm all by filter, undo from the notice and from Batches.
- `e2e/config-io.spec.ts`: export in one sandbox (stubbed save dialog), import in a second sandbox (stubbed open dialog), preview shows the counts, apply, lessons arrive pending.

## Task 11: review and PR
- Opus subagent review, fix, `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`, open the PR.
