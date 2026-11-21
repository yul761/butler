import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDiagnostics, readLogTail } from "./diag-export";
import { PerfStats } from "./perf-stats";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "diag-"));
  dirs.push(d);
  return d;
};

describe("readLogTail", () => {
  it("returns the last lines, dropping a partial first line when it starts mid-file", async () => {
    const f = join(tmp(), "main.log");
    writeFileSync(f, Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n");
    expect(await readLogTail(f, 3)).toEqual(["line 47", "line 48", "line 49"]);
    const tail = await readLogTail(f, 1000, 20);
    expect(tail[tail.length - 1]).toBe("line 49");
    expect(tail.every((l) => /^line \d+$/.test(l))).toBe(true);
  });

  it("returns [] for a missing file", async () => {
    expect(await readLogTail(join(tmp(), "nope.log"))).toEqual([]);
  });
});

describe("buildDiagnostics", () => {
  it("carries the perf windows and caps the log tail, and nothing else from sessions", () => {
    const s = new PerfStats({ now: () => 1000, log: () => undefined, mode: "on" });
    s.send("state:changed");
    const w = s.roll({ p50: 1, p99: 2, max: 3 });
    const d = buildDiagnostics({
      now: 0, version: "3.1.1", versions: { electron: "44" }, platform: "win32", arch: "x64", osRelease: "10.0", cpus: { model: "cpu", count: 8 },
      memory: { totalMb: 32000, freeMb: 4000 }, appMetrics: [], mainMemory: { rss: 1 }, mode: "on",
      current: s.current(), history: [w], logTail: Array.from({ length: 1500 }, (_, i) => `l${i}`),
    });
    expect(d.kind).toBe("butler-diagnostics");
    expect(d.logTail).toHaveLength(1000);
    expect(d.logTail[999]).toBe("l1499");
    expect(d.perf.history[0].sends["state:changed"].n).toBe(1);
    expect(Object.keys(d).sort()).toEqual(["app", "generatedAt", "kind", "logTail", "mainMemory", "perf", "processes", "schema", "system"]);
  });
});
