# Workstream E2 implementation plan: repo baseline, profile, legacy scan, lint export

Design: `docs/superpowers/specs/2026-11-17-ws-e2-repo-baseline-design.md`. Every task is test first (vitest), then the code, then `pnpm typecheck && pnpm lint && pnpm test`. UI / IPC / session tasks end with `pnpm e2e`.

## Task 1: shared types and the rule table

- `src/shared/baselines.ts`: `BaselineCategory`, `BaselineCheck`, `BaselineProject`, `RepoProfile`, `RepoBaseline`, `BaselineRule` (marker / keyword, zod schema), `BaselineCoverage`, `BaselineDraft`, view types for IPC, `LegacyScanView`, `CheckExportView`.
- `src/main/baselines/rules.ts`: the built-in marker and keyword rules (data), `resolveRules(layers)` validating rules and dropping invalid ones with a reason.
- Tests: every built-in rule validates; keys are unique; an override changes one field; a disabled rule disappears.

## Task 2: readers

- `src/main/baselines/readers/toml.ts` (small TOML subset), `jsonc.ts` (comments, trailing commas), command splitting `commands.ts` (segments, `cd x &&`, continuations, quotes).
- Tests: pyproject / Cargo / ruff / golangci samples; tsconfig with comments; shell lines with `&&`, `;`, quotes, `\` continuations, PowerShell backticks; CRLF input and BOM.

## Task 3: extractors

- `src/main/baselines/extract/*.ts`: package_json (scripts, deps, package manager, lint-staged key), lockfiles, tsconfig facts, eslint facts, pyproject / setup.cfg / tox, makefile, justfile, pre_commit, husky, lint_staged, github_actions, gitlab_ci, azure_pipelines, circleci, bitbucket, jenkinsfile, golangci, cargo, rubocop, phpstan / composer, maven / gradle, dotnet.
- Each returns `{ commands: ExtractedCommand[], facts, deps, ... }` with the file as evidence. Tests per extractor with fixture text (LF and CRLF).

## Task 4: the scanner (layers 1 and 2)

- `src/main/baselines/scan.ts`: `listFiles(root)` (git ls-files, walk fallback), project detection, attribution, rule matching, extractor runs, CI classification through keyword rules, script resolution, merge, confidence, stages, changed-files, advice, profile, inputs and listing hash.
- Fixture repos under `src/main/baselines/__fixtures__/` (written by the tests into temp dirs, not checked-in trees): JS/TS (pnpm, eslint flat, tsconfig strict, vitest, husky + lint-staged, GitHub workflow), Python (pyproject with ruff + mypy + pytest, pre-commit, uv), Go (go.mod, golangci, Makefile, workflow), CI-only unknown language (GitLab CI running `./tools/check.sh` and `make verify`), monorepo (pnpm workspace with `packages/web` TS + `services/api` Python + `tools/cli` Go and a workflow with `working-directory`).
- Tests: each fixture's checks, stages, confidence, attribution, advice and profile; a repo with no lint gets the advice; Windows-style paths and CRLF files.

## Task 5: inferred fallback

- `src/main/baselines/infer.ts`: `needsInference(result)`, prompt builder, zod schema for the model answer, validation and merge as `inferred / low`. Runs through `execHeadlessJson` with task `repo_scan_infer`, read-only tools.
- Tests with a fake runner: called for the unknown-language fixture, not for the JS fixture, `baselineInfer=off` skips it, a failure gives `partial`, bad output is dropped field by field.
- Fake claude: a branch for the `repo_scan_infer` schema (returns one test command and one lint command).

## Task 6: storage, service, staleness, D interface

- Migration: `repo_baselines`, `baseline_rules`, `legacy_scans`, `legacy_violations`, `check_exports`.
- `src/main/baselines/baselines-repo.ts` (rows), `baselines-service.ts`: `localPath(slug)`, `scan(slug, opts)` (skips with reason), `scanScope`, `latest`, `forScope`, `checksByCategory`, `coveredBy`, `describeForPrompt`, `suggestedChecks`, `adopt`, `summary`, `checkStale(slug)`, `rulesFor(slug)` and rule CRUD through `LayeredResolver`.
- Worker: `src/main/baselines/worker.ts` (scan and legacy jobs) with an injectable runner; the main-process side `jobs.ts`.
- Tests: skip reasons (not cloned, unreadable, not git), history trimmed to 10, staleness after a file change, coverage by fact / concept / category, low-confidence drafts refused without confirmation, adopt creates shadow checks in one batch, rule overrides per layer.

## Task 7: profile in the session guide, check_draft input

- `session-guide.ts`: `sessionGuide(lang, kind, lessons, profiles)` with the char limits; `writeSessionGuide` hashes the profile text too.
- `index.ts`: `guidePath` collects the ticket's repo slugs, the latest baselines, schedules stale rescans.
- `CheckDrafter`: prompt gets `describeForPrompt`.
- Tests: guide text contains the commands, limit and "…", stale line, inferred marker, no profile for non-ticket kinds, no duplicated pitfalls.

## Task 8: legacy scan

- `src/main/baselines/legacy.ts` (pure: file filter, per-file evaluation, cap), `legacy-service.ts` (worker job, progress, cancel, watchdog, storage, `latest`, `violations`, `run`).
- Tests: forbidden pattern over a fixture repo (count, lines, CRLF), import boundary, comment policy, run_command per file, cancel, watchdog, truncation, older scans replaced.

## Task 9: lint export

- `src/main/baselines/export/targets.ts` (pick target, reasons), `generate.ts` (scripts per runtime, pre-commit / eslint / lint-staged / husky / package.json / Makefile edits keeping line endings), `exporter.ts` (worktree, branch, commit, diff, record, discard, push / PR through the outward gate), `outward.ts` (4.8 interface and stub).
- Tests: target choice per repo state; generated Node / Python / shell scripts run against fixture files and agree with `evaluateBuiltin`; YAML / JSON edits keep comments and CRLF; the worktree flow on a temp repo (branch, commit, exec bit, diff), discard, push refused while the switch is off and logged.

## Task 10: export / import sections

- `baseline-rules-section.ts` and `baselines-section.ts` in config-io, `includeBaselines` export option.
- Tests: round trip, no local paths in the export, newer wins, imported rows stale.

## Task 11: IPC, settings, UI, strings, docs

- IPC channels `baselines:view|scan|cancel|rules|ruleSave|adopt`, `legacy:scan|cancel|view|violations`, `checkExport:run|act|list`; validators.
- Settings `baselineInfer`, `baselineAutoRescan`, `baselineGuideChars`, `legacyScanMaxFiles` (values, docs pairs).
- Renderer: `BaselinePanel.tsx` (new lessons page tab), legacy and export parts in `ChecksPanel.tsx`, strings zh / en, main strings.
- e2e `e2e/baselines.spec.ts`: scan a fixture repo, see checks and advice, adopt a check; profile in the guide file of a ticket session (fake claude) with the right test command; inferred run on an unknown-language repo; legacy scan count; export to a branch with push refused.

## Task 12: review and PR

- Opus review subagent, address findings, `pnpm typecheck && pnpm lint && pnpm test && pnpm e2e`, PR.
