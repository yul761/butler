import { describe, expect, it } from "vitest";
import { ADMISSION_POLICY_DEFAULTS } from "../../../shared/admission-policy";
import { assessMetrics, BatchReviews, seededSample, shelvedShares } from "./batch-review";
import { fakeRunner, setupAdmission } from "./__fixtures__/setup";
import { OPEN_GATE, type StepCtx, type StepLesson } from "./model-steps";
import type { LessonVerdict } from "./pipeline";

const v = (lessonId: number, verdict: LessonVerdict["verdict"], reason: string | null = null): LessonVerdict => ({ lessonId, verdict, reason, ref: null, note: null, score: null, check: false, promoteTo: null });
const step = (id: number): StepLesson => ({ id, text: `rule ${id}`, why: "", globs: [], scopeLabel: "acme/web", degraded: false, excerpts: ["c"] });

describe("batch review", () => {
  it("draws the same sample for the same seed", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    expect(seededSample(xs, 10, 7)).toEqual(seededSample(xs, 10, 7));
    expect(seededSample(xs, 10, 7)).not.toEqual(seededSample(xs, 10, 8));
    expect(new Set(seededSample(xs, 10, 7)).size).toBe(10);
    expect(seededSample(xs.slice(0, 3), 10, 1)).toHaveLength(3);
  });

  it("shelved shares count judged candidates only", () => {
    const s = shelvedShares([v(1, "admit"), v(2, "shelved", "conflict"), v(3, "shelved", "generality"), v(4, "covered", "covered"), v(5, "merged", "duplicate"), v(6, "unfinished")]);
    expect(s).toEqual({ judged: 4, shelved: 2, share: 0.5, byReason: { conflict: 0.25, generality: 0.25 } });
  });

  it("names the metric furthest past its floor", () => {
    const m = assessMetrics({ passRate: 0.5, shelvedShare: 0.75, coverage: null, backtestRecall: null, backtestFalsePositiveRate: null }, ADMISSION_POLICY_DEFAULTS);
    expect(m.map((x) => [x.key, x.past])).toEqual([["samplePassRate", true], ["shelvedShare", true]]);
    expect(m[0].distance).toBeCloseTo(0.375);
    expect(m[1].distance).toBeCloseTo(0.05 / 0.7);
  });

  it("reviews with the producer, stores a row and blocks accept below the floor", async () => {
    const s = setupAdmission();
    const fake = fakeRunner({
      lesson_sample_review: (req) => ({ reviews: [...req.prompt.matchAll(/^#(\d+) /gm)].map((m) => ({ id: Number(m[1]), reasonable: true, follows: Number(m[1]) % 2 === 0, scope_ok: true, note: "n" })) }),
    });
    const ctx: StepCtx = { run: fake.run, judgments: s.judgments, lang: () => "en", now: () => s.clock.now, cwd: "/", gate: OPEN_GATE };
    const reviews = new BatchReviews({ db: s.db, now: () => s.clock.now });
    const bid = Number(s.db.prepare(`INSERT INTO admission_batches (created_at, kind, origin, entity, scope, summary) VALUES (1, 'admission_plan', 'auto', 'lesson', '{}', '{}')`).run().lastInsertRowid);
    const admitted = [1, 2, 3, 4].map(step);
    const id = await reviews.review({ batchId: bid, ctx, admitted, producer: { model: "fake-mid", tier: "mid" }, verdicts: [1, 2, 3, 4].map((i) => v(i, "admit")), policy: ADMISSION_POLICY_DEFAULTS, seed: 3 });
    expect(fake.of("lesson_sample_review")[0].producer).toEqual({ model: "fake-mid", tier: "mid" });
    const view = reviews.get(id, ADMISSION_POLICY_DEFAULTS)!;
    expect(view).toMatchObject({ sampleSize: 4, reviewed: 4, passRate: 0.5, blocked: true, weakest: "samplePassRate", coverage: null });
    expect(view.verdicts.filter((x) => x.pass).map((x) => x.lessonId).sort()).toEqual([2, 4]);
    expect(reviews.get(id, { ...ADMISSION_POLICY_DEFAULTS, "batch.minSamplePassRate": 0.5 })!.blocked).toBe(false);
  });
});
