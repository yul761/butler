# Shipherd 3: checks, admission, routing and fewer human steps (master design)

Date: 2026-11-17. Base: `main` at 2.1.0 (`0057631`). Target release: **3.0.0**.

This is the master design for the next Shipherd release. It turns the maintainer's improvement plan (a local, unpublished document; the coordinating session and every workstream session read it from the maintainer's machine) into fourteen workstreams with explicit contracts between them. Each workstream writes its own design addendum and plan under `docs/superpowers/specs` and `docs/superpowers/plans` before it writes code, and those addenda may refine anything here that does not change a contract in section 4.

## 1. Intent

Shipherd is a coordination layer today: it remembers, watches PRs and CI, keeps sessions from colliding and keeps the maintainer from waiting. The next release makes it take people out of the loop **without lowering quality**:

- Review comments that could have been avoided go towards zero, because lessons learned from past reviews become **deterministic checks** where possible and pre-review against the rest, instead of an ever-longer prompt.
- Lessons are admitted by an **evidence-based pipeline** (dedupe, conflict detection, generality, checkability, backtest, shadow mode, undo), not by clicking through hundreds of pending items one at a time.
- Every background model call goes through one **router** that picks a capability tier, survives usage limits by falling back or waiting, and works for any company's limits, error texts and model names.
- The human's remaining work shrinks: review comments flow back into sessions, flaky CI is rerun, stacks are rebased, PRs arrive with readiness checks, risk, evidence and a reviewer brief, interruptions that do not need a human disappear, and memory pressure from many sessions is handled without limiting how many run.

**Non-goals (decided by the maintainer):**

- **No automatic merging.** A colleague always reviews; Shipherd never clicks merge for a work PR. Risk and readiness only inform and sort.
- **Shipherd's configuration does not live in the user's repositories** in this release. It stays in Shipherd and moves between machines by export / import. Writing a check into a repo as a lint rule is an explicit, per-check user action that produces a branch for review, never an automatic write.
- **No concurrency limit on sessions or stacks.** Memory pressure is solved by hibernation and priorities, not by WIP caps.

**Anti-goals (failure even if it works):**

- A silent behaviour change for a user who configures nothing. Every new behaviour defaults off or is equivalent to 2.1.0 until configured.
- Any outward-visible action (comment reply, resolve, PR description edit, labels, opening PRs, force push, CI rerun, posting a tracking issue, external push notifications) that happens without its own switch. Every such action has an **independent switch, defaults off, and is logged**.
- Quality claims built on a model grading itself. Evidence must be re-checkable; the independent reviewer is never the same call (and, when configured, never the same model) as the producer.
- A check program that can wedge a session. Any internal error in a hook check is "allow and log".
- Windows-only or macOS-only features. Everything in this release works on both (section 5).

## 2. Approaches considered

1. **One giant branch** implementing everything, merged once. Rejected: unreviewable, no CI signal until the end, and the coordinating session cannot hold it in context.
2. **Strict sequential phases** (the plan's phases 0 to 5 one after another). Correct dependency order but leaves most of the work idle behind the slowest phase; several tracks (routing, dashboard, memory, metrics) have no dependency on the lessons/checks chain.
3. **Chosen: dependency-ordered waves of parallel workstreams**, each a focused PR series from its own git worktree, with the shared contracts below fixed up front so parallel branches meet cleanly. Shared files that everyone touches (`db/migrations.ts`, the string tables, `shared/ipc.ts`, `index.ts` wiring, docs) are resolved by rebasing the later branch; migrations are append-only so a rebase only renumbers its own new entries.

## 3. Workstreams

IDs are used in branch names (`feat/ws-<id>-<slug>`), PR titles and commit scopes.

| ID | Name | Plan sections | Depends on | Wave |
|---|---|---|---|---|
| A | Model routing and limit fallback | Part 6 (stages A to E) | none | 1 |
| B | Coordinator gaps, dashboard, external-action switches | Part 2; switch framework for Part 7 | none | 1 |
| C | Lessons foundation: data model, bulk actions, undo, layered scopes, export / import | Part 4 bulk, export/import, data model; Part 5 stage 0 | none | 1 |
| M | Memory and responsiveness | 7.14 | none | 1 |
| H | Metrics and the effect page | 7.1; 7.4 reason statistics | B (fields), C (for lesson comment stats) | 2 |
| D | Lesson quality and admission | Part 1 items 1.2, 1.5, 1.6; Part 4 gates 1 to 4, scoring layers 1 and 2 (without verifiability), wizard stages 2 and 4, calibration UI; Part 5 stage 1 | A, C | 2 |
| E1 | Deterministic checks engine | Part 3 items 1, 2, 4, 6; hook runtime; shadow mode, hit log, "checks absent"; push-time checks; Part 5 stage 2 | C | 2 |
| I | Comment-to-fix loop and CI triage | 7.2, 7.6 | A, B | 2 |
| E2 | Repo baseline scan, repo profile, legacy scan, lint export | Part 3 items 3, 5; wizard stage 1; 7.8 | A, E1 | 3 |
| K | Stacked PRs and draft management | 7.7, 7.13 | B | 3 |
| L | Cost circuit breaker and idle scheduling | 7.10, 7.11 | A | 3 |
| J | Fewer interruptions and external notifications | 7.4, 7.12 | H | 3 |
| F | Backtest, shadow promotion, auto demotion | Part 4 gates 5 to 7, verifiability and post-launch scores, batch coverage, calibration samples; Part 5 stage 3 | D, E1, E2 | 4 |
| G | Pre-review, evidence, readiness, risk, reviewer brief, review-effect stats | Part 1 items 1.1, 1.3, 1.6 (pre-review note); Part 3 item 7; 7.3, 7.5; Part 5 stage 4 | D, E1, E2 | 4 |
| N | Work intake automation | 7.9 | G, L | 5 |
| R | Integration and release 3.0.0 | docs pairs, configuration docs, version, release | all | 5 |

At most four workstream sessions run at once (the maintainer's machine also runs real work). A wave's later items start as soon as their dependencies merge, not when the whole previous wave is done.

## 4. Contracts between workstreams

These are fixed. A workstream addendum may extend them, not change them.

### 4.1 Model router (provided by A, used by everyone)

- `src/shared/model-routing.ts` defines `Tier = "high" | "mid" | "low"`, `LimitPolicy = "fallback" | "wait" | "escalate"` and a **task registry**: every background task kind has an id, a default tier, a minimum tier, a policy and a `critical` flag. A registers all task ids below up front, including ones whose callers do not exist yet, so later workstreams only import them:

  | Task id | Tier | Policy | Owner |
  |---|---|---|---|
  | `needs_you`, `stuck_judge` | low | fallback | existing |
  | `handoff`, `feature_summary` | session model (no `--model`; fork keeps the cache) | wait | existing |
  | `handoff_refresh`, `epic_digest` | mid | fallback | existing |
  | `lesson_analyze` | mid | fallback | existing |
  | `lesson_enrich` (backfill scope / strength / checkability) | mid | fallback | D |
  | `lesson_cluster` | mid | fallback | D |
  | `lesson_conflict` | high | wait | D |
  | `lesson_clarity` | mid | fallback | D |
  | `lesson_sample_review` (independent reviewer) | ≥ producer, different model when one is configured | wait | D |
  | `lesson_classify` | low | fallback | D |
  | `check_draft` | high | wait | E1 / E2 |
  | `repo_scan_infer` | mid | fallback | E2 |
  | `backtest_judge` | mid | fallback | F |
  | `pre_review` | high | wait | G |
  | `evidence_verify` | high | wait | G |
  | `pr_brief` | mid | fallback | G |
  | `comment_classify` | mid | fallback | I |
  | `ci_classify` | low | fallback | I |
  | `permission_profile` | low | fallback | J |
  | `intake_classify` | mid | fallback | N |
  | `intake_fetch` | low | fallback | N |
  | `model_probe` | low | fallback | A |

- Every headless call passes `task: TaskId` to `execHeadlessJson` (or its successor). The router resolves tier → model chain → first healthy model, adds `--model` only when a mapping exists, and records `requested_tier`, `actual_model`, `fallback_from` on usage and run records. **With no routing configured the router returns today's choice for each call site**, so 2.1.0 behaviour is unchanged.
- Limit classification moves from hard-coded regexes into `limit_rules` data (built-ins seeded from today's `classifyLimit`), plus generic signals and learning from unrecognised errors. Health is per model. Today's `ClaudeAvailability` back-off logic is kept and split per model.
- Interactive sessions: `start_session`'s `model` accepts a tier or a configured model name (old `opus` / `sonnet` values keep working); the router picks and the result tells the coordinator what it got. Mid-session limit shows a "switch to next tier" action; automatic switching only when the user turns on the setting.
- No new workstream hard-codes a model name.

### 4.2 Layered scopes (provided by C)

`src/main/scope/layered.ts`: one resolver for anything configured at **global → product → repo** (repo slug `owner/name`, products from `lesson_products`). Later layers override earlier ones key by key. Admission policies (C/D), checks (E1), readiness conditions (G), cost caps (L) and permission profiles (J) all use it. Repo identity reuses `lessons/repo-identity.ts` (remote → slug).

### 4.3 Export / import (provided by C)

`src/main/config-io/`: a versioned single JSON file (`formatVersion`, `exportedAt`, `scope`) assembled from **registered sections**. Each section supplies `export(scope)`, `preview(incoming)` (added / changed / conflicting by content fingerprint) and `apply(incoming, mode: "merge" | "replace")`. C ships the framework and the sections `products`, `lessons`, `policies`. E1 registers `checks`, A registers `models` (registry, chains, task routes, limit rules), J registers `permissions`, E2 registers optional `baselines`. Whichever of A and C merges second wires A's section. Replace always writes an automatic backup export first. Imported items enter pending / shadow mode under a new batch id. Exports never contain secrets, local paths or comment text unless the user ticks "include source URLs".

### 4.4 Batches and undo (provided by C)

Every bulk or automatic change to lessons or checks creates an `admission_batches` row with a before-state snapshot; "undo batch" restores it. Bulk actions take either an id list or a filter and run in one transaction. The old single-id `LessonAction`s stay and reuse the bulk path internally.

### 4.5 Check definitions and the hook runtime (provided by E1)

- `checks` table and a **read-only snapshot file** that Shipherd rewrites whenever checks or policies change (the hook never opens SQLite). Types: `forbidden_pattern`, `import_boundary`, `comment_policy`, `run_command`. Each has scope globs, severity (`block` / `warn`), mode (`shadow` / `enforce`), a root-cause message ("fix the root cause, do not work around it").
- `shipherd-hook check` handles `PostToolUse` for `Edit|Write|MultiEdit` (added to the per-session settings in `claude/project-mcp.ts` next to the existing gates). Built-in types run in-process in milliseconds; `run_command` runs on changed files only, inside the hook timeout; a timeout is "could not check": allow and log. Every hit appends one line to a hit log Shipherd ingests (`check_hits`: check id, file, mode, outcome, session, time).
- Push-time heavy checks run from the existing Bash `PreToolUse` gate when it recognises `git push`.
- A session started without checks (hook version mismatch, no snapshot) records a "no checks" event that the session row shows and pre-review (G) reads.

### 4.6 Evidence, readiness and risk (provided by G)

`pr_evidence`, `pr_readiness`, `pr_risk`, `pr_briefs` keyed by `ticket_prs.id`. Risk is computed **deterministically** from paths, size, check results, pre-review result and ticket type. Readiness conditions are configurable through 4.2. H, J, K and N read these tables; they do not compute their own.

### 4.7 Metrics events (provided by H)

`src/main/metrics/` records human interventions (terminal input to a session, needs-you answers, manual merges, manual triggers) and waiting time, and rolls everything into `metrics_daily`. Other workstreams record their own events through H's `recordEvent(kind, refs)` rather than adding counters. Shipherd-made PRs are tagged so they are measured separately from other PRs.

### 4.8 External actions (provided by B)

`src/main/external/actions.ts`: a registry of outward-visible action kinds, each with its own setting (default off), `allowed(kind, scope)` and `record(kind, detail)` into the audit log (`audit-repo`). Every workstream that replies, resolves, edits PRs, labels, opens PRs, force-pushes, reruns CI, posts issues or sends notifications goes through it.

### 4.9 Common rules

- Append-only migrations; on rebase, renumber only your own new entries.
- Every user-facing string in both languages (`src/renderer/src/strings.ts`, `strings-en.ts`, `src/main/strings.ts`). Every editable setting documented in `docs/configuration.md` and its Chinese twin (a test enforces it).
- No network access outside `src/main/gateway`. `gh` and `git` subprocesses are allowed as today.
- Tests never call a real `claude` or LLM and never touch real `~/.shipherd` or `~/.claude`.
- No company, colleague or project names from the maintainer's work in code, tests, docs or PR text: this repository is public.
- Every background model call goes through the router (4.1); every outward action through 4.8; every layered setting through 4.2.

## 5. Cross-platform decisions

The source plan was written on Windows. Purpose first, then both platforms:

| Plan item | Purpose | Windows | macOS |
|---|---|---|---|
| Lower priority for idle sessions (7.14 E) | keep the UI and the active session responsive | `os.setPriority` BelowNormal for the process tree; EcoQoS where available | `os.setPriority` (nice 10) for the tree; `taskpolicy -b` background QoS when present |
| Orphan cleanup (7.14 F) | no leftover claude / MCP / shells | `taskkill /T` (existing) plus tree scan | process-group kill plus `ps` tree scan |
| Memory measurement (7.14 A) | know who uses memory | working set via PowerShell / `tasklist` | RSS via `ps -o rss` |
| Memory pressure (7.14 C) | act before the machine stalls | free physical memory | `os.freemem` plus `memory_pressure` / `vm_stat` when available |
| AV exclusions, page file (7.14 J) | advice only | Defender exclusions, page file size | Spotlight / XProtect advice, swap note |
| Shells for hooks | hooks run in Claude Code's shell | Git Bash (existing requirement) | sh |

CI already runs on macOS and Windows; every workstream's tests must pass on both.

## 6. Decisions the plan left open (made here)

- **Dashboard placement (Part 2):** a separate **"Progress"** page in the sidebar (global, filterable by epic and feature), not part of the "Now" page. "Now" stays about what needs attention this minute; "Progress" is about the whole picture and who it is stuck on.
- **Admission thresholds:** start with the plan's suggestions (`hits ≥ 2` from ≥ 2 PRs, reviewer count as a bonus; prose-only lessons need a higher score than checks; backtest recall > 0 and false-positive rate under 20%; shadow mode ≥ 5 PRs or 7 days with adoption > 60%). They are policy data, shown as "uncalibrated defaults" until the maintainer runs the calibration screen.
- **Comment policy check (Part 3 item 6):** shipped as a check type, **off by default**; when on, "temporary / not optimal" style comments must carry a ticket id.
- **Lint export (Part 1 item 4, Part 3 item 3):** an explicit per-check action that writes the rule into a new branch in a Shipherd-managed worktree and stops for the user; nothing lands in a repo automatically.
- **Stacks (7.13):** upper layers are branch-only by default; draft PRs only where the user wants PR CI; both squash and merge-commit flows are supported, detected per repo with an override.
- **External notifications (7.12):** a generic HTTPS webhook (works with ntfy-style and chat webhooks) sent through the PrivacyGateway with its own audit entry; default off; by default the payload says only what kind of event it is and how many, details are opt-in; quiet hours supported.
- **Shared MCP processes (7.14 H):** decided by measurement in M; if MCP processes are a material share of memory, M implements a shared server with per-session proxies, otherwise records the measurement in its addendum and keeps per-session servers.
- **Version:** 3.0.0.

## 7. How each workstream runs

1. Read the local source plan sections listed in section 3 and this document. Read the code it touches; the plan's "verify during development" items are verified here, not asked.
2. Write a design addendum (`docs/superpowers/specs/2026-11-17-ws-<id>-<slug>-design.md`) and a plan (`docs/superpowers/plans/...`). Make design calls yourself; record them.
3. Work in its own worktree under `~/Code/Shipherd-wt/ws-<id>` on `feat/ws-<id>-<slug>`, from the latest `origin/main`. Never use the shared checkout at `~/Code/Shipherd`.
4. Test first. `pnpm typecheck && pnpm lint && pnpm test`, plus `pnpm e2e` when touching UI, IPC, sessions or hooks.
5. Get an independent code review (Opus subagent) and address it before opening the PR.
6. Open the PR (one or more; a large workstream may split), let CI run on both platforms, fix until green, rebase on `main` when it moves.
7. Report done to the coordinator with the PR links. The coordinator reviews, merges and starts what the merge unblocks.

## 8. Acceptance for the release

The release ships when every workstream's acceptance (its addendum, derived from the plan's "验收" items) passes, CI is green on both platforms, the docs pairs and configuration docs describe every new setting, and a user who configures nothing sees 2.1.0 behaviour plus new pages that explain what can be turned on.
