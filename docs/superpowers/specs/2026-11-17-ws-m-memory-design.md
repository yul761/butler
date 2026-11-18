# Workstream M: memory and responsiveness (design addendum)

Date: 2026-11-17. Branches: `feat/ws-m-memory` (and stacked follow-ups). Target release: 3.0.0.
Source: plan item 7.14 (A to J); master design §4.9 (common rules), §5 (both platforms), §6 (shared MCP decided by measurement).

Hard constraint from the maintainer: **do not solve this by limiting how many tasks or sessions run at once.** Nothing here caps concurrency. Hibernated sessions still count as running tasks for every existing limit, so hibernation changes memory, not task counts.

## 0. What was measured before designing (H's input)

A read-only `ps -A -o pid=,ppid=,rss=,args=` of the maintainer's machine while five real Butler sessions were running (none of them touched):

| Part | RSS | Share of the session trees |
|---|---|---|
| `claude` processes | 2695 MB | 41.8% |
| MCP children (all) | 3736 MB | 57.9% |
| of which Butler's own MCP (3 × statecore-mcp at 79–83 MB, butler-sessions at 62 MB per session) | ~300 MB per session | ~23% |
| of which the user's own MCP from their Claude config (e.g. a browser-devtools server at ~330 MB, a global statecore at ~97 MB) | — | not Butler's to share |
| Butler main process | 412 MB | — |
| Electron helpers (renderer, GPU, utility) | 349 MB | — |

Conclusions:
- MCP is a material share, and Butler's own part (~300 MB per session, linear in sessions) can be shared. **H is implemented** (§8).
- The user's own MCP servers come from their Claude Code config, which Butler must never change (CONTRIBUTING). Butler only shows them in the breakdown and lists them in the advice (§10).
- `claude` itself is ~540 MB per session. Only hibernation (B / C) gets that back.

## 1. Process tables on both platforms (A, F, E, I share this)

One module, `src/main/procs/proc-table.ts`, reads the whole process table once per sample:

- **macOS / Linux:** `ps -A -o pid=,ppid=,pgid=,rss=,lstart=,args=` → `{pid, ppid, pgid, rssKb, start, args}`. `lstart` gives a start time so a pid that is reused later is never mistaken for an old one. `pgid` is used by F (below).
- **Parent links:** a process is not a child of a parent that started after it. Windows never reparents, so a long-lived process (explorer.exe) can carry the `ParentProcessId` of a parent that exited long ago and whose pid now belongs to a session's process. Without this rule that session's tree would include explorer and everything it launched, inflating memory, lowering its priority, and making F kill it. Start times compare as BigInt FILETIMEs on Windows and parsed `lstart` elsewhere.
- **Windows:** one PowerShell call, `Get-CimInstance Win32_Process -Property … | Select ProcessId,ParentProcessId,WorkingSetSize,CreationDate,Name,CommandLine | ConvertTo-Json -Compress`, with `-NoProfile -NonInteractive` and `windowsHide`. Working set is what Task Manager shows; master design §5 asks for it.
- The existing `proc-tree.ts` (background-shell detection) keeps its own `ps` call with `cputime`. It is a different question asked at a different moment, so it isn't merged. The new table reuses its `programName` helper.

Classification of a process inside a session tree (`classify(args)`), in order:
1. `claude`: the tree root (the pty's pid), plus any `claude` executable.
2. `mcp_butler`: our launcher's scripts (`statecore-mcp.cjs`, `butler-sessions-mcp.cjs`, `mcp-hub.cjs`).
3. `mcp_other`: any other direct child of `claude` that isn't a shell. Claude Code starts MCP servers as direct children, and `proc-tree.ts` already uses that rule.
4. `shell`: sh/bash/zsh/fish/pwsh/cmd/conhost/OpenConsole.
5. `watcher`: args match `--watch`, `watch`, `nodemon`, `tsserver`, `vitest` without `run`, `jest --watch`, `chokidar`, `esbuild --watch`, `tsc -w`.
6. `dev_server`: args match `vite`, `next dev`, `webpack serve`, `webpack-dev-server`, `react-scripts start`, `nuxt dev`, `astro dev`, `rails s`, `manage.py runserver`, `uvicorn`, `flask run`, `npm|pnpm|yarn run? (dev|start|serve)`.
7. `other`.

The rules are a list of plain regexes in one file with unit tests on both path styles.

On Windows, ConPTY's `conhost.exe` / `OpenConsole.exe` are children of the Butler main process, not of `claude`, so they can't be attributed to one session reliably. They go into a "Butler terminals" bucket on the Butler line. This decision is recorded so the Windows numbers aren't read as missing.

## 2. A: measurement

- **Sampler** (`src/main/procs/memory-monitor.ts`): every 60 s (and on demand when the Now page opens), take one process table and one `app.getAppMetrics()`.
  - For each open Butler terminal, sum its tree (root = `pty.pid(termId)`) per class. Process count and the largest processes are kept (top 8, with class and short args) for the breakdown.
  - Butler itself: main, renderer(s), GPU, utility processes from `getAppMetrics()` (`workingSetSize`, KB, both platforms). Butler-launched headless `claude -p` runs and the shared MCP hub are counted on the Butler line too.
  - System: total and free memory (§4).
- **Live view:** the latest sample is kept in memory and pushed to the renderer with the Now view (the Now page builds from `NowInput`). Each session row shows a total (e.g. `1.2 GB`); clicking it opens a breakdown: claude / Butler MCP / other MCP / shells / watchers / dev servers / other, plus the top processes.
- **History:** table `memory_samples` (append-only migration) gets one row per session plus one Butler row and one system row every 5 minutes (every 5th sample), and is pruned to 14 days on the hourly tick. Each session row also stores the latest total in `sessions.mem_kb` / `mem_at`, so closed and hibernated rows still show "last seen at 900 MB".
- **Now page header:** a small card shows Butler + sessions total, system free memory, the Butler-MCP share, and a 24 h sparkline (inline SVG, no chart library) of the total from `memory_samples`.
- **Setting:** `memoryMonitor` (default on). Sampling is read-only and cheap: one `ps` per minute on macOS, one PowerShell call per minute on Windows.

## 3. B: hibernate idle sessions

### State

New columns on `sessions` (append-only migration): `hibernated_at INTEGER`, `hibernate_reason TEXT` (`you` | `ci` | `review` | `idle` | `pressure` | `memory`), `pinned INTEGER NOT NULL DEFAULT 0`, `wake_error TEXT`, `wake_error_at INTEGER`, `mem_kb INTEGER`, `mem_at INTEGER`. All are stored on the chain head. `/clear` creates a new head, so `SessionsRepo.replace` copies `pinned` forward; a hibernated session never sees `/clear`.

`SessionView` gains `hibernatedAt`, `hibernateReason`, `pinned`, `wakeError`, `memKb`. The renderer shows "休眠 / Hibernated" wherever it shows a closed session today, with a wake action.

### Which state a session is waiting in

Decided per head on each tick (`hibernation.ts`, pure function `waitState`):
- `you`: "需要你" has a reason (`needsYou.reasonOf`), or the session has a pending ask_user (`inboxService.hasPendingDecision`). Permission dialogs and AskUserQuestion on screen are **excluded**, not `you` (below).
- `ci`: the ticket has an open PR (or a branch without one) with `ci === "pending"` (same rule as `waitingOnButler` in cleanup), or the session is queued in the merge gate.
- `review`: the ticket has an open PR, CI isn't pending, and review isn't approved.
- `idle`: anything else that is stopped.

Each state has its own minutes setting: `hibernateYouMinutes` 30, `hibernateCiMinutes` 20, `hibernateReviewMinutes` 30, `hibernateIdleMinutes` 60. 0 means never for that state. The master switch `hibernateEnabled` defaults off (plan: B, C, E off at first).

### When a session is never hibernated

Each rule below is a unit test:
- pinned (the "钉住" toggle on the Now row and the ticket page's session row);
- not a Butler session, a fix session (cannot be resumed by id), or a lesson run;
- no transcript on disk yet: `--resume` would fail, so it is precondition-checked with `transcriptState(id) === "present"`;
- working (`isWorking`, including background shells through `proc-tree`), or `activity === null` (unknown counts as working, as in cleanup);
- an approval or dialog on screen (`pty.screenNeedsUser`, `permissionShowing`): `--resume` drops a pending permission prompt;
- a draft in the input box, the user typed within the typing-quiet window, auto input in flight, or a reservation;
- being refreshed or closed by the refresher;
- its terminal is visible in the renderer right now (renderer reports visible terminals over IPC; §5);
- a coordinator whose managed sessions are working (same scope as cleanup's `childrenWorking`, extracted into a shared helper);
- opened less than 2 minutes ago, or woken less than 10 minutes ago. This stops wake/hibernate churn when CI results keep arriving.

The idle time is the same as cleanup's `idleSince`: the latest of head activity, transcript output, user input, terminal open, wake time and laptop resume.

### Hibernating

`Hibernator.hibernate(headId, reason)`:
1. Re-check every rule synchronously, then `pty.reserve(termId)` so nothing else types into it during the kill.
2. Snapshot the process tree from a fresh process table (§1).
3. Write `hibernated_at`, `hibernate_reason`, `mem_kb` **before** the kill, so `handleExit` knows this exit is a hibernation. `handleExit` then keeps `waitingForInput` (today's exit clears it) and doesn't prune.
4. Kill the tree. POSIX: SIGTERM to the pty pid and every recorded descendant, then SIGKILL after 5 s for any survivor whose (pid, start time) still matches. Windows: `taskkill /pid <root> /T /F`, then the same survivor check for descendants that were reparented. Descendants classed `watcher` / `dev_server` are spared when `hibernateEndWatchers` is off (I; default on). Spared ones are recorded so orphan cleanup leaves them alone while the session is hibernated.
5. Log `hibernate <id> (<reason>): idle <n> min, freed ~<MB>`, and `notify()`.

### Waking

There is one entry point, `Hibernator.wake(headId, why)`. It is idempotent: a second call while a wake is in flight returns the same promise. It does this:
1. Reopen through the session's own resume path: a ticket uses `open({ticketKey, sessionId})`, a feature coordinator `openFeature({featureId, sessionId})`, an epic `openEpic({epicId, sessionId})`, Butler `openButler({sessionId})`. All of them already use `--resume <head id>` when the transcript exists.
2. `SessionService` gets a hook `onOpened(headId)`. Any successful open of a chain clears `hibernated_at`, so a user click, `openAndSend` or patrol also "wake" it.
3. Wait for `SessionStart` (`pty.started`), then idle with no dialog. The timeout is the deliver start wait: 60 s.
4. Refresh activity and call `sessionStopped(head)`. This is the same function the Stop hook runs. It flushes the hold watcher (merge gate), the inbox (answers and reports), the Butler patrol and CI results. So every delivery path redelivers what it had to hold back.

**Resume failure.** The terminal exits before `SessionStart`, or there is no `SessionStart` within 60 s. Then Butler:
- clears `hibernated_at` and records `wake_error` and `wake_error_at`;
- logs the failure;
- shows a Now-page notice: "唤醒 X 失败：claude --resume 没有启动。点开重试，或新开一个 session".

The session then behaves exactly like a closed 2.1.0 session: CI results aren't delivered to closed sessions, the merge gate keeps waiting, and so on. Automatic wakes of that chain stop for 10 minutes. A user click always tries again.

### Every delivery path makes sure the session is running first

| Path | Today it only looks at | Change |
|---|---|---|
| `DeliveryGuard.check` | `termOf` (open terminal) | New block `hibernated`. When `termOf` is null and the chain is hibernated, it starts `wake(head)` and returns `{ok:false, block:"hibernated"}`. The caller holds the item; the wake's `sessionStopped` flushes it. Strings for the new block go into both languages (`ctlStartBlock`). |
| CI delivery (`sessionFor`) | open terminals | Hibernated heads with the same ticket and repo count as candidates, so the guard wakes them. |
| Inbox (`openHeads`, `reportTarget`) | open heads | Open plus hibernated heads. |
| Hold watcher (`isOpen`) | `gateTerm !== null` | Or hibernated. A hibernated waiter isn't treated as gone. |
| Control `send_message` / `start_feature` hand-over | `runningCoordinator` / `runningEpicSession` | Hibernated counts as not running, so the existing `openAndSend` / resume path runs. Resuming a hibernated head is the same `--resume` path, and the open hook clears hibernation. No change in the control files beyond that. |
| `pty.deliver` | — | Only ever called with a termId the guard returned, so the guard covers it. |
| Butler patrol | `runningButler` | When the Butler session is hibernated, patrol's `open` resumes it (existing behaviour). |
| User opens it | — | The renderer's existing resume (`open({ticketKey, sessionId})`). TerminalPane shows "已休眠" with a wake button, and wakes automatically when the user switches to a hibernated pane. |

Task-count limits (`openTerminalCount`, `featureTerminalCount`, the coordinator's `MAX_RUNNING_*`) count hibernated sessions as running, so hibernating never lets a coordinator start more work than before.

## 4. C: memory pressure

- Free memory: macOS reads `memory_pressure -Q` ("System-wide memory free percentage: NN%"), with `vm_stat` (free + inactive + speculative pages × page size) as a fallback. Windows and Linux use `os.freemem() / os.totalmem()`, which is accurate there. On macOS `os.freemem()` badly under-reports: it counts only free pages.
- Settings: `memoryPressureEnabled` (off), `memoryPressureFreePercent` (10).
- Each sample below the line hibernates **one** candidate: the longest-idle session passing every B exclusion, with a minimum idle of 5 minutes regardless of the B minutes. The next sample re-measures. It stops once free memory is back above the line + 5 points (hysteresis). Reason: `pressure`.
- C works when B's master switch is off: pressure-only hibernation.

## 5. D: renderer keeps only the visible terminal

- `TerminalPane` creates its xterm only while `visible`, disposes it (and its addons and listeners) when hidden, and rebuilds from `api.ptySnapshot(termId)` when shown again. The existing `ready` gate and replay logic stay. Live data that arrives while hidden isn't written anywhere in the renderer, because the main-process buffer already has it.
- Scrollback drops from 10 000 to 3 000. History is in Claude's own transcript, and the main-process replay buffer (256 KB) is unchanged.
- The renderer reports visible terminal ids to main (`pty:visible`), used by B (never hibernate what the user is looking at) and E.
- The new xterm is fitted synchronously right after `open()`, before the snapshot is written. Otherwise the snapshot (drawn at the pty's width) is replayed at xterm's default 80×24 and the redraws land on the wrong lines. When the size already matches the pty, Claude gets no SIGWINCH and never repaints.
- Terminal queries (DA, DSR, OSC 11) from a session in a hidden pane go unanswered, because no xterm exists to reply. This was already true for sessions on other pages before D. Claude Code times these queries out, so it is accepted.
- An e2e test switches between two sessions and checks that only one `.xterm` element exists and that output written while hidden appears after switching back.

## 6. E: background priority

- Applies to the trees of terminals that are not visible and not pinned. It is re-applied each sample to the tree's current pids, and reverted when the terminal becomes visible, gets pinned, or starts working. Butler tracks which pids it changed, and doesn't touch processes it didn't change.
- **macOS:** `taskpolicy -b -p <pid>` for invisible and idle trees, and `taskpolicy -B -p <pid>` to revert. Verified on this machine: reversible without root (pri 4 → 31 → 4). `os.setPriority`/nice is **not** used on macOS. Raising nice back needs root (verified: `ERR_SYSTEM_ERROR`), so a session the user comes back to would stay slow forever. Invisible but **working** trees are left at normal priority on macOS: `PRIO_DARWIN_BG` throttles CPU and disk hard and would slow the user's background builds and tests; there is no milder reversible knob.
- **Windows:** invisible trees get `os.setPriority(pid, PRIORITY_BELOW_NORMAL)`. Invisible and idle trees also get EcoQoS (`SetProcessInformation(ProcessPowerThrottling, EXECUTION_SPEED)`), via one PowerShell P/Invoke call per change batch. Reverting means `PRIORITY_NORMAL` plus EcoQoS off. An EcoQoS failure (old Windows) is logged once and BelowNormal still applies.
- **After review:**
  - Children inherit a lowered priority (Windows priority class, macOS `taskpolicy -b`). A process that appears under a lowered parent between samples is recorded at its parent's level, so restoring the tree restores it too.
  - The list of pids to change is worked out when the batch runs, not when it is queued. A restore queued behind a batch that is still lowering (EcoQoS takes a second or two) then sees what that batch did.
  - Dev servers and what they start are lowered one level at most: the user may be using them from a browser.
  - Windows only lowers processes that are at Normal, so restoring to Normal returns them to where they were. Turning EcoQoS off clears ControlMask too, which hands QoS back to the system instead of pinning it high. A pid whose EcoQoS change failed isn't retried.
  - On quit the manager stops lowering, and the monitor drops a sample still in flight (no hooks, no database writes after `stop()`).
- Setting `backgroundPriority` (off).

## 7. F: orphan cleanup

- Butler-owned means a process that was recorded as a descendant of a Butler terminal's tree in some sample (pid + start time + args). Also the shared MCP hub and headless runs, which have their own handles.
- Records accumulate across samples: each process stays recorded until it exits (matched by pid, start time and args), not just while it is in the latest tree.
- Adopted processes are found again: a process whose parent is a recorded live process, or (macOS) whose process group leader is a recorded process, is recorded too. A `nohup … &` job keeps its shell's process group after launchd adopts it, and a group id isn't reused while the group exists. A group whose leader pid now belongs to a different process is not taken. Children of a recorded parent that has exited are **not** adopted by ppid: Windows reuses pids quickly, and the parent can't be told apart from a newer process that had the same pid.
- Known gaps: on macOS, a job whose launching shell exited before any sample saw it (Claude's Bash tool runs commands in their own session with no controlling tty, and its environment isn't readable with `ps -E`, so neither can stand in). On Windows, a process whose parent exited before any sample saw it.
- When a terminal exits (closed, ended, hibernated, Butler quit), Butler waits 5 seconds, adopts once more against a fresh table, and ends each recorded process that is still alive, still matches (pid, start time, args), and is not under a live Butler tree: SIGTERM, then SIGKILL after 5 seconds; on Windows `taskkill`, then `taskkill /F`. `/T` is not used, because taskkill follows stale ppids; every descendant is a checked candidate of its own. Each one is logged.
- Exceptions: watchers and dev servers spared by a hibernation (I), while that session stays hibernated. When it is woken, ended or deleted, they become ordinary orphans and are cleaned up.
- At startup the previous run's records (persisted as JSON under `~/.butler/procs/owned.json`, rewritten each sample) are swept once. This covers Butler crashes.
- Setting `orphanCleanup` (on). It only ever kills processes Butler itself saw under its own sessions, so it can't hit the user's other work.

## 8. H: shared MCP

### Shape

One **MCP hub** child process (`memory-mcp/hub-entry.ts` → `mcp-hub.cjs`, run with Butler's Electron as Node like today's servers) serves Butler's MCP servers to every session over **loopback HTTP** (MCP Streamable HTTP, JSON responses only, stateless):
- `--mcp-config` entries become `{"type":"http","url":"http://127.0.0.1:<port>/mcp/<token>"}`. The proxy per session is just a route token. **No per-session processes remain** for Butler's servers. A stdio proxy per session was rejected: each proxy is a Node/Electron process with a 35–60 MB baseline, which gives back too little.
- **Routes:** Butler generates a random 32-byte token per (terminal, server) and sends the route table to the hub over the hub's stdin as JSON lines. A route is `{server:"memory", scope}` or `{server:"sessions", env, from}`. The per-terminal config file holds the tokens (0600, under `mcp/terms/`). The sessions server's caller identity (`from`), which today comes from `BUTLER_SESSION` in the child's env, is carried by the route.
- **Memory servers:** the hub keeps one StateCore embedded backend per scope (lazy, closed after 30 min unused) via `statecore-mcp/lib`'s `createEmbeddedBackend`. The six tools (remember, recall, facts, why, forget, handoff), their descriptions, input schemas, instructions and result shapes are reproduced from statecore-mcp 1.1.0. A **contract test** starts the real `statecore-mcp` over stdio and compares its `initialize` and `tools/list` with the hub's; it also runs remember / recall / handoff on both against temp data dirs. An upgrade of statecore-mcp that changes the tool layer fails the test. The env is cleaned exactly as `memory-mcp/entry.ts` does (no model keys, R1), and the lint allow-list for StateCore gets this one entry file.
- **Sessions server:** one `SessionsServer` instance per route (scope + from), the same class as today. `withdrawAll()` runs when a route is removed (terminal exit), the same as today's process exit.
- **Network:** the listener lives in `src/main/gateway/loopback-mcp.ts`, the only place network builtins are allowed. It binds `127.0.0.1` only and rejects requests whose `Host` isn't `127.0.0.1:<port>` or that carry an `Origin` header (DNS-rebinding and browser defence). It returns 404 for unknown tokens (never 401, so the client doesn't start OAuth discovery), 405 for GET/DELETE (allowed by the spec for servers without streams) and 202 for notifications. It is added to the gateway's public modules.
- **Lifecycle:** Butler starts the hub lazily on the first session open with the setting on. It restarts it with back-off if it dies, on the same port when free, and re-sends all routes. Because the server is stateless (no `Mcp-Session-Id`), clients continue with their next request. If the hub can't start, sessions opened meanwhile get today's stdio config, and the failure is logged and shown as a notice.

### Default

`sharedMcp` defaults **off** in 3.0.0. Reason: the HTTP transport path in the real Claude Code can't be exercised by tests (tests never run a real `claude`). A silent transport change for every session isn't acceptable before the maintainer has run it. The Now page's memory card shows the measured Butler-MCP total with "开启共享 MCP 约可省 X" when it's off. Turning it on affects sessions opened afterwards.

## 9. G: refresh by memory

- Setting `refreshMemoryMb` (default 2048; 0 = off). When a sample shows a session's `claude` process (not the whole tree) above the line, Butler calls `refresher.refresh(id, "auto")` with a log reason `memory`. The refresher's own guard, cooldown and "next stop" rules decide the moment, so it waits for the next idle point.
- If the next sample after a finished memory refresh still shows the process above 80% of the line, the process itself is restarted (`Hibernator.restart`: hibernate, then wake immediately, with the same exclusions and the same `--resume`). `/clear` drops context, but V8 doesn't always return the memory; a restart does. Each chain gets at most one memory restart per 6 hours.

## 10. I and J

- **I:** the breakdown (§2) lists watchers and dev servers per session with their size. `hibernateEndWatchers` (on) decides whether hibernation ends them (§3). A hook for workstream E2's repo profile: `src/main/procs/watcher-policy.ts` exports `setWatcherPolicy(fn: (repoPath) => "end" | "keep" | null)` (default: null, meaning use the setting). It also exports `watcherGuideLine(repoPath)`, which the session guide appends when the profile says "don't keep watchers running". E2 only has to register the function.
- **J:** a "内存与性能建议 / Memory and performance tips" section in General settings and in `docs/configuration*.md`, with platform-specific text:
  - **Windows:** Defender exclusions for the worktree root, `node_modules`, `.git` and `~/.butler`; page file size ("system managed", or at least 1.5× RAM).
  - **macOS:** add the worktree root to Spotlight privacy; avoid third-party antivirus real-time scanning of those folders. Swap is managed by macOS, so keep 15–20% of the disk free.
  - **Both:** the user's own heavy MCP servers (named from the measurement when present) load in every session. Remove them from the user's Claude config if they aren't needed. Butler only says this and never changes that config.

## 11. Settings (all documented in both config docs; strings in both languages)

| Key | Default | Item |
|---|---|---|
| `memoryMonitor` | 1 | A |
| `hibernateEnabled` | 0 | B |
| `hibernateYouMinutes` / `hibernateCiMinutes` / `hibernateReviewMinutes` / `hibernateIdleMinutes` | 30 / 20 / 30 / 60 | B |
| `hibernateEndWatchers` | 1 | B / I |
| `memoryPressureEnabled` | 0 | C |
| `memoryPressureFreePercent` | 10 | C |
| `backgroundPriority` | 0 | E |
| `orphanCleanup` | 1 | F |
| `refreshMemoryMb` | 2048 | G |
| `sharedMcp` | 0 | H |

These are global (machine-level) settings. They don't go through 4.2's layered scopes, which are for per-repo / per-product policy, and memory is a property of the machine. No background model calls are added (4.1 doesn't apply), and nothing is outward-visible (4.8 doesn't apply).

## 12. Tests

- Unit: proc-table parsing on both platforms (fixture outputs for `ps` and PowerShell JSON), classification, tree sums, `waitState`, every hibernation exclusion, wake idempotency and failure fallback, guard `hibernated` block and wake trigger, CI/inbox/hold lookups seeing hibernated heads, pressure selection and hysteresis, priority apply/revert bookkeeping per platform (commands faked), orphan detection (pid reuse safe), memory-refresh trigger, hub routing / token rejection / Host and Origin checks, the hub-vs-statecore contract test, and the TerminalPane mount/dispose behaviour.
- e2e (fake claude): a session is hibernated through a test-only IPC with the setting on. The Now row shows "休眠". A CI result (fake gh) wakes it, and it gets delivered. The woken fake claude, started with `--resume`, answers `/fake-recall` with the first prompt of the original conversation, which proves the context continued. A second e2e for D (single xterm, output kept). The fake claude learns `--resume` context reporting and `type: "http"` MCP entries for `/fake-mcp`.
- Windows-only unit tests: an EcoQoS/BelowNormal apply-and-revert test on a spawned child, and the PowerShell process-table read.

## 13. PR split

1. `feat/ws-m-memory`: A, D, E, F, G, I, J, settings and migrations for them.
2. `feat/ws-m-hibernate` (on 1): B, C, pin, wake paths, e2e.
3. `feat/ws-m-mcp-hub` (on 2): H.
