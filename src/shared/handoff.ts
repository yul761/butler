import { z } from "zod";
import { FOLLOWUP_KINDS, FOLLOWUP_TRIGGERS, TICKET_STATUSES } from "./types";

/**
 * 设计文档 5.3 节的 handoff schema。
 * 渲染进程只能 `import type` 这个文件里的类型，不要把 zod 打进渲染包。
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PrSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  review: z.enum(["pending", "changes_requested", "approved"]).nullable(),
});

export const JiraSchema = z.object({
  status: z.string(),
  subtasks: z.array(z.object({ key: z.string(), status: z.string() })),
});

export const HandoffFollowupSchema = z.object({
  id: z.string().nullable(),
  kind: z.enum(FOLLOWUP_KINDS),
  description: z.string().min(1),
  trigger: z.enum(FOLLOWUP_TRIGGERS),
  due_date: isoDate.nullable(),
  done: z.boolean(),
});

export const HandoffSchema = z.object({
  ticket: z.string(),
  status: z.enum(TICKET_STATUSES),
  done_today: z.array(z.string()),
  next_steps: z.array(z.string()),
  blockers: z.array(z.string()),
  /** 这个 ticket 的所有 PR（多仓库 ticket 每个仓库一个）；没有就是 []。 */
  prs: z.array(PrSchema),
  jira: JiraSchema.nullable(),
  followups: z.array(HandoffFollowupSchema),
  decisions: z.array(z.object({ key: z.string(), statement: z.string() })),
  learnings: z.array(z.string()),
  open_questions: z.array(z.string()),
});

/** 早间快速刷新只查 PR 和 tracker 状态（schema 的子集）。 */
export const RefreshSchema = z.object({
  status: z.enum(TICKET_STATUSES),
  prs: z.array(PrSchema),
  jira: JiraSchema.nullable(),
});

/**
 * 1.1 之前的 handoff 只有一个 pr（null 或一个对象）：存下来的旧记录、旧版本 /handoff 命令的输出都可能是这样。
 * 有 pr 没有 prs 时换成 prs（[] 或 [pr]），其余原样返回。校验和读库之前都先过一遍。
 */
export function upgradeLegacyPr(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  if (!("pr" in o) || "prs" in o) return v;
  const { pr, ...rest } = o;
  return { ...rest, prs: pr ? [pr] : [] };
}

export type Handoff = z.infer<typeof HandoffSchema>;
export type Pr = z.infer<typeof PrSchema>;
export type HandoffFollowup = z.infer<typeof HandoffFollowupSchema>;
export type RefreshResult = z.infer<typeof RefreshSchema>;
