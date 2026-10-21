import type { Brief, BriefKind, ItemMark } from "../../shared/brief";
import { effectiveStatus } from "../../shared/types";
import type { BriefsRepo } from "../db/briefs-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MarksRepo } from "../db/marks-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import { addDays, dayStart, localDate, previousWorkingDay } from "../schedule/calendar";
import { scheduleConfig, thresholds } from "../settings/settings-values";
import { buildEveningBrief, buildMorningBrief, type TicketSnapshot } from "./engine";

export interface BriefServiceDeps {
  tickets: TicketsRepo;
  sessions: SessionsRepo;
  handoffs: HandoffsRepo;
  followups: FollowupsRepo;
  marks: MarksRepo;
  briefs: BriefsRepo;
  settings: SettingsRepo;
  now: () => number;
  unclaimedCount: () => number;
}

export class BriefService {
  constructor(private readonly d: BriefServiceDeps) {}

  /**
   * 规则引擎的输入：每个未归档、未完成 ticket 的状态、时间点和最新 handoff。
   * 已完成（done）的 ticket 不进快照，免得它们被“无活动”之类的规则反复提起。
   */
  snapshot(): TicketSnapshot[] {
    return this.d.tickets
      .list()
      .filter((t) => t.archivedAt === null && effectiveStatus(t) !== "done")
      .map((t) => {
        const times = this.d.tickets.statusTimes(t.key);
        const statusSince = (t.statusManual ? times.manualAt : times.changedAt) ?? t.createdAt;
        const activity = this.d.sessions.listByTicket(t.key).map((s) => s.lastActivityAt ?? 0);
        return {
          key: t.key,
          status: effectiveStatus(t),
          createdAt: t.createdAt,
          statusSince,
          lastActivityAt: Math.max(t.createdAt, ...activity),
          latest: this.latestFull(t.key),
          latestDegraded: this.d.handoffs.latestFull(t.key)?.degraded ?? false,
        };
      });
  }

  /**
   * 最新一条“完整”handoff（不是刷新记录），所以 next_step 的条目 key（含 handoff id）不会被早间刷新改掉。
   * 比它新的刷新记录只提供 PR / tracker / 状态，叠加在它的 payload 上，让 PR 规则看到最新的 PR 状态。
   */
  private latestFull(ticketKey: string) {
    const full = this.d.handoffs.latestValidFull(ticketKey);
    if (!full?.payload) return full;
    const refresh = this.d.handoffs.latestValid(ticketKey);
    if (!refresh?.payload || refresh.trigger !== "refresh") return full;
    if (refresh.createdAt < full.createdAt || (refresh.createdAt === full.createdAt && refresh.id < full.id)) return full;
    return { ...full, payload: { ...full.payload, status: refresh.payload.status, pr: refresh.payload.pr, jira: refresh.payload.jira } };
  }

  generateMorning(): Brief {
    const now = this.d.now();
    const today = localDate(now);
    const previousDay = previousWorkingDay(today, scheduleConfig(this.d.settings).workingDays);
    const content = buildMorningBrief({
      now,
      tickets: this.snapshot(),
      followups: this.d.followups.listActiveTickets(),
      marks: this.d.marks.all(),
      unclaimedCount: this.d.unclaimedCount(),
      previousDay,
      // 只取上个工作日（本地日期）当天的 handoff，旧的在前；今天补跑的晚间批量不算“昨天做的”。
      previousDayHandoffs: this.d.handoffs.listBetween(dayStart(previousDay), dayStart(addDays(previousDay, 1))),
      thresholds: thresholds(this.d.settings),
    });
    // 计划 3 在这里接 PrivacyGateway 生成“今日重点”；计划 2 永远是 off。
    return this.d.briefs.insert({ kind: "morning", date: today, createdAt: now, content, narrative: null, narrativeStatus: "off" });
  }

  generateEvening(): Brief {
    const now = this.d.now();
    const today = localDate(now);
    const content = buildEveningBrief({ now, tickets: this.snapshot(), todayHandoffs: this.d.handoffs.listBetween(dayStart(today), now + 1) });
    return this.d.briefs.insert({ kind: "evening", date: today, createdAt: now, content, narrative: null, narrativeStatus: "off" });
  }

  latest(kind: BriefKind): Brief | null {
    return this.d.briefs.latest(kind);
  }

  /** 非 followup 条目的“完成 / 推迟到明天 / 忽略”。 */
  mark(itemKey: string, mark: ItemMark): void {
    const now = this.d.now();
    this.d.marks.set(itemKey, mark, mark === "snoozed" ? addDays(localDate(now), 1) : null, now);
  }
}
