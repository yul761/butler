// 总控页右边的对话栏：有总控 session 时是对话 tab（ConversationTab），子 session 的汇报按时间穿插在对话里；
// 还没有总控 session 时只有汇报，照旧按时间排开，不丢。两种情况都用 conversation-view 的同一种排法。
import type { ReactNode } from "react";
import type { InboxItemView, InboxScope } from "../../../shared/types";
import { buildTimeline } from "../conversation-view";
import { S } from "../strings";
import { ConversationTab } from "./ConversationTab";
import { ReportFeed, useInbox } from "./InboxPanes";

export function ControlFeed({ reports, footer }: { reports: InboxItemView[]; footer?: ReactNode }) {
  const sorted = buildTimeline({ messages: [], refreshMarks: [], convHasMore: false, forks: [], reports, reportsHasMore: false, filter: "all" })
    .flatMap((i) => (i.kind === "report" ? [i.report] : []));
  return (
    <div className="control-feed">
      {sorted.length === 0 ? <p className="muted">{S.lay.ctlEmpty}</p> : <ReportFeed reports={sorted} />}
      {footer}
    </div>
  );
}

function ReportsOnly({ scope, footer }: { scope: InboxScope; footer?: ReactNode }) {
  const view = useInbox(scope);
  if (view === null) return null;
  return <ControlFeed reports={view.reports} footer={footer} />;
}

export function ControlConversation(p: { scope: InboxScope; rootSessionId: string | null; sessions: { id: string; label: string }[]; footer?: ReactNode }) {
  const root = p.rootSessionId ?? p.sessions[0]?.id ?? null;
  if (root === null) return <ReportsOnly scope={p.scope} footer={p.footer} />;
  // footer（ButlerReplies）放进对话 tab，在输入框上面。
  return (
    <div className="control-feed">
      <ConversationTab rootSessionId={root} sessions={p.sessions} reportScope={p.scope} footer={p.footer} />
    </div>
  );
}
