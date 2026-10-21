import type { BriefRule, BriefSection } from "../../shared/brief";
import type { Handoff } from "../../shared/handoff";
import type { FollowupKind, FollowupTrigger, TicketStatus } from "../../shared/types";

/** 返回 [0, n) 的随机整数。生产环境用 crypto.randomInt；测试用可复现的 seededRng。 */
export type Rng = (n: number) => number;

type Pr = NonNullable<Handoff["pr"]>;

export interface NarrativeFollowup {
  kind: FollowupKind;
  trigger: FollowupTrigger;
  description: string;
  /** on_date 已到期时逾期的天数（0 表示今天到期）；其余为 null。 */
  overdueDays: number | null;
}

/** 生成“今日重点”需要的、关于一个 ticket 的全部信息（还没有经过任何隐私处理）。 */
export interface NarrativeTicket {
  key: string;
  status: TicketStatus;
  pr: { state: Pr["state"]; review: Pr["review"] } | null;
  daysInStatus: number;
  idleDays: number;
  /** 上个工作日完成的事项数。 */
  doneLastDay: number;
  nextSteps: string[];
  blockers: string[];
  followups: NarrativeFollowup[];
}

export interface NarrativeItem {
  section: BriefSection;
  rule: BriefRule;
  ticketKey: string | null;
  days: number | null;
  count: number | null;
}

/** 数据库里所有可能出现在自由文本里的标识：用来做假名化字典。人名和敏感词由 gateway 从敏感词表补上。 */
export interface KnownValues {
  tickets: string[];
  repos: string[];
  branches: string[];
}

export interface NarrativeSource {
  date: string;
  tickets: NarrativeTicket[];
  items: NarrativeItem[];
  known: KnownValues;
}

/** 下面是真正发给服务商的 JSON（字段名就是出站的样子）。 */
export interface OutboundFollowup {
  kind: FollowupKind;
  trigger: FollowupTrigger;
  overdue_days: number | null;
  description?: string;
}

export interface OutboundTicket {
  /** metadata / redacted：占位符；full：真实 ticket 号。 */
  id: string;
  status: TicketStatus;
  pr: { state: Pr["state"]; review: Pr["review"] } | null;
  days_in_status: number;
  idle_days: number;
  done_last_day: number;
  followups: OutboundFollowup[];
  next_steps?: string[];
  blockers?: string[];
}

export interface OutboundItem {
  section: BriefSection;
  rule: BriefRule;
  ticket: string | null;
  days: number | null;
  count: number | null;
}

export interface OutboundPayload {
  date: string;
  tickets: OutboundTicket[];
  items: OutboundItem[];
}
