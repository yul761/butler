import type { Session } from "../../shared/types";

/** 查 feature 下的 ticket、epic 下的 feature。 */
export interface ScopeLookup {
  ticketsOfFeature(featureId: number): string[];
  featuresOfEpic(epicId: number): number[];
}

/**
 * 总控管哪些 session（和总控的 end_session 范围一样，control-handler）：ticket 总控管同一个 ticket 的；
 * feature 总控管它 ticket 的和修复 session；epic 管它 feature 的总控、修复 session 和这些 feature 的 ticket。不是总控的返回 null。
 * 闲置关闭和休眠（WS-M B）共用：总控管的子 session 在干活时总控不关、不休眠。
 */
export function managedBy(coord: Session, d: ScopeLookup): ((s: Session) => boolean) | null {
  if (coord.epicId !== null) {
    const features = new Set(d.featuresOfEpic(coord.epicId));
    const keys = new Set([...features].flatMap((f) => d.ticketsOfFeature(f)));
    return (s) => (s.ticketKey !== null ? keys.has(s.ticketKey) : s.featureId !== null && features.has(s.featureId));
  }
  if (coord.ticketKey !== null) return coord.coordinator ? (s) => s.ticketKey === coord.ticketKey : null;
  if (coord.featureId !== null && coord.fixesSession === null) {
    const keys = new Set(d.ticketsOfFeature(coord.featureId));
    return (s) => (s.ticketKey !== null ? keys.has(s.ticketKey) : s.featureId === coord.featureId && s.fixesSession !== null);
  }
  return null;
}

/** 总控管的、别的 head 里有没有在干活的（working 说了算）。不是总控的返回 false。 */
export function childrenWorking(coord: Session, heads: readonly Session[], working: (headId: string) => boolean, d: ScopeLookup): boolean {
  const manages = managedBy(coord, d);
  if (!manages) return false;
  return heads.some((h) => h.id !== coord.id && manages(h) && working(h.id));
}
