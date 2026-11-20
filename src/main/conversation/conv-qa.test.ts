import { afterEach, describe, expect, it } from "vitest";
import type { HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { setLang } from "../i18n";
import { CONV_QA_ANSWER_CHARS, CONV_QA_QUESTION_CHARS, CONV_QA_SHORT_REPLY, isQuestionLike, judgeConvQa, ruleQa } from "./conv-qa";

function deps(out: HeadlessOutcome, seen: HeadlessRequest[] = [], extra: Partial<HeadlessExecDeps> = {}): HeadlessExecDeps {
  return {
    run: async (req) => (seen.push(req), out),
    ready: async () => undefined,
    claude: () => ({ path: "/bin/claude", pathValue: "/bin" }),
    baseEnv: {},
    sessions: { recordHeadless: () => undefined } as unknown as HeadlessExecDeps["sessions"],
    now: () => 0,
    newRunId: () => "r",
    ...extra,
  };
}
const usage = { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 };
const ok = (structured: unknown): HeadlessOutcome => ({
  ok: true,
  result: { sessionId: null, isError: false, subtype: null, resultText: "", structured, permissionDenials: [], apiErrorStatus: null, costUsd: null, usage, model: null, durationMs: null },
});

afterEach(() => setLang("zh"));

describe("isQuestionLike", () => {
  it.each(["换新阈值是多少？", "这个能不能改", "为啥挂了", "How does refresh work", "is it safe", "what? ok", "Done. Why did it fail"])("%s is a question", (t) => {
    expect(isQuestionLike(t)).toBe(true);
  });
  it.each(["把按钮改成蓝色", "开 PR 吧", "`a?b` 这个函数改一下", "看 https://x.com/?q=1", "```\nwhat is this\n```\n跑一下", "This is fine", ""])("%s is not a question", (t) => {
    expect(isQuestionLike(t)).toBe(false);
  });
});

describe("ruleQa", () => {
  const base = { asked: false, mutated: false, otherTools: false, answerChars: 100 };
  it("1. anything that changed files is not Q&A", () => expect(ruleQa({ ...base, asked: true, mutated: true })).toBe("no"));
  it("2. no answer is not Q&A", () => expect(ruleQa({ ...base, asked: true, answerChars: 0 })).toBe("no"));
  it("3. a question answered without other tools is Q&A", () => expect(ruleQa({ ...base, asked: true })).toBe("yes"));
  it("4. a question answered with other tools goes to the judge", () => expect(ruleQa({ ...base, asked: true, otherTools: true })).toBe("judge"));
  it("5. no question and other tools is not Q&A", () => expect(ruleQa({ ...base, otherTools: true })).toBe("no"));
  it("6. no question and a short reply is not Q&A", () => expect(ruleQa({ ...base, answerChars: CONV_QA_SHORT_REPLY })).toBe("no"));
  it("7. otherwise the judge decides", () => expect(ruleQa({ ...base, answerChars: CONV_QA_SHORT_REPLY + 1 })).toBe("judge"));
});

describe("judgeConvQa", () => {
  it("asks with no tools under task conv_qa and maps the answer", async () => {
    const seen: HeadlessRequest[] = [];
    const tasks: string[] = [];
    const d = deps(ok({ qa: true }), seen, { costGate: (o) => (tasks.push(`${o.task}:${o.ticketKey}`), "ok") });
    expect(await judgeConvQa(d, { question: "这是什么", answer: "是个函数" }, "/repo", "PROJ-1")).toBe(true);
    expect(tasks).toEqual(["conv_qa:PROJ-1"]);
    expect(seen[0].cwd).toBe("/repo");
    expect(seen[0].args).toContain("--json-schema");
    expect(seen[0].args).not.toContain("--allowedTools");
    expect(seen[0].prompt).toContain("这是什么");
    expect(seen[0].prompt).toContain("是个函数");
    expect(await judgeConvQa(deps(ok({ qa: false })), { question: "q", answer: "a" }, "/r")).toBe(false);
  });

  it("returns null on malformed answers and failed runs", async () => {
    expect(await judgeConvQa(deps(ok({ qa: "yes" })), { question: "q", answer: "a" }, "/r")).toBeNull();
    expect(await judgeConvQa(deps(ok(null)), { question: "q", answer: "a" }, "/r")).toBeNull();
    expect(await judgeConvQa(deps({ ok: false, reason: "timeout", message: "x", result: null, limit: null, stderr: "" }), { question: "q", answer: "a" }, "/r")).toBeNull();
  });

  it("returns paused when the cost breaker stops background work", async () => {
    const seen: HeadlessRequest[] = [];
    expect(await judgeConvQa(deps(ok({ qa: true }), seen, { costGate: () => "pause" }), { question: "q", answer: "a" }, "/r", "PROJ-1")).toBe("paused");
    expect(seen).toEqual([]);
  });

  it("sends only the head of the question and the tail of the answer", async () => {
    const seen: HeadlessRequest[] = [];
    const question = `${"问".repeat(CONV_QA_QUESTION_CHARS)}${"尾".repeat(5000 - CONV_QA_QUESTION_CHARS)}`;
    const answer = `${"头".repeat(5000 - CONV_QA_ANSWER_CHARS)}${"答".repeat(CONV_QA_ANSWER_CHARS)}`;
    await judgeConvQa(deps(ok({ qa: true }), seen), { question, answer }, "/r");
    expect(seen[0].prompt).toContain("问".repeat(CONV_QA_QUESTION_CHARS));
    expect(seen[0].prompt).not.toContain("尾");
    expect(seen[0].prompt).toContain("答".repeat(CONV_QA_ANSWER_CHARS));
    expect(seen[0].prompt).not.toContain("头");
  });

  it("writes the prompt in English when the app is in English", async () => {
    setLang("en");
    const seen: HeadlessRequest[] = [];
    await judgeConvQa(deps(ok({ qa: false }), seen), { question: "how?", answer: "like this" }, "/r");
    expect(seen[0].prompt.replace("how?", "").replace("like this", "")).not.toMatch(/[一-鿿]/);
    expect(seen[0].prompt).toContain("JSON");
  });
});
