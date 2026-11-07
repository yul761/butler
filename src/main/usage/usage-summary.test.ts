import { describe, expect, it } from "vitest";
import type { UsageRow } from "../db/usage-repo";
import { summarizeUsage } from "./usage-summary";

const row = (o: Partial<UsageRow> = {}): UsageRow => ({
  messageId: "m", at: 1000, model: "opus", input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, context: 0,
  sessionId: "s1", agentId: null, source: "session", job: null, ...o,
});
const kindOf = () => "ticket" as const;

describe("summarizeUsage", () => {
  it("computes weighted shares", () => {
    const s = summarizeUsage([row({ cacheRead: 1000, output: 20 })], kindOf, 0);
    expect(s.totalTokens).toBe(1020);
    expect(s.cacheReadShare).toBeCloseTo(0.5);
  });
  it("counts turns at or over 200k context", () => {
    const rows = [row({ messageId: "a", input: 10, context: 200_000 }), row({ messageId: "b", input: 10, context: 199_999 })];
    expect(summarizeUsage(rows, kindOf, 0).over200kShare).toBeCloseTo(0.5);
  });
  it("splits by kind and model", () => {
    const rows = [
      row({ messageId: "a", input: 10, model: "opus" }),
      row({ messageId: "b", input: 10, model: null, source: "subagent" }),
      row({ messageId: "c", input: 10, model: "opus", source: "headless" }),
      row({ messageId: "d", input: 10, model: "opus", sessionId: "co" }),
    ];
    const s = summarizeUsage(rows, (id) => (id === "co" ? "coordinator" : "ticket"), 0);
    expect(s.byKind).toEqual({ ticket: 0.25, coordinator: 0.25, subagent: 0.25, headless: 0.25 });
    expect(s.byModel).toEqual({ opus: 0.75, unknown: 0.25 });
  });
  it("ignores rows before sinceMs", () => {
    const s = summarizeUsage([row({ at: 5, input: 100 }), row({ messageId: "n", at: 10, input: 7 })], kindOf, 10);
    expect(s.totalTokens).toBe(7);
  });
  it("returns zeros for no rows", () => {
    expect(summarizeUsage([], () => "ticket", 0)).toMatchObject({ totalTokens: 0, cacheReadShare: 0, over200kShare: 0 });
  });
});
