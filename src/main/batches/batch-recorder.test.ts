import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { withTransaction } from "../db/database";
import { LessonsRepo } from "../db/lessons-repo";
import { BatchRecorder, canonical } from "./batch-recorder";
import { lessonAdapter, policyAdapter, productAdapter } from "./table-adapter";

const src = (n: number) => ({ prNumber: n, url: `https://github.com/acme/web/pull/${n}`, slug: "acme/web", runId: null });
const setup = () => {
  const db = memDb();
  const repo = new LessonsRepo(db);
  repo.upsertRepo("acme/web", "/w", 1);
  const rec = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db)]);
  const add = (text: string) => repo.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text, why: "w", at: 1, source: src(1) });
  const meta = (kind = "confirm") => ({ kind, origin: "manual" as const, entity: "lesson", now: 10 });
  const confirm = (ids: number[], now = 10) =>
    rec.run({ ...meta(), now }, (ctx) => {
      for (const id of ids) {
        ctx.track("lesson", id);
        if (repo.get(id)?.status === "pending") repo.setStatus(id, "confirmed", now);
        else ctx.skip();
      }
    }).outcome;
  return { db, repo, rec, add, meta, confirm };
};

describe("canonical", () => {
  it("sorts keys and drops undefined", () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: undefined }] })).toBe(`{"a":[{"d":2}],"b":1}`);
  });
});

describe("BatchRecorder.run", () => {
  it("counts only rows that changed, stamps them, and records before / after", () => {
    const { repo, rec, add, confirm } = setup();
    const a = add("a");
    const b = add("b");
    repo.setStatus(b, "confirmed", 2);
    const out = confirm([a, b]);
    expect(out).toMatchObject({ affected: 1, skipped: 1 });
    expect(out.batchId).not.toBeNull();
    expect(repo.get(a)).toMatchObject({ status: "confirmed", batchId: out.batchId });
    expect(repo.get(b)?.batchId).toBeNull();
    const d = rec.get(out.batchId!)!;
    expect(d).toMatchObject({ kind: "confirm", origin: "manual", affected: 1, undoable: true, undoneAt: null });
    expect(d.items).toEqual([{ entity: "lesson", entityId: a, label: "a", before: "pending", after: "confirmed" }]);
  });

  it("writes no batch when nothing changed, ignoring volatile fields", () => {
    const { db, repo, rec, add, meta } = setup();
    const a = add("a");
    const out = rec.run(meta(), (ctx) => {
      ctx.track("lesson", a);
      db.prepare("UPDATE lessons SET updated_at = 999 WHERE id = ?").run(a);
    }).outcome;
    expect(out).toEqual({ batchId: null, affected: 0, skipped: 0 });
    expect(rec.list()).toEqual([]);
    expect(repo.get(a)?.batchId).toBeNull();
  });

  it("rolls the whole batch back when mutate throws", () => {
    const { repo, rec, add, meta } = setup();
    const a = add("a");
    expect(() =>
      rec.run(meta(), (ctx) => {
        ctx.track("lesson", a);
        repo.setStatus(a, "confirmed", 3);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(repo.get(a)?.status).toBe("pending");
    expect(rec.list()).toEqual([]);
  });

  it("nests inside an outer transaction", () => {
    const { db, repo, add, confirm } = setup();
    const a = add("a");
    expect(() =>
      withTransaction(db, () => {
        confirm([a]);
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(repo.get(a)?.status).toBe("pending");
    expect((db.prepare("SELECT COUNT(*) AS n FROM admission_batches").get() as { n: number }).n).toBe(0);
  });
});

describe("BatchRecorder.undo", () => {
  it("restores the batch, records an undo batch, and refuses twice", () => {
    const { repo, rec, add, confirm } = setup();
    const ids = [add("a"), add("b"), add("c")];
    const out = confirm(ids);
    expect(out.affected).toBe(3);
    const u = rec.undo(out.batchId!, 20);
    expect(u).toMatchObject({ ok: true, outcome: { affected: 3, skipped: 0 } });
    for (const id of ids) expect(repo.get(id)).toMatchObject({ status: "pending", batchId: null });
    const list = rec.list();
    expect(list.map((b) => [b.kind, b.undoable, b.undoOf])).toEqual([["undo", false, out.batchId], ["confirm", false, null]]);
    expect(list[1].undoneAt).toBe(20);
    expect(rec.undo(out.batchId!, 21)).toEqual({ ok: false, reason: "not_undoable" });
    expect(rec.undo(list[0].id, 21)).toEqual({ ok: false, reason: "not_undoable" });
    expect(rec.undo(999, 21)).toEqual({ ok: false, reason: "not_found" });
  });

  it("skips rows changed since the batch, never overwriting them", () => {
    const { repo, rec, add, confirm } = setup();
    const a = add("a");
    const b = add("b");
    const out = confirm([a, b]);
    repo.setStatus(b, "disabled", 15);
    const u = rec.undo(out.batchId!, 20);
    expect(u).toMatchObject({ ok: true, outcome: { affected: 1, skipped: 1 } });
    expect(repo.get(a)?.status).toBe("pending");
    expect(repo.get(b)?.status).toBe("disabled");
  });

  it("re-inserts deleted rows with their id and sources, and deletes created ones", () => {
    const { repo, rec, add, meta } = setup();
    const a = add("a");
    repo.hit(a, 5, src(2));
    const del = rec.run(meta("delete"), (ctx) => {
      ctx.track("lesson", a);
      repo.remove(a);
    }).outcome;
    expect(repo.get(a)).toBeNull();
    rec.undo(del.batchId!, 20);
    const back = repo.get(a)!;
    expect(back).toMatchObject({ text: "a", hits: 2, status: "pending" });
    expect(back.sources.map((s) => s.prNumber)).toEqual([1, 2]);

    let created = 0;
    const ins = rec.run(meta("import"), (ctx) => {
      created = repo.addLesson({ scope: { kind: "repo", slug: "acme/web" }, text: "new", why: "w", at: 30, source: src(3) });
      ctx.created("lesson", created);
    }).outcome;
    expect(ins.affected).toBe(1);
    rec.undo(ins.batchId!, 40);
    expect(repo.get(created)).toBeNull();
  });

  it("undoes a merge: the dropped row comes back and the kept one gets its text, hits and sources back", () => {
    const { repo, rec, add, meta } = setup();
    const keep = add("keep");
    const drop = add("drop");
    repo.hit(drop, 5, src(4));
    const m = rec.run(meta("merge"), (ctx) => {
      ctx.track("lesson", keep);
      ctx.track("lesson", drop);
      repo.merge(keep, drop, "merged", 6);
    }).outcome;
    expect(repo.lessons().map((l) => l.id)).toEqual([keep]);
    rec.undo(m.batchId!, 7);
    expect(repo.get(keep)).toMatchObject({ text: "keep", hits: 1 });
    expect(repo.get(keep)!.sources.map((s) => s.prNumber)).toEqual([1]);
    expect(repo.get(drop)).toMatchObject({ text: "drop", hits: 2, mergedInto: null });
  });

  it("undoes product and lesson creation in reverse order", () => {
    const { repo, rec, meta } = setup();
    let pid = 0;
    let lid = 0;
    const out = rec.run({ ...meta("import"), entity: "mixed" }, (ctx) => {
      pid = repo.createProduct("shop", ["acme/web"], 1);
      ctx.created("product", pid);
      lid = repo.addLesson({ scope: { kind: "product", productId: pid }, text: "p", why: "w", at: 1, source: src(5) });
      ctx.created("lesson", lid);
    }).outcome;
    expect(out.affected).toBe(2);
    const u = rec.undo(out.batchId!, 2);
    expect(u).toMatchObject({ ok: true, outcome: { affected: 2, skipped: 0 } });
    expect(repo.product(pid)).toBeNull();
    expect(repo.get(lid)).toBeNull();
  });

  it("restores a product's repo list", () => {
    const { repo, rec, meta } = setup();
    repo.upsertRepo("acme/api", "/a", 1);
    const pid = repo.createProduct("shop", ["acme/web"], 1);
    const out = rec.run({ ...meta("import"), entity: "product" }, (ctx) => {
      ctx.track("product", pid);
      repo.addToProduct(pid, "acme/api");
    }).outcome;
    expect(rec.get(out.batchId!)!.items[0]).toMatchObject({ label: "shop", before: "1 repos", after: "2 repos" });
    rec.undo(out.batchId!, 2);
    expect(repo.product(pid)?.slugs).toEqual(["acme/web"]);
  });

  it("lists newest first with a limit and a cursor", () => {
    const { rec, add, confirm } = setup();
    const ids = [add("a"), add("b"), add("c")];
    const batches = ids.map((id, i) => confirm([id], 10 + i).batchId!);
    expect(rec.list({ limit: 2 }).map((b) => b.id)).toEqual([batches[2], batches[1]]);
    expect(rec.list({ beforeId: batches[1] }).map((b) => b.id)).toEqual([batches[0]]);
    expect(rec.itemIds(batches[0], "lesson")).toEqual([ids[0]]);
  });
});
