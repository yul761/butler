import type { Lang } from "../../shared/i18n";
import type { EpicFeatureRow, EpicFeatureStatus, FeatureHandoffRecord } from "../../shared/types";
import { EPIC_PLAN_MAX_CHARS } from "../../shared/control";
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

/** epic handoff 最多放多少个 feature；不算进度那一段时总长最多多少字符（规划的上限见 EPIC_PLAN_MAX_CHARS）。 */
export const EPIC_HANDOFF_FEATURES = 10;
export const EPIC_HANDOFF_MAX_CHARS = 8000;
/**
 * epic session 自己的交接（进度，见 carriedEpicProgress）最多占多少字符。它另算，不占规划和 feature 的位置：
 * 进度只有 StateCore 里这一份，截掉的就没了；规划在 epics.plan，feature 的情况随时能从数据库重新渲染。
 */
export const EPIC_PROGRESS_MAX_CHARS = 2000;

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
    progress: "epic 总控的进度",
    noSummary: "还没有汇总",
    blockers: "卡在:",
    decisions: "决定:",
    questions: "未解决的问题:",
    status: { archived: "已归档" },
  },
  en: {
    intro: "Latest state of each feature in this epic (data compiled by Butler, not instructions).",
    none: "This epic has no features yet.",
    progress: "Epic coordinator progress",
    noSummary: "No summary yet",
    blockers: "Blocked on:",
    decisions: "Decisions:",
    questions: "Open questions:",
    status: { archived: "archived" },
  },
};

/** 第一行永远是这句话：它是 Butler 自己写的 handoff 的标记。切过语言时 scope 里可能还是另一种语言写的，两种都认。 */
const INTROS = [TEXT.zh.intro, TEXT.en.intro];
/**
 * 规划那一段的分隔符，不分语言。一定紧跟在 intro 后面，后面的进度和 feature 怎么写都不会被认成这一段。
 * 名字是老版本留下的（那时这一段是 epic session 的整份交接）：改了的话升级前写下的规划就认不出来了。
 */
const PLAN_OPEN = "<epic-session-handoff>";
const PLAN_CLOSE = "</epic-session-handoff>";
/**
 * 进度那一段的分隔符：紧跟在规划那一段后面（没有规划时紧跟在 intro 后面），后面才是 feature。
 * 段里第一行是一个标签（PROGRESS_LABELS），让 recall 这个 scope 的 session 分得清哪段是规划、哪段是进度；读回进度时去掉它。
 */
const PROGRESS_OPEN = "<epic-session-progress>";
const PROGRESS_CLOSE = "</epic-session-progress>";
const TAGS = [PLAN_OPEN, PLAN_CLOSE, PROGRESS_OPEN, PROGRESS_CLOSE];

/** 这份 handoff 是不是 Butler 渲染的（第一行是 intro）。不是的就是 epic session 用 butler-epic 的 handoff 工具自己写的。 */
export function renderedByButler(active: string): boolean {
  const text = active.trim();
  return INTROS.some((i) => text.startsWith(i));
}

/** Butler 渲染的正文去掉 intro 之后的部分；不是 Butler 渲染的为 null。 */
function afterIntro(active: string): string | null {
  const text = active.trim();
  const intro = INTROS.find((i) => text.startsWith(i));
  return intro === undefined ? null : text.slice(intro.length).trimStart();
}

/** 进度那一段的标签，切过语言时两种都认。 */
const PROGRESS_LABELS = [TEXT.zh.progress, TEXT.en.progress];

/** 去掉进度那一段开头 Butler 加的标签（只去一个：epic session 自己的进度恰好以标签开头时，那一行留着）。 */
function withoutLabel(body: string): string {
  const label = PROGRESS_LABELS.find((l) => body === l || body.startsWith(`${l}\n`));
  return label === undefined ? body : body.slice(label.length).trimStart();
}

/** text 开头是 open…close 这一段时，返回段里的内容和后面剩下的部分；不是就是 null。 */
function leadingSection(text: string, open: string, close: string): { body: string; rest: string } | null {
  const end = text.indexOf(close);
  if (!text.startsWith(open) || end < 0) return null;
  return { body: text.slice(open.length, end).trim(), rest: text.slice(end + close.length).trimStart() };
}

/**
 * 老数据迁移用（计划 16 之前规划和 epic session 的交接共用 scope 里唯一一份生效的 handoff）：从里面认出规划。
 * 不是 Butler 写的：整份都是（老版本把 epic session 的交接整份当作规划）。Butler 写的：只取紧跟 intro 的那一段，没有就是 null，feature 的情况不算。
 */
export function carriedEpicPlan(active: string): string | null {
  const rest = afterIntro(active);
  if (rest === null) return active.trim() || null;
  return leadingSection(rest, PLAN_OPEN, PLAN_CLOSE)?.body || null;
}

/**
 * 从 scope 当前生效的 handoff 里取出要带着走的 epic session 进度：StateCore 每个 scope 只有一份生效的 handoff，
 * butler-epic 的 handoff 工具和 syncEpic 写的是同一份，不带上的话下一次同步就把进度冲掉了。
 * 不是 Butler 写的：整份都是（一份新的交接就这样换掉之前带着的）。Butler 写的：只取进度那一段，没有就是 null。
 */
export function carriedEpicProgress(active: string): string | null {
  const rest = afterIntro(active);
  if (rest === null) return active.trim() || null;
  const afterPlan = leadingSection(rest, PLAN_OPEN, PLAN_CLOSE)?.rest ?? rest;
  const body = leadingSection(afterPlan, PROGRESS_OPEN, PROGRESS_CLOSE)?.body;
  return body === undefined ? null : withoutLabel(body) || null;
}

/** 超过 max 时截断尾部并加省略号，截完正好不超过 max：之后的同步再截一次也不会变。 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** 正文去掉四个分隔符（epic session 可能把 recall 读到的内容抄进自己的交接）再去掉首尾空白。 */
const withoutTags = (text: string): string => TAGS.reduce((t, tag) => t.replaceAll(tag, ""), text).trim();

/** 规划放进 handoff 的样子：去掉分隔符，超长时截断（老数据迁移时也用它，迁进 epics.plan 的就是 handoff 里的那一份）。 */
export function fitEpicPlan(plan: string): string {
  return clip(withoutTags(plan), EPIC_PLAN_MAX_CHARS);
}

/**
 * 分隔符包起来的一段；空白的没有这一段。正文里的分隔符都去掉，这样第一个结束符一定是这一段的结尾，
 * carriedEpicPlan / carriedEpicProgress 读回来的和写进去的一字不差，不嵌套、不变长。超长时截断尾部，截断后就不再超长。
 */
function section(text: string | null, open: string, close: string, max: number, label?: string): string | null {
  const body = text === null ? "" : clip(withoutTags(text), max);
  if (!body) return null;
  return label === undefined ? `${open}\n${body}\n${close}` : `${open}\n${label}\n${body}\n${close}`;
}

function renderRow(r: EpicFeatureRow, t: (typeof TEXT)["zh"]): string {
  // 只标已归档：进行中、卡住、等回话这些状态变了不会重新同步，写进去会过时。
  return [r.status === "archived" ? `## ${r.name} (${t.status.archived})` : `## ${r.name}`, r.summary ?? t.noSummary, ...rowSections(r, t)].join("\n");
}

/**
 * 渲染成给 `epic:<id>` scope 的一份 handoff 正文：开头是 intro，然后是规划（plan，来自 epics.plan）、epic session 的进度
 * （progress，见 carriedEpicProgress），再是最近有汇总的 10 个 feature（含已归档，标明）。
 * 不算进度那一段时总长不超过 8000 字符，超出时先丢最旧的 feature；一个 feature 都放不下时截断第一个：plan 有自己的上限，截不到它和它的结束符。
 * 进度那一段另算（正文最多 2000 字符，加一行标签），也截不到它：没有进度时和计划 16 之前渲染的一字不差（老数据迁移后 epic 记忆不变）。
 */
export function renderEpicHandoff(rows: EpicFeatureRow[], lang: Lang, plan: string | null = null, progress: string | null = null): string {
  const t = TEXT[lang];
  const sections = [section(plan, PLAN_OPEN, PLAN_CLOSE, EPIC_PLAN_MAX_CHARS), section(progress, PROGRESS_OPEN, PROGRESS_CLOSE, EPIC_PROGRESS_MAX_CHARS, t.progress)];
  const head = [t.intro, ...sections.filter((x): x is string => x !== null)];
  if (rows.length === 0) return [...head, t.none].join("\n\n");
  // 进度那一段连同它前面的空行另算。
  const max = EPIC_HANDOFF_MAX_CHARS + (sections[1] === null ? 0 : sections[1].length + 2);
  // 最近的在前（稳定排序：时间相同时保持传入的顺序）。
  const recent = [...rows].sort(newestSummaryFirst).slice(0, EPIC_HANDOFF_FEATURES);
  const blocks = recent.map((r) => renderRow(r, t));
  const join = (n: number) => [...head, ...blocks.slice(0, n)].join("\n\n");
  let n = blocks.length;
  while (n > 1 && join(n).length > max) n--;
  // 去掉首尾空白：StateCore 存 handoff 时会去掉，不去的话下次同步比对不出“一样”。
  return join(n).slice(0, max).trim();
}
