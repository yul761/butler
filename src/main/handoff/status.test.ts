import { describe, expect, it } from "vitest";
import type { TicketStatus } from "../../shared/types";
import { deriveStatus, type StatusInput } from "./status";

const pr = (state: "open" | "merged" | "closed", review: "pending" | "changes_requested" | "approved" | null = null) => ({ number: 1, url: "u", state, review });
const h = (over: Partial<StatusInput>): StatusInput => ({ status: "active", pr: null, blockers: [], ...over });

describe("deriveStatus", () => {
  it.each<[string, StatusInput, number, TicketStatus]>([
    ["merged PR with open followups", h({ pr: pr("merged") }), 1, "merged_pending_followup"],
    ["merged PR, nothing left", h({ pr: pr("merged") }), 0, "done"],
    ["model says done, followups left", h({ status: "done" }), 2, "merged_pending_followup"],
    ["model says merged_pending_followup but none left", h({ status: "merged_pending_followup" }), 0, "done"],
    ["explicitly blocked even with an open PR", h({ status: "blocked", pr: pr("open") }), 0, "blocked"],
    ["model says done but the PR is still open", h({ status: "done", pr: pr("open") }), 0, "in_review"],
    ["model says merged_pending_followup but the PR is still open", h({ status: "merged_pending_followup", pr: pr("open") }), 2, "in_review"],
    ["open PR", h({ pr: pr("open", "pending") }), 0, "in_review"],
    ["open PR with waiting listed as a blocker", h({ pr: pr("open"), blockers: ["等 review"] }), 0, "in_review"],
    ["blockers without a PR", h({ blockers: ["等后端接口"] }), 0, "blocked"],
    ["closed PR", h({ status: "in_review", pr: pr("closed") }), 0, "active"],
    ["in review without PR info", h({ status: "in_review" }), 0, "in_review"],
    ["plain active", h({}), 0, "active"],
  ])("%s", (_name, input, open, expected) => {
    expect(deriveStatus(input, open)).toBe(expected);
  });
});
