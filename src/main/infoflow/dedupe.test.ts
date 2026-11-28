import { describe, expect, it } from "vitest";
import { DUP_SIMILARITY, findDuplicate, normalizeFact, similarity } from "./dedupe";

describe("normalizeFact", () => {
  it("drops a source note whose session name has brackets", () => {
    expect(normalizeFact("BTL-12 不做了（来自 S(t12) 的对话）")).toBe(normalizeFact("BTL-12 不做了"));
    expect(normalizeFact("Use pagination (from Fix (2)'s conversation)")).toBe("usepagination");
  });

  it("drops punctuation, spaces, case and a trailing source note", () => {
    expect(normalizeFact("BTL-12 不做了，需求变了。（来自 epic 4 总控的对话）")).toBe("btl12不做了需求变了");
    expect(normalizeFact("API returns pages (from BTL-3's conversation)")).toBe("apireturnspages");
  });
});

describe("similarity", () => {
  it("is 1 for the same fact written differently and low for different facts", () => {
    expect(similarity("BTL-12 不做了，需求变了", "btl 12 不做了 —— 需求变了！")).toBe(1);
    expect(similarity("以后接口一律分页返回", "导出按钮放到右上角")).toBeLessThan(0.2);
    expect(similarity("", "x")).toBe(0);
  });
});

describe("findDuplicate", () => {
  const memory = ["[ticket:BTL-3] 登录接口改成返回 token 和 refreshToken 两个字段", "以后 PR 一律先跑 e2e 再开", "BTL-12 不做了"];

  it("finds a near-identical fact", () => {
    expect(findDuplicate("登录接口改成返回 token 和 refreshToken 两个字段。", memory)).toBe(memory[0]);
    expect(findDuplicate("以后PR一律先跑e2e再开！", memory)).toBe(memory[1]);
  });

  it("finds a fact contained in a longer one, but not a short substring", () => {
    expect(findDuplicate("登录接口改成返回 token 和 refreshToken", memory)).toBe(memory[0]);
    // 「BTL-12 不做了」只有 8 个字：太短，包含关系不算；整句相似度也不够。
    expect(findDuplicate("BTL-12 不做了，因为客户换了需求，PR #41 也要关掉", memory)).toBeNull();
  });

  it("finds an exact repeat of a short fact", () => {
    expect(findDuplicate("BTL-12 不做了", ["BTL-12 不做了"])).toBe("BTL-12 不做了");
    expect(findDuplicate("btl-12：不做了。", memory)).toBe(memory[2]);
    expect(findDuplicate("BTL-12 不做了", ["BTL-12 不做了（来自 S(t12) 的对话）"])).toBe("BTL-12 不做了（来自 S(t12) 的对话）");
  });

  it("lets a newer fact through when it says more than an older one it contains", () => {
    const old = ["接口 /users 一律分页返回"];
    expect(findDuplicate("接口 /users 一律分页返回，每页最多 100 条", old)).toBeNull();
    expect(findDuplicate("接口 /users 一律分页返回", ["接口 /users 一律分页返回，每页最多 100 条"])).toBe("接口 /users 一律分页返回，每页最多 100 条");
  });

  it("never merges facts about different numbers", () => {
    const old = ["BTL-12 改成先做，客户下周要先看登录这一块"];
    expect(findDuplicate("BTL-13 改成先做，客户下周要先看登录这一块", old)).toBeNull();
    expect(findDuplicate("btl 12 改成先做：客户下周要先看登录这一块", old)).toBe(old[0]);
  });

  it("keeps a different fact", () => {
    expect(findDuplicate("导出按钮放到右上角", memory)).toBeNull();
    expect(findDuplicate("   ", memory)).toBeNull();
  });

  it("uses the documented threshold", () => {
    expect(DUP_SIMILARITY).toBeGreaterThan(0.5);
  });
});
