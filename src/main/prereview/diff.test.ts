import { describe, expect, it } from "vitest";
import { diffForModel, fromCompare, parseNumstatZ, prDiff, splitPatch } from "./diff";
import { lessonApplies } from "./lessons";

describe("diff parsing", () => {
  it("parses numstat -z including renames and binaries, with / paths", () => {
    expect(parseNumstatZ("3\t1\tsrc\\a.ts\0-\t-\timg.png\x000\t0\t\0old.ts\0new.ts\0")).toEqual([
      { path: "src/a.ts", added: 3, deleted: 1, binary: false },
      { path: "img.png", added: 0, deleted: 0, binary: true },
      { path: "new.ts", added: 0, deleted: 0, binary: false },
    ]);
  });

  it("splits a unified diff by file, deleted files keep their old path", () => {
    const out = "diff --git a/x.ts b/x.ts\nindex 1..2\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone";
    const m = splitPatch(out);
    expect([...m.keys()]).toEqual(["x.ts", "y.ts"]);
    expect(m.get("x.ts")).toContain("+b");
  });

  it("prDiff falls back from origin/<base> to <base> and returns null when neither resolves", async () => {
    const calls: string[][] = [];
    const run = async (_: string, a: string[]) => {
      calls.push(a);
      if (a[0] === "merge-base") { if (a[2] === "origin/main") throw new Error("no"); return "mb"; }
      return a.includes("--numstat") ? "1\t0\ta.ts\0" : "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n+x";
    };
    const d = await prDiff("/w", "s1", "main", run);
    expect(d).toMatchObject({ base: "mb", files: [{ path: "a.ts", added: 1 }], source: "git" });
    expect(await prDiff("/w", "s1", "main", async () => { throw new Error("x"); })).toBeNull();
  });

  it("diffForModel gives generated files stats only and respects the size cap", () => {
    const d = fromCompare([{ filename: "pnpm-lock.yaml", patch: "+a\n+b" }, { filename: "a.ts", patch: "+x".repeat(50) }, { filename: "b.ts", patch: "+y" }]);
    const r = diffForModel(d, ["pnpm-lock.yaml"], 10);
    expect(r.text).toContain("### pnpm-lock.yaml (+2 -0)\n(stats only)");
    expect(r.omitted).toEqual(["a.ts"]);
    expect(r.text).toContain("+y");
  });
});

describe("lessonApplies", () => {
  it("globs and language both have to match a changed file", () => {
    expect(lessonApplies({ scopeGlobs: [], scopeLang: null }, ["a.py"])).toBe(true);
    expect(lessonApplies({ scopeGlobs: ["src/**"], scopeLang: null }, ["docs/a.md"])).toBe(false);
    expect(lessonApplies({ scopeGlobs: [], scopeLang: "ts" }, ["a.tsx"])).toBe(true);
    expect(lessonApplies({ scopeGlobs: [], scopeLang: "ts" }, ["a.py"])).toBe(false);
    expect(lessonApplies({ scopeGlobs: [], scopeLang: null }, [])).toBe(false);
  });
});
