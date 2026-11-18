import { describe, expect, it } from "vitest";
import type { HibernateReason, Session } from "../../shared/types";
import type { MonitorSample } from "../procs/memory-monitor";
import { parsePsTable, type ProcTable } from "../procs/proc-table";
import type { HibernateCandidate, WaitInput } from "./hibernation";
import { Hibernator, WAKE_RETRY_MS, type HibernatorDeps } from "./hibernator";

const MIN = 60_000;
const L = {
  claude: "  110   100 300000 Mon Nov 17 09:01:00 2026 claude --resume h",
  mcp: "  111   110  80000 Mon Nov 17 09:01:01 2026 node /x/statecore-mcp.cjs",
  shell: "  112   110   3000 Mon Nov 17 09:01:02 2026 /bin/zsh -c pnpm dev",
  vite: "  113   112  90000 Mon Nov 17 09:01:03 2026 node /r/node_modules/.bin/vite",
  esbuild: "  114   113  20000 Mon Nov 17 09:01:04 2026 /r/node_modules/esbuild/bin/esbuild --service",
};
const table = (...lines: string[]): ProcTable => parsePsTable(lines.join("\n"));
const FULL = table(L.claude, L.mcp, L.shell, L.vite, L.esbuild);

const session = (over: Partial<Session> = {}): Session => ({
  id: "h", ticketKey: "T-1", cwd: "/w", origin: "butler", gitBranch: null, firstPrompt: "hi", lastActivityAt: 0, waitingForInput: true, replacedBy: null,
  dismissed: false, createdAt: 0, repoId: 1, coordinator: false, spawnedBy: null, featureId: null, fixesSession: null, epicId: null, model: null, butler: false,
  lessonRunId: null, hibernatedAt: null, hibernateReason: null, pinned: false, wakeError: null, wakeErrorAt: null, ...over,
});

function setup(o: { tables?: ProcTable[]; settings?: Partial<Record<string, unknown>>; open?: HibernatorDeps["open"] } = {}) {
  let now = 100 * MIN;
  const rows = new Map<string, Session>([["h", session()]]);
  const open = new Set(["h"]);
  const started = new Set<string>();
  const events: string[] = [];
  const kills: [number, boolean][] = [];
  const spared: [string, number[]][] = [];
  const released: string[] = [];
  const logs: string[] = [];
  const cand: Record<string, Partial<HibernateCandidate>> = {};
  const wait: Record<string, Partial<WaitInput>> = {};
  let reserved = 0;
  let notified = 0;
  const tables = o.tables ?? [FULL, table()];
  let ti = 0;
  const settings = { enabled: true, endWatchers: true, pressureOn: false, line: 10, minutes: { you: 30, ci: 20, review: 30, idle: 60 }, ...o.settings };
  const opens: string[] = [];
  const d: HibernatorDeps = {
    enabled: () => settings.enabled as boolean,
    minutes: (s) => (settings.minutes as Record<string, number>)[s],
    endWatchers: () => settings.endWatchers as boolean,
    pressureOn: () => settings.pressureOn as boolean,
    pressureLine: () => settings.line as number,
    terminals: () => [...open].flatMap((termId) => (rows.get(termId) ? [{ termId, head: rows.get(termId)! }] : [])),
    candidate: (t) => ({
      head: t.head, termId: t.termId, pinned: !!t.head.pinned, transcript: "present", activity: { working: false, background: false }, screenNeedsUser: false,
      draft: false, typing: false, autoInput: reserved > 0, refreshing: false, visible: false, childrenWorking: false, openedAt: 1, idleSince: 0, ...cand[t.head.id],
    }),
    waitInput: (h) => ({ needsYou: false, ciPending: false, reviewPending: false, ...wait[h.id] }),
    sessions: {
      head: (id) => rows.get(id) ?? null,
      setHibernated: (id, at, reason: HibernateReason, memKb) => {
        events.push(`hibernated:${reason}`);
        rows.set(id, { ...rows.get(id)!, hibernatedAt: at, hibernateReason: reason, memKb });
      },
      clearHibernated: (id) => rows.set(id, { ...rows.get(id)!, hibernatedAt: null, hibernateReason: null }),
      setWakeError: (id, error, at) => rows.set(id, { ...rows.get(id)!, wakeError: error, wakeErrorAt: at }),
    },
    readTable: async () => tables[Math.min(ti++, tables.length - 1)],
    pid: (termId) => (open.has(termId) ? 110 : null),
    isOpen: (termId) => open.has(termId),
    started: (termId) => started.has(termId),
    reserve: () => {
      reserved++;
      events.push("reserve");
      return () => {
        reserved--;
        events.push("release-reserve");
      };
    },
    endTerminal: (termId) => {
      events.push("end");
      open.delete(termId);
    },
    kill: (pid, force) => void kills.push([pid, force]),
    spare: (owner, procs) => void spared.push([owner, procs.map((p) => p.pid)]),
    release: (owner) => void released.push(owner),
    open:
      o.open ??
      (async (head) => {
        opens.push(head.id);
        open.add(head.id);
        h.opened(head.id);
        started.add(head.id);
        return { ok: true, termId: head.id };
      }),
    notify: () => void notified++,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    log: (m) => void logs.push(m),
  };
  const h = new Hibernator(d);
  return {
    h, rows, open, started, events, kills, spared, released, logs, cand, wait, opens, settings,
    advance: (ms: number) => (now += ms),
    now: () => now,
    notified: () => notified,
    reserved: () => reserved,
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("Hibernator.tick (WS-M B)", () => {
  it("hibernates a session idle past its state's minutes", async () => {
    const t = setup();
    t.cand.h = { idleSince: t.now() - 59 * MIN };
    t.h.tick();
    await flush();
    expect(t.rows.get("h")?.hibernatedAt ?? null).toBeNull();
    t.cand.h = { idleSince: t.now() - 60 * MIN };
    t.h.tick();
    await flush();
    await flush();
    expect(t.rows.get("h")).toMatchObject({ hibernateReason: "idle" });
  });

  it("uses the CI minutes while CI runs", async () => {
    const t = setup();
    t.cand.h = { idleSince: t.now() - 20 * MIN };
    t.wait.h = { ciPending: true };
    t.h.tick();
    await flush();
    await flush();
    expect(t.rows.get("h")).toMatchObject({ hibernateReason: "ci" });
  });

  it("does nothing when the switch is off, the minutes are 0, or a rule blocks it", async () => {
    const off = setup({ settings: { enabled: false } });
    off.h.tick();
    const zero = setup({ settings: { minutes: { you: 0, ci: 0, review: 0, idle: 0 } } });
    zero.h.tick();
    const pinned = setup();
    pinned.rows.set("h", session({ pinned: true }));
    pinned.h.tick();
    await flush();
    await flush();
    for (const t of [off, zero, pinned]) expect(t.events).toEqual([]);
  });
});

describe("Hibernator.hibernate", () => {
  it("marks the row before ending the tree, ends every descendant, forces survivors, and releases the reservation", async () => {
    // 5 秒后 MCP 还在：强制结束。
    const t = setup({ tables: [FULL, table(L.mcp)] });
    expect(await t.h.hibernate("h", "you")).toBe("hibernated");
    expect(t.events).toEqual(["reserve", "hibernated:you", "end", "release-reserve"]);
    expect(t.kills).toEqual([[111, false], [112, false], [113, false], [114, false], [111, true]]);
    expect(t.rows.get("h")?.memKb).toBe(300000 + 80000 + 3000 + 90000 + 20000);
    expect(t.reserved()).toBe(0);
    expect(t.logs[0]).toMatch(/hibernate h \(you\): idle \d+ min, freed ~\d+ MB/);
    expect(t.notified()).toBeGreaterThan(0);
  });

  it("keeps watchers and dev servers (and what they started) when hibernateEndWatchers is off", async () => {
    const t = setup({ settings: { endWatchers: false } });
    expect(await t.h.hibernate("h", "idle")).toBe("hibernated");
    expect(t.kills.map((k) => k[0])).toEqual([111, 112]);
    expect(t.spared).toEqual([["h", [113, 114]]]);
  });

  it("re-checks after reading the process table and stops if the session started working", async () => {
    const t = setup();
    const p = t.h.hibernate("h", "idle");
    t.cand.h = { activity: { working: true, background: false } };
    expect(await p).toBe("working");
    expect(t.events).toEqual([]);
    expect(t.kills).toEqual([]);
  });

  it("returns closed for a session without a terminal, and runs once when asked twice", async () => {
    const t = setup();
    t.open.clear();
    expect(await t.h.hibernate("h", "idle")).toBe("closed");
    const u = setup();
    const [a, b] = [u.h.hibernate("h", "idle"), u.h.hibernate("h", "idle")];
    expect(a).toBe(b);
    await a;
    expect(u.events.filter((e) => e === "end")).toHaveLength(1);
  });
});

describe("Hibernator.wake", () => {
  it("resumes through open, waits for SessionStart, and a second call shares the first", async () => {
    const t = setup();
    await t.h.hibernate("h", "ci");
    expect(t.h.isHibernated("h")).toBe(true);
    const [a, b] = [t.h.wake("h", "delivery"), t.h.wake("h", "delivery")];
    expect(a).toBe(b);
    expect(await a).toBe("woken");
    expect(t.opens).toEqual(["h"]);
    expect(t.rows.get("h")?.hibernatedAt).toBeNull();
    expect(t.released).toEqual(["h"]);
    expect(t.h.isHibernated("h")).toBe(false);
  });

  it("a session that isn't hibernated is left alone", async () => {
    const t = setup();
    expect(await t.h.wake("h", "delivery")).toBe("not_hibernated");
    expect(t.opens).toEqual([]);
  });

  it("falls back to a closed session with a wake error when claude exits before it starts, and holds off automatic wakes", async () => {
    const opens: string[] = [];
    const t = setup({
      open: async (head) => {
        opens.push(head.id);
        return { ok: true, termId: head.id }; // 终端没开起来（马上退出了）
      },
    });
    await t.h.hibernate("h", "ci");
    expect(await t.h.wake("h", "delivery")).toBe("failed");
    expect(t.rows.get("h")).toMatchObject({ hibernatedAt: null, wakeError: "claude --resume exited before it started" });
    expect(t.released).toEqual(["h"]);
    // 唤醒失败以后它就是普通的关着的 session：不再算休眠。
    expect(await t.h.wake("h", "delivery")).toBe("not_hibernated");
    t.rows.set("h", { ...t.rows.get("h")!, hibernatedAt: 1 });
    expect(await t.h.wake("h", "delivery")).toBe("cooldown");
    expect(await t.h.wake("h", "user")).toBe("failed");
    t.advance(WAKE_RETRY_MS);
    t.rows.set("h", { ...t.rows.get("h")!, hibernatedAt: 1 });
    expect(await t.h.wake("h", "delivery")).toBe("failed");
    expect(opens).toHaveLength(3);
  });

  it("gives up after 60 s without SessionStart, and when open refuses", async () => {
    const t = setup({
      open: async (head) => {
        t.open.add(head.id);
        return { ok: true, termId: head.id };
      },
    });
    await t.h.hibernate("h", "ci");
    expect(await t.h.wake("h", "delivery")).toBe("failed");
    expect(t.rows.get("h")?.wakeError).toBe("claude --resume did not start within 60 s");

    const u = setup({ open: async () => ({ ok: false, reason: "no_session" }) });
    await u.h.hibernate("h", "ci");
    expect(await u.h.wake("h", "delivery")).toBe("failed");
    expect(u.rows.get("h")).toMatchObject({ hibernatedAt: null, wakeError: "open failed: no_session" });
  });

  it("a passing reason (ticket busy, claude missing, wrong branch, a throw) keeps it hibernated and retries after the cooldown", async () => {
    let reason = "ticket_busy";
    const tries: string[] = [];
    const t = setup({
      open: async (head) => {
        tries.push(head.id);
        if (reason === "throw") throw new Error("boom");
        return { ok: false, reason };
      },
    });
    await t.h.hibernate("h", "ci");
    expect(await t.h.wake("h", "delivery")).toBe("failed");
    expect(t.rows.get("h")).toMatchObject({ wakeError: "open failed: ticket_busy" });
    expect(t.rows.get("h")?.hibernatedAt).not.toBeNull();
    expect(t.released).toEqual([]);
    expect(t.h.isHibernated("h")).toBe(true);
    // 冷却期内投递不再去开；用户点开照样试。
    expect(await t.h.wake("h", "delivery")).toBe("cooldown");
    reason = "throw";
    expect(await t.h.wake("h", "user")).toBe("failed");
    expect(t.rows.get("h")?.wakeError).toBe("open failed: error");
    t.advance(WAKE_RETRY_MS);
    reason = "claude_missing";
    expect(await t.h.wake("h", "delivery")).toBe("failed");
    expect(tries).toHaveLength(3);
    expect(t.rows.get("h")?.hibernatedAt).not.toBeNull();
  });

  it("opening a different session (another Butler control is running) counts as a failed wake, so deliveries stop waking it", async () => {
    const t = setup({
      open: async () => {
        t.open.add("b");
        t.started.add("b");
        return { ok: true, termId: "b" };
      },
    });
    t.rows.set("b", session({ id: "b", ticketKey: null, butler: true }));
    await t.h.hibernate("h", "idle");
    expect(await t.h.wake("h", "delivery")).toBe("failed");
    expect(t.rows.get("h")).toMatchObject({ hibernatedAt: null, wakeError: "another session (b) was opened instead" });
    expect(t.h.isHibernated("h")).toBe(false);
  });

  it("a woken session isn't hibernated again for 10 minutes", async () => {
    const t = setup();
    await t.h.hibernate("h", "idle");
    await t.h.wake("h", "delivery");
    t.cand.h = { idleSince: 0 };
    t.h.tick();
    await flush();
    expect(t.events.filter((e) => e.startsWith("hibernated"))).toHaveLength(1);
    t.advance(10 * MIN);
    t.h.tick();
    await flush();
    await flush();
    expect(t.events.filter((e) => e.startsWith("hibernated"))).toHaveLength(2);
  });
});

describe("Hibernator.opened", () => {
  it("any open of the chain clears hibernation and the last wake error", async () => {
    const t = setup();
    await t.h.hibernate("h", "idle");
    t.rows.set("h", { ...t.rows.get("h")!, wakeError: "x", wakeErrorAt: 1 });
    t.h.opened("h");
    expect(t.rows.get("h")).toMatchObject({ hibernatedAt: null, wakeError: null, wakeErrorAt: null });
    expect(t.released).toEqual(["h"]);
  });
});

describe("Hibernator.hibernate when the terminal does not exit", () => {
  it("forces the root once more and, if the terminal is still open, rolls the hibernation back", async () => {
    const t = setup({ tables: [FULL, FULL] });
    let exits = false;
    // pty.kill 没让终端退出（信号没送到）。
    const d = (t.h as unknown as { d: HibernatorDeps }).d;
    d.endTerminal = () => void t.events.push("end");
    d.kill = (pid, force) => {
      t.kills.push([pid, force]);
      if (exits && pid === 110 && force) t.open.delete("h");
    };
    expect(await t.h.hibernate("h", "idle")).toBe("busy");
    expect(t.rows.get("h")?.hibernatedAt).toBeNull();
    expect(t.released).toEqual(["h"]);
    expect(t.logs.some((l) => l.includes("did not exit"))).toBe(true);

    exits = true;
    expect(await t.h.hibernate("h", "idle")).toBe("hibernated");
    expect(t.rows.get("h")?.hibernatedAt).not.toBeNull();
  });
});

describe("Hibernator.forget", () => {
  it("a hidden hibernated session is no longer hibernated and its watchers are released", async () => {
    const t = setup();
    await t.h.hibernate("h", "idle");
    t.h.forget("h");
    expect(t.rows.get("h")?.hibernatedAt).toBeNull();
    expect(t.released).toEqual(["h"]);
    expect(await t.h.wake("h", "delivery")).toBe("not_hibernated");
  });
});

describe("Hibernator.restart (WS-M G)", () => {
  it("hibernates for memory and wakes right away", async () => {
    const t = setup();
    expect(await t.h.restart("h")).toBe("woken");
    expect(t.events).toContain("hibernated:memory");
    expect(t.opens).toEqual(["h"]);
  });
});

describe("memory pressure (WS-M C)", () => {
  const sample = (freePercent: number): MonitorSample =>
    ({ at: 0, table: new Map(), children: new Map(), terms: [], system: { totalKb: 100, freeKb: freePercent, freePercent, source: "os" }, snapshot: null }) as unknown as MonitorSample;

  it("hibernates one session per sample while under the line, with hysteresis, even with B off", async () => {
    const t = setup({ settings: { enabled: false, pressureOn: true } });
    t.cand.h = { idleSince: t.now() - 6 * MIN };
    t.h.onSample(sample(12));
    await flush();
    expect(t.events).toEqual([]);
    t.h.onSample(sample(8));
    await flush();
    await flush();
    expect(t.rows.get("h")?.hibernateReason).toBe("pressure");
  });

  it("stays under pressure until 5 points above the line", async () => {
    const t = setup({ settings: { pressureOn: true } });
    t.cand.h = { idleSince: t.now() - 6 * MIN };
    t.open.clear();
    t.h.onSample(sample(8));
    t.open.add("h");
    t.h.onSample(sample(13));
    await flush();
    await flush();
    expect(t.rows.get("h")?.hibernateReason).toBe("pressure");
    const u = setup({ settings: { pressureOn: true } });
    u.cand.h = { idleSince: u.now() - 6 * MIN };
    u.open.clear();
    u.h.onSample(sample(8));
    u.open.add("h");
    u.h.onSample(sample(15));
    await flush();
    expect(u.events).toEqual([]);
  });
});
