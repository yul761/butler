import { describe, expect, it } from "vitest";
import type { TicketRepo } from "../../shared/types";
import { watchTargets, type WatchTargetDeps } from "./pr-targets";

const repo = (id: number, o: Partial<TicketRepo> = {}): TicketRepo => ({
  id, ticketKey: "BTL-1", repoPath: `/r/${id}`, workMode: "worktree", worktreePath: `/w/${id}`, branch: `b${id}`, createdAt: 0,
  worktreeRemovedAt: null, cleanupBlocked: null, ...o,
});

function deps(o: Partial<WatchTargetDeps> = {}): WatchTargetDeps {
  return {
    workDir: (r) => r.worktreePath ?? r.repoPath,
    sessionOpen: () => false,
    watched: () => null,
    handoffHasOpenPr: () => false,
    ...o,
  };
}

describe("watchTargets", () => {
  it("reads the row of a branch the repo no longer uses as never read (I4: the ticket's branch was changed)", () => {
    const t = [{ key: "BTL-1", repos: [repo(1, { branch: "new" })] }];
    // 旧分支的 PR 已经合并：换了分支之后照样要查（不能当作合并过就不查）。
    const watched = () => ({ state: "merged" as const, number: 7, ci: "passing" as const, branch: "old" });
    expect(watchTargets(t, deps({ watched, handoffHasOpenPr: () => true })).map((x) => x.branch)).toEqual(["new"]);
    // 同一个分支的合并 PR 照旧不查。
    expect(watchTargets(t, deps({ watched: () => ({ ...watched(), branch: "new" }), handoffHasOpenPr: () => true }))).toEqual([]);
  });

  it("watches a repo whose own session is open, with its work dir and branch", () => {
    const t = [{ key: "BTL-1", repos: [repo(1), repo(2)] }];
    expect(watchTargets(t, deps({ sessionOpen: (_k, id) => id === 2 }))).toEqual([
      { ticketKey: "BTL-1", repoId: 2, repoPath: "/r/2", cwd: "/w/2", branch: "b2", sessionOpen: true },
    ]);
  });

  it("keeps watching an open PR after the session closed, and drops merged, closed and PR-less branches", () => {
    const state = { 1: "open", 2: "merged", 3: "closed", 4: null } as const;
    const t = [{ key: "BTL-1", repos: [repo(1), repo(2), repo(3), repo(4)] }];
    const watched = (id: number) => ({ state: state[id as keyof typeof state], number: id === 4 ? null : id, ci: "passing" as const, branch: `b${id}` });
    const out = watchTargets(t, deps({ watched, handoffHasOpenPr: () => true }));
    expect(out.map((x) => x.repoId)).toEqual([1]);
  });

  it("a first check that failed (no PR known, ci unknown) still falls back to the handoff; a branch checked and found without a PR does not", () => {
    const t = [{ key: "BTL-1", repos: [repo(1), repo(2), repo(3)] }];
    const rows = {
      1: { state: null, number: null, ci: "unknown", branch: "b1" },
      2: { state: null, number: null, ci: "none", branch: "b2" },
      3: { state: null, number: null, ci: "failing", branch: "b3" },
    } as const;
    const watched = (id: number) => rows[id as keyof typeof rows];
    expect(watchTargets(t, deps({ watched, handoffHasOpenPr: () => true })).map((x) => x.repoId)).toEqual([1]);
    expect(watchTargets(t, deps({ watched, handoffHasOpenPr: () => false }))).toEqual([]);
  });

  it("checks a repo never checked before when the ticket's last handoff has an open PR", () => {
    const t = [{ key: "BTL-1", repos: [repo(1)] }, { key: "BTL-2", repos: [repo(2, { ticketKey: "BTL-2" })] }];
    const out = watchTargets(t, deps({ handoffHasOpenPr: (k) => k === "BTL-2" }));
    expect(out.map((x) => [x.ticketKey, x.repoId, x.sessionOpen])).toEqual([["BTL-2", 2, false]]);
  });

  it("a merged PR is not checked again even while its session is open", () => {
    const out = watchTargets([{ key: "BTL-1", repos: [repo(1)] }], deps({ sessionOpen: () => true, watched: () => ({ state: "merged", number: 1, ci: "passing", branch: "b1" }) }));
    expect(out).toEqual([]);
  });
});
