import { describe, expect, it } from "vitest";
import type { EpicView, FeatureView, TicketView } from "../../shared/types";
import { routeGone } from "./route-view";

const tickets = [{ key: "DMS-1" }] as TicketView[];
const features = [{ id: 2 }] as FeatureView[];
const epics = [{ id: 3 }] as EpicView[];

describe("routeGone", () => {
  it("says a ticket, feature or epic page is gone when its target is not on the lists", () => {
    expect(routeGone({ page: "ticket", key: "DMS-9" }, tickets, features, epics)).toBe(true);
    expect(routeGone({ page: "feature", id: 9 }, tickets, features, epics)).toBe(true);
    expect(routeGone({ page: "epic", id: 9 }, tickets, features, epics)).toBe(true);
  });

  it("keeps a page whose target is still there", () => {
    expect(routeGone({ page: "ticket", key: "DMS-1" }, tickets, features, epics)).toBe(false);
    expect(routeGone({ page: "feature", id: 2 }, tickets, features, epics)).toBe(false);
    expect(routeGone({ page: "epic", id: 3 }, tickets, features, epics)).toBe(false);
  });

  it("does not confuse a feature with an epic that has the same id", () => {
    expect(routeGone({ page: "feature", id: 3 }, tickets, features, epics)).toBe(true);
    expect(routeGone({ page: "epic", id: 2 }, tickets, features, epics)).toBe(true);
  });

  it("never sends the user away from a page that has no target", () => {
    for (const page of ["home", "unclaimed", "archived", "settings", "audit"] as const) {
      expect(routeGone({ page }, [], [], [])).toBe(false);
    }
  });
});
