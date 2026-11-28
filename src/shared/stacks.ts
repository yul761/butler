/**
 * 栈式 PR（工作流 K，设计 addendum `2026-11-17-ws-k-stacks-design.md`）：本地维护的栈、整栈 rebase 的策略和界面用的视图。
 * 策略经契约 4.2 的三层（全局 → 产品 → 仓库）配置；本地写操作（autoRebase）默认关，对外动作另受 B 的开关控制。
 */
import type { PolicyScope } from "./admission-policy";

export const STACK_MERGE_METHODS = ["auto", "squash", "merge"] as const;
export type StackMergeMethod = (typeof STACK_MERGE_METHODS)[number];

export const STACK_OVERVIEWS = ["off", "issue"] as const;
export type StackOverview = (typeof STACK_OVERVIEWS)[number];

export interface StackPolicy {
  /** 允许 Shipherd 改这个仓库里栈的本地分支（rebase、autosquash）。总开关，默认关。 */
  autoRebase: boolean;
  /** 栈底合并后怎么接：auto 按合并事件检测。 */
  mergeMethod: StackMergeMethod;
  /** 远端 trunk 有更新就跑。 */
  rebaseOnMainUpdate: boolean;
  /** 每天每个栈跑一次。 */
  dailyRebase: boolean;
  /** 评论处理完（awaitingCheck 为 false）后把 fixup 提交 autosquash 掉。 */
  autosquash: boolean;
  /** 栈底合并后把新栈底开成 ready PR（还要 pr_open 开关）。 */
  autoOpenBottomPr: boolean;
  /** 冲突送给那一层的 session（关着只在「现在」页提醒）。 */
  conflictToSession: boolean;
  /** draft 超过这么多天提醒降级成纯分支。 */
  draftDemoteDays: number;
  /** 栈底落后 trunk 这么多个提交就提醒。 */
  behindCommits: number;
  /** 栈底落后 trunk 最早的那个提交超过这么多天就提醒。 */
  behindDays: number;
  /** 栈的总览贴到哪儿（issue 还要 issue_post 开关）。 */
  overview: StackOverview;
  /** draft 层打的 label。 */
  draftLabel: string;
}

export type StackPolicyKey = keyof StackPolicy;
export type StackPolicyValue = StackPolicy[StackPolicyKey];
export type StackPolicyOverrides = Partial<StackPolicy>;

export const STACK_POLICY_DEFAULTS: StackPolicy = {
  autoRebase: false,
  mergeMethod: "auto",
  rebaseOnMainUpdate: true,
  dailyRebase: true,
  autosquash: true,
  autoOpenBottomPr: true,
  conflictToSession: true,
  draftDemoteDays: 14,
  behindCommits: 20,
  behindDays: 3,
  overview: "off",
  draftLabel: "stacked",
};

export const STACK_POLICY_KEYS: readonly StackPolicyKey[] = [
  "autoRebase", "mergeMethod", "rebaseOnMainUpdate", "dailyRebase", "autosquash", "autoOpenBottomPr", "conflictToSession",
  "draftDemoteDays", "behindCommits", "behindDays", "overview", "draftLabel",
];

export type StackPolicyErrorCode = "unknown_key" | "bad_bool" | "bad_int" | "bad_enum" | "bad_label";

/** 一个键的值不合法：key 是哪个键，code 是哪种错（main 按语言出文案）。 */
export class StackPolicyError extends Error {
  constructor(readonly key: string, readonly code: StackPolicyErrorCode) {
    super(`${key}: ${code}`);
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const INT_RANGES: Partial<Record<StackPolicyKey, [number, number]>> = {
  draftDemoteDays: [1, 365],
  behindCommits: [1, 10_000],
  behindDays: [1, 365],
};

function check(key: string, v: unknown): StackPolicyValue {
  switch (key) {
    case "autoRebase":
    case "rebaseOnMainUpdate":
    case "dailyRebase":
    case "autosquash":
    case "autoOpenBottomPr":
    case "conflictToSession":
      if (typeof v !== "boolean") throw new StackPolicyError(key, "bad_bool");
      return v;
    case "draftDemoteDays":
    case "behindCommits":
    case "behindDays": {
      const [min, max] = INT_RANGES[key]!;
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new StackPolicyError(key, "bad_int");
      return v;
    }
    case "mergeMethod":
      if (!STACK_MERGE_METHODS.includes(v as StackMergeMethod)) throw new StackPolicyError(key, "bad_enum");
      return v as StackMergeMethod;
    case "overview":
      if (!STACK_OVERVIEWS.includes(v as StackOverview)) throw new StackPolicyError(key, "bad_enum");
      return v as StackOverview;
    case "draftLabel": {
      const s = typeof v === "string" ? v.trim() : "";
      if (s.length < 1 || s.length > 50 || s.includes(",") || /[\r\n]/.test(s)) throw new StackPolicyError(key, "bad_label");
      return s;
    }
    default:
      throw new StackPolicyError(key, "unknown_key");
  }
}

/** 取值范围（设置页显示用）。 */
export function stackIntRange(key: StackPolicyKey): [number, number] | null {
  return INT_RANGES[key] ?? null;
}

/** 校验一层的覆盖（设置页、导入时用）：有不合法的抛 StackPolicyError；undefined 的键丢掉。 */
export function parseStackOverrides(raw: unknown): StackPolicyOverrides {
  if (!isPlain(raw)) throw new StackPolicyError("*", "unknown_key");
  const out: Record<string, StackPolicyValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k] = check(k, v);
  }
  return out as StackPolicyOverrides;
}

/** 从库里读出来的：不合法的键丢掉，不抛（坏了的一层当作没设）。 */
export function sanitizeStackOverrides(raw: unknown): StackPolicyOverrides {
  if (!isPlain(raw)) return {};
  const out: Record<string, StackPolicyValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = check(k, v);
    } catch {
      // 丢掉
    }
  }
  return out as StackPolicyOverrides;
}

export interface StackPolicyKeyView {
  key: StackPolicyKey;
  effective: StackPolicyValue;
  origin: { kind: "default" } | { kind: "global" } | { kind: "product"; productId: number; name: string } | { kind: "repo"; slug: string };
  set: boolean;
  override: StackPolicyValue | null;
}

export interface StackPolicyView {
  scope: PolicyScope;
  keys: StackPolicyKeyView[];
  /** 这个范围里 autoRebase 被 epic 档位盖过的栈（BTL-278；index.ts 从栈服务补上）。 */
  epic?: StackEpicNote;
}

export interface StackPolicyLayer {
  scope: PolicyScope;
  label: string;
  overrides: StackPolicyOverrides;
}

export type StackPolicySetResult = { ok: true } | { ok: false; key: string; message: string };

// ---- 栈 ----

export const STACK_LAYER_STATES = ["branch_only", "draft", "ready", "merged"] as const;
export type StackLayerState = (typeof STACK_LAYER_STATES)[number];

export type StackLayerMode = "branch" | "draft";
export type StackSource = "mcp" | "ticket" | "detected";

export const STACK_TRIGGERS = ["main_updated", "bottom_merged", "layer_commits", "daily", "manual", "autosquash", "restore"] as const;
export type StackTrigger = (typeof STACK_TRIGGERS)[number];

export type StackRunMode = "update_refs" | "per_layer";
/** needs_confirm（BTL-278）：自动跑出来要改写正在 review 的 PR、或者交给 session 的冲突层，什么都没落地，等人点「马上 rebase」。 */
export type StackRunOutcome = "rebased" | "noop" | "conflict" | "deferred" | "failed" | "rolled_back" | "restored" | "needs_confirm";

/**
 * 为什么要人确认：ready_pr = 要改写开着、可以 review 的 PR；handoff = 要改写冲突已经交给 session 的层（或它上面的层）；
 * remote_ahead = 冲突的那一层远端有本地没有的提交（比如 reviewer 推的），交出去的强推会冲掉它们（BTL-278）。
 */
export type StackConfirmWhy = "ready_pr" | "handoff" | "remote_ahead";

/** 交给 session 的冲突里，强推命令锁哪个 remote 的哪个 sha（BTL-278）。remote 为 null = 认不出推到哪里。 */
export interface ConflictLease { remote: string | null; sha: string | null; ahead: boolean }

/** 谁点的「马上 rebase」（BTL-278）：user = 界面上；coordinator = epic 总控调 stack_rebase；shipherd = Shipherd 总控调的。 */
export type StackActor = "user" | "coordinator" | "shipherd";

export function isSettledOutcome(o: StackRunOutcome): boolean {
  return o === "rebased" || o === "noop" || o === "restored";
}

export interface StackRunView {
  id: number;
  trigger: StackTrigger;
  mode: StackRunMode | null;
  outcome: StackRunOutcome;
  reason: string | null;
  /** 这次 run 留了备份引用（可以恢复）。 */
  hasBackup: boolean;
  /** 冲突的层和文件。 */
  conflict: { branch: string; files: string[] } | null;
  /** 推送：开关关着没推的分支。 */
  unpushed: string[];
  /** needs_confirm：为什么、哪几层。 */
  /** push：确认以后会不会强推；toSession：冲突会不会交给 session（remote_ahead 的文案用）。 */
  confirm: { why: StackConfirmWhy; branches: string[]; push?: boolean; toSession?: boolean } | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface StackLayerView {
  id: number;
  position: number;
  branch: string;
  ticketKey: string | null;
  ticketTitle: string | null;
  mode: StackLayerMode;
  state: StackLayerState;
  prNumber: number | null;
  prUrl: string | null;
  /** 落后远端 trunk 的提交数（只算栈底；读不到为 null）。 */
  behind: number | null;
  lastRebaseAt: number | null;
  draftSince: number | null;
  mergedAt: number | null;
  /** 本地改写过、开关关着还没推到远端。 */
  unpushed: boolean;
}

export interface StackView {
  id: number;
  name: string;
  repoPath: string;
  repoSlug: string | null;
  trunk: string;
  featureId: number | null;
  source: StackSource;
  mergeMethod: "squash" | "merge" | null;
  /** 生效的策略里最常看的几个。 */
  autoRebase: boolean;
  /**
   * autoRebase 是谁定的（BTL-278）：policy = 三层策略；epic = 层所在的 epic 选了档位（半自动打开、手动关掉）；
   * explicit_off = epic 是半自动，但仓库或产品层明确关了，按关。
   */
  autoRebaseBy: StackAutoRebaseBy;
  overviewUrl: string | null;
  layers: StackLayerView[];
  lastRun: StackRunView | null;
  /** 最近一次留了备份的 run（「从备份恢复」用）。 */
  restorable: StackRunView | null;
}

export type StackAutoRebaseBy = "policy" | "epic" | "explicit_off";

/** 设置页：这个范围里 autoRebase 被 epic 档位打开的栈，和 epic 想开、被明确关掉的栈（名字）。 */
export interface StackEpicNote {
  on: string[];
  ignored: string[];
}

export interface StacksFilter {
  featureId: number | null;
}

export interface StacksView {
  stacks: StackView[];
  /** git 版本够不够 --update-refs（不够时逐层 rebase）。 */
  updateRefs: boolean | null;
}

/** 栈的提醒（「现在」页）。 */
/** rewritten：最近一次自动 rebase 改写了这几层、它们还停在 Shipherd 写的顶端（没人编译过，BTL-278）。 */
/** prs_unreadable：读不到 PR 推迟了一天以上；markers：要推的顶端有冲突标记（或者查不了），没推。 */
/** held_below：叠在一层带标记、没推出去的层上面，这次也没推（by 是拦住它的那层）。 */
/** no_push_remote：要开 PR 的新栈底认不出该推到哪个 remote，没推、没开 PR。 */
/** ticket_closed：栈里这几层（branches）的 ticket 关掉或归档了，整个栈不改写、不推，那几层也不开 PR，要人移出栈。 */
export type StackNoticeReason = "conflict" | "draft_stale" | "behind" | "stuck" | "confirm" | "rewritten" | "prs_unreadable" | "markers" | "held_below" | "no_push_remote" | "ticket_closed";

/**
 * markers 提醒里是哪种层（BTL-278）：new_bottom = 从没推过的新栈底（也没开 PR）；new_layer = 从没推过的中间层；
 * rewritten = Shipherd 改写过、没推出去；local = 本地有远端没有的提交（session 自己提交的），叠在上面的层推不出去。
 */
export type StackMarkersWhere = "new_bottom" | "new_layer" | "rewritten" | "local";

export interface StackNoticeInfo {
  reason: StackNoticeReason;
  stackId: number;
  stackName: string;
  branch: string;
  /** 这一层的 ticket（提醒上「打开 ticket」用）。 */
  ticketKey?: string | null;
  /** conflict、markers：冲突（标记）文件，markers 的空表示查不了；stuck：最近的原因；confirm：ready_pr、handoff 或 remote_ahead。 */
  files?: string[];
  /** markers：是哪种层（决定提醒怎么说）。 */
  where?: StackMarkersWhere;
  /** held_below：拦住这几层（branches）的那一层。 */
  by?: string;
  /** prs_unreadable：remote 的主机（认不出就是 null，当 github.com）。 */
  host?: string | null;
  /** confirm：等确认的几层；rewritten：刚被自动改写的几层；held_below：被拦住的几层。 */
  branches?: string[];
  /** rewritten：其中真的请了 session 核对的几层。 */
  asked?: string[];
  /** confirm：确认以后会不会强推。 */
  push?: boolean;
  /** confirm：冲突会不会交给 session。 */
  toSession?: boolean;
  detail?: string | null;
  /** draft_stale：已经多少天；behind：落后多少天。 */
  days?: number;
  /** behind：落后多少个提交。 */
  commits?: number;
  prNumber?: number | null;
}

export type StackActionResult = { ok: true; message?: string } | { ok: false; message: string };
