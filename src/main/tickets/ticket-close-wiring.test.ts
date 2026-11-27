import { describe, expect, it, vi } from "vitest";
import { BranchOwnersRepo } from "../db/branch-owners-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { RETRYABLE_CLOSE_PR_ERRORS } from "../../shared/types";
import { M } from "../strings";
import { insertTicket, memDb } from "../test-utils";
import type { PrHead } from "./gh";
import { closeWiring, type CloseWiringDeps } from "./ticket-close-wiring";

// BTL-270 审查（建议 3、两条决定）：index.ts 里关 PR、结束 session 的接线拿出来单独测。
const url = (n: number) => `https://github.com/o/app/pull/${n}`;

type Head = PrHead | { error: string };
const head = (over: Partial<PrHead> = {}): PrHead => ({ crossRepo: false, headOwner: "o", headBranch: "t-1", baseBranch: "main", open: true, ...over });

function setup(o: { defaultBranch?: string; ticketBranch?: string; heads?: Record<number, Head | (() => Promise<Head>)>; ran?: boolean; kind?: string | null; waiting?: boolean; screen?: boolean } = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  const ticketPrs = new TicketPrsRepo(db);
  const branchOwners = new BranchOwnersRepo(db);
  insertTicket(tickets, { key: "T-1", title: null, repoPath: "/r/app", workMode: "branch", worktreePath: null, branch: o.ticketBranch ?? "t-1", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
  insertTicket(tickets, { key: "T-2", title: null, repoPath: "/r/app", workMode: "branch", worktreePath: null, branch: "t-2", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.listRepos("T-1")[0].id;
  const heads = new Map<number, string>();
  const link = (n: number, headBranch: string, x: { ticketKey?: string; baseBranch?: string | null } = {}) => {
    heads.set(n, headBranch);
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
    prHead: vi.fn(async (_cwd: string, u: string) => {
      const n = Number(u.split("/").pop());
      const h = o.heads?.[n];
      if (typeof h === "function") return h();
      // 默认：实时读到的就是行里记的那个分支（link 时记下）。
      return h ?? head({ headBranch: heads.get(n) ?? "t-1" });
    }),
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

  it("a same-named branch on a fork (another owner, or cross-repo) or a deleted head repo is not the ticket's own; one no longer open is left out", async () => {
    const s = setup({ heads: {
      1: head({ crossRepo: true, headOwner: "fork" }), 2: head({ headOwner: "fork" }), 3: head({ headOwner: null }), 4: head({ open: false }), 5: head({ headOwner: "O" }),
    } });
    for (const n of [1, 2, 3, 4, 5]) s.link(n, "t-1");
    const r = await s.w.openPrs("T-1");
    // owner 不分大小写：O 和 slug 的 o 是同一个。
    expect(r.closable.map((p) => p.number)).toEqual([5]);
    expect(r.unclosable).toEqual(expect.arrayContaining([1, 2, 3].map((n) => ({ url: url(n), number: n, kind: "not_own_branch" }))));
    expect(r.unclosable).toHaveLength(3);
  });

  it("judges the live head and target branch gh reads, not the ones stored on the row", async () => {
    const s = setup({ heads: {
      1: head({ headBranch: "someone-else" }), 2: head({ baseBranch: "t-1" }), 3: head({ headBranch: "t-1", baseBranch: "release" }),
    } });
    // 行里记的目标分支是 t-1（会被判成不是自己的），实时读到的是 release：能关。
    for (const n of [1, 2]) s.link(n, "t-1");
    s.link(3, "t-1", { baseBranch: "main" });
    const r = await s.w.openPrs("T-1");
    expect(r.closable.map((p) => p.number)).toEqual([3]);
    expect(r.unclosable).toEqual(expect.arrayContaining([1, 2].map((n) => ({ url: url(n), number: n, kind: "not_own_branch" }))));
  });

  it("a failed head check (gh error, timeout or a throw) is retryable (unverified) with gh's reason, not never_read; checks run at once", async () => {
    let inFlight = 0;
    let most = 0;
    const slow = (h: Head) => async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return h;
    };
    const s = setup({ heads: { 1: slow({ error: "timed out after 10s" }), 2: () => Promise.reject(new Error("spawn gh ENOENT")), 3: slow(head()) } });
    for (const n of [1, 2, 3]) s.link(n, "t-1");
    const r = await s.w.openPrs("T-1");
    expect(r.closable.map((p) => p.number)).toEqual([3]);
    expect(r.unclosable).toEqual(expect.arrayContaining([
      { url: url(1), number: 1, kind: "unverified", error: M().ticketCloseVerifyFailed("timed out after 10s") },
      { url: url(2), number: 2, kind: "unverified", error: M().ticketCloseVerifyFailed("spawn gh ENOENT") },
    ]));
    expect(most).toBe(2);
    expect(RETRYABLE_CLOSE_PR_ERRORS).toContain("unverified");
  });

  it("a branch name another ticket in the same repo also used (a ticket repo branch or a pushed branch) is public; the same name in another repo is not", async () => {
    const s = setup({ ticketBranch: "develop" });
    s.link(1, "develop");
    s.link(2, "feat/wt");
    s.branchOwners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/wt", sessionId: "s", dir: "/wt", at: 1 });
    const t2 = s.tickets.listRepos("T-2")[0].id;
    insertTicket(s.tickets, { key: "T-4", title: null, repoPath: "/r/app", workMode: "branch", worktreePath: null, branch: "develop", status: "closed", statusManual: "closed", createdAt: 1, archivedAt: 5 });
    s.branchOwners.record({ ticketKey: "T-2", repoId: t2, branch: "feat/wt", sessionId: "s2", dir: "/wt2", at: 1 });
    const r = await s.w.openPrs("T-1");
    expect(r.closable).toEqual([]);
    expect(r.unclosable).toEqual(expect.arrayContaining([1, 2].map((n) => ({ url: url(n), number: n, kind: "not_own_branch" }))));
    // 别的仓库的同名分支不算。
    const other = setup({ ticketBranch: "develop" });
    other.link(1, "develop");
    insertTicket(other.tickets, { key: "T-3", title: null, repoPath: "/r/other", workMode: "branch", worktreePath: null, branch: "develop", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
    other.branchOwners.record({ ticketKey: "T-3", repoId: other.tickets.listRepos("T-3")[0].id, branch: "develop", sessionId: "s3", dir: "/wt3", at: 1 });
    expect((await other.w.openPrs("T-1")).closable.map((p) => p.number)).toEqual([1]);
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
