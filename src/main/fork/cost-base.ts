import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { cumulativeWeight } from "../../shared/run-cost";

/** 一个 session 存下的累计：花了多少（totalCostUSD）和它 modelUsage 的加权 token（cumulativeWeight，用来核对 CLI 真的从它接着记）。 */
export interface CostBase {
  totalUsd: number;
  weight: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 一个 session 存下的累计花费：它 transcript 里最后一条属于它自己（sessionId 相同）的 `{"type":"cost-state", "totalCostUSD": …, "modelUsage": …}`。
 * CLI（2.1.329）退出时写这一行；`--resume X`（带不带 --fork-session）从 X 最后一条合格的这一行接着记 total_cost_usd，
 * 所以分叉第一轮自己的花费 = T1 − 这个数（BTL-239，见 fork-mode 的 turnCost）。分叉之前读，跑完再读一次核对（fork-service）。
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
