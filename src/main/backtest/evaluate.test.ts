import { describe, expect, it } from "vitest";
import { canonicalJson, defHash, evaluateBacktest, type EvalInput } from "./evaluate";

const diff = (path: string, start: number, lines: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},0 +${start},${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n");

const base = (over: Partial<EvalInput> = {}): EvalInput => ({
  check: { type: "forbidden_pattern", params: { pattern: "console\\.log" }, globs: ["src/**"], excludeGlobs: ["**/*.test.ts"] },
  ticketPattern: "",
  tolerance: 3,
  prs: [],
  prComments: {},
  sources: [],
  ...over,
});

describe("evaluateBacktest", () => {
  it("counts hits on added lines in scope and splits them by whether a comment pointed nearby", () => {
    const out = evaluateBacktest(base({
      prs: [
        { number: 1, diff: diff("src/a.ts", 10, ["ok", "console.log(1)", "x", "console.log(2)"]) },
        { number: 2, diff: [diff("src/b.ts", 1, ["console.log(3)"]), diff("src/b.test.ts", 1, ["console.log(4)"]), diff("lib/c.ts", 1, ["console.log(5)"])].join("\n") },
      ],
      prComments: { 1: [{ path: "src/a.ts", line: 14 }, { path: null, line: null }], 2: [{ path: "src/other.ts", line: 1 }] },
    }));
    expect(out).toMatchObject({ prs: 2, hits: 3, matched: 2, unmatchedTotal: 1 });
    expect(out.unmatched).toEqual([{ pr: 2, path: "src/b.ts", line: 1, text: "console.log(3)", context: "1> console.log(3)" }]);
  });

  it("tolerance 0 needs the exact line", () => {
    const out = evaluateBacktest(base({ tolerance: 0, prs: [{ number: 1, diff: diff("src/a.ts", 1, ["console.log(1)"]) }], prComments: { 1: [{ path: "src/a.ts", line: 2 }] } }));
    expect(out).toMatchObject({ hits: 1, matched: 0, unmatchedTotal: 1 });
  });

  it("recall: a source comment is caught when the check fires near its line in the reviewed file", () => {
    const content = ["a", "b", "console.log(x)", "c"].join("\n");
    const out = evaluateBacktest(base({
      sources: [
        { sourceId: 1, prNumber: 5, path: "src/a.ts", line: 4, content },
        { sourceId: 2, prNumber: 5, path: "src/a.ts", line: 40, content },
        { sourceId: 3, prNumber: 5, path: "lib/a.ts", line: 3, content },
        { sourceId: 4, prNumber: 6, path: "src/a.ts", line: 3, content: null },
        { sourceId: 5, prNumber: 6, path: "src\\w.ts", line: null, content },
      ],
    }));
    expect(out.comments).toBe(4);
    expect(out.commentsMatched).toBe(2);
    expect(out.caught.map((c) => c.sourceId)).toEqual([1, 5]);
    expect(out.caught[1].path).toBe("src/w.ts");
    expect(out.missed.map((c) => c.sourceId)).toEqual([2, 3]);
  });

  it("no material gives zero counts", () => {
    expect(evaluateBacktest(base())).toMatchObject({ prs: 0, hits: 0, comments: 0, commentsMatched: 0 });
  });
});

describe("defHash", () => {
  it("ignores key order and changes with the definition", () => {
    const a = defHash({ type: "forbidden_pattern", params: { pattern: "x", flags: "i" }, globs: [], excludeGlobs: [] });
    const b = defHash({ type: "forbidden_pattern", params: { flags: "i", pattern: "x" }, globs: [], excludeGlobs: [] });
    const c = defHash({ type: "forbidden_pattern", params: { pattern: "y" }, globs: [], excludeGlobs: [] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] })).toBe('{"a":[2,{"d":1}],"b":1}');
  });
});
