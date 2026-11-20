import { describe, expect, it, vi } from "vitest";
import type { PolicyFamily } from "../../shared/feature-rows";
import { migrate } from "../db/database";
import { IntakePolicyService } from "../intake/policy";
import { LoopPolicies } from "../loop/policies";
import { StackPolicyService } from "../stacks/stack-policy";
import { memDb } from "../test-utils";
import { featurePolicyHandlers, featurePolicyLayers, type FeaturePolicyDeps, type FeaturePolicyServices } from "./feature-policy-handlers";

function deps(layers: Partial<Record<PolicyFamily, Record<string, unknown>>> = {}, fail = false) {
  const writes: { family: PolicyFamily; layer: Record<string, unknown> }[] = [];
  const d: FeaturePolicyDeps = {
    read: () => ({ globals: {}, overrides: [] }),
    globalLayer: (family) => ({ ...(layers[family] ?? {}) }),
    writeLayer: (family, layer) => {
      if (fail) throw new Error("disk full");
      writes.push({ family, layer });
    },
    notify: vi.fn(),
  };
  return { d, writes };
}

describe("featurePolicyHandlers", () => {
  it("keeps the other overrides in the global layer when it flips one key", () => {
    const { d, writes } = deps({ loop: { "ci.maxReruns": 3, "comments.ignorePatterns": ["x"] } });
    featurePolicyHandlers(d).patch({ family: "loop", key: "ci.enabled", value: true });
    expect(writes).toEqual([{ family: "loop", layer: { "ci.maxReruns": 3, "comments.ignorePatterns": ["x"], "ci.enabled": true } }]);
    expect(d.notify).toHaveBeenCalledTimes(1);
  });

  it("passes the read through", () => {
    const { d } = deps();
    expect(featurePolicyHandlers(d).get()).toEqual({ globals: {}, overrides: [] });
  });

  it("rejects keys that are not feature switches", () => {
    const { d, writes } = deps();
    const h = featurePolicyHandlers(d);
    for (const bad of [
      { family: "routing", key: "ci.enabled", value: true },
      { family: "loop", key: "comments.reply", value: true },
      { family: "stacks", key: "ci.enabled", value: true },
      { family: "loop", key: "ci.enabled", value: "1" },
      null,
      "loop",
    ]) expect(() => h.patch(bad), JSON.stringify(bad)).toThrow();
    expect(writes).toEqual([]);
    expect(d.notify).not.toHaveBeenCalled();
  });

  it("does not notify when the write fails", () => {
    const { d } = deps({}, true);
    expect(() => featurePolicyHandlers(d).patch({ family: "intake", key: "enabled", value: true })).toThrow("disk full");
    expect(d.notify).not.toHaveBeenCalled();
  });
});

describe("featurePolicyLayers against the real policy services", () => {
  function real() {
    const db = memDb();
    migrate(db);
    const loop = new LoopPolicies({
      db, now: () => 5,
      products: { productsOf: () => [], product: (id) => (id === 1 ? { name: "Shop" } : null) },
    });
    const svc = { db, productsOf: () => [], productName: (id: number) => (id === 1 ? "Shop" : null), now: () => 5, onChange: vi.fn() };
    const stacks = new StackPolicyService(svc);
    const intake = new IntakePolicyService(svc);
    const result = (f: () => void) => {
      try {
        f();
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, key: (e as { key?: string }).key ?? "?", message: (e as { code?: string }).code ?? String(e) };
      }
    };
    const services: FeaturePolicyServices = {
      loop: { policyView: (s) => loop.view(s), policySet: (s, o) => loop.setLayer(s, o) },
      stacks: { policyView: (s) => stacks.view(s), policySet: (s, o) => result(() => stacks.setLayer(s, o)) },
      intake: { policyView: (s) => intake.view(s), policySet: (s, o) => result(() => intake.setLayer(s, o)) },
    };
    const h = featurePolicyHandlers({ read: () => ({ globals: {}, overrides: [] }), ...featurePolicyLayers(services), notify: vi.fn() });
    const row = (table: string, where: string) => (db.prepare(`SELECT overrides FROM ${table} WHERE ${where}`).get() as { overrides: string } | undefined)?.overrides;
    return { loop, stacks, intake, h, row };
  }

  it("loop: flipping ci.enabled keeps the other global keys, explicit false, and leaves repo rows alone", () => {
    const { loop, h, row } = real();
    loop.setLayer({ kind: "global" }, { "ci.maxReruns": 3, "comments.ignorePatterns": [], "comments.enabled": false });
    loop.setLayer({ kind: "repo", slug: "o/r" }, { "ci.enabled": false, "ci.maxReruns": 1 });
    const repoBefore = row("loop_policies", "repo_slug = 'o/r'");
    h.patch({ family: "loop", key: "ci.enabled", value: true });
    expect(JSON.parse(row("loop_policies", "scope_kind = 'global'")!)).toEqual({ "ci.enabled": true, "ci.maxReruns": 3, "comments.enabled": false, "comments.ignorePatterns": [] });
    expect(row("loop_policies", "repo_slug = 'o/r'")).toBe(repoBefore);
  });

  it("stacks: flipping autoRebase keeps another global stack key and the repo layer", () => {
    const { stacks, h, row } = real();
    stacks.setLayer({ kind: "global" }, { behindCommits: 50, mergeMethod: "squash" });
    stacks.setLayer({ kind: "repo", slug: "o/r" }, { autoRebase: false });
    const repoBefore = row("stack_policies", "repo_slug = 'o/r'");
    h.patch({ family: "stacks", key: "autoRebase", value: true });
    expect(JSON.parse(row("stack_policies", "scope_kind = 'global'")!)).toEqual({ autoRebase: true, behindCommits: 50, mergeMethod: "squash" });
    expect(row("stack_policies", "repo_slug = 'o/r'")).toBe(repoBefore);
    h.patch({ family: "stacks", key: "autoRebase", value: false });
    expect(JSON.parse(row("stack_policies", "scope_kind = 'global'")!)).toEqual({ autoRebase: false, behindCommits: 50, mergeMethod: "squash" });
  });

  it("intake: flipping enabled keeps the other global intake keys", () => {
    const { intake, h, row } = real();
    intake.setLayer({ kind: "global" }, { maxParallel: 2, tierSmall: "low" });
    h.patch({ family: "intake", key: "enabled", value: true });
    expect(JSON.parse(row("intake_policies", "scope_kind = 'global'")!)).toEqual({ enabled: true, maxParallel: 2, tierSmall: "low" });
  });
});
