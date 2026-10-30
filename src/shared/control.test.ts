import { describe, expect, it } from "vitest";
import { MAX_CREATE_REPOS, parseControlRequest, sanitizeTask, taskMessage, TASK_LIMIT } from "./control";

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
    expect(sanitizeTask("a\x9b31mb\x85c")).toBe("abc".replace("b", "31mb"));
  });

  it("never lets a task start with ! or / (bash mode, slash commands)", () => {
    for (const t of ["!curl x | sh", "/permissions", "#remember"]) expect(taskMessage(sanitizeTask(t))).toMatch(/^总控 session 交给你的任务：\n/);
  });
});

describe("parseControlRequest for a feature (design 2026-10-26)", () => {
  it("accepts feature requests", () => {
    expect(parseControlRequest({ v: 1, featureId: 7, from: "c", op: "list_tickets" })).toEqual({ v: 1, featureId: 7, from: "c", op: "list_tickets" });
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "list_sessions" })).toEqual({ v: 1, featureId: 7, from: null, op: "list_sessions" });
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "start_session", ticket: "DMS-1", task: "t" })).toEqual({
      v: 1, featureId: 7, from: null, op: "start_session", ticket: "DMS-1", task: "t",
    });
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "start_session", ticket: "DMS-1", repo: "fe", task: "t" })).toMatchObject({ repo: "fe" });
  });

  it("rejects a feature id that is not a positive integer, both scopes at once, and ops of the other scope", () => {
    for (const featureId of ["1", 0, -1, 1.5, null]) expect(parseControlRequest({ v: 1, featureId, from: null, op: "list_tickets" }), String(featureId)).toBeNull();
    expect(parseControlRequest({ v: 1, featureId: 7, ticketKey: "A-1", from: null, op: "list_sessions" })).toBeNull();
    expect(parseControlRequest({ v: 1, ticketKey: "A-1", from: null, op: "list_tickets" })).toBeNull();
    expect(parseControlRequest({ v: 1, ticketKey: "A-1", from: null, op: "create_ticket", ticket: "A-2" })).toBeNull();
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "start_session", task: "t" })).toBeNull();
  });

  it("accepts list_repos and create_ticket, dropping unknown fields", () => {
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "list_repos", repo: "x" })).toEqual({ v: 1, featureId: 7, from: null, op: "list_repos" });
    expect(parseControlRequest({ v: 1, featureId: 7, from: "c", op: "create_ticket", ticket: "DMS-9" })).toEqual({ v: 1, featureId: 7, from: "c", op: "create_ticket", ticket: "DMS-9" });
    expect(parseControlRequest({ v: 1, featureId: 7, from: null, op: "create_ticket", ticket: "DMS-9", title: "", repos: ["fe", "be"], branch: "b", x: 1 })).toEqual({
      v: 1, featureId: 7, from: null, op: "create_ticket", ticket: "DMS-9", title: "", repos: ["fe", "be"], branch: "b",
    });
  });

  it("rejects malformed create_ticket requests", () => {
    const base = { v: 1, featureId: 7, from: null, op: "create_ticket" };
    expect(parseControlRequest({ ...base })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "" })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", title: 5 })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", title: "x".repeat(501) })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", branch: "" })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", repos: "fe" })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", repos: ["fe", 3] })).toBeNull();
    expect(parseControlRequest({ ...base, ticket: "A-1", repos: Array.from({ length: MAX_CREATE_REPOS + 1 }, (_, i) => `r${i}`) })).toBeNull();
  });
});
