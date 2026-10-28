import { afterEach, describe, expect, it } from "vitest";
import { blockedText } from "./audit-view";
import { S, STATUS_LABEL, STRINGS, setUiLang } from "./strings";

/** 递归列出键：值的种类（字符串 / 函数及参数个数 / 对象 / 数组长度）也算进去，两种语言必须一模一样。 */
function shape(v: unknown, path = ""): string[] {
  if (typeof v === "function") return [`${path}:fn${v.length}`];
  if (Array.isArray(v)) return [`${path}:array${v.length}`];
  if (v && typeof v === "object") return Object.keys(v).sort().flatMap((k) => shape((v as Record<string, unknown>)[k], `${path}.${k}`));
  return [`${path}:${typeof v}`];
}

afterEach(() => setUiLang("zh"));

describe("UI strings in two languages (design 2026-10-26 i18n)", () => {
  it("has the same keys, kinds and function arities in English and Chinese", () => {
    expect(shape(STRINGS.en)).toEqual(shape(STRINGS.zh));
  });

  it("has no Chinese left in the English strings", () => {
    const texts: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") texts.push(v);
      else if (typeof v === "function") texts.push(String((v as (...a: unknown[]) => unknown)(...Array(v.length).fill([]))));
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(STRINGS.en);
    // 语言选项故意用各自的语言写：“中文”、“语言 / Language”。
    expect(texts.filter((t) => /[\u4e00-\u9fff]/.test(t) && t !== "中文" && t !== "语言 / Language")).toEqual([]);
  });

  it("switches S and STATUS_LABEL", () => {
    setUiLang("en");
    expect(S.newTicket).toBe("New ticket");
    expect(STATUS_LABEL.done).toBe("Done");
    setUiLang("zh");
    expect(S.newTicket).toBe("新建 ticket");
    expect(STATUS_LABEL.done).toBe("完成");
  });

  it("uses singular and plural in English", () => {
    const en = STRINGS.en;
    expect(en.memoryVersions(1)).toBe("1 version");
    expect(en.memoryVersions(3)).toBe("3 versions");
    expect(en.briefRule.unclaimed({ count: 1 } as never)).toBe("1 unclaimed session");
    expect(en.briefRule.followup_due({ days: 1, text: "x" } as never)).toBe("1 day overdue: x");
    expect(en.briefRule.stale({ days: 1 } as never)).toBe("No activity for 1 day");
    expect(en.detectedTools(1, 1)).toBe("Found 1 MCP tool; 1 has a query-like name and is ticked. The others are not added unless you tick them:");
    expect(en.subReposFound(1)).toBe("This is a parent folder with 1 repo:");
  });

  it("uses ASCII punctuation around values in English", () => {
    setUiLang("en");
    expect(S.labelled("Workspace", "/w")).toBe("Workspace: /w");
    expect(blockedText([{ rule: "url", sample: "https://x" }] as never)).toBe("a URL (https://x)");
    setUiLang("zh");
    expect(S.labelled("工作区", "/w")).toBe("工作区：/w");
    expect(blockedText([{ rule: "url", sample: "https://x" }] as never)).toBe("网址（https://x）");
  });

  it("sets the page language for screen readers", () => {
    const g = globalThis as { document?: { documentElement: { lang: string } } };
    const had = g.document;
    g.document = { documentElement: { lang: "zh-CN" } };
    try {
      setUiLang("en");
      expect(g.document.documentElement.lang).toBe("en");
      setUiLang("zh");
      expect(g.document.documentElement.lang).toBe("zh-CN");
    } finally {
      g.document = had;
    }
  });

  it("has the feature summary strings in both languages", () => {
    for (const s of [STRINGS.zh, STRINGS.en]) {
      expect(s.featureProgress).toBeTruthy();
      expect(s.featureSummaryNone).toBeTruthy();
      expect(s.featureSummaryDegraded).toBeTruthy();
      expect(s.runFeatureSummary).toBeTruthy();
      expect(s.featureSummaryRunning).toBeTruthy();
      expect(Object.keys(s.featureSummaryTrigger).sort()).toEqual(["command", "manual", "nightly"]);
      expect(Object.keys(s.featureSummarySkipped).sort()).toEqual(["nothing_to_summarize", "rate_limited"]);
      expect(Object.keys(s.prPill).sort()).toEqual(["approved", "changes", "closed", "merged", "pending"]);
      expect(s.noPr).toBeTruthy();
    }
  });

  it("mentions in the language hint that /handoff needs an update after a switch", () => {
    expect(STRINGS.en.languageHint).toContain("/handoff");
    expect(STRINGS.zh.languageHint).toContain("/handoff");
  });
});
