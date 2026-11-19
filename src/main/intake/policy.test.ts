import { describe, expect, it, vi } from "vitest";
import { INTAKE_POLICY_DEFAULTS, IntakePolicyError, parseIntakeOverrides, sanitizeIntakeOverrides } from "../../shared/intake";
import { memDb } from "../test-utils";
import { IntakePolicyService } from "./policy";

function setup() {
  const db = memDb();
  const products: Record<string, { id: number; name: string }[]> = { "acme/web": [{ id: 1, name: "Shop" }], "acme/api": [] };
  const onChange = vi.fn();
  const s = new IntakePolicyService({ db, productsOf: (slug) => products[slug] ?? [], productName: (id) => (id === 1 ? "Shop" : null), now: () => 5, onChange });
  return { s, onChange };
}

describe("intake policy overrides", () => {
  it("sanitize drops bad values and keeps good ones", () => {
    expect(sanitizeIntakeOverrides({ enabled: true, maxSize: "huge", maxParallel: 0, tierSmall: "low", uncertainBelow: 0.5, nope: 1 })).toEqual({
      enabled: true, tierSmall: "low", uncertainBelow: 0.5,
    });
    expect(sanitizeIntakeOverrides("x")).toEqual({});
  });

  it("parse throws on the first bad value", () => {
    expect(() => parseIntakeOverrides({ maxParallel: 1.5 })).toThrow(IntakePolicyError);
    expect(() => parseIntakeOverrides({ clarifyMode: "email" })).toThrow(/clarifyMode: bad_choice/);
    expect(parseIntakeOverrides({ conflictAction: "parallel", autoStart: undefined })).toEqual({ conflictAction: "parallel" });
  });
});

describe("IntakePolicyService", () => {
  it("is off by default everywhere", () => {
    const { s } = setup();
    expect(s.forSlug("acme/web")).toEqual(INTAKE_POLICY_DEFAULTS);
    expect(s.forSlug(null).enabled).toBe(false);
    expect(s.anyEnabled()).toBe(false);
  });

  it("layers global → product → repo", () => {
    const { s, onChange } = setup();
    s.setLayer({ kind: "global" }, { maxParallel: 3 });
    expect(s.anyEnabled()).toBe(false);
    s.setLayer({ kind: "product", productId: 1 }, { enabled: true, tierSmall: "low" });
    s.setLayer({ kind: "repo", slug: "acme/api" }, { enabled: false, maxRisk: "medium" });
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(s.anyEnabled()).toBe(true);
    expect(s.forSlug("acme/web")).toMatchObject({ enabled: true, tierSmall: "low", maxParallel: 3 });
    expect(s.forSlug("acme/api")).toMatchObject({ enabled: false, maxRisk: "medium", maxParallel: 3 });
    const v = s.view({ kind: "repo", slug: "acme/web" });
    expect(v.keys.find((k) => k.key === "enabled")).toEqual({ key: "enabled", effective: true, origin: { kind: "product", productId: 1, name: "Shop" }, set: false, override: null });
    expect(v.layers.map((l) => l.label)).toEqual(["global", "Shop", "acme/api"]);
  });

  it("an emptied layer is removed", () => {
    const { s } = setup();
    s.setLayer({ kind: "global" }, { enabled: true });
    s.setLayer({ kind: "global" }, {});
    expect(s.layers()).toEqual([]);
    expect(() => s.setLayer({ kind: "global" }, { enabled: "yes" })).toThrow(IntakePolicyError);
  });
});
