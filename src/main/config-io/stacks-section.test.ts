import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memDb, tempDir } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter, stackPolicyAdapter } from "../batches/table-adapter";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { StackPolicyService } from "../stacks/stack-policy";
import { ConfigIoService, defaultRegistry } from ".";

function home() {
  const db = memDb();
  const repo = new LessonsRepo(db);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db), stackPolicyAdapter(db)]);
  let t = 1_700_000_000_000;
  const now = () => (t += 10);
  let version = 1;
  const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => version, set: (v) => (version = v) }, now });
  const io = new ConfigIoService({ db, repo, policies, recorder, registry: defaultRegistry(), shipherdVersion: "3.0.0", backupDir: join(tempDir(), "b"), now });
  const stacks = new StackPolicyService({ db, productsOf: (slug) => repo.products().filter((p) => p.slugs.includes(slug)).map((p) => ({ id: p.id, name: p.name })), productName: (id) => repo.products().find((p) => p.id === id)?.name ?? null, now });
  return { db, repo, recorder, io, stacks };
}

const all = { scope: { kind: "all" as const }, options: { content: "all" as const, includeSourceUrls: false } };

describe("config-io stacks section", () => {
  it("round-trips the three layers with products by name, only in 'everything'", async () => {
    const a = home();
    a.repo.upsertRepo("acme/web", "/w", 1);
    const shop = a.repo.createProduct("shop", ["acme/web"], 1);
    a.stacks.setLayer({ kind: "global" }, { behindCommits: 30, mergeMethod: "squash" });
    a.stacks.setLayer({ kind: "product", productId: shop }, { draftLabel: "stack" });
    a.stacks.setLayer({ kind: "repo", slug: "acme/web" }, { dailyRebase: false });
    const doc = a.io.exportDoc(all)!;
    expect(doc.sections.stacks).toEqual([
      { scope: { kind: "global" }, overrides: { behindCommits: 30, mergeMethod: "squash" } },
      { scope: { kind: "product", name: "shop" }, overrides: { draftLabel: "stack" } },
      { scope: { kind: "repo", slug: "acme/web" }, overrides: { dailyRebase: false } },
    ]);
    expect(a.io.exportDoc({ ...all, options: { content: "lessons", includeSourceUrls: false } })!.sections.stacks).toBeUndefined();

    const b = home();
    b.repo.upsertRepo("acme/web", "/w", 1);
    b.repo.createProduct("shop", ["acme/web"], 1);
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    const rows = pr.preview.sections.find((s) => s.id === "stacks")!.rows;
    expect(rows.map((r) => r.status)).toEqual(["added", "added", "added"]);
    const r = b.io.apply({ token: pr.preview.token, mode: "merge" });
    expect(r.ok).toBe(true);
    expect(b.stacks.forSlug("acme/web")).toMatchObject({ behindCommits: 30, mergeMethod: "squash", draftLabel: "stack", dailyRebase: false });
  });

  it("never turns on autoRebase without a choice and can be undone", async () => {
    const a = home();
    a.stacks.setLayer({ kind: "global" }, { autoRebase: true });
    const doc = a.io.exportDoc(all)!;
    const b = home();
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    const row = pr.preview.sections.find((s) => s.id === "stacks")!.rows[0]!;
    expect(row).toMatchObject({ status: "conflicting", reasons: ["autoRebase"] });
    const kept = b.io.apply({ token: pr.preview.token, mode: "merge" });
    expect(kept.ok).toBe(true);
    expect(b.stacks.forSlug(null).autoRebase).toBe(false);

    const pr2 = await b.io.previewText(JSON.stringify(doc));
    if (!pr2.ok) throw new Error("preview");
    const res = b.io.apply({ token: pr2.preview.token, mode: "merge", resolutions: { [`stacks:${row.fingerprint}`]: "imported" as const } });
    expect(b.stacks.forSlug(null).autoRebase).toBe(true);
    if (!res.ok || res.batchId === null) throw new Error("apply");
    b.recorder.undo(res.batchId, 99);
    expect(b.stacks.forSlug(null).autoRebase).toBe(false);
  });

  it("rejects bad values in the file", async () => {
    const a = home();
    const doc = a.io.exportDoc(all)!;
    doc.sections.stacks = [{ scope: { kind: "global" }, overrides: { draftDemoteDays: 0 } }];
    const pr = await a.io.previewText(JSON.stringify(doc));
    expect(pr.ok).toBe(false);
  });
});
