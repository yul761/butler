import { describe, expect, it } from "vitest";
import type { Pr } from "../../shared/handoff";
import type { MergeHold } from "../db/merge-gate-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import { PrLinker } from "./pr-links";

const SLUGS: Record<string, string> = { "/a": "a/x", "/b": "a/y" };

function setup(repoPaths: string[] = ["/a"], extra: Partial<ConstructorParameters<typeof PrLinker>[0]> = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoIds = repoPaths.map((repoPath) => tickets.addRepo({ ticketKey: "T-1", repoPath, workMode: "branch", worktreePath: null, branch: "feat", createdAt: 1 }));
  const prs = new TicketPrsRepo(db);
  const linker = new PrLinker({ prs, tickets, slugOf: (p) => SLUGS[p] ?? null, now: () => 50, ...extra });
  return { prs, linker, repoIds };
}

const pr = (number: number, url: string, state: Pr["state"] = "open"): Pr => ({ number, url, state, review: null });

describe("PrLinker", () => {
  it("links a handoff PR to the ticket repo with the same slug", () => {
    const { prs, linker, repoIds } = setup();
    expect(linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/a/x/pull/3", "merged")])).toBe(1);
    expect(prs.byTicket("T-1")[0]).toMatchObject({ repoId: repoIds[0], slug: "a/x", number: 3, state: "merged", source: "handoff", headBranch: null, linkedAt: 50, checkedAt: 0 });
    expect(linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/a/x/pull/3/")])).toBe(0);
    expect(prs.byTicket("T-1")).toHaveLength(1);
  });

  it("a handoff PR from a repo that is not one of the ticket's remotes is not linked (BTL-261)", () => {
    const { prs, linker } = setup();
    expect(linker.linkHandoffPrs("T-1", [pr(9, "https://ghe.acme.io/team/app/pull/9"), pr(25, "https://github.com/someone/x/pull/25")])).toBe(0);
    expect(prs.byTicket("T-1")).toEqual([]);
  });

  it("fork workflow: a handoff PR on the upstream remote links to the repo (BTL-261)", () => {
    const remoteSlugs = (p: string) => (p === "/a" ? ["me/x", "a/x"] : []);
    const { prs, linker, repoIds } = setup(["/a"], { slugOf: () => "me/x", remoteSlugs });
    expect(linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/a/x/pull/3"), pr(4, "https://github.com/me/x/pull/4")])).toBe(2);
    expect(prs.byTicket("T-1").map((r) => [r.slug, r.repoId]).sort()).toEqual([["a/x", repoIds[0]], ["me/x", repoIds[0]]]);
    expect(linker.foreign("T-1", "https://github.com/a/x/pull/3")).toBe(false);
    expect(linker.foreign("T-1", "https://github.com/other/x/pull/3")).toBe(true);
  });

  it("a ticket whose remotes cannot be resolved still links handoff PRs, with no repo, and nothing counts as foreign", () => {
    const { prs, linker } = setup(["/gone"]);
    expect(linker.foreign("T-1", "https://github.com/a/x/pull/3")).toBe(false);
    expect(linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/a/x/pull/3")])).toBe(1);
    expect(prs.byTicket("T-1")[0]).toMatchObject({ repoId: null, slug: "a/x" });
  });

  it("foreign is undecided while any of the ticket's repos has no resolvable remote, or a remote GitHub has not confirmed yet (BTL-261 review)", () => {
    const remoteSlugs = (p: string) => (p === "/a" ? ["a/x"] : []);
    // 两个仓库，B 的路径不在：B 的 PR 不能当成别的仓库的。
    const partial = setup(["/a", "/b"], { slugOf: (p) => (p === "/a" ? "a/x" : null), remoteSlugs });
    expect(partial.linker.foreign("T-1", "https://github.com/b/y/pull/3")).toBe(false);
    expect(partial.linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/b/y/pull/3")])).toBe(1);
    // origin 还没去 GitHub 确认过（可能刚改了名）：先收录，确认以后再说。
    const settled = new Set<string>();
    const moved: [string, string][] = [];
    const s = setup(["/a"], { slugOf: () => "a/x", remoteSlugs, settled: (x) => settled.has(x), onSlugMoved: (o, n) => moved.push([o, n]) });
    expect(s.linker.foreign("T-1", "https://github.com/a/x-renamed/pull/3")).toBe(false);
    expect(s.linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/a/x-renamed/pull/3")])).toBe(1);
    expect(moved).toEqual([["a/x", "a/x-renamed"]]);
    settled.add("a/x");
    expect(s.linker.foreign("T-1", "https://github.com/a/x-renamed/pull/3")).toBe(true);
  });

  it("an unmatched handoff PR asks the rename check about each of the ticket's origins, and is logged (BTL-261)", () => {
    const moved: [string, string][] = [];
    const logs: string[] = [];
    const { prs, linker } = setup(["/a", "/b"], { onSlugMoved: (o, n) => moved.push([o, n]), log: (m) => logs.push(m) });
    // 仓库刚改名、改名还没记下：origin 还是 a/x，session 报的是新名字的链接。
    expect(linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/a/x-renamed/pull/3")])).toBe(0);
    expect(prs.byTicket("T-1")).toEqual([]);
    expect(moved).toEqual([["a/x", "a/x-renamed"], ["a/y", "a/x-renamed"]]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("https://github.com/a/x-renamed/pull/3");
  });

  it("canonicalizes renamed repos: an old-name link lands on the new name, matches the repo, and does not duplicate the new-name row", () => {
    const canonical = (s: string) => (s === "old/x" ? "a/x" : s);
    const { prs, linker, repoIds } = setup(["/a"], { canonical });
    expect(linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/Old/X/pull/3")])).toBe(1);
    expect(prs.byTicket("T-1")[0]).toMatchObject({ repoId: repoIds[0], slug: "a/x", url: "https://github.com/a/x/pull/3" });
    expect(linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/a/x/pull/3")])).toBe(0);
    expect(linker.linkBranchPrs("T-1", { id: repoIds[0], repoPath: "/a", branch: "feat" }, [
      { number: 3, url: "https://github.com/old/x/pull/3", state: "OPEN", headRefName: "feat", createdAt: 1, mergedAt: null, closedAt: null },
    ], "branch")).toBe(0);
    expect(prs.byTicket("T-1")).toHaveLength(1);
  });

  it("a local origin still on the old name matches a link on the new name once the rename is known", () => {
    const canonical = (s: string) => (s === "a/x" ? "a/x2" : s);
    const { prs, linker, repoIds } = setup(["/a"], { canonical });
    expect(linker.linkHandoffPrs("T-1", [pr(3, "https://github.com/a/x2/pull/3")])).toBe(1);
    expect(prs.byTicket("T-1")[0]).toMatchObject({ repoId: repoIds[0], slug: "a/x2" });
  });

  it("reports when gh lists a branch PR under another repo name than the origin's", () => {
    const moved: [string, string][] = [];
    const { linker, repoIds } = setup(["/a"], { onSlugMoved: (a, b) => void moved.push([a, b]) });
    const b = (u: string) => ({ number: 3, url: u, state: "OPEN" as const, headRefName: "feat", createdAt: 1, mergedAt: null, closedAt: null });
    linker.linkBranchPrs("T-1", { id: repoIds[0], repoPath: "/a", branch: "feat" }, [b("https://github.com/a/x/pull/3")], "branch");
    expect(moved).toEqual([]);
    linker.linkBranchPrs("T-1", { id: repoIds[0], repoPath: "/a", branch: "feat" }, [b("https://github.com/a/renamed/pull/3")], "branch");
    expect(moved).toEqual([["a/x", "a/renamed"]]);
  });

  it("never links an empty or unparsable URL", () => {
    const { prs, linker } = setup(["/a", "/b"]);
    expect(linker.linkHandoffPrs("T-1", [pr(5, ""), pr(6, "not a url")])).toBe(0);
    expect(prs.byTicket("T-1")).toEqual([]);
  });

  it("in a multi-repo ticket a PR links to the repo whose slug matches", () => {
    const { prs, linker, repoIds } = setup(["/a", "/b"]);
    linker.linkHandoffPrs("T-1", [pr(1, "https://github.com/a/y/pull/1")]);
    expect(prs.byTicket("T-1")[0]).toMatchObject({ repoId: repoIds[1], slug: "a/y", number: 1 });
  });

  it("linkHold resolves a null ticket through the session and uses released_at as mergedAt", () => {
    const { prs, linker, repoIds } = setup();
    const hold: MergeHold = {
      id: 1, repoPath: "/a", branch: "feat", target: "main", kind: "pr", prUrl: "https://github.com/a/x/pull/4", sessionId: "s1", ticketKey: null,
      createdAt: 10, releasedAt: 77, outcome: "merged",
    };
    expect(linker.linkHold(hold, (s) => (s === "s1" ? "T-1" : null))).toBe(true);
    expect(prs.byTicket("T-1")[0]).toMatchObject({ repoId: repoIds[0], number: 4, state: "merged", mergedAt: 77, headBranch: "feat", source: "merge_gate" });
    expect(linker.linkHold({ ...hold, sessionId: "unknown", prUrl: "https://github.com/a/x/pull/5" }, () => null)).toBe(false);
    expect(linker.linkHold({ ...hold, prUrl: "https://github.com/a/x/pull/6", outcome: null, releasedAt: null }, () => "T-1")).toBe(true);
    expect(prs.byTicket("T-1").find((p) => p.number === 6)).toMatchObject({ state: "open", mergedAt: null });
  });
});
