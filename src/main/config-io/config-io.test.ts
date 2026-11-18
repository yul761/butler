import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { ConfigIoService, defaultRegistry } from ".";
import { CONFIG_FORMAT, ConfigFormatError, migrateDoc, parseDoc } from "./format";
import { lessonFingerprint, normText, policyFingerprint, productFingerprint } from "./fingerprint";
import type { ImportPreview } from "../../shared/config-io";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "butler-cfg-"));
  dirs.push(d);
  return d;
};

/** 一个独立的「BUTLER_HOME」：自己的数据库和备份目录。 */
function home(opts: { backupDir?: string } = {}) {
  const db = memDb();
  const repo = new LessonsRepo(db);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db)]);
  let version = 1;
  let t = 1_000;
  const now = () => (t += 10);
  const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => version, set: (v) => (version = v) }, now });
  const backupDir = opts.backupDir ?? join(tmp(), "backups");
  let exportedAt: number | null = null;
  const io = new ConfigIoService({ db, repo, policies, recorder, registry: defaultRegistry(), butlerVersion: "3.0.0", backupDir, now, onExported: (at) => (exportedAt = at) });
  const lesson = (slug: string | { productId: number }, text: string, status: "pending" | "confirmed" | "rejected" | "disabled" = "confirmed", url: string | null = null) => {
    const scope = typeof slug === "string" ? { kind: "repo" as const, slug } : { kind: "product" as const, productId: slug.productId };
    const id = repo.addLesson({ scope, text, why: "because", at: 5, source: { prNumber: 7, url, slug: typeof slug === "string" ? slug : "acme/web", runId: null } });
    repo.setStatus(id, status, 6);
    return id;
  };
  return { db, repo, recorder, policies, io, backupDir, lesson, version: () => version, exportedAt: () => exportedAt, advance: (ms: number) => (t += ms) };
}

const counts = (p: ImportPreview, id: string) => p.sections.find((s) => s.id === id)!.counts;
const rows = (p: ImportPreview, id: string) => p.sections.find((s) => s.id === id)!.rows;
const all = { scope: { kind: "all" as const }, options: { content: "all" as const, includeSourceUrls: false } };

function seed() {
  const a = home();
  a.repo.upsertRepo("acme/web", "/Users/someone/code/web", 1);
  a.repo.upsertRepo("acme/api", "C:\\code\\api", 1);
  const shop = a.repo.createProduct("shop", ["acme/web", "acme/api"], 1);
  a.lesson("acme/web", "Always validate input", "confirmed", "https://github.com/acme/web/pull/7#discussion_r1");
  a.lesson("acme/web", "Never log tokens", "pending");
  a.lesson("acme/api", "Prefer small PRs", "rejected");
  a.lesson({ productId: shop }, "Keep docs in sync", "confirmed");
  a.policies.setLayer({ kind: "global" }, { "score.admitLine": 0.75 });
  a.policies.setLayer({ kind: "product", productId: shop }, { "shadow.minPrs": 8 });
  return { a, shop };
}

describe("format", () => {
  const doc = (v: number) => ({ format: CONFIG_FORMAT, formatVersion: v, exportedAt: 1, butlerVersion: "x", scope: { kind: "all" }, options: { content: "all", includeSourceUrls: false }, sections: {} });

  it("refuses files from a newer Butler, non-JSON and non-Butler files", () => {
    expect(() => parseDoc(JSON.stringify(doc(2)))).toThrow(expect.objectContaining({ reason: "too_new" }) as Error);
    expect(() => parseDoc("{nope")).toThrow(expect.objectContaining({ reason: "not_json" }) as Error);
    expect(() => parseDoc(JSON.stringify({ format: "other" }))).toThrow(expect.objectContaining({ reason: "not_butler" }) as Error);
    expect(() => parseDoc(JSON.stringify({ ...doc(1), scope: { kind: "moon" } }))).toThrow(ConfigFormatError);
    expect(parseDoc(`\uFEFF${JSON.stringify(doc(1))}`).formatVersion).toBe(1);
  });

  it("migrates older versions step by step", () => {
    const migrations = { 1: (d: Record<string, unknown>) => ({ ...d, sections: { ...(d.sections as object), legacy: [] } }), 2: (d: Record<string, unknown>) => ({ ...d, upgraded: true }) };
    const out = migrateDoc(doc(1), migrations, 3);
    expect(out).toMatchObject({ formatVersion: 3, upgraded: true, sections: { legacy: [] } });
    expect(() => migrateDoc(doc(1), {}, 2)).toThrow(ConfigFormatError);
  });
});

describe("fingerprint", () => {
  it("is stable across machines: ignores ids, spacing, case and glob order", () => {
    expect(normText("  Always   Validate\tinput ")).toBe("always validate input");
    const a = lessonFingerprint("Always validate input", { repo: "acme/web" }, ["src/**", "lib/**"]);
    expect(lessonFingerprint(" always  VALIDATE input", { repo: "acme/web" }, ["lib/**", "src/**"])).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(lessonFingerprint("Always validate input", { repo: "acme/api" }, [])).not.toBe(lessonFingerprint("Always validate input", { repo: "acme/web" }, []));
    expect(lessonFingerprint("x", { product: "acme/web" }, [])).not.toBe(lessonFingerprint("x", { repo: "acme/web" }, []));
    expect(productFingerprint("shop")).not.toBe(policyFingerprint({ kind: "product", name: "shop" }));
  });
});

describe("export", () => {
  it("carries no local paths, comment text, scores or source urls by default", () => {
    const { a } = seed();
    const doc = a.io.exportDoc(all)!;
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/Users|code\\\\api|discussion_r1|https:/);
    expect(text).not.toMatch(/"score"|"localPath"|"local_path"/);
    expect(doc.sections.products).toEqual([{ name: "shop", repos: ["acme/api", "acme/web"] }]);
    expect(doc.sections.lessons).toHaveLength(4);
    expect(doc.sections.lessons![0]).toMatchObject({ owner: { repo: "acme/web" }, status: "confirmed", sourceCount: 1, prCount: 1 });
    expect(doc.sections.lessons![0]).not.toHaveProperty("sources");
    expect(doc.sections.policies).toEqual([
      { layer: { kind: "global" }, overrides: { "score.admitLine": 0.75 } },
      { layer: { kind: "product", name: "shop" }, overrides: { "shadow.minPrs": 8 } },
    ]);
  });

  it("includes source urls only when asked", () => {
    const { a } = seed();
    const doc = a.io.exportDoc({ ...all, options: { content: "all", includeSourceUrls: true } })!;
    expect((doc.sections.lessons![0] as { sources: unknown[] }).sources).toEqual([{ prNumber: 7, url: "https://github.com/acme/web/pull/7#discussion_r1", repo: "acme/web", at: 5 }]);
  });

  it("scopes to one product, one repo, lessons only, checks only", () => {
    const { a, shop } = seed();
    a.repo.upsertRepo("other/x", "", 1);
    a.lesson("other/x", "Unrelated");
    const prod = a.io.exportDoc({ scope: { kind: "product", productId: shop }, options: { content: "all", includeSourceUrls: false } })!;
    expect(prod.scope).toEqual({ kind: "product", name: "shop" });
    expect((prod.sections.lessons as { text: string }[]).map((l) => l.text).sort()).toEqual(["Always validate input", "Keep docs in sync", "Never log tokens", "Prefer small PRs"]);
    const repo = a.io.exportDoc({ scope: { kind: "repo", slug: "acme/web" }, options: { content: "all", includeSourceUrls: false } })!;
    expect(repo.sections.lessons).toHaveLength(2);
    expect(repo.sections.products).toEqual([]);
    expect(repo.sections.policies).toEqual([]);
    const lessonsOnly = a.io.exportDoc({ ...all, options: { content: "lessons", includeSourceUrls: false } })!;
    expect(Object.keys(lessonsOnly.sections).sort()).toEqual(["lessons", "products"]);
    expect(a.io.writeExport({ ...all, options: { content: "checks", includeSourceUrls: false } }, join(tmp(), "c.json"))).toEqual({ ok: false, reason: "no_checks" });
    expect(a.io.exportDoc({ scope: { kind: "product", productId: 999 }, options: all.options })).toBeNull();
  });

  it("writes the file and records the export time", () => {
    const { a } = seed();
    const f = join(tmp(), "out.json");
    expect(a.io.writeExport(all, f)).toMatchObject({ ok: true, counts: { products: 1, lessons: 4, policies: 2 } });
    expect(JSON.parse(readFileSync(f, "utf8"))).toMatchObject({ format: CONFIG_FORMAT, formatVersion: 1, butlerVersion: "3.0.0" });
    expect(a.exportedAt()).not.toBeNull();
  });
});

describe("import into another BUTLER_HOME", () => {
  it("previews, applies as one pending undoable batch, and undoes", async () => {
    const { a } = seed();
    const text = JSON.stringify(a.io.exportDoc(all));
    const b = home();
    b.repo.upsertRepo("acme/web", "/elsewhere/web", 1);
    b.lesson("acme/web", "always  validate INPUT", "pending");
    b.lesson("acme/web", "Local only rule", "confirmed");

    const pr = await b.io.previewText(text);
    expect(pr.ok).toBe(true);
    if (!pr.ok) return;
    const p = pr.preview;
    expect(counts(p, "products")).toMatchObject({ added: 1 });
    expect(counts(p, "lessons")).toMatchObject({ added: 3, conflicting: 1, removed: 1 });
    const conflict = rows(p, "lessons").find((r) => r.status === "conflicting")!;
    expect(conflict.reasons).toEqual(["status"]);
    expect(conflict.diffs[0]).toEqual({ field: "status", local: "pending", incoming: "confirmed" });
    expect(counts(p, "policies")).toMatchObject({ added: 2 });

    const res = b.io.apply({ token: p.token, mode: "merge" });
    expect(res).toMatchObject({ ok: true, backupFile: null, sections: { lessons: { added: 3, kept: 1, removed: 0 }, products: { added: 1 }, policies: { added: 2 } } });
    if (!res.ok) return;
    const imported = b.repo.lessons().filter((l) => l.batchId === res.batchId);
    expect(imported.map((l) => [l.text, l.status, l.admission]).sort()).toEqual([
      ["Keep docs in sync", "pending", "pending"], ["Never log tokens", "pending", "pending"], ["Prefer small PRs", "rejected", "manual"],
    ]);
    // 合并：冲突默认留本地；文件没有的本地规矩不动。
    expect(b.repo.lessons().find((l) => l.text === "always  validate INPUT")!.status).toBe("pending");
    expect(b.repo.lessons().some((l) => l.text === "Local only rule")).toBe(true);
    // 这台机器没有的仓库：建一行，本地路径为空。
    expect(b.repo.repo("acme/api")).toMatchObject({ localPath: "" });
    expect(b.repo.repo("acme/web")!.localPath).toBe("/elsewhere/web");
    const shop = b.repo.products().find((x) => x.name === "shop")!;
    expect(b.policies.overrides({ kind: "product", productId: shop.id })).toEqual({ "shadow.minPrs": 8 });
    expect(b.version()).toBe(2);
    expect(b.recorder.get(res.batchId!)).toMatchObject({ kind: "import", origin: "import", summary: { sections: { lessons: { added: 3 } } } });

    expect(b.recorder.undo(res.batchId!, 99_999)).toMatchObject({ ok: true });
    expect(b.repo.lessons().map((l) => l.text).sort()).toEqual(["Local only rule", "always  validate INPUT"]);
    expect(b.repo.products()).toEqual([]);
    expect(b.policies.allLayers()).toEqual([]);
  });

  it("per-row and bulk resolutions pick imported or local", async () => {
    const { a } = seed();
    const text = JSON.stringify(a.io.exportDoc(all));
    const b = home();
    b.repo.upsertRepo("acme/web", "", 1);
    b.lesson("acme/web", "Always validate input", "pending");
    b.lesson("acme/web", "Never log tokens", "confirmed");
    b.policies.setLayer({ kind: "global" }, { "score.admitLine": 0.6, "shadow.minDays": 3 });

    let pr = await b.io.previewText(text);
    if (!pr.ok) throw new Error("preview");
    const conf = rows(pr.preview, "lessons").filter((r) => r.status === "conflicting");
    expect(conf).toHaveLength(2);
    expect(rows(pr.preview, "policies").find((r) => r.label === "global")).toMatchObject({ status: "conflicting", reasons: ["score.admitLine"] });
    const one = conf.find((r) => r.label === "Never log tokens")!;
    // 全部用导入的，但「Never log tokens」这行单独留本地。
    const res = b.io.apply({ token: pr.preview.token, mode: "merge", bulk: "imported", resolutions: { [`lessons:${one.fingerprint}`]: "local" } });
    expect(res.ok).toBe(true);
    const byText = (t: string) => b.repo.lessons().find((l) => l.text === t)!;
    expect(byText("Always validate input")).toMatchObject({ status: "confirmed", admission: "manual" });
    expect(byText("Never log tokens").status).toBe("confirmed");
    // 合并模式：本地的键留着，文件里的覆盖上去。
    expect(b.policies.overrides({ kind: "global" })).toEqual({ "score.admitLine": 0.75, "shadow.minDays": 3 });

    pr = await b.io.previewText(text);
    if (!pr.ok) throw new Error("preview");
    expect(rows(pr.preview, "lessons").find((r) => r.label === "Always validate input")!.status).toBe("unchanged");
  });

  it("replace writes a backup first, defaults to imported and removes local items the file lacks", async () => {
    const { a } = seed();
    const text = JSON.stringify(a.io.exportDoc(all));
    const b = home();
    b.repo.upsertRepo("acme/web", "", 1);
    b.lesson("acme/web", "Always validate input", "pending");
    const gone = b.lesson("acme/web", "Local only rule", "confirmed");
    const old = b.repo.createProduct("legacy", ["acme/web"], 1);
    b.lesson({ productId: old }, "Legacy rule");
    b.policies.setLayer({ kind: "global" }, { "shadow.minDays": 3 });

    const pr = await b.io.previewText(text);
    if (!pr.ok) throw new Error("preview");
    expect(counts(pr.preview, "products")).toMatchObject({ added: 1, removed: 1 });
    const res = b.io.apply({ token: pr.preview.token, mode: "replace" });
    if (!res.ok) throw new Error(res.reason);
    expect(res.backupFile).toMatch(/before-replace-.+\.json$/);
    const backup = JSON.parse(readFileSync(res.backupFile!, "utf8")) as { sections: { lessons: { text: string }[] } };
    expect(backup.sections.lessons.map((l) => l.text).sort()).toEqual(["Always validate input", "Legacy rule", "Local only rule"]);
    expect(res.sections.lessons).toMatchObject({ added: 3, updated: 1, removed: 2 });
    expect(b.repo.lessons({ ids: [gone] })).toEqual([]);
    expect(b.repo.products().map((p) => p.name)).toEqual(["shop"]);
    expect(b.repo.lessons().find((l) => l.text === "Always validate input")!.status).toBe("confirmed");
    expect(b.policies.overrides({ kind: "global" })).toEqual({ "score.admitLine": 0.75 });
    expect(b.recorder.get(res.batchId!)!.kind).toBe("replace");

    // 撤销替换：删掉的产品、它的规矩和本地规矩都回来。
    expect(b.recorder.undo(res.batchId!, 99_999)).toMatchObject({ ok: true });
    expect(b.repo.products().map((p) => p.name)).toEqual(["legacy"]);
    expect(b.repo.lessons().map((l) => l.text).sort()).toEqual(["Always validate input", "Legacy rule", "Local only rule"]);
    expect(b.repo.lessons().find((l) => l.text === "Always validate input")!.status).toBe("pending");
    expect(b.policies.overrides({ kind: "global" })).toEqual({ "shadow.minDays": 3 });
  });

  it("aborts replace when the backup cannot be written", async () => {
    const { a } = seed();
    const d = tmp();
    const blocker = join(d, "file");
    writeFileSync(blocker, "x");
    const b = home({ backupDir: join(blocker, "backups") });
    b.repo.upsertRepo("acme/web", "", 1);
    b.lesson("acme/web", "Local only rule");
    const pr = await b.io.previewText(JSON.stringify(a.io.exportDoc(all)));
    if (!pr.ok) throw new Error("preview");
    expect(b.io.apply({ token: pr.preview.token, mode: "replace" })).toEqual({ ok: false, reason: "backup_failed" });
    expect(b.repo.lessons().map((l) => l.text)).toEqual(["Local only rule"]);
  });

  it("skips unknown sections, rejects bad items, and expires tokens", async () => {
    const { a } = seed();
    const doc = a.io.exportDoc(all)!;
    const b = home();
    const pr = await b.io.previewText(JSON.stringify({ ...doc, sections: { ...doc.sections, checks: [{ x: 1 }], models: [] } }));
    if (!pr.ok) throw new Error("preview");
    expect(pr.preview.skippedSections.sort()).toEqual(["checks", "models"]);
    expect(await b.io.previewText(JSON.stringify({ ...doc, sections: { lessons: [{ text: "" }] } }))).toEqual({ ok: false, reason: "bad_section", section: "lessons" });
    expect(await b.io.previewText(JSON.stringify({ ...doc, sections: { policies: [{ layer: { kind: "global" }, overrides: { "score.admitLine": 7 } }] } }))).toMatchObject({ ok: false, section: "policies" });
    expect(await b.io.previewText(JSON.stringify({ ...doc, formatVersion: 99 }))).toEqual({ ok: false, reason: "too_new" });
    expect(b.io.apply({ token: "nope", mode: "merge" })).toEqual({ ok: false, reason: "expired" });
    const ok = b.io.apply({ token: pr.preview.token, mode: "merge" });
    expect(ok.ok).toBe(true);
    expect(b.io.apply({ token: pr.preview.token, mode: "merge" })).toEqual({ ok: false, reason: "expired" });
  });

  it("uses the semantic conflict hook for new lessons", async () => {
    const { a } = seed();
    const b = home();
    b.repo.upsertRepo("acme/web", "", 1);
    const local = b.lesson("acme/web", "Log tokens for debugging");
    b.io.setLessonConflictDetector(async (incoming, localRules) => {
      const hit = incoming.find((i) => i.text === "Never log tokens");
      const l = localRules.find((x) => x.text.startsWith("Log tokens"));
      return hit && l ? [{ fingerprint: hit.fingerprint, localId: l.id, reason: "contradicts a local rule" }] : [];
    });
    const pr = await b.io.previewText(JSON.stringify(a.io.exportDoc(all)));
    if (!pr.ok) throw new Error("preview");
    const row = rows(pr.preview, "lessons").find((r) => r.label === "Never log tokens")!;
    expect(row).toMatchObject({ status: "conflicting", relatedId: local, localId: null, reasons: ["contradicts a local rule"] });
    // 合并模式默认留本地：这条不加进来。
    b.io.apply({ token: pr.preview.token, mode: "merge" });
    expect(b.repo.lessons().some((l) => l.text === "Never log tokens")).toBe(false);
    expect(b.repo.lessons({ ids: [local] })).toHaveLength(1);
  });
});

describe("file round trip", () => {
  it("writes an export from one home and previews it from the file in another", async () => {
    const { a } = seed();
    const f = join(tmp(), "butler-export.json");
    expect(a.io.writeExport(all, f).ok).toBe(true);
    const b = home();
    const pr = await b.io.previewFile(f);
    if (!pr.ok) throw new Error(pr.reason);
    expect(pr.preview.totals).toMatchObject({ added: 7 });
    expect(b.io.apply({ token: pr.preview.token, mode: "merge" })).toMatchObject({ ok: true });
    expect(b.repo.lessons()).toHaveLength(4);
    expect(await b.io.previewFile(join(tmp(), "missing.json"))).toEqual({ ok: false, reason: "read_failed" });
  });
});

describe("starter packs", () => {
  it("export only confirmed rules without owner, status or sources, and bind on import", async () => {
    const { a } = seed();
    a.repo.upsertRepo("acme/x", "", 1);
    a.lesson("acme/x", "Always validate input", "confirmed");
    const doc = a.io.exportDoc({ ...all, starter: { name: "Team basics" } })!;
    expect(doc.scope).toEqual({ kind: "starter", name: "Team basics" });
    expect(Object.keys(doc.sections)).toEqual(["lessons"]);
    expect(doc.sections.lessons).toEqual([
      expect.objectContaining({ text: "Always validate input", owner: null }),
      expect.objectContaining({ text: "Keep docs in sync", owner: null }),
    ]);
    expect(JSON.stringify(doc)).not.toMatch(/"status"|"hits"|"sources"|acme/);

    const b = home();
    b.repo.upsertRepo("me/app", "", 1);
    b.lesson("me/app", "Keep docs in sync", "confirmed");
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    expect(pr.preview.starter).toBe(true);
    expect(pr.preview.sections[0]!.rows).toEqual([]);
    expect(b.io.apply({ token: pr.preview.token, mode: "merge" })).toEqual({ ok: false, reason: "needs_target" });
    expect(await b.io.retarget(pr.preview.token, { kind: "repo", slug: "nope/nope" })).toEqual({ ok: false, reason: "bad_target" });
    const re = await b.io.retarget(pr.preview.token, { kind: "repo", slug: "me/app" });
    if (!re.ok) throw new Error("retarget");
    expect(counts(re.preview, "lessons")).toMatchObject({ added: 1, unchanged: 1 });
    expect(b.io.apply({ token: pr.preview.token, mode: "replace" })).toEqual({ ok: false, reason: "replace_starter" });
    const res = b.io.apply({ token: pr.preview.token, mode: "merge" });
    if (!res.ok) throw new Error(res.reason);
    expect(b.repo.lessons({ scope: { kind: "repo", slug: "me/app" } }).map((l) => [l.text, l.status])).toEqual([
      ["Keep docs in sync", "confirmed"], ["Always validate input", "pending"],
    ]);
  });
});

describe("backups", () => {
  it("writes, lists and prunes automatic backups without touching others", () => {
    const { a } = seed();
    const f1 = a.io.backup("auto");
    a.io.backup("auto");
    a.io.backup("auto");
    a.io.backup("before-replace");
    mkdirSync(a.backupDir, { recursive: true });
    writeFileSync(join(a.backupDir, "notes.txt"), "keep me");
    expect(f1).toMatch(/auto-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z(-\d+)?\.json$/);
    expect(a.io.backups()).toHaveLength(4);
    expect(a.io.pruneAutoBackups(1)).toBe(2);
    const left = readdirSync(a.backupDir).sort();
    expect(left.filter((n) => n.startsWith("auto-"))).toHaveLength(1);
    expect(left.some((n) => n.startsWith("before-replace-"))).toBe(true);
    expect(left).toContain("notes.txt");
  });
});

describe("review fixes", () => {
  it("replacing from a product file does not delete lessons of repos the file never covered", async () => {
    const a = home();
    a.repo.upsertRepo("acme/web", "/w", 1);
    const shop = a.repo.createProduct("shop", ["acme/web"], 1);
    a.lesson("acme/web", "Web rule");
    const text = JSON.stringify(a.io.exportDoc({ scope: { kind: "product", productId: shop }, options: { content: "lessons", includeSourceUrls: false } }));
    const b = home();
    b.repo.upsertRepo("acme/web", "/w", 1);
    b.repo.upsertRepo("acme/ops", "/o", 1);
    b.repo.createProduct("shop", ["acme/web", "acme/ops"], 1);
    b.lesson("acme/ops", "Ops rule never exported");
    b.lesson("acme/web", "Web only here");
    const pr = await b.io.previewText(text);
    if (!pr.ok) throw new Error("preview failed");
    expect(rows(pr.preview, "lessons").filter((r) => r.status === "removed").map((r) => r.label)).toEqual(["Web only here"]);
    expect(b.io.apply({ token: pr.preview.token, mode: "replace" })).toMatchObject({ ok: true });
    expect(b.repo.lessons().map((l) => l.text).sort()).toEqual(["Ops rule never exported", "Web rule"]);
  });

  it("undoing an import keeps a product it created once something else depends on it", async () => {
    const { a } = seed();
    const text = JSON.stringify(a.io.exportDoc(all));
    const b = home();
    const pr = await b.io.previewText(text);
    if (!pr.ok) throw new Error("preview failed");
    const res = b.io.apply({ token: pr.preview.token, mode: "merge" });
    if (!res.ok) throw new Error("apply failed");
    const shop = b.repo.products().find((p) => p.name === "shop")!.id;
    const later = b.lesson({ productId: shop }, "Added after the import");
    const u = b.recorder.undo(res.batchId!, 99_999);
    expect(u).toMatchObject({ ok: true });
    if (!u.ok) return;
    expect(u.outcome.skipped).toBeGreaterThan(0);
    expect(b.repo.product(shop)).not.toBeNull();
    expect(b.repo.get(later)).toMatchObject({ text: "Added after the import" });
  });

  it("a preview stays usable for hours while rows are being resolved, then expires", async () => {
    const { a } = seed();
    const text = JSON.stringify(a.io.exportDoc(all));
    const b = home();
    const pr = await b.io.previewText(text);
    if (!pr.ok) throw new Error("preview failed");
    b.advance(5 * 60 * 60_000);
    expect(b.io.apply({ token: pr.preview.token, mode: "merge" })).toMatchObject({ ok: true });
    const again = await b.io.previewText(text);
    if (!again.ok) throw new Error("preview failed");
    b.advance(7 * 60 * 60_000);
    expect(b.io.apply({ token: again.preview.token, mode: "merge" })).toEqual({ ok: false, reason: "expired" });
  });
});
