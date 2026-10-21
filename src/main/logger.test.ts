import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLogger } from "./logger";
import { tempDir } from "./test-utils";

describe("createFileLogger", () => {
  it("appends timestamped lines, creating the directory", () => {
    const file = join(tempDir(), "logs", "main.log");
    const log = createFileLogger(file, () => new Date("2026-01-02T03:04:05.000Z"));
    log("hello");
    log("boom", new Error("bad"));
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines[0]).toBe("2026-01-02T03:04:05.000Z hello");
    expect(lines[1]).toContain("boom Error: bad");
  });

  it("never throws when the target is unwritable", () => {
    const dir = tempDir();
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    expect(() => createFileLogger(join(blocker, "logs", "main.log"))("x")).not.toThrow(); // 父路径是文件
    expect(() => createFileLogger(dir)("x")).not.toThrow(); // 目标是目录
  });
  it("also passes each line to the tee (the dev console)", () => {
    const lines: string[] = [];
    const log = createFileLogger(join(tempDir(), "main.log"), () => new Date("2026-01-02T03:04:05.000Z"), (l) => lines.push(l));
    log("hello");
    log("boom", new Error("bad"));
    expect(lines[0]).toBe("2026-01-02T03:04:05.000Z hello");
    expect(lines[1]).toContain("boom Error: bad");
  });
});
