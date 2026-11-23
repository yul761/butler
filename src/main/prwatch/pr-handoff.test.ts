import { describe, expect, it } from "vitest";
import type { Pr } from "../../shared/handoff";
import type { TicketPr } from "../db/ticket-prs-repo";
import { prHandoff } from "./pr-handoff";

const row = (o: Partial<TicketPr> = {}): TicketPr => ({
  id: 1, ticketKey: "BTL-1", url: "https://github.com/o/app/pull/7", slug: "o/app", repoId: 1, number: 7, headBranch: "btl-1",
  state: "open", review: "pending", ci: "passing", readError: false, headSha: "a1", failed: [], openedAt: 1, mergedAt: null, closedAt: null,
  source: "branch", linkedAt: 1, checkedAt: 1, deliveredKey: null, deliveredAt: null, deliveredTo: null, mergedHandledAt: null, readFailures: 0, readFailingSince: null, readRetryAt: null, readNotFound: 0, readNotFoundSince: null, readGoneAt: null, baseBranch: null, isDraft: false, title: null, author: null, labels: [], reviewRequests: [], reviewers: [], mergeable: null, mergeState: null, statusChangedAt: null, ...o,
});
const pr = (o: Partial<Pr> = {}): Pr => ({ number: 7, url: "https://github.com/o/app/pull/7", state: "open", review: "pending", ...o });
const base = (id: number, prs: Pr[]) => ({ id, createdAt: 0, status: "in_review" as const, prs });

describe("prHandoff", () => {
  it("turns the watched PRs into handoff prs, signed by number:state:review and the handoff it builds on", () => {
    const rows = [row({ state: "merged", review: "approved" }), row({ id: 2, repoId: 2, number: 3, url: "https://github.com/o/api/pull/3", review: null })];
    expect(prHandoff("BTL-1", rows, base(41, [pr()]))).toEqual({
      prs: [pr({ state: "merged", review: "approved" }), pr({ number: 3, url: "https://github.com/o/api/pull/3", review: null })],
      status: "in_review",
      sourceRef: "prwatch:BTL-1:7:merged:approved,3:open:@41",
    });
  });

  it("leaves out rows that were never read", () => {
    const rows = [row({ review: "approved" }), row({ id: 2, number: 8, url: "https://github.com/o/app/pull/8", checkedAt: 0 })];
    expect(prHandoff("BTL-1", rows, base(1, []))?.prs).toEqual([pr({ review: "approved" })]);
  });

  it("drops an empty-URL base entry that a watched row with the same number covers", () => {
    const out = prHandoff("BTL-1", [row({ review: "approved" })], base(1, [pr({ url: "" }), pr({ number: 5, url: "" })]));
    expect(out?.prs.map((p) => [p.number, p.url])).toEqual([[7, "https://github.com/o/app/pull/7"], [5, ""]]);
  });

  it("appends linked PRs from other branches", () => {
    // 同一个分支上先合并的 #5、另一个 ticket 仓库之外的 PR（repoId 为 null）都算这个 ticket 的。
    const rows = [
      row(),
      row({ id: 2, number: 5, url: "https://github.com/o/app/pull/5", headBranch: "btl-1-old", state: "merged" }),
      row({ id: 3, number: 9, url: "https://github.com/o/docs/pull/9", repoId: null, headBranch: null, review: null }),
    ];
    expect(prHandoff("BTL-1", rows, base(1, [pr()]))?.prs).toEqual([
      pr(), pr({ number: 5, url: "https://github.com/o/app/pull/5", state: "merged" }), pr({ number: 9, url: "https://github.com/o/docs/pull/9", review: null }),
    ]);
  });

  it("keeps the PRs of the last handoff the watcher does not follow (matched by link)", () => {
    const other = pr({ number: 9, url: "https://github.com/o/docs/pull/9" });
    const out = prHandoff("BTL-1", [row({ state: "merged" })], base(1, [pr({ url: "https://github.com/O/app/pull/7/" }), other]));
    expect(out?.prs).toEqual([pr({ state: "merged" }), other]);
  });

  it("returns null when no row was read, or when the PRs are what the last handoff already says", () => {
    expect(prHandoff("BTL-1", [row({ checkedAt: 0 })], base(1, [pr()]))).toBeNull();
    expect(prHandoff("BTL-1", [], base(1, [pr()]))).toBeNull();
    expect(prHandoff("BTL-1", [row()], base(1, [pr()]))).toBeNull();
  });

  it("a review that goes back and forth gets a new source ref each time, so it is not dropped as a duplicate", () => {
    const approved = prHandoff("BTL-1", [row({ review: "approved" })], base(1, [pr()]));
    const pending = prHandoff("BTL-1", [row()], base(2, approved!.prs));
    const again = prHandoff("BTL-1", [row({ review: "approved" })], base(3, pending!.prs));
    expect(new Set([approved?.sourceRef, pending?.sourceRef, again?.sourceRef]).size).toBe(3);
  });

  it("a PR merged after the base handoff, none open, promotes active to done", () => {
    const b = { id: 1, createdAt: 100, status: "active" as const, prs: [pr()] };
    expect(prHandoff("BTL-1", [row({ state: "merged", mergedAt: 200 })], b)?.status).toBe("done");
    expect(prHandoff("BTL-1", [row({ state: "merged", mergedAt: 200 })], { ...b, status: "in_review" })?.status).toBe("done");
    expect(prHandoff("BTL-1", [row({ state: "merged", mergedAt: 200 }), row({ id: 2, number: 8, url: "https://github.com/o/app/pull/8" })], b)?.status).toBe("active");
  });

  it("a PR merged before the base handoff does not", () => {
    const b = { id: 1, createdAt: 100, status: "active" as const, prs: [pr()] };
    expect(prHandoff("BTL-1", [row({ state: "merged", mergedAt: 50 })], b)?.status).toBe("active");
  });

  it("leaves out a given-up open row and drops it from the base, so a merged sibling promotes the ticket", () => {
    const b = "https://github.com/o/app/pull/8";
    const rows = [row({ state: "merged", mergedAt: 5 }), row({ id: 2, number: 8, url: b, readFailures: 12, readFailingSince: 1, readRetryAt: 99, readError: true })];
    const out = prHandoff("BTL-1", rows, base(3, [pr(), pr({ number: 8, url: b })]));
    expect(out?.prs).toEqual([pr({ state: "merged" })]);
    expect(out?.status).toBe("done");
  });
});

