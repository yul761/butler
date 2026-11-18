/**
 * 准入策略的全部键（Butler 3 总设计第 6 节的默认值）。键是扁平的点分名，每个键能在全局 / 产品 / 仓库任一层单独覆盖（契约 4.2）。
 * 这些默认值还没校准过：校准界面出来之前页面上标「未校准的默认值」。
 */

export type PolicyGroup = "score" | "batch" | "dedupe" | "generality" | "backtest" | "shadow" | "conflict" | "demote" | "admission";
export const POLICY_GROUPS: readonly PolicyGroup[] = ["score", "batch", "dedupe", "generality", "backtest", "shadow", "conflict", "demote", "admission"];

export type PolicyKeyDef =
  | { key: string; group: PolicyGroup; kind: "number"; min: number; max: number; default: number }
  | { key: string; group: PolicyGroup; kind: "int"; min: number; max: number; default: number }
  | { key: string; group: PolicyGroup; kind: "bool"; default: boolean }
  | { key: string; group: PolicyGroup; kind: "enum"; options: readonly string[]; default: string };

const n = (key: string, group: PolicyGroup, d: number, min = 0, max = 1): PolicyKeyDef => ({ key, group, kind: "number", min, max, default: d });
const i = (key: string, group: PolicyGroup, d: number, min: number, max: number): PolicyKeyDef => ({ key, group, kind: "int", min, max, default: d });
const b = (key: string, group: PolicyGroup, d: boolean): PolicyKeyDef => ({ key, group, kind: "bool", default: d });

export const ADMISSION_POLICY_KEYS = [
  n("score.weight.evidence", "score", 0.3),
  n("score.weight.clarity", "score", 0.2),
  n("score.weight.consistency", "score", 0.2),
  n("score.weight.verifiability", "score", 0.3),
  n("score.weight.performance", "score", 0),
  n("score.admitLine", "score", 0.7),
  n("score.dropLine", "score", 0.3),
  n("score.proseAdmitLine", "score", 0.8),
  n("score.untestedCap", "score", 0.69),
  n("score.reviewerBonus", "score", 0.05),
  i("score.recencyHalfLifeDays", "score", 180, 1, 3650),
  n("score.degradedPenalty", "score", 0.1),
  i("score.evidenceFullHits", "score", 5, 1, 1000),
  i("score.evidenceFullPrs", "score", 3, 1, 1000),
  n("score.minClarity", "score", 0.4),
  i("batch.sampleSize", "batch", 20, 1, 1000),
  n("batch.minSamplePassRate", "batch", 0.8),
  n("batch.minCoverage", "batch", 0.3),
  n("batch.maxShelvedShare", "batch", 0.7),
  n("batch.minBacktestRecall", "batch", 0.01),
  n("batch.maxBacktestFalsePositiveRate", "batch", 0.2),
  n("dedupe.minSimilarity", "dedupe", 0.35),
  i("dedupe.maxGroup", "dedupe", 30, 2, 100),
  i("generality.minHits", "generality", 2, 0, 1000),
  i("generality.minPrs", "generality", 2, 0, 1000),
  i("generality.minReviewers", "generality", 0, 0, 100),
  b("generality.allowSingleReviewer", "generality", true),
  i("backtest.recentPrs", "backtest", 50, 1, 1000),
  n("backtest.minRecall", "backtest", 0.01),
  n("backtest.maxFalsePositiveRate", "backtest", 0.2),
  b("backtest.allowUntestedShadow", "backtest", true),
  i("shadow.minPrs", "shadow", 5, 0, 1000),
  i("shadow.minDays", "shadow", 7, 0, 365),
  n("shadow.maxFalsePositiveRate", "shadow", 0.2),
  n("shadow.minAdoption", "shadow", 0.6),
  b("shadow.autoPromote", "shadow", false),
  b("conflict.autoPickHigherHits", "conflict", false),
  b("demote.enabled", "demote", true),
  n("demote.maxBypassRate", "demote", 0.3),
  i("demote.noReductionPrs", "demote", 10, 1, 1000),
  { key: "demote.to", group: "demote", kind: "enum", options: ["shadow", "review"], default: "shadow" },
  b("admission.autoConfirm", "admission", false),
] as const satisfies readonly PolicyKeyDef[];

export type AdmissionPolicyKey = (typeof ADMISSION_POLICY_KEYS)[number]["key"];
export type PolicyValue = number | boolean | string;
export type AdmissionPolicy = Record<AdmissionPolicyKey, PolicyValue>;
export type AdmissionPolicyOverrides = Partial<AdmissionPolicy>;

const DEFS = new Map<string, PolicyKeyDef>(ADMISSION_POLICY_KEYS.map((d) => [d.key, d]));

export const ADMISSION_POLICY_DEFAULTS = Object.fromEntries(ADMISSION_POLICY_KEYS.map((d) => [d.key, d.default])) as AdmissionPolicy;

export function policyKeyDef(key: string): PolicyKeyDef | undefined {
  return DEFS.get(key);
}

export class PolicyValueError extends Error {
  constructor(readonly key: string, readonly problem: "unknown_key" | "bad_value") {
    super(`${problem}: ${key}`);
  }
}

/** 一个值合不合法；合法时返回规范后的值。 */
export function checkPolicyValue(key: string, v: unknown): PolicyValue {
  const d = DEFS.get(key);
  if (!d) throw new PolicyValueError(key, "unknown_key");
  switch (d.kind) {
    case "number":
      if (typeof v !== "number" || !Number.isFinite(v) || v < d.min || v > d.max) throw new PolicyValueError(key, "bad_value");
      return v;
    case "int":
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < d.min || v > d.max) throw new PolicyValueError(key, "bad_value");
      return v;
    case "bool":
      if (typeof v !== "boolean") throw new PolicyValueError(key, "bad_value");
      return v;
    case "enum":
      if (typeof v !== "string" || !d.options.includes(v)) throw new PolicyValueError(key, "bad_value");
      return v;
  }
}

/** 一层的覆盖：不认识的键、越界的值都拒绝；undefined / null = 不覆盖（继承）。 */
export function parsePolicyOverrides(v: unknown): AdmissionPolicyOverrides {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PolicyValueError("", "bad_value");
  const out: Record<string, PolicyValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (x === undefined || x === null) continue;
    out[k] = checkPolicyValue(k, x);
  }
  return out as AdmissionPolicyOverrides;
}

/** 存在库里的覆盖读回来：坏的键和值丢掉（不让一行坏数据挡住整个策略）。 */
export function sanitizePolicyOverrides(v: unknown): AdmissionPolicyOverrides {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, PolicyValue> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    try {
      out[k] = checkPolicyValue(k, x);
    } catch {
      // 跳过。
    }
  }
  return out as AdmissionPolicyOverrides;
}

/** 策略编辑器的一层：每个键的生效值、来源、这一层自己的覆盖。 */
export type PolicyScope = { kind: "global" } | { kind: "product"; productId: number } | { kind: "repo"; slug: string };

export interface PolicyKeyView {
  key: AdmissionPolicyKey;
  effective: PolicyValue;
  /** default / global / product / repo；product 时带名字。 */
  origin: { kind: "default" } | { kind: "global" } | { kind: "product"; productId: number; name: string } | { kind: "repo"; slug: string };
  /** 这一层自己设的值；没设 = 继承。 */
  override: PolicyValue | null;
}

export interface AdmissionPolicyView {
  scope: PolicyScope;
  keys: PolicyKeyView[];
  /** 同一个仓库的几个产品把同一个键设得不一样（只在仓库层有）。 */
  conflicts: { key: string; products: { id: number; name: string; value: PolicyValue }[] }[];
  version: number;
  /** 有没有校准过（还没有校准界面时永远 false：页面标「未校准的默认值」）。 */
  calibrated: boolean;
}
