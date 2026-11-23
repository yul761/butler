# BTL-242 Windows perf: plan

Addendum: `docs/superpowers/specs/2026-11-20-btl-242-windows-perf-design.md`. Every task is test-first: write the failing unit test, implement it, then run `pnpm typecheck && pnpm lint && pnpm test`.

1. **Diagnostics core**: `diag/perf-stats.ts` (windows, ring, counters, the `perf:` line, the idle skip, env modes), with tests. Wire it into `index.ts`: count in `safeSend`, time handlers in the `handle` wrapper of `ipc/register.ts`, add the event-loop histogram, and roll the window every 60 s.
2. **Renderer long tasks + export**: `diag:renderer` (send) and `diag:export` / `diag:snapshot` (invoke) in `shared/ipc.ts`; preload; `renderer/src/diag.ts`; the HealthSettings button; zh and en strings; docs. Unit-test the export builder: no transcript content, and the log tail is capped.
3. **Perf scenario**: add `/fake-work` to the fake `claude`, add `e2e/perf.spec.ts` (gated), and record the **before** numbers.
4. **Invalidator + scopes**: `diag/invalidator.ts` (coalescing, max wait, union of scopes, turn flush), with tests. Then `notify(scope)` in `index.ts`, the activity monitor's `notify(kind)`, which skips output-only changes, and `notify("procs")` for memory samples.
5. **Renderer state bus**: `state-bus.ts` (one listener, scope filter), with tests. Then `api.onStateChanged(cb, scopes?)` and `useStateRefetch(key, fetch, scopes?)`, and opt-ins in App and ShipherdPage.
6. **View cache + N+1**: `ViewCache` (generation, TTL, invalidation on writes), with tests; `SessionsRepo.listByTickets`; the `TurnService` input cache.
7. **findTranscript cache**, with tests: hit, gone, then rescan; a miss is not cached.
8. **Conv ingest**: rules only for touched turns, the rule memo, with tests. Pending turns must not be re-read on every ingest while the judge is paused.
9. **Terminals**: the WebGL addon with fallback, `terminal-cache.ts` (LRU 4), `pty:detach`, and subscribed-only `pty:data`, with tests for the cache and for main's subscription filter. Make the PtyManager replay buffer a chunk list, with tests that check the output stays identical.
10. **Sampling**: limit "soon" samples, a 120 s interval on Windows, and the `Add-Type` check in `priority.ts`, with tests.
11. **Logger**: async, buffered, with `flushSync`, and tests for ordering, flush at quit and the size trigger.
12. **Renderer memo work**: animations paused when hidden, the `Composer` split and memo in `ConversationTab`, memo in App, Sidebar and HomePage.
13. **Measure after**, then `pnpm e2e`, the Opus review, and the PR with the numbers.
