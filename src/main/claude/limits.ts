import type { LimitHit, LimitKind } from "../../shared/availability";
import { activeRules, classifyDetailed, resolveResetWith, type DetailedHit } from "../routing/rules";

export { RESET_MAX_AHEAD_MS, RESET_PAST_SLACK_MS } from "../routing/rules";

export function isPauseKind(k: LimitKind): boolean {
  return k === "usage_limit" || k === "rate_limit" || k === "overloaded";
}

/** 按当前生效的识别规则（内置 + 用户 + 学到的，见 routing/rules.ts）归类一段报错；认不出返回 null。 */
export function classifyLimit(i: { text: string; apiStatus: number | null; now: number; timeZone?: string }): LimitHit | null {
  return classifyLimitDetailed(i)?.hit ?? null;
}

/** 同 classifyLimit，另外带上命中的规则 id 和它是不是账号级。 */
export function classifyLimitDetailed(i: { text: string; apiStatus: number | null; now: number; timeZone?: string }): DetailedHit | null {
  return classifyDetailed(activeRules(), i);
}

export function resolveReset(text: string, now: number, timeZone?: string): number | null {
  return resolveResetWith(activeRules(), text, now, timeZone);
}
