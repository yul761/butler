import type { Pr } from "../../shared/handoff";
import type { FeatureHandoffOutcome, FeatureView, TicketView } from "../../shared/types";
import { S } from "./strings";

/** 组标题里只放一句话，太长就截断。 */
const SENTENCE_MAX = 80;

/**
 * 汇总的第一句话（简报的 feature 组标题用）：到第一个句末标点（含）或换行为止，最长 80 个字符。
 * 英文的 . ! ? 后面要跟空白或结尾才算句末，免得在 api.ts、v1.2 这种地方截断。
 */
export function firstSentence(text: string): string {
  const t = text.trim();
  const m = /[。！？]|[.!?](?=\s|$)|\n/.exec(t);
  const s = m ? t.slice(0, m[0] === "\n" ? m.index : m.index + 1).trimEnd() : t;
  const chars = Array.from(s);
  return chars.length > SENTENCE_MAX ? `${chars.slice(0, SENTENCE_MAX - 1).join("")}…` : s;
}

/** 最新一份有效汇总的第一句话；没有汇总或最新一份是 degraded 时为 null。 */
export function featureHeadline(f: FeatureView): string | null {
  const summary = f.summary?.payload?.summary;
  return summary ? firstSentence(summary) : null;
}

/**
 * 简报的“上个工作日”和晚间小结按 feature 分组（设计文档 2026-10-28）：保持原顺序，组按第一次出现的位置排；
 * 单独的 ticket、已归档或找不到的 ticket 都放在 feature 为 null 的组。
 */
export function groupByFeature<T extends { ticketKey: string }>(
  entries: T[],
  tickets: TicketView[],
  features: FeatureView[],
): { feature: FeatureView | null; entries: T[] }[] {
  const groups = new Map<number | null, { feature: FeatureView | null; entries: T[] }>();
  for (const e of entries) {
    const feature = featureOfTicket(e.ticketKey, tickets, features);
    const id = feature?.id ?? null;
    const g = groups.get(id) ?? { feature, entries: [] };
    g.entries.push(e);
    groups.set(id, g);
  }
  return [...groups.values()];
}

/** ticket 所属的（未归档的）feature；单独的 ticket 或找不到时为 null。早间简报的 feature 小标签也用它。 */
export function featureOfTicket(key: string, tickets: TicketView[], features: FeatureView[]): FeatureView | null {
  const featureId = tickets.find((t) => t.key === key)?.featureId ?? null;
  return featureId === null ? null : (features.find((f) => f.id === featureId) ?? null);
}

export type PrPill = "merged" | "approved" | "changes" | "pending" | "closed";

/** PR 标签的种类（feature 页 ticket 表的颜色和文字）。 */
export function prPill(pr: Pr): PrPill {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.review === "approved") return "approved";
  if (pr.review === "changes_requested") return "changes";
  return "pending";
}

/** PR 的名字：只有一个时是 #号，几个（多仓库）时带上仓库名。 */
export function prLabel(pr: { number: number; url: string }, all: { url: string }[]): string {
  const repo = all.length > 1 ? /github\.com\/[^/]+\/([^/]+)\/pull\//.exec(pr.url)?.[1] : undefined;
  return repo ? `${repo}#${pr.number}` : `#${pr.number}`;
}

/** “立即更新”的结果，用人话说。 */
export function summaryOutcomeMessage(o: FeatureHandoffOutcome): string {
  if (o.status === "stored") return o.degraded ? S.featureSummaryStoredDegraded : S.featureSummaryStored;
  if (o.status === "skipped") return S.featureSummarySkipped[o.reason] ?? o.reason;
  return S.featureSummaryFailed(o.message);
}

/**
 * “立即更新”的结果要不要按错误显示：失败、被限流、存下的是 degraded 时是；
 * nothing_to_summarize 只是告诉用户还没东西可写，按普通提示显示。
 */
export function summaryOutcomeIsError(o: FeatureHandoffOutcome): boolean {
  if (o.status === "stored") return o.degraded;
  if (o.status === "skipped") return o.reason === "rate_limited";
  return true;
}
