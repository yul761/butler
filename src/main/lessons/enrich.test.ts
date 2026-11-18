import { describe, expect, it } from "vitest";
import type { PrLessonData } from "../tickets/gh";
import { failed, fakeRunner, setupAdmission } from "./admission/__fixtures__/setup";
import { ENRICH_CHUNK, LessonEnricher } from "./enrich";

const answer = (globs: string[] = ["src/api/**"]) => (req: { prompt: string }) => ({
  enriched: [...req.prompt.matchAll(/^#(\d+) /gm)].map((m) => ({
    id: Number(m[1]), globs, lang: "ts", layer: "api", strength: "must", checkability: "checkable", checkability_reason: "a regex",
  })),
});

const make = (s: ReturnType<typeof setupAdmission>, run: ReturnType<typeof fakeRunner>["run"], gh?: { data: PrLessonData | null }) =>
  new LessonEnricher({
    repo: s.repo, runs: s.runs, recorder: s.recorder, judgments: s.judgments, run, lang: () => "en", now: () => s.clock.now, fallbackCwd: () => "/home",
    gh: gh ? { available: () => true, prLessonDataDetail: async () => ({ data: gh.data, stderr: "" }) } : undefined,
  });

describe("LessonEnricher", () => {
  it("fills scope, strength and checkability on lessons never enriched, as one undoable auto batch", async () => {
    const s = setupAdmission();
    const a = s.lesson("validate input");
    const b = s.lesson("log errors", { status: "confirmed" });
    s.repo.setFields(b, { strength: "should" }, 1);
    const f = fakeRunner({ lesson_enrich: answer() });
    const e = make(s, f.run);
    expect(e.needing().map((l) => l.id)).toEqual([a, b]);
    const r = await e.enrich([a, b]);
    expect(r.ok && r.value).toMatchObject({ enriched: [a, b], missing: [], calls: 1 });
    expect(s.repo.get(a)).toMatchObject({ scopeGlobs: ["src/api/**"], scopeLang: "ts", strength: "must", checkability: "checkable", checkabilityReason: "a regex", enrichedAt: s.clock.now });
    // 用户定过的不动；已确认的状态也不动。
    expect(s.repo.get(b)).toMatchObject({ strength: "should", status: "confirmed" });
    expect(f.calls[0]).toMatchObject({ task: "lesson_enrich", cwd: "/home" });
    const batchId = r.ok ? r.value.batchId! : 0;
    expect(s.recorder.get(batchId)).toMatchObject({ kind: "lesson_enrich", origin: "auto" });
    expect(s.recorder.undo(batchId, 2).ok).toBe(true);
    expect(s.repo.get(a)).toMatchObject({ scopeGlobs: [], strength: null, enrichedAt: null });
    expect(e.needing().map((l) => l.id)).toEqual([a, b]);
  });

  it("reuses the cached judgment after an undo, and asks again once the text changed", async () => {
    const s = setupAdmission();
    const a = s.lesson("validate input");
    const f = fakeRunner({ lesson_enrich: answer() });
    const e = make(s, f.run);
    const r = await e.enrich([a]);
    s.recorder.undo(r.ok ? r.value.batchId! : 0, 2);
    await e.enrich([a]);
    expect(f.calls).toHaveLength(1);
    expect(s.repo.get(a)?.enrichedAt).not.toBeNull();
    s.recorder.undo(s.recorder.list({ limit: 10 })[0].id, 3);
    s.repo.setText(a, "validate every input", 4);
    await e.enrich([a]);
    expect(f.calls).toHaveLength(2);
  });

  it("puts the source comments into the prompt: from gh when the repo is cloned, otherwise from stored findings", async () => {
    const s = setupAdmission();
    const run = s.runs.start({ queueId: null, slug: "acme/web", prNumber: 101, origin: "backfill", startedAt: 1 });
    s.runs.finish(run, { status: "done", reason: null, finishedAt: 2, findings: [{ comment_url: "https://github.com/acme/web/pull/101#r101", summary: "reviewer asked for a null check" }] });
    const a = s.lesson("check nulls", { sources: [{ prNumber: 101, runId: run }] });
    const f = fakeRunner({ lesson_enrich: answer() });
    await make(s, f.run).enrich([a]);
    expect(f.calls[0].prompt).toContain("reviewer asked for a null check");
    expect(s.repo.sourcesWithExcerpt(a)[0].excerpt).toBe("reviewer asked for a null check");
  });

  it("uses gh review comments for reviewer, path and text", async () => {
    const s = setupAdmission();
    s.repo.upsertRepo("acme/web", process.cwd(), 1);
    const a = s.lesson("check nulls", { sources: [{ prNumber: 7, url: "https://github.com/acme/web/pull/7#c1" }] });
    const data = {
      number: 7, title: "t", body: "", url: "https://github.com/acme/web/pull/7", author: "dev", headRefName: "b", mergedAt: "2026-01-01T00:00:00Z",
      reviews: [], comments: [], commits: [], botLogins: new Set<string>(),
      inline: [{ id: "c1", author: "rev1", body: "null check here please", url: "https://github.com/acme/web/pull/7#c1", path: "src/a.ts", line: 3, createdAt: 5, reviewId: null }],
    } satisfies PrLessonData;
    const f = fakeRunner({ lesson_enrich: answer() });
    await make(s, f.run, { data }).enrich([a]);
    const src = s.repo.sourcesWithExcerpt(a)[0];
    expect(src).toMatchObject({ reviewer: "rev1", path: "src/a.ts", line: 3, excerpt: "null check here please" });
    expect(f.calls[0].prompt).toContain("rev1 · src/a.ts:3");
  });

  it("a failed call leaves lessons unenriched; lessons the model skipped are reported missing", async () => {
    const s = setupAdmission();
    const a = s.lesson("a");
    const b = s.lesson("b");
    const bad = make(s, fakeRunner({ lesson_enrich: () => failed("claude_error") }).run);
    expect((await bad.enrich([a, b])).ok).toBe(false);
    const partial = make(s, fakeRunner({ lesson_enrich: (req) => ({ enriched: answer()(req).enriched.filter((x) => x.id === a) }) }).run);
    const r = await partial.enrich([a, b]);
    expect(r.ok && r.value).toMatchObject({ enriched: [a], missing: [b] });
  });

  it("enrichAll goes chunk by chunk and counts calls", async () => {
    const s = setupAdmission();
    for (let i = 0; i < ENRICH_CHUNK + 3; i++) s.lesson(`rule ${i}`);
    const f = fakeRunner({ lesson_enrich: answer([]) });
    let counted = 0;
    expect(await make(s, f.run).enrichAll(undefined, () => counted++)).toEqual({ enriched: ENRICH_CHUNK + 3, failed: 0, calls: 2 });
    expect(counted).toBe(2);
  });
});
