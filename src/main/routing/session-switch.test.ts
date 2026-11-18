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
    onSwitched: (id, from, to) => calls.push(`switched ${id} ${from} ${to}`),
    ...over,
  });
  return { sw, calls, row: () => row, tick: (ms: number) => void (now += ms) };
}

describe("SessionModelSwitcher", () => {
  it("a failed reopen puts the stored model back", async () => {
    const { sw, calls, row } = setup({ reopen: async () => ({ ok: false, reason: "no_repo" as const }) });
    sw.noteLimit("s1", { kind: "usage_limit", resetsAt: null, message: "limit reached" }, 1_000);
    expect(await sw.switch("s1")).toMatchObject({ ok: false, reason: "open_failed" });
    expect(calls).toEqual(["kill s1", "set M1", "set H1"]);
    expect(row().model).toBe("H1");
    expect(sw.views()).toHaveLength(1);
  });

  it("shows the limit on the row with the next model, then switches with --resume on it", async () => {
    const { sw, calls, row, tick } = setup();
    sw.noteLimit("s1", { kind: "usage_limit", resetsAt: null, message: "limit reached" }, 1_000);
    expect(sw.views()).toEqual([expect.objectContaining({ sessionId: "s1", model: "H1", next: "M1", switching: false })]);
    expect(calls).toEqual([]);
    expect(await sw.switch("s1")).toEqual({ ok: true, model: "M1", termId: "s1" });
    expect(calls).toEqual(["kill s1", "set M1", "reopen s1 M1", "switched s1 H1 M1"]);
    expect(row().model).toBe("M1");
    expect(sw.views()).toEqual([]);
    // 恢复后又读到换之前那条报错：不算 M1 撞限。之后的新报错照常提示。
    expect(sw.staleHit("s1", 1_000)).toBe(true);
    sw.noteLimit("s1", { kind: "usage_limit", resetsAt: null, message: "limit reached" }, 1_000);
    expect(sw.views()).toEqual([]);
    tick(5_000);
    sw.noteLimit("s1", { kind: "rate_limit", resetsAt: null, message: "again" }, 6_000);
    expect(sw.views()).toEqual([expect.objectContaining({ model: "M1", kind: "rate_limit" })]);
  });

  it("auto-switch (off by default) switches right away", async () => {
    const { sw, calls } = setup({ autoSwitch: () => true });
    sw.noteLimit("s1", { kind: "rate_limit", resetsAt: null, message: "x" }, 1_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["kill s1", "set M1", "reopen s1 M1", "switched s1 H1 M1"]);
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
