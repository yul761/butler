import type { AutomationLevel } from "./automation";
import type { IntakeNoticeInfo, IntakeRecentEntry } from "./intake";
import type { CostBreakerView } from "./cost";
import type { CommentsWaiting } from "./loop";
import type { StackNoticeInfo } from "./stacks";
import type { CheckAbsenceReason } from "./checks";
import type { MemorySnapshot, SessionMemory } from "./mem-usage";
import type { ActivityEvent, SessionActivity } from "./activity";
import type { AvailabilityHit, LimitHit } from "./availability";
import type { ReportKind } from "./control";
import type { FeatureHandoff, Handoff, Pr } from "./handoff";
import type { PrMergeable, PrMergeState, PrReviewer, PrReviewRequest } from "./progress";
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
  /** 规划（null：没有）：以前 epic session 建 feature 时给的，和旧 epic 的规划（BTL-246 迁移并进来）。 */
  brief: string | null;
  /** 从 Jira 按 epic 接进来时对应的 Jira epic（BTL-246 §7）；省略或 null：不是从 Jira epic 来的。 */
  jiraEpicKey?: string | null;
  /** 自动化档位（BTL-247）：这个 epic 自己选的；null = 跟随全局。 */
  automationLevel: AutomationLevel | null;
}

export type FeatureStatus = "stuck" | "waiting" | "not_started" | "active" | "archived";

/** 一个 feature 的状态和最新汇总里的进度（Shipherd 总控的 list_features 用）。 */
export interface FeatureStatusRow {
  id: number;
  name: string;
  status: FeatureStatus;
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
  /** 属于哪个 epic（内部还叫 feature，null：单独的 ticket）。 */
  featureId: number | null;
  /** 在 epic 里属于哪个 feature（内部叫 block，见 BTL-246；null 或省略：不属于任何 feature）。 */
  blockId?: number | null;
}

/**
 * epic 里的一个 feature（BTL-246 层级 A′）：一个名字、可选的说明、顺序和一组 ticket。没有总控、没有工作区。
 * 内部叫 block：界面上的 epic 是 features 表（见 docs/superpowers/specs/2026-11-20-btl-246-epic-hierarchy-design.md §2）。
 */
export interface Block {
  id: number;
  /** 属于哪个 epic（features 表的 id）。 */
  featureId: number;
  name: string;
  description: string | null;
  /** 从 0 开始，越小越靠前。 */
  position: number;
  createdAt: number;
}

export type SessionOrigin = "shipherd" | "discovered";

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
  /** 开出来时用的模型（别名或模型路由里的名字；换模型后是新的那个）；null：没指定，恢复时也不传 --model。 */
  model: string | null;
  /** Shipherd 总控（BTL-190 第 5 点）：全局只有一个，ticket、feature 都是 null。 */
  shipherd: boolean;
  /** 复盘分析 session：为了看哪一次复盘运行开的（null：不是）。没有 Shipherd 的工具，不判断卡住、不换新。 */
  lessonRunId: number | null;
  /** 这个 session 启动时为什么没有检查（契约 4.5）；null = 有检查，或者根本没有启用的检查。 */
  checksAbsent?: CheckAbsenceReason | null;
  /** 最近一次采到的整棵进程树内存（KB，WS-M A）；没采过为 null 或缺省。 */
  memKb?: number | null;
  /** 那次采样的时间。 */
  memAt?: number | null;
  /** 休眠的时间（WS-M B）：进程被 Shipherd 结束了，等着 --resume；null 或缺省：没休眠。 */
  hibernatedAt?: number | null;
  /** 休眠时在等什么。 */
  hibernateReason?: HibernateReason | null;
  /** 用户钉住了：不休眠、不降优先级。 */
  pinned?: boolean;
  /** 上一次自动唤醒失败的原因（下一次成功打开时清掉）。 */
  wakeError?: string | null;
  wakeErrorAt?: number | null;
  /** 用户点 × 结束的时间（BTL-256）：有消息时也不自动恢复；再打开时清掉。 */
  userEndedAt?: number | null;
}

/** 休眠时 session 在等什么（WS-M B）：you 等你、ci 等 CI、review 等 review、idle 闲着；pressure 内存紧张，memory 内存过大重启。 */
export type HibernateReason = "you" | "ci" | "review" | "idle" | "pressure" | "memory";

/** termId 非空表示这个 session 当前有一个打开的终端（termId 是该终端启动时用的 session id）。 */
export interface SessionView extends Session {
  termId: string | null;
  /** replaced_by 链的根 session id（第 4 层对话按它存）；换新、/clear 以后不变。没有更早的段时等于 id。 */
  rootId: string;
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
  /** epic 里的 feature（BTL-246，内部叫 block），按顺序；ticket 属于哪个看 TicketView.blockId。 */
  blocks: Block[];
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

/** Shipherd 总控页（BTL-190 第 5 点）：它的 session 和工作目录，以及复盘分析 session。 */
export interface ShipherdView {
  workspaceDir: string;
  sessions: SessionView[];
  hiddenSessions: SessionView[];
  /** 复盘分析 session（没隐藏的 head），最近活动的在前。 */
  lessonSessions: SessionView[];
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
  /** 新分支从哪里开出来（按仓库；工作流 K 的 stack_on：从下面那层的分支开）。没给的仓库从当前 HEAD 开。 */
  startPoints?: { repoPath: string; ref: string }[];
}

export interface CreateFeatureInput {
  name: string;
  /** 仓库根目录（或仓库里的目录）；至少一个。 */
  repoPaths: string[];
  /** 省略：<仓库的上一层>-features/<名字>。 */
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
  /** 新 session 开在哪个仓库里。省略时：ticket 只有一个仓库就用它，否则必须指定。 */
  repoId?: number;
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

/** 打开 Shipherd 总控（BTL-190 第 5 点）：新开，或者恢复 sessionId；已经有一个在跑时都返回那一个。 */
export interface OpenShipherdSessionRequest {
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

/** claude 看起来登没登录（BTL-249）：missing 只是提示，不拦路。 */
export type ClaudeLoginState = "ok" | "missing";
/** gh 装没装、登没登录（BTL-249）。 */
export type GhAuthState = "ok" | "missing" | "logged_out";

export interface HealthReport {
  claude: ClaudeHealth;
  /** claude 找到了才看；没找到时是 null。 */
  claudeLogin: ClaudeLoginState | null;
  gh: GhAuthState;
  hooks: HookStatus;
  hookBinInstalled: boolean;
  handoffCommand: HandoffCommandStatus;
  shipherdHome: string;
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

/**
 * [contract:ticket-finished] 算「已完成」的状态：不会再往下走的 ticket（工作流程不再提醒、不再判断）。
 * needs_decision 不在里面（还等用户拿主意）。BTL-270 的 closed 合进来后加在这里。
 */
export const FINISHED_STATUSES: readonly TicketStatus[] = ["done"];

/** ticket 已经完成：归档了，或者实际状态（手动改的优先）在 FINISHED_STATUSES 里。 */
export const ticketFinished = (t: Pick<Ticket, "status" | "statusManual" | "archivedAt">): boolean =>
  t.archivedAt !== null || FINISHED_STATUSES.includes(effectiveStatus(t));

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
  | { ticketKey: string; status: "skipped"; reason: "rate_limited" | "no_session" | "cost_paused" }
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
  /** 汇总读 PR 实时状态的时间（ws-b）；总控 /handoff 交上来的、或者升级前的为 null（按 createdAt 算）。 */
  prStatusAt: number | null;
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

/**
 * 后台监视的一个 PR（ticket_prs 的一行）或一个还没有 PR 的分支（branch_watch 的一行）的状态（渲染进程也用）。
 * PR 行的 prId、number、url、state 都有；分支行的都是 null。
 */
export interface WatchedPr {
  ticketKey: string;
  /** ticket_prs 的 id；分支行为 null。 */
  prId: number | null;
  /** PR 所在的 ticket 仓库；不是 ticket 仓库的 PR 为 null。 */
  repoId: number | null;
  repoPath: string | null;
  /** PR 的 head 分支（还不知道时为空字符串），或分支行的分支。 */
  branch: string;
  number: number | null;
  url: string | null;
  /** 没有 PR 时为 null。 */
  state: "open" | "merged" | "closed" | null;
  review: "pending" | "changes_requested" | "approved" | null;
  ci: "pending" | "passing" | "failing" | "none" | "unknown";
  headSha: string | null;
  checkedAt: number;
  /** 上一次 gh 读取失败：ci、state 是再上一次的。 */
  readError: boolean;
  /** 放弃读了（一直读不到）：状态只是最后一次读到的，不再当真（progress_overview 不算它）。分支行没有。 */
  gaveUp?: boolean;
  /** PR 行的 base、draft、标题、reviewer 等（ws-b）；分支行没有。 */
  detail?: PrDetail;
}

/** ticket_prs 里 ws-b 加的那些字段（叠放树、轮到谁、汇总新鲜度）。 */
export interface PrDetail {
  baseBranch: string | null;
  isDraft: boolean;
  title: string | null;
  author: string | null;
  labels: string[];
  reviewRequests: PrReviewRequest[];
  reviewers: PrReviewer[];
  mergeable: PrMergeable | null;
  mergeState: PrMergeState | null;
  /** 状态最后一次变化的时间；没读过为 null。 */
  statusChangedAt: number | null;
  slug: string;
}

/** 「现在」页一行点开去哪：ticket 页、feature 页或 Shipherd 总控页，sessionId 是要切到的终端（null：页面自己选）。 */
export type NowTarget =
  | { page: "ticket"; key: string; sessionId: string | null }
  | { page: "feature"; id: number; sessionId: string | null }
  | { page: "shipherd"; sessionId: string | null };

/** 换新（计划 16）正在做的那一步：写 handoff、/clear、发接着做的话。close：闲置关闭（BTL-190 第 8 点），写 handoff 之后结束终端。 */
export type RefreshStep = "handoff" | "clear" | "resume" | "close";
/**
 * 换新开始不了的原因（SessionRefresher.precheck）：busy 现在不能往终端里输入；already 正在换新；cooldown 30 分钟内失败过；
 * memory_off 记忆关着；failed 这个 session 不能换新；awaiting_user 有未决的 ask_user（只拒绝总控触发的换新，BTL-190 第 2+3 点）。
 */
export type RefreshRefusal = "busy" | "already" | "cooldown" | "memory_off" | "failed" | "awaiting_user";
/** 界面上的“换新”按钮（IPC sessions:refresh）：开始了，或者为什么开始不了。 */
export type RefreshSessionResult = { ok: true } | { ok: false; reason: RefreshRefusal };

/** 「现在」页的一行：一个开着终端的 Shipherd session，或者一个没有开着的 session、但有开着的 PR 的 ticket。 */
export interface NowRow {
  /** 没有开着的 session、只有 PR 的行为 null。 */
  sessionId: string | null;
  ticketKey: string | null;
  title: string | null;
  /** 一个 ticket 开了几个仓库的 session 时才填（仓库目录名）。 */
  repo: string | null;
  coordinator: boolean;
  /** 实况卡片上写的地方（BTL-190 第 7 点）：ticket 的 session 是仓库目录名，feature 的 session 是 feature 的名字；不知道为 null。 */
  where: string | null;
  activity: SessionActivity | null;
  /** 正在干活：思考中、跑工具、后台命令（shared/activity 的 isWorking）。停着、等确认的不算。 */
  working: boolean;
  /** 最近 3 次工具调用（实况卡片上的几行），从早到晚。 */
  recent: ActivityEvent[];
  /** 这个 session 在合并总控的等待名单里。 */
  mergeQueued: boolean;
  /** 需要你的理由：卡住时是卡住的 reason；停在确认上时是固定文案；不需要为 null。正在换新时为 null。 */
  needsYou: string | null;
  /** Shipherd 正在给这个 session 换新（计划 16）：做到哪一步；不在换新为 null。 */
  refreshing: RefreshStep | null;
  /** 这个 session 还没答的「待你决定」有几条（BTL-190 第 2+3 点；卡片上答了、等着送的不算）。有未决的条目时 needsYou 为 null（卡片由 TurnService 从 inbox 出）。 */
  decisions: number;
  prs: WatchedPr[];
  /** 停着、不需要你、不在换新也不在合并排队：默认折起来。开着的 PR 不算（BTL-190 第 7 点），只显示在行上。只有 PR 的行不算空闲。 */
  idle: boolean;
  /** 这个状态从什么时候开始（activity.startedAt，没有就用 session 的 lastActivityAt）。 */
  since: number | null;
  target: NowTarget;
  /** 这个 session 整棵进程树最近一次的内存读数（WS-M A）；监控关着、没采到、只有 PR 的行为 null 或缺省。休眠着的为 null。 */
  mem?: SessionMemory | null;
  /** 休眠着（WS-M B）：为什么休眠的；没休眠为 null 或缺省。 */
  hibernated?: HibernateReason | null;
  /** 上次自动唤醒失败（WS-M B）：为什么失败的；没失败、或者已经打开了为 null 或缺省。 */
  wakeError?: string | null;
}

/** 一组的汇总：在干活的行数（NowRow.working）、需要你的件数、卡住的行数。 */
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

/** 「待你决定」一条的状态（BTL-190 第 2+3 点）。 */
export type InboxStatus = "pending" | "answered" | "dismissed" | "superseded";
/** 提问 / 汇报的是哪种 session：ticket 的 session、feature 总控、修复 session、Shipherd 总控（BTL-190 第 5 点）。 */
export type InboxRole = "ticket" | "feature_coordinator" | "fix" | "shipherd";

/** 界面上的一条「待你决定」或汇报。 */
export interface InboxItemView {
  id: number;
  kind: "decision" | "report";
  /** 提问 / 汇报的 session 现在的 head（换新过的话是新的 id）。 */
  sessionId: string;
  role: InboxRole;
  ticketKey: string | null;
  featureId: number | null;
  /** ticket 开了几个仓库时才填（仓库目录名）。 */
  repo: string | null;
  /** decision 是问题，report 是汇报正文。 */
  text: string;
  options: string[];
  context: string | null;
  reportKind: ReportKind | null;
  /** decision：用户已经答了、还没送进终端（等它停下来）时是答案；没答为 null。 */
  answer: string | null;
  createdAt: number;
  /** 这个 session 的终端开着。 */
  open: boolean;
  target: NowTarget;
}

/** feature 页上面的两栏：未决的「待你决定」（从早到晚）和最近的汇报（从新到旧）。 */
export interface InboxView {
  decisions: InboxItemView[];
  reports: InboxItemView[];
}

/** 收件箱看哪一块：一个 feature（含它的 ticket），或者全部。 */
export type InboxScope = { featureId: number } | { all: true };

/** 「现在」页顶上的一条提醒（Claude 限额、复盘暂停或失败、某个 session 撞了限额）。 */
/** 一条 CI 结论：一个 PR 行（ticket_prs 的 id）或一个仓库的分支行（branch_watch 的 repoId）。 */
export type CiItemRef = { kind: "pr"; id: number } | { kind: "branch"; repoId: number };

/**
 * CI 结论为什么没排进信箱（工作流 W；BTL-248 起排进信箱就算交出去了）。no_repo：PR 不在 ticket 的仓库里；no_sha：gh 没给 commit；
 * no_session：没有开着的 session；owner_closed：推这个分支的 session 终端关了；unowned：开着的 session 认不出是谁的；failed：出错。
 */
export type CiUndeliveredReason = "no_repo" | "no_sha" | "no_session" | "owner_closed" | "unowned" | "failed";

/** 递不出去太久的一条 CI 结论。sessionId：本来要递给的 session（还没认出是谁的为 null）。 */
export interface CiUndelivered {
  item: CiItemRef;
  ticketKey: string;
  /** PR 号；分支行为 null。 */
  number: number | null;
  branch: string;
  reason: CiUndeliveredReason;
  since: number;
  sessionId: string | null;
}

export type NowNotice =
  | { kind: "claude_limited"; hit: AvailabilityHit; retryAt: number | null; lessonsPaused: boolean }
  | { kind: "model_unavailable"; hit: AvailabilityHit; retryAt: number | null }
  | { kind: "lessons_paused" }
  | { kind: "lessons_failing"; count: number }
  /** 共享 MCP（WS-M H）开着但 hub 起不来：新开的 session 退回各自的 MCP 进程，Shipherd 按退避在重试。 */
  | { kind: "shared_mcp_failed"; error: string }
  | { kind: "session_limited"; target: NowTarget; title: string | null; limit: LimitHit }
  /** 终端停在权限确认上（第 1 层的 you/shipherd 用）。 */
  /** startup：等的是启动对话框（信任文件夹、新的 MCP server），不是权限确认（BTL-262 审查）。 */
  | { kind: "approval"; target: NowTarget; title: string | null; startup?: boolean }
  /** 模型路由（3.0）：有模型撞限或不可用，或最近一小时有任务降级。只在配置了路由时出现。 */
  | { kind: "routing"; limited: string[]; fallbacks: number }
  /** CI 结论超过半小时没递出去（工作流 W）：可以重发、打开 ticket。 */
  | { kind: "ci_undelivered"; ci: CiUndelivered; target: NowTarget; title: string | null }
  /** 成本熔断（工作流 L）：某个 session / ticket 的花费到了提醒线、降了档或者被暂停了。暂停的可以「继续并提高上限」。 */
  | { kind: "cost"; breaker: CostBreakerView; target: NowTarget | null }
  /** 评论闭环（工作流 I）：有评论等你看分类，或该送进 session 的评论超过 30 分钟没送出去。每个 PR 一条。 */
  | { kind: "comments_waiting"; waiting: CommentsWaiting; target: NowTarget; title: string | null }
  /** 栈式 PR（工作流 K）：冲突没交到 session、draft 太久、栈底落后 trunk 太多、rebase 卡住。每个栈每种原因一条。 */
  | { kind: "stack"; stack: StackNoticeInfo; target: NowTarget | null }
  /** 影子运行的检查自动升级成强制（工作流 F）：一批一条，可撤销。 */
  | { kind: "check_promoted"; eventId: number; batchId: number | null; names: string[]; at: number }
  /** 强制的检查被自动降回影子（batchId 有值，可撤销），或者只标了待复查（flagged）。 */
  | { kind: "check_demoted"; eventId: number; batchId: number | null; names: string[]; reason: "bypassed" | "no_reduction" | null; flagged: boolean; at: number }
  /** 自动接活（工作流 N）：拿不准、缺信息、没映射到仓库、开不成、同路径冲突在排队。每个 ticket 一条。 */
  | { kind: "intake"; item: IntakeNoticeInfo };

export interface NowView {
  /** 页面顶上的提醒，即使没有什么需要你也显示。 */
  notices: NowNotice[];
  /** 按 feature 分组；最后一组 id 为 null，是不属于任何 feature 的 ticket。 */
  features: NowFeature[];
  /** 开着终端的 Shipherd 总控（BTL-190 第 5 点）的一行；没开为 null。在干活也算进 running。 */
  shipherd: NowRow | null;
  /** 正在干活的 session 数（NowRow.working）。 */
  running: number;
  /** 最近的记忆读写（实况窗口的核心卡片，BTL-190 第 7 点），从早到晚。 */
  memory: ActivityEvent[];
  merges: MergeEvent[];
  /** 内存卡片（WS-M A）：最近一次采样；监控关着或还没采到为 null 或缺省。 */
  mem?: MemorySnapshot | null;
  /** 共享 MCP（WS-M H）开着没有：关着时内存卡片提示开了大约能省多少。 */
  sharedMcp?: boolean;
  /** 自动接活（工作流 N）开着时：最近 24 小时自动做了什么（开工、排队、等着、搁着、拆栈）。关着为缺省。 */
  intake?: IntakeRecentEntry[];
}

/** 信箱（BTL-245）：消息的种类。 */
/**
 * ci：CI 结论；merge：合并占位放开了；stack：栈 rebase 冲突；patrol：每日巡检；cost：花费上限后的「接着做」；
 * refresh：换新后的「接着做」；user：用户在对话 tab 里发给开发 session 的话、分叉的结论（BTL-248）。
 */
export type MessageKind = "instruction" | "report" | "answer" | "shipherd" | "reply" | "review" | "comments" | "convention"
  | "ci" | "merge" | "stack" | "patrol" | "cost" | "refresh" | "user";
/** 信箱消息的状态：已排队、已送达、已回复。 */
export type MessageStatus = "queued" | "delivered" | "replied";

/** 界面上的一条信箱消息。时间是 ISO 字符串。 */
export interface MessageView {
  id: string;
  kind: MessageKind;
  /** 给人看的发送方："feature 登录改版的总控"、"ABC-1"、"Shipherd"之类。 */
  from: string;
  /** 给人看的接收方。 */
  to: string;
  toSession: string;
  status: MessageStatus;
  /** 怎么送到的：hook（工具调用的间隙）或 input（直接输入）；还没送到为 null。 */
  via: "hook" | "input" | null;
  interrupt: boolean;
  text: string;
  queuedAt: string;
  deliveredAt: string | null;
  reply: string | null;
  repliedAt: string | null;
}

/** messages:list 的范围：Shipherd 总控的，或者一个 feature 的。 */
export type MessageScope = { shipherd: true } | { featureId: number };
