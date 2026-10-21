import type { Handoff } from "./handoff";
export const TICKET_STATUSES = ["active", "in_review", "blocked", "merged_pending_followup", "done"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type WorkMode = "worktree" | "branch";

export interface Ticket {
  key: string;
  title: string | null;
  repoPath: string;
  workMode: WorkMode;
  worktreePath: string | null;
  branch: string;
  status: TicketStatus;
  statusManual: TicketStatus | null;
  createdAt: number;
  archivedAt: number | null;
}

export type SessionOrigin = "butler" | "discovered";

export interface Session {
  id: string;
  ticketKey: string | null;
  cwd: string;
  origin: SessionOrigin;
  gitBranch: string | null;
  firstPrompt: string | null;
  lastActivityAt: number | null;
  waitingForInput: boolean;
  replacedBy: string | null;
  dismissed: boolean;
  createdAt: number;
}

/** termId 非空表示这个 session 当前有一个打开的终端（termId 是该终端启动时用的 session id）。 */
export interface SessionView extends Session {
  termId: string | null;
}

export interface TicketView extends Ticket {
  effectiveStatus: TicketStatus;
  sessions: SessionView[];
  waiting: boolean;
}

export interface UnclaimedSession extends Session {
  suggestedTicket: string | null;
  suggestionExists: boolean;
}

export interface CreateTicketInput {
  key: string;
  title?: string;
  repoPath: string;
  workMode: WorkMode;
  branch?: string;
}

export interface OpenSessionRequest {
  ticketKey: string;
  /** 省略表示新建 session；给出时恢复该 session（会沿 replacedBy 链找到最新的）。 */
  sessionId?: string;
  /** 打开后预填到输入框的文本，不回车。 */
  prefill?: string;
  /** 跳过分支检查。 */
  force?: boolean;
}

export type OpenSessionResult =
  | { ok: true; termId: string; alreadyOpen: boolean }
  | { ok: false; reason: "branch_mismatch"; current: string; expected: string; dirty: boolean }
  | { ok: false; reason: "claude_missing" | "no_ticket" | "no_session" };

export type HookStatus = "installed" | "missing" | "partial" | "stale" | "settings_invalid";

export interface ClaudeHealth {
  path: string | null;
  version: string | null;
  flags: Record<string, boolean>;
  missingFlags: string[];
  error: string | null;
}

export interface HealthReport {
  claude: ClaudeHealth;
  hooks: HookStatus;
  hookBinInstalled: boolean;
  butlerHome: string;
  claudeSettingsPath: string;
}

export function effectiveStatus(t: Pick<Ticket, "status" | "statusManual">): TicketStatus {
  return t.statusManual ?? t.status;
}

export const FOLLOWUP_KINDS = ["config", "flag", "deploy", "doc", "other"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];
export const FOLLOWUP_TRIGGERS = ["after_merge", "after_deploy", "on_date", "none"] as const;
export type FollowupTrigger = (typeof FOLLOWUP_TRIGGERS)[number];

export const FOLLOWUP_STATUSES = ["open", "done", "snoozed", "ignored"] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];
export type FollowupSource = "jira" | "session" | "manual";

export interface Followup {
  id: string;
  ticketKey: string;
  kind: FollowupKind;
  description: string;
  trigger: FollowupTrigger;
  /** YYYY-MM-DD，只有 trigger 为 on_date 时有值。 */
  dueDate: string | null;
  status: FollowupStatus;
  /** YYYY-MM-DD；推迟到这一天（含）重新出现。 */
  snoozedUntil: string | null;
  source: FollowupSource;
  createdAt: number;
  doneAt: number | null;
}

export type HandoffTrigger = "nightly" | "manual" | "command" | "refresh";

export interface HandoffRecord {
  id: number;
  ticketKey: string;
  sessionId: string | null;
  trigger: HandoffTrigger;
  createdAt: number;
  /** 校验通过的 handoff；degraded 时为 null。 */
  payload: Handoff | null;
  degraded: boolean;
  rawText: string | null;
  sourceRef: string | null;
}
