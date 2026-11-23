import { describe, expect, it } from "vitest";
import { tempDir } from "../src/main/test-utils";
import { commandScript, findShell, killLiveCommands, OUTPUT_CAP, runCommand } from "./check-run";

describe("findShell", () => {
  it("uses /bin/sh off Windows", () => {
    expect(findShell({}, "darwin", () => false)).toBe("/bin/sh");
    expect(findShell({}, "linux", () => false)).toBe("/bin/sh");
  });

  it("finds Git Bash on Windows: env override, next to git.exe, then Program Files", () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(findShell({ CLAUDE_CODE_GIT_BASH_PATH: "D:\\tools\\bash.exe" }, "win32", has(["D:\\tools\\bash.exe"]))).toBe("D:\\tools\\bash.exe");
    // 相对路径的覆盖不认（不在当前目录找可执行文件）。
    expect(findShell({ CLAUDE_CODE_GIT_BASH_PATH: "bash.exe" }, "win32", has(["bash.exe"]))).toBeNull();
    const env = { Path: "C:\\Program Files\\Git\\cmd;relative\\dir" };
    expect(findShell(env, "win32", has(["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]))).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(findShell({ ProgramFiles: "C:\\PF" }, "win32", has(["C:\\PF\\Git\\bin\\bash.exe"]))).toBe("C:\\PF\\Git\\bin\\bash.exe");
    expect(findShell({}, "win32", () => false)).toBeNull();
  });
});

describe("commandScript", () => {
  it("passes the file as $1 instead of splicing it into the shell text", () => {
    expect(commandScript("eslint {file}", "a b.ts")).toBe('eslint "$1"');
    expect(commandScript("eslint", "a.ts")).toBe('eslint "$1"');
    expect(commandScript("pnpm test {file}", null)).toBe("pnpm test ");
  });

  it("appends the file only to a single simple command", () => {
    expect(commandScript("eslint --max-warnings 0", "a.ts")).toBe('eslint --max-warnings 0 "$1"');
    for (const c of ["pnpm lint && echo ok", "echo hi; exit 2", "a | b", "x > out", "(cd web && lint)", "a\nb", "echo `date`"]) expect(commandScript(c, "a.ts")).toBe(c);
  });
});

describe("runCommand", () => {
  const cwd = tempDir();
  const run = (command: string, file: string | null = null, timeoutMs = 5000) => runCommand({ command, file, cwd, timeoutMs, env: process.env });

  it("passes, fails with output, and treats a missing command as unavailable", async () => {
    expect(await run("exit 0")).toEqual({ kind: "pass" });
    expect(await run("echo boom >&2; exit 3")).toEqual({ kind: "fail", code: 3, output: "boom\n" });
    expect((await run("no-such-command-xyz")).kind).toBe("unavailable");
  });

  it("never lets a file name run as shell text", async () => {
    const r = await run('printf "%s" {file}; exit 1', "x; echo pwned", 5000);
    expect(r).toEqual({ kind: "fail", code: 1, output: "x; echo pwned" });
  });

  it("keeps only the tail of long output", async () => {
    const r = await run(`head -c ${OUTPUT_CAP * 2} /dev/zero | tr '\\0' 'a'; echo END; exit 1`);
    expect(r.kind).toBe("fail");
    const out = (r as { output: string }).output;
    expect(out.length).toBeLessThanOrEqual(OUTPUT_CAP);
    expect(out.endsWith("END\n")).toBe(true);
  });

  it("kills the whole tree on timeout, including children holding the pipe", async () => {
    const t0 = Date.now();
    const r = await run("sleep 30 & sleep 30; wait", null, 400);
    expect(r.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);

  it("gives the file in SHIPHERD_CHECK_FILE too (for compound commands)", async () => {
    expect(await run('printf "%s" "$SHIPHERD_CHECK_FILE"; exit 1', "src/a b.ts")).toEqual({ kind: "fail", code: 1, output: "src/a b.ts" });
  });

  it("decides on the shell's exit, not on a background child still holding the pipe", async () => {
    const t0 = Date.now();
    const r = await run("(sleep 3 &) ; echo bad; exit 1", null, 5000);
    expect(r).toEqual({ kind: "fail", code: 1, output: "bad\n" });
    expect(Date.now() - t0).toBeLessThan(2500);
  }, 15_000);

  it("killLiveCommands stops running commands (the hook calls it when Claude Code kills the hook)", async () => {
    const t0 = Date.now();
    const p = run("sleep 30", null, 20_000);
    await new Promise((r) => setTimeout(r, 200));
    killLiveCommands();
    expect((await p).kind).not.toBe("pass");
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);

  it("reports a non-positive budget as a timeout without running anything", async () => {
    expect(await run("exit 1", null, 0)).toEqual({ kind: "timeout", output: "" });
  });

  it("is unavailable without a shell", async () => {
    expect(await runCommand({ command: "x", file: null, cwd, timeoutMs: 1000, env: {}, shell: null, platform: "win32" })).toEqual({ kind: "unavailable", reason: "Git Bash not found" });
  });
});

// BTL-260：改名前写下的检查命令（数据库里、用户仓库的脚本里）用 $BUTLER_CHECK_FILE。
describe("BUTLER_CHECK_FILE", () => {
  const cwd = tempDir();
  it("is still set next to SHIPHERD_CHECK_FILE", async () => {
    const r = await runCommand({ command: 'test "$BUTLER_CHECK_FILE" = a.ts && test "$SHIPHERD_CHECK_FILE" = a.ts || exit 9', file: "a.ts", cwd, timeoutMs: 5000, env: process.env });
    expect(r).toEqual({ kind: "pass" });
  });
});
