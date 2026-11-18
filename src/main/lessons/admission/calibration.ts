import type { AdmissionPolicy } from "../../../shared/admission-policy";
import type {
  AdmissionScope,
  CalibrationAuto,
  CalibrationBand,
  CalibrationBandStats,
  CalibrationItem,
  CalibrationMark,
  CalibrationSample,
  CalibrationStats,
} from "../../../shared/lesson-admission";
import type { Lesson } from "../../../shared/lessons";
import type { Db } from "../../db/database";
import type { LessonsRepo } from "../../db/lessons-repo";
import { seededSample } from "./batch-review";

/**
 * 校准（addendum 第 9 节）：从打过分的规矩里按分数段各抽 5 条（高：过准入线；低：不到淘汰线；中间），
 * 人判好 / 不好 / 跳过，每个判断是一条 score_calibration（source = review）。一致率：好的在准入线以上、
 * 不好的在准入线以下算一致。「标记为已校准」写 admissionCalibratedAt。
 */

export const CALIBRATION_PER_BAND = 5;
const BANDS: readonly CalibrationBand[] = ["high", "mid", "low"];

export interface CalibrationDeps {
  db: Db;
  repo: LessonsRepo;
  /** 全局层的策略（线按全局层算：校准页调的就是全局层）。 */
  policy: () => AdmissionPolicy;
  now: () => number;
  calibratedAt: () => string;
  setCalibratedAt: (iso: string) => void;
  seed?: () => number;
}

/** 这条规矩按它的分类要过的线（文字规矩是更严的那条）。 */
export function admitLineOf(l: Pick<Lesson, "checkability">, p: AdmissionPolicy): number {
  return l.checkability === "prose" ? Number(p["score.proseAdmitLine"]) : Number(p["score.admitLine"]);
}

export function bandOf(score: number, admitLine: number, dropLine: number): CalibrationBand {
  return score >= admitLine ? "high" : score <= dropLine ? "low" : "mid";
}

export function autoOf(band: CalibrationBand): CalibrationAuto {
  return band === "high" ? "admit" : band === "low" ? "reject" : "shelve";
}

export class CalibrationService {
  constructor(private readonly d: CalibrationDeps) {}

  sample(scope: AdmissionScope): CalibrationSample {
    const p = this.d.policy();
    const drop = Number(p["score.dropLine"]);
    const scored = this.d.repo
      .lessons({ status: ["pending", "confirmed", "disabled"] })
      .filter((l) => l.mergedInto === null && l.score !== null && this.inScope(scope, l))
      .sort((a, b) => a.id - b.id);
    const seed = this.d.seed?.() ?? this.d.now();
    const items: CalibrationItem[] = [];
    for (const band of BANDS) {
      const pool = scored.filter((l) => bandOf(l.score!, admitLineOf(l, p), drop) === band);
      for (const l of seededSample(pool, CALIBRATION_PER_BAND, seed + BANDS.indexOf(band)))
        items.push({ lessonId: l.id, band, score: l.score!, auto: autoOf(band) });
    }
    return { drawnAt: this.d.now(), items };
  }

  /** 判一条：skip 不记；同一条在同一次抽样里再判一次覆盖上一次。 */
  mark(lessonId: number, mark: CalibrationMark, since: number): { ok: true } | { ok: false; reason: string } {
    const l = this.d.repo.get(lessonId);
    if (!l || l.score === null) return { ok: false, reason: "not_scored" };
    const p = this.d.policy();
    const auto = autoOf(bandOf(l.score, admitLineOf(l, p), Number(p["score.dropLine"])));
    this.d.db.prepare(`DELETE FROM score_calibration WHERE source = 'review' AND lesson_id = ? AND at >= ?`).run(lessonId, since);
    if (mark === "skip") return { ok: true };
    this.d.db
      .prepare(`INSERT INTO score_calibration (entity, lesson_id, entity_id, auto_verdict, human_verdict, score, score_parts, at, source) VALUES ('lesson', ?, ?, ?, ?, ?, ?, ?, 'review')`)
      .run(lessonId, lessonId, auto, mark === "good" ? "admit" : "reject", l.score, l.scoreParts === null ? null : JSON.stringify(l.scoreParts), Math.max(this.d.now(), since));
    return { ok: true };
  }

  /** 这次抽样里已经判过的（页面恢复勾选）。 */
  marks(since: number): Record<number, CalibrationMark> {
    const out: Record<number, CalibrationMark> = {};
    for (const r of this.d.db.prepare(`SELECT lesson_id, human_verdict FROM score_calibration WHERE source = 'review' AND at >= ? AND lesson_id IS NOT NULL`).all(since) as { lesson_id: number; human_verdict: string }[])
      out[Number(r.lesson_id)] = r.human_verdict === "admit" ? "good" : "bad";
    return out;
  }

  stats(since: number | null): CalibrationStats {
    const p = this.d.policy();
    const drop = Number(p["score.dropLine"]);
    const rows = this.d.db
      .prepare(`SELECT c.lesson_id, c.human_verdict, c.score, c.source, c.at, l.checkability FROM score_calibration c LEFT JOIN lessons l ON l.id = c.lesson_id WHERE c.entity = 'lesson' AND c.score IS NOT NULL`)
      .all() as { lesson_id: number | null; human_verdict: string; score: number; source: "override" | "review"; at: number; checkability: Lesson["checkability"] }[];
    const judged = rows
      .filter((r) => r.human_verdict === "admit" || r.human_verdict === "reject")
      .map((r) => {
        const line = admitLineOf({ checkability: r.checkability ?? null }, p);
        const good = r.human_verdict === "admit";
        return { ...r, good, band: bandOf(Number(r.score), line, drop), agree: good === Number(r.score) >= line };
      });
    const rate = (xs: { agree: boolean }[]) => (xs.length ? xs.filter((x) => x.agree).length / xs.length : null);
    const latest = since === null ? [] : judged.filter((r) => r.source === "review" && Number(r.at) >= since);
    const bands: CalibrationBandStats[] = BANDS.map((band) => {
      const xs = latest.filter((r) => r.band === band);
      return { band, marked: xs.length, good: xs.filter((x) => x.good).length };
    });
    const at = this.d.calibratedAt();
    return {
      latest: { bands, agreement: rate(latest), marked: latest.length },
      all: { agreement: rate(judged), marked: judged.length, review: judged.filter((r) => r.source === "review").length, override: judged.filter((r) => r.source === "override").length },
      calibratedAt: at === "" ? null : at,
    };
  }

  markCalibrated(): string {
    const iso = new Date(this.d.now()).toISOString();
    this.d.setCalibratedAt(iso);
    return iso;
  }

  private inScope(scope: AdmissionScope, l: Lesson): boolean {
    if (scope.kind === "all") return true;
    if (scope.kind === "repo") return l.scope.kind === "repo" && l.scope.slug === scope.slug;
    if (l.scope.kind === "product") return l.scope.productId === scope.productId;
    return this.d.repo.product(scope.productId)?.slugs.includes(l.scope.slug) ?? false;
  }
}
