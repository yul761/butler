// 打断与通知（工作流 J，设计文档 2026-11-17 ws-j）：权限档案、自动选择、默认答案、外部通知。主进程和渲染进程共用的类型。

export const PROFILE_STATUSES = ["confirmed", "dismissed", "pending"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export const PROFILE_SOURCES = ["history", "import", "manual"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];

/** 存下来的一条权限档案规则（用户的决定）。 */
export interface ProfileRule {
  slug: string;
  rule: string;
  status: ProfileStatus;
  source: ProfileSource;
  runs: number;
  sessions: number;
  decidedAt: number;
}

/** 从历史里算出来、还没决定的候选。why / caution 是模型可选的解释（没请或失败为 null / false）。 */
export interface ProfileCandidate {
  slug: string;
  rule: string;
  runs: number;
  sessions: number;
  example: string;
  why: string | null;
  caution: boolean;
}

export interface ProfileScan {
  /** 扫描的时间；还没扫过为 null。 */
  scannedAt: number | null;
  candidates: ProfileCandidate[];
  /** 导入进来、等用户确认的规则。 */
  pending: ProfileRule[];
}

export const AUTO_CHOICE_SOURCES = ["rule", "default"] as const;
export type AutoChoiceSource = (typeof AUTO_CHOICE_SOURCES)[number];

/** session 按规则自己做的选择（rule），或 Butler 按默认答案替你答的（default）。 */
export interface AutoChoice {
  id: number;
  source: AutoChoiceSource;
  sessionId: string | null;
  ticketKey: string | null;
  text: string;
  createdAt: number;
  reviewedAt: number | null;
}

/** 默认答案：问题里出现 pattern 的某个关键词（| 分隔，不分大小写）就答 answer；answer 为空表示「选推荐项」。 */
export interface ChoiceDefault {
  id: number;
  pattern: string;
  answer: string;
  enabled: boolean;
  createdAt: number;
}

export const NOTIFY_EVENTS = ["decision_needed", "pr_high_risk", "pr_ready", "cost_breaker", "review_comment", "intake_decision"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
export const NOTIFY_FORMATS = ["json", "ntfy"] as const;
export type NotifyFormat = (typeof NOTIFY_FORMATS)[number];
export const NOTIFY_STATUSES = ["sent", "failed", "quiet", "filtered"] as const;
export type NotifyStatus = (typeof NOTIFY_STATUSES)[number];

export interface NotificationLogEntry {
  id: number;
  ts: number;
  event: NotifyEvent;
  count: number;
  status: NotifyStatus;
  host: string | null;
  payload: string | null;
  error: string | null;
}

/** webhook 地址的状态：界面只看得到 host，完整地址保存后不回渲染进程。 */
export interface WebhookState {
  saved: boolean;
  host: string | null;
  unreadable: boolean;
  encryptionAvailable: boolean;
}

export interface InterruptsState {
  profiles: ProfileRule[];
  autoChoices: AutoChoice[];
  unreviewed: number;
  defaults: ChoiceDefault[];
  webhook: WebhookState;
  log: NotificationLogEntry[];
}

/** 设置页「打断与通知」上的操作（IPC interrupts:act）。 */
export type InterruptsAction =
  | { op: "profile_decide"; slug: string; confirm: string[]; dismiss: string[] }
  | { op: "profile_remove"; slug: string; rule: string }
  | { op: "choices_review"; ids: number[] | null }
  | { op: "default_save"; id: number | null; pattern: string; answer: string; enabled: boolean }
  | { op: "default_delete"; id: number }
  | { op: "webhook_save"; url: string }
  | { op: "webhook_clear" }
  | { op: "notify_test" };

export interface InterruptsActResult {
  state: InterruptsState;
  /** notify_test 的结果。 */
  test?: { ok: boolean; error: string | null };
}
