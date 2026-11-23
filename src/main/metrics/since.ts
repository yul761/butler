// 度量从什么时候开始记：之前没有事件不代表没有人介入，「效果」页把这之前的当作基线（只看 gh 读得到的）。
import type { SettingsRepo } from "../db/settings-repo";

/** 已存的开始时间；没有（或不是数字）返回 null。 */
export function metricsSince(settings: Pick<SettingsRepo, "get">): number | null {
  const v = settings.get("metricsSince");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 基线截止点（ws-h）：第一次有 Shipherd session 时存下来，之后不再变（最早的 session 被删、或者
 * 旧的发现 session 改成 Shipherd 的，都不会把截止点挪动、把 Shipherd 期间的 PR 当成基线）。
 * 还没有 Shipherd session 时用度量开始的时间，不存。
 */
export function baselineCutoffOf(settings: Pick<SettingsRepo, "get" | "set">, firstShipherdSessionAt: () => number | null, since: number): number {
  const v = Number(settings.get("metricsBaselineCutoff") ?? "");
  if (Number.isFinite(v) && v > 0) return v;
  const first = firstShipherdSessionAt();
  if (first === null) return since;
  settings.set("metricsBaselineCutoff", String(first));
  return first;
}

/** 幂等：已有就原样返回；没有就把现在存下来。 */
export function ensureMetricsSince(settings: Pick<SettingsRepo, "get" | "set">, now: number): number {
  const existing = metricsSince(settings);
  if (existing !== null) return existing;
  settings.set("metricsSince", String(now));
  return now;
}
