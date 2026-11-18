import { describe, expect, it } from "vitest";
import { setLang } from "../../i18n";
import type { DraftGeneration } from "../../checks/draft";
import { failed, fakeRunner, setupAdmission, type FakeAnswer } from "./__fixtures__/setup";
import { AdmissionService } from "./service";
import { WIZARD_MAX_ATTEMPTS, WIZARD_POLL_MS, WIZARD_RETRY_MS, WizardService, type Timers } from "./wizard";

const ids = (prompt: string) => [...prompt.matchAll(/^#(\d+) \[[^\]]*\] \([^)]*\) (.*)$/gm)].map((m) => ({ id: Number(m[1]), text: m[2] }));

function manualTimers() {
  const queue: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const t: Timers & { fire(): Promise<void>; pending(): { ms: number }[] } = {
    set: (fn, ms) => {
      const h = { fn, ms, cleared: false };
      queue.push(h);
      return h;
    },
    clear: (h) => void ((h as { cleared: boolean }).cleared = true),
    pending: () => queue.filter((h) => !h.cleared),
    async fire() {
      const live = queue.splice(0).filter((h) => !h.cleared);
      for (const h of live) h.fn();
    },
  };
  return t;
}

function build(o: { cluster?: FakeAnswer; review?: FakeAnswer; prs?: number[] } = {}) {
  setLang("en");
  const s = setupAdmission();
  const fake = fakeRunner({
    lesson_cluster:
      o.cluster ??
      ((req) => {
        const rs = ids(req.prompt).filter((r) => r.text.includes("migration"));
        return { groups: rs.length > 1 ? [{ ids: rs.map((r) => r.id), text: "Add a migration whenever the schema changes" }] : [] };
      }),
    lesson_conflict: () => ({ conflicts: [] }),
    lesson_clarity: (req) => ({ clarity: ids(req.prompt).map((r) => ({ id: r.id, answer: "yes", scope_clear: true, reason: "ok" })) }),
    lesson_classify: (req) => ({ classified: ids(req.prompt).map((r) => ({ id: r.id, checkability: r.text.includes("console") ? "checkable" : "prose", reason: "r", covered_by: null })) }),
    lesson_sample_review:
      o.review ?? ((req) => ({ reviews: [...req.prompt.matchAll(/^#(\d+) /gm)].map((m) => ({ id: Number(m[1]), reasonable: true, follows: true, scope_ok: true, note: "" })) })),
  });
  const drafter = {
    generate: async (id: number): Promise<DraftGeneration> => ({
      ok: true, kind: "draft", reason: "regex", model: "m", degraded: false, scope: { kind: "repo", slug: "acme/web" },
      draft: { type: "forbidden_pattern", name: `no console ${id}`, params: { pattern: "console\\.log" }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "shadow", enabled: true, message: "m" },
    }),
  };
  const admission = new AdmissionService({
    db: s.db, repo: s.repo, recorder: s.recorder, policies: s.policies, judgments: s.judgments, runs: s.runs, checks: s.checks, drafter, run: fake.run, batches: s.batches,
    lang: () => "en", now: () => s.clock.now, fallbackCwd: () => "/home",
  });
  const prs = o.prs ?? [1, 2];
  const runner = {
    backfill: async (slug: string) => {
      const enqueued = s.repo.enqueue(slug, prs, "backfill", s.clock.now);
      return { ok: true as const, enqueued, prs };
    },
    mergedPrNumbers: async () => prs,
  };
  const enricher = { needing: () => [], enrich: async () => ({ ok: true as const, value: { enriched: [], missing: [], batchId: null, calls: 0 }, model: null, degraded: false, sameModelReview: false }) };
  const timers = manualTimers();
  const make = () =>
    new WizardService({
      db: s.db, repo: s.repo, admission, runner, enricher, bulk: (verb, target) => s.batches.bulk(verb, target), now: () => s.clock.now, timers, policyVersion: () => s.policies.version(),
    });
  const finishQueue = () => s.db.prepare(`UPDATE lesson_queue SET status = 'done', attempts = 1`).run();
  return { ...s, fake, admission, timers, make, wizard: make(), finishQueue };
}

describe("WizardService", () => {
  it("runs the stages, waits for the queue, summarises and accepts in one undoable batch", async () => {
    const s = build();
    const a = s.lesson("add a migration when the schema changes", { sources: [{}, {}] });
    const b = s.lesson("schema changes need a migration");
    const c = s.lesson("no console calls in src", { sources: [{}, {}] });
    const one = s.lesson("rename the helper");
    const id = s.wizard.start({ kind: "repo", slug: "acme/web" });
    await s.wizard.idle();
    expect(s.wizard.view(id)).toMatchObject({ state: "extracting", progress: { prs: { done: 0, total: 2 } } });
    expect(s.timers.pending()).toEqual([expect.objectContaining({ ms: WIZARD_POLL_MS })]);
    // 同一个范围再开始：回到这一次。
    expect(s.wizard.start({ kind: "repo", slug: "acme/web" })).toBe(id);

    s.finishQueue();
    await s.timers.fire();
    await s.wizard.idle();
    const v = s.wizard.view(id)!;
    expect(v.state).toBe("awaiting_accept");
    expect(v.notes).toEqual(expect.arrayContaining([{ kind: "scanUnavailable" }, { kind: "notBacktested" }]));
    expect(v.summary).toMatchObject({
      prs: { total: 2, analysed: 2 }, candidates: 4, admitted: { prose: 1, checks: 1 }, merged: 1, shelved: { generality: 1 }, unfinished: 0, passRate: 1, backtested: false,
    });
    // 两次 PR 分析 + 走假模型的调用（去重、冲突、清晰度、分类、抽查）+ 一次检查草稿（草稿走 E1 的 drafter）。
    expect(v.calls).toBe(2 + s.fake.calls.length + 1);
    expect(v.summary!.calls).toBe(v.calls);
    expect(v.verdicts.find((x) => x.lessonId === b)).toMatchObject({ verdict: "merged", ref: a });

    const before = Object.fromEntries([a, b, c, one].map((x) => [x, s.repo.get(x)]));
    const acc = await s.wizard.act({ op: "accept", runId: id });
    expect(acc).toMatchObject({ ok: true });
    expect(s.wizard.view(id)).toMatchObject({ state: "accepted", acceptBatch: (acc as { batchId: number }).batchId });
    expect(s.repo.get(a)).toMatchObject({ status: "confirmed" });
    expect(s.repo.get(b)!.mergedInto).toBe(a);
    expect(s.repo.get(one)).toMatchObject({ status: "pending", admission: "shelved" });
    expect(s.recorder.undo((acc as { batchId: number }).batchId, 2).ok).toBe(true);
    for (const x of [a, b, c, one]) expect(s.repo.get(x)).toEqual(before[x]);
  });

  it("resumes after a restart and retries failed calls after 1, 5 and 15 minutes", async () => {
    let fail = true;
    const s = build({
      cluster: (req) => {
        if (fail) return failed();
        const rs = ids(req.prompt);
        return { groups: [{ ids: rs.map((r) => r.id), text: "Add a migration whenever the schema changes" }] };
      },
    });
    const a = s.lesson("add a migration when the schema changes", { sources: [{}, {}] });
    s.lesson("schema changes need a migration", { sources: [{}, {}] });
    s.finishQueue();
    const id = s.wizard.start({ kind: "repo", slug: "acme/web" });
    await s.wizard.idle();
    await s.timers.fire(); // 队列：两个 PR 刚排进去，再看一次
    s.finishQueue();
    await s.timers.fire();
    await s.wizard.idle();
    let v = s.wizard.view(id)!;
    expect(v.state).toBe("awaiting_accept");
    expect(v.summary!.unfinished).toBe(2);
    expect(v.failed).toEqual([expect.objectContaining({ kind: "cluster", attempts: 1, retryAt: s.clock.now + WIZARD_RETRY_MS[0] })]);

    // 重启：新的服务、同一个库。
    s.wizard.stop();
    const again = s.make();
    again.resume();
    expect(s.timers.pending()).toHaveLength(1);
    s.clock.now += WIZARD_RETRY_MS[0];
    await s.timers.fire();
    await again.idle();
    v = again.view(id)!;
    expect(v.failed[0]).toMatchObject({ attempts: 2, retryAt: s.clock.now + WIZARD_RETRY_MS[1] });

    fail = false;
    s.clock.now += WIZARD_RETRY_MS[1];
    await s.timers.fire();
    await again.idle();
    v = again.view(id)!;
    expect(v.failed).toEqual([]);
    expect(v.summary).toMatchObject({ unfinished: 0, merged: 1 });
    expect(v.verdicts.find((x) => x.lessonId === a)).toMatchObject({ verdict: "admit" });
  });

  it("stops retrying after the last attempt and lets the user retry by hand", async () => {
    const s = build({ cluster: () => failed() });
    s.lesson("add a migration when the schema changes", { sources: [{}, {}] });
    s.lesson("schema changes need a migration", { sources: [{}, {}] });
    s.finishQueue();
    const id = s.wizard.start({ kind: "repo", slug: "acme/web" });
    await s.wizard.idle();
    s.finishQueue();
    await s.timers.fire();
    await s.wizard.idle();
    for (let i = 0; i < WIZARD_MAX_ATTEMPTS; i++) {
      s.clock.now += WIZARD_RETRY_MS[i];
      await s.timers.fire();
      await s.wizard.idle();
    }
    const v = s.wizard.view(id)!;
    expect(v.failed[0]).toMatchObject({ attempts: WIZARD_MAX_ATTEMPTS + 1, retryAt: null });
    expect(s.timers.pending()).toEqual([]);
    const calls = s.fake.of("lesson_cluster").length;
    expect(calls).toBe(WIZARD_MAX_ATTEMPTS + 1);
    await s.wizard.act({ op: "retry", runId: id });
    expect(s.fake.of("lesson_cluster")).toHaveLength(calls + 1);
    expect(s.wizard.view(id)!.failed[0]).toMatchObject({ attempts: 1 });
  });

  it("a limit defers the item without using an attempt", async () => {
    const s = build({ cluster: () => failed("limited", 5_000_000) });
    s.lesson("add a migration when the schema changes", { sources: [{}, {}] });
    s.lesson("schema changes need a migration", { sources: [{}, {}] });
    s.finishQueue();
    const id = s.wizard.start({ kind: "repo", slug: "acme/web" });
    await s.wizard.idle();
    s.finishQueue();
    await s.timers.fire();
    await s.wizard.idle();
    expect(s.wizard.view(id)!.failed[0]).toMatchObject({ attempts: 0, retryAt: 5_000_000 });
  });

  it("hides accept when the sample review is past its floor; shelved lessons can be pulled back", async () => {
    const s = build({
      review: (req) => ({ reviews: [...req.prompt.matchAll(/^#(\d+) /gm)].map((m) => ({ id: Number(m[1]), reasonable: false, follows: true, scope_ok: true, note: "no" })) }),
    });
    s.lesson("no console calls in src", { sources: [{}, {}] });
    const one = s.lesson("rename the helper");
    s.finishQueue();
    const id = s.wizard.start({ kind: "repo", slug: "acme/web" });
    await s.wizard.idle();
    s.finishQueue();
    await s.timers.fire();
    await s.wizard.idle();
    const v = s.wizard.view(id)!;
    expect(v.review).toMatchObject({ blocked: true, weakest: "samplePassRate" });
    expect(await s.wizard.act({ op: "accept", runId: id })).toEqual({ ok: false, reason: "blocked" });
    const back = await s.wizard.act({ op: "pullBack", runId: id, lessonIds: [one] });
    expect(back).toMatchObject({ ok: true, affected: 1 });
    expect(s.repo.get(one)).toMatchObject({ status: "confirmed" });
    expect(s.db.prepare(`SELECT auto_verdict, human_verdict FROM score_calibration WHERE lesson_id = ?`).get(one)).toEqual({ auto_verdict: "shelve", human_verdict: "admit" });
  });

  it("recalculates from the cache after a threshold change without calling a model again", async () => {
    const s = build();
    s.lesson("no console calls in src", { sources: [{}, {}] });
    const one = s.lesson("rename the helper");
    s.finishQueue();
    const id = s.wizard.start({ kind: "repo", slug: "acme/web" });
    await s.wizard.idle();
    s.finishQueue();
    await s.timers.fire();
    await s.wizard.idle();
    expect(s.wizard.view(id)!.summary!.shelved).toEqual({ generality: 1 });
    const calls = s.fake.calls.length;
    s.policies.setLayer({ kind: "global" }, { "generality.minHits": 1, "generality.minPrs": 1, "score.proseAdmitLine": 0.1, "score.admitLine": 0.1 });
    expect(await s.wizard.act({ op: "recalculate", runId: id })).toMatchObject({ ok: true });
    const v = s.wizard.view(id)!;
    expect(v.verdicts.find((x) => x.lessonId === one)).toMatchObject({ verdict: "admit" });
    // 只有之前没判到的那条要补清晰度和分类（闸门 3 没过时不问），去重、冲突都读缓存。
    const fresh = s.fake.calls.slice(calls).map((c) => c.task);
    expect(fresh).not.toContain("lesson_cluster");
    expect(fresh).not.toContain("lesson_conflict");
  });
});
