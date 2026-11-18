// 度量从什么时候开始记：之前没有事件不代表没有人介入，「效果」页把这之前的当作基线（只看 gh 读得到的）。
import type { SettingsRepo } from "../db/settings-repo";

/** 已存的开始时间；没有（或不是数字）返回 null。 */
export function metricsSince(settings: Pick<SettingsRepo, "get">): number | null {
  const v = settings.get("metricsSince");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 幂等：已有就原样返回；没有就把现在存下来。 */
export function ensureMetricsSince(settings: Pick<SettingsRepo, "get" | "set">, now: number): number {
  const existing = metricsSince(settings);
  if (existing !== null) return existing;
  settings.set("metricsSince", String(now));
  return now;
}
