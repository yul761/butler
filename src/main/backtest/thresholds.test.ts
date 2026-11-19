import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { BacktestRepo } from "../db/backtest-repo";
import { ADMISSION_POLICY_DEFAULTS, type AdmissionPolicy, type AdmissionPolicyOverrides } from "../../shared/admission-policy";
import { ThresholdReview, suggestThreshold, type ThresholdSample } from "./thresholds";

const DAY = 86_400_000;
const s = (value: number, wantPass: boolean): ThresholdSample => ({ value, wantPass });

describe("suggestThreshold", () => {
  it("moves a min threshold toward the line people drew, at most 0.05", () => {
    // 采纳率 0.62 / 0.64 的被撤销了，0.8 以上的留着：门槛该往上。
    const xs = [s(0.62, false), s(0.64, false), s(0.66, false), s(0.8, true), s(0.85, true), s(0.9, true)];
    expect(suggestThreshold(xs, 0.6, "min")).toEqual({ suggested: 0.65, agreeNow: 0.5, agreeSuggested: expect.closeTo(0.833, 2) });
  });

  it("moves a max threshold down when noisy ones were overturned", () => {
    const xs = [s(0.18, false), s(0.19, false), s(0.05, true), s(0.1, true)];
    expect(suggestThreshold(xs, 0.2, "max")?.suggested).toBe(0.17);
  });

  it("returns null when nothing beats the current value", () => {
    expect(suggestThreshold([s(0.8, true), s(0.3, false)], 0.6, "min")).toBeNull();
    expect(suggestThreshold([], 0.6, "min")).toBeNull();
  });

  it("stays inside the key's bounds", () => {
    expect(suggestThreshold([s(0.99, false), s(0.995, false)], 0.98, "min", { lo: 0, hi: 1 })?.suggested).toBe(1);
  });
});

function setup(policy: Partial<AdmissionPolicy> = {}) {
  const db = memDb();
  const repo = new BacktestRepo(db);
  let now = 100 * DAY;
  let lastRun: number | null = null;
  const global: { o: AdmissionPolicyOverrides } = { o: {} };
  const p = { ...ADMISSION_POLICY_DEFAULTS, "review.minSamples": 4, ...policy } as AdmissionPolicy;
  let batch = 0;
  const review = new ThresholdReview({
    db, repo, policy: () => ({ ...p, ...global.o }) as AdmissionPolicy, now: () => now, lastRun: () => lastRun, setLastRun: (at) => (lastRun = at),
    policies: {
      overrides: () => global.o,
      setLayer: (_ref, raw) => {
        global.o = raw as AdmissionPolicyOverrides;
        const id = Number(db.prepare(`INSERT INTO admission_batches (created_at, kind, origin, entity, scope, summary) VALUES (?, 'policy_threshold', 'manual', 'policy', '{}', '{}')`).run(now).lastInsertRowid);
        return { batchId: id, version: ++batch };
      },
    },
  });
  const insBatch = db.prepare(`INSERT INTO admission_batches (created_at, kind, origin, entity, scope, summary) VALUES (?, ?, 'auto', 'check', '{}', ?)`);
  const cal = db.prepare(
    `INSERT INTO score_calibration (entity, lesson_id, entity_id, auto_verdict, human_verdict, score, score_parts, batch_id, at, source) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'override')`,
  );
  /** 一批自动升级：reasons 里每条 [checkId, adoption, fpRate]；overturned 里的 id 被人推翻了。 */
  const promotion = (at: number, reasons: [number, number, number][], overturned: number[]) => {
    const id = Number(insBatch.run(at, "check_promote", JSON.stringify({ reasons: reasons.map(([i, adoption, fpRate]) => ({ id: i, adoption, fpRate })) })).lastInsertRowid);
    for (const c of overturned) cal.run("check", c, "promote", "shadow", 0.8, "{}", id, at + 1000);
    return id;
  };
  const demotion = (at: number, reasons: [number, number][], overturned: number[]) => {
    const id = Number(insBatch.run(at, "check_demote", JSON.stringify({ reasons: reasons.map(([i, rate]) => ({ id: i, kind: "bypassed", rate })) })).lastInsertRowid);
    for (const c of overturned) cal.run("check", c, "demote", "enforce", 0.8, "{}", id, at + 1000);
    return id;
  };
  return { db, repo, review, promotion, demotion, global, advance: (ms: number) => (now += ms), now: () => now, setLastRun: (v: number | null) => (lastRun = v) };
}

describe("ThresholdReview", () => {
  it("suggests shadow.minAdoption from undone and kept promotions, applies it to the global layer, and can dismiss", () => {
    const t = setup();
    t.promotion(50 * DAY, [[1, 0.62, 0], [2, 0.63, 0], [3, 0.64, 0], [4, 0.9, 0], [5, 0.95, 0]], [1, 2, 3]);
    const r = t.review.run();
    expect(r.ran).toBe(true);
    const open = t.repo.reviews().filter((x) => x.status === "open");
    const adoption = open.find((x) => x.key === "shadow.minAdoption");
    expect(adoption).toMatchObject({ current: 0.6, suggested: 0.65, basis: { samples: 5 } });
    expect(t.review.apply(adoption!.id)).toMatchObject({ ok: true, batchId: expect.any(Number) });
    expect(t.global.o["shadow.minAdoption"]).toBe(0.65);
    expect(t.repo.review(adoption!.id)?.status).toBe("applied");
    expect(t.review.apply(adoption!.id).ok).toBe(false);
    const other = open.find((x) => x.key !== "shadow.minAdoption");
    if (other) expect(t.review.dismiss(other.id)).toBe(true);
  });

  it("counts promotions as kept only after the override window", () => {
    const t = setup();
    // 都很新：留着的还不算数，只有被推翻的 —— 不够 minSamples 的新样本也不跑。
    t.promotion(t.now() - DAY, [[1, 0.62, 0], [2, 0.9, 0]], [1]);
    expect(t.review.run()).toMatchObject({ ran: false, reason: "samples" });
  });

  it("suggests demote.maxBypassRate from undone demotions", () => {
    const t = setup();
    t.demotion(50 * DAY, [[1, 0.31, ], [2, 0.32], [3, 0.33], [4, 0.6], [5, 0.7]].map(([a, b]) => [a, b] as [number, number]), [1, 2, 3]);
    t.review.run();
    expect(t.repo.reviews().find((x) => x.key === "demote.maxBypassRate")).toMatchObject({ current: 0.3, suggested: 0.34 });
  });

  it("suggests score.admitLine from lesson verdicts", () => {
    const t = setup();
    const ins = t.db.prepare(`INSERT INTO score_calibration (entity, auto_verdict, human_verdict, score, at, source) VALUES ('lesson', 'admit', ?, ?, ?, 'review')`);
    for (const [v, sc] of [["reject", 0.71], ["reject", 0.72], ["reject", 0.73], ["admit", 0.8], ["admit", 0.9]] as const) ins.run(v, sc, 60 * DAY);
    t.review.run();
    expect(t.repo.reviews().find((x) => x.key === "score.admitLine")).toMatchObject({ current: 0.7, suggested: 0.74 });
  });

  it("runs every review.intervalDays and only with review.minSamples new samples", () => {
    const t = setup({ "review.intervalDays": 7 });
    t.promotion(50 * DAY, [[1, 0.62, 0], [2, 0.63, 0], [3, 0.64, 0], [4, 0.9, 0], [5, 0.95, 0]], [1, 2, 3]);
    expect(t.review.run().ran).toBe(true);
    t.advance(DAY);
    expect(t.review.run()).toMatchObject({ ran: false, reason: "interval" });
    t.advance(7 * DAY);
    expect(t.review.run()).toMatchObject({ ran: false, reason: "samples" });
  });
});

describe("ThresholdReview from lesson backtests and manual promotions", () => {
  it("suggests backtest.maxFalsePositiveRate from lessons people admitted or rejected", () => {
    const t = setup();
    t.db.prepare(`INSERT INTO lesson_repos (slug, local_path, created_at) VALUES ('acme/web', '/w', 1)`).run();
    const cases: [number, string][] = [[0.05, "admit"], [0.1, "admit"], [0.15, "admit"], [0.18, "reject"], [0.19, "reject"]];
    cases.forEach(([fp, verdict], i) => {
      const lesson = Number(t.db.prepare(`INSERT INTO lessons (repo_slug, text, why, status, last_seen_at, created_at, updated_at) VALUES ('acme/web', ?, 'w', 'pending', 1, 1, 1)`).run(`l${i}`).lastInsertRowid);
      t.db.prepare(`INSERT INTO check_backtests (def_hash, sources_hash, material_key, lesson_id, repo_slug, status, fp_rate, samples, created_at) VALUES (?, '', '', ?, 'acme/web', 'done', ?, '{}', 1)`).run(`d${i}`, lesson, fp);
      t.db.prepare(`INSERT INTO score_calibration (entity, lesson_id, auto_verdict, human_verdict, at, source) VALUES ('lesson', ?, 'reject', ?, ?, 'override')`).run(lesson, verdict, 60 * DAY);
    });
    t.review.run();
    expect(t.repo.reviews().find((x) => x.key === "backtest.maxFalsePositiveRate")).toMatchObject({ current: 0.2, suggested: 0.17, basis: { samples: 5, note: "backtests" } });
  });

  it("loosens shadow.minAdoption when people promote checks the rule held back", () => {
    const t = setup();
    const ins = t.db.prepare(`INSERT INTO score_calibration (entity, entity_id, auto_verdict, human_verdict, score_parts, at, source) VALUES ('check', ?, 'hold', 'enforce', ?, ?, 'override')`);
    for (const [i, a] of [[1, 0.56], [2, 0.57], [3, 0.58], [4, 0.9]]) ins.run(i, JSON.stringify({ adoption: a }), 60 * DAY);
    t.review.run();
    expect(t.repo.reviews().find((x) => x.key === "shadow.minAdoption")).toMatchObject({ current: 0.6, suggested: 0.56 });
  });
});
