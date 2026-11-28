import { describe, expect, it } from "vitest";
import { DUP_SIMILARITY, findDuplicate, normalizeFact, polarityClash, similarity } from "./dedupe";

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

// BTL-280 实测（specs/4.3.0/shared-brain-design.md L3）：改主意的两句字面很像，Dice ≥ 0.8，以前被当成重复吞掉。
describe("findDuplicate keeps a change of mind (BTL-280 L3)", () => {
  const CHANGED: [string, string][] = [
    ["BTL-280 不等 #109 合了再开始实现", "BTL-280 等 #109 合了再开始实现"],
    ["release must not ask the user first", "release must ask the user first"],
    ["Windows 安装包默认关闭自动更新", "Windows 安装包默认开启自动更新"],
  ];

  it.each(CHANGED)("%s / %s: similar enough to pass the threshold, but not a duplicate either way", (a, b) => {
    // 证明是去重规则本身在拦：光看 Dice 这两句就算重复。
    expect(similarity(a, b)).toBeGreaterThanOrEqual(DUP_SIMILARITY);
    expect(findDuplicate(a, [b])).toBeNull();
    expect(findDuplicate(b, [a])).toBeNull();
    expect(polarityClash(a, b)).toBe(true);
  });

  it("still finds a true duplicate that differs only in punctuation or a filler word", () => {
    expect(findDuplicate("Windows 安装包默认关闭自动更新啦。", ["Windows 安装包默认关闭自动更新"])).toBe("Windows 安装包默认关闭自动更新");
    expect(findDuplicate("BTL-280 不等 #109 合了，再开始实现吧", ["BTL-280 不等 #109 合了再开始实现"])).toBe("BTL-280 不等 #109 合了再开始实现");
    expect(findDuplicate("Release must NOT ask the user first!", ["release must not ask the user first"])).toBe("release must not ask the user first");
    expect(polarityClash("Windows 安装包默认关闭自动更新啦。", "Windows 安装包默认关闭自动更新")).toBe(false);
    // 语气词只在去重里去掉：normalizeFact（actions 找原话用的）照旧。
    expect(normalizeFact("再开始实现吧")).toBe("再开始实现吧");
  });

  it("does not let a contained sentence through when the older one says the opposite", () => {
    // 新的整条在旧的里（包含规则），但旧的多了个「不」：是改主意，不是重复。
    expect(findDuplicate("要等 #109 合了再开始实现 BTL-280", ["不要等 #109 合了再开始实现 BTL-280"])).toBeNull();
    expect(findDuplicate("默认开启 Windows 安装包的自动更新", ["默认开启 Windows 安装包的自动更新以后允许用户关闭"])).toBe("默认开启 Windows 安装包的自动更新以后允许用户关闭");
  });

  it("counts every listed negation word, Chinese and English", () => {
    for (const neg of ["不", "没", "别", "无", "非", "未", "勿"]) expect(polarityClash(`这个 PR ${neg}合并到 main 分支上`, "这个 PR 合并到 main 分支上")).toBe(true);
    for (const [a, b] of [
      ["release does not ask the user first", "release does ask the user first"],
      ["release should never ask the user first", "release should ask the user first"],
      ["release shouldn't ask the user first", "release should ask the user first"],
      ["release shouldn’t ask the user first", "release should ask the user first"],
      ["release goes out with no user check first", "release goes out with a user check first"],
      ["release goes out without asking the user first", "release goes out asking the user first"],
      ["release cannot ask the user first", "release can ask the user first"],
    ]) {
      expect([a, b, polarityClash(a, b)]).toEqual([a, b, true]);
      expect(findDuplicate(a, [b])).toBeNull();
    }
    // 个数一样、词不一样：「没合并」（没做）和「不合并」（不做）是两回事。
    expect(polarityClash("这个 PR 没合并到 main 分支上", "这个 PR 不合并到 main 分支上")).toBe(true);
    // 英文按整词：know 里的 no、notify 里的 not 不算，只有一边有也不算。
    expect(polarityClash("know the answer before the release", "see the answer before the release")).toBe(false);
    expect(polarityClash("notify the reviewer first", "ping the reviewer first")).toBe(false);
    // cannot 和 can not 是同一个否定：不算改主意。
    expect(polarityClash("release cannot ask the user first", "release can not ask the user first")).toBe(false);
    // 词里带着的不算：notify、another、know、nothing 不是否定词。
    expect(polarityClash("notify another reviewer first", "notify another reviewer first please")).toBe(false);
  });

  it("counts an antonym on one side and its opposite on the other", () => {
    const PAIRS: [string, string][] = [
      ["开启", "关闭"], ["打开", "关掉"], ["打开", "关闭"], ["启用", "停用"], ["启用", "禁用"], ["允许", "禁止"],
      ["enable", "disable"], ["enabled", "disabled"], ["on", "off"], ["allow", "deny"], ["show", "hide"], ["include", "exclude"],
    ];
    for (const [x, y] of PAIRS) {
      const a = `the windows installer keeps auto update ${x} by default`;
      const b = `the windows installer keeps auto update ${y} by default`;
      expect([x, y, polarityClash(a, b), polarityClash(b, a)]).toEqual([x, y, true, true]);
      expect(findDuplicate(a, [b])).toBeNull();
    }
    // 两句都两个都有：看先后，换了顺序就是改主意。
    expect(polarityClash("先关闭旧的开关再开启新的开关", "先开启旧的开关再关闭新的开关")).toBe(true);
    expect(findDuplicate("先关闭旧的开关再开启新的开关", ["先开启旧的开关再关闭新的开关"])).toBeNull();
    expect(polarityClash("先关闭旧的开关再开启新的开关", "先关闭旧的开关，再开启新的开关")).toBe(false);
    // 一句两个都有、另一句只有一个：不算，交给包含和相似度。
    expect(polarityClash("默认开启", "默认开启，允许用户关闭")).toBe(false);
    // 两边都是同一个词：照常比较。
    expect(polarityClash("自动更新默认开启", "自动更新默认开启。")).toBe(false);
    // 英文按整词：button 里的 on、shower 里的 show 不算。
    expect(polarityClash("move the button to the top right corner", "move the button to the top right")).toBe(false);
    expect(polarityClash("show the shower", "hide the shower")).toBe(true);
    expect(polarityClash("the shower stays", "the shower hides")).toBe(false);
  });
});
