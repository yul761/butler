import { describe, expect, it } from "vitest";
import type { BranchWatchRow } from "../db/branch-watch-repo";
import type { TicketPr } from "../db/ticket-prs-repo";
import type { TicketRepo } from "../../shared/types";
import { BRANCH_IDLE_MS, PR_FAST_MS, PR_SLOW_MS, PR_WATCH_MAX, capRound, nextBranchCheckAt, nextPrCheckAt, branchTargets, prPolls } from "./pr-schedule";

const bw = (o: Partial<BranchWatchRow> = {}): BranchWatchRow => ({
  repoId: 1, ticketKey: "T-1", branch: "b", ci: "passing", headSha: null, failed: [], readError: false, checkedAt: 1000, deliveredKey: null, ...o,
});
const pr = (o: Partial<TicketPr> = {}): TicketPr => ({
  id: 1, ticketKey: "T-1", url: "https://github.com/a/x/pull/3", slug: "a/x", repoId: 1, number: 3, headBranch: "b", state: "open", review: null, ci: "pending",
  readError: false, headSha: null, failed: [], openedAt: null, mergedAt: null, closedAt: null, source: "branch", linkedAt: 0, checkedAt: 1000, deliveredKey: null,
  mergedHandledAt: null, readFailures: 0, readFailingSince: null, readRetryAt: null, ...o,
});
const repo = (id: number, o: Partial<TicketRepo> = {}): TicketRepo => ({
  id, ticketKey: "T-1", repoPath: `/r${id}`, workMode: "worktree", worktreePath: `/w${id}`, branch: "b", createdAt: 0, worktreeRemovedAt: null, cleanupBlocked: null, ...o,
});

describe("nextBranchCheckAt", () => {
  it("a never-checked branch is due now; an idle one after 30 minutes; one with an open PR never", () => {
    expect(nextBranchCheckAt(null, false, false)).toBe(0);
    expect(nextBranchCheckAt(bw(), false, false)).toBe(1000 + BRANCH_IDLE_MS);
    expect(nextBranchCheckAt(bw({ ci: "pending" }), true, false)).toBe(1000 + PR_FAST_MS);
    expect(nextBranchCheckAt(bw(), true, false)).toBe(1000 + PR_SLOW_MS);
    expect(nextBranchCheckAt(bw(), true, true)).toBe(Infinity);
    expect(nextBranchCheckAt(null, true, true)).toBe(Infinity);
  });
});

describe("nextPrCheckAt", () => {
  it("an open PR with pending CI and an open session is due after 60 s, otherwise after 300 s; a merged PR never; a never-read merged PR now", () => {
    expect(nextPrCheckAt(pr({ ci: "pending" }), true)).toBe(1000 + PR_FAST_MS);
    expect(nextPrCheckAt(pr({ ci: "pending" }), false)).toBe(1000 + PR_SLOW_MS);
    expect(nextPrCheckAt(pr({ ci: "passing" }), true)).toBe(1000 + PR_SLOW_MS);
    expect(nextPrCheckAt(pr({ state: "merged" }), true)).toBe(Infinity);
    expect(nextPrCheckAt(pr({ state: "closed" }), true)).toBe(Infinity);
    expect(nextPrCheckAt(pr({ state: "merged", checkedAt: 0 }), false)).toBe(0);
  });
});

describe("prPolls", () => {
  const d = (open: (k: string, r: number | null) => boolean = () => false) => ({
    repoOf: (id: number) => (id === 1 ? repo(1) : id === 2 ? repo(2, { worktreeRemovedAt: 9 }) : null),
    ghWorkDir: (r: TicketRepo) => (r.worktreeRemovedAt === null && r.worktreePath ? r.worktreePath : r.repoPath),
    home: "/home",
    sessionOpen: open,
  });

  it("groups two tickets' rows for one URL into one poll and is session-open if either ticket's session is open", () => {
    const rows = [pr({ id: 1, ticketKey: "T-1" }), pr({ id: 2, ticketKey: "T-2" })];
    const polls = prPolls(rows, d((k) => k === "T-2"));
    expect(polls).toHaveLength(1);
    expect(polls[0]).toMatchObject({ url: rows[0].url, slug: "a/x", cwd: "/w1", repoPath: "/r1", sessionOpen: true });
    expect(polls[0].rows).toHaveLength(2);
    expect(prPolls(rows, d())[0].sessionOpen).toBe(false);
  });

  it("a slug-only PR polls from home", () => {
    const polls = prPolls([pr({ repoId: null, url: "https://github.com/o/y/pull/4", slug: "o/y" })], d());
    expect(polls[0]).toMatchObject({ cwd: "/home", repoPath: null, slug: "o/y" });
  });

  it("uses the repo path when the worktree was removed", () => {
    expect(prPolls([pr({ repoId: 2 })], d())[0]).toMatchObject({ cwd: "/r2", repoPath: "/r2" });
  });
});

describe("capRound", () => {
  it("keeps session-open items first and stops at 40", () => {
    const items = Array.from({ length: PR_WATCH_MAX + 5 }, (_, i) => ({ id: i, sessionOpen: i >= PR_WATCH_MAX }));
    const out = capRound(items);
    expect(out).toHaveLength(PR_WATCH_MAX);
    expect(out.slice(0, 5).map((x) => x.id)).toEqual([40, 41, 42, 43, 44]);
    expect(out[5].id).toBe(0);
    expect(out.map((x) => x.id)).not.toContain(PR_WATCH_MAX - 1);
  });
});

describe("branchTargets", () => {
  it("uses the repo work dir as cwd and asks sessionOpen per repo", () => {
    const t = { key: "T-1", repos: [repo(1), repo(2, { worktreeRemovedAt: 9 })] };
    const out = branchTargets([t], {
      ghWorkDir: (r) => (r.worktreeRemovedAt === null && r.worktreePath ? r.worktreePath : r.repoPath),
      sessionOpen: (_k, id) => id === 2,
    });
    expect(out).toEqual([
      { ticketKey: "T-1", repoId: 1, repoPath: "/r1", cwd: "/w1", branch: "b", sessionOpen: false },
      { ticketKey: "T-1", repoId: 2, repoPath: "/r2", cwd: "/r2", branch: "b", sessionOpen: true },
    ]);
  });
});
