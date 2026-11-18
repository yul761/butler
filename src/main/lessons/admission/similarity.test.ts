import { describe, expect, it } from "vitest";
import { globsOverlap, textSimilarity, tokens, UnionFind } from "./similarity";

describe("text similarity", () => {
  it("compares Latin words and CJK bigrams", () => {
    expect([...tokens("Use the logger, not console.log")]).toEqual(expect.arrayContaining(["use", "logger", "console", "log"]));
    expect([...tokens("改数据库要加迁移")]).toEqual(expect.arrayContaining(["改数", "数据", "迁移"]));
    expect(textSimilarity("改数据库结构要加迁移", "改数据库结构必须加迁移")).toBeGreaterThan(0.5);
    expect(textSimilarity("改数据库结构要加迁移", "按钮文字要两种语言")).toBeLessThan(0.1);
    expect(textSimilarity("validate IPC arguments", "validate every IPC argument")).toBeGreaterThan(0.3);
    expect(textSimilarity("", "x y")).toBe(0);
  });
});

describe("globsOverlap", () => {
  it.each([
    [[], ["src/**"], true],
    [["src/api/**"], ["src/**"], true],
    [["src/api/**"], ["src/ui/**"], false],
    [["**/*.sql"], ["db/**"], true],
    [["**/*.sql"], ["**/*.ts"], false],
    [["src/a.ts"], ["src/*.ts"], true],
    [["src/a.ts"], ["lib/**"], false],
    [["./src\\api\\**"], ["src/api/x.ts"], true],
  ])("%j vs %j → %s", (a, b, want) => {
    expect(globsOverlap(a, b)).toBe(want);
  });
});

describe("UnionFind", () => {
  it("groups connected ids", () => {
    const u = new UnionFind();
    u.union(5, 3);
    u.union(3, 9);
    u.union(1, 2);
    expect(u.groups([1, 2, 3, 4, 5, 9])).toEqual([[1, 2], [3, 5, 9]]);
  });
});
