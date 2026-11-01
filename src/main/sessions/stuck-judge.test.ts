import { afterEach, describe, expect, it } from "vitest";
import type { HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { setLang } from "../i18n";
import { judgeStuck } from "./stuck-judge";

const input = { cwd: "/repo", activity: "运行 pnpm test", minutes: 7, lastOutput: "Waiting for lock", terminalTail: "$ pnpm test", children: true };

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
  result: { sessionId: null, isError: false, subtype: null, resultText: "", structured, permissionDenials: [], apiErrorStatus: null, costUsd: null },
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
