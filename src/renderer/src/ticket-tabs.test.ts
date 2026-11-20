import { describe, expect, it } from "vitest";
import type { Turn, UnattendedWhy } from "../../shared/turn";
import { landingTab } from "./ticket-tabs";

const unattended = (why: UnattendedWhy): Turn => ({ owner: "you", kind: "unattended", why, canSend: false, sessionId: null });

describe("landingTab", () => {
  it("answer and stuck land on the terminal", () => {
    expect(landingTab({ owner: "you", kind: "answer", question: "q", options: [], askId: null, sessionId: "s" })).toBe("terminal");
    for (const source of ["needs_you", "blocked_report", "silent", "ticket_blocked"] as const)
      expect(landingTab({ owner: "you", kind: "stuck", source, detail: null, sessionId: null })).toBe("terminal");
  });
  it("unattended agent_stopped lands on the terminal", () => expect(landingTab(unattended("agent_stopped"))).toBe("terminal"));
  it("other unattended reasons land on the PR", () => {
    for (const why of ["ci_failing", "changes_requested", "conflicts", "behind", "draft", "no_reviewer", "ci_undelivered"] as const)
      expect(landingTab(unattended(why))).toBe("pr");
  });
  it("external lands on the PR", () => {
    for (const kind of ["ci_running", "awaiting_review", "merge_queue"] as const) expect(landingTab({ owner: "external", kind, names: [] })).toBe("pr");
  });
  it("everything else lands on the overview", () => {
    expect(landingTab({ owner: "you", kind: "merge", risk: null })).toBe("overview");
    expect(landingTab({ owner: "you", kind: "review", author: "a", title: "t", url: "u" })).toBe("overview");
    expect(landingTab({ owner: "you", kind: "butler", notice: {} as never })).toBe("overview");
    expect(landingTab({ owner: "agent", kind: "working", sessionId: "s" })).toBe("overview");
    expect(landingTab({ owner: "done", kind: "merged" })).toBe("overview");
    expect(landingTab({ owner: "idle", kind: "not_started" })).toBe("overview");
  });
});
