import type { InboxItemView, InboxScope, InboxView } from "../../../shared/types";
import { api } from "../api";
import { inboxWho } from "../now-view";
import { S } from "../strings";
import { useStateRefetch } from "./useStateRefetch";

const timeOf = (ms: number): string => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 一块范围里未决的提问和最近的汇报：打开时取一次，之后每次 stateChanged 重取。还没取到时为 null。 */
export function useInbox(scope: InboxScope): InboxView | null {
  return useStateRefetch(JSON.stringify(scope), () => api.inbox(scope));
}

export function ReportFeed({ reports }: { reports: InboxItemView[] }) {
  if (reports.length === 0) return <p className="muted inbox-reports">{S.inboxNoReports}</p>;
  return (
    <ul className="inbox-reports">
      {reports.map((r) => (
        <li key={r.id} className={`inbox-report ${r.reportKind ?? "progress"}`}>
          <ReportBody r={r} />
        </li>
      ))}
    </ul>
  );
}

/** 一条汇报的内容：谁、哪种、什么时候，加上正文（汇报列表和对话 tab 共用）。 */
export function ReportBody({ r }: { r: InboxItemView }) {
  return (
    <>
      <div className="inbox-head">
        <span className="who">{inboxWho(r, S)}</span>
        <span className={`inbox-kind ${r.reportKind ?? "progress"}`}>{S.inboxReportKinds[r.reportKind ?? "progress"]}</span>
        <span className="muted">{timeOf(r.createdAt)}</span>
      </div>
      <p>{r.text}</p>
    </>
  );
}
