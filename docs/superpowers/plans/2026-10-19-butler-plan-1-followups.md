# Plan 1 follow-ups (deferred during execution)

Collected from the plan-1 execution ledger: every deferred minor, parked finding and ruling. Plans 2–4 should triage these.

## Rulings
- Ruling R0: Work on branch plan-1-foundation in the main checkout (no separate worktree) — repo is brand-new with only docs on main, nothing to isolate from — cost if wrong: none, branch is disposable.
- Ruling R1: Task 12 Step 7 (manual GUI E2E) cannot be performed by a subagent; implementer runs all automated checks plus a launch smoke, and the 11-item checklist is handed to the user at finish — cost if wrong: a GUI-only bug ships into plan 1 until the user runs the checklist.
- Ruling R2: No unit tests for IPC registration, preload and React components (plan-mandated); covered by manual checklist now and Playwright E2E in plan 4 — cost if wrong: renderer/IPC wiring bugs found later.
- Task 1: Ruling: fix the plan-mandated smoke hang (try/catch + timeout + exit 1) — the smoke command is reused as a gate in Task 12 and a hang hides failure — cost if wrong: a few lines beyond the brief
- Task 1: Ruling: require a clean `rm -rf node_modules && pnpm install` + smoke; if spawn-helper is non-exec, make postinstall fix it — global constraint says every task's checks must pass on this machine — cost if wrong: small package.json script change
- Ruling R3: from Task 3 on, subagents use the Co-Authored-By trailer their own harness attribution reminder names (accurate model attribution); Tasks 1-2 commits keep Opus 5.5 — cost if wrong: cosmetic commit-trailer inconsistency
- Ruling R4: Vite configLoader warning on every vitest run violates 'pristine output' — fold a rename vitest.config.ts → vitest.config.mts (+ tsconfig.node include update) into Task 3's dispatch — cost if wrong: trivial config churn
- Task 4: Ruling: fix now with a guard — when going through the shell, reject any arg not matching a safe-token pattern (throw), document that execText only takes trusted constant args; plan 2's `claude -p <prompt>` must pass prompts via stdin or a file, never argv — cost if wrong: small guard; plan 2 must honour the constraint
- Task 6: Ruling: fix Critical #1 and Important #2/#3 now, plus cheap data-safety minors #4 (only drop event arrays Butler emptied), #5 (non-object hooks / non-array event → SettingsParseError), #6 (null entries don't crash), #7 (strip UTF-8 BOM) and the wrong "PowerShell" comment — the installer edits the user's real ~/.claude/settings.json; spec constraint "merge-only, never clobber" is binding — cost if wrong: ~40 lines beyond the brief
- Task 7: Ruling: fix all three — spec §10 says bad inbox files go to inbox/bad "without blocking others" but events must not be lost; (a) catch+log inside drain; (b) parse failures → bad immediately, handler failures retried on later drains up to 3 attempts then bad, unlink failure after a successful handle → log and remember the name so it is not re-applied; (c) return the in-flight promise; plus guard double start() — cost if wrong: ~30 lines and one brief test changes from 1 drain to 3 drains for handler-failure quarantine
- Task 8: Ruling: fix — wrap readSessionHead per file in scanClaudeProjects (skip on error) and make readSessionHead settle on stream errors; also narrow the "<" filter to known Claude Code tags (cheap, avoids dropping real prompts starting with "<") — spec Review Focus 5 "corrupt jsonl" — cost if wrong: few lines
- Task 11: Ruling: fix both — spec §10 "PTY 意外退出 → 显示退出码" requires (1): PtyManager keeps a bounded (20) record of exited terminals' buffer+exitCode, `snapshot` returns {data, exitCode|null} through IPC, TerminalPane uses it; re-open clears the record. (2): one shared error banner in App fed by a `report(err)` helper; every fire-and-forget api call goes through it. Also cheap minors: archive navigates home; snapshot promise guarded against unmount + catch — cost if wrong: touches Task 9/10 files (pty-manager, register) in addition to renderer
- Task 12: Ruling: fix with a safeSend guard (win && !isDestroyed) used by notify and PTY callbacks + `closed` handler nulling win; also kill PTYs in before-quit (before windows are destroyed) — cost if wrong: few lines
- Ruling F1: one fix wave for Important #1-#4 + minors #5, #6, #9 + an integration test (hook envelope → inbox → applyHookEnvelope → ticketViews incl. out-of-order /clear and nested startup) — all are spec requirements or daily-use breakers; cheap — cost if wrong: larger final diff
- Ruling F2 (for #1): re-link the chain only on SessionStart source ∈ {clear, compact, resume}; a SessionStart with any other source whose id ≠ head(BUTLER_SESSION) is a nested session: recorded with ticketKey null and dismissed=1, never chained, and later events never attach the terminal's ticket to a dismissed session — cost if wrong: an in-terminal nested claude stays invisible (intended)
- Ruling F3: minors #7, #8, #10–#12 and the deferred-minor triage go to plans 2/4 as the final reviewer grouped them
- Final: parked — trailing PTY data after exit clears the exit banner (ConPTY) — Ruling: real, deferred to plan 2 (drop data when term.exited) — cost: dead pane without buttons on Windows until fixed
- Final: parked — resume after /clear opens a new pane, old pane keeps its banner — Ruling: cosmetic, deferred
- Final: parked — control chars in dropped filenames reach the Claude TUI — Ruling: needs a maliciously named file; deferred to plan 2 (strip C0)
- Final: parked — hook-triggered discovery fires for every ticketless session machine-wide — Ruling: deferred; schedule only when details missing
- Final: parked — uncaught exceptions now only logged to file (no console in dev) — Ruling: deferred; tee to console
- Final: parked — nested `claude --resume` / `-c` still re-links (source resume) — Ruling: accepted per F2; revisit in plan 2
- Final: parked — lost nested SessionStart leaves ticket on row (phantom waiting session) — Ruling: minor, deferred

## Deferred minors
- Task 1: minor (deferred): node-pty spawn-helper exec bit on fresh macOS install — plan 4 packaging/CI must run install-app-deps or chmod +x
- Task 1: minor (deferred): build:hook script references scripts/build-hook.mjs before Task 5 creates it; electron-winstaller build script ignored by pnpm (may matter for plan 4 packaging)
- Task 1: minor (deferred): node-pty rebuild requires a C++ toolchain (Xcode CLT / VS Build Tools) — document in plan 4 README/CI
- Task 1: minor (deferred): smoke timeout leaves pty child unkilled; index.ts smoke .catch discards error (backstop only)
- Task 2: minor (deferred): repos tests weak spots (cycle head not pinned; fillDetails non-empty cwd preserved untested; setWaiting false/backwards-at untested); migrate silently ignores user_version > MIGRATIONS.length (downgrade); ensureDirs/FK/CHECK untested
- Task 3: minor (deferred): GitError escapes create() unmapped (IPC shows code internal + message); user branch name not validated/-- separated (check-ref-format); invalid/permissive ticketPattern → SyntaxError / path traversal via key; extractTicketKey false positives (UTF-8, ISO-8601); switchBranch has no worktree guard; orphaned git artifact if insert fails; tests leave temp worktree dirs
- Task 4: minor (deferred): empty PATH between markers returns ""; login PATH replaces rather than merges GUI PATH; non-POSIX $SHELL (fish/nu); quoted Windows PATH entries; existsSync matches dirs; flag regex not column-anchored; version unparsed → null with error null; execText untested
- Task 4: minor (deferred): execText reject-before-spawn path untested; claude override path with `"` unescaped in shell command
- Task 5: minor (deferred): butler-hook SEA binary is ~136 MiB (full node copy) — plan 4 may swap for a smaller compiled helper; Windows .exe untested
- Task 5: minor (deferred): build:hook needs Node with --build-sea (≥25.5/26) — pin build Node or add postject fallback in plan 4 CI; no uncaughtException guard in hook/entry.ts; orphan .tmp on rename failure; silent event loss untraceable; main/readStdin untested
- Task 6: minor (deferred): Windows rename EPERM/EBUSY retry + tmp cleanup; concurrent install temp-name clash; partial backup never replaced; uninstall rewrites when nothing to remove; $/backtick in macOS path not escaped; duplicate entries labelled partial; HealthService rethrows EACCES; installHooks throws after binary copy; Windows hook shell (PowerShell would not execute a bare quoted path) — verify on Windows in plan 4
- Task 6: minor (deferred): dangling-symlink settings.json replaced by regular file; path containing `"` not recognised by isButlerHook; hookStatus reports "missing" (not settings_invalid) for non-object hooks so UI offers Install which then throws SettingsParseError — IPC must surface it; installHooks copies binary before settings validation
- Task 7: minor (deferred): origin never upgraded discovered→butler on later envelope; stale Stop after newer UserPromptSubmit can set waiting (relies on filename order = event order); fs.watch may start before mkdir completes; no tests for reentrancy/start/stop
- Task 7: minor (deferred): attempts/applied maps never pruned for externally removed files; unwritable bad/ → infinite retry/log; unlink-failure test relies on chmod (passes for wrong reason as root); start() test doesn't distinguish watcher from polling
- Task 8: minor (deferred): line-count (not byte) cap — huge single line fully buffered; serial scan, no result cap; "HEAD" branch special case untested; sync idempotence/ID2 branch+prompt untested
- Task 9: minor (deferred): exit handler deletes termId without identity guard (latent stale-exit race); buffer slice may cut escape sequences; prefill with newlines would submit; Windows cmd.exe quoting with --mcp-config path containing spaces (plan 4 adds mcp-config — must verify on Windows); FakePty kill exits synchronously; kill sends SIGHUP only
- Task 10: minor (deferred): double-click race loser gets "terminal already open" error instead of alreadyOpen (re-check openHeads after await checkBranch); orphan session row if spawn throws; channel lists typed string[] not unions; ptyWrite/ptyResize no arg validation; notify skipped when open throws
- Task 11: minor (deferred): blank flash after create until refresh; overlapping refresh can apply stale results and calls unclaimed() on every state event; raw English error strings in UI; S.openErrors may be undefined for unmapped reason; closePane picks from stale closure; settings no retry; title "" sent instead of undefined
- Task 11: minor (deferred): error banner sits behind NewTicketDialog modal; banner has no auto-clear
- Task 12: minor (deferred): will-quit cleanup registered only after bootstrap success; close prevention may block Windows logoff/shutdown (session-end); discovery timer not unref'd / overlap-guarded; no @2x tray icon
- Task 12: minor (deferred): killAll runs twice on quit (before-quit + will-quit) — real node-pty kill on an already-exiting pty should be harmless but unverified; quit-with-live-sessions path not exercised end to end

## Parked after final review
- Final: parked — trailing PTY data after exit clears the exit banner (ConPTY) — Ruling: real, deferred to plan 2 (drop data when term.exited) — cost: dead pane without buttons on Windows until fixed
- Final: parked — resume after /clear opens a new pane, old pane keeps its banner — Ruling: cosmetic, deferred
- Final: parked — control chars in dropped filenames reach the Claude TUI — Ruling: needs a maliciously named file; deferred to plan 2 (strip C0)
- Final: parked — hook-triggered discovery fires for every ticketless session machine-wide — Ruling: deferred; schedule only when details missing
- Final: parked — uncaught exceptions now only logged to file (no console in dev) — Ruling: deferred; tee to console
- Final: parked — nested `claude --resume` / `-c` still re-links (source resume) — Ruling: accepted per F2; revisit in plan 2
- Final: parked — lost nested SessionStart leaves ticket on row (phantom waiting session) — Ruling: minor, deferred

## Resolved in plan 2
- Task 3 minor: GitError escapes create() unmapped → TicketError("git_failed") with git's own reason (plan 2 Task 1)
- Task 3 minor: user branch name not validated → `git check-ref-format --branch`, expansion and leading "-" rejected (plan 2 Task 1)
- Empty repository → "这个仓库还没有任何提交" (plan 2 Task 1)
- Task 9 minor: prefill with newlines would submit → sanitizePrefill in SessionService.open (plan 2 Task 2)
- Final parked: trailing PTY data after exit clears the exit banner → dropped in PtyManager (plan 2 Task 2)
- Final parked: control chars in dropped filenames → stripControl in quotePath (plan 2 Task 2)
- Final parked: uncaught exceptions only logged to file → logger tees to console in dev (plan 2 Task 2)
- Task 10 minor: orphan session row if spawn throws; empty row when claude exits before the first message (plan 2 Task 3)
- Task 7 minor: origin never upgraded discovered→butler (plan 2 Task 3)
- Final parked: hook-triggered discovery for every ticketless session → only when details are missing, once per session (plan 2 Task 3)


# Plan 2 follow-ups (deferred during plan-2 execution)

Triage per the plan-2 final review: items marked "→ final wave" were fixed in the fix wave (see git log 73d47a6..d8e4258); the rest wait for plan 3 (UI/robustness) or plan 4 (Windows/packaging).

## Parked
- Task 16: parked — "nested claude --resume/-c re-links" (plan-1 F2 "revisit in plan 2") — Ruling: still accepted; carry to plan-1 followups doc as open — cost: rare chain hijack
- Final: parked — §4 `--setting-sources user` probably drops project-scope (.mcp.json) and local-scope MCP servers for headless runs/probe (live check ran in a temp cwd) — Ruling: keep `user` (repo-controlled allow rules/hooks must not apply to unattended runs); plan 3 must add a live check in a real repo cwd and, if tracker servers drop, a setting to opt project MCP back in + surface it in the tracker hint — cost if wrong: tracker MCP tools from .mcp.json unavailable to nightly handoffs
- Final: parked — REQUIRED_FLAGS lacks --setting-sources (older claude would fail every headless run without a health warning) — Ruling: plan 3 task — cost: confusing failure on old claude
- Final: parked — manual runMorningNow during an evaluate catch-up is not coalesced (morning runs twice) — Ruling: harmless, deferred

## Deferred minors
- Task 1: minor (deferred): git() lacks LC_ALL=C so gitErrorSummary misparses localized git; summary not length-capped; hasCommits/isValidBranchName blanket catch; thin tests for gitErrorSummary/switchBranch mapping
- Task 2: minor (deferred): stripControl drops tabs (intended for prefill); fresh-open prefill path untested
- Task 2: minor (deferred): grapheme clusters (ZWJ emoji) can still be cut at limit; stripControl leaves CSI parameter text ("[2J") visible
- Task 3: minor (deferred): handleExit sync disk scan on exit; nested-claude on discovered row upgrades origin before dismiss (harmless)
- Task 3: minor (deferred): tombstone in-memory (lost on restart → harmless empty row); discoveryPending never pruned; transcriptExists/transcriptState deps redundant
- Task 3: minor (deferred): ".DS_Store alone → absent" case not literally tested
- Task 4: minor (deferred): HANDOFF_BLOCK_RE info string matches butler-handoffX; empty last block shadows earlier valid one; ``` inside JSON string truncates block; no test for additionalProperties/nullable encodings
- Task 5: minor (deferred): INSERT OR IGNORE hides CHECK violations as "duplicate"; unbalanced "(" in tool list; normalizeSetting no default case (IPC must gate with isEditableSetting); parseContent doesn't normalise partial notices
- Task 5: minor (deferred): ROLLBACK TO failure masks original error; no 3-level nesting test; upgrade test cleanup not in finally
- Task 6: minor (deferred, recommend fixing in final wave): normalizeDescription lacks NFKC (full-width punctuation in Chinese → near-duplicates); id hit with another item's description mislabels/closes wrong item; touched first-wins drops a later done:true; status precedence model "done" beats open PR; missing tests (empty incoming list, case-only, same-item-twice mixed done, ignored re-listed by description, degraded leaves followups, rollback)
- Task 7: minor (deferred): rate-limit regex matches stray 429 in stderr; silent 20MB truncation; timeout msg "0 秒" for <500ms; skipIf treats "0" as enabled
- Task 7: minor (deferred): SIGKILL timer not cancelled after settle (pid-reuse theoretical); grandchild test may flake under load; "0 秒" message
- Task 8: minor (deferred → final wave, priority): recordHeadless could dismiss the user's real session if claude ever reports the resumed id (guard sid !== resumeSessionId); runNightly/refreshForBrief not async (sync throws escape .catch) — carry to Task 12; ready() ignores abort signal; in-flight sharing keyed by ticket not mode; candidates() vs resumeTarget use different clocks; lastCapturedAt vs fork start time misses activity during fork; fresh-start manual outcome not flagged; runner tests lack multi-session/replacedBy/throwing-run/archived cases
- Task 9: minor (deferred): dangling symlink treated as missing; fixed tmp name not cleaned; installHooks rejects after hooks installed on command write failure; archived ticket fallback
- Task 9: minor (deferred): mid-turn isMeta (skill injection) makes /handoff capture miss (fails closed); CRLF copy → conflict
- Task 10: minor (deferred): Windows orphan gap in killTree when claude already exited; SIGKILL timer unref'd at quit; spawn options duplicated vs runHeadless
- Task 10: minor (deferred): server-name skip can drop a read verb when the server is named e.g. "Search" (false negative only)
- Task 11: minor (deferred): unclaimed item key changes daily (marks don't persist); no southern-hemisphere/30-min DST test
- Task 12: minor (deferred): partial-failure job state recording; runNightlyNow during in-flight nightly queues a second batch; "timezone change" test name overclaims; latestValidFull duplicates latestValid
- Task 12: minor (deferred): run crossing local midnight classified as catch-up (compare start time instead of now); isMorningDue lacks future-lastRunAt guard; refresh-fallback next_step key unstable when no full handoff
- Task 13: minor (deferred → final wave, priority): Scheduler should coalesce duplicate queued/running jobs (repeat regenerate clicks spend quota; manual nightly can pop 2nd evening notification); job failures reply ok:true to renderer; jobsRunNightly/briefsRegenerate/onEvening not guarded after abort; install write errors not logged; uninstall command throw skips refresh; relative BUTLER_HOME crashes (path.resolve); no-ticket /handoff captures dropped silently; Windows AUMID for notifications (plan 4)
- Task 14: minor (deferred → final wave): tab switch flashes other kind / stale load overwrite; openRequest may pick a dismissed session (exclude dismissed); pendingOpen not cleared when ticket missing; newline-collapse untested; "；" literal
- Task 15: minor (deferred → final wave): shared busy flag re-enables nightly button mid-run (use separate flags / scheduler.isRunning); no nightly feedback; working-day toggle stale base + draft dropped during in-flight save; late runHandoff message lands on another ticket; settings stuck "加载中" if first load fails; tracker textarea no blur-save

## Rulings
- Ruling P2-R1: carry plan-1 rulings R2 (no unit tests for IPC/index/components) and R3 (subagents use their own harness Co-Authored-By) — cost if wrong: same as plan 1.
- Ruling P2-R2: the plan's 手动验证 section goes to the user at the end (subagents can't run GUI) — cost if wrong: GUI-only bugs found later.
- Ruling P2-R3: work happens in worktree Butler-dev so the user's running app on main is untouched — cost if wrong: none.
- Task 2: Ruling: fix surrogate split + trimEnd after cut; also add the re-open trailing-data regression test and a re-entrancy guard on the dev console tee (EPIPE loop) — cheap, prevents real failure modes — cost if wrong: few lines
- Task 3: Ruling: fix all three + mark needsDiscovery requested only when the scan actually found the session (avoid 5-min delay regression) + 3-row chain delete test — cost if wrong: ~30 lines
- Task 3: Ruling: round 2 for re-review follow-ups — ENOTDIR (.DS_Store) makes transcriptState "unknown" on macOS, silently disabling orphan cleanup; guard setReplacedBy on a skipped ensure — cost if wrong: small
- Task 5: Ruling: fix both + minors that cause silent misbehaviour: corrupt workingDays must fall back to default (else nightly never runs), latestValid must skip corrupt rows — cost if wrong: small
- Task 7: Ruling: fix all four — (1) POSIX detached process group + group kill, hard deadline that destroys stdio and settles, grandchild test; (2) on win32 .cmd/.bat targets reject args containing `"` together with any of & | < > ^ % (fail-safe, pure helper + test) and add the tricky arg to the test; (3) subtype !== "success" → claude_error; (4) HeadlessRequest.signal?: AbortSignal kills the tree; Task 13 must wire an AbortController aborted on before-quit — plus cheap minors: parse last non-empty stdout line, live test isolates BUTLER_HOME — cost if wrong: ~60 lines
- Ruling P2-R4: carry into Task 8 dispatch — add a test that HANDOFF/REFRESH JSON schema args pass unsafeCmdArg on win32 (else every Windows .cmd handoff fails) — cost if wrong: one test
- Task 9: Ruling: (1) marker line carries a content hash of the body (e.g. `<!-- butler:handoff-command sha256:<hex> -->`); hash matches → Butler-owned (installed if equal to current template, else stale → rewrite OK); hash mismatch or no marker → conflict (never overwrite/delete); (2) readLastTurn reports whether the turn's boundary user entry is a /handoff invocation (`<command-name>/handoff</command-name>` or the command expansion), capture requires it; plus cheap minors: skip isSidechain entries, use bytesRead, rename/finish the BOM test — cost if wrong: ~50 lines
- Task 10: Ruling: fix (1) with a write-word exclusion set + tests, (2) by stripping the known sanitized server prefix (fallback last "__" segment) + tests, (3) document the assumption in code and verify in Task 16's live run (record usage/cost of one probe); plus cheap minors: cap buf, flush last unterminated line on close, tests for split line / non-JSON junk / no trailing newline, assert grandchild pid file exists — cost if wrong: ~50 lines
- Ruling: get_merge_request no longer auto-suggested (merge in write set) — conservative false negative, user can tick manually
- Task 10: Ruling: round 2 switches to verb-position rule (first verb word must be a read verb) + acronym split + extended write set — safer than any deny list — cost if wrong: more read tools need manual ticking
- Ruling P2-R5: carry into Task 12 (snapshot builder) — exclude archived and done tickets from stale; latest must be the last FULL (non-refresh) handoff so next_step keys stay stable; pass previous-working-day handoffs filtered by date and oldest-first; wrap runner calls so synchronous throws become rejections (Task 8 note) — cost if wrong: small
- Task 12: Ruling: accept the implementer's overlay — latest = last full handoff with status/pr/jira overlaid from a newer valid refresh (id/trigger kept) — my P2-R5 wording would have made the morning refresh useless; overlay keeps keys stable AND refresh effective — cost if wrong: refresh status shows with full-handoff key
- Task 12: review (opus) — Needs fixes: Important plan-mandated — evening notification fires unconditionally (empty brief; catch-up/retry runs pop "evening" notification in the morning). Ruling-interaction: my previousDayHandoffs window drops this morning's catch-up nightly handoffs from the morning brief
- Task 12: Ruling: (a) notify only when evening content non-empty AND the run is for today's slot (catch-up of an earlier day's slot → no notification; morning brief shows it); (b) revise P2-R5: previousDayHandoffs window = [dayStart(previous working day), now], oldest-first, refresh excluded (restores the brief's intent; catch-up handoffs appear in the morning brief); (c) cheap minors: fall back to latestValid when no full handoff exists; BriefService.mark rejects followup: keys; treat lastRunAt > now as due — cost if wrong: small
- Ruling: lastRunAt future → due only when >24h ahead (keeps 'clock back 1h' no-double-run) — accepted
- Task 16: Ruling: (1) controller independently re-ran step 1 evidence: 48 files / 337 passed + 1 skipped, typecheck+lint ok, build ok, smoke "sqlite-ok 1" / "pty-ok" — evidence now on record; step 2/3 live results accepted as reported (no further quota spend) — cost if wrong: re-run in final wave; (2) probe undercount becomes a final-wave code fix: wait for pending servers (short grace after init, bounded) or show "部分服务仍在连接" + 重新检测; "no tokens billed" recorded as "no assistant/usage observed before kill", not proven
- Task 16: parked — "nested claude --resume/-c re-links" (plan-1 F2 "revisit in plan 2") — Ruling: still accepted; carry to plan-1 followups doc as open — cost: rare chain hijack
- Ruling F1: one fix wave for Important #1–#7 + must-fix deferred (NFKC normalizeDescription; done:true wins over earlier non-done for same target; Scheduler coalesces same-name queued/running jobs; separate busy flags for detect vs nightly; abort guards on onEvening/jobsRunNightly/briefsRegenerate) + minors 1 (evening notification opens evening tab) and 3 (degraded handoffs don't count as captured)
- Ruling F2 (#4): `--setting-sources` exists in claude 2.1.306. Fixer does ONE live check comparing MCP tool count from probeMcpTools with default vs `--setting-sources user` vs the most restrictive accepted value. Use the most restrictive value that keeps the user-scope MCP tools; at minimum exclude project and local sources (repo-controlled allow rules). Record the result; show in Settings that the user's own user-level allow rules still apply if `user` must stay — cost if wrong: tracker MCP tools unavailable to headless runs (detectable in probe)
- Ruling F3 (#5): catch-up and partial retries of the nightly only on working days; Monday morning catches up Friday before the brief — cost if wrong: weekend handoffs delayed to Monday
- Ruling F4: remaining deferred minors go to plan 3/4 per the final reviewer's triage (copied into the followups doc at finish)
- Final: parked — §4 `--setting-sources user` probably drops project-scope (.mcp.json) and local-scope MCP servers for headless runs/probe (live check ran in a temp cwd) — Ruling: keep `user` (repo-controlled allow rules/hooks must not apply to unattended runs); plan 3 must add a live check in a real repo cwd and, if tracker servers drop, a setting to opt project MCP back in + surface it in the tracker hint — cost if wrong: tracker MCP tools from .mcp.json unavailable to nightly handoffs
- Final: parked — REQUIRED_FLAGS lacks --setting-sources (older claude would fail every headless run without a health warning) — Ruling: plan 3 task — cost: confusing failure on old claude
- Final: parked — manual runMorningNow during an evaluate catch-up is not coalesced (morning runs twice) — Ruling: harmless, deferred
- Ruling P2-R6: do NOT merge plan 2 into main yet — the user's running app is on main (renderer HMR + DB migration would disrupt their testing); stack plans 3 and 4 on this branch line and merge once at the end — cost if wrong: later merge, larger diff

# Plan 3 follow-ups

## Live checks
- Plan 3 Task 1 (claude 2.1.306): MCP sources in a real git repo cwd with a project `.mcp.json` (approved in `.claude/settings.local.json`) and a local-scope server
  - A default: butlerproj:connected, butlerlocal:connected (2 servers, 2 tools)
  - B `--setting-sources user`: no servers, no tools (0 servers, 0 tools)
  - C B + `--mcp-config .mcp.json`: butlerproj:connected (1 server, 1 tool)
  - D B + `--mcp-config <exported local servers>`: butlerlocal:connected (1 server, 1 tool)
  - no assistant message observed before kill in any run
- Ruling P3-R1: Task 5 takes route A; INCLUDE_LOCAL_SCOPE = true — B dropped both project and local servers, and C and D each restored theirs via --mcp-config — cost if wrong: tracker MCP tools from .mcp.json / local scope unavailable to nightly handoffs (detectable in the probe)

## Resolved in plan 3
- Plan 2 parked: `--setting-sources user` vs project / local MCP — live check in a real git repo cwd (Task 1, Ruling P3-R1); opt-in `headlessProjectMcp` via `--mcp-config` or hint-only, per the ruling (Task 5)
- Plan 2 parked: REQUIRED_FLAGS lacks --setting-sources → added, older claude gets a health warning (Task 1)
- Plan 2 parked: manual runMorningNow queued behind a scheduled catch-up runs again → skipped when the job already ran after the click (Task 2; now matters because each morning brief may cost personal API money)
- Plan 2 Task 1 minor: git() lacks LC_ALL=C; summary not length-capped (Task 3)
- Plan 2 Task 4 minor: HANDOFF_BLOCK_RE accepts butler-handoffX; empty last block shadows an earlier valid one (Task 3)
- Plan 2 Task 5 minor: normalizeSetting has no default case; parseContent does not normalise partial notices (Task 2)
- Plan 2 Task 7 minor: rate-limit regex matches a stray 429 in stderr; "0 秒" timeout message; live skipIf treats "0" as enabled (Task 3)
- Plan 2 Task 12 minor: nightly run crossing local midnight treated as a catch-up (Task 2)
- Plan 2 Task 13 minor: job failures reply ok to the renderer (IPC now returns the job state); relative BUTLER_HOME crashes; no-ticket /handoff captures dropped silently (now logged) (Tasks 2, 4)
- Plan 2 Task 14 minor: tab switch flashes the other kind / stale load overwrite; openRequest may pick a dismissed session; pendingOpen left dangling for a missing ticket; "；" literal (Task 4)
- Plan 2 Task 15 minor: no nightly feedback; working-day toggle stale base; settings stuck on 加载中; tracker textarea no blur-save (Task 4)
- Plan 1 Task 11 minor: error banner behind the NewTicketDialog modal; settings no retry (Task 4)
- Plan 1 Task 12 minor: discovery runs not overlap-guarded (Task 4)

## Still open after plan 3
- Windows and packaging items from both lists (rename EPERM/EBUSY, hook shell, killTree orphan gap, cmd.exe quoting with --mcp-config, notification AUMID, SEA size and build Node, CI) → plan 4
- Renderer CSP (plan 4, with the packaged build); personal API requests use Node's fetch, which ignores the system proxy → revisit in plan 4 if users need a proxy
- StateCore wiring must build its env with `statecoreEnv()` (src/main/gateway/statecore-env.ts) → plan 4
- StateCore at `full` (§8.5) bypasses the gateway's scan, budget and audit, and delivering MODEL_API_KEY to a claude-mounted statecore-mcp would put the key in plaintext (mcp-config file or session env) → plan 4 must decide: in-process StateCore via createEmbeddedBackend only, or a gateway-proxied model endpoint.
- Low-impact minors not taken (tombstones in memory, INSERT OR IGNORE hiding CHECK violations, ROLLBACK TO masking the original error, dangling symlinks, mid-turn isMeta capture miss, server-name skip false negative, unclaimed item key changes daily, 30-minute DST test, grapheme clusters at the prefill limit) → revisit with E2E in plan 4
- Nested `claude --resume/-c` re-links (accepted per plan 1 F2)
- Plan 3 parked items (from the plan-3 SDD ledger):
  - Project MCP trust (Task 5), parked because project MCP is an opt-in feature, off by default: APFS Unicode case-fold alias defended only by the realpath check (add a macOS regression test); bind the read fd to the trust check (dev/ino, O_NOFOLLOW|O_NONBLOCK); `git -c core.fsmonitor=false` app-wide; random temp name with `wx`; git absolute path on Windows; non-git cwd under a parent repo trusted (by design)
  - Scanner (Task 10): custom `ticketPattern` ReDoS validation in settings; lowercase / spaced ticket ids (`proj-12`, `PROJ - 12`); octal-ish IPs; underscore hosts; IDN domains; 2-label `.local` / `.private` hosts and uppercase ambiguous-TLD hosts pass; worst case ~0.7 s per 100 KB (linear)
  - Pseudonymizer (Task 9): substring over-replacement (`api` in `rapid`); names without accents/dots, first-name-only and traditional/simplified mismatches are not matched (documented in §7.4); English narrative sentence dropped wholesale on one bad placeholder (fails safe)
  - Gateway / provider (Tasks 11, 13): a 2xx whose body read is cut by abort or a network error is not costed; scrub misses base64 / line-split / partial key echoes
  - Narrative source (Task 15): PR orgs shorter than 3 chars are not registered; handoff scan capped at 1000 per ticket; a repo literally named like a stoplisted word (`api`, `web`) relies on the scanner
  - Audit / settings (Tasks 7, 8, 16, 17, 18): `finish()` lacks a status guard; case-only term dedupe untested; token estimate not conservative for non-CJK scripts; `llmStatus` stays cached after the keychain breaks mid-session (restart shows it); audit page resets to page 1 on every state change; pretty-printed JSON is re-serialised (not byte-verbatim); a rejected key is wiped from the input
  - Minors from Tasks 1–4: health.test fake help string hand-maintained; `~` not expanded in BUTLER_HOME; localized `hint:` line with user LC_ALL; same-field draft lost during an in-flight save
  - Manual check: macOS confirm dialog height when the outbound body is long (Task 16)
  - Egress lint accepted residuals (deliberate evasion only): `Reflect.get(globalThis, "fetch")`, `eval`, `new Function`, template-literal subscripts, an aliased `session` variable; `utilityProcess.fork` scripts are linted themselves; `protocol.handle` cannot reach out without `net` → plan 4: add `no-eval` / `no-new-func`
  - A stale `pending` row from a quit while the confirm dialog was open is labelled "may have been sent" (conservative); stale rows for a model without a price are costed at $0

# Plan 4 follow-ups

## Live checks
- Plan 4 Task 1 (statecore-mcp 1.0.0, embedded, temp dir): two followups with materially different text coexist; forget + remember of a revision keeps the old version on the why chain (chain length 2); a text identical to a forgotten note stays hidden; a variant prefix shows it; without a model `digestNow` is `no-llm`; two notes differing only in their id → the second supersedes the first (Jaccard ≥ 0.7) — Butler's variants carry distinguishing words and re-write a displaced note
- Plan 4 Task 7 (Electron 44 as Node, bundled statecore-mcp ≈ 1.8 MB): initialize / tools / remember over stdio work; `MODEL_API_KEY` + `FEATURE_LLM=true` in the environment give `no model configured`
- Plan 4 Task 11 (isolated launch, temp `BUTLER_HOME` + `CLAUDE_CONFIG_DIR`, no provider called, `llm_audit` empty): after the second launch's `syncAll()`, `user_version` 4, `memory_sync` = DEMO-42 / handoff 1; `ticket:DEMO-42` facts = the open followup and the decision, `workspace` = the learning with its `[learning:DEMO-42]` prefix; the bundled MCP (Electron as Node) `recall` on the same scope returns the handoff, decision and followup; no `--mcp-config` file written (no session opened); nothing logged

## Rulings
- Ruling P4-R1: StateCore distillation at the full level is not scanned — design 8.5 accepts sending raw events at full; it is audited (source = statecore) and budgeted — cost if wrong: raw work content reaches the user's own provider at the level whose label says so
- Ruling P4-R2: depend on `statecore-mcp@1.0.0` from npm, exact pin (published 2026-09-24, MIT, ships `./lib` with types); no vendoring, no git dependency — cost if wrong: a later StateCore fix needs a version bump
- Ruling P4-R3: `statecoreEnv()` loses its key-handover branch (single argument); no StateCore process ever gets a model key through its environment — cost if wrong: none (no caller used the branch)
- Ruling P4-R4: R1 implemented through StateCore's `digestLlm` injection point (`PrivacyGateway.statecoreModel()`), not a loopback proxy: no port, no bearer token, the key never leaves the gateway — cost if wrong: claude-mounted MCP processes cannot distil (R1 forbids it anyway)
- Ruling P4-R5: no confirm-before-send dialog for distillation; with confirm-before-send on, distillation does not run — a digest makes several model calls in the background — cost if wrong: users with confirm on get no distillation
- Ruling P4-R6: headless handoffs / refreshes do not mount the memory MCP — their prompt already carries the previous handoff and open followups, and fewer MCP servers means fewer moving parts in unattended runs — cost if wrong: handoff prompts miss Claude's own notes
- Ruling P4-R7: on Windows with a `.cmd` claude and a config path that cmd.exe cannot carry safely, sessions start without memory (logged) until plan 5 removes cmd.exe — cost if wrong: Windows users with spaces in their home path have no memory in sessions for one plan
- Ruling PF2 (notes-cap guard): before every StateCore `remember` into a ticket scope, Butler counts the scope's note slots (live + forgotten) and writes nothing when the scope is full, so it never makes StateCore evict a note it wants to keep; priority when only some fit: open followups (newest first), then decisions — cost if wrong: some entries never reach StateCore (logged as counts)
- Task 6 product ruling: the nightly distillation skips a `ticket:` scope whose notes are full (30/30) — a digest cannot free slots there, only evict — cost: full tickets are not distilled
- Final-review ruling (finding 1): the skip is widened to headroom: a `ticket:` scope is digested only when at least `DIGEST_HEADROOM` (6) note slots are free, because at 25–29 used slots a digest plus carry-over could push live Butler notes out and the resync cannot write them back — cost: tickets with 25+ used slots are not distilled

## Resolved in plan 4
- Plan 3 still open: StateCore wiring builds its env with `statecoreEnv()` (Tasks 1, 7)
- Plan 3 still open: StateCore at full bypassed the gateway / key in plaintext for claude-mounted MCP → R1: keyless MCP, distillation only via `PrivacyGateway.statecoreModel()` (Tasks 5, 6, 7)
- Plan 3 parked (scanner): custom `ticketPattern` ReDoS validation in settings (Task 9)
- Design 8.5: warning when the user also installed StateCore's capture plugin (Task 9)
- Found while planning: in dev, `app.getAppPath()` is `out/main` when launched as `electron out/main/index.js`, so the bundled hook path was wrong in that launch style; bundled paths now resolve from `__dirname` (Task 7)

## Still open after plan 4
- Everything plan 5 lists (CSP, packaging, Windows items incl. cmd.exe quoting with `--mcp-config` and the killTree orphan gap, absolute git path, AUMID, SEA size / build Node, Playwright E2E, CI, no-eval lint, open-source docs)
- Plan 3 items that plan 4 appendix C declines (not fixed; the reason for each is in that appendix): low-impact minors, nested `claude --resume/-c`, scanner / pseudonymizer / gateway / narrative / audit parked minors, the remaining egress-lint residuals
- StateCore note cap (30 notes per scope, forgotten notes included): Butler maintains at most 24 of its own notes per ticket, never evicts a note in its desired set (Ruling PF2), and skips any write that would not fit. Skipped writes are logged as counts only. Forgotten notes keep their slots on statecore-mcp 1.0.0, and that holds at every privacy level, because a full digest does not free them (see below) and ticket scopes with fewer than 6 free slots are not digested anyway. So a long-lived ticket with a lot of followup churn stops gaining new followups and decisions once the scope has seen 30 notes. That is about 28 new Butler notes after a couple of long-lived ones, and fewer when Claude also writes into the scope. `workspace` keeps the latest 30 learnings, and StateCore evicts the oldest.
- Variant distinguishing words are visible to Claude in recall (`[followup:f_1#2 abcd efgh ijkl] …`)
- StateCore 1.0.0 upstream limitations (worth reporting to StateCore; Butler works around or documents them):
  - (a) A full digest does not free forgotten-note slots. `pruneForgottenFacts` drops them, but `createDigestWithSnapshot` → `carryOverConcurrentNotes` re-appends every registry note missing from the pipeline state, without a cap check. So `profile.notes` can exceed 30, and the forgotten notes move to the end, which makes the oldest-first eviction hit live notes first.
  - (b) Consolidate events written before Butler's first note in a scope are never counted as pending: that first write inserts a `Digest` row, and `countPendingEvents` counts only newer events. They are distilled only if a later event arrives within the digest window. This is pinned by a `statecore.test.ts` test that should be deleted if an upgrade changes it.
  - (c) A digest that pushes a scope past 30 notes can evict a Butler note. Butler digests a ticket scope only with at least 6 free slots, and the resync after a digest never evicts to restore a note. A model that distils more new notes than the headroom in one digest can still push desired notes out; Butler then logs how many desired notes are still missing after the resync (count only, deduplicated). `workspace` has no resync.
  - (d) A digest can report "ran" when it did not process every event: a refused or failed stage-2 chunk is skipped while a `Digest` row is still written, and after two invalid-JSON replies stage 2 returns a degraded result. Either way, those events count as digested with no facts.
- Ticket pattern ReDoS: settings reject a pattern that times out a vm probe (~250 ms) on about 5k-character adversarial inputs, which catches exponential and steep polynomial patterns. A quadratic pattern can still pass and be slow on very large inputs.
- Parked minors:
  - Tickets whose keys differ only by case collide in `mcp/tickets/` on case-insensitive filesystems (keys are effectively uppercase).
  - Stale `mcp/tickets/` configs for deleted tickets are not removed.
  - An audit write can race `db.close` on quit. This predates plan 4: the `pending` row is swept at the next start with a conservative cost.
  - A connect-refused / DNS failure is charged a conservative cost (safe direction).
  - A skipped distillation night is visible only in the log.
  - MemoryPanel, the wizard and the App onboarding wiring have no component tests (plan 1 R2 → plan 5 E2E).
  - Quitting mid-wizard restarts it at step 1, and "稍后再说" (skip) is permanent until the wizard is rerun from settings.
  - Final review 3: `MemoryService.view` / `why` do not go through the sync queue (reads run concurrently by design; safe because node:sqlite is synchronous and StateCore reads under WAL).
  - Final review 5: StateCore's `busy_timeout=5000` on `DatabaseSync` blocks the Electron main thread while the claude-mounted MCP holds the write lock (milliseconds today); moving StateCore to a worker would remove it (plan 5 candidate).
  - Final review 10: the morning narrative shares the gateway's serial chain with distillation, so it can wait behind one in-flight StateCore call (at most 180 s), never the whole run.
  - Final review 12: `BackgroundRunner.running()` and `MemoryService.idle()` are used only by tests.
  - Final review 13: the P4-R6 wiring test matches `index.ts` source text and will churn on harmless refactors.
  - The memory tab reloads only on `memory:changed` (a Butler sync of its ticket, or the memory switch); notes Claude writes through the mounted MCP during a session show up after the next sync of that ticket or when the tab is reopened.
- Carried to plan 5:
  - Packaging must ship `build/memory-mcp/statecore-mcp.cjs` at `resources/memory-mcp/` and keep the `ELECTRON_RUN_AS_NODE` fuse enabled; the memory MCP runs on Butler's own Electron as Node.
  - Plan 5's README must not claim that the scanner covers full-level memory distillation (P4-R1). Its memory paragraph should also say that a ticket whose 30 note slots are used gets no new memory entries (the cap item above).
  - P4-R7's Windows memory-mount skip is removed by plan 5 Task 3 (no cmd.exe).
