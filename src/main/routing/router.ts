import {
  TIERS, effectiveRoute, routingConfigured, tierAbove, tierBelow, tierRank,
  type EffectiveRoute, type LimitPolicy, type RoutingConfig, type SpendLevel, type TaskId, type Tier,
} from "../../shared/model-routing";

export interface Candidate {
  model: string;
  tier: Tier;
}

export type SkipReason = "limited" | "quota_soft" | "quota_hard" | "producer";
export interface Skipped extends Candidate {
  reason: SkipReason;
  /** 预计能用的时间（撞限的恢复时间，或配额周期结束）。 */
  until: number | null;
}

export type Plan =
  /** 不走路由：用 2.1.0 的做法（model 为 null 是不传 --model，用户默认模型）。 */
  | { mode: "legacy"; model: string | null; route: EffectiveRoute; why: "unconfigured" | "no_models" | "session_unknown" }
  | {
      mode: "routed";
      route: EffectiveRoute;
      requestedTier: Tier;
      candidates: Candidate[];
      /** 没有限额和配额时会用的模型：实际用的不是它，结果就是降级来的（fallback_from）。 */
      preferred: string;
      skipped: Skipped[];
      /** 评审任务没有别的模型可用，只能和产出方同模型。 */
      sameModelReview: boolean;
    }
  | { mode: "wait"; route: EffectiveRoute; requestedTier: Tier; until: number; skipped: Skipped[] };

export interface PlanInput {
  task: TaskId;
  config: RoutingConfig;
  now: number;
  usable: (model: string) => boolean;
  recoversAt: (model: string) => number | null;
  spendLevel: (model: string, tier: Tier) => SpendLevel;
  /** 配额周期结束的时间（超配额跳过的模型那时恢复）。 */
  periodEnd: number;
  /** session 任务：被 fork 的 session 的模型（不知道为 null）。 */
  sessionModel?: string | null;
  /** 评审任务：产出方用的模型和档位。 */
  producer?: Candidate | null;
}

/** 某一档的顺序：显式链，没写就是注册表里这一档启用的模型（注册表顺序）。注册了但停用的不要。 */
export function tierChain(config: RoutingConfig, tier: Tier): string[] {
  const disabled = new Set(config.registry.filter((m) => !m.enabled).map((m) => m.name));
  const explicit = config.chains[tier] ?? [];
  const list = explicit.length > 0 ? explicit : config.registry.filter((m) => m.enabled && m.tier === tier).map((m) => m.name);
  return [...new Set(list)].filter((n) => !disabled.has(n));
}

export function effectiveChains(config: RoutingConfig): Record<Tier, string[]> {
  return Object.fromEntries(TIERS.map((t) => [t, tierChain(config, t)])) as Record<Tier, string[]>;
}

/** 注册表里这个模型的档位；不在注册表（链里直接写的名字）为 null。 */
export function registryTier(config: RoutingConfig, model: string): Tier | null {
  return config.registry.find((m) => m.name === model)?.tier ?? null;
}

/** 起始档往下到最低档，去重；全空就从起始档往上找（更强的模型总是可以）。 */
export function candidatesFor(config: RoutingConfig, start: Tier, minTier: Tier): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const take = (tier: Tier) => {
    for (const model of tierChain(config, tier)) {
      if (seen.has(model)) continue;
      seen.add(model);
      out.push({ model, tier });
    }
  };
  for (let t: Tier | null = start; t !== null && tierRank(t) >= tierRank(minTier); t = tierBelow(t)) take(t);
  for (let t = tierAbove(start); out.length === 0 && t !== null; t = tierAbove(t)) take(t);
  return out;
}

function quotaSkip(level: SpendLevel, policy: LimitPolicy, critical: boolean): SkipReason | null {
  if (critical || level === "ok") return null;
  if (level === "hard") return "quota_hard";
  return policy === "fallback" ? "quota_soft" : null;
}

/** 任务 → 要试的模型顺序，或者「等到什么时候」。纯函数，没有 I/O。 */
export function planTask(i: PlanInput): Plan {
  const override = i.config.overrides.find((o) => o.task === i.task);
  const route = effectiveRoute(i.task, override);
  const configured = routingConfigured(i.config);

  if (route.tier === "session") {
    const model = i.sessionModel ?? null;
    if (!configured) return { mode: "legacy", model, route, why: "unconfigured" };
    if (model === null) return { mode: "legacy", model: null, route, why: "session_unknown" };
    // session 任务不换模型、不降级：这个模型撞限就等。
    const tier = registryTier(i.config, model) ?? "high";
    if (!i.usable(model)) {
      const until = i.recoversAt(model) ?? i.now;
      return { mode: "wait", route, requestedTier: tier, until, skipped: [{ model, tier, reason: "limited", until }] };
    }
    return { mode: "routed", route, requestedTier: tier, candidates: [{ model, tier }], preferred: model, skipped: [], sameModelReview: false };
  }

  if (!configured) return { mode: "legacy", model: route.legacy === "session" ? (i.sessionModel ?? null) : route.legacy, route, why: "unconfigured" };

  let start: Tier = route.tier;
  if (route.reviewer && i.producer && tierRank(i.producer.tier) > tierRank(start)) start = i.producer.tier;
  // 评审：最低档也不低于产出方。
  let minTier: Tier = tierRank(route.minTier) > tierRank(start) ? start : route.minTier;
  if (route.reviewer && i.producer && tierRank(i.producer.tier) > tierRank(minTier)) minTier = i.producer.tier;
  let all = candidatesFor(i.config, start, minTier);
  if (all.length === 0) return { mode: "legacy", model: route.legacy === "session" ? null : route.legacy, route, why: "no_models" };

  const skipped: Skipped[] = [];
  let sameModelReview = false;
  if (route.reviewer && i.producer) {
    const others = all.filter((c) => c.model !== i.producer!.model);
    if (others.length > 0) {
      for (const c of all) if (c.model === i.producer.model) skipped.push({ ...c, reason: "producer", until: null });
      all = others;
    } else sameModelReview = true;
  }

  const candidates: Candidate[] = [];
  for (const c of all) {
    if (!i.usable(c.model)) {
      skipped.push({ ...c, reason: "limited", until: i.recoversAt(c.model) });
      continue;
    }
    const q = quotaSkip(i.spendLevel(c.model, c.tier), route.policy, route.critical);
    if (q) {
      skipped.push({ ...c, reason: q, until: i.periodEnd });
      continue;
    }
    candidates.push(c);
  }
  if (candidates.length > 0) return { mode: "routed", route, requestedTier: start, candidates, preferred: all[0]!.model, skipped, sameModelReview };
  const times = skipped.filter((s) => s.reason !== "producer").map((s) => s.until ?? i.now);
  return { mode: "wait", route, requestedTier: start, until: times.length > 0 ? Math.min(...times) : i.now, skipped };
}
