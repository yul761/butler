import { describe, expect, it } from "vitest";
import { JUDGE_REASON_CHARS, sanitizeJudgeReason, stripModelTags, stripToolMarkup } from "./judge-text";

/** 真机检查（840ca90）里 Haiku 实际给出的理由。 */
const LIVE = "询问用户是否把改动拆成两个 PR，需要用户做决定</reason>\n</invoke>\n";

describe("stripModelTags", () => {
  it("cuts at the first tag-like token and drops everything after it", () => {
    expect(stripModelTags(LIVE)).toBe("询问用户是否把改动拆成两个 PR，需要用户做决定");
    expect(stripModelTags("在等锁<parameter name=\"x\">y")).toBe("在等锁<parameter name=\"x\">y"); // 带属性的不像我们见过的标签，不动
    expect(stripModelTags("先 <b>确认</b> 再说")).toBe("先 ");
    expect(stripModelTags("<reason>整段被包起来")).toBe("");
    expect(stripModelTags("用 a<b 比较，x > y")).toBe("用 a<b 比较，x > y");
    expect(stripModelTags("没有标签\n第二行")).toBe("没有标签\n第二行");
  });
});

describe("sanitizeJudgeReason", () => {
  it("strips the stray tags of the live answer", () => {
    expect(sanitizeJudgeReason(LIVE)).toBe("询问用户是否把改动拆成两个 PR，需要用户做决定");
  });

  it("collapses whitespace, trims and caps at 80 characters without splitting a surrogate pair", () => {
    expect(JUDGE_REASON_CHARS).toBe(80);
    expect(sanitizeJudgeReason("  要不要\n\n  拆 PR？  ")).toBe("要不要 拆 PR？");
    expect([...sanitizeJudgeReason("问".repeat(100))]).toHaveLength(80);
    const emoji = sanitizeJudgeReason(`${"a".repeat(79)}😀😀`);
    expect([...emoji]).toHaveLength(80);
    expect(emoji.endsWith("😀")).toBe(true);
    expect(sanitizeJudgeReason("")).toBe("");
  });
});

describe("stripToolMarkup (R37: durable history keeps code-like angle brackets)", () => {
  /** 带命名空间的工具标签（模型的工具调用格式用的那种）。 */
  const NS = ["ant", "ml"].join("");
  it("keeps generics and component names", () => {
    expect(stripToolMarkup("handler 返回 Promise<void>，表单换成 <Button> 组件")).toBe("handler 返回 Promise<void>，表单换成 <Button> 组件");
    expect(stripToolMarkup("Map<string, number> 和 List<T>")).toBe("Map<string, number> 和 List<T>");
  });

  it("removes known opening tool tags and cuts at the first closing one", () => {
    expect(stripToolMarkup("询问用户是否拆 PR</reason>\n</invoke>\n")).toBe("询问用户是否拆 PR");
    expect(stripToolMarkup('<parameter name="what">用 Map<K, V> 缓存</parameter>多余')).toBe("用 Map<K, V> 缓存");
    expect(stripToolMarkup(`<${NS}:invoke name="x">做完了</${NS}:invoke>后面`)).toBe("做完了");
    expect(stripToolMarkup("<function_calls>a</function_calls>b")).toBe("a");
    expect(stripToolMarkup("下单和支付联调完成。\n退款还没开始。</summary>\n</invoke>")).toBe("下单和支付联调完成。\n退款还没开始。");
  });

  it("does not cut at a closing tag that is not tool markup", () => {
    expect(stripToolMarkup("把 </Button> 的写法统一")).toBe("把 </Button> 的写法统一");
  });
});
