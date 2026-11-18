# Workstream A plan: model routing and limit fallback

Design: `docs/superpowers/specs/2026-11-17-ws-a-model-routing-design.md`. Every task is test first; `pnpm typecheck && pnpm lint && pnpm test` after each, `pnpm e2e` after tasks 9–12.

## Stage A: routing skeleton

1. **Shared registry** (`src/shared/model-routing.ts` + test): `Tier`, `LimitPolicy`, `TaskId` (all 23 ids), `TASKS` with tier / minTier / policy / critical / legacy, `tierRank`, `effectiveRoute(task, override)`, `isModelName`, config and view types. Test: every id from the master design table exists with its tier and policy; legacy values match today's call sites.
2. **Migration** (append one entry): `model_registry`, `model_chains`, `task_routes`, `limit_rules`, `model_health`, `unrecognized_errors`, `route_events`; `session_usage` + `task`, `requested_tier`, `fallback_from`, `cost_usd`; `lesson_runs` + `requested_tier`, `actual_model`, `fallback_from`; `lesson_queue` + `upgrade_pending`. `RoutingRepo` with tests (CRUD, ordering, prune of events).
3. **Router** (`routing/router.ts` + test): `planTask` → `{ requestedTier, candidates[], wait? }` from config, health snapshot, spend levels; legacy when unconfigured; walk-down / walk-up; session tasks; producer exclusion; interactive `resolveSessionModel`.
4. **Exec layer** (`headless-exec.ts` + test): `task` required; inserts `--model` / `--effort`; fallback retry loop; pre-wait; concurrency cap; records `task`, `requestedTier`, `actualModel`, `fallbackFrom` to `onUsage` and the result. Fake `run` checks argv.
5. **Call sites** (needs-you, stuck-judge, runner full / refresh, feature-runner, epic-digest, lesson-runner): pass task ids, drop hard-coded `--model`, session tasks pass `sessionModel`. Tests: unconfigured argv identical to 2.1.0 (`--model haiku` / `sonnet` / none / session model).
6. **Usage records**: `recordHeadlessUsage` stores the new columns and `cost_usd`; `lesson_runs` stores routing fields.

## Stage B: per-model health and fallback

7. **Rule engine** (`routing/rules.ts` + test): built-ins as data, user / learned / overrides, `field` and `status` rules, reset parsers (built-in + custom named groups), generic signals; `classifyLimit` / `resolveReset` delegate with the active set; all `LIMIT_SAMPLES` unchanged.
8. **ModelHealth** (`routing/health.ts` + test): per-model back-off (shared constants with `ClaudeAvailability`), account-level marking by account label and tier, probing state, success clearing, persistence through `RoutingRepo`, timers.
9. **RoutingService** (+ test): wires repos, health, rules, learning, spend; `onLimit` / `onSuccess` / `onFailure` from exec; lessons gate in configured mode; probe runner; events; `view()` for the UI; actions.

## Stage C: discovery, learning, visibility

10. **Learning** (`routing/learning.ts` + test): fingerprints, correlated signal (3 failures + other success), unrecognised list upsert, confirm → learned rule, dismiss.
11. **Discovery** (`routing/discovery.ts` + test): candidates from env / settings.json / help text, probe each via an injected runner, tier suggestion; capability probe gets optional `--model` / `--effort`.
12. **IPC + UI**: `routing:get`, `routing:act` (validated actions), Settings tabs General / Model routing, `ModelRouting.tsx` with registry, chains, tasks, health, spend, events, unrecognised errors, rules; strings in zh + en; Now page item; e2e for the tab.

## Stage D: quotas and interactive switching

13. **Spend** (`routing/spend.ts` + test): period start by `routingPeriodStartDay`, spend per model / tier / task, money from cost or price, levels; router uses them (acceptance 4).
14. **Interactive**: `StartModel` → string; control parser accepts tiers / names; control handler resolves through the router and returns `model` + `requested`; `SessionModel` string, `storedModel` validation; `--model` dropped when unsupported; session-guide text mentions tiers; session limit → health; session row pill + "switch to next tier" (IPC `sessions:switchModel`), restart with `--resume --model`, continue message; `routingAutoSwitch`.
15. **Settings + docs**: new editable keys validated in settings service; `docs/configuration.md` and `.zh-CN.md` Model routing section.

## Stage E: degraded re-runs and export

16. **Upgrade re-run queue**: lesson runner sets `upgrade_pending` for degraded results; service requeues when the tier recovers; lessons page label; `degradedRunIds()` for D.
17. **Export section** (`config-io/models-section.ts` + test, on C's section registry): export / diff / apply for registry, chains, task routes, limit rules.

## Finish

18. Opus code review, fixes, full verification (`pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`), PR.
