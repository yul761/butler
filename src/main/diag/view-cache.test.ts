import { describe, expect, it } from "vitest";
import { ViewCache } from "./view-cache";

function make(ttlMs = 1000) {
  let t = 0;
  const c = new ViewCache({ now: () => t, ttlMs });
  return { c, at: (v: number) => (t = v) };
}

describe("ViewCache", () => {
  it("builds once until invalidated", () => {
    const { c } = make();
    let n = 0;
    const v = c.wrap("tickets", () => ++n);
    expect(v()).toBe(1);
    expect(v()).toBe(1);
    c.invalidate();
    expect(v()).toBe(2);
  });

  it("expires after the ttl", () => {
    const { c, at } = make(1000);
    let n = 0;
    const v = c.wrap("tickets", () => ++n);
    v();
    at(999);
    expect(v()).toBe(1);
    at(1000);
    expect(v()).toBe(2);
  });

  it("does not cache a build that threw", () => {
    const { c } = make();
    let n = 0;
    const v = c.wrap("x", () => {
      n++;
      if (n === 1) throw new Error("boom");
      return n;
    });
    expect(() => v()).toThrow("boom");
    expect(v()).toBe(2);
  });

  it("an invalidate during a build does not keep the stale result", () => {
    const { c } = make();
    let n = 0;
    const v = c.wrap("x", () => {
      n++;
      if (n === 1) c.invalidate();
      return n;
    });
    expect(v()).toBe(1);
    expect(v()).toBe(2);
  });

  it("keys are independent", () => {
    const { c } = make();
    let a = 0;
    let b = 0;
    const va = c.wrap("a", () => ++a);
    const vb = c.wrap("b", () => ++b);
    va();
    vb();
    va();
    expect([a, b]).toEqual([1, 1]);
  });

  it("invalidating some keys keeps the others (BTL-265)", () => {
    const { c } = make();
    let a = 0;
    let b = 0;
    const va = c.wrap("a", () => ++a);
    const vb = c.wrap("b", () => ++b);
    va();
    vb();
    c.invalidate(["a"]);
    expect([va(), vb()]).toEqual([2, 1]);
    c.invalidate([]);
    expect([va(), vb()]).toEqual([2, 1]);
    c.invalidate();
    expect([va(), vb()]).toEqual([3, 2]);
  });

  it("a keyed invalidate during a build does not keep that key's stale result, and others still cache", () => {
    const { c } = make();
    let n = 0;
    let m = 0;
    const vb = c.wrap("b", () => ++m);
    const v = c.wrap("x", () => {
      n++;
      if (n === 1) c.invalidate(["x"]);
      return vb() + n * 10;
    });
    expect(v()).toBe(11);
    expect(v()).toBe(21);
    expect(m).toBe(1);
  });
});
