import { describe, expect, it } from "vitest";
import type { Pr } from "../../shared/handoff";
import type { WatchedPr } from "../../shared/types";
import { prHandoff } from "./pr-handoff";

const row = (o: Partial<WatchedPr> = {}): WatchedPr => ({
  ticketKey: "BTL-1", repoId: 1, repoPath: "/r/app", branch: "btl-1", number: 7, url: "https://github.com/o/app/pull/7",
  state: "open", review: "pending", ci: "passing", headSha: "a1", checkedAt: 1, ...o,
});
const pr = (o: Partial<Pr> = {}): Pr => ({ number: 7, url: "https://github.com/o/app/pull/7", state: "open", review: "pending", ...o });

describe("prHandoff", () => {
  it("turns the watched PRs into handoff prs, signed by number:state:review and the handoff it builds on", () => {
    const rows = [row({ state: "merged", review: "approved" }), row({ repoId: 2, number: 3, url: "https://github.com/o/api/pull/3", review: null })];
    expect(prHandoff("BTL-1", rows, { id: 41, prs: [pr()] })).toEqual({
      prs: [pr({ state: "merged", review: "approved" }), pr({ number: 3, url: "https://github.com/o/api/pull/3", review: null })],
      sourceRef: "prwatch:BTL-1:7:merged:approved,3:open:@41",
    });
  });

  it("leaves out rows without a PR", () => {
    const rows = [row({ review: "approved" }), row({ repoId: 2, number: null, url: null, state: null, review: null, ci: "failing" })];
    expect(prHandoff("BTL-1", rows, { id: 1, prs: [] })?.prs).toEqual([pr({ review: "approved" })]);
  });

  it("keeps the PRs of the last handoff the watcher does not follow (matched by link)", () => {
    const other = pr({ number: 9, url: "https://github.com/o/docs/pull/9" });
    const out = prHandoff("BTL-1", [row({ state: "merged" })], { id: 1, prs: [pr({ url: "https://github.com/O/app/pull/7/" }), other] });
    expect(out?.prs).toEqual([pr({ state: "merged" }), other]);
  });

  it("returns null when no row has a PR, or when the PRs are what the last handoff already says", () => {
    expect(prHandoff("BTL-1", [row({ number: null, url: null, state: null, review: null })], { id: 1, prs: [pr()] })).toBeNull();
    expect(prHandoff("BTL-1", [], { id: 1, prs: [pr()] })).toBeNull();
    expect(prHandoff("BTL-1", [row()], { id: 1, prs: [pr()] })).toBeNull();
  });

  it("a review that goes back and forth gets a new source ref each time, so it is not dropped as a duplicate", () => {
    const approved = prHandoff("BTL-1", [row({ review: "approved" })], { id: 1, prs: [pr()] });
    const pending = prHandoff("BTL-1", [row()], { id: 2, prs: approved!.prs });
    const again = prHandoff("BTL-1", [row({ review: "approved" })], { id: 3, prs: pending!.prs });
    expect(new Set([approved?.sourceRef, pending?.sourceRef, again?.sourceRef]).size).toBe(3);
  });
});
