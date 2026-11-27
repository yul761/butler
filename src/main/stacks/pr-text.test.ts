import { describe, expect, it } from "vitest";
import { parseCreatedUrl } from "./gh-stack";
import { bottomBody, dependsLine, draftBody, draftTitle, stackGraph, stripPrefix, T, withDependsLine, withoutDependsLine } from "./pr-text";

describe("stack PR text", () => {
  it("the conflict hand-off says Shipherd won't reuse a rerere resolution, in both languages (BTL-278)", () => {
    const p = { branch: "b", files: ["b.txt"], onto: "1111111", upstream: "2222222", above: ["c"], push: true };
    const zh = T("zh").conflict(p);
    const en = T("en").conflict(p);
    expect(zh).toContain("不会自动套用 rerere 记下的解法");
    expect(zh).not.toContain("自动套用。");
    expect(en).toContain("never reuses a resolution rerere remembers");
    expect(en).not.toContain("reuses your resolution next time");
    expect(zh).toContain("不 rebase");
    expect(en).toContain("not to rebase");
  });

  it("prefixes draft titles in both languages and strips either prefix", () => {
    expect(draftTitle(3, 6, "Add cache", "zh")).toBe("[stack 3/6 · 勿 review] Add cache");
    expect(draftTitle(3, 6, "[stack 2/6 · 勿 review] Add cache", "en")).toBe("[stack 3/6 · do not review] Add cache");
    expect(stripPrefix("[stack 1/2 · do not review] X")).toBe("X");
    expect(stripPrefix("Plain")).toBe("Plain");
  });

  it("writes the depends line first and replaces only that line", () => {
    expect(dependsLine({ prNumber: 123, branch: "a" }, "zh")).toBe("依赖 #123，暂不需要 review");
    expect(dependsLine({ prNumber: null, branch: "a" }, "en")).toBe("Depends on branch `a`; no review needed yet");
    const body = "依赖 #1，暂不需要 review\n\n<!-- shipherd:brief -->x<!-- /shipherd:brief -->";
    expect(withDependsLine(body, "依赖 #2，暂不需要 review")).toBe("依赖 #2，暂不需要 review\n\n<!-- shipherd:brief -->x<!-- /shipherd:brief -->");
    expect(withDependsLine("hello", "Depends on #2; no review needed yet")).toBe("Depends on #2; no review needed yet\n\nhello");
    expect(withoutDependsLine(body)).toBe("<!-- shipherd:brief -->x<!-- /shipherd:brief -->");
    expect(withoutDependsLine("hello")).toBe("hello");
  });

  it("draws the stack and marks the layer to review", () => {
    const g = stackGraph([
      { branch: "a", prNumber: 1, state: "merged", title: "A" },
      { branch: "b", prNumber: 2, state: "ready", title: "B" },
      { branch: "c", prNumber: null, state: "branch_only", title: null },
    ], 1, "en");
    expect(g).toBe("1. #1 A · merged\n2. **#2 B** · ready for review ← review this one now\n3. `c` · branch");
  });

  it("puts the brief before the commit list on the bottom PR", () => {
    const body = bottomBody({ k: 2, n: 4, brief: "## Brief\nok", commits: ["b one"], graph: [], current: 0, above: ["c", "d"] }, "en");
    expect(body.indexOf("## Brief")).toBeLessThan(body.indexOf("### Commits"));
    expect(body).toContain("Still above: `c` → `d`");
    expect(bottomBody({ k: 1, n: 1, brief: null, commits: [], graph: [], current: 0, above: [] }, "zh")).toContain("这是最后一层");
  });

  it("starts a draft body with the depends line", () => {
    expect(draftBody({ prNumber: 5, branch: "a" }, [], 1, "zh").split("\n")[0]).toBe("依赖 #5，暂不需要 review");
  });

  it("has the same keys in both languages", () => {
    expect(Object.keys(T("en")).sort()).toEqual(Object.keys(T("zh")).sort());
  });

  it("parses the URL gh prints after creating", () => {
    expect(parseCreatedUrl("Warning: 1 uncommitted change\nhttps://github.com/acme/app/pull/12\n")).toEqual({ number: 12, url: "https://github.com/acme/app/pull/12" });
    expect(parseCreatedUrl("https://ghe.example.com/acme/app/issues/3")).toEqual({ number: 3, url: "https://ghe.example.com/acme/app/issues/3" });
    expect(parseCreatedUrl("nope")).toBeNull();
  });
});
