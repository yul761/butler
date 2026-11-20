import { useState, type KeyboardEvent } from "react";
import type { InboxItemView, InboxScope, InboxView } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { inboxWho } from "../now-view";
import { S } from "../strings";
import type { PageTab } from "./PageTabs";
import { useStateRefetch } from "./useStateRefetch";

const timeOf = (ms: number): string => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 一块范围里的「待你决定」和最近的汇报：打开时取一次，之后每次 stateChanged 重取。还没取到时为 null。 */
export function useInbox(scope: InboxScope): InboxView | null {
  return useStateRefetch(JSON.stringify(scope), () => api.inbox(scope));
}

/**
 * 「汇报」和「待你决定」两个 tab（BTL-190 第 2+3 点）：feature 页、epic 页、Butler 总控页终端上面的 tab 里各占一个。
 * 汇报从新到旧；「待你决定」有东西时 tab 标红。还没取到数据时数量先不显示。onGo：卡片上的「去终端」。
 */
export function inboxTabs(view: InboxView | null, onGo: (item: InboxItemView) => void): PageTab[] {
  const reports = view?.reports ?? [];
  const decisions = view?.decisions ?? [];
  return [
    {
      id: "reports",
      label: <>{S.inboxReports}{view && <span className="muted">{reports.length}</span>}</>,
      content: <ReportFeed reports={reports} />,
    },
    {
      id: "decisions",
      label: <>{S.inboxDecisions}{view && <span className="count">{decisions.length}</span>}</>,
      className: decisions.length > 0 ? "attention" : undefined,
      content: <InboxDecisions decisions={decisions} onGo={onGo} />,
    },
  ];
}

export function ReportFeed({ reports }: { reports: InboxItemView[] }) {
  if (reports.length === 0) return <p className="muted inbox-reports">{S.inboxNoReports}</p>;
  return (
    <ul className="inbox-reports">
      {reports.map((r) => (
        <li key={r.id} className={`inbox-report ${r.reportKind ?? "progress"}`}>
          <div className="inbox-head">
            <span className="who">{inboxWho(r, S)}</span>
            <span className={`inbox-kind ${r.reportKind ?? "progress"}`}>{S.inboxReportKinds[r.reportKind ?? "progress"]}</span>
            <span className="muted">{timeOf(r.createdAt)}</span>
          </div>
          <p>{r.text}</p>
        </li>
      ))}
    </ul>
  );
}

function InboxDecisions({ decisions, onGo }: { decisions: InboxItemView[]; onGo: (item: InboxItemView) => void }) {
  if (decisions.length === 0) return <p className="muted inbox-decisions">{S.inboxNoDecisions}</p>;
  return (
    <div className="inbox-decisions">
      {decisions.map((d) => <DecisionCard key={d.id} item={d} onGo={() => onGo(d)} />)}
    </div>
  );
}

/**
 * 一条「待你决定」：谁问的、问题、背景、选项按钮、回答框，「去终端」和「不用了」。
 * 答了以后卡片留着、写明已回答，等提问的 session 停下来 Butler 把回答送进去，送到后卡片消失。
 */
export function DecisionCard({ item, onGo }: { item: InboxItemView; onGo: () => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    api.answerInbox(item.id, text).then(
      () => {
        setDraft("");
        setBusy(false);
      },
      (e: unknown) => {
        setBusy(false);
        reportError(e);
      },
    );
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      answer(draft);
    }
  };
  return (
    <div className="inbox-card">
      <div className="inbox-head">
        <span className="who">{inboxWho(item, S)}</span>
        <span className="muted">{timeOf(item.createdAt)}</span>
        {!item.open && <span className="muted">{S.inboxTerminalClosed}</span>}
      </div>
      <p className="inbox-question">{item.text}</p>
      {item.context && <p className="inbox-context">{item.context}</p>}
      {item.answer !== null ? <p className="inbox-queued">{S.inboxQueued(item.answer)}</p> : (
        <>
          {item.options.length > 0 && (
            <div className="inbox-options">
              {item.options.map((o, n) => <button key={n} disabled={busy} onClick={() => answer(o)}>{o}</button>)}
            </div>
          )}
          <div className="inbox-answer">
            <textarea rows={2} value={draft} placeholder={S.inboxAnswerPlaceholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
            <button className="primary" disabled={busy || !draft.trim()} onClick={() => answer(draft)}>{S.inboxSend}</button>
          </div>
        </>
      )}
      <div className="actions">
        <button onClick={onGo}>{S.inboxGoTerminal}</button>
        <button onClick={() => void api.dismissInbox(item.id).catch(reportError)}>{S.inboxDismiss}</button>
      </div>
    </div>
  );
}
