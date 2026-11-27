import { describe, expect, it } from "vitest";
import type { TicketStatus } from "../../shared/types";
import { deriveStatus, type StatusInput } from "./status";

const pr = (state: "open" | "merged" | "closed", review: "pending" | "changes_requested" | "approved" | null = null) => ({ number: 1, url: "u", state, review });
const h = (over: Partial<StatusInput>): StatusInput => ({ status: "active", prs: [], blockers: [], ...over });

describe("deriveStatus", () => {
  it.each<[string, StatusInput, number, TicketStatus]>([
    ["merged PR with open followups", h({ status: "in_review", prs: [pr("merged")] }), 1, "merged_pending_followup"],
    ["merged PR, nothing left", h({ status: "in_review", prs: [pr("merged")] }), 0, "done"],
    ["model says done, followups left", h({ status: "done" }), 2, "merged_pending_followup"],
    ["model says merged_pending_followup but none left", h({ status: "merged_pending_followup" }), 0, "done"],
    ["explicitly blocked even with an open PR", h({ status: "blocked", prs: [pr("open")] }), 0, "blocked"],
    ["model says done but the PR is still open", h({ status: "done", prs: [pr("open")] }), 0, "in_review"],
    ["model says merged_pending_followup but the PR is still open", h({ status: "merged_pending_followup", prs: [pr("open")] }), 2, "in_review"],
    ["open PR", h({ prs: [pr("open", "pending")] }), 0, "in_review"],
    ["open PR with waiting listed as a blocker", h({ prs: [pr("open")], blockers: ["等 review"] }), 0, "in_review"],
    ["blockers without a PR", h({ blockers: ["等后端接口"] }), 0, "blocked"],
    // BTL-270：PR 都关了没合，也没有开着的：等人决定，不再沿用旧的 blockers / blocked，也不悄悄变回 active。
    ["closed PR", h({ status: "in_review", prs: [pr("closed")] }), 0, "needs_decision"],
    ["closed PR on a blocked ticket with old blockers", h({ status: "blocked", prs: [pr("closed")], blockers: ["等 review"] }), 0, "needs_decision"],
    ["closed PR, the model says it is working again", h({ status: "active", prs: [pr("closed")] }), 0, "active"],
    ["closed PR, the model says active but lists blockers", h({ status: "active", prs: [pr("closed")], blockers: ["等后端"] }), 0, "blocked"],
    ["needs_decision with a new open PR", h({ status: "needs_decision", prs: [pr("closed"), pr("open")] }), 0, "in_review"],
    ["needs_decision with a PR merged after all", h({ status: "needs_decision", prs: [pr("merged")] }), 1, "merged_pending_followup"],
    ["needs_decision without PRs", h({ status: "needs_decision" }), 0, "needs_decision"],
    // closed 只能手动关（closeTicket）：模型自己报 closed 当作等人决定。
    ["the model says closed", h({ status: "closed" }), 0, "needs_decision"],
    ["in review without PR info", h({ status: "in_review" }), 0, "in_review"],
    ["plain active", h({}), 0, "active"],
  ])("%s", (_name, input, open, expected) => {
    expect(deriveStatus(input, open)).toBe(expected);
  });

  it("waits for every PR of a multi-repo ticket before calling it merged", () => {
    const pr = (state: "open" | "merged" | "closed") => ({ number: 1, url: "u", state, review: null });
    expect(deriveStatus({ status: "merged_pending_followup", prs: [pr("merged"), pr("open")], blockers: [] }, 1)).toBe("in_review");
    expect(deriveStatus({ status: "in_review", prs: [pr("merged"), pr("merged")], blockers: [] }, 1)).toBe("merged_pending_followup");
    expect(deriveStatus({ status: "in_review", prs: [pr("merged"), pr("closed")], blockers: [] }, 0)).toBe("done");
  });

  it("a remembered merged PR does not override an explicit active", () => {
    expect(deriveStatus(h({ status: "active" }), 0, { remembered: [pr("merged")], linkedOpen: false })).toBe("active");
  });

  it("a remembered merged PR does not override in_review", () => {
    expect(deriveStatus(h({ status: "in_review" }), 0, { remembered: [pr("merged")], linkedOpen: false })).toBe("in_review");
  });

  it("an open linked PR makes an active ticket in_review", () => {
    expect(deriveStatus(h({ status: "active" }), 0, { remembered: [], linkedOpen: true })).toBe("in_review");
    expect(deriveStatus(h({ status: "blocked" }), 0, { remembered: [], linkedOpen: true })).toBe("blocked");
    expect(deriveStatus(h({ status: "active" }), 0, { remembered: [pr("open")], linkedOpen: false })).toBe("in_review");
  });

  it("model active with its own merged PR stays active (sequential PRs)", () => {
    expect(deriveStatus(h({ status: "active", prs: [pr("merged")] }), 0)).toBe("active");
  });

  it("a PR Shipherd gave up reading does not hold the ticket in review, whether the model, the memory or a refresh reports it open", () => {
    const a = { number: 1, url: "https://github.com/o/app/pull/1", state: "merged" as const, review: null };
    const b = { number: 2, url: "https://github.com/o/app/pull/2", state: "open" as const, review: null };
    const givenUp = new Set(["https://github.com/o/app/pull/2"]);
    expect(deriveStatus({ status: "in_review", prs: [a, b], blockers: [] }, 0)).toBe("in_review");
    expect(deriveStatus({ status: "in_review", prs: [a, { ...b, url: "https://github.com/O/app/pull/2/" }], blockers: [] }, 0, { remembered: [], linkedOpen: false, givenUp })).toBe("done");
    expect(deriveStatus({ status: "active", prs: [], blockers: [] }, 0, { remembered: [a, b], linkedOpen: false, givenUp })).toBe("active");
  });

  it("a handoff PR in a repo that is not the ticket's (never linked, never read) does not hold the ticket in review (BTL-261 review)", () => {
    const a = { number: 1, url: "https://github.com/o/app/pull/1", state: "merged" as const, review: null };
    const b = { number: 25, url: "https://github.com/x/other/pull/25", state: "open" as const, review: null };
    const foreign = (url: string) => url.includes("/x/other/");
    expect(deriveStatus({ status: "in_review", prs: [a, b], blockers: [] }, 0, { remembered: [], linkedOpen: false, foreign })).toBe("done");
    expect(deriveStatus({ status: "active", prs: [], blockers: [] }, 0, { remembered: [a, b], linkedOpen: false, foreign })).toBe("active");
    // 自己仓库的开着的 PR 照样留在 review。
    expect(deriveStatus({ status: "in_review", prs: [a, { ...b, url: "https://github.com/o/app/pull/25" }], blockers: [] }, 0, { remembered: [], linkedOpen: false, foreign })).toBe("in_review");
  });
});
