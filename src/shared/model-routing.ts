import type { LimitKind } from "./availability";

/** 能力档位：任务声明要哪一档，不写模型名（契约 4.1）。 */
export type Tier = "high" | "mid" | "low";
export const TIERS: readonly Tier[] = ["high", "mid", "low"];
/** 撞限策略：降级用链里下一个、等额度恢复、交给用户。 */
export type LimitPolicy = "fallback" | "wait" | "escalate";
export const POLICIES: readonly LimitPolicy[] = ["fallback", "wait", "escalate"];

/** 档位从低到高的序号：low 0、mid 1、high 2。 */
export function tierRank(t: Tier): number {
  return t === "high" ? 2 : t === "mid" ? 1 : 0;
}
export function tierBelow(t: Tier): Tier | null {
  return t === "high" ? "mid" : t === "mid" ? "low" : null;
}
export function tierAbove(t: Tier): Tier | null {
  return t === "low" ? "mid" : t === "mid" ? "high" : null;
}
export function isTier(v: unknown): v is Tier {
  return v === "high" || v === "mid" || v === "low";
}

/** 所有后台任务的 id。调用方还不存在的也先登记（契约 4.1），之后的工作流只 import。 */
export const TASK_IDS = [
  "needs_you", "stuck_judge", "conv_qa", "conv_relay",
  "handoff", "feature_summary",
  "handoff_refresh",
  "lesson_analyze", "lesson_enrich", "lesson_cluster", "lesson_conflict", "lesson_clarity", "lesson_sample_review", "lesson_classify", "lesson_merge",
  "check_draft", "repo_scan_infer", "backtest_judge",
  "pre_review", "evidence_verify", "pr_brief",
  "comment_classify", "ci_classify",
  "permission_profile", "intake_classify", "intake_fetch",
  "model_probe",
] as const;
export type TaskId = (typeof TASK_IDS)[number];
export function isTaskId(v: unknown): v is TaskId {
  return typeof v === "string" && (TASK_IDS as readonly string[]).includes(v);
}

/**
 * 没有配置路由时这个任务用的模型（等于 2.1.0 各调用点的做法）：模型别名；null 是用户默认模型（不传 --model）；
 * "session" 是沿用被 fork 的 session 自己的模型。
 */
export type LegacyModel = string | null | "session";

export interface TaskDef {
  id: TaskId;
  /** "session"：沿用 session 的模型，不传别的 --model，不降级（fork 换模型会让 prompt 缓存整个失效）。 */
  tier: Tier | "session";
  minTier: Tier;
  policy: LimitPolicy;
  /** 到第二个软阈值后，只有关键任务还能用超了阈值的模型。 */
  critical: boolean;
  legacy: LegacyModel;
  /** 独立评审：档位不低于产出方，配置了别的模型时不能和产出方同模型。 */
  reviewer?: boolean;
}

const t = (id: TaskId, tier: TaskDef["tier"], policy: LimitPolicy, o: Partial<Omit<TaskDef, "id" | "tier" | "policy">> = {}): TaskDef => ({
  id, tier, policy,
  minTier: o.minTier ?? (policy === "wait" && tier !== "session" ? tier : "low"),
  critical: o.critical ?? false,
  legacy: o.legacy === undefined ? null : o.legacy,
  ...(o.reviewer && { reviewer: true }),
});

/** 任务注册表（总设计 4.1 的表）。 */
export const TASKS: Readonly<Record<TaskId, TaskDef>> = Object.fromEntries(
  [
    t("needs_you", "low", "fallback", { legacy: "haiku" }),
    t("stuck_judge", "low", "fallback", { legacy: "haiku" }),
    t("conv_qa", "low", "fallback", { legacy: "haiku" }),
    t("conv_relay", "low", "fallback", { legacy: "haiku" }),
    t("handoff", "session", "wait", { legacy: "session" }),
    t("feature_summary", "session", "wait", { legacy: "session" }),
    t("handoff_refresh", "mid", "fallback", { legacy: "sonnet" }),
    t("lesson_analyze", "mid", "fallback"),
    t("lesson_enrich", "mid", "fallback"),
    t("lesson_cluster", "mid", "fallback"),
    t("lesson_conflict", "high", "wait"),
    t("lesson_clarity", "mid", "fallback"),
    t("lesson_sample_review", "mid", "wait", { reviewer: true }),
    t("lesson_classify", "low", "fallback"),
    t("lesson_merge", "low", "fallback", { legacy: "haiku" }),
    t("check_draft", "high", "wait"),
    t("repo_scan_infer", "mid", "fallback"),
    t("backtest_judge", "mid", "fallback"),
    t("pre_review", "high", "wait", { reviewer: true }),
    t("evidence_verify", "high", "wait", { reviewer: true }),
    t("pr_brief", "mid", "fallback"),
    t("comment_classify", "mid", "fallback"),
    t("ci_classify", "low", "fallback"),
    t("permission_profile", "low", "fallback"),
    t("intake_classify", "mid", "fallback"),
    t("intake_fetch", "low", "fallback"),
    t("model_probe", "low", "fallback"),
  ].map((d) => [d.id, d]),
) as Record<TaskId, TaskDef>;

/** 用户对某个任务的覆盖（task_routes 一行）；没写的字段用注册表的默认值。 */
export interface TaskRouteOverride {
  task: TaskId;
  tier?: Tier | null;
  minTier?: Tier | null;
  policy?: LimitPolicy | null;
  critical?: boolean | null;
}

export interface EffectiveRoute extends TaskDef {
  overridden: boolean;
}

/** 注册表默认值叠上用户覆盖。session 任务的档位不能改。最低档高于档位时按档位算。 */
export function effectiveRoute(task: TaskId, o: TaskRouteOverride | null | undefined): EffectiveRoute {
  const d = TASKS[task];
  if (!o) return { ...d, overridden: false };
  const tier = d.tier === "session" ? "session" : (o.tier ?? d.tier);
  let minTier = o.minTier ?? d.minTier;
  if (tier !== "session" && tierRank(minTier) > tierRank(tier)) minTier = tier;
  return { ...d, tier, minTier, policy: o.policy ?? d.policy, critical: o.critical ?? d.critical, overridden: true };
}

const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,99}$/;
/** 能交给 --model 的名字：字母数字开头，只含 . _ - : / @ [ ]，最长 100。 */
export function isModelName(v: unknown): v is string {
  return typeof v === "string" && MODEL_NAME_RE.test(v);
}

/** 没有配置路由时档位对应的别名（交互 session 用）。 */
export const LEGACY_TIER_ALIAS: Readonly<Record<Tier, string>> = { high: "opus", mid: "sonnet", low: "haiku" };

// ---- 配置 ----

export interface RegistryModel {
  name: string;
  tier: Tier;
  enabled: boolean;
  /** 同一个订阅 / 网关下的模型用同一个标签：账号级的限额一起标。 */
  account: string;
  /** 每百万 token 的美元价格（算金额配额用），不填为 null。 */
  priceIn: number | null;
  priceOut: number | null;
  note: string;
}

export type LimitRuleKind = "regex" | "status" | "field" | "reset";
export type LimitRuleSource = "builtin" | "user" | "learned";
export interface LimitRule {
  id: string;
  kind: LimitRuleKind;
  pattern: string;
  /** reset 规则为 null。 */
  category: LimitKind | null;
  accountLevel: boolean;
  source: LimitRuleSource;
  enabled: boolean;
  note: string;
}

export type QuotaUnit = "usd" | "tokens";
export interface Quota {
  /** "tier:high" 或 "model:<名字>"。 */
  target: string;
  unit: QuotaUnit;
  monthly: number;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export interface RoutingConfig {
  registry: RegistryModel[];
  /** 每档的显式顺序；某档没写就用注册表里这一档的模型。 */
  chains: Record<Tier, string[]>;
  overrides: TaskRouteOverride[];
}

export function routingConfigured(c: Pick<RoutingConfig, "registry">): boolean {
  return c.registry.some((m) => m.enabled);
}

// ---- 健康 ----

export type HealthState = "ok" | "limited" | "unavailable" | "probing";
export interface ModelHealthView {
  model: string;
  state: HealthState;
  kind: LimitKind | null;
  until: number | null;
  resetKnown: boolean;
  suspected: boolean;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureText: string | null;
}

// ---- 事件、未识别报错、花费 ----

export type RouteEventKind = "fallback" | "wait" | "limit" | "suspected" | "recovered" | "probe_ok" | "probe_failed" | "session_switch" | "quota_skip";
export interface RouteEvent {
  id: number;
  at: number;
  kind: RouteEventKind;
  task: string | null;
  model: string | null;
  toModel: string | null;
  detail: string | null;
}

export type UnrecognizedStatus = "open" | "confirmed" | "dismissed";
export interface UnrecognizedError {
  id: number;
  fingerprint: string;
  sample: string;
  count: number;
  models: string[];
  firstSeen: number;
  lastSeen: number;
  status: UnrecognizedStatus;
  category: LimitKind | null;
  /** 这条是怎么被当成疑似限额的：通用信号（状态码 / 关键词）还是「同模型连续失败而别的模型成功」。 */
  signal: "generic" | "correlated" | "observed";
}

export type SpendLevel = "ok" | "soft" | "hard";
export interface SpendLine {
  key: string;
  tokens: number;
  usd: number;
  /** 有一部分行既没有记录金额也没有价格：金额偏低。 */
  usdPartial: boolean;
}
export interface QuotaView extends Quota {
  used: number;
  ratio: number;
  level: SpendLevel;
}

export interface TaskRouteView {
  task: TaskId;
  route: EffectiveRoute;
  /** 现在实际会先试的模型；未配置时是 legacy（null = 默认模型）。 */
  first: string | null;
  candidates: string[];
}

export interface RoutingView {
  configured: boolean;
  registry: RegistryModel[];
  chains: Record<Tier, string[]>;
  /** 每档实际的顺序（显式的或注册表推出来的）。 */
  effectiveChains: Record<Tier, string[]>;
  tasks: TaskRouteView[];
  health: ModelHealthView[];
  events: RouteEvent[];
  unrecognized: UnrecognizedError[];
  rules: LimitRule[];
  spend: { periodStart: number; byModel: SpendLine[]; byTask: SpendLine[]; quotas: QuotaView[] };
  discovery: DiscoveryView | null;
  flags: { model: boolean; effort: boolean };
}

/** 交互 session 撞限的提示（session 行和「现在」页）。 */
export interface SessionLimitView {
  sessionId: string;
  model: string | null;
  kind: LimitKind;
  message: string;
  at: number;
  resetsAt: number | null;
  /** 「换下一档继续」会换成的模型；没有可换的为 null。 */
  next: string | null;
  switching: boolean;
}

/** sessions:switchModel 的结果。 */
export type SwitchModelResult =
  | { ok: true; model: string; termId: string }
  | { ok: false; reason: "no_session" | "no_next" | "busy" | "still_running" | "open_failed"; detail?: string };

export type DiscoveryStatus = "available" | "unavailable" | "limited" | "error" | "pending";
export interface DiscoveredModel {
  name: string;
  /** 从哪里看到的：env 变量名、settings.json、help、user。 */
  from: string;
  status: DiscoveryStatus;
  message: string | null;
  suggestedTier: Tier | null;
}
export interface DiscoveryView {
  running: boolean;
  at: number | null;
  models: DiscoveredModel[];
}

export type RoutingAction =
  | { op: "discover" }
  | { op: "addModel"; model: RegistryModel }
  | { op: "updateModel"; name: string; patch: Partial<Omit<RegistryModel, "name">> }
  | { op: "removeModel"; name: string }
  | { op: "moveModel"; name: string; delta: -1 | 1 }
  | { op: "setChain"; tier: Tier; models: string[] }
  | { op: "setTaskRoute"; route: TaskRouteOverride }
  | { op: "clearTaskRoute"; task: TaskId }
  | { op: "clearHealth"; model: string }
  | { op: "probe"; model: string }
  | { op: "confirmError"; id: number; category: LimitKind; accountLevel: boolean }
  | { op: "dismissError"; id: number }
  | { op: "addRule"; rule: Omit<LimitRule, "id" | "source" | "enabled"> }
  | { op: "removeRule"; id: string }
  | { op: "toggleRule"; id: string; enabled: boolean }
  | { op: "rerunDegraded" };
