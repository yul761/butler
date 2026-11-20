// 总控 progress_overview 的类型（设计文档 2026-11-17 ws-b 第 1、4 节）。PR 轮到谁用 turn 模型（shared/turn.ts）。
import type { Turn } from "./turn";

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

/** prTurn 要看的 PR 字段（WatchedPr 的子集）。 */
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
  /** 轮到谁（turn 模型，和看板同一份）；关了的、看板上没有的为 null。 */
  turn: Turn | null;
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
  turn: Turn;
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
