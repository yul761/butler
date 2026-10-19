import { describe, expect, it } from "vitest";
import { TicketError } from "../tickets/ticket-service";
import { toIpcResult } from "./result";

describe("toIpcResult", () => {
  it("wraps values and errors", async () => {
    expect(await toIpcResult(() => 1)).toEqual({ ok: true, value: 1 });
    expect(await toIpcResult(async () => "x")).toEqual({ ok: true, value: "x" });
    expect(await toIpcResult(() => { throw new TicketError("exists", "dup"); })).toEqual({ ok: false, code: "exists", message: "dup" });
    expect(await toIpcResult(() => { throw new Error("boom"); })).toEqual({ ok: false, code: "internal", message: "boom" });
    expect(await toIpcResult(() => { throw "weird"; })).toEqual({ ok: false, code: "internal", message: "weird" });
  });
});
