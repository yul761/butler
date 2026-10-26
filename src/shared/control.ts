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
/** start_session 的任务最长多少字。 */
export const TASK_LIMIT = 8000;
/** 请求 id：文件名，只用安全字符。 */
export const CONTROL_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** ticket 总控的请求（设计文档 2026-10-23）。 */
export type TicketControlRequest =
  | { v: 1; ticketKey: string; from: string | null; op: "list_repos" }
  | { v: 1; ticketKey: string; from: string | null; op: "list_sessions" }
  | { v: 1; ticketKey: string; from: string | null; op: "start_session"; repo: string; task: string };

/** feature 总控的请求（设计文档 2026-10-26）：start_session 指定 ticket，ticket 只有一个仓库时 repo 可以省略。 */
export type FeatureControlRequest =
  | { v: 1; featureId: number; from: string | null; op: "list_tickets" }
  | { v: 1; featureId: number; from: string | null; op: "list_sessions" }
  | { v: 1; featureId: number; from: string | null; op: "start_session"; ticket: string; repo?: string; task: string };

export type ControlRequest = TicketControlRequest | FeatureControlRequest;

export type ControlResult = { v: 1; ok: true; value: unknown } | { v: 1; ok: false; error: string };

const okTask = (t: unknown): t is string => typeof t === "string" && t.trim().length > 0 && t.length <= TASK_LIMIT;
const okName = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;

/** 主进程按运行时类型检查请求（文件谁都能写）：不合规返回 null。ticketKey 和 featureId 必须正好有一个。 */
export function parseControlRequest(raw: unknown): ControlRequest | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.v !== CONTROL_VERSION) return null;
  const from = typeof o.from === "string" && o.from.length > 0 && o.from.length <= 100 ? o.from : null;
  if ("featureId" in o) {
    if ("ticketKey" in o || !Number.isSafeInteger(o.featureId) || (o.featureId as number) <= 0) return null;
    const base = { v: 1 as const, featureId: o.featureId as number, from };
    if (o.op === "list_tickets") return { ...base, op: "list_tickets" };
    if (o.op === "list_sessions") return { ...base, op: "list_sessions" };
    if (o.op === "start_session") {
      if (!okName(o.ticket, 200) || !okTask(o.task)) return null;
      if (o.repo !== undefined && !okName(o.repo, 4096)) return null;
      return { ...base, op: "start_session", ticket: o.ticket, ...(o.repo !== undefined && { repo: o.repo as string }), task: o.task };
    }
    return null;
  }
  if (!okName(o.ticketKey, 200)) return null;
  const base = { v: 1 as const, ticketKey: o.ticketKey, from };
  if (o.op === "list_repos") return { ...base, op: "list_repos" };
  if (o.op === "list_sessions") return { ...base, op: "list_sessions" };
  if (o.op === "start_session") {
    if (!okName(o.repo, 4096) || !okTask(o.task)) return null;
    return { ...base, op: "start_session", repo: o.repo, task: o.task };
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

/**
 * 交给子 session 的第一条消息：固定的开头加上任务。任务本身可能以 ! 或 / 开头（claude 的 bash 模式、斜杠命令，不经过权限确认），
 * 有了开头它永远只是一段普通的提示。
 */
export function taskMessage(task: string, lang: Lang = "zh"): string {
  return `${lang === "en" ? "Task from the coordinator session:" : "总控 session 交给你的任务："}\n${task}`;
}
