import { describe, expect, it } from "vitest";
import { JUDGE_REASON_CHARS, sanitizeJudgeReason, stripModelTags } from "./judge-text";

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
