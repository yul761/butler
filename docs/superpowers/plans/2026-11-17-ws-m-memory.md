# Workstream M plan: memory and responsiveness

Spec: `docs/superpowers/specs/2026-11-17-ws-m-memory-design.md`. Every task is test-first: write the failing test, make it pass, run `pnpm typecheck && pnpm lint && pnpm test`. UI, IPC and session tasks also run `pnpm e2e`.

## PR 1: `feat/ws-m-memory` (A, D, E, F, G, I, J)

1. **Settings and migration.**
   - Add the keys from spec §11 to `SETTING_DEFAULTS`, `EditableSettingKey`, `settings-values.ts` (validation and helpers), General settings UI, strings in both languages, and both config docs (the doc test enforces this).
   - Migration: `sessions.mem_kb`, `mem_at`, and the `memory_samples` table.
2. **Process table** (`src/main/procs/proc-table.ts`): `ps` and PowerShell readers, a parser for each, `classify`, `treeOf(root)`, and `sumByClass`. Fixture tests for both platforms.
3. **Memory monitor** (`src/main/procs/memory-monitor.ts`):
   - sample every 60 s: session trees, `getAppMetrics`, and system free memory (`system-memory.ts`: macOS `memory_pressure` / `vm_stat`, `os.freemem` elsewhere);
   - keep the latest sample, write history every 5th sample, update `sessions.mem_kb`, prune after 14 days.
4. **Now page:** a memory field on each session row, a breakdown popover, and a header card with a 24 h sparkline. IPC: `memory:history`.
5. **D, TerminalPane:** mount the xterm only when visible, dispose it when hidden, scrollback 3000, and report `pty:visible`. Main keeps `visibleTerms`. e2e test.
6. **E, priority** (`src/main/procs/priority.ts`): taskpolicy on macOS; setPriority plus EcoQoS via PowerShell on Windows. Track which pids were changed, and revert them. The monitor drives it each sample.
7. **F, orphans** (`src/main/procs/orphans.ts`): record the descendants of each sample, sweep them after a terminal exits, persist `owned.json`, sweep once at startup, and log what is killed.
8. **G, memory refresh:** the monitor calls `refresher.refresh(id, "auto")` when claude's RSS is above `refreshMemoryMb`. The follow-up restart hook is a no-op until PR 2.
9. **I:** the watcher and dev-server classes in the breakdown, plus the `watcher-policy.ts` hook and its guide line.
10. **J:** the tips section in settings (platform-specific) and in both config docs.

## PR 2: `feat/ws-m-hibernate` (B, C)

1. **Migration:** `hibernated_at`, `hibernate_reason`, `pinned`, `wake_error`, `wake_error_at`. Repo methods, `replace` copies `pinned`, and `SessionView` gets the new fields.
2. **`waitState`** and the exclusion predicate (pure), with unit tests for every rule. Extract `managedBy` / `childrenWorking` from cleanup into a shared helper.
3. **Hibernator:** `hibernate` (reserve, snapshot, mark, tree kill, spare watchers), `wake` (per-kind resume, wait for start and idle, `sessionStopped`), failure fallback with a notice, `restart` (G), and the `tick` driven by settings.
4. **Wiring:**
   - `handleExit` keeps waiting when the session is hibernated;
   - the `onOpened` hook clears hibernation;
   - the guard gets a `hibernated` block that triggers a wake, with strings in both languages;
   - CI `sessionFor`, inbox `openHeads`, and hold `isOpen` include hibernated sessions;
   - the task counts include hibernated sessions.
5. **C, pressure:** select one candidate per sample, with hysteresis.
6. **UI:** the "休眠" status on Now rows, ticket, feature and epic session lists, and TerminalPane; a pin toggle; a wake button; auto wake when the user switches to a hibernated pane; the wake-failure notice.
7. **Fake claude:** report the `--resume` context and add `/fake-recall`. e2e: hibernate, then a CI result wakes the session, it delivers, and the recall shows the original context.

## PR 3: `feat/ws-m-mcp-hub` (H)

1. `src/main/gateway/loopback-mcp.ts`: a 127.0.0.1-only listener with Host and Origin checks, token routing, JSON responses, 405 for GET and DELETE, and 202 for notifications. Unit tests.
2. `memory-mcp/hub-entry.ts`: a stdin route table, StateCore backends per scope, reproduced tools, and `SessionsServer` per route. Contract test against the real statecore-mcp.
3. Build script and packaging verification for `mcp-hub.cjs`. Allow-list `hub-entry.ts` in the lint config for StateCore and the gateway public module.
4. Main side, `mcp-hub.ts`: lazy start, restart with backoff on the same port, re-sending routes, stdio fallback, and per-terminal config files when `sharedMcp` is on. Remove a terminal's routes when it exits.
5. Fake claude: `type: "http"` entries in `/fake-mcp`. e2e with `sharedMcp` on: ask_user and report go through the hub.
