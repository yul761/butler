import type { BriefContent, BriefItem, BriefNotices, BriefRule, BriefSection, DayEntry, EveningEntry, MarkState } from "../../shared/brief";
import type { Pr } from "../../shared/handoff";
import type { Followup, HandoffRecord, TicketStatus } from "../../shared/types";
import { combinedPr, prKey } from "../handoff/prs";
import { daysBetween, dayStart, localDate } from "../schedule/calendar";
import type { Thresholds } from "../settings/settings-values";

export interface TicketSnapshot {
  key: string;
  /** 有效状态（手动值优先）。 */
  status: TicketStatus;
  createdAt: number;
  /** 进入当前有效状态的时间。 */
  statusSince: number;
  /** 最近一次 session 活动（没有 session 时是创建时间）。 */
  lastActivityAt: number;
  /** 最新一条完整 handoff（含刷新）。 */
  latest: HandoffRecord | null;
  /** 最新一条 handoff（任何触发方式）是 degraded。 */
  latestDegraded: boolean;
}

export interface MorningInput {
  now: number;
  tickets: TicketSnapshot[];
  followups: Followup[];
  marks: ReadonlyMap<string, MarkState>;
  unclaimedCount: number;
  /** 上个工作日（YYYY-MM-DD），用作标题。 */
  previousDay: string;
  /** 从上个工作日开始到现在的 handoff。 */
  previousDayHandoffs: HandoffRecord[];
  thresholds: Thresholds;
}

export interface EveningInput {
  now: number;
  tickets: TicketSnapshot[];
  /** 今天的 handoff，旧的在前。 */
  todayHandoffs: HandoffRecord[];
}

const SECTION_RANK: Record<BriefSection, number> = { first: 0, today: 1, watch: 2 };
const RULE_RANK: Record<BriefRule, number> = {
  pr_approved: 0, pr_changes_requested: 1, followup_after_merge: 2, followup_due: 3,
  next_step: 4, blocked_long: 5, review_waiting: 6, stale: 7, unclaimed: 8,
};

/** open 的，或推迟到今天（含）已经到期的。 */
export function followupActive(f: Followup, today: string): boolean {
  if (f.status === "open") return true;
  return f.status === "snoozed" && f.snoozedUntil !== null && f.snoozedUntil <= today;
}

/** done / ignored 永远隐藏；snoozed 隐藏到 untilDate 那天为止（那天重新出现）。 */
export function markHides(m: MarkState | undefined, today: string): boolean {
  if (!m) return false;
  if (m.mark === "snoozed") return m.untilDate !== null && today < m.untilDate;
  return true;
}

function item(section: BriefSection, rule: BriefRule, key: string, over: Partial<BriefItem> = {}): BriefItem {
  return { key, section, rule, ticketKey: null, followupId: null, text: null, days: null, count: null, pr: null, dueDate: null, ...over };
}

function doneByTicket(handoffs: HandoffRecord[]): DayEntry[] {
  const by = new Map<string, string[]>();
  for (const h of handoffs) {
    if (!h.payload || h.trigger === "refresh") continue;
    const list = by.get(h.ticketKey) ?? [];
    for (const d of h.payload.done_today) {
      const s = d.trim();
      if (s && !list.includes(s)) list.push(s);
    }
    by.set(h.ticketKey, list);
  }
  return [...by]
    .filter(([, done]) => done.length > 0)
    .map(([ticketKey, done]) => ({ ticketKey, done }))
    .sort((a, b) => a.ticketKey.localeCompare(b.ticketKey));
}

function notices(tickets: TicketSnapshot[]): BriefNotices {
  return {
    degraded: tickets.filter((t) => t.latestDegraded).map((t) => t.key).sort(),
    trackerUnavailable: tickets.filter((t) => t.latest?.payload && t.latest.payload.jira === null).map((t) => t.key).sort(),
  };
}

/** 设计文档 6.3 节的规则。 */
export function buildMorningBrief(i: MorningInput): BriefContent {
  const today = localDate(i.now);
  const active = i.followups.filter((f) => followupActive(f, today));
  const items: BriefItem[] = [];

  for (const t of i.tickets) {
    const p = t.latest?.payload ?? null;
    const prs = p?.prs ?? [];
    const combined = combinedPr(prs);
    const ref = (pr: Pr) => ({ number: pr.number, url: pr.url });

    // 🔴 先做：每个打开的 PR 各算一条（多仓库 ticket 可能一个批准了、另一个要求修改）。
    for (const pr of prs) {
      if (pr.state === "open" && pr.review === "approved") {
        items.push(item("first", "pr_approved", `pr_approved:${t.key}:${prKey(pr, prs)}`, { ticketKey: t.key, pr: ref(pr) }));
      }
      if (pr.state === "open" && pr.review === "changes_requested") {
        items.push(item("first", "pr_changes_requested", `pr_changes:${t.key}:${prKey(pr, prs)}`, { ticketKey: t.key, pr: ref(pr) }));
      }
    }
    for (const f of active) {
      if (f.ticketKey !== t.key) continue;
      if (t.status === "merged_pending_followup" && f.trigger === "after_merge") {
        items.push(item("first", "followup_after_merge", `followup:${f.id}`, { ticketKey: t.key, followupId: f.id, text: f.description }));
      } else if (f.trigger === "on_date" && f.dueDate !== null && f.dueDate <= today) {
        items.push(item("first", "followup_due", `followup:${f.id}`, {
          ticketKey: t.key, followupId: f.id, text: f.description, dueDate: f.dueDate, days: daysBetween(dayStart(f.dueDate), i.now),
        }));
      }
    }

    // 🟡 今天
    const next = p?.next_steps[0];
    if (t.status === "active" && next && t.latest) {
      items.push(item("today", "next_step", `next:${t.key}:${t.latest.id}`, { ticketKey: t.key, text: next }));
    }
    const inStatus = daysBetween(t.statusSince, i.now);
    if (t.status === "blocked" && inStatus > i.thresholds.blockedDays) {
      items.push(item("today", "blocked_long", `blocked:${t.key}:${localDate(t.statusSince)}`, { ticketKey: t.key, days: inStatus, text: p?.blockers[0] ?? null }));
    }

    // ⚪ 留意
    if (t.status === "in_review" && (combined === null || combined.review === null || combined.review === "pending") && inStatus > i.thresholds.reviewWaitDays) {
      // 链接给第一个还在等 review 的 PR。
      const waiting = prs.find((pr) => pr.state === "open" && pr.review !== "approved") ?? null;
      items.push(item("watch", "review_waiting", `review:${t.key}:${localDate(t.statusSince)}`, { ticketKey: t.key, days: inStatus, pr: waiting && ref(waiting) }));
    }
    const idle = daysBetween(t.lastActivityAt, i.now);
    if (idle > i.thresholds.staleDays) {
      items.push(item("watch", "stale", `stale:${t.key}:${localDate(t.lastActivityAt)}`, { ticketKey: t.key, days: idle }));
    }
  }
  if (i.unclaimedCount > 0) items.push(item("watch", "unclaimed", `unclaimed:${today}`, { count: i.unclaimedCount }));

  // followup 条目由 followup 自己的状态决定；其余条目看 item_marks。
  const visible = items.filter((it) => it.followupId !== null || !markHides(i.marks.get(it.key), today));
  visible.sort(
    (a, b) =>
      SECTION_RANK[a.section] - SECTION_RANK[b.section] ||
      RULE_RANK[a.rule] - RULE_RANK[b.rule] ||
      (a.ticketKey ?? "").localeCompare(b.ticketKey ?? ""),
  );
  return { items: visible, previousDay: { date: i.previousDay, entries: doneByTicket(i.previousDayHandoffs) }, evening: [], notices: notices(i.tickets) };
}

/** 设计文档 6.1 节：按 ticket 列出今天做了什么、阻塞项和明天第一步。 */
export function buildEveningBrief(i: EveningInput): BriefContent {
  const captured = i.todayHandoffs.filter((h) => h.trigger !== "refresh");
  const latest = new Map<string, HandoffRecord>();
  for (const h of captured) latest.set(h.ticketKey, h);
  const done = new Map(doneByTicket(captured).map((e) => [e.ticketKey, e.done]));
  const evening: EveningEntry[] = [...latest.values()]
    .map((h) => ({
      ticketKey: h.ticketKey,
      done: done.get(h.ticketKey) ?? [],
      blockers: h.payload?.blockers ?? [],
      next: h.payload?.next_steps[0] ?? null,
      degraded: h.payload === null,
    }))
    .sort((a, b) => a.ticketKey.localeCompare(b.ticketKey));
  return { items: [], previousDay: null, evening, notices: notices(i.tickets) };
}
