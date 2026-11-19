import type { IntakePolicy, IntakeRisk, IntakeSize } from "../../shared/intake";
import { tierRank, type Tier } from "../../shared/model-routing";

/**
 * 档位（设计补充 ws-n 第 4 节）：大小定一个档、风险定一个下限，取高的；最后交给 routing.sessionModel(tier) 解析成模型。
 * 低风险不抬档。
 */
export function pickTier(size: IntakeSize, risk: IntakeRisk, p: Pick<IntakePolicy, "tierSmall" | "tierMedium" | "tierLarge" | "tierMediumRisk" | "tierHighRisk">): Tier {
  const bySize = size === "small" ? p.tierSmall : size === "medium" ? p.tierMedium : p.tierLarge;
  const byRisk: Tier | null = risk === "high" ? p.tierHighRisk : risk === "medium" ? p.tierMediumRisk : null;
  return byRisk && tierRank(byRisk) > tierRank(bySize) ? byRisk : bySize;
}
