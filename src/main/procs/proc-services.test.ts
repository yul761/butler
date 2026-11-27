import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemorySamplesRepo } from "../db/memory-samples-repo";
import { SessionsRepo } from "../db/sessions-repo";
import { SettingsRepo } from "../db/settings-repo";
import { memDb, tempDir } from "../test-utils";
import { procTreeFrom } from "../sessions/proc-tree";
import { createProcServices, SHARED_TABLE_MS } from "./proc-services";

const PS = ["  100     1   100  5000   0:01.00 Mon Nov 17 09:00:00 2026 /usr/local/bin/claude", "  101   100   100  3000   0:02.50 Mon Nov 17 09:00:01 2026 /bin/zsh -c git push"].join("\n");

function services() {
  const db = memDb();
  const settings = new SettingsRepo(db);
  settings.set("memoryMonitor", "1");
  settings.set("orphanCleanup", "1");
  let t = 0;
  const runs: string[] = [];
  const ownedFile = join(tempDir("procs-"), "owned.json");
  const svc = createProcServices({
    settings,
    sessions: new SessionsRepo(db),
    samples: new MemorySamplesRepo(db),
    pty: { openIds: () => [], pid: () => null },
    activity: () => null,
    refresher: { precheck: () => null, refresh: async () => null, isRefreshing: () => false },
    appMetrics: () => [],
    windowShown: () => true,
    ownedFile,
    platform: "darwin",
    run: async (cmd) => (runs.push(cmd), PS),
    now: () => t,
    log: () => {},
    changed: () => {},
  });
  return { svc, runs, ownedFile, advance: (ms: number) => (t += ms) };
}

describe("the shared process table (BTL-275)", () => {
  it("the memory sample and the activity probes read one ps within 5 s; a later one reads again", async () => {
    const { svc, runs, advance } = services();
    await svc.monitor.tick();
    const probe = procTreeFrom(() => svc.table(), "darwin");
    // 原来是各起一个 `ps -o pid,ppid,cputime,args`：两个 session 的探测 + 采样 = 3 个 ps。
    expect(await probe(100, ["git push"])).toEqual({ cpuMs: 2500, liveShell: true });
    expect(await probe(100, [])).toEqual({ cpuMs: 2500, liveShell: null });
    expect(runs).toEqual(["ps"]);
    advance(SHARED_TABLE_MS);
    await probe(100, []);
    expect(runs).toEqual(["ps", "ps"]);
  });

  it("orphan cleanup still reads a fresh table right after a sample (it kills by what it reads)", async () => {
    const { svc, runs, ownedFile } = services();
    await svc.monitor.tick();
    expect(runs).toHaveLength(1);
    writeFileSync(ownedFile, JSON.stringify({ procs: [{ pid: 999, start: "Mon Nov 17 08:00:00 2026", args: "gone" }] }));
    await svc.orphans.sweepAtStartup();
    expect(runs).toHaveLength(2);
  });

  it("on Windows the activity probe still does not start PowerShell", async () => {
    let reads = 0;
    const probe = procTreeFrom(async () => (reads++, null), "win32");
    expect(await probe(1, ["x"])).toEqual({ cpuMs: null, liveShell: null });
    expect(reads).toBe(0);
  });
});
