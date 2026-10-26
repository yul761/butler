import type { Handoff } from "./handoff";
export const TICKET_STATUSES = ["active", "in_review", "blocked", "merged_pending_followup", "done"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type WorkMode = "worktree" | "branch";

/** ticket 涉及的一个仓库：各自的工作方式和分支（设计文档 2026-10-23 多仓库 ticket）。 */
export interface TicketRepo {
  id: number;
  ticketKey: string;
  /** 仓库根目录。 */
  repoPath: string;
  workMode: WorkMode;
  worktreePath: string | null;
  branch: string;
  createdAt: number;
  /** PR 合并后 worktree 已被自动清理（设计文档 2026-10-26）；再开 session 时重建。 */
  worktreeRemovedAt: number | null;
  /** 上次没能自动清理的原因（给用户看）。 */
  cleanupBlocked: string | null;
}

/** feature 涉及的源仓库：在 feature 下建 ticket 时从这里选（设计文档 2026-10-26）。 */
export interface FeatureRepo {
  id: number;
  featureId: number;
  repoPath: string;
  createdAt: number;
}

/** 一组 ticket 加一个工作区目录：feature 下 ticket 的 worktree 都放在工作区里，feature 总控在那里打开。 */
export interface Feature {
  id: number;
  name: string;
  workspaceDir: string;
  repos: FeatureRepo[];
  createdAt: number;
  archivedAt: number | null;
}

export interface Ticket {
  key: string;
  title: string | null;
  /** 按添加顺序。可以为空：ticket 建好后再添加仓库。 */
  repos: TicketRepo[];
  status: TicketStatus;
  statusManual: TicketStatus | null;
  createdAt: number;
  archivedAt: number | null;
  /** 属于哪个 feature（null：单独的 ticket）。 */
  featureId: number | null;
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
  /** 为 ticket 的哪个仓库开的（null：总控、或者认不出来的旧 session）。 */
  repoId: number | null;
  /** 总控 session：在 ticket 的工作区目录里运行，能看到所有仓库。 */
  coordinator: boolean;
  /** 由哪个总控 session 开启（null：用户自己开的）。 */
  spawnedBy: string | null;
  /** feature 总控 session 属于哪个 feature（这时 ticketKey 为 null、coordinator 为 true）。 */
  featureId: number | null;
}

/** termId 非空表示这个 session 当前有一个打开的终端（termId 是该终端启动时用的 session id）。 */
export interface SessionView extends Session {
  termId: string | null;
}

export interface TicketView extends Ticket {
  effectiveStatus: TicketStatus;
  sessions: SessionView[];
  /** 用户从列表里隐藏的 session（只是不显示，对话记录不动；可以恢复）。 */
  hiddenSessions: SessionView[];
  waiting: boolean;
}

export interface UnclaimedSession extends Session {
  suggestedTicket: string | null;
  suggestionExists: boolean;
}

export interface CreateTicketInput {
  key: string;
  title?: string;
  /** 省略或空串：先不关联仓库。 */
  repoPath?: string;
  workMode?: WorkMode;
  branch?: string;
}

export interface AddRepoInput {
  ticketKey: string;
  repoPath: string;
  workMode: WorkMode;
  branch?: string;
}

/** 编辑 ticket 的标题：空串表示清空。 */
export interface UpdateTicketInput {
  key: string;
  title: string;
}

/** 编辑 ticket 的一个仓库：省略的字段不变。 */
export interface UpdateRepoInput {
  repoId: number;
  workMode?: WorkMode;
  branch?: string;
}

export interface OpenSessionRequest {
  ticketKey: string;
  /** 新 session 开在哪个仓库里。省略时：ticket 只有一个仓库就用它，否则必须指定（或者开总控）。 */
  repoId?: number;
  /** 新开总控 session（工作区目录 + 每个仓库一个 --add-dir）。 */
  coordinator?: boolean;
  /** 省略表示新建 session；给出时恢复该 session（会沿 replacedBy 链找到最新的）。 */
  sessionId?: string;
  /** 打开后预填到输入框的文本，不回车。 */
  prefill?: string;
  /** 跳过分支检查。 */
  force?: boolean;
}

export type OpenSessionResult =
  | { ok: true; termId: string; alreadyOpen: boolean }
  | { ok: false; reason: "branch_mismatch"; repoId: number; current: string; expected: string; dirty: boolean }
  /** 要恢复的 session 是在别的目录里启动的（ticket 后来改过工作方式），那个目录现在不在 ticket 的分支上（"HEAD" 表示游离）。 */
  | { ok: false; reason: "old_workdir"; cwd: string; current: string; expected: string }
  | { ok: false; reason: "claude_missing" | "no_ticket" | "no_session" | "ticket_busy" | "no_repo" | "pick_repo" };

export type HookStatus = "installed" | "missing" | "partial" | "stale" | "settings_invalid";
export type HandoffCommandStatus = "installed" | "missing" | "stale" | "conflict";

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
  handoffCommand: HandoffCommandStatus;
  butlerHome: string;
  claudeSettingsPath: string;
  /** StateCore 记忆（设计文档第 8 节）。 */
  memory: {
    enabled: boolean;
    dataDir: string;
    /** 打包的 StateCore MCP 在不在（不在时 session 不挂记忆）。 */
    mcpBundle: boolean;
    /** 用户另外装了 StateCore 的捕获插件（8.5：应该卸掉）。 */
    statecorePlugin: boolean;
  };
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

/** 一次 handoff / 刷新的结果（“立即 handoff”按钮会显示它）。 */
export type HandoffOutcome =
  | { ticketKey: string; status: "stored"; handoffId: number; degraded: boolean }
  | { ticketKey: string; status: "skipped"; reason: "rate_limited" | "no_session" }
  | { ticketKey: string; status: "failed"; reason: string; message: string };

/** 探测到的 MCP server 和工具（设置页“检测”按钮）。suggested 是名字像查询的工具，默认勾选。 */
export interface McpProbe {
  servers: { name: string; status: string }[];
  tools: string[];
  suggested: string[];
}

/** 一个调度任务最近一次运行的结果（jobs 表）。手动运行的按钮用它显示结果。 */
export interface JobStateView {
  lastRunAt: number | null;
  /** ok | partial | failed | seeded */
  lastStatus: string | null;
  lastError: string | null;
}

/** 开机自启（设计文档 2.2）。supported 为 false 时（开发模式、其他平台）设置页的开关是灰的。 */
export interface AutostartState {
  supported: boolean;
  enabled: boolean;
}
