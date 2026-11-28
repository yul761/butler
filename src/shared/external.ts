// 对外动作（契约 4.8，设计文档 2026-11-17 ws-b 第 5 节）：Shipherd 代你在 GitHub 或别的外部服务上留下痕迹的动作。
// 每种一个开关，默认全关；主进程的 ExternalActions 在动手之前查开关，做没做都记进审计。

export const EXTERNAL_ACTIONS = [
  "comment_reply",
  "comment_resolve",
  "pr_description_edit",
  "pr_label",
  "pr_open",
  "branch_push",
  "pr_title_edit",
  "force_push",
  "ci_rerun",
  "issue_post",
  "push_notification",
  "pr_brief_post",
  // 工作流 N：自动接活在 tracker 上的动作（经用户的 tracker MCP，由 session 或总控去做）。
  "intake_tracker_comment",
  "intake_tracker_status",
  // BTL-273：工作流程里 Shipherd 替 session 请 Copilot / Codex review（Codex 是在 PR 上评论 @codex review）。
  "pr_review_request",
] as const;
export type ExternalActionKind = (typeof EXTERNAL_ACTIONS)[number];

/** 每种动作的设置名：comment_reply → externalCommentReply。 */
export const EXTERNAL_ACTION_SETTINGS = {
  comment_reply: "externalCommentReply",
  comment_resolve: "externalCommentResolve",
  pr_description_edit: "externalPrDescriptionEdit",
  pr_label: "externalPrLabel",
  pr_open: "externalPrOpen",
  branch_push: "externalBranchPush",
  pr_title_edit: "externalPrTitleEdit",
  force_push: "externalForcePush",
  ci_rerun: "externalCiRerun",
  issue_post: "externalIssuePost",
  push_notification: "externalPushNotification",
  pr_brief_post: "externalPrBriefPost",
  intake_tracker_comment: "externalIntakeTrackerComment",
  intake_tracker_status: "externalIntakeTrackerStatus",
  pr_review_request: "externalPrReviewRequest",
} as const satisfies Record<ExternalActionKind, string>;
export type ExternalActionSetting = (typeof EXTERNAL_ACTION_SETTINGS)[ExternalActionKind];

/**
 * 审计表里的种类：对外动作，再加只读的更新检查（BTL-253，经你的 gh 查 GitHub 上的最新 release）。
 * 更新检查不是对外动作：没有 external* 开关，不经过 ExternalActions.attempt，只记一笔。
 */
export const AUDIT_KINDS = [...EXTERNAL_ACTIONS, "update_check"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const EXTERNAL_OUTCOMES = ["done", "failed", "skipped"] as const;
export type ExternalOutcome = (typeof EXTERNAL_OUTCOMES)[number];

/** 审计页"对外动作"里的一行。 */
export interface ExternalActionEntry {
  id: number;
  ts: number;
  kind: AuditKind;
  repoSlug: string | null;
  ticketKey: string | null;
  /** 目标：PR、评论、issue 的链接之类。 */
  target: string | null;
  summary: string;
  payload: string | null;
  /** skipped：开关关着，没做。 */
  outcome: ExternalOutcome;
  error: string | null;
}
