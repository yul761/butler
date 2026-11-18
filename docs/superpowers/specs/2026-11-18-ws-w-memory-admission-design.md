# Workstream W: memory admission for new sessions (design addendum)

Date: 2026-11-18. Base: `main` after #34. Master design: `2026-11-17-butler-3-design.md` (section 1: "memory pressure from many sessions is handled without limiting how many run"; section 5, row "Memory pressure (7.14 C)"). Separate from the CI-delivery addendum (`2026-11-18-ws-w-ci-delivery-design.md`, #39) so the two can merge independently.

## 1. What this changes

Until 2.1.0 the number of parallel sessions was capped by three constants in `shared/control.ts`: 6 terminals per ticket, 8 per feature, 4 running feature coordinators per epic. The user's rule (7.14) is that stalls are not to be fixed by limiting how many tasks run at once: **as many sessions as memory allows**. All three constants are gone. One check replaces them, applied wherever Butler opens a new terminal on a coordinator's behalf:

- `start_session` (ticket and feature coordinators),
- `start_feature` (epic session, including `create_feature` with `start`),
- a Butler-coordinator message to a coordinator that is closed (`send_message` opens it).

Sessions the user opens by hand are not gated: the user can see the machine and decides.

## 2. The check (`sessions/memory-admission.ts`)

```
available = reading.available − pending × estimate
admit  ⇔  available − estimate ≥ reserve   (and pressure ≠ critical, and the optional cap is not reached)
canStart = min( floor((available − reserve) / estimate), cap − running )
```

- **reserve** (`sessionMemoryReserveMb`, default 2048) and **estimate** (`sessionMemoryEstimateMb`, default 1024) are settings; both configuration documents describe them.
- **pending**: a session admitted in the last `PENDING_MS` (120 s) has not grown yet, so a burst of `start_session` calls would all see the same reading. Each admitted one is subtracted at the estimate until the window passes. A session that does not open (open failed, threw, or turned out already open) gives its slot back with `release()`.
- **pressure**: on macOS, `kern.memorystatus_vm_pressure_level` = 4 (critical) refuses whatever the numbers say. Warn (2) does not refuse: the numeric check already covers it, and refusing at warn would stop work on machines that sit at warn with plenty of reclaimable memory.
- **cap** (`sessionMaxRunning`, default 0 = off) is a safety net only, counting all open terminals.
- **Read failure** admits (only the cap applies) and logs. An error in measuring must not stop work.

Refusals tell the coordinator which rule fired and the numbers: available, needed, reserve, measured or setting, and how many just-opened sessions were subtracted (`ctlNoMemory`, `ctlMemoryPressure`, `ctlMaxRunning`, both languages). The successful results of `start_session` and `start_feature`, and every `list_sessions`, carry a `capacity` (`SessionCapacity` in `shared/control.ts`). The sessions MCP server renders it as one extra text line: "You can start N more sessions now (…)".

## 3. Reading available memory (`sessions/available-memory.ts`)

| Platform | Source | Why |
|----------|--------|-----|
| macOS | `vm_stat`: total − (wired + occupied by compressor + (anonymous − purgeable)) | Activity Monitor's "memory used". File-backed pages, free, speculative and purgeable come back without swapping. `os.freemem()` counts free pages only (often 2–3 GB on a 48 GB machine with 14 GB really available), so it is not used. |
| macOS fallback | `memory_pressure -Q` free percentage × total, then `os.freemem()` | Used only if `vm_stat` fails or its format changes (any needed field missing ⇒ next method). |
| Windows | `os.freemem()` | libuv calls `GlobalMemoryStatusEx` and returns `ullAvailPhys`, which is free plus standby, i.e. already available memory. |
| Linux | `os.freemem()` | libuv reads `MemAvailable` from `/proc/meminfo`. |

The commands run through `execText` with a 2 s timeout. The reading is behind `ReadDeps` (platform, run, totalmem, freemem), so the tests cover all three platforms and the fallbacks without depending on the machine's memory.

**Why not M's free + inactive.** Workstream M shows system memory as free percentage on the Now page, which is fine for display. For admission, counting inactive pages as available overstates it: inactive anonymous pages have to be compressed or swapped out to be reused, and that is exactly the stall this check exists to avoid. The two numbers can differ on screen; the admission line in `list_sessions` states its own source.

## 4. Using M's measurements (after #32 merges)

`AdmissionDeps.measuredSessionsKb()` returns the whole-process-tree size of each open session. When it returns anything, the estimate is their **mean** (`estimate: "measured"`) instead of the setting. The mean is used rather than the max, so one session running a dev server does not make every new session look that big. It is also used rather than the median, so a few large sessions still pull the estimate up. Hookup in `index.ts` once `MemoryMonitor` is on main:

```ts
measuredSessionsKb: () => openButlerHeads().flatMap((h) => {
  const m = memoryMonitor.memoryOf(h);
  // A session younger than PENDING_MS has not grown yet: leave it out so it does not pull the estimate down.
  return m && Date.now() - startedAt(h) >= PENDING_MS ? [m.totalKb] : [];
}),
```

Until then the setting is used, and nothing else changes.

## 5. Why the per-epic limit goes too

The 4-coordinator limit per epic was there for the same reason as the others: to protect the machine. A feature coordinator is a session like any other, and the memory check sees it like any other. Keeping a separate count would mean a 64 GB machine stops at 4 while an 8 GB one is protected anyway. The plan order is still respected: the epic guide tells the epic session to open features in the order the plan sets, and to wait when `start_feature` reports memory short.

## 6. Tests

- `available-memory.test.ts`: the vm_stat formula against a real 48 GB sample, missing fields, the fallbacks, Windows and Linux use `os.freemem()` without running commands.
- `memory-admission.test.ts`: admit, refuse on memory with the message's numbers, burst counting and the pending window, release, measured estimate, critical pressure, the cap on and off, read failure.
- Control layer: per-ticket, per-feature and per-epic caps are gone (more than the old numbers open), refusal with "not enough memory" opens no terminal, `capacity` on `start_session`, `start_feature` and `list_sessions`, an already running coordinator is not gated.
