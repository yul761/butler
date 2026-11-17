import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvelope } from "../src/shared/hook-envelope";
import { tempDir } from "../src/main/test-utils";
import { buildEnvelope, inboxDir, writeEnvelope } from "./butler-hook";

describe("butler-hook", () => {
  it("wraps valid JSON with ticket and session from env", () => {
    const env = buildEnvelope('{"hook_event_name":"Stop","session_id":"s1"}', { BUTLER_TICKET: "PROJ-1", BUTLER_SESSION: "s0" }, 42);
    expect(env).toEqual({ v: 1, receivedAt: 42, ticket: "PROJ-1", butlerSession: "s0", payload: { hook_event_name: "Stop", session_id: "s1" } });
  });

  it("trims an Agent PostToolUse payload to description and subagent_type", () => {
    const raw = JSON.stringify({
      hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Agent", tool_use_id: "tu1", cwd: "/w", transcript_path: "/t",
      tool_input: { description: "d".repeat(500), subagent_type: "code-reviewer", prompt: "p".repeat(1000) },
      tool_response: { content: "x".repeat(1_000_000) },
    });
    const env = buildEnvelope(raw, {}, 1);
    expect(JSON.stringify(env).length).toBeLessThan(2048);
    expect(env.payload).toEqual({
      hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Agent", tool_use_id: "tu1", cwd: "/w",
      tool_input: { description: "d".repeat(200), subagent_type: "code-reviewer" },
    });
    const task = buildEnvelope(JSON.stringify({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Task", tool_input: { description: "x" }, tool_response: "y" }), {}, 1);
    expect(task.payload).toMatchObject({ tool_name: "Task", tool_input: { description: "x", subagent_type: null } });
    expect((task.payload as Record<string, unknown>).tool_response).toBeUndefined();
  });

  it("passes a non-Agent PostToolUse payload through unchanged", () => {
    const payload = { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "x" } };
    expect(buildEnvelope(JSON.stringify(payload), {}, 1).payload).toEqual(payload);
  });

  it("keeps a truncated raw copy when stdin is not JSON", () => {
    const env = buildEnvelope("x".repeat(20_000), { BUTLER_TICKET: "  " }, 1);
    expect(env.payload).toBeNull();
    expect(env.ticket).toBeNull();
    expect(env.parseError).toBeTruthy();
    expect(env.raw).toHaveLength(10_000);
  });

  it("writes atomically into the inbox and round-trips through parseEnvelope", () => {
    const dir = join(tempDir(), "inbox");
    const env = buildEnvelope('{"a":1}', {}, 1234567890123);
    const file = writeEnvelope(dir, env);
    const names = readdirSync(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^1234567890123-\d+-[0-9a-f]+\.json$/);
    expect(parseEnvelope(readFileSync(file, "utf8"))).toEqual(env);
  });

  it("resolves the inbox from BUTLER_HOME or the home directory", () => {
    expect(inboxDir({ BUTLER_HOME: "/b" }, "/h")).toBe(join("/b", "inbox"));
    expect(inboxDir({}, "/h")).toBe(join("/h", ".butler", "inbox"));
  });

  it("parseEnvelope rejects foreign JSON", () => {
    expect(parseEnvelope('{"v":2}')).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
  });

  it("expands ~ in BUTLER_HOME like the app does", () => {
    expect(inboxDir({ BUTLER_HOME: "~/b" }, "/h")).toBe(join("/h", "b", "inbox"));
  });

  it("removes its temporary file when the rename fails", () => {
    const dir = join(tempDir(), "inbox");
    const env = buildEnvelope("{}", {}, 1);
    expect(() =>
      writeEnvelope(dir, env, () => {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }),
    ).toThrow("EPERM");
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });
});
