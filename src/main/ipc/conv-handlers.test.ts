import { describe, expect, it, vi } from "vitest";
import type { ConvPage } from "../../shared/conversation";
import { convHandlers } from "./conv-handlers";

function setup() {
  const page: ConvPage = { messages: [], refreshMarks: [], hasMore: false };
  const conv = { list: vi.fn(() => page), search: vi.fn(() => []) };
  return { conv, page, h: convHandlers({ conv }) };
}

describe("conv IPC handlers", () => {
  it("passes the id through as given (the store turns it into the root)", () => {
    const { h, conv, page } = setup();
    expect(h.list("b", { limit: 10 })).toBe(page);
    expect(conv.list).toHaveBeenCalledWith("b", { limit: 10 });
    expect(h.search(null, "lint")).toEqual([]);
    expect(h.search("c", "lint")).toEqual([]);
    expect(conv.search.mock.calls).toEqual([[null, "lint"], ["c", "lint"]]);
  });

  it("refuses bad arguments without touching the store", () => {
    const { h, conv } = setup();
    expect(() => h.list("../x", { limit: 10 })).toThrow();
    expect(() => h.list("b", { limit: 0 })).toThrow();
    expect(() => h.search("b", 42)).toThrow();
    expect(() => h.search(undefined, "x")).toThrow();
    expect(conv.list).not.toHaveBeenCalled();
    expect(conv.search).not.toHaveBeenCalled();
  });
});
