import type { Lang } from "./i18n";

/**
 * 总控 session 开子 session（设计文档 2026-10-23 第二步）：butler-sessions MCP server ↔ Butler 主进程，走文件。
 * 请求：<control>/requests/<id>.json；结果：<control>/results/<id>.json（同一个 id）。
 */

export const CONTROL_VERSION = 1;
/** 一个 ticket 同时最多这么多个运行中的终端（含总控）。到上限时 start_session 返回错误。 */
export const MAX_RUNNING_PER_TICKET = 6;
/** 一个 feature 同时最多这么多个运行中的终端（feature 总控 + 它所有 ticket 的终端；设计文档 2026-10-26）。 */
export const MAX_RUNNING_PER_FEATURE = 8;
/** 一个 epic 下同时最多这么多个 feature 的总控在跑（BTL-190 第 4 点）。到上限时 start_feature 返回错误。 */
export const MAX_RUNNING_FEATURES_PER_EPIC = 4;
/** start_session 的任务最长多少字。 */
export const TASK_LIMIT = 8000;
/** session_activity 返回的命令输出最多这么多字节。 */
export const ACTIVITY_OUTPUT_LIMIT = 4096;
/** end_session 的 reason 最多这么多字符；list_sessions、session_activity 的 last_reply 也最多这么多字符（取结尾）。 */
export const REASON_LIMIT = 500;
export const LAST_REPLY_LIMIT = 500;
/** 请求 id：文件名，只用安全字符。 */
export const CONTROL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** start_session 能选的模型：只有这两个别名。 */
export type StartModel = "opus" | "sonnet";
const START_MODELS: readonly unknown[] = ["opus", "sonnet"];
/** model 省略（undefined）或是 opus / sonnet 才算合法；别的值整个请求当作坏请求。 */
function okModel(v: unknown): boolean {
  return v === undefined || START_MODELS.includes(v);
}

/** report 的种类（BTL-190 第 2+3 点）：progress 只存不送；done、blocked 还送进所属总控的终端。 */
export type ReportKind = "progress" | "done" | "blocked";
export const REPORT_KINDS: readonly ReportKind[] = ["progress", "done", "blocked"];
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
  | { op: "ask_user"; question: string; options?: string[]; context?: string }
  | { op: "report"; text: string; kind: ReportKind };

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
  | { v: 1; ticketKey: string; from: string | null; op: "refresh_session"; session: string };

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
  | { v: 1; featureId: number; from: string | null; op: "list_tickets" }
  | { v: 1; featureId: number; from: string | null; op: "list_repos" }
  | { v: 1; featureId: number; from: string | null; op: "create_ticket"; ticket: string; title?: string; repos?: string[]; branch?: string }
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

export type ControlRequest = TicketControlRequest | FeatureControlRequest | EpicControlRequest;

export type ControlResult = { v: 1; ok: true; value: unknown } | { v: 1; ok: false; error: string };

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
    return {
      ...base, op: "ask_user", question: o.question,
      ...(options !== undefined && options.length > 0 && { options }),
      ...(context !== undefined && { context }),
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

const isSessionOp = (op: unknown) => op === "session_activity" || op === "end_session" || op === "refresh_session";

/** 主进程按运行时类型检查请求（文件谁都能写）：不合规返回 null。ticketKey 和 featureId 必须正好有一个。 */
export function parseControlRequest(raw: unknown): ControlRequest | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== CONTROL_VERSION) return null;
  const from = typeof o.from === "string" && o.from.length > 0 && o.from.length <= 100 ? o.from : null;
  if ("epicId" in o) {
    if ("ticketKey" in o || "featureId" in o || !Number.isSafeInteger(o.epicId) || (o.epicId as number) <= 0) return null;
    const base = { v: 1 as const, epicId: o.epicId as number, from };
    if (isInboxOp(o.op)) return inboxOp(base, o);
    if (o.op === "list_features") return { ...base, op: "list_features" };
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
    if (o.op === "create_ticket") {
      if (!okName(o.ticket, 200)) return null;
      if (o.title !== undefined && (typeof o.title !== "string" || o.title.length > 500)) return null;
      if (o.branch !== undefined && !okName(o.branch, 250)) return null;
      if (o.repos !== undefined && (!Array.isArray(o.repos) || o.repos.length > MAX_CREATE_REPOS || !o.repos.every((r) => okName(r, 4096)))) return null;
      return {
        ...base, op: "create_ticket", ticket: o.ticket,
        ...(o.title !== undefined && { title: o.title as string }),
        ...(o.repos !== undefined && { repos: o.repos as string[] }),
        ...(o.branch !== undefined && { branch: o.branch as string }),
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
  if (o.op === "start_session") {
    if (!okName(o.repo, 4096) || !okTask(o.task) || !okModel(o.model)) return null;
    return { ...base, op: "start_session", repo: o.repo, task: o.task, ...(o.model !== undefined && { model: o.model as StartModel }) };
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
