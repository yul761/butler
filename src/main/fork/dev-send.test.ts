import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types";
import type { DeliveryCheck } from "../sessions/delivery-guard";
import type { DeliverResult } from "../sessions/pty-manager";
import { DevSender, type DevSendDeps } from "./dev-send";

const head = (id: string): Session => ({ id } as Session);

function setup(o: { platform?: NodeJS.Platform } = {}) {
  const heads = new Map<string, Session>([["root-1", head("head-2")]]);
  const check = vi.fn<(id: string) => DeliveryCheck>(() => ({ ok: true, termId: "term-1", headId: "head-2" }));
  const recheck = vi.fn(() => true);
  const recheckAfter = vi.fn(() => recheck);
  const deliver = vi.fn<DevSendDeps["deliver"]>(async () => "sent" as DeliverResult);
  const log = vi.fn();
  const d: DevSendDeps = {
    sessions: { rootOf: (id) => (id === "root-1" ? "root-1" : null), head: (id) => heads.get(id) ?? null },
    guard: { check, recheckAfter },
    deliver,
    sanitize: (t) => `S(${t})`,
    platform: o.platform ?? "darwin",
    now: () => 42,
    log,
  };
  return { sender: new DevSender(d), heads, check, recheckAfter, recheck, deliver, log };
}

describe("DevSender", () => {
  it("守卫通过：把处理过的文本递给终端，返回 ok", async () => {
    const s = setup();
    expect(await s.sender.send("root-1", "按这个改")).toEqual({ ok: true, at: 42 });
    expect(s.check).toHaveBeenCalledWith("head-2");
    expect(s.recheckAfter).toHaveBeenCalledWith("head-2", { ok: true, termId: "term-1", headId: "head-2" });
    expect(s.deliver).toHaveBeenCalledWith("term-1", "S(按这个改)", { singleLine: false, timeoutMs: 60_000, recheck: s.recheck });
  });

  it("win32 上 singleLine 为 true", async () => {
    const s = setup({ platform: "win32" });
    await s.sender.send("root-1", "x");
    expect(s.deliver.mock.calls[0][2].singleLine).toBe(true);
  });

  it.each(["draft", "refreshing", "hibernated", "closed", "busy", "typing", "screen", "needs_you", "cost_paused"] as const)("守卫挡下 %s：原样作为 reason，不投递", async (block) => {
    const s = setup();
    s.check.mockReturnValue({ ok: false, block } as DeliveryCheck);
    expect(await s.sender.send("root-1", "x")).toEqual({ ok: false, reason: block });
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it.each(["timeout", "exited", "blocked"] as const)("deliver 返回 %s：对应的 reason", async (r) => {
    const s = setup();
    s.deliver.mockResolvedValue(r);
    expect(await s.sender.send("root-1", "x")).toEqual({ ok: false, reason: r });
  });

  it("换新以后发到现在的 head", async () => {
    const s = setup();
    s.heads.set("root-1", head("head-3"));
    await s.sender.send("root-1", "x");
    expect(s.check).toHaveBeenCalledWith("head-3");
  });

  it("找不到 session：closed，不投递", async () => {
    const s = setup();
    expect(await s.sender.send("nope", "x")).toEqual({ ok: false, reason: "closed" });
    expect(s.deliver).not.toHaveBeenCalled();
  });

  it("同一个 head 在途时再发：in_flight；完了以后可以再发", async () => {
    const s = setup();
    let release!: (r: DeliverResult) => void;
    s.deliver.mockImplementationOnce(() => new Promise((res) => (release = res)));
    const first = s.sender.send("root-1", "a");
    expect(await s.sender.send("root-1", "b")).toEqual({ ok: false, reason: "in_flight" });
    release("sent");
    expect(await first).toEqual({ ok: true, at: 42 });
    expect(await s.sender.send("root-1", "c")).toEqual({ ok: true, at: 42 });
  });

  it("deliver 抛错：blocked，写日志，在途标记清掉", async () => {
    const s = setup();
    const err = new Error("boom");
    s.deliver.mockRejectedValueOnce(err);
    expect(await s.sender.send("root-1", "x")).toEqual({ ok: false, reason: "blocked" });
    // 输入框的话和分叉的结论都走这里：日志不说「结论」（Task 8 review M6）。
    expect(s.log).toHaveBeenCalledWith(expect.stringMatching(/^fork: sending to the dev session .* failed$/), err);
    expect(await s.sender.send("root-1", "x")).toEqual({ ok: true, at: 42 });
  });
});
