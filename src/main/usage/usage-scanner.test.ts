import { appendFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageRepo } from "../db/usage-repo";
import { memDb, tempDir } from "../test-utils";
import { subagentsDir, USAGE_SCAN_MS, UsageScanner, usageScanMs } from "./usage-scanner";

const line = (id: string, extra = "") =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-06T00:00:00Z",
    message: { id, model: "m", usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 }, pad: extra },
  }) + "\n";

function setup(opts: { chunkBytes?: number; ids?: () => string[] } = {}) {
  const dir = tempDir("butler-usage-");
  const repo = new UsageRepo(memDb());
  const file = (id: string) => join(dir, `${id}.jsonl`);
  const scanner = new UsageScanner({
    repo,
    sessionIds: opts.ids ?? (() => ["s1"]),
    transcriptFile: file,
    chunkBytes: opts.chunkBytes,
  });
  const count = (sid: string) => repo.since(0).filter((r) => r.sessionId === sid).length;
  return { dir, repo, file, scanner, count };
}

describe("UsageScanner", () => {
  it("records new turns and resumes from the cursor", async () => {
    const { file, scanner, repo } = setup();
    writeFileSync(file("s1"), line("a") + line("b"));
    await scanner.scanAll();
    expect(repo.since(0)).toHaveLength(2);
    appendFileSync(file("s1"), line("c"));
    await scanner.scanAll();
    const rows = repo.since(0);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === "session" && r.agentId === null && r.job === null && r.sessionId === "s1")).toBe(true);
  });

  it("keeps a half line for the next scan", async () => {
    const { file, scanner, repo } = setup();
    const full = line("a");
    writeFileSync(file("s1"), full.slice(0, 40));
    await scanner.scanAll();
    expect(repo.since(0)).toHaveLength(0);
    appendFileSync(file("s1"), full.slice(40));
    await scanner.scanAll();
    expect(repo.since(0)).toHaveLength(1);
  });

  it("restarts from zero when the file shrinks", async () => {
    const { file, scanner, repo } = setup();
    writeFileSync(file("s1"), line("a") + line("b"));
    await scanner.scanAll();
    writeFileSync(file("s1"), line("c"));
    await scanner.scanAll();
    expect(repo.since(0).map((r) => r.messageId).sort()).toEqual(["a", "b", "c"]);
  });

  it("restarts from zero when the file is replaced by a smaller one", async () => {
    const { file, scanner, repo } = setup();
    writeFileSync(file("s1"), line("a", "x".repeat(500)));
    await scanner.scanAll();
    truncateSync(file("s1"), 0);
    writeFileSync(file("s1"), line("b"));
    await scanner.scanAll();
    expect(repo.since(0)).toHaveLength(2);
  });

  it("reads a big file in chunks", async () => {
    const { file, scanner, count } = setup({ chunkBytes: 200 });
    let data = "";
    for (let i = 0; i < 10; i++) data += line(`m${i}`);
    writeFileSync(file("s1"), data);
    await scanner.scanAll();
    expect(count("s1")).toBe(10);
  });

  it("handles a line longer than one chunk", async () => {
    const { file, scanner, count } = setup({ chunkBytes: 100 });
    writeFileSync(file("s1"), line("a", "y".repeat(450)) + line("b"));
    await scanner.scanAll();
    expect(count("s1")).toBe(2);
  });

  it("records subagent files under the parent session", async () => {
    const { file, scanner, repo } = setup();
    writeFileSync(file("s1"), line("a"));
    const sub = subagentsDir(file("s1"));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-abc.jsonl"), line("sa"));
    writeFileSync(join(sub, "notes.txt"), "ignored");
    await scanner.scanAll();
    const s = repo.since(0).find((r) => r.messageId === "sa");
    expect(s).toMatchObject({ source: "subagent", agentId: "abc", sessionId: "s1", job: null });
    expect(repo.since(0)).toHaveLength(2);
  });

  it("follows the head after clear", async () => {
    let ids = ["A"];
    const { file, scanner, count } = setup({ ids: () => ids });
    writeFileSync(file("A"), line("a1"));
    writeFileSync(file("B"), line("b1"));
    await scanner.scanAll();
    expect(count("A")).toBe(1);
    expect(count("B")).toBe(0);
    appendFileSync(file("A"), line("a2"));
    ids = ["B"];
    await scanner.scanAll();
    expect(count("A")).toBe(1);
    expect(count("B")).toBe(1);
  });

  it("scanSession reads one session regardless of sessionIds", async () => {
    const { file, scanner, count } = setup({ ids: () => [] });
    writeFileSync(file("s1"), line("a"));
    await scanner.scanSession("s1");
    expect(count("s1")).toBe(1);
  });

  it("skips unreadable files without throwing", async () => {
    const { dir, scanner, repo } = setup({ ids: () => ["missing", "dir"] });
    mkdirSync(join(dir, "dir.jsonl"));
    await expect(scanner.scanAll()).resolves.toBeUndefined();
    expect(repo.since(0)).toHaveLength(0);
  });
});

describe("usageScanMs", () => {
  it("stays at 30 seconds by default", () => {
    expect(usageScanMs({})).toBe(30_000);
    expect(USAGE_SCAN_MS).toBe(30_000);
  });

  it("honours BUTLER_USAGE_SCAN_MS only under the e2e flag", () => {
    expect(usageScanMs({ BUTLER_USAGE_SCAN_MS: "200" })).toBe(USAGE_SCAN_MS);
    expect(usageScanMs({ BUTLER_USAGE_SCAN_MS: "200", BUTLER_BACKGROUND_WINDOWS: "0" })).toBe(USAGE_SCAN_MS);
    expect(usageScanMs({ BUTLER_USAGE_SCAN_MS: "200", BUTLER_BACKGROUND_WINDOWS: "1" })).toBe(200);
  });

  it("keeps the default for a value that is not a positive whole number", () => {
    for (const bad of ["", "0", "-5", "1.5", "soon"]) {
      expect(usageScanMs({ BUTLER_USAGE_SCAN_MS: bad, BUTLER_BACKGROUND_WINDOWS: "1" })).toBe(USAGE_SCAN_MS);
    }
  });
});
