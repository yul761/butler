import { describe, expect, it, vi } from "vitest";
import { TicketError } from "../tickets/ticket-service";
import { meteredIpcResult, toIpcResult } from "./result";

describe("toIpcResult", () => {
  it("wraps values and errors", async () => {
    expect(await toIpcResult(() => 1)).toEqual({ ok: true, value: 1 });
    expect(await toIpcResult(async () => "x")).toEqual({ ok: true, value: "x" });
    expect(await toIpcResult(() => { throw new TicketError("exists", "dup"); })).toEqual({ ok: false, code: "exists", message: "dup" });
    expect(await toIpcResult(() => { throw new Error("boom"); })).toEqual({ ok: false, code: "internal", message: "boom" });
    expect(await toIpcResult(() => { throw "weird"; })).toEqual({ ok: false, code: "internal", message: "weird" });
  });
});

describe("meteredIpcResult", () => {
  it("hands successful calls, with their result, to onInvoked", async () => {
    const onInvoked = vi.fn();
    expect(await meteredIpcResult("sessions:wake", ["s1"], async () => "woken", onInvoked)).toEqual({ ok: true, value: "woken" });
    expect(onInvoked).toHaveBeenCalledWith("sessions:wake", ["s1"], "woken");
  });

  it("does not hand failed calls to onInvoked", async () => {
    const onInvoked = vi.fn();
    const r = await meteredIpcResult("x", [], () => { throw new Error("boom"); }, onInvoked);
    expect(r.ok).toBe(false);
    expect(onInvoked).not.toHaveBeenCalled();
  });

  it("returns the result even when onInvoked throws", async () => {
    const r = await meteredIpcResult("x", [], () => 3, () => { throw new Error("metrics down"); });
    expect(r).toEqual({ ok: true, value: 3 });
  });
});
