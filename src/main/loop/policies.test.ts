import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { migrate } from "../db/database";
import { LoopPolicies } from "./policies";

const make = () => {
  const db = memDb();
  migrate(db);
  const products = new Map([[1, "Alpha"], [2, "Beta"]]);
  const membership: Record<string, number[]> = { "o/r": [1, 2], "o/s": [1] };
  return new LoopPolicies({
    db, now: () => 5,
    products: {
      productsOf: (slug) => (membership[slug] ?? []).map((id) => ({ id, name: products.get(id)! })),
      product: (id) => (products.has(id) ? { name: products.get(id)! } : null),
    },
  });
};

describe("LoopPolicies", () => {
  it("defaults to everything off", () => {
    const p = make();
    expect(p.forSlug("o/r")["comments.enabled"]).toBe(false);
    expect(p.forSlug(null)["ci.enabled"]).toBe(false);
    expect(p.anyEnabled("ci.enabled")).toBe(false);
  });

  it("layers global, product and repo overrides", () => {
    const p = make();
    p.setLayer({ kind: "global" }, { "ci.enabled": true, "ci.maxReruns": 1 });
    p.setLayer({ kind: "product", productId: 1 }, { "ci.maxReruns": 3, "comments.enabled": true });
    p.setLayer({ kind: "repo", slug: "o/s" }, { "comments.enabled": false, "ci.flakyTests": ["e2e"] });
    expect(p.forSlug("o/r")).toMatchObject({ "ci.enabled": true, "ci.maxReruns": 3, "comments.enabled": true });
    expect(p.forSlug("o/s")).toMatchObject({ "ci.maxReruns": 3, "comments.enabled": false, "ci.flakyTests": ["e2e"] });
    expect(p.forSlug("x/y")).toMatchObject({ "ci.maxReruns": 1, "comments.enabled": false });
    expect(p.anyEnabled("comments.enabled")).toBe(true);
    const v = p.view({ kind: "repo", slug: "o/s" });
    expect(v.keys.find((k) => k.key === "ci.maxReruns")).toMatchObject({ effective: 3, origin: { kind: "product", productId: 1, name: "Alpha" }, override: null });
    expect(v.keys.find((k) => k.key === "comments.enabled")).toMatchObject({ effective: false, origin: { kind: "repo", slug: "o/s" }, override: false });
    expect(v.keys.find((k) => k.key === "comments.human")).toMatchObject({ effective: "review", origin: { kind: "default" } });
  });

  it("reports product conflicts on a repo and rejects bad input", () => {
    const p = make();
    p.setLayer({ kind: "product", productId: 1 }, { "ci.maxReruns": 3 });
    p.setLayer({ kind: "product", productId: 2 }, { "ci.maxReruns": 1 });
    expect(p.view({ kind: "repo", slug: "o/r" }).conflicts).toEqual([{ key: "ci.maxReruns", products: [{ id: 1, name: "Alpha", value: 3 }, { id: 2, name: "Beta", value: 1 }] }]);
    expect(() => p.setLayer({ kind: "global" }, { "ci.maxReruns": 99 })).toThrow();
    expect(() => p.setLayer({ kind: "product", productId: 9 }, {})).toThrow(/product not found/);
    p.setLayer({ kind: "product", productId: 1 }, {});
    expect(p.overrides({ kind: "product", productId: 1 })).toEqual({});
  });
});
