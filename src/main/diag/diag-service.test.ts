import { afterEach, describe, expect, it } from "vitest";
import { DiagService } from "./diag-service";
import { perfStats } from "./perf-stats";

const info = () => ({
  version: "0", versions: {}, platform: "darwin", arch: "arm64", osRelease: "x", cpus: { model: "m", count: 1 },
  memory: { totalMb: 1, freeMb: 1 }, appMetrics: [], mainMemory: {},
});

let svc: DiagService | null = null;
afterEach(() => {
  svc?.stop();
  svc = null;
});

describe("DiagService", () => {
  it("off mode records nothing and installs no global stats", () => {
    svc = new DiagService({ mode: "off", now: () => 0, log: () => undefined, logFile: "/nope", info, pickSavePath: async () => null, writeFile: async () => undefined });
    svc.start();
    svc.send("state:changed", []);
    expect(svc.snapshot()).toBeNull();
    expect(perfStats()).toBeNull();
  });

  it("counts pty:data bytes from the data argument", () => {
    svc = new DiagService({ mode: "on", now: () => 0, log: () => undefined, logFile: "/nope", info, pickSavePath: async () => null, writeFile: async () => undefined });
    svc.start();
    svc.send("pty:data", ["t1", "abcd"]);
    svc.send("state:changed", [{ scopes: ["data"] }]);
    expect(svc.snapshot()?.current.sends).toEqual({ "pty:data": { n: 1, bytes: 4 }, "state:changed": { n: 1, bytes: 0 } });
    expect(perfStats()).toBe(svc.stats);
  });

  it("export writes JSON to the picked path, and a cancel writes nothing", async () => {
    const written: Array<[string, string]> = [];
    let pick: string | null = null;
    svc = new DiagService({ mode: "on", now: () => 0, log: () => undefined, logFile: "/nope", info, pickSavePath: async () => pick, writeFile: async (p, t) => void written.push([p, t]) });
    expect(await svc.export()).toBeNull();
    expect(written).toHaveLength(0);
    pick = "/x/diag.json";
    expect(await svc.export()).toBe("/x/diag.json");
    expect(JSON.parse(written[0][1]).kind).toBe("butler-diagnostics");
  });
});

describe("DiagService measure", () => {
  it("snapshot(true) starts a fresh measurement of sends", () => {
    let t = 0;
    svc = new DiagService({ mode: "on", now: () => t, log: () => undefined, logFile: "/nope", info, pickSavePath: async () => null, writeFile: async () => undefined });
    svc.start();
    svc.send("state:changed", []);
    svc.snapshot(true);
    t = 5000;
    svc.send("state:changed", []);
    svc.send("state:changed", []);
    const m = svc.snapshot()!.measure;
    expect(m.sinceMs).toBe(5000);
    expect(m.sends["state:changed"].n).toBe(2);
  });
});

describe("DiagService measure: invokes and CPU", () => {
  it("counts invokes and CPU seconds since the last reset", () => {
    let cpu = { Browser: 1, Tab: 2 };
    svc = new DiagService({ mode: "on", now: () => 0, log: () => undefined, logFile: "/nope", info, pickSavePath: async () => null, writeFile: async () => undefined, cpuTimes: () => cpu });
    svc.start();
    svc.invoke("a", 3);
    svc.snapshot(true);
    svc.invoke("a", 4);
    svc.invoke("b", 6);
    cpu = { Browser: 1.5, Tab: 4.25 };
    const m = svc.snapshot()!.measure;
    expect(m.invokes).toEqual({ n: 2, totalMs: 10 });
    expect(m.cpuSec).toEqual({ Browser: 0.5, Tab: 2.25 });
    expect(svc.snapshot()!.current.invokes.a.n).toBe(2);
  });
});
