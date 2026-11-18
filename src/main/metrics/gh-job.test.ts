import { describe, expect, it, vi } from "vitest";
import { JOB_METRICS_GH, JobsRepo } from "../db/jobs-repo";
import { MetricsRepo } from "../db/metrics-repo";
import { memDb } from "../test-utils";
import type { PrComment, PrStatus, SearchedPr } from "../tickets/gh";
import { Metrics } from "./events";
import { baselineOf, METRICS_GH_RETRY_MS, MetricsGhJob, reopenCandidates, revertTargets, type JobPr, type MetricsGhDeps } from "./gh-job";

const DAY = 24 * 3_600_000;
const NOW = new Date(2026, 9, 15, 12).getTime();

const jp = (o: Partial<JobPr> = {}): JobPr => ({ id: 1, ticketKey: "T-1", slug: "o/app", number: 7, title: "Add cache", state: "merged", openedAt: NOW - 3 * DAY, mergedAt: NOW - 2 * DAY, closedAt: null, ...o });
const sp = (o: Partial<SearchedPr> = {}): SearchedPr => ({ number: 9, url: "https://github.com/o/app/pull/9", title: 'Revert "Add cache"', body: "", createdAt: NOW - DAY, mergedAt: NOW - DAY, ...o });

const status = (o: Partial<PrStatus> = {}): PrStatus => ({
  number: 3, url: "https://github.com/o/app/pull/3", state: "MERGED", isDraft: false, review: null, headSha: "s", headBranch: "b", checks: [], ci: "none",
  author: "me", reviews: [], comments: [], firstCommitAt: 10, createdAt: 100, mergedAt: 500, closedAt: 500, baseBranch: "main", title: "t", labels: [],
  reviewRequests: [], mergeable: null, mergeState: null, ...o,
});
const comment = (author: string, id = author): PrComment => ({ id, author, body: "x", createdAt: 1, url: null, path: null, line: null, reviewId: null });

describe("revertTargets", () => {
  it("matches `Reverts owner/repo#N` and `Reverts #N` in the body", () => {
    const prs = [jp(), jp({ id: 2, number: 8, title: "Other" }), jp({ id: 3, number: 5, slug: "o/else" })];
    expect(revertTargets(sp({ title: "Undo", body: "Reverts o/app#7" }), "o/app", prs).map((p) => p.id)).toEqual([1]);
    expect(revertTargets(sp({ title: "Undo", body: "reverts #8 and Reverts O/App#7" }), "o/app", prs).map((p) => p.id).sort()).toEqual([1, 2]);
    expect(revertTargets(sp({ title: "Undo", body: "Reverts o/else#7" }), "o/app", prs)).toEqual([]);
  });

  it("matches the GitHub title `Revert \"<title>\"`", () => {
    expect(revertTargets(sp(), "o/app", [jp()]).map((p) => p.id)).toEqual([1]);
    expect(revertTargets(sp({ title: 'Revert "Something else"' }), "o/app", [jp()])).toEqual([]);
    // 正文指了别的 PR：同名的 ticket PR 不算被 revert。
    expect(revertTargets(sp({ body: "Reverts o/app#50" }), "o/app", [jp()])).toEqual([]);
  });

  it("only counts PRs in the same repo merged before the revert, and three-part slugs", () => {
    expect(revertTargets(sp({ mergedAt: NOW - 5 * DAY }), "o/app", [jp()])).toEqual([]);
    expect(revertTargets(sp({ mergedAt: null }), "o/app", [jp()])).toEqual([]);
    expect(revertTargets(sp(), "o/app", [jp({ state: "open", mergedAt: null })])).toEqual([]);
    expect(revertTargets(sp({ number: 7, body: "Reverts #7" }), "o/app", [jp()])).toEqual([]);
    expect(revertTargets(sp({ body: "Reverts o/app#7", title: "x" }), "ghe.example.com/o/app", [jp({ slug: "ghe.example.com/o/app" })])).toHaveLength(1);
  });
});

describe("reopenCandidates", () => {
  it("keeps open PRs and ones with activity in the last 30 days, most recent first, up to 200", () => {
    const prs = [
      jp({ id: 1, state: "open", openedAt: NOW - 90 * DAY, mergedAt: null }),
      jp({ id: 2, mergedAt: NOW - 40 * DAY, openedAt: NOW - 41 * DAY }),
      jp({ id: 3, state: "closed", mergedAt: null, closedAt: NOW - DAY }),
      jp({ id: 4, mergedAt: NOW - 3 * DAY }),
    ];
    expect(reopenCandidates(prs, NOW).map((p) => p.id)).toEqual([3, 4, 1]);
    expect(reopenCandidates(Array.from({ length: 300 }, (_, i) => jp({ id: i, state: "open" })), NOW)).toHaveLength(200);
  });
});

describe("baselineOf", () => {
  it("counts comments, inline comments and reviews with a body by reviewer kind", () => {
    const pr = status({
      comments: [comment("alice"), comment("me"), comment("github-actions")],
      reviews: [
        { id: "r1", author: "bob", state: "COMMENTED", body: "nit", submittedAt: 1 },
        { id: "r1", author: "bob", state: "DISMISSED", body: "nit", submittedAt: 2 },
        { id: "r2", author: "bob", state: "APPROVED", body: "", submittedAt: 3 },
        { id: "r3", author: "copilot-pull-request-reviewer", state: "COMMENTED", body: "summary", submittedAt: 4 },
        { id: "r4", author: "carol", state: "PENDING", body: "draft", submittedAt: 5 },
      ],
    });
    expect(baselineOf("o/app", pr, [comment("Copilot", "c9"), comment("alice", "c10")], 99)).toEqual({
      slug: "o/app", number: 3, openedAt: 100, mergedAt: 500, firstCommitAt: 10, humanComments: 3, copilotComments: 2, fetchedAt: 99,
    });
  });

  it("does not count reviews or comments by Bot accounts the reviews API names (logins without [bot])", () => {
    const pr = status({
      comments: [comment("reviewbot"), comment("alice")],
      reviews: [{ id: "r1", author: "reviewbot", state: "COMMENTED", body: "auto", submittedAt: 1 }, { id: "r2", author: "dave", state: "COMMENTED", body: "ok", submittedAt: 2 }],
    });
    const bots = { botReviewIds: new Set(["r1"]), botLogins: new Set(["reviewbot"]) };
    expect(baselineOf("o/app", pr, [comment("ReviewBot", "c3")], 1, bots)).toMatchObject({ humanComments: 2, copilotComments: 0 });
    expect(baselineOf("o/app", pr, [], 1)).toMatchObject({ humanComments: 4 });
  });

  it("returns null without open or merge times", () => {
    expect(baselineOf("o/app", status({ mergedAt: null }), [], 1)).toBeNull();
  });
});

function setup(o: { prs?: JobPr[]; gh?: Partial<MetricsGhDeps["gh"]>; cutoff?: number } = {}) {
  const db = memDb();
  const repo = new MetricsRepo(db);
  const jobs = new JobsRepo(db);
  let now = NOW;
  const metrics = new Metrics({ repo, now: () => now });
  const gh: MetricsGhDeps["gh"] = {
    available: () => true,
    searchMergedPrs: vi.fn(async () => []),
    prStatus: vi.fn(async () => status()),
    reviewComments: vi.fn(async () => []),
    reviewAuthors: vi.fn(async () => null),
    issueEvents: vi.fn(async () => []),
    ...o.gh,
  };
  const job = new MetricsGhJob({
    gh, home: "/home", slugs: () => ["o/app"], prs: () => o.prs ?? [jp()], baseline: repo, cutoff: () => o.cutoff ?? NOW - 60 * DAY,
    record: metrics.recordEvent, jobs, now: () => now, log: () => {},
  });
  return { job, repo, jobs, gh, setNow: (t: number) => (now = t) };
}

describe("MetricsGhJob", () => {
  it("records reverts and reopens once, by dedupe key", async () => {
    const { job, repo } = setup({
      gh: {
        searchMergedPrs: vi.fn(async (_c: string, _r: string, search: string) => (search.startsWith("Revert") ? [sp()] : [])),
        issueEvents: vi.fn(async () => [{ id: "e1", event: "reopened", at: NOW - DAY }, { id: "e2", event: "closed", at: NOW - 2 * DAY }]),
      },
    });
    await job.run();
    await job.run();
    expect(repo.events(0).map((e) => [e.kind, e.prId, e.dedupeKey, e.at])).toEqual([
      ["pr_reverted", 1, "revert:1", NOW - DAY],
      ["pr_reopened", 1, "reopen:1:e1", NOW - DAY],
    ]);
  });

  it("backfills baseline PRs before the cutoff that are not ticket PRs, and does not reread them", async () => {
    const cutoff = NOW - 60 * DAY;
    const listed = [
      sp({ number: 3, url: "u3", mergedAt: cutoff - DAY }),
      sp({ number: 7, url: "u7", mergedAt: cutoff - DAY }),
      sp({ number: 4, url: "u4", mergedAt: cutoff + DAY }),
    ];
    const searchMergedPrs = vi.fn(async (_c: string, _r: string, search: string, _l: number, _t: number, author?: string) => (author === "@me" ? listed : []));
    const prStatus = vi.fn(async () => status());
    const { job, repo } = setup({ cutoff, gh: { searchMergedPrs, prStatus } });
    await job.run();
    expect(repo.baselinePrs().map((b) => [b.slug, b.number])).toEqual([["o/app", 3]]);
    expect(prStatus).toHaveBeenCalledWith("/home", "u3", expect.any(Number));
    const search = searchMergedPrs.mock.calls.find((c) => c[5] === "@me")![2];
    expect(search).toMatch(/^merged:\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2} sort:created-desc$/);
    await job.run();
    expect(prStatus).toHaveBeenCalledTimes(1);
  });

  it("runs once a day; when every gh call fails it retries after the backoff", async () => {
    const searchMergedPrs = vi.fn(async (): Promise<SearchedPr[] | null> => null);
    const { job, jobs, setNow } = setup({ prs: [], gh: { searchMergedPrs } });
    expect(await job.daily()).toBe(true);
    expect(jobs.get(JOB_METRICS_GH).lastStatus).toBe("failed");
    expect(await job.daily()).toBe(false);
    setNow(NOW + METRICS_GH_RETRY_MS);
    searchMergedPrs.mockImplementation(async () => []);
    expect(await job.daily()).toBe(true);
    expect(jobs.get(JOB_METRICS_GH).lastStatus).toBe("ok");
    expect(await job.daily()).toBe(false);
  });

  it("stops after five failures in a row", async () => {
    const issueEvents = vi.fn(async () => null);
    const prs = Array.from({ length: 20 }, (_, i) => jp({ id: i, number: i, state: "open" }));
    const { job } = setup({ prs, gh: { issueEvents } });
    const r = await job.run();
    expect(r.failed).toBeLessThanOrEqual(6);
    expect(r.stopped).toBe(true);
    expect(issueEvents.mock.calls.length).toBeLessThan(20);
  });

  it("records failed when it stops early even if some calls worked, so it retries after the backoff", async () => {
    let n = 0;
    const issueEvents = vi.fn(async () => (n++ < 3 ? [] : null));
    const prs = Array.from({ length: 20 }, (_, i) => jp({ id: i, number: i, state: "open" }));
    const { job, jobs } = setup({ prs, gh: { issueEvents } });
    expect(await job.daily()).toBe(true);
    expect(jobs.get(JOB_METRICS_GH).lastStatus).toBe("failed");
  });

  it("does nothing without gh", async () => {
    const { job, gh } = setup({ gh: { available: () => false } });
    expect(await job.daily()).toBe(false);
    expect(gh.searchMergedPrs).not.toHaveBeenCalled();
  });
});
