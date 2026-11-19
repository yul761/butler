// 影子运行的检查自动升级成强制（工作流 F 第 6 节），被频繁绕过 / 同类评论没减少的自动降级或标记待复查（第 7 节）。
// 每次复查（review tick）跑一遍：算分、写 check_scores、凑一批升级和一批降级（各一个可撤销的批次）、记事件给「现在」页。
import type { Db } from "../db/database";
import type { BacktestRepo } from "../db/backtest-repo";
import type { ChecksService } from "../checks/checks-service";
import type { AdmissionPolicy, AdmissionPolicyKey } from "../../shared/admission-policy";
import type {
  BacktestSummary, BypassHow, CheckLifecycleReason, LifecycleReasonData, PromotionBlocker, PromotionProgress,
} from "../../shared/backtest";
import type { CheckRow } from "../../shared/checks";
import type { BatchView } from "../../shared/batches";
import type { CheckModeChange } from "../checks/checks-service";
import type { LessonScoreParts } from "../../shared/lessons";
import type { LessonCommentTrend } from "../review-effect/stats";
import { IGNORED_AFTER_MS } from "../db/checks-repo";
import { estimateFalsePositives, seededSample, type JudgeHit, type JudgeResult } from "./judge";
import { checkScore, performanceOf, type PerformanceResult } from "./scores";
import { verifiabilityValue } from "./gate";

const DAY = 86_400_000;
/** 自动升级 / 降级以后这么久之内人手动改回去，算推翻了它（记校准样本）。 */
export const MANUAL_OVERRIDE_MS = 14 * DAY;
const num = (p: AdmissionPolicy, k: AdmissionPolicyKey) => Number(p[k]);
const round = (v: number) => Math.round(v * 1000) / 1000;

/** 检查当前模式从什么时候开始、是谁改的。 */
export interface ModeWindow {
  since: number;
  /** 最近一次改模式的批次是自动升级。 */
  autoPromoted: boolean;
  /** 最近一次改模式的批次是自动降级：在人改模式以前不再自动升级。 */
  autoDemoted: boolean;
  /** 最近一次改模式是撤销了一次自动升级（人说了不）：不再自动升级，直到人自己改。 */
  promotionUndone: boolean;
}

/** 窗口里的命中（modeSince 之后）。 */
export interface WindowHit {
  id: number;
  file: string;
  line: number | null;
  outcome: string;
  blocked: boolean;
  verdict: "false_positive" | "true_positive" | null;
  detail: string;
  session: string | null;
  at: number;
}

export interface WindowStats {
  fails: number;
  resolved: number;
  blocked: number;
  falsePositives: number;
  truePositives: number;
  ignored: number;
  /** 碰过的 PR 数（没有 PR 的 session 各算一个）。 */
  prs: number;
  bypasses: number;
  bypassHow: Partial<Record<BypassHow, number>>;
}

function summaryKind(s: string): unknown {
  try {
    return (JSON.parse(s) as { kind?: unknown }).kind;
  } catch {
    return null;
  }
}

/** 库里查窗口的几条 SQL。 */
export class LifecycleQueries {
  constructor(private readonly db: Db) {}

  window(row: Pick<CheckRow, "id" | "createdAt">): ModeWindow {
    const items = this.db
      .prepare(
        `SELECT b.kind AS kind, b.origin AS origin, b.summary AS summary, b.created_at AS at, i.before AS before, i.after AS after
         FROM admission_batch_items i JOIN admission_batches b ON b.id = i.batch_id
         WHERE i.entity = 'check' AND i.entity_id = ? ORDER BY b.created_at DESC, b.id DESC`,
      )
      .all(row.id) as { kind: string; origin: string; summary: string; at: number; before: string | null; after: string | null }[];
    const modeOf = (s: string | null): string | null => {
      if (s === null) return null;
      try {
        const v = JSON.parse(s) as { mode?: unknown };
        return typeof v.mode === "string" ? v.mode : null;
      } catch {
        return null;
      }
    };
    for (const it of items) {
      if (modeOf(it.before) === modeOf(it.after)) continue;
      const undoneKind = summaryKind(it.summary);
      return {
        since: Number(it.at),
        autoPromoted: it.kind === "check_promote" && it.origin === "auto",
        autoDemoted: it.kind === "check_demote" && it.origin === "auto",
        promotionUndone: it.kind === "undo" && undoneKind === "check_promote",
      };
    }
    return { since: row.createdAt, autoPromoted: false, autoDemoted: false, promotionUndone: false };
  }

  hits(checkId: number, since: number): WindowHit[] {
    const rows = this.db
      .prepare(
        `SELECT id, file, line, outcome, blocked, verdict, detail, session_id, at FROM check_hits
         WHERE check_id = ? AND at >= ? AND outcome IN ('fail', 'resolved') ORDER BY at, id LIMIT 20000`,
      )
      .all(checkId, since) as { id: number; file: string; line: number | null; outcome: string; blocked: number; verdict: string | null; detail: string; session_id: string | null; at: number }[];
    return rows.map((r) => ({
      id: Number(r.id), file: r.file, line: r.line === null ? null : Number(r.line), outcome: r.outcome, blocked: Number(r.blocked) === 1,
      verdict: r.verdict === "false_positive" || r.verdict === "true_positive" ? r.verdict : null, detail: r.detail, session: r.session_id, at: Number(r.at),
    }));
  }

  /** 碰过的 PR：命中所在 session 的 ticket 的 PR（同一个仓库）去重；没有 PR 的 session 各算一个。 */
  prsTouched(checkId: number, since: number): number {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT DISTINCT COALESCE(p.slug || '#' || p.number, 's:' || COALESCE(h.session_id, '')) AS k
           FROM check_hits h
           LEFT JOIN sessions s ON s.id = h.session_id
           LEFT JOIN ticket_prs p ON p.ticket_key = s.ticket_key AND (h.repo_slug IS NULL OR p.slug = h.repo_slug)
           WHERE h.check_id = ? AND h.at >= ?)`,
      )
      .get(checkId, since) as { n: number };
    return Number(r.n);
  }
}

/** 窗口里的数：拦下以后一天内同一个 session 在同一个文件上没改掉的算「没理会」。 */
export function windowStats(hits: readonly WindowHit[], now: number, extra: { prs: number; bypasses: number; bypassHow: Partial<Record<BypassHow, number>> }): WindowStats {
  let fails = 0;
  let resolved = 0;
  let blocked = 0;
  let falsePositives = 0;
  let truePositives = 0;
  let ignored = 0;
  for (const h of hits) {
    if (h.outcome === "resolved") {
      resolved++;
      continue;
    }
    fails++;
    if (h.verdict === "false_positive") falsePositives++;
    if (h.verdict === "true_positive") truePositives++;
    if (!h.blocked) continue;
    blocked++;
    if (now - h.at < IGNORED_AFTER_MS) continue;
    const fixed = hits.some((r) => r.outcome === "resolved" && r.file === h.file && r.session === h.session && r.at >= h.at);
    if (!fixed) ignored++;
  }
  return { fails, resolved, blocked, falsePositives, truePositives, ignored, ...extra };
}

export interface LifecycleDeps {
  db: Db;
  repo: BacktestRepo;
  checks: Pick<ChecksService, "bulk" | "repo">;
  /** 检查所在那一层生效的准入策略。 */
  policy(row: CheckRow): AdmissionPolicy;
  policyVersion?(): number | null;
  /** 检查的回测（几个仓库合起来）；还没回测是 null。 */
  backtestOf(row: CheckRow): BacktestSummary | null;
  /** 来源规矩的分项（手写的检查没有）。 */
  lessonParts(row: CheckRow): LessonScoreParts | null;
  /** 规矩原文（判影子命中用）。 */
  lessonText(row: CheckRow): string;
  /** G 的同类评论趋势。 */
  trend(row: CheckRow, since: number): LessonCommentTrend | null;
  /** 影子期没人标的失败交给模型判（shadow_fp，按命中 id 缓存）；没给就只看人标的。 */
  judge?: (rule: { text: string; message: string }, hits: JudgeHit[]) => Promise<JudgeResult>;
  /** 度量（H：check.promote / check.demote）。 */
  record?: (kind: string, data: Record<string, unknown>) => void;
  onChanged?: () => void;
  now(): number;
  log?: (msg: string, e?: unknown) => void;
}

/** 一条检查这次复查算出来的东西。 */
export interface CheckAssessment {
  row: CheckRow;
  window: ModeWindow;
  stats: WindowStats;
  score: number | null;
  performance: PerformanceResult | null;
  progress: PromotionProgress | null;
  /** 影子期误报率（人标的 + 模型判的外推）；没算出来是 null。 */
  fpRate: number | null;
  demotion: { reason: CheckLifecycleReason; data: LifecycleReasonData } | null;
}

export interface TickResult {
  promoted: number[];
  demoted: number[];
  flagged: number[];
  promoteBatch: number | null;
  demoteBatch: number | null;
  /** 判影子命中被限流：这个时间以后再来。 */
  waitUntil: number | null;
}

/** 绕过率：(绕过 + 没理会) / 拦下的失败。 */
export function bypassRate(s: Pick<WindowStats, "bypasses" | "ignored" | "blocked">): number | null {
  return s.blocked > 0 ? round((s.bypasses + s.ignored) / s.blocked) : null;
}

/** 降级的条件（第 7.2 节）：只看启用、强制、拦截的检查。 */
export function demotionOf(
  row: CheckRow,
  s: WindowStats,
  trend: LessonCommentTrend | null,
  p: AdmissionPolicy,
): { reason: CheckLifecycleReason; data: LifecycleReasonData } | null {
  if (p["demote.enabled"] !== true || !row.enabled || row.mode !== "enforce" || row.severity !== "block") return null;
  const rate = bypassRate(s);
  const max = num(p, "demote.maxBypassRate");
  if (rate !== null && s.blocked >= num(p, "demote.minEvents") && rate >= max) {
    return { reason: "bypassed", data: { kind: "bypassed", bypasses: s.bypasses, ignored: s.ignored, blocked: s.blocked, rate, max, how: s.bypassHow } };
  }
  if (trend && trend.before.prs > 0 && trend.after.prs >= num(p, "demote.noReductionPrs") && trend.before.perPr !== null && trend.after.perPr !== null && trend.after.perPr >= trend.before.perPr) {
    return { reason: "no_reduction", data: { kind: "no_reduction", beforePerPr: trend.before.perPr, afterPerPr: trend.after.perPr, afterPrs: trend.after.prs } };
  }
  return null;
}

/** 回测是否算「测过」：至少一个仓库 done，没有除「没 clone」以外的跳过。 */
export function backtested(b: BacktestSummary | null): "yes" | "no" | "pending" {
  if (!b) return "pending";
  if (!b.tested) return "no";
  return b.skipped.every((x) => x.reason === "not_cloned") ? "yes" : "no";
}

/** 升级的条件（第 6.2 节），按顺序列出不满足的。fpRate 是人标的 + 模型判的；null 表示还没算（不当作通过）。 */
export function promotionProgress(
  a: { row: CheckRow; window: ModeWindow; stats: WindowStats; score: number | null; backtest: BacktestSummary | null; fpRate: number | null; needsReview: boolean },
  p: AdmissionPolicy,
  now: number,
): PromotionProgress {
  const { row, stats } = a;
  const blockers: PromotionBlocker[] = [];
  const days = Math.max(0, (now - a.window.since) / DAY);
  const adoption = stats.fails > 0 ? round(Math.min(1, stats.resolved / stats.fails)) : null;
  const admitLine = num(p, "score.admitLine");
  if (p["shadow.autoPromote"] !== true) blockers.push("auto_off");
  if (!row.enabled) blockers.push("disabled");
  if (row.mode !== "shadow") blockers.push("not_shadow");
  if (row.severity !== "block") blockers.push("warn");
  const bt = backtested(a.backtest);
  if (bt === "pending") blockers.push("no_backtest");
  else if (bt === "no") blockers.push("untested");
  if (a.score === null || a.score < admitLine) blockers.push("score");
  if (stats.prs < num(p, "shadow.minPrs") && days < num(p, "shadow.minDays")) blockers.push("time");
  if (stats.fails < num(p, "shadow.minHits")) blockers.push("hits");
  if (a.fpRate === null || a.fpRate > num(p, "shadow.maxFalsePositiveRate")) blockers.push("fp");
  if (adoption === null || adoption < num(p, "shadow.minAdoption")) blockers.push("adoption");
  if (a.needsReview || a.window.promotionUndone || a.window.autoDemoted) blockers.push("needs_review");
  return {
    eligible: blockers.length === 0, blockers, since: a.window.since, prs: stats.prs, minPrs: num(p, "shadow.minPrs"), days: Math.floor(days),
    minDays: num(p, "shadow.minDays"), fails: stats.fails, minHits: num(p, "shadow.minHits"), adoption, minAdoption: num(p, "shadow.minAdoption"),
    fpRate: a.fpRate, maxFpRate: num(p, "shadow.maxFalsePositiveRate"), score: a.score, admitLine,
  };
}

export class Lifecycle {
  private readonly q: LifecycleQueries;

  constructor(private readonly d: LifecycleDeps) {
    this.q = new LifecycleQueries(d.db);
  }

  /** 一条检查的现状（页面和复查共用）。不调模型：影子误报只用人标的和缓存里判过的。 */
  assess(row: CheckRow, now = this.d.now(), judged?: JudgeResult | null): CheckAssessment {
    const p = this.d.policy(row);
    const window = this.q.window(row);
    const hits = this.q.hits(row.id, window.since);
    const by = this.d.repo.bypasses(row.id, window.since);
    const stats = windowStats(hits, now, { prs: this.q.prsTouched(row.id, window.since), bypasses: by.total, bypassHow: by.how });
    const trend = this.d.trend(row, window.since);
    const performance = performanceOf(
      { fails: stats.fails, resolved: stats.resolved, falsePositives: stats.falsePositives, enforce: row.mode === "enforce", blocked: stats.blocked, bypasses: stats.bypasses, ignored: stats.ignored, trend },
      p,
    );
    const backtest = this.d.backtestOf(row);
    const tested = backtest && backtested(backtest) === "yes" ? verifiabilityValue({ recall: backtest.recall, fpRate: backtest.fpRate }, p) : null;
    const { score } = checkScore({ lessonParts: this.d.lessonParts(row), verifiability: tested, performance }, p);
    const life = this.d.repo.lifecycle(row.id);
    const fpRate = this.shadowFpRate(hits, stats, judged ?? null, p);
    const progress = row.mode === "shadow" ? promotionProgress({ row, window, stats, score, backtest, fpRate, needsReview: life?.needsReview ?? false }, p, now) : null;
    const demotion = demotionOf(row, stats, trend, p);
    return { row, window, stats, score, performance, progress, fpRate, demotion };
  }

  /** 影子误报率：人标的误报 + 没人标的失败按模型判的比例外推；要判却没判成的全算误报（保守）。 */
  private shadowFpRate(hits: readonly WindowHit[], s: WindowStats, judged: JudgeResult | null, p: AdmissionPolicy): number | null {
    if (s.fails === 0) return null;
    const unjudged = hits.filter((h) => h.outcome === "fail" && h.verdict === null).length;
    const sample = num(p, "backtest.judgeSample");
    if (unjudged === 0 || sample <= 0) return round(s.falsePositives / s.fails);
    if (!judged) return null;
    return round((s.falsePositives + estimateFalsePositives(unjudged, judged.judged, judged.falsePositives)) / s.fails);
  }

  /** 没人标的影子失败：按种子抽 judgeSample 条，交给模型（缓存命中就不调）。 */
  private async judgeShadow(row: CheckRow, a: CheckAssessment): Promise<JudgeResult | null> {
    if (!this.d.judge) return null;
    const p = this.d.policy(row);
    const fails = this.q.hits(row.id, a.window.since).filter((h) => h.outcome === "fail" && h.verdict === null);
    const picked = seededSample(fails, num(p, "backtest.judgeSample"), `${row.id}:${a.window.since}`);
    if (!picked.length) return null;
    return this.d.judge(
      { text: this.d.lessonText(row), message: row.message },
      picked.map((h) => ({ key: `hit:${h.id}`, path: h.file, line: h.line ?? 0, text: h.detail, context: h.detail })),
    );
  }

  /** 复查一次：重算分数、升级、降级 / 标记。 */
  async tick(signal?: AbortSignal): Promise<TickResult> {
    const now = this.d.now();
    const rows = this.d.checks.repo.all().filter((r) => r.enabled);
    const promote: { row: CheckRow; a: CheckAssessment }[] = [];
    const demote: { row: CheckRow; a: CheckAssessment }[] = [];
    const flag: { row: CheckRow; a: CheckAssessment }[] = [];
    let waitUntil: number | null = null;
    for (const row of rows) {
      if (signal?.aborted) break;
      let a: CheckAssessment;
      try {
        a = this.assess(row, now);
        // 其余条件都满足、只差影子误报率没算：判一下再看。
        if (a.progress && a.progress.blockers.length === 1 && a.progress.blockers[0] === "fp" && a.fpRate === null) {
          const j = await this.judgeShadow(row, a);
          if (j?.incomplete && j.waitUntil) waitUntil = Math.max(waitUntil ?? 0, j.waitUntil);
          a = this.assess(row, now, j);
        }
      } catch (e) {
        this.d.log?.(`backtest: assessing check ${row.id} failed`, e);
        continue;
      }
      const parts: Record<string, number> = { ...(a.performance?.inputs ?? {}) };
      if (a.performance) parts.performance = a.performance.value;
      this.d.repo.setScore(row.id, a.score, parts, now, this.d.policyVersion?.() ?? null);
      if (a.progress?.eligible) promote.push({ row, a });
      else if (a.demotion) {
        const life = this.d.repo.lifecycle(row.id);
        if (life?.needsReview) continue;
        const p = this.d.policy(row);
        if (p["demote.to"] === "shadow" && a.window.autoPromoted) demote.push({ row, a });
        else flag.push({ row, a });
      }
    }
    const res: TickResult = { promoted: [], demoted: [], flagged: [], promoteBatch: null, demoteBatch: null, waitUntil };
    if (promote.length) {
      const checks = promote.map(({ row }) => ({ id: row.id, name: row.name }));
      const r = this.d.checks.bulk(promote.map((x) => x.row.id), "enforce", {
        origin: "auto", kind: "check_promote",
        summary: { checks, reasons: promote.map(({ row, a }) => ({ id: row.id, prs: a.stats.prs, days: a.progress?.days ?? 0, fails: a.stats.fails, adoption: a.progress?.adoption ?? null, fpRate: a.fpRate, score: a.score })) },
      });
      if (r.ok && r.batchId) {
        res.promoteBatch = r.batchId;
        res.promoted = promote.map((x) => x.row.id);
        for (const { row } of promote) this.d.repo.setLifecycle(row.id, { needsReview: false, reason: null, data: { kind: "none" }, lastAction: "promote", lastBatchId: r.batchId }, now);
        this.d.repo.addEvent("promote", r.batchId, checks, now);
        this.d.record?.("check.promote", { batchId: r.batchId, count: checks.length });
      }
    }
    if (demote.length) {
      const checks = demote.map(({ row, a }) => ({ id: row.id, name: row.name, reason: a.demotion!.reason }));
      const r = this.d.checks.bulk(demote.map((x) => x.row.id), "shadow", {
        origin: "auto", kind: "check_demote", summary: { checks, reasons: demote.map(({ row, a }) => ({ id: row.id, ...a.demotion!.data })) },
      });
      if (r.ok && r.batchId) {
        res.demoteBatch = r.batchId;
        res.demoted = demote.map((x) => x.row.id);
        for (const { row, a } of demote) {
          this.d.repo.setLifecycle(row.id, { needsReview: false, reason: a.demotion!.reason, data: a.demotion!.data, lastAction: "demote", lastBatchId: r.batchId }, now);
        }
        this.d.repo.addEvent("demote", r.batchId, checks, now);
        this.d.record?.("check.demote", { batchId: r.batchId, count: checks.length, to: "shadow" });
      }
    }
    if (flag.length) {
      const checks = flag.map(({ row, a }) => ({ id: row.id, name: row.name, reason: a.demotion!.reason }));
      for (const { row, a } of flag) {
        this.d.repo.setLifecycle(row.id, { needsReview: true, reason: a.demotion!.reason, data: a.demotion!.data, lastAction: "flag", lastBatchId: null }, now);
      }
      res.flagged = flag.map((x) => x.row.id);
      this.d.repo.addEvent("flag", null, checks, now);
      this.d.record?.("check.demote", { batchId: null, count: checks.length, to: "review" });
    }
    if (promote.length || demote.length || flag.length) this.d.onChanged?.();
    return res;
  }

  /** 撤销了一个自动升级 / 降级批次：每条恢复的检查记一个校准样本，清掉原因，通知消失。 */
  batchUndone(original: BatchView, restored: readonly { entity: string; id: number }[]): number {
    if (original.origin !== "auto" || (original.kind !== "check_promote" && original.kind !== "check_demote")) return 0;
    const now = this.d.now();
    const auto = original.kind === "check_promote" ? "promote" : "demote";
    let n = 0;
    for (const x of restored) {
      if (x.entity !== "check") continue;
      this.sample(x.id, auto, auto === "promote" ? "shadow" : "enforce", original.id, now);
      this.d.repo.clearLifecycle(x.id);
      n++;
    }
    this.d.repo.markUndone(original.id, now);
    this.d.onChanged?.();
    return n;
  }

  /** 人手动改了模式：刚被自动升级的改回影子、刚被自动降级的改回强制（14 天内），记校准样本。 */
  modeChanged(e: CheckModeChange): number {
    if (e.origin !== "manual") return 0;
    let n = 0;
    for (const id of e.ids) {
      const life = this.d.repo.lifecycle(id);
      if (e.mode === "enforce" && life?.lastAction !== "demote") {
        // 人自己把影子检查改成强制：规则当时没升（hold）。有表现数据才记，给阈值复查看「规则是不是太严」。
        const parts = this.d.repo.score(id)?.parts ?? {};
        if (typeof parts.adoption === "number" || typeof parts.precision === "number") {
          this.sample(id, "hold", "enforce", null, e.at);
          n++;
        }
        continue;
      }
      if (!life || life.lastBatchId === null || e.at - life.at > MANUAL_OVERRIDE_MS) continue;
      const overturned = (life.lastAction === "promote" && e.mode === "shadow") || (life.lastAction === "demote" && e.mode === "enforce");
      if (!overturned) continue;
      this.sample(id, life.lastAction as "promote" | "demote", e.mode, life.lastBatchId, e.at);
      this.d.repo.clearLifecycle(id);
      n++;
    }
    if (n) this.d.onChanged?.();
    return n;
  }

  private sample(checkId: number, auto: "promote" | "demote" | "hold", human: "shadow" | "enforce", batchId: number | null, at: number): void {
    const row = this.d.checks.repo.get(checkId);
    const sc = this.d.repo.score(checkId);
    this.d.db
      .prepare(
        `INSERT INTO score_calibration (entity, lesson_id, entity_id, auto_verdict, human_verdict, score, score_parts, batch_id, at, source)
         VALUES ('check', ?, ?, ?, ?, ?, ?, ?, ?, 'override')`,
      )
      .run(row?.lessonId ?? null, checkId, auto, human, sc?.score ?? null, JSON.stringify(sc?.parts ?? {}), batchId, at);
  }

  /** 人看过了：清掉待复查（原因留在历史里）。 */
  clearReview(checkId: number): boolean {
    const life = this.d.repo.lifecycle(checkId);
    if (!life?.needsReview) return false;
    this.d.repo.setLifecycle(checkId, { needsReview: false, reason: null, data: { kind: "none" }, lastAction: life.lastAction, lastBatchId: life.lastBatchId }, this.d.now());
    this.d.onChanged?.();
    return true;
  }
}
