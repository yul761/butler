import { describe, expect, it } from "vitest";
import type { PrDetail, Ticket, WatchedPr } from "../../shared/types";
import { bucketOf, buildProgress, buildStacks, firstSentence, progressOverview, type ProgressInput } from "./progress-view";

const ticket = (key: string, o: Partial<Ticket> = {}): Ticket => ({
  key, title: `${key} title`, repos: [], status: "active", statusManual: null, createdAt: 1, archivedAt: null, featureId: null, ...o,
});

let nextId = 1;
const detail = (o: Partial<PrDetail> = {}): PrDetail => ({
  baseBranch: "main", isDraft: false, title: null, author: "me", labels: [], reviewRequests: [], reviewers: [], mergeable: "mergeable", mergeState: "clean",
  statusChangedAt: 100, slug: "o/app", ...o,
});
const pr = (ticketKey: string, n: number, o: Partial<WatchedPr> = {}, d: Partial<PrDetail> = {}): WatchedPr => ({
  ticketKey, prId: nextId++, repoId: 1, repoPath: "/code/app", branch: `b${n}`, number: n, url: `https://github.com/o/app/pull/${n}`, state: "open",
  review: "pending", ci: "passing", headSha: "s", checkedAt: 500, readError: false, detail: detail(d), ...o,
});

const input = (o: Partial<ProgressInput> = {}): ProgressInput => ({
  now: 1000, tickets: [], features: [], epics: [], prs: [], summary: () => null, started: () => false, ...o,
});

describe("firstSentence", () => {
  it("cuts at the first sentence end and caps the length", () => {
    expect(firstSentence("做完了登录。还差注册。")).toBe("做完了登录。");
    expect(firstSentence("v1.2 shipped. Next is docs.")).toBe("v1.2 shipped.");
    expect(firstSentence("  ")).toBeNull();
    expect(firstSentence("x".repeat(300))).toHaveLength(140);
  });
});

describe("bucketOf", () => {
  const p = (o: Partial<WatchedPr> = {}, d: Partial<PrDetail> = {}) => {
    const v = buildProgress(input({ tickets: [ticket("A")], prs: [pr("A", 1, o, d)] }));
    return v.stuck[0]?.pr ?? null;
  };
  it("follows the documented order", () => {
    const t = ticket("A");
    expect(bucketOf({ ...t, statusManual: "done" }, [], false)).toBe("merged");
    const merged = { ...p()!, state: "merged" as const };
    expect(bucketOf(t, [merged], false)).toBe("merged");
    expect(bucketOf({ ...t, status: "blocked" }, [], true)).toBe("blocked");
    expect(bucketOf(t, [p({ ci: "failing" })!], false)).toBe("blocked");
    expect(bucketOf(t, [p({}, { mergeable: "conflicting" })!], false)).toBe("blocked");
    expect(bucketOf(t, [p({}, { reviewers: [{ login: "x", state: "changes_requested", at: 1, bot: false }] })!], false)).toBe("blocked");
    expect(bucketOf(t, [p()!, merged], false)).toBe("in_review");
    expect(bucketOf(t, [p({}, { isDraft: true })!], false)).toBe("in_progress");
    expect(bucketOf(t, [], true)).toBe("in_progress");
    expect(bucketOf(t, [], false)).toBe("not_started");
  });
});

describe("buildProgress", () => {
  const features = [{ id: 1, name: "Login", epicId: 10 }, { id: 2, name: "Billing", epicId: null }];
  const tickets = [ticket("A", { featureId: 1 }), ticket("B", { featureId: 1 }), ticket("C", { featureId: 2 }), ticket("D"), ticket("E", { featureId: 1, status: "blocked" })];
  const prs = [
    pr("A", 1, { review: "pending" }, { reviewRequests: [{ kind: "user", name: "alice" }], statusChangedAt: 300, labels: ["ui"], title: "[auth] login" }),
    pr("A", 2, { state: "merged" }, { labels: ["ui", "api"], title: "feat(auth): token" }),
    pr("B", 3, { ci: "failing" }, { statusChangedAt: 200, title: "Fix: crash", baseBranch: "b1" }),
    pr("C", 4, { checkedAt: 0 }),
    pr("C", 5, { state: "closed" }),
    // 同一个 PR 链接在两个 ticket 上。
    { ...pr("D", 1, { review: "pending" }, { reviewRequests: [{ kind: "user", name: "alice" }], statusChangedAt: 300, labels: ["ui"], title: "[auth] login" }) },
    { ticketKey: "D", prId: null, repoId: 1, repoPath: "/code/app", branch: "x", number: null, url: null, state: null, review: null, ci: "none", headSha: null, checkedAt: 1, readError: false },
  ] satisfies WatchedPr[];
  const base = input({
    tickets, features, epics: [{ id: 10, name: "Q4" }], prs, started: (k) => k === "C",
    summary: (id) => (id === 1 ? { summary: "Login works. Signup next.", at: 50, prStatusAt: 60, stale: true } : null),
  });

  it("counts every ticket in exactly one bucket", () => {
    const v = buildProgress(base);
    expect(v.counts).toEqual({ merged: 0, blocked: 2, in_review: 2, in_progress: 1, not_started: 0, total: 5 });
  });

  it("lists who each PR waits on, longest-stuck first, plus blocked tickets with no open PR", () => {
    const v = buildProgress(base);
    expect(v.stuck.map((s) => [s.ticketKey, s.pr?.number ?? null, s.waitingOn.who, s.waitingOn.reason, s.waitingOn.names])).toEqual([
      ["B", 3, "author", "ci_failing", ["me"]],
      ["A", 1, "reviewers", "review_requested", ["alice"]],
      ["E", null, "ticket", "ticket_blocked", []],
    ]);
  });

  it("builds a stack from base/head branches and keeps singles apart", () => {
    const v = buildProgress(base);
    expect(v.stacks).toHaveLength(1);
    expect(v.stacks[0].repo).toBe("app");
    expect(v.stacks[0].stacks.map((n) => [n.pr.number, n.children.map((c) => c.pr.number)])).toEqual([[1, [3]]]);
    expect(v.stacks[0].single).toEqual([]);
  });

  it("groups the PR table by label and by title prefix, without closed PRs or duplicates", () => {
    const v = buildProgress(base);
    expect(v.groups.byLabel.map((g) => [g.key, g.prs.map((p) => p.number)])).toEqual([["api", [2]], ["ui", [1, 2]], [null, [3]]]);
    expect(v.groups.byPrefix.map((g) => [g.key, g.prs.map((p) => p.number)])).toEqual([["auth", [1]], ["feat(auth)", [2]], ["Fix", [3]]]);
  });

  it("groups tickets by feature with the summary's first line, and puts loose tickets last", () => {
    const v = buildProgress(base);
    expect(v.featureGroups.map((g) => [g.id, g.name, g.line, g.stale, g.tickets.map((t) => t.key)])).toEqual([
      [1, "Login", "Login works.", true, ["A", "B", "E"]],
      [2, "Billing", null, false, ["C"]],
      [null, null, null, false, ["D"]],
    ]);
    expect(v.featureGroups[0].counts).toMatchObject({ in_review: 1, blocked: 2 });
    expect(v.featureGroups[0]).toMatchObject({ summaryAt: 50, prStatusAt: 60 });
  });

  it("reports freshness: checked range, read errors, unread rows, oldest summary", () => {
    const v = buildProgress({ ...base, prs: [...prs, pr("B", 9, { checkedAt: 900, readError: true })] });
    expect(v.freshness).toEqual({ generatedAt: 1000, prsCheckedOldest: 500, prsCheckedNewest: 900, readErrors: 1, unread: 1, summaryOldest: 50 });
  });

  it("filters by epic and by feature", () => {
    const byEpic = buildProgress(base, { epicId: 10 });
    expect(byEpic.counts.total).toBe(3);
    expect(byEpic.featureGroups.map((g) => g.id)).toEqual([1]);
    const byFeature = buildProgress(base, { featureId: 2 });
    expect(byFeature.featureGroups.map((g) => g.id)).toEqual([2]);
    expect(byFeature.counts).toMatchObject({ total: 1, in_progress: 1 });
    expect(byFeature.stuck).toEqual([]);
    // 下拉用的列表不受过滤影响。
    expect(byFeature.features).toHaveLength(2);
    expect(byFeature.filter).toEqual({ epicId: null, featureId: 2 });
  });
});

describe("buildStacks", () => {
  const mk = (n: number, head: string, baseBranch: string, slug = "o/app") => {
    const v = buildProgress(input({ tickets: [ticket("A")], prs: [pr("A", n, { branch: head }, { baseBranch, slug })] }));
    return v.stuck[0].pr!;
  };
  it("nests multi-level stacks per repo and survives cycles", () => {
    const out = buildStacks([mk(1, "a", "main"), mk(2, "b", "a"), mk(3, "c", "b"), mk(4, "z", "main"), mk(5, "a", "main", "o/other")]);
    expect(out.map((r) => r.repo)).toEqual(["app", "app"]);
    expect(out[0].stacks[0].pr.number).toBe(1);
    expect(out[0].stacks[0].children[0].children[0].pr.number).toBe(3);
    expect(out[0].single.map((p) => p.number)).toEqual([4]);
    expect(out[1].single.map((p) => p.number)).toEqual([5]);
    const cyc = buildStacks([mk(1, "a", "b"), mk(2, "b", "a")]);
    expect(cyc[0].stacks.map((n) => [n.pr.number, n.children.map((c) => c.pr.number)])).toEqual([[1, [2]]]);
  });
});

interface Overview {
  stuck: Record<string, unknown>[];
  stacks: { stacks: unknown[] }[];
  groups: { byLabel: unknown[] };
  features: Record<string, unknown>[];
  prs: Record<string, unknown>[];
  freshness: { generatedAt: string };
}

describe("progressOverview", () => {
  it("writes times as ISO, names next to ids, and each PR once with repo#number references", () => {
    const v = buildProgress(input({
      tickets: [ticket("A", { featureId: 1 })], features: [{ id: 1, name: "Login", epicId: 10 }], epics: [{ id: 10, name: "Q4" }],
      prs: [pr("A", 1, {}, { reviewRequests: [{ kind: "user", name: "bob" }], labels: ["ui"], statusChangedAt: 86_400_000 }), pr("A", 2, {}, { baseBranch: "b1" })],
    }));
    const o = progressOverview(v) as unknown as Overview;
    expect(o.stuck[1]).toMatchObject({ pr: "app#1", since: "1970-01-02T00:00:00.000Z", featureId: 1, feature: "Login" });
    expect(o.stacks[0].stacks).toEqual([{ pr: "app#1", children: [{ pr: "app#2" }] }]);
    expect(o.groups.byLabel[0]).toEqual({ key: "ui", prs: ["app#1"] });
    expect(o.features[0]).toMatchObject({ id: 1, epicId: 10, epic: "Q4" });
    expect(o.prs.map((p) => p.number).sort()).toEqual([1, 2]);
    expect(o.prs[0]).not.toHaveProperty("prId");
    expect(o.freshness.generatedAt).toBe(new Date(1000).toISOString());
  });
});
