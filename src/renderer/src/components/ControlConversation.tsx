// 总控页右边的对话栏：现在是子 session 汇报按时间排开；第 5 层把函数体换成 ConversationTab 加汇报穿插，props 不变。
import type { ReactNode } from "react";
import type { InboxItemView, InboxScope } from "../../../shared/types";
import { S } from "../strings";
import { ReportFeed, useInbox } from "./InboxPanes";

export function ControlFeed({ reports, footer }: { reports: InboxItemView[]; footer?: ReactNode }) {
  const sorted = [...reports].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <div className="control-feed">
      {sorted.length === 0 ? <p className="muted">{S.lay.ctlEmpty}</p> : <ReportFeed reports={sorted} />}
      {footer}
    </div>
  );
}

export function ControlConversation(p: { scope: InboxScope; rootSessionId: string | null; sessions: { id: string; label: string }[]; footer?: ReactNode }) {
  const view = useInbox(p.scope);
  return <ControlFeed reports={view?.reports ?? []} footer={p.footer} />;
}
