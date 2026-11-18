import { describe, expect, it, vi } from "vitest";
import type { LimitHit } from "../../shared/availability";
import { ClaudeAvailability } from "../claude/availability";
import type { ClaudeResult, HeadlessFailure, HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import { AvailabilityRepo } from "../db/availability-repo";
import { JOB_LESSONS_DAILY, JobsRepo } from "../db/jobs-repo";
import { LessonRunsRepo, RUN_MAX_AGE_MS } from "../db/lesson-runs-repo";
import { LessonsRepo } from "../db/lessons-repo";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import type { MergedPr, PrLessonData } from "../tickets/gh";
import { memDb } from "../test-utils";
import { RoutingRepo } from "../db/routing-repo";
import { UsageRepo } from "../db/usage-repo";
import { RoutingService } from "../routing/routing-service";
import { BACKFILL_LIMIT, DAILY_RETRY_BACKOFF_MS, LessonRunner, type LessonRunnerDeps } from "./lesson-runner";

const DAY = 86_400_000;
const T0 = new Date(2026, 5, 10, 12).getTime();

const prData = (n: number, over: Partial<PrLessonData> = {}): PrLessonData => ({
  number: n, title: `PR ${n}`, body: "", url: `https://x/pull/${n}`, author: "me", headRefName: `b${n}`, mergedAt: null,
  reviews: [], comments: [], inline: [], commits: [], botLogins: new Set(),
  ...over,
});
const withReview = (n: number, over: Partial<PrLessonData> = {}): PrLessonData =>
  prData(n, { comments: [{ id: `c${n}`, author: "alice", body: "please handle null", createdAt: 5, url: `https://x/pull/${n}#c` } as never], ...over });
const ghData = (data: PrLessonData | null, stderr = "") => ({ data, stderr });

const claudeResult = (over: Partial<ClaudeResult> = {}): ClaudeResult => ({
  sessionId: "s", isError: false, subtype: "success", resultText: "", structured: null, permissionDenials: [], apiErrorStatus: null, costUsd: 0, usage: null, model: null, durationMs: null,
  ...over,
});
const result = (structured: unknown): HeadlessOutcome => ({ ok: true, result: claudeResult({ structured }) });
const fail = (reason: HeadlessFailure, over: Partial<{ message: string; result: ClaudeResult | null; limit: LimitHit | null; stderr: string }> = {}): HeadlessOutcome => ({
  ok: false, reason, message: "", result: null, limit: null, stderr: "", ...over,
});
const noFindings = result({ findings: [] });
const newRule = result({
  findings: [{ comment_url: null, summary: "s", avoidable: true, why_missed: "w", rule: { text: "Handle null", why: "crash", scope: "repo", product_id: null, same_as: null, globs: [], lang: null, layer: null, strength: "should", checkability: "prose", checkability_reason: "r" } }],
});
/** 素材里有 “## PR #n:” 这一行。 */
const isPr = (req: { prompt: string }, n: number) => req.prompt.includes(`#${n}: PR ${n}`);

function setup(o: { identity?: (p: string) => string | null; available?: boolean } = {}) {
  const db = memDb();
  const repo = new LessonsRepo(db);
  const runs = new LessonRunsRepo(db);
  const jobs = new JobsRepo(db);
  repo.upsertRepo("acme/web", "/w", 1);
  let t = T0;
  const gates: (() => void)[] = [];
  let live = 0;
  let peak = 0;
  const timers: { fn: () => void; ms: number }[] = [];
  const availability = new ClaudeAvailability({
    repo: new AvailabilityRepo(db), now: () => t, onChange: () => undefined,
    setTimer: (fn, ms) => {
      const h = { fn, ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const run = vi.fn<(req: HeadlessRequest) => Promise<HeadlessOutcome>>(async () => noFindings);
  const gh = {
    mergedPrs: vi.fn<LessonRunnerDeps["gh"]["mergedPrs"]>(async () => [] as MergedPr[]),
    prLessonDataDetail: vi.fn<LessonRunnerDeps["gh"]["prLessonDataDetail"]>(async (_c, n) => ghData(withReview(n))),
    compareFiles: vi.fn<LessonRunnerDeps["gh"]["compareFiles"]>(async () => null),
    available: () => o.available ?? true,
  };
  const deps: LessonRunnerDeps = {
    repo,
    runs,
    availability,
    identity: { slugOf: o.identity ?? (() => "acme/web") } as never,
    jobs,
    gh,
    headless: {
      run, ready: async () => undefined, claude: () => ({ path: "/claude", pathValue: "" }), baseEnv: {},
      sessions: { recordHeadless: () => undefined } as never, now: () => t, newRunId: () => "r",
      // 和 index.ts 一样：headless 的限流先报给可用状态，runner 再看结果。
      onLimit: (hit: LimitHit, job: string) => availability.report({ ...hit, source: "headless", job, sessionId: null }),
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
    repo, runs, jobs, run, gh, deps, runner, gates, availability,
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
    async releaseAll() {
      while (gates.length) {
        gates.shift()!();
        await flush();
      }
      await runner.idle();
    },
    /** 让可用状态的定时器到点。 */
    fireTimers() {
      for (const h of timers.splice(0)) h.fn();
    },
    advance: (ms: number) => (t += ms),
    now: () => t,
    queueId: (n: number) => Number((db.prepare(`SELECT id FROM lesson_queue WHERE pr_number = ?`).get(n) as { id: number }).id),
    statusOf: (n: number) =>
      (db.prepare(`SELECT status, error, error_message, not_before, attempts, last_run_id FROM lesson_queue WHERE pr_number = ?`).get(n) as unknown as {
        status: string; error: string | null; error_message: string | null; not_before: number | null; attempts: number; last_run_id: number | null;
      }),
    /** 这个 PR 最新的一次运行。 */
    lastRun: (n: number) => runs.forPr("acme/web", n)[0]!,
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
    s.gh.prLessonDataDetail.mockResolvedValue(ghData(prData(1, { comments: [{ id: "c", author: "me", body: "note", createdAt: 5, url: "u" } as never] })));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("skipped");
    expect(s.run).not.toHaveBeenCalled();
  });

  it("marks failed with error gh when gh returns null and does not retry this round", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValue(ghData(null));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "gh" });
    expect(s.gh.prLessonDataDetail).toHaveBeenCalledTimes(1);
  });

  it("puts an aborted run back in the queue", async () => {
    const s = setup();
    s.run.mockResolvedValueOnce({ ok: false, reason: "aborted", message: "", result: null, limit: null, stderr: "" });
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("done"); // deferred to now, then picked up again
    expect(s.run).toHaveBeenCalledTimes(2);
    expect(s.runs.forPr("acme/web", 1).map((r) => [r.status, r.reason])).toEqual([["done", null], ["aborted", "app_quit"]]);
  });

  it("an app quit during a run records it aborted, keeps the item queued and takes nothing more", async () => {
    const s = setup();
    const quit = new AbortController();
    (s.deps.headless as { signal?: AbortSignal }).signal = quit.signal;
    s.run.mockImplementationOnce(async (req) => {
      quit.abort();
      expect(req.signal?.aborted).toBe(true);
      return fail("aborted");
    });
    s.repo.enqueue("acme/web", [1], "merged", T0);
    const earlier = s.runs.start({ queueId: s.queueId(1), slug: "acme/web", prNumber: 1, origin: "merged", startedAt: T0 - 5000 });
    s.runs.finish(earlier, { status: "failed", reason: "timeout", finishedAt: T0 - 4000 });
    s.db.prepare(`UPDATE lesson_queue SET last_run_id = ?`).run(earlier);
    s.runner.start();
    await s.runner.idle();
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(s.lastRun(1)).toMatchObject({ status: "aborted", reason: "app_quit" });
    // defer 不带 runId：last_run_id 留着上一次的。
    expect(s.statusOf(1)).toMatchObject({ status: "queued", not_before: T0, attempts: 1, last_run_id: earlier });
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
    s.run.mockResolvedValueOnce({ ok: false, reason: "timeout", message: "", result: null, limit: null, stderr: "" });
    s.run.mockResolvedValueOnce(result({ nope: 1 }));
    s.repo.enqueue("acme/web", [1, 2], "backfill", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "timeout" });
    expect(s.statusOf(2)).toMatchObject({ status: "failed", error: "bad_output" });
    expect(s.lastRun(1)).toMatchObject({ status: "failed", reason: "timeout" });
    const bad = s.lastRun(2);
    expect(bad).toMatchObject({ status: "failed", reason: "bad_output", rawOutput: '{"nope":1}' });
    expect(bad.message).toContain("findings");
    expect(s.statusOf(2).last_run_id).toBe(bad.id);
  });

  it("an exception inside one item fails it and the runner carries on", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockRejectedValueOnce(new Error("boom"));
    s.repo.enqueue("acme/web", [1, 2], "backfill", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "error", error_message: "Error: boom", attempts: 0 });
    expect(s.lastRun(1)).toMatchObject({ status: "failed", reason: "error", message: "Error: boom" });
    expect(s.statusOf(1).last_run_id).toBe(s.lastRun(1).id);
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
    s.runner.merged({ repoPath: "/w", slug: "acme/web" }, 2);
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

  it("a skipped analysis notifies", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValue(ghData(prData(1)));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("skipped");
    expect(s.deps.notify).toHaveBeenCalledTimes(1);
  });

  it("an exception inside an analysis still notifies once", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockRejectedValue(new Error("boom"));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "error" });
    expect(s.deps.notify).toHaveBeenCalledTimes(1);
  });

  it("a failed analysis notifies", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValue(ghData(null));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("failed");
    expect(s.deps.notify).toHaveBeenCalledTimes(1);
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

  it("inline comments with no fix range set fixesNote and still analyse", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValue(ghData(
      prData(7, {
        inline: [{ id: "i", author: "alice", body: "fix this", createdAt: Date.parse("2026-01-01T10:00:00Z"), url: "u", path: "src/a.ts", line: 3 } as never],
        commits: [{ oid: "c1", committedDate: "2026-01-01T12:00:00Z", headline: "h", body: "" }],
      })),
    );
    s.repo.enqueue("acme/web", [7], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.gh.compareFiles).not.toHaveBeenCalled();
    expect(s.run.mock.calls[0]![0].prompt).toContain("history was rewritten");
    expect(s.deps.log).toHaveBeenCalledWith(expect.stringContaining("rewritten"));
    expect(s.statusOf(7).status).toBe("done");
  });

  it("no commit after the comment leaves fixesNote null", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValue(ghData(
      prData(7, {
        inline: [{ id: "i", author: "alice", body: "fix this", createdAt: Date.parse("2026-01-01T10:00:00Z"), url: "u", path: "src/a.ts", line: 3 } as never],
        commits: [{ oid: "c1", committedDate: "2026-01-01T09:00:00Z", headline: "h", body: "" }],
      })),
    );
    s.repo.enqueue("acme/web", [7], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.run.mock.calls[0]![0].prompt).not.toContain("history was rewritten");
    expect(s.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("rewritten"));
    expect(s.statusOf(7).status).toBe("done");
  });

  it("only keeps the fix patches of files the comments point at, and survives compareFiles failing", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValue(ghData(
      prData(7, {
        inline: [{ id: "i", author: "alice", body: "fix this", createdAt: Date.parse("2026-01-01T10:00:00Z"), url: "u", path: "src/a.ts", line: 3 } as never],
        commits: [
          { oid: "c1", committedDate: "2026-01-01T09:00:00Z", headline: "h", body: "" },
          { oid: "c2", committedDate: "2026-01-01T11:00:00Z", headline: "h", body: "" },
        ],
      })),
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

describe("LessonRunner run records", () => {
  it("a failed claude run stores reason, message, stderr tail, cost and material", async () => {
    const s = setup();
    s.run.mockResolvedValueOnce(
      fail("claude_error", {
        message: "boom",
        stderr: "warn: something\n",
        result: claudeResult({
          isError: true, resultText: "boom", costUsd: 0.0042, model: "claude-x", durationMs: 1234,
          usage: { input: 10, cacheWrite5m: 1, cacheWrite1h: 2, cacheRead: 3, output: 7 },
        }),
      }),
    );
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    const r = s.lastRun(1);
    expect(r).toMatchObject({
      status: "failed", reason: "claude_error", message: "boom", stderrTail: "warn: something\n", rawOutput: "boom",
      costUsd: 0.0042, model: "claude-x", inputTokens: 16, outputTokens: 7, durationMs: 1234,
      prTitle: "PR 1", prUrl: "https://x/pull/1", origin: "merged", queueId: s.queueId(1), finishedAt: T0,
    });
    expect(r.material).toContain("please handle null");
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "claude_error", error_message: "boom", attempts: 1, last_run_id: r.id });
    expect(s.deps.notify).toHaveBeenCalledTimes(1);
  });

  it("a gh failure stores gh stderr", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValue(ghData(null, "HTTP 502: Bad Gateway"));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    const r = s.lastRun(1);
    expect(r).toMatchObject({ status: "failed", reason: "gh", ghStderr: "HTTP 502: Bad Gateway", material: null });
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "gh", attempts: 0, last_run_id: r.id });
    expect(s.run).not.toHaveBeenCalled();
  });

  it("an item whose repo row is gone fails as unknown_repo without spawning", async () => {
    const s = setup();
    s.repo.enqueue("acme/web", [1], "merged", T0);
    // 外键在正常库里拦着这种状态；这里关掉外键模拟仓库被删。
    s.db.exec("PRAGMA foreign_keys = OFF");
    s.db.prepare(`DELETE FROM lesson_repos`).run();
    s.runner.start();
    await s.runner.idle();
    const r = s.lastRun(1);
    expect(r).toMatchObject({ status: "failed", reason: "unknown_repo" });
    expect(s.statusOf(1)).toMatchObject({ status: "failed", error: "unknown_repo", attempts: 0, last_run_id: r.id });
    expect(s.gh.prLessonDataDetail).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });

  it("a PR without review comments is a skipped run with title and url", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValue(ghData(prData(1)));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    const r = s.lastRun(1);
    expect(r).toMatchObject({ status: "skipped", reason: "no_review_comments", prTitle: "PR 1", prUrl: "https://x/pull/1" });
    expect(s.statusOf(1)).toMatchObject({ status: "skipped", error: null, attempts: 0, last_run_id: r.id });
  });

  it("a done run stores counts, findings and links new sources to the run", async () => {
    const s = setup();
    s.run.mockImplementation(async () => {
      s.advance(500);
      return newRule;
    });
    s.repo.enqueue("acme/web", [7], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    const r = s.lastRun(7);
    expect(r).toMatchObject({ status: "done", reason: null, created: 1, hit: 0, dropped: 0, durationMs: 500, prTitle: "PR 7" });
    expect(r.findings).toEqual([expect.objectContaining({ summary: "s", rule: expect.objectContaining({ text: "Handle null" }) })]);
    expect(r.rawOutput).toContain("Handle null");
    expect(r.material).toContain("please handle null");
    expect(s.repo.lessons()[0]!.sources).toEqual([expect.objectContaining({ prNumber: 7, slug: "acme/web", runId: r.id })]);
    expect(s.statusOf(7)).toMatchObject({ status: "done", attempts: 1, last_run_id: r.id });
  });
});

describe("LessonRunner availability", () => {
  it("a usage limit makes the run limited, defers the item and takes nothing more while paused", async () => {
    const s = setup();
    const resetsAt = T0 + 3_600_000;
    s.run.mockImplementation(async (req) =>
      isPr(req, 1)
        ? fail("rate_limited", { message: "You've hit your limit", stderr: "err tail", limit: { kind: "usage_limit", resetsAt, message: "You've hit your limit · resets 1pm" } })
        : noFindings,
    );
    s.repo.enqueue("acme/web", [1, 2, 3], "backfill", T0);
    s.runner.start();
    await s.runner.idle();
    // 1 和 2 同时开始：1 撞了限额，2 照常跑完；3 不再取。
    expect(s.run).toHaveBeenCalledTimes(2);
    const r = s.lastRun(1);
    expect(r).toMatchObject({ status: "limited", reason: "usage_limit", message: "You've hit your limit", stderrTail: "err tail" });
    expect(s.statusOf(1)).toMatchObject({ status: "queued", not_before: T0, attempts: 1, last_run_id: r.id });
    expect(s.statusOf(2).status).toBe("done");
    expect(s.statusOf(3).status).toBe("queued");
    expect(s.availability.lessonsGate(s.now())).toMatchObject({ paused: true, reason: "limit" });
    s.runner.merged({ repoPath: "/w", slug: "acme/web" }, 4);
    await s.runner.idle();
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("a rate limit the classifier did not recognise still pauses, and the item is not spawned again at once", async () => {
    const s = setup();
    s.run.mockResolvedValueOnce(fail("rate_limited", { message: "429 Too Many Requests" }));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(s.lastRun(1)).toMatchObject({ status: "limited", reason: "rate_limit", message: "429 Too Many Requests" });
    expect(s.availability.view().current).toMatchObject({ kind: "rate_limit", source: "headless", job: "lessons", message: "429 Too Many Requests" });
    expect(s.availability.lessonsGate(s.now()).paused).toBe(true);
    expect(s.statusOf(1)).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("a pause reported mid-run lets the running item finish and takes nothing more", async () => {
    const s = setup();
    s.hold();
    s.repo.enqueue("acme/web", [1, 2, 3], "backfill", T0);
    s.runner.start();
    await flush();
    expect(s.gates.length).toBe(2);
    s.availability.report({ kind: "usage_limit", resetsAt: null, message: "limit", source: "session", job: null, sessionId: "sess" });
    await s.releaseAll();
    expect(s.statusOf(1).status).toBe("done");
    expect(s.statusOf(2).status).toBe("done");
    expect(s.statusOf(3).status).toBe("queued");
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("the availability change after the pause ends pumps the queue", async () => {
    const s = setup();
    s.availability.report({ kind: "usage_limit", resetsAt: null, message: "limit", source: "session", job: null, sessionId: "sess" });
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.run).not.toHaveBeenCalled();
    s.advance(10 * 60_000);
    s.fireTimers();
    await s.runner.idle();
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(s.statusOf(1).status).toBe("done");
  });

  it("model unavailable is limited, not failed", async () => {
    const s = setup();
    const message = "There's an issue with the selected model (claude-x)";
    s.run.mockResolvedValueOnce(fail("model_unavailable", { message, limit: { kind: "model_unavailable", resetsAt: null, message } }));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.run).toHaveBeenCalledTimes(1);
    const r = s.lastRun(1);
    expect(r).toMatchObject({ status: "limited", reason: "model_unavailable", message });
    expect(s.statusOf(1)).toMatchObject({ status: "queued", error: null, attempts: 1, last_run_id: r.id });
    expect(s.availability.lessonsGate(s.now())).toMatchObject({ paused: true, reason: "model" });
  });

  it("runNow resumes a limit pause and clears not_before, taking the older deferred item first", async () => {
    const s = setup();
    s.availability.report({ kind: "usage_limit", resetsAt: null, message: "limit", source: "session", job: null, sessionId: "sess" });
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.repo.defer(s.queueId(1), T0 + 3_600_000);
    s.repo.enqueue("acme/web", [2], "merged", T0 + 1000);
    s.runner.start();
    await s.runner.idle();
    expect(s.run).not.toHaveBeenCalled();
    s.runner.runNow();
    await s.runner.idle();
    expect(s.availability.lessonsGate(s.now()).paused).toBe(false);
    expect(s.gh.prLessonDataDetail.mock.calls.map((c) => c[1])).toEqual([1, 2]);
    expect(s.run).toHaveBeenCalledTimes(2);
    expect(s.statusOf(1).status).toBe("done");
    expect(s.statusOf(2).status).toBe("done");
  });

  it("a sibling that started before the limit and then succeeds does not lift the pause", async () => {
    const s = setup();
    (s.deps.headless as HeadlessExecDeps).onSuccess = (startedAt, job) => s.availability.noteSuccess(startedAt, job);
    const pending = new Map<number, (o: HeadlessOutcome) => void>();
    s.run.mockImplementation((req) => new Promise((res) => pending.set([1, 2, 3].find((n) => isPr(req, n))!, res)));
    s.repo.enqueue("acme/web", [1, 2, 3], "backfill", T0);
    s.runner.start();
    await flush();
    expect([...pending.keys()].sort()).toEqual([1, 2]);
    s.advance(1000);
    pending.get(1)!(fail("rate_limited", { message: "limit", limit: { kind: "usage_limit", resetsAt: null, message: "limit" } }));
    await flush();
    expect(s.availability.lessonsGate(s.now()).paused).toBe(true);
    pending.get(2)!(noFindings);
    await s.runner.idle();
    expect(s.statusOf(2).status).toBe("done");
    expect(s.availability.lessonsGate(s.now())).toMatchObject({ paused: true, reason: "limit" });
    expect(s.statusOf(3).status).toBe("queued");
    expect(s.run).toHaveBeenCalledTimes(2);
  });
});

describe("LessonRunner cancel and retry", () => {
  it("cancel of a running item aborts the spawn and marks run and item cancelled", async () => {
    const s = setup();
    s.run.mockImplementation(
      (req) => new Promise((res) => req.signal?.addEventListener("abort", () => res(fail("aborted")))),
    );
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await flush();
    expect(s.run).toHaveBeenCalledTimes(1);
    const running = s.runner.running();
    expect(running).toEqual([{ queueId: s.queueId(1), runId: s.lastRun(1).id, slug: "acme/web", prNumber: 1, startedAt: T0 }]);
    expect(s.runner.cancel(running[0]!.queueId)).toBe("ok");
    await s.runner.idle();
    expect(s.run.mock.calls[0]![0].signal?.aborted).toBe(true);
    const r = s.lastRun(1);
    expect(r).toMatchObject({ status: "cancelled", reason: "cancelled" });
    expect(s.statusOf(1)).toMatchObject({ status: "skipped", error: "cancelled", attempts: 1, last_run_id: r.id });
    expect(s.runner.running()).toEqual([]);
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it("cancel during the gh phase never spawns claude", async () => {
    const s = setup();
    let release!: () => void;
    s.gh.prLessonDataDetail.mockImplementationOnce((_c, n) => new Promise((res) => (release = () => res(ghData(withReview(n))))));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await flush();
    expect(s.runner.cancel(s.queueId(1))).toBe("ok");
    release();
    await s.runner.idle();
    expect(s.run).not.toHaveBeenCalled();
    const r = s.lastRun(1);
    expect(r).toMatchObject({ status: "cancelled", reason: "cancelled", prTitle: "PR 1" });
    expect(s.statusOf(1)).toMatchObject({ status: "skipped", error: "cancelled", attempts: 0, last_run_id: r.id });
  });

  it("cancel while the Butler context is loading never spawns claude", async () => {
    const s = setup();
    s.deps.ticketForBranch = () => "BTL-1";
    let release!: () => void;
    s.deps.butlerContext = () => new Promise((res) => (release = () => res({ decisions: [], learnings: [], transcripts: [] })));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await flush();
    expect(s.gh.prLessonDataDetail).toHaveBeenCalledTimes(1);
    expect(s.runner.cancel(s.queueId(1))).toBe("ok");
    release();
    await s.runner.idle();
    expect(s.run).not.toHaveBeenCalled();
    const r = s.lastRun(1);
    expect(r).toMatchObject({ status: "cancelled", reason: "cancelled", prTitle: "PR 1" });
    expect(r.material).toContain("please handle null");
    expect(s.statusOf(1)).toMatchObject({ status: "skipped", error: "cancelled", attempts: 0, last_run_id: r.id });
  });

  it("cancel of a queued item skips it without running", async () => {
    const s = setup();
    s.repo.enqueue("acme/web", [1], "merged", T0);
    expect(s.runner.cancel(s.queueId(1))).toBe("ok");
    s.runner.start();
    await s.runner.idle();
    expect(s.run).not.toHaveBeenCalled();
    expect(s.statusOf(1)).toMatchObject({ status: "skipped", error: "cancelled" });
  });

  it("cancel after the item finished returns bad_status", async () => {
    const s = setup();
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.runner.cancel(s.queueId(1))).toBe("bad_status");
    expect(s.runner.cancel(9999)).toBe("not_found");
    expect(s.statusOf(1).status).toBe("done");
  });

  it("retry runs the item ahead of older queued items", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValueOnce(ghData(null));
    s.repo.enqueue("acme/web", [1], "merged", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("failed");
    s.availability.pauseLessons();
    s.advance(1000);
    s.repo.enqueue("acme/web", [2, 3], "backfill", s.now());
    s.advance(1000);
    expect(s.runner.retry(s.queueId(1))).toBe("ok");
    expect(s.runner.retry(9999)).toBe("not_found");
    s.availability.resumeLessons();
    await s.runner.idle();
    expect(s.gh.prLessonDataDetail.mock.calls.map((c) => c[1])).toEqual([1, 1, 2, 3]);
    for (const n of [1, 2, 3]) expect(s.statusOf(n).status).toBe("done");
    expect(s.runner.retry(s.queueId(1))).toBe("bad_status");
  });

  it("retryFailed re-queues every failed item of the repo and runs them", async () => {
    const s = setup();
    s.gh.prLessonDataDetail.mockResolvedValueOnce(ghData(null)).mockResolvedValueOnce(ghData(null));
    s.repo.enqueue("acme/web", [1, 2], "backfill", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("failed");
    expect(s.statusOf(2).status).toBe("failed");
    expect(s.runner.retryFailed("acme/web")).toBe(2);
    await s.runner.idle();
    expect(s.statusOf(1).status).toBe("done");
    expect(s.statusOf(2).status).toBe("done");
    expect(s.runner.retryFailed("acme/web")).toBe(0);
  });
});

describe("LessonRunner start and pruning", () => {
  it("start marks a running run aborted and re-queues its PR once", async () => {
    const s = setup();
    s.repo.enqueue("acme/web", [1], "merged", T0 - 5000);
    s.db.prepare(`UPDATE lesson_queue SET status = 'running', attempts = 1`).run();
    s.runs.start({ queueId: s.queueId(1), slug: "acme/web", prNumber: 1, origin: "merged", startedAt: T0 - 1000 });
    s.runner.start();
    await s.runner.idle();
    const rows = s.runs.forPr("acme/web", 1);
    expect(rows.map((r) => [r.status, r.reason, r.finishedAt])).toEqual([["done", null, T0], ["aborted", "app_quit", T0]]);
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(s.statusOf(1)).toMatchObject({ status: "done", attempts: 2, last_run_id: rows[0]!.id });
  });

  it("start prunes runs older than the retention window", () => {
    const s = setup();
    const old = s.runs.start({ queueId: null, slug: "acme/web", prNumber: 1, origin: "merged", startedAt: T0 - RUN_MAX_AGE_MS - 1 });
    s.runs.finish(old, { status: "failed", reason: "gh", finishedAt: T0 - RUN_MAX_AGE_MS });
    s.runner.start();
    expect(s.runs.get(old)).toBeNull();
  });

  it("daily prunes runs", async () => {
    const s = setup();
    s.repo.setBackfilled("acme/web", 1);
    const old = s.runs.start({ queueId: null, slug: "acme/web", prNumber: 1, origin: "merged", startedAt: T0 - RUN_MAX_AGE_MS - 1 });
    s.runs.finish(old, { status: "failed", reason: "gh", finishedAt: T0 - RUN_MAX_AGE_MS });
    await s.runner.daily();
    expect(s.jobs.get(JOB_LESSONS_DAILY).lastStatus).toBe("ok");
    expect(s.runs.get(old)).toBeNull();
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

  it("refuses repos that came from an import and are not cloned here, and never queues their merged PRs", async () => {
    const s = setup();
    s.repo.ensureRepo("acme/imported", T0);
    s.gh.mergedPrs.mockClear();
    expect(await s.runner.backfill("acme/imported")).toEqual({ ok: false, reason: "unknown_repo" });
    expect(s.gh.mergedPrs).not.toHaveBeenCalled();
    s.runner.merged({ repoPath: null, slug: "acme/imported" }, 9);
    expect(s.repo.queueCounts("acme/imported").queued).toBe(0);
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

  it("daily with every repo failing records failed and runs again on the next call the same day", async () => {
    const s = setup();
    s.repo.setBackfilled("acme/web", 1);
    s.gh.mergedPrs.mockResolvedValue(null);
    await s.runner.daily();
    expect(s.jobs.get(JOB_LESSONS_DAILY)).toMatchObject({ lastStatus: "failed", lastError: "all repos failed" });
    s.gh.mergedPrs.mockResolvedValue([]);
    s.advance(60_000);
    await s.runner.daily();
    expect(s.gh.mergedPrs).toHaveBeenCalledTimes(1);
    s.advance(DAILY_RETRY_BACKOFF_MS);
    await s.runner.daily();
    expect(s.gh.mergedPrs).toHaveBeenCalledTimes(2);
    expect(s.jobs.get(JOB_LESSONS_DAILY).lastStatus).toBe("ok");
    await s.runner.daily();
    expect(s.gh.mergedPrs).toHaveBeenCalledTimes(2);
  });

  it("a throwing mergedPrs counts as failed", async () => {
    const s = setup();
    s.repo.setBackfilled("acme/web", 1);
    s.gh.mergedPrs.mockRejectedValue(new Error("boom"));
    await s.runner.daily();
    expect(s.jobs.get(JOB_LESSONS_DAILY)).toMatchObject({ lastStatus: "failed", lastError: "all repos failed" });
  });

  it("a partial failure records ok", async () => {
    const s = setup();
    s.repo.upsertRepo("acme/api", "/a", 1);
    s.repo.setBackfilled("acme/web", 1);
    s.repo.setBackfilled("acme/api", 1);
    s.gh.mergedPrs.mockImplementation(async (cwd) => (cwd === "/w" ? null : []));
    await s.runner.daily();
    expect(s.jobs.get(JOB_LESSONS_DAILY).lastStatus).toBe("ok");
  });

  it("does not analyze an already analyzed PR again when the overlap returns it", async () => {
    const s = setup();
    s.repo.setBackfilled("acme/web", 1);
    const cursor = "2026-06-10T01:00:00Z";
    const overlapAfter = "2026-06-10T00:00:00Z"; // the cursor minus the one-hour overlap
    // the PR comes back only when the call asks from the overlapped cursor
    s.gh.mergedPrs.mockImplementation(async (_cwd, after) =>
      after === null || after === overlapAfter ? [{ number: 9, mergedAt: cursor, headRefName: "x" }] : [],
    );
    await s.runner.daily();
    s.runner.start();
    await s.runner.idle();
    expect(s.gh.mergedPrs.mock.calls[0][1]).toBeNull();
    expect(s.run).toHaveBeenCalledTimes(1);
    expect(s.repo.repo("acme/web")?.mergedCursor).toBe(cursor);
    s.advance(DAY);
    await s.runner.daily();
    await s.runner.idle();
    expect(s.gh.mergedPrs.mock.calls[1][1]).toBe(overlapAfter);
    expect(s.run).toHaveBeenCalledTimes(1);
  });
});

describe("LessonRunner merged", () => {
  it("ignores a path with no slug", async () => {
    const s = setup({ identity: () => null });
    s.runner.merged({ repoPath: "/zzz", slug: "acme/zzz" }, 5);
    await s.runner.idle();
    expect(s.db.prepare(`SELECT COUNT(*) AS n FROM lesson_queue`).get()).toEqual({ n: 0 });
  });

  it("registers the repo and enqueues with origin merged, even if history was never analyzed", () => {
    const s = setup({ identity: () => "acme/new" });
    s.hold();
    s.runner.merged({ repoPath: "/n", slug: "acme/new" }, 5);
    expect(s.repo.repo("acme/new")?.localPath).toBe("/n");
    expect(s.db.prepare(`SELECT repo_slug, pr_number, origin FROM lesson_queue`).all()).toEqual([{ repo_slug: "acme/new", pr_number: 5, origin: "merged" }]);
  });

  it("merged with no repoPath uses the slug's lessons repo, and skips unknown slugs", () => {
    const s = setup({ identity: () => { throw new Error("no path to resolve"); } });
    s.hold();
    s.runner.merged({ repoPath: null, slug: "acme/web" }, 7);
    s.runner.merged({ repoPath: null, slug: "acme/other" }, 8);
    expect(s.db.prepare(`SELECT repo_slug, pr_number, origin FROM lesson_queue`).all()).toEqual([{ repo_slug: "acme/web", pr_number: 7, origin: "merged" }]);
    expect(s.repo.repo("acme/web")?.localPath).toBe("/w");
    expect(s.repo.repo("acme/other")).toBeNull();
  });
});

describe("LessonRunner with model routing", () => {
  it("records the fallback and re-runs on the requested tier once it recovers (acceptance 1)", async () => {
    const s = setup();
    const routingRepo = new RoutingRepo(s.db);
    routingRepo.upsertModel({ name: "M", tier: "mid", enabled: true, account: "default", priceIn: null, priceOut: null, note: "" });
    routingRepo.upsertModel({ name: "L", tier: "low", enabled: true, account: "default", priceIn: null, priceOut: null, note: "" });
    const routing = new RoutingService({
      repo: routingRepo, usage: new UsageRepo(s.db), now: s.now, probe: async () => ({ ok: true }),
      settings: () => ({ quotas: "", thresholds: "70,90", periodStartDay: 1, effort: "", maxConcurrent: "", autoSwitch: false }),
      flags: () => ({ model: true, effort: false }), setTimer: () => 0, clearTimer: () => undefined,
    });
    s.deps.headless.routing = routing;
    s.deps.upgradeReady = () => routing.tierHealthy("mid");
    routing.onLimit("M", { kind: "rate_limit", resetsAt: null, message: "simulated" }, { task: null, accountLevel: false });
    s.run.mockImplementation(async () => newRule);
    s.repo.enqueue("acme/web", [1], "backfill", T0);
    s.runner.start();
    await s.runner.idle();
    expect(s.run.mock.calls[0]![0].args).toContain("L");
    expect(s.lastRun(1)).toMatchObject({ status: "done", requestedTier: "mid", actualModel: "L", fallbackFrom: "M" });
    expect(s.repo.upgradePendingCount()).toBe(1);
    const lessonsBefore = (s.db.prepare(`SELECT COUNT(*) AS c FROM lessons`).get() as { c: number }).c;
    expect(Number(lessonsBefore)).toBe(1);

    expect(s.runner.requeueUpgrades(true)).toBe(0); // M 还在限额里
    routing.health.clear("M");
    expect(s.runner.requeueUpgrades(true)).toBe(1);
    expect(Number((s.db.prepare(`SELECT COUNT(*) AS c FROM lessons`).get() as { c: number }).c)).toBe(0);
    s.runner.retry(s.queueId(1)); // 让它马上被取
    await s.runner.idle();
    expect(s.run.mock.calls.at(-1)![0].args).toContain("M");
    expect(s.lastRun(1)).toMatchObject({ status: "done", actualModel: "M", fallbackFrom: null });
    expect(s.repo.upgradePendingCount()).toBe(0);
    expect(Number((s.db.prepare(`SELECT COUNT(*) AS c FROM lessons`).get() as { c: number }).c)).toBe(1);
  });
});
