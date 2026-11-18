import { describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import type { DraftGeneration } from "../../checks/draft";
import { failed, fakeRunner, setupAdmission, type FakeAnswer } from "./__fixtures__/setup";
import { AdmissionService } from "./service";

const rules = (prompt: string) => [...prompt.matchAll(/^#(\d+) \[[^\]]*\] \([^)]*\) (.*)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2] }));

function build(extra: Record<string, FakeAnswer> = {}, hooks: { beforeClarity?: () => void; onDraft?: (id: number) => void } = {}) {
  setLang("en");
  const s = setupAdmission();
  const fake = fakeRunner({
    lesson_cluster: (req) => {
      const rs = rules(req.prompt).filter((r) => r.text.includes("migration"));
      return { groups: rs.length > 1 ? [{ ids: rs.map((r) => r.id), text: "Add a migration whenever the schema changes" }] : [] };
    },
    lesson_conflict: (req) => {
      const rs = rules(req.prompt);
      const tabs = rs.find((r) => r.text.includes("tabs"));
      const spaces = rs.find((r) => r.text.includes("spaces"));
      return { conflicts: tabs && spaces ? [{ a: tabs.id, b: spaces.id, kind: "conflict", reason: "tabs vs spaces" }] : [] };
    },
    lesson_clarity: (req) => {
      hooks.beforeClarity?.();
      return { clarity: rules(req.prompt).map((r) => ({ id: r.id, answer: "yes", scope_clear: true, reason: "ok" })) };
    },
    lesson_classify: (req) => ({ classified: rules(req.prompt).map((r) => ({ id: r.id, checkability: r.text.includes("console") ? "checkable" : "prose", reason: "r", covered_by: null })) }),
    lesson_sample_review: (req) => ({ reviews: [...req.prompt.matchAll(/^#(\d+) /gm)].map((m) => ({ id: Number(m[1]), reasonable: true, follows: true, scope_ok: true, note: "" })) }),
    ...extra,
  });
  const drafter = {
    generate: async (id: number): Promise<DraftGeneration> => (hooks.onDraft?.(id), {
      ok: true, kind: "draft", reason: "regex", model: "m", degraded: false, scope: { kind: "repo", slug: "acme/web" },
      draft: { type: "forbidden_pattern", name: `no console ${id}`, params: { pattern: "console\\.log" }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "shadow", enabled: true, message: "m" },
    }),
  };
  const service = new AdmissionService({
    db: s.db, repo: s.repo, recorder: s.recorder, policies: s.policies, judgments: s.judgments, runs: s.runs, checks: s.checks, drafter, run: fake.run, batches: s.batches,
    lang: () => "en", now: () => s.clock.now, fallbackCwd: () => "/home",
  });
  return { ...s, fake, service };
}

describe("admission under concurrent changes and edge cases", () => {
  it("does not overwrite a lesson confirmed by hand while the pass was waiting for the model", async () => {
    let target = 0;
    const s: ReturnType<typeof build> = build({}, { beforeClarity: () => void s.batches.bulk("confirm", { ids: [target] }) });
    target = s.lesson("prefer early returns", { sources: [{}, {}] });
    await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    expect(s.repo.get(target)).toMatchObject({ status: "confirmed", admission: "manual" });
  });

  it("keeps a conflict verdict when the category is changed by hand", async () => {
    const s = build();
    const tabs = s.lesson("indent with tabs", { sources: [{}, {}] });
    s.lesson("indent with spaces", { sources: [{}, {}] });
    await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    expect(s.repo.get(tabs)).toMatchObject({ admission: "shelved", shelvedReason: "conflict" });
    let done: Promise<void> = Promise.resolve();
    s.checks.onLessonClassified((...a) => (done = s.service.onClassified(...a)));
    s.checks.classifyLesson(tabs, "checkable");
    await done;
    expect(s.repo.get(tabs)).toMatchObject({ admission: "shelved", shelvedReason: "conflict" });
  });

  it("keeps a duplicate verdict when the category is changed by hand, so accept still merges it", async () => {
    const s = build();
    const a = s.lesson("add a migration when the schema changes", { sources: [{}, {}] });
    const b = s.lesson("schema changes need a migration", { sources: [{}, {}] });
    await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    const dup = [a, b].find((id) => s.repo.get(id)!.shelvedReason === "duplicate")!;
    let done: Promise<void> = Promise.resolve();
    s.checks.onLessonClassified((...x) => (done = s.service.onClassified(...x)));
    s.checks.classifyLesson(dup, "prose");
    await done;
    expect(s.repo.get(dup)).toMatchObject({ shelvedReason: "duplicate" });
    s.service.accept();
    expect(s.repo.get(dup)!.mergedInto).not.toBeNull();
  });

  it("asks every similar pair once even when the group is larger than dedupe.maxGroup", async () => {
    const s = build();
    s.policies.setLayer({ kind: "global" }, { "dedupe.maxGroup": 2 });
    s.lesson("add a migration when the schema changes", { sources: [{}, {}] });
    s.lesson("add a migration when the schema changes now", { sources: [{}, {}] });
    s.lesson("add a migration when the schema changes always", { sources: [{}, {}] });
    await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    const first = s.fake.of("lesson_cluster").length;
    expect(first).toBe(3);
    await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    expect(s.fake.of("lesson_cluster")).toHaveLength(first);
  });

  it("does not auto-confirm when the sample review got no answers", async () => {
    const s = build({ lesson_sample_review: () => failed() });
    const c = s.lesson("no console calls in src", { sources: [{}, {}] });
    s.policies.setLayer({ kind: "repo", slug: "acme/web" }, { "admission.autoConfirm": true });
    await s.service.autoAdmit("acme/web");
    expect(s.repo.get(c)!.status).toBe("pending");
    const id = (s.db.prepare(`SELECT MAX(id) AS id FROM batch_reviews`).get() as { id: number }).id;
    expect(s.service.review(id, { kind: "repo", slug: "acme/web" })).toMatchObject({ blocked: true, weakest: "sampleReviewed" });
  });

  it("writes no new plan batch when only time has passed", async () => {
    const s = build();
    s.lesson("prefer early returns", { sources: [{}, {}] });
    const r1 = await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    expect(r1.planBatch).not.toBeNull();
    s.clock.now += 86_400_000;
    const r2 = await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    expect(r2.planBatch).toBeNull();
  });

  it("does not keep a draft made while the lesson was edited", async () => {
    let edit = true;
    const s: ReturnType<typeof build> = build({}, {
      onDraft: (id) => {
        if (edit) s.repo.setText(id, "no console calls anywhere in src", s.clock.now);
        edit = false;
      },
    });
    const c = s.lesson("no console calls in src", { sources: [{}, {}] });
    const r = await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    expect(r.verdicts.find((v) => v.lessonId === c)).toMatchObject({ verdict: "unfinished" });
    expect(s.repo.get(c)!.admission).not.toBe("auto");
  });

  it("judges a converted lesson whose check is gone as checkable and drafts a check", async () => {
    const s = build();
    const c = s.lesson("no console calls in src", { sources: [{}, {}] });
    s.repo.setFields(c, { checkability: "converted" }, 1);
    const r = await s.service.judge({ kind: "repo", slug: "acme/web" }, { review: false });
    expect(r.verdicts.find((v) => v.lessonId === c)).toMatchObject({ verdict: "admit", check: true });
  });
});
