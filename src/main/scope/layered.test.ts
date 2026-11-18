import { describe, expect, it } from "vitest";
import { LayeredResolver, mergeLayers, type DeepPartial, type ScopeRef } from "./layered";

interface Conf {
  a: number;
  nested: { x: number; y: string; deep: { z: boolean } };
  list: string[];
  "flat.key": number;
}
const DEFAULTS: Conf = { a: 1, nested: { x: 1, y: "d", deep: { z: false } }, list: ["d"], "flat.key": 0 };

describe("mergeLayers", () => {
  it("overrides key by key, merges nested objects and replaces arrays", () => {
    const r = mergeLayers(DEFAULTS, [
      { ref: { kind: "global" }, label: "global", values: { a: 2, nested: { x: 2 }, list: ["g1", "g2"] } },
      { ref: { kind: "repo", slug: "acme/web" }, label: "acme/web", values: { nested: { deep: { z: true } }, list: ["r"], "flat.key": 5 } },
    ]);
    expect(r.value).toEqual({ a: 2, nested: { x: 2, y: "d", deep: { z: true } }, list: ["r"], "flat.key": 5 });
    expect(r.origin).toEqual({
      a: { kind: "global" }, "nested.x": { kind: "global" }, "nested.y": "default", "nested.deep.z": { kind: "repo", slug: "acme/web" },
      list: { kind: "repo", slug: "acme/web" }, "flat.key": { kind: "repo", slug: "acme/web" },
    });
    expect(DEFAULTS.nested.x).toBe(1);
  });

  it("treats undefined as inherit", () => {
    const r = mergeLayers(DEFAULTS, [{ ref: { kind: "global" }, label: "g", values: { a: undefined } }]);
    expect(r.value.a).toBe(1);
    expect(r.origin.a).toBe("default");
  });
});

describe("LayeredResolver", () => {
  const layers = new Map<string, DeepPartial<Conf>>([
    ["global", { a: 10 }],
    ["product:1", { a: 20, nested: { y: "alpha" } }],
    ["product:2", { nested: { y: "beta", x: 7 } }],
    ["repo:acme/web", { nested: { x: 9 } }],
  ]);
  const key = (r: ScopeRef) => (r.kind === "global" ? "global" : r.kind === "product" ? `product:${r.productId}` : `repo:${r.slug}`);
  const products: Record<string, { id: number; name: string }[]> = { "acme/web": [{ id: 2, name: "beta" }, { id: 1, name: "alpha" }], "acme/api": [] };
  const resolver = new LayeredResolver<Conf>({
    defaults: DEFAULTS,
    read: (r) => layers.get(key(r)) ?? null,
    productsOf: (slug) => products[slug] ?? [],
    productName: (id) => (id === 1 ? "alpha" : id === 2 ? "beta" : null),
    slugOf: (p) => (p === "/code/web" ? "acme/web" : null),
  });

  it("applies global, products in name order, then the repo", () => {
    const r = resolver.forRepo("acme/web");
    expect(r.layers.map((l) => l.label)).toEqual(["global", "alpha", "beta", "acme/web"]);
    expect(r.value).toMatchObject({ a: 20, nested: { x: 9, y: "beta" } });
    expect(r.origin).toMatchObject({ a: { kind: "product", productId: 1 }, "nested.y": { kind: "product", productId: 2 }, "nested.x": { kind: "repo", slug: "acme/web" } });
  });

  it("resolves global, product and unknown paths", () => {
    expect(resolver.forGlobal().value.a).toBe(10);
    expect(resolver.forProduct(2).value).toMatchObject({ a: 10, nested: { x: 7, y: "beta" } });
    expect(resolver.forProduct(2).layers.map((l) => l.label)).toEqual(["global", "beta"]);
    expect(resolver.forPath("/code/web").value.nested.x).toBe(9);
    expect(resolver.forPath("/elsewhere").layers.map((l) => l.label)).toEqual(["global"]);
    expect(resolver.forRepo("acme/api").value.nested.x).toBe(1);
  });

  it("reports keys two products of a repo set differently", () => {
    expect(resolver.conflicts("acme/web")).toEqual([
      { key: "nested.y", products: [{ id: 1, name: "alpha", value: "alpha" }, { id: 2, name: "beta", value: "beta" }] },
    ]);
    expect(resolver.conflicts("acme/api")).toEqual([]);
  });
});
