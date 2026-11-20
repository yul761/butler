import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { cumulativeWeight, runCostFromCumulative, runWeight } from "../../shared/run-cost";
import { findTranscript } from "../sessions/discovery";

/** 一个 session 存下的累计：花了多少（totalCostUSD）和它 modelUsage 的加权 token（cumulativeWeight，用来核对 CLI 真的从它接着记）。 */
export interface CostBase {
  totalUsd: number;
  weight: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 一个 session 存下的累计花费：它 transcript 里最后一条属于它自己（sessionId 相同）的 `{"type":"cost-state", "totalCostUSD": …, "modelUsage": …}`。
 * CLI（2.1.329）退出时写这一行；`--resume X`（带不带 --fork-session）从 X 最后一条合格的这一行接着记 total_cost_usd，
 * 所以分叉第一轮自己的花费 = T1 − 这个数（BTL-239，costSinceBase）。分叉之前读，跑完再读一次核对（fork-service、headless-exec）。
 * 没有文件、读不了、没有这样的行 → null。最后一条不合用也是 null，不往前找旧的（CLI 的校验比这里严，猜它会退回哪一条不如不用）：
 * totalCostUSD 不是非负有限数、modelUsage 不是对象（CLI 的校验也过不了，不会从它接着记），或者 hasUnknownModelCost（有模型 CLI 不会定价，减出来的 0 不是真的 0）。
 * 一行一行地读（transcript 可能几十 MB），只解析含 cost-state 的行，按每行自己的 type 判断（消息正文里提到 cost-state 的不算）。坏行跳过。
 */
export async function readCostBase(file: string | null, sessionId: string): Promise<CostBase | null> {
  if (!file) return null;
  let last: Record<string, unknown> | null = null;
  try {
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"cost-state')) continue;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        continue;
      }
      if (isObj(v) && v.type === "cost-state" && v.sessionId === sessionId) last = v;
    }
  } catch {
    return null;
  }
  if (!last || last.hasUnknownModelCost === true) return null;
  const total = last.totalCostUSD;
  const weight = cumulativeWeight(last.modelUsage);
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0 || weight === null) return null;
  return { totalUsd: total, weight };
}

/** 两次读到的是同一条（分叉跑的时候开发 session 没有退出、写下新的累计）。 */
export const sameBase = (a: CostBase | null, b: CostBase | null): boolean => a !== null && b !== null && a.totalUsd === b.totalUsd && a.weight === b.weight;

/** 按 session id 在 ~/.claude/projects 下找它的 transcript 再读 base（index 给分叉讨论、handoff、feature 汇总接的就是这个）。 */
export function transcriptCostBase(projectsDir: string, sessionId: string): Promise<CostBase | null> {
  return readCostBase(findTranscript(projectsDir, sessionId), sessionId);
}

/** 一轮 CLI 结果里算准数要用的：累计的 total_cost_usd、这一轮的 usage（API 形状）、累计的 modelUsage、这一轮的模型。 */
export interface CumulativeRun {
  costUsd: number | null;
  usageRaw?: unknown;
  modelUsage?: unknown;
  model?: string | null;
}

/** base 比 T1 大多少算浮点误差。 */
const TOTAL_EPS = 1e-9;
/** 累计权重比 base 加这一轮少多少算浮点误差。 */
const WEIGHT_EPS = 1e-9;
/**
 * T1 − base 比份额估算的这么多分之一还少，就不信 base。份额是约数：固定权重跟真实价格比差得最多的是读缓存（0.1 对 0.025–0.05），
 * 这一轮跟累计的 token 构成差得越多偏得越多，按真实历史是 −17% 到 +38%，极端的构成也就几倍；十倍以上只能是 CLI 接的不是这个 base。
 */
const UNDERCOUNT_FACTOR = 10;

/**
 * 分叉出来的第一轮（--resume X --fork-session）自己的准数：T1 − base（base 是 X 存下的累计，起跑前读、跑完核对过没变）。
 * CLI 从 X 最后一条合格的 cost-state 接着记，所以 total 里减掉它就是这一轮。下面任何一条不成立就返回 null，调用方退回约数或者不记：
 * - 有 total、有 base，base 不比 T1 大（超过浮点误差）；
 * - CLI 真的从 base 接着记了：这一轮的累计（modelUsage）装得下 base 的累计加上这一轮（Σw(modelUsage) ≥ w(base) + w(usage)）。
 *   没读回（CLI 的校验比 readCostBase 严，或者退回了更早的一条）时累计会比这小；没有 modelUsage 或 usage 就核对不了。
 * - 不比份额估算少得离谱（UNDERCOUNT_FACTOR）。上一条挡不住这种：CLI 退回了更早、更小的一条，这一轮的 subagent / compaction 调用又把累计撑大
 *   （它们在 modelUsage 里、不在 usage 里），核对照样过，T1 − base 却少算，甚至成 0。
 */
export function costSinceBase(r: CumulativeRun, base: CostBase | null): number | null {
  const total = r.costUsd;
  if (total === null || base === null || base.totalUsd > total + TOTAL_EPS) return null;
  const all = cumulativeWeight(r.modelUsage);
  const run = runWeight(r.usageRaw);
  if (all === null || run === null || run <= 0 || all < (base.weight + run) * (1 - WEIGHT_EPS)) return null;
  const diff = Math.max(0, total - base.totalUsd);
  const share = runCostFromCumulative(total, r.usageRaw, r.modelUsage, r.model ?? null);
  if (share !== null && diff * UNDERCOUNT_FACTOR < share.usd) return null;
  return diff;
}
