import { appendFileSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { readChunk } from "./jsonl-reader";

const fresh = (content: string): string => {
  const f = join(tempDir("shipherd-jsonl-"), "t.jsonl");
  writeFileSync(f, content);
  return f;
};

describe("readChunk", () => {
  it("reads complete lines and ends at the file size", async () => {
    const f = fresh("a\nbb\nccc\n");
    const r = await readChunk(f, { ino: null, offset: 0 });
    expect(r).toMatchObject({ lines: ["a", "bb", "ccc"], start: 0, next: statSync(f).size, reset: false, skipped: 0, ino: `i${statSync(f,{bigint:true}).ino}` });
    expect(await readChunk(f, { ino: r!.ino, offset: r!.next })).toMatchObject({ lines: [], start: r!.next, next: r!.next, reset: false });
  });

  it("does not consume a half-written last line until it is finished", async () => {
    const f = fresh("a\n{\"half\":");
    const r1 = await readChunk(f, { ino: null, offset: 0 });
    expect(r1).toMatchObject({ lines: ["a"], next: 2 });
    expect(await readChunk(f, { ino: r1!.ino, offset: r1!.next })).toMatchObject({ lines: [], next: 2 });
    appendFileSync(f, "1}\n");
    expect(await readChunk(f, { ino: r1!.ino, offset: r1!.next })).toMatchObject({ lines: ['{"half":1}'], reset: false });
  });

  it("starts over when the file got shorter", async () => {
    const f = fresh("aaaa\nbbbb\n");
    const r = await readChunk(f, { ino: null, offset: 0 });
    truncateSync(f, 5);
    expect(await readChunk(f, { ino: r!.ino, offset: r!.next })).toMatchObject({ lines: ["aaaa"], start: 0, next: 5, reset: true });
  });

  it("starts over when the file was replaced (new inode)", async () => {
    const f = fresh("a\n");
    const r = await readChunk(f, { ino: null, offset: 0 });
    const other = join(tempDir("shipherd-jsonl-"), "n.jsonl");
    writeFileSync(other, "a\nb\nc\n");
    renameSync(other, f);
    const r2 = await readChunk(f, { ino: r!.ino, offset: r!.next });
    expect(r2).toMatchObject({ lines: ["a", "b", "c"], start: 0, reset: true });
    expect(r2!.ino).not.toBe(r!.ino);
  });

  it("grows the window for a line longer than a chunk, and skips lines over the limit", async () => {
    const long = "x".repeat(99);
    const f = fresh(`${long}\nok\n`);
    expect(await readChunk(f, { ino: null, offset: 0 }, { chunkBytes: 16 })).toMatchObject({ lines: [long, "ok"], next: 103, skipped: 0 });
    const r = await readChunk(f, { ino: null, offset: 0 }, { chunkBytes: 16, maxLineBytes: 50 });
    expect(r).toMatchObject({ lines: [], next: 100, skipped: 1 });
    expect(await readChunk(f, { ino: r!.ino, offset: r!.next }, { chunkBytes: 16, maxLineBytes: 50 })).toMatchObject({ lines: ["ok"], skipped: 0 });
  });

  it("splits on bytes, not characters", async () => {
    const f = fresh("换新阈值\n蓝色\n");
    expect((await readChunk(f, { ino: null, offset: 0 }, { chunkBytes: 4 }))?.lines).toEqual(["换新阈值"]);
    expect((await readChunk(f, { ino: null, offset: 0 }))?.lines).toEqual(["换新阈值", "蓝色"]);
  });

  it("returns null for a missing file", async () => {
    expect(await readChunk(join(tempDir(), "none.jsonl"), { ino: null, offset: 0 })).toBeNull();
  });
});
