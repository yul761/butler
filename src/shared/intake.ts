/**
 * 自动接活（工作流 N，设计 docs/superpowers/specs/2026-11-17-ws-n-intake-design.md）：
 * 来源里的 ticket → 分类（大小、风险、要不要先澄清）→ 选档位 → 自动开 session 或进队列 → 只在需要人决定时提醒。
 * 三层策略（契约 4.2）的 enabled 默认关，都不配时和以前完全一样。
 */
import type { PolicyScope } from "./admission-policy";
import type { Tier } from "./model-routing";

/** 规则版本：规则改了就加一，分类结果和用户改分类的记录都带着它（校准用）。 */
export const INTAKE_RULES_VERSION = 1;

export const INTAKE_SOURCES = ["none", "tracker", "file"] as const;
export type IntakeSourceKind = (typeof INTAKE_SOURCES)[number];

export const INTAKE_SIZES = ["small", "medium", "large"] as const;
export type IntakeSize = (typeof INTAKE_SIZES)[number];

export const INTAKE_RISKS = ["low", "medium", "high"] as const;
export type IntakeRisk = (typeof INTAKE_RISKS)[number];

/** 缺的信息：描述、复现步骤、验收标准。 */
export const INTAKE_MISSING = ["description", "repro_steps", "acceptance_criteria"] as const;
export type IntakeMissing = (typeof INTAKE_MISSING)[number];

export const INTAKE_STATES = [
  "needs_repo", "needs_clarification", "needs_decision", "held", "queued", "waiting", "started", "split", "skipped", "exists", "failed",
] as const;
export type IntakeState = (typeof INTAKE_STATES)[number];

/** 这几种状态要人决定：进入时提醒一次。 */
export const INTAKE_DECISION_STATES: readonly IntakeState[] = ["needs_repo", "needs_clarification", "needs_decision", "failed"];

/** 等什么（queued / waiting / held 的原因）。 */
export const INTAKE_WAIT_REASONS = [
  "parallel", "conflict", "memory", "cost", "stack", "retry", "auto_off", "too_large", "too_risky", "prereview_off", "manual",
] as const;
export type IntakeWaitReason = (typeof INTAKE_WAIT_REASONS)[number];

export const INTAKE_CLASS_SOURCES = ["rules", "model", "mixed", "user"] as const;
export type IntakeClassSource = (typeof INTAKE_CLASS_SOURCES)[number];

export const INTAKE_DIMS = ["size", "risk", "clarify"] as const;
export type IntakeDim = (typeof INTAKE_DIMS)[number];

/** 来源给的一个 ticket（都已限长、清理过）。 */
export interface IncomingTicket {
  key: string;
  title: string;
  description: string;
  type: string | null;
  labels: string[];
  priority: string | null;
  url: string | null;
  storyPoints: number | null;
  components: string[];
  subtasks: { key: string; title: string }[];
  /** 来源直接说了放哪个仓库（file 来源可以写路径）。 */
  repo: string | null;
  /** 父 epic（BTL-246 §7：按它分组进 Butler 的 epic）；没有时不带这个字段（以前存的 payload 也没有）。 */
  epic?: { key: string; title: string | null };
}

/** 一条分类理由：哪一维、哪条规则（或 model / user）、说明。 */
export interface IntakeReason {
  dim: IntakeDim | "paths" | "tier" | "conflict";
  rule: string;
  detail: string;
}

export interface IntakeClassification {
  size: IntakeSize | null;
  risk: IntakeRisk | null;
  clarify: boolean;
  missing: IntakeMissing[];
  questions: string[];
  expectedPaths: string[];
  reasons: IntakeReason[];
  source: IntakeClassSource;
  rulesVersion: number;
  confidence: number | null;
  model: string | null;
}

export const CLARIFY_MODES = ["notify", "session", "coordinator"] as const;
export type ClarifyMode = (typeof CLARIFY_MODES)[number];

export const CONFLICT_ACTIONS = ["serialize", "parallel"] as const;
export type ConflictAction = (typeof CONFLICT_ACTIONS)[number];

export interface IntakePolicy {
  /** 总开关：这一层（全局 / 产品 / 仓库）的 ticket 要不要自动接。默认关。 */
  enabled: boolean;
  /** 分类完满足条件就自动开工；关着时只分类、排好，等人点「开工」。 */
  autoStart: boolean;
  /** 自动开工的大小、风险上限（含）。 */
  maxSize: IntakeSize;
  maxRisk: IntakeRisk;
  /** 由自动接活开的、session 还开着的 ticket 最多几个（用户自己开的不算）。 */
  maxParallel: number;
  /** 同仓库预计改到同一批路径：排队串行，或照样并行（只记一笔）。 */
  conflictAction: ConflictAction;
  /** 缺信息时：只提醒你、开 session 回 tracker 提问、交给 Butler 总控去问。 */
  clarifyMode: ClarifyMode;
  /** 模型分类的把握低于这个就算拿不准（0–1）。 */
  uncertainBelow: number;
  /** 大 ticket、来源里有 ≥2 个子任务：拆成 K 的栈，一层一个子任务。 */
  stackSubtasks: boolean;
  tierSmall: Tier;
  tierMedium: Tier;
  tierLarge: Tier;
  tierMediumRisk: Tier;
  tierHighRisk: Tier;
}

export type IntakePolicyKey = keyof IntakePolicy;

export const INTAKE_POLICY_DEFAULTS: IntakePolicy = {
  enabled: false,
  autoStart: true,
  maxSize: "large",
  maxRisk: "high",
  maxParallel: 2,
  conflictAction: "serialize",
  clarifyMode: "notify",
  uncertainBelow: 0.6,
  stackSubtasks: true,
  tierSmall: "mid",
  tierMedium: "mid",
  tierLarge: "high",
  tierMediumRisk: "mid",
  tierHighRisk: "high",
};

export const INTAKE_POLICY_KEYS: readonly IntakePolicyKey[] = [
  "enabled", "autoStart", "maxSize", "maxRisk", "maxParallel", "conflictAction", "clarifyMode", "uncertainBelow", "stackSubtasks",
  "tierSmall", "tierMedium", "tierLarge", "tierMediumRisk", "tierHighRisk",
];

export type IntakePolicyOverrides = Partial<IntakePolicy>;
export type IntakePolicyValue = IntakePolicy[IntakePolicyKey];

export type IntakePolicyErrorCode = "unknown_key" | "bad_bool" | "bad_size" | "bad_risk" | "bad_count" | "bad_choice" | "bad_ratio" | "bad_tier";

export class IntakePolicyError extends Error {
  constructor(readonly key: string, readonly code: IntakePolicyErrorCode) {
    super(`${key}: ${code}`);
  }
}

const TIERS: readonly Tier[] = ["high", "mid", "low"];
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function check(key: string, v: unknown): IntakePolicyValue {
  switch (key) {
    case "enabled":
    case "autoStart":
    case "stackSubtasks":
      if (typeof v !== "boolean") throw new IntakePolicyError(key, "bad_bool");
      return v;
    case "maxSize":
      if (!INTAKE_SIZES.includes(v as IntakeSize)) throw new IntakePolicyError(key, "bad_size");
      return v as IntakeSize;
    case "maxRisk":
      if (!INTAKE_RISKS.includes(v as IntakeRisk)) throw new IntakePolicyError(key, "bad_risk");
      return v as IntakeRisk;
    case "maxParallel":
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 50) throw new IntakePolicyError(key, "bad_count");
      return v;
    case "conflictAction":
      if (!CONFLICT_ACTIONS.includes(v as ConflictAction)) throw new IntakePolicyError(key, "bad_choice");
      return v as ConflictAction;
    case "clarifyMode":
      if (!CLARIFY_MODES.includes(v as ClarifyMode)) throw new IntakePolicyError(key, "bad_choice");
      return v as ClarifyMode;
    case "uncertainBelow":
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new IntakePolicyError(key, "bad_ratio");
      return v;
    case "tierSmall":
    case "tierMedium":
    case "tierLarge":
    case "tierMediumRisk":
    case "tierHighRisk":
      if (!TIERS.includes(v as Tier)) throw new IntakePolicyError(key, "bad_tier");
      return v as Tier;
    default:
      throw new IntakePolicyError(key, "unknown_key");
  }
}

/** 设置页保存一层：不合法抛 IntakePolicyError；undefined 的键丢掉。 */
export function parseIntakeOverrides(raw: unknown): IntakePolicyOverrides {
  if (!isPlain(raw)) throw new IntakePolicyError("*", "unknown_key");
  const out: Record<string, IntakePolicyValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k] = check(k, v);
  }
  return out as IntakePolicyOverrides;
}

/** 从库里读的：坏的键丢掉，不抛。 */
export function sanitizeIntakeOverrides(raw: unknown): IntakePolicyOverrides {
  if (!isPlain(raw)) return {};
  const out: Record<string, IntakePolicyValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = check(k, v);
    } catch {
      // 丢掉
    }
  }
  return out as IntakePolicyOverrides;
}

export interface IntakePolicyKeyView {
  key: IntakePolicyKey;
  effective: IntakePolicyValue;
  origin: { kind: "default" } | { kind: "global" } | { kind: "product"; productId: number; name: string } | { kind: "repo"; slug: string };
  set: boolean;
  override: IntakePolicyValue | null;
}

export interface IntakePolicyView {
  scope: PolicyScope;
  keys: IntakePolicyKeyView[];
  layers: { scope: PolicyScope; label: string; overrides: IntakePolicyOverrides }[];
}

export type IntakePolicySetResult = { ok: true } | { ok: false; key: string; message: string };

/** 队列里的一行。 */
export interface IntakeItemView {
  key: string;
  title: string;
  url: string | null;
  source: IntakeSourceKind;
  repoPath: string | null;
  repoSlug: string | null;
  state: IntakeState;
  waitReason: IntakeWaitReason | null;
  detail: string | null;
  classification: IntakeClassification;
  /** 用户改过的维度。 */
  userDims: IntakeDim[];
  tier: Tier | null;
  model: string | null;
  allowParallel: boolean;
  parentKey: string | null;
  layer: number | null;
  ticketKey: string | null;
  /** 开工后 PR 的风险和就绪（只读 G 的表；还没 PR 为 null）。 */
  pr: { number: number; url: string | null; risk: IntakeRisk | null; ready: boolean | null } | null;
  firstSeenAt: number;
  updatedAt: number;
  startedAt: number | null;
}

export interface IntakeView {
  /** 来源配了、至少一层开了。 */
  active: boolean;
  source: IntakeSourceKind;
  /** 自动开工要求 G 的预审开着。 */
  preReviewOn: boolean;
  lastPollAt: number | null;
  lastPollError: string | null;
  polling: boolean;
  /** 现在由接活开着的 ticket 数。 */
  running: number;
  items: IntakeItemView[];
  /** 已知的仓库（选仓库用）。 */
  repos: { path: string; slug: string | null }[];
}

/** 「现在」页的「自动接活」记录：最近自动做了什么。 */
export interface IntakeRecentEntry {
  at: number;
  key: string;
  what: "started" | "queued" | "waiting" | "held" | "split" | "clarify_asked";
  detail: string | null;
}

export type IntakeAction =
  | { op: "start"; key: string }
  | { op: "skip"; key: string }
  | { op: "allowParallel"; key: string }
  | { op: "clarified"; key: string }
  | { op: "retry"; key: string }
  | { op: "setRepo"; key: string; repoPath: string };

export type IntakeActResult = { ok: true } | { ok: false; message: string };

export interface IntakeClassifyEdit {
  key: string;
  size?: IntakeSize;
  risk?: IntakeRisk;
  clarify?: boolean;
}

/** 「效果」页的「自动接活」卡片。 */
export interface IntakeEffect {
  days: number;
  classified: number;
  autoStarted: number;
  manualStarted: number;
  clarify: number;
  decisions: number;
  overriddenItems: number;
  /** 改过的项 / 分类过的项；没分类过为 null。 */
  overrideRate: number | null;
  byDim: { dim: IntakeDim; n: number }[];
}

/** 「现在」页的一条接活提醒（要你决定的项）。 */
export interface IntakeNoticeInfo {
  key: string;
  title: string;
  state: IntakeState;
  reason: IntakeWaitReason | null;
  detail: string | null;
  url: string | null;
}
