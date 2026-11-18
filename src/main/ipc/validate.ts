import type { AvailabilityAction } from "../../shared/availability";
import type { SensitiveTerm } from "../../shared/llm";
import { CONTEXT_LIMIT } from "../../shared/control";
import type {
  AddRepoInput, CreateEpicInput, CreateFeatureInput, CreateTicketInput, InboxScope, OpenButlerSessionRequest, OpenEpicSessionRequest, OpenFeatureSessionRequest, OpenFixSessionRequest, UpdateRepoInput, UpdateTicketInput, WorkMode,
} from "../../shared/types";
import type { PrStagesScope } from "../../shared/pr-stages";
import { LESSON_BULK_VERBS, MAX_TARGET_IDS, type LessonAction, type LessonBulkVerb, type LessonTarget } from "../../shared/lessons";
import { parseLessonFilter } from "../../shared/lesson-filter";
import { EPIC_NAME_LIMIT } from "../epics/epic-service";
import { normalizeTerms, SettingError, TERMS_LIMIT } from "../settings/settings-values";
import { M } from "../strings";
import { TicketError } from "../tickets/ticket-service";

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
  if (typeof v !== "string" || v.length > API_KEY_INPUT_LIMIT) throw new SettingError(M().apiKeyFormat);
  return v;
}

export function termsArg(v: unknown): SensitiveTerm[] {
  if (!Array.isArray(v)) throw new SettingError(M().termsFormat);
  if (v.length > TERMS_INPUT_LIMIT) throw new SettingError(M().tooManyTerms(TERMS_LIMIT));
  for (const x of v as unknown[]) {
    const o = x as { term?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.term !== "string") throw new SettingError(M().termsFormat);
    if (o.term.length > TERM_INPUT_LENGTH) throw new SettingError(M().termTooLongShort);
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

/** 一组 session id（「清理闲置」「全部删除」）：最多 500 个，每个都按 sessionIdArg 检查。 */
export function sessionIdsArg(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 500) throw new Error("invalid session ids");
  return v.map(sessionIdArg);
}

/** 「待你决定」条目的 id：正整数。 */
export function inboxIdArg(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error("invalid inbox item id");
  return v;
}

/** 卡片上的回答：非空，最多 CONTEXT_LIMIT 字（送进 session 时还会按 sanitizeTask 清理）。 */
export function inboxAnswerArg(v: unknown): string {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > CONTEXT_LIMIT) throw new Error("invalid answer");
  return v;
}

/** 收件箱的范围：一个 feature、一个 epic，或者全部。 */
export function inboxScopeArg(v: unknown): InboxScope {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid inbox scope");
  if (o.all === true) return { all: true };
  if (o.featureId !== undefined) return { featureId: featureIdArg(o.featureId) };
  if (o.epicId !== undefined) return { epicId: epicIdArg(o.epicId) };
  throw new Error("invalid inbox scope");
}

/** PR 进度的范围：一个 ticket、一个 feature 或一个 epic。 */
export function prStagesScopeArg(v: unknown): PrStagesScope {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid PR stages scope");
  if (o.ticketKey !== undefined) return { ticketKey: ticketKeyArg(o.ticketKey) };
  if (o.featureId !== undefined) return { featureId: featureIdArg(o.featureId) };
  if (o.epicId !== undefined) return { epicId: epicIdArg(o.epicId) };
  throw new Error("invalid PR stages scope");
}

/** 要打开的 PR 链接：最多 2000 字的字符串（能不能开由 openKnownPr 判断）。 */
export function prUrlArg(v: unknown): string {
  if (typeof v !== "string" || v.length > 2000) throw new Error("invalid PR url");
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

/** epic 的 id：正整数。 */
export function epicIdArg(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error("invalid epic id");
  return v;
}

/** epic 名：1–100 字。带上 invalid_name，界面才能显示 epic 自己的提示。 */
export function epicNameArg(v: unknown): string {
  if (typeof v !== "string" || v.trim().length === 0 || v.length > EPIC_NAME_LIMIT) throw new TicketError("invalid_name", M().epicNameInvalid(EPIC_NAME_LIMIT));
  return v;
}

/** 新建 epic（设计文档 2026-11-01）。 */
export function createEpicArg(v: unknown): CreateEpicInput {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid epic");
  if (o.workspaceDir !== undefined) dirArg(o.workspaceDir);
  return { name: epicNameArg(o.name), repoPaths: repoPathsArg(o.repoPaths), workspaceDir: o.workspaceDir as string | undefined };
}

/** feature 移到哪个 epic：null 是移出。不接受 undefined：少传参数不能变成移出。 */
export function moveTargetArg(v: unknown): number | null {
  return v === null ? null : epicIdArg(v);
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

/** 为卡住的 session 开修复 session。 */
export function openFixArg(v: unknown): OpenFixSessionRequest {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid fix session request");
  return { featureId: featureIdArg(o.featureId), stuckSessionId: sessionIdArg(o.stuckSessionId) };
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

/** 打开 Butler 总控（BTL-190 第 5 点）。 */
export function openButlerArg(v: unknown): OpenButlerSessionRequest {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid butler session request");
  if (!optString(o.prefill, 100_000)) throw new Error("invalid prefill");
  return {
    ...(o.sessionId !== undefined && { sessionId: sessionIdArg(o.sessionId) }),
    ...(o.prefill !== undefined && { prefill: o.prefill }),
  };
}

/** 打开 epic session。 */
export function openEpicArg(v: unknown): OpenEpicSessionRequest {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid epic session request");
  if (!optString(o.prefill, 100_000)) throw new Error("invalid prefill");
  return {
    epicId: epicIdArg(o.epicId),
    ...(o.sessionId !== undefined && { sessionId: sessionIdArg(o.sessionId) }),
    ...(o.prefill !== undefined && { prefill: o.prefill }),
  };
}

const LESSON_TEXT_LIMIT = 2000;

function lessonIdArg(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error("invalid lesson id");
  return v;
}

/** 规矩正文和产品名：去掉首尾空白后不能为空，最长 2000 字。 */
function lessonTextArg(v: unknown): string {
  if (typeof v !== "string") throw new Error("invalid lesson text");
  const t = v.trim();
  if (!t || t.length > LESSON_TEXT_LIMIT) throw new Error("invalid lesson text");
  return t;
}

export function lessonSlugArg(v: unknown): string {
  if (typeof v !== "string" || !v || v.length > 512) throw new Error("invalid repo slug");
  return v;
}

export function lessonQueueIdArg(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error("invalid lesson queue id");
  return v;
}

export function lessonRunIdArg(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error("invalid lesson run id");
  return v;
}

/** 复盘规矩页的操作。 */
/** 批量动作的目标：id 列表（1..5000 个正整数）或筛选条件，二者取一。 */
export function lessonTargetArg(v: unknown): LessonTarget {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("invalid lesson target");
  const keys = Object.keys(o);
  if (keys.length !== 1) throw new Error("invalid lesson target");
  if (keys[0] === "ids") {
    if (!Array.isArray(o.ids) || o.ids.length > MAX_TARGET_IDS) throw new Error("invalid lesson target");
    return { ids: o.ids.map(lessonIdArg) };
  }
  if (keys[0] === "filter") return { filter: parseLessonFilter(o.filter) };
  throw new Error("invalid lesson target");
}

export function lessonActionArg(v: unknown): LessonAction {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid lesson action");
  switch (o.op) {
    case "bulk":
      if (typeof o.verb !== "string" || !LESSON_BULK_VERBS.includes(o.verb as LessonBulkVerb)) throw new Error("invalid lesson action");
      return { op: "bulk", verb: o.verb as LessonBulkVerb, target: lessonTargetArg(o.target) };
    case "acceptRecommended":
      return o.target === undefined ? { op: "acceptRecommended" } : { op: "acceptRecommended", target: lessonTargetArg(o.target) };
    case "undoBatch":
      return { op: "undoBatch", batchId: batchIdArg(o.batchId) };
    case "confirm":
      return o.text === undefined ? { op: "confirm", id: lessonIdArg(o.id) } : { op: "confirm", id: lessonIdArg(o.id), text: lessonTextArg(o.text) };
    case "reject":
      return { op: "reject", id: lessonIdArg(o.id) };
    case "edit":
      return { op: "edit", id: lessonIdArg(o.id), text: lessonTextArg(o.text) };
    case "setDisabled":
      if (typeof o.disabled !== "boolean") throw new Error("invalid lesson action");
      return { op: "setDisabled", id: lessonIdArg(o.id), disabled: o.disabled };
    case "delete":
      return { op: "delete", id: lessonIdArg(o.id) };
    case "merge":
      return { op: "merge", keepId: lessonIdArg(o.keepId), dropId: lessonIdArg(o.dropId), text: lessonTextArg(o.text) };
    case "createProduct": {
      if (!Array.isArray(o.slugs) || o.slugs.length > 100) throw new Error("invalid lesson action");
      return { op: "createProduct", name: lessonTextArg(o.name), slugs: o.slugs.map(lessonSlugArg) };
    }
    case "deleteProduct":
      return { op: "deleteProduct", id: lessonIdArg(o.id) };
    case "addToProduct":
      return { op: "addToProduct", id: lessonIdArg(o.id), slug: lessonSlugArg(o.slug) };
    case "removeFromProduct":
      return { op: "removeFromProduct", id: lessonIdArg(o.id), slug: lessonSlugArg(o.slug) };
    case "backfill":
      return { op: "backfill", slug: lessonSlugArg(o.slug) };
    case "openSource":
      return { op: "openSource", sourceId: lessonIdArg(o.sourceId) };
    case "retry":
      return { op: "retry", queueId: lessonQueueIdArg(o.queueId) };
    case "retryFailed":
      return { op: "retryFailed", slug: lessonSlugArg(o.slug) };
    case "cancel":
      return { op: "cancel", queueId: lessonQueueIdArg(o.queueId) };
    case "pauseQueue":
      return { op: "pauseQueue" };
    case "resumeQueue":
      return { op: "resumeQueue" };
    case "runNow":
      return { op: "runNow" };
    case "openInClaude":
      return { op: "openInClaude", runId: lessonRunIdArg(o.runId) };
    default:
      throw new Error("invalid lesson action");
  }
}

/** 批次 id：正整数。 */
export function batchIdArg(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error("invalid batch id");
  return v;
}

/** 批次历史的分页：limit 1..500，beforeId 是上一页最后一个的 id。 */
export function batchListArg(v: unknown): { limit?: number; beforeId?: number } {
  if (v === undefined || v === null) return {};
  const o = v as Record<string, unknown>;
  if (typeof o !== "object" || Array.isArray(o)) throw new Error("invalid batch list");
  for (const k of Object.keys(o)) if (k !== "limit" && k !== "beforeId") throw new Error("invalid batch list");
  const out: { limit?: number; beforeId?: number } = {};
  if (o.limit !== undefined) {
    if (typeof o.limit !== "number" || !Number.isSafeInteger(o.limit) || o.limit < 1 || o.limit > 500) throw new Error("invalid batch list");
    out.limit = o.limit;
  }
  if (o.beforeId !== undefined) out.beforeId = batchIdArg(o.beforeId);
  return out;
}

/** 可用状态页的操作：只有手动暂停 / 恢复复盘。 */
export function availabilityActionArg(v: unknown): AvailabilityAction {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid availability action");
  if (o.op === "resumeLessons") return { op: "resumeLessons" };
  if (o.op === "pauseLessons") return { op: "pauseLessons" };
  throw new Error("invalid availability action");
}
