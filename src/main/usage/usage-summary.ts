import type { UsageRow } from "../db/usage-repo";
import type { UsageKind, UsageSummary } from "../../shared/types";

/** 相对价格（Opus 的比例，基础输入 = 1）。只用来算占比，不换算金额。 */
export const USAGE_WEIGHTS = { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 } as const;
export const USAGE_WINDOW_MS = 7 * 24 * 60 * 60_000;

const OVER_CONTEXT = 200_000;

const weightOf = (r: UsageRow): number =>
  r.input * USAGE_WEIGHTS.input + r.cacheWrite5m * USAGE_WEIGHTS.cacheWrite5m + r.cacheWrite1h * USAGE_WEIGHTS.cacheWrite1h +
  r.cacheRead * USAGE_WEIGHTS.cacheRead + r.output * USAGE_WEIGHTS.output;

/** 汇总 sinceMs 之后的用量：token 总数，以及按价格权重折算的各类占比。 */
export function summarizeUsage(
  rows: UsageRow[],
  kindOf: (sessionId: string | null) => "ticket" | "coordinator",
  sinceMs: number,
): UsageSummary {
  let totalTokens = 0;
  let total = 0;
  let cacheRead = 0;
  let over200k = 0;
  const kindSum: Record<UsageKind, number> = { ticket: 0, coordinator: 0, subagent: 0, headless: 0 };
  const modelSum: Record<string, number> = {};

  for (const r of rows) {
    if (r.at < sinceMs) continue;
    const w = weightOf(r);
    totalTokens += r.input + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead + r.output;
    total += w;
    cacheRead += r.cacheRead * USAGE_WEIGHTS.cacheRead;
    if (r.context >= OVER_CONTEXT) over200k += w;
    const kind: UsageKind = r.source === "subagent" ? "subagent" : r.source === "headless" ? "headless" : kindOf(r.sessionId);
    kindSum[kind] += w;
    const model = r.model ?? "unknown";
    modelSum[model] = (modelSum[model] ?? 0) + w;
  }

  const share = (n: number): number => (total > 0 ? n / total : 0);
  const byModel: Record<string, number> = {};
  for (const [m, n] of Object.entries(modelSum)) byModel[m] = share(n);
  return {
    sinceMs,
    totalTokens,
    cacheReadShare: share(cacheRead),
    over200kShare: share(over200k),
    byKind: { ticket: share(kindSum.ticket), coordinator: share(kindSum.coordinator), subagent: share(kindSum.subagent), headless: share(kindSum.headless) },
    byModel,
  };
}
