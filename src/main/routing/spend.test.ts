import { describe, expect, it } from "vitest";
import type { RegistryModel } from "../../shared/model-routing";
import { memDb } from "../test-utils";
import { migrate } from "../db/database";
import { UsageRepo, type SpendRow } from "../db/usage-repo";
import { parseQuotas, parseThresholds, periodEnd, periodStart, registryModelFor, summarizeSpend } from "./spend";

const reg = (name: string, tier: RegistryModel["tier"], priceIn: number | null = null, priceOut: number | null = null): RegistryModel => ({
  name, tier, enabled: true, account: "default", priceIn, priceOut, note: "",
});
const row = (model: string | null, task: string | null, over: Partial<SpendRow> = {}): SpendRow => ({
  model, task, rows: 1, input: 1000, output: 500, tokens: 1500, costUsd: 0, unpricedInput: 1000, unpricedOutput: 500, unpricedRows: 1, ...over,
});

describe("period", () => {
  it("starts on the configured day, local time", () => {
    const now = new Date(2026, 10, 17, 12).getTime();
    expect(periodStart(now, 1)).toBe(new Date(2026, 10, 1).getTime());
    expect(periodStart(now, 20)).toBe(new Date(2026, 9, 20).getTime());
    expect(periodStart(now, 17)).toBe(new Date(2026, 10, 17).getTime());
    expect(periodStart(now, 99)).toBe(new Date(2026, 9, 28).getTime());
    expect(periodEnd(new Date(2026, 11, 15).getTime())).toBe(new Date(2027, 0, 15).getTime());
  });
});

describe("settings parsing", () => {
  it("thresholds", () => {
    expect(parseThresholds("70,90")).toEqual([0.7, 0.9]);
    expect(parseThresholds("50, 80")).toEqual([0.5, 0.8]);
    expect(parseThresholds("90,70")).toEqual([0.7, 0.9]);
    expect(parseThresholds("")).toEqual([0.7, 0.9]);
  });
  it("quotas drop bad entries", () => {
    expect(parseQuotas(JSON.stringify([
      { target: "tier:high", unit: "usd", monthly: 100 },
      { target: "model:claude-x", unit: "tokens", monthly: 1e6 },
      { target: "tier:ultra", unit: "usd", monthly: 1 },
      { target: "model:x", unit: "eur", monthly: 1 },
      { target: "model:x", unit: "usd", monthly: -1 },
    ]))).toEqual([{ target: "tier:high", unit: "usd", monthly: 100 }, { target: "model:claude-x", unit: "tokens", monthly: 1e6 }]);
    expect(parseQuotas("{oops")).toEqual([]);
  });
});

describe("summarizeSpend", () => {
  it("matches aliases to full names", () => {
    expect(registryModelFor([reg("opus", "high")], "claude-opus-4-1")?.name).toBe("opus");
    expect(registryModelFor([reg("opus", "high")], "claude-sonnet-4")).toBeNull();
  });

  it("money from recorded cost or tokens × price; partial when neither", () => {
    const registry = [reg("H", "high", 10, 50), reg("M", "mid")];
    const s = summarizeSpend(
      [row("H", "pre_review"), row("H", "pr_brief", { costUsd: 2, unpricedRows: 0, unpricedInput: 0, unpricedOutput: 0 }), row("M", "pr_brief")],
      registry, [], [0.7, 0.9],
    );
    const h = s.byModel.find((l) => l.key === "H")!;
    expect(h.usd).toBeCloseTo(2 + (1000 * 10 + 500 * 50) / 1e6);
    expect(h.usdPartial).toBe(false);
    expect(s.byModel.find((l) => l.key === "M")!.usdPartial).toBe(true);
    expect(s.byTask.find((l) => l.key === "pr_brief")!.tokens).toBe(3000);
  });

  it("levels per quota, model and tier quotas both apply", () => {
    const registry = [reg("H", "high"), reg("M", "mid")];
    const rows = [row("H", null, { tokens: 750 }), row("M", null, { tokens: 950 })];
    const s = summarizeSpend(rows, registry, [
      { target: "tier:high", unit: "tokens", monthly: 1000 },
      { target: "model:M", unit: "tokens", monthly: 1000 },
    ], [0.7, 0.9]);
    expect(s.quotas.map((q) => [q.target, q.level])).toEqual([["tier:high", "soft"], ["model:M", "hard"]]);
    expect(s.level("H", "high")).toBe("soft");
    expect(s.level("M", "mid")).toBe("hard");
    expect(s.level("other", "low")).toBe("ok");
  });

  it("reads from session_usage", () => {
    const db = memDb();
    migrate(db);
    const u = new UsageRepo(db);
    const base = { sessionId: null, agentId: null, source: "headless" as const, job: "lessons", input: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 50, output: 10, context: 0 };
    u.record([
      { ...base, messageId: "a", at: 10, model: "H", task: "lesson_analyze", requestedTier: "mid", fallbackFrom: "M", costUsd: 0.5 },
      { ...base, messageId: "b", at: 20, model: "H", task: "lesson_analyze" },
      { ...base, messageId: "c", at: 1, model: "H", task: "lesson_analyze" },
    ]);
    expect(u.spendSince(5)).toEqual([{ model: "H", task: "lesson_analyze", rows: 2, input: 300, output: 20, tokens: 320, costUsd: 0.5, unpricedInput: 150, unpricedOutput: 10, unpricedRows: 1 }]);
    expect(u.since(10)[0]).toMatchObject({ task: "lesson_analyze", requestedTier: "mid", fallbackFrom: "M", costUsd: 0.5 });
  });
});
