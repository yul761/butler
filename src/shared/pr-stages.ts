// PR 进度：六个阶段的共用类型，以及 skill 名到阶段的归类。

export const PR_STAGES = ["design", "dev", "self_review", "ci", "peer_review", "merge"] as const;
export type PrStageId = (typeof PR_STAGES)[number];

/** feature_level：设计在 feature 总控或 epic session 里做过。unknown：hook 不是当前版本，看不到 skill 调用。 */
export type PrStageState =
  | "todo"
  | "active"
  | "done"
  | "failed"
  | "skipped"
  | "unknown"
  | "feature_level";

export interface PrStageCell {
  id: PrStageId;
  state: PrStageState;
  /** 这一步当前是第几轮（≥1）；只有 >1 时界面标出来。 */
  round: number;
  at: number | null;
}

export type PrTimelineKind =
  | "design_skill"
  | "review_skill"
  | "first_commit"
  | "pr_opened"
  | "push"
  | "ci_pending"
  | "ci_passed"
  | "ci_failed"
  | "copilot_review"
  | "human_approved"
  | "human_changes"
  | "human_commented"
  | "human_dismissed"
  | "merged"
  | "closed"
  | "report";

export interface PrTimelineEntry {
  at: number;
  stage: PrStageId;
  kind: PrTimelineKind;
  /** skill 名、评论数、report 原文、reviewer login 等，按 kind 决定。 */
  detail: string | null;
  /** 这一条让进度回到了开发（CI 失败、要求修改之后的 push）。 */
  back: boolean;
}

export interface PrStagesView {
  ticketKey: string;
  featureId: number | null;
  repoId: number;
  repoName: string;
  prNumber: number | null;
  prUrl: string | null;
  closed: boolean;
  stages: PrStageCell[];
  /** 从早到晚。 */
  timeline: PrTimelineEntry[];
}

export type PrStagesScope = { ticketKey: string } | { featureId: number } | { epicId: number };

export type SkillCategory = "design" | "review";

const DESIGN_SKILLS = ["brainstorming", "writing-plans"];
const REVIEW_SKILLS = ["code-review", "requesting-code-review", "simplify", "security-review", "review"];

/** 去掉最后一个 `:` 之前的插件前缀，转小写后查表。 */
export function skillCategory(name: string): SkillCategory | null {
  const base = name.slice(name.lastIndexOf(":") + 1).trim().toLowerCase();
  if (DESIGN_SKILLS.includes(base)) return "design";
  if (REVIEW_SKILLS.includes(base)) return "review";
  return null;
}

/** prompt 以 /name 开头时返回 name（去掉参数），否则 null。 */
export function slashSkill(prompt: string): string | null {
  const m = /^\s*\/([^\s/]+)/.exec(prompt);
  return m ? m[1] : null;
}
