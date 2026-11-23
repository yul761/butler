import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { ChecksRepo } from "../db/checks-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { ConfigIoService, defaultRegistry } from ".";
import { checkFingerprint } from "./checks-section";
import type { CheckInput } from "../../shared/checks";
import { tempDir } from "../test-utils";
import { join } from "node:path";

function home() {
  const db = memDb();
  const repo = new LessonsRepo(db);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  let t = 1000;
  const now = () => (t += 10);
  let version = 1;
  const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => version, set: (v) => (version = v) }, now });
  let applied = 0;
  const io = new ConfigIoService({ db, repo, policies, recorder, registry: defaultRegistry(), shipherdVersion: "3.0.0", backupDir: join(tempDir(), "b"), now, onApplied: () => applied++ });
  return { db, repo, recorder, io, checks: new ChecksRepo(db), applied: () => applied };
}

const fp = (pattern: string, over: Partial<CheckInput> = {}): CheckInput => ({
  type: "forbidden_pattern", name: "no foo", params: { pattern }, globs: ["src/**"], excludeGlobs: [], severity: "block", mode: "enforce", enabled: true, message: "fix it", ...over,
});

const checksOnly = { scope: { kind: "all" as const }, options: { content: "checks" as const, includeSourceUrls: false } };

describe("config-io checks section (addendum 9)", () => {
  it("exports checks with product names, imports them into shadow mode stamped with the batch", async () => {
    const a = home();
    a.repo.upsertRepo("acme/web", "/w", 1);
    const shop = a.repo.createProduct("shop", ["acme/web"], 1);
    a.checks.insert({ kind: "product", productId: shop }, "ck_a", fp("a"), { now: 1 });
    a.checks.insert({ kind: "repo", slug: "acme/web" }, "ck_b", fp("b", { type: "run_command", params: { command: "pnpm lint", stage: "push" } }), { now: 1 });
    const doc = a.io.exportDoc(checksOnly)!;
    const items = doc.sections.checks as { key: string; scope: unknown }[];
    expect(items.map((i) => [i.key, i.scope])).toEqual([
      ["builtin:comment_policy", { kind: "global" }],
      ["ck_a", { kind: "product", name: "shop" }],
      ["ck_b", { kind: "repo", slug: "acme/web" }],
    ]);
    const b = home();
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    const rows = pr.preview.sections.find((s) => s.id === "checks")!.rows;
    expect(rows.map((r) => r.status)).toEqual(["unchanged", "added", "added"]);
    const r = b.io.apply({ token: pr.preview.token, mode: "merge" });
    if (!r.ok) throw new Error("apply");
    expect(r.sections.checks).toMatchObject({ added: 2, kept: 1 });
    const shopB = b.repo.products().find((p) => p.name === "shop")!.id;
    const got = b.checks.byKey({ kind: "product", productId: shopB }, "ck_a")!;
    expect(got).toMatchObject({ mode: "shadow", batchId: r.batchId, params: { pattern: "a" } });
    // 导入的命令检查要先看过再打开：试运行也会执行命令。预览里看得到命令。
    expect(b.checks.byKey({ kind: "repo", slug: "acme/web" }, "ck_b")).toMatchObject({ mode: "shadow", type: "run_command", enabled: false });
    expect(rows[2].label).toContain("pnpm lint");
    expect(b.applied()).toBe(1);
  });

  it("only cosmetic changes keep the local mode; behaviour changes are conflicts and go back to shadow", async () => {
    const a = home();
    a.checks.insert({ kind: "global" }, "ck_x", fp("x"), { now: 1 });
    a.checks.insert({ kind: "global" }, "ck_y", fp("y"), { now: 1 });
    const b = home();
    b.checks.insert({ kind: "global" }, "ck_x", fp("x", { name: "renamed" }), { now: 1 });
    b.checks.insert({ kind: "global" }, "ck_y", fp("other"), { now: 1 });
    const pr = await b.io.previewText(JSON.stringify(a.io.exportDoc(checksOnly)));
    if (!pr.ok) throw new Error("preview");
    const rows = pr.preview.sections.find((s) => s.id === "checks")!.rows;
    const byFp = (k: string) => rows.find((r) => r.fingerprint === checkFingerprint(k, { kind: "global" }))!;
    expect(byFp("ck_x")).toMatchObject({ status: "changed", reasons: [] });
    expect(byFp("ck_y")).toMatchObject({ status: "conflicting", reasons: ["params"] });
    b.io.apply({ token: pr.preview.token, mode: "merge", bulk: "imported" });
    expect(b.checks.byKey({ kind: "global" }, "ck_x")).toMatchObject({ name: "no foo", mode: "enforce" });
    expect(b.checks.byKey({ kind: "global" }, "ck_y")).toMatchObject({ params: { pattern: "y" }, mode: "shadow" });
  });

  it("replace removes checks missing from the file but never the builtin, and undo restores them", async () => {
    const a = home();
    const b = home();
    const id = b.checks.insert({ kind: "repo", slug: "acme/web" }, "ck_local", fp("l"), { now: 1 });
    const pr = await b.io.previewText(JSON.stringify(a.io.exportDoc(checksOnly)));
    if (!pr.ok) throw new Error("preview");
    expect(pr.preview.sections.find((s) => s.id === "checks")!.rows.find((r) => r.status === "removed")?.localId).toBe(id);
    const r = b.io.apply({ token: pr.preview.token, mode: "replace" });
    if (!r.ok) throw new Error("apply");
    expect(b.checks.get(id)).toBeNull();
    expect(b.checks.byKey({ kind: "global" }, "builtin:comment_policy")).not.toBeNull();
    b.recorder.undo(r.batchId!, 99_999);
    expect(b.checks.get(id)?.key).toBe("ck_local");
  });

  it("rejects items that do not validate", async () => {
    const a = home();
    const doc = a.io.exportDoc(checksOnly)!;
    const bad = { ...doc, sections: { checks: [{ ...(doc.sections.checks as object[])[0], type: "forbidden_pattern", params: { pattern: "(" } }] } };
    expect(await home().io.previewText(JSON.stringify(bad))).toMatchObject({ ok: false, reason: "bad_section", section: "checks" });
  });

  it("a run_command whose command changed is switched off; one with the same command keeps enabled", async () => {
    const a = home();
    a.checks.insert({ kind: "global" }, "ck_cmd", fp("", { type: "run_command", params: { command: "pnpm lint", stage: "edit" } }), { now: 1 });
    a.checks.insert({ kind: "global" }, "ck_same", fp("", { type: "run_command", params: { command: "pnpm test", stage: "push" } }), { now: 1 });
    const doc = a.io.exportDoc(checksOnly)!;
    const b = home();
    b.checks.insert({ kind: "global" }, "ck_cmd", fp("", { type: "run_command", params: { command: "pnpm format", stage: "edit" } }), { now: 1 });
    b.checks.insert({ kind: "global" }, "ck_same", fp("", { type: "run_command", params: { command: "pnpm test", stage: "push" }, globs: ["other/**"] }), { now: 1 });
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    const r = b.io.apply({ token: pr.preview.token, mode: "merge", bulk: "imported" });
    if (!r.ok) throw new Error("apply");
    expect(b.checks.byKey({ kind: "global" }, "ck_cmd")).toMatchObject({ params: { command: "pnpm lint" }, enabled: false, mode: "shadow" });
    expect(b.checks.byKey({ kind: "global" }, "ck_same")).toMatchObject({ globs: ["src/**"], enabled: true, mode: "shadow" });
  });

  it("a checks-only file in replace mode never removes local products (and their lessons)", async () => {
    const a = home();
    const doc = a.io.exportDoc(checksOnly)!;
    const b = home();
    b.repo.upsertRepo("acme/web", "/w", 1);
    b.repo.createProduct("local-only", ["acme/web"], 1);
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    expect(pr.preview.sections.find((s) => s.id === "products")?.rows.filter((r) => r.status === "removed") ?? []).toEqual([]);
    const r = b.io.apply({ token: pr.preview.token, mode: "replace" });
    if (!r.ok) throw new Error("apply");
    expect(b.repo.products().map((p) => p.name)).toEqual(["local-only"]);
  });
});
