import { describe, expect, it } from "vitest";
import type { Plan } from "../routing/router";
import { routingQuota, type RoutingQuotaSource } from "./routing-quota";

const quota = (level: "ok" | "soft" | "hard", ratio: number) => ({ target: "tier:high", monthly: 100, unit: "usd" as const, used: ratio * 100, ratio, level });

function src(o: { configured?: boolean; quotas?: ReturnType<typeof quota>[]; plan?: Partial<Plan> }): RoutingQuotaSource {
  return {
    configured: () => o.configured ?? true,
    spend: () => ({ byModel: [], byTask: [], quotas: o.quotas ?? [], level: (m) => (m === "opus" ? "soft" : "ok"), periodEnd: 99 }),
    plan: () => ({ mode: "routed", preferred: "opus", requestedTier: "high", ...o.plan }) as Plan,
  };
}

describe("routingQuota", () => {
  it("is null without routing or quotas", () => {
    expect(routingQuota(src({ configured: false, quotas: [quota("hard", 1)] }))).toBeNull();
    expect(routingQuota(src({ quotas: [] }))).toBeNull();
  });

  it("reads the task's preferred model, treats waiting as hard, and takes the highest quota without a task", () => {
    const q = routingQuota(src({ quotas: [quota("ok", 0.2), quota("soft", 0.85)] }))!;
    expect(q.level("handoff")).toBe("soft");
    expect(q.level(null)).toBe("soft");
    expect(q.maxRatio()).toBe(0.85);
    expect(q.until()).toBe(99);
    expect(routingQuota(src({ quotas: [quota("ok", 0)], plan: { mode: "wait" } as Partial<Plan> }))!.level("handoff")).toBe("hard");
    expect(routingQuota(src({ quotas: [quota("ok", 0)], plan: { mode: "legacy" } as Partial<Plan> }))!.level("handoff")).toBe("ok");
  });
});
