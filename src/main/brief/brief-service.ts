import { basename } from "node:path";
import type { Brief, BriefKind, ItemMark } from "../../shared/brief";
import { effectiveStatus } from "../../shared/types";
import type { BriefsRepo } from "../db/briefs-repo";
import type { FollowupsRepo } from "../db/followups-repo";
import type { HandoffsRepo } from "../db/handoffs-repo";
import type { MarksRepo } from "../db/marks-repo";
import type { SessionsRepo } from "../db/sessions-repo";
import type { SettingsRepo } from "../db/settings-repo";
import type { TicketsRepo } from "../db/tickets-repo";
import type { NarrativeSource, NarrativeTicket } from "../gateway/types";
import { addDays, daysBetween, dayStart, localDate, previousWorkingDay } from "../schedule/calendar";
import { scheduleConfig, thresholds } from "../settings/settings-values";
import { buildEveningBrief, buildMorningBrief, followupActive, type TicketSnapshot } from "./engine";

/** PR 链接路径前面那几段：owner / group 和仓库名，它们可能出现在自由文本里，要进假名化字典。 */
const PR_PATH_STOP = new Set(["pull", "pulls", "-", "merge_requests", "pull-requests"]);
const PR_PATH_SKIP = new Set(["projects", "repos", "users", "scm"]);

export function prPathParts(url: string): string[] {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return [];
  }
  const stop = segments.findIndex((s) => PR_PATH_STOP.has(s));
  return (stop >= 0 ? segments.slice(0, stop) : segments.slice(0, 2)).filter((s) => !PR_PATH_SKIP.has(s));
}

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
    // 没有完整 handoff 但有有效的刷新记录时，用刷新记录。
    if (!full?.payload) return this.d.handoffs.latestValid(ticketKey);
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
      // 从上个工作日开始到现在（旧的在前，不含刷新）：包括今天早上补跑的晚间批量。
      previousDayHandoffs: this.d.handoffs.listBetween(dayStart(previousDay), now + 1).filter((h) => h.trigger !== "refresh"),
      thresholds: thresholds(this.d.settings),
    });
    // “今日重点”由早间任务在最终的简报入库之后补上（narrateBrief）。
    return this.d.briefs.insert({ kind: "morning", date: today, createdAt: now, content, narrative: null, narrativeStatus: "off" });
  }

  generateEvening(): Brief {
    const now = this.d.now();
    const today = localDate(now);
    const content = buildEveningBrief({ now, tickets: this.snapshot(), todayHandoffs: this.d.handoffs.listBetween(dayStart(today), now + 1) });
    return this.d.briefs.insert({ kind: "evening", date: today, createdAt: now, content, narrative: null, narrativeStatus: "off" });
  }

  /**
   * “今日重点”的原始输入（还没有经过任何隐私处理，交给 PrivacyGateway）。
   * known 是假名化字典：所有 ticket 号（含已归档的）、仓库目录名、分支名、PR 链接里的 owner / 仓库名，
   * 另外加上 worktree 目录名和 session 工作目录名（自由文本可能提到与仓库目录名不同的目录）。
   */
  narrativeSource(brief: Brief): NarrativeSource {
    const now = this.d.now();
    const today = localDate(now);
    const followups = this.d.followups.listActiveTickets().filter((f) => followupActive(f, today));
    const doneLastDay = new Map((brief.previousDay?.entries ?? []).map((e) => [e.ticketKey, e.done.length]));
    const all = this.d.tickets.list({ includeArchived: true });
    const repos = new Set<string>();
    const branches = new Set<string>();
    const dir = (path: string | null) => {
      const name = path ? basename(path) : "";
      if (name.length >= 3) repos.add(name);
    };
    for (const t of all) {
      dir(t.repoPath);
      dir(t.worktreePath);
      branches.add(t.branch);
      for (const s of this.d.sessions.listByTicket(t.key)) {
        if (s.gitBranch) branches.add(s.gitBranch);
        dir(s.cwd);
      }
    }
    const tickets = this.snapshot().map((t): NarrativeTicket => {
      const p = t.latest?.payload ?? null;
      if (p?.pr?.url) for (const part of prPathParts(p.pr.url)) repos.add(part);
      return {
        key: t.key,
        status: t.status,
        pr: p?.pr ? { state: p.pr.state, review: p.pr.review } : null,
        daysInStatus: daysBetween(t.statusSince, now),
        idleDays: daysBetween(t.lastActivityAt, now),
        doneLastDay: doneLastDay.get(t.key) ?? 0,
        nextSteps: p?.next_steps ?? [],
        blockers: p?.blockers ?? [],
        followups: followups
          .filter((f) => f.ticketKey === t.key)
          .map((f) => ({
            kind: f.kind,
            trigger: f.trigger,
            description: f.description,
            overdueDays: f.trigger === "on_date" && f.dueDate !== null && f.dueDate <= today ? daysBetween(dayStart(f.dueDate), now) : null,
          })),
      };
    });
    return {
      date: brief.date,
      tickets,
      items: brief.items.map((i) => ({ section: i.section, rule: i.rule, ticketKey: i.ticketKey, days: i.days, count: i.count })),
      known: { tickets: all.map((t) => t.key), repos: [...repos], branches: [...branches] },
    };
  }

  latest(kind: BriefKind): Brief | null {
    return this.d.briefs.latest(kind);
  }

  /** 非 followup 条目的“完成 / 推迟到明天 / 忽略”。 */
  mark(itemKey: string, mark: ItemMark): void {
    if (itemKey.startsWith("followup:")) throw new Error(`followup 条目不能用 mark：请通过 followups 标记 (${itemKey})`);
    const now = this.d.now();
    this.d.marks.set(itemKey, mark, mark === "snoozed" ? addDays(localDate(now), 1) : null, now);
  }
}
