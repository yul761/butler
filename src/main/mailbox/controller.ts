import type { Session } from "../../shared/types";

/**
 * from 是不是 to 自己的总控（BTL-269 A）：to 在等用户回答时，总控发来的指示也送进去（总控在替用户回答）。
 * - epic 总控 → 自己 epic 里的 ticket session、修复 session（和 featureSend 收件人的范围一样：ticket 属于这个 epic，或者是这个 epic 的修复 session）；
 * - 全局总控（shipherd）→ epic 总控。
 * 别的 session、别的 epic 的总控都不算。ticketFeature：ticket 所属的 epic（没有、找不到为 null）。
 */
export function isControllerOf(from: Session, to: Session, ticketFeature: (key: string) => number | null): boolean {
  if (from.id === to.id || to.dismissed) return false;
  if (from.shipherd) return to.coordinator;
  if (!from.coordinator || from.featureId === null || to.coordinator) return false;
  if (to.ticketKey !== null) return ticketFeature(to.ticketKey) === from.featureId;
  return to.featureId === from.featureId && to.fixesSession !== null;
}
