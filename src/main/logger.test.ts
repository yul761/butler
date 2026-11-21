import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFileLogger } from "./logger";
import { tempDir } from "./test-utils";

const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");

describe("createFileLogger", () => {
  it("appends timestamped lines, creating the directory", () => {
    const file = join(tempDir(), "logs", "main.log");
    const log = createFileLogger(file, () => new Date("2026-01-02T03:04:05.000Z"));
    log("hello");
    log("boom", new Error("bad"));
    log.flushSync();
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines[0]).toBe("2026-01-02T03:04:05.000Z hello");
    expect(lines[1]).toContain("boom Error: bad");
  });

  // BTL-242 审查：flushSync 时还有一批在异步写，进程马上就退：那一批也要同步写下去，而且在后来的行前面。
  it("flushSync while an async write is still running writes that batch too, ahead of the later lines", async () => {
    const file = join(tempDir(), "logs", "main.log");
    const log = createFileLogger(file, () => new Date("2026-01-02T03:04:05.000Z"), undefined, { flushMs: 0 });
    log("one");
    const pending = log.flush();
    log("two");
    log.flushSync();
    expect(read(file)).toMatch(/one\n.*two\n$/s);
    await pending;
    await log.flush();
    const text = read(file);
    expect(text).toContain("one");
    expect(text.indexOf("one")).toBeLessThan(text.indexOf("two"));
  });

  it("never throws when the target is unwritable", async () => {
    const dir = tempDir();
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const a = createFileLogger(join(blocker, "logs", "main.log"), undefined, undefined, { flushMs: 0 }); // 父路径是文件
    const b = createFileLogger(dir, undefined, undefined, { flushMs: 0 }); // 目标是目录
    expect(() => a("x")).not.toThrow();
    expect(() => b("x")).not.toThrow();
    await a.flush();
    await b.flush();
    expect(() => a.flushSync()).not.toThrow();
    expect(() => b.flushSync()).not.toThrow();
  });

  it("also passes each line to the tee (the dev console)", () => {
    const lines: string[] = [];
    const log = createFileLogger(join(tempDir(), "main.log"), () => new Date("2026-01-02T03:04:05.000Z"), (l) => lines.push(l));
    log("hello");
    log("boom", new Error("bad"));
    expect(lines[0]).toBe("2026-01-02T03:04:05.000Z hello");
    expect(lines[1]).toContain("boom Error: bad");
  });

  // BTL-242：主进程不再每行同步写一次盘，攒一会儿异步写；退出时 flushSync 把剩下的写完。
  it("buffers lines and writes them later, asynchronously and in order", async () => {
    const file = join(tempDir(), "main.log");
    const log = createFileLogger(file, () => new Date("2026-01-02T03:04:05.000Z"), undefined, { flushMs: 10 });
    log("one");
    log("two");
    expect(read(file)).toBe("");
    await vi.waitFor(() => expect(read(file)).toContain("two"));
    log("three");
    await log.flush();
    expect(read(file).split("\n").filter(Boolean).map((l) => l.split(" ")[1])).toEqual(["one", "two", "three"]);
  });

  it("flushSync writes what is still buffered (quitting, a crash)", () => {
    const file = join(tempDir(), "main.log");
    const log = createFileLogger(file, undefined, undefined, { flushMs: 60_000 });
    log("last words");
    expect(read(file)).toBe("");
    log.flushSync();
    expect(read(file)).toContain("last words");
    log.flushSync();
    expect(read(file).match(/last words/g)).toHaveLength(1);
  });

  it("writes right away once the buffer gets large", async () => {
    const file = join(tempDir(), "main.log");
    const log = createFileLogger(file, undefined, undefined, { flushMs: 60_000, maxBuffer: 100 });
    log("x".repeat(200));
    await vi.waitFor(() => expect(read(file)).toContain("x".repeat(200)));
  });
});
