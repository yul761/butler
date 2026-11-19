import { describe, expect, it, vi } from "vitest";
import { ADMISSION_POLICY_DEFAULTS, type AdmissionPolicy } from "../../shared/admission-policy";
import { BacktestRepo } from "../db/backtest-repo";
import { JudgmentCache } from "../lessons/admission/judgments";
import { memDb } from "../test-utils";
import { inProcessEvaluator } from "./evaluator";
import { defHash } from "./evaluate";
import type { BacktestGh } from "./material";
import { BacktestService, type AssessInput, type BacktestPayload } from "./service";
import type { CheckRow } from "../../shared/checks";

const diff = (n: number) => `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n const a = ${n};\n+console.log(a);\n`;
const SHA = "a".repeat(40);

function setup(o: { cloned?: boolean; policy?: Partial<AdmissionPolicy>; judge?: "fp" | "violation" | "fail"; gh?: Partial<BacktestGh> } = {}) {
  const db = memDb();
  const repo = new BacktestRepo(db);
  const enq: { payload: BacktestPayload; dedupeKey?: string | null }[] = [];
  const gh: BacktestGh = {
    mergedPrs: async () => [{ number: 3, mergedAt: 3 }, { number: 2, mergedAt: 2 }],
    prDiff: async (_c, n) => diff(n),
    // PR 2 的评论正指着加的那行；PR 9 是规矩的出处。
    anchors: async (_c, n) =>
      n === 2 ? [{ id: 20, author: "x", path: "src/a.ts", line: 2, originalLine: 2, originalCommit: SHA }]
      : n === 9 ? [{ id: 90, author: "rev", path: "src/a.ts", line: 4, originalLine: 4, originalCommit: SHA }]
      : [],
    fileAt: async () => ({ status: "ok", content: "a\nb\nc\nconsole.log(1)\n" }),
    ...o.gh,
  };
  const run = vi.fn(async () => {
    if (o.judge === "fail") return { ok: false, reason: "rate_limited", message: "x", limit: null, waitUntil: 99 } as never;
    return { ok: true, value: { items: [{ id: 1, verdict: o.judge === "violation" ? "violation" : "false_positive", reason: "why" }] }, route: { actualModel: "m", degraded: false, sameModelReview: false } } as never;
  });
  const onMaterial = vi.fn();
  const sources = [{ id: 1, prNumber: 9, path: "src/a.ts", line: 4, reviewer: "rev", slug: "o/r" }];
  const svc = new BacktestService({
    repo, gh, evaluate: inProcessEvaluator,
    judge: { run, judgments: new JudgmentCache(db), lang: () => "en", now: () => 5 },
    localPath: () => (o.cloned === false ? null : "/clone"),
    policy: () => ({ ...ADMISSION_POLICY_DEFAULTS, ...o.policy }) as AdmissionPolicy,
    ticketPattern: () => "[A-Z]+-\\d+",
    queue: { enqueue: (_k, payload, opt) => (enq.push({ payload, dedupeKey: opt?.dedupeKey }), enq.length) },
    jobs: { get: () => ({ state: "done", error: null }) },
    sourcesOf: () => sources,
    checks: { get: () => null, slugsOf: () => ["o/r"], lessonOf: () => null },
    slugsOfScope: () => ["o/r"],
    onMaterial, fallbackCwd: "/", now: () => 10,
  });
  const input: AssessInput = {
    lessonId: null, ruleText: "no console.log", draft: { type: "forbidden_pattern", params: { pattern: "console\\.log" }, globs: [], excludeGlobs: [], message: "remove it" },
    slugs: ["o/r"], sources,
  };
  const prefetch = () => svc.handler({ id: 1, kind: "backtest", payload: { op: "prefetch", slug: "o/r" }, checkpoint: null, ticketKey: null, attempts: 1, signal: new AbortController().signal, save: () => {}, sessionAwake: () => true, admitSession: async () => ({ ok: false, reason: "" }) });
  return { svc, repo, enq, run, onMaterial, input, prefetch };
}

describe("BacktestService.assess", () => {
  it("answers pending and enqueues a prefetch when the material is missing", async () => {
    const { svc, enq, input } = setup();
    expect(await svc.assess(input)).toEqual({ kind: "pending" });
    expect(enq).toEqual([{ payload: { op: "prefetch", slug: "o/r" }, dedupeKey: "prefetch:o/r" }]);
  });

  it("after a prefetch: recall from the source comment, false positives from unmatched hits judged by the model", async () => {
    const { svc, input, run, onMaterial, prefetch, repo } = setup();
    expect(await prefetch()).toEqual({ done: true });
    expect(onMaterial).toHaveBeenCalledWith("o/r");
    const a = await svc.assess(input);
    // 两个 PR 各加了一行 console.log：PR 2 那行有评论（命中对上），PR 3 那行没人说（候选，模型判误报）。
    expect(a).toMatchObject({ kind: "tested", hits: 2, recall: 1, comments: 1, commentsMatched: 1, falsePositives: 1, fpRate: 0.5, prs: 2 });
    expect(run).toHaveBeenCalledTimes(1);
    // 缓存：同样的定义、素材、出处不再算。
    await svc.assess(input);
    expect(run).toHaveBeenCalledTimes(1);
    const latest = repo.latestAll(defHash({ type: "forbidden_pattern", params: { pattern: "console\\.log" }, globs: [], excludeGlobs: [] }));
    expect(latest).toHaveLength(1);
    expect(latest[0].samples.falsePositives[0]).toMatchObject({ pr: 3, verdict: "false_positive", reason: "why" });
  });

  it("a hit the model calls a real violation is not a false positive", async () => {
    const { svc, input, prefetch } = setup({ judge: "violation" });
    await prefetch();
    expect(await svc.assess(input)).toMatchObject({ kind: "tested", falsePositives: 0, fpRate: 0 });
  });

  it("judgeSample 0 or a failed judge counts every unmatched hit as a false positive", async () => {
    for (const o of [{ policy: { "backtest.judgeSample": 0 } }, { judge: "fail" as const }]) {
      const { svc, input, prefetch, run } = setup(o);
      await prefetch();
      expect(await svc.assess(input)).toMatchObject({ kind: "tested", falsePositives: 1 });
      if (o.policy) expect(run).not.toHaveBeenCalled();
    }
  });

  it("a failed judge is recomputed next time", async () => {
    const { svc, input, prefetch, run } = setup({ judge: "fail" });
    await prefetch();
    await svc.assess(input);
    await svc.assess(input);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("the line tolerance decides whether a comment points at a hit", async () => {
    const far = { anchors: async (_c: string, n: number) => (n === 2 ? [{ id: 20, author: "x", path: "src/a.ts", line: 9, originalLine: 9, originalCommit: SHA }] : []) };
    const tight = setup({ gh: far, policy: { "backtest.lineTolerance": 3 } });
    await tight.prefetch();
    expect(await tight.svc.assess({ ...tight.input, sources: [] })).toMatchObject({ hits: 2, falsePositives: 2, recall: null });
    const loose = setup({ gh: far, policy: { "backtest.lineTolerance": 10 } });
    await loose.prefetch();
    expect(await loose.svc.assess({ ...loose.input, sources: [] })).toMatchObject({ hits: 2, falsePositives: 1 });
  });

  it("no clone, run_command and a gh that keeps failing are untested", async () => {
    expect(await setup({ cloned: false }).svc.assess(setup().input)).toEqual({ kind: "untested", reason: "not_cloned" });
    const s = setup();
    expect(await s.svc.assess({ ...s.input, draft: { ...s.input.draft, type: "run_command", params: { command: "x", stage: "push" } } })).toEqual({ kind: "untested", reason: "run_command" });
    const bad = setup({ gh: { mergedPrs: async () => null } });
    for (let i = 0; i < 3; i++) await bad.prefetch();
    expect(await bad.svc.assess(bad.input)).toEqual({ kind: "untested", reason: "no_gh" });
  });

  it("the check op backtests an existing check, links its key and stores the legacy count", async () => {
    const s = setup();
    const row = { id: 7, key: "ck", type: "forbidden_pattern", params: { pattern: "console\\.log" }, globs: [], excludeGlobs: [], message: "m", scope: { kind: "repo", slug: "o/r" }, lessonId: null } as unknown as CheckRow;
    const legacy = { run: vi.fn(async () => ({ ok: true as const, scan: { scanId: 4, count: 6, status: "done" } })) };
    const svc = new BacktestService({ ...(s.svc as never as { d: object }).d, checks: { get: () => row, slugsOf: () => ["o/r"], lessonOf: () => null }, legacy } as never);
    const r = await svc.handler({ id: 2, kind: "backtest", payload: { op: "check", checkId: 7 }, checkpoint: null, ticketKey: null, attempts: 1, signal: new AbortController().signal, save: () => {}, sessionAwake: () => true, admitSession: async () => ({ ok: false, reason: "" }) });
    expect(r).toEqual({ done: true });
    const sum = svc.summaryOf(row)!;
    expect(sum).toMatchObject({ tested: true, hits: 2, legacy: 6 });
    expect(legacy.run).toHaveBeenCalledWith(7, "o/r");
  });

  it("the wizard runner waits for the prefetch jobs and reports whether every repo has material", async () => {
    const s = setup();
    expect(await s.svc.wizardRunner.run({ kind: "all" }, () => {})).toEqual({ backtested: false });
    await s.prefetch();
    expect(await s.svc.wizardRunner.run({ kind: "all" }, () => {})).toEqual({ backtested: true });
    expect(await setup({ cloned: false }).svc.wizardRunner.run({ kind: "all" }, () => {})).toEqual({ backtested: false });
  });
});
