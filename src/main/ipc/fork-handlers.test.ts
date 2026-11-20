import { describe, expect, it, vi } from "vitest";
import { TASK_LIMIT } from "../../shared/control";
import { ForkError, type DevSendResult, type ForkView, type RememberResult } from "../../shared/fork";
import { forkHandlers } from "./fork-handlers";
import { toIpcResult } from "./result";

const view = { id: 3, rootSessionId: "root-1" } as ForkView;

function setup() {
  const fork = {
    ask: vi.fn<(anyId: string, forkId: number | null, q: string) => { forkId: number }>((_, forkId) => ({ forkId: forkId ?? 7 })),
    reaskFull: vi.fn<(forkId: number) => { forkId: number }>(() => ({ forkId: 8 })),
    list: vi.fn<(anyId: string) => ForkView[]>(() => [view]),
    sendConclusion: vi.fn<(forkId: number) => Promise<DevSendResult>>(async () => ({ ok: true, at: 123 })),
    remember: vi.fn<(forkId: number) => Promise<RememberResult>>(async () => "written"),
  };
  const devSend = { send: vi.fn<(anyId: string, text: string) => Promise<DevSendResult>>(async () => ({ ok: false, reason: "busy" })) };
  return { fork, devSend, h: forkHandlers({ fork, devSend }) };
}

describe("fork IPC handlers (UI redesign layer 5)", () => {
  it("fork:ask with forkId null starts a new fork, with a number asks that fork again; the question is trimmed", () => {
    const { h, fork } = setup();
    expect(h.ask("root-1", null, "  为什么？ ")).toEqual({ forkId: 7 });
    expect(h.ask("head-2", 3, "再说说")).toEqual({ forkId: 3 });
    expect(fork.ask.mock.calls).toEqual([["root-1", null, "为什么？"], ["head-2", 3, "再说说"]]);
  });

  it("routes reask-full, list, send-conclusion and remember to the fork service", async () => {
    const { h, fork } = setup();
    expect(h.reaskFull(3)).toEqual({ forkId: 8 });
    expect(fork.reaskFull).toHaveBeenCalledWith(3);
    expect(h.list("head-2")).toEqual([view]);
    expect(fork.list).toHaveBeenCalledWith("head-2");
    expect(await h.sendConclusion(3)).toEqual({ ok: true, at: 123 });
    expect(fork.sendConclusion).toHaveBeenCalledWith(3);
    expect(await h.remember(3)).toEqual({ result: "written" });
    expect(fork.remember).toHaveBeenCalledWith(3);
  });

  it("conv:send goes to the dev sender as typed", async () => {
    const { h, devSend } = setup();
    expect(await h.convSend("head-2", "先别合，等 CI")).toEqual({ ok: false, reason: "busy" });
    expect(devSend.send).toHaveBeenCalledWith("head-2", "先别合，等 CI");
  });

  it("refuses bad arguments without touching the services", async () => {
    const { h, fork, devSend } = setup();
    expect(() => h.ask("../x", null, "q")).toThrow();
    expect(() => h.ask("root-1", 0, "q")).toThrow();
    expect(() => h.ask("root-1", "3", "q")).toThrow();
    expect(() => h.ask("root-1", undefined, "q")).toThrow();
    expect(() => h.ask("root-1", null, "   ")).toThrow();
    expect(() => h.reaskFull(-1)).toThrow();
    expect(() => h.list(42)).toThrow();
    await expect(h.sendConclusion(1.5)).rejects.toThrow();
    await expect(h.remember("1")).rejects.toThrow();
    await expect(h.convSend("head-2", "  ")).rejects.toThrow();
    await expect(h.convSend("head-2", "x".repeat(TASK_LIMIT + 1))).rejects.toThrow();
    await expect(h.convSend(null, "hi")).rejects.toThrow();
    for (const f of [fork.ask, fork.reaskFull, fork.list, fork.sendConclusion, fork.remember, devSend.send]) expect(f).not.toHaveBeenCalled();
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
