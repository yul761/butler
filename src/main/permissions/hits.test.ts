import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileHitCounter } from "./hits";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "butler-hits-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-01T00:00:00Z");
const use = (id: string, name: string, input: unknown, at = T0 + 1000) =>
  `${JSON.stringify({ timestamp: new Date(at).toISOString(), message: { content: [{ type: "tool_use", id, name, input }] } })}\n`;

describe("ProfileHitCounter", () => {
  it("counts calls allowed by the rules the session got at spawn, once each, reading only what was added", async () => {
    const file = join(dir, "s1.jsonl");
    writeFileSync(file, use("a", "Bash", { command: "gh pr view 1" }) + use("b", "Bash", { command: "git push" }) + use("c", "mcp__butler-memory__recall", {}));
    const recordEvent = vi.fn();
    const c = new ProfileHitCounter({ transcriptOf: () => file, builtIn: ["mcp__butler-memory__recall"], recordEvent });
    c.spawned("s1", ["Bash(gh pr view:*)", "mcp__butler-memory__recall"], T0);
    expect(await c.sessionStopped("s1")).toBe(1);
    expect(recordEvent).toHaveBeenCalledWith("interrupt_auto_resolved", expect.objectContaining({ sessionId: "s1", dedupeKey: "profile:s1:a", data: { category: "permission", via: "profile" } }));
    expect(JSON.stringify(recordEvent.mock.calls)).not.toContain("gh pr view");
    expect(await c.sessionStopped("s1")).toBe(0);
    // 写到一半的行留到下一次。
    appendFileSync(file, use("d", "Bash", { command: "gh pr view 2" }).trimEnd());
    expect(await c.sessionStopped("s1")).toBe(0);
    appendFileSync(file, "\n");
    expect(await c.sessionStopped("s1")).toBe(1);
    // 重新启动时没给规则：不再算。
    c.spawned("s1", [], T0 + 5000);
    appendFileSync(file, use("e", "Bash", { command: "gh pr view 3" }, T0 + 6000));
    expect(await c.sessionStopped("s1")).toBe(0);
  });

  it("ignores calls from before the spawn, sessions it didn't start, and missing transcripts", async () => {
    const file = join(dir, "s2.jsonl");
    writeFileSync(file, use("old", "Bash", { command: "gh pr view 1" }, T0 - 1000) + use("new", "Bash", { command: "gh pr view 2" }, T0 + 1000));
    const recordEvent = vi.fn();
    const c = new ProfileHitCounter({ transcriptOf: () => file, recordEvent });
    // Butler 重启前就开着的 session：没有启动记录，不算。
    expect(await c.sessionStopped("s2")).toBe(0);
    c.spawned("s2", ["Bash(gh pr view:*)"], T0);
    expect(await c.sessionStopped("s2")).toBe(1);
    expect(recordEvent.mock.calls.map((x) => (x[1] as { dedupeKey: string }).dedupeKey)).toEqual(["profile:s2:new"]);
    const none = new ProfileHitCounter({ transcriptOf: () => null, recordEvent: vi.fn() });
    none.spawned("s1", ["Bash(gh pr view:*)"], T0);
    expect(await none.sessionStopped("s1")).toBe(0);
  });

  it("skips a line too long to read in one go instead of getting stuck on it", async () => {
    const file = join(dir, "s3.jsonl");
    writeFileSync(file, `{"big":"${"x".repeat(4 * 1024 * 1024 + 10)}"}\n${use("after", "Bash", { command: "gh pr view 1" })}`);
    const c = new ProfileHitCounter({ transcriptOf: () => file, recordEvent: vi.fn() });
    c.spawned("s3", ["Bash(gh pr view:*)"], T0);
    expect(await c.sessionStopped("s3")).toBe(0);
    expect(await c.sessionStopped("s3")).toBe(1);
  });
});
