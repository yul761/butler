import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePtyFactory } from "../test-utils";
import { BUFFER_LIMIT, PtyManager } from "./pty-manager";

function setup() {
  const { factory, spawned } = fakePtyFactory();
  const data: [string, string][] = [];
  const exits: [string, number][] = [];
  const mgr = new PtyManager(factory, { data: (id, d) => data.push([id, d]), exit: (id, c) => exits.push([id, c]) });
  return { mgr, spawned, data, exits };
}

const spec = { file: "/bin/claude", args: ["--session-id", "t1"] };
const opts = { cwd: "/w", env: { A: "1" } };

describe("PtyManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("spawns, forwards data, buffers output and forgets exited terminals", () => {
    const { mgr, spawned, data, exits } = setup();
    mgr.open("t1", spec, opts);
    expect(spawned[0]).toMatchObject({ file: "/bin/claude", args: ["--session-id", "t1"], opts: { cwd: "/w", env: { A: "1" }, cols: 120, rows: 32 } });
    spawned[0].pty.emit("hello ");
    spawned[0].pty.emit("world");
    expect(data).toEqual([["t1", "hello "], ["t1", "world"]]);
    expect(mgr.snapshot("t1")).toEqual({ data: "hello world", exitCode: null });
    expect(mgr.openIds()).toEqual(["t1"]);
    spawned[0].pty.emitExit(3);
    expect(exits).toEqual([["t1", 3]]);
    expect(mgr.isOpen("t1")).toBe(false);
    expect(mgr.snapshot("t1")).toEqual({ data: "hello world", exitCode: 3 });
    expect(mgr.snapshot("nope")).toEqual({ data: "", exitCode: null });
  });

  it("evicts exited records beyond the limit", () => {
    const { mgr, spawned } = setup();
    for (let i = 0; i < 21; i++) {
      mgr.open(`x${i}`, spec, opts);
      spawned[i].pty.emitExit(i);
    }
    expect(mgr.snapshot("x0")).toEqual({ data: "", exitCode: null });
    expect(mgr.snapshot("x1").exitCode).toBe(1);
    expect(mgr.snapshot("x20").exitCode).toBe(20);
  });

  it("clears the exited record on re-open", () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    spawned[0].pty.emit("old");
    spawned[0].pty.emitExit(1);
    mgr.open("t1", spec, opts);
    expect(mgr.snapshot("t1")).toEqual({ data: "", exitCode: null });
  });

  it("caps the replay buffer", () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    spawned[0].pty.emit("a".repeat(BUFFER_LIMIT));
    spawned[0].pty.emit("bcd");
    const snap = mgr.snapshot("t1").data;
    expect(snap).toHaveLength(BUFFER_LIMIT);
    expect(snap.endsWith("bcd")).toBe(true);
  });

  it("refuses to open the same terminal twice", () => {
    const { mgr } = setup();
    mgr.open("t1", spec, opts);
    expect(() => mgr.open("t1", spec, opts)).toThrow(/already open/);
  });

  it("ignores zero-size resizes and routes writes", () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    mgr.resize("t1", 0, 10);
    mgr.resize("t1", 100, 30);
    mgr.write("t1", "x");
    mgr.write("nope", "y");
    expect(spawned[0].pty.resized).toEqual([[100, 30]]);
    expect(spawned[0].pty.written).toEqual(["x"]);
  });

  it("prefill waits for output to go quiet, then types without Enter", async () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    const p = mgr.prefill("t1", "继续 follow-up", 800, 20_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawned[0].pty.written).toEqual([]); // 还没有任何输出，不能写
    spawned[0].pty.emit("welcome");
    await vi.advanceTimersByTimeAsync(500);
    spawned[0].pty.emit("…");
    await vi.advanceTimersByTimeAsync(500);
    expect(spawned[0].pty.written).toEqual([]); // 输出还没安静 800ms
    await vi.advanceTimersByTimeAsync(400);
    expect(await p).toBe(true);
    expect(spawned[0].pty.written).toEqual(["继续 follow-up"]);
  });

  it("prefill gives up when the terminal exits or times out", async () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    const p1 = mgr.prefill("t1", "x", 800, 5000);
    spawned[0].pty.emitExit(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p1).toBe(false);

    mgr.open("t2", spec, opts);
    const p2 = mgr.prefill("t2", "x", 800, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await p2).toBe(false);
  });

  it("killAll kills every terminal", () => {
    const { mgr, spawned } = setup();
    mgr.open("a", spec, opts);
    mgr.open("b", spec, opts);
    mgr.killAll();
    expect(spawned.every((s) => s.pty.killed)).toBe(true);
    expect(mgr.openIds()).toEqual([]);
  });

  it("logs instead of throwing when the pty rejects write/resize/kill", () => {
    const { factory, spawned } = fakePtyFactory();
    const logs: string[] = [];
    const mgr = new PtyManager(factory, { data: () => undefined, exit: () => undefined }, () => Date.now(), (m) => logs.push(m));
    mgr.open("a", spec, opts);
    const boom = () => {
      throw new Error("EBADF");
    };
    spawned[0].pty.write = boom;
    spawned[0].pty.resize = boom;
    spawned[0].pty.kill = boom;
    expect(() => {
      mgr.write("a", "x");
      mgr.resize("a", 80, 24);
      mgr.kill("a");
      mgr.killAll();
    }).not.toThrow();
    expect(logs).toHaveLength(4);
    expect(logs[0]).toContain("write failed");
  });
});
