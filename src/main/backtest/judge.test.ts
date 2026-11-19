import { describe, expect, it, vi } from "vitest";
import { memDb } from "../test-utils";
import { JudgmentCache } from "../lessons/admission/judgments";
import { cachedJudgments, estimateFalsePositives, judgeHits, seededSample, type JudgeHit } from "./judge";

const ok = (value: unknown) => ({ ok: true as const, value, route: { actualModel: "m", degraded: false, sameModelReview: false } });
const hit = (n: number): JudgeHit => ({ key: `k${n}`, path: "a.ts", line: n, text: `t${n}`, context: `c${n}` });

describe("judgeHits", () => {
  it("routes through backtest_judge, caches each verdict and reuses it", async () => {
    const db = memDb();
    const judgments = new JudgmentCache(db);
    const run = vi.fn(async (req: { task: string; prompt: string }) => {
      expect(req.task).toBe("backtest_judge");
      return ok({ items: [{ id: 1, verdict: "false_positive", reason: "r" }, { id: 2, verdict: "violation", reason: "r" }] }) as never;
    });
    const d = { run, judgments, lang: () => "en" as const, cwd: "/", now: () => 1 };
    const r = await judgeHits(d, "backtest_fp", { text: "no logs", message: "m" }, [hit(1), hit(2)]);
    expect(r).toMatchObject({ judged: 2, falsePositives: 1, incomplete: false });
    const again = await judgeHits(d, "backtest_fp", { text: "no logs", message: "m" }, [hit(1), hit(2)]);
    expect(again.falsePositives).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    // 规矩的文字变了：缓存不算数。
    await judgeHits(d, "backtest_fp", { text: "no console", message: "m" }, [hit(1)]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a failed call leaves the hits unjudged and says so", async () => {
    const db = memDb();
    const run = vi.fn(async () => ({ ok: false, reason: "rate_limited", message: "x", limit: null, waitUntil: 99 }) as never);
    const r = await judgeHits({ run, judgments: new JudgmentCache(db), lang: () => "zh", cwd: "/", now: () => 1 }, "shadow_fp", { text: "r", message: "m" }, [hit(1)]);
    expect(r).toMatchObject({ judged: 0, falsePositives: 0, incomplete: true, waitUntil: 99 });
  });
});

describe("cachedJudgments", () => {
  it("reads only what judgeHits cached and never calls the model (workstream R, F1)", async () => {
    const db = memDb();
    const judgments = new JudgmentCache(db);
    const rule = { text: "no logs", message: "m" };
    expect(cachedJudgments(judgments, "shadow_fp", rule, [hit(1), hit(2)])).toMatchObject({ judged: 0, falsePositives: 0, incomplete: true });
    const run = vi.fn(async () => ok({ items: [{ id: 1, verdict: "false_positive", reason: "r" }] }) as never);
    await judgeHits({ run, judgments, lang: () => "en", cwd: "/", now: () => 1 }, "shadow_fp", rule, [hit(1)]);
    expect(cachedJudgments(judgments, "shadow_fp", rule, [hit(1), hit(2)])).toMatchObject({ judged: 1, falsePositives: 1, incomplete: true });
    expect(cachedJudgments(judgments, "shadow_fp", rule, [hit(1)])).toMatchObject({ judged: 1, falsePositives: 1, incomplete: false });
    // 规矩的文字变了：缓存不算数。
    expect(cachedJudgments(judgments, "shadow_fp", { text: "no console", message: "m" }, [hit(1)]).judged).toBe(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("estimateFalsePositives", () => {
  it("extrapolates the judged share and counts everything when nothing was judged", () => {
    expect(estimateFalsePositives(10, 4, 1)).toBe(2.5);
    expect(estimateFalsePositives(10, 0, 0)).toBe(10);
    expect(estimateFalsePositives(0, 0, 0)).toBe(0);
  });
});

describe("seededSample", () => {
  it("is stable for a seed and takes at most n", () => {
    const xs = Array.from({ length: 50 }, (_, i) => i);
    expect(seededSample(xs, 5, "a")).toEqual(seededSample(xs, 5, "a"));
    expect(seededSample(xs, 5, "a")).not.toEqual(seededSample(xs, 5, "b"));
    expect(seededSample(xs, 0, "a")).toEqual([]);
    expect(new Set(seededSample(xs, 50, "a")).size).toBe(50);
  });
});
