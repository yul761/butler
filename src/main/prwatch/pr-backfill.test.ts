import { describe, expect, it, vi } from "vitest";
import type { Pr } from "../../shared/handoff";
import { JOB_PR_BACKFILL, JobsRepo } from "../db/jobs-repo";
import type { MergeHold } from "../db/merge-gate-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import type { BranchPr } from "../tickets/gh";
import { memDb } from "../test-utils";
import { runPrBackfill, type PrBackfillDeps } from "./pr-backfill";
import { PrLinker } from "./pr-links";

const SLUGS: Record<string, string> = { "/a": "a/x", "/b": "a/y" };
const bp = (number: number, state: BranchPr["state"], t: Partial<BranchPr> = {}): BranchPr => ({
  number, url: `https://github.com/a/x/pull/${number}`, state, headRefName: "feat", createdAt: 100 + number, mergedAt: null, closedAt: null, ...t,
});

function setup(opts: { repos?: string[]; archived?: boolean } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: opts.archived ? 5 : null });
  for (const repoPath of opts.repos ?? ["/a"]) tickets.addRepo({ ticketKey: "T-1", repoPath, workMode: "branch", worktreePath: null, branch: "feat", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const jobs = new JobsRepo(db);
  const linker = new PrLinker({ prs, tickets, slugOf: (p) => SLUGS[p] ?? null, now: () => 50 });
  let handoffPrs: Pr[] = [];
  let holds: MergeHold[] = [];
  const state = { branch: new Map<string, BranchPr[] | null>(), missing: new Set<string>(), slugs: new Map<string, string>() };
  const deps = (): PrBackfillDeps => ({
    tickets: () => tickets.list({ includeArchived: true }),
    linker, prs, jobs,
    handoffPrs: () => handoffPrs,
    holds: () => holds,
    sessionTicket: (s) => (s === "s1" ? "T-1" : null),
    prsForBranch: vi.fn(async (cwd: string, _branch: string, _timeout: number, repo?: string | null) => {
      const k = repo ? `${cwd}:${repo}` : cwd;
      return state.branch.has(k) ? state.branch.get(k)! : [];
    }),
    ghWorkDir: (r) => r.repoPath,
    exists: (p) => !state.missing.has(p),
    home: "/home",
    slugOf: (r) => state.slugs.get(r.repoPath) ?? null,
    now: () => 77,
    log: vi.fn(),
  });
  return { prs, jobs, deps, state, setHandoff: (p: Pr[]) => (handoffPrs = p), setHolds: (h: MergeHold[]) => (holds = h) };
}

describe("runPrBackfill", () => {
  it("links sequential PRs on an archived ticket's branch and records ok", async () => {
    const s = setup({ archived: true });
    s.state.branch.set("/a", [bp(1, "MERGED", { mergedAt: 200, createdAt: 100 }), bp(2, "OPEN")]);
    const r = await runPrBackfill(s.deps());
    expect(r).toEqual({ ok: true, linked: 2, failed: 0, skipped: 0 });
    const rows = s.prs.byTicket("T-1");
    expect(rows).toHaveLength(2);
    const merged = rows.find((p) => p.number === 1)!;
    expect(merged).toMatchObject({ state: "merged", source: "backfill", openedAt: 100, mergedAt: 200, checkedAt: 0, headBranch: "feat" });
    expect(merged.mergedHandledAt).toBeNull();
    expect(s.jobs.get(JOB_PR_BACKFILL).lastStatus).toBe("ok");
  });

  it("links handoff URLs and merge holds with a null ticket via the session", async () => {
    const s = setup();
    s.setHandoff([{ number: 7, url: "https://github.com/a/x/pull/7", state: "open", review: null }]);
    s.setHolds([{ id: 1, repoPath: "/a", branch: "feat", target: "main", kind: "pr", prUrl: "https://github.com/a/x/pull/8", sessionId: "s1", ticketKey: null, createdAt: 1, releasedAt: 9, outcome: "merged" }]);
    const r = await runPrBackfill(s.deps());
    expect(r.ok).toBe(true);
    expect(s.prs.byTicket("T-1").map((p) => [p.number, p.source]).sort()).toEqual([[7, "handoff"], [8, "merge_gate"]]);
  });

  it("records failed and links nothing twice when gh fails for one repo", async () => {
    const handoff: Pr[] = [{ number: 7, url: "https://github.com/a/x/pull/7", state: "open", review: null }];
    const s = setup({ repos: ["/a", "/b"] });
    s.setHandoff(handoff);
    s.state.branch.set("/a", [bp(1, "OPEN")]);
    s.state.branch.set("/b", null);
    const d1 = s.deps();
    const first = await runPrBackfill(d1);
    expect(first).toMatchObject({ ok: false, failed: 1 });
    expect(d1.log).toHaveBeenCalled();
    expect(s.jobs.get(JOB_PR_BACKFILL).lastStatus).toBe("failed");
    s.state.branch.set("/b", [bp(2, "OPEN", { url: "https://github.com/a/y/pull/2" })]);
    const second = await runPrBackfill(s.deps());
    expect(second).toMatchObject({ ok: true, linked: 1 });
    const clean = setup({ repos: ["/a", "/b"] });
    clean.setHandoff(handoff);
    clean.state.branch.set("/a", [bp(1, "OPEN")]);
    clean.state.branch.set("/b", [bp(2, "OPEN", { url: "https://github.com/a/y/pull/2" })]);
    await runPrBackfill(clean.deps());
    const shape = (r: ReturnType<typeof s.prs.byTicket>) => r.map((p) => [p.number, p.url, p.state, p.source]).sort();
    expect(shape(s.prs.byTicket("T-1"))).toEqual(shape(clean.prs.byTicket("T-1")));
    expect(s.prs.byTicket("T-1")).toHaveLength(3);
  });

  it("GitHub's state wins over a stale handoff or hold state", async () => {
    const s = setup();
    s.state.branch.set("/a", [bp(1, "MERGED", { mergedAt: 200 })]);
    s.setHandoff([{ number: 1, url: "https://github.com/a/x/pull/1", state: "open", review: null }]);
    await runPrBackfill(s.deps());
    expect(s.prs.byTicket("T-1")[0]).toMatchObject({ number: 1, state: "merged", mergedAt: 200 });
  });

  it("logs the error when gh throws and counts it as failed", async () => {
    const s = setup();
    const d = s.deps();
    const boom = new Error("boom");
    d.prsForBranch = vi.fn(async () => { throw boom; });
    const r = await runPrBackfill(d);
    expect(r).toMatchObject({ ok: false, failed: 1 });
    expect(d.log).toHaveBeenCalledWith(expect.any(String), boom);
  });

  it("a multi-repo ticket does not link an empty-URL handoff PR", async () => {
    const s = setup({ repos: ["/a", "/b"] });
    s.state.branch.set("/a", [bp(4, "OPEN")]);
    s.setHandoff([{ number: 4, url: "", state: "open", review: null }]);
    await runPrBackfill(s.deps());
    expect(s.prs.byTicket("T-1").map((p) => p.source)).toEqual(["backfill"]);
  });

  it("an empty-URL PR in a single-repo ticket takes the URL from the branch list", async () => {
    const s = setup();
    s.state.branch.set("/a", [bp(4, "OPEN")]);
    s.setHandoff([{ number: 4, url: "", state: "open", review: null }, { number: 99, url: "", state: "open", review: null }]);
    await runPrBackfill(s.deps());
    const rows = s.prs.byTicket("T-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 4, url: "https://github.com/a/x/pull/4" });
  });

  it("does nothing once recorded ok", async () => {
    const s = setup();
    s.jobs.record(JOB_PR_BACKFILL, 1, "ok", null);
    const d = s.deps();
    expect(await runPrBackfill(d)).toEqual({ ok: true, linked: 0, failed: 0, skipped: 0 });
    expect(d.prsForBranch).not.toHaveBeenCalled();
  });

  it("a repo whose dir is gone but whose slug is known is listed from home with the slug", async () => {
    const s = setup({ repos: ["/a", "/gone"] });
    s.state.missing.add("/gone");
    s.state.slugs.set("/gone", "a/y");
    s.state.branch.set("/a", [bp(1, "OPEN")]);
    s.state.branch.set("/home:a/y", [bp(2, "MERGED", { url: "https://github.com/a/y/pull/2", mergedAt: 300 })]);
    const d = s.deps();
    const r = await runPrBackfill(d);
    expect(r).toEqual({ ok: true, linked: 2, failed: 0, skipped: 0 });
    expect(d.prsForBranch).toHaveBeenCalledWith("/home", "feat", expect.any(Number), "a/y");
    expect(vi.mocked(d.prsForBranch).mock.calls.map((c) => c[0])).not.toContain("/gone");
    expect(s.prs.byTicket("T-1").map((p) => [p.number, p.slug, p.state]).sort()).toEqual([[1, "a/x", "open"], [2, "a/y", "merged"]]);
  });

  it("skips a repo whose dir is gone and whose slug is unknown: no gh call, no breaker, still ok", async () => {
    const gone = Array.from({ length: 6 }, (_, i) => `/gone${i}`);
    const s = setup({ repos: [...gone, "/a"] });
    for (const g of gone) s.state.missing.add(g);
    s.state.branch.set("/a", [bp(1, "OPEN")]);
    const d = s.deps();
    const r = await runPrBackfill(d);
    expect(r).toEqual({ ok: true, linked: 1, failed: 0, skipped: 6 });
    expect(d.prsForBranch).toHaveBeenCalledTimes(1);
    expect(s.jobs.get(JOB_PR_BACKFILL).lastStatus).toBe("ok");
  });

  it("skips don't reset or advance the breaker, and a failure alongside skips still records failed", async () => {
    const s = setup({ repos: ["/gone", "/b"] });
    s.state.missing.add("/gone");
    s.state.branch.set("/b", null);
    const r = await runPrBackfill(s.deps());
    expect(r).toEqual({ ok: false, linked: 0, failed: 1, skipped: 1 });
    expect(s.jobs.get(JOB_PR_BACKFILL).lastStatus).toBe("failed");
  });

  it("stops early after 5 consecutive gh failures", async () => {
    const s = setup({ repos: Array.from({ length: 8 }, (_, i) => `/r${i}`) });
    for (let i = 0; i < 8; i++) s.state.branch.set(`/r${i}`, null);
    const d = s.deps();
    const r = await runPrBackfill(d);
    expect(r.ok).toBe(false);
    expect(r.failed).toBeGreaterThanOrEqual(5);
    expect(r.failed).toBeLessThan(8);
    expect(s.jobs.get(JOB_PR_BACKFILL).lastStatus).toBe("failed");
  });
});
