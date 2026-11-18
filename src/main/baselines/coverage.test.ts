import { describe, expect, it } from "vitest";
import { coverageIn, factCovers, globsOverlapDir } from "./coverage";
import { scanFiles } from "./scan";
import { resolveRules } from "./rules";
import { JS_REPO, MONO_REPO, PY_REPO } from "./__fixtures__/repos";

const checksOf = (repo: Record<string, string>) => scanFiles({ files: Object.keys(repo), read: (p) => repo[p] ?? null, rules: resolveRules([]) }).checks;

describe("coverage for lessons", () => {
  const js = checksOf(JS_REPO);
  it("matches a rule the config turns on by name (strong)", () => {
    expect(coverageIn("a/web", js, "Never leave no-console violations")[0]).toMatchObject({ via: "fact", matched: "no-console", strength: "strong", check: expect.objectContaining({ tool: "eslint" }) });
  });
  it("matches wording through the concept table, in Chinese too", () => {
    expect(coverageIn("a/web", js, "不要留下没用到的变量")[0]).toMatchObject({ via: "concept", matched: "unused:noUnusedLocals", strength: "strong" });
    expect(coverageIn("a/web", js, "Remove console.log calls before merging")[0]).toMatchObject({ matched: "console:no-console", strength: "strong" });
    expect(coverageIn("a/web", js, "代码格式要统一")[0]).toMatchObject({ via: "concept", strength: "weak", check: expect.objectContaining({ category: "format" }) });
  });
  it("handles ruff code families and nothing for unrelated rules", () => {
    const py = checksOf(PY_REPO);
    expect(coverageIn("a/svc", py, "F401: unused import must go")[0]).toMatchObject({ via: "fact", matched: "F401", check: expect.objectContaining({ tool: "ruff" }) });
    expect(coverageIn("a/svc", py, "Name things after the domain")).toEqual([]);
    expect(factCovers("F", "F401")).toBe(true);
    expect(factCovers("F", "FA100")).toBe(false);
    expect(factCovers("@typescript-eslint/no-explicit-any", "no-explicit-any")).toBe(true);
  });
  it("respects the lesson's path scope in a monorepo", () => {
    const mono = checksOf(MONO_REPO);
    const hits = coverageIn("a/mono", mono, "Keep type errors at zero", ["packages/web/**"]);
    expect(hits.map((h) => h.dir)).toEqual(["packages/web"]);
    expect(globsOverlapDir(["services/api/**/*.py"], "packages/web")).toBe(false);
    expect(globsOverlapDir(["*.ts"], "packages/web")).toBe(true);
    expect(globsOverlapDir(["packages/**"], "packages/web")).toBe(true);
  });
});
