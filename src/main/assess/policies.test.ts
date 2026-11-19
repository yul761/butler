import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { LessonsRepo } from "../db/lessons-repo";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { memDb, tempDir } from "../test-utils";
import { ConfigIoService, defaultRegistry } from "../config-io";
import { BUILTIN_RISK_PATHS, checkPrValue, defaultPrPolicy, expandPrPolicy, PR_POLICY_DEFAULTS, PrPolicyError } from "../../shared/pr-policy";
import { PrPolicies } from "./policies";

function setup() {
  const db = memDb();
  const lessons = new LessonsRepo(db);
  const pol = new PrPolicies({ db, products: { productsOf: (s) => lessons.productsOf(s), product: (id) => lessons.product(id) }, now: () => 5 });
  return { db, lessons, pol };
}

describe("pr policy keys", () => {
  it("defaults: readiness on, should not block, evidence auto, rerun all, build off", () => {
    const p = defaultPrPolicy();
    expect(Object.values(p.readiness.enabled).every(Boolean)).toBe(true);
    expect(p.readiness.shouldBlocks).toBe(false);
    expect(p.evidence.require).toEqual({ test: "auto", lint: "auto", typecheck: "auto", build: "off" });
    expect(p.evidence.rerun).toBe("all");
    expect(p.risk.paths.migration).toEqual([...BUILTIN_RISK_PATHS.migration]);
    expect(p.risk.types.floors).toMatchObject({ hotfix: "high", security: "high", bug: "medium" });
  });

  it("rejects unknown keys, out-of-range values and malformed type mappings", () => {
    expect(() => checkPrValue("nope", true)).toThrow(PrPolicyError);
    expect(() => checkPrValue("readiness.descriptionMinChars", -1)).toThrow(PrPolicyError);
    expect(() => checkPrValue("evidence.rerun", "sometimes")).toThrow(PrPolicyError);
    expect(() => checkPrValue("risk.types.floors", ["hotfix=urgent"])).toThrow(PrPolicyError);
    expect(() => checkPrValue("risk.types.labels", ["noequals"])).toThrow(PrPolicyError);
    expect(checkPrValue("risk.types.labels", [" p0=hotfix ", "p0=hotfix"])).toEqual(["p0=hotfix"]);
  });

  it("migration paths cannot lose their builtin list; other classes can", () => {
    const flat = { ...PR_POLICY_DEFAULTS, "risk.paths.auth.builtin": false } as typeof PR_POLICY_DEFAULTS;
    const p = expandPrPolicy(flat, { migration: ["db/changes/**"] });
    expect(p.risk.paths.auth).toEqual([]);
    expect(p.risk.paths.migration).toEqual([...BUILTIN_RISK_PATHS.migration, "db/changes/**"]);
    expect(() => checkPrValue("risk.paths.migration.builtin", false)).toThrow(PrPolicyError);
  });

  it("type mappings merge over the defaults", () => {
    const p = expandPrPolicy({ ...PR_POLICY_DEFAULTS, "risk.types.labels": ["P0=hotfix"], "risk.types.floors": ["bug=high"] } as typeof PR_POLICY_DEFAULTS);
    expect(p.risk.types.labels.p0).toBe("hotfix");
    expect(p.risk.types.labels.bug).toBe("bug");
    expect(p.risk.types.floors.bug).toBe("high");
  });
});

describe("PrPolicies", () => {
  it("three layers: repo overrides product overrides global; path lists union across layers", () => {
    const { lessons, pol } = setup();
    lessons.upsertRepo("a/b", "/r", 1);
    const pid = lessons.createProduct("shop", ["a/b"], 1);
    pol.setLayer({ kind: "global" }, { "readiness.descriptionMinChars": 10, "risk.paths.auth": ["g/**"] });
    pol.setLayer({ kind: "product", productId: pid }, { "readiness.descriptionMinChars": 20, "risk.paths.auth": ["p/**"] });
    pol.setLayer({ kind: "repo", slug: "a/b" }, { "risk.paths.auth": ["r/**"], "evidence.rerun": "fast" });
    const p = pol.forSlug("a/b");
    expect(p.readiness.descriptionMinChars).toBe(20);
    expect(p.evidence.rerun).toBe("fast");
    expect(p.risk.paths.auth).toEqual([...BUILTIN_RISK_PATHS.auth, "g/**", "p/**", "r/**"]);
    expect(pol.forSlug("x/y").risk.paths.auth).toEqual([...BUILTIN_RISK_PATHS.auth, "g/**"]);
    expect(pol.forSlug(null).readiness.descriptionMinChars).toBe(10);
    const v = pol.view({ kind: "repo", slug: "a/b" });
    expect(v.keys.find((k) => k.key === "readiness.descriptionMinChars")?.origin).toEqual({ kind: "product", productId: pid, name: "shop" });
    expect(v.unions.auth).toEqual(["g/**", "p/**", "r/**"]);
  });

  it("setLayer validates, notifies listeners, and an empty layer is not created", () => {
    const { db, pol } = setup();
    let n = 0;
    pol.onChange(() => n++);
    expect(() => pol.setLayer({ kind: "global" }, { "evidence.rerun": "bad" })).toThrow(PrPolicyError);
    pol.setLayer({ kind: "repo", slug: "a/b" }, {});
    expect((db.prepare(`SELECT COUNT(*) AS c FROM pr_policies`).get() as { c: number }).c).toBe(0);
    expect(n).toBe(0);
    pol.setLayer({ kind: "global" }, { "readiness.shouldBlocks": true });
    expect(n).toBe(1);
    expect(pol.forSlug(null).readiness.shouldBlocks).toBe(true);
  });

  it("exports and imports through config-io (prPolicies section)", () => {
    const mk = () => {
      const db = memDb();
      const repo = new LessonsRepo(db);
      const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
      let version = 1;
      const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => version, set: (v) => (version = v) }, now: () => 9 });
      const io = new ConfigIoService({ db, repo, policies, recorder, registry: defaultRegistry(), butlerVersion: "3.0.0", backupDir: join(tempDir(), "b"), now: () => 9 });
      return { io, pol: new PrPolicies({ db, products: { productsOf: (s) => repo.productsOf(s), product: (id) => repo.product(id) }, now: () => 9 }) };
    };
    const a = mk();
    a.pol.setLayer({ kind: "repo", slug: "a/b" }, { "risk.paths.migration": ["db/changes/**"], "readiness.shouldBlocks": true });
    const doc = a.io.exportDoc({ scope: { kind: "all" }, options: { content: "all", includeSourceUrls: false } })!;
    expect((doc.sections as Record<string, unknown>).prPolicies).toEqual([
      { layer: { kind: "repo", slug: "a/b" }, overrides: { "readiness.shouldBlocks": true, "risk.paths.migration": ["db/changes/**"] } },
    ]);
    const b = mk();
    return b.io.previewText(JSON.stringify(doc)).then((p) => {
      if (!p.ok) throw new Error(p.reason);
      expect(p.preview.sections.find((s) => s.id === "prPolicies")?.rows[0]?.status).toBe("added");
      const r = b.io.apply({ token: p.preview.token, mode: "merge" });
      expect(r.ok).toBe(true);
      expect(b.pol.forSlug("a/b").risk.paths.migration).toContain("db/changes/**");
      expect(b.pol.forSlug("a/b").readiness.shouldBlocks).toBe(true);
    });
  });
});
