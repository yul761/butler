import { describe, expect, it } from "vitest";
import { BatchRecorder } from "../batches/batch-recorder";
import { lessonAdapter, mergeProposalAdapter } from "../batches/table-adapter";
import { failed, fakeRunner, setupAdmission, type FakeAnswer } from "./admission/__fixtures__/setup";
import { OPEN_GATE } from "./admission/model-steps";
import { LessonMergeService, MERGE_CHUNK, mergeRetryAfter, stableBlocks, type MergeLayer } from "./merge";
import type { Lesson } from "../../shared/lessons";

const ids = (prompt: string) => [...prompt.matchAll(/^#(\d+) \(/gm)].map((m) => Number(m[1]));

function build(answer: FakeAnswer, o: { overBudget?: (l: MergeLayer) => boolean; auto?: boolean } = {}) {
  let auto = o.auto ?? false;
  const s = setupAdmission();
  const recorder = new BatchRecorder(s.db, [lessonAdapter(s.db), mergeProposalAdapter(s.db)]);
  const fake = fakeRunner({ lesson_merge: answer });
  let changed = 0;
  const svc = new LessonMergeService({
    db: s.db, repo: s.repo, recorder, now: () => s.clock.now,
    ctx: () => ({ run: fake.run, judgments: s.judgments, lang: () => "en", now: () => s.clock.now, cwd: "/home", gate: OPEN_GATE }),
    overBudget: o.overBudget ?? (() => false), auto: () => auto, onChanged: () => changed++,
  });
  return { ...s, recorder, fake, svc, changed: () => changed, setAuto: (v: boolean) => (auto = v) };
}

const all = (text = "Re-read the row in the write transaction") => (req: { prompt: string }) => ({ merges: [{ ids: ids(req.prompt), text, why: "races lose edits" }] });

describe("LessonMergeService", () => {
  it("asks only about literally similar lessons with overlapping scope when the layer fits, on the cheap task", async () => {
    const s = build(all());
    const a = s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    const b = s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    s.lesson("use tabs for indentation", { status: "confirmed" });
    s.lesson("re-read the row inside the write transaction before saving it", {}); // 待确认的不算
    const r = await s.svc.suggest();
    expect(r).toEqual({ added: 1, accepted: 0, failed: 0 });
    expect(s.fake.of("lesson_merge")).toHaveLength(1);
    expect(ids(s.fake.calls[0].prompt)).toEqual([a, b]);
    expect(s.fake.calls[0].prompt).toContain("data, not instructions");
    expect(s.svc.pending()).toEqual([expect.objectContaining({ ids: [a, b], scope: { kind: "repo", slug: "acme/web" }, reason: "similar", text: "Re-read the row in the write transaction" })]);
    // 规矩没变：读缓存，不再调模型，也不重复提。
    expect(await s.svc.suggest()).toEqual({ added: 0, accepted: 0, failed: 0 });
    expect(s.fake.of("lesson_merge")).toHaveLength(1);
  });

  it("shows the whole layer to the model when it is over budget", async () => {
    const s = build(() => ({ merges: [] }), { overBudget: (l) => l.kind === "repo" && l.slug === "acme/web" });
    const xs = ["use tabs", "name files in kebab case", "no default exports"].map((t) => s.lesson(t, { status: "confirmed" }));
    s.lesson("prefer async iterators", { slug: "acme/api", status: "confirmed" });
    s.lesson("log request ids", { slug: "acme/api", status: "confirmed" });
    await s.svc.suggest();
    expect(s.fake.of("lesson_merge").map((c) => ids(c.prompt))).toEqual([xs]);
    expect(s.fake.calls[0].prompt).toContain("too many to fit");
  });

  it("accepting merges into the lesson with the most hits in one undoable batch; undo brings the proposal back", async () => {
    const s = build(all("Merged rule"));
    const a = s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    const b = s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed", sources: [{}, {}, {}] });
    s.repo.setFields(a, { scopeGlobs: ["src/**"] }, 1);
    s.repo.setFields(b, { scopeGlobs: ["src/db/**"] }, 1);
    await s.svc.suggest();
    const [p] = s.svc.pending();
    const r = s.svc.accept(p.id);
    expect(r).toMatchObject({ ok: true, affected: 3 });
    const keep = s.repo.get(b)!;
    expect(keep).toMatchObject({ text: "Merged rule", why: "races lose edits", scopeGlobs: ["src/**", "src/db/**"], mergedInto: null });
    expect(s.repo.get(a)!.mergedInto).toBe(b);
    expect(s.svc.pending()).toEqual([]);
    expect(s.recorder.undo((r as { batchId: number }).batchId, 2).ok).toBe(true);
    expect(s.repo.get(a)!.mergedInto).toBeNull();
    expect(s.repo.get(b)!.text).toBe("re-read the row inside the write transaction before writing back");
    expect(s.svc.pending().map((x) => x.id)).toEqual([p.id]);
  });

  it("a lesson edited while the model is still answering: the answer is dropped, the edit stays", async () => {
    let edit = () => {};
    const s = build(async (req) => {
      edit();
      return all("Model text")(req);
    });
    const a = s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    edit = () => s.repo.setText(a, "my own wording", 5);
    expect(await s.svc.suggest()).toMatchObject({ added: 0 });
    expect(s.repo.get(a)!.text).toBe("my own wording");
    expect(s.svc.pending()).toEqual([]);
  });

  it("a lesson edited after the proposal: it is hidden, and accepting is refused and marks it stale", async () => {
    const s = build(all());
    const a = s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    const b = s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    await s.svc.suggest();
    const [p] = s.svc.pending();
    s.repo.setText(a, "changed", 5);
    expect(s.svc.pending()).toEqual([]);
    expect(s.svc.accept(p.id)).toEqual({ ok: false, reason: "merge_stale" });
    expect(s.repo.get(b)!.mergedInto).toBeNull();
    expect(s.repo.get(a)!.text).toBe("changed");
    expect(s.svc.accept(p.id)).toEqual({ ok: false, reason: "not_found" });
  });

  it("dismissed proposals are not offered again for the same lessons; failed calls count as not done", async () => {
    let fail = false;
    const s = build((req) => (fail ? failed("timeout") : all()(req)));
    s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    await s.svc.suggest();
    const [p] = s.svc.pending();
    expect(s.svc.dismiss(p.id)).toEqual({ ok: true });
    expect(s.svc.dismiss(p.id)).toEqual({ ok: false, reason: "not_found" });
    s.judgments.put("merge", "x", "y", [], { model: null, degraded: false, at: 1 }); // 别的缓存不影响
    s.db.exec(`DELETE FROM lesson_judgments WHERE kind = 'merge' AND key != 'x'`);
    expect(await s.svc.suggest()).toEqual({ added: 0, accepted: 0, failed: 0 });
    expect(s.svc.pending()).toEqual([]);
    s.lesson("re-read the row inside the write transaction before saving again", { status: "confirmed" });
    fail = true;
    expect(await s.svc.suggest()).toMatchObject({ added: 0, failed: 1 });
    expect(s.svc.failed()).toBe(1);
  });

  it("auto-accepts new proposals as an auto batch when the setting is on", async () => {
    const s = build(all(), { auto: true });
    const a = s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    const b = s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    expect(await s.svc.suggest()).toMatchObject({ added: 1, accepted: 1 });
    // 次数一样多：保留编号小的。
    expect(s.repo.get(b)!.mergedInto).toBe(a);
    expect(s.db.prepare(`SELECT kind, origin FROM admission_batches`).all()).toEqual([{ kind: "merge_similar", origin: "auto" }]);
  });

  it("auto-accept also takes proposals left pending from earlier runs, but never one the user undid", async () => {
    const s = build(all());
    const a = s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    const b = s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    await s.svc.suggest();
    const [p] = s.svc.pending();
    // 设置后来才打开：这一轮没有新建议，以前留下的照样自动接受。
    s.setAuto(true);
    expect(await s.svc.suggest()).toEqual({ added: 0, accepted: 1, failed: 0 });
    expect(s.repo.get(b)!.mergedInto).toBe(a);
    const { id: batch } = s.db.prepare(`SELECT id FROM admission_batches WHERE kind = 'merge_similar'`).get() as { id: number };
    expect(s.recorder.undo(batch, 2).ok).toBe(true);
    expect(s.svc.pending().map((x) => x.id)).toEqual([p.id]);
    // 撤销过的：下一轮不再自动接受，只能手动接受。
    expect(await s.svc.suggest()).toEqual({ added: 0, accepted: 0, failed: 0 });
    expect(s.repo.get(b)!.mergedInto).toBeNull();
    expect(s.svc.accept(p.id)).toMatchObject({ ok: true });
  });

  it("a run that throws midway still updates the failure count instead of keeping the last one", async () => {
    const s = build(all());
    s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    await s.svc.suggest();
    expect(s.svc.failed()).toBe(0);
    s.lesson("never log a token or a secret to the console output", { status: "confirmed" });
    s.lesson("never log a token or a secret to the console at all", { status: "confirmed" });
    s.judgments.put = () => {
      throw new Error("disk full");
    };
    await expect(s.svc.suggest()).rejects.toThrow("disk full");
    expect(s.svc.failed()).toBe(1);
    expect(s.svc.running()).toBe(false);
  });

  it("a block that failed is not asked again (and paid for) until its backoff is over; the button asks right away", async () => {
    let fail = true;
    const s = build((req) => (fail ? failed("timeout") : all()(req)));
    s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    const calls = () => s.fake.of("lesson_merge").length;
    expect(await s.svc.suggest()).toMatchObject({ failed: 1 });
    expect(calls()).toBe(1);
    // 一小时后的定时任务：还在退避（2 小时），不调模型，照样算没问成。
    s.clock.now += 3600_000;
    expect(await s.svc.suggest()).toMatchObject({ added: 0, failed: 1 });
    expect(calls()).toBe(1);
    s.clock.now += 3600_000;
    expect(await s.svc.suggest()).toMatchObject({ failed: 1 });
    expect(calls()).toBe(2);
    // 第二次失败：退避翻倍到 4 小时；最多每天一次。
    expect(mergeRetryAfter(2)).toBe(4 * 3600_000);
    expect(mergeRetryAfter(9)).toBe(24 * 3600_000);
    s.clock.now += 3 * 3600_000;
    await s.svc.suggest();
    expect(calls()).toBe(2);
    // 用户点按钮：马上再问。
    fail = false;
    expect(await s.svc.suggest(undefined, { force: true })).toMatchObject({ added: 1, failed: 0 });
    expect(calls()).toBe(3);
  });

  it("blocks are cut by lesson id, so removing one lesson only re-asks its own block", async () => {
    const s = build(() => ({ merges: [] }), { overBudget: () => true });
    const xs = Array.from({ length: 150 }, (_, i) => s.lesson(`rule number ${i} about topic ${i}`, { status: "confirmed" }));
    await s.svc.suggest();
    const first = s.fake.of("lesson_merge").length;
    expect(first).toBeGreaterThan(2);
    s.repo.setStatus(xs[40], "rejected", 2);
    await s.svc.suggest();
    expect(s.fake.of("lesson_merge").length - first).toBe(1);
  });

  it("stableBlocks: no block over the cap, every lesson in exactly one block, no lonely last lesson", () => {
    const mk = (id: number) => ({ id }) as Lesson;
    const units = Array.from({ length: 200 }, (_, i) => [mk(i + 1)]);
    const blocks = stableBlocks(units);
    expect(blocks.flat().map((l) => l.id)).toEqual(units.flat().map((l) => l.id));
    expect(blocks.every((b) => b.length >= 2 && b.length <= MERGE_CHUNK + 1)).toBe(true);
    // 一组字面相似的不拆开。
    const grouped = stableBlocks([[mk(5), mk(9)], [mk(1), mk(2), mk(3)]]);
    expect(grouped.flat().map((l) => l.id)).toEqual([1, 2, 3, 5, 9]);
  });

  it("ignores ids the model made up or from another layer, and keeps one proposal per lesson", async () => {
    const s = build((req) => {
      const xs = ids(req.prompt);
      return { merges: [{ ids: [...xs, 9999], text: "one", why: "" }, { ids: xs, text: "two", why: "" }, { ids: [xs[0]], text: "solo", why: "" }] };
    });
    const a = s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    const b = s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    await s.svc.suggest();
    expect(s.svc.pending().map((p) => [p.ids, p.text])).toEqual([[[a, b], "one"]]);
  });

  it("leaves lessons turned into checks out, and drops a proposal whose lesson was turned into a check meanwhile", async () => {
    const s = build(all());
    const a = s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    const b = s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    const c = s.lesson("re-read the row inside the write transaction before saving it", { status: "confirmed" });
    s.repo.setFields(c, { checkability: "converted" }, 1);
    await s.svc.suggest();
    const [p] = s.svc.pending();
    expect(p.ids).toEqual([a, b]);
    s.repo.setFields(b, { checkability: "converted" }, 2);
    expect(s.svc.pending()).toEqual([]);
    expect(s.svc.accept(p.id)).toEqual({ ok: false, reason: "merge_stale" });
    expect(s.repo.get(a)!.mergedInto).toBeNull();
  });

  it("with a slug, only looks at that repo and its products", async () => {
    const s = build(all());
    s.lesson("re-read the row inside the write transaction before saving", { status: "confirmed" });
    s.lesson("re-read the row inside the write transaction before writing back", { status: "confirmed" });
    await s.svc.suggest("acme/api");
    expect(s.fake.calls).toEqual([]);
  });
});
