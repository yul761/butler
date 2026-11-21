import { describe, expect, it } from "vitest";
import { LruCache } from "./terminal-cache";

function make(max = 2) {
  const disposed: string[] = [];
  let made = 0;
  const c = new LruCache<number>(max, (k) => disposed.push(k));
  /** 挂上再摘下（切到这个终端、再切走）。 */
  const visit = (k: string) => {
    const v = c.acquire(k, () => ++made);
    c.release(k);
    return v;
  };
  return { c, visit, disposed, made: () => made };
}

describe("LruCache (BTL-242 terminal keep-alive)", () => {
  it("reuses a cached value instead of rebuilding it", () => {
    const { visit, made } = make();
    expect(visit("a")).toBe(1);
    expect(visit("a")).toBe(1);
    expect(made()).toBe(1);
  });

  it("evicts the least recently used one past max", () => {
    const { c, visit, disposed } = make(2);
    visit("a");
    visit("b");
    visit("a");
    visit("c");
    expect(disposed).toEqual(["b"]);
    expect(c.keys()).toEqual(["a", "c"]);
  });

  it("never evicts what is on screen; the oldest goes once it is released", () => {
    const { c, disposed } = make(1);
    c.acquire("a", () => 1);
    c.acquire("b", () => 2);
    expect(disposed).toEqual([]);
    expect(c.keys()).toEqual(["a", "b"]);
    c.release("a");
    expect(disposed).toEqual(["a"]);
    c.release("b");
    expect(c.keys()).toEqual(["b"]);
  });

  it("two views of one terminal: stays pinned until both release", () => {
    const { c, disposed } = make(0);
    c.acquire("a", () => 1);
    c.acquire("a", () => 2);
    c.release("a");
    expect(disposed).toEqual([]);
    c.release("a");
    expect(disposed).toEqual(["a"]);
  });

  it("drop disposes at once, but not while on screen", () => {
    const { c, disposed } = make(4);
    c.acquire("a", () => 1);
    c.drop("a");
    expect(disposed).toEqual([]);
    c.release("a");
    c.drop("a");
    expect(disposed).toEqual(["a"]);
    expect(c.has("a")).toBe(false);
  });
});
