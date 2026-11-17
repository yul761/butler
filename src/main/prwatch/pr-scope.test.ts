import { describe, expect, it } from "vitest";
import { assignToPrs, prEnd, type Scoped, type ScopePr } from "./pr-scope";

type Item = Scoped & { name: string };

const item = (name: string, at: number, o: Partial<Scoped> = {}): Item => ({ name, at, repoId: 1, branch: null, prId: null, number: null, ...o });
const pr = (id: number, number: number, start: number, end: number, o: Partial<ScopePr> = {}): ScopePr => ({
  id, repoId: 1, slug: "o/r", number, headBranch: "feat", start, end, ...o,
});
const repos = [{ id: 1, branch: "feat" }];
const names = (m: Map<number, Item[]>, k: number) => (m.get(k) ?? []).map((i) => i.name);

describe("prEnd", () => {
  it("is Infinity while open, else mergedAt, closedAt, then checkedAt", () => {
    expect(prEnd({ state: "open", mergedAt: null, closedAt: null, checkedAt: 5 })).toBe(Infinity);
    expect(prEnd({ state: "merged", mergedAt: 3, closedAt: 4, checkedAt: 5 })).toBe(3);
    expect(prEnd({ state: "closed", mergedAt: null, closedAt: 4, checkedAt: 5 })).toBe(4);
    expect(prEnd({ state: "merged", mergedAt: null, closedAt: null, checkedAt: 5 })).toBe(5);
  });
});

describe("assignToPrs", () => {
  const sequential = [pr(25, 25, 100, 300), pr(26, 26, 350, Infinity)];

  it("a skill before #25 merged goes to #25, one after it to #26", () => {
    const { byPr, noPr } = assignToPrs([item("before", 200), item("after", 320)], sequential, repos);
    expect(names(byPr, 25)).toEqual(["before"]);
    expect(names(byPr, 26)).toEqual(["after"]);
    expect(noPr.get(1) ?? []).toEqual([]);
  });

  it("a report after the last merge goes to the no-PR bucket", () => {
    const { byPr, noPr } = assignToPrs([item("report", 500)], [pr(25, 25, 100, 300)], repos);
    expect(names(byPr, 25)).toEqual([]);
    expect(names(noPr, 1)).toEqual(["report"]);
  });

  it("a skill with branch feature/x goes to the PR on feature/x even inside another PR's window", () => {
    const prs = [pr(25, 25, 100, 300), pr(30, 30, 150, Infinity, { headBranch: "feature/x" })];
    const { byPr } = assignToPrs([item("x", 200, { branch: "feature/x" }), item("plain", 200, { branch: "feat" })], prs, repos);
    expect(names(byPr, 30)).toEqual(["x"]);
    expect(names(byPr, 25)).toEqual(["plain"]);
  });

  it("several open PRs: the latest started wins", () => {
    const prs = [pr(1, 1, 100, Infinity, { headBranch: "a" }), pr(2, 2, 200, Infinity, { headBranch: "b" })];
    expect(names(assignToPrs([item("e", 300)], prs, repos).byPr, 2)).toEqual(["e"]);
  });

  it("a repo-less event is assigned in every repo group", () => {
    const prs = [pr(25, 25, 100, 300), pr(40, 40, 100, Infinity, { repoId: 2, headBranch: "feat" })];
    const both = [{ id: 1, branch: "feat" }, { id: 2, branch: "feat" }];
    const { byPr, noPr } = assignToPrs([item("all", 200, { repoId: null }), item("late", 400, { repoId: null })], prs, both);
    expect(names(byPr, 25)).toEqual(["all"]);
    expect(names(byPr, 40)).toEqual(["all", "late"]);
    expect(names(noPr, 1)).toEqual(["late"]);
    expect(names(noPr, 2)).toEqual([]);
  });

  it("a repo with no PRs puts everything in its no-PR bucket", () => {
    expect(names(assignToPrs([item("c", 10)], [], repos).noPr, 1)).toEqual(["c"]);
  });

  it("events with pr_id stay on their PR even after its merge", () => {
    const { byPr, noPr } = assignToPrs([item("ci", 999, { prId: 25 })], sequential, repos);
    expect(names(byPr, 25)).toEqual(["ci"]);
    expect(names(byPr, 26)).toEqual([]);
    expect(noPr.get(1) ?? []).toEqual([]);
  });

  it("an event with a PR number goes to that PR of its repo", () => {
    const { byPr } = assignToPrs([item("opened", 999, { number: 25 })], sequential, repos);
    expect(names(byPr, 25)).toEqual(["opened"]);
  });

  it("a slug group drops events after its last PR", () => {
    const prs = [pr(7, 7, 100, 300, { repoId: null, slug: "x/lib", headBranch: "lib-b" })];
    const { byPr, noPr } = assignToPrs([item("in", 200, { repoId: null }), item("after", 400, { repoId: null })], prs, []);
    expect(names(byPr, 7)).toEqual(["in"]);
    expect([...noPr.values()].flat()).toEqual([]);
  });
});
