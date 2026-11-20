import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCollapsed, onCollapsedChange, saveConvSplit, savedConvSplit, saveSendTarget, savedSendTarget, setCollapsed, setWizardSkipped, wizardSkipped } from "./local-prefs";

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

  it("is collapsed by default when asked, and an explicit open is remembered", () => {
    expect(isCollapsed("g", true)).toBe(true);
    setCollapsed("g", false, true);
    expect(isCollapsed("g", true)).toBe(false);
    setCollapsed("g", true, true);
    expect(isCollapsed("g", true)).toBe(true);
    expect(localStorage.getItem("butler.collapsed")).toBeNull();
  });

  it("keeps the old default (expanded) for ids that do not ask", () => {
    expect(isCollapsed("x")).toBe(false);
    setCollapsed("x", true);
    expect(isCollapsed("x")).toBe(true);
  });

  it("keeps default-collapsed opens apart from plain collapsed ids", () => {
    setCollapsed("same", true);
    expect(isCollapsed("same", true)).toBe(true);
    setCollapsed("same", false, true);
    expect(isCollapsed("same", true)).toBe(false);
    expect(isCollapsed("same")).toBe(true);
    setCollapsed("same", false);
    expect(isCollapsed("same")).toBe(false);
    expect(isCollapsed("same", true)).toBe(false);
  });

  it("tells listeners the collapsed state of default-collapsed ids", () => {
    const seen: [string, boolean][] = [];
    const off = onCollapsedChange((id, on) => seen.push([id, on]));
    setCollapsed("g", false, true);
    off();
    expect(seen).toEqual([["g", false]]);
  });

  it("tells listeners what changed until they stop listening", () => {
    const seen: [string, boolean][] = [];
    const off = onCollapsedChange((id, on) => seen.push([id, on]));
    setCollapsed("tickets:f1", true);
    setCollapsed("stuck-open:DMS-1", false);
    off();
    setCollapsed("tickets:f1", false);
    expect(seen).toEqual([["tickets:f1", true], ["stuck-open:DMS-1", false]]);
  });

  it("still tells listeners when the value cannot be stored", () => {
    vi.unstubAllGlobals();
    const seen: boolean[] = [];
    const off = onCollapsedChange((_, on) => seen.push(on));
    setCollapsed("sidebar:f1", true);
    off();
    expect(seen).toEqual([true]);
  });
});

describe("skipped wizard (the Now page's setup reminder)", () => {
  beforeEach(() => vi.stubGlobal("localStorage", fakeStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("is off until the wizard is skipped, and \"don't show again\" clears it for good", () => {
    expect(wizardSkipped()).toBe(false);
    setWizardSkipped(true);
    expect(wizardSkipped()).toBe(true);
    setWizardSkipped(false);
    expect(wizardSkipped()).toBe(false);
    expect(localStorage.getItem("butler.wizardSkipped")).toBeNull();
  });

  it("treats missing storage as not skipped", () => {
    vi.unstubAllGlobals();
    expect(wizardSkipped()).toBe(false);
    expect(() => setWizardSkipped(true)).not.toThrow();
  });
});

describe("conversation tab prefs", () => {
  beforeEach(() => vi.stubGlobal("localStorage", fakeStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it("send target defaults to ask-only and remembers the last pick", () => {
    expect(savedSendTarget()).toBe("fork");
    saveSendTarget("dev");
    expect(savedSendTarget()).toBe("dev");
    saveSendTarget("fork");
    expect(savedSendTarget()).toBe("fork");
    localStorage.setItem("butler.sendTarget", "garbage");
    expect(savedSendTarget()).toBe("fork");
  });

  it("side terminal is remembered per page", () => {
    expect(savedConvSplit("ticket:A-1")).toBe(false);
    saveConvSplit("ticket:A-1", true);
    expect(savedConvSplit("ticket:A-1")).toBe(true);
    expect(savedConvSplit("ticket:B-2")).toBe(false);
    expect(localStorage.getItem("butler.convSplit:ticket:A-1")).toBe("1");
    saveConvSplit("ticket:A-1", false);
    expect(savedConvSplit("ticket:A-1")).toBe(false);
    expect(localStorage.getItem("butler.convSplit:ticket:A-1")).toBeNull();
  });

  it("storage that throws counts as no record", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("off"); }, setItem: () => { throw new Error("off"); }, removeItem: () => { throw new Error("off"); } });
    expect(savedSendTarget()).toBe("fork");
    expect(() => saveSendTarget("dev")).not.toThrow();
    expect(savedConvSplit("p")).toBe(false);
  });
});
