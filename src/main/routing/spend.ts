import { isModelName, isTier, type Quota, type QuotaView, type RegistryModel, type SpendLevel, type SpendLine, type Tier } from "../../shared/model-routing";
import type { SpendRow } from "../db/usage-repo";

export const DEFAULT_THRESHOLDS: readonly [number, number] = [0.7, 0.9];

/** 本周期开始：本地时间每月 startDay 号 0 点（1–28），取不晚于 now 的最近一个。 */
export function periodStart(now: number, startDay: number): number {
  const day = Math.min(28, Math.max(1, Math.trunc(startDay) || 1));
  const d = new Date(now);
  let start = new Date(d.getFullYear(), d.getMonth(), day);
  if (start.getTime() > now) start = new Date(d.getFullYear(), d.getMonth() - 1, day);
  return start.getTime();
}

export function periodEnd(start: number): number {
  const d = new Date(start);
  return new Date(d.getFullYear(), d.getMonth() + 1, d.getDate()).getTime();
}

/** "70,90" → [0.7, 0.9]；不合法回到默认。第二个必须大于第一个。 */
export function parseThresholds(v: string | null | undefined): [number, number] {
  const parts = (v ?? "").split(",").map((x) => Number(x.trim()));
  if (parts.length !== 2 || parts.some((p) => !Number.isFinite(p) || p <= 0 || p > 100) || parts[0]! >= parts[1]!) return [...DEFAULT_THRESHOLDS];
  return [parts[0]! / 100, parts[1]! / 100];
}

export function validQuotaTarget(target: string): boolean {
  if (target.startsWith("tier:")) return isTier(target.slice(5));
  if (target.startsWith("model:")) return isModelName(target.slice(6));
  return false;
}

/** routingQuotas 设置（JSON 数组）→ 配额；不合法的条目丢掉。 */
export function parseQuotas(v: string | null | undefined): Quota[] {
  if (!v) return [];
  try {
    const arr = JSON.parse(v) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.flatMap((q): Quota[] => {
      if (typeof q !== "object" || q === null) return [];
      const { target, unit, monthly } = q as Record<string, unknown>;
      if (typeof target !== "string" || !validQuotaTarget(target)) return [];
      if (unit !== "usd" && unit !== "tokens") return [];
      if (typeof monthly !== "number" || !Number.isFinite(monthly) || monthly <= 0) return [];
      return [{ target, unit, monthly }];
    });
  } catch {
    return [];
  }
}

/**
 * 用量行里的模型名对应注册表里的哪个模型：完全相同；或者注册表里写的是别名（只有小写字母，如 opus），
 * 用量里是 CLI 解析出的全名（claude-opus-…）。
 */
export function registryModelFor(registry: readonly RegistryModel[], usageModel: string | null): RegistryModel | null {
  if (!usageModel) return null;
  const exact = registry.find((m) => m.name === usageModel);
  if (exact) return exact;
  const lower = usageModel.toLowerCase();
  return registry.find((m) => /^[a-z]+$/.test(m.name) && (lower.startsWith(`${m.name}-`) || lower.includes(`-${m.name}-`) || lower.endsWith(`-${m.name}`))) ?? null;
}

function usdOf(r: SpendRow, m: RegistryModel | null): { usd: number; partial: boolean } {
  let usd = r.costUsd;
  let partial = false;
  if (r.unpricedRows > 0) {
    if (m && m.priceIn !== null && m.priceOut !== null) usd += (r.unpricedInput * m.priceIn + r.unpricedOutput * m.priceOut) / 1e6;
    else partial = true;
  }
  return { usd, partial };
}

export interface SpendSummary {
  byModel: SpendLine[];
  byTask: SpendLine[];
  quotas: QuotaView[];
  /** 这个模型（档位）现在的阈值级别：针对它或它所在档的配额里最高的那个。 */
  level: (model: string, tier: Tier) => SpendLevel;
}

function add(map: Map<string, SpendLine>, key: string, tokens: number, usd: number, partial: boolean): void {
  const cur = map.get(key) ?? { key, tokens: 0, usd: 0, usdPartial: false };
  cur.tokens += tokens;
  cur.usd += usd;
  cur.usdPartial ||= partial;
  map.set(key, cur);
}

export function summarizeSpend(rows: readonly SpendRow[], registry: readonly RegistryModel[], quotas: readonly Quota[], thresholds: [number, number]): SpendSummary {
  const byModel = new Map<string, SpendLine>();
  const byTask = new Map<string, SpendLine>();
  // 配额用：按注册表模型名和档位汇总。
  const regSpend = new Map<string, { tokens: number; usd: number }>();
  const tierSpend = new Map<Tier, { tokens: number; usd: number }>();
  for (const r of rows) {
    const m = registryModelFor(registry, r.model);
    const { usd, partial } = usdOf(r, m);
    add(byModel, r.model ?? "(default)", r.tokens, usd, partial);
    add(byTask, r.task ?? "(interactive)", r.tokens, usd, partial);
    if (m) {
      const a = regSpend.get(m.name) ?? { tokens: 0, usd: 0 };
      regSpend.set(m.name, { tokens: a.tokens + r.tokens, usd: a.usd + usd });
      const b = tierSpend.get(m.tier) ?? { tokens: 0, usd: 0 };
      tierSpend.set(m.tier, { tokens: b.tokens + r.tokens, usd: b.usd + usd });
    }
  }
  const levelOf = (ratio: number): SpendLevel => (ratio >= thresholds[1] ? "hard" : ratio >= thresholds[0] ? "soft" : "ok");
  const views: QuotaView[] = quotas.map((q) => {
    const s = q.target.startsWith("tier:") ? tierSpend.get(q.target.slice(5) as Tier) : regSpend.get(q.target.slice(6));
    const used = q.unit === "usd" ? (s?.usd ?? 0) : (s?.tokens ?? 0);
    const ratio = used / q.monthly;
    return { ...q, used, ratio, level: levelOf(ratio) };
  });
  const rank = (l: SpendLevel) => (l === "hard" ? 2 : l === "soft" ? 1 : 0);
  const level = (model: string, tier: Tier): SpendLevel => {
    const reg = registryModelFor(registry, model);
    let best: SpendLevel = "ok";
    for (const v of views) {
      const hits = v.target === `model:${model}` || (reg !== null && v.target === `model:${reg.name}`) || v.target === `tier:${reg?.tier ?? tier}`;
      if (hits && rank(v.level) > rank(best)) best = v.level;
    }
    return best;
  };
  const sort = (m: Map<string, SpendLine>) => [...m.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
  return { byModel: sort(byModel), byTask: sort(byTask), quotas: views, level };
}
