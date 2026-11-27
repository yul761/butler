// 预审队列页（BTL-271）：正在预审的、排着队的、队列为什么停着；排队的可以提到最前或取消。
import { useState } from "react";
import type { PreReviewQueueItem, PreReviewQueueView } from "../../../shared/prereview";
import { api } from "../api";
import { reportError } from "../errors";
import { preReviewChip, preReviewClock, preReviewStoppedText } from "../prereview-view";
import { S } from "../strings";
import { useNow } from "./TicketActivity";
import { useStateRefetch } from "./useStateRefetch";

interface Props {
  onOpenTicket: (key: string) => void;
  onOpenSettings: () => void;
}

export function PreReviewQueuePage({ onOpenTicket, onOpenSettings }: Props) {
  const q = useStateRefetch("prereview-queue", api.preReviewQueue);
  // 「预审中 N 分钟」自己往前走。
  const now = useNow(30_000);
  return (
    <div className="page prq-page" data-testid="prereview-queue-page">
      <h2>{S.prq.title}</h2>
      <p className="muted">{S.prq.intro}</p>
      {q && <PreReviewQueueBody q={q} now={now} onOpenTicket={onOpenTicket} onOpenSettings={onOpenSettings} />}
    </div>
  );
}

/** 页面的内容（只吃 props，测试直接渲染它）。act 不给时用真的 api。 */
export function PreReviewQueueBody(p: Props & { q: PreReviewQueueView; now: number; act?: typeof api.preReviewQueueAct }) {
  const { q } = p;
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const act = async (op: "cancel" | "front", id: number) => {
    setBusy(id);
    try {
      const r = await (p.act ?? api.preReviewQueueAct)({ op, id });
      setMessage(r.ok ? { text: op === "cancel" ? S.prq.cancelled : S.prq.fronted, error: false } : { text: S.prq.actFailed[r.reason], error: true });
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  };
  const stopped = preReviewStoppedText(q, S);
  return (
    <>
      <p className="prq-concurrency">
        <span>{S.prq.concurrency(q.concurrency)}</span>{" "}
        <button className="link" data-testid="prereview-change-concurrency" onClick={p.onOpenSettings}>{S.prq.changeConcurrency}</button>
      </p>
      {stopped && <p className="notice" role="status" data-testid="prereview-stopped">{stopped}</p>}
      {message && <p className={message.error ? "error" : "muted"} role="status" data-testid="prereview-queue-message">{message.text}</p>}
      {q.running.length === 0 && q.queued.length === 0 && q.ending.length === 0 ? <p className="muted" data-testid="prereview-queue-empty">{S.prq.empty}</p> : (
        <>
          <h3>{S.prq.runningTitle}</h3>
          {q.running.length === 0 ? <p className="muted">—</p> : (
            <ul className="prq-list" data-testid="prereview-running">
              {q.running.map((x) => <Row key={x.id} x={x} now={p.now} onOpenTicket={p.onOpenTicket} />)}
            </ul>
          )}
          {q.ending.length > 0 && (
            <>
              {/* 取消了还没停下、出了结论还在收尾的：不算在跑的，也不能再取消、插队。 */}
              <h3>{S.prq.endingTitle}</h3>
              <ul className="prq-list" data-testid="prereview-ending">
                {q.ending.map((x) => <Row key={x.id} x={x} now={p.now} onOpenTicket={p.onOpenTicket} />)}
              </ul>
            </>
          )}
          <h3>{S.prq.queuedTitle}</h3>
          {q.queued.length === 0 ? <p className="muted">{S.prq.noneQueued}</p> : (
            <ol className="prq-list" data-testid="prereview-queued">
              {q.queued.map((x, i) => (
                <Row key={x.id} x={x} now={p.now} onOpenTicket={p.onOpenTicket}>
                  <button data-testid={`prereview-front-${x.id}`} disabled={busy !== null || i === 0} onClick={() => void act("front", x.id)}>{S.prq.front}</button>
                  <button data-testid={`prereview-cancel-${x.id}`} disabled={busy !== null} onClick={() => void act("cancel", x.id)}>{S.prq.cancel}</button>
                </Row>
              ))}
            </ol>
          )}
        </>
      )}
    </>
  );
}

/** 一行：ticket、PR、怎么触发的、什么时候排上 / 开始、在等什么。 */
function Row({ x, now, onOpenTicket, children }: { x: PreReviewQueueItem; now: number; onOpenTicket: (key: string) => void; children?: React.ReactNode }) {
  const chip = preReviewChip(x, now, S);
  const v = x.ending ? { ...chip, label: S.prq.ending[x.ending], tone: "muted" as const } : chip;
  const when = x.state === "running" && x.startedAt ? S.prq.started(preReviewClock(x.startedAt)) : x.enqueuedAt ? S.prq.enqueued(preReviewClock(x.enqueuedAt)) : "";
  const where = [x.repoSlug, x.branch].filter(Boolean).join(" · ");
  return (
    <li className="prq-row" data-testid={`prereview-item-${x.id}`} data-state={x.ending ?? x.state}>
      <span className={`pill prq prq-${v.tone}`} title={v.title || undefined}>{v.label}</span>
      {x.ticketKey ? <button className="key link" onClick={() => onOpenTicket(x.ticketKey!)}>{x.ticketKey}</button> : <span className="muted">—</span>}
      {x.prNumber !== null && (x.prUrl ? <a href={x.prUrl} target="_blank" rel="noreferrer">#{x.prNumber}</a> : <span>#{x.prNumber}</span>)}
      {where && <span className="muted">{where}</span>}
      {x.trigger && <span className="muted">{S.prq.trigger[x.trigger]}</span>}
      {when && <span className="muted">{when}</span>}
      {x.state !== "running" && x.waiting && <span className="muted">{S.prq.waiting[x.waiting]}</span>}
      {children && <span className="actions">{children}</span>}
    </li>
  );
}
