import type { CiTriageRepo } from "../db/ci-triage-repo";
import type { CommentItemsRepo } from "../db/comment-items-repo";
import type { LoopEffect } from "../../shared/loop";

/** 效果页最多列几个 flaky。 */
export const TOP_FLAKY = 10;
export const EFFECT_DAYS_DEFAULT = 30;

/** IPC loop:effect 的天数：1–365 的整数，别的按默认 30。 */
export function effectDays(v: unknown): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 365 ? v : EFFECT_DAYS_DEFAULT;
}

/** 给 H 的「效果」页（设计补充第 5 节）：评论闭环和 CI 分类在一段时间里做了什么。只读。 */
export class LoopStats {
  constructor(private readonly d: { comments: Pick<CommentItemsRepo, "stats">; triage: Pick<CiTriageRepo, "stats" | "flakyEntries"> }) {}

  summary(r: { since: number; until: number }): LoopEffect {
    const c = this.d.comments.stats(r.since, r.until);
    const t = this.d.triage.stats(r.since, r.until);
    const top = this.d.triage.flakyEntries(r.since, TOP_FLAKY * 3).filter((e) => e.count > 0).slice(0, TOP_FLAKY);
    return {
      since: r.since, until: r.until,
      comments: {
        autoHandled: c.addressed, byWho: { copilot: c.addressedCopilot, human: c.addressedHuman }, delivered: c.delivered, replied: c.replied, resolved: c.resolved, waitingForYou: c.waiting,
      },
      ci: {
        triaged: t.triaged, byCategory: { env: t.env, flaky: t.flaky, code: t.code }, reruns: t.reruns, passedAfterRerun: t.passed, deliveredAsCode: t.deliveredAsCode,
        possiblyFlaky: t.possiblyFlaky, flakyWastedMs: t.wastedMs,
        topFlaky: top.map((e) => ({ repoSlug: e.repoSlug, kind: e.kind, name: e.name, count: e.count, wastedMs: e.wastedMs, listed: e.listed !== null })),
      },
    };
  }
}
