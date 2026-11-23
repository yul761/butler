import { describe, expect, it, vi } from "vitest";
import { RepoRenamesRepo } from "../db/repo-renames-repo";
import { TicketPrsRepo } from "../db/ticket-prs-repo";
import { TicketsRepo } from "../db/tickets-repo";
import { memDb } from "../test-utils";
import { GH_NOT_FOUND } from "./gh";
import { RENAME_RETRY_MS, RENAME_SCAN_MAX, RepoRenames, type RepoRenamesDeps } from "./repo-renames";

function setup(github: Record<string, string | typeof GH_NOT_FOUND | null>, origins: Record<string, string> = {}) {
  const db = memDb();
  const tickets = new TicketsRepo(db);
  tickets.insert({ key: "T-1", title: null, status: "active", statusManual: null, createdAt: 1, archivedAt: null });
  const repoId = tickets.addRepo({ ticketKey: "T-1", repoPath: "/r", workMode: "branch", worktreePath: null, branch: "feat", createdAt: 1 });
  const prs = new TicketPrsRepo(db);
  const repo = new RepoRenamesRepo(db);
  const currentSlug = vi.fn<RepoRenamesDeps["currentSlug"]>(async (s) => (s in github ? github[s] : s));
  const onApplied = vi.fn<() => void>();
  const log = vi.fn<(m: string, e?: unknown) => void>();
  const r = new RepoRenames({
    repo, currentSlug, candidates: () => repo.candidates(0), slugOf: (p) => origins[p] ?? null, now: () => 100, log, onApplied,
  });
  const link = (slug: string, n: number) =>
    prs.link({ ticketKey: "T-1", url: `https://github.com/${slug}/pull/${n}`, slug, repoId, number: n, headBranch: null, state: "open", source: "branch", linkedAt: 1 }).pr;
  return { db, prs, repo, r, currentSlug, onApplied, log, link };
}

describe("RepoRenames", () => {
  it("scan asks GitHub about stored slugs and rewrites the ones it reports under another name", async () => {
    const s = setup({ "o/old": "o/new" });
    const a = s.link("o/old", 1);
    s.link("o/same", 2);
    await s.r.scan();
    expect(s.currentSlug.mock.calls.map((c) => c[0]).sort()).toEqual(["o/old", "o/same"]);
    expect(s.repo.canonical("o/old")).toBe("o/new");
    expect(s.prs.get(a.id)).toMatchObject({ slug: "o/new", url: "https://github.com/o/new/pull/1" });
    expect(s.onApplied).toHaveBeenCalledTimes(1);
    // 查过的不再查。
    await s.r.scan();
    expect(s.currentSlug).toHaveBeenCalledTimes(2); // o/new 是 GitHub 刚给的名字，也不用再查
  });

  it("does nothing when GitHub has no such repo or gh fails; a gh failure is tried again later", async () => {
    const s = setup({ "o/gone": GH_NOT_FOUND, "o/flaky": null });
    s.link("o/gone", 1);
    s.link("o/flaky", 2);
    await s.r.scan();
    expect(s.repo.all()).toEqual([]);
    expect(s.onApplied).not.toHaveBeenCalled();
    await s.r.scan();
    expect(s.currentSlug.mock.calls.map((c) => c[0]).filter((x) => x === "o/flaky")).toHaveLength(2);
    expect(s.currentSlug.mock.calls.map((c) => c[0]).filter((x) => x === "o/gone")).toHaveLength(1);
  });

  it("an origin that moved to a fork is not a rename: GitHub still knows the old name as itself", async () => {
    const s = setup({}, { "/r": "me/fork" });
    s.link("o/app", 1);
    await s.r.scan();
    expect(s.repo.all()).toEqual([]);
  });

  it("checks slugs whose local origin changed first, and at most RENAME_SCAN_MAX", async () => {
    const s = setup({}, { "/r": "o/renamed" });
    for (let i = 0; i < RENAME_SCAN_MAX + 5; i++) s.prs.link({ ticketKey: "T-1", url: `https://github.com/z/r${i}/pull/1`, slug: `z/r${i}`, repoId: null, number: 1, headBranch: null, state: "open", source: "handoff", linkedAt: 1 });
    s.link("o/app", 1);
    await s.r.scan();
    expect(s.currentSlug).toHaveBeenCalledTimes(RENAME_SCAN_MAX);
    expect(s.currentSlug.mock.calls[0][0]).toBe("o/app");
  });

  it("suggest confirms one slug with GitHub, once", async () => {
    const s = setup({ "o/old": "o/new" });
    s.link("o/old", 1);
    s.r.suggest("o/old", "o/new");
    s.r.suggest("o/old", "o/new");
    await s.r.scan();
    expect(s.currentSlug.mock.calls.filter((c) => c[0] === "o/old")).toHaveLength(1);
    expect(s.repo.canonical("o/old")).toBe("o/new");
    // 已经记下了：再看到也不查。
    s.r.suggest("o/old", "o/new");
    expect(s.currentSlug.mock.calls.filter((c) => c[0] === "o/old")).toHaveLength(1);
  });

  it("applyRecorded rewrites names written after the rename was recorded", () => {
    const s = setup({});
    s.repo.record("o/old", "o/new", "scan", 1);
    s.r.applyRecorded();
    expect(s.onApplied).not.toHaveBeenCalled();
    const late = s.link("o/old", 3);
    s.r.applyRecorded();
    expect(s.prs.get(late.id)).toMatchObject({ slug: "o/new" });
    expect(s.onApplied).toHaveBeenCalledTimes(1);
  });

  it("suggest does not queue the same slug twice, and waits RENAME_RETRY_MS after gh failed (BTL-261)", async () => {
    let now = 100;
    const s = setup({ "o/old": null });
    const r = new RepoRenames({
      repo: s.repo, currentSlug: s.currentSlug, candidates: () => [], slugOf: () => null, now: () => now, log: s.log,
    });
    r.suggest("o/old", "o/new");
    r.suggest("o/old", "o/new");
    await r.scan();
    expect(s.currentSlug).toHaveBeenCalledTimes(1);
    // gh 刚失败过：不再排队。
    r.suggest("o/old", "o/new");
    await r.scan();
    expect(s.currentSlug).toHaveBeenCalledTimes(1);
    now += RENAME_RETRY_MS;
    r.suggest("o/old", "o/new");
    await r.scan();
    expect(s.currentSlug).toHaveBeenCalledTimes(2);
  });
});
