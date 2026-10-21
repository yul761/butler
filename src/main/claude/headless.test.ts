import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir, waitForFile, waitUntilDead, writeFakeClaude } from "../test-utils";
import { PROBE_ARGS } from "./mcp-probe";
import { headlessArgs, isRateLimited, parseClaudeJson, runHeadless, unsafeCmdArg } from "./headless";

const env = () => ({ ...process.env }) as Record<string, string>;

/** 验证记录 V1：真实 claude 2.1.306 的 --output-format json 输出（去掉了 usage 等字段）。 */
const OBSERVED = {
  type: "result", subtype: "success", is_error: false, api_error_status: null, num_turns: 2, stop_reason: "tool_use",
  session_id: "a861b9bd-25a8-481b-a01a-3fca83dd069f", total_cost_usd: 0.23302, permission_denials: [],
  result: '{"word":"hello","count":3}', structured_output: { word: "hello", count: 3 }, terminal_reason: "completed",
};

describe("headlessArgs", () => {
  it("resumes as a non-persistent, read-only fork and never carries the prompt", () => {
    expect(headlessArgs({ schema: '{"type":"object"}', resumeSessionId: "s-1", allowedTools: ["Read", "Bash(git status)"] })).toEqual([
      "-p", "--output-format", "json", "--json-schema", '{"type":"object"}', "--no-session-persistence", "--permission-mode", "dontAsk",
      "--setting-sources", "user",
      "--resume", "s-1", "--fork-session",
      "--disallowedTools", "Edit", "Write", "NotebookEdit",
      "--allowedTools", "Read", "Bash(git status)",
    ]);
  });

  it("restricts setting sources to user so repo-controlled allow rules are not inherited", () => {
    const args = headlessArgs({ schema: "{}", allowedTools: ["Read"] });
    const i = args.indexOf("--setting-sources");
    expect(args.slice(i, i + 2)).toEqual(["--setting-sources", "user"]);
    expect(i).toBeLessThan(args.indexOf("--allowedTools"));
    expect(PROBE_ARGS.slice(PROBE_ARGS.indexOf("--setting-sources"), PROBE_ARGS.indexOf("--setting-sources") + 2)).toEqual(["--setting-sources", "user"]);
  });

  it("omits the resume flags for a fresh run", () => {
    const args = headlessArgs({ schema: "{}", allowedTools: ["Read"] });
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--fork-session");
  });
});

describe("parseClaudeJson", () => {
  it("reads the observed result shape", () => {
    expect(parseClaudeJson(`${JSON.stringify(OBSERVED)}\n`)).toEqual({
      sessionId: "a861b9bd-25a8-481b-a01a-3fca83dd069f", isError: false, subtype: "success", resultText: '{"word":"hello","count":3}',
      structured: { word: "hello", count: 3 }, permissionDenials: [], apiErrorStatus: null, costUsd: 0.23302,
    });
  });

  it("lists denied tools, accepts a message array, rejects garbage", () => {
    const denied = { ...OBSERVED, permission_denials: [{ tool_name: "Write", tool_use_id: "toolu_1", tool_input: { file_path: "/x/fork.txt", content: "x" } }] };
    expect(parseClaudeJson(JSON.stringify(denied))?.permissionDenials).toEqual(["Write"]);
    expect(parseClaudeJson(JSON.stringify([{ type: "system", subtype: "init" }, OBSERVED]))?.sessionId).toBe(OBSERVED.session_id);
    expect(parseClaudeJson("not json")).toBeNull();
    expect(parseClaudeJson(JSON.stringify({ type: "assistant" }))).toBeNull();
  });

  it("recognises rate limiting from the status or the text", () => {
    const base = parseClaudeJson(JSON.stringify(OBSERVED))!;
    expect(isRateLimited({ ...base, apiErrorStatus: 429 }, "")).toBe(true);
    expect(isRateLimited(null, "Claude usage limit reached")).toBe(true);
    expect(isRateLimited({ ...base, resultText: "Prompt is too long" }, "")).toBe(false);
    // stderr 里的数字（行号、端口）不算；只有 api_error_status 或 “API Error: 429/529” 才看状态码。
    expect(isRateLimited(null, "warning: config.ts:429: deprecated option")).toBe(false);
    expect(isRateLimited({ ...base, resultText: "API Error: 529 Overloaded" }, "")).toBe(true);
  });
});

describe("runHeadless with a fake claude executable", () => {
  it("writes the prompt to stdin and passes tricky args through untouched", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, "result({ ok: true });");
    const tricky = ['{"type":"object","properties":{"a":{"type":"string"}}}', "Bash(gh pr view:*)", "张 三 & echo pwned", "100%", "a^b|c"];
    const hostile = '{"d":"a & b > c ^ (x) 100%"}';
    const winCmd = process.platform === "win32";
    const prompt = '多行\n提示 "引号" $HOME %PATH% `x`';
    const out = await runHeadless({ claudePath: fake.path, args: tricky, prompt, cwd: dir, env: env() });
    expect(out).toMatchObject({ ok: true, result: { sessionId: "fork-1", structured: { ok: true } } });
    const refused = await runHeadless({ claudePath: fake.path, args: [...tricky, hostile], prompt, cwd: dir, env: env() });
    if (winCmd) expect(refused).toMatchObject({ ok: false, reason: "spawn_failed" });
    else expect(refused).toMatchObject({ ok: true });
    const [call] = fake.calls();
    expect(call.args).toEqual(tricky);
    expect(call.input).toBe(prompt);
    expect(call.cwd).toBe(dir);
  });

  it("reports invalid JSON on stdout as bad_output", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, 'process.stdout.write("not json");');
    expect(await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({ ok: false, reason: "bad_output" });
  });

  it("reports a non-zero exit without JSON together with stderr", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, 'process.stderr.write("boom"); process.exit(3);');
    expect(await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({
      ok: false, reason: "exit_nonzero", message: "boom",
    });
  });

  it("classifies an error result that mentions a rate limit", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(
      dir,
      'emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "x", api_error_status: 429, result: "API Error: 429 rate_limit_error" }); process.exitCode = 1;',
    );
    expect(await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({
      ok: false, reason: "rate_limited", result: { sessionId: "x" },
    });
  });

  it("kills a run that exceeds the timeout", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, "setTimeout(() => result({ late: true }), 30000);");
    const started = Date.now();
    const out = await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env(), timeoutMs: 300 });
    expect(out).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  it("reports a missing executable as spawn_failed", async () => {
    const dir = tempDir();
    expect(await runHeadless({ claudePath: `${dir}/missing-claude`, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({
      ok: false, reason: "spawn_failed",
    });
  });

  it("settles on timeout even when a grandchild holds stderr, and kills the grandchild", async () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const pidFile = join(dir, "gc.pid");
    const fake = writeFakeClaude(
      dir,
      `const gc = require("node:child_process").spawn("sleep", ["30"], { stdio: ["ignore", "ignore", "inherit"] });
       fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid)); setInterval(() => {}, 1000);`,
    );
    const started = Date.now();
    const out = await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env(), timeoutMs: 2000 });
    expect(out).toMatchObject({ ok: false, reason: "timeout" });
    // 宽松上界：满载时结束可能慢，但不能因为孙进程握着 stderr 而卡住。
    expect(Date.now() - started).toBeLessThan(6000);
    // 孙进程的 pid 文件是子进程写的，不保证已经存在：有界地等它出现。
    const pid = Number(await waitForFile(pidFile, 5000));
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    // 孙进程随进程组被杀，给一个短的有界轮询等它真正死掉。
    expect(await waitUntilDead(pid, 2000)).toBe(true);
  }, 15_000);

  it("treats a non-success subtype as claude_error even with is_error false", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, 'emit({ type: "result", subtype: "error_max_turns", is_error: false, session_id: "m", result: "" });');
    expect(await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({
      ok: false, reason: "claude_error", message: "error_max_turns", result: { sessionId: "m" },
    });
  });

  it("settles once with aborted when the signal fires", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, "setInterval(() => {}, 1000);");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const out = await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env(), signal: ac.signal });
    expect(out).toMatchObject({ ok: false, reason: "aborted" });
    const pre = new AbortController();
    pre.abort();
    expect(await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env(), signal: pre.signal })).toMatchObject({ reason: "aborted" });
  }, 10_000);

  it("falls back to the last non-empty line when stdout has extra lines", async () => {
    const dir = tempDir();
    const fake = writeFakeClaude(dir, 'process.stdout.write("warning: something\\n"); result({ ok: 1 }); process.stdout.write("\\n");');
    expect(await runHeadless({ claudePath: fake.path, args: [], prompt: "x", cwd: dir, env: env() })).toMatchObject({ ok: true, result: { structured: { ok: 1 } } });
    expect(parseClaudeJson(`noise\n${JSON.stringify(OBSERVED)}\n\n`)?.sessionId).toBe(OBSERVED.session_id);
  });
});

describe("unsafeCmdArg", () => {
  it("flags quotes combined with cmd metacharacters, only for win32 .cmd/.bat", () => {
    const bad = '{"d":"a & b"}';
    expect(unsafeCmdArg(["ok", bad], "C:\\npm\\claude.cmd", "win32")).toBe(bad);
    expect(unsafeCmdArg([bad], "C:\\x\\claude.BAT", "win32")).toBe(bad);
    expect(unsafeCmdArg(['{"a":1}', "a & b", "100%"], "claude.cmd", "win32")).toBeNull();
    expect(unsafeCmdArg([bad], "claude.exe", "win32")).toBeNull();
    expect(unsafeCmdArg([bad], "/usr/bin/claude.cmd", "darwin")).toBeNull();
  });
});
