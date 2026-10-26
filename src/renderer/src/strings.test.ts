import { afterEach, describe, expect, it } from "vitest";
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
});
