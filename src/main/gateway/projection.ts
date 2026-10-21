import type { BriefSection } from "../../shared/brief";
import type { PrivacyLevel } from "../../shared/llm";
import { normalizeText, type Pseudonymizer } from "./pseudonym";
import type { NarrativeSource, OutboundItem, OutboundPayload, OutboundTicket, Rng } from "./types";

/** redacted / full 档位下每段短文本的长度上限（字符）。 */
export const TEXT_LIMIT = 120;
/** next_steps / blockers 每个 ticket 最多发几条。 */
export const LIST_LIMIT = 3;

const SECTION_ORDER: Record<BriefSection, number> = { first: 0, today: 1, watch: 2 };

/** 截断但不切进占位符：切点落在 [[...]] 里面时退到它前面。超长时末尾加 “…”。 */
export function truncateOutside(text: string, limit: number): string {
  const chars = [...text];
  if (chars.length <= limit) return text;
  let cut = chars.slice(0, limit).join("");
  const open = cut.lastIndexOf("[[");
  if (open >= 0 && cut.indexOf("]]", open) < 0) cut = cut.slice(0, open);
  return `${cut.trimEnd()}…`;
}

function shuffle<T>(xs: readonly T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 按档位的字段白名单（设计文档 7.3）：
 * - metadata：占位符 id、状态和 PR 枚举、followup 的 kind / trigger、计数和天数；
 * - redacted：再加假名化后的 next_steps、blockers、followup 描述（每条最多 TEXT_LIMIT 字，每类最多 LIST_LIMIT 条）；
 * - full：同 redacted 的字段，但不做假名化。
 * ticket 的顺序每次打乱；条目按 区块 → 规则 → 占位符 排序，不按真实 ticket 号排。
 */
export function project(src: NarrativeSource, level: Exclude<PrivacyLevel, "off">, p: Pseudonymizer, rng: Rng): OutboundPayload {
  if ((level as string) === "off") throw new Error("project() must not be called at privacy level off");
  const pseudo = level !== "full";
  const withText = level !== "metadata";
  const id = (key: string) => (pseudo ? p.token("T", key) : key);
  const text = (s: string) => truncateOutside(pseudo ? p.apply(s) : normalizeText(s), TEXT_LIMIT);

  const tickets = shuffle(src.tickets, rng).map(
    (t): OutboundTicket => ({
      id: id(t.key),
      status: t.status,
      pr: t.pr ? { state: t.pr.state, review: t.pr.review } : null,
      days_in_status: t.daysInStatus,
      idle_days: t.idleDays,
      done_last_day: t.doneLastDay,
      followups: t.followups.slice(0, LIST_LIMIT).map((f) => ({
        kind: f.kind,
        trigger: f.trigger,
        overdue_days: f.overdueDays,
        ...(withText ? { description: text(f.description) } : {}),
      })),
      ...(withText
        ? { next_steps: t.nextSteps.slice(0, LIST_LIMIT).map(text), blockers: t.blockers.slice(0, LIST_LIMIT).map(text) }
        : {}),
    }),
  );

  const items = src.items
    .map((i): OutboundItem => ({ section: i.section, rule: i.rule, ticket: i.ticketKey === null ? null : id(i.ticketKey), days: i.days, count: i.count }))
    .sort(
      (a, b) =>
        SECTION_ORDER[a.section] - SECTION_ORDER[b.section] || a.rule.localeCompare(b.rule) || (a.ticket ?? "").localeCompare(b.ticket ?? ""),
    );

  return { date: src.date, tickets, items };
}
