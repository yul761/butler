# Workstream I plan: comment-to-fix loop, CI triage and auto rerun

Design: `docs/superpowers/specs/2026-11-17-ws-i-comment-ci-loop-design.md`. Every task is test first; `pnpm typecheck && pnpm lint && pnpm test` after each, `pnpm e2e` after tasks 10–13.

## Stage A: shared pieces

1. **Loop policy** (`src/shared/loop-policy.ts` + test): key table (`comments.*`, `ci.*`) with kinds `bool` / `int` / `enum` / `list`, defaults, `checkLoopValue`, `parseLoopOverrides`, `sanitizeLoopOverrides`, view types. `src/shared/loop.ts`: comment item / triage / effect types.
2. **Migration** (append one entry): `loop_policies`, `pr_comment_items`, `ci_triage`, `ci_flaky_events`, `ci_flaky_list`. Repos with tests: `LoopPoliciesRepo` (layered rows, same shape as admission policies), `CommentItemsRepo`, `CiTriageRepo` (triage rows, flaky events, flaky list).
3. **LoopPolicies service** (`src/main/loop/policies.ts` + test): `LayeredResolver` over the repo; `forSlug(slug)`, `view(scope)`, `set(scope, overrides)`; product names from `lesson_products`.
4. **gh functions** (`tickets/gh.ts` + parse tests): `reviewThreads`, `replyToReviewComment`, `commentOnPr`, `resolveReviewThread`, `rerunFailed`, `runJobs`. Pure parsers exported for tests.
5. **Metrics shim** (`src/main/loop/metrics.ts`): `RecordEvent` type matching contract 4.7, `NO_METRICS`.

## Stage B: CI triage (7.6)

6. **Rules** (`loop/ci-rules.ts` + test): built-in env / code keywords, install-step detection, job-level checks, test-name extraction (vitest / jest / pytest / go / playwright), failure signature, `classifyCiByRule`.
7. **Model call** (`loop/ci-model.ts` + test): `ci_classify` through `execHeadlessJson`, zod schema, bilingual prompt, failure → null.
8. **CiTriage** (`loop/ci-triage.ts` + test): `decide(item, row)` → deliver / deliver+note / hold; async classification, rerun via `ExternalActions.attempt("ci_rerun")`, cap, same signature twice, pass-after-rerun → flaky events, wasted time, auto-list, `recordEvent`. `CiDelivery` gets the optional `triage` dep and the note in the notice (tests in `ci-delivery.test.ts`).

## Stage C: comment loop (7.2)

9. **Rules** (`loop/comment-rules.ts` + test): build items from threads / reviews / PR comments; prefilter order from the design; ignore patterns (substring or `/regex/`).
10. **Model call** (`loop/comment-model.ts` + test): `comment_classify` batched per PR.
11. **CommentLoop** (`loop/comment-loop.ts` + test): `observe(row, pr)` (fetch when needed, in-flight per PR), classify, attribution policy, delivery through guard + `pty.deliver`, verification after push (outdated or compare patch overlap), reply / resolve through `ExternalActions`, two pushes unchanged → human, `recordEvent("comment_auto_handled")`, user actions (send / recategorize / dismiss / reply again), undelivered list for the Now page.
12. **Integration test** (`loop/loop.integration.test.ts`): the three acceptance scenarios with fake gh functions and a fake pty, both platforms.

## Stage D: wiring and UI

13. **index.ts + IPC**: build policies, triage, comment loop; `PrWatcher.onPrRead`; `flushCi` also flushes comments; replace `void externalActions`; IPC `loop:policy:get/set`, `loop:comments:list/act`, `loop:flaky:list/act`, `loop:effect`; preload + api types.
14. **Settings tab "评论与 CI"** (`LoopSettings.tsx`): scoped policy editor, external action shortcuts, flaky list, effect summary. Ticket page "评论" tab. Now page notice `comments_waiting`. Strings zh + en (renderer and main).
15. **Docs**: `docs/configuration.md` + `.zh-CN.md` section for every key and switch.
16. **fake-gh + e2e** (`e2e/comment-loop.spec.ts`, `e2e/ci-triage.spec.ts`, skipped on win32): graphql threads, replies, resolve, run rerun, run view --json, --log-failed, compare.

## Finish

17. Opus review, fixes, `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`, PR, report.
