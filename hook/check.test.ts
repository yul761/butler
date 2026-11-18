import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRepo, tempDir } from "../src/main/test-utils";
import { realCheckDeps, readSnapshot, repoRootOf, runCheck, runPushCheck } from "./check";
import { CHECKS_SNAPSHOT_VERSION, type CheckLogRecord, type CheckSnapshot, type ResolvedCheck } from "../src/shared/checks";

const SLUG = "acme/web";

const check = (over: Partial<ResolvedCheck>): ResolvedCheck => ({
  id: 1, key: "ck_1", type: "forbidden_pattern", name: "no foo", params: { pattern: "foo\\(" }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "enforce",
  message: "Fix the root cause.", ...over,
});

function setup(checks: ResolvedCheck[], o: { enabled?: boolean; remote?: string | null; editTimeoutMs?: number } = {}) {
  const home = tempDir("butler-home-");
  const repo = makeRepo();
  if (o.remote !== null) execFileSync("git", ["remote", "add", "origin", o.remote ?? `git@github.com:${SLUG}.git`], { cwd: repo });
  const snap: CheckSnapshot = {
    v: CHECKS_SNAPSHOT_VERSION, generatedAt: 1, enabled: o.enabled ?? true, editTimeoutMs: o.editTimeoutMs ?? 8000, pushTimeoutMs: 60_000, ticketPattern: "[A-Z]+-\\d+",
    strings: { failHeader: 'Butler check "{name}" failed: {where}', shadowTag: " (trial)", warnTag: " (warning)", blockFooter: "FOOTER", pushHeader: "PUSH BLOCKED" },
    global: [], repos: { [SLUG]: checks },
  };
  mkdirSync(join(home, "checks"), { recursive: true });
  writeFileSync(join(home, "checks", "snapshot.json"), JSON.stringify(snap));
  mkdirSync(join(repo, "src"), { recursive: true });
  const env = { ...process.env, BUTLER_HOME: home, BUTLER_SESSION: "sess-1" };
  const hits = (): CheckLogRecord[] => {
    const dir = join(home, "checks", "hits");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return [];
    }
    return names.sort().flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as CheckLogRecord));
  };
  /** before：null = 新建文件；"unknown" = 编辑前内容未知（只看防抖）。 */
  const write = (rel: string, content: string, before: string | null = null) => {
    writeFileSync(join(repo, rel), content);
    return JSON.stringify({
      hook_event_name: "PostToolUse", session_id: "cc", cwd: repo, tool_name: "Write", tool_input: { file_path: join(repo, rel), content },
      tool_response: before === null ? { type: "create" } : before === "unknown" ? { type: "update" } : { type: "update", originalFile: before },
    });
  };
  return { home, repo, env, hits, write };
}

describe("butler-hook check (PostToolUse)", () => {
  it("blocks an enforced violation the edit introduced and logs the hit", async () => {
    const t = setup([check({})]);
    const out = await runCheck(t.write("src/a.ts", "ok\nfoo(1)\n"), t.env, realCheckDeps);
    const j = JSON.parse(out);
    expect(j.decision).toBe("block");
    expect(j.reason).toContain('Butler check "no foo" failed: src/a.ts:2');
    expect(j.reason).toContain("Fix the root cause.");
    expect(j.reason).toContain("FOOTER");
    expect(t.hits()).toMatchObject([{ kind: "hit", checkKey: "ck_1", file: "src/a.ts", line: 2, outcome: "fail", blocked: true, mode: "enforce", session: "sess-1", slug: SLUG }]);
  });

  it("only hints for shadow and warn checks", async () => {
    const t = setup([check({ mode: "shadow" }), check({ id: 2, key: "ck_2", name: "warned", severity: "warn" })]);
    const j = JSON.parse(await runCheck(t.write("src/a.ts", "foo(1)\n"), t.env, realCheckDeps));
    expect(j.decision).toBeUndefined();
    expect(j.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(j.hookSpecificOutput.additionalContext).toContain("(trial)");
    expect(j.hookSpecificOutput.additionalContext).toContain("(warning)");
    expect(t.hits().map((h) => (h.kind === "hit" ? [h.mode, h.blocked] : null))).toEqual([["shadow", false], ["enforce", false]]);
  });

  it("ignores violations that were already there, then records the fix as resolved", async () => {
    const t = setup([check({})]);
    expect(await runCheck(t.write("src/a.ts", "foo(1)\nmore\n", "foo(1)\n"), t.env, realCheckDeps)).toBe("");
    // 新加一处：报；同样的内容再写一次：不重复报（防抖）。
    expect(await runCheck(t.write("src/a.ts", "foo(1)\nfoo(2)\n", "foo(1)\nmore\n"), t.env, realCheckDeps)).not.toBe("");
    expect(await runCheck(t.write("src/a.ts", "foo(1)\nfoo(2)\n", "unknown"), t.env, realCheckDeps)).toBe("");
    expect(await runCheck(t.write("src/a.ts", "foo(1)\n", "foo(1)\nfoo(2)\n"), t.env, realCheckDeps)).toBe("");
    expect(t.hits().map((h) => (h.kind === "hit" ? h.outcome : h.kind))).toEqual(["fail", "resolved"]);
  });

  it("applies globs after the layer merge, with either path separator", async () => {
    const t = setup([check({ globs: ["src\\**"], excludeGlobs: ["*.test.ts"] })]);
    expect(await runCheck(t.write("src/a.test.ts", "foo(1)\n"), t.env, realCheckDeps)).toBe("");
    writeFileSync(join(t.repo, "top.ts"), "foo(1)\n");
    expect(await runCheck(t.write("top.ts", "foo(1)\n"), t.env, realCheckDeps)).toBe("");
    expect(await runCheck(t.write("src/b.ts", "foo(1)\n"), t.env, realCheckDeps)).not.toBe("");
  });

  it("checks import boundaries and temporary comments", async () => {
    const t = setup([
      check({ type: "import_boundary", name: "renderer stays out of main", params: { forbid: ["src/main/**"] }, globs: ["src/renderer/**"] }),
      check({ id: 2, key: "builtin:comment_policy", type: "comment_policy", name: "ticket", params: {}, globs: [] }),
    ]);
    mkdirSync(join(t.repo, "src", "renderer"), { recursive: true });
    const j = JSON.parse(await runCheck(t.write("src/renderer/v.ts", `import { db } from "../main/db";\n// 暂时这样\n// temporary, see ABC-1\n`), t.env, realCheckDeps));
    expect(j.reason).toContain("src/renderer/v.ts:1");
    expect(j.reason).toContain("src/renderer/v.ts:2");
    expect(j.reason).not.toContain("v.ts:3");
  });

  it("allows silently without a remote, without a snapshot, or when switched off", async () => {
    const a = setup([check({})], { remote: null });
    expect(await runCheck(a.write("src/a.ts", "foo(1)\n"), a.env, realCheckDeps)).toBe("");
    expect(a.hits()).toEqual([]);
    const b = setup([check({})], { enabled: false });
    expect(await runCheck(b.write("src/a.ts", "foo(1)\n"), b.env, realCheckDeps)).toBe("");
    const c = setup([check({})]);
    writeFileSync(join(c.home, "checks", "snapshot.json"), JSON.stringify({ v: 999 }));
    expect(await runCheck(c.write("src/a.ts", "foo(1)\n"), c.env, realCheckDeps)).toBe("");
    expect(await runCheck(c.write("src/a.ts", "foo(2)\n"), c.env, realCheckDeps)).toBe("");
    // 「没有检查」每个 session 只记一次。
    expect(c.hits()).toEqual([{ kind: "absent", reason: "snapshot_version", session: "sess-1", at: expect.any(Number) }]);
  });

  it("runs run_command on the changed file only, and records a failure", async () => {
    const t = setup([check({ type: "run_command", name: "lint", params: { command: 'grep -q forbidden {file} && { echo "lint: forbidden word in $1"; exit 1; } || exit 0', stage: "edit" } })]);
    const j = JSON.parse(await runCheck(t.write("src/a.ts", "forbidden\n"), t.env, realCheckDeps));
    expect(j.reason).toContain("lint: forbidden word in src/a.ts");
    expect(await runCheck(t.write("src/a.ts", "fine\n", "forbidden\n"), t.env, realCheckDeps)).toBe("");
    expect(t.hits().map((h) => (h.kind === "hit" ? h.outcome : null))).toEqual(["fail", "resolved"]);
  });

  it("kills a run_command that runs past the budget and allows the edit", async () => {
    const t = setup([check({ type: "run_command", name: "slow", params: { command: "sleep 30; : {file}", stage: "edit" } })], { editTimeoutMs: 700 });
    const t0 = Date.now();
    expect(await runCheck(t.write("src/a.ts", "x\n"), t.env, realCheckDeps)).toBe("");
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(t.hits()).toMatchObject([{ kind: "hit", outcome: "timeout", blocked: false }]);
  }, 15_000);

  it("records a command that cannot run as unavailable", async () => {
    const t = setup([check({ type: "run_command", name: "missing", params: { command: "definitely-not-a-command-xyz", stage: "edit" } })]);
    expect(await runCheck(t.write("src/a.ts", "x\n"), t.env, realCheckDeps)).toBe("");
    expect(t.hits()).toMatchObject([{ kind: "hit", outcome: "unavailable" }]);
  });
});

describe("butler-hook check-push (PreToolUse Bash)", () => {
  const bash = (repo: string, command: string) => JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, tool_name: "Bash", tool_input: { command } });

  it("denies a push when an enforced push check fails", async () => {
    const t = setup([check({ type: "run_command", name: "tests", params: { command: "echo 2 tests failed; exit 1", stage: "push" }, globs: [] })]);
    const j = JSON.parse(await runPushCheck(bash(t.repo, "git push origin HEAD"), t.env, realCheckDeps));
    expect(j.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(j.hookSpecificOutput.permissionDecisionReason).toContain("PUSH BLOCKED");
    expect(j.hookSpecificOutput.permissionDecisionReason).toContain("2 tests failed");
    expect(t.hits()).toMatchObject([{ kind: "hit", stage: "push", outcome: "fail", blocked: true }]);
  });

  it("does nothing for commands that are not a real push", async () => {
    const t = setup([check({ type: "run_command", name: "tests", params: { command: "exit 1", stage: "push" }, globs: [] })]);
    for (const c of ["git status", "git push --dry-run", "git push origin --delete old", "git stash push"]) expect(await runPushCheck(bash(t.repo, c), t.env, realCheckDeps)).toBe("");
    expect(t.hits()).toEqual([]);
  });

  it("only hints for a shadow push check, and edit-stage commands are not run at push", async () => {
    const t = setup([
      check({ type: "run_command", name: "tests", params: { command: "exit 1", stage: "push" }, mode: "shadow", globs: [] }),
      check({ id: 2, key: "ck_2", type: "run_command", name: "edit only", params: { command: "exit 1", stage: "edit" }, globs: [] }),
    ]);
    const j = JSON.parse(await runPushCheck(bash(t.repo, `cd ${JSON.stringify(t.repo)} && git push`), t.env, realCheckDeps));
    expect(j.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(j.hookSpecificOutput.additionalContext).toContain("(trial)");
    expect(t.hits()).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("finds the repo root, including from a nested directory", () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    expect(repoRootOf(realCheckDeps, join(repo, "a", "b"))).toBe(repo);
    expect(repoRootOf({ exists: () => false }, join(repo, "a"))).toBeNull();
  });
  it("reads only snapshots of its own version", () => {
    expect(readSnapshot({ readText: () => null }, "x")).toEqual({ ok: false, reason: "no_snapshot" });
    expect(readSnapshot({ readText: () => "{" }, "x")).toEqual({ ok: false, reason: "no_snapshot" });
    expect(readSnapshot({ readText: () => JSON.stringify({ v: 0 }) }, "x")).toEqual({ ok: false, reason: "snapshot_version" });
  });
});
