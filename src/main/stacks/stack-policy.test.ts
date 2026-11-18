import { describe, expect, it, vi } from "vitest";
import { STACK_POLICY_DEFAULTS, StackPolicyError } from "../../shared/stacks";
import { memDb } from "../test-utils";
import { StackPolicyService } from "./stack-policy";

function setup() {
  const db = memDb();
  const products: Record<string, { id: number; name: string }[]> = { "acme/web": [{ id: 1, name: "Shop" }] };
  const onChange = vi.fn();
  const s = new StackPolicyService({ db, productsOf: (slug) => products[slug] ?? [], productName: (id) => (id === 1 ? "Shop" : null), now: () => 5, onChange });
  return { s, onChange };
}

describe("StackPolicyService", () => {
  it("defaults to no local writes", () => {
    const { s } = setup();
    expect(s.forSlug("acme/web")).toEqual(STACK_POLICY_DEFAULTS);
    expect(s.forSlug(null).autoRebase).toBe(false);
    expect(s.anyAutoRebase()).toBe(false);
  });

  it("layers global → product → repo", () => {
    const { s, onChange } = setup();
    s.setLayer({ kind: "global" }, { autoRebase: true, behindCommits: 50 });
    s.setLayer({ kind: "product", productId: 1 }, { mergeMethod: "squash" });
    s.setLayer({ kind: "repo", slug: "acme/api" }, { autoRebase: false });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(s.forSlug("acme/web")).toMatchObject({ autoRebase: true, mergeMethod: "squash", behindCommits: 50 });
    expect(s.forSlug("acme/api")).toMatchObject({ autoRebase: false, mergeMethod: "auto" });
    expect(s.anyAutoRebase()).toBe(true);
    const v = s.view({ kind: "repo", slug: "acme/web" });
    expect(v.keys.find((k) => k.key === "mergeMethod")).toMatchObject({ effective: "squash", origin: { kind: "product", name: "Shop" }, set: false });
    expect(s.layers().map((l) => l.label).sort()).toEqual(["Shop", "acme/api", "global"]);
  });

  it("rejects bad values and deletes an emptied layer", () => {
    const { s } = setup();
    expect(() => s.setLayer({ kind: "global" }, { draftDemoteDays: 0 })).toThrow(StackPolicyError);
    s.setLayer({ kind: "global" }, { autoRebase: true });
    s.setLayer({ kind: "global" }, {});
    expect(s.layers()).toEqual([]);
  });
});
