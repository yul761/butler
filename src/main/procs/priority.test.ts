import os from "node:os";
import { describe, expect, it } from "vitest";
import type { MonitorSample } from "./memory-monitor";
import { ecoScript, macBackend, PriorityManager, winBackend, type PriorityChange, type PriorityLevel } from "./priority";
import { classifyTree, parsePsTable, summarize, type ProcTable } from "./proc-table";

const PS = (extra = ""): string =>
  [
    "  110   100 300000 Mon Nov 17 09:01:00 2026 claude --resume a",
    "  111   110  80000 Mon Nov 17 09:01:01 2026 node /x/mcp.js",
    "  120   100 200000 Mon Nov 17 09:01:00 2026 claude --resume b",
    extra,
  ].join("\n");

function sample(table: ProcTable): MonitorSample {
  const terms = [
    { termId: "t1", head: "h1", pid: 110 },
    { termId: "t2", head: "h2", pid: 120 },
  ].flatMap((t) => {
    const tree = classifyTree(t.pid, table);
    return tree.length ? [{ ...t, tree, summary: summarize(tree) }] : [];
  });
  return { at: 0, table, children: new Map(), terms, system: null, snapshot: null as never };
}

function setup() {
  const calls: PriorityChange[][] = [];
  const state = { enabled: true, visible: new Set<string>(), idle: new Set<string>(["h1", "h2"]), exempt: new Set<string>() };
  const m = new PriorityManager({
    enabled: () => state.enabled,
    visible: (t) => state.visible.has(t),
    idle: (h) => state.idle.has(h),
    exempt: (h) => state.exempt.has(h),
    backend: async (changes) => {
      calls.push(changes);
      return new Map(changes.map((c) => [c.pid, c.to]));
    },
    log: () => {},
  });
  return { m, calls, state };
}

const levels = (calls: PriorityChange[][]): Record<number, PriorityLevel> => Object.fromEntries(calls.flat().map((c) => [c.pid, c.to]));

describe("PriorityManager (WS-M E)", () => {
  it("lowers invisible trees, more when they are idle, and leaves visible ones alone", async () => {
    const { m, calls, state } = setup();
    state.visible.add("t2");
    state.idle.delete("h1");
    await m.onSample(sample(parsePsTable(PS())));
    expect(levels(calls)).toEqual({ 110: 1, 111: 1 });
    calls.length = 0;
    state.idle.add("h1");
    await m.onSample(sample(parsePsTable(PS())));
    expect(levels(calls)).toEqual({ 110: 2, 111: 2 });
    calls.length = 0;
    await m.onSample(sample(parsePsTable(PS())));
    expect(calls).toEqual([]);
  });

  it("restores a tree right away when its terminal shows, and restores everything when switched off", async () => {
    const { m, calls, state } = setup();
    await m.onSample(sample(parsePsTable(PS())));
    expect(m.lowered()).toBe(3);
    calls.length = 0;
    await m.restoreTerm("t1");
    expect(levels(calls)).toEqual({ 110: 0, 111: 0 });
    expect(m.lowered()).toBe(1);
    state.enabled = false;
    calls.length = 0;
    await m.onSample(sample(parsePsTable(PS())));
    expect(levels(calls)).toEqual({ 120: 0 });
    expect(m.lowered()).toBe(0);
  });

  it("restores children that inherited a lowered priority after the last sample", async () => {
    const { m, calls, state } = setup();
    await m.onSample(sample(parsePsTable(PS())));
    calls.length = 0;
    // 降着的时候 claude 起了 npm run dev：它继承了降过的优先级。
    const withDev = parsePsTable(PS("  112   110  40000 Mon Nov 17 09:30:00 2026 /bin/zsh -c npm test"));
    await m.onSample(sample(withDev));
    expect(calls).toEqual([]);
    state.visible.add("t1");
    await m.onSample(sample(withDev));
    expect(levels(calls)).toEqual({ 110: 0, 111: 0, 112: 0 });
  });

  it("works out a restore when it runs, so a batch still in flight cannot undo it", async () => {
    const calls: PriorityChange[][] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const visible = new Set<string>();
    const m = new PriorityManager({
      enabled: () => true,
      visible: (t) => visible.has(t),
      idle: () => true,
      exempt: () => false,
      backend: async (changes) => {
        calls.push(changes);
        if (calls.length === 1) await gate;
        return new Map(changes.map((c) => [c.pid, c.to]));
      },
      log: () => {},
    });
    const table = parsePsTable(PS());
    const first = m.onSample(sample(table));
    // 第一批还在跑（Windows 的 EcoQoS），用户切到了 t1。
    await Promise.resolve();
    visible.add("t1");
    const restore = m.restoreTerm("t1");
    release();
    await Promise.all([first, restore]);
    expect(levels(calls.slice(1))).toEqual({ 110: 0, 111: 0 });
    expect(m.lowered()).toBe(1);
  });

  it("lowers a dev server and what it started by one level at most", async () => {
    const { m, calls } = setup();
    const t = parsePsTable(PS("  113   110  90000 Mon Nov 17 09:02:00 2026 node /r/node_modules/.bin/vite\n  114   113  20000 Mon Nov 17 09:02:01 2026 /r/esbuild --service"));
    await m.onSample(sample(t));
    expect(levels(calls)).toEqual({ 110: 2, 111: 2, 113: 1, 114: 1, 120: 2 });
  });

  it("does nothing more after close, but still restores what it lowered", async () => {
    const { m, calls } = setup();
    await m.onSample(sample(parsePsTable(PS())));
    m.close();
    calls.length = 0;
    await m.onSample(sample(parsePsTable(PS())));
    expect(calls).toEqual([]);
    await m.restoreAll();
    expect(levels(calls)).toEqual({ 110: 0, 111: 0, 120: 0 });
  });

  it("skips pinned sessions and forgets pids that exited or were reused", async () => {
    const { m, calls, state } = setup();
    state.exempt.add("h2");
    await m.onSample(sample(parsePsTable(PS())));
    expect(Object.keys(levels(calls))).toEqual(["110", "111"]);
    calls.length = 0;
    // 111 换成了另一个进程（启动时间不一样），而且已经不在树里：不去恢复它。
    const reused = parsePsTable(PS().replace("  111   110  80000 Mon Nov 17 09:01:01 2026 node /x/mcp.js", "  111     1  80000 Mon Nov 17 10:00:00 2026 other"));
    await m.onSample(sample(reused));
    expect(calls).toEqual([]);
    expect(m.lowered()).toBe(1);
    await m.restoreAll();
    expect(levels(calls)).toEqual({ 110: 0 });
  });
});

describe("platform backends", () => {
  it("macOS uses taskpolicy only for the background level", async () => {
    const runs: string[][] = [];
    const b = macBackend(async (cmd, args) => (runs.push([cmd, ...args]), ""));
    const out = await b([
      { pid: 1, from: 0, to: 1 },
      { pid: 2, from: 0, to: 2 },
      { pid: 3, from: 2, to: 0 },
    ]);
    expect(runs).toEqual([["taskpolicy", "-b", "-p", "2"], ["taskpolicy", "-B", "-p", "3"]]);
    expect([...out]).toEqual([[1, 1], [2, 2], [3, 0]]);
    const failing = macBackend(async () => Promise.reject(new Error("exited")));
    expect([...(await failing([{ pid: 4, from: 0, to: 2 }]))]).toEqual([]);
  });

  it("Windows uses BelowNormal and EcoQoS, and stops at BelowNormal when EcoQoS fails", async () => {
    const prio: [number, number][] = [];
    const scripts: string[] = [];
    const b = winBackend(async (_cmd, args) => (scripts.push(args.join(" ")), "2\r\n"), (pid, p) => void prio.push([pid, p]), () => os.constants.priority.PRIORITY_NORMAL);
    const out = await b([
      { pid: 1, from: 0, to: 1 },
      { pid: 2, from: 0, to: 2 },
      { pid: 3, from: 0, to: 2 },
      { pid: 4, from: 1, to: 0 },
    ]);
    expect(prio).toEqual([
      [1, os.constants.priority.PRIORITY_BELOW_NORMAL],
      [2, os.constants.priority.PRIORITY_BELOW_NORMAL],
      [3, os.constants.priority.PRIORITY_BELOW_NORMAL],
      [4, os.constants.priority.PRIORITY_NORMAL],
    ]);
    expect(scripts.length).toBe(1);
    expect(Object.fromEntries(out)).toEqual({ 1: 1, 2: 2, 3: 1, 4: 0 });
    // 3 开 EcoQoS 失败过：以后不再起 PowerShell 去试。
    scripts.length = 0;
    expect(Object.fromEntries(await b([{ pid: 3, from: 1, to: 2 }]))).toEqual({ 3: 1 });
    expect(scripts).toEqual([]);
  });

  it("Windows leaves processes that are not at Normal priority alone", async () => {
    const prio: [number, number][] = [];
    const b = winBackend(async () => "", (pid, p) => void prio.push([pid, p]), (pid) => (pid === 1 ? os.constants.priority.PRIORITY_LOW : os.constants.priority.PRIORITY_HIGH));
    expect([...(await b([{ pid: 1, from: 0, to: 1 }, { pid: 2, from: 0, to: 2 }]))]).toEqual([]);
    expect(prio).toEqual([]);
  });

  it("the EcoQoS script lists both batches", () => {
    const s = ecoScript([1, 2], [3]);
    expect(s).toContain("@(1,2)");
    expect(s).toContain("@(3)");
    expect(s).toContain("SetProcessInformation");
    // 关的时候 ControlMask 也是 0：回到系统默认，不是钉成高 QoS。
    expect(s).toContain("s.M = on ? 1u : 0u");
  });
});
