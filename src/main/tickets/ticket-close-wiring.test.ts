import { describe, expect, it, vi } from "vitest";
import { BranchOwnersRepo } from "../db/branch-owners-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { M } from "../strings";
import { insertTicket, memDb } from "../test-utils";
import type { PrHead } from "./gh";
import { closeWiring, type CloseWiringDeps } from "./ticket-close-wiring";

// BTL-270 审查（建议 3、两条决定）：index.ts 里关 PR、结束 session 的接线拿出来单独测。
const url = (n: number) => `https://github.com/o/app/pull/${n}`;

function setup(o: { defaultBranch?: string; ticketBranch?: string; heads?: Record<number, PrHead | null>; ran?: boolean; kind?: string | null; waiting?: boolean; screen?: boolean } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const ticketPrs = new TicketPrsRepo(db);
  const branchOwners = new BranchOwnersRepo(db);
  insertTicket(tickets, { key: "T-1", title: null, repoPath: "/r/app", workMode: "branch", worktreePath: null, branch: o.ticketBranch ?? "t-1", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
  insertTicket(tickets, { key: "T-2", title: null, repoPath: "/r/app", workMode: "branch", worktreePath: null, branch: "t-2", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.listRepos("T-1")[0].id;
  const link = (n: number, headBranch: string, x: { ticketKey?: string; baseBranch?: string | null } = {}) => {
    const { pr } = ticketPrs.link({ ticketKey: x.ticketKey ?? "T-1", url: url(n), slug: "o/app", repoId, number: n, headBranch, state: "open", source: "branch", linkedAt: 1 });
    ticketPrs.update(pr.id, { checkedAt: 1, baseBranch: x.baseBranch ?? "main" });
    return pr;
  };
  const calls: string[] = [];
  const records: { outcome: string; target?: string | null }[] = [];
  const d: CloseWiringDeps = {
    tickets, ticketPrs, branchOwners,
    ghDir: () => "/r/app",
    defaultBranch: async () => o.defaultBranch ?? "main",
    prHead: async (_cwd, u) => {
      const n = Number(u.split("/").pop());
      return o.heads && n in o.heads ? o.heads[n] : { crossRepo: false, headBranch: "x", open: true };
    },
    prClose: vi.fn(async (_cwd, _slug, n) => void calls.push(`gh close ${n}`)),
    external: {
      attempt: vi.fn(async (_kind, _detail, run) => {
        calls.push("attempt");
        return o.ran === false ? { ran: false as const, auditId: 1 } : { ran: true as const, value: await run(), auditId: 1 };
      }),
      record: vi.fn((_kind, detail) => (records.push({ outcome: detail.outcome, target: detail.target }), 1)),
    },
    sessions: {
      activityKind: () => (o.kind === undefined ? "idle" : o.kind),
      waitingForInput: () => o.waiting ?? true,
      screenNeedsUser: () => o.screen ?? false,
      setUserEnded: (id) => void calls.push(`ended ${id}`),
      kill: (termId) => void calls.push(`kill ${termId}`),
      forgetHibernated: (id) => void calls.push(`forget ${id}`),
    },
    now: () => 7,
    log: () => {},
  };
  return { w: closeWiring(d), d, tickets, ticketPrs, branchOwners, repoId, link, calls, records };
}

const closable = { url: url(1), number: 1, slug: "o/app", cwd: "/r/app" };

describe("closeWiring.closePr", () => {
  it("the user's close runs gh pr close directly and records it; a failure is recorded and thrown", async () => {
    const s = setup();
    expect(await s.w.closePr(closable, "不做了", { key: "T-1", source: "user" })).toBe("closed");
    expect(s.d.prClose).toHaveBeenCalledWith("/r/app", "o/app", 1, M().ticketClosePrComment("不做了"));
    expect(s.d.external.attempt).not.toHaveBeenCalled();
    expect(s.records).toEqual([{ outcome: "done", target: url(1) }]);
    vi.mocked(s.d.prClose).mockRejectedValueOnce(new Error("gh: nope"));
    await expect(s.w.closePr(closable, "不做了", { key: "T-1", source: "user" })).rejects.toThrow("gh: nope");
    expect(s.records[1]).toEqual({ outcome: "failed", target: url(1) });
  });

  it("a coordinator or routing close goes through the external action switch; switched off it is skipped and gh never runs", async () => {
    for (const source of ["coordinator", "routing"] as const) {
      const on = setup();
      expect(await on.w.closePr(closable, "r", { key: "T-1", source })).toBe("closed");
      expect(on.calls).toEqual(["attempt", "gh close 1"]);
      expect(on.records).toEqual([]);
      const off = setup({ ran: false });
      expect(await off.w.closePr(closable, "r", { key: "T-1", source })).toBe("skipped");
      expect(off.d.prClose).not.toHaveBeenCalled();
    }
  });
});

describe("closeWiring.endSession", () => {
  it("the user ends an open session without the end check; a coordinator's end is refused while it works or waits for the user", () => {
    const busy = setup({ kind: "working", waiting: false });
    expect(busy.w.endSession({ id: "s1", termId: "t1", hibernated: false }, "user")).toEqual({ ok: true });
    expect(busy.calls).toEqual(["ended s1", "kill t1"]);
    const refused = setup({ kind: "working", waiting: false });
    expect(refused.w.endSession({ id: "s1", termId: "t1", hibernated: false }, "coordinator")).toEqual({ ok: false, error: M().ctlSessionBusy("s1", "working") });
    expect(refused.calls).toEqual([]);
    const prompt = setup({ screen: true });
    expect(prompt.w.endSession({ id: "s1", termId: "t1", hibernated: false }, "routing")).toEqual({ ok: false, error: M().ctlSessionNeedsUser("s1") });
    expect(prompt.calls).toEqual([]);
    const idle = setup();
    expect(idle.w.endSession({ id: "s1", termId: "t1", hibernated: false }, "coordinator")).toEqual({ ok: true });
    expect(idle.calls).toEqual(["ended s1", "kill t1"]);
  });

  it("a hibernated session is never woken again, whoever ends it", () => {
    const s = setup({ kind: "working", waiting: false });
    expect(s.w.endSession({ id: "s2", termId: null, hibernated: true }, "coordinator")).toEqual({ ok: true });
    expect(s.calls).toEqual(["ended s2", "forget s2"]);
  });
});

describe("closeWiring.openPrs", () => {
  it("a PR on the ticket's own branch or a branch it owns can be closed", async () => {
    const s = setup();
    s.link(1, "t-1");
    s.link(2, "feat/wt");
    s.branchOwners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/wt", sessionId: "s", dir: "/wt", at: 1 });
    s.link(3, "someone-else");
    const r = await s.w.openPrs("T-1");
    expect(r.closable.map((p) => p.number).sort()).toEqual([1, 2]);
    expect(r.unclosable).toEqual([{ url: url(3), number: 3, kind: "not_own_branch" }]);
  });

  it("a PR whose head is the default branch, main / master, or its own target branch is not the ticket's own, even if the ticket's branch has that name", async () => {
    for (const [ticketBranch, base, def] of [["develop", "release", "develop"], ["main", "develop", "develop"], ["master", "develop", "trunk"], ["release", "release", "main"]] as const) {
      const s = setup({ ticketBranch, defaultBranch: def });
      s.link(1, ticketBranch, { baseBranch: base });
      const r = await s.w.openPrs("T-1");
      expect(r.closable).toEqual([]);
      expect(r.unclosable).toEqual([{ url: url(1), number: 1, kind: "not_own_branch" }]);
    }
  });

  it("a same-named branch on a fork (isCrossRepository) is not the ticket's own; an unreadable head is not closed; one no longer open is left out", async () => {
    const s = setup({ heads: { 1: { crossRepo: true, headBranch: "t-1", open: true }, 2: null, 3: { crossRepo: false, headBranch: "t-1", open: false } } });
    s.link(1, "t-1");
    s.link(2, "t-1");
    s.link(3, "t-1");
    s.link(4, "t-1");
    const r = await s.w.openPrs("T-1");
    expect(r.closable.map((p) => p.number)).toEqual([4]);
    expect(r.unclosable).toEqual(expect.arrayContaining([{ url: url(1), number: 1, kind: "not_own_branch" }, { url: url(2), number: 2, kind: "never_read" }]));
    expect(r.unclosable).toHaveLength(2);
  });

  it("a PR also linked to another ticket is not closed for it, even when that ticket is closed (reopening it would want the PR back)", async () => {
    const s = setup();
    s.link(1, "t-1");
    s.link(1, "t-1", { ticketKey: "T-2" });
    s.tickets.close("T-2", { at: 1, reason: "r", source: "user" });
    const r = await s.w.openPrs("T-1");
    expect(r.closable).toEqual([]);
    expect(r.unclosable).toEqual([{ url: url(1), number: 1, kind: "shared", ticket: "T-2" }]);
  });
});
