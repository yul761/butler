import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { ChecksService } from "./checks-service";
import { CheckDrafter, type CheckDraftRunner } from "./draft";
import type { HeadlessExecResult } from "../handoff/headless-exec";

const route = { task: "check_draft" as const, requestedTier: null, actualModel: null, fallbackFrom: null, degraded: false, sameModelReview: false };
const ok = (value: unknown): HeadlessExecResult => ({ ok: true, value, rawText: "", result: {} as never, route });

const setup = (answer: () => HeadlessExecResult) => {
  const db = memDb();
  const lessons = new LessonsRepo(db);
  lessons.upsertRepo("acme/web", "/definitely/missing", 1);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  const checks = new ChecksService({ db, lessons, recorder, now: () => 1, config: () => ({ enabled: true, editTimeoutSec: 8, pushTimeoutSec: 600, ticketPattern: "X-\\d+" }) });
  const calls: Parameters<CheckDraftRunner>[0][] = [];
  const drafter = new CheckDrafter({ lessons, checks, fallbackCwd: () => "/home", run: async (req) => (calls.push(req), answer()) });
  const lid = lessons.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "never call useEffect in views", why: "w", at: 1, source: { prNumber: 1, url: null, slug: "acme/web", runId: null } });
  return { lessons, drafter, calls, lid };
};

describe("CheckDrafter", () => {
  it("asks check_draft and returns a shadow-mode draft", async () => {
    const { drafter, calls, lid } = setup(() =>
      ok({ checkable: true, reason: "a regex catches it", check: { type: "forbidden_pattern", name: "no useEffect", params: { pattern: "useEffect\\(" }, globs: ["src/views/**"], severity: "block", message: "m" } }),
    );
    const r = await drafter.draft(lid);
    expect(r).toMatchObject({ ok: true, kind: "draft", scope: { kind: "repo", slug: "acme/web" }, draft: { mode: "shadow", enabled: true, params: { pattern: "useEffect\\(" } } });
    expect(calls[0]).toMatchObject({ task: "check_draft", cwd: "/home" });
    expect(calls[0].prompt).toContain("never call useEffect in views");
    // 没有本地仓库：不给读文件的工具。
    expect(calls[0].args).not.toContain("--allowedTools");
  });

  it("marks the lesson prose when it cannot be checked", async () => {
    const { drafter, lessons, lid } = setup(() => ok({ checkable: false, reason: "needs judgement" }));
    const r = await drafter.draft(lid);
    expect(r).toMatchObject({ ok: true, kind: "prose", reason: "needs judgement" });
    expect(lessons.get(lid)?.checkability).toBe("prose");
  });

  it("reports bad output and failures", async () => {
    expect(await setup(() => ok({ checkable: true, reason: "r", check: { type: "forbidden_pattern", name: "n", params: { pattern: "(" }, globs: [], severity: "block", message: "" } })).drafter.draft(1)).toMatchObject({ ok: false, reason: "bad_output" });
    expect(await setup(() => ok({ nope: 1 })).drafter.draft(1)).toMatchObject({ ok: false, reason: "bad_output" });
    expect(await setup(() => ({ ok: false, reason: "rate_limited", message: "x", limit: null, stderr: "", result: null, rawText: null, route })).drafter.draft(1)).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(await setup(() => ok({})).drafter.draft(999)).toEqual({ ok: false, reason: "not_found" });
  });

  it("generate asks the model without writing anything and passes the limit's reset time on", async () => {
    const { drafter, lessons, lid } = setup(() => ok({ checkable: false, reason: "needs judgement" }));
    expect(await drafter.generate(lid)).toEqual({ ok: true, kind: "prose", reason: "needs judgement", model: null, degraded: false });
    expect(lessons.get(lid)?.checkability).toBeNull();
    const limited = setup(() => ({ ok: false, reason: "rate_limited", message: "x", limit: null, stderr: "", result: null, rawText: null, route, waitUntil: 77 }));
    expect(await limited.drafter.generate(limited.lid)).toEqual({ ok: false, reason: "rate_limited", message: "x", waitUntil: 77 });
  });
});
