import { describe, expect, it, vi } from "vitest";
import type { PolicyFamily } from "../../shared/feature-rows";
import { featurePolicyHandlers, type FeaturePolicyDeps } from "./feature-policy-handlers";

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
