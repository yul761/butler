// 工作流 G（设计补充 2026-11-17-ws-g，契约 4.6）：预审、完成证据、就绪度、风险、简报在主进程和界面之间共用的类型。

export const PRE_REVIEW_TRIGGERS = ["evidence", "pr", "manual"] as const;
export type PreReviewTrigger = (typeof PRE_REVIEW_TRIGGERS)[number];

export const PRE_REVIEW_STATUSES = ["queued", "running", "done", "failed", "skipped"] as const;
export type PreReviewStatus = (typeof PRE_REVIEW_STATUSES)[number];

export type PreReviewVerdict = "clean" | "violations" | "error";

export const EVIDENCE_KINDS = ["check", "acceptance", "ui", "not_run"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** 检查类证据的类别；「要哪些证据」按这个对（设计 §3.3）。 */
export const EVIDENCE_CATEGORIES = ["test", "lint", "typecheck", "build", "other"] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];
/** 能被「要求」的类别（other 不会被要求）。 */
export const REQUIRABLE_CATEGORIES = ["test", "lint", "typecheck", "build"] as const;
export type RequirableCategory = (typeof REQUIRABLE_CATEGORIES)[number];

/** 证据核实结果（设计 §3.4）：复跑通过 / 复跑失败 / 交叉核对一致 / 对不上 / 没法核实。 */
export const EVIDENCE_VERIFIED = ["pending", "rerun_pass", "rerun_fail", "consistent", "mismatch", "unverifiable"] as const;
export type EvidenceVerified = (typeof EVIDENCE_VERIFIED)[number];
export const isVerifiedOk = (v: EvidenceVerified): boolean => v === "rerun_pass" || v === "consistent";
export const isVerifiedBad = (v: EvidenceVerified): boolean => v === "rerun_fail" || v === "mismatch";

/** 预审、证据、简报对着的那一份代码：仓库、分支、提交。 */
export interface ReviewTarget {
  repoSlug: string;
  branch: string;
  headSha: string;
}

/** 改动的一个文件（diff 的统计）。路径一律用 /。 */
export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

export interface EvidenceItem {
  id: number;
  preReviewId: number | null;
  prId: number | null;
  kind: EvidenceKind;
  category: EvidenceCategory | null;
  name: string;
  command: string | null;
  claimed: "pass" | "fail" | null;
  summary: string;
  verified: EvidenceVerified;
  verifyDetail: string | null;
  rerunOutput: string | null;
  createdAt: number;
  verifiedAt: number | null;
}

/** 预审找出的一处违规（设计 §4.4）。lessonId 为空时一定来自检查结果（checkKey 非空）。 */
export interface Violation {
  lessonId: number | null;
  checkKey: string | null;
  file: string;
  line: number | null;
  severity: "must" | "should";
  what: string;
  fix: string;
  /** 规矩的一句话（只给界面和递送用，不是规矩全文的列表）。 */
  lessonText?: string | null;
}

/** 预审时收集到的检查结果摘要（设计 §4.3）。 */
export interface CheckSummary {
  /** session 启动时为什么没挂上检查（E1 的 checks_absent）；null = 挂上了或根本没有启用的检查。 */
  absent: string | null;
  /** 还没 resolved 的 fail，按检查汇总。 */
  failing: { checkKey: string; name: string; severity: "block" | "warn"; mode: "shadow" | "enforce"; files: string[]; count: number }[];
  /** PR 的 CI 结论；没有 PR 为 null。 */
  ci: "pending" | "passing" | "failing" | null;
  /** 复跑：每条命令的结论。 */
  rerun: { category: RequirableCategory; command: string; ok: boolean; skipped?: string | null; ms: number }[];
}

export interface PreReviewView {
  id: number;
  ticketKey: string | null;
  sessionId: string | null;
  target: ReviewTarget;
  base: string | null;
  prId: number | null;
  trigger: PreReviewTrigger;
  status: PreReviewStatus;
  verdict: PreReviewVerdict | null;
  summary: string | null;
  detail: string | null;
  files: DiffFile[];
  lessonIds: number[];
  checks: CheckSummary | null;
  violations: Violation[];
  evidence: EvidenceItem[];
  /** 要的证据里还缺、或不实的（一句话一条）。 */
  missingEvidence: EvidenceGap[];
  model: string | null;
  deliveredAt: number | null;
  createdAt: number;
  finishedAt: number | null;
}

/** 缺一项证据：缺了（missing）、写了没跑的原因（explained）、对不上（bad）。 */
export interface EvidenceGap {
  category: RequirableCategory | "acceptance";
  state: "missing" | "explained" | "bad";
  detail: string;
}

// ---------------------------------------------------------------- 就绪度（设计 §7）

export const READINESS_KEYS = ["checks", "pre_review", "evidence", "comments", "mergeable", "description"] as const;
export type ReadinessKey = (typeof READINESS_KEYS)[number];

/** pass 满足；fail 不满足；unknown 还不知道（不算就绪）；off 没开（这条不算）。 */
export type ConditionState = "pass" | "fail" | "unknown" | "off";

export interface ReadinessCondition {
  key: ReadinessKey;
  state: ConditionState;
  /** 一句话，按界面语言。 */
  detail: string;
}

export interface Readiness {
  ready: boolean;
  conditions: ReadinessCondition[];
  /** 不满足（fail / unknown）的那几条。 */
  missing: { key: ReadinessKey; state: "fail" | "unknown"; detail: string }[];
}

// ---------------------------------------------------------------- 风险（设计 §5）

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const riskRank = (l: RiskLevel): number => RISK_LEVELS.indexOf(l);
export const RISK_RULES_VERSION = 1;

export const RISK_RULES = [
  "migration", "auth", "public_api", "config", "ci_config", "large_diff", "multi_repo", "check_warnings",
  "missing_evidence", "ticket_type", "low", "default",
] as const;
export type RiskRule = (typeof RISK_RULES)[number];

export interface RiskReason {
  rule: RiskRule;
  level: RiskLevel;
  files?: string[];
  detail: string;
}

export interface Risk {
  level: RiskLevel;
  reasons: RiskReason[];
}

// ---------------------------------------------------------------- 简报（设计 §8）

export const BRIEF_START = "<!-- shipherd:brief -->";
export const BRIEF_END = "<!-- /shipherd:brief -->";
/** 改名前（BTL-260）写进 PR 描述的简报块标记：已经在 GitHub 上的 PR 里，更新时要认得、整块换成新的，不能再追加一份。 */
export const LEGACY_BRIEF_START = "<!-- butler:brief -->";
export const LEGACY_BRIEF_END = "<!-- /butler:brief -->";

export interface BriefView {
  id: number;
  prId: number | null;
  preReviewId: number | null;
  target: ReviewTarget;
  markdown: string;
  summaryOk: boolean;
  createdAt: number;
  postedAt: number | null;
  postedUrl: string | null;
}

/** K 的注入点（记忆里的约定）：栈底开 PR 时问 G 要简报。 */
export interface BriefLayer {
  repoSlug: string;
  branch: string;
  headSha: string | null;
  ticketKey: string | null;
  prNumber: number | null;
}
export type BriefProvider = (layer: BriefLayer) => { markdown: string; posted: (prUrl: string) => void } | null;

// ---------------------------------------------------------------- 一个 PR 的全部评估（ticket 页的 Review tab、总控的 pr_assessment）

export interface PrAssessmentView {
  prId: number | null;
  url: string | null;
  number: number | null;
  title: string | null;
  target: ReviewTarget | null;
  state: "open" | "merged" | "closed" | null;
  draft: boolean;
  readiness: (Readiness & { headSha: string | null; computedAt: number }) | null;
  risk: (Risk & { headSha: string | null; computedAt: number; rulesVersion: number }) | null;
  preReview: PreReviewView | null;
  brief: BriefView | null;
  /** 预审开着吗（关着时界面说明怎么打开）。 */
  preReviewEnabled: boolean;
  /** 能手动贴到 PR（有 PR、PR 开着）。 */
  canPost: boolean;
}

export interface TicketAssessmentView {
  ticketKey: string;
  prs: PrAssessmentView[];
  /** 没有 PR、只有分支的（栈的上层）：最近的预审和简报。 */
  branches: PrAssessmentView[];
}

/** 页面上「重新预审」「重新生成简报」「贴到 PR」的结果。 */
export type ReviewActResult =
  | { ok: true; url?: string }
  | { ok: false; reason: "no_pr" | "not_open" | "no_brief" | "off" | "failed" | "no_head" | "no_pre_review"; detail?: string };

/** 「进度」页的待 review 清单一行（设计 §10）。 */
export interface ReviewQueueItem {
  prId: number;
  ticketKey: string;
  url: string;
  number: number;
  title: string | null;
  repoSlug: string;
  risk: RiskLevel | null;
  ready: boolean | null;
  missing: { key: ReadinessKey; state: "fail" | "unknown"; detail: string }[];
  openedAt: number | null;
}

/** 待 review 排序：未就绪在前 → 风险高在前 → 等得久在前。只改排序。 */
export function reviewQueueOrder(a: ReviewQueueItem, b: ReviewQueueItem): number {
  const notReady = (x: ReviewQueueItem) => (x.ready === true ? 0 : 1);
  const rank = (x: ReviewQueueItem) => (x.risk === null ? 1 : riskRank(x.risk));
  return notReady(b) - notReady(a) || rank(b) - rank(a) || (a.openedAt ?? Infinity) - (b.openedAt ?? Infinity) || a.prId - b.prId;
}

// ---------------------------------------------------------------- submit_evidence 的参数（MCP 和主进程各验一次）

export const EVIDENCE_LIMITS = { checks: 30, acceptance: 50, ui: 20, notRun: 20, output: 2000, text: 500, notes: 2000 } as const;

export interface SubmitEvidenceArgs {
  checks: { name: string; category: EvidenceCategory; command: string; result: "pass" | "fail"; output: string }[];
  acceptance: { criterion: string; how: string }[];
  ui?: { path: string; note?: string }[];
  notRun?: { name: string; category?: EvidenceCategory; reason: string }[];
  notes?: string;
}

const cut = (s: unknown, n: number): string => {
  const t = typeof s === "string" ? s : "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const isCategory = (v: unknown): v is EvidenceCategory => typeof v === "string" && (EVIDENCE_CATEGORIES as readonly string[]).includes(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** 宽松地解析 submit_evidence 的参数：截断超长的、丢掉不成形的；一条检查和一条验收都没有返回 null。 */
export function parseSubmitEvidence(raw: unknown): SubmitEvidenceArgs | null {
  const r = obj(raw);
  const L = EVIDENCE_LIMITS;
  const checks = arr(r.checks).slice(0, L.checks).map(obj).flatMap((c) => {
    const name = cut(c.name, L.text).trim();
    const command = cut(c.command, L.text).trim();
    if (!name && !command) return [];
    const result: "pass" | "fail" | null = c.result === "pass" || c.result === "fail" ? c.result : null;
    if (!result) return [];
    return [{ name: name || command, category: isCategory(c.category) ? c.category : "other", command, result, output: cut(c.output, L.output) }];
  });
  const acceptance = arr(r.acceptance).slice(0, L.acceptance).map(obj).flatMap((a) => {
    const criterion = cut(a.criterion, L.text).trim();
    return criterion ? [{ criterion, how: cut(a.how, L.text).trim() }] : [];
  });
  const ui = arr(r.ui).slice(0, L.ui).map(obj).flatMap((u) => {
    const path = cut(u.path, L.text).trim();
    return path ? [{ path, note: cut(u.note, L.text).trim() || undefined }] : [];
  });
  const notRun = arr(r.notRun).slice(0, L.notRun).map(obj).flatMap((n) => {
    const name = cut(n.name, L.text).trim();
    const reason = cut(n.reason, L.text).trim();
    return name && reason ? [{ name, category: isCategory(n.category) ? n.category : undefined, reason }] : [];
  });
  if (checks.length === 0 && acceptance.length === 0 && notRun.length === 0) return null;
  const notes = cut(r.notes, L.notes).trim();
  return { checks, acceptance, ...(ui.length ? { ui } : {}), ...(notRun.length ? { notRun } : {}), ...(notes ? { notes } : {}) };
}

// ---------------------------------------------------------------- 预审状态和队列（BTL-271）：徽标、队列页、总控工具共用

/**
 * 一个 ticket、PR、session 现在的预审状态：没预审过、排队第 N、停着（闸门不放行）、预审中、通过、违反 N 条、出错。
 * paused 也在排队，只是闸门（手动停、熔断、额度、内存）现在不放行。
 */
export const PRE_REVIEW_STATES = ["none", "queued", "paused", "running", "clean", "violations", "error"] as const;
export type PreReviewState = (typeof PRE_REVIEW_STATES)[number];

/** 预审停着的原因（后台闸门的 BgBlockReason）。 */
export type PreReviewPauseReason = "manual" | "cost" | "quota" | "user_active" | "outside_hours" | "memory";

/** 排着队但没轮到的原因：前面的占满了并发，或者同一个 worktree 已经有一个在跑。 */
export type PreReviewWaiting = "concurrency" | "worktree";

export interface PreReviewBadge {
  state: PreReviewState;
  /** 对着的那次预审；none 为 null。 */
  id: number | null;
  ticketKey: string | null;
  sessionId: string | null;
  repoSlug: string | null;
  branch: string | null;
  headSha: string | null;
  prId: number | null;
  trigger: PreReviewTrigger | null;
  /** 排队第几（1 起，按真正取的顺序）；不在排队为 null。 */
  position: number | null;
  /** state = paused 时为什么停着。 */
  reason: PreReviewPauseReason | null;
  /** 停到什么时候（知道的话）。 */
  until: number | null;
  /** 排队、没停着时在等什么。 */
  waiting: PreReviewWaiting | null;
  enqueuedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 违规条数（规矩违规 + 挡合并的检查失败）。 */
  violations: number;
  /** 出错时的说明。 */
  detail: string | null;
  /** 最近一次做完的结论（排队、在跑时是上一次的；界面显示「上次违反 2 条」）。 */
  last: { state: "clean" | "violations" | "error"; id: number; violations: number; headSha: string; finishedAt: number | null } | null;
}

/** 一个 ticket 的预审状态：每个（仓库, 分支）一条，overall 是最要紧的那一条（在跑 > 排队 > 违反 > 出错 > 通过）。 */
export interface PreReviewTicketStatus {
  ticketKey: string;
  overall: PreReviewBadge;
  items: PreReviewBadge[];
  /** 这个 ticket 现在开着预审没有（epic 档位或全局设置）。关着、又没预审过时界面不显示「未预审」。 */
  enabled: boolean;
}

export interface PreReviewQueueItem extends PreReviewBadge {
  id: number;
  jobId: number | null;
  prNumber: number | null;
  prUrl: string | null;
  /** 任务还没停、行已经有结局：cancelling = 取消了正在中止，finishing = 出了结论正在收尾；其余为 null。 */
  ending: "cancelling" | "finishing" | null;
}

export interface PreReviewQueueView {
  running: PreReviewQueueItem[];
  /** 还占着任务、但已经有结局的（取消中、收尾中）：不算在跑的。 */
  ending: PreReviewQueueItem[];
  /** 按真正取的顺序。 */
  queued: PreReviewQueueItem[];
  /** 同时最多跑几个（设置 preReviewConcurrency）。 */
  concurrency: number;
  /** 整个队列为什么停着；没停为 null。 */
  stopped: { reason: PreReviewPauseReason; until: number | null } | null;
}

/** 界面一次要的徽标（BTL-271）：一张列表的 ticket、session、PR 一起要，主进程一次查完。 */
export interface PreReviewStatusRequest {
  tickets?: string[];
  sessions?: string[];
  prs?: number[];
}
/** 和请求对应；没有预审的 session、PR 不在里面（ticket 都在，没预审过的 state = none）。 */
export interface PreReviewStatusBatch {
  tickets: Record<string, PreReviewTicketStatus>;
  sessions: Record<string, PreReviewBadge>;
  prs: Record<number, PreReviewBadge>;
}
/** 一次最多要多少个（超了 IPC 直接拒绝，不悄悄截断）。 */
export const PRE_REVIEW_STATUS_MAX = 2000;

/** 队列页、总控对一条预审做的：取消、提到最前。 */
export type PreReviewQueueAction = { op: "cancel" | "front"; id: number };
export type PreReviewQueueActResult = { ok: true } | { ok: false; reason: "not_found" | "not_queued" | "failed" };

/** 预审并发数的范围（设置 preReviewConcurrency，默认 2）。 */
export const PRE_REVIEW_CONCURRENCY = { min: 1, max: 8, default: 2 } as const;

/** 违规条数：规矩违规加上挡合并（block 级、enforce）的检查失败。 */
export function violationCount(violations: readonly Violation[], checks: CheckSummary | null): number {
  const blocking = (checks?.failing ?? []).filter((f) => f.severity === "block" && f.mode === "enforce").length;
  return violations.length + blocking;
}

const STATE_RANK: Record<PreReviewState, number> = { running: 6, queued: 5, paused: 5, violations: 4, error: 3, clean: 2, none: 0 };

/** 一组里最要紧的那条：在跑 > 排队（靠前的）> 违反 > 出错 > 通过 > 没有；同级新的在前。 */
export function mostUrgentBadge(items: readonly PreReviewBadge[]): PreReviewBadge | null {
  let best: PreReviewBadge | null = null;
  for (const b of items) {
    if (!best) {
      best = b;
      continue;
    }
    const d = STATE_RANK[b.state] - STATE_RANK[best.state];
    if (d > 0) best = b;
    else if (d === 0) {
      const pb = b.position ?? Infinity;
      const pa = best.position ?? Infinity;
      if (pb < pa || (pb === pa && (b.id ?? 0) > (best.id ?? 0))) best = b;
    }
  }
  return best;
}

export const noPreReview = (ticketKey: string | null): PreReviewBadge => ({
  state: "none", id: null, ticketKey, sessionId: null, repoSlug: null, branch: null, headSha: null, prId: null, trigger: null,
  position: null, reason: null, until: null, waiting: null, enqueuedAt: null, startedAt: null, finishedAt: null, violations: 0, detail: null, last: null,
});

/** 设置里的预审并发数；不合法时用默认。 */
export function readPreReviewConcurrency(raw: string | null | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n >= PRE_REVIEW_CONCURRENCY.min && n <= PRE_REVIEW_CONCURRENCY.max ? n : PRE_REVIEW_CONCURRENCY.default;
}
