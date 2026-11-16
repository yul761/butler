import { describe, expect, it } from "vitest";
import type { Pr } from "../../shared/handoff";
import type { MergeHold } from "../db/merge-gate-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import { PrLinker } from "./pr-links";

const SLUGS: Record<string, string> = { "/a": "a/x", "/b": "a/y" };

function setup(repoPaths: string[] = ["/a"]) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoIds = repoPaths.map((repoPath) => tickets.addRepo({ ticketKey: "T-1", repoPath, workMode: "branch", worktreePath: null, branch: "feat", createdAt: 1 }));
  const prs = new TicketPrsRepo(db);
  const linker = new PrLinker({ prs, tickets, slugOf: (p) => SLUGS[p] ?? null, now: () => 50 });
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

  it("a PR from another repo is linked with repo_id null and its slug", () => {
    const { prs, linker } = setup();
    linker.linkHandoffPrs("T-1", [pr(9, "https://ghe.acme.io/team/app/pull/9")]);
    expect(prs.byTicket("T-1")[0]).toMatchObject({ repoId: null, slug: "ghe.acme.io/team/app", number: 9 });
  });

  it("does not link an empty-URL PR in a multi-repo ticket", () => {
    const { prs, linker } = setup(["/a", "/b"]);
    expect(linker.linkHandoffPrs("T-1", [pr(5, ""), pr(6, "not a url")])).toBe(0);
    expect(prs.byTicket("T-1")).toEqual([]);
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
