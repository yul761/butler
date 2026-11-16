import { describe, expect, it, vi } from "vitest";
import type { HeadlessOutcome } from "../claude/headless";
import { JOB_LESSONS_DAILY, JobsRepo } from "../db/jobs-repo";
import { LessonsRepo } from "../db/lessons-repo";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import type { MergedPr, PrLessonData } from "../tickets/gh";
import { memDb } from "../test-utils";
import { BACKFILL_LIMIT, LessonRunner, RATE_LIMIT_PAUSE_MS, type LessonRunnerDeps } from "./lesson-runner";

const DAY = 86_400_000;
const T0 = new Date(2026, 5, 10, 12).getTime();

const prData = (n: number, over: Partial<PrLessonData> = {}): PrLessonData => ({
  number: n, title: `PR ${n}`, body: "", url: `https://x/pull/${n}`, author: "me", headRefName: `b${n}`, mergedAt: null,
  reviews: [], comments: [], inline: [], commits: [], botLogins: new Set(),
  ...over,
});
const withReview = (n: number, over: Partial<PrLessonData> = {}): PrLessonData =>
  prData(n, { comments: [{ id: `c${n}`, author: "alice", body: "please handle null", createdAt: 5, url: `https://x/pull/${n}#c` } as never], ...over });

const result = (structured: unknown): HeadlessOutcome => ({
  ok: true,
  result: { sessionId: "s", isError: false, subtype: "success", resultText: "", structured, permissionDenials: [], apiErrorStatus: null, costUsd: 0, usage: null, model: null },
});
const noFindings = result({ findings: [] });
const newRule = result({
  findings: [{ comment_url: null, summary: "s", avoidable: true, why_missed: "w", rule: { text: "Handle null", why: "crash", scope: "repo", product_id: null, same_as: null } }],
});

function setup(o: { identity?: (p: string) => string | null; available?: boolean } = {}) {
  const db = memDb();
  const repo = new LessonsRepo(db);
  const jobs = new JobsRepo(db);
  repo.upsertRepo("acme/web", "/w", 1);
  let t = T0;
  const gates: (() => void)[] = [];
  let live = 0;
  let peak = 0;
  const run = vi.fn<(req: { prompt: string }) => Promise<HeadlessOutcome>>(async () => noFindings);
  const gh = {
    mergedPrs: vi.fn<LessonRunnerDeps["gh"]["mergedPrs"]>(async () => [] as MergedPr[]),
    prLessonData: vi.fn<LessonRunnerDeps["gh"]["prLessonData"]>(async (_c, n) => withReview(n)),
    compareFiles: vi.fn<LessonRunnerDeps["gh"]["compareFiles"]>(async () => null),
    available: () => o.available ?? true,
  };
  const deps: LessonRunnerDeps = {
    repo,
    identity: { slugOf: o.identity ?? (() => "acme/web") } as never,
    jobs,
    gh,
    headless: {
      run, ready: async () => undefined, claude: () => ({ path: "/claude", pathValue: "" }), baseEnv: {},
      sessions: { recordHeadless: () => undefined } as never, now: () => t, newRunId: () => "r",
    } as unknown as HeadlessExecDeps,
    ticketForBranch: () => null,
    butlerContext: async () => ({ decisions: [], learnings: [], transcripts: [] }),
    lang: () => "en",
    now: () => t,
    notify: vi.fn(),
    log: vi.fn(),
  };
  const runner = new LessonRunner(deps);
  return {
    repo, jobs, run, gh, deps, runner, gates,
    peak: () => peak,
    hold() {
      run.mockImplementation(async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise<void>((r) => gates.push(r));
        live--;
        return noFindings;
      });
    },
    advance: (ms: number) => (t += ms),
    statusOf: (n: number) =>
      (db.prepare(`SELECT status, error, not_before FROM lesson_queue WHERE pr_number = ?`).get(n) as unknown as { status: string; error: string | null; not_before: number | null }),
    db,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("LessonRunner queue", () => {
  it("never runs more than 2 at once and finishes all 5", async () => {
    const s = setup();
    s.hold();
    s.repo.enqueue("acme/web", [1, 2, 3, 4, 5], "backfill", T0);
    s.runner.start();
    await flush();
    expect(s.gates.length).toBe(2);
    while (s.gates.length) {
      s.gates.shift()!();
      await flush();
    }
    await s.runner.idle();
    expect(s.peak()).toBe(2);
    for (let n = 1; n <= 5; n++) expect(s.statusOf(n).status).toBe("done");
    expect(s.repo.repo("acme/web")?.analyzedCount).toBe(5);
  });

  it("skips a PR with only author comments without calling claude", async () => {
    const s = setup();
    s.gh.prLessonData.mockResolvedValue(prData(1, { comments: [{ id: "c", author: "me", body: "note", createdAt: 5, url: "u" } as never] }));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("skipped");
    expect(s.run).not.toHaveBeenCalled();
  });

  it("marks failed with error gh when gh returns null and does not retry this round", async () => {
    const s = setup();
    s.gh.prLessonData.mockResolvedValue(null);
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "gh" });
    expect(s.gh.prLessonData).toHaveBeenCalledTimes(1);
  });

  it("defers on rate_limited by 10 minutes and takes nothing until then", async () => {
    const s = setup();
    s.run.mockResolvedValueOnce({ ok: false, reason: "rate_limited", message: "", result: null });
    s.repo.enqueue("acme/web", [1], "backfill", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1)).toMatchObject({ status: "queued", not_before: T0 + RATE_LIMIT_PAUSE_MS });
    expect(s.run).toHaveBeenCalledTimes(1);
    s.runner.merged("/w", 2);
    await s.runner.idle();
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(s.statusOf(2).status).toBe("queued");
    s.advance(RATE_LIMIT_PAUSE_MS);
    s.runner.merged("/w", 3);
    await s.runner.idle();
    for (const n of [1, 2, 3]) expect(s.statusOf(n).status).toBe("done");
  });

  it("puts an aborted run back in the queue", async () => {
    const s = setup();
    s.run.mockResolvedValueOnce({ ok: false, reason: "aborted", message: "", result: null });
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("done"); // deferred to now, then picked up again
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("does not take when the signal is already aborted", async () => {
    const s = setup();
    const ac = new AbortController();
    ac.abort();
    (s.deps.headless as { signal?: AbortSignal }).signal = ac.signal;
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("queued");
  });

  it("marks other failures failed with the reason, and bad output as bad_output", async () => {
    const s = setup();
    s.run.mockResolvedValueOnce({ ok: false, reason: "timeout", message: "", result: null });
    s.run.mockResolvedValueOnce(result({ nope: 1 }));
    s.repo.enqueue("acme/web", [1, 2], "backfill", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "timeout" });
    expect(s.statusOf(2)).toMatchObject({ status: "failed", error: "bad_output" });
  });

  it("an exception inside one item fails it and the runner carries on", async () => {
    const s = setup();
    s.gh.prLessonData.mockRejectedValueOnce(new Error("boom"));
    s.repo.enqueue("acme/web", [1, 2], "backfill", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "error" });
    expect(s.statusOf(2).status).toBe("done");
  });

  it("re-processes a row left running by a previous run", async () => {
    const s = setup();
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.db.prepare(`UPDATE lesson_queue SET status = 'running'`).run();
    const r = new LessonRunner(s.deps);
    r.start();
    await r.idle();
    expect(s.statusOf(1).status).toBe("done");
  });

  it("does not take anything before start()", async () => {
    const s = setup();
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.merged("/w", 2);
    await s.runner.daily();
    await s.runner.idle();
    expect(s.run).not.toHaveBeenCalled();
    expect(s.statusOf(1).status).toBe("queued");
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("done");
  });

  it("a throwing notify does not turn a done item into failed", async () => {
    const s = setup();
    s.deps.notify = vi.fn(() => {
      throw new Error("ui gone");
    });
    const r = new LessonRunner(s.deps);
    s.repo.enqueue("acme/web", [1], "merged", T0);
    r.start();
    await r.idle();
    expect(s.statusOf(1)).toMatchObject({ status: "done", error: null });
  });

  it("writes a new rule as pending and notifies", async () => {
    const s = setup();
    s.run.mockResolvedValue(newRule);
    s.repo.enqueue("acme/web", [7], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.repo.lessons()).toMatchObject([{ status: "pending", text: "Handle null" }]);
    expect(s.deps.notify).toHaveBeenCalled();
  });

  it("puts Butler context into the prompt for a Butler PR", async () => {
    const s = setup();
    s.deps.ticketForBranch = (slug, branch) => (slug === "acme/web" && branch === "b7" ? "BTL-1" : null);
    s.deps.butlerContext = vi.fn(async () => ({ decisions: ["DECISION-TEXT"], learnings: ["LEARNING-TEXT"], transcripts: [] }));
    const r = new LessonRunner(s.deps);
    s.repo.enqueue("acme/web", [7], "merged", T0);
    r.start();
    await r.idle();
    expect(s.run.mock.calls[0]![0].prompt).toContain("DECISION-TEXT");
    expect(s.run.mock.calls[0]![0].prompt).toContain("BTL-1");
  });

  it("does not ask for transcripts when no comment points at a file", async () => {
    const s = setup();
    s.deps.ticketForBranch = () => "BTL-1";
    const ctx = vi.fn(async () => ({ decisions: [], learnings: [], transcripts: [] }));
    s.deps.butlerContext = ctx;
    const r = new LessonRunner(s.deps);
    s.repo.enqueue("acme/web", [7], "merged", T0);
    r.start();
    await r.idle();
    expect(ctx).toHaveBeenCalledWith("BTL-1", false);
  });

  it("only keeps the fix patches of files the comments point at, and survives compareFiles failing", async () => {
    const s = setup();
    s.gh.prLessonData.mockResolvedValue(
      prData(7, {
        inline: [{ id: "i", author: "alice", body: "fix this", createdAt: Date.parse("2026-01-01T10:00:00Z"), url: "u", path: "src/a.ts", line: 3 } as never],
        commits: [
          { oid: "c1", committedDate: "2026-01-01T09:00:00Z", headline: "h", body: "" },
          { oid: "c2", committedDate: "2026-01-01T11:00:00Z", headline: "h", body: "" },
        ],
      }),
    );
    s.gh.compareFiles.mockResolvedValueOnce([{ filename: "src/a.ts", patch: "PATCH-A" }, { filename: "src/other.ts", patch: "PATCH-OTHER" }]);
    s.gh.compareFiles.mockResolvedValueOnce(null);
    s.repo.enqueue("acme/web", [7, 8], "backfill", T0);
    s.runner.start();
    await s.runner.idle();
    const prompts = s.run.mock.calls.map((c) => c[0].prompt);
    const first = prompts.find((p) => p.includes("PATCH-A"));
    expect(first).toBeDefined();
    expect(first).not.toContain("PATCH-OTHER");
    expect(s.statusOf(7).status).toBe("done");
    expect(s.statusOf(8).status).toBe("done");
  });
});

describe("LessonRunner backfill", () => {
  it("reports no_gh, gh_failed and unknown_repo without enqueuing", async () => {
    expect(await setup({ available: false }).runner.backfill("acme/web")).toEqual({ ok: false, reason: "no_gh" });
    const s = setup();
    s.gh.mergedPrs.mockResolvedValue(null);
    expect(await s.runner.backfill("acme/web")).toEqual({ ok: false, reason: "gh_failed" });
    expect(await s.runner.backfill("nope/none")).toEqual({ ok: false, reason: "unknown_repo" });
    expect(s.repo.queueCounts("acme/web").queued).toBe(0);
  });

  it("enqueues every PR, marks backfilled and advances the cursor to the newest mergedAt", async () => {
    const s = setup();
    s.hold();
    s.gh.mergedPrs.mockResolvedValue([
      { number: 1, mergedAt: "2026-01-01T00:00:00Z", headRefName: "a" },
      { number: 2, mergedAt: "2026-01-03T00:00:00Z", headRefName: "b" },
    ]);
    expect(await s.runner.backfill("acme/web")).toEqual({ ok: true, enqueued: 2 });
    expect(s.gh.mergedPrs).toHaveBeenCalledWith("/w", null, BACKFILL_LIMIT, expect.any(Number));
    expect(s.repo.repo("acme/web")).toMatchObject({ backfilledAt: T0, mergedCursor: "2026-01-03T00:00:00Z" });
    expect(s.db.prepare(`SELECT DISTINCT origin FROM lesson_queue`).all()).toEqual([{ origin: "backfill" }]);
  });

  it("logs when the list hits the limit", async () => {
    const s = setup();
    s.hold();
    s.gh.mergedPrs.mockResolvedValue(Array.from({ length: BACKFILL_LIMIT }, (_, i) => ({ number: i + 1, mergedAt: "2026-01-01T00:00:00Z", headRefName: "b" })));
    await s.runner.backfill("acme/web");
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining("hit the limit for acme/web"));
  });
});

describe("LessonRunner daily", () => {
  it("runs once a day, only for backfilled repos, and passes the cursor the next day", async () => {
    const s = setup();
    s.hold();
    s.repo.upsertRepo("acme/api", "/a", 1);
    s.repo.setBackfilled("acme/web", 1);
    s.gh.mergedPrs.mockResolvedValue([{ number: 9, mergedAt: "2026-06-10T01:00:00Z", headRefName: "x" }]);
    await s.runner.daily();
    await s.runner.daily();
    expect(s.gh.mergedPrs).toHaveBeenCalledTimes(1);
    expect(s.gh.mergedPrs).toHaveBeenCalledWith("/w", null, BACKFILL_LIMIT, expect.any(Number));
    expect(s.repo.repo("acme/web")?.mergedCursor).toBe("2026-06-10T01:00:00Z");
    expect(s.jobs.get(JOB_LESSONS_DAILY).lastRunAt).toBe(T0);
    expect(s.db.prepare(`SELECT origin FROM lesson_queue`).all()).toEqual([{ origin: "daily" }]);
    s.advance(DAY);
    await s.runner.daily();
    expect(s.gh.mergedPrs).toHaveBeenCalledTimes(2);
    expect(s.gh.mergedPrs).toHaveBeenLastCalledWith("/w", "2026-06-10T00:00:00Z", BACKFILL_LIMIT, expect.any(Number));
  });

  it("does not analyze an already analyzed PR again when the overlap returns it", async () => {
    const s = setup();
    s.repo.setBackfilled("acme/web", 1);
    s.gh.mergedPrs.mockResolvedValue([{ number: 9, mergedAt: "2026-06-10T01:00:00Z", headRefName: "x" }]);
    await s.runner.daily();
    s.runner.start();
    await s.runner.idle();
    expect(s.run).toHaveBeenCalledTimes(1);
    s.advance(DAY);
    await s.runner.daily();
    await s.runner.idle();
    expect(s.run).toHaveBeenCalledTimes(1);
  });
});

describe("LessonRunner merged", () => {
  it("ignores a path with no slug", async () => {
    const s = setup({ identity: () => null });
    s.runner.merged("/zzz", 5);
    await s.runner.idle();
    expect(s.db.prepare(`SELECT COUNT(*) AS n FROM lesson_queue`).get()).toEqual({ n: 0 });
  });

  it("registers the repo and enqueues with origin merged, even if history was never analyzed", () => {
    const s = setup({ identity: () => "acme/new" });
    s.hold();
    s.runner.merged("/n", 5);
    expect(s.repo.repo("acme/new")?.localPath).toBe("/n");
    expect(s.db.prepare(`SELECT repo_slug, pr_number, origin FROM lesson_queue`).all()).toEqual([{ repo_slug: "acme/new", pr_number: 5, origin: "merged" }]);
  });
});
