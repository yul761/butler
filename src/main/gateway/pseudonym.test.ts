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

  it("replaces invisible-character, dash and whitespace variants", () => {
    const d = { ...dict, people: [...dict.people, "İlker"] };
    const cases: [string, string][] = [
      ["fix PROJ\u200B-12", "PROJ-12"],
      ["fix PR\u200DOJ-12", "PROJ-12"],
      ["fix PROJ\u00AD-12", "PROJ-12"],
      ["fix PROJ-\u206012", "PROJ-12"],
      ["fix PROJ\uFEFF-12", "PROJ-12"],
      ["fix PROJ\u201112", "PROJ-12"],
      ["fix PROJ\u201012", "PROJ-12"],
      ["fix PROJ\u201312", "PROJ-12"],
      ["fix PROJ\u201412", "PROJ-12"],
      ["fix PROJ\u221212", "PROJ-12"],
      ["fix PROJ\uFE6312", "PROJ-12"],
      ["ask Alice  Zhang", "Alice Zhang"],
      ["ask Alice\nZhang", "Alice Zhang"],
      ["ask Alice\u00A0Zhang", "Alice Zhang"],
      ["ask İlker today", "İlker"],
      ["ask İLKER today", "İlker"],
    ];
    for (const [input, orig] of cases) {
      const p = new Pseudonymizer(d, seededRng(1));
      const out = p.apply(input);
      expect(out, input).toMatch(PLACEHOLDER_RE);
      expect(normalizeText(out).toLowerCase(), input).not.toContain(normalizeText(orig).toLowerCase());
      expect(out.replace(/\p{Default_Ignorable_Code_Point}/gu, "").replace(/[\p{Pd}\u2212]/gu, "-").toLowerCase(), input).not.toContain(orig.toLowerCase());
    }
  });

  it("normalizeText is idempotent and strips non-default-ignorable invisibles", () => {
    for (const x of ["PROJ\u200B-12", "PROJ\u201312", "Alice\nZhang", "ＰＲＯＪ－１２", "a\u3164b", "a\uFFA0b", "Jose\u200B\u0301"]) {
      expect(normalizeText(normalizeText(x)), x).toBe(normalizeText(x));
    }
    const p = new Pseudonymizer({ ...dict, people: ["José"] }, seededRng(1));
    expect(p.apply("ask Jose\u200B\u0301 now")).toMatch(PLACEHOLDER_RE);
    for (const c of ["\u2800", "\u0085", "\uFFF9", "\u0600", "\u2028"]) {
      const q = new Pseudonymizer(dict, seededRng(1));
      const out = q.apply(`fix PROJ${c}-12`);
      expect(out.toLowerCase(), JSON.stringify(c)).not.toContain("proj");
    }
  });

  it("restore keeps the original punctuation and symbols", () => {
    const p = new Pseudonymizer(dict, seededRng(3));
    const t = p.token("T", "PROJ-12");
    const text = `先合并 ${t}，再部署：看（日志）！℃ m² ❤️ 👨‍👩‍👧…`;
    expect(restore(text, p.mapping)).toEqual({ text: text.replace(t, "PROJ-12"), dropped: 0 });
  });

  it("restore drops full-width, zero-width-split and en-dash placeholders", () => {
    const p = new Pseudonymizer(dict, seededRng(3));
    const t = p.token("T", "PROJ-12");
    const id = t.slice(4, 8);
    for (const bad of [`［［T_${id}］］`, `[[T_${id.slice(0, 2)}\u200B${id.slice(2)}]]`, `T\u2013${id}`, `T\u2014${id}`]) {
      expect(restore(`坏 ${bad} 完。好。`, p.mapping), bad).toEqual({ text: "好。", dropped: 1 });
    }
  });

  it("replaces values registered through token() afterwards", () => {
    const p = new Pseudonymizer({ tickets: [], repos: [], branches: [], people: [], terms: [] }, seededRng(3));
    const t = p.token("T", "NEW-1");
    expect(p.apply("see new-1 now")).toBe(`see ${t} now`);
  });

  it("never hands out an id that already occurs in the input text", () => {
    // 桩随机数：前 4 次都返回 0（"aaaa"），之后返回 1（"bbbb"）。
    let calls = 0;
    const p = new Pseudonymizer({ tickets: [], repos: [], branches: [], people: [], terms: [] }, () => (calls++ < 4 ? 0 : 1), ["literal [[T_aaaa]] here"]);
    expect(p.token("T", "ABC-1")).toBe("[[T_bbbb]]");
  });

  it("defuses a literal placeholder in the input so it cannot be restored", () => {
    const p = new Pseudonymizer(dict, seededRng(5));
    const t = p.token("T", "PROJ-12");
    const out = p.apply(`user wrote ${t} literally`);
    expect(out).not.toContain(t);
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

  it("restore drops leftover and spoofed placeholder forms", () => {
    const p = new Pseudonymizer(dict, seededRng(3));
    const id = p.token("T", "PROJ-12").slice(4, 8);
    const forms = [`T＿${id}`, `Ｔ_${id}`, `foo T_${id}`, `fooT_${id}`, `T_${id.slice(0, 2)}\u200B${id.slice(2)}`, `T-${id}`, `[[ T_${id} ]]`, `[T_${id}]`];
    for (const f of forms) {
      expect(restore(`坏句子 ${f} 完。好句子。`, p.mapping), f).toEqual({ text: "好句子。", dropped: 1 });
    }
  });

  it("restore keeps ordinary words that merely look similar", () => {
    const p = new Pseudonymizer(dict, seededRng(3));
    const text = "查看 SHA_1234 和 T-shirt 以及 PROJECT_abcd。";
    expect(restore(text, p.mapping)).toEqual({ text, dropped: 0 });
  });
});
