# Task 11 report
Implemented LessonRunDetail.tsx, pure helpers (runDetailFacts, detailSections, detailButtons, openInClaudeOutcome) in lesson-runs-view.ts, strings (both tables, plus claude_missing/write_failed in lessonsError), wiring LessonsPage -> LessonRuns (panel at the marked spot) and App.tsx onOpenSession -> setRoute butler focusSession.
Deviations: the detail has no queueId, so LessonRuns passes {queueId,status} of the row whose lastRun is the selected run; retry/cancel only show for that run. Attempts are selectable via local viewId state in the detail (not selectedRunId, which LessonRuns prunes). SessionButton needs a SessionView so a plain button is used. findings null cannot be told from trimmed-findings, so the section is just omitted; trimmed note keys off d.trimmed. runDetailFacts takes (d, S) (no now). Open in Claude is hidden for trimmed runs / no material. PR opens via api.prOpen.
RED: pnpm vitest run src/renderer/src/lesson-runs-view.test.ts -> 8 failed | 17 passed (helpers not exported).
GREEN: same file + strings.test.ts pass; full pnpm test 3060 passed; typecheck and eslint clean.

## Fix round 1
1. detailButtons always offers "open"; test updated (trimmed failed -> ["retry","open"]).
2. Lessons show their status pill (new S.lessonRunLessonStatus, both tables, satisfies Record<LessonStatus,string>).
3-4. Duration and started asserted exactly; test renamed.
5. timeText exported and reused.
6. key={selectedRunId} on LessonRunDetail in LessonRuns; error cleared by effect on viewId change; reset effect removed.
7. Attempts list includes the viewed run, stable id-desc order, aria-current + existing "selected" class on the current one (so one can go back to the latest).
8. detailQueue computed before return.
Commands: pnpm typecheck (clean); eslint --ignore-pattern '.claude/**' src e2e hook (clean); vitest lesson-runs-view + strings: 33 passed; pnpm test: 3060 passed | 4 skipped.
