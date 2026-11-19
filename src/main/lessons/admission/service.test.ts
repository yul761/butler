import { describe, expect, it, vi } from "vitest";
import { setLang } from "../../i18n";
import type { DraftGeneration } from "../../checks/draft";
import { fakeRunner, setupAdmission } from "./__fixtures__/setup";
import { AUTO_ADMIT_DEBOUNCE_MS, AUTO_ADMIT_GATE_RETRY_MS, AdmissionService } from "./service";

const ids = (prompt: string) => [...prompt.matchAll(/^#(\d+) \[[^\]]*\] \([^)]*\) (.*)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2] }));

function build(o: { gateOpen?: () => boolean } = {}) {
  setLang("en");
  const s = setupAdmission();
  const fake = fakeRunner({
    lesson_cluster: (req) => {
      const rs = ids(req.prompt).filter((r) => r.text.includes("migration"));
      return { groups: rs.length > 1 ? [{ ids: rs.map((r) => r.id), text: "Add a migration whenever the schema changes" }] : [] };
    },
    lesson_conflict: () => ({ conflicts: [] }),
    lesson_clarity: (req) => ({ clarity: ids(req.prompt).map((r) => ({ id: r.id, answer: "yes", scope_clear: true, reason: "ok" })) }),
    lesson_classify: (req) => ({ classified: ids(req.prompt).map((r) => ({ id: r.id, checkability: r.text.includes("console") ? "checkable" : "prose", reason: "r", covered_by: null })) }),
    lesson_sample_review: (req) => ({ reviews: [...req.prompt.matchAll(/^#(\d+) /gm)].map((m) => ({ id: Number(m[1]), reasonable: true, follows: true, scope_ok: true, note: "" })) }),
  });
  const drafter = {
    generate: async (id: number): Promise<DraftGeneration> => ({
      ok: true, kind: "draft", reason: "regex", model: "m", degraded: false, scope: { kind: "repo", slug: "acme/web" },
      draft: { type: "forbidden_pattern", name: `no console ${id}`, params: { pattern: "console\\.log" }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "shadow", enabled: true, message: "m" },
    }),
  };
  let notified = 0;
  const service = new AdmissionService({
    db: s.db, repo: s.repo, recorder: s.recorder, policies: s.policies, judgments: s.judgments, runs: s.runs, checks: s.checks, drafter, run: fake.run, batches: s.batches,
    lang: () => "en", now: () => s.clock.now, fallbackCwd: () => "/home", notify: () => notified++,
    autoAdmitEnabled: () => true, gateOpen: o.gateOpen,
  });
  return { ...s, fake, service, notified: () => notified };
}

describe("AdmissionService", () => {
  it("judges, reviews, accepts in one batch and undoes it as a whole", async () => {
    const s = build();
    const p = s.repo.createProduct("P", ["acme/web", "acme/api"], 1);
    const a = s.lesson("add a migration when the schema changes", { slug: "acme/web", sources: [{}, {}] });
    const b = s.lesson("schema changes need a migration", { slug: "acme/api" });
    const c = s.lesson("no console calls in src", { sources: [{}, {}] });
    const one = s.lesson("rename the helper");
    const r = await s.service.judge({ kind: "product", productId: p }, { seed: 1 });
    expect(r.reviewId).not.toBeNull();
    const view = s.service.review(r.reviewId!, { kind: "product", productId: p })!;
    expect(view).toMatchObject({ sampleSize: 2, passRate: 1, blocked: false, shelved: { judged: 3, shelved: 1, byReason: { generality: 1 / 3 } } });

    const before = Object.fromEntries([a, b, c, one].map((id) => [id, s.repo.get(id)]));
    const acc = s.service.accept();
    expect(acc).toMatchObject({ confirmed: 2, merged: 1, promoted: 1, checks: 1 });
    expect(s.repo.get(a)).toMatchObject({ status: "confirmed", admission: "auto", scope: { kind: "product", productId: p }, text: "Add a migration whenever the schema changes", hits: 3 });
    expect(s.repo.get(b)!.mergedInto).toBe(a);
    expect(s.repo.get(one)).toMatchObject({ status: "pending", admission: "shelved" });
    const made = s.checks.repo.idsOfLesson(c);
    expect(made).toHaveLength(1);
    expect(s.checks.repo.get(made[0])).toMatchObject({ mode: "shadow" });
    expect(s.recorder.get(acc.batchId!)).toMatchObject({ kind: "accept_recommended", origin: "manual" });

    const undo = s.recorder.undo(acc.batchId!, 2);
    expect(undo.ok).toBe(true);
    for (const id of [a, b, c, one]) expect(s.repo.get(id)).toEqual(before[id]);
    expect(s.checks.repo.idsOfLesson(c)).toEqual([]);
    expect(s.repo.sourcesWithExcerpt(a)).toHaveLength(2);
  });

  it("a category change by hand is a calibration sample and re-judges the lesson", async () => {
    const s = build();
    const c = s.lesson("no console calls in src", { sources: [{}, {}] });
    await s.service.judge({ kind: "repo", slug: "acme/web" });
    expect(s.repo.get(c)).toMatchObject({ admission: "auto", checkability: "checkable" });
    let done: Promise<void> = Promise.resolve();
    s.checks.onLessonClassified((...args) => (done = s.service.onClassified(...args)));
    s.checks.classifyLesson(c, "prose");
    await done;
    const cal = s.db.prepare(`SELECT entity, auto_verdict, human_verdict FROM score_calibration WHERE lesson_id = ?`).all(c);
    expect(cal[0]).toEqual({ entity: "checkability", auto_verdict: "checkable", human_verdict: "prose" });
    // 0.789 过了可检查的线、没过文字线：改成文字以后搁置。
    expect(s.repo.get(c)).toMatchObject({ admission: "shelved", shelvedReason: "low_score", checkability: "prose" });
  });
});

describe("automatic admission", () => {
  it("judges a repository after analyses, confirms only under admission.autoConfirm", async () => {
    const s = build();
    const c = s.lesson("no console calls in src", { sources: [{}, {}] });
    await s.service.autoAdmit("acme/web");
    expect(s.repo.get(c)).toMatchObject({ status: "pending", admission: "auto" });
    expect(s.recorder.list({ limit: 5 })[0]).toMatchObject({ kind: "admission_plan", origin: "auto" });
    s.policies.setLayer({ kind: "repo", slug: "acme/web" }, { "admission.autoConfirm": true });
    await s.service.autoAdmit("acme/web");
    expect(s.repo.get(c)).toMatchObject({ status: "confirmed" });
    expect(s.recorder.list({ limit: 5 })[0]).toMatchObject({ kind: "accept_recommended", origin: "auto" });
  });

  it("automatic admission waits while its background gate is closed and runs once it opens (workstream R, L5)", async () => {
    vi.useFakeTimers();
    try {
      let open = false;
      const s = build({ gateOpen: () => open });
      const auto = vi.spyOn(s.service, "autoAdmit").mockResolvedValue();
      s.service.scheduleAuto("acme/web");
      vi.advanceTimersByTime(AUTO_ADMIT_DEBOUNCE_MS);
      expect(auto).not.toHaveBeenCalled();
      vi.advanceTimersByTime(AUTO_ADMIT_GATE_RETRY_MS);
      expect(auto).not.toHaveBeenCalled();
      open = true;
      vi.advanceTimersByTime(AUTO_ADMIT_GATE_RETRY_MS);
      expect(auto).toHaveBeenCalledTimes(1);
      expect(auto).toHaveBeenCalledWith("acme/web");
      s.service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a trigger that arrives while the repository is being judged runs one more pass afterwards", async () => {
    const s = build();
    s.lesson("no console calls in src", { sources: [{}, {}] });
    const judge = vi.spyOn(s.service, "judge");
    // 第二次在第一次判的过程中到（比如回测素材刚放弃）：不能丢，第一次判完再判一遍；再来几次也只多判一遍。
    const first = s.service.autoAdmit("acme/web");
    await s.service.autoAdmit("acme/web");
    await s.service.autoAdmit("acme/web");
    await first;
    expect(judge).toHaveBeenCalledTimes(2);
  });
});
