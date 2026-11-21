# BTL-242: Windows UI lag: design addendum

Date: 2026-11-20. Scope: work item W2 of the Butler 4.0 simplification design. The rest of that design is unchanged.

## Problem

On a Windows work machine (32 GB), Butler 3.1.x feels slow: clicking buttons, switching pages and typing in a terminal all lag. Other apps are fine and the Mac is fine. No logs were available. Reading the code points at many suspects but none was measured, so the first deliverable is diagnostics the user can export, then fixes for the suspects with the most evidence.

## Decisions

### 1. Diagnostics are always on, cheap, and exportable

- `src/main/diag/perf-stats.ts` keeps one 60-second window of counters, then rolls it into a ring of the last 60 windows (one hour):
  - event-loop delay from `perf_hooks.monitorEventLoopDelay({ resolution: 20 })`: p50, p99 and max;
  - pushes from main to the renderer per channel (`state:changed`, `turn:changed`, `pty:data` with bytes, …);
  - IPC invokes per channel, with total and max handler time; a handler over 20 ms is logged once per channel per window;
  - named heavy operations (`findTranscript`, `conv.ingest`, `conv.rules`, `turn.board`, `views.tickets`, `views.features`, `procs.sample`): count, total and max; one over 50 ms is logged once per name per window;
  - renderer long tasks (count, total ms, max), sent by the renderer once a minute.
- Every window ends with one `perf:` line in `main.log`, so a user's log already contains the data. The line is skipped when the window was idle (no long tasks, p99 < 50 ms, no slow operations), so an idle Butler adds nothing to the log.
- `BUTLER_PERF_DIAG=0` turns everything off; `BUTLER_PERF_DIAG=verbose` writes a line every window even when idle. There is no new setting: the 4.0 design asks for fewer settings, and this costs nothing when idle.
- Renderer: `PerformanceObserver({ type: "longtask" })` adds up long tasks and sends them over a fire-and-forget IPC channel `diag:renderer` once a minute, along with which xterm renderer is in use (WebGL or DOM).
- **Settings → Health (环境检查) → "Export diagnostics" (导出诊断)**: opens a save dialog and writes one JSON file: app version, platform, OS release, CPU, memory, `app.getAppMetrics()`, the ring of perf windows, the current window, and the last 1,000 lines of `main.log`. It holds no transcript or conversation content. (`main.log` has ticket keys and paths, and the user is the one choosing to share the file.)

### 2. Main to renderer: one coalesced, scoped `state:changed`

- `notify(scope = "data")` no longer sends right away. `src/main/diag/invalidator.ts` (`Invalidator`) merges every call within 120 ms (and sends at most 250 ms after the first one) into a single `state:changed` with payload `{ scopes: StateScope[] }`. In the same flush it calls `turnService.changed()`, so there is one cadence instead of two independent debounces.
- `StateScope = "data" | "activity" | "procs" | "messages" | "output"`:
  - `data`: anything stored changed. It is the default, and every existing call site keeps it.
  - `activity`: what a running session is doing changed (kind, stuck, reason, limit). The activity monitor uses this.
  - `procs`: a memory sample landed.
  - `messages`: reserved for BTL-245 (mailbox).
  - `output`: a running session only printed more (added after review). It is sent at most once every 5 s (`diag/throttle.ts`), and only the ticket glance listens (`GLANCE_SCOPES`), so its context meter and last reply keep moving during a long step.
- **The activity monitor no longer notifies the UI when only `lastOutputAt` or `lastOutput` changed.** These change on every transcript write, up to about three times a second for each working session. No renderer view except the ticket glance (see `output` above) needs them that often: the turn board reads `lastOutputAt` only for stuck sessions, which by definition are not producing output. The monitor still runs its in-process follow-ups (needs-you, auto refresh, wait tracker) on every change, exactly as before. That keeps behavior the same and stops the biggest source of refetches.
- Renderer: `src/renderer/src/state-bus.ts` attaches **one** IPC listener for `state:changed` and fans the event out to subscribers, each with a scope filter. Before this, each of the 73 subscription points attached its own IPC listener. Defaults:
  - `useStateRefetch(key, fetch)` and `api.onStateChanged(cb)` with no scopes listen to `data` only;
  - the App refresh (now view, feature views, which carry activity) and `ButlerPage` opt into `activity` and `procs`;
  - `turn:changed` follows the same flush.

  Every existing `notify()` is a `data` notify, so a component that doesn't opt in still refetches on every event it did before, except the activity and memory-sample ticks, which it never displayed.

### 3. View building

- `SessionService.ticketViews()`, `featureViews()` and `epicViews()` are wrapped in a **generation cache** in `index.ts` (`ViewCache`). A cached value is dropped at the next `notify()` call (any scope, counted when the call is made, not at the coalesced flush), on any IPC invoke that is not on the read-only allowlist, or after 1 s, whichever comes first. During one refresh burst the renderer asks for `listTickets`, `listFeatures`, `listEpics`, `nowView` and `turnBoard` (sometimes more than once), and each of those built `allTicketViews` again. Now they share one build.
- `TurnService.board()` caches its `BoardInput` the same way, so several boards with different filters in one burst build the input once.
- `allTicketViews` gets the sessions for every ticket with one query (`SessionsRepo.listByTickets`) and one `rootsOf` call, instead of N+1 queries.

### 4. Discovery: `findTranscript` cache

- `findTranscript` remembers `sessionId → path` (module-level LRU, 2,000 entries). A hit is checked with one `existsSync` on the cached path, and the directory scan runs only when that file has gone. A miss still scans, and misses are not cached, because Claude Code creates the file only after the first message. Callers keep calling the same function. Agreed with BTL-244: their setting gates only the unclaimed discovery loop (`runDiscovery`), and `findTranscript` for Butler's own sessions always works.

### 5. Conversation store

- `applyRules()` after an ingest looks only at the turns that ingest touched, not every pending turn. The full pass stays in the sweep and in the judge run.
- `ruleVerdict` remembers turns the rules already sent to the model, keyed by the turn's `lastAt`, `mutated`, `otherTools` and `asked`, so that while the judge is paused the same pending turns aren't re-read (`turnMessages`) on every ingest. The existing per-ticket pause (`CONV_PAUSE_RETRY_MS`) stays the backoff.

### 6. Terminals

- **WebGL renderer** (`@xterm/addon-webgl` 0.19.0, the release that matches xterm 6.0.0). If the addon throws or the context is lost, the terminal falls back to the DOM renderer and the diagnostics record it. The E2E fixtures set `BUTLER_TERMINAL_RENDERER=dom` (exposed through preload) because the E2E tests read `.xterm-rows`. One E2E test runs with the default and checks that a terminal still works.
- **Keep-alive instead of rebuilding**: `src/renderer/src/terminal-cache.ts` keeps xterm instances for the last 4 terminals the user looked at, as an LRU. Switching back to a cached terminal re-attaches its DOM node and re-fits it, with no snapshot replay. Evicted ones are disposed (the WS-M D memory goal is kept, with a bound of 4). A hidden xterm pauses rendering on its own (IntersectionObserver), so writes to it cost only parsing.
- **`pty:data` only to attached terminals**: `pty:snapshot` subscribes that terminal and `pty:detach` (new, fire-and-forget) unsubscribes it. Main sends `pty:data` only for subscribed terminal ids. Ordering is unchanged: the snapshot reply still follows every data event already sent.
- **Closed terminals** stay in the LRU until they are pushed out; it holds at most 4, so this is left as is.
- **Resume, not replay** (changed while measuring: cached xterms kept parsing every session's output in the background, so the home page still received all `pty:data`). A cached xterm also unsubscribes when it is taken off the page. `PtyManager` counts each run's output (`epoch` + offset); the snapshot carries that mark, and on re-attach `pty:since(id, mark)` subscribes and returns only the output after the mark. When that part has left the buffer, or the terminal was reopened, it returns a full snapshot with `reset: true`, and the renderer clears the screen and replays it as before.
- **Replay buffer**: `PtyManager` keeps output as a chunk list with a running length and joins it only on snapshot or exit. The per-chunk `string + data` and `slice` over 256 KB go away; trimming happens at chunk level, followed by the same newline alignment when joined.

### 7. Renderer work

- Animations on the live window (`stroke-dashoffset`, pulse, blink) get `animation-play-state: paused` when the document is hidden or the stage is scrolled out of view (`motion.ts`: `visibilitychange` plus an IntersectionObserver, a `motion-paused` class on the stage). The live window already isn't rendered when its fold is closed.
- `ConversationTab`: the draft lives in a child `Composer` component, so typing no longer re-renders the timeline, and `buildTimeline` is memoized on its inputs.
- `App`: `allTickets`, `ctx`, and the `liveTickets` set are memoized, and refreshes keep the old arrays when their content is unchanged (`keepSame`, also in `useStateRefetch`), so the memos hold across refreshes. `Sidebar` is wrapped in `React.memo`. `HomePage` is not: it takes many inline callbacks, and after the scope and keepSame changes it re-renders only when its data changes.

### 8. Windows-specific sampling and I/O

- The memory monitor's "sample soon" (3 s after a terminal opens or exits) is rate-limited: at most one extra sample per 20 s. On Windows the regular interval becomes 120 s (60 s elsewhere). Each sample is timed under `procs.sample`.
- Background priority's `Add-Type`: checked and left as it is. Every EcoQoS change starts its own PowerShell and compiles the type again, which costs roughly a second of CPU in a child process. That happens only when a session's level changes, batched over all pids, not on every sample. Caching the type would need a long-lived PowerShell process, which is not worth it at that rate.
- Logger: lines go into an in-memory buffer that is written with an async `appendFile` every 250 ms, or at once when the buffer passes 64 KB. `flushSync()` runs at quit and on uncaught errors, so nothing is lost at exit. The directory is created once, not on every line.

## Not done here

- No sampling profiler or trace export: the brief asks for cheap, always-on counters, and a trace would include content.
- The control inbox (1 s) and hooks/gate inbox (2 s) polling stays. Each poll is a cheap `readdir` of a small directory, and BTL-245 (mailbox) reworks delivery anyway.

## Measuring

`e2e/perf.spec.ts` runs only with `BUTLER_E2E_PERF=1`. It opens 3 sessions with the fake `claude`'s new `/fake-work <seconds> <ms>` command, which writes a tool call and about 2 KB of terminal output every 300 ms, waits on the home page and then on a ticket page for 30 s each, and reads the counters through `diag:snapshot`. The PR description has the before and after numbers on the Mac.
