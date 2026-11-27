import type { Session } from "../../shared/types";

/**
 * 这个 session 归 epic featureId 的总控管：ticket session 的 ticket 属于这个 epic（ownKeys 来自 tickets.listByFeature，
 * 已归档的不算），或者是这个 epic 的修复 session。featureSend、end_session / refresh_session 和信箱的「总控代答」共用这一个判断。
 */
export function featureOwns(featureId: number, ownKeys: ReadonlySet<string>, s: Session): boolean {
  return s.ticketKey !== null ? ownKeys.has(s.ticketKey) : s.featureId === featureId && s.fixesSession !== null;
}

/**
 * from 是不是 to 自己的总控（BTL-269 A）：to 在等用户回答时，总控发来的指示也送进去（总控在替用户回答）。
 * - epic 总控 → featureOwns 认的 session（和 featureSend 收件人的范围一样）；
 * - 全局总控（shipherd）→ epic 总控。
 * 别的 session、别的 epic 的总控都不算。ownKeys：这个 epic 没归档的 ticket key（listByFeature）；epic 不在了、归档了为 null。
 */
export function isControllerOf(from: Session, to: Session, ownKeys: (featureId: number) => ReadonlySet<string> | null): boolean {
  if (from.id === to.id || to.dismissed) return false;
  if (from.shipherd) return to.coordinator;
  if (!from.coordinator || from.featureId === null || to.coordinator) return false;
  const keys = ownKeys(from.featureId);
  return keys !== null && featureOwns(from.featureId, keys, to);
}
