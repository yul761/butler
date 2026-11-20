import type { AvailabilityAction, LimitKind } from "../../shared/availability";
import { isBgKind, type BackgroundAction } from "../../shared/background";
import { isModelName, isTaskId, isTier, POLICIES, type LimitPolicy, type LimitRuleKind, type RegistryModel, type RoutingAction, type Tier } from "../../shared/model-routing";
import type { SensitiveTerm } from "../../shared/llm";
import { CONTEXT_LIMIT } from "../../shared/control";
import { CONV_LIST_MAX, CONV_QUERY_MAX, type ConvListOpts } from "../../shared/conversation";
import type {
  AddRepoInput, CiItemRef, CreateEpicInput, CreateFeatureInput, CreateTicketInput, InboxScope, OpenButlerSessionRequest, OpenEpicSessionRequest, OpenFeatureSessionRequest, OpenFixSessionRequest, UpdateRepoInput, UpdateTicketInput, WorkMode,
} from "../../shared/types";
import type { PrStagesScope } from "../../shared/pr-stages";
import { LESSON_BULK_VERBS, MAX_TARGET_IDS, type LessonAction, type LessonBulkVerb, type LessonTarget } from "../../shared/lessons";
import { parseLessonFilter } from "../../shared/lesson-filter";
import type { AdmissionScope, CalibrationAction, WizardAction } from "../../shared/lesson-admission";
import type { BacktestAction } from "../../shared/backtest";
import { CHECKS_BULK_OPS, parseCheckScope, type CheckScope, type ChecksAction, type ChecksBulkOp } from "../../shared/checks";
import { parsePolicyOverrides, type AdmissionPolicyOverrides, type PolicyScope } from "../../shared/admission-policy";
import type { BaselinesAction, CheckExportAction, LegacyAction } from "../../shared/baselines";
import { parseLoopOverrides, type LoopPolicyOverrides, type LoopScope } from "../../shared/loop-policy";
import { COMMENT_CATEGORIES, type CommentAction, type CommentCategory, type FlakyAction } from "../../shared/loop";
import type { StackLayerMode, StacksFilter } from "../../shared/stacks";
import { INTAKE_RISKS, INTAKE_SIZES, type IntakeAction, type IntakeClassifyEdit } from "../../shared/intake";
import { isAbsolutePath } from "../intake/repo-map";
import {
  EXPORT_CONTENTS, type ExportContent, type ExportRequest, type ExportScopeArg, type ImportApplyRequest, type Resolution, type StarterTarget,
} from "../../shared/config-io";
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

/** conv:list 的选项：limit 必须是正整数（大于 CONV_LIST_MAX 的取 CONV_LIST_MAX），before 是正整数或不给，qaOnly 是布尔或不给。 */
export function convListOptsArg(v: unknown): ConvListOpts {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid conversation list options");
  const o = v as { limit?: unknown; before?: unknown; qaOnly?: unknown };
  const posInt = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x > 0;
  if (!posInt(o.limit)) throw new Error("invalid conversation page size");
  if (o.before !== undefined && !posInt(o.before)) throw new Error("invalid conversation cursor");
  if (o.qaOnly !== undefined && typeof o.qaOnly !== "boolean") throw new Error("invalid conversation filter");
  return {
    limit: Math.min(o.limit, CONV_LIST_MAX),
    ...(o.before !== undefined && { before: o.before }),
    ...(o.qaOnly !== undefined && { qaOnly: o.qaOnly }),
  };
}

/** 搜索词：必须是字符串，超出 CONV_QUERY_MAX 的部分截掉。 */
export function convQueryArg(v: unknown): string {
  if (typeof v !== "string") throw new Error("invalid search query");
  const cps = [...v];
  return cps.length <= CONV_QUERY_MAX ? v : cps.slice(0, CONV_QUERY_MAX).join("");
}

/** null（所有对话）或 sessionIdArg。 */
export function convRootArg(v: unknown): string | null {
  return v === null ? null : sessionIdArg(v);
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
/** 进度页的过滤（ws-b）：epicId、featureId 是正整数或 null / 不给。 */
export function progressFilterArg(v: unknown): { epicId: number | null; featureId: number | null } {
  if (v === undefined || v === null) return { epicId: null, featureId: null };
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("invalid progress filter");
  const o = v as Record<string, unknown>;
  const id = (x: unknown, what: string): number | null => {
    if (x === undefined || x === null) return null;
    if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) throw new Error(`invalid ${what} id`);
    return x;
  };
  return { epicId: id(o.epicId, "epic"), featureId: id(o.featureId, "feature") };
}

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
/** 批量动作的 expect：没给就不检查。 */
function expectArg(v: unknown): { expect?: number } {
  if (v === undefined) return {};
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("invalid lesson action");
  return { expect: v };
}

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
      return { op: "bulk", verb: o.verb as LessonBulkVerb, target: lessonTargetArg(o.target), ...expectArg(o.expect) };
    case "acceptRecommended":
      return { op: "acceptRecommended", ...(o.target === undefined ? {} : { target: lessonTargetArg(o.target) }), ...expectArg(o.expect) };
    case "undoBatch":
      return { op: "undoBatch", batchId: batchIdArg(o.batchId) };
    case "enrich":
      return { op: "enrich" };
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

/** 准入的范围：一个仓库、一个产品或全部。 */
export function admissionScopeArg(v: unknown): AdmissionScope {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid admission scope");
  if (o.kind === "all") return { kind: "all" };
  if (o.kind === "repo") return { kind: "repo", slug: lessonSlugArg(o.slug) };
  if (o.kind === "product") return { kind: "product", productId: lessonIdArg(o.productId) };
  throw new Error("invalid admission scope");
}

const wizardRunIdArg = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error("invalid wizard run");
  return v;
};

export function wizardActionArg(v: unknown): WizardAction {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid wizard action");
  switch (o.op) {
    case "start":
      return { op: "start", scope: admissionScopeArg(o.scope) };
    case "recalculate":
    case "retry":
    case "accept":
    case "cancel":
      return { op: o.op, runId: wizardRunIdArg(o.runId) };
    case "pullBack":
    case "rejectGroup":
      if (!Array.isArray(o.lessonIds) || o.lessonIds.length === 0 || o.lessonIds.length > MAX_TARGET_IDS) throw new Error("invalid wizard action");
      return { op: o.op, runId: wizardRunIdArg(o.runId), lessonIds: o.lessonIds.map(lessonIdArg) };
    default:
      throw new Error("invalid wizard action");
  }
}

/** 校准页「这次抽样从什么时候起」：null 或毫秒时间戳。 */
export function calibrationSinceArg(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("invalid calibration time");
  return v;
}

export function calibrationActionArg(v: unknown): CalibrationAction {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new Error("invalid calibration action");
  if (o.op === "markCalibrated") return { op: "markCalibrated" };
  if (o.op === "mark") {
    if (o.mark !== "good" && o.mark !== "bad" && o.mark !== "skip") throw new Error("invalid calibration action");
    const since = calibrationSinceArg(o.since);
    if (since === null) throw new Error("invalid calibration action");
    return { op: "mark", lessonId: lessonIdArg(o.lessonId), mark: o.mark, since };
  }
  throw new Error("invalid calibration action");
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

/** 「现在」页重发的那条 CI 结论（工作流 W）。 */
export function ciItemArg(v: unknown): CiItemRef {
  const o = v as Record<string, unknown> | null;
  const id = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
  if (o && typeof o === "object" && !Array.isArray(o)) {
    const keys = Object.keys(o).sort().join(",");
    if (o.kind === "pr" && keys === "id,kind" && id(o.id)) return { kind: "pr", id: o.id as number };
    if (o.kind === "branch" && keys === "kind,repoId" && id(o.repoId)) return { kind: "branch", repoId: o.repoId as number };
  }
  throw new Error("invalid ci item");
}

// ---- 准入策略、导入导出（契约 4.2 / 4.3）

const objArg = (v: unknown, what: string, keys: readonly string[]): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`invalid ${what}`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new Error(`invalid ${what}`);
  return v as Record<string, unknown>;
};
const posInt = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error(`invalid ${what}`);
  return v;
};

/** 策略的一层：global / product / repo。 */
export function policyScopeArg(v: unknown): PolicyScope {
  const o = objArg(v, "policy scope", ["kind", "productId", "slug"]);
  if (o.kind === "global" && o.productId === undefined && o.slug === undefined) return { kind: "global" };
  if (o.kind === "product" && o.slug === undefined) return { kind: "product", productId: posInt(o.productId, "policy scope") };
  if (o.kind === "repo" && o.productId === undefined) return { kind: "repo", slug: lessonSlugArg(o.slug) };
  throw new Error("invalid policy scope");
}

/** 改一层：覆盖整个换掉（值在服务里再按键校验）。 */
export function policySetArg(v: unknown): { scope: PolicyScope; overrides: AdmissionPolicyOverrides } {
  const o = objArg(v, "policy change", ["scope", "overrides"]);
  return { scope: policyScopeArg(o.scope), overrides: parsePolicyOverrides(o.overrides) };
}

/** 评论与 CI 策略改一层（工作流 I）：覆盖整个换掉，值按键校验。 */
export function loopSetArg(v: unknown): { scope: LoopScope; overrides: LoopPolicyOverrides } {
  const o = objArg(v, "loop policy change", ["scope", "overrides"]);
  return { scope: policyScopeArg(o.scope), overrides: parseLoopOverrides(o.overrides) };
}

export function commentActionArg(v: unknown): CommentAction {
  const o = objArg(v, "comment action", ["op", "id", "category"]);
  const id = posInt(o.id, "comment action");
  if (o.op === "categorize") {
    if (!(COMMENT_CATEGORIES as readonly unknown[]).includes(o.category)) throw new Error("invalid comment action");
    return { op: "categorize", id, category: o.category as CommentCategory };
  }
  if (o.category !== undefined) throw new Error("invalid comment action");
  if (o.op === "send" || o.op === "dismiss" || o.op === "reply") return { op: o.op, id };
  throw new Error("invalid comment action");
}

export function flakyActionArg(v: unknown): FlakyAction {
  const o = objArg(v, "flaky action", ["op", "repoSlug", "kind", "name"]);
  if (o.op !== "add" && o.op !== "remove") throw new Error("invalid flaky action");
  if (o.kind !== "check" && o.kind !== "test") throw new Error("invalid flaky action");
  if (typeof o.name !== "string" || !o.name.trim() || o.name.length > 200) throw new Error("invalid flaky action");
  return { op: o.op, repoSlug: lessonSlugArg(o.repoSlug), kind: o.kind, name: o.name.trim() };
}

export function exportRequestArg(v: unknown): ExportRequest {
  const o = objArg(v, "export request", ["scope", "options", "starter"]);
  const sc = objArg(o.scope, "export scope", ["kind", "productId", "slug"]);
  let scope: ExportScopeArg;
  if (sc.kind === "all" && sc.productId === undefined && sc.slug === undefined) scope = { kind: "all" };
  else if (sc.kind === "product" && sc.slug === undefined) scope = { kind: "product", productId: posInt(sc.productId, "export scope") };
  else if (sc.kind === "repo" && sc.productId === undefined) scope = { kind: "repo", slug: lessonSlugArg(sc.slug) };
  else throw new Error("invalid export scope");
  const op = objArg(o.options, "export options", ["content", "includeSourceUrls", "includeBaselines"]);
  if (!(EXPORT_CONTENTS as readonly unknown[]).includes(op.content) || typeof op.includeSourceUrls !== "boolean") throw new Error("invalid export options");
  if (op.includeBaselines !== undefined && typeof op.includeBaselines !== "boolean") throw new Error("invalid export options");
  const req: ExportRequest = { scope, options: { content: op.content as ExportContent, includeSourceUrls: op.includeSourceUrls, ...(op.includeBaselines ? { includeBaselines: true } : {}) } };
  if (o.starter !== undefined) {
    const st = objArg(o.starter, "starter pack", ["name"]);
    if (typeof st.name !== "string" || !st.name.trim() || st.name.length > 200) throw new Error("invalid starter pack");
    req.starter = { name: st.name.trim() };
  }
  return req;
}

const TOKEN_RE = /^[0-9a-f-]{36}$/;
function tokenArg(v: unknown): string {
  if (typeof v !== "string" || !TOKEN_RE.test(v)) throw new Error("invalid import token");
  return v;
}

export function starterTargetArg(v: unknown): StarterTarget {
  const o = objArg(v, "starter target", ["kind", "productId", "slug"]);
  if (o.kind === "repo" && o.productId === undefined) return { kind: "repo", slug: lessonSlugArg(o.slug) };
  if (o.kind === "product" && o.slug === undefined) return { kind: "product", productId: posInt(o.productId, "starter target") };
  throw new Error("invalid starter target");
}

export function importRetargetArg(v: unknown): { token: string; target: StarterTarget } {
  const o = objArg(v, "import retarget", ["token", "target"]);
  return { token: tokenArg(o.token), target: starterTargetArg(o.target) };
}

const RESOLUTIONS = ["imported", "local"] as const;
const MAX_RESOLUTIONS = 100_000;
export function importApplyArg(v: unknown): ImportApplyRequest {
  const o = objArg(v, "import", ["token", "mode", "bulk", "resolutions"]);
  if (o.mode !== "merge" && o.mode !== "replace") throw new Error("invalid import");
  const req: ImportApplyRequest = { token: tokenArg(o.token), mode: o.mode };
  if (o.bulk !== undefined) {
    if (!(RESOLUTIONS as readonly unknown[]).includes(o.bulk)) throw new Error("invalid import");
    req.bulk = o.bulk as Resolution;
  }
  if (o.resolutions !== undefined) {
    const r = objArg(o.resolutions, "import", Object.keys((o.resolutions ?? {}) as object));
    const entries = Object.entries(r);
    if (entries.length > MAX_RESOLUTIONS) throw new Error("invalid import");
    const out: Record<string, Resolution> = {};
    for (const [k, val] of entries) {
      if (!/^[\w-]{1,100}:[0-9a-f]{16}$/.test(k) || !(RESOLUTIONS as readonly unknown[]).includes(val)) throw new Error("invalid import");
      out[k] = val as Resolution;
    }
    req.resolutions = out;
  }
  return req;
}

/** 检查的层：global / product / repo（slug 规范化后）。 */
export function checkScopeArg(v: unknown): CheckScope {
  const s = parseCheckScope(v);
  if (!s) throw new Error("invalid check scope");
  return s;
}

/** 一条检查的 key：内置的 builtin:…，自己建的 ck_…，导入的保持原样（只要是短的可见字符）。 */
export function checkKeyArg(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_:.-]{1,80}$/.test(v)) throw new Error("invalid check key");
  return v;
}

const positiveId = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error(`invalid ${what}`);
  return v;
};

/** 检查页的操作。检查内容本身（input）只限大小，字段由 ChecksService 用 validateCheckInput 校验。 */
export function checksActionArg(v: unknown): ChecksAction {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("invalid checks action");
  switch (o.op) {
    case "save": {
      if (JSON.stringify(o.input ?? null).length > 64 * 1024) throw new Error("invalid checks action");
      const id = o.id === null ? null : positiveId(o.id, "check id");
      const lessonId = o.lessonId === undefined || o.lessonId === null ? null : positiveId(o.lessonId, "lesson id");
      return { op: "save", scope: checkScopeArg(o.scope), id, input: o.input, lessonId };
    }
    case "override":
      return { op: "override", scope: checkScopeArg(o.scope), key: checkKeyArg(o.key) };
    case "bulk": {
      if (!Array.isArray(o.ids) || o.ids.length < 1 || o.ids.length > 500) throw new Error("invalid checks action");
      if (typeof o.verb !== "string" || !CHECKS_BULK_OPS.includes(o.verb as ChecksBulkOp)) throw new Error("invalid checks action");
      return { op: "bulk", ids: o.ids.map((x) => positiveId(x, "check id")), verb: o.verb as ChecksBulkOp };
    }
    case "verdict":
      if (o.verdict !== null && o.verdict !== "false_positive" && o.verdict !== "true_positive") throw new Error("invalid checks action");
      return { op: "verdict", hitId: positiveId(o.hitId, "hit id"), verdict: o.verdict };
    case "classify":
      if (o.checkability !== null && o.checkability !== "checkable" && o.checkability !== "prose") throw new Error("invalid checks action");
      return { op: "classify", lessonId: positiveId(o.lessonId, "lesson id"), checkability: o.checkability };
    default:
      throw new Error("invalid checks action");
  }
}

export const checkLessonIdArg = (v: unknown): number => positiveId(v, "lesson id");

const LIMIT_KINDS: readonly unknown[] = ["usage_limit", "rate_limit", "overloaded", "model_unavailable"];
const RULE_KINDS: readonly unknown[] = ["regex", "status", "field", "reset"];
const bad = (): never => {
  throw new Error("invalid routing action");
};
const str = (v: unknown, max = 500): string => (typeof v === "string" && v.length <= max ? v : bad());
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : bad());
const price = (v: unknown): number | null => (v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0) ? v : bad());
const tierOrNull = (v: unknown): Tier | null => (v === null || v === undefined ? null : isTier(v) ? v : bad());

function registryModelArg(v: unknown): RegistryModel {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") bad();
  return {
    name: str(o!.name, 200), tier: isTier(o!.tier) ? o!.tier : bad(), enabled: bool(o!.enabled), account: str(o!.account, 100),
    priceIn: price(o!.priceIn), priceOut: price(o!.priceOut), note: str(o!.note, 500),
  };
}

/** 设置页「模型路由」的操作：只查形状，内容（名字格式、是否重复等）由 RoutingService.act 查。 */
export function routingActionArg(v: unknown): RoutingAction {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return bad();
  switch (o.op) {
    case "discover":
    case "rerunDegraded":
      return { op: o.op };
    case "addModel":
      return { op: "addModel", model: registryModelArg(o.model) };
    case "updateModel": {
      const p = o.patch as Record<string, unknown> | null;
      if (!p || typeof p !== "object") return bad();
      const patch: Partial<Omit<RegistryModel, "name">> = {};
      if (p.tier !== undefined) patch.tier = isTier(p.tier) ? p.tier : bad();
      if (p.enabled !== undefined) patch.enabled = bool(p.enabled);
      if (p.account !== undefined) patch.account = str(p.account, 100);
      if (p.priceIn !== undefined) patch.priceIn = price(p.priceIn);
      if (p.priceOut !== undefined) patch.priceOut = price(p.priceOut);
      if (p.note !== undefined) patch.note = str(p.note, 500);
      return { op: "updateModel", name: str(o.name, 200), patch };
    }
    case "removeModel":
    case "clearHealth":
    case "probe":
      return o.op === "removeModel" ? { op: o.op, name: str(o.name, 200) } : { op: o.op, model: str(o.model, 200) };
    case "moveModel":
      return { op: "moveModel", name: str(o.name, 200), delta: o.delta === 1 || o.delta === -1 ? o.delta : bad() };
    case "setChain":
      if (!Array.isArray(o.models) || o.models.length > 50) return bad();
      return { op: "setChain", tier: isTier(o.tier) ? o.tier : bad(), models: o.models.map((m) => str(m, 200)) };
    case "setTaskRoute": {
      const r = o.route as Record<string, unknown> | null;
      if (!r || typeof r !== "object" || !isTaskId(r.task)) return bad();
      const policy = r.policy === null || r.policy === undefined ? null : POLICIES.includes(r.policy as LimitPolicy) ? (r.policy as LimitPolicy) : bad();
      const critical = r.critical === null || r.critical === undefined ? null : bool(r.critical);
      return { op: "setTaskRoute", route: { task: r.task, tier: tierOrNull(r.tier), minTier: tierOrNull(r.minTier), policy, critical } };
    }
    case "clearTaskRoute":
      return isTaskId(o.task) ? { op: "clearTaskRoute", task: o.task } : bad();
    case "confirmError":
      if (!Number.isInteger(o.id) || !LIMIT_KINDS.includes(o.category)) return bad();
      return { op: "confirmError", id: o.id as number, category: o.category as LimitKind, accountLevel: bool(o.accountLevel) };
    case "dismissError":
      return Number.isInteger(o.id) ? { op: "dismissError", id: o.id as number } : bad();
    case "addRule": {
      const r = o.rule as Record<string, unknown> | null;
      if (!r || typeof r !== "object" || !RULE_KINDS.includes(r.kind)) return bad();
      const category = r.category === null ? null : LIMIT_KINDS.includes(r.category) ? (r.category as LimitKind) : bad();
      return { op: "addRule", rule: { kind: r.kind as LimitRuleKind, pattern: str(r.pattern, 500), category, accountLevel: bool(r.accountLevel), note: str(r.note, 500) } };
    }
    case "removeRule":
      return { op: "removeRule", id: str(o.id, 200) };
    case "toggleRule":
      return { op: "toggleRule", id: str(o.id, 200), enabled: bool(o.enabled) };
    default:
      return bad();
  }
}

/** sessions:switchModel 的 model：省略（换下一档）或一个模型名。 */
export function switchModelArg(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return isModelName(v) ? v : bad();
}

// ---------------------------------------------------------------- 仓库现状（工作流 E2）

const slugArg = (v: unknown): string => {
  if (typeof v !== "string" || v.length > 300 || !/^[^\s/]+\/[^\s/]+$/.test(v) || v.split("/").some((p) => p === "." || p === "..")) throw new Error("invalid repo slug");
  return v;
};
const idList = (v: unknown, what: string, max = 500): string[] => {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || x.length > 700)) throw new Error(`invalid ${what}`);
  return v as string[];
};
const objOf = (v: unknown, what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`invalid ${what}`);
  return v as Record<string, unknown>;
};

export function baselinesActionArg(v: unknown): BaselinesAction {
  const o = objOf(v, "baselines action");
  switch (o.kind) {
    case "scan": {
      if (!Array.isArray(o.slugs) || o.slugs.length < 1 || o.slugs.length > 500) throw new Error("invalid baselines action");
      if (typeof o.infer !== "boolean" || (o.force !== undefined && typeof o.force !== "boolean")) throw new Error("invalid baselines action");
      return { kind: "scan", slugs: o.slugs.map(slugArg), infer: o.infer, ...(o.force === undefined ? {} : { force: o.force as boolean }) };
    }
    case "cancel":
      return { kind: "cancel", slug: slugArg(o.slug) };
    case "adopt":
      return { kind: "adopt", slug: slugArg(o.slug), ids: idList(o.ids, "baseline check ids"), confirmLow: idList(o.confirmLow, "baseline check ids") };
    case "ruleSave":
      if (typeof o.key !== "string" || !/^[A-Za-z0-9_.:-]{1,60}$/.test(o.key) || typeof o.rule !== "string" || o.rule.length > 16 * 1024 || typeof o.enabled !== "boolean") {
        throw new Error("invalid baselines action");
      }
      return { kind: "ruleSave", scope: checkScopeArg(o.scope), key: o.key, rule: o.rule, enabled: o.enabled };
    case "ruleRemove":
      if (typeof o.key !== "string" || !/^[A-Za-z0-9_.:-]{1,60}$/.test(o.key)) throw new Error("invalid baselines action");
      return { kind: "ruleRemove", scope: checkScopeArg(o.scope), key: o.key };
    default:
      throw new Error("invalid baselines action");
  }
}

export function legacyActionArg(v: unknown): LegacyAction {
  const o = objOf(v, "legacy action");
  if (o.kind === "run") return { kind: "run", checkId: positiveId(o.checkId, "check id"), slug: slugArg(o.slug) };
  if (o.kind === "cancel") return { kind: "cancel", scanId: positiveId(o.scanId, "scan id") };
  throw new Error("invalid legacy action");
}

export function legacyViolationsArg(v: unknown): { scanId: number; offset: number; limit: number } {
  const o = objOf(v, "violations request");
  const offset = o.offset === undefined ? 0 : o.offset;
  const limit = o.limit === undefined ? 200 : o.limit;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid violations request");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid violations request");
  return { scanId: positiveId(o.scanId, "scan id"), offset, limit };
}

export function checkExportActionArg(v: unknown): CheckExportAction {
  const o = objOf(v, "export action");
  if (o.kind === "run") return { kind: "run", checkKey: checkKeyArg(o.checkKey), slug: slugArg(o.slug) };
  if (o.kind === "discard" || o.kind === "push" || o.kind === "pr" || o.kind === "open") return { kind: o.kind, id: positiveId(o.id, "export id") };
  throw new Error("invalid export action");
}

/** 回测页的操作（工作流 F）。 */
export function backtestActionArg(v: unknown): BacktestAction {
  const o = objOf(v, "backtest action");
  switch (o.op) {
    case "rerun":
    case "clearReview":
      return { op: o.op, checkId: positiveId(o.checkId, "check id") };
    case "undo":
      return { op: "undo", batchId: positiveId(o.batchId, "batch id") };
    case "dismissNotice":
      return { op: "dismissNotice", eventId: positiveId(o.eventId, "event id") };
    case "applyThreshold":
    case "dismissThreshold":
      return { op: o.op, id: positiveId(o.id, "review id") };
  }
  throw new Error("invalid backtest action");
}

/** 改花费上限的一层（工作流 L）：覆盖整个换掉，值在 CostPolicyService 里按键校验（不合法的回 CostSetResult）。 */
export function costSetArg(v: unknown): { scope: PolicyScope; overrides: unknown } {
  const o = objArg(v, "cost change", ["scope", "overrides"]);
  if (!o.overrides || typeof o.overrides !== "object" || Array.isArray(o.overrides)) throw new Error("invalid cost change");
  return { scope: policyScopeArg(o.scope), overrides: o.overrides };
}

/** 「继续并提高上限」的对象：session（链的根 id）或 ticket。 */
export function costSubjectArg(v: unknown): { subjectKind: "session" | "ticket"; subjectId: string } {
  const o = objArg(v, "cost subject", ["subjectKind", "subjectId"]);
  if (o.subjectKind === "session") return { subjectKind: "session", subjectId: sessionIdArg(o.subjectId) };
  if (o.subjectKind === "ticket") return { subjectKind: "ticket", subjectId: ticketKeyArg(o.subjectId) };
  throw new Error("invalid cost subject");
}

export function backgroundActionArg(v: unknown): BackgroundAction {
  const o = objArg(v, "background action", ["op", "kind"]);
  if ((o.op === "pauseKind" || o.op === "resumeKind") && isBgKind(o.kind)) return { op: o.op, kind: o.kind };
  throw new Error("invalid background action");
}

// ---- 栈（工作流 K）

/** 进度页的范围：epic / feature 都可以是 null。 */
export function stacksFilterArg(v: unknown): StacksFilter {
  if (v === undefined || v === null) return { epicId: null, featureId: null };
  const o = objArg(v, "stacks filter", ["epicId", "featureId"]);
  return {
    epicId: o.epicId === undefined || o.epicId === null ? null : posInt(o.epicId, "stacks filter"),
    featureId: o.featureId === undefined || o.featureId === null ? null : posInt(o.featureId, "stacks filter"),
  };
}

export function stackIdArg(v: unknown): number {
  return posInt(v, "stack id");
}

export function stackLayerModeArg(v: unknown): { layerId: number; mode: StackLayerMode } {
  const o = objArg(v, "stack layer mode", ["layerId", "mode"]);
  if (o.mode !== "draft" && o.mode !== "branch") throw new Error("invalid stack layer mode");
  return { layerId: posInt(o.layerId, "stack layer"), mode: o.mode };
}

/** 栈策略改一层：值在服务里按键校验（不合法的返回 ok:false 和是哪个键）。 */
export function stackPolicySetArg(v: unknown): { scope: PolicyScope; overrides: Record<string, unknown> } {
  const o = objArg(v, "stack policy change", ["scope", "overrides"]);
  if (typeof o.overrides !== "object" || o.overrides === null || Array.isArray(o.overrides)) throw new Error("invalid stack policy overrides");
  return { scope: policyScopeArg(o.scope), overrides: o.overrides as Record<string, unknown> };
}

// ---- 预审和就绪（工作流 G）

/** ticket_prs.id。 */
export function prIdArg(v: unknown): number {
  return posInt(v, "pr id");
}

/** 改一层就绪 / 风险策略：键和值在 PrPolicies.setLayer 里再校验。 */
export function prPolicySetArg(v: unknown): { scope: PolicyScope; overrides: Record<string, unknown> } {
  const o = objArg(v, "pr policy change", ["scope", "overrides"]);
  if (!o.overrides || typeof o.overrides !== "object" || Array.isArray(o.overrides)) throw new Error("invalid pr policy change");
  return { scope: policyScopeArg(o.scope), overrides: o.overrides as Record<string, unknown> };
}

// ---- 自动接活（工作流 N）

const intakeKey = (v: unknown): string => {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) throw new Error("invalid intake key");
  return v;
};

export function intakeActionArg(v: unknown): IntakeAction {
  const o = objOf(v, "intake action");
  const key = intakeKey(o.key);
  switch (o.op) {
    case "start":
    case "skip":
    case "allowParallel":
    case "clarified":
    case "retry":
      return { op: o.op, key };
    case "setRepo":
      if (typeof o.repoPath !== "string" || o.repoPath.length > 1000 || !isAbsolutePath(o.repoPath)) throw new Error("invalid intake repo");
      return { op: "setRepo", key, repoPath: o.repoPath };
  }
  throw new Error("invalid intake action");
}

export function intakeClassifyArg(v: unknown): IntakeClassifyEdit {
  const o = objArg(v, "intake classification", ["key", "size", "risk", "clarify"]);
  const out: IntakeClassifyEdit = { key: intakeKey(o.key) };
  if (o.size !== undefined) {
    if (!(INTAKE_SIZES as readonly unknown[]).includes(o.size)) throw new Error("invalid intake size");
    out.size = o.size as IntakeClassifyEdit["size"];
  }
  if (o.risk !== undefined) {
    if (!(INTAKE_RISKS as readonly unknown[]).includes(o.risk)) throw new Error("invalid intake risk");
    out.risk = o.risk as IntakeClassifyEdit["risk"];
  }
  if (o.clarify !== undefined) {
    if (typeof o.clarify !== "boolean") throw new Error("invalid intake clarify");
    out.clarify = o.clarify;
  }
  if (out.size === undefined && out.risk === undefined && out.clarify === undefined) throw new Error("invalid intake classification");
  return out;
}

/** 改一层自动接活的策略：值在 IntakePolicyService.setLayer 里再校验。 */
export function intakePolicySetArg(v: unknown): { scope: PolicyScope; overrides: Record<string, unknown> } {
  const o = objArg(v, "intake policy change", ["scope", "overrides"]);
  if (typeof o.overrides !== "object" || o.overrides === null || Array.isArray(o.overrides)) throw new Error("invalid intake policy overrides");
  return { scope: policyScopeArg(o.scope), overrides: o.overrides as Record<string, unknown> };
}
