# Workstream F plan: backtest, promotion, demotion

Design: `docs/superpowers/specs/2026-11-17-ws-f-backtest-promotion-design.md`. TDD: write each task's tests first, watch them fail, implement, then run `pnpm typecheck && pnpm lint && pnpm test` before moving on.

1. **Policy keys.** Add `backtest.lineTolerance`, `backtest.judgeSample`, `shadow.minHits`, `demote.minEvents`, `review.intervalDays`, `review.minSamples` (group `review`); `score.weight.performance` 0.2 and the other weights × 0.8. Policy page strings (en/zh). Tests: defaults, bounds, layer resolution.
2. **Migration.** Add `backtest_prs`, `backtest_comments`, `backtest_files`, `check_backtests`, `check_bypasses`, `check_scores`, `check_lifecycle`, `threshold_reviews`. Test: migrate an empty database and the previous schema.
3. **Diff parsing** (`src/main/backtest/diff.ts`). Parse unified diffs into files, added lines and new-side text. Tests: CRLF, renames, deleted files, binary files, `\ No newline`.
4. **gh helpers.** Add `prDiff`, `reviewCommentCommits` and `fileAt` (raw contents). Tests go through the injected runner, as in the existing gh tests. Extend the fake gh to serve `pr diff`, inline comments with commit ids and `contents?ref=`.
5. **BacktestRepo and evaluation** (`backtest/evaluate.ts`). Pure recall and false-positive arithmetic over the cached material, plus `defHash`. Tests: tolerance, globs, sources matching, `hits = 0`, recall null.
6. **Judge** (`backtest/judge.ts`). Sample unmatched hits with a seed and route them through `backtest_judge` with a zod schema. Cache the answers as JudgmentKind `backtest_fp`. Tests: `judgeSample` 0, caching, failure counts as false positive.
7. **Material prefetch and the background job** (`backtest/material.ts`, `backtest/service.ts`). Ops `prefetch`, `check` and `review`. Save checkpoints, honour abort, retry failed PRs up to 3 times. After a prefetch, call `scheduleAuto(slug)`. Implement the wizard's `BacktestRunner`. Tests use a fake gh and fake queue context.
8. **Gate 5** in D's pipeline (`PipelineDeps.backtest`). Compute the verifiability part, shelve with reasons `backtest_recall`, `backtest_fp` and `untested`, and treat missing material as pending. Strings. Tests cover every switch.
9. **Lesson filter.** Add `minVerifiability`, `maxVerifiability` and `untested`. Tests.
10. **Hook bypass detection.** Add `classifyBypass` in shared/gate-command (tests). Add the suppression-marker check in `runCheck` and the `blocked` map plus bypass records in the hook state (tests). Hit ingest writes `check_bypasses` (tests). `CheckStats` gains `bypassed` and `ignored`.
11. **Scores** (`backtest/scores.ts`). Performance part, check composite with the cap, `check_scores` writes. Tests, including the direction test.
12. **Promotion and demotion** (`backtest/lifecycle.ts`). Compute `modeSince`, the PR and day counts, the shadow false-positive rate (human verdicts plus the judge) and adoption. Write `check_promote` / `check_demote` batches, `check_lifecycle` rows, metrics events and notices. Tests cover every condition and switch.
13. **Undo and calibration.** Add listeners for `LessonBatchService.undo` and `ChecksService.bulk`. Write calibration samples with entity `check`. Tests.
14. **Threshold review** (`backtest/thresholds.ts`). Suggestions, apply through the policy service, dismiss. Tests.
15. **Batch metrics provider** (coverage and overall backtest) wired into D's batch review. Tests.
16. **G stub.** Create `src/main/review-effect/stats.ts` with `lessonCommentTrend` returning null, unless G has merged by then.
17. **Wiring in index.ts.** Register the backtest handler and enqueue the review tick. Wire the E2 coverage and scanner, notices, IPC (`backtest:*`), preload and API types.
18. **UI.** Checks panel (backtest, score, shadow progress, reason, clear, backtest again); Now notices with undo; calibration tab threshold review and check calibration; lessons filter. Strings in en and zh.
19. **Docs.** Add `docs/configuration.md` and `.zh-CN.md` (policy keys).
20. **E2E** `e2e/backtest.spec.ts`. Fake gh material, check draft and judge in fake claude, accept in shadow, ingest hits, review tick promotes, undo from the Now notice. Run `pnpm e2e`.
21. **Opus review**, fixes, then the merge-lock flow.
