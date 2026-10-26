import type { SensitiveTerm } from "../../shared/llm";
import type {
  AddRepoInput, CreateFeatureInput, CreateTicketInput, OpenFeatureSessionRequest, UpdateRepoInput, UpdateTicketInput, WorkMode,
} from "../../shared/types";
import { normalizeTerms, SettingError, TERMS_LIMIT } from "../settings/settings-values";

/**
 * 渲染进程不可信：IPC 参数在主进程里按运行时类型检查，不合规就抛错（toIpcResult 包装成 { ok: false }）。
 * 上限在做任何规范化之前生效，超大的输入不会被逐项处理。
 */

/** key 本身的格式（8–512 个可打印 ASCII）由 KeyStore 检查；这里只挡住非字符串和超大的输入。 */
const API_KEY_INPUT_LIMIT = 4096;
/** 提交的条数上限：去重前可以比 TERMS_LIMIT 多一些（normalizeTerms 再按去重后的条数限制）。 */
export const TERMS_INPUT_LIMIT = TERMS_LIMIT * 2;
/** 单个敏感词原文的上限（NFKC 和压缩空白之前）；规范化后的上限是 100 字，由 normalizeTerms 检查。 */
const TERM_INPUT_LENGTH = 1000;

export function apiKeyArg(v: unknown): string {
  // 报错里不带输入：它可能就是 key。
  if (typeof v !== "string" || v.length > API_KEY_INPUT_LIMIT) throw new SettingError("API key 格式不对");
  return v;
}

export function termsArg(v: unknown): SensitiveTerm[] {
  if (!Array.isArray(v)) throw new SettingError("敏感词表格式不对");
  if (v.length > TERMS_INPUT_LIMIT) throw new SettingError(`敏感词最多 ${TERMS_LIMIT} 个`);
  for (const x of v as unknown[]) {
    const o = x as { term?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.term !== "string") throw new SettingError("敏感词表格式不对");
    if (o.term.length > TERM_INPUT_LENGTH) throw new SettingError("敏感词太长（上限 100 字）");
  }
  return normalizeTerms(v);
}

/** 审计翻页的游标：不传，或者正整数（上一页最后一条的 id）。 */
export function auditCursorArg(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return v;
  throw new Error(`invalid audit cursor: ${typeof v}`);
}

/** ticket 号：1–200 字的字符串（格式由 ticket 正则决定；查不到就是空结果）。 */
export function ticketKeyArg(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) throw new Error("invalid ticket key");
  return v;
}

/** StateCore 的事实 / 交接 id（UUID）。 */
export function factIdArg(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(v)) throw new Error("invalid memory id");
  return v;
}

/** 开关：只接受真正的布尔值。 */
export function boolArg(v: unknown): boolean {
  if (typeof v !== "boolean") throw new Error("invalid switch value");
  return v;
}

const optString = (v: unknown, max: number): v is string | undefined => v === undefined || (typeof v === "string" && v.length <= max);

const workModeOpt = (v: unknown): v is WorkMode | undefined => v === undefined || v === "worktree" || v === "branch";

/** 编辑 ticket 的标题。 */
export function updateTicketArg(v: unknown): UpdateTicketInput {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid ticket update");
  const key = ticketKeyArg(o.key);
  if (typeof o.title !== "string" || o.title.length > 500) throw new Error("invalid ticket update");
  return { key, title: o.title };
}

/** ticket 仓库的 id：正整数。 */
export function repoIdArg(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error("invalid repo id");
  return v;
}

/** 给 ticket 加仓库：目录必填，工作方式两种之一，分支可省略。 */
export function addRepoArg(v: unknown): AddRepoInput {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid repo");
  const ticketKey = ticketKeyArg(o.ticketKey);
  if (typeof o.repoPath !== "string" || o.repoPath.length === 0 || o.repoPath.length > 4096) throw new Error("invalid repo path");
  if (o.workMode === undefined || !workModeOpt(o.workMode)) throw new Error("invalid work mode");
  if (!optString(o.branch, 250)) throw new Error("invalid branch");
  return { ticketKey, repoPath: o.repoPath, workMode: o.workMode, branch: o.branch };
}

/** 改仓库的工作方式和分支：省略的字段不变。 */
export function updateRepoArg(v: unknown): UpdateRepoInput {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid repo update");
  const repoId = repoIdArg(o.repoId);
  if (!workModeOpt(o.workMode)) throw new Error("invalid work mode");
  if (!optString(o.branch, 250)) throw new Error("invalid branch");
  return { repoId, workMode: o.workMode, branch: o.branch };
}

/** 写进剪贴板的文本：终端的选区最多是整个回放缓冲。 */
export function clipboardTextArg(v: unknown): string {
  if (typeof v !== "string" || v.length > 1024 * 1024) throw new Error("invalid clipboard text");
  return v;
}

/** session id：claude 的 UUID（也接受 Butler 测试里的短 id），只允许安全字符。 */
export function sessionIdArg(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(v)) throw new Error("invalid session id");
  return v;
}

/** 目录：1–4096 字的字符串（存在与否由调用方检查）。 */
export function dirArg(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096) throw new Error("invalid directory");
  return v;
}

/** feature 的 id：正整数。 */
export function featureIdArg(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error("invalid feature id");
  return v;
}

/** 一次最多选这么多个仓库。 */
const REPO_PATHS_LIMIT = 20;

function repoPathsArg(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > REPO_PATHS_LIMIT) throw new Error("invalid repo paths");
  return (v as unknown[]).map(dirArg);
}

/** feature 名：1–100 字。 */
export function featureNameArg(v: unknown): string {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > 100) throw new Error("invalid feature name");
  return v;
}

/** 新建 feature（设计文档 2026-10-26）。 */
export function createFeatureArg(v: unknown): CreateFeatureInput {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid feature");
  if (o.workspaceDir !== undefined) dirArg(o.workspaceDir);
  return { name: featureNameArg(o.name), repoPaths: repoPathsArg(o.repoPaths), workspaceDir: o.workspaceDir as string | undefined };
}

/** 新建 ticket：可以带 feature 和好几个仓库。 */
export function createTicketArg(v: unknown): CreateTicketInput {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid ticket");
  const key = ticketKeyArg(o.key);
  if (!optString(o.title, 500) || !optString(o.repoPath, 4096) || !optString(o.branch, 250)) throw new Error("invalid ticket");
  if (!workModeOpt(o.workMode)) throw new Error("invalid work mode");
  return {
    key, title: o.title, repoPath: o.repoPath, workMode: o.workMode, branch: o.branch,
    repoPaths: o.repoPaths === undefined ? undefined : repoPathsArg(o.repoPaths),
    featureId: o.featureId === undefined ? undefined : featureIdArg(o.featureId),
  };
}

/** 打开 feature 总控。 */
export function openFeatureArg(v: unknown): OpenFeatureSessionRequest {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid feature session request");
  if (!optString(o.prefill, 100_000)) throw new Error("invalid prefill");
  return {
    featureId: featureIdArg(o.featureId),
    ...(o.sessionId !== undefined && { sessionId: sessionIdArg(o.sessionId) }),
    ...(o.prefill !== undefined && { prefill: o.prefill }),
  };
}
