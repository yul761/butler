import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * 一个 session 存下的累计花费：它 transcript 里最后一条 `{"type":"cost-state", "totalCostUSD": …}` 的 totalCostUSD。
 * CLI（2.1.329）退出时写这一行；`--resume X`（带不带 --fork-session）从 X 最后存的这一行接着记 total_cost_usd，
 * 所以分叉第一轮自己的花费 = T1 − 这个数（BTL-239，见 fork-mode 的 turnCost）。分叉之前读：开发 session 得空着，读完到 CLI 读之间不会再写。
 * 没有文件、读不了、没有 cost-state 行 → null；最后一条 cost-state 的 totalCostUSD 不是非负有限数也是 null，不往前找旧的（那是更早的累计，减了会多算）。
 * 一行一行地读（transcript 可能几十 MB），只解析含 cost-state 的行，按每行自己的 type 判断（消息正文里提到 cost-state 的不算）。坏行跳过。
 */
export async function readCostBase(file: string | null): Promise<number | null> {
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
      if (v && typeof v === "object" && !Array.isArray(v) && (v as { type?: unknown }).type === "cost-state") last = v as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  const total = last?.totalCostUSD;
  return typeof total === "number" && Number.isFinite(total) && total >= 0 ? total : null;
}
