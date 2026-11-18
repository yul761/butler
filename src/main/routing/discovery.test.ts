import { describe, expect, it, vi } from "vitest";
import { discoveryCandidates, ModelDiscovery, suggestTier } from "./discovery";

const sources = (over: Partial<Parameters<typeof discoveryCandidates>[0]> = {}) => ({
  env: {}, settingsModel: async () => null, recentModels: () => [], registry: () => [], ...over,
});

describe("model discovery", () => {
  it("collects candidates from every source without assuming aliases exist", async () => {
    const c = await discoveryCandidates(sources({
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "corp-big", ANTHROPIC_MODEL: "bad name!" },
      settingsModel: async () => "corp-big",
      recentModels: () => ["claude-sonnet-5-5"],
      registry: () => ["ghost-model"],
    }));
    expect(c).toEqual([
      { name: "ghost-model", from: "registry" },
      { name: "corp-big", from: "ANTHROPIC_DEFAULT_OPUS_MODEL" },
      { name: "claude-sonnet-5-5", from: "usage" },
      { name: "opus", from: "alias" }, { name: "sonnet", from: "alias" }, { name: "haiku", from: "alias" },
    ]);
  });

  it("suggests tiers from names and env keys", () => {
    expect(suggestTier("corp-big", "ANTHROPIC_DEFAULT_OPUS_MODEL")).toBe("high");
    expect(suggestTier("claude-haiku-5-5")).toBe("low");
    expect(suggestTier("gpt-x")).toBeNull();
  });

  it("probes each candidate and reports missing ones", async () => {
    const onResult = vi.fn();
    const d = new ModelDiscovery({
      ...sources({ registry: () => ["ghost"] }), now: () => 1, onResult,
      probe: async (m) =>
        m === "ghost" ? { ok: false, hit: { kind: "model_unavailable", resetsAt: null, message: "nope" }, message: "There's an issue with the selected model" }
        : m === "haiku" ? { ok: false, hit: { kind: "rate_limit", resetsAt: null, message: "429" }, message: "429" }
        : { ok: true },
    });
    await d.run();
    expect(d.view()!.running).toBe(false);
    expect(d.view()!.models.map((m) => [m.name, m.status])).toEqual([["ghost", "unavailable"], ["opus", "available"], ["sonnet", "available"], ["haiku", "limited"]]);
    expect(onResult).toHaveBeenCalledTimes(4);
  });
});
