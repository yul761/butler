import type { AdmissionPolicy } from "../../../shared/admission-policy";
import type { BatchMetricKey, BatchMetricView, BatchReviewView, SampleVerdict, ShelvedShares } from "../../../shared/lesson-admission";
import type { Db } from "../../db/database";
import type { Candidate } from "../../routing/router";
import { readSample, runSample, samplePassed, type StepCtx, type StepLesson } from "./model-steps";
import type { LessonVerdict } from "./pipeline";

/**
 * 一批的复核（addendum 5.2）：从被推荐的规矩里按种子抽 batch.sampleSize 条，换一个模型复核（lesson_sample_review），
 * 算通过率和搁置比例，存成 batch_reviews 一行。线在看的时候按当时的策略算（改了线不用重新抽查）。
 */

/** F 接进来的整批指标（覆盖率、回测）；没有时这几项是「未回测」。 */
export interface BatchMetricsProvider {
  metrics(batchId: number): { coverage?: number | null; backtestRecall?: number | null; backtestFalsePositives?: number | null; backtestFalsePositiveRate?: number | null } | null;
}

/** 确定的伪随机（mulberry32）：同一个种子抽到同样的样本，向导重启后接着抽也一样。 */
export function seededSample<T>(items: readonly T[], n: number, seed: number): T[] {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const xs = [...items];
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs.slice(0, Math.max(0, n));
}

export function shelvedShares(verdicts: readonly Pick<LessonVerdict, "verdict" | "reason">[]): ShelvedShares {
  const judged = verdicts.filter((v) => v.verdict === "admit" || v.verdict === "shelved" || v.verdict === "covered");
  const shelved = judged.filter((v) => v.verdict === "shelved");
  const byReason: Record<string, number> = {};
  for (const v of shelved) byReason[v.reason ?? "other"] = (byReason[v.reason ?? "other"] ?? 0) + 1;
  for (const k of Object.keys(byReason)) byReason[k] = byReason[k] / judged.length;
  return { judged: judged.length, shelved: shelved.length, share: judged.length ? shelved.length / judged.length : null, byReason };
}

interface ReviewRow {
  id: number;
  batch_id: number;
  sample_size: number;
  pass_rate: number | null;
  coverage: number | null;
  shelved_shares: string;
  backtest_recall: number | null;
  backtest_false_positives: number | null;
  verdicts: string;
  created_at: number;
}

interface StoredVerdicts {
  sameModelReview: boolean;
  items: SampleVerdict[];
}

export class BatchReviews {
  constructor(private readonly d: { db: Db; now: () => number; metrics?: BatchMetricsProvider | null }) {}

  /** 抽查一批并存下来。没有被推荐的规矩时也存一行（通过率为空），总结照样有搁置比例。 */
  async review(o: { batchId: number; ctx: StepCtx; admitted: StepLesson[]; producer: Candidate | null; verdicts: readonly LessonVerdict[]; policy: AdmissionPolicy; seed: number }): Promise<number> {
    const sample = seededSample([...o.admitted].sort((a, b) => a.id - b.id), Number(o.policy["batch.sampleSize"]), o.seed);
    if (sample.length) await runSample(o.ctx, sample, o.producer);
    const items: SampleVerdict[] = sample.map((l) => {
      const s = readSample(o.ctx.judgments, l);
      return s
        ? { lessonId: l.id, reviewed: true, pass: samplePassed(s), reasonable: s.reasonable, follows: s.follows, scopeOk: s.scope_ok, note: s.note }
        : { lessonId: l.id, reviewed: false, pass: false, reasonable: false, follows: false, scopeOk: false, note: "" };
    });
    const same = sample.some((l) => readSample(o.ctx.judgments, l)?.sameModelReview === true);
    const reviewed = items.filter((i) => i.reviewed);
    const passRate = reviewed.length ? reviewed.filter((i) => i.pass).length / reviewed.length : null;
    const m = this.d.metrics?.metrics(o.batchId) ?? null;
    const r = this.d.db
      .prepare(
        `INSERT INTO batch_reviews (batch_id, sample_size, pass_rate, coverage, shelved_shares, backtest_recall, backtest_false_positives, verdicts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.batchId, sample.length, passRate, m?.coverage ?? null, JSON.stringify(shelvedShares(o.verdicts)), m?.backtestRecall ?? null, m?.backtestFalsePositives ?? null, JSON.stringify({ sameModelReview: same, items } satisfies StoredVerdicts), this.d.now());
    return Number(r.lastInsertRowid);
  }

  get(id: number, policy: AdmissionPolicy): BatchReviewView | null {
    const r = this.d.db.prepare(`SELECT * FROM batch_reviews WHERE id = ?`).get(id) as unknown as ReviewRow | undefined;
    return r ? this.view(r, policy) : null;
  }

  latestFor(batchId: number, policy: AdmissionPolicy): BatchReviewView | null {
    const r = this.d.db.prepare(`SELECT * FROM batch_reviews WHERE batch_id = ? ORDER BY id DESC LIMIT 1`).get(batchId) as unknown as ReviewRow | undefined;
    return r ? this.view(r, policy) : null;
  }

  /** 改了搁置结果以后（重新计算）只更新搁置比例，不重新抽查。 */
  updateShares(id: number, verdicts: readonly LessonVerdict[]): void {
    this.d.db.prepare(`UPDATE batch_reviews SET shelved_shares = ? WHERE id = ?`).run(JSON.stringify(shelvedShares(verdicts)), id);
  }

  private view(r: ReviewRow, policy: AdmissionPolicy): BatchReviewView {
    const stored = parse<StoredVerdicts>(r.verdicts, { sameModelReview: false, items: [] });
    const items = Array.isArray(stored) ? (stored as SampleVerdict[]) : stored.items;
    const shelved = parse<ShelvedShares>(r.shelved_shares, { judged: 0, shelved: 0, share: null, byReason: {} });
    const live = this.d.metrics?.metrics(Number(r.batch_id)) ?? null;
    const coverage = live?.coverage ?? r.coverage;
    const recall = live?.backtestRecall ?? r.backtest_recall;
    const metrics = assessMetrics({ passRate: r.pass_rate, shelvedShare: shelved.share, coverage, backtestRecall: recall, backtestFalsePositiveRate: live?.backtestFalsePositiveRate ?? null }, policy);
    const past = metrics.filter((x) => x.past).sort((a, b) => b.distance - a.distance);
    return {
      id: Number(r.id),
      batchId: Number(r.batch_id),
      sampleSize: Number(r.sample_size),
      reviewed: items.filter((i) => i.reviewed).length,
      passRate: r.pass_rate,
      sameModelReview: !Array.isArray(stored) && stored.sameModelReview,
      shelved,
      coverage,
      backtestRecall: recall,
      metrics,
      blocked: past.length > 0,
      weakest: past[0]?.key ?? null,
      verdicts: items,
      createdAt: Number(r.created_at),
    };
  }
}

/** 每个有值的指标对着它的线：越线的距离按线的比例算（线是 0 时按值本身）。 */
export function assessMetrics(
  v: { passRate: number | null; shelvedShare: number | null; coverage: number | null; backtestRecall: number | null; backtestFalsePositiveRate: number | null },
  p: AdmissionPolicy,
): BatchMetricView[] {
  const defs: { key: BatchMetricKey; value: number | null; floor: number; bound: "min" | "max" }[] = [
    { key: "samplePassRate", value: v.passRate, floor: Number(p["batch.minSamplePassRate"]), bound: "min" },
    { key: "shelvedShare", value: v.shelvedShare, floor: Number(p["batch.maxShelvedShare"]), bound: "max" },
    { key: "coverage", value: v.coverage, floor: Number(p["batch.minCoverage"]), bound: "min" },
    { key: "backtestRecall", value: v.backtestRecall, floor: Number(p["batch.minBacktestRecall"]), bound: "min" },
    { key: "backtestFalsePositiveRate", value: v.backtestFalsePositiveRate, floor: Number(p["batch.maxBacktestFalsePositiveRate"]), bound: "max" },
  ];
  return defs
    .filter((d): d is typeof d & { value: number } => d.value !== null && Number.isFinite(d.value))
    .map((d) => {
      const gap = d.bound === "min" ? d.floor - d.value : d.value - d.floor;
      const past = gap > 1e-9;
      return { ...d, past, distance: past ? gap / (d.floor > 0 ? d.floor : 1) : 0 };
    });
}

function parse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
