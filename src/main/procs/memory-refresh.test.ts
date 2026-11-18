import { describe, expect, it } from "vitest";
import { emptyByClass } from "./proc-table";
import type { MonitorSample } from "./memory-monitor";
import { MEMORY_REFRESH_COOLDOWN_MS, MemoryRefresh, type MemoryRefreshDeps } from "./memory-refresh";

const MB = 1024;
function sample(terms: { termId: string; head: string; claudeMb: number }[]): MonitorSample {
  return {
    at: 0, table: new Map(), children: new Map(), system: null, snapshot: null as never,
    terms: terms.map((t) => ({ termId: t.termId, head: t.head, pid: 1, tree: [], summary: { totalKb: 0, count: 1, top: [], byClass: { ...emptyByClass(), claude: t.claudeMb * MB, mcp_other: 9999 * MB } } })),
  };
}

function setup(over: Partial<MemoryRefreshDeps> = {}) {
  let now = 0;
  const refreshed: string[] = [];
  const restarted: string[] = [];
  const state = { busy: false, refreshing: new Set<string>() };
  const d: MemoryRefreshDeps = {
    enabled: () => true,
    limitMb: () => 2048,
    precheck: () => (state.busy ? "busy" : null),
    refresh: async (h) => void refreshed.push(h),
    refreshing: (h) => state.refreshing.has(h),
    restart: async (h) => void restarted.push(h),
    now: () => now,
    log: () => {},
    ...over,
  };
  return { m: new MemoryRefresh(d), refreshed, restarted, state, advance: (ms: number) => void (now += ms) };
}

describe("MemoryRefresh (WS-M G)", () => {
  it("refreshes only on claude's own memory, and waits until the session can be refreshed", () => {
    const { m, refreshed, state } = setup();
    m.onSample(sample([{ termId: "t1", head: "a", claudeMb: 1000 }]));
    expect(refreshed).toEqual([]);
    state.busy = true;
    m.onSample(sample([{ termId: "t1", head: "a", claudeMb: 3000 }]));
    expect(refreshed).toEqual([]);
    state.busy = false;
    m.onSample(sample([{ termId: "t1", head: "a", claudeMb: 3000 }]));
    expect(refreshed).toEqual(["a"]);
  });

  it("restarts when the refresh did not help, once per six hours, and does not refresh again meanwhile", () => {
    const { m, refreshed, restarted, state, advance } = setup();
    m.onSample(sample([{ termId: "t1", head: "a", claudeMb: 3000 }]));
    state.refreshing.add("a");
    m.onSample(sample([{ termId: "t1", head: "a", claudeMb: 3000 }]));
    expect(restarted).toEqual([]);
    state.refreshing.clear();
    // 换新以后 head 变了，终端还是那个。
    m.onSample(sample([{ termId: "t1", head: "b", claudeMb: 1900 }]));
    expect(restarted).toEqual(["b"]);
    m.onSample(sample([{ termId: "t1", head: "b", claudeMb: 3000 }]));
    expect(refreshed).toEqual(["a"]);
    advance(MEMORY_REFRESH_COOLDOWN_MS);
    m.onSample(sample([{ termId: "t1", head: "b", claudeMb: 3000 }]));
    expect(refreshed).toEqual(["a", "b"]);
  });

  it("does not restart when the refresh brought it down", () => {
    const { m, restarted } = setup();
    m.onSample(sample([{ termId: "t1", head: "a", claudeMb: 3000 }]));
    m.onSample(sample([{ termId: "t1", head: "b", claudeMb: 500 }]));
    expect(restarted).toEqual([]);
  });

  it("only logs without a restart hook, and does nothing when off", () => {
    const logs: string[] = [];
    const a = setup({ restart: undefined, log: (m) => void logs.push(m) });
    a.m.onSample(sample([{ termId: "t1", head: "a", claudeMb: 3000 }]));
    a.m.onSample(sample([{ termId: "t1", head: "a", claudeMb: 3000 }]));
    expect(logs.at(-1)).toContain("still uses 3000 MB");
    const off = setup({ enabled: () => false });
    off.m.onSample(sample([{ termId: "t1", head: "a", claudeMb: 9000 }]));
    expect(off.refreshed).toEqual([]);
  });
});
