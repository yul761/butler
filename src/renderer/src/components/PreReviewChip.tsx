// 预审徽标（BTL-271）：ticket 卡片、列表、看板、session 行、ticket 页都用这一枚。
import type { PreReviewBadge, PreReviewTicketStatus } from "../../../shared/prereview";
import { preReviewChip } from "../prereview-view";
import { S } from "../strings";
import { usePreReviewPr, usePreReviewSession, usePreReviewTicket } from "./prereview-store";
import { useNow } from "./TicketActivity";

/** 在跑的要每 30 秒往前走一次「预审中 N 分钟」；其他的不用计时器。 */
function RunningChip({ badge, extra }: { badge: PreReviewBadge; extra?: string }) {
  const now = useNow(30_000);
  return <Chip badge={badge} now={now} extra={extra} />;
}

function Chip({ badge, now, extra }: { badge: PreReviewBadge; now: number; extra?: string }) {
  const v = preReviewChip(badge, now, S);
  const title = [v.title, extra].filter(Boolean).join("\n");
  return (
    <span className={`pill prq prq-${v.tone}`} data-testid="prereview-chip" data-state={v.state} title={title || undefined}>
      {v.label}
    </span>
  );
}

/** 一枚徽标；hideNone 时「未预审」不显示（session 行、PR 行只在有预审时才显示）。 */
export function PreReviewChip({ badge, hideNone, extra }: { badge: PreReviewBadge | null | undefined; hideNone?: boolean; extra?: string }) {
  if (!badge || (hideNone && badge.state === "none")) return null;
  return badge.state === "running" ? <RunningChip badge={badge} extra={extra} /> : <Chip badge={badge} now={Date.now()} extra={extra} />;
}

/** 一个 ticket 的预审（最要紧的那条；几个仓库、分支时悬停列出其他的）。预审关着时没预审过的不显示「未预审」。 */
export function TicketPreReviewChip({ ticketKey, hideNone }: { ticketKey: string; hideNone?: boolean }) {
  return <TicketChip status={usePreReviewTicket(ticketKey)} hideNone={hideNone} />;
}

/** TicketPreReviewChip 的显示部分（只吃 props，测试直接渲染它）。 */
export function TicketChip({ status: s, hideNone }: { status: PreReviewTicketStatus | undefined; hideNone?: boolean }) {
  if (!s) return null;
  const others = s.items.filter((b) => b.id !== s.overall.id);
  const extra = others.map((b) => `${b.repoSlug ?? ""} ${b.branch ?? ""}: ${preReviewChip(b, Date.now(), S).label}`).join("\n");
  return <PreReviewChip badge={s.overall} hideNone={hideNone || !s.enabled} extra={extra || undefined} />;
}

/** 一个 session 最近一次预审（「等 CI」和「预审中」分开）；没有不显示。 */
export function SessionPreReviewChip({ sessionId }: { sessionId: string }) {
  return <PreReviewChip badge={usePreReviewSession(sessionId)} hideNone />;
}

/** 一个 PR 最近一次预审；没有不显示。 */
export function PrPreReviewChip({ prId }: { prId: number }) {
  return <PreReviewChip badge={usePreReviewPr(prId)} hideNone />;
}
