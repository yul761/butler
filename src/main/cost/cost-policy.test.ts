import { describe, expect, it, vi } from "vitest";
import { COST_POLICY_DEFAULTS, CostPolicyError } from "../../shared/cost";
import { memDb } from "../test-utils";
import { CostPolicyService, strictest } from "./cost-policy";

function setup() {
  const db = memDb();
  const products: Record<string, { id: number; name: string }[]> = { "acme/web": [{ id: 1, name: "Shop" }], "acme/api": [] };
  const onChange = vi.fn();
  const s = new CostPolicyService({ db, productsOf: (slug) => products[slug] ?? [], productName: (id) => (id === 1 ? "Shop" : null), now: () => 5, onChange });
  return { s, onChange };
}

describe("CostPolicyService", () => {
  it("defaults to no caps, like 2.1.0", () => {
    const { s } = setup();
    expect(s.forRepos([])).toEqual(COST_POLICY_DEFAULTS);
    expect(s.forRepos(["acme/web"])).toEqual(COST_POLICY_DEFAULTS);
    expect(s.anyCap()).toBe(false);
  });

  it("layers global → product → repo, and a repo can say no cap", () => {
    const { s, onChange } = setup();
    s.setLayer({ kind: "global" }, { sessionCap: 10, ticketCap: 40 });
    s.setLayer({ kind: "product", productId: 1 }, { sessionCap: 5, action: "pause" });
    s.setLayer({ kind: "repo", slug: "acme/api" }, { ticketCap: null });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(s.forRepos(["acme/web"])).toMatchObject({ sessionCap: 5, ticketCap: 40, action: "pause" });
    expect(s.forRepos(["acme/api"])).toMatchObject({ sessionCap: 10, ticketCap: null });
    expect(s.anyCap()).toBe(true);
    const v = s.view({ kind: "repo", slug: "acme/web" });
    expect(v.keys.find((k) => k.key === "sessionCap")).toEqual({
      key: "sessionCap", effective: 5, origin: { kind: "product", productId: 1, name: "Shop" }, set: false, override: null,
    });
    expect(s.view({ kind: "repo", slug: "acme/api" }).keys.find((k) => k.key === "ticketCap")).toMatchObject({ effective: null, set: true, override: null });
  });

  it("takes the strictest value across a ticket's repos", () => {
    const { s } = setup();
    s.setLayer({ kind: "repo", slug: "acme/web" }, { sessionCap: 8, pauseScope: "background", raisePercent: 30 });
    s.setLayer({ kind: "repo", slug: "acme/api" }, { sessionCap: 12, ticketCap: 50, action: "pause" });
    expect(s.forRepos(["acme/web", "acme/api"])).toMatchObject({ sessionCap: 8, ticketCap: 50, action: "pause", pauseScope: "session", raisePercent: 30 });
  });

  it("ignores caps in another unit when combining repos", () => {
    const p = strictest([{ ...COST_POLICY_DEFAULTS, sessionCap: 3 }, { ...COST_POLICY_DEFAULTS, unit: "tokens", sessionCap: 1 }]);
    expect(p).toMatchObject({ unit: "usd", sessionCap: 3 });
  });

  it("rejects bad values and removes an emptied layer", () => {
    const { s } = setup();
    expect(() => s.setLayer({ kind: "global" }, { sessionCap: -1 })).toThrow(CostPolicyError);
    expect(() => s.setLayer({ kind: "global" }, { unit: "eur" })).toThrow(CostPolicyError);
    expect(() => s.setLayer({ kind: "global" }, { raisePercent: 0 })).toThrow(CostPolicyError);
    expect(() => s.setLayer({ kind: "global" }, { nope: 1 })).toThrow(CostPolicyError);
    s.setLayer({ kind: "global" }, { sessionCap: 1 });
    expect(s.layers()).toHaveLength(1);
    s.setLayer({ kind: "global" }, {});
    expect(s.layers()).toEqual([]);
  });
});
