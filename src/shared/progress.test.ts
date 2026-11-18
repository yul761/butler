import { describe, expect, it } from "vitest";
import { titlePrefix, waitingOnOf, type PrReviewer, type WaitingInput } from "./progress";

const base: WaitingInput = {
  state: "open", isDraft: false, ci: "passing", review: null, author: "me", reviewers: [], reviewRequests: [], mergeable: "mergeable", mergeState: "clean",
};
const p = (o: Partial<WaitingInput>): WaitingInput => ({ ...base, ...o });
const human = (login: string, state: PrReviewer["state"]): PrReviewer => ({ login, state, at: 1, bot: false });

describe("waitingOnOf", () => {
  it("is null for PRs that are not open", () => {
    expect(waitingOnOf(p({ state: "merged" }))).toBeNull();
    expect(waitingOnOf(p({ state: "closed" }))).toBeNull();
    expect(waitingOnOf(p({ state: null }))).toBeNull();
  });

  it("follows the order: draft, CI failing, changes requested, conflicts, behind, CI pending", () => {
    expect(waitingOnOf(p({ isDraft: true, ci: "failing" }))).toEqual({ who: "author", names: ["me"], reason: "draft" });
    expect(waitingOnOf(p({ ci: "failing", reviewers: [human("a", "changes_requested")] }))).toEqual({ who: "author", names: ["me"], reason: "ci_failing" });
    expect(waitingOnOf(p({ reviewers: [human("a", "changes_requested"), human("b", "approved")], mergeable: "conflicting" }))).toEqual({ who: "author", names: ["a"], reason: "changes_requested" });
    expect(waitingOnOf(p({ mergeable: "conflicting", mergeState: "behind" }))?.reason).toBe("conflicts");
    expect(waitingOnOf(p({ mergeState: "dirty" }))?.reason).toBe("conflicts");
    expect(waitingOnOf(p({ mergeState: "behind", ci: "pending" }))?.reason).toBe("behind");
    expect(waitingOnOf(p({ ci: "pending", reviewRequests: [{ kind: "user", name: "a" }] }))).toEqual({ who: "ci", names: [], reason: "ci_pending" });
  });

  it("reviewDecision CHANGES_REQUESTED without a matching reviewer still points at the author", () => {
    expect(waitingOnOf(p({ review: "changes_requested" }))).toEqual({ who: "author", names: [], reason: "changes_requested" });
  });

  it("bots do not count as reviewers", () => {
    expect(waitingOnOf(p({ reviewers: [{ login: "copilot", state: "changes_requested", at: 1, bot: true }] }))?.reason).toBe("no_reviewer");
    expect(waitingOnOf(p({ reviewers: [{ login: "x[bot]", state: "approved", at: 1, bot: true }] }))?.reason).toBe("no_reviewer");
  });

  it("approved and nothing more required → ready to merge, even with someone still requested", () => {
    expect(waitingOnOf(p({ reviewers: [human("a", "approved")], reviewRequests: [{ kind: "team", name: "core" }] }))).toEqual({ who: "author", names: ["me"], reason: "ready_to_merge" });
    expect(waitingOnOf(p({ review: "approved" }))?.reason).toBe("ready_to_merge");
  });

  it("more approvals required: waits on the requested reviewers, or on the author to ask someone", () => {
    expect(waitingOnOf(p({ review: "pending", reviewers: [human("a", "approved")], reviewRequests: [{ kind: "user", name: "b" }, { kind: "team", name: "core" }] }))).toEqual({
      who: "reviewers", names: ["b", "core"], reason: "review_requested",
    });
    expect(waitingOnOf(p({ review: "pending", reviewers: [human("a", "approved")] }))?.reason).toBe("no_reviewer");
    expect(waitingOnOf(p({ author: null }))).toEqual({ who: "author", names: [], reason: "no_reviewer" });
  });
});

describe("titlePrefix", () => {
  it("takes bracket tags, conventional-commit types and short colon heads", () => {
    expect(titlePrefix("[ui] Add page")).toBe("ui");
    expect(titlePrefix("feat(api): add x")).toBe("feat(api)");
    expect(titlePrefix("fix!: breaking")).toBe("fix");
    expect(titlePrefix("Docs: tidy up")).toBe("Docs");
    expect(titlePrefix("数据 导出: 加一列")).toBe("数据 导出");
  });
  it("returns null without a usable prefix", () => {
    expect(titlePrefix(null)).toBeNull();
    expect(titlePrefix("   ")).toBeNull();
    expect(titlePrefix("Add a page")).toBeNull();
    expect(titlePrefix("A very long sentence that goes on and on: then")).toBeNull();
    expect(titlePrefix("[] empty")).toBeNull();
    expect(titlePrefix("see https://x: y")).toBeNull();
  });
});
