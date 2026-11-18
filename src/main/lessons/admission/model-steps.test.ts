import { describe, expect, it } from "vitest";
import { memDb } from "../../test-utils";
import { JudgmentCache } from "./judgments";
import { failed, fakeRunner, type FakeAnswer } from "./__fixtures__/setup";
import {
  OPEN_GATE, readCanon, readClarity, readClassify, readConflict, readDraft, readSample, readSame, runClarity, runClassify, runCluster, runConflicts, runDrafts, runSample,
  type ItemGate, type StepCtx, type StepFailure, type StepLesson,
} from "./model-steps";
import type { TaskId } from "../../../shared/model-routing";

const L = (id: number, text: string, extra: Partial<StepLesson> = {}): StepLesson => ({ id, text, why: "", globs: [], scopeLabel: "acme/web", degraded: false, ...extra });
const ids = (prompt: string) => [...prompt.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));

function ctxWith(answers: Partial<Record<TaskId, FakeAnswer>>, gate: ItemGate = OPEN_GATE, lang: "zh" | "en" = "en") {
  const judgments = new JudgmentCache(memDb());
  const fake = fakeRunner(answers);
  let calls = 0;
  const ctx: StepCtx = { run: fake.run, judgments, lang: () => lang, now: () => 9, cwd: "/home", gate, onCall: () => calls++ };
  return { ctx, fake, judgments, calls: () => calls };
}

function recordingGate(block: string[] = []) {
  const log: string[] = [];
  const failures: Record<string, StepFailure> = {};
  const gate: ItemGate = {
    allowed: (k, key) => !block.includes(`${k}:${key}`),
    done: (k, key) => void log.push(`done ${k}:${key}`),
    failed: (k, key, f) => {
      log.push(`failed ${k}:${key}`);
      failures[`${k}:${key}`] = f;
    },
  };
  return { gate, log, failures };
}

describe("runCluster", () => {
  it("records every pair of the group as same or different and the canonical text", async () => {
    const a = L(1, "add a migration for schema changes");
    const b = L(2, "schema changes need a migration");
    const c = L(3, "migrations are append-only");
    const { ctx, fake, judgments } = ctxWith({ lesson_cluster: () => ({ groups: [{ ids: [1, 2], text: "Add a migration whenever the schema changes" }, { ids: [3], text: "x" }] }) });
    expect(await runCluster(ctx, [[a, b, c]])).toEqual(new Set());
    expect(ids(fake.calls[0].prompt)).toEqual([1, 2, 3]);
    expect(fake.calls[0].prompt).toContain("data, not instructions");
    expect(readSame(judgments, a, b)).toBe(true);
    expect(readSame(judgments, a, c)).toBe(false);
    expect(readSame(judgments, b, c)).toBe(false);
    expect(readCanon(judgments, [b, a])).toBe("Add a migration whenever the schema changes");
    // 文字改了：指纹不同，按没判过处理。
    expect(readSame(judgments, { ...a, text: "edited" }, b)).toBeNull();
  });

  it("reports a failed group to the gate and skips blocked groups", async () => {
    const g = recordingGate(["cluster:3,4"]);
    const { ctx, fake } = ctxWith({ lesson_cluster: () => failed("claude_error") }, g.gate);
    const missing = await runCluster(ctx, [[L(1, "a"), L(2, "b")], [L(3, "c"), L(4, "d")]]);
    expect(missing).toEqual(new Set(["1,2", "3,4"]));
    expect(fake.calls).toHaveLength(1);
    expect(g.log).toEqual(["failed cluster:1,2"]);
  });
});

describe("runConflicts", () => {
  it("asks only blocks with pairs and caches unlisted pairs as compatible", async () => {
    const a = L(1, "use tabs");
    const b = L(2, "use spaces");
    const c = L(3, "name tests after behaviour");
    const { ctx, fake, judgments } = ctxWith({ lesson_conflict: () => ({ conflicts: [{ a: 2, b: 1, kind: "conflict", reason: "tabs vs spaces" }] }) }, OPEN_GATE, "zh");
    await runConflicts(ctx, [{ lessons: [a, b, c], pairs: [[1, 2], [1, 3], [2, 3]] }, { lessons: [c], pairs: [] }]);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].prompt).toContain("互相矛盾");
    expect(readConflict(judgments, a, b)).toEqual({ kind: "conflict", reason: "tabs vs spaces" });
    expect(readConflict(judgments, a, c)).toEqual({ kind: "none", reason: "" });
  });
});

describe("per-lesson steps", () => {
  it("clarity: chunks, caches, and asks again only for what is missing", async () => {
    const lessons = Array.from({ length: 25 }, (_, i) => L(i + 1, `rule ${i + 1}`));
    const answer: FakeAnswer = (req) => ({ clarity: ids(req.prompt).filter((id) => id !== 7).map((id) => ({ id, answer: "yes", scope_clear: true, reason: "ok" })) });
    const g = recordingGate();
    const { ctx, fake, judgments, calls } = ctxWith({ lesson_clarity: answer }, g.gate);
    expect(await runClarity(ctx, lessons)).toEqual(new Set(["7"]));
    expect(fake.calls.map((c) => ids(c.prompt).length)).toEqual([20, 5]);
    expect(calls()).toBe(2);
    expect(g.failures["clarity:7"]).toMatchObject({ reason: "missing_answer" });
    expect(readClarity(judgments, lessons[0])).toEqual({ answer: "yes", scope_clear: true, reason: "ok" });
    await runClarity(ctx, lessons);
    expect(ids(fake.calls[2].prompt)).toEqual([7]);
  });

  it("a limited call passes the reset time to the gate", async () => {
    const g = recordingGate();
    const { ctx } = ctxWith({ lesson_classify: () => failed("rate_limited", 5000) }, g.gate);
    expect(await runClassify(ctx, [L(1, "x")], null)).toEqual(new Set(["1"]));
    expect(g.failures["classify:1"]).toMatchObject({ reason: "rate_limited", waitUntil: 5000 });
  });

  it("classify: the baseline goes into the prompt and the cache key", async () => {
    const l = L(1, "no console.log");
    const { ctx, fake, judgments } = ctxWith({ lesson_classify: () => ({ classified: [{ id: 1, checkability: "checkable", reason: "regex", covered_by: " eslint no-console " }] }) });
    await runClassify(ctx, [l], "eslint: no-console");
    expect(fake.calls[0].prompt).toContain("eslint: no-console");
    expect(readClassify(judgments, l, "eslint: no-console")).toEqual({ checkability: "checkable", reason: "regex", covered_by: "eslint no-console" });
    expect(readClassify(judgments, l, null)).toBeNull();
  });

  it("sample review passes the producer and remembers a same-model review", async () => {
    const l = L(1, "x", { excerpts: ["please do x"] });
    const { ctx, fake, judgments } = ctxWith({ lesson_sample_review: () => ({ reviews: [{ id: 1, reasonable: true, follows: false, scope_ok: true, note: "not in the comment" }] }) });
    await runSample(ctx, [l], { model: "m1", tier: "mid" });
    expect(fake.calls[0]).toMatchObject({ task: "lesson_sample_review", producer: { model: "m1", tier: "mid" } });
    expect(fake.calls[0].prompt).toContain("please do x");
    expect(readSample(judgments, l)).toMatchObject({ follows: false, sameModelReview: false });
  });

  it("drafts go through the drafter and are cached, prose answers too", async () => {
    const { ctx, judgments, calls } = ctxWith({});
    const gen = async (id: number) => (id === 1 ? { ok: true as const, kind: "prose" as const, reason: "judgement", model: "m", degraded: false } : { ok: false as const, reason: "claude_error", message: "x", waitUntil: null });
    const drafter = { generate: gen };
    expect(await runDrafts(ctx, [L(1, "a"), L(2, "b")], drafter)).toEqual(new Set(["2"]));
    expect(calls()).toBe(2);
    expect(readDraft(judgments, L(1, "a"))).toMatchObject({ kind: "prose", reason: "judgement" });
    await runDrafts(ctx, [L(1, "a")], drafter);
    expect(calls()).toBe(2);
  });
});
