// 进度页和 PR 进度 tab 共用的文字和小计算（ws-b）：不碰 React，便于测试。
import type { ProgressPr, ProgressStackNode, WaitingOn } from "../../shared/progress";
import { S } from "./strings";

/** 时间点给人看：月/日 时:分。 */
export function shortTime(ms: number): string {
  return new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 从 since 到 now 多久：刚刚 / n 分钟 / n 小时 m 分钟 / n 天 m 小时。不知道为 —。 */
export function sinceText(since: number | null, now: number): string {
  if (since === null) return S.progress.unknownSince;
  const minutes = Math.max(0, Math.floor((now - since) / 60_000));
  if (minutes < 1) return S.durationNow;
  if (minutes < 60) return S.durationMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return S.durationHours(hours, minutes % 60);
  return S.progress.durationDays(Math.floor(hours / 24), hours % 24);
}

/** 在等谁：「reviewer：alice、bob」；没点名时只有角色。 */
export function waitingText(w: WaitingOn): string {
  const who = S.progress.who[w.who];
  return w.names.length > 0 ? S.labelled(who, w.names.join(", ")) : who;
}

/** 「app#12」。 */
export const prRef = (p: Pick<ProgressPr, "repo" | "number">): string => `${p.repo}#${p.number}`;

/** 叠放树按深度摊平，给列表缩进用。 */
export function flattenStack(nodes: ProgressStackNode[], depth = 0): { pr: ProgressPr; depth: number }[] {
  return nodes.flatMap((n) => [{ pr: n.pr, depth }, ...flattenStack(n.children, depth + 1)]);
}

/** 汇总条每一段的宽度（百分比）；总数为 0 时都是 0。 */
export function segmentWidths<K extends string>(counts: Record<K, number>, keys: readonly K[], total: number): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, total === 0 ? 0 : (counts[k] / total) * 100])) as Record<K, number>;
}
