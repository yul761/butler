import { describe, expect, it } from "vitest";
import { keepSame } from "./keep-same";

describe("keepSame", () => {
  it("keeps the old object when the new one has the same content", () => {
    const prev = [{ key: "T-1", title: "a", sessions: [{ id: "s" }] }];
    const next = [{ key: "T-1", title: "a", sessions: [{ id: "s" }] }];
    expect(keepSame(prev, next)).toBe(prev);
  });

  it("takes the new object when anything differs", () => {
    const prev = [{ key: "T-1", title: "a" }];
    const next = [{ key: "T-1", title: "b" }];
    expect(keepSame(prev, next)).toEqual(next);
    expect(keepSame(prev, next)).not.toBe(prev);
    expect(keepSame(null, next)).toBe(next);
  });

  it("swaps only the branch that changed and keeps every untouched sibling (BTL-277)", () => {
    const mk = (s2: string) => ({
      features: [
        { id: "f1", name: "a", activity: { "T-1": { state: "idle" } }, tickets: [{ key: "T-1", sessions: [{ id: "s1", status: "idle" }] }] },
        { id: "f2", name: "b", activity: { "T-2": { state: s2 } }, tickets: [{ key: "T-2", sessions: [{ id: "s2", status: s2 }] }] },
      ],
      notices: [{ id: "n1", text: "hi" }],
    });
    const prev = mk("idle");
    const next = keepSame(prev, mk("working"));
    expect(next).toEqual(mk("working"));
    expect(next).not.toBe(prev);
    expect(next.notices).toBe(prev.notices);
    expect(next.features[0]).toBe(prev.features[0]);
    expect(next.features[1]).not.toBe(prev.features[1]);
    expect(next.features[1].name).toBe("b");
    expect(next.features[1].activity["T-2"]).toEqual({ state: "working" });
    expect(next.features[1].tickets[0].sessions[0].status).toBe("working");
  });

  it("matches array items by id or key across inserts, removals and reordering", () => {
    const a = { id: "a", v: 1 }, b = { id: "b", v: 2 }, c = { key: "c", v: 3 };
    const prev = [a, b, c];
    const next = keepSame(prev, [{ key: "c", v: 3 }, { id: "new", v: 0 }, { id: "a", v: 1 }]);
    expect(next[0]).toBe(c);
    expect(next[2]).toBe(a);
    expect(next[1]).toEqual({ id: "new", v: 0 });
    expect(keepSame(prev, [{ id: "a", v: 1 }, { id: "b", v: 2 }])).toEqual([a, b]);
    // 少了一项：数组本身换新，剩下的项还是旧的。
    const shorter = keepSame(prev, [{ id: "a", v: 1 }, { id: "b", v: 2 }]);
    expect(shorter).not.toBe(prev);
    expect(shorter[0]).toBe(a);
    expect(shorter[1]).toBe(b);
  });

  it("compares items without an id by position", () => {
    const prev = [{ x: 1 }, { x: 2 }];
    const next = keepSame(prev, [{ x: 1 }, { x: 3 }]);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).toEqual({ x: 3 });
  });

  it("notices added, removed and undefined-valued keys, nulls and type changes", () => {
    const prev: Record<string, unknown> = { a: 1, b: { c: 2 } };
    expect(keepSame(prev, { a: 1, b: { c: 2 }, d: undefined })).not.toBe(prev);
    expect(keepSame(prev, { a: 1 })).toEqual({ a: 1 });
    expect(keepSame(prev, { a: 1, b: null })).toEqual({ a: 1, b: null });
    expect(keepSame(prev, { a: "1", b: { c: 2 } })).toEqual({ a: "1", b: { c: 2 } });
    expect(keepSame<unknown>([1, 2], { 0: 1, 1: 2 })).toEqual({ 0: 1, 1: 2 });
    expect(keepSame({ n: NaN }, { n: NaN }).n).toBeNaN();
    const p2 = { n: NaN };
    expect(keepSame(p2, { n: NaN })).toBe(p2);
  });

  it("gives the same content as the new value in every case (random structures)", () => {
    let rnd = 3;
    const r = (n: number) => ((rnd = (rnd * 1103515245 + 12345) % 2147483648), rnd % n);
    const gen = (depth: number): unknown => {
      const k = r(depth > 2 ? 3 : 6);
      if (k === 0) return r(3);
      if (k === 1) return ["x", "y", null][r(3)];
      if (k === 2) return r(2) === 0;
      if (k === 3) return Array.from({ length: r(4) }, () => (r(2) ? { id: `i${r(4)}`, v: gen(depth + 1) } : gen(depth + 1)));
      const o: Record<string, unknown> = {};
      for (let i = r(4); i > 0; i--) o[`k${r(5)}`] = gen(depth + 1);
      return o;
    };
    for (let i = 0; i < 2000; i++) {
      const prev = gen(0);
      const next = r(3) === 0 ? structuredClone(prev) : gen(0);
      const out = keepSame(prev, next);
      expect(JSON.stringify(out)).toBe(JSON.stringify(next));
      if (JSON.stringify(prev) === JSON.stringify(next) && out !== prev) {
        // 内容一样只可能是 key 顺序不同：那也照样留旧的。
        expect(out).toBe(prev);
      }
    }
  });
});
