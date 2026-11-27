import { describe, expect, it } from "vitest";
import { STATE_SCOPES } from "../../shared/state-scope";
import { SCOPE_INVALIDATES, VIEW_DEPENDS, VIEW_KEYS } from "./view-scopes";

describe("SCOPE_INVALIDATES", () => {
  it("drops everything on data", () => {
    expect(SCOPE_INVALIDATES.data).toBeUndefined();
  });

  it("an activity change drops the views that read activity and keeps the ticket list", () => {
    expect(SCOPE_INVALIDATES.activity).toEqual([VIEW_KEYS.features, VIEW_KEYS.turnInput, VIEW_KEYS.now]);
  });

  it("a memory sample or more output keeps every view but the Now page (BTL-275: it shows memory readings and recent activity)", () => {
    expect(SCOPE_INVALIDATES.procs).toEqual([VIEW_KEYS.now]);
    expect(SCOPE_INVALIDATES.output).toEqual([VIEW_KEYS.now]);
  });

  it("every scope drops the Now page, so a refetch after any state:changed builds it afresh (BTL-275)", () => {
    for (const s of STATE_SCOPES) {
      const keys = SCOPE_INVALIDATES[s];
      if (keys !== undefined) expect(keys, s).toContain(VIEW_KEYS.now);
    }
  });

  it("every scope that drops a view also drops the views built from it", () => {
    for (const s of STATE_SCOPES) {
      const keys = SCOPE_INVALIDATES[s];
      if (keys === undefined) continue;
      for (const [key, deps] of Object.entries(VIEW_DEPENDS)) if (deps.some((d) => keys.includes(d))) expect(keys, `${s} drops ${key}`).toContain(key);
    }
  });
});
