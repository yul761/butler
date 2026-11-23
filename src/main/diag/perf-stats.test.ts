import { describe, expect, it } from "vitest";
import { diagMode, PerfStats, perfOp, perfOpAsync, setPerfStats } from "./perf-stats";

function make(mode: "on" | "verbose" = "on") {
  let t = 0;
  const lines: string[] = [];
  const s = new PerfStats({ now: () => t, log: (l) => lines.push(l), mode });
  return { s, lines, at: (v: number) => (t = v) };
}

describe("diagMode", () => {
  it("is on by default, off with 0, verbose with verbose", () => {
    expect(diagMode({})).toBe("on");
    expect(diagMode({ SHIPHERD_PERF_DIAG: "0" })).toBe("off");
    expect(diagMode({ SHIPHERD_PERF_DIAG: "off" })).toBe("off");
    expect(diagMode({ SHIPHERD_PERF_DIAG: "verbose" })).toBe("verbose");
  });
});

describe("PerfStats", () => {
  it("counts sends per channel with bytes", () => {
    const { s } = make();
    s.send("state:changed");
    s.send("state:changed");
    s.send("pty:data", 100);
    s.send("pty:data", 50);
    expect(s.current().sends).toEqual({ "state:changed": { n: 2, bytes: 0 }, "pty:data": { n: 2, bytes: 150 } });
  });

  it("times invokes and logs a slow one once per channel per window", () => {
    const { s, lines } = make();
    s.invoke("turn:board", 5);
    s.invoke("turn:board", 30);
    s.invoke("turn:board", 40);
    expect(s.current().invokes["turn:board"]).toEqual({ n: 3, totalMs: 75, maxMs: 40 });
    expect(lines.filter((l) => l.includes("perf-slow: ipc turn:board"))).toHaveLength(1);
  });

  it("times ops and logs a slow one once per name per window", () => {
    const { s, lines } = make();
    s.op("findTranscript", 10);
    s.op("findTranscript", 80);
    s.op("findTranscript", 90);
    expect(s.current().ops.findTranscript).toEqual({ n: 3, totalMs: 180, maxMs: 90 });
    expect(lines.filter((l) => l.includes("perf-slow: op findTranscript"))).toHaveLength(1);
  });

  it("adds renderer reports up", () => {
    const { s } = make();
    s.renderer({ longTasks: 2, totalMs: 120, maxMs: 80, xterm: "webgl" });
    s.renderer({ longTasks: 1, totalMs: 60, maxMs: 60 });
    expect(s.current().renderer).toEqual({ longTasks: 3, totalMs: 180, maxMs: 80, xterm: "webgl" });
  });

  it("ignores malformed renderer reports", () => {
    const { s } = make();
    s.renderer({ longTasks: "x", totalMs: -1 } as never);
    s.renderer(null as never);
    expect(s.current().renderer).toEqual({ longTasks: 0, totalMs: 0, maxMs: 0, xterm: null });
  });

  it("roll closes the window into history, keeps at most keep windows, and starts a fresh one", () => {
    const { s, at } = make();
    for (let i = 0; i < 65; i++) {
      s.send("state:changed");
      at((i + 1) * 60_000);
      s.roll({ p50: 1, p99: 2, max: 3 });
    }
    const h = s.history();
    expect(h).toHaveLength(60);
    expect(h[h.length - 1].end).toBe(65 * 60_000);
    expect(h[h.length - 1].eld).toEqual({ p50: 1, p99: 2, max: 3 });
    expect(s.current().sends).toEqual({});
  });

  it("an idle window writes no perf line unless verbose", () => {
    const quiet = make();
    quiet.s.send("state:changed");
    quiet.s.roll({ p50: 1, p99: 10, max: 20 });
    expect(quiet.lines.filter((l) => l.startsWith("perf:"))).toHaveLength(0);

    const verbose = make("verbose");
    verbose.s.roll({ p50: 1, p99: 10, max: 20 });
    expect(verbose.lines.filter((l) => l.startsWith("perf:"))).toHaveLength(1);
  });

  it("a busy window writes one perf line with the numbers", () => {
    const { s, lines } = make();
    s.send("state:changed");
    s.send("pty:data", 2048);
    s.op("turn.board", 60);
    s.renderer({ longTasks: 1, totalMs: 70, maxMs: 70 });
    s.roll({ p50: 2, p99: 80, max: 120 });
    const line = lines.find((l) => l.startsWith("perf:"));
    expect(line).toContain("eld p50=2 p99=80 max=120");
    expect(line).toContain("state:changed=1");
    expect(line).toContain("pty:data=1/2KB");
    expect(line).toContain("turn.board n=1 t=60 max=60");
    expect(line).toContain("longtask n=1 t=70 max=70");
  });

  it("windows with a high event loop p99 alone count as busy", () => {
    const { s, lines } = make();
    s.roll({ p50: 2, p99: 60, max: 70 });
    expect(lines.filter((l) => l.startsWith("perf:"))).toHaveLength(1);
  });
});

describe("perfOp", () => {
  it("is a pass-through without stats and records with stats", async () => {
    setPerfStats(null);
    expect(perfOp("x", () => 3)).toBe(3);
    const { s } = make();
    setPerfStats(s);
    try {
      expect(perfOp("x", () => 4)).toBe(4);
      expect(await perfOpAsync("y", async () => 5)).toBe(5);
      expect(() => perfOp("z", () => {
        throw new Error("boom");
      })).toThrow("boom");
      expect(s.current().ops.x.n).toBe(1);
      expect(s.current().ops.y.n).toBe(1);
      expect(s.current().ops.z.n).toBe(1);
    } finally {
      setPerfStats(null);
    }
  });
});
