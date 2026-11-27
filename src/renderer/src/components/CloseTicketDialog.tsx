import { useState, type FormEvent } from "react";
import { REASON_LIMIT } from "../../../shared/control";
import type { Ticket } from "../../../shared/types";
import { api } from "../api";
import { closeOutcome, retryRequest, type CloseLeftoversResult, type ClosePrError } from "../close-ticket-outcome";
import { S } from "../strings";

type Leftovers = { prErrors: ClosePrError[]; sessionErrors: { id: string; error: string }[] };

/**
 * 关闭 ticket（不做了，BTL-270）：原因必填、最多 REASON_LIMIT 个字。输入框不截断（粘贴超长的照样看得见），超了提示、不让提交，主进程也拒；
 * 可以顺便关掉开着的 PR、结束它的 session。ticket 关上了但有 PR 没关掉、session 没结束时不算完成：对话框留着，
 * 逐条列出没处理完的和原因，可以重试剩下的，也可以就这样。
 */
export function CloseTicketDialog({ ticket, onClose, onNotice }: { ticket: Ticket; onClose: () => void; onNotice?: (text: string) => void }) {
  const [reason, setReason] = useState("");
  const [closePrs, setClosePrs] = useState(true);
  const [endSessions, setEndSessions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<Leftovers | null>(null);
  const empty = reason.trim().length === 0;
  const tooLong = reason.length > REASON_LIMIT;

  function settle(r: CloseLeftoversResult) {
    const o = closeOutcome(r);
    if (!o.done) {
      setLeft({ prErrors: o.prErrors, sessionErrors: o.sessionErrors });
      return;
    }
    if (o.reopenedMeanwhile) onNotice?.(S.tc.reopenedMeanwhile);
    onClose();
  }

  async function run(fn: () => Promise<CloseLeftoversResult>) {
    setBusy(true);
    setError(null);
    try {
      settle(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (empty || busy || tooLong) return;
    void run(() => api.closeTicket(ticket.key, { reason, closePrs, endSessions }));
  }

  function retry(e: FormEvent) {
    e.preventDefault();
    if (!left || busy) return;
    void run(() => api.retryClose(ticket.key, retryRequest(left)));
  }

  if (left) {
    return (
      <div className="modal-backdrop">
        <form className="modal close-ticket close-ticket-leftovers" onSubmit={retry}>
          <h2>{S.tc.leftTitle(ticket.key)}</h2>
          <p className="muted">{S.tc.leftLede}</p>
          {left.prErrors.length > 0 && (
            <>
              <h3>{S.tc.leftPrs(left.prErrors.length)}</h3>
              <ul className="close-leftovers">
                {left.prErrors.map((p) => (
                  <li key={p.url}>
                    <code>{p.url}</code> <span className="muted">{S.tc.prKind[p.kind]}</span>
                    <div className="error">{p.error}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {left.sessionErrors.length > 0 && (
            <>
              <h3>{S.tc.leftSessions(left.sessionErrors.length)}</h3>
              <ul className="close-leftovers">
                {left.sessionErrors.map((s) => (
                  <li key={s.id}>
                    <code>{s.id.slice(0, 8)}</code>
                    <div className="error">{s.error}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button type="button" onClick={onClose} disabled={busy}>{S.tc.leaveIt}</button>
            <button type="submit" className="primary" disabled={busy}>{S.tc.retry}</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <form className="modal close-ticket" onSubmit={submit}>
        <h2>{S.tc.title(ticket.key)}</h2>
        <p className="muted">{S.tc.lede}</p>
        <label>
          {S.tc.reason}
          <textarea value={reason} aria-invalid={tooLong} placeholder={S.tc.reasonHint} onChange={(e) => setReason(e.target.value)} autoFocus rows={3} />
        </label>
        <p className={tooLong ? "error" : "muted"}>{tooLong ? S.tc.reasonTooLong(REASON_LIMIT) : S.tc.reasonCount(reason.length, REASON_LIMIT)}</p>
        <label className="check"><input type="checkbox" checked={closePrs} onChange={(e) => setClosePrs(e.target.checked)} /> {S.tc.closePrs}</label>
        <label className="check"><input type="checkbox" checked={endSessions} onChange={(e) => setEndSessions(e.target.checked)} /> {S.tc.endSessions}</label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>{S.cancel}</button>
          <button type="submit" className="primary" disabled={empty || busy || tooLong}>{S.tc.confirm}</button>
        </div>
      </form>
    </div>
  );
}
