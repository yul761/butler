import { appendFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-utils";
import { backgroundTasks, currentTool } from "./activity-parse";
import { foregroundOutputFile, readOutputTail, sessionRegistryName, TranscriptTail, tasksDirFor, utf8Tail } from "./activity-sources";

const use = (id: string, command = "ls") =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
const result = (id: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

describe("TranscriptTail", () => {
  it("reads incrementally from the last offset", async () => {
    const f = join(tempDir(), "t.jsonl");
    writeFileSync(f, use("a") + "\n");
    const tail = new TranscriptTail(f);
    expect(currentTool((await tail.read()).state)?.id).toBe("a");
    appendFileSync(f, result("a") + "\n");
    const r = await tail.read();
    expect(currentTool(r.state)).toBeNull();
    expect(r.size).toBeGreaterThan(0);
  });

  it("keeps a half line for the next read", async () => {
    const f = join(tempDir(), "t.jsonl");
    const line = use("a");
    writeFileSync(f, line.slice(0, 20));
    const tail = new TranscriptTail(f);
    expect(currentTool((await tail.read()).state)).toBeNull();
    appendFileSync(f, line.slice(20) + "\n");
    expect(currentTool((await tail.read()).state)?.id).toBe("a");
  });

  it("rebuilds from the start when the file shrinks", async () => {
    const f = join(tempDir(), "t.jsonl");
    writeFileSync(f, use("a") + "\n" + use("b") + "\n");
    const tail = new TranscriptTail(f);
    await tail.read();
    writeFileSync(f, use("c") + "\n");
    const s = (await tail.read()).state;
    expect([...s.running.keys()]).toEqual(["c"]);
  });

  it("starts from the tail of a big file and drops the first partial line", async () => {
    const f = join(tempDir(), "t.jsonl");
    const lines = [use("old", "x".repeat(300)), use("mid"), result("old"), use("new")];
    writeFileSync(f, lines.join("\n") + "\n");
    const tail = new TranscriptTail(f, lines[3].length + lines[2].length + 10);
    const s = (await tail.read()).state;
    // result("old") 的开头被截掉，剩下的半行丢弃；只有最后一行完整
    expect([...s.running.keys()]).toEqual(["new"]);
  });

  it("does not throw when the records start outside the window (orphan tool_result)", async () => {
    const f = join(tempDir(), "t.jsonl");
    writeFileSync(f, use("a") + "\n" + result("a") + "\n" + result("zzz") + "\n");
    const tail = new TranscriptTail(f, result("zzz").length + 5);
    await expect(tail.read()).resolves.toBeTruthy();
  });

  it("returns an empty state when the file is missing", async () => {
    const r = await new TranscriptTail(join(tempDir(), "none.jsonl")).read();
    expect(r.size).toBe(0);
    expect(backgroundTasks(r.state)).toEqual([]);
  });

  it("keeps the last size and state when a later read fails, and resumes after", async () => {
    const f = join(tempDir(), "t.jsonl");
    const body = use("a") + "\n";
    writeFileSync(f, body);
    const tail = new TranscriptTail(f);
    const first = await tail.read();
    expect(first.size).toBe(Buffer.byteLength(body));

    rmSync(f);
    const failed = await tail.read();
    expect(failed.size).toBe(first.size);
    expect(currentTool(failed.state)?.id).toBe("a");

    writeFileSync(f, body + result("a") + "\n");
    const back = await tail.read();
    expect(back.size).toBeGreaterThan(first.size);
    expect(currentTool(back.state)).toBeNull();
  });

  it("handles a multi-byte character split across reads", async () => {
    const f = join(tempDir(), "t.jsonl");
    const buf = Buffer.from(use("a", "echo 中文") + "\n");
    const cut = buf.indexOf(Buffer.from("中")) + 1;
    writeFileSync(f, buf.subarray(0, cut));
    const tail = new TranscriptTail(f);
    await tail.read();
    appendFileSync(f, buf.subarray(cut));
    expect(currentTool((await tail.read()).state)?.command).toBe("echo 中文");
  });
});

describe("readOutputTail", () => {
  it("strips ANSI", async () => {
    const f = join(tempDir(), "o.output");
    writeFileSync(f, "\x1b[32mok\x1b[0m\n");
    expect((await readOutputTail(f))?.lines).toEqual(["ok"]);
  });
  it("keeps only the last segment of carriage-return progress lines", async () => {
    const f = join(tempDir(), "o.output");
    writeFileSync(f, "a 10%\rb 20%\r c 30%\n");
    expect((await readOutputTail(f))?.lines).toEqual(["c 30%"]);
  });
  it("drops the leading half line and half UTF-8 character", async () => {
    const f = join(tempDir(), "o.output");
    writeFileSync(f, "头部很长的一行\nline2\nline3\n");
    const buf = Buffer.from("头部很长的一行\nline2\nline3\n");
    const r = await readOutputTail(f, buf.length - 3); // 从“头”的第 3 个字节后开始
    expect(r?.text).not.toContain("�");
    expect(r?.lines).toEqual(["line2", "line3"]);
  });
  it("limits to 6 lines and reports size and mtime", async () => {
    const f = join(tempDir(), "o.output");
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n") + "\n");
    const r = await readOutputTail(f);
    expect(r?.lines).toEqual(["l4", "l5", "l6", "l7", "l8", "l9"]);
    expect(r?.size).toBeGreaterThan(0);
    expect(r?.mtimeMs).toBeGreaterThan(0);
  });
  it("returns null when the file does not exist", async () => {
    expect(await readOutputTail(join(tempDir(), "nope"))).toBeNull();
  });
});

describe("foregroundOutputFile", () => {
  it("picks the newest recent file, skipping symlinks, excluded and stale files", async () => {
    const d = tempDir();
    const now = Date.now();
    const mk = (name: string, ageMs: number) => {
      const p = join(d, name);
      writeFileSync(p, "x");
      utimesSync(p, (now - ageMs) / 1000, (now - ageMs) / 1000);
      return p;
    };
    mk("stale.output", 60_000);
    const older = mk("older.output", 1000);
    mk("excluded.output", 0);
    const real = mk("real.output", 500);
    symlinkSync(real, join(d, "link.output"));
    utimesSync(real, (now - 500) / 1000, (now - 500) / 1000);
    // 符号链接即使更新也要跳过
    expect(await foregroundOutputFile(d, now - 1000, new Set(["excluded.output"]))).toBe(real);
    expect(await foregroundOutputFile(d, now - 1000, new Set(["excluded.output", "real.output"]))).toBe(older);
  });
  it("returns null for a missing directory or no candidates", async () => {
    expect(await foregroundOutputFile(join(tempDir(), "no"), 0, new Set())).toBeNull();
    const d = tempDir();
    writeFileSync(join(d, "a"), "x");
    utimesSync(join(d, "a"), 1, 1);
    expect(await foregroundOutputFile(d, Date.now(), new Set())).toBeNull();
  });
});

describe("tasksDirFor", () => {
  const f = "/home/u/.claude/projects/-Users-me-proj/abc.jsonl";
  it("builds the path per platform", () => {
    expect(tasksDirFor(f, "sid", { platform: "darwin", uid: 501 })).toBe("/private/tmp/claude-501/-Users-me-proj/sid/tasks");
    expect(tasksDirFor(f, "sid", { platform: "linux", uid: 1000 })).toBe("/tmp/claude-1000/-Users-me-proj/sid/tasks");
    expect(tasksDirFor(f, "sid", { platform: "win32", uid: 1 })).toBeNull();
  });
});

describe("sessionRegistryName", () => {
  it("finds the name by sessionId and tolerates bad files", async () => {
    const d = tempDir();
    writeFileSync(join(d, "1.json"), JSON.stringify({ sessionId: "other", name: "no" }));
    writeFileSync(join(d, "2.json"), "{bad");
    writeFileSync(join(d, "3.json"), JSON.stringify({ sessionId: "sid", name: "my session" }));
    expect(await sessionRegistryName(d, "sid")).toBe("my session");
    expect(await sessionRegistryName(d, "zzz")).toBeNull();
    expect(await sessionRegistryName(join(d, "missing"), "sid")).toBeNull();
  });
});

describe("utf8Tail", () => {
  it("keeps short text, and cuts long text on a character boundary", () => {
    expect(utf8Tail("abc", 10)).toBe("abc");
    expect(utf8Tail("abcdef", 3)).toBe("def");
    const cut = utf8Tail("界".repeat(10), 7);
    expect(cut).toBe("界界");
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(7);
  });
});
