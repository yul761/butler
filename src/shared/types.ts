import type { SessionActivity } from "./activity";
import type { FeatureHandoff, Handoff, Pr } from "./handoff";
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
  /** 属于哪个 epic（null：不属于任何 epic）。 */
  epicId: number | null;
  /** epic session 建 feature 时给的规划（null：没有）。 */
  brief: string | null;
  /** 规划发给总控的时间（null：还没发过）。 */
  briefSentAt: number | null;
}

export interface EpicRepo {
  id: number;
  epicId: number;
  repoPath: string;
}

/** epic：一组 feature 加一个规划用的工作区目录。 */
export interface Epic {
  id: number;
  name: string;
  workspaceDir: string;
  createdAt: number;
  archivedAt: number | null;
  repos: EpicRepo[];
  /** epic session 用 set_epic_plan 写的整体规划；还没有为 null。 */
  plan: string | null;
  /**
   * 规划这一栏最后一次定下的时间：建 epic、set_epic_plan、老数据迁移。
   * null：升级前建的 epic，规划还在 epic 记忆的 handoff 里没迁过来（见 MemoryService.syncEpicNow）。
   */
  planAt: number | null;
}

export type EpicFeatureStatus = "stuck" | "waiting" | "not_started" | "active" | "archived";

/** epic 页一行：一个 feature 的状态和最新汇总里的进度。 */
export interface EpicFeatureRow {
  id: number;
  name: string;
  status: EpicFeatureStatus;
  archivedAt: number | null;
  /** 最新汇总的时间；还没有汇总为 null。 */
  summaryAt: number | null;
  summary: string | null;
  blockers: string[];
  decisions: { key: string; statement: string }[];
  openQuestions: string[];
}

/** 选目录的结果：仓库本身、上一层目录（列出下一层的仓库），或者都不是。 */
export type ScanResult = { kind: "repo"; root: string } | { kind: "parent"; repos: string[] } | { kind: "none" };

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
  /** feature 级 session（总控或修复 session）属于哪个 feature（这时 ticketKey 为 null；fixesSession 为 null 的才是总控）。 */
  featureId: number | null;
  /** 修复 session：为了解决哪个卡住的 session 开的（null：不是修复 session）。 */
  fixesSession: string | null;
  /** epic session 属于哪个 epic（这时 ticketKey 和 featureId 都是 null）。 */
  epicId: number | null;
  /** 开出来时用的模型（opus / sonnet）；null：没指定，恢复时也不传 --model。 */
  model: string | null;
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

/** feature 页和侧边栏用：feature 加上它的 ticket 和 feature 级 session（总控和修复 session，设计文档 2026-10-26）。 */
export interface FeatureView extends Feature {
  tickets: TicketView[];
  sessions: SessionView[];
  hiddenSessions: SessionView[];
  /** feature 总控或者它的任何一个 ticket 在等用户输入。 */
  waiting: boolean;
  /** 最新一条 feature 汇总（可能是 degraded）；还没有为 null。 */
  summary: FeatureHandoffRecord | null;
  /** 每个 ticket 的 PR：取最新一条有效 handoff（含 refresh）里的，没有 handoff 为 []。 */
  ticketPrs: Record<string, Pr[]>;
  /** 键是 ticket 号：这个 ticket 运行中的 session 里最需要注意的那个；没有运行中的 session 就没有这个键。 */
  activity: Record<string, SessionActivity>;
}

/** epic 页和侧边栏用：epic 加上它的 session 和下面各 feature 的情况。 */
export interface EpicView extends Epic {
  sessions: SessionView[];
  hiddenSessions: SessionView[];
  /** epic session 或者它下面的 feature 在等用户输入。 */
  waiting: boolean;
  /** 下面有 feature 卡住了。 */
  stuck: boolean;
  features: EpicFeatureRow[];
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
  /** 一次加好几个仓库（选了上一层目录、或者 feature 的几个仓库）；和 repoPath 二选一。 */
  repoPaths?: string[];
  /** 建在这个 feature 下：worktree 放进 feature 的工作区。 */
  featureId?: number;
  workMode?: WorkMode;
  branch?: string;
}

export interface CreateFeatureInput {
  name: string;
  /** 仓库根目录（或仓库里的目录）；至少一个。 */
  repoPaths: string[];
  /** 省略：<仓库的上一层>-features/<名字>。 */
  workspaceDir?: string;
}

export interface CreateEpicInput {
  name: string;
  /** 仓库根目录（或仓库里的目录）；至少一个。 */
  repoPaths: string[];
  /** 省略：<仓库的上一层>-epics/<名字>。 */
  workspaceDir?: string;
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

/** 打开 feature 总控：新开，或者恢复 sessionId。 */
export interface OpenFeatureSessionRequest {
  featureId: number;
  sessionId?: string;
  prefill?: string;
}

/** 打开 epic session：新开，或者恢复 sessionId。 */
export interface OpenEpicSessionRequest {
  epicId: number;
  sessionId?: string;
  prefill?: string;
}

/** 为卡住的 session 开修复 session。 */
export interface OpenFixSessionRequest {
  featureId: number;
  stuckSessionId: string;
}

export type OpenSessionResult =
  | { ok: true; termId: string; alreadyOpen: boolean }
  | { ok: false; reason: "branch_mismatch"; repoId: number; current: string; expected: string; dirty: boolean; busyBy?: { ticket: string; branch: string } }
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

export type FeatureHandoffTrigger = "nightly" | "manual" | "command";

/** feature 汇总（feature_handoffs 表，只追加）。 */
export interface FeatureHandoffRecord {
  id: number;
  featureId: number;
  /** 来源的总控 session；没有总控 session 时为 null。 */
  sessionId: string | null;
  trigger: FeatureHandoffTrigger;
  createdAt: number;
  /** 这份汇总读到了哪个时间点的 ticket handoff / 总控对话；还没写过为 null。 */
  coversUntil: number | null;
  /** 校验通过的汇总；degraded 时为 null。 */
  payload: FeatureHandoff | null;
  degraded: boolean;
  rawText: string | null;
  sourceRef: string | null;
}

/** 一次 feature 汇总的结果。 */
export type FeatureHandoffOutcome =
  | { featureId: number; status: "stored"; handoffId: number; degraded: boolean }
  | { featureId: number; status: "skipped"; reason: "rate_limited" | "nothing_to_summarize" }
  | { featureId: number; status: "failed"; reason: string; message: string };

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

/** 合并总控的一条记录（首页的“合并协调”也用）：wait 等占位、proceed_conflict 带着冲突继续、rebase 让后来者先 rebase、dir_busy 目录被占。 */
export interface MergeEvent {
  id: number;
  repoPath: string;
  kind: "wait" | "proceed_conflict" | "rebase" | "dir_busy";
  ticketKey: string | null;
  branch: string;
  otherTicket: string | null;
  otherBranch: string | null;
  files: string[];
  createdAt: number;
}

export type UsageKind = "ticket" | "coordinator" | "subagent" | "headless";

export interface UsageSummary {
  sinceMs: number;
  /** 五项 token 之和。 */
  totalTokens: number;
  /** 下面三个都是 0..1，按 USAGE_WEIGHTS 折算后的占比；没有数据时为 0。 */
  cacheReadShare: number;
  /** context >= 200_000 的轮次占比。 */
  over200kShare: number;
  byKind: Record<UsageKind, number>;
  /** 模型 -> 折算占比；model 为 null 的记在 "unknown"。 */
  byModel: Record<string, number>;
}

/** 后台监视的一个分支的 PR / CI 状态（渲染进程也用）。 */
export interface WatchedPr {
  ticketKey: string;
  repoId: number;
  repoPath: string;
  branch: string;
  number: number | null;
  url: string | null;
  /** 没有 PR 时为 null。 */
  state: "open" | "merged" | "closed" | null;
  review: "pending" | "changes_requested" | "approved" | null;
  ci: "pending" | "passing" | "failing" | "none" | "unknown";
  headSha: string | null;
  checkedAt: number;
}

/** 「现在」页一行点开去哪：ticket 页、feature 页或 epic 页，sessionId 是要切到的终端（null：页面自己选）。 */
export type NowTarget =
  | { page: "ticket"; key: string; sessionId: string | null }
  | { page: "feature"; id: number; sessionId: string | null }
  | { page: "epic"; id: number; sessionId: string | null };

/** 换新（计划 16）正在做的那一步：写 handoff、/clear、发接着做的话。 */
export type RefreshStep = "handoff" | "clear" | "resume";
/**
 * 换新开始不了的原因（SessionRefresher.precheck）：busy 现在不能往终端里输入；already 正在换新；cooldown 30 分钟内失败过；
 * memory_off 记忆关着；failed 这个 session 不能换新。
 */
export type RefreshRefusal = "busy" | "already" | "cooldown" | "memory_off" | "failed";
/** 界面上的“换新”按钮（IPC sessions:refresh）：开始了，或者为什么开始不了。 */
export type RefreshSessionResult = { ok: true } | { ok: false; reason: RefreshRefusal };

/** 「现在」页的一行：一个开着终端的 Butler session，或者一个没有开着的 session、但有开着的 PR 的 ticket。 */
export interface NowRow {
  /** 没有开着的 session、只有 PR 的行为 null。 */
  sessionId: string | null;
  ticketKey: string | null;
  title: string | null;
  /** 一个 ticket 开了几个仓库的 session 时才填（仓库目录名）。 */
  repo: string | null;
  coordinator: boolean;
  activity: SessionActivity | null;
  /** 这个 session 在合并总控的等待名单里。 */
  mergeQueued: boolean;
  /** 需要你的理由：卡住时是卡住的 reason；停在确认上时是固定文案；不需要为 null。正在换新时为 null。 */
  needsYou: string | null;
  /** Butler 正在给这个 session 换新（计划 16）：做到哪一步；不在换新为 null。 */
  refreshing: RefreshStep | null;
  prs: WatchedPr[];
  /** 停着、不需要你、没有开着的 PR / CI：默认折起来。 */
  idle: boolean;
  /** 这个状态从什么时候开始（activity.startedAt，没有就用 session 的 lastActivityAt）。 */
  since: number | null;
  target: NowTarget;
}

/** 一组的汇总：进行中（不空闲）的行数、需要你的行数、卡住的行数。 */
export interface NowCounts {
  active: number;
  needsYou: number;
  stuck: number;
}

/** id 为 null：不属于任何 feature 的 ticket（name 为空串，界面上显示自己的文案）。 */
export interface NowFeature {
  id: number | null;
  name: string;
  rows: NowRow[];
  counts: NowCounts;
}

/** id 为 null：「无 epic」这一组（name 为空串，界面上显示自己的文案）。rows 是 epic 总控的行。 */
export interface NowEpic {
  id: number | null;
  name: string;
  rows: NowRow[];
  features: NowFeature[];
  counts: NowCounts;
}

export interface NowView {
  /** 全部需要你的行，按 since 从早到晚。 */
  needsYou: NowRow[];
  epics: NowEpic[];
  /** 开着终端的 Butler session 数。 */
  running: number;
  merges: MergeEvent[];
}
