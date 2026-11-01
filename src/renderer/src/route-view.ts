import type { EpicView, FeatureView, TicketView } from "../../shared/types";
import type { Route } from "./App";

/** 这一页的对象已经不在列表里（归档了，可能是跟着上一层归档的）：页面没东西可显示。没有对象的页面永远不算。 */
export function routeGone(route: Route, tickets: TicketView[], features: FeatureView[], epics: EpicView[]): boolean {
  if (route.page === "ticket") return !tickets.some((t) => t.key === route.key);
  if (route.page === "feature") return !features.some((f) => f.id === route.id);
  if (route.page === "epic") return !epics.some((e) => e.id === route.id);
  return false;
}
