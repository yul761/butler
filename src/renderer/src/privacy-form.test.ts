import { describe, expect, it } from "vitest";
import type { LlmStatus } from "../../shared/llm";
import { formatUsd, llmWarnings, parseTermsText, termsText } from "./privacy-form";
import { S } from "./strings";

const ok: LlmStatus = {
  keySaved: true, keyMasked: "••••cdef", keyUnreadable: false, encryptionAvailable: true,
  configured: true, priceKnown: true, monthCostUsd: 0.12, budgetUsd: 1,
};

describe("privacy form helpers", () => {
  it("turns the term list into two textareas and back", () => {
    const terms = [{ term: "张三", category: "person" as const }, { term: "天穹计划", category: "term" as const }, { term: "Alice", category: "person" as const }];
    expect(termsText(terms, "person")).toBe("张三\nAlice");
    expect(termsText(terms, "term")).toBe("天穹计划");
    expect(parseTermsText(" 张三 \n\nAlice\r\n", "天穹计划\n")).toEqual(terms.slice(0, 1).concat(terms[2], terms[1]));
  });

  it("formats small amounts with enough precision", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0023)).toBe("$0.0023");
    expect(formatUsd(1.5)).toBe("$1.50");
  });

  it("warns about whatever keeps the narrative from being generated", () => {
    expect(llmWarnings(ok, "metadata", 0)).toEqual([]);
    expect(llmWarnings(ok, "off", 0)).toEqual(["个人 API 已关闭：简报里不会有“今日重点”。"]);
    expect(llmWarnings({ ...ok, configured: false }, "metadata", 0)).toEqual(["还没有配置完：需要服务地址、模型，远程服务还需要 API key。"]);
    expect(llmWarnings({ ...ok, priceKnown: false }, "metadata", 0)).toEqual(["价格表里没有当前模型的价格：不会调用。"]);
    expect(llmWarnings({ ...ok, keyUnreadable: true, configured: false }, "redacted", 0)[0]).toContain("无法解密");
    expect(llmWarnings({ ...ok, monthCostUsd: 1 }, "metadata", 0)[0]).toContain("预算");
    expect(llmWarnings({ ...ok, monthCostUsd: 0, budgetUsd: 0 }, "metadata", 0)).toEqual([]);
    expect(llmWarnings(ok, "full", 0)[0]).toContain("真实的 ticket 号");
  });

  it("warns about unlisted person names only at the redacted level with an empty people list", () => {
    expect(llmWarnings(ok, "redacted", 0)).toEqual([S.privacyPeopleWarning]);
    expect(llmWarnings(ok, "redacted", 2)).toEqual([]);
    expect(llmWarnings(ok, "metadata", 0)).toEqual([]);
    expect(llmWarnings(ok, "full", 0)).toHaveLength(1);
    expect(llmWarnings(ok, "off", 0)).toEqual([S.llmOff]);
  });
});
