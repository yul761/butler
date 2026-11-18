/**
 * 成本熔断（工作流 L，设计 addendum 第 4 节）：每个 session / ticket 的花费上限和到上限以后怎么办。
 * 上限经契约 4.2 的三层（全局 → 产品 → 仓库）配置；默认都不设，和 2.1.0 一样。
 */
import type { PolicyScope } from "./admission-policy";

export const COST_UNITS = ["usd", "tokens"] as const;
export type CostUnit = (typeof COST_UNITS)[number];

/** 到上限：先降一档、还超就暂停；或者直接暂停。 */
export const COST_ACTIONS = ["downgrade_then_pause", "pause"] as const;
export type CostAction = (typeof COST_ACTIONS)[number];

/** 暂停什么：整个 session（交互的也停），或者只停它的后台任务。 */
export const COST_PAUSE_SCOPES = ["session", "background"] as const;
export type CostPauseScope = (typeof COST_PAUSE_SCOPES)[number];

export interface CostPolicy {
  unit: CostUnit;
  /** 一个 session（含 /clear 换出来的整条链）一共能花多少；null 不限。 */
  sessionCap: number | null;
  /** 一个 ticket 下所有 session 加上归到它的后台调用一共能花多少；null 不限。 */
  ticketCap: number | null;
  action: CostAction;
  pauseScope: CostPauseScope;
  /** 降档以后再超出上限这么多（百分比）才暂停。 */
  graceAfterDowngradePercent: number;
  /** 「继续并提高上限」一次加上限的多少（百分比）。 */
  raisePercent: number;
}

export type CostPolicyKey = keyof CostPolicy;

export const COST_POLICY_DEFAULTS: CostPolicy = {
  unit: "usd",
  sessionCap: null,
  ticketCap: null,
  action: "downgrade_then_pause",
  pauseScope: "session",
  graceAfterDowngradePercent: 20,
  raisePercent: 50,
};

export const COST_POLICY_KEYS: readonly CostPolicyKey[] = ["sessionCap", "ticketCap", "unit", "action", "pauseScope", "graceAfterDowngradePercent", "raisePercent"];

/** 一层自己设的值；键不在 = 继承，上限为 null = 这一层明确「不限」。 */
export type CostPolicyOverrides = Partial<CostPolicy>;

export type CostPolicyValue = CostPolicy[CostPolicyKey];

/** 一个键的值不合法：key 是哪个键，code 是哪种错（main 按语言出文案）。 */
export class CostPolicyError extends Error {
  constructor(readonly key: string, readonly code: "unknown_key" | "bad_cap" | "bad_unit" | "bad_action" | "bad_scope" | "bad_percent") {
    super(`${key}: ${code}`);
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 上限最大 1e12（美元或加权 token 都够了）。 */
const MAX_CAP = 1e12;

function check(key: string, v: unknown): CostPolicyValue {
  switch (key) {
    case "sessionCap":
    case "ticketCap":
      if (v === null) return null;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_CAP) throw new CostPolicyError(key, "bad_cap");
      return v;
    case "unit":
      if (!COST_UNITS.includes(v as CostUnit)) throw new CostPolicyError(key, "bad_unit");
      return v as CostUnit;
    case "action":
      if (!COST_ACTIONS.includes(v as CostAction)) throw new CostPolicyError(key, "bad_action");
      return v as CostAction;
    case "pauseScope":
      if (!COST_PAUSE_SCOPES.includes(v as CostPauseScope)) throw new CostPolicyError(key, "bad_scope");
      return v as CostPauseScope;
    case "graceAfterDowngradePercent":
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1000) throw new CostPolicyError(key, "bad_percent");
      return v;
    case "raisePercent":
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1000) throw new CostPolicyError(key, "bad_percent");
      return v;
    default:
      throw new CostPolicyError(key, "unknown_key");
  }
}

/** 校验一层的覆盖（设置页保存时用）：有不合法的抛 CostPolicyError；undefined 的键丢掉。 */
export function parseCostOverrides(raw: unknown): CostPolicyOverrides {
  if (!isPlain(raw)) throw new CostPolicyError("*", "unknown_key");
  const out: Record<string, CostPolicyValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k] = check(k, v);
  }
  return out as CostPolicyOverrides;
}

/** 从库里读出来的：不合法的键丢掉，不抛（坏了的一层当作没设）。 */
export function sanitizeCostOverrides(raw: unknown): CostPolicyOverrides {
  if (!isPlain(raw)) return {};
  const out: Record<string, CostPolicyValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = check(k, v);
    } catch {
      // 丢掉
    }
  }
  return out as CostPolicyOverrides;
}

export interface CostPolicyKeyView {
  key: CostPolicyKey;
  effective: CostPolicyValue;
  origin: { kind: "default" } | { kind: "global" } | { kind: "product"; productId: number; name: string } | { kind: "repo"; slug: string };
  /** 这一层自己设了吗（设成 null 的上限也算设了）。 */
  set: boolean;
  override: CostPolicyValue;
}

export interface CostPolicyView {
  scope: PolicyScope;
  keys: CostPolicyKeyView[];
}

// ---- 熔断状态 ----

export type CostSubjectKind = "session" | "ticket";
export type CostState = "ok" | "warned" | "downgraded" | "paused";

export const COST_EVENT_KINDS = ["warn", "downgrade", "pause", "stop", "takeover", "resume", "raise"] as const;
export type CostEventKind = (typeof COST_EVENT_KINDS)[number];

/** 「现在」页、session 行、设置页显示的一条熔断状态（state 为 ok 的不出现）。 */
export interface CostBreakerView {
  subjectKind: CostSubjectKind;
  /** session 是链的根 id，ticket 是 key。 */
  subjectId: string;
  /** 「打开」去哪儿：session 的当前 head；ticket 的最近一个 session（没有为 null）。 */
  sessionId: string | null;
  ticketKey: string | null;
  title: string;
  state: Exclude<CostState, "ok">;
  spent: number;
  /** 生效的上限（提高过就是提高后的）。 */
  cap: number;
  unit: CostUnit;
  /** usd 时有估不出价格的用量：实际花的比显示的多。 */
  partial: boolean;
  pauseScope: CostPauseScope;
  fromModel: string | null;
  toModel: string | null;
  trippedAt: number | null;
  pausedAt: number | null;
  /** 暂停后还在花钱，Butler 结束了它的终端。 */
  stoppedAt: number | null;
  /** 用户自己往暂停的终端里打了字（自己接手了，Butler 不再结束它）。 */
  takenOver: boolean;
}

export type CostResumeResult = { ok: true; cap: number } | { ok: false; reason: "not_found" | "not_tripped" };
