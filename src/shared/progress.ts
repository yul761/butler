// 进度页和总控 progress_overview 共用的类型，以及"卡在谁手上"的纯函数（设计文档 2026-11-17 ws-b 第 1、4 节）。

/** 请了 review、还没给的人或团队（gh 的 reviewRequests）。 */
export interface PrReviewRequest {
  kind: "user" | "team";
  name: string;
}

/** 一个人（不是 PR 作者）对这个 PR 最新的态度。bot：bot 或 Copilot，不算人在 review。 */
export interface PrReviewer {
  login: string;
  state: "approved" | "changes_requested" | "commented" | "dismissed";
  at: number;
  bot: boolean;
}

export type PrMergeable = "mergeable" | "conflicting" | "unknown";
export const MERGE_STATES = ["clean", "blocked", "behind", "dirty", "draft", "unstable", "has_hooks", "unknown"] as const;
export type PrMergeState = (typeof MERGE_STATES)[number];

export type WaitingReason =
  | "draft"
  | "ci_failing"
  | "changes_requested"
  | "conflicts"
  | "behind"
  | "ci_pending"
  | "ready_to_merge"
  | "review_requested"
  | "no_reviewer"
  | "ticket_blocked";

/** 卡在谁手上：作者、CI、被请的 reviewer，或者 ticket 本身（标成了阻塞、没有开着的 PR）。 */
export interface WaitingOn {
  who: "author" | "ci" | "reviewers" | "ticket";
  /** 点名：作者的 login、被请的人和团队、提修改要求的人；不知道是谁时为空。 */
  names: string[];
  reason: WaitingReason;
}

/** waitingOnOf 要看的 PR 字段（WatchedPr 的子集）。 */
export interface WaitingInput {
  state: "open" | "merged" | "closed" | null;
  isDraft: boolean;
  ci: "none" | "pending" | "passing" | "failing" | "unknown";
  review: "pending" | "changes_requested" | "approved" | null;
  author: string | null;
  reviewers: PrReviewer[];
  reviewRequests: PrReviewRequest[];
  mergeable: PrMergeable | null;
  mergeState: PrMergeState | null;
}

const authorNames = (p: WaitingInput): string[] => (p.author ? [p.author] : []);

/** 开着的 PR 卡在谁手上；没开着（合了、关了、还没有 PR）为 null。规则的顺序见设计文档第 4 节的表。 */
export function waitingOnOf(p: WaitingInput): WaitingOn | null {
  if (p.state !== "open") return null;
  const author = (reason: WaitingReason, names = authorNames(p)): WaitingOn => ({ who: "author", names, reason });
  if (p.isDraft) return author("draft");
  if (p.ci === "failing") return author("ci_failing");
  const humans = p.reviewers.filter((r) => !r.bot);
  const changes = humans.filter((r) => r.state === "changes_requested");
  if (changes.length > 0 || (p.review === "changes_requested" && humans.every((r) => r.state !== "approved"))) {
    return { who: "author", names: changes.map((r) => r.login), reason: "changes_requested" };
  }
  if (p.mergeable === "conflicting" || p.mergeState === "dirty") return author("conflicts");
  if (p.mergeState === "behind") return author("behind");
  if (p.ci === "pending") return { who: "ci", names: [], reason: "ci_pending" };
  const approved = humans.some((r) => r.state === "approved") || p.review === "approved";
  // 有人批准了、GitHub 不再要求更多批准（reviewDecision 不是 REVIEW_REQUIRED）：可以合了，还被请着的人不用再等。
  if (approved && p.review !== "pending") return author("ready_to_merge");
  if (p.reviewRequests.length > 0) return { who: "reviewers", names: p.reviewRequests.map((r) => r.name), reason: "review_requested" };
  // 没人被请着：作者得去请人（批准数还不够时也一样）。
  return author("no_reviewer");
}

/**
 * PR 标题的前缀，用来给 PR 表分组：`[xxx] …` 里的 xxx；`type(scope): …` 里的 type(scope)；
 * 再不行取第一个冒号（后面跟空白）之前、不超过 32 个字符、不含空格以外标点的部分。都没有为 null。
 */
export function titlePrefix(title: string | null): string | null {
  const t = (title ?? "").trim();
  if (!t) return null;
  const bracket = /^\[([^\]]{1,32})\]/.exec(t);
  if (bracket) return bracket[1].trim() || null;
  const conv = /^([A-Za-z][\w-]*(?:\([^)]{1,32}\))?)!?:\s/.exec(t);
  if (conv) return conv[1];
  // 冒号后面要跟空白（或者是全角冒号）：`https://…` 不算前缀。
  const m = /[:：]/.exec(t);
  const colon = m && (m[0] === "：" || /\s/.test(t[m.index + 1] ?? "")) ? m.index : -1;
  if (colon > 0 && colon <= 32) {
    const head = t.slice(0, colon).trim();
    if (head && /^[\p{L}\p{N} _\-/.]+$/u.test(head)) return head;
  }
  return null;
}

/** 汇总条的五格（定义见设计文档第 4 节）。 */
export const PROGRESS_BUCKETS = ["merged", "blocked", "in_review", "in_progress", "not_started"] as const;
export type ProgressBucket = (typeof PROGRESS_BUCKETS)[number];

export interface ProgressFilter {
  epicId?: number | null;
  featureId?: number | null;
}

export interface ProgressPr {
  ticketKey: string;
  prId: number;
  /** 仓库目录名；不是 ticket 仓库的 PR 为 slug。 */
  repo: string;
  slug: string | null;
  number: number;
  url: string;
  title: string | null;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  review: "pending" | "changes_requested" | "approved" | null;
  ci: "none" | "pending" | "passing" | "failing" | "unknown";
  headBranch: string | null;
  baseBranch: string | null;
  labels: string[];
  author: string | null;
  reviewers: PrReviewer[];
  reviewRequests: PrReviewRequest[];
  mergeable: PrMergeable | null;
  mergeState: PrMergeState | null;
  waitingOn: WaitingOn | null;
  checkedAt: number;
  statusChangedAt: number | null;
  readError: boolean;
}

export interface ProgressStuck {
  ticketKey: string;
  ticketTitle: string | null;
  featureId: number | null;
  /** 没有 PR（ticket 标成阻塞）时为 null。 */
  pr: ProgressPr | null;
  waitingOn: WaitingOn;
  /** 从什么时候起是这个状态（PR 状态最后一次变化）；不知道为 null。 */
  since: number | null;
}

export interface ProgressStackNode {
  pr: ProgressPr;
  children: ProgressStackNode[];
}

export interface ProgressStackRepo {
  repo: string;
  /** 有上下关系的树（至少两层）。 */
  stacks: ProgressStackNode[];
  /** 不在任何叠放里的开着的 PR。 */
  single: ProgressPr[];
}

export interface ProgressPrGroup {
  /** label 名或标题前缀；null = 没有 label / 没有前缀。 */
  key: string | null;
  prs: ProgressPr[];
}

export interface ProgressTicket {
  key: string;
  title: string | null;
  featureId: number | null;
  bucket: ProgressBucket;
  prs: number;
  openPrs: number;
}

export interface ProgressFeature {
  /** null = 不属于任何 feature 的 ticket。 */
  id: number | null;
  name: string | null;
  epicId: number | null;
  /** 汇总的第一句；没有汇总为 null。 */
  line: string | null;
  summaryAt: number | null;
  /** 汇总读 PR 状态的时间；总控 /handoff 交上来的汇总为 null（按 summaryAt 算）。 */
  prStatusAt: number | null;
  /** 汇总之后有新活动（含 PR 状态变化）。 */
  stale: boolean;
  counts: Record<ProgressBucket, number>;
  tickets: ProgressTicket[];
}

export interface ProgressFreshness {
  generatedAt: number;
  prsCheckedOldest: number | null;
  prsCheckedNewest: number | null;
  readErrors: number;
  /** 从没读过的 PR。 */
  unread: number;
  summaryOldest: number | null;
}

export interface ProgressView {
  filter: { epicId: number | null; featureId: number | null };
  /** 下拉用：未归档的 epic 和 feature。 */
  epics: { id: number; name: string }[];
  features: { id: number; name: string; epicId: number | null }[];
  counts: Record<ProgressBucket, number> & { total: number };
  stuck: ProgressStuck[];
  stacks: ProgressStackRepo[];
  groups: { byLabel: ProgressPrGroup[]; byPrefix: ProgressPrGroup[] };
  featureGroups: ProgressFeature[];
  freshness: ProgressFreshness;
}
