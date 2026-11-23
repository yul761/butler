# Workstream E1: checks engine (implementation plan)

Design: `docs/superpowers/specs/2026-11-17-ws-e1-checks-engine-design.md`. Branch `feat/ws-e1-checks-engine`. Test first for every task; `pnpm typecheck && pnpm lint && pnpm test` after each group, `pnpm e2e` at the end.

## Group 1: pure shared code

1. `src/shared/glob.ts` — `globToRegExp`, `matchGlob(path, pattern)`, `matchAny`. Tests: `**`, `*`, `?`, braces, classes, basename patterns, trailing `/`, backslash paths and patterns give the same results.
2. `src/shared/repo-slug.ts` — move `parseRemoteSlug` out of `lessons/repo-identity.ts` (re-export there). Existing tests keep passing.
3. `src/shared/checks.ts` — types (`CheckType`, `CheckDef`, `ResolvedCheck`, `CheckSnapshot`, `CheckHitRecord`, `CheckAbsenceReason`, views for IPC), `CHECKS_SNAPSHOT_VERSION`, zod-free param validation `validateCheckParams(type, params)`.
4. `src/shared/check-rules.ts` — the built-in evaluators: `forbiddenPattern`, `importBoundary` (JS/TS + Python import parser, relative resolution), `commentPolicy` (comment extraction, en + zh keywords, ticket regex), plus `newViolations(before, after)` and `reconstructBefore(tool, input, after)`. Tests per type, including Chinese keywords and both separators.
5. `src/shared/gate-command.ts` — `classifyPush(command)`. Tests: plain push, `-u origin HEAD`, `git -C dir push`, `cd x && git push`, `--dry-run`, `-n`, `--delete`, `:branch`, non-push commands; `classifyGateCommand` tests unchanged.

## Group 2: data

6. Migration (appended): `checks`, `check_hits`, `sessions.checks_absent`, seeded builtin comment check. Migration test.
7. `src/main/db/checks-repo.ts` — CRUD, layer rows, hits insert (OR IGNORE), stats per check, hits per check / per session, verdict, prune.
8. `checkAdapter` in `batches/table-adapter.ts`; registered in `index.ts`; product adapter dependents include `checks`; `LessonBatchService.deleteProduct` and the config-io products section track product checks; undo hook `onRestored`.

## Group 3: main-process service

9. `src/main/checks/checks-service.ts` — layered resolution (LayeredResolver), `save` / `override` / `bulk` / `delete` through batches, lesson checkability updates, `snapshot()` builder, `sessionCoverage`, `hitsForSessions`, `checksAbsence()`, `view(scope)`.
10. `src/main/checks/snapshot-writer.ts` — atomic write, skip identical content, backstop timer.
11. `src/main/checks/hit-ingest.ts` — read `checks/hits/*.jsonl`, insert, delete; absent records update `sessions.checks_absent`; watch + poll.
12. `src/main/checks/draft.ts` — `check_draft` prompt + JSON schema, `CheckDraftRunner`, parse into a form draft or "prose" with reason.
13. Settings `checksEnabled`, `checksEditTimeoutSec`, `checksPushTimeoutSec` (defaults, editable, docs).

## Group 4: hook

14. `hook/check-run.ts` — command runner: shell selection (sh / Git Bash), `{file}` → `"$1"`, timeout kill (process group / taskkill), 127 → unavailable. Tests with real short commands and a sleeping command on the current platform.
15. `hook/check.ts` — `runCheck(raw, env, deps)`: snapshot, repo root + slug cache, selection, evaluation, debounce state, answer JSON, hit-log file. `runPushCheck(raw, env, deps)`. Tests with temp dirs and git repos.
16. `hook/entry.ts` dispatch `check` / `check-push`.
17. `claude/project-mcp.ts` — add the PostToolUse `Edit|Write|MultiEdit` group and the PreToolUse push entry (timeouts from settings). Test.

## Group 5: wiring and IPC

18. `index.ts`: ChecksService, snapshot writer, ingestion, draft runner, `checksAbsence` dep into `SessionService`, refresh triggers (lessons state changes, config import, settings, language).
19. `SessionService` records `checks_absent` at launch (both launch paths); `sessions-repo` maps it into `Session.checksAbsent`.
20. IPC: `checks:view`, `checks:save`, `checks:bulk`, `checks:hits`, `checks:verdict`, `checks:draft`, `checks:classify` (lesson checkability). Validation in `ipc/validate.ts`, preload, types.
21. config-io `checks` section registered in `defaultRegistry()`; import sets shadow; tests (export, preview, merge, replace, undo).

## Group 6: UI and docs

22. Renderer: "Checks" tab on the lessons page (`ChecksPanel.tsx`, `checks-view.ts` helpers with tests), check form, hit list with verdicts, bulk bar, settings; lesson row actions "Make a check", "Mark as text only", "Mark as checkable"; session button "no checks" mark.
23. Strings zh + en (renderer and main); `docs/configuration.md` + `.zh-CN.md` section "Checks".

## Group 7: e2e

24. fake claude: `/fake-edit <path> <content>` (PostToolUse Write with `originalFile`, prints `blocked: …` / `context: …`), and a `check_draft` answer for `--json-schema` with `checkable`.
25. `e2e/checks.spec.ts`: create a forbidden-pattern check in the UI → in a Shipherd session `/fake-edit` a violating file → the agent sees the root-cause block and `check_hits` has a `fail` row with `blocked = 1`; the same in shadow mode → `context:` only, row with `mode = shadow`, `blocked = 0`; `/fake-run git push` with a failing push check → denied. (Runs on both platforms where the merge-gate e2e pattern allows.)

## Group 8: finish

26. Opus review, fix, `report(progress)`; PR; CI on both platforms; `report(done)`.
