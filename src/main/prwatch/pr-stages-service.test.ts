import { describe, expect, it } from "vitest";
import type { StageEvent } from "../db/pr-stage-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { PrStagesView } from "../../shared/pr-stages";
import type { Ticket, TicketRepo } from "../../shared/types";
import { PrStagesService, ticketMerged, type PrStagesServiceDeps } from "./pr-stages-service";

const repo = (id: number, key: string, branch = "feat", path = `/code/r${id}`): TicketRepo => ({
  id, ticketKey: key, repoPath: path, workMode: "branch", worktreePath: null, branch, createdAt: 1, worktreeRemovedAt: null, cleanupBlocked: null,
});
const ticket = (key: string, repos: TicketRepo[], featureId: number | null = null, o: Partial<Ticket> = {}): Ticket => ({
  key, title: null, repos, status: "active", statusManual: null, createdAt: 100, archivedAt: null, featureId, ...o,
});
const ev = (o: Partial<StageEvent> = {}): StageEvent => ({
  id: 1, ticketKey: "A-1", repoId: null, prId: null, branch: null, featureId: null, epicId: null, sessionId: null, kind: "first_commit", at: 200, data: {}, ...o,
});
const prRow = (o: Partial<TicketPr>): TicketPr => ({
  id: 1, ticketKey: "A-1", url: "https://github.com/o/r/pull/1", slug: "o/r", repoId: 5, number: 1, headBranch: "feat", state: "open", review: null,
  ci: "passing", readError: false, headSha: "a", failed: [], openedAt: 100, mergedAt: null, closedAt: null, source: "branch", linkedAt: 100,
  checkedAt: 100, deliveredKey: null, mergedHandledAt: null, readFailures: 0, readFailingSince: null, readRetryAt: null, ...o,
});

function make(o: {
  tickets?: Ticket[]; features?: { id: number; epicId: number | null }[];
  reports?: PrStagesServiceDeps["reports"]; since?: number | null;
  events?: StageEvent[]; upperDesign?: PrStagesServiceDeps["stages"]["upperDesign"];
  prs?: TicketPr[];
} = {}) {
  const tickets = o.tickets ?? [];
  const features = o.features ?? [];
  return new PrStagesService({
    tickets: { get: (k) => tickets.find((t) => t.key === k) ?? null, byFeature: (id) => tickets.filter((t) => t.featureId === id) },
    features: { byEpic: (id) => features.filter((f) => f.epicId === id), get: (id) => features.find((f) => f.id === id) ?? null },
    stages: { forTicket: (k) => (o.events ?? []).filter((e) => e.ticketKey === k), upperDesign: o.upperDesign ?? (() => []) },
    prs: { byTicket: (k) => (o.prs ?? []).filter((p) => p.ticketKey === k) },
    reports: o.reports ?? (() => []),
    skillTrackingSince: () => (o.since === undefined ? 0 : o.since),
  });
}
const rowsOf = (svc: PrStagesService, key = "A-1"): PrStagesView[] => svc.view({ ticketKey: key })[0]?.rows ?? [];
const kinds = (v: PrStagesView) => v.timeline.map((e) => e.kind);

describe("PrStagesService", () => {
  it("BTL-190 shape: two sequential PRs on the branch plus one on another branch give three rows, newest first", () => {
    const prs = [
      prRow({ id: 2, number: 2, openedAt: 250 }),
      prRow({ id: 1, number: 1, openedAt: 100, state: "merged", mergedAt: 200 }),
      prRow({ id: 3, number: 3, headBranch: "other", openedAt: 300 }),
    ];
    const events = [
      ev({ id: 1, repoId: 5, branch: "feat", kind: "first_commit", at: 90 }),
      ev({ id: 2, repoId: 5, prId: 1, kind: "merged", at: 200, data: { number: 1 } }),
      ev({ id: 3, repoId: 5, branch: "feat", kind: "skill", at: 220, data: { name: "code-review", category: "review" } }),
      ev({ id: 4, repoId: 5, prId: 3, kind: "pr_opened", at: 300, data: { number: 3 } }),
    ];
    const rows = rowsOf(make({ tickets: [ticket("A-1", [repo(5, "A-1")])], prs, events }));
    expect(rows.map((r) => [r.prId, r.prNumber, r.noPr, r.slug, r.repoName])).toEqual([
      [3, 3, false, null, "r5"], [2, 2, false, null, "r5"], [1, 1, false, null, "r5"],
    ]);
    expect(rows.map(kinds)).toEqual([["pr_opened"], ["review_skill"], ["first_commit", "merged"]]);
    expect(rows[2].stages.find((c) => c.id === "merge")?.state).toBe("done");
    expect(rows[1].stages.find((c) => c.id === "merge")?.state).not.toBe("done");
  });

  it("a no-PR row appears with no PRs, or with a first_commit after the last merge", () => {
    const t = [ticket("A-1", [repo(5, "A-1")])];
    const fresh = rowsOf(make({ tickets: t }));
    expect(fresh.map((r) => [r.noPr, r.prId, r.prNumber, r.repoId, r.repoName])).toEqual([[true, null, null, 5, "r5"]]);

    const merged = [prRow({ state: "merged", mergedAt: 200 })];
    const after = rowsOf(make({ tickets: t, prs: merged, events: [ev({ repoId: 5, branch: "feat", kind: "first_commit", at: 300 })] }));
    expect(after.map((r) => [r.noPr, r.prId])).toEqual([[true, null], [false, 1]]);
    expect(kinds(after[0])).toEqual(["first_commit"]);

    const skillOnly = [ev({ repoId: 5, kind: "skill", at: 300, data: { name: "code-review", category: "review" } })];
    const quiet = rowsOf(make({ tickets: t, prs: merged, events: skillOnly, reports: () => [{ at: 310, text: "done", repoId: 5, branch: "feat" }] }));
    expect(quiet.map((r) => [r.noPr, r.prId])).toEqual([[false, 1]]);
  });

  it("archived tickets are included and flagged", () => {
    const svc = make({ tickets: [ticket("A-1", [repo(5, "A-1")], 10, { archivedAt: 500, title: "Old" }), ticket("A-2", [repo(6, "A-2")], 10)] });
    expect(svc.view({ featureId: 10 }).map((t) => [t.ticketKey, t.title, t.archived, t.merged, t.hasRepos])).toEqual([
      ["A-1", "Old", true, false, true], ["A-2", null, false, false, true],
    ]);
  });

  it("a ticket with no repos returns hasRepos false and no rows", () => {
    const [t] = make({ tickets: [ticket("A-1", [])] }).view({ ticketKey: "A-1" });
    expect([t.hasRepos, t.rows]).toEqual([false, []]);
    expect(make().view({ ticketKey: "nope" })).toEqual([]);
  });

  it("a slug-only PR row shows its slug", () => {
    const prs = [prRow({ id: 4, number: 9, repoId: null, slug: "x/lib", headBranch: "lib", openedAt: 300 }), prRow({})];
    const rows = rowsOf(make({ tickets: [ticket("A-1", [repo(5, "A-1")])], prs }));
    expect(rows.map((r) => [r.prId, r.repoId, r.slug, r.repoName])).toEqual([[4, null, "x/lib", "x/lib"], [1, 5, null, "r5"]]);
  });

  it("no-PR rows come first, ordered by repo id, with the repo directory name", () => {
    const rows = rowsOf(make({ tickets: [ticket("A-1", [repo(9, "A-1", "feat", "/code/zeta"), repo(5, "A-1", "feat", "/code/alpha/")])] }));
    expect(rows.map((r) => [r.repoId, r.repoName])).toEqual([[5, "alpha"], [9, "zeta"]]);
  });

  it("feature scope covers all its tickets; epic scope covers all features' tickets with featureId", () => {
    const svc = make({
      tickets: [ticket("A-1", [repo(1, "A-1")], 10), ticket("A-2", [repo(2, "A-2")], 10), ticket("B-1", [repo(3, "B-1")], 11), ticket("C-1", [repo(4, "C-1")], 12)],
      features: [{ id: 10, epicId: 7 }, { id: 11, epicId: 7 }, { id: 12, epicId: 8 }],
    });
    expect(svc.view({ featureId: 10 }).map((t) => t.ticketKey)).toEqual(["A-1", "A-2"]);
    expect(svc.view({ epicId: 7 }).flatMap((t) => t.rows).map((r) => [r.ticketKey, r.featureId])).toEqual([["A-1", 10], ["A-2", 10], ["B-1", 11]]);
  });

  it("keeps only reports of this repo or with no repo", () => {
    const svc = make({
      tickets: [ticket("A-1", [repo(5, "A-1"), repo(7, "A-1")])],
      reports: () => [{ at: 300, text: "for 7", repoId: 7, branch: "feat" }, { at: 310, text: "for all", repoId: null, branch: null }],
    });
    const [r5, r7] = rowsOf(svc);
    const texts = (v: PrStagesView) => v.timeline.filter((e) => e.kind === "report").map((e) => e.detail);
    expect(texts(r5)).toEqual(["for all"]);
    expect(texts(r7)).toEqual(["for 7", "for all"]);
  });

  it("looks up upper design with the feature and epic ids; none without a feature", () => {
    const seen: [number, number | null][] = [];
    const upperDesign = (f: number, e: number | null) => (seen.push([f, e]), []);
    make({ tickets: [ticket("A-1", [repo(1, "A-1")], 10), ticket("A-2", [repo(2, "A-2")])], features: [{ id: 10, epicId: 7 }], upperDesign })
      .view({ epicId: 7 });
    make({ tickets: [ticket("A-2", [repo(2, "A-2")])], upperDesign }).view({ ticketKey: "A-2" });
    expect(seen).toEqual([[10, 7]]);
  });

  it("design is unknown, not skipped, when skill tracking has no start", () => {
    const events = [ev({ repoId: 1, kind: "first_commit" })];
    const t = [ticket("A-1", [repo(1, "A-1")])];
    expect(rowsOf(make({ tickets: t, events, since: 0 }))[0].stages[0].state).toBe("skipped");
    expect(rowsOf(make({ tickets: t, events, since: null }))[0].stages[0].state).toBe("unknown");
  });

  it("self review: unknown without skill tracking; skipped with tracking and no review skill once a PR opens", () => {
    const events = [ev({ repoId: 1, kind: "first_commit", at: 150 }), ev({ id: 2, repoId: 1, prId: 1, kind: "pr_opened", at: 210, data: { number: 1 } })];
    const t = [ticket("A-1", [repo(1, "A-1")])];
    const prs = [prRow({ repoId: 1, openedAt: 210 })];
    const sr = (since: number | null) => rowsOf(make({ tickets: t, events, prs, since }))[0].stages[2];
    expect(sr(null).state).toBe("unknown");
    expect(sr(0).state).toBe("skipped");
  });

  it("feature 1 shape: five merged_pending_followup tickets count 5/5, including one with no PRs", () => {
    const keys = ["F-1", "F-2", "F-3", "F-4", "F-5"];
    const tickets = keys.map((k, i) => ticket(k, [repo(i + 1, k)], 10, { status: "merged_pending_followup" }));
    // F-1 到 F-4 各有一个合并了的 PR（F-2 还有一个关掉的）；F-5 没有 PR。
    const prs = keys.slice(0, 4).map((k, i) => prRow({ id: i + 1, ticketKey: k, repoId: i + 1, number: i + 1, state: "merged", mergedAt: 200 }));
    prs.push(prRow({ id: 9, ticketKey: "F-2", repoId: 2, number: 9, state: "closed", closedAt: 150 }));
    const view = make({ tickets, prs }).view({ featureId: 10 });
    expect(view.map((t) => [t.ticketKey, t.merged])).toEqual(keys.map((k) => [k, true]));
    expect(view.find((t) => t.ticketKey === "F-5")?.rows.map((r) => r.noPr)).toEqual([true]);
  });

  it("all PRs closed, none merged, status active: not merged", () => {
    const prs = [prRow({ id: 1, state: "closed", closedAt: 200 }), prRow({ id: 2, number: 2, state: "closed", closedAt: 300 })];
    const [t] = make({ tickets: [ticket("A-1", [repo(5, "A-1")])], prs }).view({ ticketKey: "A-1" });
    expect(t.merged).toBe(false);
  });

  it("ticketMerged: every PR merged or closed with one merged, or a merged / done status (manual status first)", () => {
    const st = (status: Ticket["status"], statusManual: Ticket["statusManual"] = null) => ({ status, statusManual });
    expect(ticketMerged(st("active"), [{ state: "merged" }, { state: "closed" }])).toBe(true);
    expect(ticketMerged(st("active"), [{ state: "merged" }, { state: "open" }])).toBe(false);
    expect(ticketMerged(st("active"), [])).toBe(false);
    expect(ticketMerged(st("done"), [])).toBe(true);
    expect(ticketMerged(st("merged_pending_followup"), [{ state: "open" }])).toBe(true);
    expect(ticketMerged(st("done", "active"), [])).toBe(false);
    expect(ticketMerged(st("active", "done"), [{ state: "open" }])).toBe(true);
  });

  it("ticketMerged: an open PR Butler gave up reading (10 failed reads) does not hold the ticket back", () => {
    const st = { status: "active" as const, statusManual: null };
    expect(ticketMerged(st, [{ state: "merged" }, { state: "open", readRetryAt: 5 }])).toBe(true);
    expect(ticketMerged(st, [{ state: "merged" }, { state: "open", readRetryAt: null }])).toBe(false);
    // 只有放弃了的：没有合并的，不算合并。
    expect(ticketMerged(st, [{ state: "open", readRetryAt: 5 }])).toBe(false);
  });

  it("an unread handoff row with a made-up url and the same number as a read row is not shown: one row", () => {
    const real = prRow({ id: 1, number: 25, url: "https://github.com/yul761/butler/pull/25", slug: "yul761/butler", state: "merged", mergedAt: 200 });
    const bogus = prRow({
      id: 2, number: 25, url: "https://github.com/yuchenlin/butler/pull/25", slug: "yuchenlin/butler", repoId: null, headBranch: null, state: "merged",
      mergedAt: null, openedAt: null, source: "handoff", checkedAt: 0, ci: "unknown",
    });
    const rows = rowsOf(make({ tickets: [ticket("A-1", [repo(5, "A-1")])], prs: [real, bogus] }));
    expect(rows.map((r) => [r.prId, r.noPr])).toEqual([[1, false]]);
  });

  it("a ticket whose only PR rows were never read: no PR rows and not merged; once read, the row shows and counts", () => {
    const unread = prRow({ id: 3, number: 26, state: "merged", mergedAt: null, source: "handoff", checkedAt: 0 });
    const before = make({ tickets: [ticket("A-1", [repo(5, "A-1")])], prs: [unread] }).view({ ticketKey: "A-1" })[0];
    expect(before.merged).toBe(false);
    expect(before.rows.filter((r) => !r.noPr)).toEqual([]);
    const after = make({ tickets: [ticket("A-1", [repo(5, "A-1")])], prs: [{ ...unread, checkedAt: 300, mergedAt: 250 }] }).view({ ticketKey: "A-1" })[0];
    expect(after.merged).toBe(true);
    expect(after.rows.map((r) => [r.prId, r.noPr])).toEqual([[3, false]]);
  });

  it("ticketMerged ignores never-read rows, for and against", () => {
    const st = { status: "active" as const, statusManual: null };
    expect(ticketMerged(st, [{ state: "merged", checkedAt: 0 }])).toBe(false);
    expect(ticketMerged(st, [{ state: "merged", checkedAt: 5 }, { state: "open", checkedAt: 0 }])).toBe(true);
  });

  it("each ticket carries its feature id, also without rows", () => {
    const svc = make({ tickets: [ticket("A-1", [], 10), ticket("B-1", [repo(2, "B-1")], 11)], features: [{ id: 10, epicId: 7 }, { id: 11, epicId: 7 }] });
    expect(svc.view({ epicId: 7 }).map((t) => [t.ticketKey, t.featureId, t.rows.length])).toEqual([["A-1", 10, 0], ["B-1", 11, 1]]);
  });
});
