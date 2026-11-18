import { describe, expect, it } from "vitest";
import { contextAround, newSideText, parseUnifiedDiff } from "./diff";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1..2 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  "+added",
  " three",
  "@@ -10,2 +11,2 @@ function x() {",
  " ten",
  "-eleven",
  "+ELEVEN",
  "\\ No newline at end of file",
  "diff --git a/old name.ts b/new name.ts",
  "similarity index 100%",
  "rename from old name.ts",
  "rename to new name.ts",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/img.png b/img.png",
  "Binary files a/img.png and b/img.png differ",
  "diff --git a/new.ts b/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,2 @@",
  "+hello",
  "+",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("keeps the new side at its real line numbers and marks added lines", () => {
    const [a, ren, del, bin, nw] = parseUnifiedDiff(DIFF);
    expect(a.path).toBe("src/a.ts");
    expect([...a.added].sort((x, y) => x - y)).toEqual([2, 3, 12]);
    expect(a.lines.get(4)).toBe("three");
    expect(a.lines.get(11)).toBe("ten");
    const text = newSideText(a).split("\n");
    expect(text).toHaveLength(12);
    expect(text[1]).toBe("TWO");
    expect(text[5]).toBe("");
    expect(text[11]).toBe("ELEVEN");
    expect(ren).toMatchObject({ path: "new name.ts", oldPath: "old name.ts" });
    expect(del.path).toBeNull();
    expect(bin).toMatchObject({ path: "img.png", binary: true });
    expect(nw.path).toBe("new.ts");
    expect([...nw.added]).toEqual([1, 2]);
    expect(nw.lines.get(2)).toBe("");
  });

  it("reads CRLF diffs the same", () => {
    const crlf = parseUnifiedDiff(DIFF.replace(/\n/g, "\r\n"));
    expect(crlf[0].lines.get(2)).toBe("TWO");
    expect([...crlf[0].added]).toEqual([2, 3, 12]);
  });

  it("handles one-line hunks without counts and quoted paths", () => {
    const d = ['diff --git "a/sp\\u00e9.ts" "b/sp\\u00e9.ts"', '--- "a/sp\\u00e9.ts"', '+++ "b/sp\\u00e9.ts"', "@@ -3 +3 @@", "-x", "+y"].join("\n");
    const [f] = parseUnifiedDiff(d);
    expect(f.path).toBe("spé.ts");
    expect([...f.added]).toEqual([3]);
  });

  it("gives context around a line", () => {
    const [a] = parseUnifiedDiff(DIFF);
    expect(contextAround(a, 2, 1)).toBe("1  one\n2> TWO\n3  added");
  });
});
