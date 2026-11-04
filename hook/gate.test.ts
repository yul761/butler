import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";
import { runGate, type GateDeps } from "./gate";

function setup(opts: { alive?: boolean | "missing"; onSleep?: (home: string) => void } = {}) {
  const home = tempDir();
  mkdirSync(join(home, "gate", "requests"), { recursive: true });
  mkdirSync(join(home, "gate", "results"), { recursive: true });
  if (opts.alive !== "missing") writeFileSync(join(home, "gate", "alive.json"), JSON.stringify({ pid: 4242 }));
  let t = 1000;
  const deps: GateDeps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      opts.onSleep?.(home);
    },
    pidAlive: () => opts.alive !== false,
    newId: () => "abcd1234-req",
  };
  const env = { BUTLER_HOME: home, BUTLER_SESSION: " s1 ", BUTLER_TICKET: "DMS-2" };
  const input = (command: string, event = "PreToolUse", tool = "Bash") => JSON.stringify({ hook_event_name: event, tool_name: tool, tool_input: { command }, cwd: "/work/repo" });
  return { home, deps, env, input, now: () => t, requests: () => readdirSync(join(home, "gate", "requests")) };
}

describe("runGate", () => {
  it("ignores unreviewable commands without touching files", async () => {
    const s = setup();
    expect(await runGate(s.input("git status"), s.env, s.deps)).toBe("");
    expect(s.requests()).toEqual([]);
  });

  it("fails open fast when alive.json is missing", async () => {
    const s = setup({ alive: "missing" });
    const t0 = s.now();
    expect(await runGate(s.input("git merge feat"), s.env, s.deps)).toBe("");
    expect(s.now() - t0).toBeLessThan(100);
    expect(s.requests()).toEqual([]);
  });

  it("fails open when the main process pid is dead", async () => {
    const s = setup({ alive: false });
    expect(await runGate(s.input("git merge feat"), s.env, s.deps)).toBe("");
    expect(s.requests()).toEqual([]);
  });

  it("returns a deny from the main process and cleans up", async () => {
    let request: Record<string, unknown> | null = null;
    const s = setup({
      onSleep: (home) => {
        const name = readdirSync(join(home, "gate", "requests")).find((n) => n.endsWith(".json"));
        if (!name) return;
        request = JSON.parse(readFileSync(join(home, "gate", "requests", name), "utf8"));
        writeFileSync(join(home, "gate", "results", name), JSON.stringify({ v: 1, decision: "deny", reason: "等 DMS-1" }));
      },
    });
    const out = JSON.parse(await runGate(s.input("git merge feat"), s.env, s.deps));
    expect(out.hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "等 DMS-1" });
    expect(request).toMatchObject({ v: 1, phase: "pre", cwd: "/work/repo", session: "s1", ticket: "DMS-2", action: { kind: "local_merge", source: "feat" } });
    expect(readdirSync(join(s.home, "gate", "results"))).toEqual([]);
  });

  it("allows on an allow result", async () => {
    const s = setup({
      onSleep: (home) => {
        for (const n of readdirSync(join(home, "gate", "requests"))) writeFileSync(join(home, "gate", "results", n), JSON.stringify({ v: 1, decision: "allow" }));
      },
    });
    expect(await runGate(s.input("git merge feat"), s.env, s.deps)).toBe("");
    expect(readdirSync(join(s.home, "gate", "results"))).toEqual([]);
  });

  it("times out after 5000ms, allows, and removes its request", async () => {
    const s = setup();
    const t0 = s.now();
    expect(await runGate(s.input("git merge feat"), s.env, s.deps)).toBe("");
    expect(s.now() - t0).toBeGreaterThanOrEqual(5000);
    expect(s.requests()).toEqual([]);
  });

  it("post writes the request and returns immediately", async () => {
    const s = setup();
    const t0 = s.now();
    expect(await runGate(s.input("git merge feat", "PostToolUse"), s.env, s.deps)).toBe("");
    expect(s.now()).toBe(t0);
    const names = s.requests();
    expect(names).toEqual(["abcd1234-req.json"]);
    expect(JSON.parse(readFileSync(join(s.home, "gate", "requests", names[0]), "utf8")).phase).toBe("post");
    expect(existsSync(join(s.home, "gate", "requests", "abcd1234-req.json.tmp"))).toBe(false);
  });

  it("treats PostToolUseFailure (the command failed) as post too", async () => {
    const s = setup();
    const t0 = s.now();
    expect(await runGate(s.input("git push origin feat:main", "PostToolUseFailure"), s.env, s.deps)).toBe("");
    expect(s.now()).toBe(t0);
    const names = s.requests();
    expect(names).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(s.home, "gate", "requests", names[0]), "utf8")).phase).toBe("post");
  });

  it("ignores non-Bash tools, other events and non-JSON stdin", async () => {
    const s = setup();
    expect(await runGate(s.input("git merge feat", "PreToolUse", "Edit"), s.env, s.deps)).toBe("");
    expect(await runGate(s.input("git merge feat", "Stop"), s.env, s.deps)).toBe("");
    expect(await runGate("not json", s.env, s.deps)).toBe("");
    expect(s.requests()).toEqual([]);
  });
});
