import type { Lang } from "./i18n";
import { isModelName, isTier } from "./model-routing";
import { MANUAL_TICKET_STATUSES, type ManualTicketStatus } from "./types";

/**
 * 总控 session 开子 session（设计文档 2026-10-23 第二步）：shipherd-sessions MCP server ↔ Shipherd 主进程，走文件。
 * 请求：<control>/requests/<id>.json；结果：<control>/results/<id>.json（同一个 id）。
 */

export const CONTROL_VERSION = 1;
/**
 * 现在还能再开几个 session（工作流 W：按内存决定，不再有每 ticket、每 feature、每 epic 的固定上限）。单位都是 MB。
 * start_session 和 list_sessions 的结果带上它，sessions-server 把它写成一行给总控看。
 */
export interface SessionCapacity {
  /** 按可用内存和硬上限算，还能再开几个；读不到内存又没开硬上限时为 null（不限）。 */
  canStart: number | null;
  /** 可用内存，已经扣掉刚开、还在启动的 session；读不到为 null。 */
  availableMb: number | null;
  /** 一个新 session 预计占多少：measured 是开着的 session 实测的平均，setting 是设置里的值。 */
  sessionMb: number;
  estimate: "measured" | "setting";
  reserveMb: number;
  /** 刚放行、还没长到该有的内存的 session 个数。 */
  pending: number;
  running: number;
  /** 设置里的硬上限；null = 没开（默认）。 */
  maxRunning: number | null;
  /** macOS 的内存压力；别的平台或读不到为 null。 */
  pressure: "normal" | "warn" | "critical" | null;
  source: "vm_stat" | "memory_pressure" | "os" | "fixed" | null;
}
/** start_session 的任务最长多少字。 */
export const TASK_LIMIT = 8000;
/** session_activity 返回的命令输出最多这么多字节。 */
export const ACTIVITY_OUTPUT_LIMIT = 4096;
/** end_session 的 reason 最多这么多字符；list_sessions、session_activity 的 last_reply 也最多这么多字符（取结尾）。 */
export const REASON_LIMIT = 500;
export const LAST_REPLY_LIMIT = 500;
/** 请求 id：文件名，只用安全字符。 */
export const CONTROL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * start_session 的模型（3.0 模型路由）：档位 high / mid / low，或模型名（旧的 opus / sonnet 照旧能用）。
 * 名字是不是真的存在由主进程按模型路由判断，这里只查格式。
 */
export type StartModel = string;
/** model 省略（undefined）、是档位或像个模型名才算合法；别的值整个请求当作坏请求。 */
function okModel(v: unknown): boolean {
  return v === undefined || isTier(v) || isModelName(v);
}

/**
 * report 的种类（BTL-190 第 2+3 点）：progress 只存不送；done、blocked 还送进所属总控的终端。
 * choice（ws-j）：session 按「选推荐项」的规则自己做了选择，存进「替你做的选择」等用户事后看，不进汇报、不送。
 */
export type ReportKind = "progress" | "done" | "blocked" | "choice";
export const REPORT_KINDS: readonly ReportKind[] = ["progress", "done", "blocked", "choice"];
/** ask_user 的问题最多这么多字符；context 最多 CONTEXT_LIMIT；选项最多 OPTIONS_MAX 个、每个最多 OPTION_LIMIT。 */
export const QUESTION_LIMIT = 1000;
export const CONTEXT_LIMIT = 4000;
export const OPTIONS_MAX = 6;
export const OPTION_LIMIT = 200;
/** report 的正文最多这么多字符。 */
export const REPORT_LIMIT = 4000;

/**
 * 所有 Shipherd session 都有的两个请求（BTL-190 第 2+3 点）：ask_user 记一条「待你决定」，report 交一条汇报。
 * 三种作用域的请求都带它们；普通 ticket session 的 shipherd-sessions 只有这两个工具（member 作用域）。
 */
export type InboxControlOp =
  | { op: "ask_user"; question: string; options?: string[]; context?: string; recommended?: number }
  | { op: "report"; text: string; kind: ReportKind };

/** stack_define 一次最多传几个分支：只是请求大小的上限（防止一次传进来几万个分支），不是栈的层数限制：栈不限层数（工作流 R，K8）。 */
export const MAX_STACK_LAYERS = 1000;

/**
 * 栈式 PR（工作流 K）：feature 总控和 Shipherd 总控有全部四个。
 * stack_define 的 branches 从下到上，每一项是分支名或 ticket 号；stack 给了就整个换掉那个栈的层。
 */
export type StackControlOp =
  | { op: "list_stacks" }
  | { op: "stack_define"; branches: string[]; repo?: string; name?: string; stack?: number }
  | { op: "stack_rebase"; stack: number }
  | { op: "stack_layer_mode"; stack: number; branch: string; mode: "draft" | "branch" };

/**
 * 预审（BTL-271）：epic 总控和 Shipherd 总控都有。ticket、pr 给且只给一个（pr 是 ticket_prs 的 id 或 PR 链接）。
 * epic 总控只能看、只能动自己 epic 里的 ticket 和 PR；Shipherd 总控不限。pre_review_queue 只看队列；epic 总控的队列只列自己 epic 的条目（position 是全队的第几，total 是全队条数）。
 * pre_review_queue_act 取消（cancel）或插队（front）一次预审，给且只给一个预审 id；会作废花了钱的预审，所以和只读的 pre_review_queue 分开、要确认。
 * epic 总控的 front 只排到自己 epic 的最前，越不过别的 epic；Shipherd 总控排到全队最前。
 */
export type PreReviewRef = { ticket: string; pr?: undefined } | { pr: string; ticket?: undefined };
export type PreReviewControlOp =
  | ({ op: "pre_review_status" } & PreReviewRef)
  | ({ op: "pre_review_run" } & PreReviewRef)
  | { op: "pre_review_queue" }
  | ({ op: "pre_review_queue_act" } & ({ cancel: number; front?: undefined } | { front: number; cancel?: undefined }));

export const isPreReviewOp = (op: unknown): op is PreReviewControlOp["op"] =>
  op === "pre_review_status" || op === "pre_review_run" || op === "pre_review_queue" || op === "pre_review_queue_act";

/**
 * ticket 的关闭和后续事项（BTL-270）：feature 总控和 Shipherd 总控都有。close_ticket 是不做了（和 done 做完了分开），
 * 可以顺便关掉开着的 PR、结束 ticket 的 session；reopen_ticket 撤销关闭。set_ticket_status 设手动状态，auto 是清掉手动状态，
 * closed 要给 reason（走 close_ticket）。list_followups 列没处理完的后续事项（all 连处理过的一起），resolve_followup 标成完成或忽略。
 */
export type TicketStatusControlOp =
  | { op: "close_ticket"; ticket: string; reason: string; close_prs?: boolean; pr_urls?: string[]; end_sessions?: boolean }
  | { op: "reopen_ticket"; ticket: string }
  | { op: "set_ticket_status"; ticket: string; status: ManualTicketStatus | "auto"; reason?: string }
  | { op: "list_followups"; ticket?: string; all?: boolean }
  | { op: "resolve_followup"; followup: string; status: "done" | "ignored"; reason: string };

/** ticket 的 session 的请求（ticket 总控 BTL-246 起没有了，只剩 ask_user、report 和下面两个）。 */
export type TicketControlRequest =
  | ({ v: 1; ticketKey: string; from: string | null } & InboxControlOp)
  /** 开发 session 交完成证据（工作流 G）：参数原样带过来，主进程按 parseSubmitEvidence 验。 */
  | { v: 1; ticketKey: string; from: string | null; op: "submit_evidence"; evidence: Record<string, unknown> }
  /** 开发 session 取自己最近一次预审的结果（工作流 G）。只读。 */
  | { v: 1; ticketKey: string; from: string | null; op: "pre_review_result" }
  /** 开发 session 查这个 ticket 的仓库的规矩全文（BTL-274）：按要改的文件（适用范围）、关键词或 #编号。只读。 */
  | { v: 1; ticketKey: string; from: string | null; op: "lessons"; paths?: string[]; query?: string };

/** lessons 工具一次最多带几个路径、关键词多长。 */
export const LESSONS_TOOL_MAX_PATHS = 50;
/** close_ticket 的 pr_urls 最多几个、每个最长多少：超了直接拒绝，不截断（BTL-270 审查）。 */
export const CLOSE_TICKET_MAX_PR_URLS = 50;
export const CLOSE_TICKET_PR_URL_MAX = 2048;
export const LESSONS_TOOL_MAX_QUERY = 200;

/**
 * feature 的规划（features.brief；界面上叫 epic）在 feature 记忆的 handoff 里最多占这么多字符：规划优先，但总要给约定和进度留位置，
 * 否则 ticket 的 session recall 时什么都读不到。
 */
export const EPIC_PLAN_MAX_CHARS = 6000;
/** list_features 里每个 feature 的 summary 最多这么多字符（超出截断）。 */
export const SUMMARY_LIMIT = 1000;

/** create_ticket 最多一次挂几个仓库。 */
export const MAX_CREATE_REPOS = 20;

/**
 * feature 总控的请求（设计文档 2026-10-26）：start_session 指定 ticket，ticket 只有一个仓库时 repo 可以省略。
 * create_ticket：在 feature 下建 ticket（worktree 放进 feature 工作区）；feature 只有一个仓库时 repos 可以省略。
 */
export type FeatureControlRequest =
  | ({ v: 1; featureId: number; from: string | null } & InboxControlOp)
  | ({ v: 1; featureId: number; from: string | null } & StackControlOp)
  | ({ v: 1; featureId: number; from: string | null } & PreReviewControlOp)
  /** BTL-271：epic 总控也能看自己 epic 的 PR 和一个 PR 的评估（和 Shipherd 总控同一份，只是只列自己的）。 */
  | { v: 1; featureId: number; from: string | null; op: "list_prs" }
  | { v: 1; featureId: number; from: string | null; op: "pr_assessment"; pr: string }
  | ({ v: 1; featureId: number; from: string | null } & TicketStatusControlOp)
  | { v: 1; featureId: number; from: string | null; op: "list_tickets" }
  | { v: 1; featureId: number; from: string | null; op: "list_repos" }
  | { v: 1; featureId: number; from: string | null; op: "create_ticket"; ticket: string; title?: string; repos?: string[]; branch?: string; stack_on?: string; feature?: string }
  /**
   * epic 里的 feature（BTL-246 层级 A′，内部叫 block）：feature 是名字或 id（统一成字符串）。
   * reorder_features 的 order 要把这个 epic 的每个 feature 正好列一次；set_ticket_feature 的 feature 为 null 时移出所有 feature。
   */
  | { v: 1; featureId: number; from: string | null; op: "list_features" }
  | { v: 1; featureId: number; from: string | null; op: "create_feature"; name: string; description?: string; before?: string }
  | { v: 1; featureId: number; from: string | null; op: "reorder_features"; order: string[] }
  | { v: 1; featureId: number; from: string | null; op: "set_ticket_feature"; ticket: string; feature: string | null }
  | { v: 1; featureId: number; from: string | null; op: "list_sessions" }
  | { v: 1; featureId: number; from: string | null; op: "session_activity"; session: string }
  | { v: 1; featureId: number; from: string | null; op: "start_session"; ticket: string; repo?: string; task: string; model?: StartModel }
  | { v: 1; featureId: number; from: string | null; op: "end_session"; session: string; reason: string }
  | { v: 1; featureId: number; from: string | null; op: "refresh_session"; session: string }
  /**
   * 给这个 feature 的 ticket session 或修复 session 发一条（排进它的信箱，BTL-245）；interrupt 先按 Esc 叫停。
   * answers（BTL-269 A2）：这条是在替用户回答它的提问，ask_user 的 id，或者 true = 它现在等着的那个（排进来之前问的）。
   */
  | { v: 1; featureId: number; from: string | null; op: "send_message"; session: string; text: string; interrupt?: boolean; answers?: SendAnswers };

/** send_message 的 answers（BTL-269 A2）：替用户回答的 ask_user id，或者 true = 它现在等着的那个。 */
export type SendAnswers = number | true;

/** answers 合不合法：没给、true、或者正整数 id。 */
export const okAnswers = (v: unknown): v is SendAnswers | undefined => v === undefined || v === true || (typeof v === "number" && Number.isSafeInteger(v) && v > 0);

/** epic 里 feature（block）名字、说明的上限，和一次 reorder_features 最多列几个。 */
export const BLOCK_NAME_LIMIT = 100;
export const BLOCK_DESCRIPTION_LIMIT = 2000;
export const BLOCK_ORDER_MAX = 200;

/** Shipherd 总控 send_message 的正文最多这么多字符，超出直接拒绝。 */
export const MESSAGE_LIMIT = 4000;

/**
 * 全局总控的请求（内部叫 Shipherd 总控，BTL-190 第 5 点）：全局只有一个，看得到所有 epic、ticket、PR 和 session，但什么都不建、不删、不结束，
 * 也不开 ticket 的 session。send_message 只能发给 epic 总控（排进它的信箱，BTL-245）：session、epic 给且只给一个，
 * epic 是名字或 id；interrupt 先按 Esc 叫停再送。目标的终端关着时 Shipherd 接着它最近的那个 session（epic 从没开过总控时新开一个）再把消息交进去。
 * list_tickets、list_features、progress_overview 的 epic 是名字或 id（list_epics 里的），可以不给。
 */
/** send_message 发给谁：一个 session，或者一个 epic（它的总控；BTL-246 以前叫 feature）。 */
export type ShipherdMessageTarget = { session: string; epic?: undefined } | { epic: string; session?: undefined };

export type ShipherdControlRequest =
  | ({ v: 1; shipherd: true; from: string | null } & InboxControlOp)
  | ({ v: 1; shipherd: true; from: string | null } & StackControlOp)
  | ({ v: 1; shipherd: true; from: string | null } & PreReviewControlOp)
  | ({ v: 1; shipherd: true; from: string | null } & TicketStatusControlOp)
  /** epic（内部是 features 表）和它们里面 feature 的进度（BTL-246）。 */
  | { v: 1; shipherd: true; from: string | null; op: "list_epics" }
  /** epic 里的 feature（内部是 block），可以只看一个 epic。 */
  | { v: 1; shipherd: true; from: string | null; op: "list_features"; epic?: string }
  | { v: 1; shipherd: true; from: string | null; op: "list_tickets"; epic?: string }
  | { v: 1; shipherd: true; from: string | null; op: "list_prs" }
  | { v: 1; shipherd: true; from: string | null; op: "list_sessions" }
  | { v: 1; shipherd: true; from: string | null; op: "session_activity"; session: string }
  | { v: 1; shipherd: true; from: string | null; op: "list_inbox" }
  | ({ v: 1; shipherd: true; from: string | null; op: "send_message"; text: string; interrupt?: boolean; answers?: SendAnswers } & ShipherdMessageTarget)
  | { v: 1; shipherd: true; from: string | null; op: "refresh_session"; session: string }
  /** 后台给一个 epic 重新生成汇总（ws-b）：立刻返回，生成完 list_epics 能看到新的 summaryAt。 */
  | { v: 1; shipherd: true; from: string | null; op: "refresh_epic_summary"; epic: string }
  /** 进度总览（ws-b）：buildProgress 的聚合，PR 轮到谁和看板同一套算法，可以按 epic 过滤。只读。 */
  | { v: 1; shipherd: true; from: string | null; op: "progress_overview"; epic?: string }
  /** 效果总览（ws-h）：和「效果」页同一份 MetricsOverview。只读。 */
  | { v: 1; shipherd: true; from: string | null; op: "metrics_overview"; days?: number }
  /** 一个 PR 的就绪条件、风险理由、预审和简报（ws-g）。pr 是 ticket_prs 的 id 或 PR 链接。只读。 */
  | { v: 1; shipherd: true; from: string | null; op: "pr_assessment"; pr: string };

export type ControlRequest = TicketControlRequest | FeatureControlRequest | ShipherdControlRequest;

export type ControlResult = { v: 1; ok: true; value: unknown; capacity?: SessionCapacity } | { v: 1; ok: false; error: string };

const okTask = (t: unknown): t is string => typeof t === "string" && t.trim().length > 0 && t.length <= TASK_LIMIT;
const okName = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
/** block 的引用：名字或 id；数字 id 统一成字符串，不合规为 null。 */
const blockRef = (x: unknown): string | null =>
  typeof x === "number" ? (Number.isSafeInteger(x) && x > 0 ? String(x) : null) : okName(x, 200) && x.trim() ? x : null;
const okReason = (r: unknown): r is string => typeof r === "string" && r.trim().length > 0 && r.length <= REASON_LIMIT;

/** 三种请求共用的 session_activity、end_session、refresh_session（list_sessions 各自处理）。 */
function sessionOp<B extends object>(
  base: B, o: Record<string, unknown>,
): (B & { op: "session_activity"; session: string }) | (B & { op: "refresh_session"; session: string }) | (B & { op: "end_session"; session: string; reason: string }) | null {
  if (!okName(o.session, 200)) return null;
  if (o.op === "session_activity") return { ...base, op: "session_activity", session: o.session };
  if (o.op === "refresh_session") return { ...base, op: "refresh_session", session: o.session };
  if (o.op === "end_session" && okReason(o.reason)) return { ...base, op: "end_session", session: o.session, reason: o.reason };
  return null;
}
/** 三种请求共用的 ask_user、report；不合规返回 null。 */
function inboxOp<B extends object>(base: B, o: Record<string, unknown>): (B & InboxControlOp) | null {
  if (o.op === "ask_user") {
    if (typeof o.question !== "string" || !o.question.trim() || o.question.length > QUESTION_LIMIT) return null;
    if (o.context !== undefined && (typeof o.context !== "string" || o.context.length > CONTEXT_LIMIT)) return null;
    if (o.options !== undefined) {
      if (!Array.isArray(o.options) || o.options.length > OPTIONS_MAX) return null;
      if (!o.options.every((x) => typeof x === "string" && x.trim().length > 0 && x.length <= OPTION_LIMIT)) return null;
    }
    const options = o.options as string[] | undefined;
    const context = typeof o.context === "string" && o.context.trim() ? o.context : undefined;
    // recommended（ws-j）：推荐的是第几个选项（从 0 数）；没有选项或越界就不合规。
    if (o.recommended !== undefined && (!Number.isInteger(o.recommended) || (o.recommended as number) < 0 || (o.recommended as number) >= (options?.length ?? 0))) return null;
    return {
      ...base, op: "ask_user", question: o.question,
      ...(options !== undefined && options.length > 0 && { options }),
      ...(context !== undefined && { context }),
      ...(o.recommended !== undefined && { recommended: o.recommended as number }),
    };
  }
  if (o.op === "report") {
    if (typeof o.text !== "string" || !o.text.trim() || o.text.length > REPORT_LIMIT) return null;
    if (o.kind !== undefined && !REPORT_KINDS.includes(o.kind as ReportKind)) return null;
    return { ...base, op: "report", text: o.text, kind: (o.kind as ReportKind | undefined) ?? "progress" };
  }
  return null;
}
const isInboxOp = (op: unknown) => op === "ask_user" || op === "report";

export const isStackOp = (op: unknown): op is StackControlOp["op"] => op === "list_stacks" || op === "stack_define" || op === "stack_rebase" || op === "stack_layer_mode";

const okId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;

/** 预审的四个请求（BTL-271）；不合规返回 null。pr 给数字（list_prs 的 prId）时转成字符串。 */
export function preReviewOp<B extends object>(base: B, o: Record<string, unknown>): (B & PreReviewControlOp) | null {
  if (o.op === "pre_review_queue") return o.cancel === undefined && o.front === undefined ? { ...base, op: "pre_review_queue" } : null;
  if (o.op === "pre_review_queue_act") {
    const given = (["cancel", "front"] as const).filter((k) => o[k] !== undefined);
    if (given.length !== 1 || !okId(o[given[0]])) return null;
    const id = o[given[0]] as number;
    return given[0] === "cancel" ? { ...base, op: "pre_review_queue_act", cancel: id } : { ...base, op: "pre_review_queue_act", front: id };
  }
  if (o.op !== "pre_review_status" && o.op !== "pre_review_run") return null;
  const pr = okId(o.pr) ? String(o.pr) : o.pr;
  const given = (["ticket", "pr"] as const).filter((k) => o[k] !== undefined);
  if (given.length !== 1) return null;
  if (given[0] === "ticket") return okName(o.ticket, 200) && o.ticket.trim() ? { ...base, op: o.op, ticket: o.ticket.trim() } : null;
  return okName(pr, 500) && pr.trim() ? { ...base, op: o.op, pr: pr.trim() } : null;
}

function stackOp<B extends object>(base: B, o: Record<string, unknown>): (B & StackControlOp) | null {
  if (o.op === "list_stacks") return { ...base, op: "list_stacks" };
  if (o.op === "stack_define") {
    if (!Array.isArray(o.branches) || o.branches.length < 2 || o.branches.length > MAX_STACK_LAYERS || !o.branches.every((b) => okName(b, 250))) return null;
    if (o.repo !== undefined && !okName(o.repo, 4096)) return null;
    if (o.name !== undefined && (typeof o.name !== "string" || o.name.length > 200)) return null;
    if (o.stack !== undefined && !okId(o.stack)) return null;
    return {
      ...base, op: "stack_define", branches: o.branches as string[],
      ...(o.repo !== undefined && { repo: o.repo as string }),
      ...(typeof o.name === "string" && o.name.trim() && { name: o.name }),
      ...(o.stack !== undefined && { stack: o.stack as number }),
    };
  }
  if (!okId(o.stack)) return null;
  if (o.op === "stack_rebase") return { ...base, op: "stack_rebase", stack: o.stack };
  if (o.op === "stack_layer_mode") {
    if (!okName(o.branch, 250) || (o.mode !== "draft" && o.mode !== "branch")) return null;
    return { ...base, op: "stack_layer_mode", stack: o.stack, branch: o.branch, mode: o.mode };
  }
  return null;
}

export const isTicketStatusOp = (op: unknown): op is TicketStatusControlOp["op"] =>
  op === "close_ticket" || op === "reopen_ticket" || op === "set_ticket_status" || op === "list_followups" || op === "resolve_followup";

const optBool = (x: unknown): boolean => x === undefined || typeof x === "boolean";

/** 两种总控共用的 ticket 关闭和后续事项请求；不合规返回 null。 */
function ticketStatusOp<B extends object>(base: B, o: Record<string, unknown>): (B & TicketStatusControlOp) | null {
  if (o.op === "list_followups") {
    if (o.ticket !== undefined && !okName(o.ticket, 200)) return null;
    if (!optBool(o.all)) return null;
    return { ...base, op: "list_followups", ...(o.ticket !== undefined && { ticket: o.ticket as string }), ...(o.all === true && { all: true }) };
  }
  if (o.op === "resolve_followup") {
    if (!okName(o.followup, 200) || (o.status !== "done" && o.status !== "ignored") || !okReason(o.reason)) return null;
    return { ...base, op: "resolve_followup", followup: o.followup, status: o.status, reason: o.reason };
  }
  if (!okName(o.ticket, 200)) return null;
  if (o.op === "reopen_ticket") return { ...base, op: "reopen_ticket", ticket: o.ticket };
  if (o.op === "close_ticket") {
    if (!okReason(o.reason) || !optBool(o.close_prs) || !optBool(o.end_sessions)) return null;
    const urls = o.pr_urls;
    if (urls !== undefined && (!Array.isArray(urls) || urls.length > CLOSE_TICKET_MAX_PR_URLS || !urls.every((u) => okName(u, CLOSE_TICKET_PR_URL_MAX)))) return null;
    // 点名了 PR 却说不关（close_prs: false）：自相矛盾，拒绝。
    if (urls !== undefined && o.close_prs === false) return null;
    return {
      ...base, op: "close_ticket", ticket: o.ticket, reason: o.reason,
      ...((o.close_prs === true || urls !== undefined) && { close_prs: true }), ...(urls !== undefined && { pr_urls: urls as string[] }),
      ...(o.end_sessions === true && { end_sessions: true }),
    };
  }
  if (o.op === "set_ticket_status") {
    if (o.status !== "auto" && !MANUAL_TICKET_STATUSES.includes(o.status as ManualTicketStatus)) return null;
    if (o.reason !== undefined && !okReason(o.reason)) return null;
    // 关掉要说为什么（和 close_ticket 一样）。
    if (o.status === "closed" && o.reason === undefined) return null;
    return { ...base, op: "set_ticket_status", ticket: o.ticket, status: o.status as ManualTicketStatus | "auto", ...(o.reason !== undefined && { reason: o.reason as string }) };
  }
  return null;
}

const isSessionOp = (op: unknown) => op === "session_activity" || op === "end_session" || op === "refresh_session";

/** 主进程按运行时类型检查请求（文件谁都能写）：不合规返回 null。ticketKey 和 featureId 必须正好有一个。 */
export function parseControlRequest(raw: unknown): ControlRequest | null {
  let o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== CONTROL_VERSION) return null;
  // 改名前（BTL-260）的 sessions MCP server 写的是 butler: true（升级前起的总控还在跑时）。TODO(5.0) 删。
  if ("butler" in o && !("shipherd" in o)) {
    const { butler, ...rest } = o;
    o = { ...rest, shipherd: butler };
  }
  const from = typeof o.from === "string" && o.from.length > 0 && o.from.length <= 100 ? o.from : null;
  if ("shipherd" in o) return parseShipherdRequest(o, from);
  // 以前的 epic session（BTL-246 去掉了）：它的 MCP server 可能还在跑，请求一律不认。
  if ("epicId" in o) return null;
  if ("featureId" in o) {
    if ("ticketKey" in o || !Number.isSafeInteger(o.featureId) || (o.featureId as number) <= 0) return null;
    const base = { v: 1 as const, featureId: o.featureId as number, from };
    if (isInboxOp(o.op)) return inboxOp(base, o);
    if (isPreReviewOp(o.op)) return preReviewOp(base, o);
    if (o.op === "list_prs") return { ...base, op: "list_prs" };
    if (o.op === "pr_assessment") return okName(o.pr, 500) ? { ...base, op: "pr_assessment", pr: o.pr } : null;
    if (o.op === "list_tickets") return { ...base, op: "list_tickets" };
    if (o.op === "list_repos") return { ...base, op: "list_repos" };
    if (o.op === "list_sessions") return { ...base, op: "list_sessions" };
    if (o.op === "send_message") {
      if (!okName(o.session, 200) || typeof o.text !== "string" || !o.text.trim() || o.text.length > MESSAGE_LIMIT) return null;
      if (o.interrupt !== undefined && typeof o.interrupt !== "boolean") return null;
      if (!okAnswers(o.answers)) return null;
      return { ...base, op: "send_message", session: o.session, text: o.text, ...(o.interrupt === true && { interrupt: true }), ...(o.answers !== undefined && { answers: o.answers }) };
    }
    if (isSessionOp(o.op)) return sessionOp(base, o);
    if (isStackOp(o.op)) return stackOp(base, o);
    if (isTicketStatusOp(o.op)) return ticketStatusOp(base, o);
    if (o.op === "create_ticket") {
      if (!okName(o.ticket, 200)) return null;
      if (o.title !== undefined && (typeof o.title !== "string" || o.title.length > 500)) return null;
      if (o.branch !== undefined && !okName(o.branch, 250)) return null;
      if (o.stack_on !== undefined && !okName(o.stack_on, 200)) return null;
      if (o.repos !== undefined && (!Array.isArray(o.repos) || o.repos.length > MAX_CREATE_REPOS || !o.repos.every((r) => okName(r, 4096)))) return null;
      const feature = o.feature === undefined ? undefined : blockRef(o.feature);
      if (feature === null) return null;
      return {
        ...base, op: "create_ticket", ticket: o.ticket,
        ...(o.title !== undefined && { title: o.title as string }),
        ...(o.repos !== undefined && { repos: o.repos as string[] }),
        ...(o.branch !== undefined && { branch: o.branch as string }),
        ...(o.stack_on !== undefined && { stack_on: o.stack_on as string }),
        ...(feature !== undefined && { feature }),
      };
    }
    if (o.op === "list_features") return { ...base, op: "list_features" };
    if (o.op === "create_feature") {
      if (typeof o.name !== "string" || !o.name.trim() || o.name.trim().length > BLOCK_NAME_LIMIT) return null;
      if (o.description !== undefined && (typeof o.description !== "string" || o.description.length > BLOCK_DESCRIPTION_LIMIT)) return null;
      const before = o.before === undefined ? undefined : blockRef(o.before);
      if (before === null) return null;
      const description = typeof o.description === "string" && o.description.trim() ? o.description.trim() : undefined;
      return { ...base, op: "create_feature", name: o.name.trim(), ...(description !== undefined && { description }), ...(before !== undefined && { before }) };
    }
    if (o.op === "reorder_features") {
      if (!Array.isArray(o.order) || o.order.length === 0 || o.order.length > BLOCK_ORDER_MAX) return null;
      const order = o.order.map(blockRef);
      return order.every((x): x is string => x !== null) ? { ...base, op: "reorder_features", order } : null;
    }
    if (o.op === "set_ticket_feature") {
      if (!okName(o.ticket, 200) || !("feature" in o)) return null;
      const feature = o.feature === null ? null : blockRef(o.feature);
      if (o.feature !== null && feature === null) return null;
      return { ...base, op: "set_ticket_feature", ticket: o.ticket, feature };
    }
    if (o.op === "start_session") {
      if (!okName(o.ticket, 200) || !okTask(o.task)) return null;
      if (o.repo !== undefined && !okName(o.repo, 4096)) return null;
      if (!okModel(o.model)) return null;
      return {
        ...base, op: "start_session", ticket: o.ticket, ...(o.repo !== undefined && { repo: o.repo as string }), task: o.task,
        ...(o.model !== undefined && { model: o.model as StartModel }),
      };
    }
    return null;
  }
  if (!okName(o.ticketKey, 200)) return null;
  const base = { v: 1 as const, ticketKey: o.ticketKey, from };
  if (isInboxOp(o.op)) return inboxOp(base, o);
  if (o.op === "pre_review_result") return { ...base, op: "pre_review_result" };
  if (o.op === "lessons") {
    const paths = o.paths;
    if (paths !== undefined && (!Array.isArray(paths) || paths.length > LESSONS_TOOL_MAX_PATHS || !paths.every((x) => typeof x === "string" && x.length > 0 && x.length <= 4096))) return null;
    if (o.query !== undefined && (typeof o.query !== "string" || o.query.length > LESSONS_TOOL_MAX_QUERY)) return null;
    return { ...base, op: "lessons", ...(paths !== undefined && { paths: paths as string[] }), ...(o.query !== undefined && { query: o.query as string }) };
  }
  if (o.op === "submit_evidence") {
    const e = o.evidence;
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    return { ...base, op: "submit_evidence", evidence: e as Record<string, unknown> };
  }
  return null;
}

/** Shipherd 总控的请求：shipherd 必须是 true，而且不能和别的作用域一起出现。 */
function parseShipherdRequest(o: Record<string, unknown>, from: string | null): ShipherdControlRequest | null {
  if (o.shipherd !== true || "ticketKey" in o || "featureId" in o || "epicId" in o) return null;
  const base = { v: 1 as const, shipherd: true as const, from };
  if (isInboxOp(o.op)) return inboxOp(base, o);
  if (isStackOp(o.op)) return stackOp(base, o);
  if (isPreReviewOp(o.op)) return preReviewOp(base, o);
  if (isTicketStatusOp(o.op)) return ticketStatusOp(base, o);
  if (o.op === "list_epics" || o.op === "list_prs" || o.op === "list_sessions" || o.op === "list_inbox") {
    return { ...base, op: o.op };
  }
  if (o.op === "list_features" || o.op === "list_tickets" || o.op === "progress_overview") {
    if (o.epic !== undefined && !okName(o.epic, 500)) return null;
    return { ...base, op: o.op, ...(o.epic !== undefined && { epic: o.epic as string }) };
  }
  if (o.op === "metrics_overview") {
    if (o.days === undefined) return { ...base, op: "metrics_overview" };
    if (typeof o.days !== "number" || !Number.isInteger(o.days) || o.days < 1 || o.days > 365) return null;
    return { ...base, op: "metrics_overview", days: o.days };
  }
  if (o.op === "pr_assessment") {
    if (!okName(o.pr, 500)) return null;
    return { ...base, op: "pr_assessment", pr: o.pr };
  }
  if (o.op === "refresh_epic_summary") {
    if (!okName(o.epic, 500)) return null;
    return { ...base, op: "refresh_epic_summary", epic: o.epic };
  }
  if (o.op === "session_activity" || o.op === "refresh_session") {
    if (!okName(o.session, 200)) return null;
    return { ...base, op: o.op, session: o.session };
  }
  if (o.op === "send_message") {
    if (typeof o.text !== "string" || !o.text.trim() || o.text.length > MESSAGE_LIMIT) return null;
    if (o.feature !== undefined) return null;
    const given = (["session", "epic"] as const).filter((k) => o[k] !== undefined);
    if (given.length !== 1) return null;
    const key = given[0];
    if (!okName(o[key], key === "session" ? 200 : 500)) return null;
    if (o.interrupt !== undefined && typeof o.interrupt !== "boolean") return null;
    if (!okAnswers(o.answers)) return null;
    return { ...base, op: "send_message", text: o.text, [key]: o[key], ...(o.interrupt === true && { interrupt: true }), ...(o.answers !== undefined && { answers: o.answers }) } as ShipherdControlRequest;
  }
  return null;
}

/**
 * 交给子 session 的任务：统一换行，去掉控制字符和 ESC（任务用 bracketed paste 写进终端，ESC 能提前结束粘贴、把后面的内容当成按键）。
 * 保留换行和制表符。
 */
export function sanitizeTask(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .trim()
    .slice(0, TASK_LIMIT);
}

/** taskMessage 的固定开头；界面上显示会话名时要认得它。 */
export const TASK_PREFIX = { zh: "总控 session 交给你的任务：", en: "Task from the coordinator session:" } as const;

/** 这段话是总控（或者 Shipherd 的需求入口）交给 session 的任务，不是用户在终端里打的。 */
export function isTaskMessage(text: string): boolean {
  const t = text.trimStart();
  return Object.values(TASK_PREFIX).some((p) => t.startsWith(p));
}

/**
 * 交给子 session 的第一条消息：固定的开头加上任务。任务本身可能以 ! 或 / 开头（claude 的 bash 模式、斜杠命令，不经过权限确认），
 * 有了开头它永远只是一段普通的提示。
 */
export function taskMessage(task: string, lang: Lang, memory: "feature" | "ticket" | null): string {
  const en = lang === "en";
  // 记忆关着（null）：没有可以 recall 的东西，不提（R36）。
  if (memory === null) return `${TASK_PREFIX[en ? "en" : "zh"]}\n${task}`;
  // 背景和约定放在记忆里；feature 总控开的 session 读 feature 记忆，ticket 总控开的读 ticket 记忆。
  const featureMemory = en ? "epic memory (shipherd-feature)" : "epic 记忆（shipherd-feature）";
  const ticketMemory = en ? "ticket memory (shipherd-memory)" : "ticket 记忆（shipherd-memory）";
  const where = memory === "feature" ? featureMemory : ticketMemory;
  const hint = en ? `Read the background and agreements from the ${where} with recall before you start.` : `开始之前先用 recall 读一下 ${where}里的背景和约定。`;
  // 记忆那句放在任务后面，这样会话按钮上显示的是任务本身。
  return `${TASK_PREFIX[en ? "en" : "zh"]}\n${task}\n\n${hint}`;
}
