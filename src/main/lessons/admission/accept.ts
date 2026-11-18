import type { BatchOrigin } from "../../../shared/batches";
import type { CheckScope } from "../../../shared/checks";
import type { Lesson, LessonScope, LessonTarget } from "../../../shared/lessons";
import type { BatchRecorder } from "../../batches/batch-recorder";
import type { ChecksService } from "../../checks/checks-service";
import type { LessonsRepo } from "../../db/lessons-repo";
import type { LessonBatchService } from "../lesson-batches";
import type { JudgmentCache } from "./judgments";
import { readCanon, readDraft } from "./model-steps";
import type { AdmissionPipeline } from "./pipeline";

/**
 * 接受（addendum 第 6 节）：一个原子批次里把计划落下去。全部从库里的状态和判断缓存推出来（重启以后也能接受）：
 * 1. 跨仓库的同义组，留下的那条提到产品层；2. 重复的合进留下的那条（不是确认过的就用规范写法）；
 * 3. 推荐的确认（admission 留着 auto）；4. 推荐的可检查规矩把缓存里的草稿写成影子检查。
 * 撤销这个批次全部还原（行、出现次数、出处、范围；新建的检查删掉）。
 */

export interface AcceptDeps {
  repo: LessonsRepo;
  recorder: BatchRecorder;
  batches: Pick<LessonBatchService, "resolve" | "calibrate">;
  checks: Pick<ChecksService, "saveIn" | "notifyChanged">;
  judgments: JudgmentCache;
  pipeline: Pick<AdmissionPipeline, "rawStep">;
  now: () => number;
}

export interface AcceptOutcome {
  batchId: number | null;
  confirmed: number;
  merged: number;
  promoted: number;
  checks: number;
}

const toCheckScope = (s: LessonScope): CheckScope => (s.kind === "repo" ? { kind: "repo", slug: s.slug } : { kind: "product", productId: s.productId });

export function acceptPlan(d: AcceptDeps, target?: LessonTarget, opts: { origin?: BatchOrigin } = {}): AcceptOutcome {
  const base: LessonTarget = target ?? { filter: {} };
  const inTarget = d.batches.resolve(base);
  const recommended = inTarget.filter((l) => l.status === "pending" && l.admission === "auto" && l.mergedInto === null);
  const keepers = new Map(recommended.map((l) => [l.id, l]));
  // 重复的：合进被推荐的那条，或者合进确认过的那条（只要重复的这条在范围里）。
  const pending = d.repo.lessons({ status: ["pending"] });
  const targetIds = new Set(inTarget.map((l) => l.id));
  const dups = new Map<number, Lesson[]>();
  for (const l of pending) {
    if (l.shelvedReason !== "duplicate" || l.shelvedRef === null || l.mergedInto !== null) continue;
    const k = keepers.get(l.shelvedRef) ?? d.repo.get(l.shelvedRef);
    if (!k || k.mergedInto !== null) continue;
    if (!keepers.has(k.id) && !(k.status === "confirmed" && targetIds.has(l.id))) continue;
    (dups.get(k.id) ?? dups.set(k.id, []).get(k.id)!).push(l);
  }
  const now = d.now();
  const out: AcceptOutcome = { batchId: null, confirmed: 0, merged: 0, promoted: 0, checks: 0 };
  const cal: Parameters<AcceptDeps["batches"]["calibrate"]>[0] = [];
  const { outcome } = d.recorder.run(
    // 原子：合并和确认必须一起撤销（只撤一半会留下重复的规矩和加过的次数）。
    { kind: "accept_recommended", origin: opts.origin ?? "manual", entity: "lesson", scope: "ids" in base ? { ids: base.ids.length } : { filter: base.filter }, summary: { atomic: true }, now },
    (ctx) => {
      for (const [keepId, drops] of dups) {
        const keeper = d.repo.get(keepId)!;
        let scope = keeper.scope;
        // 1. 跨仓库：提到同时包含这些仓库的产品。
        if (keeper.status !== "confirmed" && scope.kind === "repo") {
          const slugs = new Set([scope.slug, ...drops.flatMap((x) => (x.scope.kind === "repo" ? [x.scope.slug] : []))]);
          const product = slugs.size > 1 ? d.repo.productsOf(scope.slug).find((p) => [...slugs].every((s) => p.slugs.includes(s))) : undefined;
          if (product) {
            ctx.track("lesson", keepId);
            scope = { kind: "product", productId: product.id };
            d.repo.setScope(keepId, scope, now);
            out.promoted++;
          }
        }
        // 2. 合并。
        const text = keeper.status === "confirmed" ? keeper.text : (readCanon(d.judgments, [keeper, ...drops].map((l) => d.pipeline.rawStep(l))) ?? keeper.text);
        for (const drop of drops) {
          ctx.track("lesson", keepId);
          ctx.track("lesson", drop.id);
          for (const m of d.repo.mergedIds(drop.id)) ctx.track("lesson", m);
          d.repo.merge(keepId, drop.id, text, now);
          out.merged++;
        }
      }
      // 3. 确认；4. 草稿写成影子检查。
      for (const l of recommended) {
        const cur = d.repo.get(l.id)!;
        ctx.track("lesson", l.id);
        d.repo.setStatus(l.id, "confirmed", now);
        out.confirmed++;
        cal.push({ lesson: l, human: "admit", auto: "admit" });
        if (cur.checkability !== "checkable") continue;
        const draft = readDraft(d.judgments, d.pipeline.rawStep(l));
        if (!draft || draft.kind !== "draft") continue;
        const r = d.checks.saveIn(ctx, toCheckScope(cur.scope), null, { ...draft.draft, mode: "shadow" }, { lessonId: l.id });
        if (typeof r === "number") out.checks++;
      }
      if (!out.confirmed && !out.merged) ctx.skip();
    },
  );
  out.batchId = outcome.batchId;
  if ((opts.origin ?? "manual") === "manual") d.batches.calibrate(cal, outcome.batchId, now);
  if (out.checks) d.checks.notifyChanged();
  return out;
}
