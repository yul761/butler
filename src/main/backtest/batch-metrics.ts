// 批次指标（工作流 F 第 10 节，接 D 的 BatchMetricsProvider）：覆盖率和整批回测。
import type { Db } from "../db/database";
import type { BacktestRepo } from "../db/backtest-repo";
import type { BatchMetricsProvider } from "../lessons/admission/batch-review";

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * 覆盖率：批次里判过的规矩（都来自 avoidable 的评论），被这批接受、已经被检查或 lint 管住（covered）、或者已经有启用的检查的，占多少。
 * 判成重复的不进分母（留下的那条代表它）。整批回测：这批接受的规矩各取最新一次草稿的回测（每个仓库最新一条），
 * 召回 = Σ命中评论 / Σ评论，误报 = Σ误报，误报率 = Σ误报 / Σ命中。
 */
export function backtestBatchMetrics(d: { db: Db; repo: BacktestRepo }): BatchMetricsProvider {
  return {
    metrics(batchId) {
      const items = d.db.prepare(`SELECT entity_id, after FROM admission_batch_items WHERE batch_id = ? AND entity = 'lesson'`).all(batchId) as { entity_id: number; after: string | null }[];
      if (!items.length) return null;
      const hasCheck = d.db.prepare(`SELECT 1 FROM checks WHERE lesson_id = ? AND enabled = 1 LIMIT 1`);
      let denom = 0;
      let covered = 0;
      const admitted: number[] = [];
      for (const it of items) {
        let s: { admission?: unknown; status?: unknown; shelved_reason?: unknown } = {};
        try {
          s = it.after ? (JSON.parse(it.after) as typeof s) : {};
        } catch {
          s = {};
        }
        if (it.after === null || s.shelved_reason === "duplicate") continue;
        const ok = s.admission === "auto" || s.admission === "manual" || s.status === "confirmed";
        if (s.admission !== "auto" && s.admission !== "manual" && s.admission !== "shelved" && s.status !== "confirmed") continue;
        denom++;
        if (ok) admitted.push(Number(it.entity_id));
        if (ok || s.shelved_reason === "covered" || hasCheck.get(Number(it.entity_id))) covered++;
      }
      let comments = 0;
      let matched = 0;
      let hits = 0;
      let fps = 0;
      let any = false;
      const latestDef = d.db.prepare(`SELECT def_hash FROM check_backtests WHERE lesson_id = ? AND status = 'done' ORDER BY created_at DESC, id DESC LIMIT 1`);
      for (const id of admitted) {
        const def = latestDef.get(id) as { def_hash: string } | undefined;
        if (!def) continue;
        for (const r of d.repo.latestAll(def.def_hash)) {
          if (r.status !== "done") continue;
          any = true;
          comments += r.comments;
          matched += r.commentsMatched;
          hits += r.hits;
          fps += r.falsePositives;
        }
      }
      return {
        coverage: denom ? r3(covered / denom) : null,
        backtestRecall: comments ? r3(matched / comments) : null,
        backtestFalsePositives: any ? fps : null,
        backtestFalsePositiveRate: hits ? r3(fps / hits) : null,
      };
    },
  };
}
