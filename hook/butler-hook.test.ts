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
