import { afterEach, describe, expect, it } from "vitest";
import type { HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { setLang } from "../i18n";
import { judgeStuck } from "./stuck-judge";

const input = { cwd: "/repo", activity: "运行 pnpm test", minutes: 7, lastOutput: "Waiting for lock", terminalTail: "$ pnpm test", childCpuQuiet: true };

function deps(out: HeadlessOutcome, seen: HeadlessRequest[] = []): HeadlessExecDeps {
  return {
    run: async (req) => (seen.push(req), out),
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/bin" }),
    baseEnv: {},
    sessions: { recordHeadless: () => undefined } as unknown as HeadlessExecDeps["sessions"],
    now: () => 0,
    newRunId: () => "r",
  };
}
const ok = (structured: unknown): HeadlessOutcome => ({
  ok: true,
  result: { sessionId: null, isError: false, subtype: null, resultText: "", structured, permissionDenials: [], apiErrorStatus: null, costUsd: null, usage: null, model: null },
});

afterEach(() => setLang("zh"));

describe("judgeStuck", () => {
  it("返回判断结果，prompt 里有活动和最后输出，不给任何工具", async () => {
    const seen: HeadlessRequest[] = [];
    const v = await judgeStuck(deps(ok({ stuck: true, reason: "在等锁", action: "结束进程" }), seen), input);
    expect(v).toEqual({ stuck: true, reason: "在等锁", action: "结束进程" });
    expect(seen[0].prompt).toContain("运行 pnpm test");
    expect(seen[0].prompt).toContain("Waiting for lock");
    expect(seen[0].prompt).toContain("7");
    expect(seen[0].cwd).toBe("/repo");
    expect(seen[0].args).not.toContain("--allowedTools");
    expect(seen[0].args).toContain("--json-schema");
  });

  it("cleans stray tags and extra whitespace out of reason and action", async () => {
    const v = await judgeStuck(deps(ok({ stuck: true, reason: "在等\n  锁</reason>\n</invoke>", action: "结束进程</action>多余" })), input);
    expect(v).toEqual({ stuck: true, reason: "在等 锁", action: "结束进程" });
  });

  it("runs on haiku", async () => {
    const seen: HeadlessRequest[] = [];
    await judgeStuck(deps(ok({ stuck: false, reason: "r", action: "" }), seen), input);
    const args = seen[0].args;
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "haiku"]);
  });

  const promptFor = async (childCpuQuiet: boolean | null) => {
    const seen: HeadlessRequest[] = [];
    await judgeStuck(deps(ok({ stuck: false, reason: "", action: "" }), seen), { ...input, childCpuQuiet });
    return seen[0].prompt;
  };

  it("只说子进程最近几分钟的 CPU，不说有没有子进程", async () => {
    expect(await promptFor(true)).toContain("子进程最近几分钟几乎没有用 CPU");
    expect(await promptFor(null)).toContain("子进程的 CPU 使用情况未知");
    expect(await promptFor(false)).toContain("子进程最近几分钟用过 CPU");
    for (const v of [true, false, null]) expect(await promptFor(v)).not.toContain("子进程在跑");
  });

  it("says the same in English", async () => {
    setLang("en");
    expect(await promptFor(true)).toContain("Child processes barely used CPU in the last few minutes");
    expect(await promptFor(null)).toContain("Child process CPU usage is unknown");
    expect(await promptFor(false)).toContain("Child processes used CPU in the last few minutes");
    for (const v of [true, false, null]) expect(await promptFor(v)).not.toContain("Child processes running");
  });

  it("读不到 CPU 时开头也不声称子进程没动静", async () => {
    expect(await promptFor(null)).not.toContain("子进程 CPU 活动");
    setLang("en");
    expect(await promptFor(null)).not.toContain("child-process CPU activity");
  });

  it("headless 失败或输出不合规时返回 null", async () => {
    expect(await judgeStuck(deps({ ok: false, reason: "timeout", message: "x", result: null }), input)).toBeNull();
    expect(await judgeStuck(deps(ok({ stuck: "yes" })), input)).toBeNull();
    expect(await judgeStuck(deps(ok(null)), input)).toBeNull();
  });

  it("按 currentLang() 出中文或英文 prompt", async () => {
    const zh: HeadlessRequest[] = [];
    await judgeStuck(deps(ok({ stuck: false, reason: "", action: "" }), zh), input);
    setLang("en");
    const en: HeadlessRequest[] = [];
    await judgeStuck(deps(ok({ stuck: false, reason: "", action: "" }), en), { ...input, activity: "running pnpm test" });
    expect(zh[0].prompt).toMatch(/[一-鿿]/);
    expect(en[0].prompt).not.toMatch(/[一-鿿]/);
    expect(en[0].prompt).toContain("stuck");
  });
});
