import { describe, expect, it, vi } from "vitest";
import { TASK_LIMIT } from "../../shared/control";
import { ForkError, type DevSendResult, type ForkView, type RememberResult } from "../../shared/fork";
import { forkHandlers } from "./fork-handlers";
import { toIpcResult } from "./result";

const view = { id: 3, rootSessionId: "root-1" } as ForkView;

function setup(ready: () => Promise<void> = async () => {}) {
  const fork = {
    ask: vi.fn<(anyId: string, forkId: number | null, q: string) => { forkId: number }>((_, forkId) => ({ forkId: forkId ?? 7 })),
    reaskFull: vi.fn<(forkId: number) => { forkId: number }>(() => ({ forkId: 8 })),
    list: vi.fn<(anyId: string) => ForkView[]>(() => [view]),
    sendConclusion: vi.fn<(forkId: number) => Promise<DevSendResult>>(async () => ({ ok: true, at: 123, state: "idle" })),
    remember: vi.fn<(forkId: number) => Promise<RememberResult>>(async () => "written"),
  };
  const devSend = { send: vi.fn<(anyId: string, text: string) => Promise<DevSendResult>>(async () => ({ ok: false, reason: "not_found" })) };
  return { fork, devSend, h: forkHandlers({ fork, devSend, ready }) };
}

describe("fork IPC handlers (UI redesign layer 5)", () => {
  it("fork:ask with forkId null starts a new fork, with a number asks that fork again; the question is trimmed", async () => {
    const { h, fork } = setup();
    expect(await h.ask("root-1", null, "  为什么？ ")).toEqual({ forkId: 7 });
    expect(await h.ask("head-2", 3, "再说说")).toEqual({ forkId: 3 });
    expect(fork.ask.mock.calls).toEqual([["root-1", null, "为什么？"], ["head-2", 3, "再说说"]]);
  });

  it("routes reask-full, list, send-conclusion and remember to the fork service", async () => {
    const { h, fork } = setup();
    expect(await h.reaskFull(3)).toEqual({ forkId: 8 });
    expect(fork.reaskFull).toHaveBeenCalledWith(3);
    expect(h.list("head-2")).toEqual([view]);
    expect(fork.list).toHaveBeenCalledWith("head-2");
    expect(await h.sendConclusion(3)).toEqual({ ok: true, at: 123, state: "idle" });
    expect(fork.sendConclusion).toHaveBeenCalledWith(3);
    expect(await h.remember(3)).toEqual({ result: "written" });
    expect(fork.remember).toHaveBeenCalledWith(3);
  });

  it("conv:send goes to the dev sender as typed", async () => {
    const { h, devSend } = setup();
    expect(await h.convSend("head-2", "先别合，等 CI")).toEqual({ ok: false, reason: "not_found" });
    expect(devSend.send).toHaveBeenCalledWith("head-2", "先别合，等 CI");
  });

  it("refuses bad arguments without touching the services", async () => {
    const { h, fork, devSend } = setup();
    await expect(h.ask("../x", null, "q")).rejects.toThrow();
    await expect(h.ask("root-1", 0, "q")).rejects.toThrow();
    await expect(h.ask("root-1", "3", "q")).rejects.toThrow();
    await expect(h.ask("root-1", undefined, "q")).rejects.toThrow();
    await expect(h.ask("root-1", null, "   ")).rejects.toThrow();
    await expect(h.reaskFull(-1)).rejects.toThrow();
    expect(() => h.list(42)).toThrow();
    await expect(h.sendConclusion(1.5)).rejects.toThrow();
    await expect(h.remember("1")).rejects.toThrow();
    await expect(h.convSend("head-2", "  ")).rejects.toThrow();
    await expect(h.convSend("head-2", "x".repeat(TASK_LIMIT + 1))).rejects.toThrow();
    await expect(h.convSend(null, "hi")).rejects.toThrow();
    for (const f of [fork.ask, fork.reaskFull, fork.list, fork.sendConclusion, fork.remember, devSend.send]) expect(f).not.toHaveBeenCalled();
  });

  it("waits for the startup health check before anything that runs claude: right after launch the claude path and shipherd-hook are not known yet", async () => {
    let done!: () => void;
    const ready = new Promise<void>((r) => (done = r));
    const { h, fork, devSend } = setup(() => ready);
    const calls = [h.ask("root-1", null, "q"), h.ask("root-1", 3, "q"), h.reaskFull(3), h.sendConclusion(3), h.remember(3)];
    // 列表和发给开发 session 不用 claude，不等。
    expect(h.list("root-1")).toEqual([view]);
    expect(await h.convSend("head-2", "hi")).toEqual({ ok: false, reason: "not_found" });
    expect(devSend.send).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 0));
    for (const f of [fork.ask, fork.reaskFull, fork.sendConclusion, fork.remember]) expect(f).not.toHaveBeenCalled();
    done();
    expect(await Promise.all(calls)).toEqual([{ forkId: 7 }, { forkId: 3 }, { forkId: 8 }, { ok: true, at: 123, state: "idle" }, { result: "written" }]);
  });

  it("bad arguments are refused at once, without waiting for the health check", async () => {
    const { h, fork } = setup(() => new Promise<void>(() => {}));
    await expect(h.ask("../x", null, "q")).rejects.toThrow();
    await expect(h.reaskFull(0)).rejects.toThrow();
    await expect(h.sendConclusion("1")).rejects.toThrow();
    await expect(h.remember(null)).rejects.toThrow();
    for (const f of [fork.ask, fork.reaskFull, fork.sendConclusion, fork.remember]) expect(f).not.toHaveBeenCalled();
  });

  it("a failed health check still lets the call through: ForkService decides from the health state it has", async () => {
    const { h, fork } = setup(() => Promise.reject(new Error("probe failed")));
    expect(await h.ask("root-1", null, "q")).toEqual({ forkId: 7 });
    expect(await h.reaskFull(3)).toEqual({ forkId: 8 });
    expect(await h.sendConclusion(3)).toEqual({ ok: true, at: 123, state: "idle" });
    expect(await h.remember(3)).toEqual({ result: "written" });
    for (const f of [fork.ask, fork.reaskFull, fork.sendConclusion, fork.remember]) expect(f).toHaveBeenCalledTimes(1);
  });

  it("a ForkError reaches the renderer as { ok: false, code }", async () => {
    const { h, fork } = setup();
    fork.ask.mockImplementation(() => {
      throw new ForkError("fork_busy");
    });
    fork.reaskFull.mockImplementation(() => {
      throw new ForkError("dev_busy");
    });
    expect(await toIpcResult(() => h.ask("root-1", 3, "q"))).toMatchObject({ ok: false, code: "fork_busy" });
    expect(await toIpcResult(() => h.reaskFull(3))).toMatchObject({ ok: false, code: "dev_busy" });
    expect(await toIpcResult(() => h.ask("root-1", 0, "q"))).toMatchObject({ ok: false, code: "internal" });
  });
});
