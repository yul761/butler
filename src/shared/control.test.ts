import { describe, expect, it } from "vitest";
import { parseControlRequest, sanitizeTask, TASK_LIMIT } from "./control";

describe("parseControlRequest", () => {
  it("accepts the three operations", () => {
    expect(parseControlRequest({ v: 1, ticketKey: "P-1", from: "s1", op: "list_repos" })).toEqual({ v: 1, ticketKey: "P-1", from: "s1", op: "list_repos" });
    expect(parseControlRequest({ v: 1, ticketKey: "P-1", op: "list_sessions" })).toEqual({ v: 1, ticketKey: "P-1", from: null, op: "list_sessions" });
    expect(parseControlRequest({ v: 1, ticketKey: "P-1", from: null, op: "start_session", repo: "api", task: "写接口" })).toMatchObject({ repo: "api", task: "写接口" });
  });

  it("rejects other versions, operations and malformed fields", () => {
    for (const bad of [
      null, "x", { v: 2, ticketKey: "P-1", op: "list_repos" }, { v: 1, op: "list_repos" }, { v: 1, ticketKey: "P-1", op: "send_keys" },
      { v: 1, ticketKey: "P-1", op: "start_session", repo: "", task: "t" }, { v: 1, ticketKey: "P-1", op: "start_session", repo: "api", task: "  " },
      { v: 1, ticketKey: "P-1", op: "start_session", repo: "api", task: "x".repeat(TASK_LIMIT + 1) },
    ]) {
      expect(parseControlRequest(bad)).toBeNull();
    }
  });
});

describe("sanitizeTask", () => {
  it("keeps newlines and tabs, drops ESC and other control characters", () => {
    expect(sanitizeTask("  第一行\r\n\t第二行\x1b[201~\r\x07rm  ")).toBe("第一行\n\t第二行[201~\nrm");
  });
});
