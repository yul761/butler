import { useState, type FormEvent } from "react";
import { REASON_LIMIT } from "../../../shared/control";
import type { Ticket } from "../../../shared/types";
import { api } from "../api";
import { S } from "../strings";

/**
 * 关闭 ticket（不做了，BTL-270）：原因必填、最多 REASON_LIMIT 个字。输入框不截断（粘贴超长的照样看得见），超了提示、不让提交，主进程也拒；
 * 可以顺便关掉开着的 PR、结束它的 session。有 PR 没关掉、session 没结束时关闭照样成立，提示一句。
 */
export function CloseTicketDialog({ ticket, onClose, onNotice }: { ticket: Ticket; onClose: () => void; onNotice?: (text: string) => void }) {
  const [reason, setReason] = useState("");
  const [closePrs, setClosePrs] = useState(true);
  const [endSessions, setEndSessions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = reason.trim().length === 0;
  const tooLong = reason.length > REASON_LIMIT;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (empty || busy || tooLong) return;
    setBusy(true);
    try {
      const r = await api.closeTicket(ticket.key, { reason, closePrs, endSessions });
      const notes = [
        r.reopenedMeanwhile && S.tc.reopenedMeanwhile,
        r.prErrors.length > 0 && S.tc.prErrors(r.prErrors.length),
        r.sessionErrors.length > 0 && S.tc.sessionErrors(r.sessionErrors.length),
      ].filter((x): x is string => typeof x === "string");
      if (notes.length > 0) onNotice?.(notes.join(" "));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
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
