import type { EpicView, FeatureView, TicketView } from "../../shared/types";
import type { Route } from "./App";

/** 这一页的对象已经不在列表里（归档了，可能是跟着上一层归档的）：页面没东西可显示。没有对象的页面永远不算。 */
export function routeGone(route: Route, tickets: TicketView[], features: FeatureView[], epics: EpicView[]): boolean {
  if (route.page === "ticket") return !tickets.some((t) => t.key === route.key);
  if (route.page === "feature") return !features.some((f) => f.id === route.id);
  if (route.page === "epic") return !epics.some((e) => e.id === route.id);
  return false;
}

/** 开好修复 session 后去的地方：feature 页的「总控」，看它的终端。seq 每次递增：同一个修复 session 再开一次时路由也不一样，页面会再落一次。 */
export function fixLanding(featureId: number, termId: string | null, seq: number): Route {
  return { page: "feature", id: featureId, landing: "control", focusTerm: termId, landingSeq: seq };
}

/** 要去的 ticket 页已经不在列表里（刚归档、看板还没刷新）：返回它的 key，调用方报错、不跳到空白页；别的路由为 null。 */
export function missingTicket(route: Route, tickets: Pick<TicketView, "key">[]): string | null {
  return route.page === "ticket" && !tickets.some((t) => t.key === route.key) ? route.key : null;
}
