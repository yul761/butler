import { describe, expect, it } from "vitest";
import type { RegistryModel, Tier } from "../../shared/model-routing";
import { migrate } from "../db/database";
import { RoutingRepo } from "../db/routing-repo";
import { memDb } from "../test-utils";
import { importedRuleId, ModelsConfigSection, parseModelsSection, type ModelsSectionData } from "./config-section";

const reg = (name: string, tier: Tier, over: Partial<RegistryModel> = {}): RegistryModel => ({
  name, tier, enabled: true, account: "default", priceIn: null, priceOut: null, note: "", ...over,
});

function setup() {
  const db = memDb();
  migrate(db);
  const repo = new RoutingRepo(db);
  let applied = 0;
  const section = new ModelsConfigSection({ repo, now: () => 1000, onApplied: () => void applied++ });
  return { repo, section, applied: () => applied };
}

describe("models config section (contract 4.3)", () => {
  it("exports registry, chains, task routes and non-builtin rules without notes or local state", () => {
    const { repo, section } = setup();
    repo.upsertModel(reg("H1", "high", { priceIn: 15, priceOut: 75, note: "main" }));
    repo.setChain("high", ["H1", "other-vendor-x"]);
    repo.setTaskRoute({ task: "pr_brief", tier: "high", minTier: null, policy: "wait", critical: null });
    repo.addRule({ id: "learned:1", kind: "regex", pattern: "seat\\s+cap", category: "usage_limit", accountLevel: true, source: "learned", enabled: true, note: "Error at /Users/someone/x" }, 1);
    repo.addRule({ id: "builtin:overloaded", kind: "regex", pattern: "", category: null, accountLevel: false, source: "builtin", enabled: false, note: "" }, 1);
    const out = section.export();
    expect(out).toEqual<ModelsSectionData>({
      version: 1,
      registry: [{ name: "H1", tier: "high", account: "default", priceIn: 15, priceOut: 75, note: "main" }],
      chains: { high: ["H1", "other-vendor-x"], mid: [], low: [] },
      taskRoutes: [{ task: "pr_brief", tier: "high", minTier: null, policy: "wait", critical: null }],
      rules: [{ kind: "regex", pattern: "seat\\s+cap", category: "usage_limit", accountLevel: true, source: "learned" }],
    });
    expect(JSON.stringify(out)).not.toContain("/Users/");
  });

  it("round trip: export from one machine, import into an empty one (models and rules arrive disabled)", () => {
    const a = setup();
    a.repo.upsertModel(reg("H1", "high"));
    a.repo.upsertModel(reg("M1", "mid"));
    a.repo.setChain("mid", ["M1", "H1"]);
    a.repo.setTaskRoute({ task: "needs_you", tier: "mid", minTier: null, policy: null, critical: null });
    a.repo.addRule({ id: "user:1", kind: "regex", pattern: "allotment exhausted", category: "usage_limit", accountLevel: false, source: "user", enabled: true, note: "" }, 1);
    const data = JSON.parse(JSON.stringify(a.section.export())) as unknown;

    const b = setup();
    expect(b.section.preview(data)).toEqual({
      added: ["model:H1", "model:M1", "chain:mid", "rule:regex:allotment exhausted"],
      changed: ["task:needs_you"], conflicting: [], unchanged: 2, invalid: [],
    });
    const r = b.section.apply(data, "merge");
    expect(r.removed).toEqual([]);
    expect(b.applied()).toBe(1);
    expect(b.repo.registry().map((m) => [m.name, m.enabled])).toEqual([["H1", false], ["M1", false]]);
    expect(b.repo.chains().mid).toEqual(["M1", "H1"]);
    expect(b.repo.taskRoutes()).toEqual([{ task: "needs_you", tier: "mid", minTier: null, policy: null, critical: null }]);
    expect(b.repo.rules()).toEqual([expect.objectContaining({ id: importedRuleId({ kind: "regex", pattern: "allotment exhausted" }), enabled: false, source: "user" })]);
    // 再导入一次：都一样。
    expect(b.section.preview(data)).toMatchObject({ added: [], changed: [], conflicting: [], unchanged: 7 });
  });

  it("merge keeps local on conflicts; replace takes incoming and removes what is not in it", () => {
    const { repo, section } = setup();
    repo.upsertModel(reg("H1", "high", { priceIn: 1 }));
    repo.upsertModel(reg("LOCAL", "low"));
    repo.setChain("high", ["H1"]);
    repo.setTaskRoute({ task: "pr_brief", tier: "low", minTier: null, policy: null, critical: null });
    const incoming = {
      version: 1,
      registry: [{ name: "H1", tier: "high", account: "default", priceIn: 2, priceOut: null, note: "" }],
      chains: { high: ["H1", "H2"] },
      taskRoutes: [{ task: "pr_brief", tier: "high", minTier: null, policy: null, critical: null }],
      rules: [],
    };
    expect(section.preview(incoming)).toMatchObject({ conflicting: ["model:H1", "chain:high", "task:pr_brief"] });
    section.apply(incoming, "merge");
    expect(repo.registry().find((m) => m.name === "H1")?.priceIn).toBe(1);
    expect(repo.chains().high).toEqual(["H1"]);
    expect(repo.registry()).toHaveLength(2);

    const r = section.apply(incoming, "replace");
    expect(r.removed).toEqual(["model:LOCAL"]);
    expect(repo.registry()).toEqual([reg("H1", "high", { priceIn: 2 })]);
    expect(repo.chains().high).toEqual(["H1", "H2"]);
    expect(repo.taskRoutes()[0]?.tier).toBe("high");
  });

  it("bad entries are listed as invalid and skipped, the rest imports", () => {
    const p = parseModelsSection({
      version: 1,
      registry: [{ name: "bad name!", tier: "high" }, { name: "ok-1", tier: "nope" }, { name: "ok-2", tier: "low" }, { name: "ok-2", tier: "low" }],
      chains: { high: ["x"], ultra: ["y"], mid: [3] },
      taskRoutes: [{ task: "not_a_task" }, { task: "pr_brief", policy: "sometimes" }, { task: "needs_you", tier: "low" }],
      rules: [{ kind: "regex", pattern: "(", category: "usage_limit" }, { kind: "regex", pattern: "ok", category: null }, { kind: "status", pattern: "402", category: "usage_limit" }],
    });
    expect(p.invalid).toEqual(["registry[0]", "registry[1]", "registry[3]", "chains.ultra", "chains.mid", "taskRoutes[0]", "taskRoutes[1]", "rules[0]", "rules[1]"]);
    expect(p.registry.map((m) => m.name)).toEqual(["ok-2"]);
    expect(p.taskRoutes).toEqual([{ task: "needs_you", tier: "low", minTier: null, policy: null, critical: null }]);
    expect(p.rules).toHaveLength(1);
    expect(parseModelsSection(null).invalid).toEqual(["section"]);
    expect(parseModelsSection({ version: 99 }).invalid).toEqual(["version:99"]);
  });
});
