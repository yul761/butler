import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeadlessOutcome, HeadlessRequest } from "../claude/headless";
import type { HeadlessExecDeps } from "../handoff/headless-exec";
import { MetricsRepo } from "../db/metrics-repo";
import { setLang } from "../i18n";
import { memDb } from "../test-utils";
import { Metrics } from "./events";
import { classifyQuestion, deterministicAskCategory, InterruptRecorder, type AskedForMetrics } from "./interrupts";

function setup(o: { classify?: () => Promise<"permission" | "missing_info" | null>; pending?: boolean } = {}) {
  const repo = new MetricsRepo(memDb());
  const m = new Metrics({ repo, now: () => 5 });
  const classify = vi.fn(o.classify ?? (async () => "missing_info" as const));
  const rec = new InterruptRecorder({
    record: m.recordEvent, classify, hasPendingDecision: () => o.pending ?? false, ticketOf: () => "T-1", log: () => {},
  });
  return { repo, rec, classify };
}

const ask = (o: Partial<AskedForMetrics> = {}): AskedForMetrics => ({ id: 1, sessionId: "s1", ticketKey: "T-1", question: "q", options: [], context: null, ...o });

describe("InterruptRecorder", () => {
  it("ask_user with two or more options is a choice, without calling the model", async () => {
    const { repo, rec, classify } = setup();
    expect(await rec.asked(ask({ options: ["A", "B"] }))).toBe("choice");
    expect(classify).not.toHaveBeenCalled();
    expect(repo.events(0)[0]).toMatchObject({ kind: "interrupt", sessionId: "s1", data: { category: "choice", source: "ask_user" } });
    expect(rec.askCategory(1)).toBe("choice");
    expect(deterministicAskCategory(["only"])).toBeNull();
  });

  it("asks the router to classify an ask_user without options", async () => {
    const { repo, rec, classify } = setup();
    expect(await rec.asked(ask({ id: 2 }))).toBe("missing_info");
    expect(classify).toHaveBeenCalledTimes(1);
    expect(repo.events(0)[0].data).toEqual({ category: "missing_info", source: "ask_user" });
  });

  it("falls back to question when classifying fails or throws", async () => {
    const a = setup({ classify: async () => null });
    expect(await a.rec.asked(ask())).toBe("question");
    const b = setup({ classify: async () => { throw new Error("x"); } });
    expect(await b.rec.asked(ask())).toBe("question");
  });

  it("a question asked again keeps the earlier category: no new interrupt, no model call", async () => {
    const { repo, rec, classify } = setup();
    await rec.asked(ask({ id: 1 }));
    expect(await rec.asked(ask({ id: 2, supersedes: [1] }))).toBe("missing_info");
    expect(classify).toHaveBeenCalledTimes(1);
    expect(repo.events(0)).toHaveLength(1);
    expect(rec.askCategory(2)).toBe("missing_info");
  });

  it("keeps categories only for items still pending", async () => {
    const { rec } = setup();
    await rec.asked(ask({ id: 1, options: ["A", "B"] }));
    await rec.asked(ask({ id: 2, options: ["A", "B"] }));
    rec.retainAsks(new Set([2]));
    expect(rec.askCategory(1)).toBeNull();
    expect(rec.askCategory(2)).toBe("choice");
  });

  it("records each ask_user once", async () => {
    const { repo, rec } = setup();
    await rec.asked(ask({ options: ["A", "B"] }));
    await rec.asked(ask({ options: ["A", "B"] }));
    expect(repo.events(0)).toHaveLength(1);
  });

  it("records a needs-you stop once per reply with the judge's category", () => {
    const { repo, rec } = setup();
    expect(rec.needsYou("s1", "m1", "question")).toBe(true);
    expect(rec.needsYou("s1", "m1", "question")).toBe(false);
    expect(repo.events(0)[0]).toMatchObject({ ticketKey: "T-1", data: { category: "question", source: "needs_you" } });
  });

  it("does not count needs-you again for a session with a pending ask_user", () => {
    const { repo, rec } = setup({ pending: true });
    expect(rec.needsYou("s1", "m1", "choice")).toBe(false);
    expect(repo.events(0)).toHaveLength(0);
  });

  it("records stuck and permission / question-tool spans", () => {
    const { repo, rec } = setup();
    rec.stuck("s1", "T-1");
    rec.spanOpened(7, "s1", "T-1", "permission", "permission_prompt");
    rec.spanOpened(7, "s1", "T-1", "permission", "permission_prompt");
    rec.spanOpened(8, "s1", "T-1", "choice", "question_tool");
    expect(repo.events(0).map((e) => e.data.category)).toEqual(["stuck", "permission", "choice"]);
  });
});

function deps(out: HeadlessOutcome, seen: HeadlessRequest[]): HeadlessExecDeps {
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
const usage = { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 };
const ok = (structured: unknown): HeadlessOutcome => ({
  ok: true,
  result: { sessionId: null, isError: false, subtype: null, resultText: "", structured, permissionDenials: [], apiErrorStatus: null, costUsd: null, usage, model: null, durationMs: null },
});

afterEach(() => setLang("zh"));

describe("classifyQuestion", () => {
  it("runs the needs_you task with no tools and maps the category", async () => {
    const seen: HeadlessRequest[] = [];
    expect(await classifyQuestion(deps(ok({ category: "permission" }), seen), "可以删掉这个分支吗？", null, "/r")).toBe("permission");
    expect(seen[0].args).toContain("--json-schema");
    expect(seen[0].args).not.toContain("--allowedTools");
    expect(seen[0].prompt).toContain("可以删掉这个分支吗？");
    expect(await classifyQuestion(deps(ok({ category: "nonsense" }), []), "q", null, "/r")).toBe("question");
  });

  it("writes the prompt in English in English mode and returns null on failure", async () => {
    setLang("en");
    const seen: HeadlessRequest[] = [];
    await classifyQuestion(deps(ok({ category: "choice" }), seen), "Which?", "ctx", "/r");
    expect(seen[0].prompt).not.toMatch(/[一-鿿]/);
    expect(await classifyQuestion(deps({ ok: false, reason: "timeout", message: "x", result: null, limit: null, stderr: "" }, []), "q", null, "/r")).toBeNull();
  });
});
