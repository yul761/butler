import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { migrate } from "../db/database";
import { RoutingRepo } from "../db/routing-repo";
import { ModelHealth, PROBE_RETRY_MS } from "./health";

function setup(start = 1_000_000) {
  const db = memDb();
  migrate(db);
  const repo = new RoutingRepo(db);
  let now = start;
  const timers: { fn: () => void; at: number }[] = [];
  const probes: string[] = [];
  let changes = 0;
  const make = () =>
    new ModelHealth({
      repo, now: () => now, onChange: () => void changes++, onProbeDue: (m) => void probes.push(m),
      setTimer: (fn, ms) => {
        const t = { fn, at: now + ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        const i = timers.indexOf(t as (typeof timers)[number]);
        if (i >= 0) timers.splice(i, 1);
      },
    });
  const h = make();
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((a, b) => a.at - b.at)) {
      if (t.at <= now && timers.includes(t)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    }
  };
  return { h, repo, make, advance, probes, now: () => now, changes: () => changes };
}

describe("ModelHealth", () => {
  it("unknown models are usable", () => {
    const { h } = setup();
    expect(h.usable("x")).toBe(true);
    expect(h.recoversAt("x")).toBeNull();
  });

  it("a known reset recovers on its own", () => {
    const s = setup();
    s.h.report("a", { kind: "usage_limit", resetsAt: s.now() + 60_000, message: "limit" });
    expect(s.h.usable("a")).toBe(false);
    expect(s.h.usable("b")).toBe(true);
    s.advance(60_000 + 60_000);
    expect(s.h.usable("a")).toBe(true);
    expect(s.h.view()[0]).toMatchObject({ model: "a", state: "ok" });
    expect(s.probes).toEqual([]);
  });

  it("without a reset: backoff, then a probe decides", () => {
    const s = setup();
    s.h.report("a", { kind: "rate_limit", resetsAt: null, message: "429" });
    expect(s.h.get("a").until).toBe(s.now() + 10 * 60_000);
    s.advance(10 * 60_000);
    expect(s.probes).toEqual(["a"]);
    expect(s.h.get("a").state).toBe("probing");
    expect(s.h.usable("a")).toBe(false);
    // Probe hits the limit again: next backoff step (20 min).
    s.h.probeResult("a", { ok: false, hit: { kind: "rate_limit", resetsAt: null, message: "429" } });
    expect(s.h.get("a")).toMatchObject({ state: "limited", until: s.now() + 20 * 60_000 });
    s.advance(20 * 60_000);
    expect(s.probes).toEqual(["a", "a"]);
    s.h.probeResult("a", { ok: true });
    expect(s.h.usable("a")).toBe(true);
    expect(s.h.get("a").backoffStep).toBe(0);
  });

  it("a probe that fails for another reason tries again later", () => {
    const s = setup();
    s.h.report("a", { kind: "rate_limit", resetsAt: null, message: "429" });
    s.advance(10 * 60_000);
    s.h.probeResult("a", { ok: false, hit: null });
    expect(s.h.get("a")).toMatchObject({ state: "probing", until: s.now() + PROBE_RETRY_MS });
    s.advance(PROBE_RETRY_MS);
    expect(s.probes).toEqual(["a", "a"]);
  });

  it("model_unavailable waits an hour", () => {
    const s = setup();
    s.h.report("a", { kind: "model_unavailable", resetsAt: null, message: "404" });
    expect(s.h.get("a")).toMatchObject({ state: "unavailable", until: s.now() + 3_600_000 });
  });

  it("duplicate hits within a minute do not push the backoff", () => {
    const s = setup();
    s.h.report("a", { kind: "rate_limit", resetsAt: null, message: "x" });
    s.advance(10_000);
    s.h.report("a", { kind: "rate_limit", resetsAt: null, message: "x" });
    expect(s.h.get("a").backoffStep).toBe(1);
  });

  it("a success that started before the hit does not clear it", () => {
    const s = setup();
    const before = s.now() - 5;
    s.h.report("a", { kind: "rate_limit", resetsAt: null, message: "x" });
    s.h.noteSuccess("a", before);
    expect(s.h.usable("a")).toBe(false);
    s.h.noteSuccess("a", s.now());
    expect(s.h.usable("a")).toBe(true);
  });

  it("counts consecutive failures until a success", () => {
    const s = setup();
    expect(s.h.noteFailure("a", "boom")).toEqual({ count: 1, since: s.now() });
    s.advance(5);
    expect(s.h.noteFailure("a", "boom").count).toBe(2);
    s.h.noteSuccess("a", s.now());
    expect(s.h.get("a").consecutiveFailures).toBe(0);
  });

  it("survives a restart, and an expired probe-needed state probes at start", () => {
    const s = setup();
    s.h.report("a", { kind: "rate_limit", resetsAt: null, message: "x" });
    s.h.dispose();
    s.advance(11 * 60_000);
    const again = s.make();
    expect(again.usable("a")).toBe(false);
    s.advance(0);
    expect(s.probes).toEqual(["a"]);
  });

  it("clear forgets a model", () => {
    const s = setup();
    s.h.report("a", { kind: "rate_limit", resetsAt: null, message: "x" });
    s.h.clear("a");
    expect(s.h.usable("a")).toBe(true);
    expect(s.repo.health()).toEqual([]);
  });
});
