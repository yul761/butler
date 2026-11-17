import type { LessonsPauseReason } from "./availability";

/** 每个 session 最多送进去的规矩条数。 */
export const MAX_SESSION_LESSONS = 30;

/** 运行记录和 headless 失败 message 的字符上限（两处共用）。 */
export const RUN_MESSAGE_MAX = 4000;

export type LessonRunStatus = "running" | "done" | "skipped" | "failed" | "limited" | "aborted" | "cancelled";
export type LessonRunReason =
  | "unknown_repo" | "gh" | "no_review_comments"
  | "usage_limit" | "rate_limit" | "overloaded" | "model_unavailable"
  | "timeout" | "spawn_failed" | "exit_nonzero" | "bad_output" | "claude_error" | "claude_missing"
  | "cancelled" | "app_quit" | "error";

/** 正在分析的一个队列项（取消按钮用 queueId）。 */
export interface LessonRunningItem {
  queueId: number;
  runId: number;
  slug: string;
  prNumber: number;
  startedAt: number;
}

export type LessonStatus = "pending" | "confirmed" | "disabled" | "rejected";
export type LessonScope = { kind: "repo"; slug: string } | { kind: "product"; productId: number };

export interface LessonSource {
  id: number;
  prNumber: number;
  url: string | null;
  at: number;
  /** 出处所在仓库；老数据补不出来时为空。 */
  slug: string | null;
  /** 产生这条出处的分析运行；老数据或运行已被清理时为空。 */
  runId: number | null;
}

export interface Lesson {
  id: number;
  scope: LessonScope;
  text: string;
  /** 为什么提这条，一两句。 */
  why: string;
  status: LessonStatus;
  hits: number;
  lastSeenAt: number;
  createdAt: number;
  sources: LessonSource[];
}

export type LessonOrigin = "backfill" | "merged" | "daily";

export type LessonQueueRowStatus = "queued" | "waiting" | "limited" | "running" | "done" | "skipped" | "cancelled" | "failed";

export interface LessonRunSummary {
  id: number;
  status: LessonRunStatus;
  reason: LessonRunReason | null;
  startedAt: number;
  finishedAt: number | null;
  created: number;
  hit: number;
  dropped: number;
  costUsd: number | null;
  durationMs: number | null;
}

/** Runs 标签页的一行：一个 PR 的队列项加它最近一次运行。 */
export interface LessonQueueRowView {
  queueId: number;
  prNumber: number;
  prTitle: string | null;
  origin: LessonOrigin;
  status: LessonQueueRowStatus;
  reason: string | null;
  message: string | null;
  attempts: number;
  enqueuedAt: number;
  finishedAt: number | null;
  notBefore: number | null;
  lastRun: LessonRunSummary | null;
}

export interface LessonFinding {
  summary: string;
  avoidable: boolean;
  whyMissed: string;
  rule: { text: string; why: string; scope: "repo" | "product" } | null;
  commentUrl: string | null;
}

export interface LessonRunDetail extends LessonRunSummary {
  slug: string;
  prNumber: number;
  prUrl: string | null;
  prTitle: string | null;
  origin: LessonOrigin;
  message: string | null;
  stderrTail: string | null;
  ghStderr: string | null;
  material: string | null;
  rawOutput: string | null;
  trimmed: boolean;
  /** 存的输出解析不出来（被截断或格式不对）时为 null。 */
  findings: LessonFinding[] | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  lessons: { id: number; text: string; status: LessonStatus; kind: "created" | "hit" }[];
  /** 同一个 PR 的其它运行，新的在前。 */
  attempts: LessonRunSummary[];
}

export interface LessonQueueView {
  running: LessonRunningItem[];
  queued: number;
  pause: { reason: LessonsPauseReason; until: number | null; message: string | null } | null;
}

export interface LessonRepoView {
  slug: string;
  localPath: string;
  /** 上次分析完一个 PR 的时间。 */
  lastAnalyzedAt: number | null;
  analyzedCount: number;
  queued: number;
  failed: number;
  running: number;
  skipped: number;
  cancelled: number;
  backfilled: boolean;
  /** 单独开这个仓库的 session 时，有几条已确认的送不进去。 */
  overflow: number;
}

/** 没有 origin remote 或解析不出 slug 的仓库路径，页面上说明原因。 */
export interface LessonUnknownRepo {
  path: string;
  reason: "no_remote" | "not_git";
}

export interface LessonProductView {
  id: number;
  name: string;
  slugs: string[];
}

export interface LessonProductSuggestion {
  slugs: string[];
  together: number;
}

export interface LessonsState {
  repos: LessonRepoView[];
  unknownRepos: LessonUnknownRepo[];
  products: LessonProductView[];
  suggestions: LessonProductSuggestion[];
  /** 不含 rejected。 */
  lessons: Lesson[];
  ghAvailable: boolean;
  queue: LessonQueueView;
}

export type LessonAction =
  | { op: "confirm"; id: number; text?: string }
  | { op: "reject"; id: number }
  | { op: "edit"; id: number; text: string }
  | { op: "setDisabled"; id: number; disabled: boolean }
  | { op: "delete"; id: number }
  | { op: "merge"; keepId: number; dropId: number; text: string }
  | { op: "createProduct"; name: string; slugs: string[] }
  | { op: "deleteProduct"; id: number }
  | { op: "addToProduct"; id: number; slug: string }
  | { op: "removeFromProduct"; id: number; slug: string }
  | { op: "backfill"; slug: string }
  | { op: "openSource"; sourceId: number }
  | { op: "retry"; queueId: number }
  | { op: "retryFailed"; slug: string }
  | { op: "cancel"; queueId: number }
  | { op: "pauseQueue" }
  | { op: "resumeQueue" }
  | { op: "runNow" };

export type LessonActResult = { ok: true; sessionId?: string } | { ok: false; reason: string };

/** 送进 session 说明的一行。label 是仓库 slug 或产品名。 */
export interface SessionLesson {
  label: string;
  text: string;
}
