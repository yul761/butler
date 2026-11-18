# Workstream E1: deterministic checks engine (design addendum)

Date: 2026-11-17. Master design: `2026-11-17-butler-3-design.md` (contract 4.5; uses 4.1, 4.2, 4.3, 4.4). Base: `main` after workstream C (lessons foundation).

Scope: the `checks` and `check_hits` tables, the four built-in check types, three-layer scoping, the read-only snapshot the hook reads, `butler-hook check` (PostToolUse `Edit|Write|MultiEdit`) and the push-time checks in the Bash PreToolUse gate, shadow mode and the hit log, "checks absent", the checks UI on the lessons page (classification, generate a check from a lesson, manual edit, raw hit numbers), and the `checks` section of export / import. Out of scope (other workstreams): the repo baseline scan and wizard stage 1 (E2), backtest and automatic promotion / demotion (F), pre-review (G). E1 records the data those need and leaves the interfaces.

## 1. What was verified in the code and docs

- **Hook mechanism (Claude Code hook docs).** For `PostToolUse` the tool has already run. Returning JSON on stdout with exit 0 is the reliable channel: top-level `decision: "block"` plus `reason` puts the reason next to the tool result and Claude acts on it; `hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext }` adds context without blocking. Exit code 2 on `PostToolUse` only shows stderr to the model and is not used. For `PreToolUse`, `hookSpecificOutput.permissionDecision: "deny"` with `permissionDecisionReason` blocks the call (the existing merge gate already does this); `additionalContext` is also accepted. Matching hooks of one event run in parallel; a deny from any of them wins. The `timeout` field is in seconds.
- **PostToolUse payload:** `session_id, cwd, hook_event_name, tool_name, tool_input, tool_response, tool_use_id`. `Write`: `tool_input { file_path, content }`. `Edit`: `{ file_path, old_string, new_string, replace_all }`. `MultiEdit`: `{ file_path, edits: [{ old_string, new_string, replace_all }] }`. `tool_response` may carry `originalFile` (the content before the edit); the hook uses it when present and otherwise reconstructs the old content by reversing the edits (section 5.3). Everything is read defensively: any field may be missing.
- **Where the hooks are installed:** `projectMcpApprovalSettings` (`claude/project-mcp.ts`) writes `approve-<sha1 12>.json` with the Bash gate, Skill and Agent groups, only when `gateCommand` is passed. `index.ts` passes it only when `health.hookBinCurrent() && existsSync(paths.hookBin)`. So "hook version mismatch" already means "no hooks at all" for that session; E1 turns that into a visible "checks absent" state (section 7).
- **The settings file is shared by content hash**, so the hook entries are identical for every repo. Everything repo-specific is resolved inside the hook from `cwd` / the file path (as the source plan proposed).
- **Repo identity:** `parseRemoteSlug` and `RepoIdentity.slugOf` in `lessons/repo-identity.ts` (origin remote → `owner/name`). The hook cannot import main-process modules that pull in Electron-only code, so `parseRemoteSlug` moves to `src/shared/repo-slug.ts` (pure) and `repo-identity.ts` re-exports it. The hook runs `git remote get-url origin` itself (2 s timeout) and caches the answer per repo root in its state directory.
- **Push recognition:** `classifyGateCommand` (`shared/gate-command.ts`) returns `push` only when a refspec is written (it is about merges into protected branches). A plain `git push` / `git push -u origin HEAD` is not recognised. E1 adds a separate pure classifier `classifyPush(command)` that reuses the same tokenizer; the merge gate keeps calling `classifyGateCommand` unchanged.
- **Session id:** `sessionEnv` sets `BUTLER_SESSION` to the terminal id, which is the `sessions.id` of the launched row. Hits carry it; `headless:` ids never get these hooks (headless runs have no approval settings).
- **Batches (4.4):** `BatchRecorder` with `tableAdapter`. Deleting a product cascades through foreign keys; `LessonBatchService.deleteProduct` and the config-io products section track dependent rows first. Both now also track the product's checks. `LessonBatchService.undo` gets a hook so restoring checks rewrites the snapshot.
- **Layered resolver (4.2):** `mergeLayers` merges plain objects recursively and replaces arrays / scalars. Check params are therefore carried as a JSON string inside the resolver value, so an override row replaces the params of the broader row instead of merging into them.
- **Export / import (4.3):** `ConfigService` already handles `content: "checks"` and answers `no_checks` while no section with that content is registered. Products are referenced by name in the files (the lessons section does the same).
- **Model calls:** contract 4.1 is not on `main` yet (workstream A). `execHeadlessJson` on `main` takes `{ label, args, prompt, cwd }`. E1 defines `CheckDraftRunner = (req: { task: "check_draft"; label; args; prompt; cwd }) => Promise<HeadlessResult>` and wires it to today's `execHeadlessJson` (dropping `task`). When A merges, the wiring passes `task` through to the router; nothing else changes.
- **Windows:** Claude Code runs hook commands through Git Bash; the e2e fake claude does the same. Node's `spawn("bash")` on Windows may find WSL's `System32\bash.exe` first, so the hook locates Git Bash explicitly (section 5.6).
- **Outward actions (4.8):** E1 has none. It never writes to a repo, never pushes, never posts. Nothing to gate.

## 2. Data model (one appended migration)

### `checks`

| Column | Type / values | Meaning |
|---|---|---|
| `id` | integer PK | |
| `key` | text, not null | stable identity across layers. New checks get `ck_<12 hex>`; an override in a narrower layer copies the key of the check it overrides. Unique per layer. |
| `scope_kind` | `global` / `product` / `repo` | the layer the row lives in (4.2) |
| `product_id` | → `lesson_products.id` ON DELETE CASCADE | for product rows |
| `repo_slug` | text | for repo rows |
| `type` | `forbidden_pattern` / `import_boundary` / `comment_policy` / `run_command` | |
| `name` | text | short label; empty = the type's default name in the UI language |
| `params` | JSON object | type-specific (section 4) |
| `globs` | JSON array | where it applies; empty = every file |
| `exclude_globs` | JSON array | files excluded even if `globs` match |
| `severity` | `block` / `warn` | |
| `mode` | `shadow` / `enforce` | |
| `enabled` | 0 / 1 | an override row with `enabled = 0` turns an inherited check off for that product / repo |
| `message` | text | the root-cause message; empty = the type's default ("fix the root cause, do not work around it") in the UI language |
| `lesson_id` | → `lessons.id` ON DELETE SET NULL | the lesson it was made from |
| `batch_id` | → `admission_batches.id` ON DELETE SET NULL | last batch that changed it |
| `created_at`, `updated_at` | integer | |

The migration seeds one disabled global check: key `builtin:comment_policy`, type `comment_policy`, severity `block`, mode `enforce`, empty name and message (localised at snapshot time). That is "the comment rule is a check type, off by default" (master design §6).

### `check_hits`

| Column | Meaning |
|---|---|
| `id` | |
| `check_id` | → `checks.id` ON DELETE SET NULL (stats survive deleting a check) |
| `check_key` | the key, for rows whose check was deleted and for overrides |
| `repo_slug` | |
| `file` | repo-relative path with `/` separators (push stage: empty) |
| `line` | first line of the violation, if any |
| `stage` | `edit` / `push` |
| `mode` | `shadow` / `enforce` (as it was at the time) |
| `severity` | `block` / `warn` (as it was) |
| `outcome` | `fail` (violation reported), `resolved` (a reported violation disappeared in a later edit = adopted), `timeout` (could not check, allowed), `unavailable` (command could not run, allowed), `error` (the hook failed on this check, allowed) |
| `blocked` | 1 when the agent was actually blocked (enforce + block + fail) |
| `detail` | violation text or command output tail (truncated to 2 000 chars) |
| `session_id` | `BUTLER_SESSION` |
| `verdict` | null / `false_positive` / `true_positive` (set by the user on the checks page; F reads it) |
| `verdict_at` | |
| `at` | when the hook ran |
| `ingest_key` | unique: `<hit file name>#<line>`; makes ingestion idempotent |

### `sessions.checks_absent`

A text column: null = checks were active (or there are no enabled checks at all), otherwise the reason: `hook_outdated` (the installed hook is not the bundled one, so no hooks were installed), `no_snapshot` (the snapshot file is missing or unreadable when the session starts), `snapshot_version` (the hook found a snapshot it does not understand), `disabled` (the user turned checks off). Set on every launch; the hook can set it later through the hit log.

## 3. Layers and the snapshot

**Resolution.** `ChecksService` builds a `LayeredResolver<Record<key, CheckDef>>` (4.2). Each layer's value is `{ [key]: def }` for the rows in that layer; `def.params` is a JSON string (see 1). Global → products (ascending name) → repo; a narrower row with the same key replaces the broader one field by field, so "turn this global check off for this repo" is an override row with `enabled = 0`. Disabled checks are dropped after merging.

**Snapshot file** `<BUTLER_HOME>/checks/snapshot.json`, written with tmp + rename (retrying rename on Windows like the inbox writer):

```json
{
  "v": 1,
  "generatedAt": 1763400000000,
  "enabled": true,
  "editTimeoutMs": 8000,
  "pushTimeoutMs": 600000,
  "ticketPattern": "BTL-\\d+",
  "strings": { "failHeader": "…{name}…{where}…", "shadowTag": "…", "warnTag": "…", "blockFooter": "…", "pushHeader": "…" },
  "global": [ResolvedCheck],
  "repos": { "owner/name": [ResolvedCheck] }
}
```

`ResolvedCheck = { id, key, type, name, params, globs, excludeGlobs, severity, mode, message }` with name and message already localised. `repos` has an entry for every slug Butler knows (registered lesson repos, product members, repo-layer checks); any other repo gets `global`. The hook never merges layers itself.

**When it is rewritten:** at startup; after every checks mutation, batch undo that restored checks, product membership change, import, and change of a check setting or the language; plus a 60 s backstop timer. The writer compares content (ignoring `generatedAt`) and skips identical writes.

**Versioning.** `v` is `CHECKS_SNAPSHOT_VERSION` in `src/shared/checks.ts`; the hook is built from the same constant. A hook that finds a missing file, unparsable JSON or another `v` allows the edit and writes an `absent` record (once per session) so the session row shows it.

## 4. Check types

All built-ins run in the hook process on the file content, line by line, in milliseconds.

- **`forbidden_pattern`** `{ pattern: string, flags?: "i", literal?: boolean }`. A line matches when the regex (or the literal text) occurs in it. The pattern is validated when saved.
- **`import_boundary`** `{ forbid: string[], allow?: string[] }`. Imports are parsed from JS / TS (`import … from`, side-effect `import '…'`, `export … from`, `import(…)`, `require(…)`) and Python (`import a.b`, `from a.b import c`). A relative specifier is resolved against the file's directory to a repo-relative path (no extension guessing). An import violates the check when a `forbid` glob matches the resolved path or the raw specifier (so both `src/main/**` and `electron` / `node:*` work) and no `allow` glob does. The check's own `globs` say which files the boundary applies to; e.g. `globs: ["src/renderer/**"]`, `forbid: ["src/main/**"]`.
- **`comment_policy`** `{ keywords?: string[], ticketPattern?: string }`. Finds comments on each line (`//`, `#`, `/* … */`, `*` continuation lines, `<!-- -->`, `--` for SQL / Lua). A comment that contains a keyword must also contain a ticket reference. Defaults: keywords in English and Chinese (`temporary`, `temporarily`, `for now`, `not optimal`, `suboptimal`, `workaround`, `hack`, `quick fix`, `TODO`, `FIXME`, `XXX`, `暂时`, `临时`, `先这样`, `权宜`, `不是最优`, `以后再`, `待优化`, `凑合`); English keywords match case-insensitively on word boundaries, Chinese ones as substrings. Ticket reference: the general setting `ticketPattern`, or `#123`, or an issue / PR / tracker URL.
- **`run_command`** `{ command: string, stage: "edit" | "push", timeoutMs?: number }`.
  - `edit`: runs once per edit on the changed file only; `{file}` in the command is replaced with the quoted repo-relative path, and if the command has no `{file}` the path is appended. Exit 0 = pass. It shares the edit budget (`checksEditTimeoutSec`, default 8 s, below the hook's own timeout); a command that runs past its share is killed and recorded as `timeout` ("could not check"); the edit is allowed.
  - `push`: runs in the repo root before `git push` (section 6), with `checksPushTimeoutSec` (default 600 s).
  - Exit code 127 / 126 or a shell that cannot start = `unavailable` with the reason; the check is shown as unavailable on the checks page (source plan: "can't run it" must not be silent).

**Messages.** What the agent sees for a failure:

```
Butler check "<name>" failed in <file>:<line>
  <offending line or command output tail>
<message>          ← default: "Fix the root cause. Do not work around this check (no disabling, no renaming, no moving the code to dodge it)."
```

Severity `warn` and every shadow check use the warn header; shadow adds "(trial run: not enforced)".

## 5. `butler-hook check` (PostToolUse `Edit|Write|MultiEdit`)

1. **Read** stdin (2 s), parse. Unknown tool / no `file_path` → exit.
2. **Snapshot.** Missing / unreadable / wrong version → write an `absent` record (debounced per session) and exit. `enabled: false` → exit.
3. **Repo.** Walk up from the file to the directory containing `.git` (a directory, or a file for worktrees). No repo → exit. Slug from the per-root cache or `git -C <root> remote get-url origin` → `parseRemoteSlug`. No origin → allow, no record (source plan: "no remote, let it pass").
4. **Select.** `snapshot.repos[slug] ?? snapshot.global`, `stage` edit, then globs against the repo-relative path (section 5.5).
5. **Evaluate** each built-in against the new content and the old content and keep only violations that are new: a violation is identified by `(check key, normalized line text)` and counted, so a line that already violated before the edit is not reported again (the agent did not introduce it; the legacy scan is E2's).
6. **Debounce** (state file `<BUTLER_HOME>/checks/state/<session>.json`, tmp + rename): per `(check key, file)` the hook remembers the fingerprints it reported. It reports only fingerprints not reported before. A reported fingerprint that is no longer in the file is recorded as `resolved` (adoption). `run_command` remembers a hash of its failing output: the same failure on the next edit of the same file is not re-reported; a pass after a reported failure is `resolved`.
7. **Answer.** Any new failure of an enforce + block check → `{ decision: "block", reason, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }`. Otherwise, any warn / shadow failure → only `additionalContext`. Nothing → no output. Exit code is always 0.
8. **Hit log.** One file per hook run, `<BUTLER_HOME>/checks/hits/<time>-<pid>-<rand>.jsonl`, written with tmp + rename (no concurrent appends, safe on Windows). Butler ingests the directory (watch + 3 s poll), inserts rows with `INSERT OR IGNORE` on `ingest_key`, then deletes the file.

### 5.3 Old content

`tool_response.originalFile` when it is a string. Otherwise: `Write` with `type: "create"` → empty; `Edit` → the new content with `new_string` replaced back by `old_string` (all occurrences when `replace_all`, otherwise the first); `MultiEdit` → the edits reversed in reverse order. If reconstruction fails (the new string is not found), "new violations" falls back to violations on lines that overlap the edited text.

### 5.5 Globs

`src/shared/glob.ts`, no dependency: `**`, `*`, `?`, `[…]`, `{a,b}`. Both the path and the pattern have `\` turned into `/` first, so a check written on Windows matches on macOS and the other way round. A pattern with no `/` matches the file name anywhere (`*.ts`); a pattern ending in `/` means everything under it. Matching is case-sensitive on both platforms (same results everywhere).

### 5.6 Running commands on both platforms

- Shell: macOS / Linux `/bin/sh -c`. Windows: Git Bash, located from `CLAUDE_CODE_GIT_BASH_PATH`, then next to the `git.exe` found on `PATH` (`…\Git\cmd\git.exe` → `…\Git\bin\bash.exe`), then `%ProgramFiles%\Git\bin\bash.exe`. No Git Bash → `unavailable`.
- The command is passed as `sh -c '<command>' butler-check <path>` with `{file}` rewritten to `"$1"`, so the file name is never spliced into the shell text.
- Kill on timeout: POSIX children are started `detached` (own process group) and killed with `kill(-pid, SIGKILL)`; Windows uses `taskkill /PID <pid> /T /F` (this is our own just-started tree, not the orphan scan where `/T` is avoided). Output is capped at 64 KB.

## 6. Push-time checks

A second hook in the `PreToolUse` Bash group: `<hook> check-push`, timeout `checksPushTimeoutSec + 30`. It runs in parallel with the merge gate, whose behaviour does not change. The hook exits at once unless `classifyPush` recognises a real `git push` (not `--dry-run` / `-n`, not a delete-only push). Directory: `git -C`, a preceding `cd` (relative to the payload `cwd`), else `cwd`. It runs the repo's `run_command` checks with `stage: "push"` in the repo root, one after another within the push budget. When a check has globs, it runs only if a file changed between `@{upstream}` (or `origin/HEAD`) and `HEAD` matches; if that range cannot be computed it runs. Enforce + block failure → deny with the reason (message + output tail). Warn / shadow failure → `additionalContext`. Timeout / unavailable → allow and record. Every failure, timeout and unavailable result is logged with `stage: "push"`.

## 7. "Checks absent"

At each launch (ticket, feature, epic and Butler workspace sessions) `SessionService` calls `checksAbsence()` and stores the result in `sessions.checks_absent`:

- no enabled check in any layer → null (nothing to miss; no noise);
- the check setting is off → `disabled`;
- the hook is not installed because it is outdated → `hook_outdated`;
- the snapshot is missing or does not parse → `no_snapshot`;
- otherwise null.

The "event at session start" is a main-process log line (`session <id>: checks absent (<reason>)`) plus the row mark; the renderer refreshes on the usual state change. The hook adds `snapshot_version` / `no_snapshot` later through the hit log. The session button shows a small "no checks" mark with the reason in its tooltip. For pre-review (G): `ChecksService.sessionCoverage(sessionIds)` returns `{ [id]: { absent: reason | null } }` and `ChecksService.hitsForSessions(ids)` returns the raw hits.

## 8. UI (lessons page, new "Checks" tab)

- A scope picker (global, each product, each repo), the effective checks for that scope with their origin layer, and the rows defined in that layer.
- Per check: type, name, globs, severity, mode, enabled, the source lesson, raw numbers from `check_hits` (fails, blocked, resolved, adoption = resolved / fails, timeouts, unavailable, false positives) and the last unavailable reason. A hit list per check where each hit can be marked false positive / true positive.
- Create / edit form for all four types, with validation (bad regex, empty command, …). "Override here" copies an inherited check into the current layer. Bulk: select several → enable, disable, shadow, enforce, delete; every change is one batch (4.4) and shows in the existing "Batches" tab, where it can be undone.
- Lessons list: the checkability tag already exists (C). A lesson row gets "Make a check": it runs `check_draft` and opens the form pre-filled; saving creates the check in **shadow** mode with `lesson_id` and sets the lesson's checkability to `converted` in the same batch. When the model says it cannot be a check, the lesson is set to `prose` (one batch, undoable) and the reason is shown. "Mark as text only" / "Mark as checkable" set the classification by hand.
- Automatic promotion from shadow to enforce is F's; E1 stores everything F needs (hits with mode, outcome, verdict, session).

## 9. Export / import (`checks` section, 4.3)

Section id `checks`, order 40, content `checks`, not in the starter. Item: `{ key, scope: { kind, product?: name, repo?: slug }, type, name, params, globs, excludeGlobs, severity, mode, enabled, message }`. Fingerprint = key + scope. Preview statuses: added, changed (name or message only), conflicting (a behaviour field differs: type, params, globs, excludeGlobs, severity, enabled), unchanged, removed (replace mode). Mode is not compared. Apply writes inside the import batch: a **new** check and a **conflicting** one taken from the file enter shadow mode (a check proven on another machine still has to prove itself here); a cosmetic-only change keeps the local mode; the batch id is stamped on each row. The builtin comment check is exported like any other row, but a replace import never deletes a `builtin:` row. "Checks only" exports also carry the products section, since product-layer checks need their product.

## 10. Settings

| Key | Default | Meaning |
|---|---|---|
| `checksEnabled` | `1` | master switch for edit and push checks |
| `checksEditTimeoutSec` | `8` | budget for one edit's checks (1 to 30). The hook's own timeout is this plus 3 |
| `checksPushTimeoutSec` | `600` | budget for push-time checks (10 to 3600) |

All three are on the checks tab and documented in `docs/configuration.md` and its Chinese twin.

## 11. Decisions

1. Snapshot holds pre-resolved checks per known slug plus `global`; the hook does no layer merging.
2. Override = a full row with the same key in a narrower layer (simple to show and undo; field-level partial overrides were rejected as hard to explain in the UI).
3. Shadow checks show a non-blocking hint to the agent. Without the hint there is nothing to adopt, and F's promotion rule is based on adoption. Shadow never blocks.
4. Only violations introduced by the edit are reported; pre-existing ones are left to E2's legacy scan.
5. One hit-log file per hook run instead of appending to one file: no locking problems on Windows, idempotent ingestion.
6. No "pass" rows in `check_hits`: the log is about hits. Adoption is measured by `resolved`.
7. "Checks absent" is only shown when at least one enabled check exists.
8. `check_draft` produces a draft for the form; nothing is saved without the user pressing save (E1 is the manual path; automatic generation is F's).
9. Imported checks enter shadow mode when they are new or their behaviour changed; a name / message-only change keeps the local mode.
10. When the old content is unknown (no `originalFile`, `Write` of an existing file), the hook cannot tell new violations from old ones. It keeps a per-session `seen` set per `(key, file)` and only reports fingerprints it has not seen in that file before, so the first unknown-before edit reports what is there and later ones only what is new.
11. The check hooks are registered for a session only when `checksEnabled` is on and the installed `butler-hook` is the current build (the same condition as the merge gate). A session started while either is false shows "no checks" with the reason.
12. Snapshot `strings` are fixed to `failHeader` (with `{name}` and `{where}`), `shadowTag`, `warnTag`, `blockFooter` and `pushHeader`, localised at write time, so a language change rewrites the snapshot.
13. A repo-layer scope must be a slug in the shape `parseRemoteSlug` produces (`owner/name` for GitHub, `host/group/…/name` elsewhere; two or more non-empty segments), lowercased at the IPC and import boundaries.
14. Hits are kept for a year (`HIT_RETENTION_MS`), pruned at startup.
15. The checks list in the hook is filtered after the layer merge; push-stage glob filtering uses the files changed between `@{upstream}` (then `origin/HEAD`) and `HEAD`, and runs the check when that cannot be computed.
16. (Review) User regexes (forbidden patterns, ticket patterns) run in a `worker_threads` worker with eval'd self-contained source, terminated after `min(2 s, remaining edit budget)`. On timeout every regex-using check of that edit is recorded as `timeout` and the edit is let through. Rejecting nested quantifiers statically was rejected: too many false rejections, and the worker covers every case.
17. (Review) The hook command carries its budget (`check --budget-ms N`, `check-push --budget-ms N`), and the hook uses `min(snapshot budget, argv budget)`. The hook timeout in a session's settings is fixed at spawn, so raising the setting mid-session cannot make Claude Code kill the hook. On SIGTERM / SIGINT / SIGHUP the hook kills the live command process groups before exiting 0.
18. (Review) `run_command` is decided on the shell's `exit` (then up to 200 ms to drain the pipes), not on `close`, so a background child holding stdout cannot turn a failure into a timeout. Without `{file}`, the file is appended only to a single simple command (no `;`, `&`, `|`, `<`, `>`, parentheses, backticks, `$(` or newline); the file is always in `BUTLER_CHECK_FILE`.
19. (Review) Only a definitive "no origin" (`git remote get-url` exit 2) is cached per session; a timeout or other git failure is retried on the next edit.
20. (Review) The debounce state file is re-read just before the write and only the `(check, file)` keys this run touched are replaced (slugs are unioned), so parallel PostToolUse hooks in one session do not drop each other's entries.
21. (Review) A session that recorded "checks absent" and later gets checked again writes a `present` record; ingest clears the session's mark.
22. (Review) Imported `run_command` checks that are new or whose command text changed are imported **disabled** (shadow still executes the command); the preview label shows the command. A checks-only file (no `lessons` section) never yields `removed` product rows, so replace cannot cascade into products and their lessons.
23. (Review) Comment parsing: shell `$#` / `${#x}` are not comments; backtick template literals carry across lines in C-like files; HTML / XML / SVG / Markdown only use `<!-- -->`. Push-stage `git diff --name-only` runs with `core.quotepath=off` so non-ASCII paths match globs.
