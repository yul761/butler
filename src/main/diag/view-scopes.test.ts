import { describe, expect, it } from "vitest";
import { STATE_SCOPES } from "../../shared/state-scope";
import { SCOPE_INVALIDATES, VIEW_DEPENDS, VIEW_KEYS } from "./view-scopes";

describe("SCOPE_INVALIDATES", () => {
  it("drops everything on data", () => {
    expect(SCOPE_INVALIDATES.data).toBeUndefined();
  });

  it("an activity change drops the views that read activity and keeps the ticket list", () => {
    expect(SCOPE_INVALIDATES.activity).toEqual([VIEW_KEYS.features, VIEW_KEYS.turnInput]);
  });

  it("a memory sample or more output keeps every view", () => {
    expect(SCOPE_INVALIDATES.procs).toEqual([]);
    expect(SCOPE_INVALIDATES.output).toEqual([]);
  });

  it("every scope that drops a view also drops the views built from it", () => {
    for (const s of STATE_SCOPES) {
      const keys = SCOPE_INVALIDATES[s];
      if (keys === undefined) continue;
      for (const [key, deps] of Object.entries(VIEW_DEPENDS)) if (deps.some((d) => keys.includes(d))) expect(keys, `${s} drops ${key}`).toContain(key);
    }
  });
});
