# Workstream E2: repo baseline scan, repo profile, legacy scan, lint export (design addendum)

Date: 2026-11-18. Master design: `2026-11-17-butler-3-design.md` (section 6 "Lint export"; contracts 4.1, 4.2, 4.3 `baselines`, 4.5, 4.8). Base: `main` with A (#34 routing), C (#35 lessons foundation) and E1 (#38 checks engine).

Scope: wizard stage 1 (scan what the repo already checks, three layers with fallback), scoring layer 3 (scan confidence), the `repo_baselines` record, the configurable marker table, the uses of the baseline (D's "already covered", reuse of commands for `run_command`, `check_draft` input, "add basic checks first", no automatic checks from low-confidence results), the repo profile for agents (7.8) written into the session guide, the legacy scan (Part 3 item 5) and the lint export (Part 3 item 3, master design section 6), plus the `baselines` export section. Out of scope: the wizard shell and stages 2 and 4 (D), backtest and automatic generation of checks from lessons (F), pre-review (G).

## 1. What was verified in the code

- **Repo paths.** A slug's local clone comes from `lesson_repos.local_path` (registered lesson repos) and, failing that, from any `ticket_repos.repo_path` whose `RepoIdentity.slugOf` is that slug. Nothing else knows where a repo lives. A slug with neither is "not cloned" and its scan is skipped with that reason.
- **Session guide.** `writeSessionGuide(mcpDir, lang, kind, lessons)` (`claude/session-guide.ts`) builds the text passed with `--append-system-prompt-file`; `index.ts` calls it through `guidePath(kind, repoPaths)` when a session launches, and only ticket sessions (ticket and fix) get repo-specific lessons. The profile goes in the same place, for the same kind, after the lessons. The file name carries a content hash whenever the text is repo-specific (today: only when lessons exist), so the hash now covers the profile too. The e2e fake claude logs `guide=<path>` for each interactive launch; the e2e reads that file.
- **Check evaluation.** `evaluateBuiltin(check, content, ctx)` in `src/shared/check-rules.ts` is pure and is what the hook uses for `forbidden_pattern`, `import_boundary` and `comment_policy`. The legacy scan reuses it unchanged, so "in the repo" and "at edit time" agree by construction. `run_command` edit checks run `sh -c` with `{file}` rewritten to `"$1"` and the path in `BUTLER_CHECK_FILE` (`hook/check-run.ts`); generated commands follow the same rules.
- **Workers.** electron-vite 6 bundles `import createX from "./x?nodeWorker"` as a separate worker chunk. Tests inject an in-process runner instead; the real worker path is covered by the e2e test.
- **Model calls.** `execHeadlessJson(deps, { task, label, args, prompt, cwd })` routes by task (4.1). `repo_scan_infer` (mid, fallback) and `check_draft` are registered. `headlessArgs({ schema, allowedTools })` gives a read-only run with `["Read", "Grep", "Glob"]`.
- **Layered config (4.2).** `LayeredResolver` merges `{ key: value }` layers; arrays replace. E1 stores check params as a JSON string for that reason; marker rules do the same.
- **Export / import (4.3).** Sections register in `defaultRegistry()`; `content` decides which exports include them. `ExportOptions` has `includeSourceUrls`; E2 adds `includeBaselines` (default false).
- **Outward actions (4.8).** B's `ExternalActions` (`src/main/external/actions.ts`, PR #33) is not on `main` yet. Its kinds include `pr_open` but no plain branch push. E2 needs `branch_push` and `pr_open`; see section 8.
- **YAML.** `yaml@2.9.1` is already a dependency of the build (tests use it). E2 uses `parseDocument` so pre-commit / ESLint YAML edits keep comments. There is no TOML parser; E2 adds a small one (section 3.3) for the parts it reads.

## 2. Data model (one appended migration)

### `repo_baselines` (one row per scan; history kept, latest wins)

| Column | Meaning |
|---|---|
| `id` | |
| `repo_slug` | `owner/name` (lowercased, `normalizeCheckSlug`) |
| `scanned_at` | when the scan finished |
| `status` | `ok` / `partial` (some layer failed, e.g. the inferred run) / `skipped` (not cloned, unreadable) / `failed` |
| `skip_reason` | `not_cloned`, `unreadable`, `not_git`, `cancelled`, or the error text |
| `origin` | `local` (scanned here) / `imported` (from another machine's export) |
| `projects` | JSON `BaselineProject[]` (section 3.4) |
| `checks` | JSON `BaselineCheck[]` |
| `advice` | JSON `{ missing: BaselineCategory[] }` per project: no lint / no type check |
| `profile` | JSON `RepoProfile` (section 5): the agent-facing summary |
| `inputs` | JSON `{ path, hash }[]`: the files the scan read (repo-relative, `/`), for staleness |
| `listing_hash` | hash of the sorted list of marker-candidate paths (new / removed marker files) |
| `stale_at` | set when the inputs changed since the scan; null = fresh |
| `inferred` | `none` / `ran` / `failed` / `skipped_off` |
| `infer_detail` | failure text or the model's notes |
| `duration_ms` | |

Only the latest 10 rows per slug are kept.

### `baseline_rules` (the marker table overrides, 4.2)

`id, key, scope_kind (global/product/repo), product_id → lesson_products ON DELETE CASCADE, repo_slug, rule (JSON string), enabled, created_at, updated_at`, unique per `(scope_kind, product_id, repo_slug, key)`. The built-in table is the default layer (code data, section 3.1). A row with the key of a built-in rule overrides it field by field at that layer; `enabled = 0` turns it off there; a new key adds a rule.

### `legacy_scans` and `legacy_violations`

`legacy_scans`: `id, check_id → checks ON DELETE CASCADE, check_key, repo_slug, started_at, finished_at, status (running / done / cancelled / failed / truncated), files_total, files_scanned, count, error`. `legacy_violations`: `scan_id → legacy_scans ON DELETE CASCADE, file, line, snippet` (snippet cut to 300 chars, at most 5 000 rows per scan; `count` is the true total). The latest finished scan per `(check_key, repo_slug)` is "legacy N"; older scans of the same pair are deleted when a new one finishes.

### `check_exports`

`id, check_id → checks ON DELETE SET NULL, check_key, repo_slug, target, branch, base, worktree, files (JSON), diff (capped at 200 KB), status (ready / pushed / pr_opened / discarded / failed), detail, pr_url, created_at, updated_at`. Never exported through 4.3 (it holds local paths).

## 3. Stage 1: the scan (no model call, read-only)

Runs in a worker thread (section 9). Input: the repo root and the resolved rule table for the slug. Output: projects, checks, advice, inputs.

### 3.1 The rule table (configurable data)

Two kinds of rules share one table and one key space:

- **`marker`**: `{ key, kind: "marker", lang?, project?: true, files: string[], requires?: { file, contains?, dep? }[], tools: ToolSpec[], install?, facts? }`. `files` are file-name globs relative to a project directory (`eslint.config.*`, `.eslintrc*`, `pyproject.toml`). `project: true` makes the directory a project (package.json, pyproject.toml, setup.py, go.mod, Cargo.toml, pom.xml, build.gradle*, *.csproj / *.sln, Gemfile, composer.json). `requires` narrows a rule ("pyproject.toml containing `[tool.ruff]`", "package.json with the dependency `vitest`"). `ToolSpec = { tool, category, command, fileCommand?, testOne?, exts?, butlerStage? }`, commands use placeholders resolved per project: `{pm}` (npm / pnpm / yarn / bun, from `packageManager` or the lockfile), `{exec}` (npx / pnpm exec / yarn / bunx), `{py}` (`uv run ` / `poetry run ` / `pipenv run ` / empty), `{mvn}` (`./mvnw` when present), `{gradle}` (`./gradlew` when present), `{file}`, `{name}`.
- **`keyword`**: `{ key, kind: "keyword", category, tool, match (regex source), fileCommand? }`. Classifies a command line from CI, a script, a Makefile target, a hook. Rules are tried in order of specificity (`priority`), the generic `\blint\b` / `\btest\b` / `\bbuild\b` last.

The built-in table covers everything the source plan lists: JS/TS (package.json scripts and dependencies, eslint flat and legacy, tsconfig, prettier, biome, oxlint, stylelint, vitest, jest, mocha, playwright), Python (pyproject, setup.cfg, tox.ini, ruff, flake8, mypy, pyright, pylint, black, isort, pytest, bandit), Java / Kotlin (pom.xml with checkstyle / spotbugs / pmd / spotless / surefire, build.gradle(.kts) with checkstyle / spotbugs / detekt / ktlint / spotless, checkstyle.xml, detekt.yml, .editorconfig-ktlint), C# / .NET (*.csproj, *.sln, Directory.Build.props, .editorconfig analyzers, StyleCop / NetAnalyzers, `dotnet format`), Go (go.mod, .golangci.yml / .golangci.yaml / .golangci.toml, staticcheck.conf, govulncheck), Rust (Cargo.toml, clippy.toml, rustfmt.toml, deny.toml), Ruby (Gemfile, .rubocop.yml, .rspec, Rakefile, sorbet, brakeman, bundler-audit), PHP (composer.json scripts, phpstan.neon, psalm.xml, phpcs.xml, .php-cs-fixer.php, phpunit.xml), and the generic ones: Makefile, justfile, .pre-commit-config.yaml, husky (`.husky/*`), lint-staged (package.json key or `.lintstagedrc*`), `.github/workflows/*.yml|yaml`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `.circleci/config.yml`, `bitbucket-pipelines.yml`, `Jenkinsfile`.

Parsing structured files (package.json scripts, Makefile targets, workflow steps, …) is code: an **extractor** per file format, named in the rule (`extract: "package_json" | "makefile" | "justfile" | "pre_commit" | "husky" | "lint_staged" | "github_actions" | "gitlab_ci" | "azure_pipelines" | "circleci" | "bitbucket" | "jenkinsfile" | "tsconfig" | "eslint" | "pyproject" | …`). Which files trigger which extractor, which tool a file means, how commands are classified and what commands to suggest are all data. Users and later versions add tools by adding rules; a rule naming an unknown extractor is shown as invalid and ignored.

### 3.2 Layer 1: marker files (deterministic)

1. List files: `git ls-files --cached --others --exclude-standard -z` (tracked plus new, honours `.gitignore`), falling back to a directory walk (skipping `node_modules`, `.git`, `vendor`, `dist`, `build`, `target`, `.venv`, `venv`, `__pycache__`, `.next`, `out`, `coverage`) when git fails. Paths use `/`. At most 200 000 paths; beyond that the listing is truncated and the scan is `partial`.
2. **Projects**: every directory (depth ≤ 6) containing a file of a `project` rule is a project, keyed by its repo-relative directory (`""` = root). Each file in the listing belongs to the deepest project containing it (monorepo attribution). Generic markers (Makefile, justfile, husky, pre-commit, lint-staged, CI) attach to the directory they are in; CI files always to the root.
3. Each matching rule produces checks for its project from its `tools`; extractors add the explicit ones (scripts, targets, hooks) and the rule facts (section 6.1).

File-name matching is case-insensitive for the marker globs (`Makefile` / `makefile`, `Dockerfile`, Windows checkouts), paths in the output keep their real case.

### 3.3 Layer 2: CI steps (deterministic, language-independent)

Every CI command is split into segments on newlines, `&&`, `||`, `;` (outside quotes), line continuations (`\` and PowerShell backtick) are joined first, `cd <dir> &&` prefixes and `working-directory` / `defaults.run.working-directory` attribute the segment to a project directory. Each segment is classified by the keyword rules into lint / typecheck / test / build / security / format; an unclassified segment is kept as `other` only for the profile's CI list. A segment that runs a script (`pnpm lint`, `npm run test`, `make check`, `just lint`, `tox -e lint`) is resolved through that project's script / target to the real tool, so `pnpm lint` in CI and `"lint": "eslint ."` merge into one check with stage `ci`. GitHub `uses:` steps are classified by action name (golangci-lint-action, codeql-action, super-linter, …).

TOML: a small reader for `[table]`, `[[array]]`, `key = value` with strings, numbers, booleans and (multi-line) arrays, inline tables kept as raw text. That is all pyproject / Cargo / ruff / golangci TOML needs here; anything it cannot read is skipped, not fatal.

### 3.4 The merged result

`BaselineProject = { dir, langs: string[], markers: string[] (rule keys that matched), pm?, runner? }`.

`BaselineCheck = { id, dir, category, tool, command, fileCommand?, testOne?, stages: ("commit" | "push" | "ci")[], changedFiles, butlerStage: "edit" | "push", source: "marker" | "ci" | "inferred", confidence: "high" | "medium" | "low", evidence: string[], facts: string[], exts?: string[] }`.

- Identity is `(dir, category, tool)`; sources merge (a tool configured in a file and run in CI is one check with both evidences).
- **Where it runs** (the plan's "edit time / before push / CI"): `commit` = pre-commit, lint-staged, husky `pre-commit` (the repo's own "while editing / committing" step), `push` = husky `pre-push`, pre-commit `stages: [pre-push]`, `ci` = a CI step. Empty = configured but not wired anywhere (manual). `butlerStage` is where Butler would run it as a check: `edit` when it can take single files and is a lint / format / typecheck tool that works per file, otherwise `push`.
- **Changed files only**: true when the tool takes file arguments (rule `fileCommand`), when pre-commit / lint-staged already pass files to it, or `pre-commit run <id> --files {file}` for pre-commit hooks.
- **Confidence (scoring layer 3)**: `high` = seen in CI or an explicit script / target / hook; `medium` = only a configuration file (the command comes from the rule template); `low` = inferred.
- **Advice**: a project with a language but no `lint` and no `typecheck` check gets `missing: ["lint", "typecheck"]` (only the missing ones); the UI and the wizard summary say "Add basic checks first". This is the talk's "foundation first".

### 3.5 Layer 3: inferred fallback (`repo_scan_infer`, read-only headless claude)

Runs only when the deterministic layers found nothing or clearly too little:

- no project and no classified CI step (unknown language), or
- a project with a language but neither a `test` nor a `lint` check, or
- CI run steps exist but none could be classified.

Setting `baselineInfer` (`auto` default / `off`). The run gets `allowedTools: ["Read", "Grep", "Glob"]`, cwd = the repo root, a prompt with the deterministic findings and the reasons it is asked, and a JSON schema `{ checks: [{ dir, category, tool, command, fileCommand?, changedFiles }], profile: { install, build, testAll, testOne, fastest, lint, typecheck }, notes }`. Results are validated (strings, lengths, categories, dirs that exist in the listing), merged only where nothing deterministic exists, and marked `source: "inferred"`, `confidence: "low"`. A failed or limited run leaves the deterministic result and sets `status: partial`, `inferred: failed`. Automatic rescans (section 5.3) never run the model.

## 4. Uses of the baseline

### 4.1 For D: "already covered by an existing check"

`BaselineService` (main process) exposes:

```ts
latest(slug): RepoBaseline | null
forScope(scope: CheckScope): { slug, baseline: RepoBaseline | null }[]     // product → its repos
checksByCategory(slug, category): BaselineCheck[]
coveredBy(lesson: { scope: LessonScope; text: string; scopeGlobs?: string[] }): BaselineCoverage[]
describeForPrompt(slugs: string[], maxChars?): string                      // compact text for model prompts
```

`BaselineCoverage = { slug, dir, check: BaselineCheck, via: "fact" | "concept", matched: string, strength: "strong" | "weak" }`, strongest first.

- `fact`: the lesson text names a rule the repo enforces (`no-console`, `noImplicitAny`, `F401`, `errcheck`, `clippy::unwrap_used`). Facts come from the configs (section 6.1). Strong.
- `concept`: a small built-in table maps lesson wording (English and Chinese) to facts or categories (unused imports → `no-unused-vars` / `noUnusedLocals` / `F401`; `any` type → `no-explicit-any` / `strict`; formatting / indentation → a `format` check; import order → `import/order` / `isort` / ruff `I`; type errors → a `typecheck` check). Weak when only the category matched.
- Lesson scope globs, when given, must overlap the check's project directory.
- Low-confidence checks are returned with `check.confidence: "low"`; D must not shelve a lesson as covered on a low-confidence check alone (scoring layer 3).

D calls `coveredBy` in its "covered" gate and may add `describeForPrompt` to its `lesson_classify` prompt. The interface is fixed here; D aligns before or after its merge.

### 4.2 Reusing commands for `run_command` checks

`BaselineService.suggestedChecks(slug)` returns, for each baseline check that is a lint / format / typecheck tool, a `CheckInput` draft of type `run_command`: edit stage with `fileCommand` when it takes single files, push stage with `command` otherwise; globs limited to the project directory and the tool's extensions (`packages/web/**/*.{ts,tsx}`); `cd '<dir>' && …` for subdirectory projects (single files through `"$OLDPWD/$BUTLER_CHECK_FILE"`, so the path stays quoted). Drafts are always `shadow`, and each carries `needsConfirm: confidence === "low"`.

`BaselineService.adopt(slug, ids, confirmLow)` creates the chosen drafts in one batch (4.4) at the repo layer. A low-confidence draft is refused unless its id is in `confirmLow`. Callers that create checks without a person choosing them (F's automatic path) use `suggestedChecks(slug).filter(d => !d.needsConfirm)`. That is "low-confidence results do not generate checks automatically".

`check_draft` (E1's `CheckDrafter`) gets the repo's `describeForPrompt([slug])` in its prompt, so a lesson that matches an existing tool becomes a `run_command` check reusing the repo's command instead of a new regex.

### 4.3 The wizard (D) entry points

`scanScope(scope, { infer })` scans every repo in the scope one after another and returns `{ slug, status, reason? }[]`. `summary(scope)` gives the wizard numbers: repos scanned / skipped (with reasons), checks by confidence, repos that should add basic checks first, low-confidence items to confirm. Re-entering the wizard for the same scope rescans only repos whose inputs changed (`force` rescans all).

## 5. Repo profile (7.8)

### 5.1 Content

`RepoProfile = { projects: ProfileProject[], dirs: string[], ci: { category, command }[], pitfalls: string[], generatedAt }` with `ProfileProject = { dir, langs, install, build, testAll, testOne, fastest, lint, typecheck }` (each a command or null, plus `inferred: string[]` naming the fields that came from the model). Install comes from the lockfile / project rule (`pnpm install`, `npm ci`, `uv sync`, `poetry install`, `pip install -r requirements.txt`, `go mod download`, `cargo fetch`, `bundle install`, `composer install`, `{mvn} -q -DskipTests install`, `{gradle} assemble`, `dotnet restore`). "Fastest check" prefers a per-file lint, then a typecheck, then a whole-project lint. `dirs` lists directory conventions detected from the listing (source and test roots, `packages/*`, `apps/*`, `cmd/`, `internal/`, test file naming like `*.test.ts` next to sources or `tests/test_*.py`). `ci` lists the classified CI steps. `pitfalls` are the repo's confirmed lessons (top five, refreshed when the guide is written).

### 5.2 Into the session guide

Ticket sessions (ticket and fix) get one section per repo of the ticket that has a baseline, after the lessons: a heading with the slug and scan date, then one line per known field, monorepo projects by directory. Pitfalls are not repeated when the lessons section is present (they are the same confirmed lessons); otherwise they are listed. Limit: `baselineGuideChars` (default 1200) per repo, 2 × that in total; lines are dropped from the end (CI list first, then dirs, then secondary projects) and a "…" marker is left. A stale baseline adds one line: "config files changed since this scan; check the commands". Commands from the model are marked "(inferred)".

### 5.3 Freshness

- At session launch the guide writer checks the latest baseline's `inputs` (hash of each file read, ≤ 200 files, stops after 150 ms and treats the rest as unchanged); a difference sets `stale_at`.
- A stale baseline is rescanned in the background (deterministic layers only) when `baselineAutoRescan` is on (default `1`), at most once per slug per 10 minutes. A rescan also compares the marker listing, so a new or removed marker file is noticed.
- The baseline tab and the wizard rescan on request; the wizard's incremental pass rescans repos whose inputs or listing changed.

## 6. Facts and the profile inputs

### 6.1 Rule facts

Extractors record the rules a config turns on, as `tool:rule` strings and bare names: tsconfig `compilerOptions` booleans that are true (`strict`, `noImplicitAny`, `noUnusedLocals`, …; comments and trailing commas allowed), ESLint rule names set to `error` / `warn` / `1` / `2` (JSON / YAML read properly, JS configs by a quoted-key regex), ruff `select` / `extend-select`, flake8 `select`, golangci `linters.enable`, Cargo `[lints.*]`, clippy.toml keys, `.rubocop.yml` cops enabled, phpstan `level`. These are hints for 4.1, not a full model of the configs.

## 7. Legacy scan (Part 3 item 5)

- **What**: one check, one repo, the whole working tree (read-only). Files = the same listing as 3.2, filtered by the check's globs / exclude globs, skipping files over 1 MB and binary files (NUL in the first 8 KB). Content split on `\r?\n`, so CRLF files report the same lines.
- **Types**: the three built-ins use `evaluateBuiltin` with the same context as the hook (ticket pattern from the settings). `run_command`: edit-stage commands run per matching file (sequentially, the check's timeout per file, at most `legacyScanMaxFiles`), a failing file is one violation with the output tail as snippet and no line; push-stage commands run once in the repo root and a failure is one violation for the repo. Commands run only because the user pressed "scan" on that check.
- **Where it runs**: a worker thread; the worker posts progress every 200 files. Cancel terminates the worker (status `cancelled`, what was found so far is kept and shown as partial). A watchdog terminates a worker that posts nothing for 20 s (a pathological regex) and records `failed` with the file it was on. Limits: `legacyScanMaxFiles` (default 50 000) → `truncated`.
- **What is stored / shown**: "legacy N" per check and repo on the checks tab with the scan time, a detail list (file, line, snippet; first 500 in the page, all through IPC paging), "scan" / "rescan" / "cancel". The order from the talk is the default stance shown in the UI: put the check in to stop new ones first, then clean up the old ones.
- **For F** (`legacy_violations` of the backtest): `LegacyScanService.latest(checkKey, slug): { count, at, status, scanId } | null`, `violations(scanId, offset, limit)` and `run(checkId, slug): Promise<LegacyScanResult>` (the same scan, awaitable; F may call it during a backtest).

## 8. Lint export (Part 3 item 3, master design section 6)

An explicit per-check action "Write into the repo". It never pushes or opens a PR by itself.

**Target selection from the baseline** (first that applies):

| Check type | Target |
|---|---|
| `forbidden_pattern` | pre-commit config present → a `repo: local` hook with `language: pygrep` (Python regex; JS-only syntax is translated, `(?<n>` → `(?P<n>`, or refused when it uses `\p{…}` / `\u{…}` / sticky flags). Otherwise the script target. |
| `import_boundary` | ESLint present (flat config or JSON / YAML eslintrc) and every `forbid` / `allow` entry is a package specifier (not a repo path) → `no-restricted-imports` with `patterns`, scoped by `files` / `ignores`. Otherwise the script target (which resolves relative imports to repo paths like the hook does). |
| `comment_policy` | script target |
| `run_command` | edit stage: pre-commit `language: system` hook with `pass_filenames` (when `{file}` is the last argument or missing), else lint-staged entry, else a husky `pre-commit` loop over staged files. Push stage: husky `pre-push` line, else pre-commit `stages: [pre-push]`. Nothing to wire into → refused ("the repo has no pre-commit, husky or lint-staged; the command is already the repo's own"). A command already run by the repo's CI → refused ("already in CI"). |

**Script target**: a self-contained checker in the repo's own runtime: `scripts/butler-checks/<name>.mjs` when the repo has Node (a `package.json`), else `scripts/butler_checks/<name>.py` when it is a Python project, else `scripts/butler-checks/<name>.sh` (forbidden patterns only, `git grep -P`). Usage: no arguments = staged files, `--all` = every tracked file, or a list of files; prints `file:line: message`, exits 1 on violations. Wiring (all that apply): pre-commit local hook, lint-staged entry, husky `pre-commit` line, a `butler:<name>` package.json script, a Makefile target `butler-<name>`; when CI runs the project's `lint` script / target, the new one is appended to it so CI runs it too. A Python / shell script with no hook manager and no Makefile is still written, and the summary says how to run it.

**Where it is written**: `git worktree add -b butler/check-<name>-<key6> <BUTLER_HOME>/exports/<id> <base>`, base = `origin/HEAD` (after a quiet `git fetch origin`, 20 s), falling back to the local default branch, then `HEAD`. Edits keep each file's line endings (CRLF stays CRLF); new files use LF; `.sh` and husky hooks get the executable bit through `git update-index --chmod=+x` (works on Windows). Then `git add` and one local commit (`chore: add Butler check "<name>" as a repo rule`) with the repo's identity; if git has no identity the files are left staged and the result says so.

**Hand-off**: the result (stored in `check_exports`) shows the branch, the worktree folder (button to open it), the changed files and the diff. Then it stops. Actions on it: **Push branch** and **Open PR** go through the outward-action switches (4.8, kinds `branch_push` and `pr_open`, default off, logged); **Discard** removes the worktree and deletes the local branch.

**Contract 4.8 alignment**: until B (#33) is on `main`, E2 ships `src/main/baselines/outward.ts` with the structural interface `{ allowed(kind, scope); attempt(kind, detail, run) }` and a stub that is always off and logs each attempt. When B merges, `index.ts` passes B's `ExternalActions` instead and B's registry gains `branch_push` ("push a branch Butler made"). Nothing else changes.

**Not exportable** (shown with the reason): Node / Python needed for `import_boundary` / `comment_policy` and the repo has neither; a regex that cannot be expressed for the target; a check without a repo (global / product check with no cloned repo in scope); no baseline (scan first).

## 9. Workers and both platforms

- One worker entry (`baselines/worker.ts`, bundled with `?nodeWorker`) handles `scan` and `legacy` jobs; the main process only receives results. A job can be cancelled; the worker is created per job and terminated after.
- Paths: everything stored and matched uses `/`; `path.join` only to touch the disk. Marker names match case-insensitively; repo-relative paths keep their case. Commands are run through E1's shell resolution (Git Bash on Windows).
- CRLF: every reader splits on `\r?\n` and strips a BOM; edits keep the file's ending.
- Executable bit: `git update-index --chmod=+x` for generated scripts and husky hooks.
- `git` is run with `GIT_SAFE_ARGS` and `-c core.quotepath=off` (non-ASCII paths).

## 10. Export / import (4.3)

- Section `baseline_rules` (order 45, content `config` and `checks`, so it travels with "everything" and "checks only"): the user rows of the marker table, products by name. Fingerprint = key + layer. Preview: added / changed (rule JSON differs) / unchanged / removed (replace). Imported rules keep the on/off state the file gives them (they are data, not behaviour that touches the agent); a rule that is not valid once merged with the built-in one of the same key is skipped and counted.
- Section `baselines` (order 90, only when "include repo baselines" is ticked; default off): the latest baseline per slug in the export scope **without** local paths, `inputs` or the export history: slug, scanned at, projects, checks, advice, profile (pitfalls dropped: they are lesson text). Import: added when the slug has no local baseline, changed when the incoming one is newer; stored with `origin: imported` and `stale_at` set, so the first local scan replaces it.

## 11. UI

- Lessons page, new tab **"Repo baseline"**: the known repos (registered, in products, with checks) with path status, last scan, status / reason, stale mark, numbers by confidence; "Scan" / "Scan all"; per repo: projects by directory, the checks table (category, tool, command, where it runs, changed files, confidence, source, evidence), the "add basic checks first" advice, "Make a check" per suggestion (low confidence needs a ticked "I checked this command"), and the profile text exactly as sessions get it. A "Marker table" section with a scope picker (global / product / repo): effective rules with their origin, edit (JSON), disable here, add, remove override.
- Checks tab: per check a "Legacy" cell (N, scan time, scan / cancel, detail list) and a "Write into the repo" action (repo choice when the check is not repo-scoped) with the export result and its actions.

## 12. Settings

| Key | Default | Meaning |
|---|---|---|
| `baselineInfer` | `auto` | `auto`: ask the model when the files and CI are not enough; `off`: never |
| `baselineAutoRescan` | `1` | rescan a scanned repo in the background when its config files changed |
| `baselineGuideChars` | `1200` | limit of the repo profile per repo in the session guide (200 to 4000) |
| `legacyScanMaxFiles` | `50000` | files one legacy scan reads at most (100 to 500000) |

All on the baseline tab and in `docs/configuration.md` and its Chinese twin. A user who configures nothing and never presses "scan" sees no change: no baseline means no profile in the guide and no rescans.

## 13. Decisions

1. Stage names: the repo's own stages are `commit` / `push` / `ci`; Butler's suggested stage is `edit` / `push`. The plan's "edit time" maps to the repo's commit-time hooks for "where it runs" and to Butler's edit-time hook for "where Butler would run it".
2. Marker and keyword rules share one layered table; extractors (parsers) stay code and are referenced by name from the data.
3. Confidence: CI / explicit scripts high, config-only medium, inferred low. Low never produces checks without a person confirming each one.
4. The inferred fallback is opt-out (`baselineInfer: auto`) because scans are user-initiated; automatic rescans never call the model.
5. Legacy scan reuses `evaluateBuiltin`; run-command checks are scannable but only on an explicit click.
6. Lint export writes into a Butler-managed worktree under `<BUTLER_HOME>/exports`, commits locally, stops. Push and PR only through 4.8 switches (`branch_push`, `pr_open`).
7. Generated checker scripts are self-contained templates per runtime (Node, Python, shell), not copies of the hook code; their behaviour is tested against the same cases as the hook's rules.
8. The profile in the guide is only for ticket / fix sessions and only for the ticket's repos; pitfalls are not duplicated when the lessons section is present.
9. Staleness is checked cheaply at session launch from stored input hashes; the full listing comparison happens on rescans.
10. Baselines are exported only on request and never with local paths or file hashes.

## 14. Addendum: decisions made while building

11. **One commit-time hook per export.** A check is wired into the first hook manager that applies (pre-commit, then lint-staged, then husky), not into all of them, so it never runs twice per commit. The package.json script and Makefile target are added too, because they are entry points for people and CI, not hooks.
12. **Simple vs compound commands.** A `run_command` whose command is one simple command is written into the hook as is; a compound one (`;`, `&&`, `|`, redirection, subshell) is wrapped in a per-file runner `scripts/butler-checks/<name>.sh`, so the hook manager's own argument passing cannot change its meaning.
13. **pygrep gets `(?a)`.** Python's `\w`, `\d` and `\s` match Unicode by default while JavaScript's do not; the exported pattern is prefixed with `(?a)` so the repo rule matches what the Butler check matched.
14. **ESLint falls back to the script target** when the config already sets `no-restricted-imports`: merging two option lists cannot be done safely by text editing, and overriding the repo's own rule is not acceptable.
15. **The shell target needs `git grep -P`.** The generated script checks for PCRE support first and exits with a clear message when git was built without it.
16. **The Butler commit uses `--no-verify`.** The repo's own hooks may not be installed in the new worktree (or may need tools that are not there); the point of the commit is to hand over a reviewed diff, and the PR's CI runs the hooks for real.
17. **The layout comes from the base commit**, not the user's working copy (`git ls-tree` and `git show <base>:<path>`), so uncommitted local edits never leak into the export and a refusal is decided before anything is created: a refused export leaves no branch, worktree or row.
18. **Outward stub shape.** `stubOutward` matches B's `ExternalActions.attempt(kind, detail, run) → {ran:false,auditId} | {ran:true,value,auditId}`; B's registry lacks `branch_push` and adds it when the two merge.
19. **IPC is grouped by page** (`baselines:act` for scan / cancel / adopt / rule save / rule remove, `legacy:act`, `checkExport:act`) instead of one channel per verb; each action is a validated tagged union.
20. **Baselines are never removed by an import**, even in replace mode: a scan is an observation of a repo, not configuration; a missing row in the file says nothing about the local repo.
21. **The baselines export section uses an `include(options)` hook** on the registry, so it is opt-in per export without a new content kind.
22. **The profile in the guide** is joined over the ticket's repos with a total budget of twice `baselineGuideChars`; a repo whose baseline is stale is marked so in the text and (with `baselineAutoRescan`) rescanned in the background without the model, never delaying the launch.
23. **Legacy scan and export live on the Checks tab** behind one per-check toggle "Existing code / export", with a repo picker defaulting to the repo layer's own slug.

