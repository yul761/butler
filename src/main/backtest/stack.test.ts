import { describe, expect, it, vi } from "vitest";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { ChecksService } from "../checks/checks-service";
import { LessonsRepo } from "../db/lessons-repo";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { JudgmentCache } from "../lessons/admission/judgments";
import { LessonBatchService } from "../lessons/lesson-batches";
import { memDb } from "../test-utils";
import type { CheckInput } from "../../shared/checks";
import { inProcessEvaluator } from "./evaluator";
import { createBacktestStack, NOTICE_DAYS, REVIEW_INTERVAL_MS } from "./stack";
import { defHash } from "./evaluate";
import { checkDef } from "./service";

const T0 = Date.UTC(2026, 10, 1);

function setup() {
  const db = memDb();
  const lessons = new LessonsRepo(db);
  lessons.upsertRepo("acme/web", "/w", 1);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  let now = T0;
  const checks = new ChecksService({ db, lessons, recorder, now: () => now, config: () => ({ enabled: true, editTimeoutSec: 8, pushTimeoutSec: 600, ticketPattern: "" }) });
  const batches = new LessonBatchService({ db, repo: lessons, recorder, now: () => now });
  let version = 1;
  const policies = new AdmissionPolicyService({ db, repo: lessons, recorder, now: () => now, version: { get: () => version, set: (v) => (version = v) } });
  const queue = { enqueue: vi.fn<(k: "backtest", p: unknown, o?: unknown) => number>(() => 1) };
  let lastReview: number | null = null;
  const onChanged = vi.fn();
  const stack = createBacktestStack({
    db, lessons, checks, batches, policies, queue, jobs: { get: () => null },
    gh: { mergedPrs: async () => [], prDiff: async () => null, anchors: async () => [], fileAt: async () => ({ status: "failed", content: null }) },
    evaluate: inProcessEvaluator, run: vi.fn(), judgments: new JudgmentCache(db), lang: () => "en", localPath: () => null, ticketPattern: () => "",
    lastReview: { get: () => lastReview, set: (at) => (lastReview = at) },
    onChanged, fallbackCwd: "/tmp", now: () => now,
  });
  const save = (over: Partial<CheckInput> = {}) => {
    const input: CheckInput = { type: "forbidden_pattern", name: "no foo", params: { pattern: "foo\\(" }, globs: [], excludeGlobs: [], severity: "block", mode: "shadow", enabled: true, message: "m", ...over };
    return (checks.save({ kind: "repo", slug: "acme/web" }, null, input) as { ok: true; id: number }).id;
  };
  return { db, checks, stack, queue, save, onChanged, setNow: (t: number) => (now = t) };
}

describe("backtest stack", () => {
  it("schedules the hourly review once, deduplicated", () => {
    const t = setup();
    t.stack.start();
    expect(t.queue.enqueue).toHaveBeenCalledWith("backtest", { op: "review" }, expect.objectContaining({ dedupeKey: "review" }));
  });

  it("keeps the review queued: a review that was cancelled or failed is queued again within the hour (workstream R, F3)", () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const stop = t.stack.keepReviewing();
      expect(t.queue.enqueue).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(REVIEW_INTERVAL_MS);
      expect(t.queue.enqueue).toHaveBeenCalledTimes(2);
      expect(t.queue.enqueue).toHaveBeenLastCalledWith("backtest", { op: "review" }, expect.objectContaining({ dedupeKey: "review" }));
      stop();
      vi.advanceTimersByTime(REVIEW_INTERVAL_MS * 3);
      expect(t.queue.enqueue).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms the review within the hour", async () => {
    const t = setup();
    const r = await t.stack.handler({ id: 1, kind: "backtest", payload: { op: "review" }, checkpoint: null, ticketKey: null, attempts: 1, signal: new AbortController().signal, save: () => {} } as never);
    expect(r).toMatchObject({ defer: true });
    const at = (r as { notBefore: number }).notBefore;
    expect(at).toBeGreaterThan(T0);
    expect(at).toBeLessThanOrEqual(T0 + REVIEW_INTERVAL_MS);
  });

  it("keeps re-arming when the review throws, and queues backtests for checks without a result", async () => {
    const t = setup();
    const id = t.save();
    const ctx = { id: 1, kind: "backtest", payload: { op: "review" }, checkpoint: null, ticketKey: null, attempts: 1, signal: new AbortController().signal, save: () => {} } as never;
    vi.spyOn(t.stack.lifecycle, "tick").mockRejectedValueOnce(new Error("boom"));
    expect(await t.stack.handler(ctx)).toMatchObject({ defer: true });
    expect(t.queue.enqueue).toHaveBeenCalledWith("backtest", { op: "check", checkId: id }, expect.objectContaining({ dedupeKey: `check:${id}` }));
  });

  it("counts only results from repos in the check's scope", () => {
    const t = setup();
    const id = t.save();
    const row = t.checks.repo.get(id)!;
    const hash = defHash(checkDef(row));
    const put = (slug: string, status: "done" | "skipped", reason: string | null) =>
      t.db.prepare(`INSERT INTO check_backtests (def_hash, repo_slug, status, skip_reason, prs, hits, comments, comments_matched, recall, fp_rate, created_at) VALUES (?, ?, ?, ?, 10, 1, 1, 1, 1, 0, 1)`).run(hash, slug, status, reason);
    put("acme/web", "done", null);
    put("other/repo", "skipped", "no_gh");
    expect(t.stack.service.summaryOf(row)).toMatchObject({ tested: true, skipped: [] });
  });

  it("reruns a backtest for a known check and refuses an unknown one", () => {
    const t = setup();
    const id = t.save();
    expect(t.stack.act({ op: "rerun", checkId: 999 })).toEqual({ ok: false, error: "not_found" });
    expect(t.stack.act({ op: "rerun", checkId: id })).toEqual({ ok: true });
    expect(t.queue.enqueue).toHaveBeenCalledWith("backtest", expect.objectContaining({ op: "check", checkId: id }), expect.anything());
  });

  it("shows automatic promotions as notices that undo puts back and dismiss hides", () => {
    const t = setup();
    const id = t.save();
    const r = t.checks.bulk([id], "enforce", { origin: "auto", kind: "check_promote", summary: { checks: [id], reasons: [{ id }] } });
    const batchId = (r as { batchId: number }).batchId;
    t.stack.repo.addEvent("promote", batchId, [{ id, name: "no foo", reason: null }], T0);
    expect(t.stack.notices()).toEqual([{ kind: "check_promoted", eventId: expect.any(Number), batchId, names: ["no foo"], at: T0 }]);

    expect(t.stack.act({ op: "undo", batchId })).toMatchObject({ ok: true });
    expect(t.checks.repo.get(id)!.mode).toBe("shadow");
    expect(t.stack.notices()).toEqual([]);
    expect(t.stack.view().calibration).toMatchObject({ promotions: 1, promotionsUndone: 1 });

    const eventId = t.stack.repo.addEvent("flag", null, [{ id, name: "no foo", reason: "bypassed" }], T0);
    expect(t.stack.notices()).toEqual([{ kind: "check_demoted", eventId, batchId: null, names: ["no foo"], reason: "bypassed", flagged: true, at: T0 }]);
    expect(t.stack.act({ op: "dismissNotice", eventId })).toEqual({ ok: true });
    expect(t.stack.notices()).toEqual([]);
    expect(t.stack.act({ op: "dismissNotice", eventId })).toEqual({ ok: false, error: "not_found" });
  });

  it("drops notices older than two weeks", () => {
    const t = setup();
    const id = t.save();
    t.stack.repo.addEvent("flag", null, [{ id, name: "no foo", reason: "bypassed" }], T0);
    t.setNow(T0 + (NOTICE_DAYS + 1) * 86_400_000);
    expect(t.stack.notices()).toEqual([]);
  });

  it("lists each check with its backtest part in the view", () => {
    const t = setup();
    const id = t.save();
    const v = t.stack.view();
    expect(v.checks.map((c) => c.checkId)).toContain(id);
    expect(v.running).toEqual([]);
    expect(v.reviews).toEqual([]);
  });
});
