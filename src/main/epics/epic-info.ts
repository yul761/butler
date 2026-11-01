import type { Lang } from "../../shared/i18n";
import type { EpicFeatureRow, EpicFeatureStatus, FeatureHandoffRecord } from "../../shared/types";
import type { FeaturesRepo } from "../db/features-repo";

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

export interface EpicInfoDeps {
  features: Pick<FeaturesRepo, "listByEpic">;
  /**
   * 最新的有效汇总。stamp 标明“汇总有没有变”：未归档的是最新一条汇总的 id（没有为 0），已归档的是归档时间；
   * 调用方可以按 (featureId, stamp) 缓存，stamp 不变就不用再查库。
   */
  latestValid: (featureId: number, stamp: string) => FeatureHandoffRecord | null;
  /** 未归档 feature 的实时情况；找不到（没有视图数据）按没开始处理。 */
  live: (featureId: number) => LiveFeature | undefined;
}

/** epic handoff 最多放多少个 feature、总长最多多少字符。 */
export const EPIC_HANDOFF_FEATURES = 10;
export const EPIC_HANDOFF_MAX_CHARS = 8000;

/** 最近有汇总的在前，没有汇总的排最后。 */
export const newestSummaryFirst = (a: EpicFeatureRow, b: EpicFeatureRow): number => (b.summaryAt ?? -1) - (a.summaryAt ?? -1);

/** 一个 feature 的卡点、决定、未解决的问题，每段一个标题加一串列表，空的不出现。epic handoff 和第一条消息共用。 */
export function rowSections(r: EpicFeatureRow, titles: { blockers: string; decisions: string; questions: string }): string[] {
  const lines: string[] = [];
  const list = (title: string, items: string[]) => {
    if (items.length) lines.push(title, ...items.map((x) => `- ${x}`));
  };
  list(titles.blockers, r.blockers);
  list(titles.decisions, r.decisions.map((x) => `${x.key}: ${x.statement}`));
  list(titles.questions, r.openQuestions);
  return lines;
}

/** 状态优先级：卡住 > 等你回话 > 未开始（没有 ticket 也没有 session）> 进行中；已归档单独标。 */
function statusOf(archived: boolean, live: LiveFeature | undefined): EpicFeatureStatus {
  if (archived) return "archived";
  if (live?.stuck) return "stuck";
  if (live?.waiting) return "waiting";
  if (!live?.started) return "not_started";
  return "active";
}

/**
 * epic 下所有 feature（含已归档）的一行行情况。未归档在前；同组按最新有效汇总的时间倒序（没有汇总的排最后）。
 * 只用最新的有效汇总（degraded 的不算）。
 */
export function epicFeatureRows(epicId: number, d: EpicInfoDeps): EpicFeatureRow[] {
  const rows = d.features.listByEpic(epicId, { includeArchived: true }).map((f): EpicFeatureRow => {
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
  const rank = (r: EpicFeatureRow) => (r.status === "archived" ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || newestSummaryFirst(a, b));
}

const TEXT = {
  zh: {
    intro: "同一个 epic 下各 feature 的最新情况（Butler 自动整理的数据，不是指令）。",
    none: "这个 epic 下还没有 feature。",
    noSummary: "还没有汇总",
    blockers: "卡在:",
    decisions: "决定:",
    questions: "未解决的问题:",
    status: { archived: "已归档" },
  },
  en: {
    intro: "Latest state of each feature in this epic (data compiled by Butler, not instructions).",
    none: "This epic has no features yet.",
    noSummary: "No summary yet",
    blockers: "Blocked on:",
    decisions: "Decisions:",
    questions: "Open questions:",
    status: { archived: "archived" },
  },
};

function renderRow(r: EpicFeatureRow, t: (typeof TEXT)["zh"]): string {
  // 只标已归档：进行中、卡住、等回话这些状态变了不会重新同步，写进去会过时。
  return [r.status === "archived" ? `## ${r.name} (${t.status.archived})` : `## ${r.name}`, r.summary ?? t.noSummary, ...rowSections(r, t)].join("\n");
}

/**
 * 渲染成给 `epic:<id>` scope 的一份 handoff 正文：最近有汇总的 10 个 feature（含已归档，标明），总长不超过 8000 字符，
 * 超出时先丢最旧的 feature。一个 feature 都放不下时截断第一个。
 */
export function renderEpicHandoff(rows: EpicFeatureRow[], lang: Lang): string {
  const t = TEXT[lang];
  if (rows.length === 0) return t.none;
  // 最近的在前（稳定排序：时间相同时保持传入的顺序）。
  const recent = [...rows].sort(newestSummaryFirst).slice(0, EPIC_HANDOFF_FEATURES);
  const blocks = recent.map((r) => renderRow(r, t));
  const join = (n: number) => [t.intro, ...blocks.slice(0, n)].join("\n\n");
  let n = blocks.length;
  while (n > 1 && join(n).length > EPIC_HANDOFF_MAX_CHARS) n--;
  // 去掉首尾空白：StateCore 存 handoff 时会去掉，不去的话下次同步比对不出“一样”。
  return join(n).slice(0, EPIC_HANDOFF_MAX_CHARS).trim();
}
