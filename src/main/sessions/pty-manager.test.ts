import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePtyFactory } from "../test-utils";
import { BUFFER_LIMIT, nextDraftLength, permissionPromptShowing, PtyManager, trimBuffer } from "./pty-manager";

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

  it("keeps the terminal modes that scrolled out of the replay buffer", () => {
    // claude（全屏界面）只在启动和改尺寸时打开备用屏幕和鼠标上报：缓冲截掉开头后，回放要把这些模式补上，不然滚轮到不了 claude。
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    spawned[0].pty.emit("\x1b[?1049h\x1b[?1000h\x1b[?1002;1006h\x1b[?2004h\x1b[?25l\n");
    spawned[0].pty.emit("\x1b[?2004l\n");
    spawned[0].pty.emit(`${"x".repeat(100)}\n`.repeat(Math.ceil(BUFFER_LIMIT / 101) + 10));
    spawned[0].pty.emit("tail");
    const snap = mgr.snapshot("t1").data;
    expect(snap.startsWith("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004l\x1b[?25l")).toBe(true);
    expect(snap.endsWith("tail")).toBe(true);
    // 还在缓冲里的模式不重复补；退出后的记录也带着。
    spawned[0].pty.emitExit(0);
    expect(mgr.snapshot("t1").data).toBe(snap);
  });

  it("adds no mode prefix while nothing has been cut", () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    spawned[0].pty.emit("\x1b[?1049hhello");
    expect(mgr.snapshot("t1").data).toBe("\x1b[?1049hhello");
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

  it("remembers when the user last wrote to a terminal; Butler's own deliveries and prefills don't count", async () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    expect(mgr.lastUserInputAt("t1")).toBe(0);
    expect(mgr.lastUserInputAt("nope")).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    mgr.write("t1", "半句");
    const typed = Date.now();
    expect(mgr.lastUserInputAt("t1")).toBe(typed);
    spawned[0].pty.emit("ready");
    const p = mgr.deliver("t1", "通知", { startWaitMs: 0 });
    await vi.advanceTimersByTimeAsync(7000);
    expect(await p).toBe("sent");
    const f = mgr.prefill("t1", "x", 800, 1000);
    await vi.advanceTimersByTimeAsync(1200);
    await f;
    expect(mgr.lastUserInputAt("t1")).toBe(typed);
    spawned[0].pty.emitExit(0);
    mgr.open("t1", spec, opts);
    expect(mgr.lastUserInputAt("t1")).toBe(0);
  });

  it("deliver waits for SessionStart and a quiet prompt, pastes once, then presses Enter after the echo settles", async () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    const p = mgr.deliver("t1", "写接口\n加测试", { idleMs: 800, startWaitMs: 60_000, settleMs: 300 });
    spawned[0].pty.emit("welcome");
    await vi.advanceTimersByTimeAsync(2000);
    expect(spawned[0].pty.written).toEqual([]); // 还没有 SessionStart
    mgr.markStarted("t1");
    await vi.advanceTimersByTimeAsync(200);
    expect(spawned[0].pty.written).toEqual(["\x1b[200~写接口\r加测试\x1b[201~"]);
    spawned[0].pty.emit("写接口…");
    await vi.advanceTimersByTimeAsync(200);
    expect(spawned[0].pty.written).toHaveLength(1); // 回显还没安静
    await vi.advanceTimersByTimeAsync(400);
    expect(await p).toBe("sent");
    expect(spawned[0].pty.written).toEqual(["\x1b[200~写接口\r加测试\x1b[201~", "\r"]);
  });

  it("deliver can send the task as a single line (Windows)", async () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    const p = mgr.deliver("t1", "开头：\n写接口\n  加测试", { startWaitMs: 0, singleLine: true });
    spawned[0].pty.emit("ready");
    await vi.advanceTimersByTimeAsync(7000);
    expect(await p).toBe("sent");
    expect(spawned[0].pty.written).toEqual(["\x1b[200~开头： 写接口 加测试\x1b[201~", "\r"]);
  });

  it("deliver never answers a trust or MCP dialog, and waits for the user to get past it", async () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    const p = mgr.deliver("t1", "task", { idleMs: 800, startWaitMs: 1000, timeoutMs: 600_000 });
    spawned[0].pty.emit("\x1b[1m Do you trust the files in this folder?\x1b[0m\r\n ❯ 1. Yes, proceed\r\n   2. No, exit");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawned[0].pty.written).toEqual([]);
    // 用户选了“是”：claude 重画欢迎界面和输入框。
    spawned[0].pty.emit(`\x1b[2J${"─".repeat(1200)}\r\n> `);
    await vi.advanceTimersByTimeAsync(2000);
    expect(spawned[0].pty.written[0]).toBe("\x1b[200~task\x1b[201~");
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p).toBe("sent");
  });

  it("deliver gives up when the terminal exits or the user never gets past the dialog", async () => {
    const { mgr, spawned } = setup();
    mgr.open("t1", spec, opts);
    const p1 = mgr.deliver("t1", "x");
    spawned[0].pty.emitExit(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p1).toBe("exited");

    mgr.open("t2", spec, opts);
    const p2 = mgr.deliver("t2", "x", { startWaitMs: 100, timeoutMs: 5000 });
    spawned[1].pty.emit("New MCP server found in .mcp.json");
    await vi.advanceTimersByTimeAsync(6000);
    expect(await p2).toBe("timeout");
    expect(spawned[1].pty.written).toEqual([]);
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
  it("does not let output from an exited process leak into a re-opened terminal", () => {
    const { mgr, spawned, data } = setup();
    mgr.open("t1", spec, opts);
    spawned[0].pty.emitExit(0);
    mgr.open("t1", spec, opts);
    spawned[0].pty.emit("late");
    expect(data.filter(([id, d]) => id === "t1" && d === "late")).toEqual([]);
    expect(mgr.snapshot("t1")).toEqual({ data: "", exitCode: null });
  });

  it("drops output that arrives after the process exited", () => {
    const { mgr, spawned, data } = setup();
    mgr.open("t1", spec, opts);
    spawned[0].pty.emit("before");
    spawned[0].pty.emitExit(0);
    spawned[0].pty.emit("trailing");
    expect(data).toEqual([["t1", "before"]]);
    expect(mgr.snapshot("t1")).toEqual({ data: "before", exitCode: 0 });
  });
});

describe("PtyManager.pid", () => {
  it("gives the process id of an open terminal and null otherwise", () => {
    const { factory, spawned } = fakePtyFactory();
    const pty = new PtyManager(factory, { data: () => undefined, exit: () => undefined });
    expect(pty.pid("t1")).toBeNull();
    pty.open("t1", { file: "/bin/claude", args: [] }, { cwd: "/", env: {} });
    expect(pty.pid("t1")).toBe(spawned[0].pty.pid);
    spawned[0].pty.emitExit(0);
    expect(pty.pid("t1")).toBeNull();
  });
});

describe("PtyManager.screenNeedsUser", () => {
  it("is true while a permission prompt or a startup dialog is on the live screen, false otherwise", () => {
    const { mgr, spawned } = setup();
    expect(mgr.screenNeedsUser("t1")).toBe(false);
    mgr.open("t1", spec, opts);
    spawned[0].pty.emit("收到：做完了\r\n> ");
    expect(mgr.screenNeedsUser("t1")).toBe(false);
    spawned[0].pty.emit("Bash command\r\n\x1b[1mDo you want to proceed?\x1b[0m\r\n ❯ 1. Yes");
    expect(mgr.screenNeedsUser("t1")).toBe(true);
    // 回答之后提示被后面的输出推出了屏幕末尾
    spawned[0].pty.emit(`\x1b[2J${"─".repeat(1200)}\r\n> `);
    expect(mgr.screenNeedsUser("t1")).toBe(false);

    mgr.open("t2", spec, opts);
    spawned[1].pty.emit("\x1b[1m Do you trust the files in this folder?\x1b[0m\r\n ❯ 1. Yes, proceed");
    expect(mgr.screenNeedsUser("t2")).toBe(true);
    // 退出之后不再看缓冲：终端已经不在了
    spawned[1].pty.emitExit(0);
    expect(mgr.screenNeedsUser("t2")).toBe(false);
  });
});

describe("trimBuffer", () => {
  it("keeps short buffers and cuts long ones at a line boundary", () => {
    expect(trimBuffer("abc")).toBe("abc");
    const long = `\x1b[31m${"x".repeat(BUFFER_LIMIT)}\nnext line`;
    const t = trimBuffer(long);
    expect(t.length).toBeLessThanOrEqual(BUFFER_LIMIT);
    expect(t.startsWith("x") || t.startsWith("next")).toBe(true);
    const lines = `${"a".repeat(100)}\n`.repeat(Math.ceil(BUFFER_LIMIT / 101) + 50);
    expect(trimBuffer(lines).startsWith("a".repeat(100))).toBe(true);
  });
});

describe("permissionPromptShowing", () => {
  it("识别带 ANSI 的权限确认提示", () => {
    expect(permissionPromptShowing("\x1b[1mDo you want to proceed?\x1b[0m\n❯ 1. Yes")).toBe(true);
    expect(permissionPromptShowing("\x1b[2mDo you want to make this edit to a.ts?\x1b[0m")).toBe(true);
    expect(permissionPromptShowing("Do you want to create foo.ts?")).toBe(true);
    expect(permissionPromptShowing("\x1b[1mWould you like to proceed?\x1b[0m\n❯ 1. Yes, and auto-accept edits")).toBe(true);
  });
  it("普通输出不算，只看尾部", () => {
    expect(permissionPromptShowing("building...\n")).toBe(false);
    expect(permissionPromptShowing("Do you want to proceed?" + "x".repeat(5000))).toBe(false);
  });
});

describe("nextDraftLength", () => {
  it("typed text without enter is a draft", () => {
    expect(nextDraftLength(0, "hel")).toBe(3);
  });
  it("enter clears the draft", () => {
    expect(nextDraftLength(3, "lo\r")).toBe(0);
  });
  it("backspace and ctrl-u shrink or clear it", () => {
    expect(nextDraftLength(2, "\x7f")).toBe(1);
    expect(nextDraftLength(0, "\x7f")).toBe(0);
    expect(nextDraftLength(5, "\x15")).toBe(0);
    expect(nextDraftLength(5, "\x03")).toBe(0);
  });
  it("escape sequences are not a draft", () => {
    expect(nextDraftLength(0, "\x1b[<64;10;5M\x1b[A\x1b[I\x1bOA")).toBe(0);
  });
  it("pasted text counts", () => {
    expect(nextDraftLength(0, "\x1b[200~abc\x1b[201~")).toBe(3);
  });
});

describe("PtyManager.hasDraft", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("follows write and prefill, and is false for unknown terminals", async () => {
    const { mgr, spawned } = setup();
    expect(mgr.hasDraft("nope")).toBe(false);
    mgr.open("t1", spec, opts);
    expect(mgr.hasDraft("t1")).toBe(false);
    mgr.write("t1", "ab");
    expect(mgr.hasDraft("t1")).toBe(true);
    mgr.write("t1", "\r");
    expect(mgr.hasDraft("t1")).toBe(false);
    spawned[0].pty.emit("ready");
    const p = mgr.prefill("t1", "继续", 800, 5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe(true);
    expect(mgr.hasDraft("t1")).toBe(true);
  });
});
