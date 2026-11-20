import type { UsageRow } from "../db/usage-repo";
import { jobOf, type UsageReport } from "../handoff/headless-exec";

/**
 * 一次 headless 运行（handoff、feature 汇总、卡住判断、分叉讨论）的用量行。
 * 走路由的（有 task）带任务、档位、降级来源；costUsd 只要给了就写（分叉讨论不走路由，也要记金额）。两边传的都是这一轮自己的（runUsd、turnCost），不是 CLI 的累计 total。
 */
export function headlessUsageRow({ runId, label, at, model, usage, task, requestedTier, fallbackFrom, costUsd, ticketKey }: UsageReport): UsageRow {
  return {
    messageId: `headless:${runId}`, sessionId: null, agentId: null, source: "headless", job: jobOf(label), at, model, ...usage, ticketKey: ticketKey ?? null,
    context: usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead,
    ...(task !== undefined && { task, requestedTier: requestedTier ?? null, fallbackFrom: fallbackFrom ?? null }),
    ...((task !== undefined || costUsd !== undefined) && { costUsd: costUsd ?? null }),
  };
}
