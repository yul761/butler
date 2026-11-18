import { describe, expect, it } from "vitest";
import { BUILTIN_RULES, resolveRules, validateRule } from "./rules";

describe("baseline rule table", () => {
  it("has valid, unique built-in rules", () => {
    const keys = new Set<string>();
    for (const r of BUILTIN_RULES) {
      expect(validateRule(r), r.key).not.toHaveProperty("error");
      expect(keys.has(r.key), r.key).toBe(false);
      keys.add(r.key);
    }
    const res = resolveRules([]);
    expect(Object.keys(res.invalid)).toEqual([]);
    expect(res.markers.length + res.keywords.length).toBe(BUILTIN_RULES.length);
  });

  it("covers the ecosystems the plan lists", () => {
    const keys = BUILTIN_RULES.map((r) => r.key);
    for (const k of ["node", "python", "maven", "gradle", "dotnet", "go", "rust", "ruby", "php", "makefile", "justfile", "pre-commit", "husky", "lint-staged", "github-actions", "gitlab-ci", "azure-pipelines"]) {
      expect(keys).toContain(k);
    }
  });

  it("orders keyword rules so generic words come last", () => {
    const kw = resolveRules([]).keywords;
    expect(kw[kw.length - 1].tool).toBe("*");
    expect(kw.findIndex((r) => r.key === "kw-tox-lint")).toBeLessThan(kw.findIndex((r) => r.key === "kw-tox"));
  });

  it("overrides a built-in field by field, disables per layer and adds new rules", () => {
    const res = resolveRules([
      [
        { key: "eslint", rule: JSON.stringify({ files: ["my.eslint.js"] }), enabled: true },
        { key: "kw-acme", rule: JSON.stringify({ kind: "keyword", category: "lint", tool: "acme-lint", match: "\\bacme-lint\\b" }), enabled: true },
      ],
      [{ key: "prettier", rule: "{}", enabled: false }],
    ]);
    const eslint = res.markers.find((r) => r.key === "eslint")!;
    expect(eslint.files).toEqual(["my.eslint.js"]);
    expect(eslint.tools?.[0].tool).toBe("eslint");
    expect(res.markers.find((r) => r.key === "prettier")).toBeUndefined();
    expect(res.keywords.find((r) => r.key === "kw-acme")?.tool).toBe("acme-lint");
    expect(res.origin.eslint).toBe(0);
    expect(res.origin.prettier).toBe(1);
  });

  it("reports invalid rules and ignores them", () => {
    const res = resolveRules([
      [
        { key: "bad-json", rule: "{", enabled: true },
        { key: "bad-regex", rule: JSON.stringify({ kind: "keyword", category: "lint", tool: "x", match: "(" }), enabled: true },
        { key: "bad-extract", rule: JSON.stringify({ kind: "marker", files: ["x"], extract: "nope" }), enabled: true },
      ],
    ]);
    expect(Object.keys(res.invalid).sort()).toEqual(["bad-extract", "bad-json", "bad-regex"]);
  });
});
