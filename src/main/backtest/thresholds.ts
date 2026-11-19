// 定期阈值复查（工作流 F 第 8.2 节）：拿人推翻 / 留下自动决定的样本，给几个门槛各算一个建议值。
// 建议值是让「规则的结论」和「人的结论」最一致的那个，每次最多挪 MAX_MOVE；应用写进全局层（一个策略批次，能撤销）。
import type { Db } from "../db/database";
import type { BacktestRepo } from "../db/backtest-repo";
import type { AdmissionPolicyService } from "../lessons/admission-policies";
import { policyKeyDef, type AdmissionPolicy, type AdmissionPolicyKey } from "../../shared/admission-policy";
import type { ThresholdReviewView } from "../../shared/backtest";
import { MANUAL_OVERRIDE_MS } from "./lifecycle";

const DAY = 86_400_000;
/** 每次复查一个门槛最多挪这么多。 */
export const MAX_MOVE = 0.05;
const STEP = 0.01;
/** 一个门槛至少要这么多样本才给建议。 */
const MIN_PER_KEY = 3;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** 一个样本：规则看的值，以及人想不想让它「过」（min 门槛：值 ≥ t 算过；max 门槛：值 ≤ t 算过）。 */
export interface ThresholdSample {
  value: number;
  wantPass: boolean;
}

/** 在当前值 ± MAX_MOVE 里找一致率最高的；一样高的取挪得最少的。比现在好才返回。 */
export function suggestThreshold(
  xs: readonly ThresholdSample[],
  current: number,
  dir: "min" | "max",
  bounds: { lo: number; hi: number } = { lo: 0, hi: 1 },
): { suggested: number; agreeNow: number; agreeSuggested: number } | null {
  if (!xs.length) return null;
  const agree = (t: number) => xs.filter((x) => (dir === "min" ? x.value >= t : x.value <= t) === x.wantPass).length / xs.length;
  const now = agree(current);
  let best = { t: current, a: now, move: 0 };
  const steps = Math.round(MAX_MOVE / STEP);
  for (let k = -steps; k <= steps; k++) {
    const t = r2(Math.min(bounds.hi, Math.max(bounds.lo, current + k * STEP)));
    const a = agree(t);
    const move = Math.abs(t - current);
    if (a > best.a + 1e-9 || (Math.abs(a - best.a) < 1e-9 && move < best.move)) best = { t, a, move };
  }
  if (best.a <= now + 1e-9 || best.t === current) return null;
  return { suggested: best.t, agreeNow: r3(now), agreeSuggested: r3(best.a) };
}

export interface ThresholdReviewDeps {
  db: Db;
  repo: BacktestRepo;
  /** 全局层生效的策略。 */
  policy(): AdmissionPolicy;
  policies: Pick<AdmissionPolicyService, "overrides" | "setLayer">;
  lastRun(): number | null;
  setLastRun(at: number): void;
  onPolicyChanged?: () => void;
  now(): number;
}

type Reason = { id: number } & Record<string, unknown>;
type Collected = { samples: ThresholdSample[]; note: string };

export class ThresholdReview {
  constructor(private readonly d: ThresholdReviewDeps) {}

  /** 到时间、新样本够了就复查一次，写建议。 */
  run(): { ran: true; suggestions: number } | { ran: false; reason: "interval" | "samples" } {
    const p = this.d.policy();
    const now = this.d.now();
    const last = this.d.lastRun();
    if (last !== null && now - last < Number(p["review.intervalDays"]) * DAY) return { ran: false, reason: "interval" };
    if (this.newSamples(last ?? 0, now) < Number(p["review.minSamples"])) return { ran: false, reason: "samples" };
    this.d.setLastRun(now);
    const keys: [AdmissionPolicyKey, "min" | "max", Collected][] = [
      ["score.admitLine", "min", this.lessonScores()],
      ["backtest.maxFalsePositiveRate", "max", this.lessonBacktests()],
      ["shadow.minAdoption", "min", this.promotions("adoption", now)],
      ["shadow.maxFalsePositiveRate", "max", this.promotions("fpRate", now)],
      ["demote.maxBypassRate", "min", this.demotions(now)],
    ];
    let n = 0;
    for (const [key, dir, c] of keys) {
      if (c.samples.length < MIN_PER_KEY) continue;
      const def = policyKeyDef(key);
      const bounds = def && (def.kind === "number" || def.kind === "int") ? { lo: def.min, hi: def.max } : { lo: 0, hi: 1 };
      const s = suggestThreshold(c.samples, Number(p[key]), dir, bounds);
      if (!s) continue;
      this.d.repo.addReview({ key, current: Number(p[key]), suggested: s.suggested, basis: { samples: c.samples.length, agreeNow: s.agreeNow, agreeSuggested: s.agreeSuggested, note: c.note }, at: now });
      n++;
    }
    return { ran: true, suggestions: n };
  }

  /** 应用一条建议：改全局层的这个键（策略批次，能撤销）。 */
  apply(id: number): { ok: true; batchId: number | null } | { ok: false; error: string } {
    const r = this.d.repo.review(id);
    if (!r || r.status !== "open") return { ok: false, error: "not_found" };
    const res = this.d.policies.setLayer({ kind: "global" }, { ...this.d.policies.overrides({ kind: "global" }), [r.key]: r.suggested }, { origin: "manual", kind: "policy_threshold" });
    this.d.repo.decideReview(id, "applied", res.batchId, this.d.now());
    this.d.onPolicyChanged?.();
    return { ok: true, batchId: res.batchId };
  }

  dismiss(id: number): boolean {
    return this.d.repo.decideReview(id, "dismissed", null, this.d.now());
  }

  reviews(): ThresholdReviewView[] {
    return this.d.repo.reviews();
  }

  /** 上次复查以后新来的样本：新的校准记录 + 这段时间里过了推翻窗口（算「留下了」）的自动升降级。 */
  private newSamples(since: number, now: number): number {
    const cal = this.d.db.prepare(`SELECT COUNT(*) AS n FROM score_calibration WHERE at > ? AND at <= ?`).get(since, now) as { n: number };
    let kept = 0;
    for (const b of this.batches(["check_promote", "check_demote"]))
      if (b.at + MANUAL_OVERRIDE_MS > since && b.at + MANUAL_OVERRIDE_MS <= now) kept += b.reasons.filter((x) => !b.overturned.has(x.id)).length;
    return Number(cal.n) + kept;
  }

  private batches(kinds: string[]): { id: number; at: number; reasons: Reason[]; overturned: Set<number> }[] {
    const rows = this.d.db
      .prepare(`SELECT id, created_at, summary FROM admission_batches WHERE origin = 'auto' AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id`)
      .all(...kinds) as { id: number; created_at: number; summary: string }[];
    const over = this.d.db.prepare(`SELECT entity_id FROM score_calibration WHERE entity = 'check' AND batch_id = ?`);
    return rows.map((r) => {
      let reasons: Reason[] = [];
      try {
        const v = (JSON.parse(r.summary) as { reasons?: unknown }).reasons;
        if (Array.isArray(v)) reasons = v.filter((x): x is Reason => !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "number");
      } catch {
        reasons = [];
      }
      const overturned = new Set((over.all(r.id) as { entity_id: number }[]).map((x) => Number(x.entity_id)));
      return { id: Number(r.id), at: Number(r.created_at), reasons, overturned };
    });
  }

  /** 自动升级：被推翻的不该过，过了推翻窗口还留着的该过；人手动升级（hold → enforce）的该过。 */
  private promotions(field: "adoption" | "fpRate", now: number): Collected {
    const samples: ThresholdSample[] = [];
    for (const b of this.batches(["check_promote"])) {
      const matured = now - b.at >= MANUAL_OVERRIDE_MS;
      for (const x of b.reasons) {
        const v = x[field];
        if (typeof v !== "number") continue;
        if (b.overturned.has(x.id)) samples.push({ value: v, wantPass: false });
        else if (matured) samples.push({ value: v, wantPass: true });
      }
    }
    const manual = this.d.db.prepare(`SELECT score_parts FROM score_calibration WHERE entity = 'check' AND auto_verdict = 'hold' AND human_verdict = 'enforce'`).all() as { score_parts: string | null }[];
    for (const m of manual) {
      const parts = parseParts(m.score_parts);
      const v = field === "adoption" ? parts.adoption : typeof parts.precision === "number" ? 1 - parts.precision : undefined;
      if (typeof v === "number") samples.push({ value: r3(v), wantPass: true });
    }
    return { samples, note: field === "adoption" ? "promotions" : "promotions_fp" };
  }

  /** 自动降级（绕过）：降级被撤销的说明门槛太低（不该触发），留着的该触发。 */
  private demotions(now: number): Collected {
    const samples: ThresholdSample[] = [];
    for (const b of this.batches(["check_demote"])) {
      const matured = now - b.at >= MANUAL_OVERRIDE_MS;
      for (const x of b.reasons) {
        if (x.kind !== "bypassed" || typeof x.rate !== "number") continue;
        if (b.overturned.has(x.id)) samples.push({ value: x.rate, wantPass: false });
        else if (matured) samples.push({ value: x.rate, wantPass: true });
      }
    }
    return { samples, note: "demotions" };
  }

  /** 规矩分数：人判收 / 不收（D 的样本），文字型规矩用另一条线，不算在这里。 */
  private lessonScores(): Collected {
    const rows = this.d.db
      .prepare(
        `SELECT c.human_verdict AS v, c.score AS score FROM score_calibration c LEFT JOIN lessons l ON l.id = c.lesson_id
         WHERE c.entity = 'lesson' AND c.score IS NOT NULL AND c.human_verdict IN ('admit', 'reject') AND (l.checkability IS NULL OR l.checkability != 'prose')`,
      )
      .all() as { v: string; score: number }[];
    return { samples: rows.map((r) => ({ value: Number(r.score), wantPass: r.v === "admit" })), note: "lessons" };
  }

  /** 回测误报率：人判收 / 不收的规矩，用它最新一次回测的误报率。 */
  private lessonBacktests(): Collected {
    const rows = this.d.db
      .prepare(
        `SELECT c.human_verdict AS v,
           (SELECT b.fp_rate FROM check_backtests b WHERE b.lesson_id = c.lesson_id AND b.status = 'done' AND b.fp_rate IS NOT NULL ORDER BY b.created_at DESC, b.id DESC LIMIT 1) AS fp
         FROM score_calibration c WHERE c.entity = 'lesson' AND c.lesson_id IS NOT NULL AND c.human_verdict IN ('admit', 'reject')`,
      )
      .all() as { v: string; fp: number | null }[];
    return { samples: rows.filter((r) => r.fp !== null).map((r) => ({ value: Number(r.fp), wantPass: r.v === "admit" })), note: "backtests" };
  }
}

function parseParts(s: string | null): Record<string, number> {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
