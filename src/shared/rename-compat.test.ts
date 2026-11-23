// BTL-260：改名前的进程（升级时还在跑的 hook、sessions MCP server）写的文件用旧字段名。butler 是旧名字，测的就是它还被认得。
import { describe, expect, it } from "vitest";
import { parseControlRequest } from "./control";
import { parseEnvelope } from "./hook-envelope";

describe("hook envelopes written by the pre-rename hook", () => {
  it("read butlerSession as the Shipherd session, with the new field winning", () => {
    expect(parseEnvelope(JSON.stringify({ v: 1, receivedAt: 1, ticket: "T-1", butlerSession: "s-old", payload: {} }))?.shipherdSession).toBe("s-old");
    expect(parseEnvelope(JSON.stringify({ v: 1, receivedAt: 1, ticket: null, shipherdSession: "s-new", butlerSession: "s-old", payload: {} }))?.shipherdSession).toBe("s-new");
    expect(parseEnvelope(JSON.stringify({ v: 1, receivedAt: 1, ticket: null, payload: {} }))?.shipherdSession).toBeNull();
  });
});

describe("control requests from a pre-rename sessions MCP server", () => {
  it("treat butler: true as the Shipherd controller scope", () => {
    expect(parseControlRequest({ v: 1, butler: true, from: "s", op: "list_epics" })).toEqual({ v: 1, shipherd: true, from: "s", op: "list_epics" });
  });

  it("still refuse mixed scopes and anything but true", () => {
    expect(parseControlRequest({ v: 1, butler: true, ticketKey: "T-1", from: "s", op: "list_epics" })).toBeNull();
    expect(parseControlRequest({ v: 1, butler: "yes", from: "s", op: "list_epics" })).toBeNull();
    expect(parseControlRequest({ v: 1, butler: true, shipherd: false, from: "s", op: "list_epics" })).toBeNull();
  });
});
