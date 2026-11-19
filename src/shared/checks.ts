// 确定性检查（契约 4.5）：类型、快照格式、命中记录、页面用的视图和输入校验。纯数据，不引 Node 模块。
import type { BypassHow } from "./backtest";

/** 快照格式的版本：hook 和 Butler 用同一个常量构建；hook 看到别的版本就当作「没有检查」放行并记录。 */
export const CHECKS_SNAPSHOT_VERSION = 1;

export const CHECK_TYPES = ["forbidden_pattern", "import_boundary", "comment_policy", "run_command"] as const;
export type CheckType = (typeof CHECK_TYPES)[number];
export const CHECK_SEVERITIES = ["block", "warn"] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];
export const CHECK_MODES = ["shadow", "enforce"] as const;
export type CheckMode = (typeof CHECK_MODES)[number];
export type CheckStage = "edit" | "push";

/** 检查所在的层（契约 4.2）。 */
export type CheckScope = { kind: "global" } | { kind: "product"; productId: number } | { kind: "repo"; slug: string };

export interface ForbiddenPatternParams {
  pattern: string;
  /** 只认 "i"（不区分大小写）。 */
  flags?: string;
  /** true：按原样找文字，不当正则。 */
  literal?: boolean;
}
export interface ImportBoundaryParams {
  /** 不许 import 的目标：仓库内路径 glob（相对 import 先解析成仓库路径）或包名 glob（electron、node:*）。 */
  forbid: string[];
  /** 例外：命中 allow 的不算违规。 */
  allow?: string[];
}
export interface CommentPolicyParams {
  /** 空或没写 = 默认的中英文关键词。 */
  keywords?: string[];
  /** 空或没写 = 设置里的 ticketPattern。 */
  ticketPattern?: string;
}
export interface RunCommandParams {
  command: string;
  stage: CheckStage;
  /** 单条命令的上限（毫秒）；还受整次编辑 / push 的预算限制。 */
  timeoutMs?: number;
}

/** 新建 / 编辑一条检查时可改的部分。 */
export interface CheckInput {
  type: CheckType;
  name: string;
  params: Record<string, unknown>;
  globs: string[];
  excludeGlobs: string[];
  severity: CheckSeverity;
  mode: CheckMode;
  enabled: boolean;
  message: string;
}

export interface CheckRow extends CheckInput {
  id: number;
  key: string;
  scope: CheckScope;
  lessonId: number | null;
  batchId: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 快照里的一条：已经按三层合并、已经本地化。 */
export interface ResolvedCheck {
  id: number;
  key: string;
  type: CheckType;
  name: string;
  params: Record<string, unknown>;
  globs: string[];
  excludeGlobs: string[];
  severity: CheckSeverity;
  mode: CheckMode;
  message: string;
}

/** hook 输出给 agent 的几句固定文字（按 Butler 的界面语言）。 */
export interface CheckSnapshotStrings {
  /** 「Butler 检查「{name}」没通过：{where}」 */
  failHeader: string;
  /** 影子模式的标记。 */
  shadowTag: string;
  /** 警告级的标记。 */
  warnTag: string;
  /** 被拦下时最后一句：要怎么做。 */
  blockFooter: string;
  /** push 被拦下时的开头。 */
  pushHeader: string;
}

export interface CheckSnapshot {
  v: number;
  generatedAt: number;
  enabled: boolean;
  editTimeoutMs: number;
  pushTimeoutMs: number;
  /** 注释规则默认的 ticket 号正则（设置 ticketPattern）。 */
  ticketPattern: string;
  strings: CheckSnapshotStrings;
  global: ResolvedCheck[];
  repos: Record<string, ResolvedCheck[]>;
}

export type CheckOutcome = "fail" | "resolved" | "timeout" | "unavailable" | "error";
export const CHECK_OUTCOMES: readonly CheckOutcome[] = ["fail", "resolved", "timeout", "unavailable", "error"];

export const CHECK_ABSENCE_REASONS = ["hook_outdated", "no_snapshot", "snapshot_version", "disabled"] as const;
export type CheckAbsenceReason = (typeof CHECK_ABSENCE_REASONS)[number];

/** hook 写进命中日志的一行（JSON Lines）。 */
export type CheckLogRecord =
  | {
      kind: "hit";
      checkId: number;
      checkKey: string;
      slug: string;
      file: string;
      line: number | null;
      stage: CheckStage;
      mode: CheckMode;
      severity: CheckSeverity;
      outcome: CheckOutcome;
      blocked: boolean;
      detail: string;
      session: string | null;
      at: number;
    }
  | { kind: "absent"; reason: CheckAbsenceReason; session: string | null; at: number }
  /** 记过「没有检查」的 session 后来又检查上了（快照恢复了）：清掉 session 上的标记。 */
  | { kind: "present"; session: string | null; at: number }
  /** 绕过一条拦过的检查（工作流 F 第 7.1 节）：在拦下的地方加压制注释、--no-verify、关掉 git hook、改 Butler 的检查文件。 */
  | {
      kind: "bypass";
      checkId: number;
      checkKey: string;
      slug: string;
      file: string;
      line: number | null;
      how: BypassHow;
      detail: string;
      session: string | null;
      at: number;
    };

export type CheckVerdict = "false_positive" | "true_positive";

/** 一条检查的原始命中数据（F 拿去算升级 / 降级）。 */
export interface CheckStats {
  fails: number;
  blocked: number;
  resolved: number;
  timeouts: number;
  unavailable: number;
  errors: number;
  falsePositives: number;
  truePositives: number;
  /** 不同 session 数。 */
  sessions: number;
  lastHitAt: number | null;
  /** 最近一次「跑不起来」的原因（run_command）。 */
  lastUnavailable: { at: number; detail: string } | null;
  /** 绕过次数（工作流 F：压制注释、--no-verify、关 hook、改检查文件）。 */
  bypassed: number;
  /** 拦下以后一天内同一个 session 没改掉的次数（工作流 F 第 7.1 节）。 */
  ignored: number;
}

export interface CheckHitView {
  id: number;
  checkId: number | null;
  checkKey: string;
  repoSlug: string | null;
  file: string;
  line: number | null;
  stage: CheckStage;
  mode: CheckMode;
  severity: CheckSeverity;
  outcome: CheckOutcome;
  blocked: boolean;
  detail: string;
  sessionId: string | null;
  verdict: CheckVerdict | null;
  at: number;
}

/** 页面上某一层看到的一条：生效的定义、来自哪一层、这一层自己有没有一行。 */
export interface CheckEffectiveView {
  key: string;
  check: CheckRow;
  /** 生效的那一行所在的层。 */
  origin: CheckScope;
  originLabel: string;
  /** 这一层自己的一行（覆盖或在这一层定义的）；没有为 null。 */
  own: CheckRow | null;
  stats: CheckStats;
  lessonText: string | null;
}

export interface ChecksView {
  scope: CheckScope;
  checks: CheckEffectiveView[];
  /** 页面上能选的层。 */
  products: { id: number; name: string }[];
  repos: string[];
  settings: { enabled: boolean; editTimeoutSec: number; pushTimeoutSec: number };
  /** 快照最近一次写出的时间；写失败的原因。 */
  snapshot: { writtenAt: number | null; error: string | null };
}

export type ChecksBulkOp = "enable" | "disable" | "shadow" | "enforce" | "block" | "warn" | "delete";
export const CHECKS_BULK_OPS: readonly ChecksBulkOp[] = ["enable", "disable", "shadow", "enforce", "block", "warn", "delete"];

/** 检查页上的操作（checks:act）。input 由服务端用 validateCheckInput 校验。 */
export type ChecksAction =
  | { op: "save"; scope: CheckScope; id: number | null; input: unknown; lessonId?: number | null }
  | { op: "override"; scope: CheckScope; key: string }
  | { op: "bulk"; ids: number[]; verb: ChecksBulkOp }
  | { op: "verdict"; hitId: number; verdict: CheckVerdict | null }
  | { op: "classify"; lessonId: number; checkability: "checkable" | "prose" | null };

export type ChecksActResult = { ok: true; batchId: number | null; affected: number; id?: number } | { ok: false; reason: string; message?: string };

/** 从一条规矩生成检查（check_draft）的结果：一份草稿，或者「只能写成文字」和理由。 */
export type CheckDraftResult =
  | { ok: true; kind: "draft"; draft: CheckInput; scope: CheckScope; reason: string }
  | { ok: true; kind: "prose"; reason: string; batchId: number | null }
  | { ok: false; reason: string; message?: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strList = (v: unknown, max = 50): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= 500) ? (v as string[]).map((x) => x.trim()).filter(Boolean) : null;

/** 正则能不能编译；能就返回 null，否则返回错误信息。 */
export function regexError(pattern: string, flags = ""): string | null {
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 校验并清理一种类型的参数。错误信息是给开发者看的英文短语，页面按 key 翻译。 */
export function validateCheckParams(type: CheckType, raw: unknown): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const p = isObj(raw) ? raw : {};
  switch (type) {
    case "forbidden_pattern": {
      const pattern = typeof p.pattern === "string" ? p.pattern : "";
      if (!pattern.trim() || pattern.length > 1000) return { ok: false, error: "pattern" };
      const flags = p.flags === "i" ? "i" : "";
      const literal = p.literal === true;
      if (!literal && regexError(pattern, flags)) return { ok: false, error: "pattern_invalid" };
      return { ok: true, params: { pattern, ...(flags ? { flags } : {}), ...(literal ? { literal } : {}) } };
    }
    case "import_boundary": {
      const forbid = strList(p.forbid);
      if (!forbid || forbid.length === 0) return { ok: false, error: "forbid" };
      const allow = p.allow === undefined ? [] : strList(p.allow);
      if (!allow) return { ok: false, error: "allow" };
      return { ok: true, params: { forbid, ...(allow.length ? { allow } : {}) } };
    }
    case "comment_policy": {
      const keywords = p.keywords === undefined ? [] : strList(p.keywords, 200);
      if (!keywords) return { ok: false, error: "keywords" };
      const ticketPattern = typeof p.ticketPattern === "string" ? p.ticketPattern.trim() : "";
      if (ticketPattern && regexError(ticketPattern)) return { ok: false, error: "ticket_invalid" };
      return { ok: true, params: { ...(keywords.length ? { keywords } : {}), ...(ticketPattern ? { ticketPattern } : {}) } };
    }
    case "run_command": {
      const command = typeof p.command === "string" ? p.command.trim() : "";
      if (!command || command.length > 2000) return { ok: false, error: "command" };
      const stage = p.stage === "push" ? "push" : "edit";
      const t = typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) ? Math.round(p.timeoutMs) : undefined;
      if (t !== undefined && (t < 100 || t > 3_600_000)) return { ok: false, error: "timeout" };
      return { ok: true, params: { command, stage, ...(t !== undefined ? { timeoutMs: t } : {}) } };
    }
  }
}

/** 校验一份 CheckInput（IPC、导入、草稿都走这里）。 */
export function validateCheckInput(raw: unknown): { ok: true; value: CheckInput } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "shape" };
  const type = raw.type;
  if (typeof type !== "string" || !(CHECK_TYPES as readonly string[]).includes(type)) return { ok: false, error: "type" };
  const params = validateCheckParams(type as CheckType, raw.params);
  if (!params.ok) return params;
  const globs = raw.globs === undefined ? [] : strList(raw.globs);
  const excludeGlobs = raw.excludeGlobs === undefined ? [] : strList(raw.excludeGlobs);
  if (!globs) return { ok: false, error: "globs" };
  if (!excludeGlobs) return { ok: false, error: "excludeGlobs" };
  const severity = raw.severity;
  if (severity !== "block" && severity !== "warn") return { ok: false, error: "severity" };
  const mode = raw.mode;
  if (mode !== "shadow" && mode !== "enforce") return { ok: false, error: "mode" };
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (name.length > 200 || message.length > 2000) return { ok: false, error: "length" };
  return {
    ok: true,
    value: { type: type as CheckType, name, params: params.params, globs, excludeGlobs, severity, mode, enabled: raw.enabled !== false, message },
  };
}

export function parseCheckScope(raw: unknown): CheckScope | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "global") return { kind: "global" };
  if (raw.kind === "product" && Number.isSafeInteger(raw.productId) && (raw.productId as number) > 0) return { kind: "product", productId: raw.productId as number };
  // 仓库层用 parseRemoteSlug 的写法：GitHub 是 owner/name，别的主机带上主机名和子组（gitlab.com/grp/sub/repo）；一律小写。
  if (raw.kind === "repo" && typeof raw.slug === "string" && raw.slug.length <= 300) {
    const slug = normalizeCheckSlug(raw.slug);
    if (slug) return { kind: "repo", slug };
  }
  return null;
}

/** 仓库 slug：两段以上、没有空白和空段，小写（hook 查快照用的是 remote 解析出来的小写 slug）。不合格返回 null。 */
export function normalizeCheckSlug(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  return /^[^\s/]+(?:\/[^\s/]+)+$/.test(s) ? s : null;
}

export const sameScope = (a: CheckScope, b: CheckScope): boolean =>
  a.kind === b.kind && (a.kind !== "product" || a.productId === (b as { productId: number }).productId) && (a.kind !== "repo" || a.slug === (b as { slug: string }).slug);
