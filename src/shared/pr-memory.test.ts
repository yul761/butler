import { describe, expect, it } from "vitest";
import type { Pr } from "./handoff";
import { dedupeHandoffPrs, rememberMergedPrs } from "./pr-memory";

const pr = (number: number, state: Pr["state"], url = `https://github.com/acme/ui/pull/${number}`): Pr => ({ number, url, state, review: null });

describe("rememberMergedPrs", () => {
  it("keeps a merged PR that a later handoff no longer mentions", () => {
    expect(rememberMergedPrs([], [[pr(402, "merged")], [pr(402, "open")]])).toEqual([pr(402, "merged")]);
  });

  it("does not let a later report turn a merged PR back into open or closed", () => {
    expect(rememberMergedPrs([pr(402, "open"), pr(403, "closed")], [[pr(402, "merged"), pr(403, "merged")]])).toEqual([pr(402, "merged"), pr(403, "merged")]);
  });

  it("matches links loosely, puts the latest PRs first and the newest remembered ones next", () => {
    const latest = [pr(404, "open"), pr(402, "open", "https://GitHub.com/acme/ui/pull/402/")];
    const out = rememberMergedPrs(latest, [[pr(401, "merged")], [pr(400, "merged"), pr(401, "merged")], [pr(402, "merged")]]);
    expect(out.map((p) => [p.number, p.state])).toEqual([[404, "open"], [402, "merged"], [401, "merged"], [400, "merged"]]);
  });

  it("only remembers merged PRs: an open or closed one that disappeared stays gone", () => {
    expect(rememberMergedPrs([], [[pr(1, "open"), pr(2, "closed")]])).toEqual([]);
    expect(rememberMergedPrs([pr(1, "open")], [])).toEqual([pr(1, "open")]);
  });

  it("falls back to the PR number when there is no link", () => {
    expect(rememberMergedPrs([pr(9, "open", "")], [[pr(9, "merged", "")]])).toEqual([pr(9, "merged", "")]);
  });
});

describe("dedupeHandoffPrs", () => {
  it("dedupes an empty-URL entry into the URL entry with the same number", () => {
    const url = pr(3, "open");
    expect(dedupeHandoffPrs([pr(3, "open", ""), url])).toEqual([url]);
    expect(dedupeHandoffPrs([url, pr(3, "open", "  ")])).toEqual([url]);
  });

  it("keeps empty-URL entries of different numbers apart and the first of URL duplicates", () => {
    const a = pr(3, "open", "https://github.com/a/x/pull/3");
    expect(dedupeHandoffPrs([pr(3, "open", ""), pr(5, "open", ""), pr(5, "merged", "")])).toEqual([pr(3, "open", ""), pr(5, "open", "")]);
    expect(dedupeHandoffPrs([a, { ...a, url: "https://GitHub.com/a/x/pull/3/", state: "merged" }])).toEqual([a]);
  });

  it("rememberMergedPrs no longer returns both #3 and https://…/pull/3", () => {
    const out = rememberMergedPrs([pr(3, "open")], [[pr(3, "merged", "")]]);
    expect(out.map((p) => p.number)).toEqual([3]);
    expect(rememberMergedPrs([pr(3, "open", ""), pr(3, "open")], []).map((p) => p.url)).toEqual(["https://github.com/acme/ui/pull/3"]);
  });
});
