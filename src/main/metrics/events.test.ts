import { describe, expect, it, vi } from "vitest";
import { MetricsRepo } from "../db/metrics-repo";
import { memDb } from "../test-utils";
import { cleanData, INTERVENTION_KINDS, isMetricKind, Metrics } from "./events";

describe("Metrics.recordEvent", () => {
  it("writes an event with its refs and the current time", () => {
    const repo = new MetricsRepo(memDb());
    const m = new Metrics({ repo, now: () => 42 });
    expect(m.recordEvent("manual_trigger", { sessionId: "s", ticketKey: "T-1", prId: 3, repoSlug: "o/r", data: { channel: "sessions:open" } })).toBe(true);
    expect(repo.events(0)[0]).toMatchObject({ kind: "manual_trigger", at: 42, sessionId: "s", ticketKey: "T-1", prId: 3, repoSlug: "o/r", data: { channel: "sessions:open" } });
  });

  it("records once per dedupe key and keeps the given time", () => {
    const repo = new MetricsRepo(memDb());
    const m = new Metrics({ repo, now: () => 42 });
    expect(m.recordEvent("pr_reopened", { at: 7, dedupeKey: "x" })).toBe(true);
    expect(m.recordEvent("pr_reopened", { at: 8, dedupeKey: "x" })).toBe(false);
    expect(repo.events(0).map((e) => e.at)).toEqual([7]);
  });

  it("accepts kinds it does not know (other workstreams) but rejects malformed ones", () => {
    const repo = new MetricsRepo(memDb());
    const log = vi.fn();
    const m = new Metrics({ repo, now: () => 1, log });
    expect(m.recordEvent("cost.pause")).toBe(true);
    expect(m.recordEvent("someone_elses_kind")).toBe(true);
    expect(m.recordEvent("Bad Kind")).toBe(false);
    expect(m.recordEvent("")).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
    expect(isMetricKind("a.b.c")).toBe(false);
  });

  it("never throws when the database write fails", () => {
    const log = vi.fn();
    const m = new Metrics({ repo: { addEvent: () => { throw new Error("disk full"); } }, now: () => 1, log });
    expect(m.recordEvent("terminal_input")).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("terminal_input"), expect.any(Error));
  });

  it("keeps only short scalar data", () => {
    expect(cleanData({ a: "x".repeat(500), b: 1, c: true, d: null, e: { nested: 1 }, f: [1], g: Number.NaN })).toEqual({ a: "x".repeat(120), b: 1, c: true, d: null });
  });

  it("lists the intervention kinds", () => {
    expect([...INTERVENTION_KINDS].sort()).toEqual(["manual_merge", "manual_trigger", "needs_you_answer", "terminal_input"]);
  });
});
