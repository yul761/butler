import { describe, expect, it } from "vitest";
import { checkBudget, costUsd, estimateTokens, monthStart } from "./budget";

const price = { pattern: "*", inputPerMTok: 2, outputPerMTok: 8 };

describe("budget", () => {
  it("starts the month at local midnight on the 1st, across year ends", () => {
    expect(monthStart(new Date(2026, 9, 21, 9, 30).getTime())).toBe(new Date(2026, 9, 1).getTime());
    expect(monthStart(new Date(2027, 0, 1, 0, 0).getTime())).toBe(new Date(2027, 0, 1).getTime());
    expect(monthStart(new Date(2026, 11, 31, 23, 59).getTime())).toBe(new Date(2026, 11, 1).getTime());
  });

  it("estimates tokens conservatively for Chinese and ASCII", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("今天ab c")).toBe(2 + 2);
    expect(estimateTokens("abcdef")).toBe(2);
  });

  it("prices usage per million tokens", () => {
    expect(costUsd(price, 1_000_000, 500_000)).toBe(6);
    expect(costUsd(price, 120, 40)).toBeCloseTo(0.00056, 10);
  });

  it("refuses when the model has no price or the estimate would cross the budget", () => {
    const base = { prices: [price], model: "m", budgetUsd: 1, spentUsd: 0, inputText: "x".repeat(300), maxOutputTokens: 800 };
    expect(checkBudget(base)).toMatchObject({ ok: true, price, estimateUsd: (100 * 2 + 800 * 8) / 1_000_000 });
    expect(checkBudget({ ...base, prices: [] })).toMatchObject({ ok: false, reason: "no_price" });
    expect(checkBudget({ ...base, spentUsd: 0.999 })).toMatchObject({ ok: false, reason: "over_budget" });
    // 免费的本机模型：预算为 0 也能用。
    expect(checkBudget({ ...base, prices: [{ pattern: "*", inputPerMTok: 0, outputPerMTok: 0 }], budgetUsd: 0 })).toMatchObject({ ok: true });
  });
});
