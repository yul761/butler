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

export type LessonStatus = "pending" | "confirmed" | "disabled" | "rejected";
export type LessonScope = { kind: "repo"; slug: string } | { kind: "product"; productId: number };

export interface LessonSource {
  id: number;
  prNumber: number;
  url: string | null;
  at: number;
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

export interface LessonRepoView {
  slug: string;
  localPath: string;
  /** 上次分析完一个 PR 的时间。 */
  lastAnalyzedAt: number | null;
  analyzedCount: number;
  queued: number;
  failed: number;
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
  | { op: "openSource"; sourceId: number };

/** 送进 session 说明的一行。label 是仓库 slug 或产品名。 */
export interface SessionLesson {
  label: string;
  text: string;
}
