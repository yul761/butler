import { describe, expect, it } from "vitest";
import { auditCutoff, checkBudget, costUsd, estimateTokens, monthStart, sentWithoutUsage, stalePendingCost, STATECORE_MAX_TOKENS } from "./budget";
import { NARRATIVE_MAX_TOKENS } from "./narrative";

const price = { pattern: "*", inputPerMTok: 2, outputPerMTok: 8 };

describe("budget", () => {
  it("starts the month at local midnight on the 1st, across year ends", () => {
    expect(monthStart(new Date(2026, 9, 21, 9, 30).getTime())).toBe(new Date(2026, 9, 1).getTime());
    expect(monthStart(new Date(2027, 0, 1, 0, 0).getTime())).toBe(new Date(2027, 0, 1).getTime());
    expect(monthStart(new Date(2026, 11, 31, 23, 59).getTime())).toBe(new Date(2026, 11, 1).getTime());
  });

  it("prunes the audit by the retention period but never into the current month", () => {
    const now = new Date(2026, 9, 21, 9).getTime();
    expect(auditCutoff(now, 90)).toBe(now - 90 * 86_400_000);
    expect(auditCutoff(now, 7)).toBe(new Date(2026, 9, 1).getTime());
    expect(auditCutoff(now, 1)).toBe(new Date(2026, 9, 1).getTime());
    expect(auditCutoff(new Date(2026, 9, 1, 0, 5).getTime(), 1)).toBe(new Date(2026, 8, 30, 0, 5).getTime());
  });

  it("estimates tokens conservatively for Chinese and ASCII", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("今天ab c")).toBe(2 + 2);
    expect(estimateTokens("abcdef")).toBe(2);
  });

  it("charges a request that was sent without usable usage by its body and the output cap", () => {
    const body = '{"model":"m","messages":["今天"]}';
    expect(sentWithoutUsage(price, body)).toEqual({
      tokensIn: estimateTokens(body), tokensOut: NARRATIVE_MAX_TOKENS, costUsd: costUsd(price, estimateTokens(body), NARRATIVE_MAX_TOKENS),
    });
    const estimate = stalePendingCost([{ pattern: "gpt-*", inputPerMTok: 2, outputPerMTok: 8 }]);
    expect(estimate({ model: "gpt-x", payloadSent: body, source: "narrative" })).toEqual(sentWithoutUsage(price, body));
    expect(estimate({ model: "other", payloadSent: body, source: "narrative" })).toBeNull();
    // StateCore 的遗留 pending 按它自己的输出上限（8192）估，不是“今日重点”的 800。
    expect(estimate({ model: "gpt-x", payloadSent: body, source: "statecore" })).toEqual({
      tokensIn: estimateTokens(body), tokensOut: STATECORE_MAX_TOKENS, costUsd: costUsd(price, estimateTokens(body), STATECORE_MAX_TOKENS),
    });
    expect(STATECORE_MAX_TOKENS).toBe(8192);
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

  it("fails closed on NaN, allows spending exactly up to the budget, and blocks a priced model at budget 0", () => {
    const base = { prices: [price], model: "m", budgetUsd: 1, spentUsd: 0, inputText: "", maxOutputTokens: 125_000 }; // estimate = exactly $1
    expect(checkBudget(base)).toMatchObject({ ok: true });
    expect(checkBudget({ ...base, budgetUsd: 1.0000001 })).toMatchObject({ ok: true });
    expect(checkBudget({ ...base, spentUsd: Number.NaN })).toMatchObject({ ok: false, reason: "over_budget" });
    expect(checkBudget({ ...base, budgetUsd: Number.NaN })).toMatchObject({ ok: false, reason: "over_budget" });
    expect(checkBudget({ ...base, maxOutputTokens: Number.NaN })).toMatchObject({ ok: false, reason: "over_budget" });
    expect(checkBudget({ ...base, budgetUsd: 0 })).toMatchObject({ ok: false, reason: "over_budget" });
  });
});
