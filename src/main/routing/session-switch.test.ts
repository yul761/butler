import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/types";
import { SessionModelSwitcher, SESSION_LIMIT_TTL_MS, type SessionSwitchDeps } from "./session-switch";

/** 只用到 id 和 model。 */
const session = (): Session => ({ id: "s1", model: "H1", ticketKey: "T-1" }) as unknown as Session;

function setup(over: Partial<SessionSwitchDeps> = {}) {
  let row: Session = { ...session(), model: "H1" };
  const open = new Set(["s1"]);
  const calls: string[] = [];
  let now = 1_000;
  const sw = new SessionModelSwitcher({
    head: (id) => (id === row.id ? row : null),
    setModel: (_id, m) => {
      calls.push(`set ${m}`);
      row = { ...row, model: m };
    },
    termIdOf: (id) => (open.has(id) ? id : null),
    kill: (t) => {
      calls.push(`kill ${t}`);
      open.delete(t);
    },
    running: (t) => open.has(t),
    reopen: async (h) => {
      calls.push(`reopen ${h.id} ${h.model}`);
      open.add(h.id);
      return { ok: true, termId: h.id, alreadyOpen: false };
    },
    nextModel: (m) => (m === "H1" ? "M1" : null),
    autoSwitch: () => false,
    now: () => now,
    sleep: async () => undefined,
    ...over,
  });
  return { sw, calls, row: () => row, tick: (ms: number) => void (now += ms) };
}

describe("SessionModelSwitcher", () => {
  it("shows the limit on the row with the next model, then switches with --resume on it", async () => {
    const { sw, calls, row } = setup();
    sw.noteLimit("s1", { kind: "usage_limit", resetsAt: null, message: "limit reached" }, 1_000);
    expect(sw.views()).toEqual([expect.objectContaining({ sessionId: "s1", model: "H1", next: "M1", switching: false })]);
    expect(calls).toEqual([]);
    expect(await sw.switch("s1")).toEqual({ ok: true, model: "M1", termId: "s1" });
    expect(calls).toEqual(["kill s1", "set M1", "reopen s1 M1"]);
    expect(row().model).toBe("M1");
    expect(sw.views()).toEqual([]);
  });

  it("auto-switch (off by default) switches right away", async () => {
    const { sw, calls } = setup({ autoSwitch: () => true });
    sw.noteLimit("s1", { kind: "rate_limit", resetsAt: null, message: "x" }, 1_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["kill s1", "set M1", "reopen s1 M1"]);
  });

  it("no next model, a terminal that will not exit, an expired hint", async () => {
    const a = setup({ nextModel: () => null });
    expect(await a.sw.switch("s1")).toEqual({ ok: false, reason: "no_next" });
    let clock = 0;
    const b = setup({ kill: () => undefined, now: () => (clock += 5_000) });
    expect(await b.sw.switch("s1")).toEqual({ ok: false, reason: "still_running" });
    expect(b.row().model).toBe("H1");
    const c = setup();
    c.sw.noteLimit("s1", { kind: "usage_limit", resetsAt: null, message: "x" }, 1_000);
    c.tick(SESSION_LIMIT_TTL_MS);
    expect(c.sw.views()).toEqual([]);
  });
});
