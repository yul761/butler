import { describe, expect, it } from "vitest";
import { MAIN_STRINGS } from "../../strings";
import { setLang } from "../../i18n";
import { failed, fakeRunner, setupAdmission, type FakeAnswer } from "./__fixtures__/setup";
import { AdmissionPipeline, type CoverageProvider } from "./pipeline";
import type { DraftGeneration } from "../../checks/draft";

/** 从提示词里读出规矩：#id [scope] (globs) text */
const rules = (prompt: string) => [...prompt.matchAll(/^#(\d+) \[[^\]]*\] \([^)]*\) (.*)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2] }));

/** 假模型：去重按关键词分组；冲突：tabs / spaces；清晰度：带 vague 的说 no，带 skipme 的不答；分类：带 console 的能检查。 */
const answers = (extra: Record<string, FakeAnswer> = {}) => ({
  lesson_cluster: (req: { prompt: string }) => {
    const rs = rules(req.prompt);
    const groups = ["migration", "IPC"].map((w) => rs.filter((r) => r.text.includes(w)).map((r) => r.id)).filter((g) => g.length > 1);
    return { groups: groups.map((ids) => ({ ids, text: ids.length && rs.find((r) => r.id === ids[0])!.text.includes("migration") ? "Add a migration whenever the schema changes" : "Validate every IPC argument" })) };
  },
  lesson_conflict: (req: { prompt: string }) => {
    const rs = rules(req.prompt);
    const tabs = rs.find((r) => r.text.includes("tabs"));
    const spaces = rs.find((r) => r.text.includes("spaces"));
    return { conflicts: tabs && spaces ? [{ a: tabs.id, b: spaces.id, kind: "conflict", reason: "tabs vs spaces" }] : [] };
  },
  lesson_clarity: (req: { prompt: string }) => ({
    clarity: rules(req.prompt).filter((r) => !r.text.includes("skipme")).map((r) => ({ id: r.id, answer: r.text.includes("vague") ? "no" : "yes", scope_clear: true, reason: "fine" })),
  }),
  lesson_classify: (req: { prompt: string }) => ({
    classified: rules(req.prompt).map((r) => ({ id: r.id, checkability: r.text.includes("console") ? "checkable" : "prose", reason: "because", covered_by: r.text.includes("lint already") ? "eslint rule" : null })),
  }),
  ...extra,
});

const draft = (id: number): DraftGeneration => ({
  ok: true, kind: "draft", reason: "regex", model: "m", degraded: false, scope: { kind: "repo", slug: "acme/web" },
  draft: { type: "forbidden_pattern", name: `no console ${id}`, params: { pattern: "console\\.log" }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "shadow", enabled: true, message: "m" },
});

function build(o: { answers?: Record<string, FakeAnswer>; coverage?: CoverageProvider; draftKind?: "draft" | "prose" } = {}) {
  setLang("en");
  const s = setupAdmission();
  const fake = fakeRunner(answers(o.answers));
  const drafted: number[] = [];
  const drafter = {
    generate: async (id: number): Promise<DraftGeneration> => (drafted.push(id), o.draftKind === "prose" ? { ok: true, kind: "prose", reason: "needs judgement", model: "m", degraded: false } : draft(id)),
  };
  const pipeline = new AdmissionPipeline({
    repo: s.repo, recorder: s.recorder, policies: s.policies, judgments: s.judgments, runs: s.runs, checks: s.checks, drafter, run: fake.run,
    lang: () => "en", now: () => s.clock.now, fallbackCwd: () => "/home", coverage: o.coverage ?? null,
  });
  const two = () => [{}, {}];
  return { ...s, fake, pipeline, drafted, two };
}
const T = MAIN_STRINGS.en.admission;

describe("AdmissionPipeline.judge", () => {
  it("merges duplicates, shelves conflicts and one-offs, scores and admits the rest in one plan batch", async () => {
    const s = build();
    const m1 = s.lesson("add a migration when the schema changes", { at: s.clock.now - 10, sources: s.two() });
    const m2 = s.lesson("schema changes need a migration");
    const tabs = s.lesson("indent with tabs", { sources: s.two() });
    const spaces = s.lesson("indent with spaces", { sources: s.two() });
    const once = s.lesson("rename the helper");
    const check = s.lesson("no console calls in src", { sources: s.two() });
    const prose = s.lesson("error messages say what to do next", { sources: [{}, {}, {}] });
    const vague = s.lesson("code should be vague and nice", { sources: s.two() });
    const ipc = s.lesson("validate IPC arguments", { status: "confirmed" });
    const ipc2 = s.lesson("validate every IPC argument");
    s.repo.setFields(prose, { checkability: "prose" }, 1);

    const r = await s.pipeline.judge({ kind: "repo", slug: "acme/web" });
    const v = Object.fromEntries(r.verdicts.map((x) => [x.lessonId, x]));
    expect(r.candidates).toBe(9);
    expect(v[m2]).toMatchObject({ verdict: "merged", reason: "duplicate", ref: m1 });
    expect(v[m1]).toMatchObject({ verdict: "admit", check: false });
    expect(v[ipc2]).toMatchObject({ verdict: "merged", ref: ipc });
    expect(v[ipc]).toBeUndefined();
    expect(v[tabs]).toMatchObject({ verdict: "shelved", reason: "conflict", ref: spaces, note: T.note.conflict(spaces, "tabs vs spaces") });
    expect(v[spaces]).toMatchObject({ verdict: "shelved", reason: "conflict", ref: tabs });
    expect(v[once]).toMatchObject({ verdict: "shelved", reason: "generality", note: T.note.generality(1, 1, 2, 2) });
    expect(v[check]).toMatchObject({ verdict: "admit", check: true });
    expect(v[prose]).toMatchObject({ verdict: "admit", check: false });
    expect(v[vague]).toMatchObject({ verdict: "shelved", reason: "clarity" });
    expect(s.drafted).toEqual([check]);

    // 计划批次只改字段，不合并、不确认；确认过的那条一点没动。
    const l = (id: number) => s.repo.get(id)!;
    expect(l(m2)).toMatchObject({ status: "pending", admission: "shelved", shelvedReason: "duplicate", shelvedRef: m1, mergedInto: null });
    expect(l(m1)).toMatchObject({ status: "pending", admission: "auto" });
    expect(l(m1).scoreParts).toMatchObject({ evidence: { value: expect.any(Number) }, clarity: { value: 1 }, consistency: { value: 1 }, composite: { value: expect.any(Number) } });
    expect(l(check)).toMatchObject({ admission: "auto", checkability: "checkable", checkabilityReason: "because" });
    expect(l(check).scoreParts!.cap!.value).toBe(0.69);
    expect(l(ipc)).toMatchObject({ status: "confirmed", admission: "pending", batchId: null });
    expect(l(once)).toMatchObject({ admission: "shelved", shelvedNote: T.note.generality(1, 1, 2, 2) });
    expect(s.recorder.get(r.planBatch!)).toMatchObject({ kind: "admission_plan", origin: "auto" });

    // 再判一次：全部来自缓存，没有新的调用，计划也不变（没有新批次）。
    const n = s.fake.calls.length;
    const again = await s.pipeline.judge({ kind: "repo", slug: "acme/web" });
    expect(s.fake.calls.length).toBe(n);
    expect(again.planBatch).toBeNull();
    expect(again.verdicts).toEqual(r.verdicts);
  });

  it("undoing the plan batch restores every row", async () => {
    const s = build();
    const a = s.lesson("rename the helper");
    const before = s.repo.get(a)!;
    const r = await s.pipeline.judge({ kind: "repo", slug: "acme/web" });
    expect(s.repo.get(a)!.admission).toBe("shelved");
    s.recorder.undo(r.planBatch!, 5);
    expect(s.repo.get(a)).toMatchObject({ admission: before.admission, shelvedReason: null, shelvedNote: null });
  });

  it("failed or missing answers leave lessons unfinished and pending", async () => {
    const s = build({ answers: { lesson_classify: () => failed() } });
    const a = s.lesson("no console calls", { sources: s.two() });
    const b = s.lesson("explain skipme in docs", { sources: s.two() });
    s.repo.setFields(b, { checkability: "prose", admission: "shelved", shelvedReason: "low_score" }, 1);
    const r = await s.pipeline.judge({ kind: "repo", slug: "acme/web" });
    expect(r.verdicts.map((v) => [v.lessonId, v.verdict])).toEqual([[a, "unfinished"], [b, "unfinished"]]);
    expect(s.repo.get(b)).toMatchObject({ admission: "pending", shelvedReason: null });
  });

  it("covered: an enabled check made from the lesson, the repo baseline or the classifier", async () => {
    const coverage: CoverageProvider = { coveredBy: (q) => (q.text.includes("baseline") ? [{ label: "tsc strict", strength: "strong" }] : q.text.includes("weak") ? [{ label: "x", strength: "weak" }] : []), describeForPrompt: () => "eslint: no-console" };
    const s = build({ coverage });
    const own = s.lesson("own check exists", { sources: s.two() });
    s.repo.setFields(own, { checkability: "checkable" }, 1);
    s.checks.save({ kind: "repo", slug: "acme/web" }, null, { type: "forbidden_pattern", name: "mine", params: { pattern: "x" }, globs: [], excludeGlobs: [], severity: "warn", mode: "shadow", enabled: true, message: "m" }, { lessonId: own });
    const base = s.lesson("baseline handles it", { sources: s.two() });
    const lint = s.lesson("lint already catches it", { sources: s.two() });
    const weak = s.lesson("weak coverage only", { sources: s.two() });
    const r = await s.pipeline.judge({ kind: "repo", slug: "acme/web" });
    const v = Object.fromEntries(r.verdicts.map((x) => [x.lessonId, x]));
    expect(v[own]).toMatchObject({ verdict: "covered", note: T.note.covered("mine") });
    expect(v[base]).toMatchObject({ verdict: "covered", note: T.note.covered("tsc strict") });
    expect(v[lint]).toMatchObject({ verdict: "covered", note: T.note.covered("eslint rule") });
    expect(s.repo.get(lint)!.checkability).toBe("covered");
    expect(v[weak].verdict).not.toBe("covered");
    expect(s.fake.of("lesson_classify")[0].prompt).toContain("eslint: no-console");
  });

  it("a check draft that comes back as prose is judged against the stricter prose line", async () => {
    const s = build({ draftKind: "prose" });
    const a = s.lesson("no console calls", { sources: s.two() }); // 0.789：过可检查的线，没过文字线
    const r = await s.pipeline.judge({ kind: "repo", slug: "acme/web" });
    expect(r.verdicts[0]).toMatchObject({ lessonId: a, verdict: "shelved", reason: "low_score" });
    expect(s.repo.get(a)).toMatchObject({ checkability: "prose", checkabilityReason: "needs judgement" });
  });

  it("generality: a team habit of one reviewer passes unless it is switched off", async () => {
    const s = build();
    const a = s.lesson("error messages say what to do next", { sources: [{ reviewer: "r1" }, { reviewer: "r1" }, { reviewer: "r1" }] });
    s.repo.setFields(a, { checkability: "prose" }, 1);
    expect((await s.pipeline.judge({ kind: "repo", slug: "acme/web" })).verdicts[0].verdict).toBe("admit");
    s.policies.setLayer({ kind: "global" }, { "generality.allowSingleReviewer": false });
    const r = await s.pipeline.judge({ kind: "repo", slug: "acme/web" });
    expect(r.verdicts[0]).toMatchObject({ verdict: "shelved", reason: "generality", note: T.note.reviewers(1, 2) });
  });

  it("autoPickHigherHits keeps the side with more hits", async () => {
    const s = build();
    const tabs = s.lesson("indent with tabs", { sources: [{}, {}, {}, {}, {}] });
    const spaces = s.lesson("indent with spaces", { sources: s.two() });
    s.repo.setFields(tabs, { checkability: "prose" }, 1);
    s.policies.setLayer({ kind: "global" }, { "conflict.autoPickHigherHits": true });
    const v = Object.fromEntries((await s.pipeline.judge({ kind: "repo", slug: "acme/web" })).verdicts.map((x) => [x.lessonId, x]));
    expect(v[spaces]).toMatchObject({ verdict: "shelved", reason: "conflict", ref: tabs });
    expect(v[tabs].verdict).not.toBe("shelved");
    expect(s.repo.get(tabs)!.scoreParts!.consistency!.value).toBe(0.5);
  });

  it("in a product, a duplicate across repos is promoted to the product at accept", async () => {
    const s = build();
    const p = s.repo.createProduct("P", ["acme/web", "acme/api"], 1);
    const a = s.lesson("add a migration when the schema changes", { slug: "acme/web" });
    const b = s.lesson("schema changes need a migration", { slug: "acme/api" });
    const r = await s.pipeline.judge({ kind: "product", productId: p });
    const v = Object.fromEntries(r.verdicts.map((x) => [x.lessonId, x]));
    expect(v[b]).toMatchObject({ verdict: "merged", ref: a, promoteTo: p });
    // 只判一个仓库时不跨仓库比。
    const s2 = build();
    s2.repo.createProduct("P", ["acme/web", "acme/api"], 1);
    const c = s2.lesson("add a migration when the schema changes", { slug: "acme/web" });
    s2.lesson("schema changes need a migration", { slug: "acme/api" });
    const only = await s2.pipeline.judge({ kind: "repo", slug: "acme/web" });
    expect(only.verdicts).toEqual([expect.objectContaining({ lessonId: c, verdict: "shelved", reason: "generality" })]);
  });
});
