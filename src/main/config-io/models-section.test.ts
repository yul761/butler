import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RegistryModel, Tier } from "../../shared/model-routing";
import { BatchRecorder } from "../batches/batch-recorder";
import { checkAdapter, lessonAdapter, policyAdapter, productAdapter } from "../batches/table-adapter";
import { LessonsRepo } from "../db/lessons-repo";
import { RoutingRepo } from "../db/routing-repo";
import { AdmissionPolicyService } from "../lessons/admission-policies";
import { memDb, tempDir } from "../test-utils";
import { ConfigIoService, defaultRegistry } from ".";
import { importedRuleId, modelsFingerprint } from "./models-section";

const reg = (name: string, tier: Tier, over: Partial<RegistryModel> = {}): RegistryModel => ({
  name, tier, enabled: true, account: "default", priceIn: null, priceOut: null, note: "", ...over,
});

function home() {
  const db = memDb();
  const repo = new LessonsRepo(db);
  const recorder = new BatchRecorder(db, [lessonAdapter(db), productAdapter(db), policyAdapter(db), checkAdapter(db)]);
  let t = 1000;
  const now = () => (t += 10);
  let version = 1;
  const policies = new AdmissionPolicyService({ db, repo, recorder, version: { get: () => version, set: (v) => (version = v) }, now });
  const io = new ConfigIoService({ db, repo, policies, recorder, registry: defaultRegistry(), butlerVersion: "3.0.0", backupDir: join(tempDir(), "b"), now });
  return { io, routing: new RoutingRepo(db), lessons: repo };
}

const all = { scope: { kind: "all" as const }, options: { content: "all" as const, includeSourceUrls: false } };

async function preview(b: ReturnType<typeof home>, doc: unknown) {
  const pr = await b.io.previewText(JSON.stringify(doc));
  if (!pr.ok) throw new Error(`preview: ${pr.reason}`);
  return { token: pr.preview.token, rows: pr.preview.sections.find((s) => s.id === "models")?.rows ?? [] };
}

describe("models config section (contract 4.3)", () => {
  it("exports registry, chains, task routes and non-builtin rules without notes or local state; only in full exports", () => {
    const a = home();
    a.routing.upsertModel(reg("H1", "high", { priceIn: 15, priceOut: 75, note: "main" }));
    a.routing.setChain("high", ["H1", "other-vendor-x"]);
    a.routing.setTaskRoute({ task: "pr_brief", tier: "high", minTier: null, policy: "wait", critical: null });
    a.routing.addRule({ id: "learned:1", kind: "regex", pattern: "seat\\s+cap", category: "usage_limit", accountLevel: true, source: "learned", enabled: true, note: "Error at /Users/someone/x" }, 1);
    a.routing.addRule({ id: "builtin:overloaded", kind: "regex", pattern: "", category: null, accountLevel: false, source: "builtin", enabled: false, note: "" }, 1);
    const doc = a.io.exportDoc(all)!;
    expect(doc.sections.models).toEqual([
      { kind: "model", name: "H1", tier: "high", account: "default", priceIn: 15, priceOut: 75, note: "main" },
      { kind: "chain", tier: "high", models: ["H1", "other-vendor-x"] },
      { kind: "task", task: "pr_brief", tier: "high", minTier: null, policy: "wait", critical: null },
      { kind: "rule", ruleKind: "regex", pattern: "seat\\s+cap", category: "usage_limit", accountLevel: true, source: "learned" },
    ]);
    expect(JSON.stringify(doc.sections.models)).not.toContain("/Users/");
    expect(a.io.exportDoc({ ...all, options: { ...all.options, content: "lessons" } })!.sections.models).toBeUndefined();
  });

  it("round trip into an empty machine: models and rules arrive disabled; the local enabled state is kept on re-import", async () => {
    const a = home();
    a.routing.upsertModel(reg("H1", "high"));
    a.routing.upsertModel(reg("M1", "mid"));
    a.routing.setChain("mid", ["M1", "H1"]);
    a.routing.setTaskRoute({ task: "needs_you", tier: "mid", minTier: null, policy: null, critical: null });
    a.routing.addRule({ id: "user:1", kind: "regex", pattern: "allotment exhausted", category: "usage_limit", accountLevel: false, source: "user", enabled: true, note: "" }, 1);
    const doc = a.io.exportDoc(all)!;

    const b = home();
    const p = await preview(b, doc);
    expect(p.rows.map((r) => r.status)).toEqual(["added", "added", "added", "added", "added"]);
    const r = b.io.apply({ token: p.token, mode: "merge" });
    if (!r.ok) throw new Error("apply");
    expect(r.sections.models).toMatchObject({ added: 5 });
    expect(b.routing.registry().map((m) => [m.name, m.enabled])).toEqual([["H1", false], ["M1", false]]);
    expect(b.routing.chains().mid).toEqual(["M1", "H1"]);
    expect(b.routing.taskRoutes()).toEqual([expect.objectContaining({ task: "needs_you", tier: "mid" })]);
    expect(b.routing.rules().find((x) => x.source === "user")).toMatchObject({ id: importedRuleId({ ruleKind: "regex", pattern: "allotment exhausted" }), enabled: false });

    b.routing.upsertModel({ ...b.routing.registry().find((m) => m.name === "H1")!, enabled: true });
    const again = await preview(b, doc);
    expect(again.rows.every((x) => x.status === "unchanged")).toBe(true);
  });

  it("behaviour differences are conflicts, note-only ones are changes; replace removes what the file lacks", async () => {
    const a = home();
    a.routing.upsertModel(reg("H1", "high", { priceIn: 10, note: "x" }));
    a.routing.upsertModel(reg("M1", "mid", { note: "file" }));
    const b = home();
    b.routing.upsertModel(reg("H1", "high", { priceIn: 20, note: "x" }));
    b.routing.upsertModel(reg("M1", "mid", { note: "local" }));
    b.routing.upsertModel(reg("L1", "low"));
    b.routing.setTaskRoute({ task: "pr_brief", tier: "low", minTier: null, policy: null, critical: null });
    const p = await preview(b, a.io.exportDoc(all));
    const by = (name: string) => p.rows.find((r) => r.fingerprint === modelsFingerprint({ kind: "model", name, tier: "high", account: "", priceIn: null, priceOut: null, note: "" }))!;
    expect(by("H1")).toMatchObject({ status: "conflicting", reasons: ["priceIn"] });
    expect(by("M1")).toMatchObject({ status: "changed", reasons: [] });
    expect(by("L1")).toMatchObject({ status: "removed" });
    expect(p.rows.filter((r) => r.status === "removed")).toHaveLength(2);

    const r = b.io.apply({ token: p.token, mode: "replace", bulk: "imported" });
    if (!r.ok) throw new Error(`apply ${r.reason}`);
    expect(b.routing.registry().map((m) => [m.name, m.priceIn, m.note, m.enabled])).toEqual([["H1", 10, "x", true], ["M1", null, "file", true]]);
    expect(b.routing.taskRoutes()).toEqual([]);
  });

  it("a file from before BTL-246 with an epic_digest route still imports; that route is dropped", async () => {
    const a = home();
    a.routing.setTaskRoute({ task: "pr_brief", tier: "high", minTier: null, policy: null, critical: null });
    const doc = a.io.exportDoc(all)!;
    (doc.sections as Record<string, unknown[]>).models.push({ kind: "task", task: "epic_digest", tier: "mid", minTier: null, policy: null, critical: null });
    const b = home();
    const p = await preview(b, doc);
    expect(p.rows.map((r) => r.label)).toEqual(["task · pr_brief"]);
    const r = b.io.apply({ token: p.token, mode: "replace", bulk: "imported" });
    if (!r.ok) throw new Error(`apply ${r.reason}`);
    expect(b.routing.taskRoutes()).toEqual([expect.objectContaining({ task: "pr_brief", tier: "high" })]);
  });

  it("a malformed models section is refused before anything is written", async () => {
    const a = home();
    const doc = a.io.exportDoc(all)!;
    (doc.sections as Record<string, unknown>).models = [{ kind: "model", name: "bad name!", tier: "high", account: "default", priceIn: null, priceOut: null, note: "" }];
    const pr = await home().io.previewText(JSON.stringify(doc));
    expect(pr).toMatchObject({ ok: false, reason: "bad_section", section: "models" });
  });
});
