import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { LessonBatchService, MAX_TARGET_IDS, verdictOf } from "./lesson-batches";

const src = { prNumber: 1, url: null, slug: "acme/web", runId: null };
const setup = () => {
  const db = memDb();
  const repo = new LessonsRepo(db);
  repo.upsertRepo("acme/web", "/w", 1);
  repo.upsertRepo("acme/api", "/a", 1);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db)]);
  let t = 100;
  const svc = new LessonBatchService({ db, repo, recorder, now: () => ++t });
  const add = (slug = "acme/web", text = "t") => repo.addLesson({ scope: { kind: "repo", slug }, text, why: "w", at: 1, source: src });
  const calibration = () => db.prepare("SELECT lesson_id, entity_id, auto_verdict, human_verdict, batch_id FROM score_calibration ORDER BY id").all() as Record<string, unknown>[];
  return { db, repo, recorder, svc, add, calibration };
};

describe("LessonBatchService.bulk", () => {
  it("confirms hundreds of pending lessons by filter in one batch, and undoes the whole batch", () => {
    const { repo, recorder, svc, add } = setup();
    const web = Array.from({ length: 581 }, (_, i) => add("acme/web", `rule ${i}`));
    const api = add("acme/api");
    const done = add("acme/web");
    repo.setStatus(done, "confirmed", 2);
    const out = svc.bulk("confirm", { filter: { slug: "acme/web", status: ["pending"] } });
    expect(out).toMatchObject({ affected: 581, skipped: 0 });
    expect(recorder.list()).toHaveLength(1);
    for (const id of web) expect(repo.get(id)).toMatchObject({ status: "confirmed", admission: "manual", batchId: out.batchId });
    expect(repo.get(api)?.status).toBe("pending");
    const u = svc.undo(out.batchId!);
    expect(u).toMatchObject({ ok: true, affected: 581, skipped: 0 });
    for (const id of web) expect(repo.get(id)).toMatchObject({ status: "pending", admission: "pending", batchId: null });
    expect(repo.get(done)?.status).toBe("confirmed");
  });

  it("counts lessons already in the target state as skipped", () => {
    const { repo, svc, add } = setup();
    const a = add();
    const b = add();
    repo.setStatus(b, "confirmed", 2);
    expect(svc.bulk("confirm", { ids: [a, b, 999] })).toMatchObject({ affected: 1, skipped: 1 });
    expect(svc.preview("confirm", { ids: [a, b] })).toEqual({ matched: 2, changes: 0 });
  });

  it("rejects, disables, enables and deletes by filter", () => {
    const { repo, svc, add } = setup();
    const a = add();
    const b = add();
    const c = add();
    repo.setStatus(b, "confirmed", 2);
    repo.setStatus(c, "confirmed", 2);
    expect(svc.bulk("disable", { filter: {} })).toMatchObject({ affected: 2, skipped: 1 });
    expect([repo.get(b)?.status, repo.get(c)?.status]).toEqual(["disabled", "disabled"]);
    expect(svc.bulk("enable", { filter: { status: ["disabled"] } })).toMatchObject({ affected: 2 });
    expect(svc.bulk("reject", { filter: { minHits: 1 } })).toMatchObject({ affected: 3 });
    expect(repo.get(a)).toMatchObject({ status: "rejected", admission: "manual" });
    const del = svc.bulk("delete", { filter: { status: ["rejected"] } });
    expect(del.affected).toBe(3);
    expect(repo.lessons()).toEqual([]);
    svc.undo(del.batchId!);
    expect(repo.lessons().map((l) => l.id)).toEqual([a, b, c]);
  });

  it("writes no batch when nothing matches", () => {
    const { recorder, svc } = setup();
    expect(svc.bulk("confirm", { filter: { slug: "acme/none" } })).toEqual({ batchId: null, affected: 0, skipped: 0 });
    expect(recorder.list()).toEqual([]);
  });

  it("never touches merged rows and refuses too many ids", () => {
    const { repo, svc, add } = setup();
    const keep = add();
    const drop = add();
    repo.merge(keep, drop, "x", 2);
    expect(svc.bulk("reject", { ids: [drop] })).toMatchObject({ affected: 0 });
    expect(repo.get(drop)?.status).toBe("pending");
    expect(() => svc.bulk("confirm", { ids: Array.from({ length: MAX_TARGET_IDS + 1 }, (_, i) => i + 1) })).toThrow();
  });
});

describe("LessonBatchService.acceptRecommended", () => {
  it("confirms only pending lessons the pipeline recommended, keeping admission auto", () => {
    const { repo, svc, add, recorder } = setup();
    const rec = add();
    const plain = add();
    const other = add("acme/api");
    repo.setFields(rec, { admission: "auto" }, 2);
    repo.setFields(other, { admission: "auto" }, 2);
    expect(svc.recommendedCount()).toBe(2);
    expect(svc.recommendedCount({ slug: "acme/web" })).toBe(1);
    const out = svc.acceptRecommended({ filter: { slug: "acme/web" } });
    expect(out).toMatchObject({ affected: 1 });
    expect(repo.get(rec)).toMatchObject({ status: "confirmed", admission: "auto" });
    expect(repo.get(plain)?.status).toBe("pending");
    expect(repo.get(other)?.status).toBe("pending");
    expect(recorder.get(out.batchId!)?.kind).toBe("accept_recommended");
    expect(svc.acceptRecommended({ ids: [plain, other] })).toMatchObject({ affected: 1 });
    expect(repo.get(plain)?.status).toBe("pending");
    expect(svc.acceptRecommended()).toMatchObject({ affected: 0, batchId: null });
  });
});

describe("single ops", () => {
  it("keep their checks and are undoable", () => {
    const { repo, svc, add } = setup();
    const a = add();
    expect(svc.setDisabledOne(a, true)).toEqual({ ok: false, reason: "bad_status" });
    const c = svc.confirmOne(a, "edited");
    expect(c).toMatchObject({ ok: true, affected: 1 });
    expect(repo.get(a)).toMatchObject({ status: "confirmed", text: "edited", admission: "manual" });
    expect(svc.confirmOne(a)).toEqual({ ok: false, reason: "bad_status" });
    svc.undo((c as { batchId: number }).batchId);
    expect(repo.get(a)).toMatchObject({ status: "pending", text: "t" });
    expect(svc.confirmOne(999)).toEqual({ ok: false, reason: "not_found" });
  });

  it("treat merged rows as gone, and merge records both rows", () => {
    const { repo, svc, add } = setup();
    const a = add();
    const b = add();
    const c = add();
    expect(svc.mergeOne(b, a, "b+a")).toMatchObject({ ok: true, affected: 2 });
    for (const op of [() => svc.confirmOne(a), () => svc.rejectOne(a), () => svc.editOne(a, "x"), () => svc.deleteOne(a), () => svc.mergeOne(c, a, "x")]) {
      expect(op()).toEqual({ ok: false, reason: "not_found" });
    }
    const m = svc.mergeOne(c, b, "all");
    expect(m).toMatchObject({ ok: true, affected: 3 });
    expect(repo.get(a)?.mergedInto).toBe(c);
    svc.undo((m as { batchId: number }).batchId);
    expect(repo.get(a)?.mergedInto).toBe(b);
    expect(repo.get(b)?.mergedInto).toBeNull();
    expect(repo.get(c)?.text).toBe("t");
  });
});

describe("calibration samples", () => {
  it("are written when a person overrides an automatic verdict", () => {
    const { repo, svc, add, calibration } = setup();
    const auto = add();
    const shelved = add();
    const plain = add();
    repo.setFields(auto, { admission: "auto", score: 0.8 }, 2);
    repo.setFields(shelved, { admission: "shelved", shelvedReason: "generality" }, 2);
    svc.rejectOne(auto);
    svc.confirmOne(shelved);
    svc.confirmOne(plain);
    expect(calibration()).toMatchObject([
      { lesson_id: auto, auto_verdict: "admit", human_verdict: "reject" },
      { lesson_id: shelved, auto_verdict: "shelve", human_verdict: "admit" },
    ]);
    expect(repo.get(shelved)).toMatchObject({ admission: "manual", shelvedReason: null });
  });

  it("are written for each lesson restored by undoing an automatic batch", () => {
    const { repo, svc, add, calibration } = setup();
    const a = add();
    const b = add();
    const out = svc.bulk("confirm", { ids: [a, b] }, { origin: "auto", keepAdmission: true, extra: (_ctx, l) => repo.setFields(l.id, { admission: "auto" }, 3) });
    expect(calibration()).toEqual([]);
    svc.undo(out.batchId!);
    expect(calibration().map((r) => [r.lesson_id, r.auto_verdict, r.human_verdict])).toEqual([[b, "admit", "reject"], [a, "admit", "reject"]]);
  });

  it("verdictOf reads snapshots", () => {
    expect(verdictOf(null)).toBe("reject");
    expect(verdictOf({ status: "pending", admission: "pending" })).toBeNull();
    expect(verdictOf({ status: "pending", admission: "auto" })).toBe("admit");
    expect(verdictOf({ status: "pending", admission: "shelved" })).toBe("shelve");
    expect(verdictOf({ status: "disabled", admission: "manual" })).toBe("reject");
  });
});

/** 单条动作的结果里取批次号（失败就让测试失败）。 */
const bid = (r: { ok: boolean; batchId?: number | null }): number => {
  if (!r.ok || r.batchId == null) throw new Error("no batch");
  return r.batchId;
};

describe("review fixes", () => {
  it("deleting a kept lesson deletes the lessons merged into it, and undo brings both back merged", () => {
    const { db, repo, svc, add } = setup();
    const a = add("acme/web", "a");
    const b = add("acme/web", "b");
    repo.setStatus(a, "confirmed", 2);
    repo.setStatus(b, "confirmed", 2);
    expect(svc.mergeOne(a, b, "a+b")).toMatchObject({ ok: true });
    const d = svc.deleteOne(a);
    expect(d).toMatchObject({ ok: true, affected: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM lessons").get()).toEqual({ n: 0 });
    expect(svc.undo(bid(d))).toMatchObject({ ok: true, affected: 2, skipped: 0 });
    expect(repo.get(a)).toMatchObject({ status: "confirmed", mergedInto: null, text: "a+b" });
    expect(repo.get(b)).toMatchObject({ mergedInto: a });
    expect(repo.lessons().map((l) => l.id)).toEqual([a]);
  });

  it("bulk delete also takes merged rows with it", () => {
    const { repo, svc, add } = setup();
    const a = add("acme/web", "a");
    const b = add("acme/web", "b");
    repo.setStatus(a, "confirmed", 2);
    repo.setStatus(b, "confirmed", 2);
    svc.mergeOne(a, b, "a+b");
    const d = svc.bulk("delete", { filter: { slug: "acme/web" } });
    expect(d).toMatchObject({ affected: 2 });
    expect(repo.get(b)).toBeNull();
    svc.undo(d.batchId!);
    expect(repo.get(b)).toMatchObject({ mergedInto: a });
  });

  it("a merge is undone as a whole or not at all", () => {
    const { db, repo, recorder, svc, add } = setup();
    const a = add("acme/web", "a");
    const b = add("acme/web", "b");
    repo.setStatus(a, "confirmed", 2);
    repo.setStatus(b, "confirmed", 2);
    const m = svc.mergeOne(a, b, "a+b");
    db.prepare("UPDATE lessons SET hits = hits + 1 WHERE id = ?").run(a);
    expect(svc.undo(bid(m))).toEqual({ ok: false, reason: "conflict" });
    expect(repo.get(b)).toMatchObject({ mergedInto: a });
    expect(recorder.get(bid(m))).toMatchObject({ undoable: true, undoneAt: null });
  });

  it("a batch whose rows all changed since stays undoable", () => {
    const { repo, recorder, svc, add } = setup();
    const a = add();
    const out = svc.bulk("confirm", { ids: [a] });
    repo.setText(a, "changed", 999);
    expect(svc.undo(out.batchId!)).toMatchObject({ ok: true, affected: 0, skipped: 1 });
    expect(recorder.get(out.batchId!)).toMatchObject({ undoable: true });
  });

  it("deleting a product is one undoable batch with its lessons and policy layer, and bumps the policy version", () => {
    const db0 = setup();
    const { db, repo, recorder } = db0;
    let bumped = 0;
    let t = 500;
    const svc = new LessonBatchService({ db, repo, recorder, now: () => ++t, onPolicyChanged: () => bumped++ });
    const shop = repo.createProduct("shop", ["acme/web"], 1);
    const l = repo.addLesson({ scope: { kind: "product", productId: shop }, text: "p", why: "w", at: 1, source: src });
    db.prepare("INSERT INTO admission_policies (scope_kind, product_id, overrides, updated_at) VALUES ('product', ?, '{\"shadow.minPrs\":3}', 1)").run(shop);
    const d = svc.deleteProduct(shop);
    expect(d).toMatchObject({ ok: true, affected: 3 });
    expect(bumped).toBe(1);
    expect(repo.product(shop)).toBeNull();
    expect(svc.undo(bid(d))).toMatchObject({ ok: true, affected: 3, skipped: 0 });
    expect(bumped).toBe(2);
    expect(repo.product(shop)).toMatchObject({ name: "shop", slugs: ["acme/web"] });
    expect(repo.get(l)).toMatchObject({ text: "p" });
    expect(db.prepare("SELECT overrides FROM admission_policies WHERE product_id = ?").get(shop)).toEqual({ overrides: '{"shadow.minPrs":3}' });
  });

  it("the filter's maxId leaves out lessons the page has not seen", () => {
    const { svc, add } = setup();
    const a = add();
    const b = add();
    expect(svc.preview("confirm", { filter: { maxId: a } })).toEqual({ matched: 1, changes: 1 });
    expect(svc.bulk("confirm", { filter: { maxId: a } })).toMatchObject({ affected: 1 });
    expect(svc.recommendedTargets()).toEqual([]);
    expect(b).toBeGreaterThan(a);
  });
});
