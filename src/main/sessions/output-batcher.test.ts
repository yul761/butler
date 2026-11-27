import { describe, expect, it } from "vitest";
import { OutputBatcher, type BatchClock } from "./output-batcher";
import { PtyManager } from "./pty-manager";
import { fakePtyFactory } from "../test-utils";

/** 手动走时间的钟：advance 到点就跑到期的定时器（按到期先后）。 */
function manualClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: BatchClock = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (h) => void timers.delete(h as number),
  };
  const advance = (ms: number) => {
    const until = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t = due[1].at;
      due[1].fn();
    }
    t = until;
  };
  return { clock, advance, pendingTimers: () => timers.size };
}

function setup(opts: { windowMs?: number; maxChars?: number } = {}) {
  const c = manualClock();
  const sent: [string, string][] = [];
  const b = new OutputBatcher((id, d) => sent.push([id, d]), opts, c.clock);
  return { ...c, sent, b };
}

describe("OutputBatcher", () => {
  it("sends the first chunk after a quiet spell right away (typing echo is not delayed)", () => {
    const { b, sent } = setup({ windowMs: 8 });
    b.push("t1", "a");
    expect(sent).toEqual([["t1", "a"]]);
  });

  it("joins chunks that arrive inside the window, in order, and sends them once when the window ends", () => {
    const { b, sent, advance } = setup({ windowMs: 8 });
    b.push("t1", "1");
    advance(1);
    b.push("t1", "2");
    b.push("t1", "3");
    advance(3);
    b.push("t1", "4");
    expect(sent).toEqual([["t1", "1"]]);
    advance(3);
    expect(sent).toEqual([["t1", "1"]]);
    advance(1);
    expect(sent).toEqual([["t1", "1"], ["t1", "234"]]);
    // 窗口刚结束又来一块：离上一次发送不到一个窗口，接着攒。
    b.push("t1", "5");
    expect(sent.length).toBe(2);
    advance(8);
    expect(sent).toEqual([["t1", "1"], ["t1", "234"], ["t1", "5"]]);
    // 安静了一个窗口以上：又是马上发。
    advance(20);
    b.push("t1", "6");
    expect(sent.at(-1)).toEqual(["t1", "6"]);
  });

  it("adds at most one window of delay to any chunk", () => {
    const arrived = new Map<string, number>();
    const delivered = new Map<string, number>();
    // 一串随机间隔的块，记下每个字符到达和发出的时间。
    const c = manualClock();
    const got: [number, string][] = [];
    const bb = new OutputBatcher((_id, d) => got.push([c.clock.now(), d]), { windowMs: 8 }, c.clock);
    let code = 0;
    let rnd = 7;
    for (let i = 0; i < 400; i++) {
      rnd = (rnd * 1103515245 + 12345) % 2147483648;
      c.advance(rnd % 13);
      const ch = String.fromCharCode(0x4e00 + code++);
      arrived.set(ch, c.clock.now());
      bb.push("t1", ch);
    }
    c.advance(100);
    for (const [at, d] of got) for (const ch of d) delivered.set(ch, at);
    expect(delivered.size).toBe(400);
    for (const [ch, at] of arrived) expect(delivered.get(ch)! - at).toBeLessThanOrEqual(8);
    // 两次发送之间至少一个窗口（除了攒满上限那种）。
    for (let i = 1; i < got.length; i++) expect(got[i][0] - got[i - 1][0]).toBeGreaterThanOrEqual(8);
  });

  it("never loses or reorders bytes, across terminals, whatever the timing", () => {
    const c = manualClock();
    const got = new Map<string, string>();
    const b = new OutputBatcher((id, d) => got.set(id, (got.get(id) ?? "") + d), { windowMs: 12, maxChars: 50 }, c.clock);
    const want = new Map<string, string>();
    let rnd = 1;
    for (let i = 0; i < 3000; i++) {
      rnd = (rnd * 1103515245 + 12345) % 2147483648;
      const id = `t${rnd % 3}`;
      const piece = `${i},`.repeat((rnd >> 4) % 9);
      want.set(id, (want.get(id) ?? "") + piece);
      b.push(id, piece);
      c.advance((rnd >> 8) % 6);
      if (rnd % 97 === 0) b.flush(id);
    }
    c.advance(100);
    expect(got).toEqual(new Map([...want].filter(([, v]) => v !== "")));
  });

  it("sends at once when a batch grows past maxChars", () => {
    const { b, sent } = setup({ windowMs: 8, maxChars: 10 });
    b.push("t1", "a");
    b.push("t1", "12345");
    expect(sent.length).toBe(1);
    b.push("t1", "67890");
    expect(sent).toEqual([["t1", "a"], ["t1", "1234567890"]]);
  });

  it("keeps each terminal's window separate", () => {
    const { b, sent, advance } = setup({ windowMs: 8 });
    b.push("t1", "a");
    b.push("t2", "x");
    b.push("t1", "b");
    expect(sent).toEqual([["t1", "a"], ["t2", "x"]]);
    advance(8);
    expect(sent).toEqual([["t1", "a"], ["t2", "x"], ["t1", "b"]]);
  });

  it("flush sends what is waiting now and cancels the timer; forget also drops the window", () => {
    const { b, sent, advance, pendingTimers } = setup({ windowMs: 8 });
    b.push("t1", "a");
    b.push("t1", "b");
    expect(b.pendingChars("t1")).toBe(1);
    b.flush("t1");
    expect(sent).toEqual([["t1", "a"], ["t1", "b"]]);
    expect(pendingTimers()).toBe(0);
    advance(20);
    expect(sent.length).toBe(2);
    b.flush("t1");
    expect(sent.length).toBe(2);
    advance(1);
    b.push("t1", "c");
    b.forget("t1");
    expect(sent.at(-1)).toEqual(["t1", "c"]);
    // 忘掉以后（终端退出、同一个 id 重开）第一块马上发。
    b.push("t1", "d");
    expect(sent.at(-1)).toEqual(["t1", "d"]);
  });

  /**
   * 和渲染进程挂终端的约定一起跑（live-terminal.ts + register.ts）：挂上时取快照，回包之前到的数据丢掉、之后到的接着写。
   * 主进程在回快照之前 flush 这个终端：随便什么时候挂上，渲染进程拼出来的都正好是终端的全部输出，一个字不多、不少、不乱。
   */
  it("works with the snapshot handshake: what the renderer shows is exactly the terminal's output", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const c = manualClock();
      const { factory, spawned } = fakePtyFactory();
      // 「线」：主进程按顺序发到渲染进程的东西（数据事件、invoke 的回包）。
      const wire: ({ kind: "data"; data: string } | { kind: "reply"; data: string })[] = [];
      const b = new OutputBatcher((_id, d) => wire.push({ kind: "data", data: d }), { windowMs: 8 }, c.clock);
      const pty = new PtyManager(factory, { data: (id, d) => b.push(id, d), exit: (id) => b.forget(id) });
      pty.open("t1", { file: "claude", args: [] }, { cwd: "/", env: {} });
      let rnd = seed;
      let all = "";
      const attachAt = seed * 7;
      for (let i = 0; i < 300; i++) {
        rnd = (rnd * 1103515245 + 12345) % 2147483648;
        const piece = `<${i}>`;
        all += piece;
        spawned[0].pty.emit(piece);
        c.advance(rnd % 5);
        if (i === attachAt) {
          b.flush("t1");
          wire.push({ kind: "reply", data: pty.snapshotAt("t1").data });
        }
      }
      c.advance(50);
      // 渲染进程：回包之前的数据丢掉，回包写进去，之后的数据接着写。
      let shown = "";
      let ready = false;
      for (const m of wire) {
        if (m.kind === "reply") {
          shown = m.data;
          ready = true;
        } else if (ready) shown += m.data;
      }
      expect(shown).toBe(all);
    }
  });
});
