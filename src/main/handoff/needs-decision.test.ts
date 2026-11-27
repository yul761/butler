import { describe, expect, it } from "vitest";
import type { Handoff, Pr } from "../../shared/handoff";
import { awaitsDecision, needsDecision } from "../../shared/types";
import type { TicketPr } from "../db/ticket-prs-repo";
import { prHandoff } from "../prwatch/pr-handoff";
import { deriveStatus } from "./status";

// BTL-270 审查（建议 1）：「要你决定」只有一个判断，deriveStatus、prHandoff、awaitsDecision 对同样的事实说法一致。
const url = (n: number) => `https://github.com/o/app/pull/${n}`;
const row = (n: number, state: TicketPr["state"]): TicketPr => ({
  id: n, ticketKey: "BTL-1", url: url(n), slug: "o/app", repoId: 1, number: n, headBranch: "btl-1",
  state, review: null, ci: "passing", readError: false, headSha: "a1", failed: [], openedAt: 1, mergedAt: null, closedAt: state === "closed" ? 2 : null,
  source: "branch", linkedAt: 1, checkedAt: 1, deliveredKey: null, deliveredAt: null, deliveredTo: null, mergedHandledAt: null, readFailures: 0, readFailingSince: null,
  readRetryAt: null, readNotFound: 0, readNotFoundSince: null, readGoneAt: null, baseBranch: null, isDraft: false, title: null, author: null, labels: [],
  reviewRequests: [], reviewers: [], mergeable: null, mergeState: null, statusChangedAt: null,
});
const asPr = (n: number, state: Pr["state"]): Pr => ({ number: n, url: url(n), state, review: "pending" });

const statuses: Handoff["status"][] = ["active", "in_review", "blocked", "needs_decision", "closed"];
const blockerSets = [[], ["等 API"]];
const prSets: { name: string; prs: [number, "open" | "closed"][] }[] = [
  { name: "all closed", prs: [[7, "closed"], [8, "closed"]] },
  { name: "one open", prs: [[7, "closed"], [8, "open"]] },
  { name: "only open", prs: [[7, "open"]] },
];

describe("needsDecision is the one rule behind deriveStatus, prHandoff and awaitsDecision", () => {
  for (const status of statuses) {
    for (const blockers of blockerSets) {
      for (const set of prSets) {
        it(`${status}, ${blockers.length} blockers, ${set.name}`, () => {
          const prs = set.prs.map(([n, s]) => asPr(n, s));
          const openPrs = prs.filter((p) => p.state === "open").length;
          const expected = needsDecision({
            status: status === "closed" ? "needs_decision" : status,
            blockedWithReasons: status === "blocked" && blockers.length > 0,
            openPrs,
            allClosed: openPrs === 0,
          });
          const derived = deriveStatus({ status, prs, blockers }, 0, { remembered: [], linkedOpen: false });
          expect(derived === "needs_decision").toBe(expected);
          const watched = prHandoff("BTL-1", set.prs.map(([n, s]) => row(n, s)), { id: 1, createdAt: 0, status, prs: [], blockers });
          expect(watched?.status === "needs_decision").toBe(expected);
          // 存的状态是算出来的那个：看板说不说要你决定，和算出来的一致。
          expect(awaitsDecision(derived, openPrs)).toBe(expected);
        });
      }
    }
  }

  it("a closed ticket or one with an open PR is not waiting for a decision", () => {
    expect(awaitsDecision("closed", 0)).toBe(false);
    expect(awaitsDecision("needs_decision", 1)).toBe(false);
    expect(awaitsDecision("needs_decision", 0)).toBe(true);
    expect(needsDecision({ status: "active", blockedWithReasons: false, openPrs: 0, allClosed: true })).toBe(false);
    expect(needsDecision({ status: "blocked", blockedWithReasons: true, openPrs: 0, allClosed: true })).toBe(false);
    expect(needsDecision({ status: "blocked", blockedWithReasons: false, openPrs: 0, allClosed: true })).toBe(true);
    expect(needsDecision({ status: "in_review", blockedWithReasons: false, openPrs: 0, allClosed: false })).toBe(false);
  });

  it("a model-reported closed that a reopened PR contradicts goes back to review in prHandoff, as in deriveStatus", () => {
    const out = prHandoff("BTL-1", [row(7, "open")], { id: 1, createdAt: 0, status: "closed", prs: [], blockers: [] });
    expect(out?.status).toBe("in_review");
    expect(deriveStatus({ status: "closed", prs: [asPr(7, "open")], blockers: [] }, 0, { remembered: [], linkedOpen: false })).toBe("in_review");
  });
});
