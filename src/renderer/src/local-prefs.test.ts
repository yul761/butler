import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCollapsed, setCollapsed } from "./local-prefs";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("collapsed sections", () => {
  beforeEach(() => vi.stubGlobal("localStorage", fakeStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("starts expanded and remembers each id on its own", () => {
    expect(isCollapsed("sidebar:f1")).toBe(false);
    setCollapsed("sidebar:f1", true);
    setCollapsed("tickets:f1", true);
    expect(isCollapsed("sidebar:f1")).toBe(true);
    expect(isCollapsed("tickets:f1")).toBe(true);
    expect(isCollapsed("sidebar:f2")).toBe(false);

    setCollapsed("sidebar:f1", false);
    expect(isCollapsed("sidebar:f1")).toBe(false);
    expect(isCollapsed("tickets:f1")).toBe(true);
    setCollapsed("tickets:f1", false);
    expect(localStorage.getItem("butler.collapsed")).toBeNull();
  });

  it("treats a broken record as nothing collapsed", () => {
    localStorage.setItem("butler.collapsed", "{not json");
    expect(isCollapsed("sidebar:f1")).toBe(false);
    setCollapsed("sidebar:f1", true);
    expect(isCollapsed("sidebar:f1")).toBe(true);
  });

  it("treats missing storage as nothing collapsed", () => {
    vi.unstubAllGlobals();
    expect(isCollapsed("sidebar:f1")).toBe(false);
    expect(() => setCollapsed("sidebar:f1", true)).not.toThrow();
  });
});
