import { afterEach, describe, expect, it } from "vitest";
import type { HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { setLang } from "../i18n";
import { classifyCiByModel, ciPrompt, CI_MODEL_LOG_CHARS } from "./ci-model";
import { classifyCommentsByModel, commentPrompt } from "./comment-model";

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
  result: { sessionId: null, isError: false, subtype: null, resultText: "", structured, permissionDenials: [], apiErrorStatus: null, costUsd: null, usage: null, model: null, durationMs: null },
});
const fail: HeadlessOutcome = { ok: false, reason: "timeout", message: "t", stderr: "", result: null } as unknown as HeadlessOutcome;

afterEach(() => setLang("zh"));

describe("classifyCiByModel", () => {
  it("asks with the checks, step and the log tail, no tools", async () => {
    const seen: HeadlessRequest[] = [];
    const v = await classifyCiByModel(deps(ok({ category: "env", reason: "网络超时</reason>" }), seen), { cwd: "/r", checks: ["test"], step: "Install", log: `x${"y".repeat(CI_MODEL_LOG_CHARS)}` });
    expect(v).toEqual({ category: "env", reason: "网络超时" });
    expect(seen[0].prompt).toContain("Install");
    expect(seen[0].prompt).not.toContain("xy");
    expect(seen[0].args).toContain("--json-schema");
    expect(seen[0].cwd).toBe("/r");
  });

  it("returns null when the model fails or answers badly", async () => {
    expect(await classifyCiByModel(deps(fail), { cwd: "/r", checks: [], step: null, log: "" })).toBeNull();
    expect(await classifyCiByModel(deps(ok({ category: "maybe", reason: "" })), { cwd: "/r", checks: [], step: null, log: "" })).toBeNull();
  });

  it("writes the prompt in the interface language", () => {
    expect(ciPrompt({ cwd: "/r", checks: ["a"], step: null, log: "" }, "en")).toContain("Answer as JSON");
    expect(ciPrompt({ cwd: "/r", checks: ["a"], step: null, log: "" }, "zh")).toContain("用 JSON 回答");
  });
});

describe("classifyCommentsByModel", () => {
  const item = (id: string) => ({ id, who: "copilot" as const, path: "a.ts", line: 3, body: `body ${id}`, followUps: [{ author: "me", who: "author" as const, body: "hmm" }] });

  it("classifies a batch and drops unknown ids", async () => {
    const seen: HeadlessRequest[] = [];
    const v = await classifyCommentsByModel(deps(ok({ items: [{ id: "1", category: "fix", reason: "rename" }, { id: "9", category: "fix", reason: "x" }] }), seen), "/r", [item("1"), item("2")]);
    expect([...(v ?? new Map()).entries()]).toEqual([["1", { category: "fix", reason: "rename" }]]);
    expect(seen[0].prompt).toContain("id=2");
    expect(seen[0].prompt).toContain("a.ts:3");
    expect(seen[0].prompt).toContain("hmm");
  });

  it("does not call the model for an empty batch and returns null on failure", async () => {
    const seen: HeadlessRequest[] = [];
    expect((await classifyCommentsByModel(deps(fail, seen), "/r", []))?.size).toBe(0);
    expect(seen).toHaveLength(0);
    expect(await classifyCommentsByModel(deps(fail), "/r", [item("1")])).toBeNull();
  });

  it("writes the prompt in both languages", () => {
    expect(commentPrompt([item("1")], "en")).toContain("When unsure between fix and human");
    expect(commentPrompt([item("1")], "zh")).toContain("拿不准就答 human");
  });
});
