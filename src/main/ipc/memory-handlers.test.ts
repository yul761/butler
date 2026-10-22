import { describe, expect, it, vi } from "vitest";
import type { MemoryView } from "../../shared/memory";
import { memoryHandlers } from "./memory-handlers";

const view: MemoryView = { enabled: true, scope: "ticket:PROJ-1", handoff: null, items: [], error: null };
function setup() {
  const memory = { view: vi.fn(async () => view), why: vi.fn(async () => []) };
  const tickets = { get: vi.fn((k: string) => (k === "PROJ-1" ? ({ key: k } as never) : null)) };
  return { memory, h: memoryHandlers({ tickets, memory }) };
}

describe("memory IPC handlers", () => {
  it("routes known tickets to the memory service", async () => {
    const { h, memory } = setup();
    expect(await h.view("PROJ-1")).toBe(view);
    expect(await h.why("PROJ-1", "abc-1")).toEqual([]);
    expect(memory.view).toHaveBeenCalledWith("PROJ-1");
    expect(memory.why).toHaveBeenCalledWith("PROJ-1", "abc-1");
  });

  it("never opens or creates a StateCore scope for an unknown ticket", async () => {
    const { h, memory } = setup();
    expect((await h.view("NOPE-9")).items).toEqual([]);
    expect(await h.why("NOPE-9", "abc-1")).toBeNull();
    expect(memory.view).not.toHaveBeenCalled();
    expect(memory.why).not.toHaveBeenCalled();
  });

  it("rejects bad arguments before touching anything", async () => {
    const { h, memory } = setup();
    for (const bad of [undefined, "", 5, "x".repeat(201)]) await expect(h.view(bad)).rejects.toThrow();
    await expect(h.why("PROJ-1", "../x")).rejects.toThrow();
    await expect(h.why(null, "abc")).rejects.toThrow();
    expect(memory.view).not.toHaveBeenCalled();
    expect(memory.why).not.toHaveBeenCalled();
  });
});
