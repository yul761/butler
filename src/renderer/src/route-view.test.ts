import { describe, expect, it } from "vitest";
import type { EpicView, FeatureView, TicketView } from "../../shared/types";
import { fixLanding, missingTicket, routeGone } from "./route-view";

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

describe("fixLanding", () => {
  it("lands on the feature's control tab with the fix terminal, and every call is a new landing", () => {
    expect(fixLanding(2, "term-1", 1)).toEqual({ page: "feature", id: 2, landing: "control", focusTerm: "term-1", landingSeq: 1 });
    // 同一个修复 session 再开一次（已经开着）：别的字段都一样，只有 landingSeq 不同，页面才会再落一次。
    expect(fixLanding(2, "term-1", 2)).not.toEqual(fixLanding(2, "term-1", 1));
    expect(fixLanding(2, null, 3)).toMatchObject({ landing: "control", focusTerm: null });
  });
});

describe("missingTicket", () => {
  const tickets = [{ key: "BTL-1" }] as TicketView[];
  it("a card's look into a ticket that was just archived (the board not refreshed yet) is caught, not a blank page", () => {
    expect(missingTicket({ page: "ticket", key: "BTL-9", landing: { owner: "you", kind: "merge", risk: null } }, tickets)).toBe("BTL-9");
    expect(missingTicket({ page: "ticket", key: "BTL-1" }, tickets)).toBeNull();
    expect(missingTicket({ page: "home" }, tickets)).toBeNull();
  });
});
