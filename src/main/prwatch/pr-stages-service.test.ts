import { describe, expect, it } from "vitest";
import type { StageEvent } from "../db/pr-stage-repo";
import type { PrWatchRow } from "../db/pr-watch-repo";
import type { Ticket, TicketRepo } from "../../shared/types";
import { PrStagesService, type PrStagesServiceDeps } from "./pr-stages-service";

const repo = (id: number, key: string, branch = "feat", path = `/code/r${id}`): TicketRepo => ({
  id, ticketKey: key, repoPath: path, workMode: "branch", worktreePath: null, branch, createdAt: 1, worktreeRemovedAt: null, cleanupBlocked: null,
});
const ticket = (key: string, repos: TicketRepo[], featureId: number | null = null): Ticket => ({
  key, title: null, repos, status: "active", statusManual: null, createdAt: 100, archivedAt: null, featureId,
});
const ev = (o: Partial<StageEvent> = {}): StageEvent => ({
  id: 1, ticketKey: "A-1", repoId: null, branch: null, featureId: null, epicId: null, sessionId: null, kind: "first_commit", at: 200, data: {}, ...o,
});

function make(o: {
  tickets?: Ticket[]; features?: { id: number; epicId: number | null }[];
  reports?: PrStagesServiceDeps["reports"]; skillTracking?: boolean;
  forRepo?: PrStagesServiceDeps["stages"]["forRepo"]; upperDesign?: PrStagesServiceDeps["stages"]["upperDesign"];
  pr?: (repoId: number) => PrWatchRow | null;
} = {}) {
  const tickets = o.tickets ?? [];
  const features = o.features ?? [];
  return new PrStagesService({
    tickets: { get: (k) => tickets.find((t) => t.key === k) ?? null, byFeature: (id) => tickets.filter((t) => t.featureId === id) },
    features: { byEpic: (id) => features.filter((f) => f.epicId === id), get: (id) => features.find((f) => f.id === id) ?? null },
    stages: { forRepo: o.forRepo ?? (() => []), upperDesign: o.upperDesign ?? (() => []) },
    prWatch: { get: o.pr ?? (() => null) },
    reports: o.reports ?? (() => []),
    skillTracking: () => o.skillTracking ?? true,
  });
}

describe("PrStagesService", () => {
  it("emits one row per repo of a ticket, ordered by repo id, with the repo directory name", () => {
    const svc = make({ tickets: [ticket("A-1", [repo(9, "A-1", "feat", "/code/zeta"), repo(5, "A-1", "feat", "/code/alpha")])] });
    const rows = svc.view({ ticketKey: "A-1" });
    expect(rows.map((r) => r.repoId)).toEqual([5, 9]);
    expect(rows.map((r) => r.repoName)).toEqual(["alpha", "zeta"]);
    expect(svc.view({ ticketKey: "nope" })).toEqual([]);
  });

  it("feature scope covers all its tickets; epic scope covers all features' tickets with featureId", () => {
    const svc = make({
      tickets: [ticket("A-1", [repo(1, "A-1")], 10), ticket("A-2", [repo(2, "A-2")], 10), ticket("B-1", [repo(3, "B-1")], 11), ticket("C-1", [repo(4, "C-1")], 12)],
      features: [{ id: 10, epicId: 7 }, { id: 11, epicId: 7 }, { id: 12, epicId: 8 }],
    });
    expect(svc.view({ featureId: 10 }).map((r) => r.ticketKey)).toEqual(["A-1", "A-2"]);
    expect(svc.view({ epicId: 7 }).map((r) => [r.ticketKey, r.featureId])).toEqual([["A-1", 10], ["A-2", 10], ["B-1", 11]]);
  });

  it("asks for events on the repo's current branch", () => {
    const calls: [string, number, string][] = [];
    const forRepo = (k: string, id: number, b: string) => (calls.push([k, id, b]), []);
    make({ tickets: [ticket("A-1", [repo(5, "A-1", "old")])], forRepo }).view({ ticketKey: "A-1" });
    make({ tickets: [ticket("A-1", [repo(5, "A-1", "feat")])], forRepo }).view({ ticketKey: "A-1" });
    expect(calls).toEqual([["A-1", 5, "old"], ["A-1", 5, "feat"]]);
    expect(make({ tickets: [ticket("A-1", [repo(5, "A-1", "feat")])] }).view({ ticketKey: "A-1" })[0].branch).toBe("feat");
  });

  it("keeps only reports of this repo or with no repo", () => {
    const svc = make({
      tickets: [ticket("A-1", [repo(5, "A-1"), repo(7, "A-1")])],
      reports: () => [{ at: 300, text: "for 7", repoId: 7 }, { at: 310, text: "for all", repoId: null }],
    });
    const [r5, r7] = svc.view({ ticketKey: "A-1" });
    const texts = (v: typeof r5) => v.timeline.filter((e) => e.kind === "report").map((e) => e.detail);
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

  it("design is unknown, not skipped, when skill tracking is off", () => {
    const events = [ev({ kind: "first_commit" })];
    const t = [ticket("A-1", [repo(1, "A-1")])];
    expect(make({ tickets: t, forRepo: () => events, skillTracking: true }).view({ ticketKey: "A-1" })[0].stages[0].state).toBe("skipped");
    expect(make({ tickets: t, forRepo: () => events, skillTracking: false }).view({ ticketKey: "A-1" })[0].stages[0].state).toBe("unknown");
  });
});
