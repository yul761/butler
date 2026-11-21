import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/types";
import { DevSender, type DevSendDeps } from "./dev-send";

const head = (id: string, featureId: number | null = null): Session => ({ id, featureId } as Session);

function setup() {
  const heads = new Map<string, Session>([["root-1", head("head-2", 7)]]);
  const send = vi.fn<DevSendDeps["mailbox"]["send"]>(() => ({ id: "m1", state: "busy" }));
  const log = vi.fn();
  const d: DevSendDeps = {
    sessions: { rootOf: (id) => (id === "root-1" ? "root-1" : null), head: (id) => heads.get(id) ?? null },
    mailbox: { send },
    sanitize: (t) => `S(${t})`,
    now: () => 42,
    log,
  };
  return { sender: new DevSender(d), heads, send, log };
}

describe("DevSender (BTL-248：走信箱)", () => {
  it("排进现在 head 的信箱，kind user，返回排队时目标的状态", async () => {
    const s = setup();
    expect(await s.sender.send("root-1", "按这个改")).toEqual({ ok: true, at: 42, state: "busy" });
    expect(s.send).toHaveBeenCalledWith({ kind: "user", from: null, to: "head-2", featureId: 7, body: "S(按这个改)" });
  });

  it.each(["idle", "closed"] as const)("目标 %s 也一样排队，不挡", async (state) => {
    const s = setup();
    s.send.mockReturnValue({ id: "m1", state });
    expect(await s.sender.send("root-1", "x")).toEqual({ ok: true, at: 42, state });
  });

  it("换新以后发到现在的 head", async () => {
    const s = setup();
    s.heads.set("root-1", head("head-3"));
    await s.sender.send("root-1", "x");
    expect(s.send.mock.calls[0][0].to).toBe("head-3");
  });

  it("找不到 session：not_found，不排队", async () => {
    const s = setup();
    expect(await s.sender.send("nope", "x")).toEqual({ ok: false, reason: "not_found" });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("排队抛错（库坏了）：not_found 以外报 failed，写日志", async () => {
    const s = setup();
    s.send.mockImplementation(() => {
      throw new Error("db");
    });
    expect(await s.sender.send("root-1", "x")).toEqual({ ok: false, reason: "failed" });
    expect(s.log).toHaveBeenCalled();
  });
});
