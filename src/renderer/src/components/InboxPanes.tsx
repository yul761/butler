import { useEffect, useState, type KeyboardEvent } from "react";
import type { InboxItemView, InboxScope, InboxView } from "../../../shared/types";
import { api } from "../api";
import { reportError } from "../errors";
import { inboxWho } from "../now-view";
import { S } from "../strings";

/** hook 事件一来一串：合并成一次重读（和 App 的刷新一样）。 */
const STATE_DEBOUNCE_MS = 80;

const timeOf = (ms: number): string => new Date(ms).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 一块范围里的「待你决定」和最近的汇报：打开时取一次，之后每次 stateChanged 重取。还没取到时为 null。 */
export function useInbox(scope: InboxScope): InboxView | null {
  // scope 每次渲染都是新对象：按内容决定要不要重新订阅。
  const key = JSON.stringify(scope);
  const [view, setView] = useState<InboxView | null>(null);
  useEffect(() => {
    let live = true;
    let seq = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      const n = ++seq;
      api.inbox(JSON.parse(key) as InboxScope).then((v) => live && n === seq && setView(v), reportError);
    };
    load();
    const off = api.onStateChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(load, STATE_DEBOUNCE_MS);
    });
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [key]);
  return view;
}

/**
 * feature 页、epic 页终端上面的两栏（BTL-190 第 2+3 点）：左边是汇报（从新到旧），右边是「待你决定」的卡片。两栏都空时整块不显示。
 * onGo：卡片上的「去终端」。alwaysShow：都空也显示（Butler 总控页，BTL-190 第 5 点）。
 */
export function InboxPanes({ scope, onGo, alwaysShow }: { scope: InboxScope; onGo: (item: InboxItemView) => void; alwaysShow?: boolean }) {
  const view = useInbox(scope);
  if (!view || (!alwaysShow && view.decisions.length === 0 && view.reports.length === 0)) return null;
  return (
    <div className="inbox-panes">
      <section className="inbox-pane inbox-reports">
        <h3>{S.inboxReports}<span className="muted">{view.reports.length}</span></h3>
        {view.reports.length === 0 ? <p className="muted">{S.inboxNoReports}</p> : (
          <ul>
            {view.reports.map((r) => (
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
        )}
      </section>
      <section className="inbox-pane inbox-decisions">
        <h3>{S.inboxDecisions}<span className="muted">{view.decisions.length}</span></h3>
        {view.decisions.length === 0 ? <p className="muted">{S.inboxNoDecisions}</p> : view.decisions.map((d) => <DecisionCard key={d.id} item={d} onGo={() => onGo(d)} />)}
      </section>
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
