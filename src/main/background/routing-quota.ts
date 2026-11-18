import type { SpendLevel, TaskId, Tier } from "../../shared/model-routing";
import type { Plan } from "../routing/router";
import type { SpendSummary } from "../routing/spend";
import type { BgQuota } from "./scheduler";

const rank = (l: SpendLevel) => (l === "hard" ? 2 : l === "soft" ? 1 : 0);

export interface RoutingQuotaSource {
  configured(): boolean;
  spend(): SpendSummary & { periodEnd: number };
  plan(task: TaskId): Plan;
}

/**
 * 调度器看的额度（A 的配额）：没配模型路由、没配配额时为 null（额度永远 ok）。
 * 某个任务的级别看它首选模型所在的配额；等着（全都撞限 / 超配额）算 hard；不指定任务取所有配额里最高的。
 */
export function routingQuota(r: RoutingQuotaSource): BgQuota | null {
  if (!r.configured()) return null;
  const spend = r.spend();
  if (spend.quotas.length === 0) return null;
  return {
    level(task) {
      if (task === null) return spend.quotas.reduce<SpendLevel>((m, q) => (rank(q.level) > rank(m) ? q.level : m), "ok");
      const p = r.plan(task);
      if (p.mode === "wait") return "hard";
      if (p.mode !== "routed") return "ok";
      return spend.level(p.preferred, p.requestedTier as Tier);
    },
    maxRatio: () => Math.max(...spend.quotas.map((q) => q.ratio)),
    until: () => spend.periodEnd,
  };
}
