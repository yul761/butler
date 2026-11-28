import { describe, expect, it } from "vitest";
import { TASK_IDS, TASKS, effectiveRoute, isModelName, isTaskId, routingConfigured, tierAbove, tierBelow, tierRank } from "./model-routing";

describe("task registry", () => {
  it("registers every task id of the master design table with its tier and policy", () => {
    const table: Record<string, [string, string]> = {
      needs_you: ["low", "fallback"], stuck_judge: ["low", "fallback"], conv_qa: ["low", "fallback"], conv_relay: ["low", "fallback"],
      handoff: ["session", "wait"], feature_summary: ["session", "wait"],
      handoff_refresh: ["mid", "fallback"],
      lesson_analyze: ["mid", "fallback"], lesson_enrich: ["mid", "fallback"], lesson_cluster: ["mid", "fallback"],
      lesson_conflict: ["high", "wait"], lesson_clarity: ["mid", "fallback"], lesson_sample_review: ["mid", "wait"],
      lesson_classify: ["low", "fallback"], check_draft: ["high", "wait"], repo_scan_infer: ["mid", "fallback"],
      backtest_judge: ["mid", "fallback"], pre_review: ["high", "wait"], evidence_verify: ["high", "wait"],
      pr_brief: ["mid", "fallback"], comment_classify: ["mid", "fallback"], ci_classify: ["low", "fallback"],
      lesson_merge: ["low", "fallback"], permission_profile: ["low", "fallback"], intake_classify: ["mid", "fallback"], intake_fetch: ["low", "fallback"], model_probe: ["low", "fallback"],
    };
    expect([...TASK_IDS].sort()).toEqual(Object.keys(table).sort());
    // 旧 epic 层的整理任务（BTL-246 去掉了）。
    expect(isTaskId("epic_digest")).toBe(false);
    for (const [id, [tier, policy]] of Object.entries(table)) {
      expect(isTaskId(id)).toBe(true);
      const d = TASKS[id as keyof typeof TASKS];
      expect([d.tier, d.policy], id).toEqual([tier, policy]);
    }
  });

  it("keeps today's model for every existing call site", () => {
    expect(TASKS.needs_you.legacy).toBe("haiku");
    expect(TASKS.stuck_judge.legacy).toBe("haiku");
    expect(TASKS.conv_qa.legacy).toBe("haiku");
    expect(TASKS.handoff_refresh.legacy).toBe("sonnet");
    expect(TASKS.lesson_analyze.legacy).toBeNull();
    expect(TASKS.handoff.legacy).toBe("session");
    expect(TASKS.feature_summary.legacy).toBe("session");
  });

  it("wait tasks do not degrade below their tier by default", () => {
    expect(TASKS.lesson_conflict.minTier).toBe("high");
    expect(TASKS.pre_review.minTier).toBe("high");
    expect(TASKS.lesson_analyze.minTier).toBe("low");
    expect(TASKS.lesson_sample_review.reviewer).toBe(true);
  });

  it("overlays overrides; session tier stays; min tier never above tier", () => {
    expect(effectiveRoute("lesson_analyze", null).overridden).toBe(false);
    const r = effectiveRoute("lesson_analyze", { task: "lesson_analyze", tier: "low", minTier: "high", policy: "wait", critical: true });
    expect(r).toMatchObject({ tier: "low", minTier: "low", policy: "wait", critical: true, overridden: true });
    expect(effectiveRoute("handoff", { task: "handoff", tier: "high" }).tier).toBe("session");
    expect(effectiveRoute("needs_you", { task: "needs_you", policy: null }).policy).toBe("fallback");
  });

  it("tier helpers", () => {
    expect(tierRank("high")).toBeGreaterThan(tierRank("mid"));
    expect(tierBelow("high")).toBe("mid");
    expect(tierBelow("low")).toBeNull();
    expect(tierAbove("low")).toBe("mid");
    expect(tierAbove("high")).toBeNull();
  });

  it("model names", () => {
    for (const ok of ["opus", "claude-opus-5-5", "us.anthropic.claude-x-v1:0", "claude-sonnet-5-5[1m]", "vendor/model@2026"]) expect(isModelName(ok), ok).toBe(true);
    for (const bad of ["", " opus", "-x", "a b", "x;rm", "x".repeat(101), 3, null]) expect(isModelName(bad), String(bad)).toBe(false);
  });

  it("configured means one enabled model", () => {
    expect(routingConfigured({ registry: [] })).toBe(false);
    const m = { name: "a", tier: "high" as const, enabled: false, account: "default", priceIn: null, priceOut: null, note: "" };
    expect(routingConfigured({ registry: [m] })).toBe(false);
    expect(routingConfigured({ registry: [{ ...m, enabled: true }] })).toBe(true);
  });
});
