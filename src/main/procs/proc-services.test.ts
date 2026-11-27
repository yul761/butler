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
    let fresh = 0;
    const probe = procTreeFrom(() => svc.table(), "darwin", async () => (fresh++, null));
    // 原来是各起一个 `ps -o pid,ppid,cputime,args`：两个 session 的 CPU 探测 + 采样 = 3 个 ps。
    expect(await probe(100, [])).toEqual({ cpuMs: 2500, liveShell: null });
    expect(await probe(200, [])).toEqual({ cpuMs: 0, liveShell: null });
    expect(runs).toEqual(["ps"]);
    expect(fresh).toBe(0);
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

  it("asking whether a background shell is still alive reads a fresh table: a shared one may predate the shell, and 'gone' is never re-asked", async () => {
    const before = new Map([[100, { pid: 100, ppid: 1, rssKb: 1, cpuMs: 1000, start: "s", args: "claude" }]]);
    const after = new Map([...before, [101, { pid: 101, ppid: 100, rssKb: 1, cpuMs: 0, start: "s", args: "/bin/zsh -c npm run dev" }]]);
    const probe = procTreeFrom(async () => ({ at: 0, table: before }), "darwin", async () => ({ at: 1, table: after }));
    expect(await probe(100, ["npm run dev"])).toEqual({ cpuMs: 0, liveShell: true });
  });

  it("the same session probed twice on one shared table reads fresh the second time (a CPU delta of 0 would look quiet)", async () => {
    const shared = new Map([[100, { pid: 100, ppid: 1, rssKb: 1, cpuMs: 1000, start: "s", args: "claude" }], [101, { pid: 101, ppid: 100, rssKb: 1, cpuMs: 10, start: "s", args: "node" }]]);
    const later = new Map([...shared, [101, { pid: 101, ppid: 100, rssKb: 1, cpuMs: 900, start: "s", args: "node" }]]);
    let fresh = 0;
    const probe = procTreeFrom(async () => ({ at: 0, table: shared }), "darwin", async () => (fresh++, { at: 1, table: later }));
    expect((await probe(100, [])).cpuMs).toBe(10);
    expect((await probe(100, [])).cpuMs).toBe(900);
    expect(fresh).toBe(1);
    expect((await probe(200, [])).cpuMs).toBe(0);
    expect(fresh).toBe(1);
  });

  it("a third probe within the shared table's life does not go back to the older shared table (the CPU reading would go backwards)", async () => {
    const cpu = (ms: number) => new Map([[100, { pid: 100, ppid: 1, rssKb: 1, cpuMs: 0, start: "s", args: "claude" }], [101, { pid: 101, ppid: 100, rssKb: 1, cpuMs: ms, start: "s", args: "node" }]]);
    const s0 = { at: 0, table: cpu(10) };
    let t = 1000;
    const freshReads: number[] = [];
    const probe = procTreeFrom(async () => s0, "darwin", async () => {
      t += 1000;
      freshReads.push(t);
      return { at: t, table: cpu(t) };
    });
    const readings = [];
    for (let i = 0; i < 3; i++) readings.push((await probe(100, [])).cpuMs!);
    expect(readings).toEqual([10, 2000, 3000]);
    expect(freshReads).toHaveLength(2);
    // 共用表换成更新的一张以后照旧用它，不现读
    const s1 = { at: 10_000, table: cpu(5000) };
    const probe2 = procTreeFrom(async () => s1, "darwin", async () => (freshReads.push(-1), null));
    expect((await probe2(100, [])).cpuMs).toBe(5000);
    expect(freshReads).toHaveLength(2);
  });

  it("on Windows the activity probe still does not start PowerShell", async () => {
    let reads = 0;
    const probe = procTreeFrom(async () => (reads++, null), "win32");
    expect(await probe(1, ["x"])).toEqual({ cpuMs: null, liveShell: null });
    expect(reads).toBe(0);
  });
});
