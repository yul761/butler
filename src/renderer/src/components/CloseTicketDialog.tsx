import { useEffect, useState, type FormEvent } from "react";
import { REASON_LIMIT } from "../../../shared/control";
import type { Ticket } from "../../../shared/types";
import { api } from "../api";
import { closedMeanwhile, closeOutcome, closePrsRequest, retryableInPreview, retryRequest, type CloseLeftoversResult, type ClosePreview, type ClosePrError } from "../close-ticket-outcome";
import { S } from "../strings";

type Leftovers = { prErrors: ClosePrError[]; sessionErrors: { id: string; error: string }[] };

function PrErrorList({ prs }: { prs: ClosePrError[] }) {
  return (
    <ul className="close-leftovers">
      {prs.map((p) => (
        <li key={p.url}>
          <code>{p.url}</code> <span className="muted">{S.tc.prKind[p.kind]}</span>
          <div className="error">{p.error}</div>
        </li>
      ))}
    </ul>
  );
}

/**
 * 关闭 ticket（不做了，BTL-270）：原因必填、最多 REASON_LIMIT 个字。输入框不截断（粘贴超长的照样看得见），超了提示、不让提交，主进程也拒；
 * 打开时先列出这个 ticket 开着的 PR：能关的（这个 ticket 自己分支上的）逐个勾选，默认不勾，勾了的才关；关不了的写明原因，不会关。
 * 勾了 PR 时说明原因会作为评论公开发到 GitHub。可以顺便结束它的 session。
 * ticket 关上了但有 PR 没关掉、session 没结束时不算完成：对话框留着，逐条列出没处理完的和原因，可以重试剩下的（再试也一样的不重试），也可以就这样。
 * rest：ticket 已经关着，从 ticket 页的「关掉剩下的 PR」打开（BTL-270 审查）：同一个勾选框，不再要原因（评论写关闭时的原因），
 * 勾上的走重试（tickets:closeRetry，关之前同样核对），之后和关闭一样处理结果。
 */
export function CloseTicketDialog({ ticket, onClose, onNotice, rest = false }: { ticket: Ticket; onClose: () => void; onNotice?: (text: string) => void; rest?: boolean }) {
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [endSessions, setEndSessions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<Leftovers | null>(null);
  const empty = reason.trim().length === 0;
  const tooLong = reason.length > REASON_LIMIT;

  useEffect(() => {
    let live = true;
    api.closePreview(ticket.key).then(
      (p) => live && setPreview(p),
      (err: unknown) => live && setPreviewError((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [ticket.key]);

  function toggle(url: string, on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(url);
      else next.delete(url);
      return next;
    });
  }

  function settle(r: CloseLeftoversResult) {
    const o = closeOutcome(r);
    // 打开关闭框以后别人（总控）先关了这个 ticket：这次只关了勾的 PR（评论用这里填的原因），关闭的原因、来源还是第一次的。
    if (closedMeanwhile(r, rest)) onNotice?.(S.tc.closedMeanwhile);
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
    const { closePrs, prUrls } = closePrsRequest(preview, picked);
    if (rest) {
      if (busy || prUrls.length === 0) return;
      void run(() => api.retryClose(ticket.key, { prUrls, sessionIds: [] }));
      return;
    }
    if (empty || busy || tooLong) return;
    void run(() => api.closeTicket(ticket.key, { reason, closePrs, endSessions, prUrls }));
  }

  const again = left ? retryRequest(left) : null;
  const retryable = retryableInPreview(preview);
  const unclosable = (preview?.unclosable ?? []).filter((p) => !retryable.includes(p));

  function retry(e: FormEvent) {
    e.preventDefault();
    if (!again || busy) return;
    void run(() => api.retryClose(ticket.key, again));
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
              <PrErrorList prs={left.prErrors} />
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
          {!again && <p className="muted close-nothing-to-retry">{S.tc.nothingToRetry}</p>}
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button type="button" onClick={onClose} disabled={busy}>{S.tc.leaveIt}</button>
            <button type="submit" className="primary" disabled={busy || !again}>{S.tc.retry}</button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <form className={rest ? "modal close-ticket close-ticket-rest" : "modal close-ticket"} onSubmit={submit}>
        <h2>{rest ? S.tc.restTitle(ticket.key) : S.tc.title(ticket.key)}</h2>
        <p className="muted">{rest ? S.tc.restLede : S.tc.lede}</p>
        {rest ? (
          ticket.closure && <p className="muted close-rest-reason">{S.tc.banner(ticket.closure.reason)}</p>
        ) : (
          <>
            <label>
              {S.tc.reason}
              <textarea value={reason} aria-invalid={tooLong} placeholder={S.tc.reasonHint} onChange={(e) => setReason(e.target.value)} autoFocus rows={3} />
            </label>
            <p className={tooLong ? "error" : "muted"}>{tooLong ? S.tc.reasonTooLong(REASON_LIMIT) : S.tc.reasonCount(reason.length, REASON_LIMIT)}</p>
          </>
        )}
        <fieldset className="close-prs">
          <legend>{S.tc.closePrs}</legend>
          {previewError ? (
            <p className="error">{S.tc.prsFailed(previewError)}</p>
          ) : !preview ? (
            <p className="muted">{S.tc.prsLoading}</p>
          ) : (
            <>
              {preview.closable.length === 0 && preview.unclosable.length === 0 && <p className="muted">{rest ? S.tc.restNone : S.tc.prsNone}</p>}
              {preview.closable.map((p) => (
                <label key={p.url} className="check">
                  <input type="checkbox" checked={picked.has(p.url)} onChange={(e) => toggle(p.url, e.target.checked)} /> <code>{p.url}</code>
                </label>
              ))}
              {/* 核对失败的也能勾：关的时候再核对一次，还是失败就留在「没处理完的」里重试。 */}
              {retryable.map((p) => (
                <label key={p.url} className="check close-pr-unverified">
                  <input type="checkbox" checked={picked.has(p.url)} onChange={(e) => toggle(p.url, e.target.checked)} /> <code>{p.url}</code>
                  <div className="error">{p.error}</div>
                </label>
              ))}
              {picked.size > 0 && <p className="muted close-public-comment">{S.tc.publicComment}</p>}
              {unclosable.length > 0 && (
                <>
                  <p className="muted">{S.tc.unclosableTitle(unclosable.length)}</p>
                  <PrErrorList prs={unclosable} />
                </>
              )}
            </>
          )}
        </fieldset>
        {!rest && <label className="check"><input type="checkbox" checked={endSessions} onChange={(e) => setEndSessions(e.target.checked)} /> {S.tc.endSessions}</label>}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>{S.cancel}</button>
          {rest
            ? <button type="submit" className="primary" disabled={busy || closePrsRequest(preview, picked).prUrls.length === 0}>{S.tc.restConfirm}</button>
            : <button type="submit" className="primary" disabled={empty || busy || tooLong}>{S.tc.confirm}</button>}
        </div>
      </form>
    </div>
  );
}
