import { describe, expect, it, vi } from "vitest";
import { BranchOwnersRepo } from "../db/branch-owners-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { RETRYABLE_CLOSE_PR_ERRORS } from "../../shared/types";
import { M } from "../strings";
import { insertTicket, memDb } from "../test-utils";
import type { PrHead, PrHeadError } from "./gh";
import { closeWiring, type CloseWiringDeps } from "./ticket-close-wiring";

// BTL-270 审查（建议 3、两条决定）：index.ts 里关 PR、结束 session 的接线拿出来单独测。
const url = (n: number) => `https://github.com/o/app/pull/${n}`;

type Head = PrHead | PrHeadError;
const head = (over: Partial<PrHead> = {}): PrHead => ({ crossRepo: false, headOwner: "o", headRepo: "app", headBranch: "t-1", baseBranch: "main", open: true, ...over });

function setup(o: { defaultBranch?: string | ((repoPath: string) => Promise<string>); slugs?: Record<string, string | null>; ticketBranch?: string; heads?: Record<number, Head | (() => Promise<Head>)>; ran?: boolean; kind?: string | null; waiting?: boolean; screen?: boolean } = {}) {
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
    // 默认 /r/app 的 origin 是 o/app，别的路径读不到 slug（按路径比）。
    slugOf: vi.fn(async (p: string) => (o.slugs && p in o.slugs ? o.slugs[p] : p === "/r/app" ? "o/app" : null)),
    defaultBranch: vi.fn(typeof o.defaultBranch === "function" ? o.defaultBranch : async () => (o.defaultBranch as string | undefined) ?? "main"),
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

  it("a same-named branch under another owner (a fork) or a deleted head repo is not the ticket's own; one no longer open is left out", async () => {
    const s = setup({ heads: {
      1: head({ crossRepo: true, headOwner: "fork" }), 2: head({ headOwner: "fork" }), 3: head({ headOwner: null }), 4: head({ open: false }), 5: head({ headOwner: "O" }),
      6: head({ crossRepo: true, headOwner: "o" }),
    } });
    for (const n of [1, 2, 3, 4, 5, 6]) s.link(n, "t-1");
    const r = await s.w.openPrs("T-1");
    // owner 不分大小写：O 和 slug 的 o 是同一个。cross-repo 但 head 在 ticket 仓库的 owner 下的也算（按 owner 比，BTL-270 审查）。
    expect(r.closable.map((p) => p.number).sort()).toEqual([5, 6]);
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

  it("a branch name another ticket in the same repo also used (a ticket repo branch or a pushed branch) is shared_branch, naming it; the same name in another repo is not", async () => {
    const s = setup({ ticketBranch: "develop" });
    s.link(1, "develop");
    s.link(2, "feat/wt");
    s.branchOwners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/wt", sessionId: "s", dir: "/wt", at: 1 });
    const t2 = s.tickets.listRepos("T-2")[0].id;
    insertTicket(s.tickets, { key: "T-4", title: null, repoPath: "/r/app", workMode: "branch", worktreePath: null, branch: "develop", status: "closed", statusManual: "closed", createdAt: 1, archivedAt: 5 });
    s.branchOwners.record({ ticketKey: "T-2", repoId: t2, branch: "feat/wt", sessionId: "s2", dir: "/wt2", at: 1 });
    const r = await s.w.openPrs("T-1");
    expect(r.closable).toEqual([]);
    expect(r.unclosable).toEqual(expect.arrayContaining([
      { url: url(1), number: 1, kind: "shared_branch", ticket: "T-4" },
      { url: url(2), number: 2, kind: "shared_branch", ticket: "T-2" },
    ]));
    expect(r.unclosable).toHaveLength(2);
    expect(M().ticketClosePrWhy("shared_branch", "T-4")).toContain("T-4");
    // 别的仓库（slug 不同）的同名分支不算。
    const other = setup({ ticketBranch: "develop", slugs: { "/r/app": "o/app", "/r/other": "o/other" } });
    other.link(1, "develop");
    insertTicket(other.tickets, { key: "T-3", title: null, repoPath: "/r/other", workMode: "branch", worktreePath: null, branch: "develop", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
    other.branchOwners.record({ ticketKey: "T-3", repoId: other.tickets.listRepos("T-3")[0].id, branch: "develop", sessionId: "s3", dir: "/wt3", at: 1 });
    expect((await other.w.openPrs("T-1")).closable.map((p) => p.number)).toEqual([1]);
  });

  it("compares repos by slug: another clone of the same repo is the same repo, a different slug is not; a slug it can't read on either side counts as the same repo (BTL-270 review)", async () => {
    const make = (slugs: Record<string, string | null>) => {
      const s = setup({ ticketBranch: "develop", slugs });
      s.link(1, "develop");
      insertTicket(s.tickets, { key: "T-5", title: null, repoPath: "/clone/app", workMode: "branch", worktreePath: null, branch: "develop", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
      return s;
    };
    const same = await make({ "/r/app": "o/app", "/clone/app": "o/app" }).w.openPrs("T-1");
    expect(same.unclosable).toEqual([{ url: url(1), number: 1, kind: "shared_branch", ticket: "T-5" }]);
    expect((await make({ "/r/app": "o/app", "/clone/app": "o/other" }).w.openPrs("T-1")).closable.map((p) => p.number)).toEqual([1]);
    // 路径不同、一边读不到 slug（clone 删了、git 超时）：不知道是不是同一个仓库，当作同一个，报 shared_branch 不关（已知限制：可能误报）。
    for (const slugs of [{ "/r/app": "o/app", "/clone/app": null }, { "/r/app": null, "/clone/app": "o/app" }, { "/r/app": null, "/clone/app": null }]) {
      expect((await make(slugs).w.openPrs("T-1")).unclosable).toEqual([{ url: url(1), number: 1, kind: "shared_branch", ticket: "T-5" }]);
    }
    // 同一个路径两边都读不到 slug：算同一个仓库。
    const s = setup({ ticketBranch: "develop", slugs: { "/r/app": null } });
    s.link(1, "develop");
    insertTicket(s.tickets, { key: "T-6", title: null, repoPath: "/r/app", workMode: "branch", worktreePath: null, branch: "develop", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
    expect((await s.w.openPrs("T-1")).unclosable).toEqual([{ url: url(1), number: 1, kind: "shared_branch", ticket: "T-6" }]);
  });

  it("fork flow (origin me/app, PR opened to org/app): a head under the origin's owner is the ticket's own even cross-repo; another owner or a deleted head repo is not", async () => {
    const s = setup({ slugs: { "/r/app": "me/app" }, heads: {
      1: head({ crossRepo: true, headOwner: "me" }), 2: head({ crossRepo: false, headOwner: "org" }), 3: head({ crossRepo: true, headOwner: "bob" }), 4: head({ crossRepo: true, headOwner: null }),
    } });
    for (const n of [1, 2, 3, 4]) s.ticketPrs.link({ ticketKey: "T-1", url: `https://github.com/org/app/pull/${n}`, slug: "org/app", repoId: s.repoId, number: n, headBranch: "t-1", state: "open", source: "branch", linkedAt: 1 });
    for (const p of s.ticketPrs.byTicket("T-1")) s.ticketPrs.update(p.id, { checkedAt: 1, baseBranch: "main" });
    vi.mocked(s.d.prHead).mockImplementation(async (_cwd, u) => ({
      1: head({ crossRepo: true, headOwner: "me" }), 2: head({ headOwner: "org" }), 3: head({ crossRepo: true, headOwner: "bob" }), 4: head({ crossRepo: true, headOwner: null }),
    })[Number(u.split("/").pop()) as 1 | 2 | 3 | 4]);
    const r = await s.w.openPrs("T-1");
    expect(r.closable.map((p) => p.number)).toEqual([1]);
    expect(r.unclosable.map((u) => [u.number, u.kind]).sort()).toEqual([[2, "not_own_branch"], [3, "not_own_branch"], [4, "not_own_branch"]]);
  });

  it("with no slug for the ticket's repo it compares with the PR's repo owner; with no slug at all it does not close (BTL-270 review)", async () => {
    const s = setup({ slugs: { "/r/app": null } });
    s.link(1, "t-1");
    expect((await s.w.openPrs("T-1")).closable.map((p) => p.number)).toEqual([1]);
    const none = setup({ slugs: { "/r/app": null } });
    none.link(1, "t-1");
    const rows = none.ticketPrs.byTicket("T-1").map((p) => ({ ...p, slug: null as unknown as string }));
    none.d.ticketPrs = { byTicket: () => rows, byUrl: (u) => none.ticketPrs.byUrl(u) };
    const r = await none.w.openPrs("T-1");
    expect(r.closable).toEqual([]);
    expect(r.unclosable).toEqual([{ url: url(1), number: 1, kind: "not_own_branch" }]);
  });

  it("a gh too old for the head fields is unverified with an upgrade hint", async () => {
    const s = setup({ heads: { 1: { error: 'Unknown JSON field: "headRepositoryOwner"', ghTooOld: true } } });
    s.link(1, "t-1");
    const r = await s.w.openPrs("T-1");
    expect(r.unclosable).toEqual([{ url: url(1), number: 1, kind: "unverified", error: M().ticketCloseGhTooOld('Unknown JSON field: "headRepositoryOwner"') }]);
    expect(M().ticketCloseGhTooOld("x")).toMatch(/gh/);
  });

  it("one ticket in two repos with the same branch name: each repo's PR is the ticket's own, neither makes the other shared_branch; another ticket's same name only blocks its own repo", async () => {
    const s = setup({ ticketBranch: "develop", slugs: { "/r/app": "o/app", "/r/web": "o/web" } });
    const web = s.tickets.addRepo({ ticketKey: "T-1", repoPath: "/r/web", workMode: "branch", worktreePath: null, branch: "develop", createdAt: 1 });
    s.link(1, "develop");
    const { pr } = s.ticketPrs.link({ ticketKey: "T-1", url: "https://github.com/o/web/pull/2", slug: "o/web", repoId: web, number: 2, headBranch: "develop", state: "open", source: "branch", linkedAt: 1 });
    s.ticketPrs.update(pr.id, { checkedAt: 1, baseBranch: "main" });
    vi.mocked(s.d.prHead).mockImplementation(async () => head({ headBranch: "develop" }));
    expect((await s.w.openPrs("T-1")).closable.map((p) => p.number).sort()).toEqual([1, 2]);
    // 另一个 ticket 在 web 仓库也用过 develop：只拦 web 的 PR，app 的不受影响。
    insertTicket(s.tickets, { key: "T-7", title: null, repoPath: "/r/web", workMode: "branch", worktreePath: null, branch: "develop", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
    const r = await s.w.openPrs("T-1");
    expect(r.closable.map((p) => p.number)).toEqual([1]);
    expect(r.unclosable).toEqual([{ url: "https://github.com/o/web/pull/2", number: 2, kind: "shared_branch", ticket: "T-7" }]);
  });

  it("judges shared_branch on the live head: the row says one own branch, GitHub says another own branch that another ticket used (BTL-270 review)", async () => {
    const s = setup({ heads: { 1: head({ headBranch: "feat/wt" }) } });
    // T-1 自己的分支有两个：仓库分支 t-1，和推过的 feat/wt；T-2 在同一个仓库里也推过 feat/wt。
    s.branchOwners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/wt", sessionId: "s", dir: "/wt", at: 1 });
    s.branchOwners.record({ ticketKey: "T-2", repoId: s.tickets.listRepos("T-2")[0].id, branch: "feat/wt", sessionId: "s2", dir: "/wt2", at: 1 });
    s.link(1, "t-1");
    vi.mocked(s.d.prHead).mockImplementation(async () => head({ headBranch: "feat/wt" }));
    const r = await s.w.openPrs("T-1");
    expect(r.closable).toEqual([]);
    expect(r.unclosable).toEqual([{ url: url(1), number: 1, kind: "shared_branch", ticket: "T-2" }]);
  });

  it("judges shared_branch on the live head against another clone: the other ticket's pushed branch is recorded under a different clone path, read only for the live head (BTL-270 review)", async () => {
    const make = (cloneSlug: string) => {
      const s = setup({ slugs: { "/r/app": "o/app", "/clone/app": cloneSlug } });
      // T-1 自己推过 feat/wt；T-2 在另一个 clone 里（仓库分支是 t-2b，不叫 feat/wt），也推过 feat/wt：只有 branchOwners 记着它。
      const clone = s.tickets.addRepo({ ticketKey: "T-2", repoPath: "/clone/app", workMode: "branch", worktreePath: null, branch: "t-2b", createdAt: 1 });
      s.branchOwners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/wt", sessionId: "s", dir: "/wt", at: 1 });
      s.branchOwners.record({ ticketKey: "T-2", repoId: clone, branch: "feat/wt", sessionId: "s2", dir: "/clone/wt2", at: 1 });
      // 行里记的是 t-1（预先只读 t-1 牵涉的路径），GitHub 上实际的 head 是 feat/wt：/clone/app 的 slug 只在核对实时 head 时才读。
      s.link(1, "t-1");
      vi.mocked(s.d.prHead).mockImplementation(async () => head({ headBranch: "feat/wt" }));
      return s;
    };
    const same = await make("o/app").w.openPrs("T-1");
    expect(same.closable).toEqual([]);
    expect(same.unclosable).toEqual([{ url: url(1), number: 1, kind: "shared_branch", ticket: "T-2" }]);
    // 那个 clone 其实是别的仓库：读到了它的 slug 才知道，能关（没去读就当作读不到，会误报 shared_branch）。
    const other = make("o/other");
    expect((await other.w.openPrs("T-1")).closable.map((p) => p.number)).toEqual([1]);
    expect(vi.mocked(other.d.slugOf).mock.calls.map((c) => c[0])).toContain("/clone/app");
  });

  it("a branch owner whose repo row is gone counts as the same repo: shared_branch, not closed (BTL-270 review)", async () => {
    const s = setup({ slugs: { "/r/app": "o/app", "/clone/app": "o/other" } });
    const clone = s.tickets.addRepo({ ticketKey: "T-2", repoPath: "/clone/app", workMode: "branch", worktreePath: null, branch: "t-2b", createdAt: 1 });
    s.branchOwners.record({ ticketKey: "T-1", repoId: s.repoId, branch: "feat/wt", sessionId: "s", dir: "/wt", at: 1 });
    s.branchOwners.record({ ticketKey: "T-2", repoId: clone, branch: "feat/wt", sessionId: "s2", dir: "/clone/wt2", at: 1 });
    s.link(1, "feat/wt");
    // 有仓库行时 /clone/app 是别的仓库（o/other），能关。
    expect((await s.w.openPrs("T-1")).closable.map((p) => p.number)).toEqual([1]);
    // 归属记录还在、它的仓库行读不到了（路径不知道，slug 也就无从读起）：不知道是不是同一个仓库，当作同一个，不关。
    const getRepo = s.tickets.getRepo.bind(s.tickets);
    vi.spyOn(s.tickets, "getRepo").mockImplementation((id) => (id === clone ? null : getRepo(id)));
    const r = await s.w.openPrs("T-1");
    expect(r.closable).toEqual([]);
    expect(r.unclosable).toEqual([{ url: url(1), number: 1, kind: "shared_branch", ticket: "T-2" }]);
  });

  it("a cross-repo head must sit in the repo named like the origin, not just under its owner; a head repo name it can't read is not closed (BTL-270 review)", async () => {
    const s = setup({ slugs: { "/r/app": "me/app" } });
    for (const n of [1, 2, 3, 4]) s.link(n, "t-1");
    vi.mocked(s.d.prHead).mockImplementation(async (_cwd, u) => ({
      1: head({ crossRepo: true, headOwner: "me", headRepo: "App" }),
      2: head({ crossRepo: true, headOwner: "me", headRepo: "app-other-fork" }),
      3: head({ crossRepo: true, headOwner: "me", headRepo: null }),
      4: head({ crossRepo: false, headOwner: "me", headRepo: "whatever" }),
    })[Number(u.split("/").pop()) as 1 | 2 | 3 | 4]);
    const r = await s.w.openPrs("T-1");
    // 名字不分大小写；不是 fork 的（crossRepo false）head 就在 PR 的仓库里，只比 owner。
    expect(r.closable.map((p) => p.number).sort()).toEqual([1, 4]);
    expect(r.unclosable.map((u) => [u.number, u.kind]).sort()).toEqual([[2, "not_own_branch"], [3, "not_own_branch"]]);
  });

  it("reads slugs only through the async slugOf, once per path", async () => {
    const s = setup({ ticketBranch: "develop" });
    s.link(1, "develop");
    s.link(2, "develop");
    insertTicket(s.tickets, { key: "T-5", title: null, repoPath: "/clone/app", workMode: "branch", worktreePath: null, branch: "develop", status: "in_review", statusManual: null, createdAt: 1, archivedAt: null });
    vi.mocked(s.d.prHead).mockImplementation(async () => head({ headBranch: "develop" }));
    await s.w.openPrs("T-1");
    const paths = vi.mocked(s.d.slugOf).mock.calls.map((c) => c[0]);
    expect(new Set(paths)).toEqual(new Set(["/r/app", "/clone/app"]));
    expect(paths).toHaveLength(2);
  });

  it("with onlyPrs it reads and checks only the named PRs (BTL-270 review)", async () => {
    const s = setup();
    for (const n of [1, 2, 3]) s.link(n, "t-1");
    const r = await s.w.openPrs("T-1", new Set([url(2)]));
    expect(r.closable.map((p) => p.number)).toEqual([2]);
    expect(r.unclosable).toEqual([]);
    expect(vi.mocked(s.d.prHead).mock.calls.map((c) => c[1])).toEqual([url(2)]);
  });

  it("reads the default branches of several repos at once", async () => {
    let inFlight = 0;
    let most = 0;
    const s = setup({
      defaultBranch: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return "main";
      },
    });
    s.link(1, "t-1");
    const t2 = s.tickets.listRepos("T-2")[0].id;
    const { pr } = s.ticketPrs.link({ ticketKey: "T-1", url: url(2), slug: "o/app", repoId: t2, number: 2, headBranch: "t-2", state: "open", source: "branch", linkedAt: 1 });
    s.ticketPrs.update(pr.id, { checkedAt: 1, baseBranch: "main" });
    await s.w.openPrs("T-1");
    expect(s.d.defaultBranch).toHaveBeenCalledTimes(2);
    expect(most).toBe(2);
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
