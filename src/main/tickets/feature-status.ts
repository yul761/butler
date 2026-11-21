import type { Feature, FeatureHandoffRecord, FeatureStatus, FeatureStatusRow } from "../../shared/types";

/** 一个未归档 feature 的实时情况（取自 featureViews() 的数据，不在这里重算）。 */
export interface LiveFeature {
  /** 任何一个 ticket 的 session 卡住了。 */
  stuck: boolean;
  /** 总控或任何 ticket 在等用户回话。 */
  waiting: boolean;
  /** 有 ticket 或有 session。 */
  started: boolean;
  /** 最新一条汇总（可能是 degraded）；给了就不用再查库。 */
  summary?: FeatureHandoffRecord | null;
}

export interface FeatureStatusDeps {
  /**
   * 最新的有效汇总。stamp 标明“汇总有没有变”：未归档的是最新一条汇总的 id（没有为 0），已归档的是归档时间；
   * 调用方可以按 (featureId, stamp) 缓存，stamp 不变就不用再查库。
   */
  latestValid: (featureId: number, stamp: string) => FeatureHandoffRecord | null;
  /** 未归档 feature 的实时情况；找不到（没有视图数据）按没开始处理。 */
  live: (featureId: number) => LiveFeature | undefined;
}

/** 最近有汇总的在前，没有汇总的排最后。 */
export const newestSummaryFirst = (a: FeatureStatusRow, b: FeatureStatusRow): number => (b.summaryAt ?? -1) - (a.summaryAt ?? -1);

/** 状态优先级：卡住 > 等你回话 > 未开始（没有 ticket 也没有 session）> 进行中；已归档单独标。 */
function statusOf(archived: boolean, live: LiveFeature | undefined): FeatureStatus {
  if (archived) return "archived";
  if (live?.stuck) return "stuck";
  if (live?.waiting) return "waiting";
  if (!live?.started) return "not_started";
  return "active";
}

/**
 * 给定的 feature 一行行的情况（Butler 总控的 list_features）。未归档在前；同组按最新有效汇总的时间倒序（没有汇总的排最后）。
 * 只用最新的有效汇总（degraded 的不算）。
 */
export function featureStatusRows(features: readonly Feature[], d: FeatureStatusDeps): FeatureStatusRow[] {
  const rows = features.map((f): FeatureStatusRow => {
    const archived = f.archivedAt !== null;
    const live = archived ? undefined : d.live(f.id);
    // 实时数据里的最新汇总有效就直接用，省一次查库；无效（degraded）或没有数据时才查。
    const cached = live?.summary;
    const rec = cached && cached.payload && !cached.degraded ? cached : d.latestValid(f.id, archived ? `a${f.archivedAt}` : `l${cached?.id ?? 0}`);
    const p = rec?.payload ?? null;
    return {
      id: f.id,
      name: f.name,
      status: statusOf(archived, live),
      archivedAt: f.archivedAt,
      summaryAt: rec && p ? rec.createdAt : null,
      summary: p?.summary ?? null,
      blockers: p?.blockers ?? [],
      decisions: p?.decisions ?? [],
      openQuestions: p?.open_questions ?? [],
    };
  });
  const rank = (r: FeatureStatusRow) => (r.status === "archived" ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || newestSummaryFirst(a, b));
}
