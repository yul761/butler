import { describe, expect, it } from "vitest";
import { memDb } from "../test-utils";
import { LessonsRepo } from "../db/lessons-repo";
import { BatchRecorder } from "../batches/batch-recorder";
import { lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { AdmissionPolicyService } from "./admission-policies";
import { ADMISSION_POLICY_DEFAULTS, ADMISSION_POLICY_KEYS, checkPolicyValue, parsePolicyOverrides, sanitizePolicyOverrides } from "../../shared/admission-policy";

const setup = () => {
  const db = memDb();
  const repo = new LessonsRepo(db);
  repo.upsertRepo("acme/web", "/w", 1);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db)]);
  let version = 1;
  const svc = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => version, set: (v) => (version = v) }, now: () => 5 });
  return { db, repo, recorder, svc };
};

describe("admission policy keys", () => {
  it("cover the plan's settings with the master-design defaults", () => {
    expect(ADMISSION_POLICY_KEYS).toHaveLength(36);
    expect(ADMISSION_POLICY_DEFAULTS).toMatchObject({
      "score.admitLine": 0.7, "score.proseAdmitLine": 0.8, "generality.minHits": 2, "generality.minPrs": 2, "backtest.minRecall": 0.01,
      "backtest.maxFalsePositiveRate": 0.2, "shadow.minPrs": 5, "shadow.minDays": 7, "shadow.minAdoption": 0.6,
      "shadow.autoPromote": false, "admission.autoConfirm": false, "demote.to": "shadow",
    });
    const w = ["evidence", "clarity", "consistency", "verifiability", "performance"].reduce((s, k) => s + Number(ADMISSION_POLICY_DEFAULTS[`score.weight.${k}` as "score.weight.evidence"]), 0);
    expect(w).toBeCloseTo(1);
  });

  it("validate values", () => {
    expect(checkPolicyValue("score.admitLine", 0.5)).toBe(0.5);
    expect(() => checkPolicyValue("score.admitLine", 1.5)).toThrow();
    expect(() => checkPolicyValue("generality.minHits", 1.5)).toThrow();
    expect(() => checkPolicyValue("shadow.autoPromote", "yes")).toThrow();
    expect(() => checkPolicyValue("demote.to", "nowhere")).toThrow();
    expect(() => checkPolicyValue("nope", 1)).toThrow();
    expect(parsePolicyOverrides({ "score.admitLine": 0.6, "shadow.minPrs": null })).toEqual({ "score.admitLine": 0.6 });
    expect(() => parsePolicyOverrides([])).toThrow();
    expect(sanitizePolicyOverrides({ "score.admitLine": 9, "shadow.minPrs": 3, x: 1 })).toEqual({ "shadow.minPrs": 3 });
  });
});

describe("AdmissionPolicyService", () => {
  it("resolves global, product and repo layers key by key and shows where each value comes from", () => {
    const { repo, svc } = setup();
    const shop = repo.createProduct("shop", ["acme/web"], 1);
    svc.setLayer({ kind: "global" }, { "score.admitLine": 0.75, "shadow.minPrs": 8 });
    svc.setLayer({ kind: "product", productId: shop }, { "score.admitLine": 0.8 });
    svc.setLayer({ kind: "repo", slug: "acme/web" }, { "shadow.autoPromote": true });
    const r = svc.resolve({ kind: "repo", slug: "acme/web" }).value;
    expect(r).toMatchObject({ "score.admitLine": 0.8, "shadow.minPrs": 8, "shadow.autoPromote": true, "score.dropLine": 0.3 });
    const v = svc.view({ kind: "repo", slug: "acme/web" });
    const k = (key: string) => v.keys.find((x) => x.key === key)!;
    expect(k("score.admitLine")).toMatchObject({ effective: 0.8, origin: { kind: "product", name: "shop" }, override: null });
    expect(k("shadow.minPrs").origin).toEqual({ kind: "global" });
    expect(k("shadow.autoPromote")).toMatchObject({ origin: { kind: "repo", slug: "acme/web" }, override: true });
    expect(k("score.dropLine").origin).toEqual({ kind: "default" });
    expect(v).toMatchObject({ version: 4, calibrated: false, conflicts: [] });
  });

  it("warns when two products of a repo disagree", () => {
    const { repo, svc } = setup();
    const a = repo.createProduct("a", ["acme/web"], 1);
    const b = repo.createProduct("b", ["acme/web"], 1);
    svc.setLayer({ kind: "product", productId: a }, { "score.admitLine": 0.6 });
    svc.setLayer({ kind: "product", productId: b }, { "score.admitLine": 0.9 });
    expect(svc.view({ kind: "repo", slug: "acme/web" }).conflicts).toEqual([
      { key: "score.admitLine", products: [{ id: a, name: "a", value: 0.6 }, { id: b, name: "b", value: 0.9 }] },
    ]);
    expect(svc.resolve({ kind: "repo", slug: "acme/web" }).value["score.admitLine"]).toBe(0.9);
  });

  it("records each change as an undoable batch, bumps the version only on change, and rejects bad input", () => {
    const { svc, recorder } = setup();
    const first = svc.setLayer({ kind: "global" }, { "score.admitLine": 0.75 });
    expect(first.version).toBe(2);
    expect(svc.setLayer({ kind: "global" }, { "score.admitLine": 0.75 })).toEqual({ batchId: null, version: 2 });
    const second = svc.setLayer({ kind: "global" }, { "score.admitLine": 0.6 });
    recorder.undo(second.batchId!, 9);
    expect(svc.overrides({ kind: "global" })).toEqual({ "score.admitLine": 0.75 });
    recorder.undo(first.batchId!, 10);
    expect(svc.overrides({ kind: "global" })).toEqual({});
    expect(() => svc.setLayer({ kind: "global" }, { "score.admitLine": 3 })).toThrow();
    expect(() => svc.setLayer({ kind: "product", productId: 99 }, {})).toThrow();
  });

  it("drops a product's layer with the product", () => {
    const { repo, svc } = setup();
    const p = repo.createProduct("p", [], 1);
    svc.setLayer({ kind: "product", productId: p }, { "shadow.minDays": 3 });
    repo.deleteProduct(p);
    expect(svc.allLayers()).toEqual([]);
  });
});
