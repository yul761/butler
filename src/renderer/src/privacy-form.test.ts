import { describe, expect, it } from "vitest";
import type { LlmStatus } from "../../shared/llm";
import { formatUsd, llmWarnings } from "./privacy-form";
import { S, setUiLang } from "./strings";

const ok: LlmStatus = {
  keySaved: true, keyMasked: "••••cdef", keyUnreadable: false, encryptionAvailable: true,
  configured: true, priceKnown: true, monthCostUsd: 0.12, budgetUsd: 1,
};

describe("privacy form helpers", () => {
  it("formats small amounts with enough precision", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0023)).toBe("$0.0023");
    expect(formatUsd(1.5)).toBe("$1.50");
  });

  it("says plainly that only the full level calls the personal API", () => {
    expect(llmWarnings(ok, "off")).toEqual(["个人 API 已关闭：不会做记忆蒸馏。"]);
    for (const level of ["metadata", "redacted"] as const) {
      expect(llmWarnings(ok, level)).toEqual([S.llmNotFull]);
      // 这两个档位什么都不发：配置上的问题不用提。
      expect(llmWarnings({ ...ok, configured: false, keyUnreadable: true }, level)).toEqual([S.llmNotFull]);
    }
    expect(S.llmNotFull).toContain("完整");
  });

  it("at the full level, warns about whatever keeps distillation from running, then about what it sends", () => {
    expect(llmWarnings(ok, "full")).toEqual([S.llmFullWarning]);
    expect(S.llmFullWarning).toContain("真实的 ticket 号");
    expect(llmWarnings({ ...ok, configured: false }, "full")).toEqual(["还没有配置完：需要服务地址、模型，远程服务还需要 API key。", S.llmFullWarning]);
    expect(llmWarnings({ ...ok, priceKnown: false }, "full")).toEqual(["价格表里没有当前模型的价格：不会调用。", S.llmFullWarning]);
    expect(llmWarnings({ ...ok, keyUnreadable: true, configured: false }, "full")[0]).toContain("无法解密");
    expect(llmWarnings({ ...ok, monthCostUsd: 1 }, "full")[0]).toContain("预算");
    expect(llmWarnings({ ...ok, monthCostUsd: 0, budgetUsd: 0 }, "full")).toEqual([S.llmZeroBudget, S.llmFullWarning]);
  });

  it("describes only memory distillation, in both languages", () => {
    for (const lang of ["zh", "en"] as const) {
      setUiLang(lang);
      const copy = [S.privacyIntro, ...Object.values(S.privacyLevelHelp), S.llmOff, S.llmNotFull, S.llmFullWarning, S.llmConfirm, S.auditIntro, S.wizardPrivacyHelp].join("\n");
      expect(copy, lang).not.toMatch(/今日重点|Today's focus|简报|brief|placeholder|占位符|sensitive-terms|敏感词表/i);
      expect(copy, lang).toMatch(lang === "zh" ? /记忆蒸馏/ : /memory distillation/i);
    }
    setUiLang("zh");
  });
});
