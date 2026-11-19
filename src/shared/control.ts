import type { Lang } from "./i18n";
import { isModelName, isTier } from "./model-routing";

/**
 * 总控 session 开子 session（设计文档 2026-10-23 第二步）：butler-sessions MCP server ↔ Butler 主进程，走文件。
 * 请求：<control>/requests/<id>.json；结果：<control>/results/<id>.json（同一个 id）。
 */

export const CONTROL_VERSION = 1;
/**
 * 现在还能再开几个 session（工作流 W：按内存决定，不再有每 ticket、每 feature、每 epic 的固定上限）。单位都是 MB。
 * start_session、start_feature 和 list_sessions 的结果带上它，sessions-server 把它写成一行给总控看。
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
 * 所有 Butler session 都有的两个请求（BTL-190 第 2+3 点）：ask_user 记一条「待你决定」，report 交一条汇报。
 * 三种作用域的请求都带它们；普通 ticket session 的 butler-sessions 只有这两个工具（member 作用域）。
 */
export type InboxControlOp =
  | { op: "ask_user"; question: string; options?: string[]; context?: string; recommended?: number }
  | { op: "report"; text: string; kind: ReportKind };

/** stack_define 一次最多传几个分支：只是请求大小的上限（防止一次传进来几万个分支），不是栈的层数限制：栈不限层数（工作流 R，K8）。 */
export const MAX_STACK_LAYERS = 1000;

/**
 * 栈式 PR（工作流 K）：feature 总控和 Butler 总控有全部四个，epic session 只有 list_stacks。
 * stack_define 的 branches 从下到上，每一项是分支名或 ticket 号；stack 给了就整个换掉那个栈的层。
 */
export type StackControlOp =
  | { op: "list_stacks" }
  | { op: "stack_define"; branches: string[]; repo?: string; name?: string; stack?: number }
  | { op: "stack_rebase"; stack: number }
  | { op: "stack_layer_mode"; stack: number; branch: string; mode: "draft" | "branch" };

/** ticket 总控的请求（设计文档 2026-10-23）。 */
export type TicketControlRequest =
  | ({ v: 1; ticketKey: string; from: string | null } & InboxControlOp)
  | { v: 1; ticketKey: string; from: string | null; op: "list_repos" }
  | { v: 1; ticketKey: string; from: string | null; op: "list_sessions" }
  | { v: 1; ticketKey: string; from: string | null; op: "session_activity"; session: string }
  | { v: 1; ticketKey: string; from: string | null; op: "start_session"; repo: string; task: string; model?: StartModel }
  /** 结束一个停下来在等输入的 session（和用户点 × 一样，之后能恢复）。 */
  | { v: 1; ticketKey: string; from: string | null; op: "end_session"; session: string; reason: string }
  /** 让 Butler 给一个停下来的 session 换新上下文（计划 16）：handoff → /clear → 从记忆里接上。 */
  | { v: 1; ticketKey: string; from: string | null; op: "refresh_session"; session: string }
  /** 开发 session 交完成证据（工作流 G）：参数原样带过来，主进程按 parseSubmitEvidence 验。 */
  | { v: 1; ticketKey: string; from: string | null; op: "submit_evidence"; evidence: Record<string, unknown> }
  /** 开发 session 取自己最近一次预审的结果（工作流 G）。只读。 */
  | { v: 1; ticketKey: string; from: string | null; op: "pre_review_result" };

/** epic session 建 feature 时 brief 最多这么多字符，超出直接拒绝。 */
export const BRIEF_LIMIT = 4000;
/**
 * epic 的整体规划（set_epic_plan）最多这么多字符，超出直接拒绝。epic 记忆的 handoff 里规划也最多占这么多：
 * 规划优先，但总要给最新的 feature 留位置，否则 ticket 的 session recall 时什么进度都读不到。
 */
export const EPIC_PLAN_MAX_CHARS = 6000;
/** list_features、epic_context 里每个 feature 的 summary 最多这么多字符（超出截断）。 */
export const SUMMARY_LIMIT = 1000;
/** start_feature 的 instructions 最多这么多字符，超出直接拒绝。 */
export const START_INSTRUCTIONS_LIMIT = 2000;

/** create_ticket 最多一次挂几个仓库。 */
export const MAX_CREATE_REPOS = 20;

/**
 * feature 总控的请求（设计文档 2026-10-26）：start_session 指定 ticket，ticket 只有一个仓库时 repo 可以省略。
 * create_ticket：在 feature 下建 ticket（worktree 放进 feature 工作区）；feature 只有一个仓库时 repos 可以省略。
 */
export type FeatureControlRequest =
  | ({ v: 1; featureId: number; from: string | null } & InboxControlOp)
  | ({ v: 1; featureId: number; from: string | null } & StackControlOp)
  | { v: 1; featureId: number; from: string | null; op: "list_tickets" }
  | { v: 1; featureId: number; from: string | null; op: "list_repos" }
  | { v: 1; featureId: number; from: string | null; op: "create_ticket"; ticket: string; title?: string; repos?: string[]; branch?: string; stack_on?: string }
  | { v: 1; featureId: number; from: string | null; op: "list_sessions" }
  | { v: 1; featureId: number; from: string | null; op: "session_activity"; session: string }
  | { v: 1; featureId: number; from: string | null; op: "start_session"; ticket: string; repo?: string; task: string; model?: StartModel }
  /** feature 属于 epic 时：epic 名字和同一 epic 下其他 feature 的情况。 */
  | { v: 1; featureId: number; from: string | null; op: "epic_context" }
  | { v: 1; featureId: number; from: string | null; op: "end_session"; session: string; reason: string }
  | { v: 1; featureId: number; from: string | null; op: "refresh_session"; session: string };

/**
 * epic session 的请求（设计文档 2026-11-01）：create_feature 在 epic 下建 feature，epic 只有一个仓库时 repos 可以省略。
 * start_feature（BTL-190 第 4 点）：打开 feature 的总控，让它按规划开工；feature 是名字或 id（list_features 里的）。create_feature 带 start 时建完直接开工。
 */
export type EpicControlRequest =
  | ({ v: 1; epicId: number; from: string | null } & InboxControlOp)
  | { v: 1; epicId: number; from: string | null; op: "list_stacks" }
  | { v: 1; epicId: number; from: string | null; op: "list_features" }
  | { v: 1; epicId: number; from: string | null; op: "list_repos" }
  | { v: 1; epicId: number; from: string | null; op: "create_feature"; name: string; repos?: string[]; brief: string; start?: true }
  | { v: 1; epicId: number; from: string | null; op: "start_feature"; feature: string; instructions?: string }
  /** 规划定下来或者改了：整份换掉 epics.plan，再重新渲染 epic 的 handoff。 */
  | { v: 1; epicId: number; from: string | null; op: "set_epic_plan"; plan: string }
  /** epic 下各 feature 的 session：feature 级的（总控、修复）和 ticket 的。 */
  | { v: 1; epicId: number; from: string | null; op: "list_sessions" }
  | { v: 1; epicId: number; from: string | null; op: "session_activity"; session: string }
  | { v: 1; epicId: number; from: string | null; op: "end_session"; session: string; reason: string }
  | { v: 1; epicId: number; from: string | null; op: "refresh_session"; session: string };

/** Butler 总控 send_message 的正文最多这么多字符，超出直接拒绝。 */
export const MESSAGE_LIMIT = 4000;

/**
 * Butler 总控的请求（BTL-190 第 5 点）：全局只有一个，看得到所有 epic、feature、ticket、PR 和 session，但什么都不建、不删、不结束，
 * 也不开 ticket 的 session。send_message 只能发给 epic session 或 feature 总控（经过 DeliveryGuard）：session、feature、epic 给且只给一个，
 * feature、epic 是名字或 id。目标的终端关着时 Butler 接着它最近的那个 session（feature 从没开过总控时新开一个）再把消息交进去。
 * list_tickets 的 feature / epic 是名字或 id（list_features、list_epics 里的），可以都不给。
 */
/** send_message 发给谁：一个 session，或者一个 feature（它的总控）、一个 epic（它的 epic session）。 */
export type ButlerMessageTarget = { session: string; feature?: undefined; epic?: undefined } | { feature: string; session?: undefined; epic?: undefined } | { epic: string; session?: undefined; feature?: undefined };

export type ButlerControlRequest =
  | ({ v: 1; butler: true; from: string | null } & InboxControlOp)
  | ({ v: 1; butler: true; from: string | null } & StackControlOp)
  | { v: 1; butler: true; from: string | null; op: "list_epics" }
  | { v: 1; butler: true; from: string | null; op: "list_features" }
  | { v: 1; butler: true; from: string | null; op: "list_tickets"; feature?: string; epic?: string }
  | { v: 1; butler: true; from: string | null; op: "list_prs" }
  | { v: 1; butler: true; from: string | null; op: "list_sessions" }
  | { v: 1; butler: true; from: string | null; op: "session_activity"; session: string }
  | { v: 1; butler: true; from: string | null; op: "list_inbox" }
  | ({ v: 1; butler: true; from: string | null; op: "send_message"; text: string } & ButlerMessageTarget)
  | { v: 1; butler: true; from: string | null; op: "refresh_session"; session: string }
  /** 后台给一个 feature 重新生成汇总（ws-b）：立刻返回，生成完 list_features 能看到新的 summaryAt。 */
  | { v: 1; butler: true; from: string | null; op: "refresh_feature_summary"; feature: string }
  /** 进度总览（ws-b）：和进度页同一份聚合，可以按 epic / feature 过滤。只读。 */
  | { v: 1; butler: true; from: string | null; op: "progress_overview"; feature?: string; epic?: string }
  /** 效果总览（ws-h）：和「效果」页同一份 MetricsOverview。只读。 */
  | { v: 1; butler: true; from: string | null; op: "metrics_overview"; days?: number }
  /** 一个 PR 的就绪条件、风险理由、预审和简报（ws-g）。pr 是 ticket_prs 的 id 或 PR 链接。只读。 */
  | { v: 1; butler: true; from: string | null; op: "pr_assessment"; pr: string };

export type ControlRequest = TicketControlRequest | FeatureControlRequest | EpicControlRequest | ButlerControlRequest;

export type ControlResult = { v: 1; ok: true; value: unknown; capacity?: SessionCapacity } | { v: 1; ok: false; error: string };

const okTask = (t: unknown): t is string => typeof t === "string" && t.trim().length > 0 && t.length <= TASK_LIMIT;
const okName = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;
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

const isSessionOp = (op: unknown) => op === "session_activity" || op === "end_session" || op === "refresh_session";

/** 主进程按运行时类型检查请求（文件谁都能写）：不合规返回 null。ticketKey 和 featureId 必须正好有一个。 */
export function parseControlRequest(raw: unknown): ControlRequest | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== CONTROL_VERSION) return null;
  const from = typeof o.from === "string" && o.from.length > 0 && o.from.length <= 100 ? o.from : null;
  if ("butler" in o) return parseButlerRequest(o, from);
  if ("epicId" in o) {
    if ("ticketKey" in o || "featureId" in o || !Number.isSafeInteger(o.epicId) || (o.epicId as number) <= 0) return null;
    const base = { v: 1 as const, epicId: o.epicId as number, from };
    if (isInboxOp(o.op)) return inboxOp(base, o);
    if (o.op === "list_features") return { ...base, op: "list_features" };
    if (o.op === "list_stacks") return { ...base, op: "list_stacks" };
    if (o.op === "list_repos") return { ...base, op: "list_repos" };
    if (o.op === "list_sessions") return { ...base, op: "list_sessions" };
    if (isSessionOp(o.op)) return sessionOp(base, o);
    if (o.op === "create_feature") {
      if (!okName(o.name, 500) || typeof o.brief !== "string" || o.brief.length > BRIEF_LIMIT) return null;
      if (o.repos !== undefined && (!Array.isArray(o.repos) || o.repos.length > MAX_CREATE_REPOS || !o.repos.every((r) => okName(r, 4096)))) return null;
      if (o.start !== undefined && typeof o.start !== "boolean") return null;
      return { ...base, op: "create_feature", name: o.name, brief: o.brief, ...(o.repos !== undefined && { repos: o.repos as string[] }), ...(o.start === true && { start: true as const }) };
    }
    if (o.op === "start_feature") {
      if (!okName(o.feature, 500)) return null;
      if (o.instructions !== undefined && (typeof o.instructions !== "string" || o.instructions.length > START_INSTRUCTIONS_LIMIT)) return null;
      const instructions = typeof o.instructions === "string" && o.instructions.trim() ? o.instructions : undefined;
      return { ...base, op: "start_feature", feature: o.feature, ...(instructions !== undefined && { instructions }) };
    }
    if (o.op === "set_epic_plan") {
      if (typeof o.plan !== "string" || !o.plan.trim() || o.plan.length > EPIC_PLAN_MAX_CHARS) return null;
      return { ...base, op: "set_epic_plan", plan: o.plan };
    }
    return null;
  }
  if ("featureId" in o) {
    if ("ticketKey" in o || !Number.isSafeInteger(o.featureId) || (o.featureId as number) <= 0) return null;
    const base = { v: 1 as const, featureId: o.featureId as number, from };
    if (isInboxOp(o.op)) return inboxOp(base, o);
    if (o.op === "list_tickets") return { ...base, op: "list_tickets" };
    if (o.op === "list_repos") return { ...base, op: "list_repos" };
    if (o.op === "list_sessions") return { ...base, op: "list_sessions" };
    if (o.op === "epic_context") return { ...base, op: "epic_context" };
    if (isSessionOp(o.op)) return sessionOp(base, o);
    if (isStackOp(o.op)) return stackOp(base, o);
    if (o.op === "create_ticket") {
      if (!okName(o.ticket, 200)) return null;
      if (o.title !== undefined && (typeof o.title !== "string" || o.title.length > 500)) return null;
      if (o.branch !== undefined && !okName(o.branch, 250)) return null;
      if (o.stack_on !== undefined && !okName(o.stack_on, 200)) return null;
      if (o.repos !== undefined && (!Array.isArray(o.repos) || o.repos.length > MAX_CREATE_REPOS || !o.repos.every((r) => okName(r, 4096)))) return null;
      return {
        ...base, op: "create_ticket", ticket: o.ticket,
        ...(o.title !== undefined && { title: o.title as string }),
        ...(o.repos !== undefined && { repos: o.repos as string[] }),
        ...(o.branch !== undefined && { branch: o.branch as string }),
        ...(o.stack_on !== undefined && { stack_on: o.stack_on as string }),
      };
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
  if (o.op === "list_repos") return { ...base, op: "list_repos" };
  if (o.op === "list_sessions") return { ...base, op: "list_sessions" };
  if (isSessionOp(o.op)) return sessionOp(base, o);
  if (o.op === "pre_review_result") return { ...base, op: "pre_review_result" };
  if (o.op === "submit_evidence") {
    const e = o.evidence;
    if (!e || typeof e !== "object" || Array.isArray(e)) return null;
    return { ...base, op: "submit_evidence", evidence: e as Record<string, unknown> };
  }
  if (o.op === "start_session") {
    if (!okName(o.repo, 4096) || !okTask(o.task) || !okModel(o.model)) return null;
    return { ...base, op: "start_session", repo: o.repo, task: o.task, ...(o.model !== undefined && { model: o.model as StartModel }) };
  }
  return null;
}

/** Butler 总控的请求：butler 必须是 true，而且不能和别的作用域一起出现。 */
function parseButlerRequest(o: Record<string, unknown>, from: string | null): ButlerControlRequest | null {
  if (o.butler !== true || "ticketKey" in o || "featureId" in o || "epicId" in o) return null;
  const base = { v: 1 as const, butler: true as const, from };
  if (isInboxOp(o.op)) return inboxOp(base, o);
  if (isStackOp(o.op)) return stackOp(base, o);
  if (o.op === "list_epics" || o.op === "list_features" || o.op === "list_prs" || o.op === "list_sessions" || o.op === "list_inbox") {
    return { ...base, op: o.op };
  }
  if (o.op === "list_tickets" || o.op === "progress_overview") {
    if (o.feature !== undefined && !okName(o.feature, 500)) return null;
    if (o.epic !== undefined && !okName(o.epic, 500)) return null;
    return { ...base, op: o.op, ...(o.feature !== undefined && { feature: o.feature as string }), ...(o.epic !== undefined && { epic: o.epic as string }) };
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
  if (o.op === "refresh_feature_summary") {
    if (!okName(o.feature, 500)) return null;
    return { ...base, op: "refresh_feature_summary", feature: o.feature };
  }
  if (o.op === "session_activity" || o.op === "refresh_session") {
    if (!okName(o.session, 200)) return null;
    return { ...base, op: o.op, session: o.session };
  }
  if (o.op === "send_message") {
    if (typeof o.text !== "string" || !o.text.trim() || o.text.length > MESSAGE_LIMIT) return null;
    const given = (["session", "feature", "epic"] as const).filter((k) => o[k] !== undefined);
    if (given.length !== 1) return null;
    const key = given[0];
    if (!okName(o[key], key === "session" ? 200 : 500)) return null;
    return { ...base, op: "send_message", text: o.text, [key]: o[key] } as ButlerControlRequest;
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

/**
 * 交给子 session 的第一条消息：固定的开头加上任务。任务本身可能以 ! 或 / 开头（claude 的 bash 模式、斜杠命令，不经过权限确认），
 * 有了开头它永远只是一段普通的提示。
 */
export function taskMessage(task: string, lang: Lang, memory: "feature" | "ticket" | null): string {
  const en = lang === "en";
  // 记忆关着（null）：没有可以 recall 的东西，不提（R36）。
  if (memory === null) return `${TASK_PREFIX[en ? "en" : "zh"]}\n${task}`;
  // 背景和约定放在记忆里；feature 总控开的 session 读 feature 记忆，ticket 总控开的读 ticket 记忆。
  const featureMemory = en ? "feature memory (butler-feature)" : "feature 记忆（butler-feature）";
  const ticketMemory = en ? "ticket memory (butler-memory)" : "ticket 记忆（butler-memory）";
  const where = memory === "feature" ? featureMemory : ticketMemory;
  const hint = en ? `Read the background and agreements from the ${where} with recall before you start.` : `开始之前先用 recall 读一下 ${where}里的背景和约定。`;
  // 记忆那句放在任务后面，这样会话按钮上显示的是任务本身。
  return `${TASK_PREFIX[en ? "en" : "zh"]}\n${task}\n\n${hint}`;
}
