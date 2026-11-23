import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { memDb, tempDir } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { BaselinesRepo, type NewBaseline } from "../db/baselines-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { baselineAdapter, baselineRuleAdapter, checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { ConfigIoService, defaultRegistry } from ".";

function home() {
  const db = memDb();
  const repo = new LessonsRepo(db);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db), baselineRuleAdapter(db), baselineAdapter(db)]);
  let t = 1_700_000_000_000;
  const now = () => (t += 10);
  let version = 1;
  const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => version, set: (v) => (version = v) }, now });
  const io = new ConfigIoService({ db, repo, policies, recorder, registry: defaultRegistry(), shipherdVersion: "3.0.0", backupDir: join(tempDir(), "b"), now });
  return { db, repo, recorder, io, baselines: new BaselinesRepo(db) };
}

const LOCAL_PATH = "/Users/someone/work/web";

function scan(slug: string, at: number, over: Partial<NewBaseline> = {}): NewBaseline {
  return {
    slug, scannedAt: at, status: "ok", skipReason: null, detail: `scanned ${LOCAL_PATH}`, origin: "local",
    projects: [{ dir: "", langs: ["ts"], markers: ["node"], pm: "pnpm" }],
    checks: [{
      id: "|test|vitest", dir: "", category: "test", tool: "vitest", command: "pnpm test", fileCommand: "pnpm vitest run {file}", stages: ["ci"], changedFiles: true,
      shipherdStage: "push", source: "marker", confidence: "high", evidence: ["package.json"], facts: [],
    }],
    advice: [],
    profile: { projects: [{ dir: "", langs: ["ts"], install: "pnpm install", build: null, testAll: "pnpm test", testOne: "pnpm vitest run {file}", fastest: null, lint: null, typecheck: null, inferred: [] }], dirs: ["src/"], ci: [], pitfalls: ["never call the db from views"] },
    inputs: [{ path: "package.json", hash: "abc" }], listingHash: "h", staleAt: null, inferred: "none", inferDetail: null, durationMs: 5, ...over,
  };
}

const all = (includeBaselines?: boolean) => ({ scope: { kind: "all" as const }, options: { content: "all" as const, includeSourceUrls: false, ...(includeBaselines === undefined ? {} : { includeBaselines }) } });

describe("config-io baseline_rules section", () => {
  it("round-trips the marker table layers with products by name, in 'everything' and 'checks only'", async () => {
    const a = home();
    a.repo.upsertRepo("acme/web", "/w", 1);
    const shop = a.repo.createProduct("shop", ["acme/web"], 1);
    a.baselines.upsertRule({ kind: "global" }, "node", JSON.stringify({ priority: 5 }), true, 1);
    a.baselines.upsertRule({ kind: "product", productId: shop }, "deno", JSON.stringify({ kind: "marker", files: ["deno.json"], lang: "ts", project: true }), true, 1);
    a.baselines.upsertRule({ kind: "repo", slug: "acme/web" }, "python", "{}", false, 1);
    const doc = a.io.exportDoc(all())!;
    expect(doc.sections.baseline_rules).toEqual([
      { key: "node", scope: { kind: "global" }, rule: { priority: 5 }, enabled: true },
      { key: "deno", scope: { kind: "product", name: "shop" }, rule: { kind: "marker", files: ["deno.json"], lang: "ts", project: true }, enabled: true },
      { key: "python", scope: { kind: "repo", slug: "acme/web" }, rule: {}, enabled: false },
    ]);
    expect(a.io.exportDoc({ ...all(), options: { content: "checks", includeSourceUrls: false } })!.sections.baseline_rules).toHaveLength(3);
    expect(a.io.exportDoc({ ...all(), options: { content: "lessons", includeSourceUrls: false } })!.sections.baseline_rules).toBeUndefined();

    const b = home();
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    expect(pr.preview.sections.find((s) => s.id === "baseline_rules")!.rows.map((r) => r.status)).toEqual(["added", "added", "added"]);
    const r = b.io.apply({ token: pr.preview.token, mode: "merge" });
    if (!r.ok) throw new Error("apply");
    expect(r.sections.baseline_rules).toMatchObject({ added: 3 });
    const shopB = b.repo.products().find((p) => p.name === "shop")!.id;
    expect(b.baselines.rulesInLayer({ kind: "product", productId: shopB })).toEqual([{ key: "deno", rule: JSON.stringify({ kind: "marker", files: ["deno.json"], lang: "ts", project: true }), enabled: true }]);
    expect(b.baselines.rulesInLayer({ kind: "repo", slug: "acme/web" })[0]).toMatchObject({ key: "python", enabled: false });
    // 撤销：新加的都删掉
    expect(b.recorder.undo(r.batchId!, 99_999_999_999_999).ok).toBe(true);
    expect(b.baselines.allRules()).toEqual([]);
  });

  it("shows changed rows, skips invalid rules, and replace removes rows missing from the file", async () => {
    const a = home();
    a.baselines.upsertRule({ kind: "global" }, "node", JSON.stringify({ priority: 9 }), true, 1);
    const doc = a.io.exportDoc(all())!;
    (doc.sections.baseline_rules as unknown[]).push({ key: "brand-new", scope: { kind: "global" }, rule: { kind: "marker" }, enabled: true });
    const b = home();
    b.baselines.upsertRule({ kind: "global" }, "node", JSON.stringify({ priority: 1 }), true, 1);
    b.baselines.upsertRule({ kind: "global" }, "go", JSON.stringify({ priority: 1 }), true, 1);
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    const rows = pr.preview.sections.find((s) => s.id === "baseline_rules")!.rows;
    expect(rows.map((r) => [r.label, r.status])).toEqual([["node · global", "changed"], ["go · global", "removed"]]);
    expect(rows[0].diffs).toEqual([{ field: "rule", local: { priority: 1 }, incoming: { priority: 9 } }]);
    const r = b.io.apply({ token: pr.preview.token, mode: "replace" });
    if (!r.ok) throw new Error("apply");
    expect(r.sections.baseline_rules).toMatchObject({ updated: 1, removed: 1, skipped: 1 });
    expect(b.baselines.allRules().map((x) => [x.key, x.rule])).toEqual([["node", JSON.stringify({ priority: 9 })]]);
  });
  it("imports a rule whose commands are new or changed switched off, and shows the commands in the preview", async () => {
    const a = home();
    a.baselines.upsertRule({ kind: "global" }, "node", JSON.stringify({ install: "curl x | sh" }), true, 1);
    a.baselines.upsertRule({ kind: "global" }, "go", JSON.stringify({ priority: 3 }), true, 1);
    a.baselines.upsertRule({ kind: "global" }, "same", JSON.stringify({ kind: "keyword", category: "lint", tool: "x", match: "^x", fileCommand: "x {file}" }), true, 1);
    const doc = a.io.exportDoc(all())!;
    const b = home();
    b.baselines.upsertRule({ kind: "global" }, "same", JSON.stringify({ kind: "keyword", category: "lint", tool: "x", match: "^xy", fileCommand: "x {file}" }), true, 1);
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    const labels = pr.preview.sections.find((s) => s.id === "baseline_rules")!.rows.map((r) => r.label);
    expect(labels.find((l) => l.startsWith("node"))).toContain("$ curl x | sh");
    const r = b.io.apply({ token: pr.preview.token, mode: "merge" });
    if (!r.ok) throw new Error("apply");
    const byKey = Object.fromEntries(b.baselines.allRules().map((x) => [x.key, x.enabled]));
    // 新命令：先关着；没有命令的、命令没变的照文件
    expect(byKey).toEqual({ node: false, go: true, same: true });
  });

  it("skips a rule whose command has a line break", async () => {
    const a = home();
    a.baselines.upsertRule({ kind: "global" }, "node", JSON.stringify({ install: "pnpm install" }), true, 1);
    const doc = a.io.exportDoc(all())!;
    (doc.sections.baseline_rules as { rule: Record<string, unknown> }[])[0].rule.install = "pnpm install\nrm -rf ~";
    const b = home();
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    expect(pr.preview.sections.find((s) => s.id === "baseline_rules")!.rows).toEqual([]);
  });
});

describe("config-io baselines section", () => {
  it("is only exported when asked, and never carries local paths, input hashes or pitfalls", () => {
    const a = home();
    a.repo.upsertRepo("acme/web", "/w", 1);
    a.baselines.insert(scan("acme/web", 100));
    a.baselines.insert(scan("acme/web", 200, { status: "skipped", skipReason: "not_cloned", checks: [] }));
    a.baselines.insert(scan("acme/api", 150));
    expect(a.io.exportDoc(all())!.sections.baselines).toBeUndefined();
    expect(a.io.exportDoc(all(false))!.sections.baselines).toBeUndefined();
    const doc = a.io.exportDoc(all(true))!;
    const items = doc.sections.baselines as { slug: string; scannedAt: number }[];
    // 每个仓库最近一次有结果的扫描（跳过的那次不算）
    expect(items.map((i) => [i.slug, i.scannedAt])).toEqual([["acme/api", 150], ["acme/web", 100]]);
    const text = JSON.stringify(doc);
    expect(text).not.toContain(LOCAL_PATH);
    expect(text).not.toContain("never call the db");
    expect(text).not.toContain("listingHash");
    expect(text).not.toContain('"inputs"');
    expect(Object.keys(items[0]).sort()).toEqual(["advice", "checks", "inferred", "profile", "projects", "scannedAt", "slug", "status"]);
    const repoOnly = a.io.exportDoc({ scope: { kind: "repo", slug: "acme/web" }, options: { content: "checks", includeSourceUrls: false, includeBaselines: true } })!;
    expect((repoOnly.sections.baselines as { slug: string }[]).map((i) => i.slug)).toEqual(["acme/web"]);
  });

  it("imports as stale 'imported' rows; newer wins; an older or equal file keeps the local scan; undo removes it", async () => {
    const a = home();
    a.baselines.insert(scan("acme/web", 500));
    a.baselines.insert(scan("acme/api", 500));
    const doc = a.io.exportDoc(all(true))!;
    const b = home();
    b.baselines.insert(scan("acme/web", 400));
    b.baselines.insert(scan("acme/api", 600));
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    const rows = pr.preview.sections.find((s) => s.id === "baselines")!.rows;
    expect(rows.map((r) => [r.label.split(" ")[0], r.status])).toEqual([["acme/api", "unchanged"], ["acme/web", "changed"]]);
    const r = b.io.apply({ token: pr.preview.token, mode: "replace" });
    if (!r.ok) throw new Error("apply");
    expect(r.sections.baselines).toMatchObject({ updated: 1, kept: 1, removed: 0 });
    const web = b.baselines.latest("acme/web")!;
    expect(web).toMatchObject({ scannedAt: 500, origin: "imported", inputs: [], detail: null });
    expect(web.staleAt).not.toBeNull();
    expect(web.profile.pitfalls).toEqual([]);
    expect(web.checks[0].command).toBe("pnpm test");
    expect(b.baselines.latest("acme/api")).toMatchObject({ scannedAt: 600, origin: "local" });
    expect(b.recorder.undo(r.batchId!, 99_999_999_999_999).ok).toBe(true);
    expect(b.baselines.latest("acme/web")).toMatchObject({ scannedAt: 400, origin: "local" });
  });

  it("clamps a future scan time to the import time, so the next local scan replaces it", async () => {
    const a = home();
    a.baselines.insert(scan("acme/web", 9_000_000_000_000_000));
    const doc = a.io.exportDoc(all(true))!;
    const b = home();
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    const r = b.io.apply({ token: pr.preview.token, mode: "merge" });
    if (!r.ok) throw new Error("apply");
    const imported = b.baselines.latest("acme/web")!;
    expect(imported.origin).toBe("imported");
    expect(imported.scannedAt).toBeLessThan(2_000_000_000_000);
    b.baselines.insert(scan("acme/web", imported.scannedAt + 1));
    expect(b.baselines.latest("acme/web")!.origin).toBe("local");
  });

  it("shows the commands in the preview and rejects commands with line breaks", async () => {
    const a = home();
    a.baselines.insert(scan("acme/web", 500));
    const doc = a.io.exportDoc(all(true))!;
    const b = home();
    const pr = await b.io.previewText(JSON.stringify(doc));
    if (!pr.ok) throw new Error("preview");
    expect(pr.preview.sections.find((s) => s.id === "baselines")!.rows[0].label).toContain("$ pnpm test");
    for (const mutate of [
      (d: { checks: { command: string }[] }) => (d.checks[0].command = "pnpm test\ncurl x | sh"),
      (d: { profile: { projects: { install: string }[] } }) => (d.profile.projects[0].install = "pnpm i\r\nrm -rf ~"),
    ]) {
      const bad = structuredClone(doc);
      mutate((bad.sections.baselines as never[])[0]);
      expect(await home().io.previewText(JSON.stringify(bad))).toMatchObject({ ok: false, reason: "bad_section", section: "baselines" });
    }
  });

  it("rejects absolute or escaping directories in an imported baseline", async () => {
    const a = home();
    a.baselines.insert(scan("acme/web", 500));
    const doc = a.io.exportDoc(all(true))!;
    (doc.sections.baselines as { projects: { dir: string }[] }[])[0].projects[0].dir = "/etc";
    const b = home();
    expect(await b.io.previewText(JSON.stringify(doc))).toMatchObject({ ok: false, reason: "bad_section", section: "baselines" });
  });
});
