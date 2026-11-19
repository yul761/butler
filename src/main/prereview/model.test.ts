import { describe, expect, it } from "vitest";
import type { ExecOptions, HeadlessExecResult } from "../handoff/headless-exec";
import { BACKGROUND_KINDS } from "../../shared/background";
import { TASKS } from "../../shared/model-routing";
import type { CheckSummary, DiffFile, EvidenceItem } from "../../shared/prereview";
import { briefSummaryByModel, filterViolations, preReviewByModel, preReviewPrompt, verifyEvidenceByModel, type ExecRun, type PreReviewModelInput } from "./model";

const route = { task: "pre_review" as const, requestedTier: "high" as const, actualModel: "fake-high", fallbackFrom: null, degraded: false, sameModelReview: false };
const ok = (value: unknown): HeadlessExecResult => ({ ok: true, value, rawText: "", result: {} as never, route });
const fail: HeadlessExecResult = { ok: false, reason: "timeout", message: "took too long", limit: null, stderr: "", result: null, rawText: null, route };

function fake(answer: (o: ExecOptions) => HeadlessExecResult) {
  const calls: ExecOptions[] = [];
  const run: ExecRun = async (o) => {
    calls.push(o);
    return answer(o);
  };
  return { run, calls };
}

const files: DiffFile[] = [{ path: "src/a.ts", added: 10, deleted: 2, binary: false }, { path: "src/b.ts", added: 1, deleted: 0, binary: false }];
const checks: CheckSummary = { absent: null, failing: [{ checkKey: "no-console", name: "no console", severity: "warn", mode: "enforce", files: ["src/b.ts"], count: 1 }], ci: null, rerun: [] };
const lessons = [{ id: 7, text: "Never swallow errors", strength: "must" as const, scopeGlobs: [] }, { id: 8, text: "Prefer early return", strength: "should" as const, scopeGlobs: ["src/**"] }];
const input = (p: Partial<PreReviewModelInput> = {}): PreReviewModelInput => ({
  cwd: "/w", ticketKey: "BTL-1", ticketTitle: "Do it", producer: { model: "dev-model", tier: "high" }, files, diffText: "### src/a.ts", lessons, lessonsTotal: 2, checks, evidence: [], lang: "en", ...p,
});
const v = (p: Record<string, unknown>) => ({ lessonId: null, checkKey: null, file: "src/a.ts", line: 3, severity: "must", what: "bad", fix: "do better", ...p });

describe("routing for G's tasks", () => {
  it("pre_review and evidence_verify are reviewer tasks; the pre_review background kind is high and not idle-only", () => {
    expect(TASKS.pre_review.reviewer).toBe(true);
    expect(TASKS.evidence_verify.reviewer).toBe(true);
    expect(BACKGROUND_KINDS.pre_review).toMatchObject({ priority: "high", idleEligible: false });
  });
});

describe("filterViolations", () => {
  it("drops unknown lessons, files outside the change and violations with neither a lesson nor a failing check", () => {
    const out = filterViolations(
      [v({ lessonId: 7 }), v({ lessonId: 99 }), v({ lessonId: 7, file: "other.ts" }), v({}), v({ checkKey: "nope" }), v({ checkKey: "no-console", file: "./src/b.ts" })] as never,
      lessons, checks, files,
    );
    expect(out.map((x) => [x.lessonId, x.checkKey, x.file, x.severity])).toEqual([[7, null, "src/a.ts", "must"], [null, "no-console", "src/b.ts", "should"]]);
    expect(out[0]!.lessonText).toBe("Never swallow errors");
  });
  it("caps severity at the rule's strength and dedupes", () => {
    const out = filterViolations([v({ lessonId: 8 }), v({ lessonId: 8 })] as never, lessons, checks, files);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe("should");
  });
});

describe("preReviewByModel", () => {
  it("runs pre_review read-only with the producer and filters the answer", async () => {
    const f = fake(() => ok({ violations: [v({ lessonId: 7 }), v({ lessonId: 42 })], summary: "One problem." }));
    const r = await preReviewByModel(f.run, input());
    expect(r).toMatchObject({ ok: true, summary: "One problem.", model: "fake-high" });
    if (r.ok) expect(r.violations).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c).toMatchObject({ task: "pre_review", producer: { model: "dev-model", tier: "high" }, ticketKey: "BTL-1" });
    const tools = c.args.slice(c.args.indexOf("--allowedTools") + 1);
    expect(tools).toEqual(["Read", "Grep", "Glob"]);
  });
  it("reports a failed call or a bad answer", async () => {
    expect(await preReviewByModel(fake(() => fail).run, input())).toEqual({ ok: false, detail: "timeout: took too long" });
    expect(await preReviewByModel(fake(() => ok({ nope: 1 })).run, input())).toEqual({ ok: false, detail: "bad_output" });
  });
  it("the prompt lists rule ids and says when rules were left out, in the UI language", () => {
    const p = preReviewPrompt(input({ lessonsTotal: 5, lang: "zh" }));
    expect(p).toContain("id=7 [must]");
    expect(p).toContain("另有 3 条");
  });
});

describe("verifyEvidenceByModel", () => {
  const item = (id: number): EvidenceItem => ({ id, preReviewId: 1, prId: null, kind: "check", category: "test", name: "t", command: "x", claimed: "pass", summary: "120 passed", verified: "pending", verifyDetail: null, rerunOutput: null, createdAt: 0, verifiedAt: null });
  it("gives no tools and keeps only known ids", async () => {
    const f = fake(() => ok({ items: [{ id: 1, verdict: "mismatch", reason: "output shows 0 tests" }, { id: 9, verdict: "consistent", reason: "?" }] }));
    const r = await verifyEvidenceByModel(f.run, { cwd: "/w", ticketKey: "BTL-1", ticketTitle: null, producer: null, items: [item(1)], rerun: [], files, lang: "en" });
    expect(r.ok && [...r.verdicts]).toEqual([[1, { verified: "mismatch", detail: "output shows 0 tests" }]]);
    expect(f.calls[0]!.task).toBe("evidence_verify");
    expect(f.calls[0]!.args).not.toContain("--allowedTools");
  });
  it("does not call the model with nothing to verify", async () => {
    const f = fake(() => fail);
    expect((await verifyEvidenceByModel(f.run, { cwd: "/w", ticketKey: null, ticketTitle: null, producer: null, items: [], rerun: [], files, lang: "en" })).ok).toBe(true);
    expect(f.calls).toHaveLength(0);
  });
});

describe("briefSummaryByModel", () => {
  const bi = { cwd: "/w", ticketKey: "BTL-1", ticketTitle: "T", prTitle: "P", description: null, files, acceptance: [], lang: "en" as const };
  it("returns the summary without HTML comment markers; null on failure", async () => {
    expect(await briefSummaryByModel(fake(() => ok({ summary: "Adds X. <!-- butler:brief --> Because Y." })).run, bi)).toBe("Adds X.  butler:brief  Because Y.");
    expect(await briefSummaryByModel(fake(() => fail).run, bi)).toBeNull();
  });
});
