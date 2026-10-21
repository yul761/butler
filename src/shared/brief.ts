export type BriefKind = "morning" | "evening";
export type BriefSection = "first" | "today" | "watch";
export type BriefRule =
  | "pr_approved"
  | "pr_changes_requested"
  | "followup_after_merge"
  | "followup_due"
  | "next_step"
  | "blocked_long"
  | "review_waiting"
  | "stale"
  | "unclaimed";
export type NarrativeStatus = "ok" | "off" | "failed" | "blocked" | "budget";

export const ITEM_MARKS = ["done", "snoozed", "ignored"] as const;
export type ItemMark = (typeof ITEM_MARKS)[number];
export interface MarkState {
  mark: ItemMark;
  /** 只有 snoozed 有值：到这一天（含）重新出现。 */
  untilDate: string | null;
}

/** 简报里的一条。文案由渲染进程按 rule 拼（strings.ts），这里只放数据。 */
export interface BriefItem {
  /** 稳定 id：followup 条目是 `followup:<id>`；其余条目的“完成/推迟/忽略”按这个 key 记在 item_marks 里。 */
  key: string;
  section: BriefSection;
  rule: BriefRule;
  ticketKey: string | null;
  followupId: string | null;
  /** next step、followup 描述或阻塞原因。 */
  text: string | null;
  /** 阻塞 / 等 review / 无活动 / 逾期的天数。 */
  days: number | null;
  /** 未认领 session 的数量。 */
  count: number | null;
  pr: { number: number; url: string } | null;
  dueDate: string | null;
}

export interface DayEntry {
  ticketKey: string;
  done: string[];
}

export interface EveningEntry {
  ticketKey: string;
  done: string[];
  blockers: string[];
  next: string | null;
  degraded: boolean;
}

export interface BriefNotices {
  /** 最新一次 handoff 不完整的 ticket。 */
  degraded: string[];
  /** 最新一次 handoff 的 jira 为 null（tracker MCP 不可用）的 ticket。 */
  trackerUnavailable: string[];
}

export interface BriefContent {
  items: BriefItem[];
  /** 早间简报：上个工作日完成的事。晚间小结为 null。 */
  previousDay: { date: string; entries: DayEntry[] } | null;
  /** 晚间小结：今天每个 ticket 的进展。早间简报为空。 */
  evening: EveningEntry[];
  notices: BriefNotices;
}

export const EMPTY_BRIEF_CONTENT: BriefContent = { items: [], previousDay: null, evening: [], notices: { degraded: [], trackerUnavailable: [] } };

export interface Brief extends BriefContent {
  id: number;
  kind: BriefKind;
  /** YYYY-MM-DD（本地日期）。 */
  date: string;
  createdAt: number;
  /** 早间简报的“今日重点”（计划 3，个人 LLM API）。简报先入库，之后由 narrateBrief 补上；晚间小结永远是 null / "off"。 */
  narrative: string | null;
  narrativeStatus: NarrativeStatus;
}

export interface BriefView {
  brief: Brief | null;
  /** 早间刷新（查询 PR / tracker）进行中。 */
  refreshing: boolean;
}
