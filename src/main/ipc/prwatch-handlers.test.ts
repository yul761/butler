import { describe, expect, it, vi } from "vitest";
import type { WatchedPr } from "../../shared/types";
import { prWatchListHandler } from "./prwatch-handlers";

const pr = (ticketKey: string, n: number) => ({ ticketKey, number: n, url: `https://github.com/o/app/pull/${n}`, state: "open" }) as unknown as WatchedPr;

function setup() {
  const rows: Record<string, WatchedPr[]> = { "BTL-1": [pr("BTL-1", 1)], "BTL-2": [pr("BTL-2", 2), pr("BTL-2", 3)] };
  const watcher = {
    statusOf: vi.fn((k: string) => rows[k] ?? []),
    statusOfMany: vi.fn((ks: readonly string[]) => new Map(ks.map((k) => [k, rows[k] ?? []]))),
  };
  return { watcher, list: prWatchListHandler({ watcher, ticketKeys: () => ["BTL-1", "BTL-2"] }) };
}

describe("prwatch:list handler (BTL-270 review)", () => {
  it("with a ticket key returns only that ticket's rows", () => {
    const { list, watcher } = setup();
    expect(list("BTL-2").map((p) => [p.ticketKey, p.number])).toEqual([["BTL-2", 2], ["BTL-2", 3]]);
    expect(list("BTL-1").map((p) => p.ticketKey)).toEqual(["BTL-1"]);
    expect(watcher.statusOf).toHaveBeenCalledWith("BTL-2");
    expect(watcher.statusOfMany).not.toHaveBeenCalled();
  });

  it("without an argument reads every ticket in one batch", () => {
    const { list, watcher } = setup();
    expect(list(undefined).map((p) => p.number)).toEqual([1, 2, 3]);
    expect(watcher.statusOfMany).toHaveBeenCalledTimes(1);
    expect(watcher.statusOfMany).toHaveBeenCalledWith(["BTL-1", "BTL-2"]);
    expect(watcher.statusOf).not.toHaveBeenCalled();
  });

  it("rejects a bad key instead of reading everything", () => {
    const { list, watcher } = setup();
    for (const bad of [null, 5, "", "x".repeat(201), {}]) expect(() => list(bad), String(bad)).toThrow();
    expect(watcher.statusOf).not.toHaveBeenCalled();
    expect(watcher.statusOfMany).not.toHaveBeenCalled();
  });
});
