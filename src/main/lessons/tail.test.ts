import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { readTailLines } from "./tail";

describe("readTailLines", () => {
  it("returns every line of a small file", async () => {
    const f = join(tempDir(), "a.jsonl");
    writeFileSync(f, "one\ntwo\n\nthree\n");
    expect(await readTailLines(f, 1000)).toEqual(["one", "two", "three"]);
  });
  it("reads only the tail of a big file and drops the first partial line", async () => {
    const f = join(tempDir(), "b.jsonl");
    writeFileSync(f, ["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"].join("\n") + "\n");
    // the last 15 bytes begin in the middle of the "bbbb" line
    expect(await readTailLines(f, 15)).toEqual(["cccccccccc"]);
  });
  it("keeps a first line that starts exactly at the cut", async () => {
    const f = join(tempDir(), "c.jsonl");
    writeFileSync(f, "aaaaaaaaaa\nbbbbbbbbbb\n");
    expect(await readTailLines(f, 11)).toEqual(["bbbbbbbbbb"]);
  });
});
