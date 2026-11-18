import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import type { Db } from "./database";
import { AssessRepo } from "./assess-repo";
import { PreReviewRepo, type NewEvidence } from "./prereview-repo";
import { ReviewEffectRepo } from "./review-effect-repo";
import { TicketPrsRepo } from "./ticket-prs-repo";
import { TicketsRepo } from "./tickets-repo";

const T = { repoSlug: "a/b", branch: "feat", headSha: "s1" };

function setup(): { db: Db; repo: PreReviewRepo; assess: AssessRepo; prId: number } {
  const db = memDb();
  new TicketsRepo(db).insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const prId = new TicketPrsRepo(db).link({
    ticketKey: "T-1", url: "https://github.com/a/b/pull/1", slug: "a/b", repoId: null, number: 1, headBranch: "feat", state: "open",
    source: "branch", linkedAt: 10,
  }).pr.id;
  return { db, repo: new PreReviewRepo(db), assess: new AssessRepo(db), prId };
}

const ev = (o: Partial<NewEvidence> = {}): NewEvidence => ({
  preReviewId: null, prId: null, ticketKey: "T-1", sessionId: "s", target: T, kind: "check", category: "test", name: "unit",
  command: "pnpm test", claimed: "pass", summary: "12 passed", createdAt: 5, ...o,
});

describe("PreReviewRepo", () => {
  it("insert, update and latest by (slug, branch, sha); pending blocks a duplicate", () => {
    const { repo } = setup();
    const a = repo.insert({ ticketKey: "T-1", sessionId: "s", target: T, cwd: "/w", base: "main", prId: null, trigger: "evidence", createdAt: 1 });
    expect(repo.pendingFor(T)?.id).toBe(a);
    repo.update(a, {
      status: "done", verdict: "violations", files: [{ path: "x.ts", added: 1, deleted: 0, binary: false }], lessonIds: [3],
      violations: [{ lessonId: 3, checkKey: null, file: "x.ts", line: 2, severity: "must", what: "w", fix: "f" }], finishedAt: 9,
    });
    expect(repo.pendingFor(T)).toBeNull();
    const b = repo.insert({ ticketKey: "T-1", sessionId: "s", target: { ...T, headSha: "s2" }, cwd: "/w", base: "main", prId: null, trigger: "pr", createdAt: 2 });
    const got = repo.latestFor(T)!;
    expect(got).toMatchObject({ id: a, status: "done", verdict: "violations", lessonIds: [3], checks: null });
    expect(got.violations[0]).toMatchObject({ lessonId: 3, severity: "must" });
    expect(repo.latestForBranch("a/b", "feat")?.id).toBe(b);
    expect(repo.latestForSession("s")?.id).toBe(b);
    expect(repo.undelivered(0).map((r) => r.id)).toEqual([a]);
    repo.update(a, { deliveredAt: 10 });
    expect(repo.undelivered(0)).toEqual([]);
  });

  it("attachPr fills pr_id on the review, its evidence and briefs for the same sha only", () => {
    const { repo, assess, prId } = setup();
    const a = repo.insert({ ticketKey: "T-1", sessionId: "s", target: T, cwd: null, base: null, prId: null, trigger: "evidence", createdAt: 1 });
    const other = repo.insert({ ticketKey: "T-1", sessionId: "s", target: { ...T, headSha: "s0" }, cwd: null, base: null, prId: null, trigger: "evidence", createdAt: 0 });
    repo.addEvidence(ev({ preReviewId: a }));
    assess.addBrief({ prId: null, preReviewId: a, target: T, markdown: "m", summaryOk: true, createdAt: 3 });
    expect(repo.attachPr(prId, T)).toBe(1);
    expect(repo.get(a)?.prId).toBe(prId);
    expect(repo.get(other)?.prId).toBeNull();
    expect(repo.evidenceOf(a)[0]!.prId).toBe(prId);
    expect(assess.latestBriefForPr(prId)?.markdown).toBe("m");
    expect(repo.latestForPr(prId)?.id).toBe(a);
  });

  it("evidenceFor returns only the latest submission's items; setVerified writes back; deleting the review cascades", () => {
    const { db, repo } = setup();
    const a = repo.insert({ ticketKey: "T-1", sessionId: "s", target: T, cwd: null, base: null, prId: null, trigger: "evidence", createdAt: 1 });
    repo.addEvidence(ev({ preReviewId: a, name: "old" }));
    const b = repo.insert({ ticketKey: "T-1", sessionId: "s", target: T, cwd: null, base: null, prId: null, trigger: "evidence", createdAt: 2 });
    const id = repo.addEvidence(ev({ preReviewId: b, name: "new" }));
    repo.addEvidence(ev({ preReviewId: b, kind: "acceptance", category: null, name: "c1", command: null, claimed: null }));
    expect(repo.evidenceFor(T).map((e) => e.name)).toEqual(["new", "c1"]);
    repo.setVerified(id, "rerun_pass", "ok", "out", 7);
    expect(repo.evidenceOf(b)[0]).toMatchObject({ verified: "rerun_pass", verifyDetail: "ok", rerunOutput: "out", verifiedAt: 7 });
    repo.update(b, { status: "done" });
    repo.update(a, { status: "done" });
    expect(repo.prune(100)).toBe(2);
    expect((db.prepare(`SELECT COUNT(*) AS c FROM pr_evidence`).get() as { c: number }).c).toBe(0);
  });
});

describe("AssessRepo", () => {
  it("setReadiness and setRisk write only when the content changes and report the previous value", () => {
    const { assess, prId } = setup();
    const r = { ready: false, conditions: [{ key: "checks" as const, state: "fail" as const, detail: "x" }], missing: [{ key: "checks" as const, state: "fail" as const, detail: "x" }] };
    expect(assess.setReadiness(prId, "s1", r, 1)).toEqual({ changed: true, before: null });
    expect(assess.setReadiness(prId, "s1", r, 2)).toEqual({ changed: false, before: false });
    expect(assess.readiness(prId)?.computedAt).toBe(1);
    expect(assess.setReadiness(prId, "s1", { ready: true, conditions: [], missing: [] }, 3)).toEqual({ changed: true, before: false });
    const risk = { level: "high" as const, reasons: [{ rule: "migration" as const, level: "high" as const, detail: "d" }] };
    expect(assess.setRisk(prId, "s1", risk, { lines: 3 }, 1, 1)).toEqual({ changed: true, before: null });
    expect(assess.setRisk(prId, "s1", risk, { lines: 3 }, 1, 2).changed).toBe(false);
    expect(assess.setRisk(prId, "s1", risk, { lines: 3 }, 2, 3).changed).toBe(true);
    expect(assess.risk(prId)).toMatchObject({ level: "high", rulesVersion: 2, inputs: { lines: 3 } });
    expect(assess.summaries([prId, 999]).get(prId)).toEqual({ risk: "high", ready: true, missing: [] });
    expect(assess.summaries([prId, 999]).get(999)).toEqual({ risk: null, ready: null, missing: [] });
  });

  it("addBrief dedupes identical content, markPosted records where it went", () => {
    const { assess, prId } = setup();
    const a = assess.addBrief({ prId: null, preReviewId: null, target: T, markdown: "m", summaryOk: false, createdAt: 1 });
    expect(assess.addBrief({ prId, preReviewId: null, target: T, markdown: "m", summaryOk: false, createdAt: 2 })).toEqual({ id: a.id, created: false });
    expect(assess.brief(a.id)?.prId).toBe(prId);
    const b = assess.addBrief({ prId, preReviewId: null, target: T, markdown: "m2", summaryOk: true, createdAt: 3 });
    expect(b.created).toBe(true);
    expect(assess.briefPosted(prId)).toBe(false);
    assess.markPosted(b.id, "https://x", 4, 9);
    expect(assess.briefPosted(prId)).toBe(true);
    expect(assess.latestBriefForBranch("a/b", "feat")).toMatchObject({ id: b.id, postedUrl: "https://x", auditId: 9, summaryOk: true });
  });
});

describe("ReviewEffectRepo", () => {
  it("save rewrites the PR row and its comments; queries by merge time and lesson", () => {
    const { db, prId } = setup();
    const repo = new ReviewEffectRepo(db);
    expect(repo.missingMerged(10)).toEqual([]);
    db.prepare(`UPDATE ticket_prs SET state = 'merged' WHERE id = ?`).run(prId);
    expect(repo.missingMerged(10)).toEqual([prId]);
    const pr = {
      prId, repoSlug: "a/b", number: 1, butler: true, openedAt: 1, mergedAt: 100, files: ["x.ts"], commentsHuman: 2, commentsCopilot: 1,
      avoidable: 1, rounds: 2, firstReviewMs: 50, submitToMergeMs: 99, briefPosted: false, retroDone: false, computedAt: 100,
    };
    repo.save(pr, [
      { sourceId: 1, lessonId: 7, who: "human", path: "x.ts", lessonConfirmedBefore: true, createdAt: 20 },
      { sourceId: 2, lessonId: null, who: "copilot", path: null, lessonConfirmedBefore: false, createdAt: 30 },
    ]);
    repo.save({ ...pr, retroDone: true }, [{ sourceId: 1, lessonId: 7, who: "human", path: "x.ts", lessonConfirmedBefore: true, createdAt: 20 }]);
    expect(repo.get(prId)).toMatchObject({ retroDone: true, files: ["x.ts"], butler: true });
    expect(repo.commentsOf([prId])).toHaveLength(1);
    expect(repo.mergedBetween(0, 101).map((p) => p.prId)).toEqual([prId]);
    expect(repo.mergedBetween(101, 200)).toEqual([]);
    expect(repo.commentsForLessons([7], 0, 21)).toHaveLength(1);
    expect(repo.commentsForLessons([7], 21, 99)).toHaveLength(0);
    expect(repo.missingMerged(10)).toEqual([]);
  });
});
