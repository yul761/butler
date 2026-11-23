import { describe, expect, it, vi } from "vitest";
import { MemorySamplesRepo } from "../db/memory-samples-repo";
import { memDb } from "../test-utils";
import { MemoryMonitor, type MemoryMonitorDeps, type MonitorSample, sampleIntervalMs, SAMPLE_INTERVAL_MS } from "./memory-monitor";
import { parsePsTable } from "./proc-table";

const PS = [
  "  100     1  50000 Mon Nov 17 09:00:00 2026 /Applications/Shipherd.app/Contents/MacOS/Shipherd",
  "  101   100 150000 Mon Nov 17 09:00:01 2026 /Applications/Shipherd.app/Contents/Frameworks/Shipherd Helper (Renderer).app/Contents/MacOS/Shipherd Helper (Renderer)",
  "  110   100 300000 Mon Nov 17 09:01:00 2026 /usr/local/bin/claude --resume abc",
  "  111   110  80000 Mon Nov 17 09:01:01 2026 /Applications/Shipherd.app/Contents/MacOS/Shipherd /x/memory-mcp/statecore-mcp.cjs",
  "  112   110  20000 Mon Nov 17 09:01:01 2026 node /x/some-mcp/server.js",
  "  120   100 200000 Mon Nov 17 09:01:00 2026 /usr/local/bin/claude --session-id def",
  "  130   100  40000 Mon Nov 17 09:05:00 2026 /usr/local/bin/claude -p --model haiku",
  "  131   130  10000 Mon Nov 17 09:05:01 2026 node /x/mcp.js",
  "  140   100   9000 Mon Nov 17 09:05:00 2026 /usr/bin/git fetch",
].join("\n");

function setup(over: Partial<MemoryMonitorDeps> = {}) {
  const db = memDb();
  const samples = new MemorySamplesRepo(db);
  const mem: Record<string, number> = {};
  let now = 1_000;
  let record = true;
  const d: MemoryMonitorDeps = {
    terms: () => [
      { termId: "t1", head: "h1", pid: 110 },
      { termId: "t2", head: "h2", pid: 120 },
      { termId: "t3", head: "gone", pid: 999 },
    ],
    appMetrics: () => [
      { pid: 100, type: "Browser", kb: 60000 },
      { pid: 101, type: "Tab", kb: 160000 },
    ],
    mainPid: 100,
    readTable: async () => parsePsTable(PS),
    readSystem: async () => ({ totalKb: 1000, freeKb: 250, freePercent: 25, source: "os" }),
    enabled: () => true,
    recordOn: () => record,
    sessions: { setMemory: (id, kb) => void (mem[id] = kb) },
    samples,
    now: () => now,
    log: () => {},
    changed: () => {},
    ...over,
  };
  const m = new MemoryMonitor(d);
  return { m, mem, samples, advance: (ms: number) => void (now += ms), setRecord: (v: boolean) => void (record = v) };
}

describe("MemoryMonitor", () => {
  it("sums each open session's tree and Shipherd's own processes, without counting a process twice", async () => {
    const { m, mem } = setup();
    const s = await m.tick();
    expect(s?.terms.map((t) => [t.head, t.summary.totalKb])).toEqual([["h1", 400000], ["h2", 200000]]);
    expect(m.memoryOf("h1")).toMatchObject({ totalKb: 400000, count: 3, at: 1000 });
    expect(m.memoryOf("gone")).toBeNull();
    expect(mem).toEqual({ h1: 400000, h2: 200000 });
    expect(m.snapshot()).toEqual({
      at: 1000,
      // Electron 报的主进程和渲染进程，加上无头 claude 那棵树（40000 + 10000）和 git（utility）。
      shipherdKb: 60000 + 160000 + 50000 + 9000,
      shipherd: { main: 60000, renderer: 160000, gpu: 0, utility: 9000, terminals: 0, headless: 50000, hub: 0 },
      sessionsKb: 600000,
      sessions: 2,
      shipherdMcpKb: 80000,
      system: { totalKb: 1000, freeKb: 250, freePercent: 25 },
    });
  });

  it("writes history on the first and every fifth sample and reads it back as points", async () => {
    const { m, samples, advance } = setup();
    for (let i = 0; i < 6; i++) {
      await m.tick();
      advance(60_000);
    }
    const ats = [...new Set(samples.since(0).map((r) => r.at))];
    expect(ats).toEqual([1000, 1000 + 5 * 60_000]);
    expect(m.history(0)).toEqual([
      { at: 1000, shipherdKb: 279000, sessionsKb: 600000, freePercent: 25 },
      { at: 301000, shipherdKb: 279000, sessionsKb: 600000, freePercent: 25 },
    ]);
  });

  it("prunes history older than 14 days", async () => {
    const { m, samples } = setup();
    samples.insertMany([{ at: -20 * 24 * 3600_000, kind: "shipherd", sessionId: null, totalKb: 1, detail: null }]);
    await m.tick();
    expect(samples.since(-Infinity).some((r) => r.totalKb === 1)).toBe(false);
  });

  it("still feeds the hooks but shows and stores nothing when the monitor setting is off", async () => {
    const { m, mem, samples, setRecord } = setup();
    setRecord(false);
    const seen: MonitorSample[] = [];
    m.onSample((s) => void seen.push(s));
    await m.tick();
    expect(seen.length).toBe(1);
    expect(m.snapshot()).toBeNull();
    expect(m.memoryOf("h1")).toBeNull();
    expect(mem).toEqual({});
    expect(samples.since(0)).toEqual([]);
  });

  it("tells the renderer after each sample it shows, before slow hooks finish, and once when the card goes away", async () => {
    // 「现在」页只在 stateChanged 时重取：采样不通知的话，比最后一个 hook 事件晚到的第一次采样要等一分钟才显示（Windows 上 PowerShell 冷启动就是这样）。
    let changed = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { m, setRecord } = setup({ changed: () => void changed++ });
    m.onSample(() => gate);
    const first = m.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(changed).toBe(1);
    release();
    await first;
    await m.tick();
    expect(changed).toBe(2);
    setRecord(false);
    await m.tick();
    expect(changed).toBe(3);
    await m.tick();
    expect(changed).toBe(3);
    const fail = setup({ readTable: async () => null, changed: () => void changed++ });
    await fail.m.tick();
    expect(changed).toBe(3);
  });

  it("does nothing when nothing needs samples, and skips a sample when ps fails", async () => {
    let reads = 0;
    const off = setup({ enabled: () => false, readTable: async () => (reads++, null) });
    expect(await off.m.tick()).toBeNull();
    expect(reads).toBe(0);
    const fail = setup({ readTable: async () => null });
    expect(await fail.m.tick()).toBeNull();
    expect(fail.m.snapshot()).toBeNull();
  });

  it("keeps going when a hook throws, and does not overlap samples", async () => {
    const logs: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { m } = setup({ log: (msg) => void logs.push(msg) });
    let calls = 0;
    m.onSample(async () => {
      calls++;
      await gate;
      throw new Error("boom");
    });
    const first = m.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(await m.tick()).toBeNull();
    release();
    expect(await first).not.toBeNull();
    expect(calls).toBe(1);
    expect(logs).toContain("memory sample hook failed");
  });

  it("samples again shortly after a terminal opens or exits, once for a burst, and after a sample that was running", async () => {
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      let gate: Promise<void> | null = null;
      let reads = 0;
      const { m } = setup({ soonGapMs: 0, readTable: async () => { reads++; if (gate) await gate; return parsePsTable(PS); } });
      m.soon(3_000);
      m.soon(3_000);
      await vi.advanceTimersByTimeAsync(2_999);
      expect(reads).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(reads).toBe(1);
      expect(m.snapshot()?.sessions).toBe(2);
      // 一次采样正在跑（比如每分钟那次刚开始读进程表）：它可能在终端开之前就读了表，所以跑完再补一次。
      gate = new Promise<void>((r) => (release = r));
      const running = m.tick();
      await vi.advanceTimersByTimeAsync(0);
      m.soon(10);
      await vi.advanceTimersByTimeAsync(10);
      expect(reads).toBe(2);
      gate = null;
      release();
      await running;
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(3);
      // 停了以后不再补采。
      m.soon(10);
      m.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(reads).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spaces out the extra samples: at most one per soonGapMs, later ones wait instead of being dropped (BTL-242)", async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      let now = 0;
      const { m } = setup({ soonGapMs: 20_000, now: () => now, readTable: async () => { reads++; return parsePsTable(PS); } });
      const step = async (ms: number) => {
        now += ms;
        await vi.advanceTimersByTimeAsync(ms);
      };
      m.soon(3_000);
      await step(3_000);
      expect(reads).toBe(1);
      // 5 秒后又开了一个终端：等到上一次之后满 20 秒才采。
      await step(5_000);
      m.soon(3_000);
      await step(3_000);
      expect(reads).toBe(1);
      await step(12_000);
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sampleIntervalMs (BTL-242)", () => {
  it("samples every 2 minutes on Windows, where each sample is a PowerShell process-table query", () => {
    expect(sampleIntervalMs("win32")).toBe(120_000);
    expect(sampleIntervalMs("darwin")).toBe(SAMPLE_INTERVAL_MS);
    expect(sampleIntervalMs("linux")).toBe(SAMPLE_INTERVAL_MS);
  });
});
