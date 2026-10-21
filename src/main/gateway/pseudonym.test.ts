import { describe, expect, it } from "vitest";
import { normalizeText, PLACEHOLDER_RE, Pseudonymizer, restore } from "./pseudonym";
import { seededRng } from "./testing";

const dict = {
  tickets: ["PROJ-12", "PROJ-123"],
  repos: ["acme-billing"],
  branches: ["feature/PROJ-12-login"],
  people: ["张三", "Alice Zhang"],
  terms: ["天穹计划"],
};

describe("Pseudonymizer", () => {
  it("replaces every spelling of a known value", () => {
    const p = new Pseudonymizer(dict, seededRng(1));
    const text = "修好PROJ-12的bug，proj-123 等ＰＲＯＪ－１２合并；分支 feature/PROJ-12-login 在 acme-billing 仓库；找张三和alice zhang确认天穹计划。";
    const out = p.apply(text);
    for (const v of ["PROJ-12", "PROJ-123", "acme-billing", "feature/PROJ-12-login", "张三", "Alice Zhang", "天穹计划"]) {
      expect(out.toLowerCase()).not.toContain(v.toLowerCase());
    }
    expect(out).not.toContain("ＰＲＯＪ");
    // PROJ-12（两种写法）、PROJ-123、分支、仓库、两个人名、一个敏感词：7 个不同的占位符。
    expect(new Set(out.match(PLACEHOLDER_RE)).size).toBe(7);
    expect(restore(out, p.mapping)).toEqual({
      text: normalizeText(text).replace("proj-123", "PROJ-123").replace("alice zhang", "Alice Zhang"),
      dropped: 0,
    });
  });

  it("draws fresh random placeholders for every request", () => {
    const a = new Pseudonymizer(dict);
    const b = new Pseudonymizer(dict);
    expect(a.token("T", "PROJ-12")).toMatch(/^\[\[T_[a-z0-9]{4}\]\]$/);
    expect(a.token("T", "PROJ-12")).not.toBe(b.token("T", "PROJ-12"));
    // 同一次请求里同一个值永远是同一个占位符，不分大小写。
    expect(a.token("T", "proj-12")).toBe(a.token("T", "PROJ-12"));
  });

  it("skips one-character values and still hands out ids for values outside the dictionary", () => {
    const p = new Pseudonymizer({ tickets: [], repos: ["a"], branches: [], people: [], terms: [] }, seededRng(2));
    expect(p.apply("a b c")).toBe("a b c");
    const t = p.token("T", "NEW-1");
    expect(p.mapping.get(t)).toBe("NEW-1");
    expect(p.originals()).toEqual(["NEW-1"]);
  });

  it("restore drops sentences with unknown or mangled placeholders", () => {
    const p = new Pseudonymizer(dict, seededRng(3));
    const t = p.token("T", "PROJ-12");
    const upper = t.toUpperCase();
    const single = t.slice(1, -1);
    const r = restore(`先合并 ${t} 的 PR。再看 [[T_0000]] 的阻塞。然后 ${upper} 收尾！最后 ${single} 部署？还有 [[S_ab 的事。`, p.mapping);
    expect(r).toEqual({ text: "先合并 PROJ-12 的 PR。", dropped: 4 });
  });
});
