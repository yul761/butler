import type { LessonsPauseReason } from "./availability";

/**
 * session 说明里规矩全文最多占多少字符（BTL-274：按大小，不按条数）。装不下的写进索引、编辑时补送、lessons 工具能查到全文，
 * 一条都不会静默丢。中文大约一个字一个 token，8000 字符和以前 30 条差不多。
 */
export const GUIDE_FULL_BUDGET = 8000;
/** 索引（装不下全文的规矩，一行标题 + 适用范围）最多占多少字符；再多的只写条数，用 lessons 工具查。 */
export const GUIDE_INDEX_BUDGET = 3000;
/** 索引里标题最多几个字符。 */
export const INDEX_TITLE_MAX = 60;
/** 编辑时补送（hook 的 additionalContext）一次最多这么多字符；放不下的等下一次编辑。和信箱的上限（9000）分开算，两段加起来也在 Claude Code 的 10,000 以内时最好，所以留小一点。 */
export const LESSON_DRIP_LIMIT = 6000;

/**
 * 一条已确认的规矩怎么到 session（BTL-274）：
 * full 全文写在说明里；principle 归进一条原则（说明里是原则那一行，案例在旁边的文件里），编辑匹配的文件时也补送全文；
 * index 说明里一行标题和范围（没限定范围的规矩，第一次编辑时补送全文）；drip 编辑匹配的文件时补送全文（也列在索引里，放得下的话）；
 * check 已转成检查，编辑和 push 时由检查强制，不占说明的位置。每一条都还能用 lessons 工具查全文。
 */
export type LessonDelivery = "full" | "principle" | "index" | "drip" | "check";
export const LESSON_DELIVERIES: readonly LessonDelivery[] = ["full", "principle", "index", "drip", "check"];
export type LessonDeliveryCounts = Record<LessonDelivery, number>;

/** 运行记录和 headless 失败 message 的字符上限（两处共用）。 */
export const RUN_MESSAGE_MAX = 4000;

export type LessonRunStatus = "running" | "done" | "skipped" | "failed" | "limited" | "aborted" | "cancelled";
export type LessonRunReason =
  | "unknown_repo" | "gh" | "no_review_comments"
  | "usage_limit" | "rate_limit" | "overloaded" | "model_unavailable"
  | "timeout" | "spawn_failed" | "exit_nonzero" | "bad_output" | "claude_error" | "claude_missing"
  | "cancelled" | "app_quit" | "yielded" | "cost_paused" | "error";

/** 正在分析的一个队列项（取消按钮用 queueId）。 */
export interface LessonRunningItem {
  queueId: number;
  runId: number;
  slug: string;
  prNumber: number;
  startedAt: number;
}

export type LessonStatus = "pending" | "confirmed" | "disabled" | "rejected";
/** 准入流水线的判断（和 status 分开：status 决定进不进 session）。manual = 人决定过；auto = 流水线推荐 / 自动准入；shelved = 搁置，见 shelvedReason。 */
export type LessonAdmission = "pending" | "auto" | "manual" | "shelved";
export const LESSON_ADMISSIONS: readonly LessonAdmission[] = ["pending", "auto", "manual", "shelved"];
export type LessonStrength = "must" | "should";
export const LESSON_STRENGTHS: readonly LessonStrength[] = ["must", "should"];
/** 可检查性：能写成确定性检查 / 只能留文字 / 已转成检查 / 已被仓库现有检查覆盖。null = 还没分类。 */
export type LessonCheckability = "checkable" | "prose" | "converted" | "covered";
export const LESSON_CHECKABILITIES: readonly LessonCheckability[] = ["checkable", "prose", "converted", "covered"];
export const LESSON_STATUSES: readonly LessonStatus[] = ["pending", "confirmed", "disabled", "rejected"];
/** 搁置原因；流水线以后可能加别的，所以页面对不认识的原因显示原文。 */
export type LessonShelvedReason = "conflict" | "generality" | "low_score" | "clarity" | "backtest_fp" | "backtest_recall" | "untested" | "covered" | "duplicate" | "below_drop" | (string & {});
/** 评分的一个分项：0..1 的值和一句理由；还没有数据时整个分项不出现。 */
export interface LessonScorePart { value: number; reason: string }
export interface LessonScoreParts {
  evidence?: LessonScorePart;
  clarity?: LessonScorePart;
  consistency?: LessonScorePart;
  verifiability?: LessonScorePart;
  performance?: LessonScorePart;
  /** 可检查的规矩还没有回测：给检查用的综合分被封顶（value 是封顶后的分），不能凭别的分项自动变成拦截。 */
  cap?: LessonScorePart;
  /** 综合分怎么来的一句话（用了哪些分项、准入线是多少）。 */
  composite?: LessonScorePart;
}
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
  /** 留评论的人、评论所在的文件和行（工作流 D 补的；老数据补不出来时为空）。评论原文只在主进程里用，不送页面。 */
  reviewer: string | null;
  path: string | null;
  line: number | null;
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
  /** 适用路径 glob；空 = 在它的仓库或产品里处处适用。 */
  scopeGlobs: string[];
  scopeLang: string | null;
  scopeLayer: string | null;
  strength: LessonStrength | null;
  checkability: LessonCheckability | null;
  admission: LessonAdmission;
  shelvedReason: LessonShelvedReason | null;
  /** 冲突时的另一条规矩。 */
  shelvedRef: number | null;
  /** 最近一次改动它的批次。 */
  batchId: number | null;
  /** 被合并进的那条；合并过的行留着（撤销用），但不在任何列表里出现。 */
  mergedInto: number | null;
  score: number | null;
  scoreParts: LessonScoreParts | null;
  scoredAt: number | null;
  scorePolicyVersion: number | null;
  /** 由降级后的模型产出（模型路由，契约 4.1）。 */
  degraded: boolean;
  degradedFrom: string | null;
  /** 范围、类型、可检查性最近一次补填的时间（null = 还没补过）。 */
  enrichedAt: number | null;
  /** 可检查性的一句理由（分类或起草检查时给的）。 */
  checkabilityReason: string | null;
  /** 为什么搁置，一句话（冲突的原因、普适性的数字、拖后腿的分项）。 */
  shelvedNote: string | null;
  /** 归到的原则。 */
  principleId: number | null;
  /** 第一次确认的时间。 */
  confirmedAt: number | null;
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
  /** 单独开这个仓库的 session 时，已确认的规矩各有几条按哪种方式送到（BTL-274）。 */
  delivery: LessonDeliveryCounts;
  /** 全文装不下（有规矩只能走索引或补送）：这时页面建议合并。 */
  overBudget: boolean;
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
  /** 还没补过范围、类型和可检查性的规矩（工作流 D 的补填）；running：正在后台补。 */
  enrich: { needing: number; running: boolean };
  /** 每条已确认的规矩（id）单独开它所在仓库的 session 时怎么送到（BTL-274）。产品规矩取它各仓库里最差的那种。 */
  delivery: Record<number, LessonDelivery>;
  /** 待确认的「合并相似规矩」建议（BTL-274）。 */
  mergeProposals: LessonMergeProposal[];
  /** 合并建议是不是自动接受（设置 lessonsMergeAuto）。 */
  mergeAuto: boolean;
  /** 正在后台找相似规矩。 */
  mergeRunning: boolean;
  /** 上一次找相似规矩时没问成的块数（失败、超时）：不是 0 时页面说一句，重启后为 0。 */
  mergeFailed: number;
}

/** 模型给出的一条「把这几条相似规矩合成一条」的建议（BTL-274）。接受时记成一个可撤销的批次。 */
export interface LessonMergeProposal {
  id: number;
  scope: LessonScope;
  /** 要合并的规矩（至少两条）；接受时保留出现次数最多的那条，其余合进去。 */
  ids: number[];
  text: string;
  why: string;
  /** 为什么提：over_budget 这个范围全文装不下；similar 有明显相似的规矩。 */
  reason: "over_budget" | "similar";
  createdAt: number;
}

/** 准入、范围、评分这些字段都还没填时的样子（迁移后的默认值）。 */
export const LESSON_FIELD_DEFAULTS = {
  scopeGlobs: [] as string[], scopeLang: null, scopeLayer: null, strength: null, checkability: null, admission: "pending",
  shelvedReason: null, shelvedRef: null, batchId: null, mergedInto: null, score: null, scoreParts: null, scoredAt: null,
  scorePolicyVersion: null, degraded: false, degradedFrom: null, enrichedAt: null, checkabilityReason: null, shelvedNote: null,
  principleId: null, confirmedAt: null,
} as const satisfies Omit<Lesson, "id" | "scope" | "text" | "why" | "status" | "hits" | "lastSeenAt" | "createdAt" | "sources">;

/** 批量动作（契约 4.4）。 */
export type LessonBulkVerb = "confirm" | "reject" | "disable" | "enable" | "delete";
export const LESSON_BULK_VERBS: readonly LessonBulkVerb[] = ["confirm", "reject", "disable", "enable", "delete"];
/** 一次批量动作按 id 给的上限（按筛选条件给的不设上限）。 */
export const MAX_TARGET_IDS = 5000;
/** 批量动作的目标：一串 id（最多 5000 个），或一个筛选条件（主进程在事务里按它找行）。 */
export type LessonTarget = { ids: number[] } | { filter: import("./lesson-filter").LessonFilter };

export type LessonAction =
  /** expect：页面按钮上的数。真会改的比它多（列表在页面没刷新时变了）就什么都不改，返回 stale。 */
  | { op: "bulk"; verb: LessonBulkVerb; target: LessonTarget; expect?: number }
  /** 接受全部推荐：待确认、admission = auto 的全部确认；target 可再缩小范围。 */
  | { op: "acceptRecommended"; target?: LessonTarget; expect?: number }
  /** 后台补填老规矩的范围、类型、强度和可检查性（lesson_enrich）；不重新分析 PR。 */
  | { op: "enrich" }
  | { op: "undoBatch"; batchId: number }
  | { op: "confirm"; id: number; text?: string }
  | { op: "reject"; id: number }
  | { op: "edit"; id: number; text: string }
  | { op: "setDisabled"; id: number; disabled: boolean }
  | { op: "delete"; id: number }
  | { op: "merge"; keepId: number; dropId: number; text: string }
  /** 接受一条合并建议（BTL-274）：建议依据的规矩变了时返回 stale，什么都不改。 */
  | { op: "acceptMerge"; id: number }
  | { op: "dismissMerge"; id: number }
  /** 现在就找一遍相似规矩（slug 不给时找全部）。 */
  | { op: "suggestMerges"; slug?: string }
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
  | { op: "runNow" }
  /** 在一个看得见的 Claude session 里打开这次运行；成功时 sessionId 是它的终端 id。 */
  | { op: "openInClaude"; runId: number };

/** 改规矩的动作成功时带上它记成的批次（没有一行真变时 batchId 为 null）、改了几行、跳过几行。 */
export type LessonActResult =
  | { ok: true; sessionId?: string; batchId?: number | null; affected?: number; skipped?: number }
  | { ok: false; reason: string };

/** 送进 session 说明的一行。label 是仓库 slug 或产品名。 */
export interface SessionLesson {
  /** 规矩的 id（原则行没有）。 */
  id?: number;
  label: string;
  text: string;
  /** 这一行是一个原则（工作流 D）：属于它的规矩，写进旁边的案例文件，说明里只写条数。 */
  cases?: string[];
}
/** 核心说明（设置 lessonsCoreGuide）最多几条。 */
export const CORE_GUIDE_MAX = 10;
