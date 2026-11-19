import { describe, expect, it, vi } from "vitest";
import { BacktestRepo } from "../db/backtest-repo";
import { LessonsRepo } from "../db/lessons-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { LessonBatchService } from "../lessons/lesson-batches";
import { ChecksService } from "../checks/checks-service";
import { memDb } from "../test-utils";
import { ADMISSION_POLICY_DEFAULTS, type AdmissionPolicy } from "../../shared/admission-policy";
import type { BacktestSummary } from "../../shared/backtest";
import type { CheckInput, CheckLogRecord, CheckRow } from "../../shared/checks";
import type { LessonCommentTrend } from "../review-effect/stats";
import { Lifecycle, bypassRate, demotionOf, windowStats, type WindowHit } from "./lifecycle";
import type { JudgeResult } from "./judge";

const DAY = 86_400_000;
const T0 = 1_000_000;
type Hit = Extract<CheckLogRecord, { kind: "hit" }>;

const tested: BacktestSummary = {
  tested: true, skipped: [], prs: 20, hits: 5, falsePositives: 0, fpRate: 0, comments: 5, commentsMatched: 3, recall: 0.6, legacy: null, samples: [], at: T0,
};

function setup(o: { policy?: Partial<AdmissionPolicy>; backtest?: BacktestSummary | null; judge?: (n: number) => JudgeResult; trend?: LessonCommentTrend | null } = {}) {
  const db = memDb();
  const lessons = new LessonsRepo(db);
  lessons.upsertRepo("acme/web", "/w", 1);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  let now = T0;
  const checks = new ChecksService({ db, lessons, recorder, now: () => now, config: () => ({ enabled: true, editTimeoutSec: 8, pushTimeoutSec: 600, ticketPattern: "" }) });
  const batches = new LessonBatchService({ db, repo: lessons, recorder, now: () => now });
  const repo = new BacktestRepo(db);
  const policy = { ...ADMISSION_POLICY_DEFAULTS, "shadow.autoPromote": true, "backtest.judgeSample": 0, ...o.policy } as AdmissionPolicy;
  const events: string[] = [];
  const judge = o.judge ? vi.fn(async (_r: unknown, hits: unknown[]) => o.judge!(hits.length)) : undefined;
  const life = new Lifecycle({
    db, repo, checks, policy: () => policy, backtestOf: () => (o.backtest === undefined ? tested : o.backtest), lessonParts: () => null, lessonText: () => "rule",
    trend: () => o.trend ?? null, judge, record: (k) => events.push(k), now: () => now,
  });
  const save = (over: Partial<CheckInput> = {}): CheckRow => {
    const input: CheckInput = { type: "forbidden_pattern", name: "no foo", params: { pattern: "foo\\(" }, globs: [], excludeGlobs: [], severity: "block", mode: "shadow", enabled: true, message: "m", ...over };
    const r = checks.save({ kind: "repo", slug: "acme/web" }, null, input) as { ok: true; id: number };
    return checks.repo.get(r.id)!;
  };
  let seq = 0;
  /** n 次失败（各在不同 session），其中 resolved 条后来改掉了。 */
  const hits = (row: CheckRow, n: number, resolved: number, over: Partial<Hit> = {}) => {
    const rows: { key: string; rec: Hit }[] = [];
    for (let i = 0; i < n; i++) {
      const base: Hit = {
        kind: "hit", checkId: row.id, checkKey: row.key, slug: "acme/web", file: `src/f${seq}.ts`, line: 1, stage: "edit", mode: row.mode, severity: row.severity,
        outcome: "fail", blocked: row.mode === "enforce", detail: "foo(1)", session: `s${seq}`, at: now + i, ...over,
      };
      rows.push({ key: `h${seq++}`, rec: base });
      if (i < resolved) rows.push({ key: `h${seq++}`, rec: { ...base, outcome: "resolved", blocked: false, at: base.at + 1 } });
    }
    checks.repo.insertHits(rows);
  };
  return {
    db, checks, batches, repo, life, save, hits, events, judge,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

describe("windowStats", () => {
  const h = (over: Partial<WindowHit>): WindowHit => ({ id: 1, file: "a", line: 1, outcome: "fail", blocked: true, verdict: null, detail: "", session: "s", at: 0, ...over });
  it("counts ignored blocks only after a day without a fix in the same session and file", () => {
    const hits = [h({ at: 0 }), h({ id: 2, file: "b", at: 0 }), h({ id: 3, outcome: "resolved", blocked: false, at: 5 }), h({ id: 4, file: "c", at: 0, blocked: false })];
    expect(windowStats(hits, 10, { prs: 1, bypasses: 0, bypassHow: {} }).ignored).toBe(0);
    const s = windowStats(hits, DAY + 1, { prs: 1, bypasses: 0, bypassHow: {} });
    expect(s).toMatchObject({ fails: 3, resolved: 1, blocked: 2, ignored: 1 });
    expect(bypassRate({ ...s, bypasses: 1 })).toBe(1);
  });
});

describe("promotion (gate 6)", () => {
  it("promotes an eligible shadow check in one auto batch, with a notice and a metric", async () => {
    const t = setup();
    const row = t.save();
    t.hits(row, 6, 5);
    const r = await t.life.tick();
    expect(r.promoted).toEqual([row.id]);
    expect(t.checks.repo.get(row.id)?.mode).toBe("enforce");
    const b = t.db.prepare(`SELECT kind, origin FROM admission_batches WHERE id = ?`).get(r.promoteBatch) as { kind: string; origin: string };
    expect(b).toEqual({ kind: "check_promote", origin: "auto" });
    expect(t.repo.lifecycle(row.id)).toMatchObject({ lastAction: "promote", lastBatchId: r.promoteBatch, needsReview: false });
    expect(t.repo.openEvents(0)).toMatchObject([{ kind: "promote", batchId: r.promoteBatch, checks: [{ id: row.id, name: "no foo" }] }]);
    expect(t.events).toEqual(["check.promote"]);
    expect(t.repo.score(row.id)?.score).toBeGreaterThan(0);
  });

  it("can be undone, and an undone promotion is not repeated", async () => {
    const t = setup();
    const row = t.save();
    t.hits(row, 6, 5);
    const r = await t.life.tick();
    t.advance(1000);
    expect(t.batches.undo(r.promoteBatch!).ok).toBe(true);
    expect(t.checks.repo.get(row.id)?.mode).toBe("shadow");
    t.advance(30 * DAY);
    t.hits(t.checks.repo.get(row.id)!, 6, 6);
    const again = await t.life.tick();
    expect(again.promoted).toEqual([]);
    expect(t.life.assess(t.checks.repo.get(row.id)!).progress?.blockers).toContain("needs_review");
  });

  const blockedBy = async (o: Parameters<typeof setup>[0], over: Partial<CheckInput>, hits: [number, number], blocker: string) => {
    const t = setup(o);
    const row = t.save(over);
    t.hits(row, ...hits);
    expect((await t.life.tick()).promoted).toEqual([]);
    expect(t.life.assess(t.checks.repo.get(row.id)!).progress?.blockers).toContain(blocker);
  };

  it("holds back for each unmet condition and switch", async () => {
    await blockedBy({ policy: { "shadow.autoPromote": false } }, {}, [6, 5], "auto_off");
    await blockedBy({ backtest: { ...tested, tested: false, skipped: [{ slug: "acme/web", reason: "no_gh" }] } }, {}, [6, 5], "untested");
    await blockedBy({ backtest: { ...tested, skipped: [{ slug: "acme/api", reason: "no_material" }] } }, {}, [6, 5], "untested");
    await blockedBy({ backtest: null }, {}, [6, 5], "no_backtest");
    await blockedBy({}, { severity: "warn" }, [6, 5], "warn");
    await blockedBy({ policy: { "shadow.minHits": 10, "shadow.minPrs": 1 } }, {}, [6, 5], "hits");
    await blockedBy({ policy: { "shadow.minAdoption": 0.9 } }, {}, [6, 5], "adoption");
    await blockedBy({ policy: { "shadow.minPrs": 10 } }, {}, [6, 5], "time");
  });

  it("never promotes an untested check even with perfect shadow data", async () => {
    const t = setup({ backtest: { ...tested, tested: false, skipped: [{ slug: "acme/web", reason: "not_cloned" }] } });
    const row = t.save();
    t.hits(row, 30, 30);
    t.advance(60 * DAY);
    expect((await t.life.tick()).promoted).toEqual([]);
  });

  it("accepts either enough PRs or enough days", async () => {
    const t = setup({ policy: { "shadow.minPrs": 10, "shadow.minDays": 7 } });
    const row = t.save();
    t.hits(row, 6, 5);
    expect((await t.life.tick()).promoted).toEqual([]);
    t.advance(8 * DAY);
    expect((await t.life.tick()).promoted).toEqual([row.id]);
  });

  it("uses human verdicts for the false-positive rate", async () => {
    const t = setup({ policy: { "shadow.maxFalsePositiveRate": 0.2 } });
    const row = t.save();
    t.hits(row, 6, 5);
    const ids = (t.db.prepare(`SELECT id FROM check_hits WHERE outcome = 'fail' ORDER BY id LIMIT 2`).all() as { id: number }[]).map((x) => x.id);
    for (const id of ids) t.checks.setVerdict(id, "false_positive");
    expect((await t.life.tick()).promoted).toEqual([]);
    expect(t.life.assess(row).fpRate).toBeCloseTo(2 / 6);
  });

  it("asks the judge about unjudged shadow fails only when everything else passes", async () => {
    const clean: JudgeResult = { judged: 3, falsePositives: 0, verdicts: new Map(), incomplete: false, waitUntil: null };
    const t = setup({ policy: { "backtest.judgeSample": 3 }, judge: () => clean });
    const row = t.save();
    t.hits(row, 6, 5);
    expect((await t.life.tick()).promoted).toEqual([row.id]);
    expect(t.judge).toHaveBeenCalledTimes(1);
    expect((t.judge!.mock.calls[0] as unknown[])[1]).toHaveLength(3);

    const noisy = setup({ policy: { "backtest.judgeSample": 3 }, judge: () => ({ ...clean, falsePositives: 2 }) });
    const r2 = noisy.save();
    noisy.hits(r2, 6, 5);
    expect((await noisy.life.tick()).promoted).toEqual([]);

    const limited = setup({ policy: { "backtest.judgeSample": 3 }, judge: () => ({ ...clean, judged: 0, incomplete: true, waitUntil: T0 + 5000 }) });
    const r3 = limited.save();
    limited.hits(r3, 6, 5);
    const res = await limited.life.tick();
    expect(res.promoted).toEqual([]);
    expect(res.waitUntil).toBe(T0 + 5000);

    const early = setup({ policy: { "backtest.judgeSample": 3, "shadow.minHits": 50 }, judge: () => clean });
    early.hits(early.save(), 6, 5);
    await early.life.tick();
    expect(early.judge).not.toHaveBeenCalled();
  });
});

describe("demotion (gate 7)", () => {
  const promoted = async (o: Parameters<typeof setup>[0] = {}) => {
    const t = setup(o);
    const row = t.save();
    t.hits(row, 6, 5);
    await t.life.tick();
    t.advance(1000);
    return { t, row: t.checks.repo.get(row.id)! };
  };
  const bypass = (t: ReturnType<typeof setup>, row: CheckRow, n: number, how: "no_verify" | "suppress" = "no_verify") =>
    t.repo.insertBypassLogs(
      Array.from({ length: n }, (_, i) => ({ key: `b${row.id}:${i}:${how}`, rec: { kind: "bypass" as const, checkId: row.id, checkKey: row.key, slug: "acme/web", file: "", line: null, how, detail: "", session: "s", at: t.now() + i } })),
    );

  it("demotes an auto-promoted check that is bypassed too often, with the reason", async () => {
    const { t, row } = await promoted();
    t.hits(row, 6, 6);
    bypass(t, row, 2);
    bypass(t, row, 1, "suppress");
    const r = await t.life.tick();
    expect(r.demoted).toEqual([row.id]);
    expect(t.checks.repo.get(row.id)?.mode).toBe("shadow");
    expect(t.repo.lifecycle(row.id)).toMatchObject({ reason: "bypassed", lastAction: "demote", needsReview: false, data: { kind: "bypassed", bypasses: 3, blocked: 6, rate: 0.5, how: { no_verify: 2, suppress: 1 } } });
    const b = t.db.prepare(`SELECT kind, origin FROM admission_batches WHERE id = ?`).get(r.demoteBatch) as { kind: string; origin: string };
    expect(b).toEqual({ kind: "check_demote", origin: "auto" });
    expect(t.events).toContain("check.demote");
    // 降回影子以后不会马上又被升回去。
    t.advance(30 * DAY);
    t.hits(t.checks.repo.get(row.id)!, 6, 6);
    expect((await t.life.tick()).promoted).toEqual([]);
  });

  it("only flags a check a person set to enforce, or when demote.to is review", async () => {
    const t = setup();
    const row = t.save({ mode: "enforce" });
    t.hits(row, 6, 6);
    bypass(t, row, 3);
    const r = await t.life.tick();
    expect(r).toMatchObject({ demoted: [], flagged: [row.id] });
    expect(t.checks.repo.get(row.id)?.mode).toBe("enforce");
    expect(t.repo.lifecycle(row.id)).toMatchObject({ needsReview: true, reason: "bypassed", lastAction: "flag" });
    expect((await t.life.tick()).flagged).toEqual([]);
    expect(t.life.clearReview(row.id)).toBe(true);
    expect(t.repo.lifecycle(row.id)?.needsReview).toBe(false);

    const { t: t2, row: r2 } = await promoted({ policy: { "demote.to": "review" } });
    t2.hits(r2, 6, 6);
    bypass(t2, r2, 3);
    expect(await t2.life.tick()).toMatchObject({ demoted: [], flagged: [r2.id] });
  });

  it("respects demote.enabled, demote.minEvents and demote.maxBypassRate", async () => {
    for (const policy of [{ "demote.enabled": false }, { "demote.minEvents": 50 }, { "demote.maxBypassRate": 0.9 }]) {
      const { t, row } = await promoted({ policy });
      t.hits(row, 6, 6);
      bypass(t, row, 3);
      expect(await t.life.tick()).toMatchObject({ demoted: [], flagged: [] });
    }
  });

  it("flags or demotes when similar comments did not drop", () => {
    const P = { ...ADMISSION_POLICY_DEFAULTS, "demote.noReductionPrs": 10 } as AdmissionPolicy;
    const row = { enabled: true, mode: "enforce", severity: "block" } as CheckRow;
    const s = { fails: 0, resolved: 0, blocked: 0, falsePositives: 0, truePositives: 0, ignored: 0, prs: 0, bypasses: 0, bypassHow: {} };
    const side = (prs: number, perPr: number) => ({ prs, comments: prs * perPr, perPr, byWho: { human: 0, copilot: 0 } });
    expect(demotionOf(row, s, { lessonId: 1, before: side(10, 0.8), after: side(12, 0.9) }, P)).toEqual({
      reason: "no_reduction", data: { kind: "no_reduction", beforePerPr: 0.8, afterPerPr: 0.9, afterPrs: 12 },
    });
    expect(demotionOf(row, s, { lessonId: 1, before: side(10, 0.8), after: side(12, 0.5) }, P)).toBeNull();
    expect(demotionOf(row, s, { lessonId: 1, before: side(10, 0.8), after: side(5, 0.9) }, P)).toBeNull();
    expect(demotionOf(row, s, { lessonId: 1, before: side(0, 0), after: side(12, 0.9) }, P)).toBeNull();
    expect(demotionOf({ ...row, mode: "shadow" }, s, { lessonId: 1, before: side(10, 0.8), after: side(12, 0.9) }, P)).toBeNull();
  });
});

describe("calibration samples (8.1)", () => {
  const samples = (t: ReturnType<typeof setup>) =>
    t.db.prepare(`SELECT entity, entity_id, auto_verdict, human_verdict, batch_id, source, score FROM score_calibration WHERE entity = 'check' ORDER BY entity_id, id`).all() as
      { entity: string; entity_id: number; auto_verdict: string; human_verdict: string; batch_id: number | null; source: string; score: number | null }[];
  const wire = (t: ReturnType<typeof setup>) => {
    t.batches.onUndone((o, r) => t.life.batchUndone(o, r));
    t.checks.onModeChanged((e) => t.life.modeChanged(e));
  };

  it("records a sample per check when an auto promotion is undone, and closes the notice", async () => {
    const t = setup();
    wire(t);
    const a = t.save();
    const b = t.save({ name: "no bar", params: { pattern: "bar" } });
    t.hits(a, 6, 5);
    t.hits(b, 6, 5);
    const r = await t.life.tick();
    expect(r.promoted).toHaveLength(2);
    t.advance(1000);
    t.batches.undo(r.promoteBatch!);
    expect(samples(t)).toMatchObject([
      { entity_id: a.id, auto_verdict: "promote", human_verdict: "shadow", batch_id: r.promoteBatch, source: "override" },
      { entity_id: b.id, auto_verdict: "promote", human_verdict: "shadow" },
    ]);
    expect(samples(t)[0].score).toBeGreaterThan(0);
    expect(t.repo.openEvents(0)).toEqual([]);
    expect(t.repo.lifecycle(a.id)).toBeNull();
  });

  it("records a sample when an auto demotion is undone", async () => {
    const t = setup();
    wire(t);
    const row = t.save();
    t.hits(row, 6, 5);
    await t.life.tick();
    t.advance(1000);
    const enforced = t.checks.repo.get(row.id)!;
    t.hits(enforced, 6, 6);
    t.repo.insertBypassLogs([0, 1, 2].map((i) => ({ key: `b${i}`, rec: { kind: "bypass" as const, checkId: row.id, checkKey: row.key, slug: "acme/web", file: "", line: null, how: "no_verify" as const, detail: "", session: "s", at: t.now() } })));
    const r = await t.life.tick();
    expect(r.demoted).toEqual([row.id]);
    t.advance(1000);
    t.batches.undo(r.demoteBatch!);
    expect(samples(t)).toMatchObject([{ entity_id: row.id, auto_verdict: "demote", human_verdict: "enforce", batch_id: r.demoteBatch }]);
    expect(t.checks.repo.get(row.id)?.mode).toBe("enforce");
    // 撤销以后窗口从头算，不会马上又降。
    expect((await t.life.tick()).demoted).toEqual([]);
  });

  it("records a sample when a person sets a promoted check back to shadow within 14 days, not later", async () => {
    const t = setup();
    wire(t);
    const a = t.save();
    const b = t.save({ name: "no bar", params: { pattern: "bar" } });
    t.hits(a, 6, 5);
    t.hits(b, 6, 5);
    const r = await t.life.tick();
    t.advance(3 * DAY);
    t.checks.bulk([a.id], "shadow");
    expect(samples(t)).toMatchObject([{ entity_id: a.id, auto_verdict: "promote", human_verdict: "shadow", batch_id: r.promoteBatch }]);
    t.advance(20 * DAY);
    t.checks.bulk([b.id], "shadow");
    expect(samples(t)).toHaveLength(1);
  });

  it("ignores undo of other batches and auto mode changes", async () => {
    const t = setup();
    wire(t);
    const row = t.save();
    const r = t.checks.bulk([row.id], "enforce");
    t.batches.undo(r.ok ? r.batchId! : 0);
    t.checks.bulk([row.id], "enforce", { origin: "auto" });
    expect(samples(t)).toEqual([]);
  });
});

describe("manual promotion sample", () => {
  it("records hold → enforce when a person promotes a scored shadow check", async () => {
    const t = setup({ policy: { "shadow.autoPromote": false } });
    t.checks.onModeChanged((e) => t.life.modeChanged(e));
    const row = t.save();
    t.hits(row, 6, 4);
    await t.life.tick();
    t.checks.bulk([row.id], "enforce");
    const r = t.db.prepare(`SELECT auto_verdict, human_verdict, score_parts FROM score_calibration WHERE entity = 'check'`).all() as { auto_verdict: string; human_verdict: string; score_parts: string }[];
    expect(r).toMatchObject([{ auto_verdict: "hold", human_verdict: "enforce" }]);
    expect(JSON.parse(r[0].score_parts)).toMatchObject({ adoption: expect.closeTo(0.667, 2) });
  });
});
